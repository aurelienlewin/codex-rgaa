import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import chromeLauncher from 'chrome-launcher';
import ExcelJS from 'exceljs';
import { loadCriteria } from './criteria.js';
import { collectSnapshotWithMcp, listMcpPages } from './mcpSnapshot.js';
import { collectEnrichedEvidenceWithMcp } from './mcpEnrich.js';
import { closeMcpPages } from './mcpClosePages.js';
import { buildEnrichment } from './enrichment.js';
import { evaluateCriterion, STATUS } from './checks.js';
import { aiReviewCriteriaBatch, aiReviewCriterion, aiReviewCrossPageCriterion } from './ai.js';
import { createAbortError, isAbortError } from './abort.js';
import { getI18n, normalizeReportLang } from './i18n.js';
import { validateHtmlUrl } from './htmlValidator.js';

class EnrichmentCache {
  constructor(limit = 32) {
    this.limit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 32;
    this.map = new Map();
  }
  get(key) {
    if (!key || !this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, value) {
    if (!key) return;
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
  clear() {
    this.map.clear();
  }
}

function compactSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  return {
    title: snapshot.title || '',
    lang: snapshot.lang || '',
    enrichmentMeta: snapshot.enrichmentMeta || null
  };
}

async function writeResumeState(statePath, state) {
  if (!statePath) return;
  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch {}
}

function buildResumeState({
  pages,
  reportLang,
  outPath,
  completedPages,
  crossPageEvidence,
  pageMeta,
  criteriaIds,
  createdAt
}) {
  return {
    version: 1,
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pages,
    reportLang,
    outPath,
    criteriaIds,
    completedPages,
    crossPageEvidence,
    pageMeta
  };
}

function isRetryableAiError(err) {
  const text = String(err?.message || err || '').toLowerCase();
  return text.includes('timed out') || text.includes('timeout') || text.includes('stalled');
}

function createPauseAwareSignal({ signal, pauseController }) {
  if (!pauseController) {
    return { signal, cleanup: () => {}, wasPausedAbort: () => false };
  }
  const controller = new AbortController();
  let pausedAbort = false;
  const pauseAbort = () => {
    if (pausedAbort) return;
    pausedAbort = true;
    controller.abort();
  };
  const forwardAbort = () => {
    controller.abort();
  };
  const removePauseListener = pauseController.onChange?.(({ paused }) => {
    if (paused) pauseAbort();
  });
  if (pauseController.isPaused?.()) {
    pauseAbort();
  }
  if (signal?.aborted) {
    controller.abort();
  } else if (signal) {
    signal.addEventListener('abort', forwardAbort, { once: true });
  }
  const cleanup = () => {
    if (signal) signal.removeEventListener('abort', forwardAbort);
    if (removePauseListener) removePauseListener();
  };
  return { signal: controller.signal, cleanup, wasPausedAbort: () => pausedAbort };
}

async function withPauseRetry({
  fn,
  pauseController,
  reporter,
  label,
  retryOnAny = false,
  signal
}) {
  const runAttempt = async () => {
    const { signal: attemptSignal, cleanup, wasPausedAbort } = createPauseAwareSignal({
      signal,
      pauseController
    });
    try {
      return { result: await fn({ signal: attemptSignal }), wasPausedAbort };
    } catch (err) {
      return { err, wasPausedAbort };
    } finally {
      cleanup();
    }
  };

  const first = await runAttempt();
  if (!first.err) return first.result;
  const firstErr = first.err;
  const pausedAbort = first.wasPausedAbort();
  if (signal?.aborted || (isAbortError(firstErr) && !pausedAbort)) {
    throw firstErr;
  }
  if (!pauseController) throw firstErr;
  if (!retryOnAny && !isRetryableAiError(firstErr)) throw firstErr;
  reporter?.onAILog?.({
    criterion: { id: 'ai', title: 'AI', theme: 'Debug' },
    message: `${label} failed (${String(firstErr?.message || firstErr)}). Pausing until resume to retry.`
  });
  if (!pauseController.isPaused?.()) pauseController.pause();
  await pauseController.waitIfPaused();
  const second = await runAttempt();
  if (second.err) throw second.err;
  return second.result;
}

function sanitizeSheetName(name) {
  const cleaned = name
    .replace(/[\\/?*\[\]:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 31) || 'Page';
}

function summarizeCounts(results) {
  const counts = { C: 0, NC: 0, NA: 0, ERR: 0, REVIEW: 0 };
  for (const res of results) {
    if (res.status === STATUS.C) counts.C += 1;
    if (res.status === STATUS.NC) counts.NC += 1;
    if (res.status === STATUS.NA) counts.NA += 1;
    if (res.status === STATUS.ERR) counts.ERR += 1;
    if (res.status === STATUS.REVIEW) counts.REVIEW += 1;
  }
  return counts;
}

function scoreFromCounts(counts) {
  const denom = counts.C + counts.NC;
  if (denom === 0) return 0;
  return counts.C / denom;
}

function formatScorePercent(value) {
  const pct = Number.isFinite(value) ? value * 100 : 0;
  return `${pct.toFixed(1)}%`;
}

function stripToolReferences(value) {
  const text = String(value || '');
  if (!text) return '';
  return text
    .replace(/\b(ai|mcp|codex)\b/gi, '')
    .replace(/chrome-devtools/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([:;,.)])/g, '$1')
    .trim();
}

function humanizeEnrichmentEvidence(text) {
  const raw = String(text || '');
  if (!raw) return '';
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized.toLowerCase().includes('enrichment.')) return normalized;
  const replaced = normalized
    .replace(/enrichment\.contrast\./gi, 'Contraste ')
    .replace(/enrichment\.motion\./gi, 'Mouvement ')
    .replace(/enrichment\.htmlHints\./gi, 'Indice HTML ')
    .replace(/enrichment\.domHints\./gi, 'Indice DOM ')
    .replace(/\bcontrast\./gi, 'Contraste ')
    .replace(/\bmotion\./gi, 'Mouvement ')
    .replace(/\bhtmlHints\./gi, 'Indice HTML ')
    .replace(/\bdomHints\./gi, 'Indice DOM ')
    .replace(/\bmissingAltCount\b/gi, 'images sans alt')
    .replace(/\broleImgMissingNameCount\b/gi, 'images role=img sans nom')
    .replace(/\bmissingTitleCount\b/gi, 'iframes sans titre')
    .replace(/\bmissingNameCount\b/gi, 'liens sans nom')
    .replace(/\bgenericCount\b/gi, 'liens génériques')
    .replace(/\bskipLinkFound\b/gi, 'lien d’évitement')
    .replace(/\bh1Count\b/gi, 'h1')
    .replace(/\bhasLevelJumps\b/gi, 'sauts de niveaux')
    .replace(/\binvalidCount\b/gi, 'listes invalides')
    .replace(/\bmissingLabel\b/gi, 'champs sans libellé')
    .replace(/\bcontrolsTotal\b/gi, 'champs')
    .replace(/\bsampleCount\b/gi, 'échantillons contraste')
    .replace(/\bfailingCount\b/gi, 'échantillons contraste insuffisant')
    .replace(/\bworstSample\.ratio\b/gi, 'pire contraste')
    .replace(/\bworstSample\.text\b/gi, 'texte')
    .replace(/\bworstSample\b/gi, 'pire échantillon')
    .replace(/\bworstClassification\.aa\b/gi, 'contraste AA')
    .replace(/\bworstClassification\.aaa\b/gi, 'contraste AAA')
    .replace(/\bworstClassification\.largeText\b/gi, 'texte large')
    .replace(/\bdiffRatio\b/gi, 'taux de mouvement')
    .replace(/\bdiffPixels\b/gi, 'pixels en mouvement')
    .replace(/\btotalPixels\b/gi, 'pixels totaux')
    .replace(/\bmotionLikely\b/gi, 'mouvement probable')
    .replace(/\bmarqueeCount\b/gi, 'balises marquee')
    .replace(/\bblinkCount\b/gi, 'balises blink')
    .replace(/\binlineAnimationCount\b/gi, 'animations inline')
    .replace(/\btargetBlankLinks\b/gi, 'liens target=_blank')
    .replace(/\bdownloadLinks\b/gi, 'liens de téléchargement')
    .replace(/\bautoplayMedia\b/gi, 'médias en lecture auto')
    .replace(/\buiContrast\./gi, 'Contraste UI ')
    .replace(/\buiContrast\.sampleCount\b/gi, 'échantillons UI')
    .replace(/\buiContrast\.failingCount\b/gi, 'échantillons UI insuffisants')
    .replace(/\buiContrast\.worstSample\.ratio\b/gi, 'pire contraste UI')
    .replace(/\buiContrast\.worstSample\.source\b/gi, 'source contraste UI')
    .replace(/\buiContrast\.worstSample\b/gi, 'pire échantillon UI')
    .replace(/\btrue\b/gi, 'oui')
    .replace(/\bfalse\b/gi, 'non')
    .replace(/\s+([:;,.)])/g, '$1')
    .trim();
  return replaced;
}

