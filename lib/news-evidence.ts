import type { NewsEvent } from './market';

export const NEWS_HALF_LIFE_HOURS = 24;
export const NEWS_MAX_AGE_HOURS = 168;
export function newsTimeWeight(event: NewsEvent, now: number) {
  const age = (now - Date.parse(event.publishedAt)) / 3_600_000;
  if (!Number.isFinite(age) || age < 0 || age >= NEWS_MAX_AGE_HOURS) return 0;
  return 2 ** (-age / NEWS_HALF_LIFE_HOURS);
}
function titleKey(title: string) {
  return title.toLowerCase().replace(/&(?:apos|quot|amp|lt|gt);/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}
function canonicalUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of url.searchParams.keys()) if (/^(utm_|fbclid$|gclid$)/.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    // Homepages/live streams are not unique event identifiers.
    if (url.pathname === '/' || /\/live\/global\/?$/.test(url.pathname)) return '';
    return url.href;
  } catch { return ''; }
}
function similarTitle(a: string, b: string) {
  if (a === b && a.length > 0) return true;
  if (Math.min(a.length, b.length) < 20 || a.match(/\d+/g)?.join(',') !== b.match(/\d+/g)?.join(',')) return false;
  const grams = (value: string) => new Set(Array.from({ length: value.length - 2 }, (_, i) => value.slice(i, i + 3)));
  const x = grams(a), y = grams(b);
  const overlap = [...x].filter(value => y.has(value)).length;
  return 2 * overlap / (x.size + y.size) >= 0.95;
}
/** Earliest known publication survives syndication; reposts cannot rejuvenate an event. */
export function prepareNewsEvidence(events: NewsEvent[], now: number) {
  const clusters: Array<{ title: string; url: string; event: NewsEvent }> = [];
  for (const event of [...events].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) {
    if (!newsTimeWeight(event, now)) continue;
    const title = titleKey(event.title), url = canonicalUrl(event.url);
    const existing = clusters.find(item => (url && item.url === url) || similarTitle(title, item.title));
    if (existing) {
      // Conflicting reports neutralize the event instead of selecting the favorable report.
      existing.event = { ...existing.event, tone: existing.event.tone === event.tone ? event.tone : '中性',
        sectors: [...new Set([...existing.event.sectors, ...event.sectors])] };
    } else clusters.push({ title, url, event: { ...event } });
  }
  return clusters.map(item => item.event).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}
