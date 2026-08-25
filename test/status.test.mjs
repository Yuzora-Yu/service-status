import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProbe, evolveStatus, looksLikeDailyLimit, nextJstReset } from '../scripts/status-core.mjs';

const base = {
  status:'operational', reason:'', message:'', resumeAt:'', updatedAt:'2026-08-25T06:00:00.000Z',
  monitor:{ consecutiveFailures:0, lastHttpStatus:200 }
};

test('detects Cloudflare 1027 and HTTP 429', () => {
  assert.equal(looksLikeDailyLimit(500, '<h1>Error 1027</h1>'), true);
  assert.equal(looksLikeDailyLimit(429, ''), true);
  assert.equal(looksLikeDailyLimit(503, 'temporary'), false);
});

test('healthy response is operational', () => {
  assert.equal(classifyProbe({ httpStatus:200, body:'{"ok":true}', json:{ok:true} }).kind, 'healthy');
});

test('first two generic failures degrade, third stops service', () => {
  const now = Date.parse('2026-08-25T06:40:00Z');
  const probe = { kind:'failure', httpStatus:503 };
  const one = evolveStatus({ previous:base, probe, nowMs:now }).service;
  assert.equal(one.status, 'degraded');
  const two = evolveStatus({ previous:one, probe, nowMs:now+300000 }).service;
  assert.equal(two.status, 'degraded');
  const three = evolveStatus({ previous:two, probe, nowMs:now+600000 }).service;
  assert.equal(three.status, 'outage');
  assert.equal(three.reason, 'unreachable');
});

test('daily limit resumes at next 09:05 JST', () => {
  const now = Date.parse('2026-08-25T06:40:00Z'); // 15:40 JST
  const result = evolveStatus({ previous:base, probe:{kind:'daily-limit',httpStatus:500}, nowMs:now }).service;
  assert.equal(result.status, 'outage');
  assert.equal(result.reason, 'daily_limit');
  assert.equal(result.resumeAt, '2026-08-26T00:05:00.000Z');
  assert.equal(nextJstReset(now), Date.parse('2026-08-26T00:05:00.000Z'));
});

test('healthy state does not rewrite status every five minutes', () => {
  const result = evolveStatus({ previous:base, probe:{kind:'healthy',httpStatus:200}, nowMs:Date.now() });
  assert.equal(result.changed, false);
});
