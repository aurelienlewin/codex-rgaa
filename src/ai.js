import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATUS } from './checks.js';
import { createAbortError, isAbortError } from './abort.js';
import { getI18n, normalizeReportLang } from './i18n.js';

const activeCodexChildren = new Set();
const childProcessGroup = new WeakMap();
const childKillTimers = new Map();

function looksLikeCodexHomePermissionError(stderr) {
  const text = String(stderr || '');
  return (
    text.includes('Codex cannot access session files') ||
    text.includes('permission denied') ||
    text.includes('Operation not permitted (os error 1)') ||
    text.includes('Error finding codex home') ||
    text.includes('CODEX_HOME points to')
  );
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

function summarizeCodexStderr(stderr) {
  const text = String(stderr || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer the last explicit error line, else tail.
  const lastError = [...lines].reverse().find((l) => l.toLowerCase().includes('error'));
  return (lastError || lines[lines.length - 1] || '').slice(0, 400);
}

function terminateChild(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  const useGroup = childProcessGroup.get(child);
  const killWith = (signal) => {
    try {
      if (useGroup && pid) {
        process.kill(-pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {}
  };

  killWith('SIGTERM');
  if (!childKillTimers.has(child)) {
    const timer = setTimeout(() => killWith('SIGKILL'), 2000);
    if (typeof timer.unref === 'function') timer.unref();
    childKillTimers.set(child, timer);
  }
}

function registerChild(child, useGroup) {
  activeCodexChildren.add(child);
  childProcessGroup.set(child, useGroup);

  const cleanup = () => {
    activeCodexChildren.delete(child);
    const timer = childKillTimers.get(child);
    if (timer) clearTimeout(timer);
    childKillTimers.delete(child);
  };

  child.once('exit', cleanup);
  child.once('close', cleanup);
}

export function terminateCodexChildren() {
  for (const child of activeCodexChildren) {
    terminateChild(child);
  }
}

const SCHEMA_PATH = fileURLToPath(new URL('../data/codex-review-schema.json', import.meta.url));
const BATCH_SCHEMA_PATH = fileURLToPath(
  new URL('../data/codex-review-batch-schema.json', import.meta.url)
);

function looksLikeNonVerifiable({ rationale, evidence } = {}) {
  const text = `${rationale || ''} ${(Array.isArray(evidence) ? evidence.join(' ') : '')}`
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return false;
  return (
    text.includes('insufficient evidence') ||
    text.includes('insufficient') ||
    text.includes('not enough evidence') ||
    text.includes('missing evidence') ||
    text.includes('cannot verify') ||
    text.includes('cannot be verified') ||
    text.includes('unable to verify') ||
    text.includes('non-verifiable') ||
    text.includes('non verifiable') ||
    text.includes('preuves insuffisantes') ||
    text.includes('preuve insuffisante') ||
    text.includes('manque de preuves') ||
    text.includes('preuve manquante') ||
    text.includes('non vérifiable') ||
    text.includes('impossible de vérifier') ||
    text.includes('impossible a verifier')
  );
}

function normalizeAiStatus(status, { rationale, evidence } = {}) {
  const normalized = String(status || '').trim();
  if (normalized === STATUS.NC && looksLikeNonVerifiable({ rationale, evidence })) {
    return STATUS.NA;
  }
  return normalized || STATUS.NC;
}

function buildEvidence(snapshot) {
  const safeSlice = (arr, max) => (Array.isArray(arr) ? arr.slice(0, max) : []);
  return {
    doctype: snapshot.doctype || '',
    title: snapshot.title || '',
    lang: snapshot.lang || '',
    headings: safeSlice(snapshot.headings, 60),
    links: safeSlice(snapshot.links, 60),
    formControls: safeSlice(snapshot.formControls, 60),
    images: safeSlice(snapshot.images, 60),
    frames: safeSlice(snapshot.frames, 20),
    tables: safeSlice(snapshot.tables, 40),
    listItems: safeSlice(snapshot.listItems, 60),
    langChanges: safeSlice(snapshot.langChanges, 40),
    media: snapshot.media || { video: 0, audio: 0, object: 0 },
    scripts: snapshot.scripts || { scriptTags: 0, hasInlineHandlers: false }
  };
}

function buildPrompt({ criterion, url, snapshot, reportLang }) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  const evidence = buildEvidence(snapshot);
  const lines =
    i18n.lang === 'en'
      ? [
          'You are an RGAA auditor. Reply strictly following the provided JSON schema.',
          'Allowed statuses: "Conform", "Not conform", "Non applicable".',
          'Use only the provided evidence. If evidence is insufficient or non-verifiable, return "Non applicable" and explain what is missing.',
          'Always include 1–4 short evidence items for every result (including Conform and Non applicable).',
          '',
          'Data:',
          JSON.stringify({
            criterion_id: criterion.id,
            criterion_title: criterion.title,
            url,
            evidence
          })
        ]
      : [
          'Tu es un auditeur RGAA. Réponds strictement au schéma JSON fourni.',
          'Statuts autorisés: "Conform", "Not conform", "Non applicable".',
          'Utilise uniquement les preuves fournies. Si les preuves sont insuffisantes ou non vérifiables, réponds "Non applicable" en expliquant ce qui manque.',
          'Fournis toujours 1–4 éléments de preuve courts pour chaque résultat (y compris Conforme et Non applicable).',
          '',
          'Données:',
          JSON.stringify({
            criterion_id: criterion.id,
            criterion_title: criterion.title,
            url,
            evidence
          })
        ];
  return lines.join('\n');
}

function buildBatchPrompt({ criteria, url, snapshot, reportLang }) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  const evidence = buildEvidence(snapshot);
  const lines =
    i18n.lang === 'en'
      ? [
          'You are an RGAA auditor. Reply strictly following the provided JSON schema.',
          'Allowed statuses: "Conform", "Not conform", "Non applicable".',
          'You MUST return a JSON object with a "results" property (array) containing EXACTLY one result per provided criterion.',
          'Use only the provided evidence. If evidence is insufficient or non-verifiable for a criterion, return "Non applicable" and explain what is missing.',
          'For each item: always include 1–4 short evidence items (even for Conform and Non applicable).',
          '',
          'Data:',
          JSON.stringify({
            url,
            criteria: criteria.map((c) => ({
              criterion_id: c.id,
              criterion_title: c.title,
              theme: c.theme
            })),
            evidence
          })
        ]
      : [
          'Tu es un auditeur RGAA. Réponds strictement au schéma JSON fourni.',
          'Statuts autorisés: "Conform", "Not conform", "Non applicable".',
          'Tu dois retourner un objet JSON contenant une propriété "results" (tableau) avec EXACTEMENT un résultat par critère fourni.',
          'Utilise uniquement les preuves fournies. Si les preuves sont insuffisantes ou non vérifiables pour un critère, réponds "Non applicable" en expliquant ce qui manque.',
          'Pour chaque item: fournis toujours 1–4 éléments de preuve courts (y compris Conforme et Non applicable).',
          '',
          'Données:',
          JSON.stringify({
            url,
            criteria: criteria.map((c) => ({
              criterion_id: c.id,
              criterion_title: c.title,
              theme: c.theme
            })),
            evidence
          })
        ];
  return lines.join('\n');
}

async function runCodexPrompt({
  prompt,
  model,
  schemaPath = SCHEMA_PATH,
  timeoutMs = 120000,
  onLog,
  onStage,
  signal
}) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const outputFile = path.join(
    os.tmpdir(),
    `codex-rgaa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const codexPath = process.env.CODEX_PATH || 'codex';
  const args = [
    'exec',
    // AI review only consumes the provided JSON evidence; it does not need any MCP server.
    // Keeping MCP disabled avoids flaky/slow `npx` installs and keeps runs reliable.
    '-c',
    'mcp_servers={}',
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

  if (model) {
    args.push('-m', model);
  }

  args.push('-');

  onStage?.('AI: preparing prompt');
  onLog?.('Codex: preparing prompt');
  const useProcessGroup = process.platform !== 'win32';
  let abortRequested = false;
  let abortHandler = null;

  const runOnce = async (env) =>
    new Promise((resolve, reject) => {
      onStage?.('AI: spawning Codex');
      const child = spawn(codexPath, args, {
        stdio: ['pipe', 'ignore', 'pipe'],
        detached: useProcessGroup,
        env
      });
      registerChild(child, useProcessGroup);

      let settled = false;
      let stderrText = '';
      let timeout = null;
      const finalize = (err) => {
        if (settled) return;
        settled = true;
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        if (timeout) clearTimeout(timeout);
        if (err) {
          err.stderr = stderrText;
          reject(err);
        } else {
          resolve();
        }
      };

      timeout = setTimeout(() => {
        onLog?.(`Codex: timeout after ${timeoutMs}ms`);
        terminateChild(child);
        finalize(new Error(`codex exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timeout.unref === 'function') timeout.unref();

      abortHandler = () => {
        abortRequested = true;
        onLog?.('Codex: abort signal received');
        terminateChild(child);
      };

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      child.on('error', (err) => {
        if (abortRequested || signal?.aborted || isAbortError(err)) {
          finalize(createAbortError());
          return;
        }
        finalize(err);
      });
      child.on('exit', (code) => {
        if (abortRequested || signal?.aborted) {
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

      onStage?.('AI: running inference');
      onLog?.('Codex: running inference');
      child.stdin.write(prompt);
      child.stdin.end();
    });

  // Ensure a user-provided CODEX_HOME exists; Codex exits early if it doesn't.
  if (process.env.CODEX_HOME) {
    await ensureDir(process.env.CODEX_HOME);
  }

  try {
    await runOnce(buildCodexEnv());
  } catch (err) {
    // Common failure mode in sandboxed/CI environments: ~/.codex isn't writable.
    if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err.stderr)) {
      const fallbackHome = getFallbackCodexHome();
      await ensureDir(fallbackHome);
      await ensureDir(path.join(fallbackHome, 'sessions'));
      await ensureDir(path.join(fallbackHome, 'npm-cache'));
      await seedCodexConfig(fallbackHome, onLog);
      onLog?.(`Codex: retrying with CODEX_HOME=${fallbackHome}`);
      await runOnce(buildCodexEnv({ codexHome: fallbackHome }));
    } else {
      // Surface a meaningful hint to the caller.
      const hint = summarizeCodexStderr(err.stderr);
      if (hint && err && err.message && !err.message.includes(hint)) {
        err.message = `${err.message} (${hint})`;
      }
      throw err;
    }
  }

  onStage?.('AI: parsing response');
  onLog?.('Codex: parsing response');
  const content = await fs.readFile(outputFile, 'utf-8');
  await fs.unlink(outputFile).catch(() => {});
  return content;
}

export async function aiReviewCriterion({
  model,
  url,
  criterion,
  snapshot,
  reportLang,
  onLog,
  onStage,
  signal
}) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  try {
    if (signal?.aborted) {
      throw createAbortError();
    }
    onStage?.('AI: building prompt');
    const prompt = buildPrompt({ criterion, url, snapshot, reportLang });
    const timeoutRaw = Number(process.env.AUDIT_CODEX_CRITERION_TIMEOUT_MS || '');
    const timeoutMs =
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 120000;
    const content = await runCodexPrompt({ prompt, model, timeoutMs, onLog, onStage, signal });
    const parsed = JSON.parse(content);
    const confidence = Number(parsed.confidence || 0);
    const rationale = parsed.rationale || '';
    const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];

    return {
      status: normalizeAiStatus(parsed.status, { rationale, evidence }),
      notes: `${i18n.notes.aiReviewLabel()} (${confidence.toFixed(2)}): ${rationale}`,
      ai: { confidence, rationale, evidence }
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    const hint = summarizeCodexStderr(err?.stderr);
    const message = hint && err?.message && !String(err.message).includes(hint)
      ? `${err.message} (${hint})`
      : err.message;
    return {
      status: STATUS.ERR,
      notes: `${i18n.notes.aiFailed()}: ${message}`,
      ai: null
    };
  }
}

