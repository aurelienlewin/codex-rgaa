const DEFAULT_PUSH_MS = 2000;
const DEFAULT_KEY = 'rgaa-monitor:state';

function normalizeStatus(status) {
  const raw = String(status || '').trim();
  if (!raw) return '';
  if (raw === 'C' || raw === 'Conform') return 'C';
  if (raw === 'NC' || raw === 'Not conform') return 'NC';
  if (raw === 'NA' || raw === 'Non applicable') return 'NA';
  if (raw === 'Review' || raw === 'REVIEW') return 'REVIEW';
  if (raw === 'Error' || raw === 'ERR') return 'ERR';
  return raw;
}

function formatElapsed(ms) {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  const seconds = Math.floor(total / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function computeScore(counts) {
  const denom = (counts.C || 0) + (counts.NC || 0);
  if (!denom) return 0;
  return (counts.C || 0) / denom;
}

function getUpstashConfig() {
  return {
    url: process.env.AUDIT_UPSTASH_REST_URL || process.env.UPSTASH_REDIS_REST_URL || '',
    token: process.env.AUDIT_UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
    key: process.env.AUDIT_UPSTASH_KEY || DEFAULT_KEY
  };
}

async function upstashSet(state) {
  const { url, token, key } = getUpstashConfig();
  if (!url || !token) return;
  const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(state || {})
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash error ${res.status}: ${text}`);
  }
}

function shouldEnable() {
  const raw = String(process.env.AUDIT_REMOTE_STATUS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function pushFeed(feed, entry) {
  if (!entry) return;
  feed.push(entry);
  while (feed.length > 30) feed.shift();
}

export function createRemoteStatusReporter({ reporter }) {
  if (!shouldEnable()) return { reporter, stop: () => {} };

  const counts = { C: 0, NC: 0, NA: 0, REVIEW: 0, ERR: 0 };
  const totals = {
    pagesTotal: 0,
    criteriaTotal: 0,
    overallDone: 0,
    overallTotal: 0,
    completedPages: 0,
    inProgressCriteria: 0
  };
  const feed = [];
  const stage = { event: '', details: '' };
  const secondPass = { total: 0, done: 0, detail: '' };

  let startAt = 0;
  let lastError = '';
  let currentPageUrl = '';
  let currentCriteriaDone = 0;
  let statusState = 'idle';
  let statusMessage = 'Idle';

  let lastPushAt = 0;
  const minPushMs = Number(process.env.AUDIT_REMOTE_PUSH_MS || DEFAULT_PUSH_MS) || DEFAULT_PUSH_MS;

  const buildStatus = () => {
    const elapsedMs = startAt ? Date.now() - startAt : 0;
    return {
      state: statusState,
      message: statusMessage,
      elapsedMs,
      elapsedLabel: formatElapsed(elapsedMs),
      error: lastError
    };
  };

  const buildPayload = () => ({
    totals: {
      ...totals,
      overallDone: totals.completedPages * (totals.criteriaTotal || 0) + (currentCriteriaDone || 0),
      overallTotal: (totals.pagesTotal || 0) * (totals.criteriaTotal || 0),
      inProgressCriteria: currentCriteriaDone
    },
    counts: { ...counts },
    score: computeScore(counts),
    currentPageUrl,
    stage: { ...stage },
    secondPass: { ...secondPass },
    feed: [...feed],
    status: buildStatus()
  });

  const push = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastPushAt < minPushMs) return;
    lastPushAt = now;
    try {
      await upstashSet(buildPayload());
    } catch {}
  };

  const wrapped = {
    ...reporter,
    onStart(payload) {
      totals.pagesTotal = Number(payload?.pages || 0);
      totals.criteriaTotal = Number(payload?.criteriaCount || 0);
      startAt = Date.now() - Number(payload?.resumeState?.elapsedMs || 0);
      statusState = 'running';
      statusMessage = 'Running';
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'stage', message: 'Audit started' });
      push(true);
      reporter.onStart?.(payload);
    },
    onPageStart(payload) {
      currentPageUrl = payload?.url || '';
      currentCriteriaDone = 0;
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'page', message: `Page start ${currentPageUrl}` });
      push();
      reporter.onPageStart?.(payload);
    },
    onPageNavigateStart(payload) {
      stage.event = 'page-load';
      stage.details = '';
      push();
      reporter.onPageNavigateStart?.(payload);
    },
    onPageNetworkIdle(payload) {
      stage.event = 'page-idle';
      stage.details = payload?.timedOut ? 'Network idle (timed out)' : 'Network idle';
      push();
      reporter.onPageNetworkIdle?.(payload);
    },
    onSnapshotStart(payload) {
      stage.event = 'snapshot-start';
      stage.details = '';
      push();
      reporter.onSnapshotStart?.(payload);
    },
    onSnapshotEnd(payload) {
      stage.event = 'snapshot-end';
      stage.details = payload?.durationMs ? `${payload.durationMs}ms` : '';
      push();
      reporter.onSnapshotEnd?.(payload);
    },
    onEnrichmentStart(payload) {
      stage.event = 'enrich-start';
      stage.details = '';
      push();
      reporter.onEnrichmentStart?.(payload);
    },
    onEnrichmentEnd(payload) {
      stage.event = 'enrich-end';
      stage.details = payload?.ok === false ? 'error' : 'ok';
      push();
      reporter.onEnrichmentEnd?.(payload);
    },
    onEnrichmentReady(payload) {
      stage.event = 'enrich-ready';
      stage.details = payload?.criteriaCount ? `${payload.criteriaCount} criteria` : '';
      push();
      reporter.onEnrichmentReady?.(payload);
    },
    onInferenceStart(payload) {
      stage.event = 'inference-start';
      stage.details = payload?.criteriaCount ? `${payload.criteriaCount} criteria` : '';
      push();
      reporter.onInferenceStart?.(payload);
    },
    onInferenceSummary(payload) {
      stage.event = 'inference-summary';
      stage.details = '';
      push();
      reporter.onInferenceSummary?.(payload);
    },
    onInferenceEnd(payload) {
      stage.event = 'inference-end';
      stage.details = '';
      push();
      reporter.onInferenceEnd?.(payload);
    },
    onChecksStart(payload) {
      stage.event = 'checks-start';
      stage.details = '';
      push();
      reporter.onChecksStart?.(payload);
    },
    onChecksEnd(payload) {
      stage.event = 'checks-end';
      stage.details = '';
      push();
      reporter.onChecksEnd?.(payload);
    },
    onAIStart(payload) {
      stage.event = 'ai-start';
      stage.details = payload?.criterion?.id || '';
      push();
      reporter.onAIStart?.(payload);
    },
    onAIStage(payload) {
      stage.event = 'ai-stage';
      stage.details = payload?.label || '';
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'ai-stage', message: payload?.label || '' });
      push();
      reporter.onAIStage?.(payload);
    },
    onAILog(payload) {
      stage.event = 'ai-log';
      stage.details = '';
      const message = String(payload?.message || '').trim();
      if (message) {
        pushFeed(feed, { ts: new Date().toISOString(), kind: 'ai-log', message });
      }
      push();
      reporter.onAILog?.(payload);
    },
    onCriterion(payload) {
      const status = normalizeStatus(payload?.evaluation?.status);
      if (status === 'C') counts.C += 1;
      else if (status === 'NC') counts.NC += 1;
      else if (status === 'NA') counts.NA += 1;
      else if (status === 'REVIEW') counts.REVIEW += 1;
      else if (status === 'ERR') counts.ERR += 1;
      currentCriteriaDone += 1;
      pushFeed(feed, {
        ts: new Date().toISOString(),
        kind: 'criterion',
        message: `${payload?.criterion?.id || ''} ${payload?.evaluation?.status || ''}`.trim()
      });
      push();
      reporter.onCriterion?.(payload);
    },
    onCrossPageStart(payload) {
      secondPass.total = Number(payload?.total || 0);
      secondPass.done = 0;
      secondPass.detail = '';
      stage.event = 'cross-start';
      stage.details = '';
      push();
      reporter.onCrossPageStart?.(payload);
    },
    onCrossPageUpdate(payload) {
      if (Number.isFinite(payload?.total)) secondPass.total = payload.total;
      if (Number.isFinite(payload?.done)) secondPass.done = payload.done;
      stage.event = 'cross-update';
      stage.details = payload?.current?.id ? payload.current.id : '';
      push();
      reporter.onCrossPageUpdate?.(payload);
    },
    onCrossPageDecision(payload) {
      if (payload?.criterion?.id) {
        const status = payload?.evaluation?.status || '';
        const detail = `${payload.criterion.id}${status ? `:${status}` : ''}`;
        secondPass.detail = detail;
      }
      push();
      reporter.onCrossPageDecision?.(payload);
    },
    onCrossPageEnd(payload) {
      stage.event = 'cross-end';
      stage.details = '';
      push();
      reporter.onCrossPageEnd?.(payload);
    },
    onPause(payload) {
      const paused = Boolean(payload?.paused);
      statusState = paused ? 'paused' : 'running';
      statusMessage = paused ? 'Paused' : 'Running';
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'stage', message: paused ? 'Paused' : 'Resumed' });
      push(true);
      reporter.onPause?.(payload);
    },
    onPageEnd(payload) {
      totals.completedPages += 1;
      currentCriteriaDone = 0;
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'page', message: `Page done ${payload?.url || ''}` });
      push();
      reporter.onPageEnd?.(payload);
    },
    onPageError(payload) {
      lastError = String(payload?.error?.message || payload?.error || '');
      statusState = 'error';
      statusMessage = 'Error';
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'error', message: lastError });
      push(true);
      reporter.onPageError?.(payload);
    },
    onDone(payload) {
      const hasErrors =
        (payload?.errors?.pagesFailed || 0) > 0 || (payload?.errors?.aiFailed || 0) > 0;
      statusState = hasErrors ? 'done_with_errors' : 'done';
      statusMessage = hasErrors ? 'Done with errors' : 'Done';
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'stage', message: statusMessage });
      push(true);
      reporter.onDone?.(payload);
    },
    onError(payload) {
      lastError = String(payload || '');
      statusState = 'error';
      statusMessage = 'Error';
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'error', message: lastError });
      push(true);
      reporter.onError?.(payload);
    }
  };

  return { reporter: wrapped, stop: () => {} };
}
