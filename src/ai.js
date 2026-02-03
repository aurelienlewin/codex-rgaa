import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATUS } from './checks.js';
import { createAbortError, isAbortError } from './abort.js';
import { getI18n, normalizeReportLang } from './i18n.js';
import {
  buildMcpArgs,
  looksLikeMcpConnectError,
  looksLikeMcpInstallOrNetworkError
} from './mcpConfig.js';

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

function normalizeAiStatus(status) {
  const normalized = String(status || '').trim();
  if (normalized === STATUS.C || normalized === STATUS.NC || normalized === STATUS.NA) {
    return normalized;
  }
  return STATUS.NC;
}

function buildEvidence(snapshot) {
  const safeSlice = (arr, max) => (Array.isArray(arr) ? arr.slice(0, max) : []);
  const caps = {
    headings: 60,
    links: 60,
    formControls: 60,
    images: 60,
    frames: 20,
    tables: 40,
    listItems: 60,
    langChanges: 40
  };
  const counts = {
    headings: Array.isArray(snapshot.headings) ? snapshot.headings.length : 0,
    links: Array.isArray(snapshot.links) ? snapshot.links.length : 0,
    formControls: Array.isArray(snapshot.formControls) ? snapshot.formControls.length : 0,
    images: Array.isArray(snapshot.images) ? snapshot.images.length : 0,
    frames: Array.isArray(snapshot.frames) ? snapshot.frames.length : 0,
    tables: Array.isArray(snapshot.tables) ? snapshot.tables.length : 0,
    listItems: Array.isArray(snapshot.listItems) ? snapshot.listItems.length : 0,
    langChanges: Array.isArray(snapshot.langChanges) ? snapshot.langChanges.length : 0
  };
  const truncated = Object.fromEntries(
    Object.entries(caps).map(([key, cap]) => [key, counts[key] > cap])
  );

  return {
    doctype: snapshot.doctype || '',
    title: snapshot.title || '',
    lang: snapshot.lang || '',
    href: snapshot.href || '',
    readyState: snapshot.readyState || '',
    headings: safeSlice(snapshot.headings, 60),
    links: safeSlice(snapshot.links, 60),
    formControls: safeSlice(snapshot.formControls, 60),
    images: safeSlice(snapshot.images, 60),
    frames: safeSlice(snapshot.frames, 20),
    tables: safeSlice(snapshot.tables, 40),
    listItems: safeSlice(snapshot.listItems, 60),
    langChanges: safeSlice(snapshot.langChanges, 40),
    media: snapshot.media || { video: 0, audio: 0, object: 0 },
    scripts: snapshot.scripts || { scriptTags: 0, hasInlineHandlers: false },
    visual: snapshot.visual || {
      svg: 0,
      canvas: 0,
      picture: 0,
      cssBackgroundImages: 0,
      bgExamples: []
    },
    counts,
    truncated
  };
}