export async function aiReviewCriteriaBatch({
  model,
  url,
  criteria,
  snapshot,
  reportLang,
  onLog,
  onStage,
  signal
}) {
  try {
    if (signal?.aborted) {
      throw createAbortError();
    }
    onStage?.(`AI: building batch prompt (${criteria.length})`);
    const prompt = buildBatchPrompt({ criteria, url, snapshot, reportLang });
    const timeoutRaw = Number(process.env.AUDIT_CODEX_BATCH_TIMEOUT_MS || '');
    const timeoutMs =
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 240000;
    const content = await runCodexPrompt({
      prompt,
      model,
      schemaPath: BATCH_SCHEMA_PATH,
      timeoutMs,
      onLog,
      onStage,
      signal
    });
    const parsed = JSON.parse(content);
    const results = parsed?.results;
    if (!Array.isArray(results)) {
      throw new Error('Invalid AI batch response (expected {results: [...]}).');
    }
    return results.map((res) => ({
      ...res,
      status: normalizeAiStatus(res?.status, {
        rationale: res?.rationale,
        evidence: Array.isArray(res?.evidence) ? res.evidence : []
      })
    }));
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    const hint = summarizeCodexStderr(err?.stderr);
    const message =
      hint && err?.message && !String(err.message).includes(hint) ? `${err.message} (${hint})` : err.message;
    throw new Error(`AI batch review failed: ${message}`);
  }
}
