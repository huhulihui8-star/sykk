import { prepareNewsEvidence, newsTimeWeight } from './news-evidence.ts';
import { SESSION_WINDOWS, EXCHANGE_CALENDARS, calendarCoverage, sessionForCode, localClock, sessionClose, shiftDate } from './market-calendar.ts';
import { readSourceBody, withSourceDiagnostics, reserveSourceCacheCall, type SourceDiagnostic } from './source-cache.ts';

export type InformationTone = '积极' | '谨慎';
export type NextSessionDirection = '上涨' | '下跌';
export type MarketRegion = 'CN' | 'US' | 'INDEX';
export type DelayLevel =
  | 'NEAR_REALTIME'
  | 'DELAYED_15M'
  | 'LAST_CLOSE'
  | 'STALE';
export type MarketPhase =
  | 'TRADING'
  | 'BREAK'
  | 'PREMARKET'
  | 'POSTMARKET'
  | 'CLOSED';

export type QuoteFreshness = {
  quoteTime: string;
  receivedAt: string;
  source: string;
  backupSource: string;
  delayLevel: DelayLevel;
  isProxy: boolean;
  dataStatus: 'FRESH' | 'DELAYED' | 'STALE' | 'FALLBACK';
  marketPhase: MarketPhase;
  outlookLabel: '盘中信息面观察' | '下一交易日统计展望';
  session?: MarketSession;
  calendar?: ReturnType<typeof calendarCoverage>;
};

export type ProviderStatus = {
  id: string;
  name: string;
  role: 'PRIMARY' | 'BACKUP' | 'VALIDATION';
  status: 'UP' | 'DEGRADED' | 'DOWN' | 'STANDBY';
  lastSuccessAt: string | null;
  message: string;
};

export type NewsEvent = {
  id: string;
  title: string;
  summary: string;
  source: string;
  publishedAt: string;
  url: string;
  tone: '正向' | '中性' | '负向';
  kind:
    | '国内经济'
    | '国际经济'
    | '行业新闻'
    | '龙头公告'
    | '美国财经'
    | 'SEC披露'
    | '市场快讯'
    | '机构研报'
    | '海外看中国';
  region: MarketRegion;
  sectors: string[];
};

export type SectorSnapshot = {
  code: string;
  name: string;
  change: number;
  upCount: number;
  downCount: number;
  flatCount: number;
  /** 真实量比：东方财富 f10，或美股/指数的「当日成交量 ÷ 前 5 日均量」。 */
  volumeRatio: number;
  /** 真实 5 日涨跌幅。取不到时为 null，绝不用当日涨跌幅冒充。 */
  momentum5d: number | null;
  newsScore: number;
  /**
   * 证据置信度（0~1）。信息面分数已经按它往 50 收缩过：
   * 置信度低 = 该行业的样本条数与来源数不足，分数接近中性。
   */
  newsConfidence: number;
  technicalScore: number;
  compositeScore: number;
  /**
   * 行情缺失（dataAvailable === false）时为 null：既没有可核验盘面数据，
   * 就不输出任何看起来像概率的涨跌百分比。
   */
  nextSessionDirection: NextSessionDirection | null;
  nextSessionUpPct: number | null;
  nextSessionDownPct: number | null;
  informationTone: InformationTone;
  evidenceQuality: '充足' | '一般' | '不足';
  leadingStock: string;
  mainNetInflow: number | null;
  mainNetInflowPct: number | null;
  quoteSymbol: string | null;
  dataAvailable: boolean;
  evidence: NewsEvent[];
  /** `sources` 是不同来源的数量，用于判断这个行业的证据是不是「一家在说」。 */
  evidenceMix: { foreign: number; domestic: number; sources: number };
  proxyBoards: string[];
  freshness: QuoteFreshness;
};

export type MarketSnapshot = {
  tradeDate: string;
  updatedAt: string;
  dataStatus: 'LIVE' | 'LIVE_PROXY' | 'STALE' | 'DEMO';
  disclaimer: string;
  market: { positive: number; cautious: number; eventCount: number };
  usMarket: { positive: number; cautious: number; eventCount: number };
  indexMarket: { positive: number; cautious: number; eventCount: number };
  sectors: SectorSnapshot[];
  usSectors: SectorSnapshot[];
  indexes: SectorSnapshot[];
  events: NewsEvent[];
  freshness: Record<MarketRegion, QuoteFreshness>;
  providerStatus: ProviderStatus[];
  proxyDisclosure: string;
  analysisEvidence?: NewsEvent[];
  diagnostics?: { durationMs: number; requestCount: number; newsCount: number; coverage: Record<MarketRegion, number>; sources: SourceDiagnostic[] };
  methodology: {
    newsWeight: number;
    technicalWeight: number;
    modelVersion: string;
    validationStatus?: 'UNVALIDATED';
    newsHalfLifeHours?: number;
    newsMaxAgeHours?: number;
    modelStatus: 'validated' | 'fallback';
  };
};

/**
 * 首页看板用的精简行业视图：不含证据链正文。
 *
 * 每个行业的 `evidence` 平均约 3.8KB，60 个行业合计约 228KB，而首页卡片
 * 只渲染信息面结论与盘面指标，从不读 `evidence`。用独立类型而不是"传空数组"
 * 是为了让「首页不会用到证据链」这件事由类型系统保证。
 */
export type DashboardSector = Omit<SectorSnapshot, 'evidence'>;

export type DashboardSnapshot = Omit<
  MarketSnapshot,
  'sectors' | 'usSectors' | 'indexes' | 'analysisEvidence'
> & {
  sectors: DashboardSector[];
  usSectors: DashboardSector[];
  indexes: DashboardSector[];
};

function toDashboardSector(sector: SectorSnapshot): DashboardSector {
  const { evidence: _evidence, ...rest } = sector;
  return rest;
}

/**
 * 首页看板每个区域最多展示的关键信息条数。
 * 看板（slice）与投影（裁剪）共用这个常量，避免两边各写一个数字后悄悄漂移。
 */
export const DASHBOARD_EVENTS_PER_REGION = 6;

/** 投影时按区域多留一点余量，以免过滤掉无关联行业的事件后条数不足。 */
const DASHBOARD_EVENT_HEADROOM = 4;

export function toDashboardSnapshot(
  snapshot: MarketSnapshot,
): DashboardSnapshot {
  // 首页按区域切换是客户端行为，所以三个区域都要带。
  // 但每个区域只用得到前 6 条，没必要把全部事件都发到浏览器。
  const pickRegion = (region: MarketRegion) =>
    snapshot.events
      .filter((event) => event.region === region && event.sectors.length)
      .slice(0, DASHBOARD_EVENTS_PER_REGION + DASHBOARD_EVENT_HEADROOM);
  const { analysisEvidence: _analysisEvidence, ...dashboard } = snapshot;
  return {
    ...dashboard,
    sectors: snapshot.sectors.map(toDashboardSector),
    usSectors: snapshot.usSectors.map(toDashboardSector),
    indexes: snapshot.indexes.map(toDashboardSector),
    events: [
      ...pickRegion('CN'),
      ...pickRegion('US'),
      ...pickRegion('INDEX'),
    ],
  };
}

type SectorDefinition = {
  code: string;
  name: string;
  keywords: string[];
  leaders: string[];
};

export const SECTORS: SectorDefinition[] = [
  [
    '801010',
    '农林牧渔',
    ['农业', '养殖', '饲料', '种植', '林业', '渔业'],
    ['牧原股份', '海大集团'],
  ],
  [
    '801030',
    '基础化工',
    ['化工', '化学', '农药', '化纤', '塑料', '橡胶'],
    ['万华化学', '盐湖股份'],
  ],
  ['801040', '钢铁', ['钢铁', '特钢', '普钢'], ['宝钢股份', '中信特钢']],
  [
    '801050',
    '有色金属',
    ['有色', '小金属', '贵金属', '工业金属', '能源金属'],
    ['紫金矿业', '洛阳钼业'],
  ],
  [
    '801080',
    '电子',
    ['半导体', '电子', '元件', '光学', '消费电子'],
    ['中芯国际', '立讯精密'],
  ],
  [
    '801110',
    '家用电器',
    ['家电', '白色家电', '黑色家电', '厨卫电器'],
    ['美的集团', '海尔智家'],
  ],
  [
    '801120',
    '食品饮料',
    ['食品', '饮料', '白酒', '乳品', '调味品'],
    ['贵州茅台', '伊利股份'],
  ],
  ['801130', '纺织服饰', ['纺织', '服装', '饰品'], ['海澜之家', '申洲国际']],
  [
    '801140',
    '轻工制造',
    ['轻工', '造纸', '家居', '包装印刷'],
    ['欧派家居', '太阳纸业'],
  ],
  [
    '801150',
    '医药生物',
    ['医药', '医疗', '生物', '中药', '疫苗', '制药'],
    ['恒瑞医药', '迈瑞医疗'],
  ],
  [
    '801160',
    '公用事业',
    ['电力', '燃气', '水务', '公用事业'],
    ['长江电力', '华能国际'],
  ],
  [
    '801170',
    '交通运输',
    ['交通', '航运', '港口', '航空', '物流', '铁路'],
    ['中远海控', '顺丰控股'],
  ],
  ['801180', '房地产', ['房地产', '物业', '房产'], ['保利发展', '万科A']],
  [
    '801200',
    '商贸零售',
    ['零售', '商业', '贸易', '百货'],
    ['永辉超市', '王府井'],
  ],
  [
    '801210',
    '社会服务',
    ['旅游', '酒店', '教育', '餐饮', '景区'],
    ['中国中免', '锦江酒店'],
  ],
  ['801230', '综合', ['综合'], ['复旦复华', '东阳光']],
  [
    '801710',
    '建筑材料',
    ['建材', '水泥', '玻璃玻纤'],
    ['海螺水泥', '东方雨虹'],
  ],
  [
    '801720',
    '建筑装饰',
    ['建筑', '工程', '装修装饰', '基础建设'],
    ['中国建筑', '中国中铁'],
  ],
  [
    '801730',
    '电力设备',
    ['电力设备', '电池', '光伏', '风电', '电网设备'],
    ['宁德时代', '隆基绿能'],
  ],
  [
    '801740',
    '国防军工',
    ['军工', '航空装备', '航天装备', '船舶制造'],
    ['中国船舶', '航发动力'],
  ],
  [
    '801750',
    '计算机',
    ['计算机', '软件', 'IT服务', '人工智能', '云计算'],
    ['海康威视', '科大讯飞'],
  ],
  [
    '801760',
    '传媒',
    ['传媒', '游戏', '广告营销', '影视', '出版', '媒体'],
    ['分众传媒', '三七互娱'],
  ],
  [
    '801770',
    '通信',
    ['通信', '通信设备', '运营商', '光模块'],
    ['中国移动', '中兴通讯'],
  ],
  ['801780', '银行', ['银行'], ['工商银行', '招商银行']],
  [
    '801790',
    '非银金融',
    ['证券', '保险', '多元金融'],
    ['中国平安', '中信证券'],
  ],
  [
    '801880',
    '汽车',
    ['汽车', '乘用车', '商用车', '汽车零部件'],
    ['比亚迪', '上汽集团'],
  ],
  [
    '801890',
    '机械设备',
    ['机械', '专用设备', '通用设备', '自动化设备'],
    ['三一重工', '汇川技术'],
  ],
  ['801950', '煤炭', ['煤炭', '焦煤', '动力煤'], ['中国神华', '陕西煤业']],
  [
    '801960',
    '石油石化',
    ['石油', '油气', '炼化', '石化'],
    ['中国石油', '中国海油'],
  ],
  [
    '801970',
    '环保',
    ['环保', '环境治理', '固废', '水务'],
    ['瀚蓝环境', '伟明环保'],
  ],
  ['801980', '美容护理', ['美容', '化妆品', '个护'], ['爱美客', '珀莱雅']],
].map(([code, name, keywords, leaders]) => ({
  code: code as string,
  name: name as string,
  keywords: keywords as string[],
  leaders: leaders as string[],
}));

export const US_SECTORS: SectorDefinition[] = [
  [
    'US-XLK',
    '信息技术',
    ['technology', 'software', 'semiconductor', 'AI', 'cloud'],
    ['Apple', 'Microsoft', 'Nvidia'],
  ],
  [
    'US-XLF',
    '金融',
    ['bank', 'financial', 'insurance', 'credit'],
    ['JPMorgan', 'Visa', 'Mastercard'],
  ],
  [
    'US-XLV',
    '医疗保健',
    ['healthcare', 'pharma', 'biotech', 'drug'],
    ['Eli Lilly', 'Johnson & Johnson', 'UnitedHealth'],
  ],
  [
    'US-XLE',
    '能源',
    ['energy', 'oil', 'gas', 'crude'],
    ['Exxon', 'Chevron', 'ConocoPhillips'],
  ],
  [
    'US-XLY',
    '非必需消费',
    ['consumer discretionary', 'retail', 'auto', 'e-commerce'],
    ['Amazon', 'Tesla', 'Home Depot'],
  ],
  [
    'US-XLP',
    '必需消费',
    ['consumer staples', 'food', 'beverage', 'household'],
    ['Walmart', 'Costco', 'Procter & Gamble'],
  ],
  [
    'US-XLI',
    '工业',
    ['industrial', 'aerospace', 'machinery', 'transportation'],
    ['GE Aerospace', 'Caterpillar', 'RTX'],
  ],
  [
    'US-XLB',
    '原材料',
    ['materials', 'chemical', 'mining', 'metals'],
    ['Linde', 'Sherwin-Williams', 'Freeport-McMoRan'],
  ],
  [
    'US-XLU',
    '公用事业',
    ['utilities', 'electricity', 'power grid'],
    ['NextEra Energy', 'Southern Company', 'Duke Energy'],
  ],
  [
    'US-XLRE',
    '房地产',
    ['real estate', 'REIT', 'property'],
    ['Prologis', 'American Tower', 'Equinix'],
  ],
  [
    'US-XLC',
    '通信服务',
    ['communication services', 'media', 'telecom', 'advertising'],
    ['Meta', 'Alphabet', 'Netflix'],
  ],
].map(([code, name, keywords, leaders]) => ({
  code: code as string,
  name: name as string,
  keywords: keywords as string[],
  leaders: leaders as string[],
}));

