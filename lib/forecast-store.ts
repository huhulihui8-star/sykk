import type { MarketHistoryRow, MarketSnapshot, NextSessionDirection, SectorSnapshot } from './market.ts';
import { calendarCoverage, localClock, sessionClose, sessionForCode } from './market-calendar.ts';
import { isSessionTradeDate, nextTradeDate } from './market.ts';

export const FORECAST_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS forecast_archive (id TEXT PRIMARY KEY, sector_code TEXT NOT NULL, session TEXT NOT NULL, decision_date TEXT NOT NULL, target_date TEXT NOT NULL, captured_at TEXT NOT NULL, model_version TEXT NOT NULL, direction TEXT NOT NULL, baseline_direction TEXT, base_close REAL NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(sector_code, decision_date, model_version))',
  'CREATE TABLE IF NOT EXISTS forecast_results (forecast_id TEXT PRIMARY KEY, evaluated_at TEXT NOT NULL, target_date TEXT NOT NULL, actual_change REAL NOT NULL, actual_direction TEXT, model_hit INTEGER, baseline_hit INTEGER, source TEXT NOT NULL, FOREIGN KEY(forecast_id) REFERENCES forecast_archive(id))',
  'CREATE INDEX IF NOT EXISTS idx_forecast_archive_target_date ON forecast_archive(target_date)',
];

export function captureWindow(code: string, now = new Date()) {
  const session = sessionForCode(code);
  const clock = localClock(session, now);
  const close = sessionClose(session, clock.dateKey);
  const covered = calendarCoverage(session, clock.dateKey).covered;
  return { session, decisionDate: clock.dateKey, eligible: covered && isSessionTradeDate(session, clock.dateKey)
    && clock.minutes >= close + 20 && clock.minutes < close + 50,
    message: covered ? '收盘后第 20 至 50 分钟留档；超时不补写预测' : '日历未覆盖，暂停留档' };
}

export type ForecastRecord = {
  id: string; code: string; session: string; decisionDate: string; targetDate: string; capturedAt: string;
  modelVersion: string; direction: NextSessionDirection; baselineDirection: NextSessionDirection | null;
  baseClose: number; source: string; sector: SectorSnapshot; snapshotUpdatedAt: string;
  evidence: SectorSnapshot['evidence'];
  evidenceTime: string | null;
};

export function makeForecast(snapshot: MarketSnapshot, sector: SectorSnapshot, rows: MarketHistoryRow[], source: string, now = new Date()): ForecastRecord | null {
  const window = captureWindow(sector.code, now);
  const quoteClock = localClock(window.session, new Date(sector.freshness.quoteTime));
  const snapshotClock = localClock(window.session, new Date(snapshot.updatedAt));
  const targetDate = nextTradeDate(window.session, window.decisionDate);
  const base = rows.find(row => row.date === window.decisionDate);
  if (!window.eligible || !targetDate || !base || base.close <= 0 || !Number.isFinite(base.close)
    || !sector.dataAvailable || !sector.nextSessionDirection || sector.freshness.delayLevel === 'STALE'
    || quoteClock.dateKey !== window.decisionDate || snapshotClock.dateKey !== window.decisionDate
    || snapshotClock.minutes < sessionClose(window.session, window.decisionDate) + 20
    || Date.parse(snapshot.updatedAt) > now.getTime()) return null;
  const evidence = (snapshot.analysisEvidence ?? sector.evidence).filter(event => event.sectors.includes(sector.code));
  if (evidence.some(event => !Number.isFinite(Date.parse(event.publishedAt)) || Date.parse(event.publishedAt) > now.getTime())) return null;
  const version = snapshot.methodology.modelVersion;
  return { id: `${sector.code}:${window.decisionDate}:${version}`, code: sector.code, session: window.session,
    decisionDate: window.decisionDate, targetDate, capturedAt: now.toISOString(), modelVersion: version,
    direction: sector.nextSessionDirection,
    baselineDirection: base.change > 0 ? '上涨' : base.change < 0 ? '下跌' : null,
    baseClose: base.close, source, sector, evidence, snapshotUpdatedAt: snapshot.updatedAt,
    evidenceTime: evidence.map(event => new Date(event.publishedAt).toISOString()).sort().at(-1) ?? null };
}

