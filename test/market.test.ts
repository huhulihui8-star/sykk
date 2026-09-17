import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  aggregateSectorSeries,
  buildSector,
  capPerSource,
  CN_SECTOR_THS_BOARDS,
  createHistory,
  DASHBOARD_EVENTS_PER_REGION,
  diversifyBySource,
  evidenceConfidence,
  freshestSeries,
  hasChinaMarker,
  informationToneFromScore,
  isForeignChinaAnalysis,
  isMarketSessionOpen,
  isQuoteMarketOpen,
  MARKET_INDEXES,
  marketCacheTtlMs,
  marketPhase,
  mentionsChineseCompany,
  mergeCurrentBreadth,
  nextSessionSignalFromScore,
  normalizeThsIndexVolume,
  parseSinaCnSeries,
  parseSinaUsSeries,
  parseThsBoardSeries,
  readCachedQuote,
  SECTORS,
  snapshotCacheTtlMs,
  THS_INDEX_CODES,
  toDashboardSnapshot,
  toneFor,
  US_SECTORS,
  weightedChinaEvidenceScore,
  type MarketSnapshot,
  type NewsEvent,
} from '../lib/market.ts';

test('申万 2021 一级行业完整且唯一', () => {
  assert.equal(SECTORS.length, 31);
  assert.equal(new Set(SECTORS.map((sector) => sector.code)).size, 31);
  assert.equal(new Set(SECTORS.map((sector) => sector.name)).size, 31);
});

test('美股 11 个 GICS 行业代理完整且唯一', () => {
  assert.equal(US_SECTORS.length, 11);
  assert.equal(new Set(US_SECTORS.map((sector) => sector.code)).size, 11);
  assert.ok(US_SECTORS.every((sector) => sector.code.startsWith('US-')));
});

test('国内外主流指数覆盖完整且唯一', () => {
  assert.ok(MARKET_INDEXES.length >= 12);
  assert.equal(
    new Set(MARKET_INDEXES.map((index) => index.code)).size,
    MARKET_INDEXES.length,
  );
  assert.ok(MARKET_INDEXES.some((index) => index.name === '沪深300'));
  assert.ok(MARKET_INDEXES.some((index) => index.name === '标普500'));
  for (const required of [
    '上证指数',
    '深证成指',
    '恒生指数',
    '道琼斯工业指数',
    '纳斯达克综合指数',
    '韩国KOSPI',
    '台湾加权指数',
    '日经225',
  ]) {
    assert.ok(
      MARKET_INDEXES.some((index) => index.name === required),
      `缺少 ${required}`,
    );
  }
});

test('下一交易日展望只输出积极或谨慎', () => {
  assert.equal(informationToneFromScore(52), '积极');
  assert.equal(informationToneFromScore(51.99), '谨慎');
  assert.deepEqual(
    new Set([
      informationToneFromScore(0),
      informationToneFromScore(50),
      informationToneFromScore(100),
    ]),
    new Set(['积极', '谨慎']),
  );
});

test('下一交易日上涨与下跌信息信号百分比互补且无中性', () => {
  for (const score of [0, 35, 51.99, 52, 65, 100]) {
    const result = nextSessionSignalFromScore(score);
    assert.equal(result.upPct + result.downPct, 100);
    assert.ok(result.upPct >= 30 && result.upPct <= 70);
    assert.equal(
      result.direction,
      result.upPct > result.downPct ? '上涨' : '下跌',
    );
  }
  assert.equal(nextSessionSignalFromScore(52).direction, '上涨');
  assert.equal(nextSessionSignalFromScore(51.99).direction, '下跌');
});

test('A 股信息因子严格按海外 60% 与国内 40% 加权', () => {
  assert.equal(weightedChinaEvidenceScore(100, 0), 60);
  assert.equal(weightedChinaEvidenceScore(0, 100), 40);
  assert.equal(weightedChinaEvidenceScore(80, 20), 56);
});

test('交易阶段与近实时缓存周期按市场切换', () => {
  const cnTrading = new Date('2026-08-31T02:00:00.000Z');
  const cnBreak = new Date('2026-08-31T04:00:00.000Z');
  const usTrading = new Date('2026-08-31T14:00:00.000Z');
  const weekend = new Date('2026-09-05T02:00:00.000Z');
  assert.equal(marketPhase('CN', cnTrading), 'TRADING');
  assert.equal(marketPhase('CN', cnBreak), 'BREAK');
  assert.equal(marketPhase('US', usTrading), 'TRADING');
  assert.equal(marketCacheTtlMs(cnTrading), 3 * 60 * 1000);
  assert.equal(marketCacheTtlMs(usTrading), 5 * 60 * 1000);
  assert.equal(marketCacheTtlMs(weekend), 15 * 60 * 1000);
});

test('公开 MCP 只注册五个只读分析工具', () => {
  const source = readFileSync(
    new URL('../lib/mcp-server.ts', import.meta.url),
    'utf8',
  );
  for (const tool of [
    'get_market_overview',
    'get_sector_analysis',
    'get_index_analysis',
    'get_evidence_feed',
    'get_data_freshness',
  ])
    assert.match(source, new RegExp(`server\\.registerTool\\(\\s*'${tool}'`));
  assert.doesNotMatch(source, /buy|sell|target_price|position_advice/);
});

