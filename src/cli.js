#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import chalk from 'chalk';
import boxen from 'boxen';
import gradientString from 'gradient-string';
import chalkAnimation from 'chalk-animation';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAudit } from './audit.js';
import { loadCriteria } from './criteria.js';
import { createReporter } from './ui.js';
import { terminateCodexChildren } from './ai.js';
import { createAbortError, isAbortError } from './abort.js';
import { listMcpPages } from './mcpSnapshot.js';

let lastShutdownSignal = null;
const fancyPromptState = { introShown: false };
let outputErrorHandlerInstalled = false;

const promptPalette = {
  primary: chalk.hex('#22d3ee'),
  accent: chalk.hex('#a78bfa'),
  glow: chalk.hex('#f472b6'),
  warn: chalk.hex('#f59e0b'),
  ok: chalk.hex('#22c55e'),
  muted: chalk.hex('#94a3b8')
};

function isFancyTTY() {
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
}

function installOutputErrorHandlers() {
  if (outputErrorHandlerInstalled) return;
  outputErrorHandlerInstalled = true;
  const handle = (err) => {
    if (!err) return;
    if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_WRITE_AFTER_END') return;
    throw err;
  };
  process.stdout.on('error', handle);
  process.stderr.on('error', handle);
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLen(text) {
  return stripAnsi(text).length;
}

function padVisible(text, width) {
  const str = String(text || '');
  const len = visibleLen(str);
  if (len >= width) return str;
  return str + ' '.repeat(width - len);
}

async function showFancyIntro() {
  if (!isFancyTTY() || fancyPromptState.introShown) return;
  fancyPromptState.introShown = true;
  const title = 'RGAA Guided Setup';
  const animation = chalkAnimation.neon(title);
  await new Promise((resolve) => setTimeout(resolve, 520));
  animation.stop();
  console.log(gradientString(['#22d3ee', '#a78bfa', '#f472b6'])(title));
}

function renderPromptBox(title, lines, { borderColor = 'cyan' } = {}) {
  const content = lines.join('\n');
  return boxen(content, {
    padding: 1,
    margin: { top: 1, bottom: 0, left: 0, right: 0 },
    borderStyle: 'round',
    borderColor,
    title: title ? chalk.bold(title) : undefined,
    titleAlignment: 'left'
  });
}

function formatRunId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function createDebugLogger({ logPath }) {
  if (!logPath) return null;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {}
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  let closed = false;
  stream.on('error', () => {
    closed = true;
  });
  const log = (event, details = '') => {
    if (closed || !stream.writable) return;
    const line = `${new Date().toISOString()} ${event}${details ? ` ${details}` : ''}\n`;
    try {
      stream.write(line);
    } catch {
      closed = true;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      stream.end();
    } catch {}
  };
  return { log, close, logPath };
}

function wrapReporterWithDebug({ reporter, logger }) {
  if (!logger) return { reporter, stop: () => {} };
  const safe = (val, max = 400) => {
    const text = String(val || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const stop = () => logger.close();
  const wrapped = {
    ...reporter,
    onStart(payload) {
      logger.log('start', JSON.stringify(payload || {}));
      reporter.onStart?.(payload);
    },
    onChromeReady(payload) {
      logger.log('chrome-ready');
      reporter.onChromeReady?.(payload);
    },
    onPageStart(payload) {
      logger.log('page-start', safe(payload?.url));
      reporter.onPageStart?.(payload);
    },
    onPageNavigateStart(payload) {
      logger.log('page-load');
      reporter.onPageNavigateStart?.(payload);
    },
    onPageNetworkIdle(payload) {
      logger.log(
        'page-idle',
        `${payload?.durationMs || 0}ms${payload?.timedOut ? ' timed-out' : ''}`
      );
      reporter.onPageNetworkIdle?.(payload);
    },
    onSnapshotStart(payload) {
      logger.log('snapshot-start');
      reporter.onSnapshotStart?.(payload);
    },
    onEnrichmentStart(payload) {
      logger.log('enrich-start');
      reporter.onEnrichmentStart?.(payload);
    },
    onEnrichmentEnd(payload) {
      logger.log('enrich-end', payload?.ok === false ? 'error' : 'ok');
      reporter.onEnrichmentEnd?.(payload);
    },
    onSnapshotEnd(payload) {
      logger.log('snapshot-end', `${payload?.durationMs || 0}ms`);
      reporter.onSnapshotEnd?.(payload);
    },
    onChecksStart(payload) {
      logger.log('checks-start');
      reporter.onChecksStart?.(payload);
    },
    onChecksEnd(payload) {
      logger.log('checks-end');
      reporter.onChecksEnd?.(payload);
    },
    onAIStart(payload) {
      const crit = payload?.criterion;
      logger.log('ai-start', safe(`${crit?.id || ''} ${crit?.title || ''}`));
      reporter.onAIStart?.(payload);
    },
    onAIStage(payload) {
      logger.log('ai-stage', safe(payload?.label));
      reporter.onAIStage?.(payload);
    },
    onAILog(payload) {
      logger.log('ai-log', safe(payload?.message));
      reporter.onAILog?.(payload);
    },
    onCriterion(payload) {
      const crit = payload?.criterion;
      const status = payload?.evaluation?.status || '';
      logger.log('criterion', safe(`${crit?.id || ''} ${status}`));
      reporter.onCriterion?.(payload);
    },
    onPageEnd(payload) {
      logger.log('page-end', safe(payload?.url));
      reporter.onPageEnd?.(payload);
    },
    onPageError(payload) {
      logger.log('page-error', safe(payload?.error?.message || payload?.error));
      reporter.onPageError?.(payload);
    },
    onDone(payload) {
      logger.log('done', JSON.stringify(payload || {}));
      reporter.onDone?.(payload);
    },
    onShutdown(payload) {
      logger.log('shutdown', safe(payload?.signal));
      reporter.onShutdown?.(payload);
    },
    onError(payload) {
      logger.log('error', safe(payload));
      reporter.onError?.(payload);
    }
  };
  return { reporter: wrapped, stop };
}

function createAiWatchdog({ reporter, abortController, stallTimeoutMs, stageTimeoutMs }) {
  if (!stallTimeoutMs && !stageTimeoutMs) {
    return { reporter, stop: () => {} };
  }
  let lastActivityAt = Date.now();
  let stageLabel = '';
  let stageStartAt = 0;
  let timer = null;
  const bump = () => {
    lastActivityAt = Date.now();
  };
  const startStage = (label) => {
    stageLabel = String(label || '');
    stageStartAt = Date.now();
    bump();
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  timer = setInterval(() => {
    const now = Date.now();
    if (stallTimeoutMs && now - lastActivityAt >= stallTimeoutMs) {
      const seconds = Math.round(stallTimeoutMs / 1000);
      reporter.onError?.(`AI/MCP stalled for ${seconds}s. Aborting audit.`);
      abortController.abort();
      terminateCodexChildren();
      stop();
      return;
    }
    if (stageTimeoutMs && stageStartAt && now - stageStartAt >= stageTimeoutMs) {
      const seconds = Math.round(stageTimeoutMs / 1000);
      const label = stageLabel ? ` (${stageLabel})` : '';
      reporter.onError?.(`AI stage exceeded ${seconds}s${label}. Aborting audit.`);
      abortController.abort();
      terminateCodexChildren();
      stop();
    }
  }, 1000);
  if (typeof timer.unref === 'function') timer.unref();

  const wrapped = {
    ...reporter,
    onAIStart(payload) {
      bump();
      reporter.onAIStart?.(payload);
    },
    onAIStage(payload) {
      startStage(payload?.label);
      reporter.onAIStage?.(payload);
    },
    onAILog(payload) {
      bump();
      reporter.onAILog?.(payload);
    },
    onCriterion(payload) {
      bump();
      stageStartAt = 0;
      stageLabel = '';
      reporter.onCriterion?.(payload);
    },
    onPageStart(payload) {
      bump();
      reporter.onPageStart?.(payload);
    },
    onPageEnd(payload) {
      bump();
      reporter.onPageEnd?.(payload);
    },
    onShutdown(payload) {
      stop();
      reporter.onShutdown?.(payload);
    },
    onError(payload) {
      stop();
      reporter.onError?.(payload);
    },
    onDone(payload) {
      stop();
      reporter.onDone?.(payload);
    }
  };
  return { reporter: wrapped, stop };
}

function defaultXlsxOutPath() {
  return path.join('out', formatRunId(), 'rgaa-audit.xlsx');
}

function normalizeHttpBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function clearScreen() {
  if (!process.stdout.isTTY || process.env.TERM === 'dumb') return;
  try {
    process.stdout.write('\x1b[2J\x1b[0;0H');
  } catch (err) {
    if (err && (err.code === 'EPIPE' || err.code === 'ERR_STREAM_WRITE_AFTER_END')) return;
    throw err;
  }
}

async function canReachChromeDebugEndpoint(baseUrl) {
  const url = normalizeHttpBaseUrl(baseUrl);
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${url}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return Boolean(res && res.ok);
  } catch {
    return false;
  }
}

function ensureCodexHomeDir() {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) return;
  try {
    fs.mkdirSync(codexHome, { recursive: true });
  } catch (err) {
    // Let Codex report a clearer error later; this is just best-effort.
  }
}

function parsePagesFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const urls = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cleaned = trimmed.replace(/^[-*\d.\s]+/, '').trim();
    const match = cleaned.match(/https?:\/\/[^\s)\]]+/i);
    if (match) urls.push(match[0]);
  }
  return urls;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

