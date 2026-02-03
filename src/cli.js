#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runAudit } from './audit.js';
import { loadCriteria } from './criteria.js';
import { createReporter } from './ui.js';
import { terminateCodexChildren } from './ai.js';
import { createAbortError, isAbortError } from './abort.js';
import { listMcpPages } from './mcpSnapshot.js';

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

function defaultXlsxOutPath() {
  return path.join('out', formatRunId(), 'rgaa-audit.xlsx');
}

function normalizeHttpBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
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

async function promptPages({ tabs } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const urls = [];
  const tabPages = Array.isArray(tabs) ? tabs : [];
  if (tabPages.length) {
    console.log('\nOpen tabs detected:');
    tabPages.slice(0, 12).forEach((page, index) => {
      const title = page?.title ? ` — ${page.title}` : '';
      console.log(`${index + 1}) ${page?.url || '(no url)'}${title}`);
    });
    if (tabPages.length > 12) {
      console.log(`(+${tabPages.length - 12} more)`);
    }
    const ask = (q) =>
      new Promise((resolve) => {
        rl.question(q, (answer) => resolve(answer));
      });
    const selection = String(
      await ask('Select tab numbers (comma), "all", or press Enter to skip: ')
    )
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
    }
  }

  console.log('Enter page URLs (one per line). Empty line to finish:');

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
  return urls;
}

async function promptYesNo(question, defaultValue = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });

  const suffix = defaultValue ? ' (Y/n) ' : ' (y/N) ';
  const raw = String(await ask(`${question}${suffix}`))
    .trim()
    .toLowerCase();
  rl.close();

  if (!raw) return defaultValue;
  if (raw === 'y' || raw === 'yes') return true;
  if (raw === 'n' || raw === 'no') return false;
  return defaultValue;
}

async function promptChoice(question, choices, { defaultIndex = 0 } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });

  console.log(`\n${question}`);
  choices.forEach((label, index) => {
    const n = index + 1;
    const isDefault = index === defaultIndex;
    console.log(`${n}) ${label}${isDefault ? ' (default)' : ''}`);
  });

  const raw = String(await ask('Choose a number: ')).trim();
  rl.close();

  if (!raw) return defaultIndex;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultIndex;
  const idx = Math.floor(n) - 1;
  if (idx < 0 || idx >= choices.length) return defaultIndex;
  return idx;
}

async function promptOptionalNumber(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (q) =>
    new Promise((resolve) => {
      rl.question(q, (answer) => resolve(answer));
    });

  const raw = String(await ask(question)).trim();
  rl.close();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.floor(n);
}

async function promptMcpAutoConnectSetup({ channel } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });

  const channelLabel = channel ? ` (${channel})` : '';
  console.log('\nMCP autoConnect setup (Chrome 144+):');
  console.log(`1) Launch Google Chrome${channelLabel} and keep it open.`);
  console.log('2) Open chrome://inspect/#remote-debugging and enable remote debugging.');
  console.log('3) In the dialog, click Allow for incoming debugging connections.');
  console.log('4) Return here to continue.\n');

  await ask('Press Enter when Chrome is ready…');
  rl.close();
}

async function promptMcpBrowserUrlSetup({ browserUrl } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question) =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });

  const url = normalizeHttpBaseUrl(browserUrl);
  console.log('\nChrome DevTools endpoint setup:');
  console.log(`- Target URL: ${url || '(empty)'}`);
  console.log('- Chrome must be launched with a remote debugging port enabled.');
  console.log('  Example (Linux): google-chrome --remote-debugging-port=9222');
  console.log('  Example (macOS): open -a "Google Chrome" --args --remote-debugging-port=9222\n');

  await ask('Press Enter to continue…');
  rl.close();
}

