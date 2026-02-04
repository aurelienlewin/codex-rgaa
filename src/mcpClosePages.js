import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAbortError, isAbortError } from './abort.js';
import { attachIgnoreEpipe } from './streamErrors.js';
import {
  buildMcpArgs,
  normalizeBrowserUrl,
  looksLikeMcpConnectError,
  looksLikeMcpInstallOrNetworkError
} from './mcpConfig.js';
import { validateStrictOutputSchema } from './schemaValidate.js';

const SCHEMA_PATH = fileURLToPath(new URL('../data/mcp-close-pages-schema.json', import.meta.url));

function looksLikeCodexHomePermissionError(stderr) {
  const text = String(stderr || '');
  return (
    text.includes('Codex cannot access session files') ||
    (text.includes('permission denied') && (text.includes('.codex') || text.includes('sessions'))) ||
    text.includes('Error finding codex home') ||
    text.includes('CODEX_HOME points to')
  );
}

function looksLikeModelNotFound(stderr) {
  const text = String(stderr || '').toLowerCase();
  return (
    text.includes('model_not_found') ||
    (text.includes('requested model') && text.includes('does not exist')) ||
    (text.includes('does not exist') && text.includes('model'))
  );
}

function summarizeCodexStderr(stderr) {
  const text = String(stderr || '').trim();
  if (!text) return '';
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || '';
  return String(last).slice(0, 400);
}

function decorateCodexError(err) {
  if (!err) return err;
  const hint = summarizeCodexStderr(err.stderr);
  if (hint && err?.message && !String(err.message).includes(hint)) {
    err.message = `${err.message} (${hint})`;
  }
  if (looksLikeMcpConnectError(err.stderr) && err?.message) {
    err.message =
      `${err.message} ` +
      `(Cannot connect to Chrome DevTools. If you used http://127.0.0.1:9222, start Chrome with --remote-debugging-port=9222 or switch to MCP auto-connect.)`;
  }
  if (looksLikeMcpInstallOrNetworkError(err.stderr) && err?.message) {
    err.message =
      `${err.message} ` +
      `(MCP server unavailable: set AUDIT_MCP_COMMAND to a pre-installed chrome-devtools-mcp)`;
  }
  return err;
}

async function ensureDir(dirPath) {
  if (!dirPath) return;
  await fs.mkdir(dirPath, { recursive: true });
}

async function seedCodexConfig(codexHome, onLog) {
  if (!codexHome) return;
  const targetPath = path.join(codexHome, 'config.toml');
  try {
    await fs.access(targetPath);
    return;
  } catch {}

  const sourceCandidates = [path.join(os.homedir(), '.codex', 'config.toml')];
  for (const sourcePath of sourceCandidates) {
    try {
      const content = await fs.readFile(sourcePath, 'utf-8');
      await fs.writeFile(targetPath, content, { mode: 0o600 });
      onLog?.(`Codex: seeded ${targetPath} from ${sourcePath}`);
      return;
    } catch {}
  }
}

function getFallbackCodexHome() {
  return path.join(os.tmpdir(), 'rgaa-auditor-codex-home');
}

function getDefaultCodexHome() {
  return path.join(os.homedir(), '.codex');
}

function buildCodexEnv({ codexHome } = {}) {
  const env = { ...process.env };
  env.CODEX_HOME = codexHome || env.CODEX_HOME || getDefaultCodexHome();
  env.CODEX_SANDBOX_NETWORK_DISABLED = '0';

  const cacheRoot = env.CODEX_HOME || os.tmpdir();
  env.npm_config_cache = env.npm_config_cache || path.join(cacheRoot, 'npm-cache');
  env.npm_config_yes = env.npm_config_yes || 'true';
  env.npm_config_update_notifier = env.npm_config_update_notifier || 'false';
  env.npm_config_fund = env.npm_config_fund || 'false';
  env.npm_config_audit = env.npm_config_audit || 'false';
  return env;
}

let schemaPreflightDone = false;
async function preflightSchemas(onLog) {
  if (schemaPreflightDone) return;
  schemaPreflightDone = true;
  const res = await validateStrictOutputSchema(SCHEMA_PATH);
  if (!res.ok) {
    onLog?.('Codex: schema preflight failed for close pages');
    const msg =
      `Invalid structured-output schema (mcp close pages):\n` +
      res.problems.map((p) => `- ${p}`).join('\n');
    throw new Error(msg);
  }
}

