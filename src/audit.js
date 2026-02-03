import fs from 'node:fs/promises';
import path from 'node:path';
import chromeLauncher from 'chrome-launcher';
import ExcelJS from 'exceljs';
import { loadCriteria } from './criteria.js';
import { collectSnapshotWithMcp } from './mcpSnapshot.js';
import { collectEnrichedEvidenceWithMcp } from './mcpEnrich.js';
import { closeMcpPages } from './mcpClosePages.js';
import { buildEnrichment } from './enrichment.js';
import { evaluateCriterion, STATUS } from './checks.js';
import { aiReviewCriteriaBatch, aiReviewCriterion } from './ai.js';
import { createAbortError, isAbortError } from './abort.js';
import { getI18n, normalizeReportLang } from './i18n.js';

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
  const criteria = loadCriteria({ lang: reportLang });
  const reporter = options.reporter || null;
  const signal = options.signal || null;
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
  const mcpForAi = aiUseMcp ? { ...mcpConfig, ocr: aiUseOcr, utils: aiUseUtils } : null;
  let pagesFailed = 0;
  let aiFailed = 0;
  const wantsEnrichment =
    String(process.env.AUDIT_ENRICH || '').trim().toLowerCase() !== '0';
  const wantsDebugSnapshots =
    String(process.env.AUDIT_DEBUG_SNAPSHOTS || '').trim() === '1' ||
    String(process.env.AUDIT_DEBUG_SNAPSHOTS || '').trim().toLowerCase() === 'true';
  const debugSnapshotsDir =
    wantsDebugSnapshots && options.outPath
      ? path.join(path.dirname(path.resolve(options.outPath)), 'snapshots')
      : '';

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

  const pageResults = [];

  try {
    if (aborted || signal?.aborted) {
      throw createAbortError();
    }
    if (reporter && reporter.onChromeReady) reporter.onChromeReady();
    for (const url of options.pages) {
      if (aborted || signal?.aborted) {
        throw createAbortError();
      }
      const pageIndex = pageResults.length;
      if (reporter && reporter.onPageStart) reporter.onPageStart({ index: pageIndex, url });
      let page = null;
      reporter?.onPageNavigateStart?.({ url });
      const navStart = Date.now();
      try {
        reporter?.onSnapshotStart?.({ url });
        const snapshotStart = Date.now();
        const snapshot = await collectSnapshotWithMcp({
          url,
          model: options.ai?.model,
          mcp: mcpConfig,
          onLog: (message) => reporter?.onAILog?.({ criterion: { id: 'snapshot' }, message }),
          onStage: (label) => reporter?.onAIStage?.({ criterion: { id: 'snapshot' }, label }),
          signal
        });
        let enrichment = null;
        if (wantsEnrichment && options.ai?.useMcp) {
          try {
            const enriched = await collectEnrichedEvidenceWithMcp({
              url,
              model: options.ai?.model,
              mcp: mcpConfig,
              onLog: (message) => reporter?.onAILog?.({ criterion: { id: 'enrich' }, message }),
              onStage: (label) => reporter?.onAIStage?.({ criterion: { id: 'enrich' }, label }),
              signal
            });
            enrichment = await buildEnrichment(enriched);
            snapshot.enrichment = enrichment;
          } catch (err) {
            reporter?.onAILog?.({
              criterion: { id: 'enrich', title: 'Enrichment', theme: 'Debug' },
              message: `Enrichment failed: ${String(err?.message || err)}`
            });
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
          const chunk = pendingAI.slice(start, start + batchSize);
          try {
            const batchResults = await aiReviewCriteriaBatch({
              model: options.ai.model,
              url,
              criteria: chunk.map((p) => p.criterion),
              snapshot: page.snapshot,
              reportLang,
              onLog: (message) => reporter?.onAILog?.({ criterion: pseudoCriterion, message }),
              onStage: (label) => reporter?.onAIStage?.({ criterion: pseudoCriterion, label }),
              signal,
              mcp: mcpForAi
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

          const { criterion, index } = pending;
          if (reported.has(index)) continue;
          const hit = batchById ? batchById.get(criterion.id) : null;

          let evaluation;
          if (hit) {
            evaluation = evaluationFromHit(hit);
          } else {
            evaluation = await aiReviewCriterion({
              model: options.ai.model,
              url,
              criterion,
              snapshot: page.snapshot,
              reportLang,
              onLog: (message) => reporter?.onAILog?.({ criterion, message }),
              onStage: (label) => reporter?.onAIStage?.({ criterion, label }),
              signal,
              mcp: mcpForAi
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
          const { criterion, index } = pending;
          const evaluation = await aiReviewCriterion({
            model: options.ai.model,
            url,
            criterion,
            snapshot: page.snapshot,
            reportLang,
            onLog: (message) => reporter?.onAILog?.({ criterion, message }),
            onStage: (label) => reporter?.onAIStage?.({ criterion, label }),
            signal,
            mcp: mcpForAi,
            retry: true
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
      reporter?.onChecksEnd?.({ index: pageIndex, url });
      if (page.error) pagesFailed += 1;
      pageResults.push({ url, snapshot: page.snapshot, results });
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
  const outPath = options.outPath ? path.resolve(options.outPath) : null;
  const errorSummary = {
    pagesFailed,
    aiFailed,
    criteriaErrored: globalCounts.ERR
  };

  if (options.outPath) {
    const BASE_FONT_SIZE = 14;
    const workbook = new ExcelJS.Workbook();
    const summarySheet = workbook.addWorksheet('Summary');
    const uiSheet = workbook.addWorksheet('Audit');

    const toColLetter = (n) => {
      let col = '';
      let num = n;
      while (num > 0) {
        const rem = (num - 1) % 26;
        col = String.fromCharCode(65 + rem) + col;
        num = Math.floor((num - 1) / 26);
      }
      return col;
    };

    const pageLabels = pageResults.map((page, index) => {
      const title = String(page?.snapshot?.title || '').trim();
      if (title) return title.slice(0, 40);
      try {
        const host = new URL(page.url).hostname;
        if (host) return host.slice(0, 32);
      } catch {}
      return `Page ${index + 1}`;
    });
    const header = [...i18n.excel.matrixHeader(), ...pageLabels];
    uiSheet.addRow(header);

    const lastCol = toColLetter(3 + pageLabels.length);

    const COLORS = {
      headerBg: 'FF0F172A',
      headerFg: 'FFFFFFFF',
      grid: 'FFCBD5E1',
      conformBg: 'FFDCFCE7',
      conformFg: 'FF166534',
      notConformBg: 'FFFEE2E2',
      notConformFg: 'FFB91C1C',
      naBg: 'FFF1F5F9',
      naFg: 'FF475569',
      errBg: 'FFFCA5A5',
      errFg: 'FF7F1D1D',
      reviewBg: 'FFFEF3C7',
      reviewFg: 'FF92400E',
      aiBg: 'FFEDE9FE',
      aiFg: 'FF6D28D9'
    };

    const styleHeaderRow = (sheet) => {
      sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 1 }];
      sheet.getRow(1).font = { size: BASE_FONT_SIZE, bold: true, color: { argb: COLORS.headerFg } };
      sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      for (let col = 1; col <= 3 + pageLabels.length; col += 1) {
        const cell = sheet.getRow(1).getCell(col);
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
        cell.border = {
          top: { style: 'thin', color: { argb: COLORS.grid } },
          left: { style: 'thin', color: { argb: COLORS.grid } },
          bottom: { style: 'thin', color: { argb: COLORS.grid } },
          right: { style: 'thin', color: { argb: COLORS.grid } }
        };
      }
      sheet.autoFilter = { from: 'A1', to: `${lastCol}1` };

      sheet.getColumn(1).width = 7;
      sheet.getColumn(2).width = 22;
      sheet.getColumn(3).width = 64;
      for (let i = 0; i < pageLabels.length; i += 1) {
        const col = 4 + i;
        sheet.getColumn(col).width = 18;
      }
    };

    styleHeaderRow(uiSheet);
    // Attach page URLs as header comments.
    for (let i = 0; i < pageResults.length; i += 1) {
      const cell = uiSheet.getRow(1).getCell(4 + i);
      cell.note = `${i18n.excel.urlLabel()}: ${pageResults[i].url}`;
    }

    const statusStyle = (status) => {
      if (status === STATUS.C) return { bg: COLORS.conformBg, fg: COLORS.conformFg, icon: '✓' };
      if (status === STATUS.NC) return { bg: COLORS.notConformBg, fg: COLORS.notConformFg, icon: '✗' };
      if (status === STATUS.NA) return { bg: COLORS.naBg, fg: COLORS.naFg, icon: '–' };
      if (status === STATUS.ERR) return { bg: COLORS.errBg, fg: COLORS.errFg, icon: '!' };
      if (status === STATUS.REVIEW) return { bg: COLORS.reviewBg, fg: COLORS.reviewFg, icon: '' };
      if (status === STATUS.AI) return { bg: COLORS.aiBg, fg: COLORS.aiFg, icon: '?' };
      return { bg: 'FFFFFFFF', fg: 'FF0F172A', icon: '' };
    };

    const applyStatusCellStyle = (cell, status, { centered = true } = {}) => {
      const s = statusStyle(status);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.bg } };
      cell.font = { size: BASE_FONT_SIZE, bold: true, color: { argb: s.fg } };
      cell.alignment = centered
        ? { vertical: 'middle', horizontal: 'center' }
        : { vertical: 'top', horizontal: 'left', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: COLORS.grid } },
        left: { style: 'thin', color: { argb: COLORS.grid } },
        bottom: { style: 'thin', color: { argb: COLORS.grid } },
        right: { style: 'thin', color: { argb: COLORS.grid } }
      };
      return s;
    };

    const buildCellNote = (res) => {
      if (!res) return '';

      const collapse = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const status = i18n.statusLabel(res.status);
      const aiConfidence = Number(res.ai?.confidence || 0);
      const aiRationale = collapse(res.ai?.rationale || '');

      const summary =
        aiRationale && Number.isFinite(aiConfidence)
          ? `${i18n.notes.aiPrefix(aiConfidence)}: ${aiRationale}`
          : collapse(res.notes || '');

      const evidence = [];
      if (Array.isArray(res.ai?.evidence)) {
        for (const ex of res.ai.evidence) {
          const line = collapse(ex);
          if (line) evidence.push(line);
        }
      }

      const examples = [];
      if (Array.isArray(res.examples)) {
        for (const ex of res.examples) {
          const line = collapse(ex);
          if (line) examples.push(line);
        }
      }

      const lines = [];
      lines.push(`${status}${summary ? `: ${summary}` : ''}`);
      if (evidence.length > 0) {
        lines.push(i18n.notes.evidenceLabel());
        for (const ex of evidence) {
          lines.push(`- ${ex}`);
        }
      }
      if (examples.length > 0) {
        lines.push(i18n.notes.examplesLabel());
        for (const ex of examples.slice(0, 3)) {
          lines.push(`- ${ex}`);
        }
      }

      // Keep cell notes readable and avoid huge XLSX metadata.
      return lines.join('\n').slice(0, 800);
    };

    for (const criterion of criteria) {
      const uiRow = [criterion.id, criterion.theme, criterion.title];
      for (let pageIndex = 0; pageIndex < pageResults.length; pageIndex += 1) {
        uiRow.push(''); // filled after row is created (for styling + note)
      }
      const excelUiRow = uiSheet.addRow(uiRow);
      excelUiRow.font = { size: BASE_FONT_SIZE };

      // Left meta columns formatting
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
        uiCell.note = buildCellNote(res);
      }
    }

    const summaryTitleRow = summarySheet.addRow([i18n.excel.summaryTitle()]);
    summaryTitleRow.font = { size: 16, bold: true };
    summarySheet.getColumn(1).width = 28;
    summarySheet.getColumn(2).width = 18;
    summarySheet.addRow([i18n.excel.generatedAt(), new Date().toISOString()]);
    summarySheet.addRow([i18n.excel.pagesAudited(), options.pages.length]);
    summarySheet.addRow([i18n.excel.globalScore(), globalScore]);
    summarySheet.addRow([i18n.excel.pagesFailed(), pagesFailed]);
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
      valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.bg } };
      valueCell.font = { size: BASE_FONT_SIZE, bold: true, color: { argb: s.fg } };
    }

    // Legend (UI-friendly)
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

    // Ensure a readable base font size across the whole workbook.
    for (const sheet of [uiSheet, summarySheet]) {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cell.font = { ...(cell.font || {}), size: Math.max(BASE_FONT_SIZE, cell.font?.size || 0) };
        });
      });
    }

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await workbook.xlsx.writeFile(outPath);
    if (reporter && reporter.onDone) {
      reporter.onDone({ outPath, globalScore, counts: globalCounts, errors: errorSummary });
    }
  } else if (reporter && reporter.onDone) {
    reporter.onDone({ outPath: null, globalScore, counts: globalCounts, errors: errorSummary });
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
