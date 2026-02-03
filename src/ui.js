import chalk from 'chalk';
import boxen from 'boxen';
import ora from 'ora';
import chalkAnimation from 'chalk-animation';
import gradientString from 'gradient-string';
import { MultiBar, Presets } from 'cli-progress';
import { getI18n, normalizeReportLang } from './i18n.js';

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

export function createReporter(options = {}) {
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
  let lastAILog = '';
  let pulseTimer = null;
  let pulseLabel = '';
  let pulseDots = 0;
  let pageStartAt = 0;
  let stageStartAt = 0;
  let auditMode = 'cdp';

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

  const nowMs = () => {
    if (typeof process.hrtime === 'function' && process.hrtime.bigint) {
      return Number(process.hrtime.bigint() / 1000000n);
    }
    return Date.now();
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
      auditMode = mode || 'cdp';
      const headline = 'RGAA Website Auditor';
      const criteriaLabel = i18n.t(`${criteriaCount} critères`, `${criteriaCount} criteria`);
      const subtitle =
        auditMode === 'mcp'
          ? i18n.t(
              `Audit piloté par MCP • ${criteriaLabel} • Pages FR`,
              `MCP-driven audit • ${criteriaLabel} • French pages`
            )
          : i18n.t(
              `Audit piloté par CDP • ${criteriaLabel} • Pages FR`,
              `CDP-driven audit • ${criteriaLabel} • French pages`
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
      spinner.text =
        auditMode === 'mcp'
          ? i18n.t('Démarrage de Chrome (MCP)…', 'Starting MCP Chrome…')
          : i18n.t('Lancement de Chrome…', 'Launching Chrome…');
    },

    onChromeReady() {
      spinner.text =
        auditMode === 'mcp'
          ? i18n.t('Chrome MCP prêt. Audit des pages…', 'MCP Chrome ready. Auditing pages…')
          : i18n.t('Chrome prêt. Audit des pages…', 'Chrome ready. Auditing pages…');
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
      if (pageBar) pageBar.update(0, { crit: '' });
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
        pageBar.update(
          null,
          { crit: palette.muted(`${label}: ${durationMs}ms`) }
        );
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
      if (!label) return;
      startStage(label);
      if (pageBar) pageBar.update(null, { crit: palette.muted(label) });
      const line = `${palette.muted('•')} ${palette.muted(label)}`;
      if (typeof bars.log === 'function') bars.log(line);
      else console.log(line);
    },

    onAILog({ message }) {
      if (!pageBar) return;
      const cleaned = String(message || '')
        .replace(/^Codex:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
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

    onError(message) {
      stopPulse();
      if (spinner.isSpinning) spinner.fail(message);
      else console.error(palette.error(message));
    }
  };
}
