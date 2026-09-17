'use client';
import { useStaticClock } from './use-static-clock';
import { expireStaticQuote } from '@/lib/static-freshness';
import { sitePath } from '@/lib/site-path';


import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  ChevronRight,
  Clock3,
  ExternalLink,
  Newspaper,
  Radar,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  SectorChangeChart,
  ToneDistributionChart,
} from '@/components/charts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type {
  DashboardSector,
  DashboardSnapshot,
  InformationTone,
  MarketSnapshot,
} from '@/lib/market';
import { DASHBOARD_EVENTS_PER_REGION } from '@/lib/market';

const toneClasses: Record<InformationTone, string> = {
  积极: 'bg-red-400/10 text-red-400 ring-red-400/20',
  谨慎: 'bg-emerald-400/10 text-emerald-400 ring-emerald-400/20',
};

function formatMoney(value: number) {
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toFixed(0);
}
function ToneBadge({ tone }: { tone: InformationTone }) {
  return (
    <Badge className={`font-normal ring-1 ${toneClasses[tone]}`}>{tone}</Badge>
  );
}
function MetricCard({
  label,
  value,
  note,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  note: string;
  icon: typeof Activity;
  color: string;
}) {
  return (
    <Card className="border-white/5 bg-card/80 ring-white/8">
      <CardContent className="flex items-center justify-between pt-1">
        <div>
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
          <p className="mt-1 text-[11px] text-slate-500">{note}</p>
        </div>
        <span
          className={`grid size-10 place-items-center rounded-xl bg-white/4 ${color}`}
        >
          <Icon className="size-5" />
        </span>
      </CardContent>
    </Card>
  );
}

