import { authorizedForecastJob } from '@/lib/job-auth';
import { captureWindow, evaluateForecast, makeForecast, pendingForecasts, saveForecast, saveForecastResult } from '@/lib/forecast-store';
import { getMarketDatabase, getMarketSnapshot, getSectorHistory } from '@/lib/market-repository';
import { latestCompletedTradeDate, MARKET_INDEXES, SECTORS, US_SECTORS } from '@/lib/market';
import { localClock, sessionClose, sessionForCode } from '@/lib/market-calendar';

export async function POST(request: Request) {
  if (!await authorizedForecastJob(request)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  let input: { code?: string; mode?: string };
  try { input = await request.json(); }
  catch { return Response.json({ error: '无效 JSON' }, { status: 400 }); }
  if (!input || typeof input.code !== 'string' || ![...SECTORS, ...US_SECTORS, ...MARKET_INDEXES].some(item => item.code === input.code)
    || (input.mode !== undefined && input.mode !== 'capture' && input.mode !== 'evaluate')) return Response.json({ error: '无效代码或模式' }, { status: 400 });
  const code = input.code;
  const now = new Date();
  const window = captureWindow(code, now);
  if (input.mode !== 'evaluate' && !window.eligible) return Response.json({ status: 'SKIPPED', message: window.message });
  try {
    const db = await getMarketDatabase();
    const session = sessionForCode(code);
    let snapshot = await getMarketSnapshot();
    const clock = localClock(session, new Date(snapshot.updatedAt));
    if (input.mode !== 'evaluate' && (clock.dateKey !== window.decisionDate || clock.minutes < sessionClose(session, window.decisionDate) + 20)) snapshot = await getMarketSnapshot(true);
    const sector = [...snapshot.sectors, ...snapshot.usSectors, ...snapshot.indexes].find(item => item.code === code)!;
    const history = await getSectorHistory(sector, input.mode === 'evaluate' ? 250 : 60);
    if (input.mode === 'evaluate') {
      const pending = await pendingForecasts(db, code, latestCompletedTradeDate(session, now));
      let evaluated = 0;
      for (const record of pending) {
        const result = evaluateForecast(record, history.rows, history.meta.source);
        if (result && await saveForecastResult(db, result)) evaluated++;
      }
      return Response.json({ status: 'OK', evaluated, pending: pending.length - evaluated });
    }
    const record = makeForecast(snapshot, sector, history.rows, history.meta.source, now);
    if (!record || history.meta.status !== 'FRESH') return Response.json({ status: 'SKIPPED', message: '行情或历史未达到可核验留档条件' });
    return Response.json({ status: await saveForecast(db, record) ? 'SAVED' : 'EXISTS', id: record.id });
  } catch (error) {
    console.error('[forecast-job]', error instanceof Error ? error.message : 'unknown');
    return Response.json({ error: '预测留档或评估暂时不可用' }, { status: 503 });
  }
}
