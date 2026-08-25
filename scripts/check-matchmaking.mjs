import fs from 'node:fs/promises';
import process from 'node:process';
import { classifyProbe, evolveStatus, normalizePrevious } from './status-core.mjs';

const file = process.env.STATUS_FILE || 'status.json';
const serviceKey = process.env.SERVICE_KEY || 'cloudflare-matchmaking';
const healthUrl = process.env.MATCHMAKING_HEALTH_URL || 'https://kanji-crash-match-server.rikai-829.workers.dev/health/deep';
const expectedOrigin = process.env.MATCHMAKING_EXPECTED_ORIGIN || 'https://yu-zora.com';
const timeoutMs = Math.max(1000, Number(process.env.PROBE_TIMEOUT_MS) || 8000);
const nowMs = Date.now();

function setOutput(key, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  return fs.appendFile(process.env.GITHUB_OUTPUT, `${key}=${String(value)}\n`, 'utf8');
}

const raw = await fs.readFile(file, 'utf8');
const payload = JSON.parse(raw);
const hadPublishedService = !!(payload?.services && Object.prototype.hasOwnProperty.call(payload.services, serviceKey));
const previous = normalizePrevious(payload, serviceKey);

// A confirmed daily limit cannot recover before resumeAt, so do not burn requests checking it.
const resumeMs = Date.parse(previous.resumeAt || '');
if (previous.reason === 'daily_limit' && Number.isFinite(resumeMs) && nowMs < resumeMs) {
  console.log(`Daily limit active; skipping Worker probe until ${previous.resumeAt}`);
  await setOutput('probed', 'false');
  await setOutput('status_changed', 'false');
  await setOutput('probe_kind', 'skipped-daily-limit');
  process.exit(0);
}

let probeInput = {
  httpStatus: 0,
  body: '',
  json: null,
  error: '',
  expectedOrigin,
  corsAllowedOrigin: ''
};
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(healthUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json,text/plain;q=0.9,*/*;q=0.1',
        origin: expectedOrigin
      },
      redirect: 'manual',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  probeInput = {
    httpStatus: response.status,
    body,
    json,
    error: '',
    expectedOrigin,
    corsAllowedOrigin: response.headers.get('access-control-allow-origin') || ''
  };
} catch (error) {
  probeInput.error = error instanceof Error ? error.message : String(error);
}

const probe = classifyProbe(probeInput);
const { changed, service } = evolveStatus({ previous, probe, nowMs });
const statusChanged = changed || !hadPublishedService;
console.log(`Probe result: ${probe.kind}; HTTP ${probe.httpStatus || 0}; statusChanged=${statusChanged}`);
if (probe.kind === 'cors-failure') {
  console.log(`CORS expected=${probe.expectedOrigin} actual=${probe.corsAllowedOrigin || '(missing)'}`);
}

function newestIso(...values) {
  let best = '';
  let bestMs = -Infinity;
  for (const value of values) {
    const ms = Date.parse(value || '');
    if (Number.isFinite(ms) && ms > bestMs) { bestMs = ms; best = value; }
  }
  return best;
}

payload.schemaVersion = 1;
payload.updatedAt = newestIso(payload.updatedAt, service.updatedAt, service.lastCheckedAt) || service.updatedAt || service.lastCheckedAt || '';
payload.lastCheckedAt = newestIso(payload.lastCheckedAt, service.lastCheckedAt) || service.lastCheckedAt || payload.lastCheckedAt || '';
payload.services ||= {};
payload.services[serviceKey] = service;
// Always write the just-checked timestamp for the Pages artifact. The workflow only commits
// this file when the published status itself changes, so routine checks do not create commit noise.
await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

await setOutput('probed', 'true');
await setOutput('status_changed', statusChanged ? 'true' : 'false');
await setOutput('probe_kind', probe.kind);
console.log(`Prepared ${file}: ${service.status} / ${service.reason || 'ok'}; checked=${service.lastCheckedAt}`);
