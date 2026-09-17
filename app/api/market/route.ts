import { getMarketSnapshot } from '@/lib/market-repository';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const force = url.searchParams.get('refresh') === '1';
  try {
    const snapshot = await getMarketSnapshot(force);
    return Response.json(snapshot, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return Response.json(
      {
        error: '行情数据暂时不可用',
        detail: error instanceof Error ? error.message : 'unknown',
      },
      { status: 503 },
    );
  }
}