test('行情缺失时不生成模拟历史序列', async () => {
  const sector = {
    code: '801080',
    name: '电子',
    change: 1.2,
    upCount: 10,
    downCount: 5,
    flatCount: 0,
    volumeRatio: 1.1,
    momentum5d: 0.8,
    newsScore: 60,
    newsConfidence: 1,
    technicalScore: 58,
    compositeScore: 59,
    informationTone: '积极' as const,
    nextSessionDirection: '上涨' as const,
    nextSessionUpPct: 56,
    nextSessionDownPct: 44,
    evidenceQuality: '一般' as const,
    evidenceMix: { foreign: 0, domestic: 0, sources: 0 },
    leadingStock: '中芯国际',
    mainNetInflow: null,
    mainNetInflowPct: null,
    quoteSymbol: null,
    dataAvailable: false,
    evidence: [],
    proxyBoards: [],
    freshness: {
      quoteTime: '2026-08-31T07:00:00.000Z',
      receivedAt: '2026-08-31T07:00:01.000Z',
      source: 'test',
      backupSource: '',
      delayLevel: 'NEAR_REALTIME' as const,
      isProxy: false,
      dataStatus: 'FRESH' as const,
      marketPhase: 'TRADING' as const,
      outlookLabel: '盘中信息面观察' as const,
    },
  };
  const history = await createHistory(sector, 60);
  assert.deepEqual(history, []);

  const merged = mergeCurrentBreadth(
    [
      {
        date: '2026-08-31',
        close: 100,
        change: 1,
        volume: 1000,
        breadth: null,
      },
    ],
    sector,
  );
  assert.equal(merged[0].breadth, 66.7);
});

