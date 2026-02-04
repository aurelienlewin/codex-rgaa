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
import { applyCodexBaseUrlFromConfig, maybeHandleMissingAuth } from './codexAuth.js';
import { listMcpPages } from './mcpSnapshot.js';

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
  return applyCodexBaseUrlFromConfig(env, env.CODEX_HOME);
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

function normalizeCachedPages(pages, maxEntries) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const trimmed = pages
    .map((page) => ({
      id: Number.isFinite(page?.id) ? page.id : null,
      url: typeof page?.url === 'string' ? page.url : '',
      title: typeof page?.title === 'string' ? page.title : ''
    }))
    .filter((page) => Number.isFinite(page.id) && page.url);
  if (!trimmed.length) return null;
  return trimmed.slice(0, maxEntries);
}

function buildPrompt({ url, pageId, paths, cachedPages }) {
  const htmlMaxRaw = Number(process.env.AUDIT_ENRICH_HTML_MAX || '');
  const htmlMax =
    Number.isFinite(htmlMaxRaw) && htmlMaxRaw > 0 ? Math.floor(htmlMaxRaw) : 20000;
  const cachedMaxRaw = Number(process.env.AUDIT_MCP_CACHED_PAGES_MAX || '');
  const cachedMax =
    Number.isFinite(cachedMaxRaw) && cachedMaxRaw > 0 ? Math.floor(cachedMaxRaw) : 60;
  const normalizedCachedPages = normalizeCachedPages(cachedPages, cachedMax);
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
      : normalizedCachedPages
        ? '- Use the provided CACHED_PAGES list (do not call list_pages); select the page matching the URL with the lowest id; otherwise navigate_page to the URL.'
        : '- list_pages; if a page matches the URL, select the one with the lowest id; otherwise navigate_page to the URL.',
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
    normalizedCachedPages ? `CACHED_PAGES: ${JSON.stringify(normalizedCachedPages)}` : '',
    '',
    'evaluate_script JS:',
    '() => {',
    '  const maxSamples = 25;',
    '  const maxUiSamples = 40;',
    '  const samples = [];',
    '  const uiSamples = [];',
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
    '  const isTransparent = (value) => {',
    '    const v = (value || "").toString().trim().toLowerCase();',
    '    if (!v || v === "transparent") return true;',
    '    if (v.startsWith("rgba")) {',
    '      const m = v.match(/rgba\\(\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*\\d+\\s*,\\s*([0-9.]+)\\s*\\)/);',
    '      if (m && Number(m[1]) === 0) return true;',
    '    }',
    '    return false;',
    '  };',
    '  const resolveBg = (el) => {',
    '    let node = el;',
    '    while (node) {',
    '      const style = window.getComputedStyle(node);',
    '      const bg = style ? style.backgroundColor : "";',
    '      if (bg && !isTransparent(bg)) return bg;',
    '      node = node.parentElement;',
    '    }',
    '    const bodyBg = window.getComputedStyle(document.body).backgroundColor;',
    '    if (bodyBg && !isTransparent(bodyBg)) return bodyBg;',
    '    const htmlBg = window.getComputedStyle(document.documentElement).backgroundColor;',
    '    return htmlBg || "";',
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
    '  const uiNodes = Array.from(document.querySelectorAll(',
    '    "button, input, select, textarea, progress, meter, summary, [role=\\"button\\"], [role=\\"switch\\"], [role=\\"checkbox\\"], [role=\\"radio\\"], [role=\\"tab\\"], [role=\\"slider\\"], [role=\\"menuitem\\"], [role=\\"link\\"], a, svg[aria-label], [role=\\"img\\"], img[alt]"',
    '  ));',
    '  for (const el of uiNodes) {',
    '    if (uiSamples.length >= maxUiSamples) break;',
    '    if (!isVisible(el)) continue;',
    '    const style = window.getComputedStyle(el);',
    '    const text = (el.getAttribute("aria-label") || el.getAttribute("alt") || el.textContent || "")',
    '      .replace(/\\s+/g, " ")',
    '      .trim()',
    '      .slice(0, 120);',
    '    const role = (el.getAttribute("role") || "").trim();',
    '    uiSamples.push({',
    '      text,',
    '      color: style.color || "",',
    '      backgroundColor: style.backgroundColor || "",',
    '      borderColor: style.borderColor || "",',
    '      parentBackgroundColor: resolveBg(el.parentElement || el) || "",',
    '      fontSize: style.fontSize || "",',
    '      fontWeight: style.fontWeight || "",',
    '      tag: el.tagName.toLowerCase(),',
    '      selector: elToSelector(el),',
    '      role',
    '    });',
    '  }',
    '  const html = (document.documentElement && document.documentElement.outerHTML) || "";',
    '  return {',
    '    styleSamples: samples,',
    '    uiSamples,',
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
        paths: { screenshot1, screenshot2 },
        cachedPages: mcp?.cachedPages
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
  if (
    mcp &&
    !mcp?.pageId &&
    (!Array.isArray(mcp?.cachedPages) || mcp.cachedPages.length === 0)
  ) {
    try {
      const list = await listMcpPages({ model, mcp, onLog, onStage, signal });
      if (Array.isArray(list?.pages) && list.pages.length) {
        mcp.cachedPages = list.pages;
      }
    } catch (err) {
      onLog?.(`Codex: failed to prefetch MCP list_pages (${err?.message || 'unknown error'})`);
    }
  }
  return runCodexEnrich({ url, model, mcp, onLog, onStage, signal });
}
