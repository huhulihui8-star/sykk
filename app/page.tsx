import { MarketDashboard } from '@/components/market-dashboard';
import { toDashboardSnapshot } from '@/lib/market';
import { getMarketSnapshot } from '@/lib/market-repository';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ region?: string }>;
}) {
  const { region } = await searchParams;
  const initialRegion =
    region === 'US' || region === 'INDEX' || region === 'CN' ? region : 'CN';
  const snapshot = await getMarketSnapshot();
  return (
    <MarketDashboard
      initialData={toDashboardSnapshot(snapshot)}
      initialRegion={initialRegion}
    />
  );
}