test('历史行情具备备用源、持久缓存且运行时 DDL 不破坏既有数据', () => {
  const market = readFileSync(
    new URL('../lib/market.ts', import.meta.url),
    'utf8',
  );
  const repository = readFileSync(
    new URL('../lib/market-repository.ts', import.meta.url),
    'utf8',
  );
  const homePage = readFileSync(
    new URL('../app/page.tsx', import.meta.url),
    'utf8',
  );
  const marketRoute = readFileSync(
    new URL('../app/api/market/route.ts', import.meta.url),
    'utf8',
  );
  // 历史行情必须有多条**实测可达**的链路。Yahoo（`query1/query2`）在本网络环境
  // 永久 403，已从历史链路里整条移除，不再作为"备用源"挂在代码里充当门面。
  assert.match(market, /d\.10jqka\.com\.cn/); // A 股行业：同花顺板块日线
  assert.match(market, /web\.ifzq\.gtimg\.cn/); // 指数：腾讯日线
  assert.match(market, /US_MinKService\.getDailyK/); // 美股：新浪日线
  assert.match(market, /push2delay\.eastmoney\.com/);
  assert.doesNotMatch(market, /query1\.finance\.yahoo\.com/);
  assert.doesNotMatch(market, /query2\.finance\.yahoo\.com/);
  assert.match(repository, /sector_history_cache/);
  assert.match(repository, /'CACHED'/);
  assert.match(repository, /mergeSnapshotCoverage/);
  assert.match(homePage, /dynamic = 'force-dynamic'/);
  assert.match(marketRoute, /Cache-Control': 'no-store'/);
  // ensureSchema() 现在是 schema 的唯一真值，必须始终非破坏性
  assert.doesNotMatch(repository, /DROP\s+TABLE/i);
  assert.doesNotMatch(repository, /DELETE\s+FROM/i);
  assert.doesNotMatch(repository, /ALTER\s+TABLE/i);
});

test('生产行情代码不含日期哈希或随机涨跌回退', () => {
  const source = readFileSync(
    new URL('../lib/market.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /const change = round\(\(\(seed % 401\)/);
  assert.match(source, /push2delay\.eastmoney\.com/);
  assert.match(source, /push2delay\.eastmoney\.com\/api\/qt\/ulist\.np\/get/);
  assert.doesNotMatch(source, /\/api\/qt\/stock\/get\?secid=/);
  // 海外指数与美股行业改用东财真实 secid（100 = 国际指数，107 = 美交所/ARCA）。
  // 这些代码是从东财 m:100 全表里逐个挑出来并实测回报的，不是照抄 Yahoo 符号。
  assert.match(source, /'100\.SPX'/);
  assert.match(source, /'100\.NDX100'/);
  assert.match(source, /'100\.NDX'/);
  assert.match(source, /'100\.DJIA'/);
  assert.match(source, /107\.\$\{sector\.code\.slice\(3\)\}/);
  // Yahoo 已从行情与历史两条链路里彻底移除（2021-11-01 起对大陆 403，是地区封锁不是限流）。
  assert.doesNotMatch(source, /query1\.finance\.yahoo\.com/);
  assert.doesNotMatch(source, /fetchYahooHistory|YAHOO_INDEX_SYMBOLS/);
  // 历史链路必须覆盖三类标的：A 股行业、指数、美股。
  assert.match(source, /CN_SECTOR_THS_BOARDS/);
  assert.match(source, /TENCENT_HISTORY_SYMBOLS/);
  assert.match(source, /SINA_US_HISTORY_SYMBOLS/);
  assert.match(source, /SINA_CN_HISTORY_SYMBOLS/);
  assert.match(source, /THS_INDEX_CODES/);
});

test('欧元50 已移除，且没有留下孤立的 secid 映射', () => {
  // 移除理由：所有可达源都没有它的**历史日线**（东财只有实时行情；同花顺全球指数段试遍
  // 1–99 市场号 × 40 余种代码拼法、腾讯、新浪、WSCN、stooq、CNBC 全部无）。
  // 留着只会是一个「走势图永远显示数据不足」的页面。**要重新加入，必须先找到可用的历史源。**
  assert.ok(
    !MARKET_INDEXES.some((index) => index.code === 'IDX-EU-STOXX50'),
    '欧元50 不应再出现在指数清单里',
  );
  const source = readFileSync(
    new URL('../lib/market.ts', import.meta.url),
    'utf8',
  );
  // 指数定义与 secid 映射必须同时移除，否则会留下指向空气的孤立配置
  assert.doesNotMatch(source, /'IDX-EU-STOXX50'/);
  assert.doesNotMatch(source, /'100\.SX5E'/);
});

test('海外指数走同花顺全球指数日线，且分片要取多份选最新', () => {
  // 同花顺的行情节点用「市场_代码」命名：bk_ = A 股行业板块、hk_ = 港股指数、88_ = 全球指数。
  // 这组映射是穷举各市场段 + 与实时行情逐位比对后定下来的，改动即等于换源，必须显式确认。
  assert.deepEqual(THS_INDEX_CODES, {
    'IDX-HK-HSI': 'hk_HSI',
    'IDX-JP-NIKKEI': '88_N225',
    'IDX-KR-KOSPI': '88_KS11',
    'IDX-TW-TAIEX': '88_TWII',
    'IDX-DE-DAX': '88_GDAXI',
    'IDX-UK-FTSE': '88_FTSE',
  });
  const source = readFileSync(
    new URL('../lib/market.ts', import.meta.url),
    'utf8',
  );
  // ⚠️ 分片必须取两份并选最新：hk_HSI 的 /00/、/01/ 停在 2026-04-21，
  //    只用 /01/ 会让恒生 K 线静默回退到几个月前。线上还观察到 /02/ 也会拿到旧窗口。
  assert.match(source, /\['01', '02'\]/);
  assert.match(source, /freshestSeries\(/);
  // A 股行业板块走的是 bk_ 前缀 + 01 分片，那条链路的 01 实测是最新的，不受上面约束。
  assert.match(source, /v6\/line\/bk_\$\{code\}\/01\/last\.js/);
});

test('多分片候选里选末条日期最新的那份', () => {
  const stale = [
    { date: '2026-04-20', close: 26500, volume: 1 },
    { date: '2026-04-21', close: 26519.5, volume: 1 },
  ];
  const fresh = [
    { date: '2026-09-10', close: 24954.47, volume: 1 },
    { date: '2026-09-11', close: 24805.63, volume: 1 },
  ];
  // 顺序无关：无论新鲜的在第几份，结果都取它
  assert.equal(freshestSeries([stale, fresh])?.at(-1)?.date, '2026-09-11');
  assert.equal(freshestSeries([fresh, stale])?.at(-1)?.date, '2026-09-11');
  // 空数组/空序列被跳过
  assert.equal(freshestSeries([[], fresh])?.at(-1)?.date, '2026-09-11');
  assert.equal(freshestSeries([]), null);
});

test('同花顺海外指数的常量占位成交量按「无成交量」处理', () => {
  // 实测：88_N225 / 88_KS11 / 88_TWII / 88_GDAXI / 88_FTSE 的成交量字段恒为 1（占位），
  // 而 88_SPX 与 hk_HSI 是真实量。占位值若照原样透传，量能图会画出一排等高柱。
  const placeholder = [
    { date: '2026-09-10', close: 100, volume: 1 },
    { date: '2026-09-11', close: 101, volume: 1 },
  ];
  assert.deepEqual(
    normalizeThsIndexVolume(placeholder).map((point) => point.volume),
    [0, 0],
  );
  const real = [
    { date: '2026-09-10', close: 100, volume: 2_659_812_200 },
    { date: '2026-09-11', close: 101, volume: 2_531_376_000 },
  ];
  assert.deepEqual(
    normalizeThsIndexVolume(real).map((point) => point.volume),
    [2_659_812_200, 2_531_376_000],
  );
});

test('评分会按来源做配额，避免单一媒体主导信息面', () => {
  const make = (source: string, tone: '正向' | '负向', index: number) => ({
    id: `e${index}`,
    title: `t${index}`,
    summary: '',
    source,
    publishedAt: `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    url: '',
    tone,
    kind: '国际经济' as const,
    region: 'CN' as const,
    sectors: ['801080'],
  });
  // 一家媒体刷 9 条正向：如果不去重，信息面会被这一家拉到很高。
  const dominated = Array.from({ length: 9 }, (_, i) =>
    make('同一家媒体', '正向', i),
  );
  assert.ok(diversifyBySource(dominated).length <= 3);

  // 同样 9 条、但来自 9 家：全部计入，且置信度明显更高。
  const diversified = Array.from({ length: 9 }, (_, i) =>
    make(`媒体 ${i}`, '正向', i),
  );
  assert.equal(diversifyBySource(diversified).length, 9);
  assert.ok(evidenceConfidence(diversified) > evidenceConfidence(dominated));
  assert.equal(evidenceConfidence([]), 0);
  assert.equal(evidenceConfidence(diversified), 0.866);
});

test('一级与二级页面使用可靠的原生导航', () => {
  const dashboard = readFileSync(
    new URL('../components/market-dashboard.tsx', import.meta.url),
    'utf8',
  );
  const detail = readFileSync(
    new URL('../components/sector-detail.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(dashboard.includes('href={sitePath(`/sectors/${sector.code}/`)}'));
  assert.match(dashboard, /target="_blank"/);
  assert.match(dashboard, /rel="noopener noreferrer"/);
  assert.doesNotMatch(dashboard, /from 'next\/link'/);
  assert.ok(detail.includes('href={sitePath(`/?region=${returnRegion}#sectors`)}'));
  assert.match(dashboard, /initialRegion: 'CN' \| 'US' \| 'INDEX'/);
  assert.doesNotMatch(detail, /from 'next\/link'/);
});

// ── 以下是行为测试：直接调用 buildSector，锁定盘面因子与展望口径 ──

const testFreshness = {
  quoteTime: '2026-09-11T07:00:00.000Z',
  receivedAt: '2026-09-11T07:00:01.000Z',
  source: 'unit-test',
  backupSource: '',
  delayLevel: 'NEAR_REALTIME' as const,
  isProxy: false,
  dataStatus: 'FRESH' as const,
  marketPhase: 'TRADING' as const,
  outlookLabel: '盘中信息面观察' as const,
};

const electronics = {
  code: '801080',
  name: '电子',
  keywords: ['电子'],
  leaders: ['中芯国际'],
};

test('量比取接口真实字段，不再退化成恒定的 1', () => {
  const sector = buildSector(
    electronics,
    [{ f14: '电子', f3: 1, f10: 1.8, f109: 7.5, f20: 1e11, f104: 30, f105: 10 }],
    [],
    'CN',
    testFreshness,
  );
  assert.equal(sector.dataAvailable, true);
  assert.equal(sector.volumeRatio, 1.8);
  assert.equal(sector.momentum5d, 7.5);
  // 旧实现是 round(change * 0.72)，必须不再是那个值
  assert.notEqual(sector.momentum5d, Math.round(sector.change * 0.72 * 100) / 100);
});

test('量比与 5 日涨跌幅按市值加权，缺失值自动跳过', () => {
  const partial = buildSector(
    electronics,
    [
      { f14: '电子元件', f3: 0, f10: 2, f109: 10, f20: 300, f104: 1, f105: 0 },
      { f14: '电子化学品', f3: 0, f20: 100, f104: 1, f105: 0 },
    ],
    [],
    'CN',
    testFreshness,
  );
  assert.equal(partial.volumeRatio, 2);
  assert.equal(partial.momentum5d, 10);

  const both = buildSector(
    electronics,
    [
      { f14: '电子元件', f3: 0, f10: 2, f109: 10, f20: 300, f104: 1, f105: 0 },
      { f14: '电子化学品', f3: 0, f10: 1, f109: 0, f20: 100, f104: 1, f105: 0 },
    ],
    [],
    'CN',
    testFreshness,
  );
  assert.equal(both.volumeRatio, 1.75); // (2×300 + 1×100) / 400
  assert.equal(both.momentum5d, 7.5); // (10×300 + 0×100) / 400
});

test('取不到 5 日数据时 momentum5d 为 null，不用当日涨跌凑数', () => {
  const sector = buildSector(
    electronics,
    [{ f14: '电子', f3: 2, f10: 1.2, f20: 1e11, f104: 5, f105: 1 }],
    [],
    'CN',
    testFreshness,
  );
  assert.equal(sector.dataAvailable, true);
  assert.equal(sector.momentum5d, null);
});

test('没有可核验行情时不输出任何涨跌倾向', () => {
  const noQuote = buildSector(electronics, [], [], 'CN', testFreshness);
  assert.equal(noQuote.dataAvailable, false);
  assert.equal(noQuote.nextSessionDirection, null);
  assert.equal(noQuote.nextSessionUpPct, null);
  assert.equal(noQuote.nextSessionDownPct, null);
  assert.equal(noQuote.momentum5d, null);
  assert.equal(noQuote.technicalScore, 50);
});

test('有行情时涨跌倾向必须非空，且涨跌互补', () => {
  const quoted = buildSector(
    electronics,
    [{ f14: '电子', f3: 3, f10: 1.6, f109: 6, f20: 1e11, f104: 40, f105: 5 }],
    [],
    'CN',
    testFreshness,
  );
  assert.notEqual(quoted.nextSessionDirection, null);
  assert.equal(
    (quoted.nextSessionUpPct ?? 0) + (quoted.nextSessionDownPct ?? 0),
    100,
  );
  // 盘面因子不应再是写死的 50
  assert.notEqual(quoted.technicalScore, 50);
});

test('证据稀薄时信息面分数被拉向中性，并如实给出置信度', () => {
  const event = (source: string, index: number): NewsEvent => ({
    id: `thin-${index}`,
    title: `电子行业订单回暖 ${index}`,
    summary: '',
    source,
    publishedAt: testFreshness.receivedAt,
    url: '',
    tone: '正向',
    kind: '国内经济',
    region: 'CN',
    sectors: ['801080'],
  });
  const board = [
    { f14: '电子', f3: 1, f10: 1, f109: 1, f20: 1e11, f104: 20, f105: 10 },
  ];

  // 只有 1 条、1 家来源 → 置信度极低，信息面几乎贴在中性 50，而不是报一个高看多数
  const thin = buildSector(
    electronics,
    board,
    [event('某家媒体', 0)],
    'CN',
    testFreshness,
  );
  assert.ok(thin.newsConfidence < 0.25, `置信度应偏低，实际 ${thin.newsConfidence}`);
  assert.ok(
    Math.abs(thin.newsScore - 50) <= 5,
    `薄样本应贴近中性，实际 ${thin.newsScore}`,
  );

  // 同样全是正向，但 12 条来自 12 家 → 置信度拉满，分数才允许明显偏离中性
  const rich = buildSector(
    electronics,
    board,
    Array.from({ length: 12 }, (_, i) => event(`媒体 ${i}`, i)),
    'CN',
    testFreshness,
  );
  assert.equal(rich.newsConfidence, 1);
  assert.ok(rich.newsScore >= 70, `充足样本应明显偏离中性，实际 ${rich.newsScore}`);
  assert.ok(rich.newsScore > thin.newsScore);
  assert.equal(rich.evidenceMix.sources, 12);
});

test('展示列表按来源削峰，不让单一媒体刷满整个列表', () => {
  const make = (source: string, index: number): NewsEvent => ({
    id: `cap-${source}-${index}`,
    title: `t${index}`,
    summary: '',
    source,
    publishedAt: '2026-09-11T00:00:00.000Z',
    url: '',
    tone: '中性',
    kind: '美国财经',
    region: 'US',
    sectors: ['US-XLK'],
  });
  const events: NewsEvent[] = [
    ...Array.from({ length: 51 }, (_, i) => make('CNBC', i)),
    ...Array.from({ length: 10 }, (_, i) => make('The Wall Street Journal', i)),
    ...Array.from({ length: 2 }, (_, i) => make('Fortune', i)),
  ];
  const capped = capPerSource(events, 10);
  assert.equal(capped.filter((e) => e.source === 'CNBC').length, 10);
  // 未超上限的来源必须原样保留，且整体保持时间顺序
  assert.equal(capped.filter((e) => e.source === 'Fortune').length, 2);
  assert.equal(
    capped.filter((e) => e.source === 'CNBC')[0].id,
    'cap-CNBC-0',
    '削峰应保留最早出现的那些（列表本身是时间序）',
  );
  assert.ok(capped.length < events.length);
});

test('海外看中国池排除地缘政治稿，但保留对中国公司/产业的分析', () => {
  // 这些含中国主体但是时政/军事稿。放进池里的危害很大：它们的行业归属会落到
  // 「全部行业」，等于一条军事新闻污染 31 个行业的分数。
  const rejected = [
    "China's Military Drills Near Taiwan Draw U.S. Concern",
    'Chinese Satellite Imagery Linked to Iranian Strike That Killed Two',
    'U.S. Alliances Push Rivals China and India Together',
    'China President Xi Jinping Meets Diplomatic Envoys',
  ];
  for (const title of rejected) {
    assert.equal(isForeignChinaAnalysis(title), false, title);
  }
  const accepted = [
    "China's EV makers shift gears to focus on humanoids as car market slows",
    // 只写公司名、不提国名——中概股 feed 里几乎全是这种，必须认出来
    'PDD Holdings: Core Ad Deceleration And 1P Pivot Cloud Risk',
    'The Trillion-Dollar Bright Spot in China\u2019s Economy: Tourism',
    'Alibaba beats estimates as cloud revenue grows',
  ];
  for (const title of accepted) {
    assert.equal(isForeignChinaAnalysis(title), true, title);
  }
  assert.equal(hasChinaMarker('The Fed holds rates steady'), false);
  assert.equal(mentionsChineseCompany('Alibaba and JD.com rally'), true);
});

test('行业历史：同花顺板块映射完整、不重复，且订阅代码格式正确', () => {
  const used = new Map<string, string>();
  let total = 0;
  for (const sector of SECTORS) {
    const boards = CN_SECTOR_THS_BOARDS[sector.code];
    assert.ok(
      boards?.length,
      `行业 ${sector.code} ${sector.name} 缺少同花顺板块映射`,
    );
    total += boards.length;
    for (const code of boards) {
      assert.match(code, /^881\d{3}$/, `${sector.name} 的板块代码 ${code} 格式不对`);
      // 一个板块只能属于一个行业，否则点位与宽度会被重复计权
      assert.equal(
        used.get(code),
        undefined,
        `板块 ${code} 同时被 ${used.get(code)} 和 ${sector.code} 占用`,
      );
      used.set(code, sector.code);
    }
  }
  assert.equal(used.size, total, '存在被重复分配的板块');
  assert.ok(total >= 90, `板块覆盖数偏少：${total}`);
});

test('行业历史：同花顺日线解析与等权聚合', () => {
  // 真实响应片段（字段序：日期,开,高,低,收,量,额）
  const raw =
    '20260213,4795.224,4828.310,4770.734,4776.047,738121470,6350360800.000,,,,0;' +
    '20260224,4813.018,4919.036,4813.018,4902.204,1127078830,9593147900.000,,,,0';
  const parsed = parseThsBoardSeries(raw);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    date: '2026-02-13',
    close: 4776.047,
    volume: 738121470,
  });
  assert.equal(parsed[1].date, '2026-02-24');

  // 两个子板块：一个 +10%、一个 −5% → 等权 +2.5%，宽度 50%
  const a = [
    { date: '2026-09-10', close: 100, volume: 10 },
    { date: '2026-09-11', close: 110, volume: 20 },
  ];
  const b = [
    { date: '2026-09-10', close: 200, volume: 5 },
    { date: '2026-09-11', close: 190, volume: 5 },
  ];
  const rows = aggregateSectorSeries([a, b], 60);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-09-11');
  assert.equal(rows[0].change, 2.5);
  assert.equal(rows[0].close, 1025); // 1000 × (1 + 2.5%)
  assert.equal(rows[0].volume, 25);
  assert.equal(rows[0].breadth, 50); // 1 涨 / 2 家 = 真实宽度，不是估算
});

test('行业历史：新浪美股日线解析', () => {
  const body =
    "/*<script>location.href='//sina.com';</script>*/\n" +
    'var _=([{"d":"2026-09-10","o":"1","h":"2","l":"1","c":"100","v":"1000","a":"0"},' +
    '{"d":"2026-09-11","o":"1","h":"2","l":"1","c":"102","v":"2000","a":"0"}])';
  const rows = parseSinaUsSeries(body);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    date: '2026-09-11',
    close: 102,
    change: 2,
    volume: 2000,
    breadth: null,
  });
  assert.throws(() => parseSinaUsSeries('not-a-jsonp'), /格式异常/);
});

test('行业历史：新浪 A 股指数日线解析（成交量换算成手）', () => {
  const body = JSON.stringify([
    {
      day: '2026-09-10',
      open: '3900.000',
      high: '3950.000',
      low: '3890.000',
      close: '3943.920',
      volume: '51750431100',
    },
    {
      day: '2026-09-11',
      open: '3910.923',
      high: '3912.325',
      low: '3852.032',
      close: '3888.111',
      volume: '57912314500',
    },
  ]);
  const rows = parseSinaCnSeries(body);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].close, 3888.11);
  assert.equal(rows[1].change, -1.42);
  // 新浪给的是「股」，腾讯同口径给的是「手」（1 手 = 100 股）。
  // 不换算的话，同一个指数换源后量柱会跳 100 倍。
  assert.equal(rows[1].volume, 579123145);
  assert.throws(() => parseSinaCnSeries('null'), /格式异常/);
});