function normalizeUrlCandidate(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return base.endsWith('/') && base !== '/' ? base.slice(0, -1) : base;
  } catch {
    return raw.endsWith('/') && raw.length > 1 ? raw.slice(0, -1) : raw;
  }
}

async function fetchJson(url, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url, { timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function closePagesDirect({ urls, browserUrl, onLog }) {
  const base = normalizeBrowserUrl(browserUrl);
  if (!base) return { closed: [], skipped: [], errors: [] };

  const original = new Set(urls.map((u) => String(u || '').trim()).filter(Boolean));
  const normalized = new Set(urls.map(normalizeUrlCandidate).filter(Boolean));

  let pages = [];
  try {
    pages = await fetchJson(`${base}/json/list`);
  } catch (err) {
    return { closed: [], skipped: [], errors: [{ error: String(err?.message || err) }] };
  }

  const closed = [];
  const skipped = [];
  const errors = [];

  for (const page of Array.isArray(pages) ? pages : []) {
    const url = String(page?.url || '').trim();
    if (!url) continue;
    const isHttp = url.startsWith('http://') || url.startsWith('https://');
    if (!isHttp && !original.has(url)) {
      skipped.push({ id: page?.id, url, reason: 'non-http url' });
      continue;
    }
    const normalizedUrl = normalizeUrlCandidate(url);
    const shouldClose =
      original.has(url) || normalized.has(url) || normalized.has(normalizedUrl);
    if (!shouldClose) {
      skipped.push({ id: page?.id, url, reason: 'no match' });
      continue;
    }
    if (!page?.id) {
      errors.push({ id: page?.id, url, error: 'missing page id' });
      continue;
    }
    try {
      await fetchText(`${base}/json/close/${page.id}`);
      closed.push({ id: page.id, url });
      onLog?.(`Codex: closed page ${page.id} via direct CDP`);
    } catch (err) {
      errors.push({ id: page.id, url, error: String(err?.message || err) });
    }
  }

  return { closed, skipped, errors };
}

function buildPrompt({ urls }) {
  const normalized = Array.from(new Set(urls.map(normalizeUrlCandidate).filter(Boolean)));
  const original = Array.from(new Set(urls.map((u) => String(u || '').trim()).filter(Boolean)));
  return [
    'You are a technical tool runner. Use ONLY chrome-devtools MCP tools.',
    'Write a brief narration on ONE line.',
    'On the next line, output only the MCP tool call (or the final JSON response).',
    'Repeat this two-line format for each action.',
    'Goal: close Chrome tabs whose URL matches one of the audited URLs.',
    'Rules:',
    '- First call list_pages.',
    '- Close a page if its url matches any Target URL (exact match) OR matches after trimming a trailing slash.',
    '- Do NOT close pages with empty URLs or non-http(s) URLs unless explicitly listed in targets.',
    '- For each closed tab, call close_page with its id.',
    '- Return ONLY JSON matching the provided schema.',
    '',
    'Target URLs (original):',
    JSON.stringify(original),
    'Target URLs (normalized, trailing slash removed):',
    JSON.stringify(normalized)
  ].join('\n');
}

async function runCodexClosePages({ urls, model, mcp, onLog, onStage, signal }) {
  if (signal?.aborted) throw createAbortError();

  await preflightSchemas(onLog);

  const outputFile = path.join(
    os.tmpdir(),
    `codex-mcp-close-pages-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const codexPath = process.env.CODEX_PATH || 'codex';
  const buildArgs = (mcpConfig, modelOverride = model) => {
    const args = [
      '-a',
      'on-failure',
      'exec',
      ...buildMcpArgs(mcpConfig),
      '--skip-git-repo-check',
      '--output-schema',
      SCHEMA_PATH,
      '--output-last-message',
      outputFile,
      '--color',
      'never',
      '--sandbox',
      'read-only'
    ];
    if (modelOverride) args.push('-m', modelOverride);
    args.push('-');
    return args;
  };

  const runOnce = async (env, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(codexPath, args, { stdio: ['pipe', 'ignore', 'pipe'], env });
      let settled = false;
      let stderrText = '';
      let abortHandler = null;
      const finalize = (err) => {
        if (settled) return;
        settled = true;
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        if (err) {
          err.stderr = stderrText;
          reject(err);
        } else {
          resolve();
        }
      };

      abortHandler = () => {
        onLog?.('Codex: abort signal received');
        try {
          child.kill('SIGTERM');
        } catch {}
      };
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const message = String(chunk);
          stderrText += message;
          if (stderrText.length > 64_000) stderrText = stderrText.slice(-64_000);
          const trimmed = message.trim();
          if (trimmed) onLog?.(`Codex: ${trimmed.split('\n').slice(-1)[0]}`);
        });
      }

      child.on('error', (err) => {
        if (signal?.aborted || isAbortError(err)) {
          finalize(createAbortError());
          return;
        }
        finalize(err);
      });
      child.on('exit', (code) => {
        if (signal?.aborted) {
          finalize(createAbortError());
          return;
        }
        if (code === 0) finalize();
        else finalize(new Error(`codex exec exited with code ${code}`));
      });

      onStage?.('AI: closing audited tabs');
      onLog?.('Codex: closing audited tabs');
      attachIgnoreEpipe(child.stdin, (err) => {
        onLog?.(`Codex: stdin error (${err?.code || 'unknown'}).`);
      });
      child.stdin.write(buildPrompt({ urls }));
      child.stdin.end();
    });

  let preferredEnv = buildCodexEnv();
  if (process.env.CODEX_HOME) {
    try {
      await ensureDir(process.env.CODEX_HOME);
    } catch {
      const fallbackHome = getFallbackCodexHome();
      await ensureDir(fallbackHome);
      await ensureDir(path.join(fallbackHome, 'sessions'));
      await ensureDir(path.join(fallbackHome, 'npm-cache'));
      await seedCodexConfig(fallbackHome, onLog);
      preferredEnv = buildCodexEnv({ codexHome: fallbackHome });
    }
  }

  try {
    await runOnce(preferredEnv, buildArgs(mcp));
  } catch (err) {
    if (model && looksLikeModelNotFound(err.stderr)) {
      onLog?.(`Codex: model ${JSON.stringify(model)} not found; retrying with default model`);
      await runOnce(preferredEnv, buildArgs(mcp, ''));
    } else {
      const providedBrowserUrl = normalizeBrowserUrl(mcp?.browserUrl);
      const canFallback = Boolean(providedBrowserUrl && mcp?.autoConnect);
      if (canFallback && looksLikeMcpConnectError(err.stderr)) {
        onLog?.(
          `Codex: MCP connect to ${providedBrowserUrl} failed; retrying with --autoConnect`
        );
        const fallbackConfig = { ...(mcp || {}) };
        fallbackConfig.browserUrl = '';
        fallbackConfig.autoConnect = true;
        await runOnce(preferredEnv, buildArgs(fallbackConfig));
      } else if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err.stderr)) {
        const fallbackHome = getFallbackCodexHome();
        await ensureDir(fallbackHome);
        await ensureDir(path.join(fallbackHome, 'sessions'));
        await ensureDir(path.join(fallbackHome, 'npm-cache'));
        await seedCodexConfig(fallbackHome, onLog);
        onLog?.(`Codex: retrying with CODEX_HOME=${fallbackHome}`);
        await runOnce(buildCodexEnv({ codexHome: fallbackHome }), buildArgs(mcp));
      } else {
        throw decorateCodexError(err);
      }
    }
  }

  const content = await fs.readFile(outputFile, 'utf-8');
  await fs.unlink(outputFile).catch(() => {});
  return JSON.parse(content);
}

export async function closeMcpPages({ urls, model, mcp, onLog, onStage, signal }) {
  const targetUrls = Array.isArray(urls) ? urls.filter(Boolean) : [];
  if (targetUrls.length === 0) {
    return { closed: [], skipped: [], errors: [] };
  }
  let result = await runCodexClosePages({ urls: targetUrls, model, mcp, onLog, onStage, signal });
  const needsFallback =
    (result?.closed || []).length === 0 ||
    (result?.errors || []).length > 0;
  if (needsFallback) {
    const direct = await closePagesDirect({
      urls: targetUrls,
      browserUrl: mcp?.browserUrl || '',
      onLog
    });
    const closed = new Map();
    for (const item of result.closed || []) {
      if (item && item.url) closed.set(item.url, item);
    }
    for (const item of direct.closed || []) {
      if (item && item.url) closed.set(item.url, item);
    }
    result = {
      closed: Array.from(closed.values()),
      skipped: [...(result.skipped || []), ...(direct.skipped || [])],
      errors: [...(result.errors || []), ...(direct.errors || [])]
    };
  }
  return result;
}