export type ForecastResult = {
  forecastId: string; actualChange: number; actualDirection: NextSessionDirection | null;
  modelHit: boolean | null; baselineHit: boolean | null; source: string; targetDate: string;
};

/** Compare adjacent dates in the SAME fetched sequence: A-share synthetic levels rebase with each window. */
export function evaluateForecast(record: ForecastRecord, rows: MarketHistoryRow[], source: string): ForecastResult | null {
  if (source !== record.source) return null;
  const baseIndex = rows.findIndex(row => row.date === record.decisionDate);
  const base = rows[baseIndex];
  const target = rows[baseIndex + 1];
  if (!base || !target || target.date !== record.targetDate || base.close <= 0 || target.close <= 0) return null;
  const actualChange = ((target.close - base.close) / base.close) * 100;
  if (!Number.isFinite(actualChange)) return null;
  const actualDirection = actualChange > 0 ? '上涨' : actualChange < 0 ? '下跌' : null;
  return { forecastId: record.id, actualChange, actualDirection, targetDate: record.targetDate, source,
    modelHit: actualDirection ? record.direction === actualDirection : null,
    baselineHit: actualDirection && record.baselineDirection ? record.baselineDirection === actualDirection : null };
}

export async function saveForecast(db: D1Database, record: ForecastRecord) {
  const result = await db.prepare('INSERT INTO forecast_archive (id, sector_code, session, decision_date, target_date, captured_at, model_version, direction, baseline_direction, base_close, source, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(record.id, record.code, record.session, record.decisionDate, record.targetDate, record.capturedAt,
      record.modelVersion, record.direction, record.baselineDirection, record.baseClose, record.source, JSON.stringify(record)).run();
  return Boolean(result.meta.changes);
}

export async function pendingForecasts(db: D1Database, code: string, before: string) {
  const result = await db.prepare('SELECT a.payload FROM forecast_archive a LEFT JOIN forecast_results r ON r.forecast_id = a.id WHERE a.sector_code = ? AND a.target_date <= ? AND r.forecast_id IS NULL ORDER BY a.target_date DESC LIMIT 60').bind(code, before).all<{ payload: string }>();
  return (result.results ?? []).map(row => JSON.parse(row.payload) as ForecastRecord);
}

export async function saveForecastResult(db: D1Database, result: ForecastResult) {
  const saved = await db.prepare('INSERT INTO forecast_results (forecast_id, evaluated_at, target_date, actual_change, actual_direction, model_hit, baseline_hit, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(result.forecastId, new Date().toISOString(), result.targetDate, result.actualChange, result.actualDirection,
      result.modelHit === null ? null : Number(result.modelHit), result.baselineHit === null ? null : Number(result.baselineHit), result.source).run();
  return Boolean(saved.meta.changes);
}

export type ForecastSummaryGroup = {
  modelVersion: string; session: string; archived: number; predictedUp: number; predictedDown: number;
  evaluated: number; flat: number; validSamples: number; hitRate: number | null;
  baselineSamples: number; baselineHitRate: number | null; comparableHitRate: number | null;
};

export async function forecastSummary(db: D1Database) {
  const result = await db.prepare(`SELECT a.model_version AS modelVersion, a.session, COUNT(*) AS archived,
    SUM(CASE WHEN a.direction = '上涨' THEN 1 ELSE 0 END) AS predictedUp,
    SUM(CASE WHEN a.direction = '下跌' THEN 1 ELSE 0 END) AS predictedDown,
    COUNT(r.forecast_id) AS evaluated, SUM(CASE WHEN r.actual_direction IS NULL AND r.forecast_id IS NOT NULL THEN 1 ELSE 0 END) AS flat,
    COUNT(r.model_hit) AS validSamples, AVG(r.model_hit) AS hitRate,
    COUNT(r.baseline_hit) AS baselineSamples, AVG(r.baseline_hit) AS baselineHitRate,
    AVG(CASE WHEN r.baseline_hit IS NOT NULL THEN r.model_hit ELSE NULL END) AS comparableHitRate
    FROM forecast_archive a LEFT JOIN forecast_results r ON r.forecast_id = a.id GROUP BY a.model_version, a.session`).all<ForecastSummaryGroup>();
  return { groups: result.results ?? [], disclaimer: '固定时点留档后的方向评估；零涨跌单独统计。样本与命中率不代表真实概率，不自动调整模型。' };
}
