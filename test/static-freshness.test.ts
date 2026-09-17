import test from 'node:test';
import assert from 'node:assert/strict';
import { expireStaticQuote } from '../lib/static-freshness.ts';
import type { DashboardSector } from '../lib/market.ts';
const now = Date.parse('2026-09-17T00:00:00Z');
const quote = (age: number) => ({ dataAvailable: true, nextSessionDirection: '上涨', nextSessionUpPct: 60, nextSessionDownPct: 40,
  freshness: { quoteTime: new Date(now - age).toISOString() } }) as DashboardSector;
test('static quotes retain direction before expiry and clear it at 24 hours', () => {
  const fresh = quote(86_399_999);
  assert.equal(expireStaticQuote(fresh, now), fresh);
  const expired = expireStaticQuote(quote(86_400_000), now);
  assert.equal(expired.dataAvailable, false);
  assert.equal(expired.nextSessionDirection, null);
  assert.equal(expired.nextSessionUpPct, null);
  assert.equal(expired.freshness.quoteTime, quote(86_400_000).freshness.quoteTime);
});
test('future or invalid static quote timestamps cannot retain direction', () => {
  assert.equal(expireStaticQuote(quote(-1), now).dataAvailable, false);
  const invalid = quote(0); invalid.freshness.quoteTime = 'unknown';
  assert.equal(expireStaticQuote(invalid, now).nextSessionDirection, null);
});
