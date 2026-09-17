import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SectorDetail } from '@/components/sector-detail';
import { MARKET_INDEXES, SECTORS, US_SECTORS } from '@/lib/market';
import { getMarketSnapshot, getSectorHistory } from '@/lib/market-repository';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const sector = [...SECTORS, ...US_SECTORS, ...MARKET_INDEXES].find(
    (item) => item.code === code,
  );
  const title = sector
    ? `${sector.name}公开信息分析｜最强分析师`
    : '行业信息详情｜最强分析师';
  return {
    title,
    description: sector
      ? `${sector.name}的当日新闻、企业财报公告与公开行情分析，以及下一交易日行业信息展望。`
      : 'A 股与美股行业公开信息分析',
    openGraph: { title, images: [] },
    twitter: { title, images: [] },
  };
}

export default async function SectorPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const snapshot = await getMarketSnapshot();
  const sector = [
    ...snapshot.sectors,
    ...snapshot.usSectors,
    ...snapshot.indexes,
  ].find((item) => item.code === code);
  // 未知代码必须 404，不能静默回退到第一个行业（否则任意乱码 URL 都会返回 200）。
  if (!sector) notFound();
  const definition = [...SECTORS, ...US_SECTORS, ...MARKET_INDEXES].find(
    (item) => item.code === sector.code,
  );
  const history = await getSectorHistory(sector, 60);
  return (
    <SectorDetail
      sector={sector}
      history={history.rows}
      historyMeta={history.meta}
      snapshot={snapshot}
      leaders={definition?.leaders ?? [sector.leadingStock]}
    />
  );
}