function buildEnrichmentCacheKey(enriched) {
  if (!enriched) return '';
  try {
    const payload = {
      styleSamples: enriched.styleSamples || [],
      uiSamples: enriched.uiSamples || [],
      htmlSnippet: enriched.htmlSnippet || ''
    };
    const json = JSON.stringify(payload);
    return createHash('sha1').update(json).digest('hex');
  } catch {
    return '';
  }
}

function createEnrichmentCache() {
  const limitRaw = Number(process.env.AUDIT_ENRICH_CACHE_MAX || '');
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 32;
  return new EnrichmentCache(limit);
}

async function copyEvidenceScreenshots(pages, evidenceDir) {
  if (!evidenceDir) return pages.map(() => ({ screenshot1: '', screenshot2: '' }));
  const results = pages.map(() => ({ screenshot1: '', screenshot2: '' }));
  let dirReady = false;

  const ensureDir = async () => {
    if (dirReady) return;
    await fs.mkdir(evidenceDir, { recursive: true });
    dirReady = true;
  };

  const safeCopy = async (src, dest) => {
    if (!src) return false;
    try {
      await fs.copyFile(src, dest);
      return true;
    } catch {
      return false;
    }
  };

  for (let i = 0; i < pages.length; i += 1) {
    const meta = pages[i]?.snapshot?.enrichmentMeta || null;
    if (!meta) continue;
    const relA = `evidence/P${i + 1}-a.png`;
    const relB = `evidence/P${i + 1}-b.png`;
    if (meta.screenshot1) {
      await ensureDir();
      const ok = await safeCopy(meta.screenshot1, path.join(evidenceDir, `P${i + 1}-a.png`));
      if (ok) results[i].screenshot1 = relA;
    }
    if (meta.screenshot2) {
      await ensureDir();
      const ok = await safeCopy(meta.screenshot2, path.join(evidenceDir, `P${i + 1}-b.png`));
      if (ok) results[i].screenshot2 = relB;
    }
  }

  return results;
}

async function cleanupEnrichmentTempFiles(pages, evidenceLinksByPage, { force = false } = {}) {
  if (!Array.isArray(evidenceLinksByPage) || evidenceLinksByPage.length === 0) {
    return;
  }
  const tasks = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const links = evidenceLinksByPage[i] || null;
    const meta = page?.snapshot?.enrichmentMeta || null;
    if (!meta) continue;
    if (meta.screenshot1 && (force || links?.screenshot1)) {
      tasks.push(fs.unlink(meta.screenshot1).catch(() => {}));
    }
    if (meta.screenshot2 && (force || links?.screenshot2)) {
      tasks.push(fs.unlink(meta.screenshot2).catch(() => {}));
    }
  }
  if (tasks.length) {
    await Promise.all(tasks);
  }
}

async function fetchChromeVersion(baseUrl) {
  const url = String(baseUrl || '').trim();
  if (!url) return null;
  try {
    const res = await fetch(`${url}/json/version`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      browser: data?.Browser || '',
      userAgent: data?.UserAgent || '',
      protocolVersion: data?.['Protocol-Version'] || ''
    };
  } catch {
    return null;
  }
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSearchEvidence(snapshot) {
  const landmarks = Array.isArray(snapshot?.landmarks) ? snapshot.landmarks : [];
  const controls = Array.isArray(snapshot?.formControls) ? snapshot.formControls : [];
  const links = Array.isArray(snapshot?.links) ? snapshot.links : [];
  const keywords = ['search', 'recherche', 'chercher', 'rechercher'];
  const hasKeyword = (value) => {
    const text = normalizeSearchText(value);
    if (!text) return false;
    return keywords.some((k) => text.includes(k));
  };

  const searchLandmarks = landmarks
    .filter((l) => String(l?.role || '').toLowerCase() === 'search' || hasKeyword(l?.label))
    .slice(0, 5)
    .map((l) => ({
      tag: l?.tag || '',
      role: l?.role || '',
      label: l?.label || ''
    }));

  const searchControls = controls
    .filter((c) => {
      if (String(c?.type || '').toLowerCase() === 'search') return true;
      return hasKeyword(c?.label) || hasKeyword(c?.name) || hasKeyword(c?.id);
    })
    .slice(0, 8)
    .map((c) => ({
      tag: c?.tag || '',
      type: c?.type || '',
      label: c?.label || '',
      name: c?.name || '',
      id: c?.id || ''
    }));

  const searchLinks = links
    .filter((l) => hasKeyword(l?.name) || hasKeyword(l?.href))
    .slice(0, 6)
    .map((l) => ({
      name: l?.name || '',
      href: l?.href || ''
    }));

  return { searchLandmarks, searchControls, searchLinks };
}

function shouldOpenReport() {
  const raw = String(process.env.AUDIT_OPEN_XLS || '').trim().toLowerCase();
  if (!raw) return true;
  return !(raw === '0' || raw === 'false' || raw === 'no');
}

function openReport(outPath) {
  if (!outPath) return;
  try {
    if (process.platform === 'darwin') {
      spawn('open', [outPath], { stdio: 'ignore', detached: true });
    } else if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', outPath], { stdio: 'ignore', detached: true });
    } else {
      spawn('xdg-open', [outPath], { stdio: 'ignore', detached: true });
    }
  } catch {}
}

function formatPageFailure(error) {
  if (!error) return 'Page load failed.';
  const message = String(error.message || error).trim();
  const stderr = String(error.stderr || '').trim();
  if (!stderr) return `Page load failed: ${message}`;

  // If the error was already decorated with a useful stderr hint, don't add more noise.
  if (message.includes('(') || message.toLowerCase().includes('mcp:') || message.includes('ERROR')) {
    return `Page load failed: ${message}`;
  }

  const stderrLines = stderr
    .split('\n')
    .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  const tail = stderrLines.slice(-3).join(' | ').slice(0, 240);
  if (!tail) return `Page load failed: ${message}`;
  if (message.includes(tail)) return `Page load failed: ${message}`;
  return `Page load failed: ${message} (${tail})`;
}

function buildChromeFlags() {
  const flags = [
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-breakpad'
  ];

  // In Codex/CI environments, launching a visible (non-headless) Chrome can hang.
  // Prefer headless by default in those contexts, while keeping local interactive runs unchanged.
  const wantsHeadless =
    process.env.AUDIT_HEADLESS === '1' ||
    process.env.CI === '1' ||
    process.env.CODEX_CI === '1';
  if (wantsHeadless) {
    flags.push('--headless=new');
  }

  // On Linux, Chrome often needs this in sandboxed CI/containers.
  // On macOS/Windows, it is unnecessary and can be destabilizing.
  if (process.platform === 'linux') {
    flags.push('--no-sandbox');
  }

  return flags;
}

