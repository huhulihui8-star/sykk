import { forecastSummary } from '@/lib/forecast-store';
import { getMarketDatabase } from '@/lib/market-repository';

export async function GET() {
  try {
    return Response.json(await forecastSummary(await getMarketDatabase()), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ error: '预测评估持久数据库暂时不可用' }, { status: 503 });
  }
}