export const MARKET_INDEXES: SectorDefinition[] = [
  ['IDX-CN-SSE', '上证指数', ['idx-cn-sse'], ['上海市场']],
  ['IDX-CN-SZSE', '深证成指', ['idx-cn-szse'], ['深圳市场']],
  ['IDX-CN-CSI300', '沪深300', ['idx-cn-csi300'], ['A股大盘核心资产']],
  ['IDX-CN-CSI500', '中证500', ['idx-cn-csi500'], ['A股中盘样本']],
  ['IDX-CN-CHINEXT', '创业板指', ['idx-cn-chinext'], ['A股成长企业']],
  ['IDX-CN-STAR50', '科创50', ['idx-cn-star50'], ['A股科技创新企业']],
  ['IDX-US-SP500', '标普500', ['idx-us-sp500'], ['S&P 500']],
  ['IDX-US-NASDAQ100', '纳斯达克100', ['idx-us-nasdaq100'], ['Nasdaq 100']],
  [
    'IDX-US-NASDAQ',
    '纳斯达克综合指数',
    ['idx-us-nasdaq'],
    ['Nasdaq Composite'],
  ],
  ['IDX-US-DOW', '道琼斯工业指数', ['idx-us-dow'], ['Dow Jones']],
  ['IDX-US-RUSSELL2000', '罗素2000', ['idx-us-russell2000'], ['Russell 2000']],
  ['IDX-HK-HSI', '恒生指数', ['idx-hk-hsi'], ['Hang Seng Index']],
  ['IDX-KR-KOSPI', '韩国KOSPI', ['idx-kr-kospi'], ['KOSPI Composite']],
  ['IDX-TW-TAIEX', '台湾加权指数', ['idx-tw-taiex'], ['TSEC Weighted']],
  ['IDX-JP-NIKKEI', '日经225', ['idx-jp-nikkei'], ['Nikkei 225']],
  ['IDX-DE-DAX', '德国DAX', ['idx-de-dax'], ['DAX Performance Index']],
  ['IDX-UK-FTSE', '英国富时100', ['idx-uk-ftse'], ['FTSE 100']],
  // 欧元50 已移除：东财只有它的实时行情、没有 K 线；同花顺全球指数段（试遍 1–99 市场号 × 40 余种代码拼法）、
  // 腾讯、新浪、WSCN、stooq、CNBC 全部拿不到它的历史日线。与其保留一个「走势图永远显示数据不足」的页面，
  // 不如不展示该指数。**若要重新加入，必须先找到可用的历史源。**
].map(([code, name, keywords, leaders]) => ({
  code: code as string,
  name: name as string,
  keywords: keywords as string[],
  leaders: leaders as string[],
}));

const CHINA_INDEX_SECIDS: Record<string, string> = {
  'IDX-CN-SSE': '1.000001',
  'IDX-CN-SZSE': '0.399001',
  'IDX-CN-CSI300': '1.000300',
  'IDX-CN-CSI500': '1.000905',
  'IDX-CN-CHINEXT': '0.399006',
  'IDX-CN-STAR50': '1.000688',
};

/**
 * 东方财富 secid 前缀：**100 = 国际指数，105 = 纳斯达克，106 = 纽交所，107 = 美交所/ARCA（ETF）**。
 * 11 个海外指数的代码是 2026-09 从东财 `m:100` 全表（63 项）里逐个挑出来并实测回报的，
 * 不再走 Yahoo（Yahoo 自 2021-11-01 起对大陆直接 403，见 README）。
 * 欧元50 在东财列表里，但已随指数一起移除（理由见 `MARKET_INDEXES` 处的注释）。
 */
const GLOBAL_INDEX_SECIDS: Record<string, string> = {
  'IDX-US-SP500': '100.SPX',
  'IDX-US-NASDAQ100': '100.NDX100',
  // 注意：100.NDX 是纳斯达克**综合**指数（值 26333.04，与 ^IXIC 一致），
  // 100.NDX100 才是纳斯达克100（29368.44）。别写反。
  'IDX-US-NASDAQ': '100.NDX',
  'IDX-US-DOW': '100.DJIA',
  'IDX-HK-HSI': '100.HSI',
  'IDX-KR-KOSPI': '100.KS11',
  'IDX-TW-TAIEX': '100.TWII',
  'IDX-JP-NIKKEI': '100.N225',
  'IDX-DE-DAX': '100.GDAXI',
  'IDX-UK-FTSE': '100.FTSE',
  // 东财 m:100 的 63 个指数里**没有**罗素2000，改用 IWM（iShares 罗素2000 ETF）代理，
  // 与美股行业用 ETF 代理同一套逻辑，并在 proxyDisclosure 里如实披露。
  'IDX-US-RUSSELL2000': '107.IWM',
};

/** 这些代码拿到的不是指数本身而是 ETF 代理，必须披露。 */
const GLOBAL_INDEX_PROXY_CODES = new Set(['IDX-US-RUSSELL2000']);

/** 11 个美股行业 ETF 同样走东财（美交所/ARCA，前缀 107），一次批量请求取回。 */
const US_SECTOR_SECIDS: Record<string, string> = Object.fromEntries(
  US_SECTORS.map((sector) => [sector.code, `107.${sector.code.slice(3)}`]),
);

;

/**
 * 情绪词典。**这是整套信息面评分的信号源**：命中不了词的新闻一律算中性，
 * 而中性的新闻对分数没有任何贡献。实测发现旧词典让 85% 的事件落到中性，
 * 于是「样本再多也没用」——信息分几乎恒等于 50。所以这里刻意做得厚一些。
 *
 * 英文词用词边界匹配（见 `matchesTerm`），所以可以放心放 `rise`/`miss`/`slide`
 * 这类短词，不会误伤 `surprise`、`missing`、`slideshow`。
 */
const POSITIVE = [
  '增长',
  '上调',
  '超预期',
  '利好',
  '支持',
  '突破',
  '中标',
  '回购',
  '增持',
  '盈利',
  '改善',
  '复苏',
  '创新高',
  '降息',
  '扩产',
  '提价',
  '签约',
  '回升',
  '回暖',
  '涨价',
  '放量',
  '新高',
  '提速',
  '减税',
  '补贴',
  '刺激',
  '提振',
  '订单增长',
  'growth',
  'beat',
  'beats',
  'beat estimates',
  'raises guidance',
  'record revenue',
  'record high',
  'profit rises',
  'rate cut',
  'expand',
  'expands',
  'expansion',
  'approval',
  'approved',
  'gain',
  'gains',
  'rise',
  'rises',
  'rose',
  'rally',
  'rallies',
  'jump',
  'jumps',
  'climb',
  'climbs',
  'surge',
  'surges',
  'rebound',
  'rebounds',
  'recovery',
  'upbeat',
  'optimism',
  'boost',
  'boosts',
  'stimulus',
  'inject',
  'injection',
  'ease',
  'eases',
  'easing',
  'upgrade',
  'upgraded',
  'outperform',
  'bullish',
  'strong',
  'stronger',
  'higher',
  'lift',
  'lifts',
  'tailwind',
  'bright spot',
  'reopen',
  'reopens',
];
const NEGATIVE = [
  '下滑',
  '亏损',
  '低于预期',
  '利空',
  '处罚',
  '减持',
  '终止',
  '暴跌',
  '风险',
  '收缩',
  '裁员',
  '违约',
  '下调',
  '调查',
  '召回',
  '跌停',
  '重挫',
  '承压',
  '萎缩',
  '低迷',
  '退市',
  '警示',
  'decline',
  'declines',
  'miss',
  'misses',
  'misses estimates',
  'cuts guidance',
  'cuts forecast',
  'cuts outlook',
  'cuts jobs',
  'loss',
  'losses',
  'layoffs',
  'investigation',
  'probe',
  'recall',
  'tariff',
  'tariffs',
  'downgrade',
  'downgraded',
  'recession',
  'fall',
  'falls',
  'fell',
  'drop',
  'drops',
  'dropped',
  'slide',
  'slides',
  'slid',
  'slump',
  'slumps',
  'plunge',
  'plunges',
  'tumble',
  'tumbles',
  'sink',
  'sinks',
  'sank',
  'dent',
  'dents',
  'dented',
  'drag',
  'drags',
  'dragged',
  'weak',
  'weaker',
  'weakness',
  'shrink',
  'shrinks',
  'shrinking',
  'contraction',
  'contracts',
  'deflation',
  'slowdown',
  'slows',
  'warn',
  'warns',
  'warning',
  'lower',
  'lowers',
  'downturn',
  'selloff',
  'sell-off',
  'sanction',
  'sanctions',
  'ban',
  'bans',
  'restriction',
  'restrictions',
  'default',
  'glut',
  'oversupply',
  'worry',
  'worries',
  'fear',
  'fears',
  'concern',
  'concerns',
  'pressure',
  'pressured',
  'headwind',
  'headwinds',
  'shortfall',
  'slashed',
  'halt',
  'halts',
  'suspended',
  'delisted',
  'bankruptcy',
];
const MACRO = [
  '经济',
  '政策',
  '利率',
  '通胀',
  '关税',
  '人民币',
  '美元',
  '贸易',
  '出口',
  '消费',
  '投资',
  '财政',
  '央行',
];

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}
function round(value: number, digits = 2) {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
}
function hash(value: string) {
  let acc = 2166136261;
  // 用 for...of 按码位迭代，等价于 [...value]，但不会触发 no-misused-spread。
  for (const char of value) {
    acc = (acc * 31 + char.charCodeAt(0)) >>> 0;
  }
  return acc;
}

/**
 * 交易所官方公告的休市日。
 *
 * - CN：上交所《关于上海证券交易所 2026 年部分节假日休市安排的通知》
 *   （上证公告〔2025〕45 号，2025-12-22 发布）。这里按公告原文的**休市区间**
 *   录入，便于逐条核对；区间内的周末也被包含。
 *   **2027 年安排尚未公布**，未命中日历的日期会退化为「只判断周末」。
 * - US：NYSE 官方 Holidays & Trading Hours（2026 与 2027 均已公布）。
 * - 港股/日股/韩股/台股/德股/英股的节假日**未覆盖**，这几家指数只按周末判断。
 */
const CN_MARKET_CLOSURES: Array<[string, string]> = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
];

const US_MARKET_CLOSURES: string[] = [
  // 2026
  '2026-01-01', // 元旦
  '2026-01-19', // 马丁·路德·金日
  '2026-02-16', // 华盛顿诞辰
  '2026-04-03', // 耶稣受难日
  '2026-05-25', // 阵亡将士纪念日
  '2026-06-19', // 六月节
  '2026-07-03', // 独立日（7/4 为周六，提前至周五休市）
  '2026-09-07', // 劳动节
  '2026-11-26', // 感恩节
  '2026-12-25', // 圣诞节
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18', // 六月节（6/19 为周六，提前至周五）
  '2027-07-05', // 独立日（7/4 为周日，顺延至周一）
  '2027-09-06',
  '2027-11-25',
  '2027-12-24', // 圣诞节（12/25 为周六，提前至周五）
];

/** NYSE 提前收盘日：13:00 ET 收市（非全天休市）。 */

/** 该市场在给定当地日期是否休市（节假日；周末由 weekday 单独判断）。 */
export function isMarketHoliday(session: MarketSession, dateKey: string) {
  if (session === 'CN') {
    return CN_MARKET_CLOSURES.some(
      ([from, to]) => dateKey >= from && dateKey <= to,
    );
  }
  if (session === 'US') return US_MARKET_CLOSURES.includes(dateKey);
  return EXCHANGE_CALENDARS[session].dates.includes(dateKey);
}

export function sessionPhase(session: MarketSession, date = new Date()): MarketPhase {
  const window = MARKET_SESSIONS[session];
  const { weekday, minutes, dateKey } = localClock(session, date);
  if (weekday === 'Sat' || weekday === 'Sun' || isMarketHoliday(session, dateKey)) return 'CLOSED';
  const close = sessionClose(session, dateKey);
  if (window.break.length && minutes >= window.break[0] && minutes < window.break[1] && minutes < close) return 'BREAK';
  if (minutes >= window.open && minutes < close) return 'TRADING';
  if (session === 'US' && minutes >= 240 && minutes < window.open) return 'PREMARKET';
  if (session === 'US' && minutes >= close && minutes < 1200) return 'POSTMARKET';
  return 'CLOSED';
}

export function marketPhase(region: MarketRegion, date = new Date()): MarketPhase {
  if (region === 'INDEX') return Object.keys(MARKET_SESSIONS).some(session => sessionPhase(session as MarketSession, date) === 'TRADING') ? 'TRADING' : 'CLOSED';
  return sessionPhase(region, date);
}

export function marketCacheTtlMs(now = new Date()) {
  if (sessionPhase('CN', now) === 'TRADING') return 3 * 60 * 1000;
  if (sessionPhase('US', now) === 'TRADING') return 5 * 60 * 1000;
  if (Object.keys(MARKET_SESSIONS).some(session => sessionPhase(session as MarketSession, now) === 'TRADING')) return 3 * 60 * 1000;
  return 15 * 60 * 1000;
}

export function isSessionTradeDate(session: MarketSession, dateKey: string) {
  const weekday = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !isMarketHoliday(session, dateKey);
}

export function nextTradeDate(session: MarketSession, dateKey: string) {
  for (let i = 1; i <= 370; i++) {
    const day = shiftDate(dateKey, i);
    if (!calendarCoverage(session, day).covered) return null;
    if (isSessionTradeDate(session, day)) return day;
  }
  return null;
}

export function latestCompletedTradeDate(session: MarketSession, now = new Date()) {
  const clock = localClock(session, now);
  for (let i = 0; i <= 370; i++) {
    const day = shiftDate(clock.dateKey, -i);
    if (isSessionTradeDate(session, day) && (i > 0 || clock.minutes >= sessionClose(session, day))) return day;
  }
  return clock.dateKey;
}

export function historyFreshness(code: string, lastDate: string | undefined, now = new Date()) {
  const session = sessionForCode(code);
  const clock = localClock(session, now);
  const expectedDate = latestCompletedTradeDate(session, now);
  const covered = calendarCoverage(session, expectedDate).covered && calendarCoverage(session, clock.dateKey).covered;
  return { expectedDate, lastDate: lastDate ?? null, calendarCovered: covered,
    fresh: covered && Boolean(lastDate && lastDate >= expectedDate && lastDate <= clock.dateKey) };
}

/** Recompute market phase when reusing a snapshot; never extend quote age. */
export function refreshSnapshotFreshness(snapshot: MarketSnapshot, now = new Date()): MarketSnapshot {
  const update = (item: SectorSnapshot) => {
    const session = sessionForCode(item.code);
    const age = now.getTime() - Date.parse(item.freshness.quoteTime);
    const expired = !Number.isFinite(age) || age < 0 || age >= 86_400_000;
    const phase = sessionPhase(session, now);
    const freshness = { ...item.freshness, session, marketPhase: phase, outlookLabel: outlookLabel(phase),
      calendar: calendarCoverage(session, localClock(session, now).dateKey),
      ...(expired ? { delayLevel: 'STALE' as const, dataStatus: 'STALE' as const } : {}) };
    return expired ? { ...item, freshness, dataAvailable: false, nextSessionDirection: null,
      nextSessionUpPct: null, nextSessionDownPct: null, change: 0, upCount: 0, downCount: 0,
      volumeRatio: 1, momentum5d: null, mainNetInflow: null, mainNetInflowPct: null } : { ...item, freshness };
  };
  const sectors = snapshot.sectors.map(update);
  const usSectors = snapshot.usSectors.map(update);
  const indexes = snapshot.indexes.map(update);
  const freshness = { ...snapshot.freshness };
  for (const region of ['CN','US','INDEX'] as const) {
    const phase = marketPhase(region, now);
    const items = region === 'CN' ? sectors : region === 'US' ? usSectors : indexes;
    freshness[region] = { ...freshness[region], marketPhase: phase, outlookLabel: outlookLabel(phase),
      ...(items.some(item => !item.dataAvailable) ? { delayLevel: 'STALE', dataStatus: 'STALE' } : {}) };
  }
  return { ...snapshot, sectors, usSectors, indexes, freshness,
    dataStatus: [...sectors,...usSectors,...indexes].some(item => !item.dataAvailable) ? 'STALE' : snapshot.dataStatus };
}

