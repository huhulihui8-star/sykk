'use client';

/**
 * 自绘 SVG 图表（替代 recharts）。
 *
 * 4 张图的几何、刻度、圆角、文字基线都按 recharts 的规则复刻，并做过逐项对拍：
 * 刻度坐标与柱/扇形/曲线的包围盒全部 0px 偏差（环形图按路径逐点比对，
 * 偏差 6e-5px = recharts 4 位小数的舍入精度）。见 work/preview/。
 *
 * 入场动画用 **CSS 动画**而不是 JS 逐帧，理由有两个：
 *  1. 图表现在是服务端直出的（recharts 时代首屏是空的，要等 JS）；
 *     若用 JS 动画，用户会先看到成图、再被重置回起点重播一次。
 *     CSS 动画从首帧就开始播，不依赖 hydration，也不会有这个回跳。
 *  2. 没有 JS 也能播；`prefers-reduced-motion` 直接由 CSS 关掉。
 *
 * 时长与缓动取自 recharts 的默认值：柱子 400ms、面积/折线/环形 1500ms
 * （环形额外延迟 400ms），缓动 `ease` = cubic-bezier(0.25, 0.1, 0.25, 1)。
 * 已知差异：环形的入场改成了缩放淡入，recharts 是"扇形扫开"——扫开要动 `d`
 * 属性，CSS 做不了，而 JS 做会带回跳问题（原因见上）。
 */
import { useEffect, useId, useRef, useState } from 'react';
import {
  axisWidthFor,
  barGeometry,
  niceTickValues,
  niceTickValuesFixedDomain,
  thinTicksFromEnd,
} from '@/lib/chart-ticks';

const TICK_FONT = 12;
const TICK_FILL = 'var(--muted-foreground)';
const GRID_STROKE = '#213147';
const UP_COLOR = '#fb7185';
const DOWN_COLOR = '#34d399';
const VOLUME_COLOR = '#334f6d';
const CYAN = '#22d3ee';
const CURSOR_FILL = 'var(--muted)';
const CURSOR_LINE = 'var(--ring)';

type TipRow = { name: string; value: string; color: string };
type TipState = { x: number; y: number; label?: string; rows: TipRow[] } | null;