test('情绪判定能识别真实财经标题，且不被英文子串误伤', () => {
  // 这几条都是本轮真实抓到的标题：旧词典（子串匹配 + 词表太窄）全部判成「中性」。
  assert.equal(
    toneFor("BYD shares slide as fierce China competition dents first-half profit"),
    '负向',
  );
  assert.equal(toneFor("China's imports in August miss estimates"), '负向');
  assert.equal(
    toneFor("China's factory activity shrinks for second straight month"),
    '负向',
  );
  assert.equal(toneFor("The Trillion-Dollar Bright Spot in China's Economy"), '正向');
  assert.equal(
    toneFor('Dow rallies as inflation report boosts odds of rate cut'),
    '正向',
  );
  // 词边界：surprise 里含 rise、dismissed 里含 miss，都不应命中。
  assert.equal(toneFor("Analysts surprised by the firm's dismissed case"), '中性');
  assert.equal(toneFor('A quiet trading session'), '中性');
});

test('首页精简投影剥离证据链，其余字段完整保留且不改动原对象', () => {
  const event: NewsEvent = {
    id: 'evt-1',
    title: '测试事件标题',
    summary: '摘要',
    source: 'unit-test',
    publishedAt: '2026-09-11T00:00:00.000Z',
    url: '',
    tone: '正向',
    kind: '行业新闻',
    region: 'CN',
    sectors: ['801080'],
  };
  const sector = buildSector(
    electronics,
    [{ f14: '电子', f3: 1, f10: 1.5, f109: 4, f20: 1e11, f104: 20, f105: 5 }],
    [event],
    'CN',
    testFreshness,
  );
  assert.equal(sector.evidence.length, 1);

  const snapshot: MarketSnapshot = {
    tradeDate: '2026-09-11',
    updatedAt: '2026-09-11T07:00:00.000Z',
    dataStatus: 'LIVE_PROXY',
    disclaimer: 'test',
    market: { positive: 1, cautious: 0, eventCount: 1 },
    usMarket: { positive: 0, cautious: 0, eventCount: 0 },
    indexMarket: { positive: 0, cautious: 0, eventCount: 0 },
    sectors: [sector],
    usSectors: [],
    indexes: [],
    events: [event],
    freshness: { CN: testFreshness, US: testFreshness, INDEX: testFreshness },
    providerStatus: [],
    proxyDisclosure: 'test',
    methodology: {
      newsWeight: 0.65,
      technicalWeight: 0.35,
      modelVersion: 'provider-split-direction-share-v10',
      modelStatus: 'validated',
    },
  };

  const lean = toDashboardSnapshot(snapshot);
  assert.equal(
    Object.prototype.hasOwnProperty.call(lean.sectors[0], 'evidence'),
    false,
  );
  assert.equal(lean.sectors[0].name, sector.name);
  assert.equal(lean.sectors[0].evidenceQuality, sector.evidenceQuality);
  assert.equal(lean.sectors[0].nextSessionDirection, sector.nextSessionDirection);
  assert.deepEqual(lean.sectors[0].evidenceMix, sector.evidenceMix);
  assert.equal(lean.events.length, 1);
  // 原快照必须保持不变（投影不能有副作用）
  assert.equal(snapshot.sectors[0].evidence.length, 1);
  assert.ok(JSON.stringify(lean).length < JSON.stringify(snapshot).length);
});

