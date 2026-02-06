import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import chalkAnimation from 'chalk-animation';
import gradientString from 'gradient-string';
import { MultiBar, Presets } from 'cli-progress';
import { getI18n, normalizeReportLang } from './i18n.js';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { attachIgnoreEpipe } from './streamErrors.js';
import { applyCodexBaseUrlFromConfig, maybeHandleMissingAuth } from './codexAuth.js';

const palette = {
  primary: chalk.hex('#22d3ee'),
  accent: chalk.hex('#a78bfa'),
  glow: chalk.hex('#f472b6'),
  warn: chalk.hex('#f59e0b'),
  error: chalk.hex('#ef4444'),
  review: chalk.hex('#dc2626'),
  muted: chalk.hex('#94a3b8'),
  ok: chalk.hex('#22c55e'),
  steel: chalk.hex('#0f172a')
};

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatTempScore({ C, NC } = {}) {
  const c = Number(C || 0);
  const nc = Number(NC || 0);
  const denom = c + nc;
  if (denom <= 0) return formatPercent(0);
  return formatPercent(c / denom);
}

function bumpTempCounts(counts, statusLabel) {
  const label = String(statusLabel || '').trim();
  if (!label) return;
  if (label === 'Conform' || label === 'C') {
    counts.C += 1;
  } else if (label === 'Not conform' || label === 'NC') {
    counts.NC += 1;
  } else if (label === 'Non applicable' || label === 'NA') {
    counts.NA += 1;
  }
}

function normalizeStatusLabel(statusLabel) {
  const label = String(statusLabel || '').trim();
  if (!label) return '';
  if (label === 'C' || label === 'Conform') return 'C';
  if (label === 'NC' || label === 'Not conform') return 'NC';
  if (label === 'NA' || label === 'Non applicable') return 'NA';
  if (label === 'Review') return 'REVIEW';
  if (label === 'Error') return 'ERR';
  return label;
}

function createTempScoreTracker(totalPages = 0) {
  const perCriterion = new Map();
  const globalStatus = new Map();
  const counts = { C: 0, NC: 0, NA: 0 };

  const applyStatus = (criterionId, nextStatus) => {
    const current = globalStatus.get(criterionId) || '';
    if (current === nextStatus) return false;
    if (current === 'C' || current === 'NC' || current === 'NA') {
      counts[current] = Math.max(0, counts[current] - 1);
    }
    if (nextStatus === 'C' || nextStatus === 'NC' || nextStatus === 'NA') {
      counts[nextStatus] += 1;
      globalStatus.set(criterionId, nextStatus);
    } else if (nextStatus) {
      globalStatus.set(criterionId, nextStatus);
    } else {
      globalStatus.delete(criterionId);
    }
    return true;
  };

  const onCriterion = (criterionId, statusLabel) => {
    if (!criterionId) return false;
    const status = normalizeStatusLabel(statusLabel);
    if (!status) return false;
    const entry =
      perCriterion.get(criterionId) || { seen: 0, hasC: false, hasNC: false, hasNA: false };
    if (status === 'C') entry.hasC = true;
    if (status === 'NC') entry.hasNC = true;
    if (status === 'NA') entry.hasNA = true;
    entry.seen += 1;
    perCriterion.set(criterionId, entry);
    if (entry.hasNC) return applyStatus(criterionId, 'NC');
    if (entry.hasC) return applyStatus(criterionId, 'C');
    if (entry.hasNA) return applyStatus(criterionId, 'NA');
    return applyStatus(criterionId, '');
  };

  const onGlobalDecision = (criterionId, statusLabel) => {
    if (!criterionId) return false;
    const status = normalizeStatusLabel(statusLabel);
    if (!status) return false;
    return applyStatus(criterionId, status);
  };

  return { counts, onCriterion, onGlobalDecision };
}

function formatSecondPassSummary(secondPass = {}) {
  const total = Number(secondPass.total || 0);
  const done = Number(secondPass.done || 0);
  const criteria = Array.isArray(secondPass.criteria) ? secondPass.criteria : [];
  const remaining = Math.max(0, total - done);
  const detail = criteria
    .map((c) => `${c.id}${c.status ? `:${c.status}` : ''}`)
    .join(', ');
  return { total, done, remaining, detail };
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLen(text) {
  return stripAnsi(text).length;
}

function padVisibleRight(text, width) {
  const str = String(text || '');
  const len = visibleLen(str);
  if (len >= width) return str;
  return str + ' '.repeat(width - len);
}

function formatKeyValueRows(rows, gap = 2) {
  const items = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!items.length) return '';
  const keyWidth = Math.max(...items.map((row) => visibleLen(row.key)));
  const spacer = ' '.repeat(Math.max(1, gap));
  return items
    .map(({ key, value }) => `${padVisibleRight(key, keyWidth)}${spacer}${value}`)
    .join('\n');
}

function joinBoxenColumns(left, right) {
  const leftLines = String(left || '').split('\n');
  const rightLines = String(right || '').split('\n');
  const maxLines = Math.max(leftLines.length, rightLines.length);
  const leftWidth = Math.max(...leftLines.map((line) => visibleLen(line)));
  const rightWidth = Math.max(...rightLines.map((line) => visibleLen(line)));
  const out = [];
  for (let i = 0; i < maxLines; i += 1) {
    const l = leftLines[i] || '';
    const r = rightLines[i] || '';
    out.push(`${padVisibleRight(l, leftWidth)}  ${padVisibleRight(r, rightWidth)}`);
  }
  return out.join('\n');
}

function normalizeInline(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clipInline(text, width) {
  const str = normalizeInline(text);
  if (width <= 0) return '';
  if (str.length <= width) return str;
  if (width === 1) return '…';
  return `${str.slice(0, width - 1)}…`;
}

function clipFixed(text, width) {
  const str = String(text || '');
  if (width <= 0) return '';
  if (str.length <= width) return str;
  if (width === 1) return '…';
  return `${str.slice(0, width - 1)}…`;
}

const AI_NOISE_PATTERNS = [
  /mcp snapshot/i,
  /mcp list_pages/i,
  /spawning codex/i,
  /autocomplete.*required.*describedby/i,
  /evaluate(?:d)? script response/i,
  /evaluate_script/i,
  /^"content"\s*:\s*\[/i,
  /confirming script evaluation success/i
];

function normalizeAiMessage(text) {
  return String(text || '')
    .replace(/^Codex:\s*/i, '')
    .replace(/^AI:\s*/i, '')
    .trim();
}

function normalizeReasoningValue(value) {
  const cleaned = String(value || '').trim().toLowerCase();
  if (!cleaned) return '';
  const allowed = new Set(['low', 'medium', 'high', 'auto', 'minimal', 'none']);
  return allowed.has(cleaned) ? cleaned : '';
}

function initialReasoningFromEnv() {
  return normalizeReasoningValue(
    process.env.AUDIT_CODEX_REASONING ||
      process.env.CODEX_REASONING ||
      process.env.OPENAI_REASONING ||
      process.env.OPENAI_REASONING_EFFORT ||
      ''
  );
}

function extractCodexReasoning(text) {
  const cleaned = normalizeAiMessage(text);
  const match = cleaned.match(
    /\breasoning(?:[_\s-]*(?:level|effort))?\b[^a-z0-9]{0,6}(low|medium|high|auto|minimal|none)\b/i
  );
  return match ? normalizeReasoningValue(match[1]) : '';
}

function isNoiseAiMessage(text) {
  const cleaned = normalizeAiMessage(text).toLowerCase();
  if (!cleaned) return false;
  if (/^[}\]]+,?$/.test(cleaned)) return true;
  if (/^[{}[\]]$/.test(cleaned)) return true;
  return AI_NOISE_PATTERNS.some((pattern) => pattern.test(cleaned));
}

function formatProgressStatus({
  totalPages,
  totalCriteria,
  overallDone,
  pageDone,
  currentPageIndex,
  i18n
}) {
  const overallTotal = totalPages * totalCriteria;
  const overallPct = overallTotal ? Math.round((overallDone / overallTotal) * 100) : 0;
  const pagePct = totalCriteria ? Math.round((pageDone / totalCriteria) * 100) : 0;
  const pageLabel = totalPages ? `${Math.max(0, currentPageIndex + 1)}/${totalPages}` : '-/-';
  const prefix = i18n?.t('Progression à l’arrêt', 'Progress at shutdown') || 'Progress at shutdown';
  const overallLabel = i18n?.t('Global', 'Overall') || 'Overall';
  const pageLabelText = i18n?.t('Page', 'Page') || 'Page';
  const overallCounts = `${overallDone}/${overallTotal || 0}`;
  const pageCounts = `${pageDone}/${totalCriteria || 0}`;
  return `${prefix}: ${overallLabel} ${overallPct}% (${overallCounts}) • ${pageLabelText} ${pageLabel} ${pagePct}% (${pageCounts})`;
}

function nowMs() {
  if (typeof process.hrtime === 'function' && process.hrtime.bigint) {
    return Number(process.hrtime.bigint() / 1000000n);
  }
  return Date.now();
}

let outputClosed = false;

function handleOutputError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_WRITE_AFTER_END') {
    outputClosed = true;
    return true;
  }
  return false;
}

function safeWrite(text) {
  if (outputClosed) return false;
  try {
    return process.stdout.write(text);
  } catch (err) {
    if (handleOutputError(err)) return false;
    throw err;
  }
}

function safeMoveCursor(dx, dy) {
  if (outputClosed || !process.stdout.isTTY) return;
  try {
    readline.moveCursor(process.stdout, dx, dy);
  } catch (err) {
    if (handleOutputError(err)) return;
    throw err;
  }
}

function safeCursorTo(x, y) {
  if (outputClosed || !process.stdout.isTTY) return;
  try {
    if (typeof y === 'number') {
      readline.cursorTo(process.stdout, x, y);
    } else {
      readline.cursorTo(process.stdout, x);
    }
  } catch (err) {
    if (handleOutputError(err)) return;
    throw err;
  }
}

function safeClearLine() {
  if (outputClosed || !process.stdout.isTTY) return;
  try {
    readline.clearLine(process.stdout, 0);
  } catch (err) {
    if (handleOutputError(err)) return;
    throw err;
  }
}

