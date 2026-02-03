import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAbortError, isAbortError } from './abort.js';
import { getSnapshotExpression } from './snapshot.js';
import {
  buildMcpArgs,
  normalizeBrowserUrl,
  looksLikeMcpConnectError,
  looksLikeMcpInstallOrNetworkError
} from './mcpConfig.js';
import { validateStrictOutputSchema } from './schemaValidate.js';

const SCHEMA_PATH = fileURLToPath(new URL('../data/mcp-snapshot-schema.json', import.meta.url));
const LIST_PAGES_SCHEMA_PATH = fileURLToPath(
  new URL('../data/mcp-list-pages-schema.json', import.meta.url)
);

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
  return runCodexSnapshot({ url, model, mcp, onLog, onStage, signal });
}

export async function listMcpPages({ model, mcp, onLog, onStage, signal }) {
  if (signal?.aborted) {
    throw createAbortError();
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
  return JSON.parse(content);
}