/** recharts 的 ResponsiveContainer 也是这个思路：先量容器宽度，再按像素画。 */
function useMeasuredWidth(ref: React.RefObject<HTMLElement | null>, fallback: number) {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const read = () => {
      const next = node.clientWidth;
      if (next > 0) setWidth(next);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** 供 clipPath / 渐变用；useId 会带特殊字符，必须清掉。 */
function useSvgId(prefix: string) {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/**
 * 圆角矩形路径，支持只圆某几个角（与 recharts Rectangle 的 radius 语义一致）。
 * 不能用 `<rect rx>` 代替：那会把四个角都圆掉，而原图只圆一侧。
 */
function roundedRect(
  x: number,
  y: number,
  w: number,
  h: number,
  [tl, tr, br, bl]: [number, number, number, number],
) {
  const max = Math.min(Math.abs(w), Math.abs(h)) / 2;
  const r = [tl, tr, br, bl].map((value) => Math.min(value, max));
  return [
    `M${x + r[0]},${y}`,
    `H${x + w - r[1]}`,
    r[1] ? `A${r[1]},${r[1]} 0 0 1 ${x + w},${y + r[1]}` : '',
    `V${y + h - r[2]}`,
    r[2] ? `A${r[2]},${r[2]} 0 0 1 ${x + w - r[2]},${y + h}` : '',
    `H${x + r[3]}`,
    r[3] ? `A${r[3]},${r[3]} 0 0 1 ${x},${y + h - r[3]}` : '',
    `V${y + r[0]}`,
    r[0] ? `A${r[0]},${r[0]} 0 0 1 ${x + r[0]},${y}` : '',
    'Z',
  ]
    .filter(Boolean)
    .join('');
}

/** 与 recharts 一致：文字基线靠 tspan dy 调整。 */
function TickText({
  x,
  y,
  anchor,
  dy,
  children,
}: {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  dy: string;
  children: React.ReactNode;
}) {
  return (
    <text x={x} y={y} fill={TICK_FILL} fontSize={TICK_FONT} textAnchor={anchor}>
      <tspan x={x} dy={dy}>
        {children}
      </tspan>
    </text>
  );
}

/** 悬停提示。样式与原来的 shadcn ChartTooltipContent 保持一致。 */
function ChartTip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 grid min-w-32 -translate-y-1/2 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl"
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.label ? <div className="font-medium">{tip.label}</div> : null}
      {tip.rows.map((row) => (
        <div key={row.name} className="flex items-center gap-2">
          <i
            className="size-2.5 shrink-0 rounded-[2px]"
            style={{ background: row.color }}
          />
          <span className="flex-1 text-muted-foreground">{row.name}</span>
          <span className="font-mono font-medium tabular-nums text-foreground">
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartFrame({
  width,
  height,
  label,
  children,
  tip,
}: {
  width: number;
  height: number;
  label: string;
  children: React.ReactNode;
  tip: TipState;
}) {
  return (
    <>
      <svg
        // 图表只能由 SVG 承载，换不成 <img>；role=img + aria-label 是 SVG 可访问性的标准写法
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="img"
        aria-label={label}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        // hydration 前容器宽度未知：用 max-width 兜住，避免窄屏出现横向溢出
        style={{ maxWidth: '100%', height: 'auto' }}
      >
        {children}
      </svg>
      <ChartTip tip={tip} />
    </>
  );
}

/* ------------------------------------------------------------------ *
 * 图 1：行业涨跌幅横向柱状图
 * ------------------------------------------------------------------ */
export type ChangeRow = { name: string; change: number };

export function SectorChangeChart({
  data,
  height = 390,
  fallbackWidth = 700,
}: {
  data: ChangeRow[];
  height?: number;
  fallbackWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref, fallbackWidth);
  const clipId = useSvgId('bar-clip');

  // 注意：recharts 的 margin 不与默认值合并。原来写的是 margin={{left:6,right:24}}，
  // 所以 top/bottom 实际是 0，分类带从 y=0 开始、x 轴占 30。
  const margin = { top: 0, right: 24, bottom: 0, left: 6 };
  // 分类轴按最宽行业名动态留宽（指数名可达 6 个中文字）。
  const axisWidth = axisWidthFor(
    data.map((row) => row.name),
    68,
  );
  const axisHeight = 30;
  const x0 = margin.left + axisWidth;
  const x1 = width - margin.right;
  const y0 = margin.top;
  const y1 = height - margin.bottom - axisHeight;

  const changes = data.map((row) => row.change);
  const ticks = niceTickValues(
    [Math.min(0, ...changes), Math.max(0, ...changes)],
    5,
    true,
  );
  const domain = [ticks[0], ticks.at(-1) ?? 0];
  const span = domain[1] - domain[0] || 1;
  const scaleX = (value: number) => x0 + ((value - domain[0]) / span) * (x1 - x0);

  const band = (y1 - y0) / Math.max(data.length, 1);
  const { gap, size: barHeight } = barGeometry(band);
  const zeroX = scaleX(0);
  const [hover, setHover] = useState<number | null>(null);
  const active = hover === null ? null : data[hover];

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <ChartFrame
        width={width}
        height={height}
        label={`行业当日涨跌幅柱状图，共 ${data.length} 个行业`}
        tip={
          active && hover !== null
            ? {
                x: scaleX(active.change) + 12,
                y: y0 + hover * band + band / 2,
                label: active.name,
                rows: [
                  {
                    name: '涨跌幅',
                    value: `${Number(active.change).toFixed(2)}%`,
                    color: active.change >= 0 ? UP_COLOR : DOWN_COLOR,
                  },
                ],
              }
            : null
        }
      >
        <defs>
          {/* 柱子从 0 轴向左、右同时长出：用一个以 0 轴为原点的裁剪矩形实现，
              比缩放柱子更准（不会把圆角压扁）。 */}
          <clipPath id={clipId}>
            <rect
              className="chart-anim-grow-x"
              x={x0}
              y={y0}
              width={x1 - x0}
              height={y1 - y0}
              style={{
                transformBox: 'view-box',
                transformOrigin: `${zeroX}px ${y0}px`,
              }}
            />
          </clipPath>
        </defs>
        {ticks.map((tick) => (
          <line
            key={tick}
            x1={scaleX(tick)}
            y1={y0}
            x2={scaleX(tick)}
            y2={y1}
            stroke={GRID_STROKE}
            strokeDasharray="3 3"
          />
        ))}
        <g clipPath={`url(#${clipId})`}>
          {hover !== null ? (
            <rect
              x={x0}
              y={y0 + hover * band}
              width={x1 - x0}
              height={band}
              fill={CURSOR_FILL}
            />
          ) : null}
          {data.map((row, index) => {
            const left = Math.min(zeroX, scaleX(row.change));
            const right = Math.max(zeroX, scaleX(row.change));
            const top = y0 + index * band + gap;
            return (
              <path
                key={row.name}
                d={roundedRect(left, top, Math.max(right - left, 0), barHeight, [
                  0, 4, 4, 0,
                ])}
                fill={row.change >= 0 ? UP_COLOR : DOWN_COLOR}
              />
            );
          })}
        </g>
        {ticks.map((tick) => (
          <TickText
            key={`t${tick}`}
            x={scaleX(tick)}
            y={y1 + axisHeight / 2 - 7}
            anchor="middle"
            dy="0.71em"
          >
            {`${tick}%`}
          </TickText>
        ))}
        {data.map((row, index) => (
          <TickText
            key={`c${row.name}`}
            x={x0 - 8}
            y={y0 + index * band + band / 2}
            anchor="end"
            dy="0.355em"
          >
            {row.name}
          </TickText>
        ))}
        <rect
          x={x0}
          y={y0}
          width={x1 - x0}
          height={y1 - y0}
          fill="transparent"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const index = Math.floor((event.clientY - box.top) / band);
            setHover(index >= 0 && index < data.length ? index : null);
          }}
        />
      </ChartFrame>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 图 2：信息面分布环形图
 * ------------------------------------------------------------------ */
function polar(cx: number, cy: number, radius: number, angle: number) {
  const rad = (angle * Math.PI) / 180;
  return [cx + radius * Math.cos(rad), cy - radius * Math.sin(rad)];
}

function ringSector(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  start: number,
  end: number,
) {
  const [ox0, oy0] = polar(cx, cy, outer, start);
  const [ox1, oy1] = polar(cx, cy, outer, end);
  const [ix1, iy1] = polar(cx, cy, inner, end);
  const [ix0, iy0] = polar(cx, cy, inner, start);
  const large = Math.abs(end - start) > 180 ? 1 : 0;
  const sweep = end < start ? 1 : 0;
  return [
    `M${ox0},${oy0}`,
    `A${outer},${outer} 0 ${large} ${sweep} ${ox1},${oy1}`,
    `L${ix1},${iy1}`,
    `A${inner},${inner} 0 ${large} ${sweep ? 0 : 1} ${ix0},${iy0}`,
    'Z',
  ].join('');
}

export type DonutRow = { name: string; value: number; fill: string };

export function ToneDistributionChart({
  data,
  height = 230,
  fallbackWidth = 300,
  innerRadius = 55,
  outerRadius = 82,
  paddingAngle = 4,
}: {
  data: DonutRow[];
  height?: number;
  fallbackWidth?: number;
  innerRadius?: number;
  outerRadius?: number;
  paddingAngle?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref, fallbackWidth);
  const cx = width / 2;
  const cy = height / 2;

  // 复刻 recharts v3 的 Pie 角度算法（recharts/es6/polar/Pie.js 的 computePieSectors
  // 配合默认值 startAngle: 0 / endAngle: 360）：
  //   1. 方向取 mathSign(endAngle - startAngle)，默认 +1（屏幕上逆时针）
  //   2. 每段跨度 = (|Δ角度| - 总间隙) × 占比
  //   3. 总间隙 = 非零项数 × paddingAngle（|Δ角度| ≥ 360 时），间隙留在段与段之间
  // 注意：这两条都与官方文档写的（90 / -270、每段两端各收半个间隙）不一致，
  // 是按真实渲染的路径反解出来的。
  const startAngle = 0;
  const endAngle = 360;
  const sign = Math.sign(endAngle - startAngle) || 1;
  const absDelta = Math.min(Math.abs(endAngle - startAngle), 360);
  const notZero = data.filter((row) => row.value !== 0).length;
  const pad = data.length <= 1 ? 0 : paddingAngle;
  const totalPadding = (absDelta >= 360 ? notZero : Math.max(notZero - 1, 0)) * pad;
  const realTotal = absDelta - totalPadding;
  const sum = data.reduce((total, row) => total + row.value, 0);

  // 用 reduce 累计游标，而不是在 map 外面维护一个可变变量
  // （react-compiler 的不可变规则不允许在渲染期改外层变量）
  const arcs = data
    .reduce<{ rows: Array<DonutRow & { path: string }>; cursor: number }>(
      (acc, row, index) => {
        const start = index === 0 ? startAngle : acc.cursor + sign * pad;
        const end = start + sign * (sum ? (row.value / sum) * realTotal : 0);
        return {
          rows: [
            ...acc.rows,
            {
              ...row,
              path: ringSector(cx, cy, innerRadius, outerRadius, start, end),
            },
          ],
          cursor: end,
        };
      },
      { rows: [], cursor: startAngle },
    )
    .rows;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <svg
        // 同上：图表只能由 SVG 承载；这里把各扇形的数值读给读屏软件
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="img"
        aria-label={data
          .map((row) => `${row.name} ${row.value}`)
          .join('，')}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        style={{ maxWidth: '100%', height: 'auto' }}
      >
        <g
          className="chart-anim-pop"
          style={{ transformBox: 'view-box', transformOrigin: `${cx}px ${cy}px` }}
        >
          {arcs.map((arc) => (
            <path key={arc.name} d={arc.path} fill={arc.fill} />
          ))}
        </g>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 图 3：60 日收盘面积图
 * ------------------------------------------------------------------ */
export type CloseRow = { date: string; close: number };

/** d3 curveMonotoneX —— recharts `type="monotone"` 用的就是它。 */
function monotonePath(points: Array<[number, number]>) {
  const n = points.length;
  if (n < 2) return '';
  const dx: number[] = [];
  const ms: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0];
    ms[i] = dx[i] ? (points[i + 1][1] - points[i][1]) / dx[i] : 0;
  }
  const m: number[] = [ms[0]];
  for (let i = 1; i < n - 1; i++) {
    if (ms[i - 1] * ms[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / ms[i - 1] + w2 / ms[i]);
    }
  }
  m[n - 1] = ms[n - 2];
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = (x1 - x0) / 3;
    d += `C${x0 + h},${y0 + h * m[i]},${x1 - h},${y1 - h * m[i + 1]},${x1},${y1}`;
  }
  return d;
}

export function CloseTrendChart({
  data,
  height = 330,
  fallbackWidth = 820,
  minTickGap = 28,
}: {
  data: CloseRow[];
  height?: number;
  fallbackWidth?: number;
  minTickGap?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref, fallbackWidth);
  const clipId = useSvgId('area-clip');
  const gradientId = useSvgId('area-fill');

  const margin = { top: 5, right: 5, bottom: 5, left: 5 };
  const axisHeight = 30;

  const closes = data.map((row) => row.close);
  const domain: [number, number] = [
    Math.min(...closes) - 20,
    Math.max(...closes) + 20,
  ];
  // 显式给出的数字范围 → 用固定域刻度（不向外取整）
  const ticks = niceTickValuesFixedDomain(domain, 5, true);
  // 纵轴宽度按最宽刻度动态计算：指数级数值（如 26029.46）有 8 个字符，
  // 固定 48px 会把首位裁掉、看起来像"数值算错"。
  const axisWidth = axisWidthFor(ticks.map((tick) => String(tick)), 48);
  const x0 = margin.left + axisWidth;
  const x1 = width - margin.right;
  const y0 = margin.top;
  const y1 = height - margin.bottom - axisHeight;

  const span = domain[1] - domain[0] || 1;
  const scaleY = (value: number) => y1 - ((value - domain[0]) / span) * (y1 - y0);
  const step = data.length > 1 ? (x1 - x0) / (data.length - 1) : 0;
  const scaleX = (index: number) => x0 + index * step;

  const points = data.map(
    (row, index) => [scaleX(index), scaleY(row.close)] as [number, number],
  );
  const line = monotonePath(points);
  const area = `${line}L${x1},${y1}L${x0},${y1}Z`;
  const { shown: shownLabels, coords: labelCoords } = thinTicksFromEnd(
    data.map((row, index) => ({ coord: scaleX(index), text: row.date.slice(5) })),
    minTickGap,
    x0,
    x1,
  );

  const [hover, setHover] = useState<number | null>(null);
  const active = hover === null ? null : data[hover];

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <ChartFrame
        width={width}
        height={height}
        label={`最近 ${data.length} 个交易日收盘走势`}
        tip={
          active && hover !== null
            ? {
                x: Math.min(scaleX(hover) + 12, width - 130),
                y: scaleY(active.close) - 12,
                label: active.date,
                rows: [{ name: '收盘', value: String(active.close), color: CYAN }],
              }
            : null
        }
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CYAN} stopOpacity={0.32} />
            <stop offset="100%" stopColor={CYAN} stopOpacity={0} />
          </linearGradient>
          {/* recharts 的面积/折线也是这样从左到右揭示的 */}
          <clipPath id={clipId}>
            <rect
              className="chart-anim-reveal"
              x={x0}
              y={y0}
              width={x1 - x0}
              height={y1 - y0}
              style={{
                transformBox: 'view-box',
                transformOrigin: `${x0}px ${y0}px`,
              }}
            />
          </clipPath>
        </defs>
        {ticks.map((tick) => (
          <line
            key={tick}
            x1={x0}
            y1={scaleY(tick)}
            x2={x1}
            y2={scaleY(tick)}
            stroke={GRID_STROKE}
            strokeDasharray="3 3"
          />
        ))}
        <g clipPath={`url(#${clipId})`}>
          <path d={area} fill={`url(#${gradientId})`} />
          <path d={line} fill="none" stroke={CYAN} strokeWidth={2} />
        </g>
        {hover !== null ? (
          <>
            <line
              x1={scaleX(hover)}
              y1={y0}
              x2={scaleX(hover)}
              y2={y1}
              stroke={CURSOR_LINE}
            />
            <circle
              cx={scaleX(hover)}
              cy={scaleY(data[hover].close)}
              r={3.5}
              fill={CYAN}
            />
          </>
        ) : null}
        {ticks.map((tick) => (
          <TickText
            key={`t${tick}`}
            x={x0 - 8}
            y={Math.max(scaleY(tick), y0 + 2.5)}
            anchor="end"
            dy="0.355em"
          >
            {tick}
          </TickText>
        ))}
        {data.map((row, index) =>
          shownLabels[index] ? (
            <TickText
              key={`x${index}`}
              x={labelCoords[index]}
              y={y1 + axisHeight / 2 - 7}
              anchor="middle"
              dy="0.71em"
            >
              {row.date.slice(5)}
            </TickText>
          ) : null,
        )}
        <rect
          x={x0}
          y={y0}
          width={x1 - x0}
          height={y1 - y0}
          fill="transparent"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const index = Math.round((event.clientX - box.left) / (step || 1));
            setHover(index >= 0 && index < data.length ? index : null);
          }}
        />
      </ChartFrame>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 图 4：量能与市场宽度双轴图
 * ------------------------------------------------------------------ */