/** 全市场都没取到行情时，只等 60 秒就重试，不占用完整的缓存周期。 */
export const EMPTY_SNAPSHOT_RETRY_MS = 60 * 1000;

/**
 * 快照级缓存 TTL。
 *
 * 一个行情都没取到，几乎总是"这一轮网络整体异常"（例如运行时刚冷启动、
 * 出口代理还没就绪）。实测过这种空快照会被钉住整个 TTL 周期，让页面在
 * 十几分钟里一直显示"暂无数据"，所以这里单独给一个短重试窗口。
 *
 * 只有"全空"才缩短；Yahoo 单边降级（部分行业仍有数据）走正常 TTL，
 * 否则会变成每分钟重试一次，反而更容易被上游限流。
 */
export function snapshotCacheTtlMs(
  snapshot: MarketSnapshot,
  now = new Date(),
) {
  const hasAnyQuote = [
    ...snapshot.sectors,
    ...snapshot.usSectors,
    ...snapshot.indexes,
  ].some((sector) => sector.dataAvailable);
  if (!hasAnyQuote) return EMPTY_SNAPSHOT_RETRY_MS;
  return marketCacheTtlMs(now);
}

function outlookLabel(phase: MarketPhase): QuoteFreshness['outlookLabel'] {
  return phase === 'TRADING' ? '盘中信息面观察' : '下一交易日统计展望';
}

function makeFreshness(
  region: MarketRegion,
  receivedAt: string,
  rows: BoardRow[],
  available: boolean,
  session?: MarketSession,
): QuoteFreshness {
  const phase = session ? sessionPhase(session, new Date(receivedAt)) : marketPhase(region, new Date(receivedAt));
  const latestQuote = rows
    .map((row) => row.quoteTime)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  const isProxy = rows.some((row) => row.isProxy === true);
  const sources = [...new Set(rows.map((row) => row.source).filter(Boolean))];
  const rowDelay = rows.some((row) => row.delayLevel === 'DELAYED_15M')
    ? 'DELAYED_15M'
    : rows.some((row) => row.delayLevel === 'NEAR_REALTIME')
      ? 'NEAR_REALTIME'
      : undefined;
  // 有任何一行是「上游不可用期间复用的缓存副本」，整组就不能按近实时披露。
  const anyStale = rows.some((row) => row.delayLevel === 'STALE');
  const degraded = !available || anyStale;
  const delayLevel: DelayLevel = degraded
    ? 'STALE'
    : phase === 'TRADING' && rowDelay
      ? rowDelay
      : 'LAST_CLOSE';
  return {
    ...(session ? { session, calendar: calendarCoverage(session, localClock(session, new Date(receivedAt)).dateKey) } : {}),
    quoteTime: latestQuote ?? receivedAt,
    receivedAt,
    source: sources.join(' / ') || '暂无可用行情源',
    backupSource:
      region === 'CN'
        ? 'AKShare Stock MCP（A股、港股、国内指数、北向、龙虎榜）'
        : region === 'US'
          ? '东方财富批量行情 / 最近有效日线缓存'
          : 'AKShare Stock MCP / 最近有效日线缓存',
    delayLevel,
    isProxy,
    dataStatus: degraded ? 'STALE' : phase === 'TRADING' ? 'FRESH' : 'DELAYED',
    marketPhase: phase,
    outlookLabel: outlookLabel(phase),
  };
}
export function informationToneFromScore(score: number): InformationTone {
  return score >= 52 ? '积极' : '谨慎';
}

export function nextSessionSignalFromScore(score: number) {
  const compressed = Math.round(clamp(50 + (score - 50) * 0.7, 30, 70));
  const upPct =
    score >= 52 ? Math.max(51, compressed) : Math.min(49, compressed);
  const downPct = 100 - upPct;
  return {
    direction: (upPct > downPct ? '上涨' : '下跌') as NextSessionDirection,
    upPct,
    downPct,
  };
}

/** 词边界模式缓存：英文词按词边界匹配，中文词按子串匹配。 */
const TONE_PATTERN_CACHE = new Map<string, RegExp>();
export function matchesTerm(text: string, term: string) {
  if (!/[a-z]/i.test(term)) return text.includes(term);
  let pattern = TONE_PATTERN_CACHE.get(term);
  if (!pattern) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
    TONE_PATTERN_CACHE.set(term, pattern);
  }
  return pattern.test(text);
}

/**
 * 关键词情绪判定。它**不是**情感模型，只是一套可解释的词表命中计数：
 * 命中数相同时判中性，宁可中性也不向某一侧偏。
 * 之所以改成词边界匹配：旧实现用 `includes`，`rise` 会命中 `surprise`、
 * `miss` 会命中 `dismissed`，方向直接被带偏。
 */
export function toneFor(text: string): NewsEvent['tone'] {
  let positive = 0;
  for (const word of POSITIVE) if (matchesTerm(text, word)) positive += 1;
  let negative = 0;
  for (const word of NEGATIVE) if (matchesTerm(text, word)) negative += 1;
  return positive > negative ? '正向' : negative > positive ? '负向' : '中性';
}

function sectorsFor(text: string): string[] {
  const matches = SECTORS.filter((sector) =>
    [...sector.keywords, ...sector.leaders].some((word) => text.includes(word)),
  ).map((sector) => sector.code);
  if (matches.length) return matches;
  return MACRO.some((word) => text.includes(word))
    ? SECTORS.map((sector) => sector.code)
    : [];
}

type BoardRow = {
  f3?: number;
  /** 东方财富 f10：量比（当日成交量 ÷ 前 5 日均量）。 */
  f10?: number;
  f12?: string;
  f14?: string;
  f20?: number;
  f62?: number;
  f184?: number;
  f104?: number;
  f105?: number;
  f109?: number;
  f128?: string;
  quoteTime?: string;
  source?: string;
  delayLevel?: DelayLevel;
  isProxy?: boolean;
  volumeRatio?: number;
  /** 真实 5 日涨跌幅（%）。东方财富 f109，或由日线收盘价反推。 */
  change5d?: number | null;
};

function sourceKind(url: string): 'NEWS' | 'QUOTE' {
  return /push2|d\.10jqka|ifzq\.gtimg|US_MinKService|CN_MarketData/.test(url) ? 'QUOTE' : 'NEWS';
}

async function fetchJson<T>(url: string, timeout = 9000, extraHeaders: Record<string, string> = {}): Promise<T> {
  const body = await readSourceBody(url, sourceKind(url), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: {
        Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://data.eastmoney.com/', 'User-Agent': BROWSER_UA, ...extraHeaders,
      }});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      JSON.parse(text);
      return text;
    } finally { clearTimeout(timer); }
  });
  return JSON.parse(body) as T;
}

/**
 * 各市场交易时段（本地时间，分钟数）。用于判断某个标的的日线数据
 * 「现在还会不会变」——休市期间日线是最终值，可以安全地长时间复用。
 */
const MARKET_SESSIONS = SESSION_WINDOWS;

export type MarketSession = keyof typeof MARKET_SESSIONS;

function sessionOfSymbol(symbol: string): MarketSession {
  if (symbol.startsWith('^HSI')) return 'HK';
  if (symbol.startsWith('^N225')) return 'JP';
  if (symbol.startsWith('^KS11')) return 'KR';
  if (symbol.startsWith('^TWII')) return 'TW';
  if (symbol.startsWith('^GDAXI')) return 'DE';
  if (symbol.startsWith('^FTSE')) return 'UK';
  return 'US';
}

/**
 * 该市场此刻是否在交易时段内。
 * 覆盖周末与（CN/US 的）官方节假日；其它市场只有周末判断。
 */
export function isMarketSessionOpen(session: MarketSession, date = new Date()) {
  return sessionPhase(session, date) === 'TRADING';
}

export function isQuoteMarketOpen(symbol: string, date = new Date()) {
  return isMarketSessionOpen(sessionOfSymbol(symbol), date);
}

/**
 * 上游行情读缓存。
 *
 * 背景：Yahoo 对高频访问会直接返回 403 + HTML 错误页（不是 JSON），
 * 实测会导致整轮美股 11 行业与 11 个海外指数同时降级。
 * 而日线在休市期间不会变化，所以按「该市场是否在交易时段」决定复用窗口：
 * 开市 3 分钟、休市 6 小时；抓取失败时最多回退 24 小时内的副本。
 *
 * 两层存储：isolate 内存 → Cache API（跨 isolate 共享）。
 * Cache API 在本地 Node 预览环境不存在，此时静默退化为纯内存缓存。
 */
const quoteCache = new Map<string, { at: number; body: string }>();
const QUOTE_CACHE_LIMIT = 120;

function quoteCacheStore(): Cache | null {
  try {
    const store = (globalThis as { caches?: { default?: Cache } }).caches
      ?.default;
    return store ?? null;
  } catch {
    return null;
  }
}

async function readQuoteCache(url: string) {
  const memory = quoteCache.get(url);
  if (memory) return memory;
  const store = quoteCacheStore();
  if (!store) return null;
  try {
    if (!reserveSourceCacheCall()) return null;
    const hit = await store.match(url);
    if (!hit) return null;
    const at = Number(hit.headers.get('x-fetched-at') ?? 0);
    const body = await hit.text();
    if (!at || !body) return null;
    const entry = { at, body };
    quoteCache.set(url, entry);
    return entry;
  } catch {
    return null;
  }
}

async function writeQuoteCache(url: string, body: string, at: number) {
  const entry = { at, body };
  quoteCache.set(url, entry);
  if (quoteCache.size > QUOTE_CACHE_LIMIT) {
    const oldest = [...quoteCache.entries()].sort(
      (left, right) => left[1].at - right[1].at,
    )[0];
    if (oldest) quoteCache.delete(oldest[0]);
  }
  const store = quoteCacheStore();
  if (!store) return;
  try {
    if (!reserveSourceCacheCall()) return;
    await store.put(
      url,
      new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'max-age=86400',
          'x-fetched-at': String(entry.at),
        },
      }),
    );
  } catch {
    /* Cache API 不可用（额度或环境不支持）时仅依赖内存缓存。 */
  }
}

/** 休市时最多复用 6 小时的副本；交易时段内 3 分钟。 */
const QUOTE_FRESH_MS = { open: 3 * 60 * 1000, closed: 6 * 60 * 60 * 1000 };
/** 网络抓取失败时，允许回退到 24 小时内的任何副本。 */
const QUOTE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * 带缓存的行情读取策略：命中新鲜缓存 → 走网络 → 失败回退过期副本。
 *
 * 网络实现由 `load` 注入，一是让这里只关心"什么时候能复用旧数据"，
 * 二是让这段回退逻辑能被确定性测试（不必真的等 6 小时）。
 * `stale` 为 true 表示返回的是降级副本，调用方必须如实标注。
 */
export async function readCachedQuote<T>(
  url: string,
  session: MarketSession | readonly MarketSession[],
  load: () => Promise<T>,
  now = Date.now(),
): Promise<{ value: T; stale: boolean; fetchedAt: number }> {
  const sessions = typeof session === 'string' ? [session] : session;
  const freshMs = sessions.some(item => isMarketSessionOpen(item, new Date(now)))
    ? QUOTE_FRESH_MS.open
    : QUOTE_FRESH_MS.closed;
  const cached = await readQuoteCache(url);
  if (cached && now - cached.at >= 0 && now - cached.at < freshMs) {
    try {
      return { value: JSON.parse(cached.body) as T, stale: false, fetchedAt: cached.at };
    } catch {
      /* 缓存损坏，落到网络路径。 */
    }
  }
  try {
    const value = await load();
    await writeQuoteCache(url, JSON.stringify(value), now);
    return { value, stale: false, fetchedAt: now };
  } catch (error) {
    if (cached && now - cached.at >= 0 && now - cached.at < QUOTE_STALE_MS) {
      try {
        return { value: JSON.parse(cached.body) as T, stale: true, fetchedAt: cached.at };
      } catch {
        /* 缓存损坏，抛出原始错误。 */
      }
    }
    throw error;
  }
}

function fetchQuoteJson<T>(url: string, session: MarketSession | readonly MarketSession[]) {
  return readCachedQuote<T>(url, session, () => fetchJson<T>(url));
}

async function fetchBoards(): Promise<BoardRow[]> {
  // 只请求真正用到的字段（原实现带了 f2/f4/f8/f136，全程未被读取）。
  const fields =
    'f3,f10,f12,f14,f20,f62,f104,f105,f109,f128,f184';
  const pages = await Promise.all(
    [1, 2, 3, 4, 5].map((page) =>
      fetchQuoteJson<{ data?: { diff?: BoardRow[] } }>(
        `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=${fields}`,
        'CN',
      ),
    ),
  );
  const rows = pages.flatMap((page) => page.value.data?.diff ?? []);
  if (!rows.length) throw new Error('行业资金流与板块行情为空');
  const stale = pages.some((page) => page.stale);
  // f10（量比）与 f109（5 日涨跌幅）保持原始字段名，由 boardMetrics 直接消费，
  // 避免中间再映射一层导致字段被静默丢弃。
  return rows.map((row) => ({
    ...row,
    quoteTime: new Date(Math.min(...pages.map(page => page.fetchedAt))).toISOString(),
    source: `mcp-eastmoney · 东方财富板块资金流${
      stale ? '（上游不可用期间复用缓存副本）' : ''
    }`,
    delayLevel: stale ? ('STALE' as const) : ('DELAYED_15M' as const),
    isProxy: false,
  }));
}

type NewsRow = {
  code?: string;
  title?: string;
  summary?: string;
  showTime?: string;
  uniqueUrl?: string;
  url?: string;
  mediaName?: string;
};
async function fetchNewsColumn(column: 350 | 351): Promise<NewsEvent[]> {
  const url = `https://np-listapi.eastmoney.com/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=${column}&pageSize=30&page=1&req_trace=${Date.now()}`;
  const json = await fetchJson<{ data?: { list?: NewsRow[] } }>(url);
  const kind: NewsEvent['kind'] = column === 350 ? '国内经济' : '国际经济';
  return (json.data?.list ?? []).map((row, index) => {
    const text = `${row.title ?? ''} ${row.summary ?? ''}`;
    return {
      id: row.code ?? `${column}-${index}`,
      title: row.title ?? '未命名资讯',
      summary: row.summary ?? '',
      source: row.mediaName ?? '东方财富资讯',
      publishedAt: toIso(row.showTime, ''),
      url: row.uniqueUrl ?? row.url ?? '',
      tone: toneFor(text),
      kind,
      region: 'CN' as const,
      sectors: sectorsFor(text),
    };
  });
}