// ── 上游行情缓存策略（Yahoo 403 降级加固） ──

// 2026-09-12 是周六，所有市场休市 → 新鲜窗口为 6 小时
const SATURDAY = Date.parse('2026-09-12T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;

test('各市场交易时段判断覆盖跨时区与周末', () => {
  // 2026-09-11 是周五
  assert.equal(
    isQuoteMarketOpen('XLK', new Date('2026-09-11T14:30:00Z')),
    true, // 纽约 10:30 EDT
  );
  assert.equal(
    isQuoteMarketOpen('XLK', new Date('2026-09-11T02:30:00Z')),
    false, // 纽约 22:30，已收盘
  );
  assert.equal(
    isMarketSessionOpen('CN', new Date('2026-09-11T02:30:00Z')),
    true, // 北京 10:30
  );
  assert.equal(
    isMarketSessionOpen('CN', new Date('2026-09-11T12:00:00Z')),
    false, // 北京 20:00
  );
  // 同一时刻：东京在交易时段，纽约不在
  assert.equal(isQuoteMarketOpen('^N225', new Date('2026-09-11T01:00:00Z')), true);
  assert.equal(isQuoteMarketOpen('XLK', new Date('2026-09-11T01:00:00Z')), false);
  // 周末全部休市
  assert.equal(isQuoteMarketOpen('XLK', new Date('2026-09-12T14:30:00Z')), false);
  assert.equal(isQuoteMarketOpen('^N225', new Date('2026-09-12T01:00:00Z')), false);
});

test('行情缓存：休市窗口内复用副本，不再发起网络请求', async () => {
  const url = 'https://example.test/quote/cache-hit';
  let calls = 0;
  const load = async () => {
    calls += 1;
    return { price: 100 + calls };
  };

  const first = await readCachedQuote(url, 'US', load, SATURDAY);
  assert.equal(first.stale, false);
  assert.deepEqual(first.value, { price: 101 });
  assert.equal(calls, 1);

  // 2 小时后仍在 6 小时新鲜窗口内 → 命中缓存
  const second = await readCachedQuote(url, 'US', load, SATURDAY + 2 * HOUR);
  assert.equal(calls, 1);
  assert.deepEqual(second.value, { price: 101 });
  assert.equal(second.stale, false);
});

test('行情缓存：网络失败时回退过期副本并标记 stale', async () => {
  const url = 'https://example.test/quote/stale-fallback';
  await readCachedQuote(url, 'US', async () => ({ price: 42 }), SATURDAY);

  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    throw new Error('HTTP 403');
  };

  // 10 小时：超过 6 小时新鲜窗口 → 会尝试网络；网络失败 → 回退 24 小时内的副本
  const fallback = await readCachedQuote(
    url,
    'US',
    failing,
    SATURDAY + 10 * HOUR,
  );
  assert.equal(attempts, 1);
  assert.equal(fallback.stale, true);
  assert.deepEqual(fallback.value, { price: 42 });
});