async function promptPages({ tabs, guided = false } = {}) {
  await showFancyIntro();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const urls = [];
  const tabPages = Array.isArray(tabs) ? tabs : [];
  let selectedPageId;
  if (tabPages.length) {
    const tabLines = tabPages.slice(0, 12).map((page, index) => {
      const title = page?.title ? ` — ${page.title}` : '';
      return `${promptPalette.accent(String(index + 1).padStart(2, '0'))} ${page?.url || '(no url)'}${title}`;
    });
    if (tabPages.length > 12) {
      tabLines.push(promptPalette.muted(`(+${tabPages.length - 12} more)`));
    }
    if (isFancyTTY()) {
      console.log(
        renderPromptBox('Open Tabs Detected', tabLines, { borderColor: 'cyan' })
      );
    } else {
      console.log('\nOpen tabs detected:');
      tabLines.forEach((line) => console.log(stripAnsi(line)));
    }
    if (guided) {
      const picks = tabPages.map((_, idx) => idx);
      for (const idx of picks) {
        const url = tabPages[idx]?.url;
        if (isHttpUrl(url)) {
          urls.push(url);
        } else if (url) {
          console.log('Skipped (not http/https):', url);
        }
      }
    } else {
      const ask = (q) =>
        new Promise((resolve) => {
          rl.question(q, (answer) => resolve(answer));
        });
      const promptLabel = isFancyTTY()
        ? promptPalette.primary('Select tab numbers (comma), "all", or press Enter to skip: ')
        : 'Select tab numbers (comma), "all", or press Enter to skip: ';
      const selection = String(await ask(promptLabel))
        .trim()
        .toLowerCase();
      if (selection) {
        const picks =
          selection === 'all'
            ? tabPages.map((_, idx) => idx)
            : selection
                .split(',')
                .map((token) => Number(token.trim()) - 1)
                .filter((idx) => Number.isFinite(idx) && idx >= 0 && idx < tabPages.length);
        for (const idx of picks) {
          const url = tabPages[idx]?.url;
          if (isHttpUrl(url)) {
            urls.push(url);
          } else if (url) {
            console.log('Skipped (not http/https):', url);
          }
        }
        if (picks.length === 1) {
          const candidateId = tabPages[picks[0]]?.id;
          if (Number.isFinite(candidateId)) {
            selectedPageId = candidateId;
          }
        }
      }
      clearScreen();
    }
  }

  if (guided && tabPages.length) {
    rl.close();
    clearScreen();
    return { urls, pageId: selectedPageId };
  }

  if (isFancyTTY()) {
    console.log(
      renderPromptBox(
        'Pages to Audit',
        [
          'Enter page URLs (one per line).',
          promptPalette.muted('Press Enter on an empty line to finish.')
        ],
        { borderColor: 'cyan' }
      )
    );
  } else {
    console.log('Enter page URLs (one per line). Empty line to finish:');
  }

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) break;
    const match = trimmed.match(/https?:\/\/[^\s)\]]+/i);
    if (match) {
      urls.push(match[0]);
    } else {
      console.log('Skipped (no URL found):', trimmed);
    }
  }

  rl.close();
  clearScreen();
  return { urls, pageId: selectedPageId };
}

