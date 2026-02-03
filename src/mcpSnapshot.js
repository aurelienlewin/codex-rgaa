import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAbortError, isAbortError } from './abort.js';
import { getSnapshotExpression } from './snapshot.js';

const SCHEMA_PATH = fileURLToPath(new URL('../data/mcp-snapshot-schema.json', import.meta.url));
const LIST_PAGES_SCHEMA_PATH = fileURLToPath(
  new URL('../data/mcp-list-pages-schema.json', import.meta.url)
);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function normalizeBrowserUrl(browserUrl) {
  const url = String(browserUrl || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  return `http://${url}`;
}

function resolveLocalMcpBinary() {
  const name =
    process.platform === 'win32' ? 'chrome-devtools-mcp.cmd' : 'chrome-devtools-mcp';
  const localPath = path.join(PROJECT_ROOT, 'node_modules', '.bin', name);
  try {
    fsSync.accessSync(localPath, fsSync.constants.X_OK);
    return localPath;
  } catch {
    return '';
  }
}

function resolveMcpCommand() {
  const overridden = String(process.env.AUDIT_MCP_COMMAND || '').trim();
  if (overridden) return { command: overridden, baseArgs: [] };

  const local = resolveLocalMcpBinary();
  if (local) return { command: local, baseArgs: [] };

  // Upstream recommends using `npx -y` to avoid interactive install prompts.
  // This is critical for non-interactive `codex exec` runs where there is no TTY.
  return { command: resolveNpxCommand(), baseArgs: ['-y', 'chrome-devtools-mcp@latest'] };
}

function buildMcpArgs({ browserUrl, autoConnect, channel } = {}) {
  if (process.env.CODEX_MCP_MODE === 'none') {
    return ['-c', 'mcp_servers={}'];
  }

  const url = normalizeBrowserUrl(browserUrl || process.env.AUDIT_MCP_BROWSER_URL);
  const resolvedAutoConnect =
    url ? false : typeof autoConnect === 'boolean' ? autoConnect : true;
  const resolvedChannel = String(channel || process.env.AUDIT_MCP_CHANNEL || '').trim();

  // We still set npm_config_yes=true in buildCodexEnv(), but `npx -y` is the most reliable
  // way to suppress install prompts across npm versions.
  const { command, baseArgs } = resolveMcpCommand();
  const args = [...baseArgs];
  if (url) {
    args.push(`--browser-url=${url}`);
  } else if (resolvedAutoConnect) {
    args.push('--autoConnect');
    if (resolvedChannel) args.push(`--channel=${resolvedChannel}`);
  }

  // Codex `-c` values are parsed as TOML. Use dotted paths so values are valid TOML scalars/arrays.
  return [
    '-c',
    'mcp_servers={}',
    '-c',
    `mcp_servers.chrome-devtools.command=${JSON.stringify(command)}`,
    '-c',
    `mcp_servers.chrome-devtools.args=${JSON.stringify(args)}`,
    '-c',
    'mcp_servers.chrome-devtools.startup_timeout_sec=30'
  ];
}

function buildPrompt({ url, pageId } = {}) {
  const expression = getSnapshotExpression();
  const targetLabel =
    typeof pageId === 'number' && Number.isFinite(pageId)
      ? `page id ${pageId}`
      : `URL ${url}`;
  return [
    'Tu es un outil technique. Utilise uniquement le MCP chrome-devtools.',
    'Étapes obligatoires:',
    '1) Détermine la page cible:',
    typeof pageId === 'number' && Number.isFinite(pageId)
      ? `- Sélectionne la page ${pageId} avec select_page.`
      : '- Liste les pages avec list_pages; si une page correspond à l’URL, sélectionne-la avec select_page; sinon navigue vers l’URL avec navigate_page.',
    `2) Vérifie que location.href correspond bien à la cible (${targetLabel}); si besoin navigue vers l’URL.`,
    '3) Exécute la fonction JS fournie via evaluate_script pour attendre le chargement et collecter le snapshot.',
    '4) Réponds uniquement avec le JSON retourné (pas de texte supplémentaire).',
    '',
    `URL: ${url}`,
    typeof pageId === 'number' && Number.isFinite(pageId) ? `PAGE_ID: ${pageId}` : '',
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

function resolveNpxCommand() {
  if (process.env.AUDIT_NPX_PATH) return String(process.env.AUDIT_NPX_PATH);
  if (process.platform === 'win32') return 'npx.cmd';

  const candidates = [
    // Homebrew default locations (covers some sanitized PATH cases).
    '/usr/local/bin/npx',
    '/opt/homebrew/bin/npx',
    'npx'
  ];

  for (const candidate of candidates) {
    try {
      if (candidate === 'npx') return candidate;
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {}
  }

  return 'npx';
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

function looksLikeMcpConnectError(stderr) {
  const text = String(stderr || '').toLowerCase();
  return (
    text.includes('econnrefused') ||
    text.includes('connection refused') ||
    text.includes('connect') && text.includes('9222') ||
    text.includes('websocket') ||
    text.includes('ws://') ||
    text.includes('devtools') && text.includes('connect')
  );
}

function looksLikeMcpInstallOrNetworkError(stderr) {
  const text = String(stderr || '').toLowerCase();
  return (
    (text.includes('chrome-devtools-mcp') &&
      (text.includes('registry.npmjs.org') ||
        text.includes('npm error network') ||
        text.includes('enotfound') ||
        text.includes('etimedout') ||
        text.includes('eai_again') ||
        text.includes('self signed certificate') ||
        text.includes('unable to get local issuer certificate'))) ||
    (text.includes('npx') && text.includes('network'))
  );
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
      `(Cannot connect to Chrome DevTools. If you used http://127.0.0.1:9222, start Chrome with --remote-debugging-port=9222 or switch to MCP auto-connect, or use --snapshot-mode cdp.)`;
  }
  if (looksLikeMcpInstallOrNetworkError(err.stderr) && err?.message) {
    err.message =
      `${err.message} ` +
      `(MCP server unavailable: use --snapshot-mode cdp, or set AUDIT_MCP_COMMAND to a pre-installed chrome-devtools-mcp)`;
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

function buildCodexEnv({ codexHome } = {}) {
  const env = { ...process.env };
  if (codexHome) env.CODEX_HOME = codexHome;
  // This project relies on Codex network access to reach the OpenAI API.
  // In some Codex-managed environments, CODEX_SANDBOX_NETWORK_DISABLED=1 is inherited,
  // which breaks `codex exec` runs. Override it for the nested Codex process.
  env.CODEX_SANDBOX_NETWORK_DISABLED = '0';

  const cacheRoot = codexHome || env.CODEX_HOME || os.tmpdir();
  // Make npx/npm usable even when $HOME is not writable (common in sandboxed environments).
  env.npm_config_cache = env.npm_config_cache || path.join(cacheRoot, 'npm-cache');
  env.npm_config_yes = env.npm_config_yes || 'true';
  env.npm_config_update_notifier = env.npm_config_update_notifier || 'false';
  env.npm_config_fund = env.npm_config_fund || 'false';
  env.npm_config_audit = env.npm_config_audit || 'false';
  return env;
}

async function runCodexSnapshot({ url, model, mcp, onLog, onStage, signal }) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const outputFile = path.join(
    os.tmpdir(),
    `codex-mcp-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const codexPath = process.env.CODEX_PATH || 'codex';
  const buildArgs = (mcpConfig, schemaPath) => {
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
    if (model) args.push('-m', model);
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
      child.stdin.write(buildPrompt({ url, pageId: mcp?.pageId }));
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
    // Default behavior may point to an existing local CDP endpoint (127.0.0.1:9222).
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

  onStage?.('AI: parsing MCP snapshot');
  onLog?.('Codex: parsing MCP snapshot');
  const content = await fs.readFile(outputFile, 'utf-8');
  await fs.unlink(outputFile).catch(() => {});
  return JSON.parse(content);
}

export async function collectSnapshotWithMcp({ url, model, mcp, onLog, onStage, signal }) {
  return runCodexSnapshot({ url, model, mcp, onLog, onStage, signal });
}

export async function listMcpPages({ model, mcp, onLog, onStage, signal }) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const outputFile = path.join(
    os.tmpdir(),
    `codex-mcp-list-pages-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const codexPath = process.env.CODEX_PATH || 'codex';
  const buildArgs = (mcpConfig) => {
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
    if (model) args.push('-m', model);
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

  onStage?.('AI: parsing MCP list_pages');
  onLog?.('Codex: parsing MCP list_pages');
  const content = await fs.readFile(outputFile, 'utf-8');
  await fs.unlink(outputFile).catch(() => {});
  return JSON.parse(content);
}