test('行情缓存：副本超过 24 小时且网络失败时必须抛错，不能拿旧数据充数', async () => {
  const url = 'https://example.test/quote/too-old';
  await readCachedQuote(url, 'US', async () => ({ price: 7 }), SATURDAY);

  const failing = async (): Promise<{ price: number }> => {
    throw new Error('HTTP 403');
  };
  await assert.rejects(
    () => readCachedQuote(url, 'US', failing, SATURDAY + 30 * HOUR),
    /HTTP 403/,
  );
});

test('行情缓存：交易时段内使用 3 分钟短窗口', async () => {
  const url = 'https://example.test/quote/open-session';
  // 纽约 10:30，处于交易时段
  const openTime = Date.parse('2026-09-11T14:30:00.000Z');
  let calls = 0;
  const load = async () => {
    calls += 1;
    return { price: calls };
  };

  await readCachedQuote(url, 'US', load, openTime);
  assert.equal(calls, 1);
  // 1 分钟后仍新鲜
  await readCachedQuote(url, 'US', load, openTime + 60_000);
  assert.equal(calls, 1);
  // 4 分钟后已过期 → 重新请求
  await readCachedQuote(url, 'US', load, openTime + 4 * 60_000);
  assert.equal(calls, 2);
});

// ── 节假日日历 ──