function safeClearScreenDown() {
  if (outputClosed || !process.stdout.isTTY) return;
  try {
    readline.clearScreenDown(process.stdout);
  } catch (err) {
    if (handleOutputError(err)) return;
    throw err;
  }
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  if (hh > 0) {
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function isFancyTTY() {
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
}

function renderBar({ value, total, width }) {
  const safeTotal = Math.max(1, Number(total || 0));
  const ratio = Math.max(0, Math.min(1, Number(value || 0) / safeTotal));
  const filled = Math.round(ratio * width);
  const full = '█'.repeat(Math.max(0, filled));
  const empty = '░'.repeat(Math.max(0, width - filled));
  return `${palette.accent(full)}${palette.muted(empty)}`;
}

export function chromeAutomationWarningLines({ i18n, mcpMode }) {
  if (String(mcpMode || '').trim().toLowerCase() !== 'chrome') return null;
  const isMac = process.platform === 'darwin';
  if (isMac) {
    return [
      `${palette.warn('⚠')} ${chalk.bold(
        i18n.t(
          'macOS peut vous demander plusieurs fois d’autoriser le contrôle à distance de Google Chrome.',
          'macOS may prompt you several times to allow remote control of Google Chrome.'
        )
      )}`,
      palette.muted(
        i18n.t(
          'Cliquez sur Autoriser/OK à chaque fois pour que l’audit continue.',
          'Click Allow/OK each time so the audit can continue.'
        )
      )
    ];
  }

  return [
    `${palette.warn('⚠')} ${chalk.bold(
      i18n.t(
        'Votre système peut demander d’autoriser le contrôle à distance de Chrome pendant l’audit.',
        'Your OS may ask you to allow remote control of Chrome during the audit.'
      )
    )}`
  ];
}

function sanitizeStatusLine(text) {
  return normalizeInline(String(text || ''))
    .replace(/[•◆◇■□▪▫]/g, ' ')
    .replace(/[┌┐└┘├┤┬┴┼│─━]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeCodexHomePermissionError(stderr) {
  const text = String(stderr || '');
  return (
    text.includes('Codex cannot access session files') ||
    text.includes('permission denied') ||
    text.includes('Operation not permitted') ||
    text.includes('Error finding codex home') ||
    text.includes('CODEX_HOME points to')
  );
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

function getFallbackCodexHome() {
  return path.join(os.tmpdir(), 'rgaa-auditor-codex-home');
}

async function ensureDir(dirPath) {
  if (!dirPath) return;
  await fs.mkdir(dirPath, { recursive: true });
}

function createCodexFeedHumanizer({
  enabled,
  model,
  lang,
  minIntervalMs = 450,
  throttleMsByKind = { progress: 1200, stage: 2000, thinking: 1500 },
  timeoutMs = 5000
} = {}) {
  if (!enabled) {
    return {
      request() {},
      stop() {}
    };
  }

  const codexPath = process.env.CODEX_PATH || 'codex';
  const useProcessGroup = process.platform !== 'win32';
  const pending = [];
  let running = null;
  let lastRunAt = 0;
  const lastByKind = new Map();
  const throttleTimers = new Map();
  const throttledLatest = new Map();

  const shouldRewriteKind = (kind) => kind === 'progress' || kind === 'stage' || kind === 'thinking';

  const summarizeOnce = async (text, { retry = false } = {}) => {
    const payload = String(text || '').trim();
    if (!payload) return '';

    const prompt =
      `You translate internal audit logs into short, plain-language status updates.\n` +
      `Language: ${lang === 'fr' ? 'French' : 'English'}.\n` +
      `Rules:\n` +
      `- Preserve meaning exactly; do not invent steps or progress.\n` +
      `- Keep concrete details from input (page numbers, durations, URLs, counts, criterion IDs).\n` +
      `- If input is already clear, keep it close to the original wording.\n` +
      `- Output 1–2 short sentences (max 140 characters total).\n` +
      `- No bullets, no box-drawing characters, no emojis.\n` +
      `- Avoid unexplained acronyms; if one appears, expand it briefly.\n` +
      `- If AI-related, say so plainly (e.g., "AI reviewing criteria").\n` +
      `Input: ${JSON.stringify(payload)}\n` +
      `Output:`;

    const buildArgs = (modelOverride = model) => {
      const args = [
        'exec',
        '--non-interactive',
        '--full-auto',
        '--color',
        'never',
        '--sandbox',
        'read-only'
      ];
      if (modelOverride) args.push('-m', modelOverride);
      args.push('-');
      return args;
    };

    const runWithEnv = async (env, modelOverride = model) =>
      new Promise((resolve, reject) => {
        const child = spawn(codexPath, buildArgs(modelOverride), {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: useProcessGroup,
          env
        });

        let stdoutText = '';
        let stderrText = '';
        let settled = false;
        let timeout = null;

        const finalize = (err, out) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          try {
            if (!child.killed) {
              if (useProcessGroup && child.pid) process.kill(-child.pid, 'SIGTERM');
              else child.kill('SIGTERM');
            }
          } catch {}
          if (err) {
            err.stderr = stderrText;
            reject(err);
          } else {
            resolve(out);
          }
        };

        timeout = setTimeout(() => {
          finalize(new Error(`codex exec timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof timeout.unref === 'function') timeout.unref();

        child.on('error', (err) => finalize(err));
        child.on('exit', (code) => {
          if (code === 0) finalize(null, stdoutText);
          else finalize(new Error(`codex exec exited with code ${code}`));
        });

        child.stdout?.on?.('data', (chunk) => {
          stdoutText += String(chunk);
          if (stdoutText.length > 32_000) stdoutText = stdoutText.slice(-32_000);
        });
        child.stderr?.on?.('data', (chunk) => {
          stderrText += String(chunk);
          if (stderrText.length > 64_000) stderrText = stderrText.slice(-64_000);
        });

        attachIgnoreEpipe(child.stdin);
        child.stdin.write(prompt);
        child.stdin.end();
      });

    // Ensure a user-provided CODEX_HOME exists; Codex exits early if it doesn't.
    if (process.env.CODEX_HOME) {
      await ensureDir(process.env.CODEX_HOME);
    }

    try {
      return await runWithEnv(buildCodexEnv(), model);
    } catch (err) {
      maybeHandleMissingAuth({ onLog: null, stderr: err?.stderr || err?.message });
      if (!process.env.CODEX_HOME && looksLikeCodexHomePermissionError(err?.stderr)) {
        const fallbackHome = getFallbackCodexHome();
        await ensureDir(fallbackHome);
        await ensureDir(path.join(fallbackHome, 'sessions'));
        await ensureDir(path.join(fallbackHome, 'npm-cache'));
        return await runWithEnv(buildCodexEnv({ codexHome: fallbackHome }), model);
      }
      if (!retry && err?.message && /timed out/i.test(err.message)) {
        return await summarizeOnce(text, { retry: true });
      }
      throw err;
    }
  };

  const drain = async () => {
    if (running) return;
    running = (async () => {
      while (pending.length) {
        const now = nowMs();
        const wait = Math.max(0, minIntervalMs - (now - lastRunAt));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const job = pending.shift();
        if (!job) continue;
        lastRunAt = nowMs();

        try {
          const out = await summarizeOnce(job.text);
          const cleaned = String(out || '')
            .replace(/```[\s\S]*?```/g, '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)[0];
          if (cleaned) job.onResult(cleaned);
        } catch {
          // Best-effort; keep existing line.
        }
      }
    })().finally(() => {
      running = null;
    });
  };

  return {
    request({ kind, text, onResult }) {
      const raw = String(text || '').trim();
      if (!raw) return;
      if (!shouldRewriteKind(kind)) return;
      const now = nowMs();
      const throttleMs = throttleMsByKind?.[kind] || 0;
      const lastAt = lastByKind.get(kind) || 0;
      const enqueue = (payload) => {
        pending.push(payload);
        while (pending.length > 3) pending.shift();
        lastByKind.set(kind, nowMs());
        drain();
      };
      if (!throttleMs || now - lastAt >= throttleMs) {
        enqueue({ kind, text: raw, onResult });
        return;
      }
      throttledLatest.set(kind, { kind, text: raw, onResult });
      if (throttleTimers.has(kind)) return;
      const waitMs = Math.max(0, throttleMs - (now - lastAt));
      const timer = setTimeout(() => {
        throttleTimers.delete(kind);
        const latest = throttledLatest.get(kind);
        if (latest) {
          throttledLatest.delete(kind);
          enqueue(latest);
        }
      }, waitMs);
      if (typeof timer.unref === 'function') timer.unref();
      throttleTimers.set(kind, timer);
    },
    stop() {
      pending.length = 0;
      throttledLatest.clear();
      for (const timer of throttleTimers.values()) clearTimeout(timer);
      throttleTimers.clear();
    }
  };
}

function drawPanel({ title, lines, width, borderColor = palette.muted }) {
  const w = Math.max(40, width);
  const inner = w - 2;
  const top = borderColor(`┌${'─'.repeat(inner)}┐`);
  const bottom = borderColor(`└${'─'.repeat(inner)}┘`);
  const out = [top];
  if (title) {
    const t = clipInline(title, inner - 2);
    const head = `${borderColor('│')} ${padVisibleRight(chalk.bold(t), inner - 2)} ${borderColor('│')}`;
    out.push(head);
    out.push(borderColor(`├${'─'.repeat(inner)}┤`));
  }
  for (const raw of lines) {
    const clipped = clipFixed(stripAnsi(raw), inner);
    // Re-apply color by allowing pre-colored lines; if raw contains ansi, keep it but prevent wrap.
    const line = raw && visibleLen(raw) <= inner ? raw : clipped;
    out.push(`${borderColor('│')}${padVisibleRight(line, inner)}${borderColor('│')}`);
  }
  out.push(bottom);
  return out.join('\n');
}

export function renderPromptFrame({ title, lines, borderColor = 'accent', width } = {}) {
  const cols = process.stdout?.columns || 100;
  const panelWidth = width || Math.max(68, Math.min(cols - 2, 120));
  const colorFn =
    typeof borderColor === 'function'
      ? borderColor
      : palette[borderColor] || palette.accent;
  return drawPanel({ title, lines, width: panelWidth, borderColor: colorFn });
}

function createLiveBlockRenderer() {
  let lastLineCount = 0;
  let lastLines = null;
  let cursorHidden = false;

  const hideCursor = () => {
    if (!cursorHidden && process.stdout.isTTY) {
      safeWrite('\x1b[?25l');
      cursorHidden = true;
    }
  };
  const showCursor = () => {
    if (cursorHidden && process.stdout.isTTY) {
      safeWrite('\x1b[?25h');
      cursorHidden = false;
    }
  };

  const clearPrevious = () => {
    if (!process.stdout.isTTY) return;
    if (lastLineCount > 0) safeMoveCursor(0, -lastLineCount);
    safeClearScreenDown();
  };

  return {
    render(block) {
      if (!process.stdout.isTTY) {
        safeWrite(`${stripAnsi(block)}\n`);
        return;
      }
      const lines = String(block).split('\n');
      const renderFull = () => {
        hideCursor();
        clearPrevious();
        safeWrite(`${block}\n`);
        lastLineCount = lines.length;
        lastLines = lines;
      };
      if (!lastLines || lastLines.length === 0) {
        renderFull();
        return;
      }
      if (lines.length !== lastLineCount) {
        renderFull();
        return;
      }
      const changed = [];
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i] !== lastLines[i]) changed.push(i);
      }
      if (!changed.length) return;
      hideCursor();
      safeMoveCursor(0, -lastLineCount);
      safeCursorTo(0);
      let cursorLine = 0;
      for (const idx of changed) {
        const delta = idx - cursorLine;
        if (delta) safeMoveCursor(0, delta);
        safeCursorTo(0);
        safeClearLine();
        safeWrite(lines[idx]);
        cursorLine = idx;
      }
      safeMoveCursor(0, -cursorLine);
      safeMoveCursor(0, lastLineCount);
      safeCursorTo(0);
      lastLineCount = lines.length;
      lastLines = lines;
    },
    stop({ keepBlock = true } = {}) {
      if (!keepBlock) clearPrevious();
      showCursor();
      lastLineCount = 0;
      lastLines = null;
    }
  };
}

function createFancyReporter(options = {}) {
  const i18n = getI18n(normalizeReportLang(options.uiLang || options.lang));
  const isGuided = Boolean(options.guided);
  const spinner = ora({ text: i18n.t('Préparation de l’audit…', 'Preparing audit…'), color: 'cyan' });
  const renderer = createLiveBlockRenderer();
  const humanizeEnabled = Boolean(options.humanizeFeed);
  const verboseAiFeedRaw = String(process.env.AUDIT_AI_FEED_VERBOSE || '').trim().toLowerCase();
  const verboseAiFeed =
    verboseAiFeedRaw === ''
      ? true
      : verboseAiFeedRaw === '1' || verboseAiFeedRaw === 'true' || verboseAiFeedRaw === 'yes';
  const feedHumanizer = createCodexFeedHumanizer({
    enabled: humanizeEnabled,
    model: options.humanizeFeedModel || '',
    lang: i18n.lang || options.lang || 'fr'
  });
  let frame = 0;
  let ticking = false;
  let resizeHandler = null;
  let exitHandler = null;
  let animTimer = null;
  let clockTimer = null;
  let clockNow = nowMs();

  let totalCriteria = 0;
  let totalPages = 0;
  let overallDone = 0;
  let pageDone = 0;
  let tempTracker = null;
  let tempCounts = { C: 0, NC: 0, NA: 0 };
  let currentPageIndex = -1;
  let currentUrl = '';
  let stageStartAt = 0;
  let pageStartAt = 0;
  let auditStartAt = 0;
  let auditMode = 'mcp';
  let mcpMode = '';
  let codexReasoning = initialReasoningFromEnv();
  let helpVisible = false;
  let enrichmentEnabled = false;
  let enrichmentDone = 0;
  let enrichmentStatus = 'idle';
  let showEnrichmentSummary = false;
  let isPaused = false;
  let resumeOverallDone = 0;
  let resumeCompletedPages = 0;
  let lastAILog = '';
  let lastAILogAt = 0;
  const aiLogRepeatRaw = Number(process.env.AUDIT_AI_LOG_REPEAT_MS || '');
  const aiLogRepeatMs =
    Number.isFinite(aiLogRepeatRaw) && aiLogRepeatRaw > 0 ? Math.floor(aiLogRepeatRaw) : 8000;
  const uiTickRaw = Number(process.env.AUDIT_UI_TICK_MS || '');
  const uiTickMs =
    Number.isFinite(uiTickRaw) && uiTickRaw >= 60 ? Math.floor(uiTickRaw) : 750;
  const animTickRaw = Number(process.env.AUDIT_UI_ANIM_MS || '');
  const animTickMs =
    Number.isFinite(animTickRaw) && animTickRaw >= 40 ? Math.floor(animTickRaw) : 120;
  const clockTickRaw = Number(process.env.AUDIT_UI_CLOCK_MS || '');
  const clockTickMs =
    Number.isFinite(clockTickRaw) && clockTickRaw >= 250 ? Math.floor(clockTickRaw) : 1000;
  let showHelp = false;
  let currentCriterion = null;
  let secondPassActive = false;
  let secondPassTotal = 0;
  let secondPassDone = 0;
  let secondPassCurrent = null;
  let secondPassNotice = '';
  let secondPassStartedAt = 0;
  let lastDecision = null;
  const decisions = [];
  let enrichmentActive = false;
  let enrichmentLabel = '';
  let enrichmentStartedAt = 0;
  let aiActive = false;
  let aiLabel = '';
  let aiStartedAt = 0;

  const feedMax = 7;
  const feed = [];
  let feedSeq = 0;
  const humanizeKinds = new Set(['progress', 'stage', 'thinking']);
  const placeholderLine = i18n.t('Working…', 'Working…');
  const reasoningPlaceholder = i18n.t('detecting…', 'detecting…');
  const blendHex = (a, b, t) => {
    const clamp = (v) => Math.max(0, Math.min(255, v));
    const hexToRgb = (hex) => {
      const clean = hex.replace('#', '');
      const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
      const n = parseInt(full, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    };
    const rgbToHex = ({ r, g, b }) =>
      `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
    const c1 = hexToRgb(a);
    const c2 = hexToRgb(b);
    return rgbToHex({
      r: Math.round(c1.r + (c2.r - c1.r) * t),
      g: Math.round(c1.g + (c2.g - c1.g) * t),
      b: Math.round(c1.b + (c2.b - c1.b) * t)
    });
  };
  const pulseSteps = [0.0, 0.35, 0.7, 1.0, 0.7, 0.35];
  const pulseGlyphs = Array.from({ length: pulseSteps.length }, () => '●');
  const pulseColors = pulseSteps.map((t) =>
    chalk.hex(blendHex('#94a3b8', '#22d3ee', t))
  );
  const hasAnimatedParts = () => {
    if (isPaused) return false;
    if (feed.length > 0) return true;
    if (auditStartAt) return true;
    if (secondPassActive) return true;
    if (aiActive) return true;
    return false;
  };
  const pendingLabel = (kind, normalized) => {
    const cleaned = clipInline(String(normalized || '').trim(), 120);
    if (cleaned) return cleaned;
    if (kind === 'thinking') return i18n.t('Réflexion…', 'Thinking…');
    if (kind === 'stage') return i18n.t('Démarrage…', 'Starting…');
    return placeholderLine;
  };
  const pushFeed = (kind, message, { replaceLastIfSameKind = false } = {}) => {
    const raw = String(message || '');
    const normalized = sanitizeStatusLine(raw);
    const base = humanizeKinds.has(kind) ? pendingLabel(kind, normalized) : normalized;
    const cleaned = clipInline(base, 320);
    if (!cleaned) return;
    if (kind === 'progress') frame = (frame + 1) % pulseGlyphs.length;
    const shouldHumanize = humanizeKinds.has(kind);
    const initialMessage = shouldHumanize && humanizeEnabled ? pendingLabel(kind, normalized) : normalized;
    const initialStatus = shouldHumanize ? (humanizeEnabled ? 'pending' : 'failed') : 'n/a';
    if (replaceLastIfSameKind && feed.length && feed[feed.length - 1].kind === kind) {
      const id = feed[feed.length - 1].id || ++feedSeq;
      feed[feed.length - 1] = {
        id,
        at: nowMs(),
        kind,
        message: clipInline(initialMessage, 320),
        raw: normalized,
        humanizeStatus: initialStatus
      };
      feedHumanizer.request({
        kind,
        text: normalized,
        onResult: (rewritten) => {
          const idx = feed.findIndex((r) => r.id === id);
          if (idx < 0) return;
          const cleanedRewrite = String(rewritten || '').trim();
          feed[idx] = {
            ...feed[idx],
            message: clipInline(cleanedRewrite || normalized, 320),
            humanizeStatus: cleanedRewrite ? 'done' : 'failed'
          };
          scheduleRender();
        }
      });
      scheduleRender();
    } else {
      const id = ++feedSeq;
      feed.push({
        id,
        at: nowMs(),
        kind,
        message: clipInline(initialMessage, 320),
        raw: normalized,
        humanizeStatus: initialStatus
      });
      while (feed.length > feedMax) feed.shift();
      feedHumanizer.request({
        kind,
        text: normalized,
        onResult: (rewritten) => {
          const idx = feed.findIndex((r) => r.id === id);
          if (idx < 0) return;
          const cleanedRewrite = String(rewritten || '').trim();
          feed[idx] = {
            ...feed[idx],
            message: clipInline(cleanedRewrite || normalized, 320),
            humanizeStatus: cleanedRewrite ? 'done' : 'failed'
          };
          scheduleRender();
        }
      });
      scheduleRender();
    }
  };

  const startTicking = () => {
    if (ticking) return;
    ticking = true;
    resizeHandler = () => scheduleRender();
    exitHandler = () => renderer.stop({ keepBlock: true });
    process.on('exit', exitHandler);
    process.stdout?.on?.('resize', resizeHandler);
    animTimer = setInterval(() => {
      if (!process.stdout.isTTY) return;
      frame = (frame + 1) % pulseGlyphs.length;
      if (!hasAnimatedParts()) return;
      scheduleRender({ refreshTime: false });
    }, animTickMs);
    clockTimer = setInterval(() => {
      if (!process.stdout.isTTY) return;
      clockNow = nowMs();
      if (!hasAnimatedParts()) return;
      scheduleRender({ refreshTime: false });
    }, clockTickMs);
    if (typeof animTimer.unref === 'function') animTimer.unref();
    if (typeof clockTimer.unref === 'function') clockTimer.unref();
  };

  const stopTicking = () => {
    if (!ticking) return;
    ticking = false;
    if (resizeHandler) process.stdout?.off?.('resize', resizeHandler);
    if (exitHandler) process.off?.('exit', exitHandler);
    if (animTimer) clearInterval(animTimer);
    if (clockTimer) clearInterval(clockTimer);
    resizeHandler = null;
    exitHandler = null;
    animTimer = null;
    clockTimer = null;
    feedHumanizer.stop();
  };

  const startStage = (label) => {
    const original = sanitizeStatusLine(label);
    stageStartAt = nowMs();
    if (original) pushFeed('stage', original);
    scheduleRender();
  };
  const pushAiFeed = (raw, { replaceLastIfSameKind = false } = {}) => {
    const lines = String(raw || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return;
    if (!verboseAiFeed) {
      pushFeed('progress', lines[lines.length - 1], { replaceLastIfSameKind });
      return;
    }
    for (const line of lines) {
      pushFeed('progress', line, { replaceLastIfSameKind: false });
    }
  };

  const endStage = (label) => {
    const endAt = nowMs();
    const elapsed = stageStartAt ? endAt - stageStartAt : 0;
    stageStartAt = 0;
    pushFeed('timing', `${label || 'Stage'}: ${elapsed}ms`, { replaceLastIfSameKind: false });
    scheduleRender();
  };

  const kindColor = (kind) => {
    if (kind === 'error') return palette.error;
    if (kind === 'decision') return palette.ok;
    if (kind === 'thinking') return palette.accent;
    if (kind === 'progress') return palette.primary;
    if (kind === 'stage') return palette.muted;
    if (kind === 'timing') return palette.muted;
    if (kind === 'page') return palette.glow;
    return palette.muted;
  };

  let renderQueued = false;

  const render = () => {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 100;
    const width = Math.max(76, Math.min(cols - 1, 120));
    const barW = Math.max(12, Math.min(28, Math.floor((width - 24) / 2)));

    const overallTotal = totalPages * totalCriteria;
    const overallPct = overallTotal ? Math.round((overallDone / overallTotal) * 100) : 0;
    const pagePct = totalCriteria ? Math.round((pageDone / totalCriteria) * 100) : 0;
    const pageLabel = totalPages ? `${Math.max(0, currentPageIndex + 1)}/${totalPages}` : '-/-';

    const elapsed = auditStartAt ? formatElapsed(clockNow - auditStartAt) : '';

    const urlLine = currentUrl ? clipInline(currentUrl, width - 18) : '';
    const criterionLine = currentCriterion
      ? clipInline(`${currentCriterion.id} ${currentCriterion.title}`, width - 18)
      : '';
    const enrichmentAge =
      enrichmentActive && enrichmentStartedAt ? formatElapsed(nowMs() - enrichmentStartedAt) : '';

    const showAiPost = aiActive && !secondPassActive && pageDone >= totalCriteria && totalCriteria > 0;
    const aiElapsed = aiStartedAt ? formatElapsed(clockNow - aiStartedAt) : '';

    const progressRows = [];
    if (secondPassActive) {
      if (secondPassNotice) {
        progressRows.push({
          key: palette.muted('Note'),
          value: palette.glow(clipInline(secondPassNotice, width - 18))
        });
      }
      progressRows.push({
        key: palette.glow(i18n.t('Second pass', 'Second pass')),
        value:
          `${renderBar({ value: secondPassDone, total: secondPassTotal, width: barW })} ` +
          `${palette.muted(`${secondPassDone}/${secondPassTotal || 0}`)}` +
          `${secondPassCurrent ? ` ${palette.muted('•')} ${palette.accent(secondPassCurrent)}` : ''}`
      });
    }

    progressRows.push({
      key: palette.primary('Overall'),
      value:
        `${renderBar({ value: overallDone, total: overallTotal, width: barW })} ` +
        `${palette.muted(`${overallPct}% • ${overallDone}/${overallTotal || 0}`)}`
    });

    if (showAiPost) {
      progressRows.push({
        key: palette.accent('AI'),
        value: `${palette.primary(
          clipInline(aiLabel || i18n.t('Working…', 'Working…'), width - 24)
        )}${aiElapsed ? ` ${palette.muted('•')} ${palette.muted(aiElapsed)}` : ''}`
      });
    }

    if (showEnrichmentSummary && enrichmentEnabled) {
      progressRows.push({
        key: palette.glow('Enrich'),
        value:
          `${renderBar({ value: enrichmentDone, total: 1, width: barW })} ` +
          `${palette.muted(`${enrichmentDone}/1`)} ${palette.muted('•')} ` +
          `${
            enrichmentStatus === 'failed'
              ? palette.warn('failed')
              : enrichmentStatus === 'done'
                ? palette.ok('done')
                : palette.muted('pending')
          }`
      });
    } else {
      progressRows.push({
        key: palette.accent('Page'),
        value:
          `${renderBar({ value: pageDone, total: totalCriteria, width: barW })} ` +
          `${palette.muted(`${pagePct}% • ${pageDone}/${totalCriteria || 0}`)} ` +
          `${palette.muted('•')} ${palette.muted(i18n.t('Page', 'Page'))} ${palette.accent(pageLabel)}`
      });
    }

    const tempScoreLabel = i18n.t('Score temp (C/(C+NC))', 'Temp score (C/(C+NC))');
    progressRows.push({
      key: palette.muted(tempScoreLabel),
      value: chalk.bold(formatTempScore(tempCounts))
    });

    if (urlLine) {
      progressRows.push({ key: palette.muted('URL'), value: chalk.bold(urlLine) });
    }
    if (criterionLine) {
      progressRows.push({ key: palette.muted('Criterion'), value: palette.accent(criterionLine) });
    }

    progressRows.push({
      key: palette.muted('Keys'),
      value: palette.muted(showHelp ? 'p pause • r resume • h hide help' : 'p pause • r resume • h help')
    });

    if (showHelp) {
      progressRows.push({
        key: palette.muted('Help'),
        value: palette.muted('Pause cancels in-flight AI/MCP calls and retries on resume.')
      });
      progressRows.push({
        key: palette.muted('Help'),
        value: palette.muted('Set AUDIT_UI_ANIM_MS to adjust animation speed.')
      });
    }

    if (isPaused) {
      progressRows.push({ key: palette.warn('Status'), value: palette.warn('paused') });
    }

    if (elapsed) {
      progressRows.push({
        key: palette.muted(i18n.t('Durée', 'Elapsed')),
        value: `${palette.accent(elapsed)} ${(pulseColors[frame] || palette.muted)(
          pulseGlyphs[frame] || '·'
        )}`
      });
    }

    const progressLines = formatKeyValueRows(progressRows, 2).split('\n');

    const timeW = 5;
    const typeW = 11;
    const msgW = Math.max(18, width - 2 - (timeW + typeW + 6));
    const feedHeader =
      `${palette.muted(padVisibleRight('Age', timeW))} ` +
      `${palette.muted(padVisibleRight('Kind', typeW))} ` +
      `${palette.muted(padVisibleRight('Update', msgW))}`;

    const feedLines = [feedHeader, palette.muted('─'.repeat(Math.min(width - 2, visibleLen(feedHeader))))];
    const now = clockNow;
    const formatAge = (at) => {
      const s = Math.max(0, Math.round((now - at) / 1000));
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    };
    const kindIcon = (kind) => {
      if (kind === 'error') return '⛔';
      if (kind === 'decision') return '✓';
      if (kind === 'thinking') return '◆';
      if (kind === 'progress') return '●';
      if (kind === 'stage') return '◇';
      if (kind === 'timing') return '⏱';
      if (kind === 'page') return '▣';
      return '•';
    };
    const pulseColor = pulseColors[frame] || palette.primary;
    const visibleFeed = feed.slice(-feedMax);
    for (let i = 0; i < visibleFeed.length; i += 1) {
      const row = visibleFeed[i];
      const isNewest = i === visibleFeed.length - 1;
      const age = formatAge(row.at);
      const type = row.kind;
      const showRaw = row.humanizeStatus === 'failed' && humanizeKinds.has(row.kind);
      const raw = showRaw ? clipInline(String(row.raw || '').trim(), Math.floor(msgW / 2)) : '';
      const baseMsg = row.message || '';
      const msg = clipInline(raw ? `${baseMsg} • raw: ${raw}` : baseMsg, msgW);
      const kindLabel = `${kindIcon(type)} ${padVisibleRight(type, typeW - 2)}`;
      const msgColor = isNewest ? pulseColor : palette.primary;
      feedLines.push(
        `${palette.muted(padVisibleRight(age, timeW))} ` +
          `${kindColor(type)(padVisibleRight(kindLabel, typeW))} ` +
          `${msgColor(padVisibleRight(msg, msgW))}`
      );
    }

    const decisionLines = [];
    if (lastDecision) {
      const status = lastDecision.status;
      let statusColor = palette.muted;
      if (status === 'Conform') statusColor = palette.ok;
      if (status === 'Not conform') statusColor = palette.error;
      if (status === 'Non applicable') statusColor = palette.muted;
      if (status === 'Review') statusColor = palette.review;
      if (status === 'Review') statusColor = palette.review;
      if (status === 'Error') statusColor = palette.error;
      decisionLines.push(
        `${padVisibleRight(palette.muted('Status'), 8)} ${statusColor(chalk.bold(status))} ${palette.muted('•')} ${palette.accent(
          clipInline(lastDecision.crit, width - 26)
        )}`
      );
      if (lastDecision.rationale) {
        decisionLines.push(
          `${padVisibleRight(palette.muted('Reason'), 8)} ${palette.muted(
            clipInline(lastDecision.rationale, width - 12)
          )}`
        );
      }
    }

    const panels = [
      ...(secondPassActive
        ? [
            drawPanel({
              title: i18n.t('Second pass • AI boost', 'Second pass • AI boost'),
              lines: [
                palette.glow(
                  i18n.t(
                    'Revue IA ciblée pour réduire les critères “Review”.',
                    'Targeted AI review to reduce remaining “Review” criteria.'
                  )
                ),
                secondPassCurrent
                  ? `${palette.muted('Current')} ${palette.accent(secondPassCurrent)}`
                  : '',
                `${palette.muted('Progress')} ${palette.accent(
                  `${secondPassDone}/${secondPassTotal || 0}`
                )}`,
                secondPassStartedAt
                  ? `${palette.muted('Elapsed')} ${palette.accent(
                      formatElapsed(clockNow - secondPassStartedAt)
                    )}`
                  : ''
              ].filter(Boolean),
              width,
              borderColor: palette.glow
            })
          ]
        : []),
      drawPanel({
        title: i18n.t('Progress', 'Progress'),
        lines: progressLines,
        width,
        borderColor: palette.muted
      }),
      drawPanel({
        title: i18n.t('Live feed', 'Live feed'),
        lines: feedLines,
        width,
        borderColor: palette.accent
      }),
      ...(decisionLines.length
        ? [
            drawPanel({
              title: i18n.t('Last decision', 'Last decision'),
              lines: decisionLines,
              width,
              borderColor: palette.muted
            })
          ]
        : [])
    ];

    renderer.render(panels.join('\n'));
  };

  const scheduleRender = ({ refreshTime = true } = {}) => {
    if (!process.stdout.isTTY) return;
    if (renderQueued) return;
    if (refreshTime) clockNow = nowMs();
    renderQueued = true;
    setImmediate(() => {
      renderQueued = false;
      render();
    });
  };

  return {
    async onStart({
      pages,
      criteriaCount,
      mcpMode: mcpModeFromCli,
      auditMode: mode,
      enrichmentEnabled: enrichmentEnabledFromCli,
      resumePath,
      outDirName
    }) {
      totalPages = pages;
      totalCriteria = criteriaCount;
      tempTracker = createTempScoreTracker(totalPages);
      tempCounts = tempTracker.counts;
      auditMode = mode || 'mcp';
      mcpMode = mcpModeFromCli || '';
      enrichmentEnabled = Boolean(enrichmentEnabledFromCli);
      auditStartAt = nowMs();
      const headline = 'RGAA Website Auditor';
      const criteriaLabel = i18n.t(`${criteriaCount} critères`, `${criteriaCount} criteria`);
      const subtitle = i18n.t(
        `Audit piloté par MCP • ${criteriaLabel} • Pages FR`,
        `MCP-driven audit • ${criteriaLabel} • French pages`
      );
      const credit = 'Aurélien Lewin <aurelienlewin@proton.me>';

      const glowLine = gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(
        '━'.repeat(42)
      );
      const cols = process.stdout.columns || 100;
      const totalWidth = Math.max(76, Math.min(cols - 2, 120));
      const half = Math.max(32, Math.floor((totalWidth - 2) / 2));
      const title = boxen(
        `${gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(headline)}\n` +
          `${palette.muted(subtitle)}\n` +
          `${palette.muted(credit)}\n` +
          `${glowLine}`,
        { padding: 1, borderStyle: 'double', borderColor: 'magenta', width: half }
      );
      const tempScoreLabel = i18n.t('Score temp (C/(C+NC))', 'Temp score (C/(C+NC))');
      const sessionRows = formatKeyValueRows([
        {
          key: palette.muted('Session'),
          value: outDirName ? palette.accent(outDirName) : palette.muted('—')
        },
        { key: palette.muted(i18n.t('Pages', 'Pages')), value: chalk.bold(String(pages)) },
        {
          key: palette.muted(i18n.t('Critères', 'Criteria')),
          value: chalk.bold(String(criteriaCount))
        },
        { key: palette.muted(tempScoreLabel), value: chalk.bold(formatTempScore(tempCounts)) }
      ]);
      const session = boxen(
        sessionRows,
        { padding: 1, borderStyle: 'round', borderColor: 'cyan', width: half }
      );
      console.log(joinBoxenColumns(title, session));
      spinner.start();
      spinner.text = i18n.t('Démarrage de Chrome (MCP)…', 'Starting MCP Chrome…');
    },

    onChromeReady() {
      spinner.text = i18n.t(
        'Chrome MCP prêt. Audit des pages…',
        'MCP Chrome ready. Auditing pages…'
      );
      spinner.stop();
      startTicking();
      pushFeed('progress', i18n.t('Chrome ready. Starting pages…', 'Chrome ready. Starting pages…'));
      scheduleRender();
    },

    onChromeRecovered() {
      pushFeed('stage', i18n.t('Chrome récupéré.', 'Recovered Chrome.'));
      scheduleRender();
    },

    onResumeState({ completedPages = 0, completedCriteria = 0 } = {}) {
      resumeCompletedPages = completedPages;
      resumeOverallDone = completedCriteria;
      overallDone = completedCriteria;
      currentPageIndex = completedPages - 1;
      scheduleRender();
    },

    onPause({ paused } = {}) {
      isPaused = Boolean(paused);
      if (isPaused) {
        stopTicking();
      } else {
        startTicking();
      }
      pushFeed('stage', isPaused ? 'Paused' : 'Resumed', { replaceLastIfSameKind: false });
      scheduleRender();
    },

    onPageStart({ index, url }) {
      currentPageIndex = index;
      currentUrl = url;
      pageDone = 0;
      enrichmentDone = 0;
      enrichmentStatus = 'idle';
      showEnrichmentSummary = false;
      pageStartAt = nowMs();
      stageStartAt = 0;
      enrichmentActive = false;
      enrichmentLabel = '';
      enrichmentStartedAt = 0;
      pushFeed('page', `Page ${index + 1}/${totalPages}: ${url}`);
      scheduleRender();
    },

    onPageNavigateStart() {
      startStage('Page load');
    },

    onPageNetworkIdle({ durationMs, timedOut }) {
      endStage('Page load');
      const label = timedOut ? 'Network idle (timed out)' : 'Network idle';
      pushFeed('timing', `${label}: ${durationMs}ms`);
    },

    onSnapshotStart() {
      startStage('Snapshot');
    },

    onSnapshotEnd({ durationMs }) {
      endStage('Snapshot');
      pushFeed('timing', `Snapshot collected in ${durationMs}ms`);
    },

    onEnrichmentStart() {
      const pageLabel = totalPages
        ? `Page ${Math.max(0, currentPageIndex + 1)}/${totalPages}`
        : '';
      enrichmentActive = true;
      enrichmentLabel = pageLabel ? `Enrichment • ${pageLabel}` : 'Enrichment';
      enrichmentStartedAt = nowMs();
      enrichmentStatus = 'running';
      scheduleRender();
    },

    onEnrichmentEnd({ ok } = {}) {
      if (enrichmentEnabled && enrichmentDone === 0) {
        enrichmentDone = 1;
      }
      enrichmentActive = false;
      enrichmentStatus = ok === false ? 'failed' : 'done';
      enrichmentLabel = ok === false ? 'Enrichment failed' : '';
      scheduleRender();
    },

    onEnrichmentReady({ criteriaCount = 0, criteriaSample = [] } = {}) {
      if (!enrichmentEnabled) return;
      const sample = Array.isArray(criteriaSample) && criteriaSample.length
        ? ` • ${criteriaSample.join(', ')}`
        : '';
      pushFeed('stage', `Enrichment ready • affects ${criteriaCount} criteria${sample}`);
      scheduleRender();
    },

    onInferenceStart({ criteriaCount = 0, criteriaSample = [] } = {}) {
      const sample = Array.isArray(criteriaSample) && criteriaSample.length
        ? ` • ${criteriaSample.join(', ')}`
        : '';
      startStage('Inference');
      pushFeed('stage', `Inference running • ${criteriaCount} criteria${sample}`);
      scheduleRender();
    },

    onInferenceSummary({ counts } = {}) {
      if (!counts) return;
      pushFeed(
        'progress',
        `Inference summary • OK ${counts.OK || 0} • NC ${counts.NC || 0} • NA ${counts.NA || 0} • Review ${counts.REV || 0} • Error ${counts.ERR || 0}`
      );
      scheduleRender();
    },

    onInferenceEnd() {
      if (!codexReasoning) codexReasoning = 'n/a';
      endStage('Inference');
    },

    onPageError({ url, error }) {
      const message = String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').trim();
      const clipped = message.length > 220 ? `${message.slice(0, 217)}…` : message;
      pushFeed('error', `Page failed: ${clipped}`);
      scheduleRender();
    },

    onChecksStart() {
      startStage('Running checks');
      enrichmentActive = false;
      enrichmentLabel = '';
      enrichmentStartedAt = 0;
    },

    onChecksEnd() {
      endStage('Checks');
      showEnrichmentSummary = enrichmentEnabled;
      aiActive = false;
      aiLabel = '';
      aiStartedAt = 0;
      scheduleRender();
    },

    onAIStart({ criterion }) {
      const isBatch = typeof criterion?.id === 'string' && /^AI\\(\\d+\\)$/.test(criterion.id);
      const critText = isBatch
        ? `${criterion.title}`.slice(0, 60)
        : `${criterion.id} ${criterion.title}`.slice(0, 60);
      currentCriterion = { id: criterion.id, title: criterion.title };
      aiActive = true;
      aiLabel = critText || i18n.t('Working…', 'Working…');
      if (!aiStartedAt) aiStartedAt = nowMs();
      startStage(`AI thinking ${critText}`);
      if (!isBatch) {
        pushFeed('thinking', `${criterion.id} ${criterion.title}`.slice(0, 140));
      }
    },

    onAIStage({ label, criterion }) {
      if (!label || isNoiseAiMessage(label)) return;
      startStage(label);
      pushFeed('stage', label, { replaceLastIfSameKind: false });
      aiActive = true;
      const cleaned = sanitizeStatusLine(label);
      if (cleaned) aiLabel = cleaned;
      if (!aiStartedAt) aiStartedAt = nowMs();
      if (criterion?.id === 'enrich') {
        enrichmentActive = true;
        enrichmentLabel = sanitizeStatusLine(label) || 'Enrichment';
        if (!enrichmentStartedAt) enrichmentStartedAt = nowMs();
      }
      scheduleRender();
    },

    onAILog({ message, criterion }) {
      const cleaned = normalizeAiMessage(message).replace(/\s+/g, ' ').trim();
      if (!cleaned || isNoiseAiMessage(cleaned)) return;
      const clipped = clipInline(cleaned, 64);
      if (clipped) {
        const now = nowMs();
        const shouldRepeat = clipped === lastAILog && now - lastAILogAt >= aiLogRepeatMs;
        let updated = false;
        const normalizedReason = sanitizeStatusLine(cleaned);
        if (criterion?.id === 'enrich') {
          enrichmentActive = true;
          enrichmentLabel = normalizedReason || enrichmentLabel || 'Enrichment';
          if (!enrichmentStartedAt) enrichmentStartedAt = nowMs();
          updated = true;
        }
        if (clipped !== lastAILog || shouldRepeat) {
          lastAILog = clipped;
          lastAILogAt = now;
          pushAiFeed(cleaned, { replaceLastIfSameKind: true });
          updated = true;
        }
        if (updated) scheduleRender();
      }
    },

    onCriterion({ criterion, evaluation }) {
      const statusLabel = evaluation.status || '';
      const critText = `${criterion.id} ${criterion.title}`.slice(0, 120);
      const rationale = evaluation.ai?.rationale || '';
      if (tempTracker) tempTracker.onCriterion(criterion.id, statusLabel);
      overallDone += 1;
      pageDone += 1;
      lastDecision = { status: statusLabel, crit: critText, rationale };
      decisions.push({
        status: statusLabel,
        crit: critText,
        rationale
      });
      pushFeed('decision', `${criterion.id} ${statusLabel}${rationale ? ` • ${rationale}` : ''}`);
      scheduleRender();
    },

    onCrossPageDecision({ criterion, evaluation }) {
      const statusLabel = evaluation?.status || '';
      const critText = `${criterion.id} ${criterion.title}`.slice(0, 120);
      const rationale = evaluation?.ai?.rationale || '';
      if (tempTracker) tempTracker.onGlobalDecision(criterion.id, statusLabel);
      lastDecision = { status: statusLabel, crit: critText, rationale };
      decisions.push({
        status: statusLabel,
        crit: critText,
        rationale
      });
      pushFeed('decision', `${criterion.id} ${statusLabel}${rationale ? ` • ${rationale}` : ''}`);
      scheduleRender();
    },

    onCrossPageStart({ total = 0, criteria = [] } = {}) {
      secondPassActive = true;
      secondPassTotal = Number.isFinite(total) && total > 0 ? total : criteria.length || 0;
      secondPassDone = 0;
      const first = Array.isArray(criteria) && criteria.length ? criteria[0] : null;
      secondPassCurrent = first ? `${first.id}` : null;
      secondPassStartedAt = nowMs();
      secondPassNotice = i18n.t(
        'Seconde passe IA : réduction des critères “Review” restants.',
        'Second-pass AI: reducing remaining “Review” criteria.'
      );
      enrichmentActive = false;
      enrichmentLabel = '';
      enrichmentStartedAt = 0;
      pushFeed('stage', i18n.t('Second-pass checks starting…', 'Second-pass checks starting…'));
      scheduleRender();
    },

    onCrossPageUpdate({ done, total, current } = {}) {
      if (Number.isFinite(total) && total > 0) secondPassTotal = total;
      if (Number.isFinite(done)) secondPassDone = done;
      if (current?.id) secondPassCurrent = `${current.id}`;
      scheduleRender();
    },

    onCrossPageEnd({ done, total } = {}) {
      if (Number.isFinite(total) && total > 0) secondPassTotal = total;
      if (Number.isFinite(done)) secondPassDone = done;
      secondPassActive = secondPassTotal > 0 && secondPassDone < secondPassTotal;
      if (!secondPassActive) secondPassCurrent = null;
      if (!secondPassActive) secondPassNotice = '';
      if (!secondPassActive) secondPassStartedAt = 0;
      pushFeed('stage', i18n.t('Second-pass checks complete.', 'Second-pass checks complete.'));
      scheduleRender();
    },

    onHelpToggle() {
      showHelp = !showHelp;
      scheduleRender();
    },

    onPageEnd({ index, url, counts }) {
      const totalElapsed = pageStartAt ? nowMs() - pageStartAt : 0;
      const score = counts.C + counts.NC === 0 ? 0 : counts.C / (counts.C + counts.NC);
      pushFeed(
        'page',
        `Page ${index + 1}/${totalPages} summary: C ${counts.C}, NC ${counts.NC}, NA ${counts.NA}, REV ${counts.REVIEW || 0}, Score ${formatPercent(
          score
        )}, Time ${totalElapsed}ms`
      );
      // Keep details in the live table to avoid fighting with cursor-based rendering.
      scheduleRender();
    },

    onDone({ outPath, globalScore, counts, errors, secondPass }) {
      stopTicking();
      renderer.stop({ keepBlock: false });
      if (process.stdout.isTTY) {
        safeWrite('\x1b[2J\x1b[0;0H');
      }

      const reviewRemaining = counts.REVIEW || 0;
      const second = formatSecondPassSummary(secondPass);
      const scoreLine =
        `${palette.accent('Score')} ${chalk.bold(formatPercent(globalScore))}` +
        ` ${palette.muted('•')} ${palette.muted('C')} ${palette.ok(String(counts.C))}` +
        ` ${palette.muted('NC')} ${palette.error(String(counts.NC))}` +
        ` ${palette.muted('NA')} ${palette.muted(String(counts.NA))}` +
        ` ${palette.muted('REV')} ${palette.review(String(counts.REVIEW || 0))}` +
        ` ${palette.muted('ERR')} ${palette.error(String(counts.ERR || 0))}`;
      const reviewLine = `${palette.review('Remaining review')} ${palette.accent(String(reviewRemaining))}`;
      const secondPassLine =
        second.total > 0
          ? `${palette.glow('Second pass')} ${palette.muted(`${second.done}/${second.total}`)}` +
            (second.detail ? ` ${palette.muted('•')} ${palette.accent(second.detail)}` : '')
          : `${palette.glow('Second pass')} ${palette.muted('—')}`;
      const summary = [scoreLine, reviewLine, secondPassLine].join('\n');

      if (isGuided) {
        const cols = process.stdout.columns || 100;
        const width = Math.max(76, Math.min(cols - 1, 120));
        const summaryPanel = drawPanel({
          title: i18n.t('Synthèse', 'Summary'),
          lines: summary.split('\n'),
          width,
          borderColor: counts.ERR ? palette.error : palette.ok
        });

        const decisionMax = 12;
        const totalDecisions = decisions.length;
        const decisionLines = [];
        const show = decisions.slice(-decisionMax);
        for (const item of show) {
          const status = i18n.statusLabel(item.status);
          let statusColor = palette.muted;
          if (item.status === 'Conform') statusColor = palette.ok;
          if (item.status === 'Not conform') statusColor = palette.error;
          if (item.status === 'Non applicable') statusColor = palette.muted;
          if (item.status === 'Review') statusColor = palette.review;
          if (item.status === 'Error') statusColor = palette.error;
          const details = item.rationale ? ` • ${item.rationale}` : '';
          decisionLines.push(`${statusColor(status)} ${item.crit}${details}`);
        }
        if (!decisionLines.length) {
          decisionLines.push(i18n.t('Aucune décision enregistrée.', 'No decisions recorded.'));
        }
        if (totalDecisions > decisionMax) {
          decisionLines.push(
            palette.muted(
              i18n.t(
                `Dernières ${decisionMax} décisions affichées sur ${totalDecisions}.`,
                `Showing last ${decisionMax} of ${totalDecisions} decisions.`
              )
            )
          );
        }

        const decisionsPanel = drawPanel({
          title: i18n.t('Décisions', 'Decisions'),
          lines: decisionLines,
          width,
          borderColor: palette.muted
        });

        console.log([summaryPanel, decisionsPanel].join('\n'));
      } else {
        console.log(
          boxen(summary, {
            padding: 1,
            borderStyle: 'double',
            borderColor: counts.ERR ? 'red' : 'green',
            title: 'Audit summary'
          })
        );
      }
      if (errors && (errors.pagesFailed || errors.aiFailed)) {
        const details = [
          errors.pagesFailed ? `Pages failed: ${errors.pagesFailed}` : null,
          errors.aiFailed ? `AI failures: ${errors.aiFailed}` : null
        ]
          .filter(Boolean)
          .join(' • ');
        if (details) {
          console.log(`${palette.error('Audit had errors')} ${palette.muted(details)}`);
        }
      }
      if (outPath) {
        console.log(`${palette.primary('Report saved to')} ${chalk.bold(outPath)}`);
      } else {
        console.log(`${palette.muted('Report export skipped (--no-xlsx).')}`);
      }
    },

    onShutdown() {
      stopTicking();
      if (spinner.isSpinning) spinner.stop();
      renderer.stop({ keepBlock: false });
      if (process.stdout.isTTY) {
        safeWrite('\x1b[2J\x1b[0;0H');
      }
      const line = formatProgressStatus({
        totalPages,
        totalCriteria,
        overallDone,
        pageDone,
        currentPageIndex,
        i18n
      });
      safeWrite(`${line}\n`);
    },

    onError(message) {
      if (spinner.isSpinning) spinner.fail(message);
      else {
        stopTicking();
        renderer.stop({ keepBlock: true });
        console.error(palette.error(message));
      }
    }
  };
}

function createLegacyReporter(options = {}) {
  const i18n = getI18n(normalizeReportLang(options.lang));
  const spinner = ora({ text: i18n.t('Préparation de l’audit…', 'Preparing audit…'), color: 'cyan' });
  const bars = new MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: `{label} ${palette.accent('{bar}')} {percentage}% ${palette.muted('•')} {value}/{total} {crit}`,
      barCompleteChar: '█',
      barIncompleteChar: '░'
    },
    Presets.shades_classic
  );

  let overallBar = null;
  let pageBar = null;
  let secondPassBar = null;
  let aiPostBar = null;
  let totalCriteria = 0;
  let totalPages = 0;
  let overallDone = 0;
  let pageDone = 0;
  let tempTracker = null;
  let tempCounts = { C: 0, NC: 0, NA: 0 };
  let lastAILog = '';
  let lastAILogAt = 0;
  let codexReasoning = initialReasoningFromEnv();
  let enrichmentEnabled = false;
  let enrichmentDone = 0;
  const aiLogRepeatRaw = Number(process.env.AUDIT_AI_LOG_REPEAT_MS || '');
  const aiLogRepeatMs =
    Number.isFinite(aiLogRepeatRaw) && aiLogRepeatRaw > 0 ? Math.floor(aiLogRepeatRaw) : 8000;
  const verboseAiFeedRaw = String(process.env.AUDIT_AI_FEED_VERBOSE || '').trim().toLowerCase();
  const verboseAiFeed =
    verboseAiFeedRaw === ''
      ? true
      : verboseAiFeedRaw === '1' || verboseAiFeedRaw === 'true' || verboseAiFeedRaw === 'yes';
  let pulseTimer = null;
  let pulseLabel = '';
  let pulseDots = 0;
  let pausedPulseLabel = '';
  let pageStartAt = 0;
  let stageStartAt = 0;
  let auditMode = 'mcp';
  let secondPassTotal = 0;
  let secondPassDone = 0;
  let enrichmentStatus = 'idle';
  let isPaused = false;
  let resumeOverallDone = 0;
  let aiPostActive = false;

  const stopPulse = () => {
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = null;
    pulseDots = 0;
  };

  const pulseOnce = () => {
    if (!pageBar || !pulseLabel) return;
    pulseDots = (pulseDots + 1) % 4;
    const dots = '.'.repeat(pulseDots);
    pageBar.update(null, { crit: `${palette.muted(pulseLabel + dots)}` });
  };

  const startPulse = (label) => {
    stopPulse();
    pulseLabel = label;
    pulseDots = 0;
    pulseOnce();
  };

  const startStage = (label) => {
    stageStartAt = nowMs();
    startPulse(label);
  };

  const endStage = (label) => {
    const endAt = nowMs();
    const elapsed = stageStartAt ? endAt - stageStartAt : 0;
    stopPulse();
    if (pageBar) pageBar.update(null, { crit: palette.muted(`${label} done in ${elapsed}ms`) });
    const line = `${palette.muted('•')} ${palette.muted(label)} ${palette.accent(`${elapsed}ms`)}`;
    if (typeof bars.log === 'function') bars.log(line);
    else console.log(line);
  };

  const logAILine = (label, message) => {
    const text = `${palette.accent('Codex')} ${label}${message ? ` ${message}` : ''}`;
    if (typeof bars.log === 'function') bars.log(text);
    else console.log(text);
  };
  const logAiFeed = (raw, label) => {
    const lines = String(raw || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) return;
    if (!verboseAiFeed) {
      logAILine(label, lines[lines.length - 1]);
      return;
    }
    for (const line of lines) logAILine(label, line);
  };

  return {
    async onStart({
      pages,
      criteriaCount,
      mcpMode,
      auditMode: mode,
      enrichmentEnabled: enrichmentEnabledFromCli,
      resumePath,
      outDirName
    }) {
      totalPages = pages;
      totalCriteria = criteriaCount;
      tempTracker = createTempScoreTracker(totalPages);
      tempCounts = tempTracker.counts;
      auditMode = mode || 'mcp';
      enrichmentEnabled = Boolean(enrichmentEnabledFromCli);
      const headline = 'RGAA Website Auditor';
      const criteriaLabel = i18n.t(`${criteriaCount} critères`, `${criteriaCount} criteria`);
      const subtitle = i18n.t(
        `Audit piloté par MCP • ${criteriaLabel} • Pages FR`,
        `MCP-driven audit • ${criteriaLabel} • French pages`
      );
      const credit = 'Aurélien Lewin <aurelienlewin@proton.me>';

      const glowLine = gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(
        '━'.repeat(42)
      );
      const cols = process.stdout.columns || 100;
      const totalWidth = Math.max(76, Math.min(cols - 2, 120));
      const half = Math.max(32, Math.floor((totalWidth - 2) / 2));
      const title = boxen(
        `${gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(headline)}\n` +
          `${palette.muted(subtitle)}\n` +
          `${palette.muted(credit)}\n` +
          `${glowLine}`,
        { padding: 1, borderStyle: 'double', borderColor: 'magenta', width: half }
      );
      const tempScoreLabel = i18n.t('Score temp (C/(C+NC))', 'Temp score (C/(C+NC))');
      const sessionRows = formatKeyValueRows([
        {
          key: palette.muted('Session'),
          value: outDirName ? palette.accent(outDirName) : palette.muted('—')
        },
        { key: palette.muted(i18n.t('Pages', 'Pages')), value: chalk.bold(String(pages)) },
        {
          key: palette.muted(i18n.t('Critères', 'Criteria')),
          value: chalk.bold(String(criteriaCount))
        },
        { key: palette.muted(tempScoreLabel), value: chalk.bold(formatTempScore(tempCounts)) }
      ]);
      const session = boxen(
        sessionRows,
        { padding: 1, borderStyle: 'round', borderColor: 'cyan', width: half }
      );
      console.log(joinBoxenColumns(title, session));
      spinner.start();
      spinner.text = i18n.t('Démarrage de Chrome (MCP)…', 'Starting MCP Chrome…');
    },

    onChromeReady() {
      spinner.text = i18n.t(
        'Chrome MCP prêt. Audit des pages…',
        'MCP Chrome ready. Auditing pages…'
      );
      spinner.stop();
      overallBar = bars.create(totalPages * totalCriteria, 0, {
        label: palette.primary(i18n.t('Global', 'Overall')),
        crit: ''
      });
      pageBar = bars.create(totalCriteria || 1, 0, {
        label: palette.accent(i18n.t('Page', 'Page')),
        crit: ''
      });
      if (resumeOverallDone > 0 && overallBar) {
        overallBar.update(resumeOverallDone, { crit: '' });
      }
    },

    onChromeRecovered() {
      const line = `${palette.warn('●')} ${palette.accent(i18n.t('Recovered Chrome', 'Recovered Chrome'))}`;
      if (typeof bars.log === 'function') bars.log(line);
      else console.log(line);
    },

    onResumeState({ completedCriteria = 0 } = {}) {
      resumeOverallDone = completedCriteria;
      overallDone = completedCriteria;
    },

    onPageStart({ index, url }) {
      currentPageIndex = index;
      if (pageBar) {
        pageBar.setTotal(totalCriteria || 1);
        pageBar.update(0, { label: palette.accent(i18n.t('Page', 'Page')), crit: '' });
      }
      pageDone = 0;
      enrichmentDone = 0;
      enrichmentStatus = 'idle';
      pageStartAt = nowMs();
      stageStartAt = pageStartAt;
      const pageLabel = `${index + 1}/${totalPages}`;
      console.log(
        `${palette.glow('◆')} ${palette.primary('Page')} ${palette.accent(pageLabel)} ${chalk.bold(
          url
        )}`
      );
    },

    onPageNavigateStart() {
      startStage('Page load');
    },

    onPageNetworkIdle({ durationMs, timedOut }) {
      endStage('Page load');
      const label = timedOut ? 'Network idle (timed out)' : 'Network idle';
      if (pageBar) {
        pageBar.update(null, { crit: palette.muted(`${label}: ${durationMs}ms`) });
      }
    },

    onSnapshotStart() {
      startStage('Snapshot');
    },

    onSnapshotEnd({ durationMs }) {
      endStage('Snapshot');
      if (pageBar) {
        pageBar.update(null, { crit: palette.muted(`Snapshot collected in ${durationMs}ms`) });
      }
    },

    onEnrichmentStart() {
      const pageLabel = totalPages
        ? `Page ${Math.max(0, currentPageIndex + 1)}/${totalPages}`
        : '';
      const label = pageLabel ? `Enrichment • ${pageLabel}` : 'Enrichment';
      enrichmentStatus = 'running';
      pulseOnce();
    },

    onEnrichmentEnd({ ok } = {}) {
      if (enrichmentDone === 0) {
        enrichmentDone = 1;
      }
      enrichmentStatus = ok === false ? 'failed' : 'done';
    },

    onEnrichmentReady({ criteriaCount = 0, criteriaSample = [] } = {}) {
      const sample = Array.isArray(criteriaSample) && criteriaSample.length
        ? ` • ${criteriaSample.join(', ')}`
        : '';
      const lineText = `${palette.muted('Enrichment ready')} ${palette.accent(
        `${criteriaCount} criteria${sample}`
      )}`;
      if (typeof bars.log === 'function') bars.log(lineText);
      else console.log(lineText);
    },

    onInferenceStart({ criteriaCount = 0, criteriaSample = [] } = {}) {
      const sample = Array.isArray(criteriaSample) && criteriaSample.length
        ? ` • ${criteriaSample.join(', ')}`
        : '';
      startStage('Inference');
      const lineText = `${palette.muted('Inference running')} ${palette.accent(
        `${criteriaCount} criteria${sample}`
      )}`;
      if (typeof bars.log === 'function') bars.log(lineText);
      else console.log(lineText);
    },

    onInferenceSummary({ counts } = {}) {
      if (!counts) return;
      const lineText = `${palette.muted('Inference summary')} ${palette.accent(
        `OK ${counts.OK || 0} • NC ${counts.NC || 0} • NA ${counts.NA || 0} • Review ${counts.REV || 0} • Error ${counts.ERR || 0}`
      )}`;
      if (typeof bars.log === 'function') bars.log(lineText);
      else console.log(lineText);
    },

    onInferenceEnd() {
      if (!codexReasoning) codexReasoning = 'n/a';
      endStage('Inference');
    },

    onPageError({ url, error }) {
      stopPulse();
      const message = String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').trim();
      const clipped = message.length > 220 ? `${message.slice(0, 217)}…` : message;
      if (pageBar) {
        pageBar.update(null, { crit: palette.error(`Error: ${clipped}`) });
      }
      const line = `${palette.error('✖')} ${palette.error('Page failed')} ${palette.muted(
        url
      )} ${palette.muted('•')} ${palette.error(clipped)}`;
      if (typeof bars.log === 'function') bars.log(line);
      else console.error(line);
    },

    onChecksStart() {
      startStage('Running checks');
    },

    onChecksEnd() {
      endStage('Checks');
      if (enrichmentEnabled) {
        const critLabel =
          enrichmentStatus === 'failed'
            ? palette.warn('failed')
            : enrichmentStatus === 'done'
              ? palette.ok('done')
              : palette.muted('pending');
        if (pageBar) {
          pageBar.setTotal(1);
          pageBar.update(enrichmentDone, {
            label: palette.glow(i18n.t('Enrich', 'Enrich')),
            crit: critLabel
          });
        }
      }
      if (aiPostActive && aiPostBar) {
        aiPostBar.update(1, { crit: '' });
      }
      aiPostActive = false;
    },

    onPause({ paused } = {}) {
      isPaused = Boolean(paused);
      if (isPaused) {
        pausedPulseLabel = pulseLabel;
        stopPulse();
      } else if (pausedPulseLabel) {
        startPulse(pausedPulseLabel);
        pausedPulseLabel = '';
      }
      const lineText = isPaused
        ? `${palette.warn('Paused')} ${palette.muted('(press r to resume)')}`
        : `${palette.ok('Resumed')}`;
      if (typeof bars.log === 'function') bars.log(lineText);
      else console.log(lineText);
    },

    onAIStart({ criterion }) {
      if (!pageBar) return;
      const isBatch = typeof criterion?.id === 'string' && /^AI\\(\\d+\\)$/.test(criterion.id);
      const critText = isBatch
        ? `${criterion.title}`.slice(0, 60)
        : `${criterion.id} ${criterion.title}`.slice(0, 60);
      startStage(`AI thinking ${critText}`);
      pageBar.update(null, { crit: `${palette.accent('AI thinking')} ${critText}` });
      if (!isBatch) {
        logAILine('thinking', `${criterion.id} ${criterion.title}`.slice(0, 80));
      }
      if (pageDone >= totalCriteria && totalCriteria > 0 && !secondPassBar) {
        aiPostActive = true;
        if (!aiPostBar) {
          aiPostBar = bars.create(1, 0, {
            label: palette.glow(i18n.t('AI post', 'AI post')),
            crit: palette.muted(critText || i18n.t('Working…', 'Working…'))
          });
        } else {
          aiPostBar.setTotal(1);
          aiPostBar.update(0, {
            label: palette.glow(i18n.t('AI post', 'AI post')),
            crit: palette.muted(critText || i18n.t('Working…', 'Working…'))
          });
        }
      }
    },

    onAIStage({ label }) {
      if (!label || isNoiseAiMessage(label)) return;
      startStage(label);
      if (pageBar) pageBar.update(null, { crit: palette.muted(label) });
      pulseOnce();
      const line = `${palette.muted('•')} ${palette.muted(label)}`;
      if (typeof bars.log === 'function') bars.log(line);
      else console.log(line);
      if (aiPostActive && aiPostBar) {
        aiPostBar.update(0, { crit: palette.muted(label) });
      }
    },

    onAILog({ message }) {
      if (!pageBar) return;
      const cleaned = normalizeAiMessage(message).replace(/\s+/g, ' ').trim();
      if (!cleaned || isNoiseAiMessage(cleaned)) return;
      const clipped = clipInline(cleaned, 64);
      if (clipped) {
        const now = nowMs();
        const shouldRepeat = clipped === lastAILog && now - lastAILogAt >= aiLogRepeatMs;
        stopPulse();
        pageBar.update(null, { crit: `${palette.accent('AI')} ${clipped}` });
        pulseOnce();
        if (clipped !== lastAILog || shouldRepeat) {
          lastAILog = clipped;
          lastAILogAt = now;
          logAiFeed(cleaned, 'progress');
        }
        if (aiPostActive && aiPostBar) {
          aiPostBar.update(0, { crit: palette.muted(clipped) });
        }
      }
    },

    onCriterion({ criterion, evaluation }) {
      const statusLabel = evaluation.status || '';
      let statusColor = palette.muted;
      if (statusLabel === 'Conform') statusColor = palette.ok;
      if (statusLabel === 'Not conform') statusColor = palette.error;
      if (statusLabel === 'Non applicable') statusColor = palette.muted;
      if (statusLabel === 'Review') statusColor = palette.review;
      if (statusLabel === 'Error') statusColor = palette.error;
      if (tempTracker) tempTracker.onCriterion(criterion.id, statusLabel);

      const critText = `${criterion.id} ${criterion.title}`.slice(0, 56);
      const rationale = evaluation.ai?.rationale || '';
      const snippet = rationale ? ` • ${rationale.slice(0, 48)}…` : '';
      overallDone += 1;
      pageDone += 1;
      if (overallBar) overallBar.increment(1, { crit: '' });
      if (pageBar) pageBar.increment(1, { crit: `${statusColor(statusLabel)} ${critText}${snippet}` });

      if (evaluation.ai?.rationale) {
        const line = `${palette.accent('AI')} ${criterion.id} ${statusColor(statusLabel)} ${rationale}`;
        if (typeof bars.log === 'function') bars.log(line);
        else console.log(line);
      }
    },

    onCrossPageDecision({ criterion, evaluation }) {
      const statusLabel = evaluation?.status || '';
      let statusColor = palette.muted;
      if (statusLabel === 'Conform') statusColor = palette.ok;
      if (statusLabel === 'Not conform') statusColor = palette.error;
      if (statusLabel === 'Non applicable') statusColor = palette.muted;
      if (statusLabel === 'Review') statusColor = palette.review;
      if (statusLabel === 'Error') statusColor = palette.error;
      if (tempTracker) tempTracker.onGlobalDecision(criterion.id, statusLabel);
      const rationale = evaluation?.ai?.rationale || '';
      const line = `${palette.accent('AI second pass')} ${criterion.id} ${statusColor(statusLabel)} ${rationale}`;
      if (typeof bars.log === 'function') bars.log(line);
      else console.log(line);
    },

    onCrossPageStart({ total = 0, criteria = [] } = {}) {
      secondPassTotal = Number.isFinite(total) && total > 0 ? total : criteria.length || 0;
      secondPassDone = 0;
      if (!secondPassBar) {
        secondPassBar = bars.create(secondPassTotal || 1, 0, {
          label: palette.glow(i18n.t('Second pass', 'Second pass')),
          crit: ''
        });
      } else {
        secondPassBar.setTotal(secondPassTotal || 1);
        secondPassBar.update(0, { crit: '' });
      }
    },

    onCrossPageUpdate({ done, total, current } = {}) {
      if (!secondPassBar) return;
      if (Number.isFinite(total) && total > 0) {
        secondPassTotal = total;
        secondPassBar.setTotal(total);
      }
      if (Number.isFinite(done)) {
        secondPassDone = done;
        secondPassBar.update(done, {
          crit: current?.id ? palette.accent(String(current.id)) : ''
        });
      }
    },

    onCrossPageEnd({ done, total } = {}) {
      if (!secondPassBar) return;
      if (Number.isFinite(total) && total > 0) secondPassBar.setTotal(total);
      if (Number.isFinite(done)) secondPassBar.update(done, { crit: '' });
    },

    onPageEnd({ index, url, counts }) {
      stopPulse();
      const totalElapsed = pageStartAt ? nowMs() - pageStartAt : 0;
      const score = counts.C + counts.NC === 0 ? 0 : counts.C / (counts.C + counts.NC);
      const header = `${palette.muted('Page summary')} ${palette.muted(`#${index + 1}`)}`;
      const line1 =
        `${palette.ok(`C ${counts.C}`)}  ` +
        `${palette.error(`NC ${counts.NC}`)}  ` +
        `${palette.muted(`NA ${counts.NA}`)}  ` +
        `${counts.REVIEW ? palette.review(`REV ${counts.REVIEW}`) + '  ' : ''}` +
        `${counts.ERR ? palette.error(`ERR ${counts.ERR}`) + '  ' : ''}` +
        `${palette.accent(`Score ${formatPercent(score)}`)}  ` +
        `${palette.muted(`Time ${totalElapsed}ms`)}`;
      const line2 = `${palette.muted('URL')} ${chalk.bold(url)}`;
      console.log(
        boxen(`${header}\n${line1}\n${line2}`, {
          padding: 1,
          borderStyle: 'round',
          borderColor: 'magenta'
        })
      );
    },

    onDone({ outPath, globalScore, counts, errors, secondPass }) {
      stopPulse();
      if (overallBar) overallBar.update(totalPages * totalCriteria);
      if (pageBar) pageBar.update(totalCriteria);
      bars.stop();

      const reviewRemaining = counts.REVIEW || 0;
      const second = formatSecondPassSummary(secondPass);
      const scoreLine =
        `${palette.accent('Score')} ${chalk.bold(formatPercent(globalScore))}` +
        ` ${palette.muted('•')} ${palette.muted('C')} ${palette.ok(String(counts.C))}` +
        ` ${palette.muted('NC')} ${palette.error(String(counts.NC))}` +
        ` ${palette.muted('NA')} ${palette.muted(String(counts.NA))}` +
        ` ${palette.muted('REV')} ${palette.review(String(counts.REVIEW || 0))}` +
        ` ${palette.muted('ERR')} ${palette.error(String(counts.ERR || 0))}`;

      const secondPassLine =
        second.total > 0
          ? `${palette.glow('Second pass')} ${palette.muted(`${second.done}/${second.total}`)}` +
            (second.detail ? ` ${palette.muted('•')} ${palette.accent(second.detail)}` : '')
          : `${palette.glow('Second pass')} ${palette.muted('—')}`;

      const reviewLine = `${palette.review('Remaining review')} ${palette.accent(String(reviewRemaining))}`;

      const summary = [scoreLine, reviewLine, secondPassLine].join('\n');
      const title = `${gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(
        i18n.t('Synthèse', 'Summary')
      )}`;
      console.log(
        boxen(summary, {
          padding: 1,
          borderStyle: 'double',
          borderColor: counts.ERR ? 'red' : 'green',
          title
        })
      );
      if (errors && (errors.pagesFailed || errors.aiFailed)) {
        const details = [
          errors.pagesFailed ? `Pages failed: ${errors.pagesFailed}` : null,
          errors.aiFailed ? `AI failures: ${errors.aiFailed}` : null
        ]
          .filter(Boolean)
          .join(' • ');
        if (details) {
          console.log(`${palette.error('Audit had errors')} ${palette.muted(details)}`);
        }
      }
      if (outPath) {
        console.log(`${palette.primary('Report saved to')} ${chalk.bold(outPath)}`);
      } else {
        console.log(`${palette.muted('Report export skipped (--no-xlsx).')}`);
      }
    },

    onShutdown() {
      stopPulse();
      if (spinner.isSpinning) spinner.stop();
      if (overallBar) overallBar.update(totalPages * totalCriteria);
      if (pageBar) pageBar.update(totalCriteria);
      bars.stop();
      if (process.stdout.isTTY) {
        safeWrite('\x1b[2J\x1b[0;0H');
      }
      const line = formatProgressStatus({
        totalPages,
        totalCriteria,
        overallDone,
        pageDone,
        currentPageIndex,
        i18n
      });
      safeWrite(`${line}\n`);
    },

    onError(message) {
      stopPulse();
      if (spinner.isSpinning) spinner.fail(message);
      else console.error(palette.error(message));
    }
  };
}

function createPlainReporter(options = {}) {
  const i18n = getI18n(normalizeReportLang(options.uiLang || options.lang));
  const feedHumanizer = createCodexFeedHumanizer({
    enabled: Boolean(options.humanizeFeed),
    model: options.humanizeFeedModel || '',
    lang: i18n.lang || options.lang || 'fr'
  });
  let totalCriteria = 0;
  let totalPages = 0;
  let overallDone = 0;
  let pageDone = 0;
  let tempTracker = null;
  let tempCounts = { C: 0, NC: 0, NA: 0 };
  let currentPageIndex = -1;
  let lastAILog = '';
  let lastAILogAt = 0;
  const aiLogRepeatRaw = Number(process.env.AUDIT_AI_LOG_REPEAT_MS || '');
  const aiLogRepeatMs =
    Number.isFinite(aiLogRepeatRaw) && aiLogRepeatRaw > 0 ? Math.floor(aiLogRepeatRaw) : 8000;
  const verboseAiFeedRaw = String(process.env.AUDIT_AI_FEED_VERBOSE || '').trim().toLowerCase();
  const verboseAiFeed =
    verboseAiFeedRaw === ''
      ? true
      : verboseAiFeedRaw === '1' || verboseAiFeedRaw === 'true' || verboseAiFeedRaw === 'yes';
  let pageStartAt = 0;
  let auditStartAt = 0;
  let auditMode = 'mcp';
  let mcpMode = '';

  let codexReasoning = initialReasoningFromEnv();
  let helpVisible = false;

  const line = (label, value = '') =>
    console.log(`${palette.muted(label)}${value ? ` ${value}` : ''}`);
  const logAiFeed = (raw) => {
    const lines = String(raw || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) return;
    if (!verboseAiFeed) {
      line('Codex', lines[lines.length - 1]);
      return;
    }
    for (const l of lines) line('Codex', l);
  };

  return {
    async onStart({ pages, criteriaCount, mcpMode: mcpModeFromCli, auditMode: mode, resumePath }) {
      totalPages = pages;
      totalCriteria = criteriaCount;
      tempTracker = createTempScoreTracker(totalPages);
      tempCounts = tempTracker.counts;
      auditMode = mode || 'mcp';
      mcpMode = mcpModeFromCli || '';
      auditStartAt = nowMs();
      line(i18n.t('Pages:', 'Pages:'), String(pages));
      line(i18n.t('Criteria:', 'Criteria:'), String(criteriaCount));
      line('Temp score (C/(C+NC)):', formatTempScore(tempCounts));
      line('Keys:', 'p pause • r resume • h help');
      if (resumePath) line('Resume file:', resumePath);
      line('MCP mode:', mcpModeFromCli || '(default)');
      line('Snapshot mode:', auditMode);
      line(i18n.t('Launching Chrome…', 'Launching Chrome…'));
    },

    onChromeReady() {
      line(i18n.t('Chrome ready. Auditing pages…', 'Chrome ready. Auditing pages…'));
    },

    onChromeRecovered() {
      line('Chrome:', i18n.t('Recovered', 'Recovered'));
    },

    onResumeState({ completedPages = 0, completedCriteria = 0 } = {}) {
      if (completedPages > 0 || completedCriteria > 0) {
        line(
          i18n.t('Resuming:', 'Resuming:'),
          `${completedPages} pages • ${completedCriteria} criteria`
        );
      }
    },

    onPageStart({ index, url }) {
      currentPageIndex = index;
      pageDone = 0;
      pageStartAt = nowMs();
      line(i18n.t('Page', 'Page'), `${index + 1}/${totalPages} ${url}`);
    },

    onPageNavigateStart() {
      line(i18n.t('Stage:', 'Stage:'), 'Page load');
    },

    onPageNetworkIdle({ durationMs, timedOut }) {
      const label = timedOut ? 'Network idle (timed out)' : 'Network idle';
      line(i18n.t('Stage:', 'Stage:'), `${label} ${durationMs}ms`);
    },

    onSnapshotStart() {
      line(i18n.t('Stage:', 'Stage:'), 'Snapshot');
    },

    onSnapshotEnd({ durationMs }) {
      line(i18n.t('Stage:', 'Stage:'), `Snapshot collected ${durationMs}ms`);
    },

    onEnrichmentStart() {
      const pageLabel = totalPages
        ? `Page ${Math.max(0, currentPageIndex + 1)}/${totalPages}`
        : '';
      const label = pageLabel ? `Enrichment • ${pageLabel}` : 'Enrichment';
      line(i18n.t('Stage:', 'Stage:'), label);
    },

    onEnrichmentEnd({ ok } = {}) {
      line(i18n.t('Stage:', 'Stage:'), ok === false ? 'Enrichment failed' : 'Enrichment done');
    },

    onEnrichmentReady({ criteriaCount = 0, criteriaSample = [] } = {}) {
      const sample = Array.isArray(criteriaSample) && criteriaSample.length
        ? ` • ${criteriaSample.join(', ')}`
        : '';
      line(
        i18n.t('Stage:', 'Stage:'),
        `Enrichment ready • affects ${criteriaCount} criteria${sample}`
      );
    },

    onInferenceStart({ criteriaCount = 0, criteriaSample = [] } = {}) {
      const sample = Array.isArray(criteriaSample) && criteriaSample.length
        ? ` • ${criteriaSample.join(', ')}`
        : '';
      line(
        i18n.t('Stage:', 'Stage:'),
        `Inference running • ${criteriaCount} criteria${sample}`
      );
    },

    onInferenceSummary({ counts } = {}) {
      if (!counts) return;
      line(
        i18n.t('Stage:', 'Stage:'),
        `Inference summary • OK ${counts.OK || 0} • NC ${counts.NC || 0} • NA ${counts.NA || 0} • Review ${counts.REV || 0} • Error ${counts.ERR || 0}`
      );
    },

    onInferenceEnd() {
      if (!codexReasoning) codexReasoning = 'n/a';
    },

    onPause({ paused } = {}) {
      line(i18n.t('Stage:', 'Stage:'), paused ? 'Paused (press r to resume)' : 'Resumed');
    },

    onChecksStart() {
      line(i18n.t('Stage:', 'Stage:'), 'Running checks');
    },

    onChecksEnd() {
      line(i18n.t('Stage:', 'Stage:'), 'Checks done');
      if (aiPostActive) {
        line('AI post:', 'done');
      }
      aiPostActive = false;
    },

    onAIStart({ criterion }) {
      const isBatch = typeof criterion?.id === 'string' && /^AI\\(\\d+\\)$/.test(criterion.id);
      const label = isBatch ? criterion.title : `${criterion.id} ${criterion.title}`;
      line('Codex', `thinking ${label}`);
      if (pageDone >= totalCriteria && totalCriteria > 0) {
        aiPostActive = true;
        line('AI post:', label);
      }
    },

    onAIStage({ label }) {
      if (label && !isNoiseAiMessage(label)) {
        const normalized = sanitizeStatusLine(label);
        line('Codex', normalized);
        if (aiPostActive) line('AI post:', normalized);
        feedHumanizer.request({
          kind: 'stage',
          text: normalized,
          onResult: (rewritten) => line('Codex', rewritten)
        });
      }
    },

    onAILog({ message }) {
      const cleaned = normalizeAiMessage(message).replace(/\s+/g, ' ').trim();
      if (!cleaned || isNoiseAiMessage(cleaned)) return;
      const clipped = clipInline(sanitizeStatusLine(cleaned), 120);
      const now = nowMs();
      const shouldRepeat = clipped === lastAILog && now - lastAILogAt >= aiLogRepeatMs;
      if (clipped !== lastAILog || shouldRepeat) {
        lastAILog = clipped;
        lastAILogAt = now;
        if (verboseAiFeed) {
          logAiFeed(message);
        } else {
          line('Codex', i18n.t('Working…', 'Working…'));
          feedHumanizer.request({
            kind: 'progress',
            text: sanitizeStatusLine(cleaned),
            onResult: (rewritten) => line('Codex', rewritten)
          });
        }
      }
    },

    onCriterion({ criterion, evaluation }) {
      const status = evaluation.status || '';
      const rationale = evaluation.ai?.rationale ? ` • ${evaluation.ai.rationale}` : '';
      if (tempTracker) tempTracker.onCriterion(criterion.id, status);
      overallDone += 1;
      pageDone += 1;
      line(i18n.t('Result:', 'Result:'), `${criterion.id} ${status}${rationale}`);
      if (
        status === 'Conform' ||
        status === 'Not conform' ||
        status === 'Non applicable' ||
        status === 'C' ||
        status === 'NC' ||
        status === 'NA'
      ) {
        line('Temp score (C/(C+NC)):', formatTempScore(tempCounts));
      }
    },

    onCrossPageDecision({ criterion, evaluation }) {
      const status = evaluation?.status || '';
      const rationale = evaluation?.ai?.rationale ? ` • ${evaluation.ai.rationale}` : '';
      if (tempTracker) tempTracker.onGlobalDecision(criterion.id, status);
      line(i18n.t('Second-pass result:', 'Second-pass result:'), `${criterion.id} ${status}${rationale}`);
      if (
        status === 'Conform' ||
        status === 'Not conform' ||
        status === 'Non applicable' ||
        status === 'C' ||
        status === 'NC' ||
        status === 'NA'
      ) {
        line('Temp score (C/(C+NC)):', formatTempScore(tempCounts));
      }
    },

    onCrossPageStart({ total = 0, criteria = [] } = {}) {
      secondPassTotal = Number.isFinite(total) && total > 0 ? total : criteria.length || 0;
      secondPassDone = 0;
      const label = i18n.t('Second-pass checks start', 'Second-pass checks start');
      const note = i18n.t(
        'IA utilisée pour réduire les critères “Review” restants.',
        'AI used to reduce remaining “Review” criteria.'
      );
      line(label, secondPassTotal ? `${secondPassDone}/${secondPassTotal}` : '');
      line('Note:', note);
    },

    onCrossPageUpdate({ done, total, current } = {}) {
      if (Number.isFinite(total) && total > 0) secondPassTotal = total;
      if (Number.isFinite(done)) secondPassDone = done;
      const label = i18n.t('Second-pass progress', 'Second-pass progress');
      const currentLabel = current?.id ? ` • ${current.id}` : '';
      line(label, `${secondPassDone}/${secondPassTotal || 0}${currentLabel}`);
    },

    onCrossPageEnd({ done, total } = {}) {
      if (Number.isFinite(total) && total > 0) secondPassTotal = total;
      if (Number.isFinite(done)) secondPassDone = done;
      line(i18n.t('Second-pass checks done', 'Second-pass checks done'), `${secondPassDone}/${secondPassTotal || 0}`);
    },

    onHelpToggle() {
      helpVisible = !helpVisible;
      if (!helpVisible) return;
      line('Help:', 'Press h to hide help.');
      line('Pause:', 'Cancels in-flight AI/MCP calls and retries on resume.');
      line('UI anim:', 'Set AUDIT_UI_ANIM_MS to adjust animation speed.');
    },

    onPageEnd({ index, url, counts }) {
      const totalElapsed = pageStartAt ? nowMs() - pageStartAt : 0;
      const score = counts.C + counts.NC === 0 ? 0 : counts.C / (counts.C + counts.NC);
      line(
        i18n.t('Page summary:', 'Page summary:'),
        `${index + 1}/${totalPages} C ${counts.C} NC ${counts.NC} NA ${counts.NA} REV ${counts.REVIEW || 0} Score ${formatPercent(
          score
        )} Time ${totalElapsed}ms • ${url}`
      );
    },

    onDone({ outPath, globalScore, counts, errors, secondPass }) {
      line(i18n.t('Audit summary:', 'Audit summary:'), '');
      const reviewRemaining = counts.REVIEW || 0;
      const second = formatSecondPassSummary(secondPass);
      line('Score:', formatPercent(globalScore));
      line('Conform:', String(counts.C));
      line('Not conform:', String(counts.NC));
      line('Non applicable:', String(counts.NA));
      line('Review:', String(reviewRemaining));
      line('Errors:', String(counts.ERR || 0));
      if (second.total > 0) {
        line('Second pass:', `${second.done}/${second.total}${second.detail ? ` • ${second.detail}` : ''}`);
      }
      const elapsed = auditStartAt ? formatElapsed(nowMs() - auditStartAt) : '';
      if (elapsed) line(i18n.t('Elapsed:', 'Elapsed:'), elapsed);
      if (errors && (errors.pagesFailed || errors.aiFailed)) {
        const details = [
          errors.pagesFailed ? `Pages failed: ${errors.pagesFailed}` : null,
          errors.aiFailed ? `AI failures: ${errors.aiFailed}` : null
        ]
          .filter(Boolean)
          .join(' • ');
        if (details) line(i18n.t('Warnings:', 'Warnings:'), details);
      }
      if (outPath) line(i18n.t('Report saved to:', 'Report saved to:'), outPath);
      else line(i18n.t('Report export skipped.', 'Report export skipped.'));
    },

    onShutdown() {
      if (process.stdout.isTTY) {
        safeWrite('\x1b[2J\x1b[0;0H');
      }
      const lineText = formatProgressStatus({
        totalPages,
        totalCriteria,
        overallDone,
        pageDone,
        currentPageIndex,
        i18n
      });
      console.log(lineText);
    },

    onError(message) {
      console.error(palette.error(String(message || 'Unknown error')));
    }
  };
}

export function createReporter(options = {}) {
  if (!isFancyTTY()) return createPlainReporter(options);
  return createFancyReporter(options);
}
