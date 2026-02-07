const DEFAULT_PUSH_MS = 60000;
const DEFAULT_KEY = 'rgaa-monitor:state';
const INFO_PREFIX = '[remote]';
const ERROR_COOLDOWN_MS = 10000;
const CLEAR_ON_DONE_DELAY_MS = 5000;
const CLEAR_RETRY_ATTEMPTS = 5;
const CLEAR_RETRY_BASE_MS = 2000;
const CLEAR_RETRY_MAX_MS = 30000;

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

function logRemoteInfo(message) {
  if (process.stdout.isTTY && process.env.AUDIT_REMOTE_LOGS !== '1') return;
  console.log(`${INFO_PREFIX} ${message}`);
}

function logRemoteWarn(message) {
  if (process.stdout.isTTY && process.env.AUDIT_REMOTE_LOGS !== '1') return;
  console.warn(`${INFO_PREFIX} ${message}`);
}

function getCloudSyncConfig() {
  return {
    url: process.env.AUDIT_UPSTASH_REST_URL || process.env.UPSTASH_REDIS_REST_URL || '',
    token: process.env.AUDIT_UPSTASH_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
    key: process.env.AUDIT_UPSTASH_KEY || DEFAULT_KEY
  };
}

async function upstashDelete() {
  const { url, token, key } = getCloudSyncConfig();
  if (!url || !token) return;
  const res = await fetch(`${url}/del/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloud sync error ${res.status}: ${text}`);
  }
}

async function upstashSet(state) {
  const { url, token, key } = getCloudSyncConfig();
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
    throw new Error(`Cloud sync error ${res.status}: ${text}`);
  }
}

function shouldEnable() {
  const raw = String(process.env.AUDIT_REMOTE_STATUS || '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  return true;
}

function pushFeed(feed, entry) {
  if (!entry) return;
  feed.push(entry);
  while (feed.length > 30) feed.shift();
}

function notifyRemoteStatus(reporter, payload) {
  if (typeof reporter?.onRemoteStatus === 'function') {
    reporter.onRemoteStatus(payload);
  }
}

export function createRemoteStatusReporter({ reporter }) {
  if (!shouldEnable()) return { reporter, stop: () => {} };

  const { url, token, key } = getCloudSyncConfig();
  const configured = Boolean(url && token);
  let lastErrorAt = 0;
  let didLogSuccess = false;
  let clearPromise = null;
  let clearTimer = null;
  let clearAttempts = 0;
  let clearInProgress = false;
  let allowPush = true;

  if (!configured) {
    logRemoteWarn(
      'Remote status enabled but missing Cloud sync creds (AUDIT_UPSTASH_REST_URL/AUDIT_UPSTASH_REST_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN).'
    );
    notifyRemoteStatus(reporter, { state: 'missing', message: 'Missing cloud sync credentials' });
    return { reporter, stop: () => {} };
  }

  logRemoteInfo(`Remote status enabled. Cloud sync key: ${key}.`);
  notifyRemoteStatus(reporter, { state: 'enabled', message: `Cloud sync key: ${key}` });

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
  let startPayload = null;

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
    start: startPayload ? { ...startPayload } : null,
    paths: {
      resumePath: startPayload?.resumePath || '',
      logPath: startPayload?.logPath || ''
    },
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

  const clearRemote = async (reason = 'completion') => {
    if (clearInProgress) return clearPromise;
    clearInProgress = true;
    try {
      await upstashDelete();
      const message =
        reason === 'start'
          ? 'Cloud sync cleared before new audit.'
          : 'Cloud sync cleared after completion.';
      logRemoteInfo(message);
      notifyRemoteStatus(reporter, { state: 'cleared', message });
    } catch (err) {
      const msg = `Cloud sync clear failed: ${String(err?.message || err)}`;
      logRemoteWarn(msg);
      notifyRemoteStatus(reporter, { state: 'error', message: msg });
      if (clearAttempts < CLEAR_RETRY_ATTEMPTS) {
        clearAttempts += 1;
        const delay = Math.min(CLEAR_RETRY_BASE_MS * 2 ** (clearAttempts - 1), CLEAR_RETRY_MAX_MS);
        scheduleClear(reason, { delayMs: delay, resetAttempts: false });
      }
    } finally {
      clearInProgress = false;
    }
  };

  const scheduleClear = (reason, { delayMs = 0, resetAttempts = true } = {}) => {
    if (clearTimer) clearTimeout(clearTimer);
    if (resetAttempts) clearAttempts = 0;
    clearTimer = setTimeout(() => {
      clearPromise = clearRemote(reason);
    }, delayMs);
    if (typeof clearTimer.unref === 'function') clearTimer.unref();
  };

  const push = async (force = false) => {
    if (!allowPush) return;
    const now = Date.now();
    if (!force && now - lastPushAt < minPushMs) return;
    lastPushAt = now;
    try {
      const pendingClear = clearPromise;
      if (pendingClear) {
        try {
          await pendingClear;
        } catch {}
        if (clearPromise === pendingClear) clearPromise = null;
      }
      await upstashSet(buildPayload());
      if (!didLogSuccess) {
        didLogSuccess = true;
        logRemoteInfo('Cloud sync OK.');
        notifyRemoteStatus(reporter, { state: 'ok', message: 'Cloud sync OK' });
      }
    } catch (err) {
      const errorNow = Date.now();
      if (errorNow - lastErrorAt >= ERROR_COOLDOWN_MS) {
        lastErrorAt = errorNow;
        const msg = `Cloud sync failed: ${String(err?.message || err)}`;
        logRemoteWarn(msg);
        notifyRemoteStatus(reporter, { state: 'error', message: msg });
      }
    }
  };

  const wrapped = {
    ...reporter,
    onStart(payload) {
      didLogSuccess = false;
      lastError = '';
      lastErrorAt = 0;
      allowPush = true;
      clearAttempts = 0;
      startPayload = payload
        ? {
            pages: Number(payload.pages || 0),
            criteriaCount: Number(payload.criteriaCount || 0),
            codexModel: payload.codexModel || '',
            mcpMode: payload.mcpMode || '',
            auditMode: payload.auditMode || '',
            enrichmentEnabled: Boolean(payload.enrichmentEnabled),
            resumePath: payload.resumePath || '',
            logPath: payload.logPath || '',
            outDirName: payload.outDirName || '',
            startedAt: new Date().toISOString()
          }
        : null;
      if (clearTimer) {
        clearTimeout(clearTimer);
        clearTimer = null;
      }
      clearPromise = clearRemote('start');
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
      allowPush = false;
      scheduleClear('completion', { delayMs: CLEAR_ON_DONE_DELAY_MS });
      reporter.onDone?.(payload);
    },
    onError(payload) {
      lastError = String(payload || '');
      statusState = 'error';
      statusMessage = 'Error';
      pushFeed(feed, { ts: new Date().toISOString(), kind: 'error', message: lastError });
      push(true);
      allowPush = false;
      scheduleClear('error');
      reporter.onError?.(payload);
    }
  };

  const stop = () => {
    allowPush = false;
    scheduleClear('stop');
  };

  return { reporter: wrapped, stop };
}
