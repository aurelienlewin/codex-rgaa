import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAbortError, isAbortError } from './abort.js';
import { getSnapshotExpression } from './snapshot.js';
import { attachIgnoreEpipe } from './streamErrors.js';
import {
  buildMcpArgs,
  normalizeBrowserUrl,
  looksLikeMcpConnectError,
  looksLikeMcpInstallOrNetworkError
} from './mcpConfig.js';
import { validateStrictOutputSchema } from './schemaValidate.js';
import { applyCodexBaseUrlFromConfig, maybeHandleMissingAuth } from './codexAuth.js';

const SCHEMA_PATH = fileURLToPath(new URL('../data/mcp-snapshot-schema.json', import.meta.url));
const LIST_PAGES_SCHEMA_PATH = fileURLToPath(
  new URL('../data/mcp-list-pages-schema.json', import.meta.url)
);

const LIST_PAGES_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.AUDIT_MCP_LIST_PAGES_CACHE_TTL_MS || '');
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 60 * 60 * 1000;
})();

const CACHED_PAGES_MAX = (() => {
  const raw = Number(process.env.AUDIT_MCP_CACHED_PAGES_MAX || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
})();

const listPagesCache = new Map();

function parseEnvBool(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const text = String(raw).trim().toLowerCase();
  if (text === '1' || text === 'true' || text === 'yes') return true;
  if (text === '0' || text === 'false' || text === 'no') return false;
  return fallback;
}

function shouldSkipListPages(mcp) {
  if (mcp && typeof mcp.skipListPages === 'boolean') return mcp.skipListPages;
  return parseEnvBool(process.env.AUDIT_MCP_SKIP_LIST_PAGES, false);
}

function hashCacheKey(cacheKey) {
  return crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 16);
}

async function getListPagesCacheDir() {
  const preferred = process.env.CODEX_HOME || getDefaultCodexHome();
  const candidateDirs = [
    path.join(preferred, 'cache'),
    path.join(getFallbackCodexHome(), 'cache')
  ];
  for (const dir of candidateDirs) {
    try {
      await ensureDir(dir);
      return dir;
    } catch {}
  }
  return '';
}

async function readListPagesDiskCache(cacheKey, { allowExpired = false } = {}) {
  if (LIST_PAGES_CACHE_TTL_MS <= 0) return null;
  const dir = await getListPagesCacheDir();
  if (!dir) return null;
  const filePath = path.join(dir, `mcp-list-pages-${hashCacheKey(cacheKey)}.json`);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.expiresAt && (parsed.expiresAt > Date.now() || allowExpired) && parsed.value) {
      return parsed;
    }
    if (!allowExpired) await fs.unlink(filePath).catch(() => {});
  } catch {}
  return null;
}

async function writeListPagesDiskCache(cacheKey, payload) {
  if (LIST_PAGES_CACHE_TTL_MS <= 0) return;
  const dir = await getListPagesCacheDir();
  if (!dir) return;
  const filePath = path.join(dir, `mcp-list-pages-${hashCacheKey(cacheKey)}.json`);
  try {
    await fs.writeFile(filePath, JSON.stringify(payload), { mode: 0o600 });
  } catch {}
}

let schemaPreflightDone = false;
async function preflightSchemas(onLog) {
  if (schemaPreflightDone) return;
  schemaPreflightDone = true;

  const checks = [
    { label: 'mcp snapshot', path: SCHEMA_PATH },
    { label: 'mcp list_pages', path: LIST_PAGES_SCHEMA_PATH }
  ];

  for (const item of checks) {
    try {
      const res = await validateStrictOutputSchema(item.path);
      if (!res.ok) {
        const msg =
          `Invalid structured-output schema (${item.label}):\n` +
          res.problems.map((p) => `- ${p}`).join('\n');
        throw new Error(msg);
      }
    } catch (err) {
      onLog?.(`Codex: schema preflight failed for ${item.label}`);
      throw err;
    }
  }
}

function normalizeCachedPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const trimmed = pages
    .map((page) => ({
      id: Number.isFinite(page?.id) ? page.id : null,
      url: typeof page?.url === 'string' ? page.url : '',
      title: typeof page?.title === 'string' ? page.title : ''
    }))
    .filter((page) => Number.isFinite(page.id) && page.url);
  if (!trimmed.length) return null;
  return trimmed.slice(0, CACHED_PAGES_MAX);
}

