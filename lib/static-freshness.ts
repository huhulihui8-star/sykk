import type { DashboardSector } from './market';

export function expireStaticQuote<T extends DashboardSector>(item: T, now: number): T {
  const age = now - Date.parse(item.freshness.quoteTime);
  if (Number.isFinite(age) && age >= 0 && age < 86_400_000) return item;
  return { ...item, dataAvailable: false, nextSessionDirection: null, nextSessionUpPct: null,
    nextSessionDownPct: null, change: 0, upCount: 0, downCount: 0, flatCount: 0,
    momentum5d: null, mainNetInflow: null, mainNetInflowPct: null,
    freshness: { ...item.freshness, dataStatus: 'STALE', delayLevel: 'STALE' } };
}
