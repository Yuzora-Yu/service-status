const DAILY_LIMIT_PATTERNS = [
  /error\s*1027/i,
  /(?:code|error)["'\s:=]+1027/i,
  /daily\s+(?:request\s+)?limit/i,
  /daily_limit/i,
  /exceeded\s+allowed\s+volume\s+of\s+requests\s+in\s+durable\s+objects\s+free\s+tier/i
];

export function looksLikeDailyLimit(httpStatus, body = '') {
  if (Number(httpStatus) === 429) return true;
  return DAILY_LIMIT_PATTERNS.some(pattern => pattern.test(String(body)));
}

export function nextJstReset(nowMs, graceMinutes = 10) {
  const d = new Date(nowMs);
  // JST 09:00 = UTC 00:00. Recheck at 09:10 JST to allow for possible quota-reset propagation delay.
  let reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, graceMinutes, 0, 0);
  if (reset <= nowMs) reset += 24 * 60 * 60 * 1000;
  return reset;
}

export function normalizePrevious(payload, serviceKey) {
  const service = payload?.services?.[serviceKey];
  return service && typeof service === 'object' ? service : {
    status: 'operational', reason: '', message: '', resumeAt: '', updatedAt: '', lastCheckedAt: '',
    monitor: { consecutiveFailures: 0, lastHttpStatus: 0, lastProbeKind: '' }
  };
}

export function classifyProbe({
  httpStatus = 0,
  body = '',
  json = null,
  error = '',
  expectedOrigin = '',
  corsAllowedOrigin = ''
}) {
  const status = Number(httpStatus) || 0;
  if (looksLikeDailyLimit(status, body)) {
    return { kind: 'daily-limit', httpStatus: status };
  }

  const expected = String(expectedOrigin || '').trim();
  const allowed = String(corsAllowedOrigin || '').trim();
  // Missing CORS headers only prove a CORS problem when our endpoint itself answered normally
  // or explicitly rejected the Origin. Network/edge failures often have no CORS header at all.
  if (expected && (status === 200 || status === 403) && allowed !== expected && allowed !== '*') {
    return { kind: 'cors-failure', httpStatus: status, expectedOrigin: expected, corsAllowedOrigin: allowed };
  }

  if (status === 200 && json?.ok === true && json?.worker === true && json?.durableObject === true) {
    return { kind: 'healthy', httpStatus: 200 };
  }

  if (json && typeof json === 'object' && json.worker === true && json.durableObject === false) {
    return { kind: 'backend-failure', httpStatus: status };
  }

  return {
    kind: 'failure',
    httpStatus: status,
    error: String(error || '')
  };
}

function monitorFor(probe, consecutiveFailures) {
  return {
    consecutiveFailures,
    lastHttpStatus: probe.httpStatus || 0,
    lastProbeKind: probe.kind
  };
}

function withCheckTime(service, nowIso) {
  return { ...service, lastCheckedAt: nowIso };
}

export function evolveStatus({ previous, probe, nowMs }) {
  const nowIso = new Date(nowMs).toISOString();
  const prevFailures = Math.max(0, Number(previous?.monitor?.consecutiveFailures) || 0);
  const previousChangedAt = previous?.updatedAt || '';

  if (probe.kind === 'healthy') {
    const alreadyHealthy = previous?.status === 'operational' && prevFailures === 0 && previous?.reason === '';
    return {
      changed: !alreadyHealthy,
      service: {
        status: 'operational', reason: '', message: '', resumeAt: '',
        updatedAt: alreadyHealthy ? (previousChangedAt || nowIso) : nowIso,
        lastCheckedAt: nowIso,
        monitor: monitorFor(probe, 0)
      }
    };
  }

  if (probe.kind === 'daily-limit') {
    const prevResumeMs = Date.parse(previous?.resumeAt || '');
    const wasDailyLimit = previous?.reason === 'daily_limit';
    // First detection sleeps until the next JST 09:10. If the limit remains after that,
    // retry in 20 minutes instead of incorrectly sleeping for another whole day.
    const resumeMs = wasDailyLimit && Number.isFinite(prevResumeMs) && prevResumeMs <= nowMs
      ? nowMs + 20 * 60 * 1000
      : nextJstReset(nowMs);
    const resumeAt = new Date(resumeMs).toISOString();
    const sameState = wasDailyLimit && previous?.status === 'outage' && previous?.resumeAt === resumeAt;
    return {
      changed: !sameState,
      service: {
        status: 'outage',
        reason: 'daily_limit',
        message: '無料サーバーが本日の利用上限に達したため、オンライン対戦は利用停止中です。',
        resumeAt,
        updatedAt: sameState ? (previousChangedAt || nowIso) : nowIso,
        lastCheckedAt: nowIso,
        monitor: monitorFor(probe, 2)
      }
    };
  }

  if (probe.kind === 'cors-failure') {
    const sameState = previous?.status === 'outage' && previous?.reason === 'cors_misconfigured';
    return {
      changed: !sameState,
      service: {
        status: 'outage',
        reason: 'cors_misconfigured',
        message: 'オンライン対戦サーバーの接続設定に問題があるため、現在利用できません。',
        resumeAt: '',
        updatedAt: sameState ? (previousChangedAt || nowIso) : nowIso,
        lastCheckedAt: nowIso,
        monitor: monitorFor(probe, 1)
      }
    };
  }

  if (probe.kind === 'backend-failure') {
    const sameState = previous?.status === 'outage' && previous?.reason === 'durable_object_unavailable';
    return {
      changed: !sameState,
      service: {
        status: 'outage',
        reason: 'durable_object_unavailable',
        message: 'オンライン対戦のバックエンドを利用できないため、一時停止しています。',
        resumeAt: '',
        updatedAt: sameState ? (previousChangedAt || nowIso) : nowIso,
        lastCheckedAt: nowIso,
        monitor: monitorFor(probe, 1)
      }
    };
  }

  // With a 20-minute schedule, two generic failures are enough to stop publication.
  // A single timeout/network blip is only degraded to avoid false outages.
  const failures = Math.min(2, prevFailures + 1);
  const status = failures >= 2 ? 'outage' : 'degraded';
  const reason = failures >= 2 ? 'unreachable' : 'probe_failed';
  const message = failures >= 2
    ? 'オンライン対戦サーバーへ接続できないため、一時的に利用を停止しています。'
    : 'オンライン対戦サーバーが一時的に不安定です。';
  const sameState = previous?.status === status && previous?.reason === reason;
  return {
    changed: !sameState,
    service: withCheckTime({
      status, reason, message, resumeAt: '',
      updatedAt: sameState ? (previousChangedAt || nowIso) : nowIso,
      monitor: monitorFor(probe, failures)
    }, nowIso)
  };
}