async function promptYesNo(question, defaultValue = false) {
  await showFancyIntro();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });

  const suffix = defaultValue ? 'Y/n' : 'y/N';
  if (isFancyTTY()) {
    const lines = [
      question,
      `${promptPalette.muted('Default:')} ${defaultValue ? promptPalette.ok('Yes') : promptPalette.warn('No')}`,
      `${promptPalette.muted('Answer:')} ${suffix}`
    ];
    console.log(renderPromptBox('Question', lines, { borderColor: 'magenta' }));
  }
  const promptLabel = isFancyTTY()
    ? promptPalette.primary(`→ (${suffix}) `)
    : `${question} (${suffix}) `;
  const raw = String(await ask(promptLabel))
    .trim()
    .toLowerCase();
  rl.close();
  clearScreen();

  if (!raw) return defaultValue;
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  return defaultValue;
}

async function promptChoice(question, choices, { defaultIndex = 0 } = {}) {
  await showFancyIntro();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });

  if (isFancyTTY()) {
    const lines = [];
    const labels = choices.map((label, index) => {
      const n = index + 1;
      const isDefault = index === defaultIndex;
      const left = `${promptPalette.accent(String(n).padStart(2, '0'))} ${label}`;
      return isDefault ? `${left} ${promptPalette.ok('• default')}` : left;
    });
    const maxLen = Math.max(0, ...labels.map((line) => visibleLen(line)));
    labels.forEach((line) => lines.push(padVisible(line, maxLen)));
    console.log(renderPromptBox(question, lines, { borderColor: 'cyan' }));
  } else {
    console.log(`\n${question}`);
    choices.forEach((label, index) => {
      const n = index + 1;
      const isDefault = index === defaultIndex;
      console.log(`${n}) ${label}${isDefault ? ' (default)' : ''}`);
    });
  }

  const promptLabel = isFancyTTY()
    ? promptPalette.primary('→ Choose a number: ')
    : 'Choose a number: ';
  const raw = String(await ask(promptLabel)).trim();
  rl.close();
  clearScreen();

  if (!raw) return defaultIndex;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultIndex;
  const idx = Math.floor(n) - 1;
  if (idx < 0 || idx >= choices.length) return defaultIndex;
  return idx;
}

