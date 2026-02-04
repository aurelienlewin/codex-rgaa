import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATUS } from './checks.js';
import { createAbortError, isAbortError } from './abort.js';
import { getI18n, normalizeReportLang } from './i18n.js';
import { validateStrictOutputSchema } from './schemaValidate.js';
import { attachIgnoreEpipe } from './streamErrors.js';
import { applyCodexBaseUrlFromConfig, looksLikeMissingAuth, maybeHandleMissingAuth } from './codexAuth.js';
import {
  buildMcpArgs,
  looksLikeMcpConnectError,
  looksLikeMcpInstallOrNetworkError
} from './mcpConfig.js';

const CODEX_MAX_CONCURRENT = (() => {
  const raw = Number(process.env.AUDIT_CODEX_MAX_CONCURRENT || '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
})();
let codexInFlight = 0;
const codexWaiters = [];
async function acquireCodexSlot() {
  if (codexInFlight < CODEX_MAX_CONCURRENT) {
    codexInFlight += 1;
    return;
  }
  await new Promise((resolve) => codexWaiters.push(resolve));
  codexInFlight += 1;
}
function releaseCodexSlot() {
  codexInFlight = Math.max(0, codexInFlight - 1);
  const next = codexWaiters.shift();
  if (next) next();
}

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

function summarizeCodexStderr(stderr) {
  const text = String(stderr || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer the last explicit error line, else tail.
  const lastError = [...lines].reverse().find((l) => l.toLowerCase().includes('error'));
  return (lastError || lines[lines.length - 1] || '').slice(0, 400);
}

const alertMissingAuth = (onError, stderr) =>
  maybeHandleMissingAuth({ onError, stderr });

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

let schemaPreflightDone = false;
async function preflightSchemas(onLog) {
  if (schemaPreflightDone) return;
  schemaPreflightDone = true;
  const checks = [
    { label: 'codex review', path: SCHEMA_PATH },
    { label: 'codex review batch', path: BATCH_SCHEMA_PATH }
  ];
  for (const item of checks) {
    const res = await validateStrictOutputSchema(item.path);
    if (!res.ok) {
      onLog?.(`Codex: schema preflight failed for ${item.label}`);
      const msg =
        `Invalid structured-output schema (${item.label}):\n` +
        res.problems.map((p) => `- ${p}`).join('\n');
      throw new Error(msg);
    }
  }
}

function looksLikeModelNotFound(stderr) {
  const text = String(stderr || '').toLowerCase();
  return (
    text.includes('model_not_found') ||
    (text.includes('requested model') && text.includes('does not exist')) ||
    (text.includes('does not exist') && text.includes('model'))
  );
}

function normalizeAiStatus(status) {
  const normalized = String(status || '').trim();
  if (normalized === STATUS.C || normalized === STATUS.NC || normalized === STATUS.NA || normalized === STATUS.REVIEW) {
    return normalized;
  }
  return STATUS.NC;
}

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

function buildEvidence(snapshot) {
  const safeSlice = (arr, max) => (Array.isArray(arr) ? arr.slice(0, max) : []);
  const caps = {
    headings: 60,
    links: 60,
    formControls: 60,
    images: 60,
    frames: 20,
    tables: 40,
    fieldsets: 30,
    buttons: 40,
    landmarks: 40,
    focusables: 80,
    dirChanges: 40,
    rolesSummary: 30,
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
    fieldsets: Array.isArray(snapshot.fieldsets) ? snapshot.fieldsets.length : 0,
    buttons: Array.isArray(snapshot.buttons) ? snapshot.buttons.length : 0,
    landmarks: Array.isArray(snapshot.landmarks) ? snapshot.landmarks.length : 0,
    focusables: Array.isArray(snapshot.focusables) ? snapshot.focusables.length : 0,
    listItems: Array.isArray(snapshot.listItems) ? snapshot.listItems.length : 0,
    langChanges: Array.isArray(snapshot.langChanges) ? snapshot.langChanges.length : 0,
    dirChanges: Array.isArray(snapshot.dirChanges) ? snapshot.dirChanges.length : 0,
    rolesSummary: Array.isArray(snapshot.rolesSummary) ? snapshot.rolesSummary.length : 0
  };
  const truncated = Object.fromEntries(
    Object.entries(caps).map(([key, cap]) => [key, counts[key] > cap])
  );

  return {
    doctype: snapshot.doctype || '',
    title: snapshot.title || '',
    lang: snapshot.lang || '',
    dir: snapshot.dir || '',
    href: snapshot.href || '',
    readyState: snapshot.readyState || '',
    headings: safeSlice(snapshot.headings, 60),
    links: safeSlice(snapshot.links, 60),
    formControls: safeSlice(snapshot.formControls, 60),
    images: safeSlice(snapshot.images, 60),
    frames: safeSlice(snapshot.frames, 20),
    tables: safeSlice(snapshot.tables, 40),
    fieldsets: safeSlice(snapshot.fieldsets, 30),
    buttons: safeSlice(snapshot.buttons, 40),
    landmarks: safeSlice(snapshot.landmarks, 40),
    focusables: safeSlice(snapshot.focusables, 80),
    listItems: safeSlice(snapshot.listItems, 60),
    langChanges: safeSlice(snapshot.langChanges, 40),
    dirChanges: safeSlice(snapshot.dirChanges, 40),
    headingsSummary: snapshot.headingsSummary || {
      total: 0,
      h1: 0,
      h2: 0,
      h3: 0,
      h4: 0,
      h5: 0,
      h6: 0
    },
    tableSummary: snapshot.tableSummary || {
      total: 0,
      withCaption: 0,
      withTh: 0,
      withScope: 0,
      withId: 0,
      withHeadersAttr: 0,
      withThead: 0
    },
    linkSummary: snapshot.linkSummary || {
      total: 0,
      targetBlank: 0,
      targetBlankNoRel: 0,
      fragmentLinks: 0
    },
    formSummary: snapshot.formSummary || {
      controlsTotal: 0,
      missingLabel: 0,
      requiredCount: 0,
      autocompleteCount: 0,
      describedByCount: 0,
      inFieldsetCount: 0,
      fieldsetCount: 0,
      fieldsetWithLegendCount: 0
    },
    focusableSummary: snapshot.focusableSummary || {
      total: 0,
      tabindexPositive: 0,
      tabindexZero: 0,
      maxTabindex: 0
    },
    media: snapshot.media || { video: 0, audio: 0, object: 0 },
    mediaDetails: snapshot.mediaDetails || { videos: [], audios: [] },
    scripts: snapshot.scripts || { scriptTags: 0, hasInlineHandlers: false },
    meta: snapshot.meta || { viewport: '', refresh: '' },
    ariaLive: snapshot.ariaLive || {
      liveRegions: 0,
      rolesCount: 0,
      politeness: { polite: 0, assertive: 0, off: 0 },
      roles: { alert: 0, status: 0, log: 0, marquee: 0, timer: 0 }
    },
    ariaSummary: snapshot.ariaSummary || {
      label: 0,
      labelledby: 0,
      describedby: 0,
      hidden: 0
    },
    rolesSummary: safeSlice(snapshot.rolesSummary, 30),
    visual: snapshot.visual || {
      svg: 0,
      canvas: 0,
      picture: 0,
      cssBackgroundImages: 0,
      bgExamples: []
    },
    enrichment: snapshot.enrichment || null,
    counts,
    truncated
  };
}

function buildPrompt({ criterion, url, snapshot, reportLang, mcp, retry = false }) {
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
          'Allowed statuses: "Conform", "Not conform", "Non applicable", "Review".',
          'Decision rules (in order):',
          '1) Applicability → return "Non applicable" ONLY if evidence clearly shows the criterion does not apply (no relevant elements).',
          '   Examples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Evidence sufficiency → if the criterion applies but required information is missing to verify compliance EVEN after using MCP tools, return "Review" and state what is missing.',
          '3) Compliance → if any relevant element violates the requirement, return "Not conform"; return "Conform" only when evidence explicitly shows compliance for ALL relevant elements.',
          ...(retry
            ? [
                'Previous pass returned "Review". Re-check using MCP tools to resolve missing evidence; return "Review" only if still blocked after targeted tool use.'
              ]
            : []),
          'Evidence is capped: headings/links/formControls/images/listItems up to 60; frames 20; tables 40; fieldsets 30; buttons 40; landmarks 40; focusables 80; dirChanges 40; rolesSummary 30; langChanges 40.',
          'If a list hits its cap or truncated.* is true, treat evidence as partial and avoid "Conform" unless the criterion can still be fully verified.',
          'Use only the provided evidence; no assumptions or external sources.',
          'Extra evidence may be provided under enrichment (motion detection, contrast summary, UI contrast, HTML hints, DOM hints).',
          'For contrast, motion, or animation-related criteria, prioritize enrichment.contrast / enrichment.uiContrast / enrichment.motion / enrichment.htmlHints when present.',
          'For criterion 3.3 (UI components/graphics contrast), prioritize enrichment.uiContrast when present.',
          'For form grouping/legend criteria, use fieldsets and formControls[*].fieldsetLegend/inFieldset.',
          'For multimedia criteria, use mediaDetails (tracks + controls/autoplay/muted).',
          'For navigation/structure criteria, use landmarks/meta and enrichment.domHints when present.',
          'For keyboard navigation/order criteria, use focusables (tabindex) and ariaLive.',
          'For text direction criteria, use dir and dirChanges.',
          'Always include 1–4 short evidence items (even for Conform/Non applicable), each referencing a specific evidence path/value',
          '(e.g., images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'Use chrome-devtools MCP tools proactively to resolve missing/partial evidence.',
                'Do NOT return "Review" until you have attempted targeted MCP checks (unless tool use is blocked).',
                'If evidence is partial (snapshot.partial or capped lists), run targeted evaluate_script queries to compute the needed facts.',
                'If using MCP tools:',
                pageId !== null
                  ? `- select_page with MCP_PAGE_ID=${pageId} then verify location.href.`
                  : '- list_pages then select the matching URL page with the lowest id; if none, navigate_page to MCP_TARGET_URL.',
                '- Verify location.href; if mismatched, navigate_page to MCP_TARGET_URL.',
                '- Prefer take_snapshot (a11y tree) and small evaluate_script queries for targeted facts.',
                '- Use take_screenshot only for visual-only checks; do not claim anything you cannot verify.',
                '- Do NOT submit forms or change data/state.',
                'If you used MCP tools, include the relevant tool outputs in evidence items.',
                'If you resize the viewport for any reason, record the original size and restore it after checks.',
                ...(useOcr
                  ? [
                      'OCR tool available: rgaa_ocr. Recommended flow: take_screenshot with filePath under /tmp, then call rgaa_ocr {path, lang?}.',
                      'Use OCR only to extract visible text from images; cite the OCR output in evidence.',
                      'If images are missing alt or role="img" has no accessible name and the criterion is about text alternatives (1.x), run OCR on representative images.'
                    ]
                  : []),
                'Local analysis tools available:',
                '- rgaa_html_analyze {html|path} for DOM/HTML accessibility hints (links/images/forms/structure).',
                '- rgaa_contrast_samples {samples[]} to compute contrast ratios from style samples.',
                '- rgaa_motion_diff {screenshot1,screenshot2} to detect motion between screenshots.',
                'If enrichment.htmlSnippet exists and htmlHints/domHints are missing, call rgaa_html_analyze {html: enrichment.htmlSnippet}.',
                'If enrichment.styleSamples exists and enrichment.contrast is missing, call rgaa_contrast_samples {samples: enrichment.styleSamples}.',
                'If enrichment.uiSamples exists and the criterion is UI contrast (3.3), map uiSamples to samples {color: borderColor||backgroundColor||color, backgroundColor: parentBackgroundColor, fontSize, fontWeight} then call rgaa_contrast_samples.',
                'If enrichmentMeta.screenshot1/screenshot2 exists and the criterion is motion/animation (10.x), call rgaa_motion_diff.',
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
          'Statuts autorisés: "Conform", "Not conform", "Non applicable", "Review".',
          'Règles de décision (dans l’ordre):',
          '1) Applicabilité → réponds "Non applicable" UNIQUEMENT si les preuves montrent clairement que le critère ne s’applique pas (aucun élément concerné).',
          '   Exemples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Suffisance des preuves → si le critère s’applique mais que des informations nécessaires manquent pour vérifier la conformité MÊME après usage des outils MCP, réponds "Review" et précise ce qui manque.',
          '3) Conformité → si un élément concerné est non conforme, réponds "Not conform"; réponds "Conform" seulement si les preuves démontrent la conformité pour TOUS les éléments concernés.',
          ...(retry
            ? [
                'Un premier passage a rendu "Review". Re-vérifie en utilisant les outils MCP pour combler les preuves manquantes; ne réponds "Review" que si tu restes bloqué après des vérifications ciblées.'
              ]
            : []),
          'Les preuves sont tronquées: headings/links/formControls/images/listItems jusqu’à 60; frames 20; tables 40; fieldsets 30; buttons 40; landmarks 40; focusables 80; dirChanges 40; rolesSummary 30; langChanges 40.',
          'Si une liste atteint son maximum ou si truncated.* est true, considère l’échantillon comme partiel et évite "Conform" sauf si le critère reste entièrement vérifiable.',
          'Utilise uniquement les preuves fournies; pas d’hypothèses ni de sources externes.',
          'Des preuves supplémentaires peuvent être fournies dans enrichment (détection de mouvement, synthèse contraste, contraste UI, indices HTML).',
          'Pour les critères de contraste, mouvement ou animation, privilégie enrichment.contrast / enrichment.uiContrast / enrichment.motion / enrichment.htmlHints si présents.',
          'Pour le critère 3.3 (composants UI/éléments graphiques), privilégie enrichment.uiContrast si présent.',
          'Pour les critères de regroupement/légende de champs, utilise fieldsets et formControls[*].fieldsetLegend/inFieldset.',
          'Pour les critères multimédia, utilise mediaDetails (pistes + controls/autoplay/muted).',
          'Pour les critères de navigation/structure, utilise landmarks et meta (viewport/refresh).',
          'Pour les critères de navigation clavier/ordre de tabulation, utilise focusables (tabindex) et ariaLive.',
          'Pour les critères de direction du texte, utilise dir et dirChanges.',
          'Fournis toujours 1–4 éléments de preuve courts (y compris Conforme/Non applicable), en citant un chemin/valeur précis',
          '(ex: images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'Tu DOIS utiliser les outils MCP chrome-devtools pour combler les preuves manquantes.',
                "Ne réponds pas \"Review\" sans avoir tenté des vérifications MCP ciblées (sauf blocage d’outils).",
                'Si les preuves sont partielles (snapshot.partial ou listes tronquées), fais des requêtes evaluate_script ciblées.',
                'Si tu utilises MCP:',
                pageId !== null
                  ? `- select_page avec MCP_PAGE_ID=${pageId} puis vérifie location.href.`
                  : '- list_pages puis sélectionne la page correspondante avec l’ID le plus bas; sinon navigate_page vers MCP_TARGET_URL.',
                '- Vérifie location.href; si différent, navigate_page vers MCP_TARGET_URL.',
                '- Privilégie take_snapshot (arbre a11y) et evaluate_script pour des requêtes ciblées.',
                '- Utilise take_screenshot uniquement pour des vérifications visuelles; ne conclus rien d’invérifiable.',
                '- Ne soumets pas de formulaires et ne modifie pas l’état.',
                'Si tu utilises MCP, cite les sorties d’outils pertinentes dans les preuves.',
                'Si tu redimensionnes la fenêtre pour le critère 10.11 (ex: largeur 320px / hauteur 256px), note la taille d’origine et rétablis-la après les vérifications.',
                'Pour les critères 10.7 et 10.13, identifie des éléments interactifs représentatifs (logo, entrée/icône de navigation principale, liens de fil d’Ariane, bouton CTA de tuile, liens de pied de page).',
                'Utilise evaluate_script pour trouver un sélecteur ou un texte distinctif, focus() l’élément (et scrollIntoView si besoin), puis prends des captures d’élément via take_screenshot {uid}.',
                ...(useOcr
                  ? [
                      'Outil OCR disponible : rgaa_ocr. Flux recommandé : take_screenshot avec filePath sous /tmp, puis rgaa_ocr {path, lang?}.',
                      'Utilise l’OCR uniquement pour extraire du texte visible; cite la sortie OCR dans les preuves.',
                      'Si des images n’ont pas d’alt ou des role=\"img\" sans nom accessible et que le critère porte sur les alternatives textuelles (1.x), fais un OCR sur des images représentatives.'
                    ]
                  : []),
                'Outils locaux disponibles :',
                '- rgaa_html_analyze {html|path} pour des indices d’accessibilité DOM/HTML.',
                '- rgaa_contrast_samples {samples[]} pour calculer les ratios de contraste.',
                '- rgaa_motion_diff {screenshot1,screenshot2} pour détecter du mouvement.',
                'Si enrichment.htmlSnippet existe et que htmlHints/domHints manquent, lance rgaa_html_analyze {html: enrichment.htmlSnippet}.',
                'Si enrichment.styleSamples existe et que enrichment.contrast manque, lance rgaa_contrast_samples {samples: enrichment.styleSamples}.',
                'Si enrichment.uiSamples existe et que le critère porte sur le contraste UI (3.3), mappe uiSamples vers samples {color: borderColor||backgroundColor||color, backgroundColor: parentBackgroundColor, fontSize, fontWeight} puis lance rgaa_contrast_samples.',
                'Si enrichmentMeta.screenshot1/screenshot2 existe et que le critère porte sur le mouvement/animation (10.x), lance rgaa_motion_diff.',
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
          'Allowed statuses: "Conform", "Not conform", "Non applicable", "Review".',
          'You MUST return a JSON object with a "results" property (array) containing EXACTLY one result per provided criterion.',
          'Decision rules (in order):',
          '1) Applicability → return "Non applicable" ONLY if evidence clearly shows the criterion does not apply (no relevant elements).',
          '   Examples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Evidence sufficiency → if the criterion applies but required information is missing to verify compliance EVEN after using MCP tools, return "Review" and state what is missing.',
          '3) Compliance → if any relevant element violates the requirement, return "Not conform"; return "Conform" only when evidence explicitly shows compliance for ALL relevant elements.',
          'Evidence is capped: headings/links/formControls/images/listItems up to 60; frames 20; tables 40; fieldsets 30; buttons 40; landmarks 40; focusables 80; dirChanges 40; rolesSummary 30; langChanges 40.',
          'If a list hits its cap or truncated.* is true, treat evidence as partial and avoid "Conform" unless the criterion can still be fully verified.',
          'Use only the provided evidence; no assumptions or external sources.',
          'Extra evidence may be provided under enrichment (motion detection, contrast summary, UI contrast, HTML hints, DOM hints).',
          'For contrast, motion, or animation-related criteria, prioritize enrichment.contrast / enrichment.uiContrast / enrichment.motion / enrichment.htmlHints when present.',
          'For criterion 3.3 (UI components/graphics contrast), prioritize enrichment.uiContrast when present.',
          'For form grouping/legend criteria, use fieldsets and formControls[*].fieldsetLegend/inFieldset.',
          'For multimedia criteria, use mediaDetails (tracks + controls/autoplay/muted).',
          'For navigation/structure criteria, use landmarks and meta (viewport/refresh).',
          'For keyboard navigation/order criteria, use focusables (tabindex) and ariaLive.',
          'For text direction criteria, use dir and dirChanges.',
          'For each item: always include 1–4 short evidence items, each referencing a specific evidence path/value',
          '(e.g., images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'Use chrome-devtools MCP tools proactively to resolve missing/partial evidence.',
                'Do NOT return "Review" until you have attempted targeted MCP checks (unless tool use is blocked).',
                'If evidence is partial (snapshot.partial or capped lists), run targeted evaluate_script queries to compute the needed facts.',
                'If using MCP tools, do so once per batch and reuse the evidence across results.',
                pageId !== null
                  ? `- select_page with MCP_PAGE_ID=${pageId} then verify location.href.`
                  : '- list_pages then select the matching URL page with the lowest id; if none, navigate_page to MCP_TARGET_URL.',
                '- Verify location.href; if mismatched, navigate_page to MCP_TARGET_URL.',
                '- Prefer take_snapshot (a11y tree) and small evaluate_script queries for targeted facts.',
                '- Use take_screenshot only for visual-only checks; do not claim anything you cannot verify.',
                '- Do NOT submit forms or change data/state.',
                'If you used MCP tools, include the relevant tool outputs in evidence items.',
                'If you resize the viewport for criterion 10.11 (e.g., width 320px / height 256px), record the original size and restore it after checks.',
                ...(useOcr
                  ? [
                      'OCR tool available: rgaa_ocr. Recommended flow: take_screenshot with filePath under /tmp, then call rgaa_ocr {path, lang?}.',
                      'Use OCR only to extract visible text from images; cite the OCR output in evidence.',
                      'If images are missing alt or role="img" has no accessible name and the criterion is about text alternatives (1.x), run OCR on representative images.'
                    ]
                  : []),
                'Local analysis tools available:',
                '- rgaa_html_analyze {html|path} for DOM/HTML accessibility hints (links/images/forms/structure).',
                '- rgaa_contrast_samples {samples[]} to compute contrast ratios from style samples.',
                '- rgaa_motion_diff {screenshot1,screenshot2} to detect motion between screenshots.',
                'If enrichment.htmlSnippet exists and htmlHints/domHints are missing, call rgaa_html_analyze {html: enrichment.htmlSnippet}.',
                'If enrichment.styleSamples exists and enrichment.contrast is missing, call rgaa_contrast_samples {samples: enrichment.styleSamples}.',
                'If enrichment.uiSamples exists and the criterion is UI contrast (3.3), map uiSamples to samples {color: borderColor||backgroundColor||color, backgroundColor: parentBackgroundColor, fontSize, fontWeight} then call rgaa_contrast_samples.',
                'If enrichmentMeta.screenshot1/screenshot2 exists and the criterion is motion/animation (10.x), call rgaa_motion_diff.',
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
          'Statuts autorisés: "Conform", "Not conform", "Non applicable", "Review".',
          'Tu dois retourner un objet JSON contenant une propriété "results" (tableau) avec EXACTEMENT un résultat par critère fourni.',
          'Règles de décision (dans l’ordre):',
          '1) Applicabilité → réponds "Non applicable" UNIQUEMENT si les preuves montrent clairement que le critère ne s’applique pas (aucun élément concerné).',
          '   Exemples: images.length=0, links.length=0, formControls.length=0, frames.length=0, tables.length=0, listItems.length=0,',
          '   langChanges.length=0, media.video=0 & media.audio=0 & media.object=0, visual.cssBackgroundImages=0 & visual.svg=0 & visual.canvas=0 & visual.picture=0.',
          '2) Suffisance des preuves → si le critère s’applique mais que des informations nécessaires manquent pour vérifier la conformité MÊME après usage des outils MCP, réponds "Review" et précise ce qui manque.',
          '3) Conformité → si un élément concerné est non conforme, réponds "Not conform"; réponds "Conform" seulement si les preuves démontrent la conformité pour TOUS les éléments concernés.',
          'Les preuves sont tronquées: headings/links/formControls/images/listItems jusqu’à 60; frames 20; tables 40; fieldsets 30; buttons 40; landmarks 40; focusables 80; dirChanges 40; rolesSummary 30; langChanges 40.',
          'Si une liste atteint son maximum ou si truncated.* est true, considère l’échantillon comme partiel et évite "Conform" sauf si le critère reste entièrement vérifiable.',
          'Utilise uniquement les preuves fournies; pas d’hypothèses ni de sources externes.',
          'Des preuves supplémentaires peuvent être fournies dans enrichment (détection de mouvement, synthèse contraste, contraste UI, indices HTML).',
          'Pour les critères de contraste, mouvement ou animation, privilégie enrichment.contrast / enrichment.uiContrast / enrichment.motion / enrichment.htmlHints si présents.',
          'Pour le critère 3.3 (composants UI/éléments graphiques), privilégie enrichment.uiContrast si présent.',
          'Pour les critères de regroupement/légende de champs, utilise fieldsets et formControls[*].fieldsetLegend/inFieldset.',
          'Pour les critères multimédia, utilise mediaDetails (pistes + controls/autoplay/muted).',
          'Pour les critères de navigation/structure, utilise landmarks/meta et enrichment.domHints si présent.',
          'Pour les critères de navigation clavier/ordre de tabulation, utilise focusables (tabindex) et ariaLive.',
          'Pour les critères de direction du texte, utilise dir et dirChanges.',
          'Pour chaque item: fournis toujours 1–4 éléments de preuve courts, en citant un chemin/valeur précis',
          '(ex: images[2].alt=null, links[5].name="", media.video=0, lang="fr").',
          ...(useMcp
            ? [
                'Tu DOIS utiliser les outils MCP chrome-devtools pour combler les preuves manquantes.',
                "Ne réponds pas \"Review\" sans avoir tenté des vérifications MCP ciblées (sauf blocage d’outils).",
                'Si les preuves sont partielles (snapshot.partial ou listes tronquées), fais des requêtes evaluate_script ciblées.',
                'Si tu utilises MCP, fais-le une fois par batch et réutilise les preuves.',
                pageId !== null
                  ? `- select_page avec MCP_PAGE_ID=${pageId} puis vérifie location.href.`
                  : '- list_pages puis sélectionne la page correspondante avec l’ID le plus bas; sinon navigate_page vers MCP_TARGET_URL.',
                '- Vérifie location.href; si différent, navigate_page vers MCP_TARGET_URL.',
                '- Privilégie take_snapshot (arbre a11y) et evaluate_script pour des requêtes ciblées.',
                '- Utilise take_screenshot uniquement pour des vérifications visuelles; ne conclus rien d’invérifiable.',
                '- Ne soumets pas de formulaires et ne modifie pas l’état.',
                'Si tu utilises MCP, cite les sorties d’outils pertinentes dans les preuves.',
                'Si tu redimensionnes la fenêtre pour n’importe quelle raison, note la taille d’origine et rétablis-la après les vérifications.',
                ...(useOcr
                  ? [
                      'Outil OCR disponible : rgaa_ocr. Flux recommandé : take_screenshot avec filePath sous /tmp, puis rgaa_ocr {path, lang?}.',
                      'Utilise l’OCR uniquement pour extraire du texte visible; cite la sortie OCR dans les preuves.',
                      'Si des images n’ont pas d’alt ou des role="img" sans nom accessible et que le critère porte sur les alternatives textuelles (1.x), fais un OCR sur des images représentatives.'
                    ]
                  : []),
                'Outils locaux disponibles :',
                '- rgaa_html_analyze {html|path} pour des indices d’accessibilité DOM/HTML.',
                '- rgaa_contrast_samples {samples[]} pour calculer les ratios de contraste.',
                '- rgaa_motion_diff {screenshot1,screenshot2} pour détecter du mouvement.',
                'Si enrichment.htmlSnippet existe et que htmlHints/domHints manquent, lance rgaa_html_analyze {html: enrichment.htmlSnippet}.',
                'Si enrichment.styleSamples existe et que enrichment.contrast manque, lance rgaa_contrast_samples {samples: enrichment.styleSamples}.',
                'Si enrichment.uiSamples existe et que le critère porte sur le contraste UI (3.3), mappe uiSamples vers samples {color: borderColor||backgroundColor||color, backgroundColor: parentBackgroundColor, fontSize, fontWeight} puis lance rgaa_contrast_samples.',
                'Si enrichmentMeta.screenshot1/screenshot2 existe et que le critère porte sur le mouvement/animation (10.x), lance rgaa_motion_diff.',
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

function buildCrossPagePrompt({ criterion, pages, reportLang }) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  const safePages = Array.isArray(pages) ? pages : [];
  const payload = {
    criterion_id: criterion.id,
    criterion_title: criterion.title,
    pages: safePages.map((page, idx) => ({
      index: idx + 1,
      url: page.url,
      title: page.title || '',
      searchLandmarks: page.searchLandmarks || [],
      searchControls: page.searchControls || [],
      searchLinks: page.searchLinks || []
    }))
  };
  const baseLines =
    i18n.lang === 'en'
      ? [
          'You are an RGAA auditor. Reply strictly following the provided JSON schema.',
          'Allowed statuses: "Conform", "Not conform", "Non applicable", "Review".',
          'Criterion 12.5 is cross-page: "Within each set of pages, is the search engine reachable in an identical manner?"',
          'Compare how search is reached across all pages using the provided evidence (landmarks, controls, links).',
          'Return "Review" if evidence is missing or ambiguous for any page.',
          'Return "Non applicable" only if no search entry exists on all pages.',
          'Always include 1–4 short evidence items that cite page index and a concrete clue (e.g., page[2].searchControls[0].label="Search").',
          '',
          'Data:',
          JSON.stringify(payload)
        ]
      : [
          'Tu es un auditeur RGAA. Réponds strictement au schéma JSON fourni.',
          'Statuts autorisés: "Conform", "Not conform", "Non applicable", "Review".',
          'Le critère 12.5 est inter-pages : "Dans chaque ensemble de pages, le moteur de recherche est-il atteignable de manière identique ?"',
          'Compare la manière d’accéder à la recherche sur toutes les pages à partir des preuves fournies (landmarks, champs, liens).',
          'Réponds "Review" si des preuves manquent ou sont ambiguës pour une page.',
          'Réponds "Non applicable" uniquement si aucun accès à la recherche n’existe sur toutes les pages.',
          'Fournis toujours 1–4 éléments de preuve courts en citant l’index de page et un indice concret (ex: page[2].searchControls[0].label="Recherche").',
          '',
          'Données:',
          JSON.stringify(payload)
        ];
  return baseLines.join('\n');
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

  await preflightSchemas(onLog);
  await acquireCodexSlot();
  try {

  const outputFile = path.join(
    os.tmpdir(),
    `codex-rgaa-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );

  const codexPath = process.env.CODEX_PATH || 'codex';
  const buildArgs = (mcpConfig, modelOverride = model) => {
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
    if (modelOverride) {
      args.push('-m', modelOverride);
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
      let heartbeat = null;
      const startAt = Date.now();
      let lastActivityAt = startAt;
      const heartbeatRaw = Number(process.env.AUDIT_CODEX_HEARTBEAT_MS || '');
      const heartbeatMs =
        Number.isFinite(heartbeatRaw) && heartbeatRaw > 0 ? Math.floor(heartbeatRaw) : 15000;
      const stallRaw = Number(process.env.AUDIT_CODEX_STALL_TIMEOUT_MS || '');
      const stallTimeoutMs =
        Number.isFinite(stallRaw) && stallRaw > 0 ? Math.floor(stallRaw) : 0;
      const finalize = (err) => {
        if (settled) return;
        settled = true;
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
        if (timeout) clearTimeout(timeout);
        if (heartbeat) clearInterval(heartbeat);
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

      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          const now = Date.now();
          const silentFor = now - lastActivityAt;
          if (stallTimeoutMs > 0 && silentFor >= stallTimeoutMs) {
            onLog?.(`Codex: stalled for ${stallTimeoutMs}ms; terminating.`);
            terminateChild(child);
            finalize(new Error(`codex exec stalled after ${stallTimeoutMs}ms`));
            return;
          }
          if (silentFor >= heartbeatMs) {
            onLog?.(`Codex: still running (${Math.round((now - startAt) / 1000)}s).`);
          }
        }, heartbeatMs);
        if (typeof heartbeat.unref === 'function') heartbeat.unref();
      }

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
          lastActivityAt = Date.now();
          // Avoid unbounded growth if Codex is noisy (keep the tail).
          if (stderrText.length > 64_000) stderrText = stderrText.slice(-64_000);
          const trimmed = message.trim();
          if (trimmed) onLog?.(`Codex: ${trimmed.split('\n').slice(-1)[0]}`);
        });
      }

      onStage?.('AI: running inference');
      onLog?.('Codex: running inference');
      attachIgnoreEpipe(child.stdin, (err) => {
        onLog?.(`Codex: stdin error (${err?.code || 'unknown'}).`);
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });

  // Ensure a user-provided CODEX_HOME exists; Codex exits early if it doesn't.
  if (process.env.CODEX_HOME) {
    await ensureDir(process.env.CODEX_HOME);
  }

  const runWithEnv = async (env, mcpConfig, modelOverride = model) => {
    try {
      await runOnce(env, buildArgs(mcpConfig, modelOverride));
    } catch (err) {
      if (modelOverride && looksLikeModelNotFound(err.stderr)) {
        onLog?.(`Codex: model ${JSON.stringify(modelOverride)} not found; retrying with default model`);
        await runOnce(env, buildArgs(mcpConfig, ''));
        return;
      }
      // Common failure mode in sandboxed/CI environments: ~/.codex isn't writable.
      if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err.stderr)) {
        const fallbackHome = getFallbackCodexHome();
        await ensureDir(fallbackHome);
        await ensureDir(path.join(fallbackHome, 'sessions'));
        await ensureDir(path.join(fallbackHome, 'npm-cache'));
        await seedCodexConfig(fallbackHome, onLog);
        onLog?.(`Codex: retrying with CODEX_HOME=${fallbackHome}`);
        await runOnce(buildCodexEnv({ codexHome: fallbackHome }), buildArgs(mcpConfig, modelOverride));
        return;
      }
      throw err;
    }
  };

  try {
    await runWithEnv(buildCodexEnv(), mcp, model);
  } catch (err) {
    if (mcp && (looksLikeMcpConnectError(err.stderr) || looksLikeMcpInstallOrNetworkError(err.stderr))) {
      onLog?.('Codex: MCP failed, retrying AI review without MCP.');
      try {
        await runWithEnv(buildCodexEnv(), null, model);
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
  } finally {
    releaseCodexSlot();
  }
}

export async function aiReviewCriterion({
  model,
  url,
  criterion,
  snapshot,
  reportLang,
  onLog,
  onStage,
  onError,
  failFast = false,
  signal,
  mcp,
  retry = false
}) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  try {
    if (signal?.aborted) {
      throw createAbortError();
    }
    onStage?.('AI: building prompt');
    const prompt = buildPrompt({ criterion, url, snapshot, reportLang, mcp, retry });
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

    const normalized = normalizeAiStatus(parsed.status);
    const finalStatus =
      normalized === STATUS.NC && looksLikeNonVerifiable({ rationale, evidence })
        ? STATUS.REVIEW
        : normalized;
    return {
      status: finalStatus,
      notes: `${i18n.notes.aiReviewLabel()} (${confidence.toFixed(2)}): ${rationale}`,
      ai: { confidence, rationale, evidence }
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    if (failFast && looksLikeMissingAuth(err?.stderr || err?.message)) {
      alertMissingAuth(onError, err?.stderr || err?.message);
      throw err;
    }
    alertMissingAuth(onError, err?.stderr || err?.message);
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
  onError,
  failFast = false,
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
    return results.map((res) => {
      const normalized = normalizeAiStatus(res?.status);
      const finalStatus =
        normalized === STATUS.NC &&
        looksLikeNonVerifiable({ rationale: res?.rationale, evidence: res?.evidence })
          ? STATUS.REVIEW
          : normalized;
      return { ...res, status: finalStatus };
    });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    if (failFast && looksLikeMissingAuth(err?.stderr || err?.message)) {
      alertMissingAuth(onError, err?.stderr || err?.message);
      throw err;
    }
    alertMissingAuth(onError, err?.stderr || err?.message);
    const hint = summarizeCodexStderr(err?.stderr);
    const message =
      hint && err?.message && !String(err.message).includes(hint) ? `${err.message} (${hint})` : err.message;
    throw new Error(`AI batch review failed: ${message}`);
  }
}

export async function aiReviewCrossPageCriterion({
  model,
  criterion,
  pages,
  reportLang,
  onLog,
  onStage,
  onError,
  failFast,
  signal
}) {
  const i18n = getI18n(normalizeReportLang(reportLang));
  try {
    const prompt = buildCrossPagePrompt({ criterion, pages, reportLang });
    onStage?.('AI: preparing cross-page prompt');
    onLog?.('Codex: preparing cross-page prompt');
    const content = await runCodexPrompt({ prompt, model, onLog, onStage, signal });
    const parsed = JSON.parse(content);
    const confidence = Number(parsed.confidence || 0);
    const rationale = parsed.rationale || '';
    const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
    const normalized = normalizeAiStatus(parsed.status);
    const finalStatus =
      normalized === STATUS.NC && looksLikeNonVerifiable({ rationale, evidence })
        ? STATUS.REVIEW
        : normalized;
    return {
      status: finalStatus,
      notes: `${i18n.notes.aiReviewLabel()} (${confidence.toFixed(2)}): ${rationale}`,
      ai: { confidence, rationale, evidence }
    };
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      throw createAbortError();
    }
    if (failFast && looksLikeMissingAuth(err?.stderr || err?.message)) {
      alertMissingAuth(onError, err?.stderr || err?.message);
      throw err;
    }
    alertMissingAuth(onError, err?.stderr || err?.message);
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
