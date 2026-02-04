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
import { maybeHandleMissingAuth } from './codexAuth.js';

const SCHEMA_PATH = fileURLToPath(new URL('../data/mcp-enrich-schema.json', import.meta.url));

function looksLikeCodexHomePermissionError(stderr) {
  const text = String(stderr || '');
  return (
    text.includes('Codex cannot access session files') ||
    (text.includes('permission denied') && (text.includes('.codex') || text.includes('sessions'))) ||
    text.includes('Error finding codex home') ||
    text.includes('CODEX_HOME points to')
  );
}

async function ensureDir(dirPath) {
  if (!dirPath) return;
  await fs.mkdir(dirPath, { recursive: true });
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

function summarizeCodexStderr(stderr) {
  const text = String(stderr || '').trim();
  if (!text) return '';
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  return String(lines[lines.length - 1] || '').slice(0, 400);
}

function buildPrompt({ url, pageId, paths }) {
  const htmlMaxRaw = Number(process.env.AUDIT_ENRICH_HTML_MAX || '');
  const htmlMax =
    Number.isFinite(htmlMaxRaw) && htmlMaxRaw > 0 ? Math.floor(htmlMaxRaw) : 20000;
  const targetLabel =
    typeof pageId === 'number' && Number.isFinite(pageId)
      ? `page id ${pageId}`
      : `URL ${url}`;
  return [
    'You are a technical tool runner. Use ONLY chrome-devtools MCP tools.',
    'Write a brief narration on ONE line.',
    'On the next line, output only the MCP tool call (or the final JSON response).',
    'Repeat this two-line format for each action.',
    'Required steps:',
    '1) Determine the target page:',
    typeof pageId === 'number' && Number.isFinite(pageId)
      ? `- select_page ${pageId}.`
      : '- list_pages; if a page matches the URL, select it; otherwise navigate_page to the URL.',
    `2) Verify location.href matches the target (${targetLabel}); if not, navigate_page.`,
    '3) Collect evidence:',
    `- take_screenshot fullPage=true to "${paths.screenshot1}".`,
    '- wait ~1200ms.',
    `- take_screenshot fullPage=true to "${paths.screenshot2}".`,
    '- evaluate_script to collect style samples and a trimmed HTML snippet.',
    '4) Respond ONLY with JSON matching the schema.',
    '',
    `URL: ${url}`,
    typeof pageId === 'number' && Number.isFinite(pageId) ? `PAGE_ID: ${pageId}` : '',
    '',
    'evaluate_script JS:',
    '() => {',
    '  const maxSamples = 25;',
    '  const samples = [];',
    '  const elToSelector = (el) => {',
    '    if (!el || !el.tagName) return "";',
    '    const id = el.getAttribute("id");',
    '    if (id) return `#${id}`;',
    '    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0,2);',
    '    const tag = el.tagName.toLowerCase();',
    '    return cls.length ? `${tag}.${cls.join(".")}` : tag;',
    '  };',
    '  const isVisible = (el) => {',
    '    if (!el) return false;',
    '    const style = window.getComputedStyle(el);',
    '    if (!style || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;',
    '    const rect = el.getBoundingClientRect();',
    '    return rect.width > 0 && rect.height > 0;',
    '  };',
    '  const nodes = Array.from(document.querySelectorAll("body *"));',
    '  for (const el of nodes) {',
    '    if (samples.length >= maxSamples) break;',
    '    if (!isVisible(el)) continue;',
    '    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();',
    '    if (!text || text.length < 3) continue;',
    '    const style = window.getComputedStyle(el);',
    '    samples.push({',
    '      text: text.slice(0, 120),',
    '      color: style.color || "",',
    '      backgroundColor: style.backgroundColor || "",',
    '      fontSize: style.fontSize || "",',
    '      fontWeight: style.fontWeight || "",',
    '      tag: el.tagName.toLowerCase(),',
    '      selector: elToSelector(el)',
    '    });',
    '  }',
    '  const html = (document.documentElement && document.documentElement.outerHTML) || "";',
    '  return {',
    '    styleSamples: samples,',
    `    htmlSnippet: html.length > ${htmlMax} ? html.slice(0, ${htmlMax}) : html`,
    '  };',
    '}'
  ]
    .filter(Boolean)
    .join('\n');
}

async function runCodexEnrich({ url, model, mcp, onLog, onStage, signal }) {
  if (signal?.aborted) throw createAbortError();

  onStage?.('AI: preparing MCP enrichment');
  onLog?.('Codex: preparing MCP enrichment');

  const outputFile = path.join(
    os.tmpdir(),
    `codex-mcp-enrich-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const screenshot1 = path.join(os.tmpdir(), `rgaa-enrich-${Date.now()}-a.png`);
  const screenshot2 = path.join(os.tmpdir(), `rgaa-enrich-${Date.now()}-b.png`);

  const codexPath = process.env.CODEX_PATH || 'codex';
  const buildArgs = (mcpConfig) => {
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
    if (model) args.push('-m', model);
    args.push('-');
    return args;
  };

  const runOnce = async (env, args) =>
    new Promise((resolve, reject) => {
      onStage?.('AI: spawning Codex');
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
        try {
          child.kill('SIGTERM');
        } catch {}
      };
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const message = String(chunk);
          stderrText += message;
          if (stderrText.length > 64000) stderrText = stderrText.slice(-64000);
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

      const prompt = buildPrompt({
        url,
        pageId: mcp?.pageId,
        paths: { screenshot1, screenshot2 }
      });
      onStage?.('AI: running MCP enrichment');
      onLog?.('Codex: running MCP enrichment');
      attachIgnoreEpipe(child.stdin, (err) => {
        onLog?.(`Codex: stdin error (${err?.code || 'unknown'}).`);
      });
      child.stdin.write(prompt);
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
      preferredEnv = buildCodexEnv({ codexHome: fallbackHome });
    }
  }

  try {
    await runOnce(preferredEnv, buildArgs(mcp));
  } catch (err) {
    maybeHandleMissingAuth({ onLog, stderr: err?.stderr || err?.message });
    const providedBrowserUrl = normalizeBrowserUrl(mcp?.browserUrl);
    const canFallback = Boolean(providedBrowserUrl && mcp?.autoConnect);
    if (canFallback && looksLikeMcpConnectError(err.stderr)) {
      const fallbackConfig = { ...(mcp || {}), browserUrl: '', autoConnect: true };
      await runOnce(preferredEnv, buildArgs(fallbackConfig));
    } else if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err.stderr)) {
      const fallbackHome = getFallbackCodexHome();
      await ensureDir(fallbackHome);
      await ensureDir(path.join(fallbackHome, 'sessions'));
      await ensureDir(path.join(fallbackHome, 'npm-cache'));
      await runOnce(buildCodexEnv({ codexHome: fallbackHome }), buildArgs(mcp));
    } else if (looksLikeMcpInstallOrNetworkError(err.stderr)) {
      const hint = summarizeCodexStderr(err.stderr);
      throw new Error(`MCP enrichment failed (${hint || 'tool error'})`);
    } else {
      throw err;
    }
  }

  onStage?.('AI: parsing MCP enrichment');
  onLog?.('Codex: parsing MCP enrichment');
  const content = await fs.readFile(outputFile, 'utf-8');
  await fs.unlink(outputFile).catch(() => {});
  const parsed = JSON.parse(content);
  return {
    ...parsed,
    screenshot1,
    screenshot2
  };
}

export async function collectEnrichedEvidenceWithMcp({
  url,
  model,
  mcp,
  onLog,
  onStage,
  signal
}) {
  return runCodexEnrich({ url, model, mcp, onLog, onStage, signal });
}
