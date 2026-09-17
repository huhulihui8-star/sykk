import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSector, SECTORS, type MarketSnapshot } from '../lib/market.ts';
import { FORECAST_SCHEMA, captureWindow, evaluateForecast, forecastSummary, makeForecast, pendingForecasts, saveForecast, saveForecastResult } from '../lib/forecast-store.ts';
import { d1Adapter } from '../lib/local-database.ts';

function snapshot(): MarketSnapshot {
  const now = '2026-09-16T07:25:00Z';
  const freshness = { quoteTime: now, receivedAt: now, source: 'real', backupSource: '', delayLevel: 'LAST_CLOSE' as const,
    isProxy: false, dataStatus: 'FRESH' as const, marketPhase: 'CLOSED' as const, outlookLabel: '下一交易日统计展望' as const };
  const sector = buildSector(SECTORS[0], [{ f14: SECTORS[0].name, f12: 'BK1000', f3: 1 }], [], 'CN', freshness);
  const summary = { positive: 1, cautious: 0, eventCount: 0 };
  return { tradeDate: '2026-09-16', updatedAt: now, dataStatus: 'LIVE', disclaimer: '', market: summary, usMarket: summary, indexMarket: summary,
    sectors: [sector], usSectors: [], indexes: [], events: [], freshness: { CN: freshness, US: freshness, INDEX: freshness },
    providerStatus: [], proxyDisclosure: '', methodology: { newsWeight: 0.65, technicalWeight: 0.35, modelVersion: 'v10', modelStatus: 'fallback' } };
}
const baseRows = [{ date: '2026-09-16', close: 1000, change: 1, volume: 10, breadth: 50 }];
function record() {
  const data = snapshot();
  return makeForecast(data, data.sectors[0], baseRows, 'same proxy', new Date(data.updatedAt))!;
}

test('fixed capture windows skip before close, missed windows, holidays, and unknown years', () => {
  assert.equal(captureWindow('801010', new Date('2026-09-16T07:19:00Z')).eligible, false);
  assert.equal(captureWindow('801010', new Date('2026-09-16T07:20:00Z')).eligible, true);
  assert.equal(captureWindow('801010', new Date('2026-09-16T07:50:00Z')).eligible, false);
  assert.equal(captureWindow('IDX-JP-NIKKEI', new Date('2026-09-22T07:00:00Z')).eligible, false);
  assert.equal(captureWindow('IDX-HK-HSI', new Date('2027-01-04T08:40:00Z')).eligible, false);
});

test('archive rejects stale quotes, incomplete history, and future evidence', () => {
  const data = snapshot();
  assert.ok(record());
  assert.equal(makeForecast(data, data.sectors[0], [], 'same proxy', new Date(data.updatedAt)), null);
  data.analysisEvidence = [{ id: 'future', title: 'future', summary: '', source: 'real', publishedAt: '2026-09-16T08:00:00Z', url: '', tone: '正向', kind: '国内经济', region: 'CN', sectors: [data.sectors[0].code] }];
  assert.equal(makeForecast(data, data.sectors[0], baseRows, 'same proxy', new Date(data.updatedAt)), null);
  data.analysisEvidence = [];
  data.sectors[0].freshness.delayLevel = 'STALE';
  assert.equal(makeForecast(data, data.sectors[0], baseRows, 'same proxy', new Date(data.updatedAt)), null);
  data.sectors[0].freshness.delayLevel = 'LAST_CLOSE';
  data.updatedAt = '2026-09-16T07:10:00Z';
  assert.equal(makeForecast(data, data.sectors[0], baseRows, 'same proxy', new Date('2026-09-16T07:25:00Z')), null);
});

test('same sequence proxy returns are valid despite rebasing; source switches and missing target are excluded', () => {
  const prediction = record();
  const rows = [{ ...baseRows[0], close: 2000 }, { ...baseRows[0], date: '2026-09-17', close: 2020 }];
  const result = evaluateForecast(prediction, rows, 'same proxy')!;
  assert.ok(Math.abs(result.actualChange - 1) < 1e-9);
  assert.equal(result.baselineHit, true);
  assert.equal(evaluateForecast(prediction, rows, 'different proxy'), null);
  assert.equal(evaluateForecast(prediction, rows.slice(0,1), 'same proxy'), null);
  const flat = evaluateForecast(prediction, [rows[0], { ...rows[1], close: 2000 }], 'same proxy')!;
  assert.equal(flat.actualDirection, null);
  assert.equal(flat.modelHit, null);
  assert.equal(flat.baselineHit, null);
});

test('SQLite archive survives reopening, duplicate capture stays immutable, evaluation is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analyst-forecast-test-'));
  let sqlite = new DatabaseSync(join(directory,'test.sqlite'));
  try {
    const db = d1Adapter(sqlite);
    await db.batch(FORECAST_SCHEMA.map(sql => db.prepare(sql)));
    const prediction = record();
    assert.equal(await saveForecast(db, prediction), true);
    assert.equal(await saveForecast(db, { ...prediction, baseClose: 999 }), false);
    sqlite.close();
    sqlite = new DatabaseSync(join(directory,'test.sqlite'));
    const reopened = d1Adapter(sqlite);
    const pending = await pendingForecasts(reopened, prediction.code, prediction.targetDate);
    assert.equal(pending[0].baseClose, 1000);
    const result = evaluateForecast(prediction, [baseRows[0], { ...baseRows[0], date: prediction.targetDate, close: 1010 }], prediction.source)!;
    assert.equal(await saveForecastResult(reopened, result), true);
    assert.equal(await saveForecastResult(reopened, result), false);
    assert.equal((await pendingForecasts(reopened, prediction.code, prediction.targetDate)).length, 0);
    const summary = (await forecastSummary(reopened)).groups[0];
    assert.equal(summary.archived, 1);
    assert.equal(summary.validSamples, 1);
    assert.equal(summary.baselineSamples, 1);
    assert.equal(summary.baselineHitRate, 1);
  } finally {
    sqlite.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'analyst-forecast-test-')));
    await rm(directory, { recursive: true });
  }
});