const weekdayIn = (dateKey: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    new Date(`${dateKey}T12:00:00Z`),
  );

test('休市区间录入与交易所公告原文的星期标注一致', () => {
  // 上交所《2026 年部分节假日休市安排的通知》原文逐条标注了星期，
  // 用它反向校验区间起止日有没有抄错。
  const cnExpectations: Array<[string, string]> = [
    ['2026-01-01', 'Thu'],
    ['2026-01-03', 'Sat'],
    ['2026-02-15', 'Sun'],
    ['2026-02-23', 'Mon'],
    ['2026-04-04', 'Sat'],
    ['2026-04-06', 'Mon'],
    ['2026-05-01', 'Fri'],
    ['2026-05-05', 'Tue'],
    ['2026-06-19', 'Fri'],
    ['2026-06-21', 'Sun'],
    ['2026-09-25', 'Fri'],
    ['2026-09-27', 'Sun'],
    ['2026-10-01', 'Thu'],
    ['2026-10-07', 'Wed'],
  ];
  for (const [key, expected] of cnExpectations) {
    assert.equal(weekdayIn(key, 'Asia/Shanghai'), expected, `${key} 星期不符`);
  }

  // NYSE 官方日历标注的关键日期
  const usExpectations: Array<[string, string]> = [
    ['2026-01-01', 'Thu'], // New Year's Day
    ['2026-01-19', 'Mon'], // MLK Day
    ['2026-02-16', 'Mon'], // Washington's Birthday
    ['2026-04-03', 'Fri'], // Good Friday
    ['2026-06-19', 'Fri'], // Juneteenth
    ['2026-07-03', 'Fri'], // Independence Day observed
    ['2026-09-07', 'Mon'], // Labor Day
    ['2026-11-26', 'Thu'], // Thanksgiving
    ['2026-12-25', 'Fri'], // Christmas
    ['2027-07-05', 'Mon'], // 独立日顺延
  ];
  for (const [key, expected] of usExpectations) {
    assert.equal(weekdayIn(key, 'America/New_York'), expected, `${key} 星期不符`);
  }
});

test('法定节假日不再被误判为交易日', () => {
  // A 股：10/1 国庆（周四）、2/17 春节（周二）、1/2 元旦（周五）
  assert.equal(marketPhase('CN', new Date('2026-10-01T02:30:00Z')), 'CLOSED');
  assert.equal(marketPhase('CN', new Date('2026-02-17T02:30:00Z')), 'CLOSED');
  assert.equal(marketPhase('CN', new Date('2026-01-02T02:30:00Z')), 'CLOSED');
  // 对照：节后首个交易日 10/8 应正常开市
  assert.equal(marketPhase('CN', new Date('2026-10-08T02:30:00Z')), 'TRADING');

  // 美股：感恩节（11/26 周四）、耶稣受难日（4/3 周五）
  assert.equal(marketPhase('US', new Date('2026-11-26T15:00:00Z')), 'CLOSED');
  assert.equal(marketPhase('US', new Date('2026-04-03T14:00:00Z')), 'CLOSED');
  // 对照：4/6 周一美国不休市，A 股因清明休市
  assert.equal(marketPhase('US', new Date('2026-04-06T14:00:00Z')), 'TRADING');
  assert.equal(marketPhase('CN', new Date('2026-04-06T02:30:00Z')), 'CLOSED');
});