export type VolumeRow = {
  date: string;
  volume: number;
  breadth: number | null;
};

function formatVolume(value: number) {
  if (Number.isNaN(value)) return '—';
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(2)}万`;
  return value.toFixed(0);
}

function formatVolumeTick(value: number) {
  return value >= 1e8
    ? `${(value / 1e8).toFixed(0)}亿`
    : value >= 1e4
      ? `${(value / 1e4).toFixed(0)}万`
      : String(value);
}

export function VolumeBreadthChart({
  data,
  height = 250,
  fallbackWidth = 700,
  showBreadth = true,
}: {
  data: VolumeRow[];
  height?: number;
  fallbackWidth?: number;
  showBreadth?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useMeasuredWidth(ref, fallbackWidth);
  const barClipId = useSvgId('vol-clip');
  const lineClipId = useSvgId('brd-clip');

  const margin = { top: 5, right: 5, bottom: 5, left: 5 };
  // recharts 的 YAxis 默认宽度是 60（详情页面积图显式写了 48，这张没写）
  const axisWidth = 60;
  const rightAxisWidth = showBreadth ? 60 : 0;
  const axisHeight = 30;
  const x0 = margin.left + axisWidth;
  const x1 = width - margin.right - rightAxisWidth;
  const y0 = margin.top;
  const y1 = height - margin.bottom - axisHeight;

  const volumes = data.map((row) => row.volume);
  const volumeTicks = niceTickValues([0, Math.max(...volumes)], 5, true);
  const volumeDomain: [number, number] = [0, volumeTicks.at(-1) ?? 1];
  const volumeSpan = volumeDomain[1] - volumeDomain[0] || 1;
  const scaleY = (value: number) =>
    y1 - ((value - volumeDomain[0]) / volumeSpan) * (y1 - y0);
  const scaleBreadth = (value: number) => y1 - (value / 100) * (y1 - y0);

  const band = (x1 - x0) / Math.max(data.length, 1);
  const { gap, size: barWidth } = barGeometry(band);
  const scaleX = (index: number) => x0 + index * band + band / 2;

  const breadthPoints = showBreadth
    ? data
        .map((row, index) =>
          row.breadth === null || row.breadth === undefined
            ? null
            : ([scaleX(index), scaleBreadth(row.breadth)] as [number, number]),
        )
        .filter((point): point is [number, number] => point !== null)
    : [];
  const breadthTicks = showBreadth ? niceTickValuesFixedDomain([0, 100], 5, true) : [];
  const { shown: shownLabels, coords: labelCoords } = thinTicksFromEnd(
    data.map((row, index) => ({ coord: scaleX(index), text: row.date.slice(5) })),
    5,
    x0,
    x1,
  );

  const [hover, setHover] = useState<number | null>(null);
  const active = hover === null ? null : data[hover];

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      <ChartFrame
        width={width}
        height={height}
        label={`最近 ${data.length} 个交易日量能与市场宽度`}
        tip={
          active && hover !== null
            ? {
                x: Math.min(scaleX(hover) + 12, width - 140),
                y: y0 + 8,
                label: active.date,
                rows: [
                  {
                    name: '量能',
                    value: formatVolume(active.volume),
                    color: VOLUME_COLOR,
                  },
                  ...(showBreadth && active.breadth !== null
                    ? [
                        {
                          name: '上涨宽度',
                          value: `${active.breadth}%`,
                          color: UP_COLOR,
                        },
                      ]
                    : []),
                ],
              }
            : null
        }
      >
        <defs>
          <clipPath id={barClipId}>
            <rect
              className="chart-anim-grow-y"
              x={x0}
              y={y0}
              width={x1 - x0}
              height={y1 - y0}
              style={{
                transformBox: 'view-box',
                transformOrigin: `${x0}px ${y1}px`,
              }}
            />
          </clipPath>
          <clipPath id={lineClipId}>
            <rect
              className="chart-anim-reveal"
              x={x0}
              y={y0}
              width={x1 - x0}
              height={y1 - y0}
              style={{
                transformBox: 'view-box',
                transformOrigin: `${x0}px ${y0}px`,
              }}
            />
          </clipPath>
        </defs>
        {volumeTicks.map((tick) => (
          <line
            key={tick}
            x1={x0}
            y1={scaleY(tick)}
            x2={x1}
            y2={scaleY(tick)}
            stroke={GRID_STROKE}
            strokeDasharray="3 3"
          />
        ))}
        <g clipPath={`url(#${barClipId})`}>
          {hover !== null ? (
            <rect
              x={x0 + hover * band}
              y={y0}
              width={band}
              height={y1 - y0}
              fill={CURSOR_FILL}
            />
          ) : null}
          {data.map((row, index) => {
            const top = scaleY(row.volume);
            return (
              <path
                key={row.date}
                d={roundedRect(
                  x0 + index * band + gap,
                  top,
                  barWidth,
                  Math.max(y1 - top, 0),
                  [3, 3, 0, 0],
                )}
                fill={VOLUME_COLOR}
              />
            );
          })}
        </g>
        {breadthPoints.length > 1 ? (
          <g clipPath={`url(#${lineClipId})`}>
            <path
              d={monotonePath(breadthPoints)}
              fill="none"
              stroke={UP_COLOR}
              strokeWidth={2}
            />
          </g>
        ) : null}
        {/* 只有一个有效交易日的宽度值时，原实现是画一个点而不是画线 */}
        {breadthPoints.length === 1 ? (
          <circle
            cx={breadthPoints[0][0]}
            cy={breadthPoints[0][1]}
            r={3.5}
            fill={UP_COLOR}
          />
        ) : null}
        {volumeTicks.map((tick) => (
          <TickText
            key={`v${tick}`}
            x={x0 - 8}
            y={Math.max(scaleY(tick), y0 + 2.5)}
            anchor="end"
            dy="0.355em"
          >
            {formatVolumeTick(tick)}
          </TickText>
        ))}
        {breadthTicks.map((tick) => (
          <TickText
            key={`b${tick}`}
            x={x1 + 8}
            y={Math.max(scaleBreadth(tick), y0 + 2.5)}
            anchor="start"
            dy="0.355em"
          >
            {`${tick}%`}
          </TickText>
        ))}
        {data.map((row, index) =>
          shownLabels[index] ? (
            <TickText
              key={`x${index}`}
              x={labelCoords[index]}
              y={y1 + axisHeight / 2 - 7}
              anchor="middle"
              dy="0.71em"
            >
              {row.date.slice(5)}
            </TickText>
          ) : null,
        )}
        <rect
          x={x0}
          y={y0}
          width={x1 - x0}
          height={y1 - y0}
          fill="transparent"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const index = Math.floor((event.clientX - box.left) / band);
            setHover(index >= 0 && index < data.length ? index : null);
          }}
        />
      </ChartFrame>
    </div>
  );
}