async function promptOptionalNumber(question) {
  await showFancyIntro();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });

  if (isFancyTTY()) {
    console.log(
      renderPromptBox(
        'Optional',
        [question, promptPalette.muted('Leave empty to skip.')],
        { borderColor: 'cyan' }
      )
    );
  }
  const promptLabel = isFancyTTY() ? promptPalette.primary('→ ') : question;
  const raw = String(await ask(promptLabel)).trim();
  rl.close();
  clearScreen();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

async function promptMcpAutoConnectSetup({ channel } = {}) {
  await showFancyIntro();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });

  const channelLabel = channel ? ` (${channel})` : '';
  const lines = [
    `${promptPalette.accent('1.')} Launch Google Chrome${channelLabel} and keep it open.`,
    `${promptPalette.accent('2.')} Open the pages you want to audit in separate tabs/windows.`,
    `${promptPalette.accent('3.')} Open chrome://inspect/#remote-debugging and enable remote debugging.`,
    `${promptPalette.accent('4.')} Return here to continue. The Chrome permission prompt will appear after you press Enter.`
  ];
  if (isFancyTTY()) {
    console.log(renderPromptBox('MCP autoConnect setup (Chrome 144+)', lines, { borderColor: 'cyan' }));
  } else {
    console.log('\nMCP autoConnect setup (Chrome 144+):');
    lines.forEach((line) => console.log(stripAnsi(line)));
  }

  await ask(isFancyTTY() ? promptPalette.primary('Press Enter to start auto-connect…') : 'Press Enter to start auto-connect…');
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  rl.close();
  clearScreen();
}

async function promptMcpBrowserUrlSetup({ browserUrl } = {}) {
  await showFancyIntro();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });

  const url = normalizeHttpBaseUrl(browserUrl);
  const lines = [
    `${promptPalette.muted('Target URL:')} ${url || '(empty)'}`,
    'Chrome must be launched with a remote debugging port enabled.',
    `${promptPalette.muted('Example (Linux):')} google-chrome --remote-debugging-port=9222`,
    `${promptPalette.muted('Example (macOS):')} open -a "Google Chrome" --args --remote-debugging-port=9222`
  ];
  if (isFancyTTY()) {
    console.log(renderPromptBox('Chrome DevTools endpoint setup', lines, { borderColor: 'cyan' }));
  } else {
    console.log('\nChrome DevTools endpoint setup:');
    lines.forEach((line) => console.log(stripAnsi(line)));
  }

  await ask(isFancyTTY() ? promptPalette.primary('Press Enter to continue…') : 'Press Enter to continue…');
  rl.close();
  clearScreen();
}

