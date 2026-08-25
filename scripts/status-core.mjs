const DAILY_LIMIT_PATTERNS = [
  /error\s*1027/i,
  /(?:code|error)["'\s:=]+1027/i,
  /daily\s+(?:request\s+)?limit/i,
  /daily_limit/i
];

export function looksLikeDailyLimit(httpStatus, body = '') {
  if (Number(httpStatus) === 429) return true;
  return DAILY_LIMIT_PATTERNS.some(pattern => pattern.test(String(body)));
}

export function nextJstReset(nowMs, graceMinutes = 5) {
  const d = new Date(nowMs);
  // JST 09:00 = UTC 00:00. A small grace period avoids racing the reset.
  let reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, graceMinutes, 0, 0);
  if (reset <= nowMs) reset += 24 * 60 * 60 * 1000;
  return reset;
}

export function normalizePrevious(payload, serviceKey) {
  const service = payload?.services?.[serviceKey];
  return service && typeof service === 'object' ? service : {
    status: 'operational', reason: '', message: '', resumeAt: '', updatedAt: '',
    monitor: { consecutiveFailures: 0, lastHttpStatus: 0 }
  };
}

export function classifyProbe({ httpStatus = 0, body = '', json = null, error = '' }) {
  if (looksLikeDailyLimit(httpStatus, body)) {
    return { kind: 'daily-limit', httpStatus: Number(httpStatus) || 0 };
  }
  if (Number(httpStatus) === 200 && json?.ok === true) {
    return { kind: 'healthy', httpStatus: 200 };
  }
  return {
    kind: 'failure',
    httpStatus: Number(httpStatus) || 0,
    error: String(error || '')
  };
}

export function evolveStatus({ previous, probe, nowMs, heartbeatMs = 10 * 60 * 1000 }) {
  const nowIso = new Date(nowMs).toISOString();
  const prevFailures = Math.max(0, Number(previous?.monitor?.consecutiveFailures) || 0);
  const prevUpdatedMs = Date.parse(previous?.updatedAt || '');

  if (probe.kind === 'healthy') {
    if (previous?.status === 'operational' && prevFailures === 0 && previous?.reason === '') {
      return { changed: false, service: previous };
    }
    return {
      changed: true,
      service: {
        status: 'operational', reason: '', message: '', resumeAt: '', updatedAt: nowIso,
        monitor: { consecutiveFailures: 0, lastHttpStatus: 200 }
      }
    };
  }

  if (probe.kind === 'daily-limit') {
    const prevResumeMs = Date.parse(previous?.resumeAt || '');
    const wasDailyLimit = previous?.reason === 'daily_limit';
    // First detection sleeps until the next JST 09:05. If the limit remains after that,
    // retry in 10 minutes instead of incorrectly sleeping for another whole day.
    const resumeMs = wasDailyLimit && Number.isFinite(prevResumeMs) && prevResumeMs <= nowMs
      ? nowMs + 10 * 60 * 1000
      : nextJstReset(nowMs);
    const resumeAt = new Date(resumeMs).toISOString();
    const sameWindow = wasDailyLimit && previous?.status === 'outage' && previous?.resumeAt === resumeAt;
    return {
      changed: !sameWindow,
      service: sameWindow ? previous : {
        status: 'outage',
        reason: 'daily_limit',
        message: '無料サーバーが本日の利用上限に達したため、フレンド対戦は利用停止中です。',
        resumeAt,
        updatedAt: nowIso,
        monitor: { consecutiveFailures: 3, lastHttpStatus: probe.httpStatus || 0 }
      }
    };
  }

  const failures = Math.min(3, prevFailures + 1);
  const status = failures >= 3 ? 'outage' : 'degraded';
  const reason = failures >= 3 ? 'unreachable' : 'probe_failed';
  const message = failures >= 3
    ? 'フレンド対戦サーバーへ接続できないため、一時的に利用を停止しています。'
    : 'フレンド対戦サーバーが一時的に不安定です。';
  const sameState = previous?.status === status && previous?.reason === reason && prevFailures === failures;
  const heartbeatDue = !Number.isFinite(prevUpdatedMs) || prevUpdatedMs + heartbeatMs <= nowMs;
  if (sameState && !heartbeatDue) return { changed: false, service: previous };
  return {
    changed: true,
    service: {
      status, reason, message, resumeAt: '', updatedAt: nowIso,
      monitor: { consecutiveFailures: failures, lastHttpStatus: probe.httpStatus || 0 }
    }
  };
}
