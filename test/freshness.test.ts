import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSector, SECTORS, historyFreshness, latestCompletedTradeDate, marketPhase, nextTradeDate, refreshSnapshotFreshness, sessionPhase, type MarketSnapshot, type QuoteFreshness } from '../lib/market.ts';
import { calendarCoverage } from '../lib/market-calendar.ts';
import { mergeSnapshotCoverage } from '../lib/market-repository.ts';

export function sampleSnapshot(now = new Date('2026-09-16T07:25:00Z')): MarketSnapshot {
  const freshness: QuoteFreshness = { quoteTime: now.toISOString(), receivedAt: now.toISOString(), source: 'verified', backupSource: '',
    delayLevel: 'LAST_CLOSE', isProxy: false, dataStatus: 'FRESH', marketPhase: 'CLOSED', outlookLabel: '下一交易日统计展望' };
  const sector = buildSector(SECTORS[0], [{ f14: SECTORS[0].name, f3: 1, f12: 'BK1000', f104: 8, f105: 2 }], [], 'CN', freshness);
  return { tradeDate: '2026-09-16', updatedAt: now.toISOString(), dataStatus: 'LIVE_PROXY', disclaimer: '',
    market: { positive: 0, cautious: 1, eventCount: 0 }, usMarket: { positive: 0, cautious: 0, eventCount: 0 },
    indexMarket: { positive: 0, cautious: 0, eventCount: 0 }, sectors: [sector], usSectors: [], indexes: [], events: [],
    freshness: { CN: freshness, US: freshness, INDEX: freshness }, providerStatus: [], proxyDisclosure: '',
    methodology: { newsWeight: 0.65, technicalWeight: 0.35, modelVersion: 'provider-split-direction-share-v10', modelStatus: 'fallback' } };
}

test('snapshot coverage uses original quote timestamp and never falls back beyond 24 hours', () => {
  const now = Date.parse('2026-09-16T07:25:00Z');
  const previous = sampleSnapshot(new Date(now - 86_400_000));
  previous.updatedAt = new Date(now).toISOString();
  const current = sampleSnapshot(new Date(now));
  current.sectors[0].dataAvailable = false;
  assert.equal(mergeSnapshotCoverage(current, previous, now).sectors[0].dataAvailable, false);
  previous.sectors[0].freshness.quoteTime = new Date(now - 86_399_999).toISOString();
  const fallback = mergeSnapshotCoverage(current, previous, now).sectors[0];
  assert.equal(fallback.dataAvailable, true);
  assert.equal(fallback.freshness.delayLevel, 'STALE');
  assert.equal(fallback.freshness.quoteTime, previous.sectors[0].freshness.quoteTime);
});

test('expired full snapshot clears direction while preserving evidence and recomputes phases', () => {
  const snapshot = sampleSnapshot();
  const expired = refreshSnapshotFreshness(snapshot, new Date('2026-09-17T08:00:00Z'));
  assert.equal(expired.sectors[0].dataAvailable, false);
  assert.equal(expired.sectors[0].nextSessionDirection, null);
  assert.equal(expired.sectors[0].nextSessionUpPct, null);
  assert.equal(snapshot.sectors[0].dataAvailable, true);
  const live = refreshSnapshotFreshness(snapshot, new Date('2026-09-17T02:00:00Z'));
  assert.equal(live.sectors[0].freshness.marketPhase, 'TRADING');
});

test('index aggregate includes Japan when CN and US are closed', () => {
  const now = new Date('2026-09-16T00:30:00Z');
  assert.equal(marketPhase('CN', now), 'CLOSED');
  assert.equal(marketPhase('US', now), 'CLOSED');
  assert.equal(marketPhase('INDEX', now), 'TRADING');
  assert.equal(sessionPhase('JP', new Date('2026-09-16T06:20:00Z')), 'TRADING');
  assert.equal(sessionPhase('JP', new Date('2026-09-16T03:00:00Z')), 'BREAK');
});

test('six added official calendars, half days, and unknown years are handled explicitly', () => {
  for (const [session, date] of [['HK','2026-04-07'],['JP','2026-09-22'],['KR','2026-06-03'],['TW','2026-02-12'],['DE','2026-12-24'],['UK','2026-12-28']] as const) {
    assert.equal(sessionPhase(session, new Date(`${date}T${session === 'DE' || session === 'UK' ? '12' : '02'}:00:00Z`)), 'CLOSED');
  }
  assert.equal(sessionPhase('HK', new Date('2026-02-16T04:15:00Z')), 'CLOSED');
  assert.equal(sessionPhase('HK', new Date('2026-09-16T04:30:00Z')), 'BREAK');
  assert.equal(sessionPhase('UK', new Date('2026-12-24T13:00:00Z')), 'CLOSED');
  assert.equal(calendarCoverage('HK', '2027-01-04').covered, false);
  assert.equal(nextTradeDate('CN', '2026-12-31'), null);
  assert.equal(nextTradeDate('JP', '2026-09-18'), '2026-09-24');
});

test('history freshness uses last completed trade date, including holidays and local midnight', () => {
  assert.equal(latestCompletedTradeDate('CN', new Date('2026-10-07T08:00:00Z')), '2026-09-30');
  assert.equal(historyFreshness('IDX-JP-NIKKEI', '2026-09-18', new Date('2026-09-22T07:00:00Z')).fresh, true);
  assert.equal(historyFreshness('IDX-JP-NIKKEI', '2026-04-21', new Date('2026-09-22T07:00:00Z')).fresh, false);
  assert.equal(historyFreshness('IDX-US-SP500', '2026-09-15', new Date('2026-09-16T01:00:00Z')).fresh, true);
  assert.equal(historyFreshness('IDX-HK-HSI', '2027-01-04', new Date('2027-01-04T09:00:00Z')).fresh, false);
});