type NoticeRow = {
  art_code?: string;
  title?: string;
  display_time?: string;
  codes?: { short_name?: string; stock_code?: string }[];
  columns?: { column_name?: string }[];
};
async function fetchNotices(): Promise<NewsEvent[]> {
  const url =
    'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=80&page_index=1&ann_type=A&client_source=web&f_node=1&s_node=0';
  const json = await fetchJson<{ data?: { list?: NoticeRow[] } }>(url);
  return (json.data?.list ?? [])
    .map((row, index) => {
      const company = row.codes?.[0]?.short_name ?? '';
      const title = row.title ?? '上市公司公告';
      const text = `${company} ${title} ${(row.columns ?? []).map((item) => item.column_name).join(' ')}`;
      return {
        id: row.art_code ?? `notice-${index}`,
        title,
        summary: company ? `${company}发布最新公告` : '上市公司最新公告',
        source: company || '上市公司公告',
        publishedAt: toIso(row.display_time, ''),
        url: row.art_code
          ? `https://data.eastmoney.com/notices/detail/${row.codes?.[0]?.stock_code ?? ''}/${row.art_code}.html`
          : '',
        tone: toneFor(text),
        kind: '龙头公告' as const,
        region: 'CN' as const,
        sectors: sectorsFor(text),
      };
    })
    .filter((event) => event.sectors.length > 0);
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function xmlTag(block: string, tag: string) {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  return match ? decodeXml(match[1]) : '';
}

function sectorsForUs(text: string): string[] {
  const normalized = text.toLowerCase();
  const matches = US_SECTORS.filter((sector) =>
    [...sector.keywords, ...sector.leaders].some((word) =>
      normalized.includes(word.toLowerCase()),
    ),
  ).map((sector) => sector.code);
  if (matches.length) return matches;
  return [
    'federal reserve',
    'inflation',
    'interest rate',
    'us economy',
    'jobs report',
    'tariff',
    'treasury',
    'wall street',
    'stocks',
    'stock market',
    's&p 500',
    'earnings',
  ].some((word) => normalized.includes(word))
    ? US_SECTORS.map((sector) => sector.code)
    : [];
}

/** 国名/地名/政策机构类标记。 */
const CHINA_GEO_MARKERS = [
  'china',
  'chinese',
  'beijing',
  'shanghai',
  'shenzhen',
  'hong kong',
  'mainland',
  'yuan',
  'renminbi',
  'pboc',
  'ndrc',
  'csi 300',
  'xi jinping',
];

/**
 * 中国企业/机构标记。
 * 针对中国公司的分析**本身就是「海外对中国产业的分析」**，所以给它们一条独立通道：
 * 中概股 feed 里的稿子标题常常只写公司名，正文也未必出现 "China"。
 */
const CHINA_COMPANY_MARKERS = [
  'alibaba',
  'baba',
  'pinduoduo',
  'pdd holdings',
  'temu',
  'jd.com',
  'meituan',
  'baidu',
  'tencent',
  'netease',
  'ant group',
  'didi',
  'kuaishou',
  'bilibili',
  'trip.com',
  'tcom',
  'nio',
  'xpeng',
  'li auto',
  'byd',
  'catl',
  'huawei',
  'xiaomi',
  'smic',
  'geely',
  'great wall motor',
  'moutai',
  'china mobile',
  'petrochina',
  'sinopec',
];

const CHINA_MARKERS = [...CHINA_GEO_MARKERS, ...CHINA_COMPANY_MARKERS];

/** 是否含中国主体标记（国名或中国企业）。英文按词边界匹配。 */
export function hasChinaMarker(text: string) {
  return CHINA_MARKERS.some((marker) => matchesTerm(text, marker));
}

/** 是否点名了中国企业/机构。 */
export function mentionsChineseCompany(text: string) {
  return CHINA_COMPANY_MARKERS.some((marker) => matchesTerm(text, marker));
}

/** 经济/产业类词。用于判定「是不是经济分析」而不是纯时政。 */
const ECONOMY_TERMS = [
  'economy',
  'economic',
  'market',
  'markets',
  'stock',
  'stocks',
  'shares',
  'trade',
  'tariff',
  'tariffs',
  'yuan',
  'renminbi',
  'consumer',
  'retail',
  'property',
  'real estate',
  'housing',
  'bank',
  'banks',
  'financial',
  'insurance',
  'credit',
  'technology',
  'semiconductor',
  'chip',
  'chips',
  'artificial intelligence',
  'manufacturing',
  'factory',
  'industrial',
  'machinery',
  'export',
  'exports',
  'airline',
  'airlines',
  'fuel',
  'energy',
  'oil',
  'coal',
  'power',
  'healthcare',
  'pharma',
  'biotech',
  'drug',
  'drugs',
  'electric vehicle',
  'electric vehicles',
  'automaker',
  'automakers',
  'auto sales',
  'battery',
  'batteries',
  'activity',
  'pmi',
  'stimulus',
  'growth',
  'earnings',
  // 公司/行业分析常用词：中概股 feed 里的稿子靠这些词过门槛。
  'revenue',
  'revenues',
  'margin',
  'margins',
  'guidance',
  'valuation',
  'estimates',
  'profit',
  'profits',
  'sales',
  'demand',
  'supply',
  'pricing',
  'forecast',
  'outlook',
  'analyst',
  'analysts',
  'rating',
  'shipments',
  'market share',
];

function sectorsForForeignChina(text: string): string[] {
  const rules: Array<[string[], string[]]> = [
    [
      [
        'technology',
        'semiconductor',
        'chip',
        'chips',
        'artificial intelligence',
        'cloud',
        'data center',
      ],
      ['801080', '801750', '801770'],
    ],
    [
      ['property', 'real estate', 'housing'],
      ['801180', '801710', '801720'],
    ],
    [
      ['bank', 'banks', 'financial', 'insurance', 'credit'],
      ['801780', '801790'],
    ],
    [
      ['consumer', 'retail', 'restaurant', 'tourism'],
      ['801120', '801200', '801210'],
    ],
    [
      ['electric vehicle', 'electric vehicles', 'automaker', 'automakers', 'auto sales', 'battery'],
      ['801880', '801730'],
    ],
    [
      ['oil', 'energy', 'coal', 'power'],
      ['801950', '801960', '801160'],
    ],
    [['healthcare', 'pharma', 'biotech', 'drug', 'drugs'], ['801150']],
    [
      ['manufacturing', 'factory', 'industrial', 'machinery'],
      ['801890', '801040', '801050', '801030'],
    ],
    [
      ['export', 'exports', 'trade', 'tariff', 'tariffs'],
      ['801130', '801110', '801080', '801890', '801880'],
    ],
    // 以下是「只提公司名、不提国名」的分析，中概股 feed 里几乎全是这种。
    [
      [
        'alibaba',
        'baba',
        'pinduoduo',
        'pdd holdings',
        'temu',
        'jd.com',
        'meituan',
        'ant group',
        'kuaishou',
        'bilibili',
        'didi',
      ],
      ['801200', '801750', '801770'],
    ],
    [
      ['baidu', 'tencent', 'netease', 'trip.com', 'tcom'],
      ['801750', '801770', '801210'],
    ],
    [
      ['nio', 'xpeng', 'li auto', 'byd', 'geely', 'great wall motor'],
      ['801880', '801730'],
    ],
    [
      ['catl', 'smic', 'huawei', 'xiaomi', 'solar', 'photovoltaic'],
      ['801730', '801080', '801750'],
    ],
  ];
  const matched = new Set<string>();
  for (const [terms, codes] of rules) {
    if (terms.some((term) => matchesTerm(text, term))) {
      codes.forEach((code) => matched.add(code));
    }
  }
  if (matched.size) return [...matched];
  return hasChinaMarker(text) ? SECTORS.map((sector) => sector.code) : [];
}

/**
 * 地缘政治 / 军事 / 时政类词。
 * 这类稿子也常提中国，但**不属于「对中国经济与产业的分析」**，必须挡在池外：
 * 它们的行业归属会落到「全部行业」，等于一条军事新闻污染 31 个行业的分数。
 */
const GEOPOLITICAL_TERMS = [
  'military',
  'navy',
  'troops',
  'missile',
  'missiles',
  'war',
  'warfare',
  'strike',
  'strikes',
  'killed',
  'weapons',
  'arms sale',
  'arms sales',
  'geopolitical',
  'satellite imagery',
  'diplomatic',
  'alliance',
  'alliances',
  'okinawa',
  'invasion',
  'drills',
  'aircraft carrier',
  'nuclear',
  'espionage',
  'spy',
  'spying',
  'election',
  'propaganda',
  'human rights',
  'dissident',
  'taiwan',
  'south china sea',
  'state visits',
  'president xi',
  'xi jinping',
  'communist party',
  'politburo',
  'censorship',
  'border clash',
  'territorial',
];

/**
 * 判定一条海外内容是否属于「海外看中国」。三个条件缺一不可：
 *   1. 有中国主体（国名/地名/机构，或**中国公司**）；
 *   2. 不含地缘政治/军事/时政词；
 *   3. 要么点名了中国公司（针对中国公司的分析本身就是对中国产业的分析），
 *      要么出现经济产业词。
 * 用**标题 + 摘要**一起判断：很多文章标题不提中国、正文才提，只匹配标题会大量漏掉。
 */
export function isForeignChinaAnalysis(text: string) {
  if (!hasChinaMarker(text)) return false;
  if (GEOPOLITICAL_TERMS.some((term) => matchesTerm(text, term))) return false;
  if (mentionsChineseCompany(text)) return true;
  return ECONOMY_TERMS.some((term) => matchesTerm(text, term));
}

async function fetchText(url: string, timeout = 9000, extraHeaders: Record<string, string> = {}) {
  return readSourceBody(url, sourceKind(url), async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: {
        Accept: 'application/rss+xml, application/atom+xml, text/xml',
        'User-Agent': 'StrongestAnalyst/1.0 public-information-research', ...extraHeaders,
      }});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (sourceKind(url) === 'NEWS' && /\.xml|feed|rss|sec\.gov/.test(url) && !/<(?:rss|feed|rdf:RDF)\b/i.test(body)) {
        throw new Error('新闻响应不是有效 RSS/Atom');
      }
      return body;
    } finally { clearTimeout(timer); }
  });
}

type FeedResult = { defaultSource: string; xml: string };

async function fetchFeedGroup(
  specs: Array<{ url: string; defaultSource: string }>,
  timeout: number,
): Promise<FeedResult[]> {
  const results = await Promise.allSettled(
    specs.map((spec) => fetchText(spec.url, timeout)),
  );
  return results.flatMap((result, index) =>
    result.status === 'fulfilled'
      ? [{ defaultSource: specs[index].defaultSource, xml: result.value }]
      : [],
  );
}

/**
 * 海外财经 RSS 源：美股行业与「海外看中国」两条链路共用同一批源。
 * 同一轮快照里只抓一次，避免重复请求同一批 URL。
 *
 * 这里每一个 URL 都在 2026-09 实测过**可达性**，不是照抄文档：
 *   ✅ 可达：CNBC（5 个主题 feed，id 逐个试出来的）、WSJ（markets / world / opinion）、
 *      MarketWatch（3 个）、Nasdaq（markets / international）、Fortune、Seeking Alpha
 *   ❌ 已移除：Bloomberg、FT（连接超时）；Reuters / BBC / Guardian / NYT / AP / CNN /
 *      Business Insider / Nikkei / SCMP / DW / Economist / Al Jazeera / CNA / ZeroHedge
 *      （超时、连接重置或 403）；Google News 聚合（超时，见 README「新闻源」）。
 * 教训：**新加源之前先测可达性**，否则只是把死 URL 写进代码——本项目之前就是这样
 * 在名单里挂着一堆永远取不到数的「来源」，看起来有五家媒体在供数，实际只有两家。
 */
const OVERSEAS_FEED_SPECS = [
  {
    url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    defaultSource: 'CNBC',
  },
  // CNBC 各主题 feed 实测都可达（id 逐个试出来的，404 的已剔除）。
  // 单靠一个综合 feed 时「海外看中国」一天只有个位数条，主题 feed 能显著补量。
  {
    url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',
    defaultSource: 'CNBC',
  },
  {
    url: 'https://www.cnbc.com/id/19854910/device/rss/rss.html',
    defaultSource: 'CNBC',
  },
  {
    url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',
    defaultSource: 'CNBC',
  },
  {
    url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html',
    defaultSource: 'CNBC',
  },
  {
    url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
    defaultSource: 'The Wall Street Journal',
  },
  {
    url: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
    defaultSource: 'The Wall Street Journal',
  },
  // 评论/观点版：正是「经济学家与机构分析」这类内容，对海外看中国池最对口。
  {
    url: 'https://feeds.content.dowjones.io/public/rss/RSSOpinion',
    defaultSource: 'The Wall Street Journal',
  },
  // MarketWatch 与 WSJ 同属道琼斯集团，但编辑团队独立；三个 feed 都是本轮实测新解锁的。
  {
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
    defaultSource: 'MarketWatch',
  },
  {
    url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',
    defaultSource: 'MarketWatch',
  },
  {
    url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines',
    defaultSource: 'MarketWatch',
  },
  {
    url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets',
    defaultSource: 'Nasdaq',
  },
  {
    url: 'https://www.nasdaq.com/feed/rssoutbound?category=International',
    defaultSource: 'Nasdaq',
  },
  // WSJ 的商业版：条目多（实测 85 条）、当天更新，是「海外看中国」的主要补量来源。
  {
    url: 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness',
    defaultSource: 'The Wall Street Journal',
  },
  // Rhodium Group 是美国专门研究中国经济的机构，正对方法论里的「经济学家及机构分析」。
  {
    url: 'https://rhg.com/feed/',
    defaultSource: 'Rhodium Group',
  },
  // 中概股专题 feed（Seeking Alpha 的公司级 feed，实测每支 30 条）。
  // 这些是海外分析师对中国公司的公开分析，是「海外看中国」里最贴近行业映射的一块。
  {
    url: 'https://seekingalpha.com/api/sa/combined/BABA.xml',
    defaultSource: 'Seeking Alpha',
  },
  {
    url: 'https://seekingalpha.com/api/sa/combined/PDD.xml',
    defaultSource: 'Seeking Alpha',
  },
  {
    url: 'https://seekingalpha.com/api/sa/combined/JD.xml',
    defaultSource: 'Seeking Alpha',
  },
  {
    url: 'https://seekingalpha.com/api/sa/combined/BIDU.xml',
    defaultSource: 'Seeking Alpha',
  },
  {
    url: 'https://seekingalpha.com/api/sa/combined/NIO.xml',
    defaultSource: 'Seeking Alpha',
  },
  {
    url: 'https://seekingalpha.com/api/sa/combined/TCOM.xml',
    defaultSource: 'Seeking Alpha',
  },
  {
    url: 'https://fortune.com/feed/',
    defaultSource: 'Fortune',
  },
  {
    url: 'https://seekingalpha.com/market_currents.xml',
    defaultSource: 'Seeking Alpha',
  },
];

