import { buildSector } from '../lib/market.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { newsTimeWeight, prepareNewsEvidence } from '../lib/news-evidence.ts';
import type { NewsEvent } from '../lib/market.ts';
const now = Date.parse('2026-09-17T08:00:00Z');
const event = (hours: number, overrides: Partial<NewsEvent> = {}): NewsEvent => ({ id: 'test', title: '企业发布季度报告利润增长百分之十', summary: '',
  source: 'test', publishedAt: new Date(now - hours * 3_600_000).toISOString(), url: 'https://example.com/article/1', tone: '正向', kind: '国内经济', region: 'CN', sectors: ['801080'], ...overrides });
test('news decays at 24 hours and excludes old, future, and unknown timestamps', () => {
  assert.equal(newsTimeWeight(event(0), now), 1);
  assert.equal(newsTimeWeight(event(24), now), 0.5);
  assert.equal(newsTimeWeight(event(168), now), 0);
  assert.equal(newsTimeWeight(event(-1), now), 0);
  assert.equal(newsTimeWeight(event(0, { publishedAt: '' }), now), 0);
});
test('syndicated events count once, keep earliest evidence time and union sectors', () => {
  const result = prepareNewsEvidence([event(1, { source: 'B', sectors: ['801010'] }), event(24, { source: 'A' })], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].publishedAt, event(24).publishedAt);
  assert.deepEqual(result[0].sectors.sort(), ['801010', '801080']);
});
test('tracking URLs deduplicate and contradictory copies are neutralized', () => {
  const result = prepareNewsEvidence([event(0), event(1, { title: '另一个媒体的报道', url: 'https://example.com/article/1?utm_source=x', tone: '负向' })], now);
  assert.equal(result.length, 1);
  assert.equal(result[0].tone, '中性');
});
test('different factual numbers and unrelated live stories remain separate', () => {
  const a = event(0, { title: '企业季度报告利润增长10%并宣布新增业务', url: 'https://example.com/live/global' });
  const b = event(0, { title: '企业季度报告利润增长20%并宣布新增业务', url: 'https://example.com/live/global' });
  assert.equal(prepareNewsEvidence([a, b], now).length, 2);
});

test('v11 sector scoring discounts old news and does not amplify syndication', () => {
  const definition = { code: '801080', name: '电子', keywords: [], leaders: [] };
  const boards = [{ f14: '电子', f3: 0, f10: 1, f104: 1, f105: 1 }];
  const freshness = { quoteTime: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), source: 'test', backupSource: '', delayLevel: 'LAST_CLOSE' as const, isProxy: false, dataStatus: 'FRESH' as const, marketPhase: 'CLOSED' as const, outlookLabel: '下一交易日统计展望' as const };
  const score = (events: NewsEvent[]) => buildSector(definition, boards, events, 'CN', freshness);
  assert.ok(score([event(0)]).newsScore > score([event(72)]).newsScore);
  assert.equal(score([event(0)]).newsScore, score([event(0), event(0, { source: 'copy', id: 'copy' })]).newsScore);
  assert.equal(score([event(-1)]).newsScore, 50);
  assert.equal(score([event(0, { publishedAt: '' })]).newsScore, 50);
  const noQuote = buildSector(definition, [], [event(0)], 'CN', freshness);
  assert.equal(noQuote.nextSessionDirection, null);
});

test('reposting cannot revive an event older than the scoring window', () => {
  assert.equal(prepareNewsEvidence([event(200), event(0, { source: 'repost' })], now).length, 0);
});
