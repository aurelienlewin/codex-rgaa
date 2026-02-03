import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import chalkAnimation from 'chalk-animation';
import gradientString from 'gradient-string';
import { MultiBar, Presets } from 'cli-progress';
import { getI18n, normalizeReportLang } from './i18n.js';
import readline from 'node:readline';

const palette = {
  primary: chalk.hex('#22d3ee'),
  accent: chalk.hex('#a78bfa'),
  glow: chalk.hex('#f472b6'),
  warn: chalk.hex('#f59e0b'),
  error: chalk.hex('#ef4444'),
  muted: chalk.hex('#94a3b8'),
  ok: chalk.hex('#22c55e'),
  steel: chalk.hex('#0f172a')
};

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
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
  /spawning codex/i
];

function normalizeAiMessage(text) {
  return String(text || '')
    .replace(/^Codex:\s*/i, '')
    .replace(/^AI:\s*/i, '')
    .trim();
}

function isNoiseAiMessage(text) {
  const cleaned = normalizeAiMessage(text).toLowerCase();
  if (!cleaned) return false;
  if (/^[}\]]+,?$/.test(cleaned)) return true;
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

function chromeAutomationWarningLines({ i18n, mcpMode }) {
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
      ),
      palette.muted(
        i18n.t(
          'Astuce : Réglages Système → Confidentialité et sécurité → Automatisation.',
          'Tip: System Settings → Privacy & Security → Automation.'
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

function humanizeCodexFeedMessage(message, i18n) {
  const raw = normalizeInline(String(message || '').replace(/^Codex:\s*/i, ''));
  if (!raw) return '';

  const lower = raw.toLowerCase();
  const t = (fr, en) => i18n?.t(fr, en) || en;

  if (lower.includes('schema preflight')) {
    return t('Vérification des schémas…', 'Validating schemas…');
  }
  if (lower.includes('parsing mcp snapshot')) {
    return t('Lecture de la capture de page…', 'Reading page snapshot…');
  }
  if (lower.includes('running mcp snapshot') || lower.includes('mcp snapshot')) {
    return t('Capture de la page…', 'Capturing page…');
  }
  if (lower.includes('list_pages')) {
    return t('Récupération des onglets Chrome…', 'Fetching Chrome tabs…');
  }
  if (lower.includes('chrome-devtools-mcp')) {
    return t('Connexion à Chrome…', 'Connecting to Chrome…');
  }
  if (lower.includes('retrying') && lower.includes('default model')) {
    return t('Modèle introuvable, nouvel essai…', 'Model not found, retrying…');
  }

  return raw
    .replace(/\bMCP\b/g, 'Chrome')
    .replace(/\bCDP\b/g, 'DevTools')
    .replace(/^AI:\s*/i, '')
    .trim();
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

function createLiveBlockRenderer() {
  let lastLineCount = 0;
  let cursorHidden = false;

  const hideCursor = () => {
    if (!cursorHidden && process.stdout.isTTY) {
      process.stdout.write('\x1b[?25l');
      cursorHidden = true;
    }
  };
  const showCursor = () => {
    if (cursorHidden && process.stdout.isTTY) {
      process.stdout.write('\x1b[?25h');
      cursorHidden = false;
    }
  };

  const clearPrevious = () => {
    if (!process.stdout.isTTY) return;
    if (lastLineCount > 0) readline.moveCursor(process.stdout, 0, -lastLineCount);
    readline.clearScreenDown(process.stdout);
  };

  return {
    render(block) {
      if (!process.stdout.isTTY) {
        process.stdout.write(`${stripAnsi(block)}\n`);
        return;
      }
      hideCursor();
      clearPrevious();
      process.stdout.write(`${block}\n`);
      lastLineCount = String(block).split('\n').length;
    },
    stop({ keepBlock = true } = {}) {
      if (!keepBlock) clearPrevious();
      showCursor();
      lastLineCount = 0;
    }
  };
}

function createFancyReporter(options = {}) {
  const i18n = getI18n(normalizeReportLang(options.lang));
  const isGuided = Boolean(options.guided);
  const spinner = ora({ text: i18n.t('Préparation de l’audit…', 'Preparing audit…'), color: 'cyan' });
  const renderer = createLiveBlockRenderer();
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let tickTimer = null;

  let totalCriteria = 0;
  let totalPages = 0;
  let overallDone = 0;
  let pageDone = 0;
  let currentPageIndex = -1;
  let currentUrl = '';
  let stageLabel = '';
  let stageStartAt = 0;
  let lastStageMs = null;
  let pageStartAt = 0;
  let auditStartAt = 0;
  let auditMode = 'mcp';
  let mcpMode = '';
  let lastAILog = '';
  let currentCriterion = null;
  let lastDecision = null;
  const decisions = [];

  const feedMax = 7;
  const feed = [];
  const pushFeed = (kind, message, { replaceLastIfSameKind = false } = {}) => {
    const raw = String(message || '');
    const normalized = kind === 'progress' ? humanizeCodexFeedMessage(raw, i18n) : normalizeInline(raw);
    const cleaned = clipInline(normalized, 240);
    if (!cleaned) return;
    if (replaceLastIfSameKind && feed.length && feed[feed.length - 1].kind === kind) {
      feed[feed.length - 1] = { at: nowMs(), kind, message: cleaned };
    } else {
      feed.push({ at: nowMs(), kind, message: cleaned });
      while (feed.length > feedMax) feed.shift();
    }
  };

  const startTicking = () => {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      frame = (frame + 1) % spinnerFrames.length;
      render();
    }, 120);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
    process.on('exit', () => renderer.stop({ keepBlock: true }));
    process.stdout?.on?.('resize', () => render());
  };

  const stopTicking = () => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  };

  const startStage = (label) => {
    stageLabel = String(label || '').trim();
    stageStartAt = nowMs();
    lastStageMs = null;
    if (stageLabel) pushFeed('stage', stageLabel);
    render();
  };

  const endStage = (label) => {
    const endAt = nowMs();
    const elapsed = stageStartAt ? endAt - stageStartAt : 0;
    stageStartAt = 0;
    lastStageMs = elapsed;
    if (label) stageLabel = `${label} done`;
    pushFeed('timing', `${label || 'Stage'}: ${elapsed}ms`, { replaceLastIfSameKind: false });
    render();
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

  const render = () => {
    if (!process.stdout.isTTY) return;
    const cols = process.stdout.columns || 100;
    const width = Math.max(76, Math.min(cols - 1, 120));
    const barW = Math.max(12, Math.min(28, Math.floor((width - 24) / 2)));

    const overallTotal = totalPages * totalCriteria;
    const overallPct = overallTotal ? Math.round((overallDone / overallTotal) * 100) : 0;
    const pagePct = totalCriteria ? Math.round((pageDone / totalCriteria) * 100) : 0;
    const pageLabel = totalPages ? `${Math.max(0, currentPageIndex + 1)}/${totalPages}` : '-/-';

    const stageSpinner = stageStartAt ? spinnerFrames[frame] : ' ';
    const stageAge = stageStartAt ? `${nowMs() - stageStartAt}ms` : lastStageMs ? `${lastStageMs}ms` : '';
    const stageText = stageLabel || (currentUrl ? i18n.t('Audit en cours', 'Audit running') : '');
    const elapsed = auditStartAt ? formatElapsed(nowMs() - auditStartAt) : '';

    const urlLine = currentUrl ? clipInline(currentUrl, width - 18) : '';
    const criterionLine = currentCriterion
      ? clipInline(`${currentCriterion.id} ${currentCriterion.title}`, width - 18)
      : '';

    const progressLines = [
      `${padVisibleRight(palette.primary('Overall'), 8)} ${renderBar({ value: overallDone, total: overallTotal, width: barW })} ${palette.muted(
        `${overallPct}% • ${overallDone}/${overallTotal || 0}`
      )}`,
      `${padVisibleRight(palette.accent('Page'), 8)} ${renderBar({ value: pageDone, total: totalCriteria, width: barW })} ${palette.muted(
        `${pagePct}% • ${pageDone}/${totalCriteria || 0}`
      )} ${palette.muted('•')} ${palette.muted(i18n.t('Page', 'Page'))} ${palette.accent(pageLabel)}`,
      urlLine ? `${padVisibleRight(palette.muted('URL'), 8)} ${chalk.bold(urlLine)}` : '',
      criterionLine ? `${padVisibleRight(palette.muted('Criterion'), 8)} ${palette.accent(criterionLine)}` : '',
      `${padVisibleRight(palette.muted('Stage'), 8)} ${palette.primary(stageSpinner)} ${palette.muted(
        clipInline(stageText, width - 22)
      )}${stageAge ? ` ${palette.muted('•')} ${palette.accent(stageAge)}` : ''}`,
      elapsed
        ? `${padVisibleRight(palette.muted(i18n.t('Durée', 'Elapsed')), 8)} ${palette.accent(elapsed)}`
        : ''
    ].filter(Boolean);

    const timeW = 6;
    const typeW = 10;
    const msgW = Math.max(18, width - 2 - (timeW + typeW + 6));
    const feedHeader =
      `${palette.muted(padVisibleRight('Time', timeW))} ` +
      `${palette.muted(padVisibleRight('Type', typeW))} ` +
      `${palette.muted(padVisibleRight('Message', msgW))}`;

    const feedLines = [feedHeader, palette.muted('─'.repeat(Math.min(width - 2, visibleLen(feedHeader))))];
    const now = nowMs();
    const formatAge = (at) => {
      const s = Math.max(0, Math.round((now - at) / 1000));
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${mm}:${ss}`;
    };
    for (const row of feed.slice(-feedMax)) {
      const age = formatAge(row.at);
      const type = row.kind;
      const msg = clipInline(row.message, msgW);
      feedLines.push(
        `${palette.muted(padVisibleRight(age, timeW))} ` +
          `${kindColor(type)(padVisibleRight(type, typeW))} ` +
          `${padVisibleRight(msg, msgW)}`
      );
    }

    const decisionLines = [];
    if (lastDecision) {
      const status = lastDecision.status;
      let statusColor = palette.muted;
      if (status === 'Conform') statusColor = palette.ok;
      if (status === 'Not conform') statusColor = palette.error;
      if (status === 'Non applicable') statusColor = palette.muted;
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

    const chromeWarning = chromeAutomationWarningLines({ i18n, mcpMode });
    const panels = [
      drawPanel({
        title: i18n.t('Progress', 'Progress'),
        lines: progressLines,
        width,
        borderColor: palette.muted
      }),
      ...(chromeWarning
        ? [
            drawPanel({
              title: i18n.t('Chrome permissions', 'Chrome permissions'),
              lines: chromeWarning,
              width,
              borderColor: palette.warn
            })
          ]
        : []),
      drawPanel({
        title: i18n.t('Codex feed', 'Codex feed'),
        lines: feedLines,
        width,
        borderColor: palette.muted
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

  return {
    async onStart({ pages, criteriaCount, codexModel, mcpMode: mcpModeFromCli, auditMode: mode }) {
      totalPages = pages;
      totalCriteria = criteriaCount;
      auditMode = mode || 'mcp';
      mcpMode = mcpModeFromCli || '';
      auditStartAt = nowMs();
      const headline = 'RGAA Website Auditor';
      const criteriaLabel = i18n.t(`${criteriaCount} critères`, `${criteriaCount} criteria`);
      const subtitle = i18n.t(
        `Audit piloté par MCP • ${criteriaLabel} • Pages FR`,
        `MCP-driven audit • ${criteriaLabel} • French pages`
      );
      const credit = 'Aurélien Lewin <aurelien.lewin@osf.digital>';

      const animation = chalkAnimation.karaoke(headline, 1.2);
      await new Promise((resolve) => setTimeout(resolve, 900));
      animation.stop();

      const glowLine = gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(
        '━'.repeat(42)
      );
      const title = boxen(
        `${gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(headline)}\n` +
          `${palette.muted(subtitle)}\n` +
          `${palette.muted(credit)}\n` +
          `${glowLine}`,
        { padding: 1, borderStyle: 'double', borderColor: 'magenta' }
      );
      console.log(title);
      const modelLabel = codexModel ? `Codex model: ${codexModel}` : 'Codex model: (default)';
      const mcpLabel = mcpModeFromCli ? `MCP mode: ${mcpModeFromCli}` : 'MCP mode: (default)';
      const modeLabel = `Snapshot mode: ${auditMode}`;
      const session = boxen(
        `${palette.muted('Session')}\n` +
          `${palette.muted(i18n.t('Pages', 'Pages'))}      ${chalk.bold(String(pages))}\n` +
          `${palette.muted(i18n.t('Critères', 'Criteria'))}   ${chalk.bold(String(criteriaCount))}\n` +
          `${palette.muted(modelLabel)}\n` +
          `${palette.muted(mcpLabel)}\n` +
          `${palette.muted(modeLabel)}`,
        { padding: 1, borderStyle: 'round', borderColor: 'cyan' }
      );
      console.log(session);
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
      render();
    },

    onPageStart({ index, url }) {
      currentPageIndex = index;
      currentUrl = url;
      pageDone = 0;
      pageStartAt = nowMs();
      stageStartAt = 0;
      stageLabel = i18n.t('Starting page', 'Starting page');
      pushFeed('page', `Page ${index + 1}/${totalPages}: ${url}`);
      render();
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

    onPageError({ url, error }) {
      const message = String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').trim();
      const clipped = message.length > 220 ? `${message.slice(0, 217)}…` : message;
      pushFeed('error', `Page failed: ${clipped}`);
      stageLabel = `Error: ${clipped}`;
      render();
    },

    onChecksStart() {
      startStage('Running checks');
    },

    onChecksEnd() {
      endStage('Checks');
    },

    onAIStart({ criterion }) {
      const critText = `${criterion.id} ${criterion.title}`.slice(0, 60);
      currentCriterion = { id: criterion.id, title: criterion.title };
      startStage(`AI thinking ${critText}`);
      pushFeed('thinking', `${criterion.id} ${criterion.title}`.slice(0, 140));
    },

    onAIStage({ label }) {
      if (!label || isNoiseAiMessage(label)) return;
      startStage(label);
      pushFeed('stage', label, { replaceLastIfSameKind: false });
    },

    onAILog({ message }) {
      const cleaned = normalizeAiMessage(message).replace(/\s+/g, ' ').trim();
      if (!cleaned || isNoiseAiMessage(cleaned)) return;
      const clipped = cleaned.slice(0, 64);
      if (clipped) {
        if (clipped !== lastAILog) {
          lastAILog = clipped;
          pushFeed('progress', clipped, { replaceLastIfSameKind: true });
          stageLabel = i18n.t('Codex is thinking…', 'Codex is thinking…');
          render();
        }
      }
    },

    onCriterion({ criterion, evaluation }) {
      const statusLabel = evaluation.status || '';
      const critText = `${criterion.id} ${criterion.title}`.slice(0, 120);
      const rationale = evaluation.ai?.rationale || '';
      overallDone += 1;
      pageDone += 1;
      lastDecision = { status: statusLabel, crit: critText, rationale };
      decisions.push({
        status: statusLabel,
        crit: critText,
        rationale
      });
      pushFeed('decision', `${criterion.id} ${statusLabel}${rationale ? ` • ${rationale}` : ''}`);
      stageLabel = i18n.t('Waiting for next criterion…', 'Waiting for next criterion…');
      render();
    },

    onPageEnd({ index, url, counts }) {
      const totalElapsed = pageStartAt ? nowMs() - pageStartAt : 0;
      const score = counts.C + counts.NC === 0 ? 0 : counts.C / (counts.C + counts.NC);
      pushFeed(
        'page',
        `Page ${index + 1}/${totalPages} summary: C ${counts.C}, NC ${counts.NC}, NA ${counts.NA}, Score ${formatPercent(
          score
        )}, Time ${totalElapsed}ms`
      );
      // Keep details in the live table to avoid fighting with cursor-based rendering.
      render();
    },

    onDone({ outPath, globalScore, counts, errors }) {
      stopTicking();
      if (isGuided) {
        renderer.stop({ keepBlock: false });
      } else {
        renderer.stop({ keepBlock: true });
      }

      const col = (label, value, color) =>
        `${palette.muted(label.padEnd(16))}${color(value)}`;
      const summary = [
        col('Conform', String(counts.C), palette.ok),
        col('Not conform', String(counts.NC), palette.error),
        col('Non applicable', String(counts.NA), palette.muted),
        col('Errors', String(counts.ERR || 0), palette.error),
        col('Score', formatPercent(globalScore), palette.accent)
      ].join('\n');

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
        process.stdout.write('\x1b[2J\x1b[0;0H');
      }
      const line = formatProgressStatus({
        totalPages,
        totalCriteria,
        overallDone,
        pageDone,
        currentPageIndex,
        i18n
      });
      process.stdout.write(`${line}\n`);
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
  let totalCriteria = 0;
  let totalPages = 0;
  let overallDone = 0;
  let pageDone = 0;
  let lastAILog = '';
  let pulseTimer = null;
  let pulseLabel = '';
  let pulseDots = 0;
  let pageStartAt = 0;
  let stageStartAt = 0;
  let auditMode = 'mcp';

  const stopPulse = () => {
    if (pulseTimer) clearInterval(pulseTimer);
    pulseTimer = null;
    pulseLabel = '';
    pulseDots = 0;
  };

  const startPulse = (label) => {
    stopPulse();
    pulseLabel = label;
    pulseDots = 0;
    pulseTimer = setInterval(() => {
      if (!pageBar) return;
      pulseDots = (pulseDots + 1) % 4;
      const dots = '.'.repeat(pulseDots);
      pageBar.update(null, { crit: `${palette.muted(pulseLabel + dots)}` });
    }, 400);
    if (typeof pulseTimer.unref === 'function') pulseTimer.unref();
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

  return {
    async onStart({ pages, criteriaCount, codexModel, mcpMode, auditMode: mode }) {
      totalPages = pages;
      totalCriteria = criteriaCount;
      auditMode = mode || 'mcp';
      const headline = 'RGAA Website Auditor';
      const criteriaLabel = i18n.t(`${criteriaCount} critères`, `${criteriaCount} criteria`);
      const subtitle = i18n.t(
        `Audit piloté par MCP • ${criteriaLabel} • Pages FR`,
        `MCP-driven audit • ${criteriaLabel} • French pages`
      );
      const credit = 'Aurélien Lewin <aurelien.lewin@osf.digital>';

      const animation = chalkAnimation.karaoke(headline, 1.2);
      await new Promise((resolve) => setTimeout(resolve, 900));
      animation.stop();

      const glowLine = gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(
        '━'.repeat(42)
      );
      const title = boxen(
        `${gradientString(['#22d3ee', '#a78bfa', '#f472b6']).multiline(headline)}\n` +
          `${palette.muted(subtitle)}\n` +
          `${palette.muted(credit)}\n` +
          `${glowLine}`,
        { padding: 1, borderStyle: 'double', borderColor: 'magenta' }
      );
      console.log(title);
      const modelLabel = codexModel ? `Codex model: ${codexModel}` : 'Codex model: (default)';
      const mcpLabel = mcpMode ? `MCP mode: ${mcpMode}` : 'MCP mode: (default)';
      const modeLabel = `Snapshot mode: ${auditMode}`;
      const session = boxen(
        `${palette.muted('Session')}\n` +
          `${palette.muted(i18n.t('Pages', 'Pages'))}      ${chalk.bold(String(pages))}\n` +
          `${palette.muted(i18n.t('Critères', 'Criteria'))}   ${chalk.bold(String(criteriaCount))}\n` +
          `${palette.muted(modelLabel)}\n` +
          `${palette.muted(mcpLabel)}\n` +
          `${palette.muted(modeLabel)}`,
        { padding: 1, borderStyle: 'round', borderColor: 'cyan' }
      );
      console.log(session);
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
      pageBar = bars.create(totalCriteria, 0, {
        label: palette.accent(i18n.t('Page', 'Page')),
        crit: ''
      });
    },

    onPageStart({ index, url }) {
      currentPageIndex = index;
      if (pageBar) pageBar.update(0, { crit: '' });
      pageDone = 0;
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
    },

    onAIStart({ criterion }) {
      if (!pageBar) return;
      const critText = `${criterion.id} ${criterion.title}`.slice(0, 60);
      startStage(`AI thinking ${critText}`);
      pageBar.update(null, { crit: `${palette.accent('AI thinking')} ${critText}` });
      logAILine('thinking', `${criterion.id} ${criterion.title}`.slice(0, 80));
    },

    onAIStage({ label }) {
      if (!label || isNoiseAiMessage(label)) return;
      startStage(label);
      if (pageBar) pageBar.update(null, { crit: palette.muted(label) });
      const line = `${palette.muted('•')} ${palette.muted(label)}`;
      if (typeof bars.log === 'function') bars.log(line);
      else console.log(line);
    },

    onAILog({ message }) {
      if (!pageBar) return;
      const cleaned = normalizeAiMessage(message).replace(/\s+/g, ' ').trim();
      if (!cleaned || isNoiseAiMessage(cleaned)) return;
      const clipped = cleaned.slice(0, 64);
      if (clipped) {
        stopPulse();
        pageBar.update(null, { crit: `${palette.accent('AI')} ${clipped}` });
        if (clipped !== lastAILog) {
          lastAILog = clipped;
          logAILine('progress', clipped);
        }
      }
    },

    onCriterion({ criterion, evaluation }) {
      const statusLabel = evaluation.status || '';
      let statusColor = palette.muted;
      if (statusLabel === 'Conform') statusColor = palette.ok;
      if (statusLabel === 'Not conform') statusColor = palette.error;
      if (statusLabel === 'Non applicable') statusColor = palette.muted;
      if (statusLabel === 'Error') statusColor = palette.error;

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

    onPageEnd({ index, url, counts }) {
      stopPulse();
      const totalElapsed = pageStartAt ? nowMs() - pageStartAt : 0;
      const score = counts.C + counts.NC === 0 ? 0 : counts.C / (counts.C + counts.NC);
      const header = `${palette.muted('Page summary')} ${palette.muted(`#${index + 1}`)}`;
      const line1 =
        `${palette.ok(`C ${counts.C}`)}  ` +
        `${palette.error(`NC ${counts.NC}`)}  ` +
        `${palette.muted(`NA ${counts.NA}`)}  ` +
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

    onDone({ outPath, globalScore, counts, errors }) {
      stopPulse();
      if (overallBar) overallBar.update(totalPages * totalCriteria);
      if (pageBar) pageBar.update(totalCriteria);
      bars.stop();

      const col = (label, value, color) =>
        `${palette.muted(label.padEnd(16))}${color(value)}`;
      const summary = [
        col('Conform', String(counts.C), palette.ok),
        col('Not conform', String(counts.NC), palette.error),
        col('Non applicable', String(counts.NA), palette.muted),
        col('Errors', String(counts.ERR || 0), palette.error),
        col('Score', formatPercent(globalScore), palette.accent)
      ].join('\n');

      console.log(
        boxen(summary, {
          padding: 1,
          borderStyle: 'double',
          borderColor: counts.ERR ? 'red' : 'green',
          title: 'Audit summary'
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
        process.stdout.write('\x1b[2J\x1b[0;0H');
      }
      const line = formatProgressStatus({
        totalPages,
        totalCriteria,
        overallDone,
        pageDone,
        currentPageIndex,
        i18n
      });
      process.stdout.write(`${line}\n`);
    },

    onError(message) {
      stopPulse();
      if (spinner.isSpinning) spinner.fail(message);
      else console.error(palette.error(message));
    }
  };
}

function createPlainReporter(options = {}) {
  const i18n = getI18n(normalizeReportLang(options.lang));
  let totalCriteria = 0;
  let totalPages = 0;
  let overallDone = 0;
  let pageDone = 0;
  let currentPageIndex = -1;
  let lastAILog = '';
  let pageStartAt = 0;
  let auditStartAt = 0;
  let auditMode = 'mcp';
  let mcpMode = '';

  const line = (label, value = '') =>
    console.log(`${palette.muted(label)}${value ? ` ${value}` : ''}`);

  return {
    async onStart({ pages, criteriaCount, codexModel, mcpMode: mcpModeFromCli, auditMode: mode }) {
      totalPages = pages;
      totalCriteria = criteriaCount;
      auditMode = mode || 'mcp';
      mcpMode = mcpModeFromCli || '';
      auditStartAt = nowMs();
      line('RGAA Website Auditor');
      line(i18n.t('Pages:', 'Pages:'), String(pages));
      line(i18n.t('Criteria:', 'Criteria:'), String(criteriaCount));
      line('Codex model:', codexModel || '(default)');
      line('MCP mode:', mcpModeFromCli || '(default)');
      line('Snapshot mode:', auditMode);
      const chromeWarning = chromeAutomationWarningLines({ i18n, mcpMode });
      if (chromeWarning) {
        for (const msg of chromeWarning) line(msg);
      }
      line(i18n.t('Launching Chrome…', 'Launching Chrome…'));
    },

    onChromeReady() {
      line(i18n.t('Chrome ready. Auditing pages…', 'Chrome ready. Auditing pages…'));
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

    onChecksStart() {
      line(i18n.t('Stage:', 'Stage:'), 'Running checks');
    },

    onChecksEnd() {
      line(i18n.t('Stage:', 'Stage:'), 'Checks done');
    },

    onAIStart({ criterion }) {
      line('Codex', `thinking ${criterion.id} ${criterion.title}`);
    },

    onAIStage({ label }) {
      if (label && !isNoiseAiMessage(label)) line('Codex', label);
    },

    onAILog({ message }) {
      const cleaned = normalizeAiMessage(message).replace(/\s+/g, ' ').trim();
      if (!cleaned || isNoiseAiMessage(cleaned)) return;
      const friendly = humanizeCodexFeedMessage(cleaned, i18n);
      const clipped = friendly.slice(0, 120);
      if (clipped !== lastAILog) {
        lastAILog = clipped;
        line('Codex', clipped);
      }
    },

    onCriterion({ criterion, evaluation }) {
      const status = evaluation.status || '';
      const rationale = evaluation.ai?.rationale ? ` • ${evaluation.ai.rationale}` : '';
      overallDone += 1;
      pageDone += 1;
      line(i18n.t('Result:', 'Result:'), `${criterion.id} ${status}${rationale}`);
    },

    onPageEnd({ index, url, counts }) {
      const totalElapsed = pageStartAt ? nowMs() - pageStartAt : 0;
      const score = counts.C + counts.NC === 0 ? 0 : counts.C / (counts.C + counts.NC);
      line(
        i18n.t('Page summary:', 'Page summary:'),
        `${index + 1}/${totalPages} C ${counts.C} NC ${counts.NC} NA ${counts.NA} Score ${formatPercent(
          score
        )} Time ${totalElapsed}ms • ${url}`
      );
    },

    onDone({ outPath, globalScore, counts, errors }) {
      line(i18n.t('Audit summary:', 'Audit summary:'), '');
      line('Conform:', String(counts.C));
      line('Not conform:', String(counts.NC));
      line('Non applicable:', String(counts.NA));
      line('Errors:', String(counts.ERR || 0));
      line('Score:', formatPercent(globalScore));
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
        process.stdout.write('\x1b[2J\x1b[0;0H');
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