function isPortProbePermissionError(err) {
  const message = String(err?.message || '');
  return (
    (err && err.code === 'EPERM') ||
    (message.includes('EPERM') && message.toLowerCase().includes('listen'))
  );
}

async function waitForCdpReady({ port, timeoutMs = 5000, signal } = {}) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(`${baseUrl}/json/version`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res && res.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Chrome launched but DevTools endpoint was not reachable on port ${port}.`);
}

async function launchChrome({ chromePath, port } = {}) {
  const chromeFlags = buildChromeFlags();
  const launch = async (p) =>
    chromeLauncher.launch({
      chromePath,
      chromeFlags,
      ...(typeof p === 'number' && Number.isFinite(p) && p > 0 ? { port: p } : {})
    });

  // Default: let chrome-launcher pick a free port. In some sandboxed environments, the
  // random port probe is denied (EPERM on listen). Fall back to fixed ports.
  let chrome = null;
  try {
    if (typeof port === 'number' && Number.isFinite(port) && port > 0) {
      chrome = await launch(port);
    } else {
      try {
        chrome = await launch(undefined);
      } catch (err) {
        if (!isPortProbePermissionError(err)) throw err;

        const candidatePorts = Array.from({ length: 16 }, (_, i) => 9222 + i);
        let lastErr = err;
        for (const candidatePort of candidatePorts) {
          try {
            chrome = await launch(candidatePort);
            break;
          } catch (e) {
            lastErr = e;
          }
        }
        if (!chrome) throw lastErr;
      }
    }

    await waitForCdpReady({ port: chrome.port, timeoutMs: 6000 });
    return chrome;
  } catch (err) {
    try {
      if (chrome) await chrome.kill();
    } catch {}
    throw err;
  }
}

export async function runAudit(options) {
  const reportLang = normalizeReportLang(options?.reportLang);
  const i18n = getI18n(reportLang);
  const criteria =
    Array.isArray(options?.criteria) && options.criteria.length
      ? options.criteria
      : loadCriteria({ lang: reportLang });
  const criteriaIds = criteria.map((criterion) => criterion.id);
  const reporter = options.reporter || null;
  const signal = options.signal || null;
  const pauseController = options.pauseController || null;
  const auditStartedAt = new Date();
  let aborted = false;
  let chrome = null;
  let mcpConfig = options.mcp || {};
  const aiUseMcp = Boolean(options.ai?.useMcp);
  const aiUseOcr = Boolean(options.ai?.ocr);
  const aiUseUtilsRaw = String(process.env.AUDIT_AI_UTILS || '').trim().toLowerCase();
  const aiUseUtils =
    aiUseUtilsRaw === ''
      ? true
      : !(aiUseUtilsRaw === '0' || aiUseUtilsRaw === 'false' || aiUseUtilsRaw === 'no');
  const failFastRaw = String(process.env.AUDIT_FAIL_FAST || '').trim().toLowerCase();
  const failFast =
    failFastRaw === ''
      ? true
      : !(failFastRaw === '0' || failFastRaw === 'false' || failFastRaw === 'no');
  const mcpForAi = aiUseMcp ? { ...mcpConfig, ocr: aiUseOcr, utils: aiUseUtils } : null;
  const totalPages = Array.isArray(options.pages) ? options.pages.length : 0;
  let pagesFailed = 0;
  let aiFailed = 0;
  const wantsEnrichment =
    String(process.env.AUDIT_ENRICH || '').trim().toLowerCase() !== '0';
  const enrichmentCache = createEnrichmentCache();
  const wantsDebugSnapshots =
    String(process.env.AUDIT_DEBUG_SNAPSHOTS || '').trim() === '1' ||
    String(process.env.AUDIT_DEBUG_SNAPSHOTS || '').trim().toLowerCase() === 'true';
  const debugSnapshotsDir =
    wantsDebugSnapshots && options.outPath
      ? path.join(path.dirname(path.resolve(options.outPath)), 'snapshots')
      : '';
  const incrementalXlsxRaw = String(process.env.AUDIT_XLS_INCREMENTAL || '').trim().toLowerCase();
  const incrementalXlsx =
    incrementalXlsxRaw === ''
      ? true
      : !(incrementalXlsxRaw === '0' || incrementalXlsxRaw === 'false' || incrementalXlsxRaw === 'no');

  const onAbort = () => {
    aborted = true;
    if (chrome) {
      Promise.resolve()
        .then(() => chrome.kill())
        .catch(() => {});
    }
  };

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  if (signal?.aborted) {
    throw createAbortError();
  }

  const providedBrowserUrl = String(mcpConfig?.browserUrl || '').trim();
  const wantsAutoConnect = Boolean(mcpConfig?.autoConnect);
  if (!providedBrowserUrl && !wantsAutoConnect) {
    chrome = await launchChrome({
      chromePath: options.chromePath,
      port: options.chromePort
    });
    mcpConfig = {
      ...mcpConfig,
      browserUrl: `http://127.0.0.1:${chrome.port}`,
      autoConnect: false
    };
  }
  if (mcpConfig?.browserUrl) {
    chromeInfo = await fetchChromeVersion(mcpConfig.browserUrl);
  }

  const pageResults = [];
  const crossPageEvidence = [];
  const criteriaIndexById = new Map(criteria.map((criterion, idx) => [criterion.id, idx]));
  const hasMultiPageAudit = totalPages >= 2;
  const secondPassSummary = {
    total: 0,
    done: 0,
    criteria: []
  };
  const pageMeta = [];
  let chromeInfo = null;
  let resumeCompletedPages = 0;

  if (options.resumeState?.completedPages?.length) {
    const resumeCriteria = Array.isArray(options.resumeState.criteriaIds)
      ? options.resumeState.criteriaIds
      : [];
    if (resumeCriteria.length && JSON.stringify(resumeCriteria) !== JSON.stringify(criteriaIds)) {
      throw new Error('Resume file does not match current criteria set.');
    }
    const completed = options.resumeState.completedPages || [];
    for (const page of completed) {
      if (!page?.url || !Array.isArray(page?.results)) continue;
      pageResults.push({
        url: page.url,
        results: page.results,
        snapshot: {
          title: page?.title || '',
          lang: page?.lang || ''
        }
      });
      if (page?.title || page?.lang) {
        pageMeta.push({ url: page.url, title: page?.title || '', lang: page?.lang || '' });
      }
    }
    if (Array.isArray(options.resumeState.crossPageEvidence)) {
      crossPageEvidence.push(...options.resumeState.crossPageEvidence);
    }
    resumeCompletedPages = pageResults.length;
  }

  try {
    if (aborted || signal?.aborted) {
      throw createAbortError();
    }
    if (reporter && reporter.onChromeReady) reporter.onChromeReady();
    if (mcpConfig && !mcpConfig?.pageId && !Array.isArray(mcpConfig?.cachedPages)) {
      try {
        const list = await listMcpPages({
          model: options.ai?.model,
          mcp: mcpConfig,
          onLog: (message) => reporter?.onAILog?.({ criterion: { id: 'snapshot' }, message }),
          onStage: (label) => reporter?.onAIStage?.({ criterion: { id: 'snapshot' }, label }),
          signal
        });
        if (Array.isArray(list?.pages)) {
          mcpConfig.cachedPages = list.pages;
        } else {
          mcpConfig.cachedPages = [];
        }
      } catch (err) {
        mcpConfig.cachedPages = [];
        reporter?.onAILog?.({
          criterion: { id: 'snapshot', title: 'MCP', theme: 'Debug' },
          message: `Cached list_pages failed: ${String(err?.message || err)}`
        });
      }
    }
    for (let pageIdx = resumeCompletedPages; pageIdx < options.pages.length; pageIdx += 1) {
      const url = options.pages[pageIdx];
      if (aborted || signal?.aborted) {
        throw createAbortError();
      }
      if (pauseController) await pauseController.waitIfPaused();
      const pageIndex = pageResults.length;
      if (reporter && reporter.onPageStart) reporter.onPageStart({ index: pageIndex, url });
      let page = null;
      reporter?.onPageNavigateStart?.({ url });
      const navStart = Date.now();
      try {
        if (pauseController) await pauseController.waitIfPaused();
        reporter?.onSnapshotStart?.({ url });
        const snapshotStart = Date.now();
        const snapshot = await withPauseRetry({
          pauseController,
          reporter,
          label: 'Snapshot',
          retryOnAny: true,
          signal,
          fn: ({ signal: attemptSignal }) =>
            collectSnapshotWithMcp({
              url,
              model: options.ai?.model,
              mcp: mcpConfig,
              onLog: (message) => reporter?.onAILog?.({ criterion: { id: 'snapshot' }, message }),
              onStage: (label) => reporter?.onAIStage?.({ criterion: { id: 'snapshot' }, label }),
              signal: attemptSignal
            })
        });
        const wantsHtmlValidation =
          String(process.env.AUDIT_HTML_VALIDATOR || '').trim().toLowerCase() !== '0';
        if (wantsHtmlValidation) {
          const validation = await validateHtmlUrl(url);
          if (validation) {
            snapshot.validation = validation;
          }
        }
        let enrichment = null;
        if (wantsEnrichment && options.ai?.useMcp) {
          if (pauseController) await pauseController.waitIfPaused();
          reporter?.onEnrichmentStart?.({ url });
          let enrichmentOk = true;
          try {
            const enriched = await withPauseRetry({
              pauseController,
              reporter,
              label: 'Enrichment',
              retryOnAny: true,
              signal,
              fn: ({ signal: attemptSignal }) =>
                collectEnrichedEvidenceWithMcp({
                  url,
                  model: options.ai?.model,
                  mcp: mcpConfig,
                  onLog: (message) => reporter?.onAILog?.({ criterion: { id: 'enrich' }, message }),
                  onStage: (label) => reporter?.onAIStage?.({ criterion: { id: 'enrich' }, label }),
                  signal: attemptSignal
                })
            });
            const cacheKey = buildEnrichmentCacheKey(enriched);
            const cached = cacheKey ? enrichmentCache.get(cacheKey) : null;
            if (cached) {
              enrichment = cached;
            } else {
              enrichment = await buildEnrichment(enriched);
              if (cacheKey) enrichmentCache.set(cacheKey, enrichment);
            }
            snapshot.enrichment = enrichment;
            snapshot.enrichmentMeta = {
              screenshot1: enriched?.screenshot1 || '',
              screenshot2: enriched?.screenshot2 || ''
            };
            const criteriaSample = criteria.slice(0, 6).map((item) => item.id);
            reporter?.onEnrichmentReady?.({
              url,
              criteriaCount: criteria.length,
              criteriaSample
            });
          } catch (err) {
            enrichmentOk = false;
            if (failFast) throw err;
            reporter?.onAILog?.({
              criterion: { id: 'enrich', title: 'Enrichment', theme: 'Debug' },
              message: `Enrichment failed: ${String(err?.message || err)}`
            });
          } finally {
            reporter?.onEnrichmentEnd?.({ url, ok: enrichmentOk });
          }
        }
        reporter?.onSnapshotEnd?.({ url, durationMs: Date.now() - snapshotStart });
        reporter?.onPageNetworkIdle?.({
          url,
          durationMs: Date.now() - navStart,
          timedOut: false
        });
        page = { snapshot };
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
        if (failFast) {
          throw err;
        }
        page = { error: err };
      }

      if (page?.error) {
        reporter?.onPageError?.({ url, error: page.error });
      }
      if (debugSnapshotsDir && page?.snapshot && !page?.error) {
        try {
          await fs.mkdir(debugSnapshotsDir, { recursive: true });
          const payload = {
            url,
            collectedAt: new Date().toISOString(),
            snapshot: page.snapshot
          };
          const filePath = path.join(debugSnapshotsDir, `P${pageIndex + 1}.json`);
          await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        } catch (err) {
          reporter?.onAILog?.({
            criterion: { id: 'snapshot', title: 'Snapshot debug', theme: 'Debug' },
            message: `Warning: failed to write debug snapshot (${String(err?.message || err)})`
          });
        }
      }

      const results = [];
      let criterionIndex = 0;
      const reported = new Set();
      const reportCriterion = (criterion, evaluation, resultIndex) => {
        if (reported.has(resultIndex)) return;
        reporter?.onCriterion?.({ index: criterionIndex, criterion, evaluation });
        criterionIndex += 1;
        reported.add(resultIndex);
      };
      reporter?.onInferenceStart?.({
        url,
        criteriaCount: criteria.length,
        criteriaSample: criteria.slice(0, 6).map((item) => item.id)
      });
      reporter?.onChecksStart?.({ index: pageIndex, url });
      const pendingAI = [];
      const reviewRetry = [];
      const reviewRetryQueued = new Set();
      const queueReviewRetry = (criterion, index, evaluation) => {
        if (!mcpForAi) return;
        if (evaluation?.status !== STATUS.REVIEW) return;
        if (reviewRetryQueued.has(index)) return;
        reviewRetryQueued.add(index);
        reviewRetry.push({ criterion, index });
      };
      for (const criterion of criteria) {
        if (aborted || signal?.aborted) {
          throw createAbortError();
        }
        if (pauseController) await pauseController.waitIfPaused();

        if (page.error) {
          const evaluation = {
            ...criterion,
            status: STATUS.ERR,
            notes: formatPageFailure(page.error)
          };
          const index = results.length;
          results.push(evaluation);
          reportCriterion(criterion, {
            status: evaluation.status,
            notes: evaluation.notes,
            ai: evaluation.ai || null,
            automated: Boolean(evaluation.automated),
            aiCandidate: Boolean(evaluation.aiCandidate)
          }, index);
          continue;
        }

        if (criterion.id === '12.5' && !hasMultiPageAudit) {
          const evaluation = {
            status: STATUS.REVIEW,
            notes: i18n.t(
              'Critère multi-pages : nécessite au moins deux pages. À revoir lors d’un second passage.',
              'Multi-page criterion: requires at least two pages. Review in a second pass.'
            ),
            automated: false,
            aiCandidate: false
          };
          const index = results.length;
          results.push({ ...criterion, ...evaluation });
          reportCriterion(
            criterion,
            {
              status: evaluation.status,
              notes: evaluation.notes,
              ai: evaluation.ai || null,
              automated: Boolean(evaluation.automated),
              aiCandidate: Boolean(evaluation.aiCandidate)
            },
            index
          );
          continue;
        }
        if (criterion.id === '12.5' && hasMultiPageAudit) {
          const evaluation = {
            status: STATUS.REVIEW,
            notes: i18n.t(
              'Critère multi-pages : revue inter-pages en seconde passe.',
              'Multi-page criterion: cross-page review in a second pass.'
            ),
            automated: false,
            aiCandidate: false
          };
          const index = results.length;
          results.push({ ...criterion, ...evaluation });
          reportCriterion(
            criterion,
            {
              status: evaluation.status,
              notes: evaluation.notes,
              ai: evaluation.ai || null,
              automated: Boolean(evaluation.automated),
              aiCandidate: Boolean(evaluation.aiCandidate)
            },
            index
          );
          continue;
        }

        const evaluation = evaluateCriterion(criterion, page.snapshot, { lang: reportLang });
        const index = results.length;
        results.push({ ...criterion, ...evaluation });
        if (evaluation.aiCandidate) {
          pendingAI.push({ criterion, index });
        } else {
          reportCriterion(criterion, {
            status: evaluation.status || STATUS.ERR,
            notes: evaluation.notes || 'Missing evaluation.',
            ai: evaluation.ai || null,
            automated: Boolean(evaluation.automated),
            aiCandidate: Boolean(evaluation.aiCandidate)
          }, index);
        }
      }

      if (!page.error && pendingAI.length > 0) {
        if (pauseController) await pauseController.waitIfPaused();
        const pseudoCriterion = {
          id: `AI(${pendingAI.length})`,
          title: 'Batch criteria review',
          theme: 'AI'
        };
        reporter?.onAIStart?.({ criterion: pseudoCriterion });

        const batchById = new Map();
        const batchSizeRaw = Number(process.env.AUDIT_AI_BATCH_SIZE || '');
        const batchSize =
          Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.floor(batchSizeRaw) : 6;

        const evaluationFromHit = (hit) => {
          const confidence = Number(hit.confidence || 0);
          const rationale = String(hit.rationale || '');
          const evidence = Array.isArray(hit.evidence) ? hit.evidence : [];
          return {
            status: hit.status || STATUS.NC,
            notes: `${i18n.notes.aiReviewLabel()} (${confidence.toFixed(2)}): ${rationale}`,
            ai: { confidence, rationale, evidence }
          };
        };

        for (let start = 0; start < pendingAI.length; start += batchSize) {
          if (aborted || signal?.aborted) {
            throw createAbortError();
          }
          if (pauseController) await pauseController.waitIfPaused();
          const chunk = pendingAI.slice(start, start + batchSize);
          try {
            const batchResults = await withPauseRetry({
              pauseController,
              reporter,
              label: 'AI batch',
              retryOnAny: true,
              signal,
              fn: ({ signal: attemptSignal }) =>
                aiReviewCriteriaBatch({
                  model: options.ai.model,
                  url,
                  criteria: chunk.map((p) => p.criterion),
                  snapshot: page.snapshot,
                  reportLang,
                  onLog: (message) => reporter?.onAILog?.({ criterion: pseudoCriterion, message }),
                  onStage: (label) => reporter?.onAIStage?.({ criterion: pseudoCriterion, label }),
                  onError: (message) => reporter?.onError?.(message),
                  failFast,
                  signal: attemptSignal,
                  mcp: mcpForAi
                })
            });
            for (const r of Array.isArray(batchResults) ? batchResults : []) {
              const key = String(r?.criterion_id || '');
              if (key) batchById.set(key, r);
            }

            // Update progress incrementally (avoid "stuck at 22/106 then jump to 100%").
            for (const pending of chunk) {
              const { criterion, index } = pending;
              if (reported.has(index)) continue;
              const hit = batchById.get(criterion.id);
              if (!hit) continue;
              const evaluation = evaluationFromHit(hit);
              results[index] = { ...criterion, ...evaluation };
              if (evaluation.status === STATUS.ERR) {
                aiFailed += 1;
              }
              queueReviewRetry(criterion, index, evaluation);
              reportCriterion(
                criterion,
                {
                  status: evaluation.status || STATUS.ERR,
                  notes: evaluation.notes || 'Missing evaluation.',
                  ai: evaluation.ai || null,
                  automated: Boolean(evaluation.automated),
                  aiCandidate: Boolean(evaluation.aiCandidate)
                },
                index
              );
            }
          } catch (err) {
            reporter?.onAILog?.({
              criterion: pseudoCriterion,
              message: `Batch chunk failed (${start + 1}-${Math.min(
                pendingAI.length,
                start + chunk.length
              )}); will fall back to per-criterion for missing ids. ${String(err?.message || err)}`
            });
          }
        }

        for (const pending of pendingAI) {
          if (aborted || signal?.aborted) {
            throw createAbortError();
          }
          if (pauseController) await pauseController.waitIfPaused();

          const { criterion, index } = pending;
          if (reported.has(index)) continue;
          const hit = batchById ? batchById.get(criterion.id) : null;

          let evaluation;
          if (hit) {
            evaluation = evaluationFromHit(hit);
          } else {
            evaluation = await withPauseRetry({
              pauseController,
              reporter,
              label: `AI criterion ${criterion.id}`,
              retryOnAny: true,
              signal,
              fn: ({ signal: attemptSignal }) =>
                aiReviewCriterion({
                  model: options.ai.model,
                  url,
                  criterion,
                  snapshot: page.snapshot,
                  reportLang,
                  onLog: (message) => reporter?.onAILog?.({ criterion, message }),
                  onStage: (label) => reporter?.onAIStage?.({ criterion, label }),
                  onError: (message) => reporter?.onError?.(message),
                  failFast,
                  signal: attemptSignal,
                  mcp: mcpForAi
                })
            });
          }

          if (evaluation.status === STATUS.ERR) {
            aiFailed += 1;
          }

          results[index] = { ...criterion, ...evaluation };
          queueReviewRetry(criterion, index, evaluation);
          reportCriterion(criterion, {
            status: evaluation.status || STATUS.ERR,
            notes: evaluation.notes || 'Missing evaluation.',
            ai: evaluation.ai || null,
            automated: Boolean(evaluation.automated),
            aiCandidate: Boolean(evaluation.aiCandidate)
          }, index);
        }
      }

      if (reviewRetry.length > 0) {
        const pseudoCriterion = {
          id: `AI(${reviewRetry.length})`,
          title: 'Review follow-up',
          theme: 'AI'
        };
        reporter?.onAIStart?.({ criterion: pseudoCriterion });
        for (const pending of reviewRetry) {
          if (aborted || signal?.aborted) {
            throw createAbortError();
          }
          if (pauseController) await pauseController.waitIfPaused();
          const { criterion, index } = pending;
          const evaluation = await withPauseRetry({
            pauseController,
            reporter,
            label: `AI retry ${criterion.id}`,
            retryOnAny: true,
            signal,
            fn: ({ signal: attemptSignal }) =>
              aiReviewCriterion({
                model: options.ai.model,
                url,
                criterion,
                snapshot: page.snapshot,
                reportLang,
                onLog: (message) => reporter?.onAILog?.({ criterion, message }),
                onStage: (label) => reporter?.onAIStage?.({ criterion, label }),
                onError: (message) => reporter?.onError?.(message),
                failFast,
                signal: attemptSignal,
                mcp: mcpForAi,
                retry: true
              })
          });
          if (evaluation.status === STATUS.ERR) {
            aiFailed += 1;
          }
          results[index] = { ...criterion, ...evaluation };
        }
      }

      // Report final results in criterion order (after AI batch is merged).
      for (let i = 0; i < criteria.length; i++) {
        if (aborted || signal?.aborted) {
          throw createAbortError();
        }
        if (pauseController) await pauseController.waitIfPaused();
        const criterion = criteria[i];
        const res = results[i];
        if (!reported.has(i)) {
          const evaluation = {
            status: res?.status || STATUS.ERR,
            notes: res?.notes || 'Missing evaluation.',
            ai: res?.ai || null,
            automated: Boolean(res?.automated),
            aiCandidate: Boolean(res?.aiCandidate)
          };
          reportCriterion(criterion, evaluation, i);
        }
      }
      const inferenceCounts = summarizeCounts(results);
      reporter?.onInferenceSummary?.({ url, counts: inferenceCounts });
      reporter?.onInferenceEnd?.({ url });
      reporter?.onChecksEnd?.({ index: pageIndex, url });
      if (page.error) pagesFailed += 1;
      const searchEvidence = page?.snapshot ? extractSearchEvidence(page.snapshot) : null;
      if (searchEvidence) {
        crossPageEvidence.push({
          url,
          title: page?.snapshot?.title || '',
          ...searchEvidence
        });
      }
      if (page?.snapshot) {
        pageMeta.push({
          url,
          title: page.snapshot.title || '',
          lang: page.snapshot.lang || ''
        });
      }
      pageResults.push({ url, snapshot: compactSnapshot(page.snapshot), results });
      if (options.resumeStatePath) {
        const completedPages = pageResults.map((item) => ({
          url: item.url,
          results: item.results,
          title: item.snapshot?.title || '',
          lang: item.snapshot?.lang || ''
        }));
        await writeResumeState(
          options.resumeStatePath,
          buildResumeState({
            pages: options.pages,
            reportLang,
            outPath: options.outPath ? path.resolve(options.outPath) : null,
            completedPages,
            crossPageEvidence,
            pageMeta,
            criteriaIds,
            createdAt: options.resumeState?.createdAt
          })
        );
      }
      if (incrementalXlsx && options.outPath) {
        await writeXlsxReport({ final: false });
      }
      if (reporter && reporter.onPageEnd) {
        const counts = summarizeCounts(results);
        reporter.onPageEnd({ index: pageIndex, url, counts });
      }
    }
  } finally {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    if (chrome) {
      try {
        await chrome.kill();
      } catch {}
    }
  }

  if (!aborted && !signal?.aborted && hasMultiPageAudit && crossPageEvidence.length > 0) {
    const criterionIndex = criteriaIndexById.get('12.5');
    if (typeof criterionIndex === 'number') {
      const criterion = criteria[criterionIndex];
      const pseudoCriterion = {
        id: 'AI(12.5)',
        title: criterion.title,
        theme: criterion.theme
      };
      secondPassSummary.total = 1;
      secondPassSummary.done = 0;
      secondPassSummary.criteria = [{ id: criterion.id, title: criterion.title, status: null }];
      reporter?.onCrossPageStart?.({
        total: 1,
        criteria: [criterion]
      });
      reporter?.onAIStart?.({ criterion: pseudoCriterion });
      try {
        reporter?.onCrossPageUpdate?.({ done: 0, total: 1, current: criterion });
        const evaluation = await withPauseRetry({
          pauseController,
          reporter,
          label: `AI cross-page ${criterion.id}`,
          retryOnAny: true,
          signal,
          fn: ({ signal: attemptSignal }) =>
            aiReviewCrossPageCriterion({
              model: options.ai?.model,
              criterion,
              pages: crossPageEvidence,
              reportLang,
              onLog: (message) => reporter?.onAILog?.({ criterion: pseudoCriterion, message }),
              onStage: (label) => reporter?.onAIStage?.({ criterion: pseudoCriterion, label }),
              onError: (message) => reporter?.onError?.(message),
              failFast,
              signal: attemptSignal
            })
        });
        if (evaluation.status === STATUS.ERR) {
          aiFailed += 1;
        }
        for (const page of pageResults) {
          if (Array.isArray(page.results) && page.results[criterionIndex]) {
            page.results[criterionIndex] = { ...criterion, ...evaluation };
          }
        }
        secondPassSummary.done = 1;
        secondPassSummary.criteria = [
          { id: criterion.id, title: criterion.title, status: evaluation.status || STATUS.ERR }
        ];
        reporter?.onCrossPageDecision?.({ criterion, evaluation });
        reporter?.onCrossPageUpdate?.({ done: 1, total: 1, current: criterion });
      } catch (err) {
        if (failFast) throw err;
        reporter?.onAILog?.({
          criterion: pseudoCriterion,
          message: `Cross-page AI failed: ${String(err?.message || err)}`
        });
        secondPassSummary.done = 1;
        secondPassSummary.criteria = [
          { id: criterion.id, title: criterion.title, status: STATUS.ERR }
        ];
      } finally {
        reporter?.onCrossPageEnd?.({ done: 1, total: 1 });
      }
    }
  }

  function computeGlobalSummary() {
    const pageResultsById = pageResults.map((page) => {
      const byId = new Map();
      for (const res of page.results) {
        if (res?.id) byId.set(res.id, res);
      }
      return byId;
    });
    const globalByCriterion = new Map();
    for (const criterion of criteria) {
      const statuses = pageResultsById.map(
        (byId) => byId.get(criterion.id)?.status || STATUS.ERR
      );
      let status = STATUS.C;
      if (statuses.every((s) => s === STATUS.NA)) {
        status = STATUS.NA;
      } else if (statuses.some((s) => s === STATUS.ERR)) {
        status = STATUS.ERR;
      } else if (statuses.some((s) => s === STATUS.NC)) {
        status = STATUS.NC;
      } else if (statuses.some((s) => s === STATUS.REVIEW)) {
        status = STATUS.REVIEW;
      }
      globalByCriterion.set(criterion.id, {
        ...criterion,
        status
      });
    }
    const globalCounts = summarizeCounts(Array.from(globalByCriterion.values()));
    const globalScore = scoreFromCounts(globalCounts);
    const errorSummary = {
      pagesFailed,
      aiFailed,
      criteriaErrored: globalCounts.ERR
    };
    return { pageResultsById, globalByCriterion, globalCounts, globalScore, errorSummary };
  }

  const outPath = options.outPath ? path.resolve(options.outPath) : null;
  const auditFinishedAt = new Date();


  async function writeXlsxReport({ final }) {
    const { pageResultsById, globalCounts, globalScore, errorSummary } = computeGlobalSummary();
    if (!options.outPath) {
      if (final && reporter && reporter.onDone) {
        reporter.onDone({
          outPath: null,
          globalScore,
          counts: globalCounts,
          errors: errorSummary,
          secondPass: secondPassSummary
        });
      }
      return { globalCounts, globalScore, errorSummary };
    }

    const BASE_FONT_SIZE = 14;
    const workbook = new ExcelJS.Workbook();
    const authorName = 'Aurélien Lewin';
    const authorUrl = 'https://github.com/aurelienlewin';
    const modelLabel = '';
    const hosts = pageResults
      .map((page) => {
        try {
          return new URL(page.url).hostname;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    const uniqueHosts = Array.from(new Set(hosts));
    const pageTitles = pageMeta
      .map((p) => p.title)
      .filter(Boolean)
      .slice(0, 8);
    const chromeLabel = chromeInfo?.browser || '';
    workbook.creator = authorName;
    workbook.lastModifiedBy = authorName;
    workbook.company = 'OSF Digital';
    workbook.properties = {
      title: `RGAA Audit • ${pageResults.length} page(s)`,
      subject: `RGAA 4.x accessibility audit${modelLabel ? ` • ${modelLabel}` : ''}`,
      category: 'Accessibility',
      keywords: [
        'RGAA',
        'accessibility',
        'audit',
        modelLabel,
        ...uniqueHosts
      ]
        .filter(Boolean)
        .join(', '),
      description: [
        `Generated by RGAA Website Auditor • ${authorName} • ${authorUrl}`,
        chromeLabel ? `Chrome: ${chromeLabel}` : '',
        pageTitles.length ? `Pages: ${pageTitles.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join(' • ')
    };

    const uiSheet = workbook.addWorksheet(i18n.excel.auditSheet());
    const summarySheet = workbook.addWorksheet(i18n.excel.summarySheet());
    const evidenceSheet = workbook.addWorksheet(i18n.excel.evidenceSheet());

    const COLORS = {
      headerBg: 'FF0F172A',
      headerFg: 'FFF8FAFC',
      grid: 'FFE2E8F0',
      note: 'FF475569'
    };

    const statusStyle = (status) => {
      switch (status) {
        case STATUS.C:
          return { icon: '✅', fg: 'FF14532D', bg: 'FFDCFCE7' };
        case STATUS.NC:
          return { icon: '❌', fg: 'FF7F1D1D', bg: 'FFFEE2E2' };
        case STATUS.NA:
          return { icon: '➖', fg: 'FF334155', bg: 'FFE2E8F0' };
        case STATUS.REVIEW:
          return { icon: '👀', fg: 'FF7C2D12', bg: 'FFFFEDD5' };
        case STATUS.ERR:
          return { icon: '⚠️', fg: 'FF7F1D1D', bg: 'FFFEE2E2' };
        default:
          return { icon: '?', fg: 'FF0F172A', bg: 'FFF8FAFC' };
      }
    };

    const statusDropdown = [STATUS.C, STATUS.NC, STATUS.NA, STATUS.REVIEW, STATUS.ERR].join(',');

    const applyStatusCellStyle = (cell, status) => {
      const style = statusStyle(status);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.bg } };
      cell.font = { size: BASE_FONT_SIZE, bold: true, color: { argb: style.fg } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin', color: { argb: COLORS.grid } },
        left: { style: 'thin', color: { argb: COLORS.grid } },
        bottom: { style: 'thin', color: { argb: COLORS.grid } },
        right: { style: 'thin', color: { argb: COLORS.grid } }
      };
      return style;
    };

    const lastCol = toExcelColumn(3 + pageResults.length);
    const pageLabels = pageResults.map((page, index) => `P${index + 1}`);

    uiSheet.columns = [
      { header: i18n.excel.criterionId(), key: 'id', width: 11 },
      { header: i18n.excel.criterionTheme(), key: 'theme', width: 18 },
      { header: i18n.excel.criterionTitle(), key: 'title', width: 64 },
      ...pageLabels.map((label) => ({ header: label, key: label, width: 6 }))
    ];

    evidenceSheet.columns = [
      { header: i18n.excel.criterionId(), key: 'id', width: 10 },
      { header: i18n.excel.criterionTheme(), key: 'theme', width: 18 },
      { header: i18n.excel.criterionTitle(), key: 'title', width: 64 },
      { header: i18n.excel.pageLabel(), key: 'page', width: 6 },
      { header: i18n.excel.pageUrl(), key: 'url', width: 60 },
      { header: i18n.excel.status(), key: 'status', width: 12 },
      { header: i18n.excel.summary(), key: 'summary', width: 56 },
      { header: i18n.excel.evidence(), key: 'evidence', width: 56 },
      { header: i18n.excel.examples(), key: 'examples', width: 56 },
      { header: i18n.excel.screenshot1(), key: 'screenshot1', width: 26 },
      { header: i18n.excel.screenshot2(), key: 'screenshot2', width: 26 }
    ];

    const headerStyle = (row, sheet) => {
      row.font = { size: BASE_FONT_SIZE, bold: true, color: { argb: COLORS.headerFg } };
      row.height = 22;
      row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      row.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
        cell.border = {
          top: { style: 'thin', color: { argb: COLORS.grid } },
          left: { style: 'thin', color: { argb: COLORS.grid } },
          bottom: { style: 'thin', color: { argb: COLORS.grid } },
          right: { style: 'thin', color: { argb: COLORS.grid } }
        };
      });
      sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }];
    };

    headerStyle(uiSheet.getRow(1), uiSheet);
    headerStyle(evidenceSheet.getRow(1), evidenceSheet);

    const collapseEvidence = (text) =>
      String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/\n/g, ' ')
        .trim()
        .slice(0, 400);

    const buildEvidencePayload = (res) => {
      if (!res) return { status: STATUS.ERR, summary: '', evidence: [], examples: [] };
      const status = res.status || STATUS.ERR;
      const aiConfidence = res.ai?.confidence ?? null;
      const aiRationale = collapseEvidence(res.ai?.rationale || '');
      const summary =
        aiRationale && Number.isFinite(aiConfidence)
          ? `${i18n.notes.aiPrefix(aiConfidence)}: ${aiRationale}`
          : collapseEvidence(res.notes || '');

      const evidence = [];
      if (Array.isArray(res.ai?.evidence)) {
        for (const ex of res.ai.evidence) {
          const line = collapseEvidence(ex);
          if (line) evidence.push(line);
        }
      }

      const examples = [];
      if (Array.isArray(res.examples)) {
        for (const ex of res.examples) {
          const line = collapseEvidence(ex);
          if (line) examples.push(line);
        }
      }

      return { status, summary, evidence, examples };
    };

    const buildCellNote = (res) => {
      if (!res) return '';
      const payload = buildEvidencePayload(res);
      const lines = [];
      lines.push(`${payload.status}${payload.summary ? `: ${payload.summary}` : ''}`);
      if (payload.evidence.length > 0) {
        lines.push(i18n.notes.evidenceLabel());
        for (const ex of payload.evidence) {
          lines.push(`- ${ex}`);
        }
      }
      if (payload.examples.length > 0) {
        lines.push(i18n.notes.examplesLabel());
        for (const ex of payload.examples.slice(0, 3)) {
          lines.push(`- ${ex}`);
        }
      }

      return lines.join('\n').slice(0, 800);
    };

    const evidenceDir = outPath ? path.join(path.dirname(outPath), 'evidence') : '';
    const evidenceLinksByPage = await copyEvidenceScreenshots(pageResults, evidenceDir);
    if (final) {
      await cleanupEnrichmentTempFiles(pageResults, evidenceLinksByPage, { force: !evidenceDir });
    }

    const applyHyperlinkStyle = (cell) => {
      cell.font = { ...(cell.font || {}), color: { argb: 'FF1D4ED8' }, underline: true };
    };

    const listToText = (items) =>
      Array.isArray(items) && items.length
        ? items.map((item) => `- ${item}`).join('\n')
        : '';

    for (const criterion of criteria) {
      const uiRow = [criterion.id, criterion.theme, criterion.title];
      for (let pageIndex = 0; pageIndex < pageResults.length; pageIndex += 1) {
        uiRow.push('');
      }
      const excelUiRow = uiSheet.addRow(uiRow);
      excelUiRow.font = { size: BASE_FONT_SIZE };

      for (let c = 1; c <= 3; c += 1) {
        const cell = excelUiRow.getCell(c);
        cell.font = { size: BASE_FONT_SIZE, bold: true };
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = {
          top: { style: 'thin', color: { argb: COLORS.grid } },
          left: { style: 'thin', color: { argb: COLORS.grid } },
          bottom: { style: 'thin', color: { argb: COLORS.grid } },
          right: { style: 'thin', color: { argb: COLORS.grid } }
        };
      }

      for (let pageIndex = 0; pageIndex < pageResults.length; pageIndex += 1) {
        const res = pageResultsById[pageIndex].get(criterion.id);
        const uiCell = excelUiRow.getCell(4 + pageIndex);
        const s = applyStatusCellStyle(uiCell, res?.status || STATUS.ERR);
        uiCell.value = s.icon;
        uiCell.dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`"${statusDropdown}"`]
        };
        uiCell.note = buildCellNote(res);

        const evidencePayload = buildEvidencePayload(res);
        const pageUrl = pageResults[pageIndex]?.url || '';
        const evidenceLinks = evidenceLinksByPage[pageIndex] || {};
        const evidenceRow = evidenceSheet.addRow([
          criterion.id,
          criterion.theme,
          criterion.title,
          pageLabels[pageIndex],
          pageUrl,
          evidencePayload.status,
          evidencePayload.summary,
          listToText(evidencePayload.evidence),
          listToText(evidencePayload.examples),
          evidenceLinks.screenshot1 || '',
          evidenceLinks.screenshot2 || ''
        ]);

        for (let c = 1; c <= 11; c += 1) {
          const cell = evidenceRow.getCell(c);
          cell.alignment = { vertical: 'top', wrapText: true };
          cell.border = {
            top: { style: 'thin', color: { argb: COLORS.grid } },
            left: { style: 'thin', color: { argb: COLORS.grid } },
            bottom: { style: 'thin', color: { argb: COLORS.grid } },
            right: { style: 'thin', color: { argb: COLORS.grid } }
          };
        }

        if (pageUrl) {
          const urlCell = evidenceRow.getCell(5);
          urlCell.value = { text: pageUrl, hyperlink: pageUrl };
          applyHyperlinkStyle(urlCell);
        }
        if (evidenceLinks.screenshot1) {
          const shotCell = evidenceRow.getCell(10);
          shotCell.value = { text: evidenceLinks.screenshot1, hyperlink: evidenceLinks.screenshot1 };
          applyHyperlinkStyle(shotCell);
        }
        if (evidenceLinks.screenshot2) {
          const shotCell = evidenceRow.getCell(11);
          shotCell.value = { text: evidenceLinks.screenshot2, hyperlink: evidenceLinks.screenshot2 };
          applyHyperlinkStyle(shotCell);
        }
      }
    }

    const auditRange = `D2:${lastCol}${uiSheet.rowCount}`;

    const summaryTitleRow = summarySheet.addRow([i18n.excel.summaryTitle()]);
    summarySheet.getColumn(1).width = 30;
    summarySheet.getColumn(2).width = 20;
    summarySheet.mergeCells('A1:B1');
    summaryTitleRow.font = { size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
    summaryTitleRow.alignment = { vertical: 'middle', horizontal: 'center' };
    summaryTitleRow.height = 28;
    summaryTitleRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };

    const infoRows = [
      [i18n.excel.generatedAt(), new Date().toISOString()],
      [i18n.excel.pagesAudited(), options.pages.length],
      [i18n.excel.globalScore(), globalScore],
      [i18n.excel.pagesFailed(), pagesFailed]
    ];
    for (const row of infoRows) {
      const r = summarySheet.addRow(row);
      r.getCell(1).font = { size: BASE_FONT_SIZE, bold: true };
      r.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
      r.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
      r.getCell(2).font = { size: BASE_FONT_SIZE, bold: true };
    }
    const scoreRowIndex = summaryTitleRow.number + 3;
    const scoreCell = summarySheet.getRow(scoreRowIndex).getCell(2);
    scoreCell.numFmt = '0.0%';
    const countC = `COUNTIF(Audit!${auditRange},"${statusStyle(STATUS.C).icon}")`;
    const countNC = `COUNTIF(Audit!${auditRange},"${statusStyle(STATUS.NC).icon}")`;
    scoreCell.value = {
      formula: `IF((${countC}+${countNC})=0,0,${countC}/(${countC}+${countNC}))`
    };
    summarySheet.addRow([]);
    summarySheet.addRow([i18n.excel.globalStatus()]);
    const statusRows = [
      { status: STATUS.C, label: i18n.excel.conform(), value: globalCounts.C },
      { status: STATUS.NC, label: i18n.excel.notConform(), value: globalCounts.NC },
      { status: STATUS.NA, label: i18n.excel.nonApplicable(), value: globalCounts.NA },
      { status: STATUS.REVIEW, label: i18n.excel.review(), value: globalCounts.REVIEW || 0 },
      { status: STATUS.ERR, label: i18n.excel.errors(), value: globalCounts.ERR }
    ];
    for (const row of statusRows) {
      const r = summarySheet.addRow([row.label, row.value]);
      const labelCell = r.getCell(1);
      const valueCell = r.getCell(2);
      labelCell.font = { size: BASE_FONT_SIZE, bold: true };
      labelCell.alignment = { vertical: 'middle', horizontal: 'left' };
      valueCell.font = { size: BASE_FONT_SIZE, bold: true };
      valueCell.alignment = { vertical: 'middle', horizontal: 'center' };
      const s = statusStyle(row.status);
      valueCell.value = {
        formula: `COUNTIF(Audit!${auditRange},"${s.icon}")`
      };
      valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.bg } };
      valueCell.font = { size: BASE_FONT_SIZE, bold: true, color: { argb: s.fg } };
    }

    const summaryBottom = summarySheet.rowCount;
    for (let r = 1; r <= summaryBottom; r += 1) {
      for (let c = 1; c <= 2; c += 1) {
        const cell = summarySheet.getRow(r).getCell(c);
        cell.border = {
          top: { style: 'thin', color: { argb: COLORS.grid } },
          left: { style: 'thin', color: { argb: COLORS.grid } },
          bottom: { style: 'thin', color: { argb: COLORS.grid } },
          right: { style: 'thin', color: { argb: COLORS.grid } }
        };
      }
    }

    summarySheet.addRow([]);
    summarySheet.addRow([i18n.t('Légende', 'Legend')]);
    const legend = [
      [statusStyle(STATUS.C).icon, i18n.statusLabel(STATUS.C)],
      [statusStyle(STATUS.NC).icon, i18n.statusLabel(STATUS.NC)],
      [statusStyle(STATUS.NA).icon, i18n.statusLabel(STATUS.NA)],
      [statusStyle(STATUS.REVIEW).icon, i18n.statusLabel(STATUS.REVIEW)],
      [statusStyle(STATUS.ERR).icon, i18n.statusLabel(STATUS.ERR)]
    ];
    for (const [icon, label] of legend) {
      const r = summarySheet.addRow([icon, label]);
      r.getCell(1).alignment = { horizontal: 'center' };
    }

    for (const sheet of [uiSheet, summarySheet, evidenceSheet]) {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cell.font = { ...(cell.font || {}), size: Math.max(BASE_FONT_SIZE, cell.font?.size || 0) };
        });
      });
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await workbook.xlsx.writeFile(outPath);
    if (final && reporter && reporter.onDone) {
      reporter.onDone({
        outPath,
        globalScore,
        counts: globalCounts,
        errors: errorSummary,
        secondPass: secondPassSummary
      });
    }
    if (final && shouldOpenReport()) {
      openReport(outPath);
    }
    return { globalCounts, globalScore, errorSummary };
  }

  if (options.outPath) {
    await writeXlsxReport({ final: true });
  } else if (reporter && reporter.onDone) {
    const { globalCounts, globalScore, errorSummary } = computeGlobalSummary();
    reporter.onDone({
      outPath: null,
      globalScore,
      counts: globalCounts,
      errors: errorSummary,
      secondPass: secondPassSummary
    });
  }


  const closeTabsEnv = String(process.env.AUDIT_CLOSE_TABS || '').trim().toLowerCase();
  const shouldCloseTabs = closeTabsEnv !== '0' && closeTabsEnv !== 'false' && closeTabsEnv !== 'no';
  if (shouldCloseTabs && !aborted && !signal?.aborted) {
    try {
      const urlsToClose = Array.isArray(options.pages) ? options.pages : [];
      const result = await closeMcpPages({
        urls: urlsToClose,
        model: options.ai?.model,
        mcp: mcpConfig,
        onLog: (message) =>
          reporter?.onAILog?.({ criterion: { id: 'cleanup', title: 'Close tabs', theme: 'Debug' }, message }),
        onStage: (label) =>
          reporter?.onAIStage?.({ criterion: { id: 'cleanup', title: 'Close tabs', theme: 'Debug' }, label }),
        signal
      });
      const closedCount = Array.isArray(result?.closed) ? result.closed.length : 0;
      if (closedCount > 0) {
        reporter?.onAILog?.({
          criterion: { id: 'cleanup', title: 'Close tabs', theme: 'Debug' },
          message: `Closed ${closedCount} audited tab(s).`
        });
      }
    } catch (err) {
      reporter?.onAILog?.({
        criterion: { id: 'cleanup', title: 'Close tabs', theme: 'Debug' },
        message: `Warning: failed to close audited tabs (${String(err?.message || err)})`
      });
    }
  }

  return { outPath, globalScore, counts: globalCounts, errors: errorSummary };
}