function SectorCard({ sector }: { sector: DashboardSector }) {
  const total = sector.upCount + sector.downCount;
  const breadth = total ? Math.round((sector.upCount / total) * 100) : 50;
  const outlook = sector.nextSessionDirection;
  const outlookPct =
    outlook === '上涨' ? sector.nextSessionUpPct : sector.nextSessionDownPct;
  return (
    <a
      href={sitePath(`/sectors/${sector.code}/`)}
      target="_blank"
      rel="noopener noreferrer"
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
      aria-label={`在新标签页查看${sector.name}${sector.code.startsWith('IDX-') ? '指数' : '行业'}信息详情`}
    >
      <Card className="relative h-full border-white/5 bg-card/70 ring-white/8 transition duration-200 group-hover:-translate-y-0.5 group-hover:bg-[#102139] group-hover:ring-cyan-300/20">
        <CardHeader className="relative min-h-[104px] pr-[132px]">
          <div className="min-w-0 flex-1">
            <CardTitle className="text-[15px]">{sector.name}</CardTitle>
            <p className="mt-1 text-[10px] text-slate-600">
              {sector.code.startsWith('801')
                ? `SW ${sector.code}`
                : sector.code}
            </p>
            <p
              className={`mt-3 font-mono text-lg font-semibold ${sector.dataAvailable && sector.change < 0 ? 'text-emerald-400' : 'text-red-400'}`}
            >
              {sector.dataAvailable
                ? `${sector.change >= 0 ? '+' : ''}${sector.change.toFixed(2)}%`
                : '暂无数据'}
            </p>
          </div>
          <div
            className={`absolute right-6 top-6 w-[112px] rounded-lg border px-3 py-2 text-right ${
              outlook === null
                ? 'border-white/10 bg-white/[.03]'
                : outlook === '上涨'
                  ? 'border-red-400/20 bg-red-400/[.06]'
                  : 'border-emerald-400/20 bg-emerald-400/[.06]'
            }`}
            aria-label={
              outlook === null
                ? '缺少可核验行情，不输出下一交易日涨跌倾向'
                : `下一交易日信息面统计倾向：上涨${sector.nextSessionUpPct}%，下跌${sector.nextSessionDownPct}%`
            }
          >
            <p className="text-[9px] tracking-wide text-slate-500">
              下一个交易日
            </p>
            {outlook === null ? (
              <>
                <p className="mt-0.5 text-sm font-semibold text-slate-400">
                  数据不足
                </p>
                <p className="mt-0.5 font-mono text-[9px] text-slate-600">
                  无可用盘面数据
                </p>
              </>
            ) : (
              <>
                <p
                  className={`mt-0.5 text-sm font-semibold ${outlook === '上涨' ? 'text-red-400' : 'text-emerald-400'}`}
                >
                  {outlook} {outlookPct}%
                </p>
                <p className="mt-0.5 font-mono text-[9px] text-slate-500">
                  涨 {sector.nextSessionUpPct}% · 跌 {sector.nextSessionDownPct}%
                </p>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="mb-1 text-[10px] text-slate-500">
                {sector.freshness.outlookLabel}
              </p>
              <ToneBadge tone={sector.informationTone} />
            </div>
            <div className="text-right">
              <p className="text-[10px] text-slate-500">证据质量</p>
              <p className="mt-1 text-xs text-slate-300">
                {sector.evidenceQuality}
              </p>
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex justify-between text-[10px] text-slate-500">
              <span>上涨家数 {sector.upCount || '—'}</span>
              <span>{breadth}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-emerald-400/20">
              <div
                className="h-full rounded-full bg-red-400"
                style={{ width: `${breadth}%` }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-white/6 pt-3 text-[11px] text-slate-500">
            <span>
              {sector.mainNetInflow !== null
                ? `主力净流 ${formatMoney(sector.mainNetInflow)}`
                : `信息 ${sector.newsScore.toFixed(0)} · 盘面 ${sector.technicalScore.toFixed(0)}`}
            </span>
            <ChevronRight className="size-3.5 transition group-hover:translate-x-0.5 group-hover:text-cyan-300" />
          </div>
        </CardContent>
      </Card>
    </a>
  );
}

export function MarketDashboard({
  initialData: generatedData,
  initialRegion,
}: {
  initialData: DashboardSnapshot;
  initialRegion: 'CN' | 'US' | 'INDEX';
}) {
  const now = useStaticClock();
  const initialData = useMemo(() => now === null ? generatedData : ({ ...generatedData, sectors: generatedData.sectors.map(item => expireStaticQuote(item, now)), usSectors: generatedData.usSectors.map(item => expireStaticQuote(item, now)), indexes: generatedData.indexes.map(item => expireStaticQuote(item, now)) }), [generatedData, now]);
  const [region, setRegion] = useState<'CN' | 'US' | 'INDEX'>(initialRegion);
  useEffect(() => { const timer = setTimeout(() => { const query = new URLSearchParams(window.location.search).get('region'); if (query === 'CN' || query === 'US' || query === 'INDEX') setRegion(query); }, 0); return () => clearTimeout(timer); }, []);
  const [sortBy, setSortBy] = useState<'change' | 'information' | 'fundFlow'>(
    'change',
  );
  const regionSectors =
    region === 'CN'
      ? initialData.sectors
      : region === 'US'
        ? initialData.usSectors
        : initialData.indexes;
  const regionMarket =
    region === 'CN'
      ? initialData.market
      : region === 'US'
        ? initialData.usMarket
        : initialData.indexMarket;
  const sorted = useMemo(
    () =>
      [...regionSectors].sort((a, b) =>
        sortBy === 'change'
          ? Number(b.dataAvailable) - Number(a.dataAvailable) ||
            b.change - a.change
          : sortBy === 'fundFlow'
            ? (b.mainNetInflow ?? Number.NEGATIVE_INFINITY) -
              (a.mainNetInflow ?? Number.NEGATIVE_INFINITY)
            : b.compositeScore - a.compositeScore,
      ),
    [regionSectors, sortBy],
  );
  const chartData = sorted.slice(0, 14);
  const distribution = [
    { name: '信息面积极', value: regionMarket.positive, fill: '#fb7185' },
    { name: '信息面谨慎', value: regionMarket.cautious, fill: '#34d399' },
  ];
  const topEvents = initialData.events
    .filter((event) => event.region === region && event.sectors.length)
    .slice(0, DASHBOARD_EVENTS_PER_REGION);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-white/8 bg-[#07111f]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <a
            href={sitePath('/')}
            className="flex items-center gap-3"
            aria-label="返回最强分析师首页"
          >
            <span className="grid size-9 place-items-center rounded-xl bg-cyan-400/15 text-cyan-300 ring-1 ring-cyan-300/25">
              <Radar className="size-5" />
            </span>
            <div>
              <p className="text-[15px] font-semibold tracking-wide">
                最强分析师
              </p>
              <p className="text-[10px] tracking-[.18em] text-slate-500">
                A-SHARE INFORMATION LAB
              </p>
            </div>
          </a>
          <nav
            className="hidden items-center gap-5 text-xs text-slate-400 md:flex"
            aria-label="主导航"
          >
            <a href="#overview" className="hover:text-cyan-300">
              市场概览
            </a>
            <a href="#events" className="hover:text-cyan-300">
              关键信息
            </a>
            <a href="#freshness" className="hover:text-cyan-300">
              数据新鲜度
            </a>
            <a href="#sectors" className="hover:text-cyan-300">
              行业全景
            </a>
            <a href="#methodology" className="hover:text-cyan-300">
              方法与边界
            </a>
            <a href={sitePath('/evaluation/')} className="px-2 py-1 hover:text-cyan-300">评估</a>
            <a href={sitePath('/account/')} className="px-2 py-1 hover:text-cyan-300">注册 / 登录</a>
            <a href={sitePath('/admin/')} className="px-2 py-1 hover:text-cyan-300">管理后台</a>
      </nav>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Clock3 className="size-3.5" />
            <span className="hidden sm:inline">{initialData.tradeDate} · </span>
            {statusLabel(initialData.dataStatus)}
          </div>
        </div>
      </header>
      <nav
        className="sticky top-[61px] z-10 flex justify-around border-b border-white/7 bg-[#07111f]/95 px-2 py-2 text-[11px] text-slate-400 backdrop-blur md:hidden"
        aria-label="移动端主导航"
      >
        <a href="#overview" className="px-2 py-1 hover:text-cyan-300">
          概览
        </a>
        <a href="#events" className="px-2 py-1 hover:text-cyan-300">
          信息
        </a>
        <a href="#freshness" className="px-2 py-1 hover:text-cyan-300">
          数据
        </a>
        <a href="#sectors" className="px-2 py-1 hover:text-cyan-300">
          行业
        </a>
        <a href={sitePath('/account/')} className="px-2 py-1 hover:text-cyan-300">账号</a>
        <a href="#methodology" className="px-2 py-1 hover:text-cyan-300">
          方法
        </a>
      </nav>
      <div className="mx-auto max-w-[1500px] space-y-5 px-4 py-6 sm:px-8">
        <section className="rounded-2xl border border-amber-300/20 bg-amber-300/[.055] p-4 text-sm leading-6 text-amber-100/85">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-amber-300" />
            <div>
              <strong className="text-amber-200">信息分析边界</strong>
              <p className="mt-1 text-xs text-slate-400">
                本站仅根据当日公开信息生成行业级的下一交易日统计展望。卡片中的上涨/下跌百分比是综合信息信号占比，不是经回测校准的真实概率；不输出个股或
                ETF 推荐、仓位建议、目标价或收益承诺。
              </p>
            </div>
          </div>
        </section>
        <section
          id="overview"
          className="scroll-mt-20 flex flex-col justify-between gap-4 lg:flex-row lg:items-end"
        >
          <div>
            <p className="mb-2 text-xs font-medium tracking-[.2em] text-cyan-300">
              行业信息全景
            </p>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              用今日公开证据研判下一交易日行业走势
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              {region === 'US'
                ? '以 CNBC、WSJ、MarketWatch 等实际可用财经媒体与 SEC 披露为主'
                : region === 'INDEX'
                  ? '汇总中国与海外宏观新闻、企业财报公告和主流指数/代理 ETF 行情'
                  : 'A 股信息因子中，海外主流媒体及经济学家对中国分析占 60%，国内经济新闻与上市公司公告占 40%'}
              ，信息因子占 65%，当日公开行情占 35%。
            </p>
            <div
              className="mt-4 inline-flex rounded-xl border border-white/8 bg-white/[.025] p-1"
              // 分段控件用 div[role=group] 是 shadcn/Radix ToggleGroup 的既定做法；
              // 改成语义上的 fieldset 会引入 UA 默认样式与 min-inline-size 的布局风险。
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
              role="group"
              aria-label="市场切换"
            >
              <button
                type="button"
                onClick={() => setRegion('CN')}
                className={`rounded-lg px-4 py-2 text-sm transition ${region === 'CN' ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}
              >
                A 股 · 31 行业
              </button>
              <button
                type="button"
                onClick={() => setRegion('US')}
                className={`rounded-lg px-4 py-2 text-sm transition ${region === 'US' ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}
              >
                美股 · 11 行业
              </button>
              <button
                type="button"
                onClick={() => setRegion('INDEX')}
                className={`rounded-lg px-4 py-2 text-sm transition ${region === 'INDEX' ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:text-slate-300'}`}
              >
                国内外主流指数
              </button>
            </div>
          </div>
          <Badge className="h-7 bg-cyan-400/10 px-3 text-cyan-300 ring-1 ring-cyan-300/20">
            <ShieldCheck className="size-3.5" />
            {region === 'CN'
              ? '31 个申万一级行业'
              : region === 'US'
                ? '11 个 GICS 行业代理'
                : `${regionSectors.length} 个国内外主流指数`}
          </Badge>
        </section>
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label={`${initialData.freshness[region].outlookLabel}·积极`}
            value={regionMarket.positive}
            note="当日正向证据占优"
            icon={Activity}
            color="text-red-400"
          />
          <MetricCard
            label={`${initialData.freshness[region].outlookLabel}·谨慎`}
            value={regionMarket.cautious}
            note="负向或不确定信息占优"
            icon={BarChart3}
            color="text-emerald-400"
          />
          <MetricCard
            label="行业覆盖"
            value={regionSectors.length}
            note={
              region === 'CN'
                ? '申万 2021 一级行业'
                : region === 'US'
                  ? '美股 11 个 GICS 行业'
                  : '中国与全球股票主流指数'
            }
            icon={ShieldCheck}
            color="text-emerald-400"
          />
          <MetricCard
            label="今日信息样本"
            value={regionMarket.eventCount}
            note={
              region === 'US'
                ? '美国主流媒体与 SEC'
                : region === 'INDEX'
                  ? '国内外宏观与企业信息'
                  : '海外中国分析 60% · 国内信息 40%'
            }
            icon={Newspaper}
            color="text-cyan-300"
          />
        </section>
        <section
          id="freshness"
          className="scroll-mt-20 grid gap-4 lg:grid-cols-[1fr_1.4fr]"
        >
          <Card className="border-white/5 bg-card/80 ring-white/8">
            <CardHeader>
              <CardTitle>数据新鲜度 · {regionLabel(region)}</CardTitle>
              <p className="text-xs text-slate-500">
                公开近实时行情，不宣称交易所级实时
              </p>
            </CardHeader>
            <CardContent className="grid gap-3 text-xs sm:grid-cols-2">
              <FreshnessItem
                label="行情来源"
                value={initialData.freshness[region].source}
              />
              <FreshnessItem
                label="延迟等级"
                value={delayLabel(initialData.freshness[region].delayLevel)}
              />
              <FreshnessItem
                label="行情时间"
                value={dateTimeLabel(initialData.freshness[region].quoteTime)}
              />
              <FreshnessItem
                label="接收时间"
                value={dateTimeLabel(initialData.freshness[region].receivedAt)}
              />
              <FreshnessItem
                label="市场阶段"
                value={phaseLabel(initialData.freshness[region].marketPhase)}
              />
              <FreshnessItem
                label="展示性质"
                value={
                  initialData.freshness[region].isProxy
                    ? 'ETF / 指数代理'
                    : '原始公开行情'
                }
              />
              {initialData.diagnostics && (
                <div className="col-span-full space-y-2 border-t border-white/7 pt-3 text-sm text-slate-400">
                  <p>本次抓取 {initialData.diagnostics.requestCount} 次 · 耗时 {(initialData.diagnostics.durationMs / 1000).toFixed(1)} 秒</p>
                  <p>新闻源：{initialData.diagnostics.sources.filter(source => source.kind === 'NEWS' && source.status === 'CACHED').length} 个命中缓存 · {initialData.diagnostics.sources.filter(source => source.kind === 'NEWS' && source.status === 'STALE').length} 个复用降级副本 · {initialData.diagnostics.sources.filter(source => source.kind === 'NEWS' && source.status === 'FAILED').length} 个失败</p>
                  <p>新闻正常缓存 5 分钟；上游失败最多复用 30 分钟，时间不因回退而延长。</p>
                  <details>
                    <summary className="cursor-pointer">新闻来源时间与状态</summary>
                    <ul className="mt-2 space-y-1 break-words">
                      {initialData.diagnostics.sources.filter(source => source.kind === 'NEWS').map((source, index) => (
                        <li key={index}>{new URL(source.source).hostname} · {source.status === 'STALE' ? '降级缓存' : source.status === 'FAILED' ? '失败' : source.status === 'CACHED' ? '缓存' : '已更新'} · {source.fetchedAt ? dateTimeLabel(source.fetchedAt) : '无成功时间'}{source.error ? ' · ' + source.error : ''}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
            </CardContent>
          </Card>
          <Card className="border-white/5 bg-card/80 ring-white/8">
            <CardHeader>
              <CardTitle>提供者健康状态</CardTitle>
              <p className="text-xs text-slate-500">
                主源、备用源与内部校验链路分开披露
              </p>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {initialData.providerStatus.map((provider) => (
                <div
                  key={provider.id}
                  className="rounded-xl border border-white/7 bg-white/[.025] p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-slate-200">
                      {provider.name}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-[10px] text-cyan-300"
                    >
                      {providerStatusLabel(provider.status)}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-slate-500">
                    {provider.message}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
          <p className="lg:col-span-2 text-[11px] leading-5 text-slate-500">
            {initialData.proxyDisclosure}
          </p>
        </section>
        <section
          id="events"
          className="scroll-mt-20 grid gap-5 xl:grid-cols-[1.55fr_.7fr_1fr]"
        >
          <Card className="border-white/5 bg-card/80 ring-white/8">
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>
                  {region === 'INDEX'
                    ? '主流指数公开行情对比'
                    : '行业公开行情对比'}
                </CardTitle>
                <p className="text-xs text-slate-500">
                  当日涨跌幅为事实数据，非排名推荐
                </p>
              </div>
              <NativeSelect
                size="sm"
                value={sortBy}
                onChange={(event) =>
                  setSortBy(event.target.value as typeof sortBy)
                }
                aria-label={region === 'INDEX' ? '指数排序' : '行业排序'}
              >
                <NativeSelectOption value="change">
                  按当日涨跌幅
                </NativeSelectOption>
                <NativeSelectOption value="information">
                  按信息面得分
                </NativeSelectOption>
                {region === 'CN' && (
                  <NativeSelectOption value="fundFlow">
                    按主力资金净流入
                  </NativeSelectOption>
                )}
              </NativeSelect>
            </CardHeader>
            <CardContent>
              <SectorChangeChart data={chartData} />
            </CardContent>
          </Card>
          <Card className="border-white/5 bg-card/80 ring-white/8">
            <CardHeader>
              <CardTitle>
                {initialData.freshness[region].outlookLabel}分布
              </CardTitle>
              <p className="text-xs text-slate-500">
                {regionSectors.length}{' '}
                {region === 'INDEX' ? '个主流指数' : '个行业'}，仅显示积极或谨慎
              </p>
            </CardHeader>
            <CardContent>
              <ToneDistributionChart data={distribution} />
              <div className="mt-2 space-y-2">
                {distribution.map((item) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="flex items-center gap-2 text-slate-400">
                      <i
                        className="size-2 rounded-full"
                        style={{ background: item.fill }}
                      />
                      {item.name}
                    </span>
                    <strong className="font-mono text-slate-200">
                      {item.value}
                    </strong>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          <Card className="border-white/5 bg-card/80 ring-white/8">
            <CardHeader>
              <CardTitle>
                {region === 'US'
                  ? '美国主流媒体与 SEC'
                  : region === 'CN'
                    ? '海外看中国与国内公开信息'
                    : '国内外关键公开信息'}
              </CardTitle>
              <p className="text-xs text-slate-500">
                按{region === 'INDEX' ? '指数' : '行业'}关联度与发布时间整理
              </p>
            </CardHeader>
            <CardContent className="max-h-[410px] space-y-3 overflow-auto pr-1">
              {topEvents.map((event) => (
                <article
                  key={event.id}
                  className="rounded-xl border border-white/7 bg-white/[.025] p-3.5"
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
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
                  <h2 className="line-clamp-2 text-sm leading-6 text-slate-200">
                    {event.title}
                  </h2>
                  <div className="mt-2 flex items-center justify-between text-[10px] text-slate-600">
                    <span>
                      关联 {event.sectors.length} 个
                      {region === 'INDEX' ? '指数' : '行业'}
                    </span>
                    {event.url && (
                      <a
                        href={event.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="查看原文"
                        className="hover:text-cyan-300"
                      >
                        <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </CardContent>
          </Card>
        </section>
        <section id="sectors" className="scroll-mt-20">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold">
                {region === 'CN'
                  ? 'A 股 31 行业全景'
                  : region === 'US'
                    ? '美股 11 行业全景'
                    : '国内外主流指数全景'}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                点击查看 60 日公开行情、新闻证据链和代表企业公告
              </p>
            </div>
            <p className="hidden text-[11px] text-slate-600 sm:block">
              信息权重 65% · 盘面权重 35%
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sorted.map((sector) => (
              <SectorCard key={sector.code} sector={sector} />
            ))}
          </div>
        </section>
        <section
          id="methodology"
          className="scroll-mt-20 grid gap-4 lg:grid-cols-4"
        >
          {[
            [
              '信息来源',
              'A 股信息因子：海外主流媒体及经济学家对中国分析占 60%，国内经济新闻与上市公司公告占 40%；美股以美国主流财经媒体与 SEC 为主。',
            ],
            [
              '影响分析',
              '将公开信息按行业归类为正向、中性或负向影响，再与当日行情交叉校验。',
            ],
            [
              '数据质量',
              '样本不足、来源超时或证据冲突时明确降级，不用猜测补齐结论。',
            ],
            [
              '产品边界',
              '只提供行业与指数的统计展望；不做个股排名、买卖指令、目标价或收益承诺，展望不等于价格保证。',
            ],
          ].map(([title, copy]) => (
            <Card
              key={title}
              className="border-white/5 bg-card/60 ring-white/8"
            >
              <CardHeader>
                <CardTitle className="text-sm">{title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs leading-5 text-slate-500">{copy}</p>
              </CardContent>
            </Card>
          ))}
        </section>
        <footer className="border-t border-white/7 py-5 text-xs leading-5 text-slate-600">
          <p>{initialData.disclaimer}</p>
          <p className="mt-1">
            更新时间：
            {new Date(initialData.updatedAt).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
            })}{' '}
            · 数据状态：{statusLabel(initialData.dataStatus)}
          </p>
        </footer>
      </div>
    </main>
  );
}

function statusLabel(status: MarketSnapshot['dataStatus']) {
  return status === 'LIVE'
    ? '近实时公开行情'
    : status === 'LIVE_PROXY'
      ? '近实时代理行情'
      : status === 'STALE'
        ? '部分数据降级'
        : '示例数据';
}

function FreshnessItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/[.025] p-3">
      <p className="text-[10px] text-slate-600">{label}</p>
      <p className="mt-1 text-slate-300">{value}</p>
    </div>
  );
}

function dateTimeLabel(value: string) {
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function regionLabel(region: 'CN' | 'US' | 'INDEX') {
  return region === 'CN' ? 'A 股' : region === 'US' ? '美股' : '主流指数';
}

function delayLabel(delay: MarketSnapshot['freshness']['CN']['delayLevel']) {
  return delay === 'NEAR_REALTIME'
    ? '近实时'
    : delay === 'DELAYED_15M'
      ? '约 15 分钟延迟'
      : delay === 'LAST_CLOSE'
        ? '最近收盘'
        : '旧缓存';
}

function phaseLabel(phase: MarketSnapshot['freshness']['CN']['marketPhase']) {
  return phase === 'TRADING'
    ? '交易中'
    : phase === 'BREAK'
      ? '午间休市'
      : phase === 'PREMARKET'
        ? '盘前'
        : phase === 'POSTMARKET'
          ? '盘后'
          : '休市';
}

function providerStatusLabel(
  status: MarketSnapshot['providerStatus'][number]['status'],
) {
  return status === 'UP'
    ? '正常'
    : status === 'DEGRADED'
      ? '降级'
      : status === 'DOWN'
        ? '不可用'
        : '待命';
}