async function main() {
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
    .option('timeout', {
      type: 'number',
      default: 45000,
      describe: 'Page load timeout (ms).'
    })
    .option('snapshot-mode', {
      type: 'string',
      default: 'cdp',
      choices: ['mcp', 'cdp'],
      describe: 'Snapshot collection mode.'
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
        'Interactive wizard for non-technical users (prompts for common options like snapshot mode, MCP settings, and report language). In TTY, it is enabled by default; pass --no-guided to disable.'
    })
    .option('mcp-browser-url', {
      type: 'string',
      describe:
        'When snapshot-mode=mcp, connect the Chrome DevTools MCP server to an existing Chrome CDP endpoint (e.g. http://127.0.0.1:9222).'
    })
    .option('mcp-auto-connect', {
      type: 'boolean',
      describe:
        'When snapshot-mode=mcp and no --mcp-browser-url is provided, let chrome-devtools-mcp use --autoConnect (requires Chrome 144+). If omitted, defaults to true (interactive Chrome).'
    })
    .option('mcp-channel', {
      type: 'string',
      describe:
        'Optional channel for chrome-devtools-mcp autoConnect (e.g. "beta" when using Chrome 144 Beta).'
    })
    .option('mcp-page-id', {
      type: 'number',
      describe:
        'When snapshot-mode=mcp, target an existing Chrome page by id (as shown by chrome-devtools-mcp list_pages). If set, the snapshot is collected from that page (no navigation).'
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
    allowRemoteDebug = await promptYesNo(
      'Allow Chrome remote debugging for this audit?',
      guided ? true : false
    );
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

  const snapshotModeExplicit = rawArgs.some(
    (arg) => arg === '--snapshot-mode' || arg.startsWith('--snapshot-mode=')
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

  let snapshotMode = argv['snapshot-mode'];
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

    if (!snapshotModeExplicit) {
      const modeIndex = await promptChoice(
        'How should the auditor open/capture pages?',
        [
          'Automatic (recommended) — the auditor opens its own Chrome and navigates to each URL.',
          'Use my existing Chrome window (MCP) — connect to a Chrome session you already have open.'
        ],
        { defaultIndex: 1 }
      );
      snapshotMode = modeIndex === 1 ? 'mcp' : 'cdp';
    }

    if (snapshotMode === 'mcp') {
      const hasBrowserUrl = Boolean(String(mcpBrowserUrlArg || '').trim());
      const hasAutoConnect = Boolean(mcpAutoConnectArg);

      if (!mcpBrowserUrlExplicit && !mcpAutoConnectExplicit && !hasBrowserUrl && !hasAutoConnect) {
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
              return answer || defaultBrowserUrl;
            })()) || mcpBrowserUrlArg;
        }
      }

      if (!mcpChannelExplicit && (mcpAutoConnectArg || String(mcpBrowserUrlArg || '').trim() === '')) {
        mcpChannelArg =
          (await (async () => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a)));
            const answer = String(
              await ask('Optional Chrome channel (leave empty for stable; e.g. "beta"): ')
            ).trim();
            rl.close();
            return answer;
          })()) || mcpChannelArg;
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
  }

  const mcpBrowserUrl =
    snapshotMode === 'mcp' ? String(mcpBrowserUrlArg || '').trim() : '';
  const mcpAutoConnect =
    snapshotMode === 'mcp' && !mcpBrowserUrl
      ? mcpAutoConnectArg === undefined
        ? true
        : Boolean(mcpAutoConnectArg)
      : Boolean(mcpAutoConnectArg);

  if (interactive && guided && snapshotMode === 'mcp' && mcpBrowserUrl) {
    await promptMcpBrowserUrlSetup({ browserUrl: mcpBrowserUrl });
    const ok = await canReachChromeDebugEndpoint(mcpBrowserUrl);
    if (!ok) {
      console.log(
        `\nWarning: cannot reach Chrome DevTools at ${normalizeHttpBaseUrl(mcpBrowserUrl)}.\n` +
          `If MCP fails, either start Chrome with --remote-debugging-port=9222, or use auto-connect, or switch to --snapshot-mode cdp.\n`
      );
    }
  }

  if (snapshotMode === 'mcp' && mcpAutoConnect && !mcpBrowserUrl && interactive) {
    await promptMcpAutoConnectSetup({
      channel: mcpChannelArg || process.env.AUDIT_MCP_CHANNEL || ''
    });
  }

  let mcpTabs = [];
  if (interactive && guided && snapshotMode === 'mcp' && pages.length === 0) {
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
    pages = await promptPages({ tabs: mcpTabs });
  }

  if (pages.length === 0) {
    console.error('No pages provided.');
    process.exit(1);
  }

  const outPath = argv.out ? path.resolve(argv.out) : null;
  const debugSnapshotsEnvExplicit =
    Object.prototype.hasOwnProperty.call(process.env, 'AUDIT_DEBUG_SNAPSHOTS') &&
    process.env.AUDIT_DEBUG_SNAPSHOTS !== undefined;

  if (guided && !debugSnapshotsEnvExplicit) {
    const defaultEnabled = true;
    let enableDebugSnapshots = defaultEnabled;

    if (interactive) {
      const targetHint = outPath
        ? `This writes per-page snapshot JSON under ${path.join(path.dirname(outPath), 'snapshots')}/`
        : 'XLSX output is disabled, so snapshots will not be written.';
      enableDebugSnapshots = await promptYesNo(
        `Export debug snapshots for troubleshooting? (${targetHint})`,
        defaultEnabled
      );
    }

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
    process.env.CODEX_MODEL ||
    process.env.AUDIT_CODEX_MODEL ||
    'gpt-5.2-codex';
  if (!process.env.CODEX_MCP_MODE) {
    process.env.CODEX_MCP_MODE = snapshotMode === 'mcp' ? 'chrome' : 'none';
  }
  const reporter = createReporter({ lang: reportLang });
  const criteriaCount = loadCriteria({ lang: reportLang }).length;
  if (reporter.onStart) {
    await reporter.onStart({
      pages: pages.length,
      criteriaCount,
      codexModel,
      mcpMode: process.env.CODEX_MCP_MODE,
      auditMode: snapshotMode
    });
  }

  const abortController = new AbortController();
  let shutdownRequested = false;
  let forceExitTimer = null;
  const shutdown = (signal) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    reporter.onError?.(`Received ${signal}. Shutting down…`);
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
      chromePath: argv['chrome-path'],
      chromePort: argv['chrome-port'],
      timeoutMs: argv.timeout,
      reporter,
      signal: abortController.signal,
      snapshotMode,
      mcp: {
        browserUrl: snapshotMode === 'mcp' ? mcpBrowserUrl || process.env.AUDIT_MCP_BROWSER_URL || '' : '',
        autoConnect: mcpAutoConnect,
        channel: mcpChannelArg || process.env.AUDIT_MCP_CHANNEL || '',
        pageId: snapshotMode === 'mcp' ? mcpPageIdArg : undefined
      },
      ai: {
        model: codexModel
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
    if (isAbortError(err) || abortController.signal.aborted) {
      throw createAbortError();
    }
    throw err;
  } finally {
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
    console.error('Audit aborted. Shutdown complete.');
    process.exit(130);
    return;
  }
  console.error(err);
  process.exit(1);
});