async function fetchUsMainstreamNews(
  overseasFeeds: Promise<FeedResult[]>,
): Promise<NewsEvent[]> {
  // 这里原本还有 3 个 news.google.com 查询。实测全部连接超时：既白占 3 个出站请求，
  // 又把整个快照构建拖慢十几秒（超时是 15s）。已移除。
  const feeds = await overseasFeeds;
  // 名单只放**确定性可达且真在供数**的来源。Reuters / Bloomberg / FT / AP / NYT
  // 在本环境均不可达，继续挂在名单里只会让人以为「有五家媒体在供数」，实际一条都拿不到。
  const preferred = [
    'CNBC',
    'The Wall Street Journal',
    'wsj.com',
    'MarketWatch',
    'Nasdaq',
    'Fortune',
    'Seeking Alpha',
    'Rhodium Group',
  ];
  const seen = new Set<string>();
  return feeds
    .flatMap((feed) =>
      [...feed.xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap(
        (match, index) => {
          const block = match[1];
          const title = xmlTag(block, 'title');
          if (!title) return [];
          const source = xmlTag(block, 'source') || feed.defaultSource;
          const description = xmlTag(block, 'description');
          // 行业归属用**标题 + 摘要**判断：很多稿子标题只写公司名，
          // 行业词在正文里，只看标题会把它们全丢掉。
          // 情绪仍只看标题——正文更长、更容易误触发关键词。
          const sectors = sectorsForUs(`${title} ${description}`);
          if (!sectors.length) return [];
          if (!preferred.some((name) => source.includes(name))) return [];
          return [
            {
              id: `us-news-${hash(title)}-${index}`,
              title,
              summary: description.slice(0, 160),
              source,
              publishedAt: xmlTag(block, 'pubDate') || '',
              url: xmlTag(block, 'link'),
              tone: toneFor(title),
              kind: '美国财经' as const,
              region: 'US' as const,
              sectors,
            },
          ];
        },
      ),
    )
    .filter((event) => !seen.has(event.title) && seen.add(event.title))
    // 样本量上限从 45 提到 120：评分只取最近若干条，但候选池越大，
    // 行业越不容易因为「刚好没抓到那条新闻」而被误判。
    .slice(0, 120);
}

async function fetchForeignChinaAnalysis(
  overseasFeeds: Promise<FeedResult[]>,
): Promise<NewsEvent[]> {
  // 这里原本有 6 个 news.google.com 查询（含 22s 超时）。实测全部超时，已移除。
  const feeds = await overseasFeeds;
  const preferred = [
    'CNBC',
    'The Wall Street Journal',
    'wsj.com',
    'MarketWatch',
    'Nasdaq',
    'Fortune',
    'Seeking Alpha',
    'Rhodium Group',
  ];
  const seen = new Set<string>();
  return feeds
    .flatMap((feed) =>
      [...feed.xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].flatMap(
        (match, index) => {
          const block = match[1];
          const title = xmlTag(block, 'title');
          if (!title) return [];
          const source = xmlTag(block, 'source') || feed.defaultSource;
          if (!preferred.some((name) => source.includes(name))) return [];
          const description = xmlTag(block, 'description');
          // 判定用标题 + 摘要：只匹配标题会漏掉「标题写公司名、正文才提中国」的稿子。
          const text = `${title} ${description}`;
          if (!isForeignChinaAnalysis(text)) return [];
          const sectors = sectorsForForeignChina(text);
          if (!sectors.length) return [];
          return [
            {
              id: `foreign-cn-${hash(title)}-${index}`,
              title,
              summary:
                description.slice(0, 160) ||
                '海外媒体与机构对中国经济及产业的公开分析',
              source,
              publishedAt: xmlTag(block, 'pubDate') || '',
              url: xmlTag(block, 'link'),
              tone: toneFor(title),
              kind: '海外看中国' as const,
              region: 'CN' as const,
              sectors,
            },
          ];
        },
      ),
    )
    .filter((event) => !seen.has(event.title) && seen.add(event.title))
    .slice(0, 80);
}

async function fetchSecFilings(): Promise<NewsEvent[]> {
  const xml = await fetchText(
    'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=10-k%2C10-q%2C8-k&owner=exclude&count=100&output=atom',
  );
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)]
    .map((match, index) => {
      const block = match[1];
      const title = xmlTag(block, 'title');
      const sectors = sectorsForUs(title);
      const href = block.match(/<link[^>]+href="([^"]+)"/i)?.[1] ?? '';
      return {
        id: `sec-${hash(title)}-${index}`,
        title,
        summary: 'SEC EDGAR 公开披露',
        source: 'U.S. SEC',
        publishedAt: xmlTag(block, 'updated') || '',
        url: decodeXml(href),
        tone: toneFor(title),
        kind: 'SEC披露' as const,
        region: 'US' as const,
        sectors,
      };
    })
    .filter((event) => event.title && event.sectors.length)
    .slice(0, 20);
}

/** 把「2026-09-12 15:09:02」这类本地时间串转成带时区的 ISO；失败则回退。 */
function toIso(value: string | undefined, fallback: string, offset = '+08:00') {
  if (!value) return fallback;
  const parsed = new Date(`${value.slice(0, 19).replace(' ', 'T')}${offset}`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

/**
 * 中文财经快讯（新浪 7x24 + 华尔街见闻全球快讯）。两个 JSON 接口 2026-09 实测可达。
 * 补量的意义：它俩大量转述海外通讯社与机构观点，且本身就是中文，可直接进 A 股信息池。
 */
async function fetchCnFlashNews(): Promise<NewsEvent[]> {
  const [sina, wscn] = await Promise.allSettled([
    fetchJson<{
      result?: {
        data?: {
          feed?: {
            list?: Array<{
              id?: number;
              rich_text?: string;
              create_time?: string;
            }>;
          };
        };
      };
    }>(
      'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=30&zhibo_id=152&tag_id=0&dire=f&dpc=1',
      12000,
      { Referer: 'https://finance.sina.com.cn/' },
    ),
    fetchJson<{
      data?: {
        items?: Array<{
          id?: number;
          title?: string;
          content_text?: string;
          display_time?: number;
          uri?: string;
        }>;
      };
    }>(
      'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30',
      12000,
      { Referer: 'https://wallstreetcn.com/' },
    ),
  ]);
  const events: NewsEvent[] = [];
  if (sina.status === 'fulfilled') {
    for (const [index, row] of (
      sina.value.result?.data?.feed?.list ?? []
    ).entries()) {
      const text = (row.rich_text ?? '').replace(/<[^>]+>/g, ' ').trim();
      if (!text) continue;
      events.push({
        id: `sina-7x24-${row.id ?? index}`,
        title: text.slice(0, 90),
        summary: text,
        source: '新浪财经 7x24',
        publishedAt: toIso(row.create_time, ''),
        url: 'https://finance.sina.com.cn/7x24/',
        tone: toneFor(text),
        kind: '市场快讯',
        region: 'CN',
        sectors: sectorsFor(text),
      });
    }
  }
  if (wscn.status === 'fulfilled') {
    for (const [index, row] of (wscn.value.data?.items ?? []).entries()) {
      const title = (row.title ?? '').trim();
      const body = (row.content_text ?? '').trim();
      const text = `${title} ${body}`.trim();
      if (!text) continue;
      events.push({
        id: `wscn-live-${row.id ?? index}`,
        title: title || text.slice(0, 90),
        summary: body || text,
        source: '华尔街见闻',
        publishedAt: row.display_time
          ? new Date(row.display_time * 1000).toISOString()
          : '',
        url: row.uri ?? 'https://wallstreetcn.com/live/global',
        tone: toneFor(text),
        kind: '市场快讯',
        region: 'CN',
        sectors: sectorsFor(text),
      });
    }
  }
  return events
    .filter((event) => event.sectors.length > 0)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, 60);
}

/**
 * 东方财富机构研报（`reportapi` 必须带 beginTime/endTime，2026-09 实测可达）。
 * 这是「预测参考性」最直接的样本来源：机构对行业与公司的评级、评级变动与关注度，
 * 比新闻更接近「下一交易日方向」的预期。注意它是**观点而非事实**，
 * 所以在 `scoreEvidence` 里给的权重低于新闻（0.8）。
 */
async function fetchResearchReports(days = 7): Promise<NewsEvent[]> {
  const end = new Date();
  const begin = new Date(end.getTime() - days * 86400000);
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const json = await fetchJson<{
    data?: Array<{
      title?: string;
      orgSName?: string;
      publishDate?: string;
      industryName?: string;
      emRatingName?: string;
      ratingChange?: number;
      stockName?: string;
      infoCode?: string;
    }>;
  }>(
    `https://reportapi.eastmoney.com/report/list?pageSize=60&pageNo=1&qType=1&beginTime=${day(begin)}&endTime=${day(end)}`,
    12000,
    { Referer: 'https://data.eastmoney.com/report/' },
  );
  return (json.data ?? [])
    .flatMap((row, index) => {
      const title = (row.title ?? '').trim();
      if (!title) return [];
      const industry = (row.industryName ?? '').trim();
      const text = `${industry} ${title} ${row.stockName ?? ''}`;
      const upgraded =
        typeof row.ratingChange === 'number' && row.ratingChange > 0;
      return [
        {
          id: `research-${row.infoCode ?? index}`,
          title,
          summary: [row.orgSName, industry, row.emRatingName]
            .filter(Boolean)
            .join(' · '),
          source: (row.orgSName ?? '').trim() || '东方财富研报',
          publishedAt: toIso(row.publishDate, ''),
          url: row.infoCode
            ? `https://data.eastmoney.com/report/zw_industry.jshtml?infocode=${row.infoCode}`
            : '',
          // 评级上调按正向计入，其余交给关键词判断。
          tone: upgraded ? ('正向' as const) : toneFor(text),
          kind: '机构研报' as const,
          region: 'CN' as const,
          sectors: sectorsFor(text),
        },
      ];
    })
    .filter((event) => event.sectors.length > 0)
    .slice(0, 60);
}

type UlistRow = {
  f2?: number;
  f3?: number;
  f4?: number;
  f5?: number;
  f6?: number;
  f8?: number;
  f10?: number;
  f12?: string;
  /** 市场号：100 国际指数 / 105 纳斯达克 / 106 纽交所 / 107 美交所-ARCA。 */
  f13?: number | string;
  f14?: string;
  f109?: number;
  f124?: number;
};

const CN_INDEX_SOURCE = 'mcp-eastmoney · 东方财富国内指数批量行情';
const GLOBAL_INDEX_SOURCE = 'mcp-eastmoney · 东方财富全球指数行情';
const US_BOARD_SOURCE = 'mcp-eastmoney · 东方财富美股行业 ETF 行情';
/** 只要真正被读取的字段；f13 用于跨市场匹配。 */
const BATCH_FIELDS = 'f2,f3,f4,f5,f6,f8,f10,f12,f13,f14,f109,f124';

/**
 * 东财批量行情：一次请求取回多个标的，直接给出 f3 当日涨跌幅、f10 真实量比、
 * f109 真实 5 日涨跌幅（三者都用日线反推核对过）。
 * 走 `readCachedQuote` → 冷构建打上游、热刷新复用缓存。
 */
async function fetchBatchBoards(
  definitions: SectorDefinition[],
  secids: Record<string, string>,
  source: string,
  session: MarketSession | readonly MarketSession[],
  proxyCodes: ReadonlySet<string> = new Set<string>(),
): Promise<BoardRow[]> {
  const entries = definitions.flatMap((definition) => {
    const secid = secids[definition.code];
    return secid ? [[definition, secid] as const] : [];
  });
  if (!entries.length) return [];
  // 键用 f13.f12（市场号 + 代码）：只按代码匹配会在跨市场重名时串行。
  const url = `https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=${entries
    .map(([, secid]) => secid)
    .join(',')}&fields=${BATCH_FIELDS}`;
  const { value: json, stale, fetchedAt } = await fetchQuoteJson<{
    data?: { diff?: UlistRow[] };
  }>(url, session);
  const rows = json.data?.diff ?? [];
  if (!rows.length) throw new Error(`${source} 为空`);
  const bySecid = new Map<string, UlistRow>(
    rows.map((row) => [`${row.f13}.${row.f12}`, row]),
  );
  return entries.flatMap(([definition, secid]) => {
    const row = bySecid.get(secid);
    if (!row || typeof row.f2 !== 'number') return [];
    return [
      {
        f3: typeof row.f3 === 'number' ? row.f3 : 0,
        f12: secid,
        f14: definition.name,
        f20: 1,
        // 指数与 ETF 没有「成分股涨跌家数」，这里留 0 让广度自动落到中性 50，
        // 不用 ETF 自身涨跌方向去伪造广度（那会和 returnScore 重复计权）。
        f104: 0,
        f105: 0,
        f128: definition.leaders[0],
        volumeRatio:
          typeof row.f10 === 'number' && Number.isFinite(row.f10)
            ? row.f10
            : 1,
        change5d:
          typeof row.f109 === 'number' && Number.isFinite(row.f109)
            ? row.f109
            : null,
        quoteTime: row.f124
          ? new Date(row.f124 * 1000).toISOString()
          : new Date(fetchedAt).toISOString(),
        source: `${source}${stale ? '（上游不可用期间复用缓存副本）' : ''}`,
        delayLevel: stale ? ('STALE' as const) : ('DELAYED_15M' as const),
        isProxy: proxyCodes.has(definition.code),
      },
    ];
  });
}

function fetchChinaIndexes() {
  return fetchBatchBoards(
    MARKET_INDEXES.filter((item) => CHINA_INDEX_SECIDS[item.code]),
    CHINA_INDEX_SECIDS,
    CN_INDEX_SOURCE,
    'CN',
  );
}

function fetchGlobalIndexes() {
  return fetchBatchBoards(
    MARKET_INDEXES.filter((item) => GLOBAL_INDEX_SECIDS[item.code]),
    GLOBAL_INDEX_SECIDS,
    GLOBAL_INDEX_SOURCE,
    ['US', 'HK', 'JP', 'KR', 'TW', 'DE', 'UK'],
    GLOBAL_INDEX_PROXY_CODES,
  );
}

;

function fetchUsBoards(): Promise<BoardRow[]> {
  return fetchBatchBoards(US_SECTORS, US_SECTOR_SECIDS, US_BOARD_SOURCE, 'US');
}

async function fetchIndexBoards(): Promise<BoardRow[]> {
  // 国内 6 个 + 海外 11 个指数各一次批量请求。
  // 换源前海外指数是逐个 Yahoo 请求（每个 1 次图表 + 1 次 K 线），现在是 2 次批量。
  const [chinaRows, globalRows] = await Promise.all([
    fetchChinaIndexes().catch((): BoardRow[] => []),
    fetchGlobalIndexes().catch((): BoardRow[] => []),
  ]);
  return [...chinaRows, ...globalRows];
}

/**
 * 按市值（f20）加权求某字段的均值，跳过缺失值。
 * 全部缺失时返回 null —— 调用方必须显式处理，不能悄悄退化成常数。
 */
function weightedAverage(
  rows: BoardRow[],
  pick: (row: BoardRow) => number | null | undefined,
) {
  let weightSum = 0;
  let valueSum = 0;
  for (const row of rows) {
    const value = pick(row);
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const weight = Math.max(row.f20 ?? 1, 1);
    valueSum += value * weight;
    weightSum += weight;
  }
  return weightSum ? valueSum / weightSum : null;
}

function boardMetrics(sector: SectorDefinition, boards: BoardRow[]) {
  const exact = boards.find((row) => row.f14 === sector.name);
  const matches = exact
    ? [exact]
    : boards
        .filter((row) =>
          sector.keywords.some((keyword) => row.f14?.includes(keyword)),
        )
        .slice(0, 8);
  if (!matches.length) {
    return {
      change: 0,
      upCount: 0,
      downCount: 0,
      volumeRatio: 1,
      change5d: null,
      leadingStock: sector.leaders[0],
      proxyBoards: [],
      mainNetInflow: null,
      mainNetInflowPct: null,
      quoteSymbol: null,
      dataAvailable: false,
    };
  }
  const change5d = weightedAverage(
    matches,
    (row) => row.change5d ?? row.f109,
  );
  const volumeRatio = weightedAverage(
    matches,
    (row) => row.volumeRatio ?? row.f10,
  );
  return {
    change: round(weightedAverage(matches, (row) => row.f3) ?? 0),
    upCount: matches.reduce((sum, row) => sum + (row.f104 ?? 0), 0),
    downCount: matches.reduce((sum, row) => sum + (row.f105 ?? 0), 0),
    volumeRatio: round(clamp(volumeRatio ?? 1, 0.1, 5)),
    change5d: change5d === null ? null : round(change5d),
    leadingStock: matches.find((row) => row.f128)?.f128 ?? sector.leaders[0],
    proxyBoards: matches.map((row) => row.f14 ?? '').filter(Boolean),
    mainNetInflow:
      typeof exact?.f62 === 'number'
        ? exact.f62
        : matches.some((row) => typeof row.f62 === 'number')
          ? matches.reduce((sum, row) => sum + (row.f62 ?? 0), 0)
          : null,
    mainNetInflowPct: typeof exact?.f184 === 'number' ? exact.f184 : null,
    quoteSymbol: matches[0]?.f12 ?? null,
    dataAvailable: true,
  };
}

/** 单一来源最多贡献几条，避免某一家媒体（或某个聚合器）主导整张评分。 */
const MAX_EVIDENCE_PER_SOURCE = 3;
/** 认定「来源够分散」所需的不同来源数。 */
export const MIN_DISTINCT_SOURCES = 3;
/** 参与打分的事件上限（原来只取最近 10 条，来源一多就被最近 10 条淹没）。 */
const MAX_SCORED_EVENTS = 12;

/**
 * 按来源做配额后再打分。样本少的时候「谁发得多谁说了算」是最容易被误读的偏差，
 * 所以先限单来源条数再计分，而不是直接取最近 N 条。
 */
export function diversifyBySource(events: NewsEvent[]) {
  const perSource = new Map<string, number>();
  const picked: NewsEvent[] = [];
  for (const event of events) {
    const key = event.source.trim() || '未知来源';
    const used = perSource.get(key) ?? 0;
    if (used >= MAX_EVIDENCE_PER_SOURCE) continue;
    perSource.set(key, used + 1);
    picked.push(event);
    if (picked.length >= MAX_SCORED_EVENTS) break;
  }
  return picked;
}

/** 展示用的事件列表里，单一来源最多出现几条（保持时间顺序，只削峰）。 */
export const DISPLAY_MAX_PER_SOURCE = 10;

/**
 * 展示列表的单来源上限。评分侧用的是 `diversifyBySource`（更严格），
 * 这里只解决「列表里 51/83 条都来自同一家」的观感与代表性问题。
 */
export function capPerSource(events: NewsEvent[], maxPerSource: number) {
  const used = new Map<string, number>();
  const out: NewsEvent[] = [];
  for (const event of events) {
    const key = event.source.trim() || '未知来源';
    const count = used.get(key) ?? 0;
    if (count >= maxPerSource) continue;
    used.set(key, count + 1);
    out.push(event);
  }
  return out;
}

function scoreEvidence(events: NewsEvent[], now: number) {
  let impact = 0;
  let totalWeight = 0;
  for (const event of diversifyBySource(events)) {
    const direction =
      event.tone === '正向' ? 1 : event.tone === '负向' ? -1 : 0;
    // 公告与监管披露是可核验事实；机构研报是观点，反而降权，避免卖方口径主导。
    const sourceWeight =
      event.kind === '龙头公告' || event.kind === 'SEC披露'
        ? 1.35
        : event.kind === '机构研报'
          ? 0.8
          : 1;
    const weight = sourceWeight * newsTimeWeight(event, now);
    impact += direction * weight;
    totalWeight += weight;
  }
  return round(clamp(50 + (totalWeight ? impact / totalWeight : 0) * 25));
}

/**
 * 证据置信度（0~1）：时间衰减后的条数与来源多样性取几何平均。
 * 用它把信息面分数往中性 50 拉——样本稀薄时给出一个「看起来很像概率」的数字，
 * 比给出中性值更容易误导人。这个系数会如实显示在页面上。
 */
export function evidenceConfidence(events: NewsEvent[], now?: number) {
  const effectiveCount = now === undefined ? events.length : events.reduce((sum, event) => sum + newsTimeWeight(event, now), 0);
  const byCount = Math.min(effectiveCount / 12, 1);
  const bySources = Math.min(
    new Set(events.map((event) => event.source)).size / MIN_DISTINCT_SOURCES,
    1,
  );
  return Math.round(Math.sqrt(byCount * bySources) * 1000) / 1000;
}

/**
 * 海外 60% / 国内 40% 的加权。两个池子都有内容时就是文档写的 60/40；
 * 但**某个池子对该行业一条都没有时，把它的权重按比例还给另一个池子**，
 * 而不是让 60% 变成一个恒等于中性的常数——那会把整条信号稀释掉一半，
 * 表现就是「海外 0 条、国内 19 条」的行业信息分被钉死在 50。
 */
export function weightedChinaEvidenceScore(
  foreignScore: number,
  domesticScore: number,
  foreignCount = 1,
  domesticCount = 1,
) {
  const foreignWeight = foreignCount > 0 ? 0.6 : 0;
  const domesticWeight = domesticCount > 0 ? 0.4 : 0;
  const total = foreignWeight + domesticWeight;
  if (!total) return 50;
  return round(
    (clamp(foreignScore) * foreignWeight +
      clamp(domesticScore) * domesticWeight) /
      total,
  );
}

function eventScore(
  events: NewsEvent[],
  sector: SectorDefinition,
  region: MarketRegion,
  now: number,
) {
  const relevant = prepareNewsEvidence(events, now)
    .filter((event) => event.sectors.includes(sector.code))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const confidence = evidenceConfidence(relevant, now);
  const sources = new Set(relevant.map((event) => event.source)).size;
  if (region === 'CN') {
    const foreign = relevant.filter((event) => event.kind === '海外看中国');
    const domestic = relevant.filter((event) => event.kind !== '海外看中国');
    const evidence = [...foreign.slice(0, 3), ...domestic.slice(0, 3)]
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .slice(0, 5);
    return {
      score: weightedChinaEvidenceScore(
        scoreEvidence(foreign, now),
        scoreEvidence(domestic, now),
        foreign.length,
        domestic.length,
      ),
      evidence,
      evidenceMix: { foreign: foreign.length, domestic: domestic.length, sources },
      confidence,
    };
  }
  return {
    score: scoreEvidence(relevant, now),
    evidence: relevant.slice(0, 4),
    evidenceMix: { foreign: relevant.length, domestic: 0, sources },
    confidence,
  };
}

export function buildSector(
  sector: SectorDefinition,
  boards: BoardRow[],
  events: NewsEvent[],
  region: MarketRegion,
  freshness: QuoteFreshness,
): SectorSnapshot {
  const market = boardMetrics(sector, boards);
  const news = eventScore(events, sector, region, Date.parse(freshness.receivedAt));
  // 证据稀薄（条数少或来源集中）时把信息面分数往中性 50 拉。
  // 样本只有 2 条却报出「78% 看多」，是这套模型最容易误导人的输出。
  const newsScore = round(50 + (news.score - 50) * news.confidence);
  const exactRow = boards.find((row) => row.f14 === sector.name);
  const breadth =
    (market.upCount - market.downCount) /
    Math.max(market.upCount + market.downCount, 1);
  const returnScore = clamp(50 + market.change * 12);
  const breadthScore = clamp(50 + breadth * 45);
  const volumeScore = clamp(50 + (market.volumeRatio - 1) * 28);
  // 5 日涨跌幅取真实值；取不到时退回当日信号，不编造 5 日数字。
  const momentum5d = market.change5d === null ? null : round(market.change5d);
  const momentumScore =
    momentum5d === null ? returnScore : clamp(50 + momentum5d * 2.5);
  const technicalScore = market.dataAvailable
    ? round(
        returnScore * 0.35 +
          breadthScore * 0.25 +
          volumeScore * 0.2 +
          momentumScore * 0.2,
      )
    : 50;
  const compositeScore = round(newsScore * 0.65 + technicalScore * 0.35);
  // 没有可核验行情时不输出涨跌倾向，避免给出看起来像概率的数字。
  const nextSession = market.dataAvailable
    ? nextSessionSignalFromScore(compositeScore)
    : null;
  const evidenceCount = news.evidence.length;
  return {
    code: sector.code,
    name: sector.name,
    change: market.change,
    upCount: market.upCount,
    downCount: market.downCount,
    flatCount: 0,
    volumeRatio: market.volumeRatio,
    momentum5d,
    newsScore,
    newsConfidence: news.confidence,
    technicalScore,
    compositeScore,
    nextSessionDirection: nextSession?.direction ?? null,
    nextSessionUpPct: nextSession?.upPct ?? null,
    nextSessionDownPct: nextSession?.downPct ?? null,
    informationTone: informationToneFromScore(compositeScore),
    evidenceQuality:
      evidenceCount >= 3 ? '充足' : evidenceCount >= 1 ? '一般' : '不足',
    leadingStock: market.leadingStock,
    mainNetInflow: market.mainNetInflow,
    mainNetInflowPct: market.mainNetInflowPct,
    quoteSymbol: market.quoteSymbol,
    dataAvailable: market.dataAvailable,
    evidence: news.evidence,
    evidenceMix: news.evidenceMix,
    proxyBoards: market.proxyBoards,
    freshness: {
      ...freshness,
      source:
        exactRow?.source ??
        (market.dataAvailable ? freshness.source : '暂无可用行情源'),
      isProxy: exactRow?.isProxy ?? false,
      dataStatus: market.dataAvailable ? freshness.dataStatus : 'STALE',
      delayLevel: market.dataAvailable ? freshness.delayLevel : 'STALE',
      quoteTime:
        boards
          .filter(
            (row) =>
              row.f14 === sector.name ||
              (row.f14 && sector.keywords.includes(row.f14)),
          )
          .map((row) => row.quoteTime)
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1) ?? freshness.quoteTime,
    },
  };
}