function buildPrompt({ url, pageId, cachedPages, skipListPages } = {}) {
  const expression = getSnapshotExpression();
  const targetLabel =
    typeof pageId === 'number' && Number.isFinite(pageId)
      ? `page id ${pageId}`
      : `URL ${url}`;
  const normalizedCachedPages = normalizeCachedPages(cachedPages);
  const skipList = Boolean(skipListPages);
  return [
    'Tu es un outil technique. Utilise uniquement le MCP chrome-devtools.',
    'Écris une courte narration explicative sur UNE ligne.',
    'Sur la ligne suivante, écris uniquement l’appel d’outil MCP (ou la réponse JSON finale).',
    'Répète ce format pour chaque action.',
    'Étapes obligatoires:',
    '1) Détermine la page cible:',
    typeof pageId === 'number' && Number.isFinite(pageId)
      ? `- Sélectionne la page ${pageId} avec select_page.`
      : normalizedCachedPages
        ? "- Utilise la liste CACHED_PAGES fournie (sans appeler list_pages); sélectionne la première page qui correspond à l’URL en respectant l’ordre fourni; sinon navigue vers l’URL avec navigate_page."
        : skipList
          ? '- N’appelle pas list_pages; navigue directement vers l’URL avec navigate_page.'
          : '- Liste les pages avec list_pages; si une page correspond à l’URL, sélectionne la première dans l’ordre retourné; sinon navigue vers l’URL avec navigate_page.',
    `2) Vérifie que location.href correspond bien à la cible (${targetLabel}); si besoin navigue vers l’URL.`,
    '3) Exécute la fonction JS fournie via evaluate_script pour attendre le chargement et collecter le snapshot.',
    '4) Réponds uniquement avec le JSON retourné (pas de texte supplémentaire).',
    '',
    `URL: ${url}`,
    typeof pageId === 'number' && Number.isFinite(pageId) ? `PAGE_ID: ${pageId}` : '',
    normalizedCachedPages ? `CACHED_PAGES: ${JSON.stringify(normalizedCachedPages)}` : '',
    '',
    'Fonction JS à exécuter via evaluate_script:',
    'async () => {',
    '  if (document.readyState !== "complete") {',
    '    await new Promise((resolve) => {',
    '      const done = () => resolve();',
    '      window.addEventListener("load", done, { once: true });',
    '      setTimeout(done, 15000);',
    '    });',
    '  }',
    `  return ${expression}`,
    '}'
  ].join('\n');
}

function buildListPagesPrompt() {
  return [
    'Tu es un outil technique. Utilise uniquement le MCP chrome-devtools.',
    'Ne fournis aucune narration, explication ou confirmation (pas de texte libre).',
    'N’écris que des appels d’outils MCP et la réponse JSON finale.',
    'Étapes obligatoires:',
    '1) Appelle list_pages.',
    '2) Réponds uniquement avec le JSON retourné (pas de texte supplémentaire).'
  ].join('\n');
}


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

  const pickLastMatch = (regex) => [...lines].reverse().find((line) => regex.test(line)) || '';

  const candidates = [
    pickLastMatch(/mcp:\s*chrome-devtools failed/i),
    pickLastMatch(/mcp startup:\s*failed/i),
    pickLastMatch(/mcp client .* timed out/i),
    pickLastMatch(/codex_api::endpoint::responses/i),
    pickLastMatch(/error sending request/i),
    pickLastMatch(/stream disconnected before completion/i),
    pickLastMatch(/econnrefused|connection refused/i),
    pickLastMatch(/net::err_/i),
    pickLastMatch(/error/i)
  ].filter(Boolean);

  return String(candidates[0] || lines[lines.length - 1] || '').slice(0, 400);
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
  // Stable temp directory so repeated runs can reuse cached artifacts (npx cache, sessions).
  return path.join(os.tmpdir(), 'rgaa-auditor-codex-home');
}

function getDefaultCodexHome() {
  return path.join(os.homedir(), '.codex');
}