function buildPrompt({ criterion, url, snapshot, reportLang, mcp }) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  const evidence = buildEvidence(snapshot);
  const useMcp = Boolean(mcp);
  const useOcr = Boolean(mcp?.ocr);
  const pageId =
    typeof mcp?.pageId === 'number' && Number.isFinite(mcp.pageId) ? mcp.pageId : null;
  const lines =
    i18n.lang === 'en'
      ? [
          'You are an RGAA auditor. Reply strictly following the provided JSON schema.',
          'Allowed statuses: "Conform", "Not conform", "Non applicable".',
          'Decision rules (in order):',
          '1) Applicability → return "Non applicable" ONLY if evidence clearly shows the criterion does not apply (no relevant elements).',
          '   Examples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Evidence sufficiency → if the criterion applies but required information is missing to verify compliance, return "Not conform" and state what is missing.',
          '3) Compliance → if any relevant element violates the requirement, return "Not conform"; return "Conform" only when evidence explicitly shows compliance for ALL relevant elements.',
          'Evidence is capped: headings/links/formControls/images/listItems up to 60; frames 20; tables 40; langChanges 40.',
          'If a list hits its cap or truncated.* is true, treat evidence as partial and avoid "Conform" unless the criterion can still be fully verified.',
          'Use only the provided evidence; no assumptions or external sources.',
          'Always include 1–4 short evidence items (even for Conform/Non applicable), each referencing a specific evidence path/value',
          '(e.g., images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'You MAY use chrome-devtools MCP tools to gather missing evidence. Use them only when needed.',
                'If using MCP tools:',
                pageId !== null
                  ? `- select_page with MCP_PAGE_ID=${pageId} then verify location.href.`
                  : '- list_pages then select a page whose URL matches; if none, navigate_page to MCP_TARGET_URL.',
                '- Verify location.href; if mismatched, navigate_page to MCP_TARGET_URL.',
                '- Prefer take_snapshot (a11y tree) and evaluate_script for targeted queries.',
                '- Use take_screenshot only for visual-only checks; do not claim anything you cannot verify.',
                '- Do NOT submit forms or change data/state.',
                'If you used MCP tools, include the relevant tool outputs in evidence items.',
                ...(useOcr
                  ? [
                      'OCR tool available: rgaa_ocr. Recommended flow: take_screenshot with filePath under /tmp, then call rgaa_ocr {path, lang?}.',
                      'Use OCR only to extract visible text from images; cite the OCR output in evidence.'
                    ]
                  : []),
                `MCP_TARGET_URL: ${url}`,
                pageId !== null ? `MCP_PAGE_ID: ${pageId}` : ''
              ].filter(Boolean)
            : []),
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
          'Règles de décision (dans l’ordre):',
          '1) Applicabilité → réponds "Non applicable" UNIQUEMENT si les preuves montrent clairement que le critère ne s’applique pas (aucun élément concerné).',
          '   Exemples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Suffisance des preuves → si le critère s’applique mais que des informations nécessaires manquent pour vérifier la conformité, réponds "Not conform" et précise ce qui manque.',
          '3) Conformité → si un élément concerné est non conforme, réponds "Not conform"; réponds "Conform" seulement si les preuves démontrent la conformité pour TOUS les éléments concernés.',
          'Les preuves sont tronquées: headings/links/formControls/images/listItems jusqu’à 60; frames 20; tables 40; langChanges 40.',
          'Si une liste atteint son maximum ou si truncated.* est true, considère l’échantillon comme partiel et évite "Conform" sauf si le critère reste entièrement vérifiable.',
          'Utilise uniquement les preuves fournies; pas d’hypothèses ni de sources externes.',
          'Fournis toujours 1–4 éléments de preuve courts (y compris Conforme/Non applicable), en citant un chemin/valeur précis',
          '(ex: images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'Tu PEUX utiliser les outils MCP chrome-devtools pour obtenir des preuves manquantes. Fais-le seulement si nécessaire.',
                'Si tu utilises MCP:',
                pageId !== null
                  ? `- select_page avec MCP_PAGE_ID=${pageId} puis vérifie location.href.`
                  : '- list_pages puis sélectionne une page dont l’URL correspond; sinon navigate_page vers MCP_TARGET_URL.',
                '- Vérifie location.href; si différent, navigate_page vers MCP_TARGET_URL.',
                '- Privilégie take_snapshot (arbre a11y) et evaluate_script pour des requêtes ciblées.',
                '- Utilise take_screenshot uniquement pour des vérifications visuelles; ne conclus rien d’invérifiable.',
                '- Ne soumets pas de formulaires et ne modifie pas l’état.',
                'Si tu utilises MCP, cite les sorties d’outils pertinentes dans les preuves.',
                ...(useOcr
                  ? [
                      'Outil OCR disponible : rgaa_ocr. Flux recommandé : take_screenshot avec filePath sous /tmp, puis rgaa_ocr {path, lang?}.',
                      'Utilise l’OCR uniquement pour extraire du texte visible; cite la sortie OCR dans les preuves.'
                    ]
                  : []),
                `MCP_TARGET_URL: ${url}`,
                pageId !== null ? `MCP_PAGE_ID: ${pageId}` : ''
              ].filter(Boolean)
            : []),
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