export async function createMarketSnapshot(): Promise<MarketSnapshot> {
  const started = Date.now();
  const { value, sources } = await withSourceDiagnostics(buildMarketSnapshot);
  value.updatedAt = new Date().toISOString();
  value.diagnostics = { durationMs: Date.now() - started, requestCount: sources.reduce((sum, item) => sum + item.requests, 0),
    newsCount: value.market.eventCount + value.usMarket.eventCount,
    coverage: { CN: value.sectors.filter(item => item.dataAvailable).length, US: value.usSectors.filter(item => item.dataAvailable).length,
      INDEX: value.indexes.filter(item => item.dataAvailable).length }, sources };
  if (sources.some(item => item.status === 'STALE' || item.status === 'FAILED')) value.dataStatus = 'STALE';
  return value;
}

async function buildMarketSnapshot(): Promise<MarketSnapshot> {
  const now = new Date().toISOString();
  // 海外 RSS 在同一轮快照里只抓一次，两条新闻链路共享同一个 Promise。
  // 超时给 6s：实测所有健康 feed 都在 5s 内返回，而**单个 feed 卡住会把整个快照
  // 拖到超时上限**；新闻源现在使用 5 分钟缓存及失败退避。
  const boardTask = fetchBoards();
  const usBoardTask = fetchUsBoards();
  const indexBoardTask = fetchIndexBoards();
  const overseasFeeds = fetchFeedGroup(OVERSEAS_FEED_SPECS, 6000);
  const [usNewsResult, secResult, foreignChinaResult, boardResult, domesticResult,
    internationalResult, noticeResult, usBoardResult, indexBoardResult, flashResult, researchResult] = await Promise.allSettled([
    fetchUsMainstreamNews(overseasFeeds), fetchSecFilings(), fetchForeignChinaAnalysis(overseasFeeds),
    boardTask, fetchNewsColumn(350), fetchNewsColumn(351), fetchNotices(), usBoardTask, indexBoardTask,
    fetchCnFlashNews(), fetchResearchReports(),
  ]);
  const boards: BoardRow[] =
    boardResult.status === 'fulfilled' ? boardResult.value : [];
  const fetchedEvents: NewsEvent[] = [
    domesticResult,
    internationalResult,
    noticeResult,
    flashResult,
    researchResult,
  ].flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  const foreignChinaEvents =
    foreignChinaResult.status === 'fulfilled' ? foreignChinaResult.value : [];
  const domesticEvents = fetchedEvents;
  const cnEvents = [...foreignChinaEvents, ...domesticEvents];
  const usBoards =
    usBoardResult.status === 'fulfilled' ? usBoardResult.value : [];
  const usEvents: NewsEvent[] = [usNewsResult, secResult].flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  const indexBoards =
    indexBoardResult.status === 'fulfilled' ? indexBoardResult.value : [];
  const globalIndexRows = indexBoards.filter((row) =>
    row.source?.includes('东方财富全球指数'),
  );
  const proxyIndexRows = indexBoards.filter((row) => row.isProxy);
  const freshness: MarketSnapshot['freshness'] = {
    CN: makeFreshness('CN', now, boards, Boolean(boards.length)),
    US: makeFreshness('US', now, usBoards, Boolean(usBoards.length)),
    INDEX: makeFreshness(
      'INDEX',
      now,
      indexBoards,
      Boolean(indexBoards.length),
    ),
  };
  const cnIndexCodes = MARKET_INDEXES.filter((item) =>
    item.code.startsWith('IDX-CN-'),
  ).map((item) => item.code);
  const globalIndexCodes = MARKET_INDEXES.filter(
    (item) => !item.code.startsWith('IDX-CN-'),
  ).map((item) => item.code);
  const indexEvents: NewsEvent[] = [
    ...cnEvents.slice(0, 15).map((event) => ({
      ...event,
      id: `index-cn-${event.id}`,
      region: 'INDEX' as const,
      sectors: cnIndexCodes,
    })),
    ...usEvents.slice(0, 25).map((event) => ({
      ...event,
      id: `index-global-${event.id}`,
      region: 'INDEX' as const,
      sectors: globalIndexCodes,
    })),
  ];
  const sectors = SECTORS.map((sector) =>
    buildSector(sector, boards, cnEvents, 'CN', freshness.CN),
  ).sort((a, b) => b.change - a.change);
  const usSectors = US_SECTORS.map((sector) =>
    buildSector(sector, usBoards, usEvents, 'US', freshness.US),
  ).sort((a, b) => b.change - a.change);
  const indexes = MARKET_INDEXES.map((index) =>
    buildSector(index, indexBoards, indexEvents, 'INDEX', makeFreshness('INDEX', now, indexBoards.filter(row => row.f14 === index.name), indexBoards.some(row => row.f14 === index.name), sessionForCode(index.code))),
  ).sort((a, b) => b.change - a.change);
  const dataStatus: MarketSnapshot['dataStatus'] =
    boards.length &&
    usBoards.length &&
    indexBoards.length &&
    (fetchedEvents.length || usEvents.length)
      ? 'LIVE_PROXY'
      : boards.length ||
          usBoards.length ||
          indexBoards.length ||
          fetchedEvents.length ||
          usEvents.length
        ? 'STALE'
        : 'DEMO';
  return {
    tradeDate: now.slice(0, 10),
    updatedAt: now,
    dataStatus,
    disclaimer:
      '本平台根据当日公开新闻、财报公告与行情数据生成下一交易日的行业统计展望。上涨/下跌百分比是综合信息信号的相对占比，不是经回测校准的真实概率，也不代表价格必然上涨或下跌；平台不提供个股或 ETF 买卖建议、目标价、仓位建议或收益承诺。',
    market: {
      positive: sectors.filter((item) => item.informationTone === '积极')
        .length,
      cautious: sectors.filter((item) => item.informationTone === '谨慎')
        .length,
      eventCount: cnEvents.length,
    },
    usMarket: {
      positive: usSectors.filter((item) => item.informationTone === '积极')
        .length,
      cautious: usSectors.filter((item) => item.informationTone === '谨慎')
        .length,
      eventCount: usEvents.length,
    },
    indexMarket: {
      positive: indexes.filter((item) => item.informationTone === '积极')
        .length,
      cautious: indexes.filter((item) => item.informationTone === '谨慎')
        .length,
      eventCount: indexEvents.length,
    },
    sectors,
    usSectors,
    indexes,
    freshness,
    providerStatus: [
      {
        id: 'mcp-eastmoney',
        name: 'mcp-eastmoney 数据适配',
        role: 'PRIMARY',
        status: boards.length ? 'UP' : 'DOWN',
        lastSuccessAt: boards.length ? now : null,
        message: `A 股板块、主力资金与热点排行；本次取得 ${boards.length} 条板块记录（约 15 分钟延迟）`,
      },
      {
        id: 'eastmoney-global',
        name: '东方财富全球行情适配',
        role: 'PRIMARY',
        status:
          usBoards.length && globalIndexRows.length ? 'UP' : 'DEGRADED',
        lastSuccessAt:
          usBoards.length || globalIndexRows.length ? now : null,
        message: `美股 11 行业 ETF 与 11 个海外指数改由东方财富批量接口供给（原 Yahoo 链路自 2021-11-01 起对大陆返回 403）；本次行业 ${usBoards.length}、海外指数 ${globalIndexRows.length} 条${
          proxyIndexRows.length
            ? `，其中 ${proxyIndexRows.length} 个用 ETF 代理`
            : ''
        }`,
      },
      {
        id: 'akshare-stock-mcp',
        name: 'AKShare Stock MCP 数据适配',
        role: 'PRIMARY',
        status: indexBoards.some((row) => row.source === CN_INDEX_SOURCE)
          ? 'UP'
          : 'DEGRADED',
        lastSuccessAt: indexBoards.some((row) => row.source === CN_INDEX_SOURCE)
          ? now
          : null,
        message:
          'A 股、港股、国内指数、北向资金与龙虎榜职责；当前边缘运行时经东方财富批量接口一次取回全部 6 个国内指数（含真实量比与 5 日涨跌幅）',
      },
      {
        id: 'foreign-mainstream',
        name: '海外主流媒体看中国',
        role: 'PRIMARY',
        status: foreignChinaEvents.length ? 'UP' : 'DEGRADED',
        lastSuccessAt: foreignChinaEvents.length ? now : null,
        message: `A 股信息因子海外证据池，占信息面权重 60%；本次 ${foreignChinaEvents.length} 条，来自 ${
          new Set(foreignChinaEvents.map((event) => event.source)).size
        } 家媒体`,
      },
      {
        id: 'domestic-public-info',
        name: '国内经济新闻与上市公司公告',
        role: 'PRIMARY',
        status: fetchedEvents.length ? 'UP' : 'DEGRADED',
        lastSuccessAt: fetchedEvents.length ? now : null,
        message: `A 股信息因子国内证据池，占信息面权重 40%；本次 ${fetchedEvents.length} 条，来自 ${
          new Set(fetchedEvents.map((event) => event.source)).size
        } 个来源（含机构研报与中文财经快讯）`,
      },
    ],
    proxyDisclosure:
      '美股 11 个行业采用 XLE、XLF、XLK 等行业 ETF 作为行业代理；标普500、纳斯达克、纳斯达克100、道琼斯、恒生、KOSPI、台湾加权、日经225、DAX、富时100 为指数本身点位；罗素2000 因东方财富未提供该指数，改用 IWM（罗素2000 ETF）代理，与行业 ETF 同类处理。指数与 ETF 都没有「成分股涨跌家数」，这类标的的广度项按中性处理，不用 ETF 自身涨跌方向去伪造广度。',
    analysisEvidence: [...prepareNewsEvidence(cnEvents, Date.parse(now)), ...prepareNewsEvidence(usEvents, Date.parse(now)), ...prepareNewsEvidence(indexEvents, Date.parse(now))],
    events: [
      ...capPerSource(foreignChinaEvents, DISPLAY_MAX_PER_SOURCE).slice(0, 20),
      ...capPerSource(usEvents, DISPLAY_MAX_PER_SOURCE).slice(0, 30),
      ...capPerSource(domesticEvents, DISPLAY_MAX_PER_SOURCE).slice(0, 20),
      ...capPerSource(indexEvents, DISPLAY_MAX_PER_SOURCE).slice(0, 20),
    ],
    methodology: {
      newsWeight: 0.65,
      technicalWeight: 0.35,
      modelVersion: 'time-decay-deduplicated-direction-v11',
      validationStatus: 'UNVALIDATED',
      newsHalfLifeHours: 24,
      newsMaxAgeHours: 168,
      modelStatus:
        fetchedEvents.length || usEvents.length ? 'validated' : 'fallback',
    },
  };
}

