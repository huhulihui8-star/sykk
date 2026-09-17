import { getMarketSnapshot, getSectorHistory } from '@/lib/market-repository';

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> },
) {
  const { code } = await context.params;
  const range = new URL(request.url).searchParams.get('range') ?? '60d';
  const days = range === '20d' ? 20 : range === '1y' ? 250 : 60;
  const snapshot = await getMarketSnapshot();
  const sector = [
    ...snapshot.sectors,
    ...snapshot.usSectors,
    ...snapshot.indexes,
  ].find((item) => item.code === code);
  if (!sector) return Response.json({ error: '未找到该行业' }, { status: 404 });
  const history = await getSectorHistory(sector, days);
  return Response.json({
    tradeDate: snapshot.tradeDate,
    updatedAt: snapshot.updatedAt,
    dataStatus: snapshot.dataStatus,
    disclaimer: snapshot.disclaimer,
    freshness: sector.freshness,
    providerStatus: snapshot.providerStatus,
    proxyDisclosure: snapshot.proxyDisclosure,
    sector,
    history: history.rows,
    historyMeta: history.meta,
  });
}