async function main() {
  installOutputErrorHandlers();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rawArgs = hideBin(process.argv).map((v) => String(v));
  const argv = yargs(rawArgs)
    .option('pages', {
      type: 'array',
      describe: 'List of page URLs (space or comma separated).',
      coerce: (val) =>
        val
          .flatMap((v) => String(v).split(','))
          .map((v) => v.trim())
          .filter(Boolean)
    })
    .option('pages-file', {
      type: 'string',
      describe: 'Markdown/text file with one page per line.'
    })
    .option('out', {
      type: 'string',
      describe: 'Output XLSX file path.'
    })
    .option('xlsx', {
      type: 'boolean',
      default: true,
      describe: 'Generate XLSX output (default: true). Use --no-xlsx to disable.'
    })
    .option('allow-remote-debug', {
      type: 'boolean',
      describe:
        'Skip the prompt and explicitly allow Chrome remote debugging (required for non-interactive runs).'
    })
    .option('chrome-path', {
      type: 'string',
      describe: 'Custom Chrome/Chromium executable path.'
    })
    .option('chrome-port', {
      type: 'number',
      describe:
        'Remote debugging port to use when launching Chrome. Useful in restricted environments where chrome-launcher cannot probe a random port.'
    })
    .option('codex-model', {
      type: 'string',
      describe: 'Codex model for AI review (optional).'
    })
    .option('ai-mcp', {
      type: 'boolean',
      describe:
        'Allow the AI reviewer to use chrome-devtools MCP tools for additional evidence (default: on; use --no-ai-mcp to disable).'
    })
    .option('ai-ocr', {
      type: 'boolean',
      describe:
        'Enable OCR tool for AI+MCP (text in images). Defaults to true when --ai-mcp is enabled.'
    })
    .option('timeout', {
      type: 'number',
      default: 45000,
      describe: 'Page load timeout (ms).'
    })
    .option('report-lang', {
      alias: 'lang',
      type: 'string',
      default: 'fr',
      choices: ['fr', 'en'],
      describe: 'Output language for report content (criteria titles, cell comments, summary labels).'
    })
    .option('guided', {
      type: 'boolean',
      describe:
        'Interactive wizard for non-technical users (prompts for common options like MCP settings and report language). In TTY, it is enabled by default; pass --no-guided to disable.'
    })
    .option('humanize-feed', {
      type: 'boolean',
      describe:
        'Rewrite technical Codex progress logs into short, user-friendly status updates (uses extra codex exec calls). In TTY, enabled by default; pass --no-humanize-feed to disable.'
    })
    .option('humanize-feed-model', {
      type: 'string',
      describe:
        'Optional Codex model to use for feed humanization (leave empty for default).'
    })
    .option('mcp-browser-url', {
      type: 'string',
      describe:
        'Connect the Chrome DevTools MCP server to an existing Chrome DevTools endpoint (e.g. http://127.0.0.1:9222).'
    })
    .option('mcp-auto-connect', {
      type: 'boolean',
      describe:
        'When no --mcp-browser-url is provided, let chrome-devtools-mcp use --autoConnect (requires Chrome 144+). If omitted, defaults to true (interactive Chrome).'
    })
    .option('mcp-channel', {
      type: 'string',
      describe:
        'Optional channel for chrome-devtools-mcp autoConnect (e.g. "beta" when using Chrome 144 Beta).'
    })
    .option('mcp-page-id', {
      type: 'number',
      describe:
        'Target an existing Chrome page by id (as shown by chrome-devtools-mcp list_pages). If set, the snapshot is collected from that page (no navigation).'
    })
    .option('allow-partial', {
      type: 'boolean',
      default: false,
      describe:
        'Exit with code 0 even if some pages/criteria failed due to tool errors (still reported as Error).'
    })
    .help()
    .parse();

  const guided = interactive ? argv.guided !== false : Boolean(argv.guided);
  const humanizeFeedDefault =
    String(process.env.AUDIT_HUMANIZE_FEED || '').trim().length > 0
      ? ['1', 'true', 'yes'].includes(String(process.env.AUDIT_HUMANIZE_FEED || '').trim().toLowerCase())
      : interactive;
  const humanizeFeed =
    typeof argv['humanize-feed'] === 'boolean' ? argv['humanize-feed'] : humanizeFeedDefault;
  const humanizeFeedModel =
    argv['humanize-feed-model'] ||
    process.env.AUDIT_HUMANIZE_FEED_MODEL ||
    '';

  if (argv.xlsx === false) {
    argv.out = null;
  } else if (!argv.out) {
    // Default behavior: always produce an XLSX report.
    argv.out = defaultXlsxOutPath();
  }

  let pages = argv.pages || [];

  if (argv['pages-file']) {
    const filePath = path.resolve(argv['pages-file']);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Pages file not found: ${filePath}`);
    }
    pages = pages.concat(parsePagesFile(filePath));
  }

  pages = Array.from(new Set(pages));

  let allowRemoteDebug = argv['allow-remote-debug'];
  if (allowRemoteDebug === undefined) {
    if (!interactive) {
      console.error(
        'Remote debugging consent required. Re-run with --allow-remote-debug (or run interactively).'
      );
      process.exit(1);
    }
    allowRemoteDebug = guided
      ? true
      : await promptYesNo('Allow Chrome remote debugging for this audit?', false);
  }
  if (!allowRemoteDebug) {
    console.error('Remote debugging not allowed. Aborting.');
    process.exit(1);
  }

  let reportLang = String(argv['report-lang'] || 'fr').trim().toLowerCase();
  if (reportLang !== 'en') reportLang = 'fr';

  const reportLangExplicit = rawArgs.some(
    (arg) =>
      arg === '--report-lang' ||
      arg.startsWith('--report-lang=') ||
      arg === '--lang' ||
      arg.startsWith('--lang=')
  );

  const mcpBrowserUrlExplicit = rawArgs.some(
    (arg) => arg === '--mcp-browser-url' || arg.startsWith('--mcp-browser-url=')
  );

  const mcpAutoConnectExplicit = rawArgs.some(
    (arg) => arg === '--mcp-auto-connect' || arg === '--no-mcp-auto-connect'
  );

  const mcpChannelExplicit = rawArgs.some(
    (arg) => arg === '--mcp-channel' || arg.startsWith('--mcp-channel=')
  );

  const mcpPageIdExplicit = rawArgs.some(
    (arg) => arg === '--mcp-page-id' || arg.startsWith('--mcp-page-id=')
  );

  const snapshotMode = 'mcp';
  let mcpBrowserUrlArg = argv['mcp-browser-url'];
  let mcpAutoConnectArg = argv['mcp-auto-connect'];
  let mcpChannelArg = argv['mcp-channel'];
  let mcpPageIdArg = argv['mcp-page-id'];

  if (interactive && guided) {
    if (!reportLangExplicit) {
      const langIndex = await promptChoice(
        'What language should the report use?',
        ['French (fr)', 'English (en)'],
        { defaultIndex: reportLang === 'en' ? 1 : 0 }
      );
      reportLang = langIndex === 1 ? 'en' : 'fr';
    }

    const hasBrowserUrl = Boolean(String(mcpBrowserUrlArg || '').trim());
    const hasAutoConnect = Boolean(mcpAutoConnectArg);

    if (!mcpBrowserUrlExplicit && !mcpAutoConnectExplicit && !hasBrowserUrl && !hasAutoConnect) {
      if (guided) {
        mcpAutoConnectArg = true;
        mcpBrowserUrlArg = '';
      } else {
        const connectIndex = await promptChoice(
          'How should we connect to Chrome?',
          [
            'Auto-connect (recommended) — Chrome 144+ will prompt you to allow debugging connections.',
            'Use an existing debugging URL (advanced) — e.g. http://127.0.0.1:9222'
          ],
          { defaultIndex: 1 }
        );

        if (connectIndex === 0) {
          mcpAutoConnectArg = true;
          mcpBrowserUrlArg = '';
        } else {
          const defaultBrowserUrl = 'http://127.0.0.1:9222';
          mcpAutoConnectArg = false;
          mcpBrowserUrlArg =
            (await (async () => {
              const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
              });
              const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
              const answer = String(
                await ask(`Chrome debugging URL (default: ${defaultBrowserUrl}): `)
              ).trim();
              rl.close();
              clearScreen();
              return answer || defaultBrowserUrl;
            })()) || mcpBrowserUrlArg;
        }
      }
    }

    if (!mcpChannelExplicit) {
      mcpChannelArg = mcpChannelArg || '';
    }

    if (!mcpPageIdExplicit) {
      const wantsPageId = await promptYesNo(
        'Do you want to target a specific existing tab id (optional)?',
        false
      );
      if (wantsPageId) {
        const pageId = await promptOptionalNumber(
          'Tab id (from chrome-devtools list_pages). Leave empty to skip: '
        );
        if (typeof pageId === 'number' && Number.isFinite(pageId)) {
          mcpPageIdArg = pageId;
        }
      }
    }
  }

  const mcpBrowserUrl = String(mcpBrowserUrlArg || '').trim();
  const mcpAutoConnect =
    !mcpBrowserUrl
      ? mcpAutoConnectArg === undefined
        ? true
        : Boolean(mcpAutoConnectArg)
      : Boolean(mcpAutoConnectArg);

  if (interactive && guided && mcpBrowserUrl) {
    await promptMcpBrowserUrlSetup({ browserUrl: mcpBrowserUrl });
    const ok = await canReachChromeDebugEndpoint(mcpBrowserUrl);
    if (!ok) {
      console.log(
        `\nWarning: cannot reach Chrome DevTools at ${normalizeHttpBaseUrl(mcpBrowserUrl)}.\n` +
          `If MCP fails, either start Chrome with --remote-debugging-port=9222, or use auto-connect.\n`
      );
    }
  }

  if (mcpAutoConnect && !mcpBrowserUrl && interactive) {
    await promptMcpAutoConnectSetup({
      channel: mcpChannelArg || process.env.AUDIT_MCP_CHANNEL || ''
    });
  }

  let mcpTabs = [];
  if (interactive && guided && pages.length === 0) {
    try {
      console.log('\nChecking existing Chrome tabs (list_pages)…');
      const list = await listMcpPages({
        model: argv['codex-model'],
        mcp: {
          browserUrl: mcpBrowserUrl || process.env.AUDIT_MCP_BROWSER_URL || '',
          autoConnect: mcpAutoConnect,
          channel: mcpChannelArg || process.env.AUDIT_MCP_CHANNEL || ''
        }
      });
      const entries = Array.isArray(list?.pages) ? list.pages : [];
      mcpTabs = entries;
      if (entries.length) {
        console.log('Open tabs:');
        entries.slice(0, 8).forEach((page) => {
          const title = page?.title ? ` — ${page.title}` : '';
          console.log(`- [${page?.id}] ${page?.url || '(no url)'}${title}`);
        });
        if (entries.length > 8) {
          console.log(`- (+${entries.length - 8} more)`);
        }
      }
    } catch (err) {
      console.log(
        `\nWarning: unable to list Chrome tabs via MCP (${err?.message || 'unknown error'}).`
      );
    }
  }

  if (pages.length === 0) {
    if (!interactive) {
      console.error('No pages provided. Use --pages or --pages-file in non-interactive mode.');
      process.exit(1);
    }
    const promptResult = await promptPages({ tabs: mcpTabs, guided });
    pages = promptResult.urls;
    if (!mcpPageIdArg && Number.isFinite(promptResult.pageId)) {
      mcpPageIdArg = promptResult.pageId;
    }
  }

  if (pages.length === 0) {
    console.error('No pages provided.');
    process.exit(1);
  }

  const outPath = argv.out ? path.resolve(argv.out) : null;
  const debugLogEnv = String(process.env.AUDIT_DEBUG_LOG || '').trim().toLowerCase();
  const debugLogEnabled = debugLogEnv
    ? debugLogEnv === '1' || debugLogEnv === 'true' || debugLogEnv === 'yes'
    : true;
  const debugLogPath = debugLogEnabled
    ? path.join(outPath ? path.dirname(outPath) : path.join('out', formatRunId()), 'audit.debug.log')
    : '';
  const debugLogger = debugLogEnabled ? createDebugLogger({ logPath: debugLogPath }) : null;
  const debugSnapshotsEnvExplicit =
    Object.prototype.hasOwnProperty.call(process.env, 'AUDIT_DEBUG_SNAPSHOTS') &&
    process.env.AUDIT_DEBUG_SNAPSHOTS !== undefined;

  if (guided && !debugSnapshotsEnvExplicit) {
    const defaultEnabled = true;
    let enableDebugSnapshots = defaultEnabled;

    if (enableDebugSnapshots && outPath) {
      process.env.AUDIT_DEBUG_SNAPSHOTS = '1';
    } else if (!enableDebugSnapshots) {
      process.env.AUDIT_DEBUG_SNAPSHOTS = '0';
    } else if (enableDebugSnapshots && !outPath) {
      console.log(
        'Debug snapshots requested, but XLSX output is disabled (--no-xlsx), so there is no out/<run>/ folder to write snapshots into.'
      );
    }
  }

  const codexModel =
    argv['codex-model'] ||
    process.env.AUDIT_CODEX_MODEL ||
    '';
  const aiMcpEnv = String(process.env.AUDIT_AI_MCP || '').trim().toLowerCase();
  const aiMcpEnvExplicit = aiMcpEnv.length > 0;
  const aiMcpEnvEnabled =
    aiMcpEnv === '1' || aiMcpEnv === 'true' || aiMcpEnv === 'yes';
  const aiMcpDefault = aiMcpEnvExplicit ? aiMcpEnvEnabled : true;
  const aiMcp =
    typeof argv['ai-mcp'] === 'boolean' ? argv['ai-mcp'] : aiMcpDefault;
  const aiOcrEnv = String(process.env.AUDIT_AI_OCR || '').trim().toLowerCase();
  const aiOcrEnvExplicit = aiOcrEnv.length > 0;
  const aiOcrEnvEnabled =
    aiOcrEnv === '1' || aiOcrEnv === 'true' || aiOcrEnv === 'yes';
  const aiOcrDefault = aiMcp ? (!aiOcrEnvExplicit || aiOcrEnvEnabled) : false;
  const aiOcr = typeof argv['ai-ocr'] === 'boolean' ? argv['ai-ocr'] : aiOcrDefault;
  if (!process.env.CODEX_MCP_MODE) {
    process.env.CODEX_MCP_MODE = 'chrome';
  }
  const reporter = createReporter({
    lang: reportLang,
    uiLang: 'en',
    guided,
    humanizeFeed,
    humanizeFeedModel
  });
  const debugWrapped = wrapReporterWithDebug({ reporter, logger: debugLogger });
  const aiStallRaw = Number(process.env.AUDIT_AI_STALL_TIMEOUT_MS || '');
  const aiStallTimeoutMs =
    Number.isFinite(aiStallRaw) && aiStallRaw > 0 ? Math.floor(aiStallRaw) : 0;
  const aiStageRaw = Number(process.env.AUDIT_AI_STAGE_TIMEOUT_MS || '');
  const aiStageTimeoutMs =
    Number.isFinite(aiStageRaw) && aiStageRaw > 0 ? Math.floor(aiStageRaw) : 0;
  const criteria = loadCriteria({ lang: reportLang });
  const criteriaCount = criteria.length;
  const wantsEnrichment =
    String(process.env.AUDIT_ENRICH || '').trim().toLowerCase() !== '0';
  const enrichmentEnabled = wantsEnrichment && aiMcp;
  if (interactive && guided) {
    clearScreen();
  }
  if (reporter.onStart) {
    await reporter.onStart({
      pages: pages.length,
      criteriaCount,
      codexModel,
      mcpMode: process.env.CODEX_MCP_MODE,
      auditMode: snapshotMode,
      enrichmentEnabled
    });
  }

  const abortController = new AbortController();
  const watchdog = createAiWatchdog({
    reporter: debugWrapped.reporter,
    abortController,
    stallTimeoutMs: aiStallTimeoutMs,
    stageTimeoutMs: aiStageTimeoutMs
  });
  let shutdownRequested = false;
  let forceExitTimer = null;
  const shutdown = (signal) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    lastShutdownSignal = signal;
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    if (signal === 'SIGTERM') {
      watchdog.stop();
      debugWrapped.stop();
      if (reporter.onShutdown) {
        reporter.onShutdown({ signal });
      } else {
        clearScreen();
        console.log('Progress at shutdown.');
      }
    } else {
      watchdog.stop();
      debugWrapped.stop();
      reporter.onError?.(`Received ${signal}. Shutting down…`);
    }
    abortController.abort();
    terminateCodexChildren();
    process.exitCode = exitCode;
    forceExitTimer = setTimeout(() => {
      process.exit(exitCode);
    }, 5000);
    if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => terminateCodexChildren());

  const { spawnSync } = await import('node:child_process');
  ensureCodexHomeDir();
  const codexBin = process.env.CODEX_PATH || 'codex';
  const codexCheck = spawnSync(codexBin, ['--version'], { stdio: 'ignore' });
  if (codexCheck.error || codexCheck.status !== 0) {
    reporter.onError?.(
      `Codex CLI is required for AI-based criteria review (${codexBin} --version failed).`
    );
    process.exit(1);
  }

  try {
    const summary = await runAudit({
      pages,
      outPath,
      reportLang,
      criteria,
      chromePath: argv['chrome-path'],
      chromePort: argv['chrome-port'],
      timeoutMs: argv.timeout,
      reporter: watchdog.reporter,
      signal: abortController.signal,
      snapshotMode,
      mcp: {
        browserUrl: mcpBrowserUrl || process.env.AUDIT_MCP_BROWSER_URL || '',
        autoConnect: mcpAutoConnect,
        channel: mcpChannelArg || process.env.AUDIT_MCP_CHANNEL || '',
        pageId: mcpPageIdArg,
        cachedPages: mcpTabs.length ? mcpTabs : undefined
      },
      ai: {
        model: codexModel,
        useMcp: aiMcp,
        ocr: aiOcr
      }
    });

    const hadErrors =
      (summary?.errors?.criteriaErrored || 0) > 0 ||
      (summary?.errors?.pagesFailed || 0) > 0 ||
      (summary?.errors?.aiFailed || 0) > 0;

    if (hadErrors && !argv['allow-partial']) {
      reporter.onError?.(
        'Audit finished with errors (marked as "Error" in the report). Re-run with --allow-partial to keep exit code 0.'
      );
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    watchdog.stop();
    debugWrapped.stop();
    if (isAbortError(err) || abortController.signal.aborted) {
      throw createAbortError();
    }
    throw err;
  } finally {
    watchdog.stop();
    debugWrapped.stop();
    terminateCodexChildren();
    if (forceExitTimer) clearTimeout(forceExitTimer);
  }

  if (!abortController.signal.aborted) {
    if (process.exitCode && process.exitCode !== 0) return;
    if (outPath) console.log(`\nAudit complete: ${outPath}`);
    else console.log('\nAudit complete.');
  }
}

main().catch((err) => {
  if (isAbortError(err)) {
    if (lastShutdownSignal === 'SIGTERM') {
      process.exit(process.exitCode || 143);
      return;
    }
    console.error('Audit aborted. Shutdown complete.');
    process.exit(130);
    return;
  }
  console.error(err);
  process.exit(1);
});