function buildCodexEnv({ codexHome } = {}) {
  const env = { ...process.env };
  env.CODEX_HOME = codexHome || env.CODEX_HOME || getDefaultCodexHome();
  // This project relies on Codex network access to reach the OpenAI API.
  // In some Codex-managed environments, CODEX_SANDBOX_NETWORK_DISABLED=1 is inherited,
  // which breaks `codex exec` runs. Override it for the nested Codex process.
  env.CODEX_SANDBOX_NETWORK_DISABLED = '0';

  const cacheRoot = env.CODEX_HOME || os.tmpdir();
  // Make npx/npm usable even when $HOME is not writable (common in sandboxed environments).
  env.npm_config_cache = env.npm_config_cache || path.join(cacheRoot, 'npm-cache');
  env.npm_config_yes = env.npm_config_yes || 'true';
  env.npm_config_update_notifier = env.npm_config_update_notifier || 'false';
  env.npm_config_fund = env.npm_config_fund || 'false';
  env.npm_config_audit = env.npm_config_audit || 'false';
  return applyCodexBaseUrlFromConfig(env, env.CODEX_HOME);
}

async function runCodexSnapshot({ url, model, mcp, onLog, onStage, signal }) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  await preflightSchemas(onLog);

  const outputFile = path.join(
    os.tmpdir(),
    `codex-mcp-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const codexPath = process.env.CODEX_PATH || 'codex';
  const buildArgs = (mcpConfig, schemaPath, modelOverride = model) => {
    const args = [
      // MCP servers are launched as local processes (e.g. `npx chrome-devtools-mcp@latest ...`).
      // In non-interactive `codex exec` runs, the default approval policy can block spawning them
      // (there is no TTY to approve). Use a non-interactive policy so MCP can start.
      '-a',
      'on-failure',
      'exec',
      ...buildMcpArgs(mcpConfig),
      '--skip-git-repo-check',
      '--output-schema',
      schemaPath,
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

  onStage?.('AI: preparing MCP snapshot');
  onLog?.('Codex: preparing MCP snapshot');

  const runOnce = async (env, args) =>
    new Promise((resolve, reject) => {
      onStage?.('AI: spawning Codex');
      const child = spawn(codexPath, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        env
      });

      let settled = false;
      let stderrText = '';
      let abortHandler = null;
      const finalize = (err) => {
        if (settled) return;
        settled = true;
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
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

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
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

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const message = String(chunk);
          stderrText += message;
          // Avoid unbounded growth if Codex is noisy (keep the tail).
          if (stderrText.length > 64_000) stderrText = stderrText.slice(-64_000);
          const trimmed = message.trim();
          if (trimmed) onLog?.(`Codex: ${trimmed.split('\n').slice(-1)[0]}`);
        });
      }

      onStage?.('AI: running MCP snapshot');
      onLog?.('Codex: running MCP snapshot');
      attachIgnoreEpipe(child.stdin, (err) => {
        onLog?.(`Codex: stdin error (${err?.code || 'unknown'}).`);
      });
      child.stdin.write(
        buildPrompt({
          url,
          pageId: mcp?.pageId,
          cachedPages: mcp?.cachedPages,
          skipListPages: shouldSkipListPages(mcp)
        })
      );
      child.stdin.end();
    });

  // Ensure a user-provided CODEX_HOME exists; if it's not usable, fall back to a temp CODEX_HOME.
  let preferredEnv = buildCodexEnv();
  if (process.env.CODEX_HOME) {
    try {
      await ensureDir(process.env.CODEX_HOME);
    } catch (err) {
      const fallbackHome = getFallbackCodexHome();
      await ensureDir(fallbackHome);
      await ensureDir(path.join(fallbackHome, 'sessions'));
      await ensureDir(path.join(fallbackHome, 'npm-cache'));
      await seedCodexConfig(fallbackHome, onLog);
      onLog?.(
        `Codex: CODEX_HOME=${process.env.CODEX_HOME} is not writable; retrying with CODEX_HOME=${fallbackHome}`
      );
      preferredEnv = buildCodexEnv({ codexHome: fallbackHome });
    }
  }

  try {
    await runOnce(preferredEnv, buildArgs(mcp, SCHEMA_PATH));
  } catch (err) {
    maybeHandleMissingAuth({ onLog, stderr: err?.stderr || err?.message });
    if (model && looksLikeModelNotFound(err.stderr)) {
      onLog?.(`Codex: model ${JSON.stringify(model)} not found; retrying with default model`);
      await runOnce(preferredEnv, buildArgs(mcp, SCHEMA_PATH, ''));
    } else {
    // Default behavior may point to an existing local DevTools endpoint (127.0.0.1:9222).
    // If that endpoint isn't available, retry using autoConnect (when enabled).
    const providedBrowserUrl = normalizeBrowserUrl(mcp?.browserUrl);
    const canFallback = Boolean(providedBrowserUrl && mcp?.autoConnect);
    if (canFallback && looksLikeMcpConnectError(err.stderr)) {
      onLog?.(
        `Codex: MCP connect to ${providedBrowserUrl} failed; retrying with --autoConnect`
      );
      const fallbackConfig = { ...(mcp || {}) };
      fallbackConfig.browserUrl = '';
      fallbackConfig.autoConnect = true;
      try {
        await runOnce(preferredEnv, buildArgs(fallbackConfig, SCHEMA_PATH));
      } catch (fallbackErr) {
        throw decorateCodexError(fallbackErr);
      }
    } else
    // Common failure mode in sandboxed/CI environments: ~/.codex isn't writable.
    if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err.stderr)) {
      const fallbackHome = getFallbackCodexHome();
      await ensureDir(fallbackHome);
      await ensureDir(path.join(fallbackHome, 'sessions'));
      await ensureDir(path.join(fallbackHome, 'npm-cache'));
      await seedCodexConfig(fallbackHome, onLog);
      onLog?.(`Codex: retrying with CODEX_HOME=${fallbackHome}`);
      try {
        await runOnce(buildCodexEnv({ codexHome: fallbackHome }), buildArgs(mcp, SCHEMA_PATH));
      } catch (fallbackErr) {
        throw decorateCodexError(fallbackErr);
      }
    } else {
      throw decorateCodexError(err);
    }
    }
  }

  onStage?.('AI: parsing MCP snapshot');
  onLog?.('Codex: parsing MCP snapshot');
  const content = await fs.readFile(outputFile, 'utf-8');
  await fs.unlink(outputFile).catch(() => {});
  return JSON.parse(content);
}


export async function collectSnapshotWithMcp({ url, model, mcp, onLog, onStage, signal }) {
  if (
    mcp &&
    !mcp?.pageId &&
    !Array.isArray(mcp?.cachedPages)
  ) {
    try {
      const list = await listMcpPages({ model, mcp, onLog, onStage, signal });
      if (Array.isArray(list?.pages)) {
        mcp.cachedPages = list.pages;
      } else {
        mcp.cachedPages = [];
      }
    } catch (err) {
      mcp.cachedPages = [];
      onLog?.(`Codex: failed to prefetch MCP list_pages (${err?.message || 'unknown error'})`);
    }
  }
  return runCodexSnapshot({ url, model, mcp, onLog, onStage, signal });
}

export async function listMcpPages({ model, mcp, onLog, onStage, signal }) {
  if (signal?.aborted) {
    throw createAbortError();
  }
  const skipList = shouldSkipListPages(mcp);

  if (LIST_PAGES_CACHE_TTL_MS > 0) {
    const cacheKey = JSON.stringify({
      model: model || '',
      browserUrl: mcp?.browserUrl || '',
      autoConnect: Boolean(mcp?.autoConnect),
      channel: mcp?.channel || ''
    });
    const cached = listPagesCache.get(cacheKey);
    if (cached && (cached.expiresAt > Date.now() || skipList)) {
      onLog?.('Codex: using cached MCP list_pages');
      if (typeof structuredClone === 'function') {
        return structuredClone(cached.value);
      }
      return JSON.parse(JSON.stringify(cached.value));
    }
    const diskCached = await readListPagesDiskCache(cacheKey, { allowExpired: skipList });
    if (diskCached && (diskCached.expiresAt > Date.now() || skipList)) {
      onLog?.('Codex: using disk-cached MCP list_pages');
      listPagesCache.set(cacheKey, diskCached);
      if (typeof structuredClone === 'function') {
        return structuredClone(diskCached.value);
      }
      return JSON.parse(JSON.stringify(diskCached.value));
    }
    listPagesCache.delete(cacheKey);
  }

  if (skipList) {
    onLog?.('Codex: skipping MCP list_pages (disabled).');
    return { pages: [] };
  }

  await preflightSchemas(onLog);

  const outputFile = path.join(
    os.tmpdir(),
    `codex-mcp-list-pages-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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
      LIST_PAGES_SCHEMA_PATH,
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

  onStage?.('AI: preparing MCP list_pages');
  onLog?.('Codex: preparing MCP list_pages');

  const runOnce = async (env, args) =>
    new Promise((resolve, reject) => {
      onStage?.('AI: spawning Codex');
      const child = spawn(codexPath, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        env
      });

      let settled = false;
      let stderrText = '';
      let abortHandler = null;
      const finalize = (err) => {
        if (settled) return;
        settled = true;
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
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

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
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

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const message = String(chunk);
          stderrText += message;
          if (stderrText.length > 64_000) stderrText = stderrText.slice(-64_000);
          const trimmed = message.trim();
          if (trimmed) onLog?.(`Codex: ${trimmed.split('\n').slice(-1)[0]}`);
        });
      }

      onStage?.('AI: running MCP list_pages');
      onLog?.('Codex: running MCP list_pages');
      attachIgnoreEpipe(child.stdin, (err) => {
        onLog?.(`Codex: stdin error (${err?.code || 'unknown'}).`);
      });
      child.stdin.write(buildListPagesPrompt());
      child.stdin.end();
    });

  let preferredEnv = buildCodexEnv();
  if (process.env.CODEX_HOME) {
    try {
      await ensureDir(process.env.CODEX_HOME);
    } catch (err) {
      const fallbackHome = getFallbackCodexHome();
      await ensureDir(fallbackHome);
      await ensureDir(path.join(fallbackHome, 'sessions'));
      await ensureDir(path.join(fallbackHome, 'npm-cache'));
      await seedCodexConfig(fallbackHome, onLog);
      onLog?.(
        `Codex: CODEX_HOME=${process.env.CODEX_HOME} is not writable; retrying with CODEX_HOME=${fallbackHome}`
      );
      preferredEnv = buildCodexEnv({ codexHome: fallbackHome });
    }
  }

  try {
    await runOnce(preferredEnv, buildArgs(mcp));
  } catch (err) {
    maybeHandleMissingAuth({ onLog, stderr: err?.stderr || err?.message });
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
      try {
        await runOnce(preferredEnv, buildArgs(fallbackConfig));
      } catch (fallbackErr) {
        throw decorateCodexError(fallbackErr);
      }
    } else if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err.stderr)) {
      const fallbackHome = getFallbackCodexHome();
      await ensureDir(fallbackHome);
      await ensureDir(path.join(fallbackHome, 'sessions'));
      await ensureDir(path.join(fallbackHome, 'npm-cache'));
      await seedCodexConfig(fallbackHome, onLog);
      onLog?.(`Codex: retrying with CODEX_HOME=${fallbackHome}`);
      try {
        await runOnce(buildCodexEnv({ codexHome: fallbackHome }), buildArgs(mcp));
      } catch (fallbackErr) {
        throw decorateCodexError(fallbackErr);
      }
    } else {
      throw decorateCodexError(err);
    }
    }
  }

  onStage?.('AI: parsing MCP list_pages');
  onLog?.('Codex: parsing MCP list_pages');
  const content = await fs.readFile(outputFile, 'utf-8');
  await fs.unlink(outputFile).catch(() => {});
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed?.pages)) {
    parsed.pages.sort((a, b) => {
      const aId = Number.isFinite(a?.id) ? a.id : Number.MAX_SAFE_INTEGER;
      const bId = Number.isFinite(b?.id) ? b.id : Number.MAX_SAFE_INTEGER;
      return aId - bId;
    });
  }
  if (LIST_PAGES_CACHE_TTL_MS > 0) {
    const cacheKey = JSON.stringify({
      model: model || '',
      browserUrl: mcp?.browserUrl || '',
      autoConnect: Boolean(mcp?.autoConnect),
      channel: mcp?.channel || ''
    });
    const payload = {
      value: parsed,
      expiresAt: Date.now() + LIST_PAGES_CACHE_TTL_MS
    };
    listPagesCache.set(cacheKey, payload);
    await writeListPagesDiskCache(cacheKey, payload);
  }
  return parsed;
}