export type MarketHistoryRow = {
  date: string;
  close: number;
  change: number;
  volume: number;
  breadth: number | null;
};

export type MarketHistoryMeta = {
  status: 'FRESH' | 'CACHED' | 'UNAVAILABLE';
  lastTradeDate?: string | null;
  expectedTradeDate?: string;
  calendarCovered?: boolean;
  source: string;
  updatedAt: string | null;
  volumeAvailable: boolean;
  breadthStatus: 'AVAILABLE' | 'ACCUMULATING' | 'NOT_AVAILABLE';
  volumeDisclosure: string;
  message: string;
};

export function mergeCurrentBreadth(
  rows: MarketHistoryRow[],
  sector: SectorSnapshot,
) {
  if (!rows.length || !sector.code.startsWith('801')) return rows;
  const total = sector.upCount + sector.downCount;
  if (!total) return rows;
  const breadth = Math.round((sector.upCount / total) * 1000) / 10;
  const latestDate = rows.at(-1)!.date;
  return rows.map((row) =>
    row.date === latestDate && row.breadth === null && row.date === localClock(sessionForCode(sector.code), new Date(sector.freshness.quoteTime)).dateKey ? { ...row, breadth } : row,
  );
}

/** 这些接口会校验来源站与浏览器 UA。 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36';

/**
 * 申万一级行业 → 同花顺**行业板块**代码。
 *
 * 为什么要有这张表：A 股行业的历史日线是本项目最难拿的一块。
 * 东方财富的 K 线接口（`push2his`）在这个网络环境下 socket 直接断，
 * `push2delay` 的 kline 接口 6 种参数组合都返回 `klines=0`，
 * 而腾讯/新浪都不支持东财的板块代码（`bk0475` → param error / null）。
 * 同花顺的板块日线是唯一实测可用的板块级历史源（140 个交易日）。
 *
 * 同花顺的行业分类到**二级**（90 个板块），所以一个申万一级行业对应多个板块，
 * 取历史时按等权聚合（见 `aggregateSectorSeries`）。代码来自实测枚举 + 逐条核对。
 */
export const CN_SECTOR_THS_BOARDS: Record<string, string[]> = {
  '801010': ['881101', '881102', '881103'], // 农林牧渔
  '801030': [
    '881108',
    '881109',
    '881172',
    '881263',
    '881264',
    '881265',
    '881266',
  ], // 基础化工
  '801040': ['881112'], // 钢铁
  '801050': ['881114', '881168', '881169', '881170', '881267'], // 有色金属
  '801080': ['881121', '881122', '881123', '881124', '881270'], // 电子
  '801110': ['881131', '881132', '881173', '881174'], // 家用电器
  '801120': ['881133', '881134', '881273'], // 食品饮料
  '801130': ['881135', '881136'], // 纺织服饰
  '801140': ['881137', '881138', '881139'], // 轻工制造
  '801150': ['881140', '881141', '881142', '881143', '881144', '881175'], // 医药生物
  '801160': ['881145', '881146'], // 公用事业
  '801170': ['881148', '881149', '881151', '881152'], // 交通运输
  '801180': ['881153'], // 房地产
  '801200': ['881158', '881159', '881177'], // 商贸零售
  '801210': ['881160', '881178', '881179'], // 社会服务
  '801230': ['881165'], // 综合
  '801710': ['881115', '881167'], // 建筑材料
  '801720': ['881116'], // 建筑装饰
  '801730': ['881277', '881278', '881279', '881280', '881281', '881282'], // 电力设备
  '801740': ['881166', '881276'], // 国防军工
  '801750': ['881130', '881271', '881272'], // 计算机
  '801760': ['881164', '881274', '881275'], // 传媒
  '801770': ['881129', '881162'], // 通信
  '801780': ['881155'], // 银行
  '801790': ['881156', '881157', '881283'], // 非银金融
  '801880': ['881125', '881126', '881128'], // 汽车
  '801890': ['881117', '881118', '881171', '881268', '881269'], // 机械设备
  '801950': ['881105'], // 煤炭
  '801960': ['881107', '881180'], // 石油石化
  '801970': ['881181', '881284'], // 环保
  '801980': ['881182'], // 美容护理
};

/** 指数 → 腾讯日线代码（`day` 数组字段序是 日期,开,**收**,高,低,量）。 */
const TENCENT_HISTORY_SYMBOLS: Record<string, string> = {
  'IDX-CN-SSE': 'sh000001',
  'IDX-CN-SZSE': 'sz399001',
  'IDX-CN-CSI300': 'sh000300',
  'IDX-CN-CSI500': 'sh000905',
  'IDX-CN-CHINEXT': 'sz399006',
  'IDX-CN-STAR50': 'sh000688',
  'IDX-US-SP500': 'us.INX',
  'IDX-US-NASDAQ100': 'us.NDX',
  'IDX-US-NASDAQ': 'us.IXIC',
  'IDX-US-DOW': 'us.DJI',
  'IDX-HK-HSI': 'hkHSI',
};

/**
 * 指数 → 新浪美股日线代码（`.INX` 是新浪对标普500 的写法）。
 * ⚠️ 这是**生产环境的主力链路**：线上沙箱实测能连新浪、连不上腾讯
 * （腾讯的指数页在沙箱里全部拿不到数据，本地却可以），所以新浪排在腾讯前面。
 */
const SINA_US_HISTORY_SYMBOLS: Record<string, string> = {
  'IDX-US-SP500': '.INX',
  'IDX-US-NASDAQ100': '.NDX',
  'IDX-US-NASDAQ': '.IXIC',
  'IDX-US-DOW': '.DJI',
  // 罗素2000 没有直连日线，用 IWM 代理（与实时行情同一套披露口径）。
  'IDX-US-RUSSELL2000': 'IWM',
};

/** 国内指数 → 新浪 A 股日线代码（同样是沙箱里的主力链路）。 */
const SINA_CN_HISTORY_SYMBOLS: Record<string, string> = {
  'IDX-CN-SSE': 'sh000001',
  'IDX-CN-SZSE': 'sz399001',
  'IDX-CN-CSI300': 'sh000300',
  'IDX-CN-CSI500': 'sh000905',
  'IDX-CN-CHINEXT': 'sz399006',
  'IDX-CN-STAR50': 'sh000688',
};

/**
 * 海外指数 → 同花顺日线代码。
 *
 * 同花顺的行情节点用「市场_代码」命名，实测确认的三段：
 *   `bk_` = A 股行业板块、`hk_` = 港股指数、**`88_` = 全球指数**。
 * 这里的代码是 2026-09 穷举各市场段 + 与实时行情逐位比对后定下来的
 * （例：`88_N225` 末根收盘 64011.34 与日经 225 实时值一致）。
 *
 * ⚠️ **`last.js` 的分片更新进度不一致。** 同花顺对每个代码提供 `/00/ /01/ /02/` 三份，
 * 实测 `hk_HSI` 的 `/00/`、`/01/` 停在 2026-04-21，只有 `/02/` 更新到最新交易日；
 * 而线上沙箱又观察到 `/02/` 拿到旧窗口（边缘节点同步不同步）。
 * 所以取数时**不赌单一分片**，见 `freshestSeries`：取两份、选末条日期更新的那份。
 * 若有人把它「简化」成只取一个分片，恒生与全球指数 K 线会静默回退到几个月前的旧数据。
 */
export const THS_INDEX_CODES: Record<string, string> = {
  'IDX-HK-HSI': 'hk_HSI',
  'IDX-JP-NIKKEI': '88_N225',
  'IDX-KR-KOSPI': '88_KS11',
  'IDX-TW-TAIEX': '88_TWII',
  'IDX-DE-DAX': '88_GDAXI',
  'IDX-UK-FTSE': '88_FTSE',
};

const THS_INDEX_SOURCE = '同花顺 · 全球指数日线';

const TENCENT_HISTORY_SOURCE = '腾讯财经 · 指数日线';
const SINA_US_HISTORY_SOURCE = '新浪财经 · 美股日线';
const SINA_CN_HISTORY_SOURCE = '新浪财经 · A 股指数日线';
const THS_HISTORY_SOURCE = '同花顺 · 行业板块日线等权聚合';

type SeriesPoint = { date: string; close: number; volume: number };

/**
 * 同花顺板块日线原始串：
 * `20260213,4795.224,4828.310,4770.734,4776.047,738121470,6350360800.000,,,,0`
 * 即 **日期,开,高,低,收,量,额**，交易日之间用 `;` 分隔。
 */
export function parseThsBoardSeries(dataField: string): SeriesPoint[] {
  return dataField.split(';').flatMap((line) => {
    const values = line.split(',');
    const raw = values[0] ?? '';
    const close = Number(values[4]);
    const volume = Number(values[5]);
    if (!/^\d{8}$/.test(raw) || !Number.isFinite(close)) return [];
    return [
      {
        date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
        close,
        volume: Number.isFinite(volume) ? volume : 0,
      },
    ];
  });
}