test('美股提前收盘日按 13:00 收市处理', () => {
  // 2026-11-27 感恩节次日：纽约 14:00 已进入盘后
  assert.equal(marketPhase('US', new Date('2026-11-27T19:00:00Z')), 'POSTMARKET');
  // 对照：普通周五同一时刻仍在交易
  assert.equal(marketPhase('US', new Date('2026-11-20T19:00:00Z')), 'TRADING');
});

test('日本节假日已覆盖，未覆盖年份保留明确限制', () => {
  // 日本元旦现在按 JPX 官方日历识别。
  assert.equal(isMarketSessionOpen('JP', new Date('2026-01-01T02:00:00Z')), false);
  // 覆盖到的市场则正确识别
  assert.equal(isMarketSessionOpen('CN', new Date('2026-10-01T02:30:00Z')), false);
  assert.equal(isMarketSessionOpen('US', new Date('2026-11-26T15:00:00Z')), false);
});

test('全空的快照只缓存 60 秒就重试，部分降级仍走正常周期', () => {
  const saturday = new Date('2026-09-12T03:00:00.000Z');
  const normalTtl = marketCacheTtlMs(saturday);
  assert.equal(normalTtl, 15 * 60 * 1000);

  const sector = buildSector(
    electronics,
    [{ f14: '电子', f3: 1, f10: 1.5, f109: 4, f20: 1e11, f104: 20, f105: 5 }],
    [],
    'CN',
    testFreshness,
  );
  const empty = buildSector(electronics, [], [], 'CN', testFreshness);
  assert.equal(sector.dataAvailable, true);
  assert.equal(empty.dataAvailable, false);

  const base: MarketSnapshot = {
    tradeDate: '2026-09-12',
    updatedAt: '2026-09-12T03:00:00.000Z',
    dataStatus: 'STALE',
    disclaimer: 'test',
    market: { positive: 0, cautious: 0, eventCount: 0 },
    usMarket: { positive: 0, cautious: 0, eventCount: 0 },
    indexMarket: { positive: 0, cautious: 0, eventCount: 0 },
    sectors: [sector],
    usSectors: [empty],
    indexes: [],
    events: [],
    freshness: { CN: testFreshness, US: testFreshness, INDEX: testFreshness },
    providerStatus: [],
    proxyDisclosure: 'test',
    methodology: {
      newsWeight: 0.65,
      technicalWeight: 0.35,
      modelVersion: 'provider-split-direction-share-v10',
      modelStatus: 'validated',
    },
  };

  // 全空 → 60 秒后立刻重试
  assert.equal(
    snapshotCacheTtlMs({ ...base, sectors: [empty] }, saturday),
    60 * 1000,
  );
  // 只要有一个标的拿到行情（例如只有 Yahoo 降级），就走正常 TTL
  assert.equal(snapshotCacheTtlMs(base, saturday), normalTtl);
});

test('首页投影按区域裁剪事件，且不裁掉看板需要展示的条数', () => {
  const makeEvent = (
    id: string,
    region: 'CN' | 'US' | 'INDEX',
    sectors: string[],
  ): NewsEvent => ({
    id,
    title: `事件 ${id}`,
    summary: '',
    source: 'unit-test',
    publishedAt: '2026-09-11T00:00:00.000Z',
    url: '',
    tone: '中性',
    kind: '行业新闻',
    region,
    sectors,
  });

  const events: NewsEvent[] = [
    ...Array.from({ length: 30 }, (_, i) =>
      makeEvent(`cn-${i}`, 'CN', ['801080']),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      makeEvent(`us-${i}`, 'US', ['US-XLK']),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      makeEvent(`idx-${i}`, 'INDEX', ['IDX-CN-SSE']),
    ),
    // 无关联行业的事件应该被投影丢掉
    ...Array.from({ length: 5 }, (_, i) => makeEvent(`empty-${i}`, 'CN', [])),
  ];

  const empty = buildSector(electronics, [], [], 'CN', testFreshness);
  const snapshot: MarketSnapshot = {
    tradeDate: '2026-09-11',
    updatedAt: '2026-09-11T07:00:00.000Z',
    dataStatus: 'STALE',
    disclaimer: 'test',
    market: { positive: 0, cautious: 0, eventCount: events.length },
    usMarket: { positive: 0, cautious: 0, eventCount: events.length },
    indexMarket: { positive: 0, cautious: 0, eventCount: events.length },
    sectors: [empty],
    usSectors: [],
    indexes: [],
    events,
    freshness: { CN: testFreshness, US: testFreshness, INDEX: testFreshness },
    providerStatus: [],
    proxyDisclosure: 'test',
    methodology: {
      newsWeight: 0.65,
      technicalWeight: 0.35,
      modelVersion: 'provider-split-direction-share-v10',
      modelStatus: 'validated',
    },
  };

  const lean = toDashboardSnapshot(snapshot);
  const countIn = (region: 'CN' | 'US' | 'INDEX') =>
    lean.events.filter((event) => event.region === region).length;

  // 每个区域都必须留够看板要展示的条数
  for (const region of ['CN', 'US', 'INDEX'] as const) {
    assert.ok(
      countIn(region) >= DASHBOARD_EVENTS_PER_REGION,
      `${region} 保留条数不足`,
    );
  }
  // 而且要比原来少很多
  assert.ok(lean.events.length < events.length / 2);
  // 无关联行业的事件不再发给浏览器
  assert.equal(
    lean.events.some((event) => event.id.startsWith('empty-')),
    false,
  );
});
