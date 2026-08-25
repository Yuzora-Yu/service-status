import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe, evolveStatus, looksLikeDailyLimit, nextJstReset } from '../scripts/status-core.mjs';

const base = {
  status:'operational', reason:'', message:'', resumeAt:'',
  updatedAt:'2026-08-25T06:00:00.000Z', lastCheckedAt:'2026-08-25T06:00:00.000Z',
  monitor:{ consecutiveFailures:0, lastHttpStatus:200, lastProbeKind:'healthy' }
};

const deepHealthy = {
  httpStatus:200,
  body:'{"ok":true,"worker":true,"durableObject":true}',
  json:{ok:true,worker:true,durableObject:true},
  expectedOrigin:'https://yu-zora.com',
  corsAllowedOrigin:'https://yu-zora.com'
};

test('detects Cloudflare 1027 and HTTP 429', () => {
  assert.equal(looksLikeDailyLimit(500, '<h1>Error 1027</h1>'), true);
  assert.equal(looksLikeDailyLimit(429, ''), true);
  assert.equal(looksLikeDailyLimit(503, 'temporary'), false);
});

test('deep health requires Worker, Durable Object, and the production CORS origin', () => {
  assert.equal(classifyProbe(deepHealthy).kind, 'healthy');
  assert.equal(classifyProbe({ ...deepHealthy, corsAllowedOrigin:'https://example.com' }).kind, 'cors-failure');
  assert.equal(classifyProbe({ ...deepHealthy, httpStatus:503, json:{ok:false,worker:true,durableObject:false} }).kind, 'backend-failure');
  assert.equal(classifyProbe({ ...deepHealthy, json:{ok:true} }).kind, 'failure');
  assert.equal(classifyProbe({ httpStatus:0, error:'timeout', expectedOrigin:'https://yu-zora.com', corsAllowedOrigin:'' }).kind, 'failure');
});

test('one generic failure degrades, second stops service on a 30-minute schedule', () => {
  const now = Date.parse('2026-08-25T06:40:00Z');
  const probe = { kind:'failure', httpStatus:503 };
  const one = evolveStatus({ previous:base, probe, nowMs:now }).service;
  assert.equal(one.status, 'degraded');
  const two = evolveStatus({ previous:one, probe, nowMs:now+30*60*1000 }).service;
  assert.equal(two.status, 'outage');
  assert.equal(two.reason, 'unreachable');
});

test('CORS and Durable Object failures stop publication immediately', () => {
  const now = Date.parse('2026-08-25T06:40:00Z');
  assert.equal(evolveStatus({ previous:base, probe:{kind:'cors-failure',httpStatus:200}, nowMs:now }).service.reason, 'cors_misconfigured');
  assert.equal(evolveStatus({ previous:base, probe:{kind:'backend-failure',httpStatus:503}, nowMs:now }).service.reason, 'matchmaking_unavailable');
});

test('daily limit resumes at next 09:05 JST', () => {
  const now = Date.parse('2026-08-25T06:40:00Z'); // 15:40 JST
  const result = evolveStatus({ previous:base, probe:{kind:'daily-limit',httpStatus:500}, nowMs:now }).service;
  assert.equal(result.status, 'outage');
  assert.equal(result.reason, 'daily_limit');
  assert.equal(result.resumeAt, '2026-08-26T00:05:00.000Z');
  assert.equal(nextJstReset(now), Date.parse('2026-08-26T00:05:00.000Z'));
});

test('healthy check refreshes lastCheckedAt without changing statusChangedAt', () => {
  const now = Date.parse('2026-08-25T07:00:00Z');
  const result = evolveStatus({ previous:base, probe:{kind:'healthy',httpStatus:200}, nowMs:now });
  assert.equal(result.changed, false);
  assert.equal(result.service.updatedAt, base.updatedAt);
  assert.equal(result.service.lastCheckedAt, '2026-08-25T07:00:00.000Z');
});