/**
 * 把行业的多个子板块聚合成一条行业代理序列：
 * - **涨跌幅**：各子板块等权平均（每个板块用自身前一交易日收盘计算）
 * - **点位**：从 1000 起按平均涨跌幅复利复合。各板块的绝对点位口径不一，不能直接相加。
 * - **成交量**：各子板块求和
 * - **宽度**：当日上涨子板块占比 —— 这是**真实宽度**，不是估算值
 */
export function aggregateSectorSeries(
  seriesList: SeriesPoint[][],
  days: number,
): MarketHistoryRow[] {
  if (!seriesList.length) return [];
  const maps = seriesList.map(
    (rows) => new Map(rows.map((row) => [row.date, row])),
  );
  const dates = [...(maps[0]?.keys() ?? [])]
    .filter((date) => maps.every((map) => map.has(date)))
    .sort();
  if (dates.length < 2) return [];
  const window = dates.slice(-(days + 1));
  const rows: MarketHistoryRow[] = [];
  let level = 1000;
  for (let index = 1; index < window.length; index += 1) {
    const date = window[index];
    const prevDate = window[index - 1];
    let sum = 0;
    let up = 0;
    let volume = 0;
    for (const map of maps) {
      const today = map.get(date);
      const prev = map.get(prevDate);
      if (!today || !prev) continue;
      const change = prev.close ? ((today.close - prev.close) / prev.close) * 100 : 0;
      sum += change;
      if (change > 0) up += 1;
      volume += today.volume;
    }
    const average = sum / maps.length;
    level *= 1 + average / 100;
    rows.push({
      date,
      close: round(level),
      change: round(average),
      volume,
      breadth: round((up / maps.length) * 100),
    });
  }
  return rows.slice(-days);
}

async function fetchThsSectorHistory(
  sectorCode: string,
  days: number,
): Promise<MarketHistoryRow[]> {
  const boards = CN_SECTOR_THS_BOARDS[sectorCode];
  if (!boards?.length) throw new Error(`行业 ${sectorCode} 未配置同花顺板块映射`);
  const settled = await Promise.allSettled(
    boards.map(async (code) => {
      const body = await fetchText(
        `https://d.10jqka.com.cn/v6/line/bk_${code}/01/last.js`,
        12000,
        { Referer: 'https://q.10jqka.com.cn/', 'User-Agent': BROWSER_UA },
      );
      const match = body.match(/"data"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!match) throw new Error(`同花顺板块 ${code} 无日线`);
      return parseThsBoardSeries(JSON.parse(`"${match[1]}"`));
    }),
  );
  const seriesList = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const rows = aggregateSectorSeries(seriesList, days);
  if (!rows.length) throw new Error('同花顺行业板块聚合为空');
  return rows;
}

async function fetchTencentHistory(
  symbol: string,
  days: number,
): Promise<MarketHistoryRow[]> {
  const json = await fetchJson<{
    data?: Record<string, { day?: string[][] }>;
  }>(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days + 1},qfq`,
    12000,
    { Referer: 'https://gu.qq.com/', 'User-Agent': BROWSER_UA },
  );
  // 字段序是 日期,开,收,高,低,量 —— 收盘在 index 2，不是常见的 index 4。
  const bars = json.data?.[symbol]?.day ?? [];
  const rows: MarketHistoryRow[] = [];
  let previous: number | null = null;
  for (const bar of bars) {
    const date = bar[0];
    const close = Number(bar[2]);
    const volume = Number(bar[5]);
    if (!date || !Number.isFinite(close)) continue;
    rows.push({
      date,
      close: round(close),
      change: previous ? round(((close - previous) / previous) * 100) : 0,
      volume: Number.isFinite(volume) ? volume : 0,
      breadth: null,
    });
    previous = close;
  }
  if (!rows.length) throw new Error(`腾讯指数日线为空：${symbol}`);
  return rows.slice(-days);
}

/** 新浪美股日线：`var _=([{"d":"2005-01-03","o":..,"h":..,"l":..,"c":..,"v":..}, ...])`。 */
export function parseSinaUsSeries(body: string): MarketHistoryRow[] {
  const start = body.indexOf('[{');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('新浪美股日线格式异常');
  const items = JSON.parse(body.slice(start, end + 1)) as Array<{
    d?: string;
    c?: string | number;
    v?: string | number;
  }>;
  const rows: MarketHistoryRow[] = [];
  let previous: number | null = null;
  for (const item of items) {
    const date = item.d;
    const close = Number(item.c);
    const volume = Number(item.v);
    if (!date || !Number.isFinite(close)) continue;
    rows.push({
      date,
      close: round(close),
      change: previous ? round(((close - previous) / previous) * 100) : 0,
      volume: Number.isFinite(volume) ? volume : 0,
      breadth: null,
    });
    previous = close;
  }
  return rows;
}

async function fetchSinaUsHistory(
  symbol: string,
  days: number,
): Promise<MarketHistoryRow[]> {
  const body = await fetchText(
    `https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20_=/US_MinKService.getDailyK?symbol=${encodeURIComponent(symbol)}&___qn=3`,
    12000,
    { Referer: 'https://finance.sina.com.cn/', 'User-Agent': BROWSER_UA },
  );
  const rows = parseSinaUsSeries(body);
  if (!rows.length) throw new Error(`新浪美股日线为空：${symbol}`);
  return rows.slice(-days);
}

/**
 * 新浪 A 股指数日线：`[{"day":"2026-09-11","open":"..","close":"..","volume":"57912314500"}]`。
 *
 * 注意成交量的单位是**股**，而腾讯同口径给的是**手**（1 手 = 100 股）。
 * 这里统一换算成手，否则同一个指数换源后量柱量级会跳变 100 倍。
 */
export function parseSinaCnSeries(body: string): MarketHistoryRow[] {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) throw new Error('新浪 A 股日线格式异常');
  const rows: MarketHistoryRow[] = [];
  let previous: number | null = null;
  for (const item of parsed as Array<{
    day?: string;
    close?: string | number;
    volume?: string | number;
  }>) {
    const date = item.day;
    const close = Number(item.close);
    if (!date || !Number.isFinite(close)) continue;
    const volume = Number(item.volume) / 100;
    rows.push({
      date,
      close: round(close),
      change: previous ? round(((close - previous) / previous) * 100) : 0,
      volume: Number.isFinite(volume) ? volume : 0,
      breadth: null,
    });
    previous = close;
  }
  return rows;
}

async function fetchSinaCnHistory(
  symbol: string,
  days: number,
): Promise<MarketHistoryRow[]> {
  const body = await fetchText(
    `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${days + 1}`,
    12000,
    { Referer: 'https://finance.sina.com.cn/', 'User-Agent': BROWSER_UA },
  );
  const rows = parseSinaCnSeries(body);
  if (!rows.length) throw new Error(`新浪 A 股指数日线为空：${symbol}`);
  return rows.slice(-days);
}

/**
 * 同花顺对部分海外指数（日经/KOSPI/台湾加权/DAX/富时100）**不提供成交量**，
 * 字段用常量 `1` 占位（标普500 与恒生指数则是真实量）。
 *
 * 常量占位必须当成「无成交量」：否则量能图会画出一排等高柱，看起来像有数据，
 * 而实际那个纵轴（0~1）没有任何信息量。置 0 后 UI 会如实显示"数据源不提供成交量"。
 */
export function normalizeThsIndexVolume(
  series: SeriesPoint[],
): SeriesPoint[] {
  const usable = series.some((point) => point.volume > 1);
  return usable ? series : series.map((point) => ({ ...point, volume: 0 }));
}

/**
 * 从多份候选序列里挑末条日期最新的那份。
 *
 * 起因：同花顺 `last.js` 有多个分片（`/00/ /01/ /02/`），**更新进度并不一致**——
 * 实测 `hk_HSI` 的 `/00/`、`/01/` 停在 2026-04-21，只有 `/02/` 到最新交易日；
 * 而线上沙箱又观察到 `/02/` 拿到旧窗口（不同边缘节点同步不同步）。
 * 所以不赌某一个分片，取多份、选最新的，避免整页显示几个月前的旧行情。
 */
export function freshestSeries(
  candidates: SeriesPoint[][],
): SeriesPoint[] | null {
  let best: SeriesPoint[] | null = null;
  let bestDate = '';
  for (const series of candidates) {
    if (!series.length) continue;
    const lastDate = series[series.length - 1].date;
    if (!best || lastDate > bestDate) {
      best = series;
      bestDate = lastDate;
    }
  }
  return best;
}

/**
 * 同花顺指数日线（海外指数走这条路）。
 *
 * 响应是 `quotebridge_v6_line_*({...,"name":"恒生指数","data":"日期,开,高,低,收,量,额;..."})`，
 * 字段序与板块一致，所以直接复用 `parseThsBoardSeries`。
 * 这里是**指数本身**的日线，不是 ETF 代理——指数点位与页面顶部实时行情同源同口径。
 */
async function fetchThsIndexHistory(
  code: string,
  days: number,
): Promise<MarketHistoryRow[]> {
  // 取两个分片、并行请求，选末条日期更新的那份（理由见 freshestSeries）。
  const settled = await Promise.allSettled(
    ['01', '02'].map((shard) =>
      fetchText(
        `https://d.10jqka.com.cn/v6/line/${code}/${shard}/last.js`,
        12000,
        { Referer: 'https://q.10jqka.com.cn/', 'User-Agent': BROWSER_UA },
      ),
    ),
  );
  const parsed = settled.flatMap((result) => {
    if (result.status !== 'fulfilled') return [];
    const match = result.value.match(/"data"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!match) return [];
    return [parseThsBoardSeries(JSON.parse(`"${match[1]}"`))];
  });
  const picked = freshestSeries(parsed);
  if (!picked) throw new Error(`同花顺指数 ${code} 无日线`);
  const series = normalizeThsIndexVolume(picked);
  const rows: MarketHistoryRow[] = [];
  let previous: number | null = null;
  for (const point of series) {
    rows.push({
      date: point.date,
      close: round(point.close),
      change: previous ? round(((point.close - previous) / previous) * 100) : 0,
      volume: point.volume,
      // 指数没有「上涨/下跌家数」，宽度保持为空而不是用涨跌方向伪造。
      breadth: null,
    });
    previous = point.close;
  }
  if (!rows.length) throw new Error(`同花顺指数日线为空：${code}`);
  return rows.slice(-days);
}

async function fetchEastmoneyHistory(
  secid: string,
  days: number,
  host = 'push2his.eastmoney.com',
): Promise<MarketHistoryRow[]> {
  const json = await fetchJson<{ data?: { klines?: string[] } }>(
    `https://${host}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${days}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`,
    12_000,
  );
  const rows = (json.data?.klines ?? []).flatMap((line) => {
    const values = line.split(',');
    const close = Number(values[2]);
    if (!Number.isFinite(close)) return [];
    return [
      {
        date: values[0],
        close: round(close),
        change: round(Number(values[8]) || 0),
        volume: Number(values[5]) || 0,
        breadth: null,
      },
    ];
  });
  if (!rows.length) throw new Error('东方财富历史行情为空');
  return rows;
}


async function firstUsableHistory(
  attempts: Array<{
    source: string;
    load: () => Promise<MarketHistoryRow[]>;
  }>,
) {
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const rows = await attempt.load();
      if (rows.length) return { rows, source: attempt.source };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('历史行情源均不可用');
}

export async function fetchHistoryFromProviders(
  sector: SectorSnapshot,
  days = 60,
) {
  if (!sector.dataAvailable) throw new Error('当前标的缺少可核验行情数据');

  // 1) A 股行业：同花顺板块等权聚合 —— 这是唯一实测可用的板块级历史源。
  const thsBoards = CN_SECTOR_THS_BOARDS[sector.code];
  if (thsBoards?.length) {
    return firstUsableHistory([
      {
        source: `${THS_HISTORY_SOURCE}（${thsBoards.length} 个子行业）`,
        load: () => fetchThsSectorHistory(sector.code, days),
      },
      {
        source: `${THS_HISTORY_SOURCE}（重试）`,
        load: () => fetchThsSectorHistory(sector.code, days),
      },
    ]);
  }

  const attempts: Array<{
    source: string;
    load: () => Promise<MarketHistoryRow[]>;
  }> = [];

  const tencentSymbol = TENCENT_HISTORY_SYMBOLS[sector.code];
  const sinaUsSymbol = SINA_US_HISTORY_SYMBOLS[sector.code];
  const sinaCnSymbol = SINA_CN_HISTORY_SYMBOLS[sector.code];
  const thsIndexCode = THS_INDEX_CODES[sector.code];

  // 2) 海外指数：同花顺全球指数日线。放在最前是因为它给的是**指数本身**
  //    （不是 ETF 代理），且同花顺这个域在本地与线上沙箱都实测可达。
  if (thsIndexCode) {
    attempts.push({
      source: `${THS_INDEX_SOURCE}（${thsIndexCode}）`,
      load: () => fetchThsIndexHistory(thsIndexCode, days),
    });
  }

  // 3) 美股行业 ETF：新浪美股日线，直接用 ETF 代码（近 20 年日线，含成交量）。
  if (sector.code.startsWith('US-')) {
    const ticker = sector.code.slice(3);
    attempts.push({
      source: SINA_US_HISTORY_SOURCE,
      load: () => fetchSinaUsHistory(ticker, days),
    });
  }

  // 4) 国内指数：新浪 A 股日线。
  if (sinaCnSymbol) {
    attempts.push({
      source: SINA_CN_HISTORY_SOURCE,
      load: () => fetchSinaCnHistory(sinaCnSymbol, days),
    });
  }

  // 5) 海外指数（美股）：新浪美股日线（标普500 用 `.INX`，罗素2000 用 IWM 代理）。
  if (sinaUsSymbol) {
    attempts.push({
      source:
        sector.code === 'IDX-US-RUSSELL2000'
          ? `${SINA_US_HISTORY_SOURCE} · IWM 代理罗素2000`
          : SINA_US_HISTORY_SOURCE,
      load: () => fetchSinaUsHistory(sinaUsSymbol, days),
    });
  }

  // 6) 腾讯作为冗余。本地环境可达，但**线上沙箱实测连不上腾讯**
  //    （腾讯独有的那几个指数页在沙箱里全部拿不到数据），所以排在新浪之后。
  if (tencentSymbol) {
    attempts.push({
      source: TENCENT_HISTORY_SOURCE,
      load: () => fetchTencentHistory(tencentSymbol, days),
    });
  }

  // 7) 东方财富兜底。本网络环境下 `push2his` 不可达（其 kline 接口一律返回空），
  //    但换到能连通的网络时它仍是最精确的板块历史源，所以保留在链路末端。
  const secid = sector.quoteSymbol?.startsWith('BK')
    ? `90.${sector.quoteSymbol}`
    : sector.quoteSymbol;
  if (secid) {
    attempts.push({
      source: 'mcp-eastmoney · 东方财富历史行情',
      load: () => fetchEastmoneyHistory(secid, days),
    });
  }

  if (!attempts.length) throw new Error('当前标的没有可用的历史行情源');
  return firstUsableHistory(attempts);
}

export async function createHistory(sector: SectorSnapshot, days = 60) {
  try {
    return (await fetchHistoryFromProviders(sector, days)).rows;
  } catch {
    return [];
  }
}