function buildBatchPrompt({ criteria, url, snapshot, reportLang, mcp }) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  const evidence = buildEvidence(snapshot);
  const useMcp = Boolean(mcp);
  const useOcr = Boolean(mcp?.ocr);
  const pageId =
    typeof mcp?.pageId === 'number' && Number.isFinite(mcp.pageId) ? mcp.pageId : null;
  const lines =
    i18n.lang === 'en'
      ? [
          'You are an RGAA auditor. Reply strictly following the provided JSON schema.',
          'Allowed statuses: "Conform", "Not conform", "Non applicable".',
          'You MUST return a JSON object with a "results" property (array) containing EXACTLY one result per provided criterion.',
          'Decision rules (in order):',
          '1) Applicability → return "Non applicable" ONLY if evidence clearly shows the criterion does not apply (no relevant elements).',
          '   Examples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Evidence sufficiency → if the criterion applies but required information is missing to verify compliance, return "Not conform" and state what is missing.',
          '3) Compliance → if any relevant element violates the requirement, return "Not conform"; return "Conform" only when evidence explicitly shows compliance for ALL relevant elements.',
          'Evidence is capped: headings/links/formControls/images/listItems up to 60; frames 20; tables 40; langChanges 40.',
          'If a list hits its cap or truncated.* is true, treat evidence as partial and avoid "Conform" unless the criterion can still be fully verified.',
          'Use only the provided evidence; no assumptions or external sources.',
          'For each item: always include 1–4 short evidence items, each referencing a specific evidence path/value',
          '(e.g., images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'You MAY use chrome-devtools MCP tools to gather missing evidence. Use them only when needed.',
                'If using MCP tools, do so once per batch and reuse the evidence across results.',
                pageId !== null
                  ? `- select_page with MCP_PAGE_ID=${pageId} then verify location.href.`
                  : '- list_pages then select a page whose URL matches; if none, navigate_page to MCP_TARGET_URL.',
                '- Verify location.href; if mismatched, navigate_page to MCP_TARGET_URL.',
                '- Prefer take_snapshot (a11y tree) and evaluate_script for targeted queries.',
                '- Use take_screenshot only for visual-only checks; do not claim anything you cannot verify.',
                '- Do NOT submit forms or change data/state.',
                'If you used MCP tools, include the relevant tool outputs in evidence items.',
                ...(useOcr
                  ? [
                      'OCR tool available: rgaa_ocr. Recommended flow: take_screenshot with filePath under /tmp, then call rgaa_ocr {path, lang?}.',
                      'Use OCR only to extract visible text from images; cite the OCR output in evidence.'
                    ]
                  : []),
                `MCP_TARGET_URL: ${url}`,
                pageId !== null ? `MCP_PAGE_ID: ${pageId}` : ''
              ].filter(Boolean)
            : []),
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
          'Règles de décision (dans l’ordre):',
          '1) Applicabilité → réponds "Non applicable" UNIQUEMENT si les preuves montrent clairement que le critère ne s’applique pas (aucun élément concerné).',
          '   Exemples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Suffisance des preuves → si le critère s’applique mais que des informations nécessaires manquent pour vérifier la conformité, réponds "Not conform" et précise ce qui manque.',
          '3) Conformité → si un élément concerné est non conforme, réponds "Not conform"; réponds "Conform" seulement si les preuves démontrent la conformité pour TOUS les éléments concernés.',
          'Les preuves sont tronquées: headings/links/formControls/images/listItems jusqu’à 60; frames 20; tables 40; langChanges 40.',
          'Si une liste atteint son maximum ou si truncated.* est true, considère l’échantillon comme partiel et évite "Conform" sauf si le critère reste entièrement vérifiable.',
          'Utilise uniquement les preuves fournies; pas d’hypothèses ni de sources externes.',
          'Pour chaque item: fournis toujours 1–4 éléments de preuve courts, en citant un chemin/valeur précis',
          '(ex: images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'Tu PEUX utiliser les outils MCP chrome-devtools pour obtenir des preuves manquantes. Fais-le seulement si nécessaire.',
                'Si tu utilises MCP, fais-le une fois par batch et réutilise les preuves.',
                pageId !== null
                  ? `- select_page avec MCP_PAGE_ID=${pageId} puis vérifie location.href.`
                  : '- list_pages puis sélectionne une page dont l’URL correspond; sinon navigate_page vers MCP_TARGET_URL.',
                '- Vérifie location.href; si différent, navigate_page vers MCP_TARGET_URL.',
                '- Privilégie take_snapshot (arbre a11y) et evaluate_script pour des requêtes ciblées.',
                '- Utilise take_screenshot uniquement pour des vérifications visuelles; ne conclus rien d’invérifiable.',
                '- Ne soumets pas de formulaires et ne modifie pas l’état.',
                'Si tu utilises MCP, cite les sorties d’outils pertinentes dans les preuves.',
                ...(useOcr
                  ? [
                      'Outil OCR disponible : rgaa_ocr. Flux recommandé : take_screenshot avec filePath sous /tmp, puis rgaa_ocr {path, lang?}.',
                      'Utilise l’OCR uniquement pour extraire du texte visible; cite la sortie OCR dans les preuves.'
                    ]
                  : []),
                `MCP_TARGET_URL: ${url}`,
                pageId !== null ? `MCP_PAGE_ID: ${pageId}` : ''
              ].filter(Boolean)
            : []),
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
  signal,
  mcp
}) {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const outputFile = path.join(
    os.tmpdir(),
    `codex-rgaa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const codexPath = process.env.CODEX_PATH || 'codex';
  const buildArgs = (mcpConfig) => {
    const args = [];
    if (mcpConfig) {
      // Allow non-interactive MCP startup (no TTY for approvals).
      args.push('-a', 'on-failure');
    }
    args.push('exec');
    if (mcpConfig) {
      args.push(...buildMcpArgs(mcpConfig));
    } else {
      // AI review only consumes the provided JSON evidence; it does not need any MCP server.
      // Keeping MCP disabled avoids flaky/slow `npx` installs and keeps runs reliable.
      args.push('-c', 'mcp_servers={}');
    }
    args.push(
      '--skip-git-repo-check',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outputFile,
      '--color',
      'never',
      '--sandbox',
      'read-only'
    );
    if (model) {
      args.push('-m', model);
    }
    args.push('-');
    return args;
  };

  onStage?.('AI: preparing prompt');
  onLog?.('Codex: preparing prompt');
  const useProcessGroup = process.platform !== 'win32';
  let abortRequested = false;
  let abortHandler = null;

  const runOnce = async (env, args) =>
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

  const runWithEnv = async (env, mcpConfig) => {
    try {
      await runOnce(env, buildArgs(mcpConfig));
    } catch (err) {
      // Common failure mode in sandboxed/CI environments: ~/.codex isn't writable.
      if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err.stderr)) {
        const fallbackHome = getFallbackCodexHome();
        await ensureDir(fallbackHome);
        await ensureDir(path.join(fallbackHome, 'sessions'));
        await ensureDir(path.join(fallbackHome, 'npm-cache'));
        await seedCodexConfig(fallbackHome, onLog);
        onLog?.(`Codex: retrying with CODEX_HOME=${fallbackHome}`);
        await runOnce(buildCodexEnv({ codexHome: fallbackHome }), buildArgs(mcpConfig));
        return;
      }
      throw err;
    }
  };

  try {
    await runWithEnv(buildCodexEnv(), mcp);
  } catch (err) {
    if (mcp && (looksLikeMcpConnectError(err.stderr) || looksLikeMcpInstallOrNetworkError(err.stderr))) {
      onLog?.('Codex: MCP failed, retrying AI review without MCP.');
      try {
        await runWithEnv(buildCodexEnv(), null);
      } catch (fallbackErr) {
        const hint = summarizeCodexStderr(fallbackErr.stderr);
        if (hint && fallbackErr && fallbackErr.message && !fallbackErr.message.includes(hint)) {
          fallbackErr.message = `${fallbackErr.message} (${hint})`;
        }
        throw fallbackErr;
      }
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
  signal,
  mcp
}) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  try {
    if (signal?.aborted) {
      throw createAbortError();
    }
    onStage?.('AI: building prompt');
    const prompt = buildPrompt({ criterion, url, snapshot, reportLang, mcp });
    const timeoutRaw = Number(process.env.AUDIT_CODEX_CRITERION_TIMEOUT_MS || '');
    const timeoutMs =
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 120000;
    const content = await runCodexPrompt({
      prompt,
      model,
      timeoutMs,
      onLog,
      onStage,
      signal,
      mcp
    });
    const parsed = JSON.parse(content);
    const confidence = Number(parsed.confidence || 0);
    const rationale = parsed.rationale || '';
    const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];

    return {
      status: normalizeAiStatus(parsed.status),
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
  signal,
  mcp
}) {
  try {
    if (signal?.aborted) {
      throw createAbortError();
    }
    onStage?.(`AI: building batch prompt (${criteria.length})`);
    const prompt = buildBatchPrompt({ criteria, url, snapshot, reportLang, mcp });
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
      signal,
      mcp
    });
    const parsed = JSON.parse(content);
    const results = parsed?.results;
    if (!Array.isArray(results)) {
      throw new Error('Invalid AI batch response (expected {results: [...]}).');
    }
    return results.map((res) => ({
      ...res,
      status: normalizeAiStatus(res?.status)
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
