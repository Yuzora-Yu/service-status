import fs from 'node:fs/promises';
import process from 'node:process';
import { classifyProbe, evolveStatus, normalizePrevious } from './status-core.mjs';

const file = process.env.STATUS_FILE || 'status.json';
const serviceKey = process.env.SERVICE_KEY || 'cloudflare-matchmaking';
const healthUrl = process.env.MATCHMAKING_HEALTH_URL || 'https://kanji-crash-match-server.rikai-829.workers.dev/health';
const timeoutMs = Math.max(1000, Number(process.env.PROBE_TIMEOUT_MS) || 8000);
const nowMs = Date.now();

const raw = await fs.readFile(file, 'utf8');
const payload = JSON.parse(raw);
const previous = normalizePrevious(payload, serviceKey);

// A confirmed daily limit cannot recover before resumeAt, so do not burn requests checking it.
const resumeMs = Date.parse(previous.resumeAt || '');
if (previous.reason === 'daily_limit' && Number.isFinite(resumeMs) && nowMs < resumeMs) {
  console.log(`Daily limit active; skipping Worker probe until ${previous.resumeAt}`);
  process.exit(0);
}

let probeInput = { httpStatus: 0, body: '', json: null, error: '' };
try {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(healthUrl, {
      method: 'GET',
      headers: { accept: 'application/json,text/plain;q=0.9,*/*;q=0.1' },
      redirect: 'manual',
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  const body = await response.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  probeInput = { httpStatus: response.status, body, json, error: '' };
} catch (error) {
  probeInput.error = error instanceof Error ? error.message : String(error);
}

const probe = classifyProbe(probeInput);
const { changed, service } = evolveStatus({ previous, probe, nowMs });
console.log(`Probe result: ${probe.kind}; HTTP ${probe.httpStatus || 0}; changed=${changed}`);

if (!changed) process.exit(0);

payload.schemaVersion = 1;
payload.updatedAt = service.updatedAt;
payload.services ||= {};
payload.services[serviceKey] = service;
await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(`Updated ${file}: ${service.status} / ${service.reason || 'ok'}`);
