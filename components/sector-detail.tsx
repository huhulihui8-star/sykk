'use client';
import { useStaticClock } from './use-static-clock';
import { expireStaticQuote } from '@/lib/static-freshness';
import { sitePath } from '@/lib/site-path';


import {
  ArrowLeft,
  Clock3,
  ExternalLink,
  Gauge,
  Newspaper,
  Radar,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  CloseTrendChart,
  VolumeBreadthChart,
} from '@/components/charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  MarketHistoryMeta,
  MarketSnapshot,
  SectorSnapshot,
} from '@/lib/market';

type HistoryRow = {
  date: string;
  close: number;
  change: number;
  volume: number;
  breadth: number | null;
};

function formatMoney(value: number) {
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toFixed(0);
}

export function SectorDetail({
  sector: generatedSector,
  history,
  historyMeta,
  snapshot,
  leaders,
}: {
  sector: SectorSnapshot;
  history: HistoryRow[];
  historyMeta: MarketHistoryMeta;
  snapshot: Pick<
    MarketSnapshot,
    'tradeDate' | 'updatedAt' | 'dataStatus' | 'disclaimer'
  >;
  leaders: string[];
}) {
  const now = useStaticClock();
  const sector = now === null ? generatedSector : expireStaticQuote(generatedSector, now);
  const isUs = sector.code.startsWith('US-');
  const isIndex = sector.code.startsWith('IDX-');
  const returnRegion = isUs ? 'US' : isIndex ? 'INDEX' : 'CN';
  const returnLabel = isUs
    ? '返回美股行业全景'
    : isIndex
      ? '返回主流指数全景'
      : '返回A股行业全景';
  const total = sector.upCount + sector.downCount;
  const breadth = total ? Math.round((sector.upCount / total) * 100) : 50;
  const recentHistory = history.slice(-20);
  const breadthPoints = recentHistory.filter(
    (row) => typeof row.breadth === 'number',
  ).length;
  const metrics: Array<{
    label: string;
    value: string;
    note: string;
    icon: LucideIcon;
  }> = [
    {
      label: '展望强度',
      value: sector.compositeScore.toFixed(0),
      note: '新闻 65% + 盘面 35%',
      icon: Gauge,
    },
    {
      label: '新闻因子',
      value: sector.newsScore.toFixed(0),
      note: `${sector.evidence.length} 条关键证据`,
      icon: Newspaper,
    },
    {
      label: '盘面因子',
      value: sector.technicalScore.toFixed(0),
      note:
        sector.mainNetInflow !== null
          ? `主力净流 ${formatMoney(sector.mainNetInflow)}`
          : sector.dataAvailable
            ? `量比 ${sector.volumeRatio.toFixed(2)}`
            : '行情数据暂不可用',
      icon: TrendingUp,
    },
    {
      label: '上涨宽度',
      value: sector.dataAvailable ? `${breadth}%` : '—',
      note: sector.dataAvailable
        ? `${sector.upCount} 涨 / ${sector.downCount} 跌`
        : '不使用模拟家数',
      icon: Radar,
    },
  ];
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-white/8 bg-[#07111f]/95">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between px-4 py-3 sm:px-8">
          <a
            href={sitePath(`/?region=${returnRegion}#sectors`)}
            className="flex items-center gap-2 text-sm text-slate-400 hover:text-cyan-300"
          >
            <ArrowLeft className="size-4" />
            {returnLabel}
          </a>
          <div className="flex items-center gap-4">
            <a
              href={sitePath('/')}
              className="hidden items-center gap-2 text-sm font-medium text-cyan-300 sm:flex"
              aria-label="返回最强分析师首页"
            >
              <Radar className="size-4" />
              最强分析师
            </a>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Clock3 className="size-3.5" />
              {snapshot.tradeDate}
            </div>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-[1280px] space-y-5 px-4 py-6 sm:px-8">
        <section className="flex flex-col justify-between gap-5 rounded-2xl border border-white/7 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,.12),transparent_42%),#0c192a] p-5 sm:p-7 lg:flex-row lg:items-end">
          <div>
            <p className="mb-2 flex items-center gap-2 text-xs tracking-[.18em] text-cyan-300">
              <Radar className="size-3.5" />
              {isIndex
                ? '国内外主流指数'
                : isUs
                  ? '美股 GICS 行业代理'
                  : '申万一级'}{' '}
              · {sector.code}
            </p>
            <h1 className="text-3xl font-semibold">{sector.name}</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              {isIndex
                ? '汇总国内外宏观新闻、企业财报公告和指数/代理 ETF 公开行情'
                : isUs
                  ? '以美国主流财经媒体、SEC 披露和行业 ETF 公开行情为主'
                  : 'A 股信息因子按海外主流媒体及经济学家对中国分析 60%、国内经济新闻与上市公司公告 40% 加权'}
              ，生成{sector.freshness.outlookLabel}。
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-4 sm:gap-6">
            <div>
              <p className="text-xs text-slate-500">当日公开行情</p>
              <p
                className={`mt-1 font-mono text-3xl font-semibold ${sector.change >= 0 ? 'text-red-400' : 'text-emerald-400'}`}
              >
                {sector.dataAvailable
                  ? `${sector.change >= 0 ? '+' : ''}${sector.change.toFixed(2)}%`
                  : '暂无行情'}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">
                {sector.freshness.outlookLabel}
              </p>
              <Badge className="mt-2 bg-cyan-400/10 text-cyan-300 ring-1 ring-cyan-300/20">
                {sector.informationTone}
              </Badge>
            </div>
            <div
              className={`rounded-xl border px-4 py-3 text-right ${
                sector.nextSessionDirection === null
                  ? 'border-white/10 bg-white/[.03]'
                  : sector.nextSessionDirection === '上涨'
                    ? 'border-red-400/20 bg-red-400/[.06]'
                    : 'border-emerald-400/20 bg-emerald-400/[.06]'
              }`}
              aria-label={
                sector.nextSessionDirection === null
                  ? '缺少可核验行情，不输出下一交易日涨跌倾向'
                  : `下一交易日信息面统计倾向：上涨${sector.nextSessionUpPct}%，下跌${sector.nextSessionDownPct}%`
              }
            >
              <p className="text-[10px] text-slate-500">下一交易日统计倾向</p>
              {sector.nextSessionDirection === null ? (
                <>
                  <p className="mt-1 text-xl font-semibold text-slate-400">
                    数据不足
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-slate-600">
                    无可核验盘面数据
                  </p>
                </>
              ) : (
                <>
                  <p
                    className={`mt-1 text-xl font-semibold ${sector.nextSessionDirection === '上涨' ? 'text-red-400' : 'text-emerald-400'}`}
                  >
                    {sector.nextSessionDirection}{' '}
                    {sector.nextSessionDirection === '上涨'
                      ? sector.nextSessionUpPct
                      : sector.nextSessionDownPct}
                    %
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-slate-500">
                    上涨 {sector.nextSessionUpPct}% · 下跌{' '}
                    {sector.nextSessionDownPct}%
                  </p>
                </>
              )}
            </div>
          </div>
        </section>
        <section className="rounded-2xl border border-white/7 bg-white/[.025] p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-400">
            <span>
              来源：
              <strong className="font-normal text-slate-200">
                {sector.freshness.source}
              </strong>
            </span>
            <span>
              行情时间：
              <strong className="font-normal text-slate-200">
                {new Date(sector.freshness.quoteTime).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                })}
              </strong>
            </span>
            <span>
              延迟：
              <strong className="font-normal text-slate-200">
                {sector.freshness.delayLevel === 'NEAR_REALTIME'
                  ? '近实时'
                  : sector.freshness.delayLevel === 'DELAYED_15M'
                    ? '约 15 分钟'
                    : sector.freshness.delayLevel === 'LAST_CLOSE'
                      ? '最近收盘'
                      : '旧缓存'}
              </strong>
            </span>
            <span>
              数据属性：
              <strong className="font-normal text-slate-200">
                {sector.dataAvailable
                  ? sector.freshness.isProxy
                    ? 'ETF 行业代理'
                    : '原始指数/板块行情'
                  : '数据暂不可用'}
              </strong>
            </span>
            {!isUs && !isIndex && (
              <span>
                证据构成：
                <strong className="font-normal text-slate-200">
                  海外 {sector.evidenceMix.foreign} 条 / 国内{' '}
                  {sector.evidenceMix.domestic} 条
                </strong>
              </span>
            )}
          </div>
          {sector.freshness.calendar && <p className="mt-3 text-xs text-slate-500">交易日历：{sector.freshness.session} · 覆盖 {sector.freshness.calendar.years.join('、')} 年。{sector.freshness.calendar.message} <a href={sector.freshness.calendar.source} target="_blank" rel="noreferrer" className="text-cyan-300">官方来源</a></p>}
        </section>
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map(({ label, value, note, icon: Icon }) => (
            <Card
              key={label}
              className="border-white/5 bg-card/75 ring-white/8"
            >
              <CardContent className="flex items-center justify-between pt-1">
                <div>
                  <p className="text-xs text-slate-500">{label}</p>
                  <p className="mt-1 text-2xl font-semibold">{value}</p>
                  <p className="mt-1 text-[11px] text-slate-600">{note}</p>
                </div>
                <Icon className="size-5 text-cyan-300" />
              </CardContent>
            </Card>
          ))}
        </section>
        <section className="grid gap-5 lg:grid-cols-[1.45fr_1fr]">
          <Card className="border-white/5 bg-card/75 ring-white/8">
            <CardHeader>
              <CardTitle>60 日走势</CardTitle>
              <p className="text-xs text-slate-500">行业代理指数 · 收盘点位</p>
            </CardHeader>
            <CardContent>
              {history.length ? (
                <CloseTrendChart data={history} />
              ) : (
                <div className="flex h-[330px] items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
                  历史 K 线暂不可用；系统不会生成模拟走势。
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="border-white/5 bg-card/75 ring-white/8">
            <CardHeader>
              <CardTitle>公开信息证据链</CardTitle>
              <p className="text-xs text-slate-500">可回到原始新闻或公告核验</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {sector.evidence.length ? (
                sector.evidence.map((event) => (
                  <article
                    key={event.id}
                    className="rounded-xl border border-white/7 bg-white/[.025] p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] text-cyan-300">
                        {event.kind} · {event.source}
                      </span>
                      <span
                        className={
                          event.tone === '正向'
                            ? 'text-[11px] text-red-400'
                            : event.tone === '负向'
                              ? 'text-[11px] text-emerald-400'
                              : 'text-[11px] text-slate-400'
                        }
                      >
                        {event.tone}影响
                      </span>
                    </div>
                    <h2 className="mt-2 text-sm leading-6 text-slate-200">
                      {event.title}
                    </h2>
                    {event.summary && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                        {event.summary}
                      </p>
                    )}
                    <div className="mt-2 flex justify-between text-[10px] text-slate-600">
                      <span>{event.publishedAt.slice(0, 16)}</span>
                      {event.url && (
                        <a
                          href={event.url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 hover:text-cyan-300"
                        >
                          原文
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-sm text-slate-500">
                  当前行业相关信息不足，展望按“谨慎”处理并明确标注证据不足。
                </div>
              )}
            </CardContent>
          </Card>
        </section>
        <section className="grid gap-5 lg:grid-cols-2">
          <Card className="border-white/5 bg-card/75 ring-white/8">
            <CardHeader>
              <CardTitle>量能与市场宽度</CardTitle>
              <p className="text-xs text-slate-500">最近 20 个交易日</p>
            </CardHeader>
            <CardContent>
              {history.length && historyMeta.volumeAvailable ? (
                <VolumeBreadthChart
                  data={recentHistory}
                  showBreadth={breadthPoints >= 1}
                />
              ) : (
                <div className="flex h-[250px] items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">
                  {history.length
                    ? '该原始指数数据源不提供可核验成交量。'
                    : '暂无可核验的真实量能数据。'}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-500">
                <span>
                  {historyMeta.message}
                </span>
                <span>{historyMeta.volumeDisclosure}</span>
                <span>
                  {historyMeta.breadthStatus === 'AVAILABLE'
                    ? `市场宽度 ${breadthPoints} 个有效交易日`
                    : historyMeta.breadthStatus === 'ACCUMULATING'
                      ? 'A 股真实市场宽度正在逐日积累'
                      : '该市场暂不提供历史成分宽度'}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card className="border-white/5 bg-card/75 ring-white/8">
            <CardHeader>
              <CardTitle>行业代表企业与代理板块</CardTitle>
              <p className="text-xs text-slate-500">
                仅用于公告归类与行情交叉验证
              </p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                {leaders.map((name) => (
                  <div
                    key={name}
                    className="rounded-xl border border-white/7 bg-white/[.025] p-4"
                  >
                    <p className="text-sm font-medium text-slate-200">{name}</p>
                    <p className="mt-1 text-[11px] text-slate-500">
                      公告信息样本 · 非个股推荐
                    </p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {sector.proxyBoards.slice(0, 8).map((name) => (
                  <Badge
                    key={name}
                    variant="outline"
                    className="text-slate-400"
                  >
                    {name}
                  </Badge>
                ))}
              </div>
              <div className="mt-5 rounded-xl bg-cyan-400/5 p-4 text-xs leading-5 text-slate-500">
                <strong className="text-cyan-300">方法说明：</strong>
                {isUs || isIndex
                  ? '新闻与公告先按行业、指数和代表企业归类，再与当日行情交叉校验。'
                  : 'A 股新闻因子严格按海外主流媒体及经济学家对中国分析 60%、国内经济新闻与上市公司公告 40% 加权，再与当日行情交叉校验。'}
                上涨/下跌百分比是综合信息信号占比，并非经回测校准的真实概率。最终结果不是价格保证。
              </div>
            </CardContent>
          </Card>
        </section>
        <footer className="border-t border-white/7 py-5 text-xs leading-5 text-slate-600">
          <p>{snapshot.disclaimer}</p>
          <p className="mt-1">
            更新时间：
            {new Date(snapshot.updatedAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            })}
          </p>
        </footer>
      </div>
    </main>
  );
}
