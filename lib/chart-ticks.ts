/**
 * 坐标轴刻度算法：无依赖复刻 recharts 的行为。
 *
 * 为什么要复刻而不是自己写一套：换掉 recharts 后刻度必须与原来的图表逐一对齐，
 * 否则会出现「网格线位置变了」这种难以察觉的漂移。这份实现曾与
 * `recharts/es6/util/scale/getNiceTickValues.js` 做过 4000 组随机域对拍，结果完全一致
 * （见 work/preview/src/analyze.jsx）。
 *
 * 两种模式对应 recharts 的两条分支（recharts/es6/state/selectors/axisSelectors.js）：
 *  - 轴的 domain 里含 `'auto'` 关键字（例如默认的 `[0, 'auto']`）→ `niceTickValues`，
 *    刻度可以落到域外，recharts 会再用刻度把 domain 撑大；
 *  - 轴的 domain 是显式数字（例如 `['dataMin - 20', 'dataMax + 20']`）→
 *    `niceTickValuesFixedDomain`，刻度不向外取整，且强制把上限也作为一个刻度。
 *    这正是详情页纵轴会出现 `3744.15 / 3894.15 / 4044.15 / 4183.1` 的原因。
 */

/**
 * 抹掉浮点噪声。recharts 原实现用 decimal.js 做精确十进制运算，纯浮点复刻会出现两类噪声：
 *  - 量级噪声：0 + 4×1.5e8 会算出 600000000.0000001
 *  - 零附近噪声：-2.1 + 3×0.7 会算出 -1.11e-16（本该正好是 0 这个刻度）
 * 前者用 12 位有效数字抹掉，后者相对步长极小则直接归零（同时把 -0 归一成 0）。
 */
function tidy(value: number, step?: number) {
  if (value === 0) return 0;
  if (step && Math.abs(value) < Math.abs(step) * 1e-9) return 0;
  const cleaned = Number(value.toPrecision(12));
  return cleaned === 0 ? 0 : cleaned;
}

function getDigitCount(value: number) {
  if (value === 0) return 1;
  return Math.floor(Math.log10(Math.abs(value))) + 1;
}

/** 对应 recharts 的 getAdaptiveStep：把粗糙步长吸附到 1/2/2.5/5 这类好读的数字。 */
function getAdaptiveStep(
  roughStep: number,
  allowDecimals: boolean,
  correctionFactor: number,
) {
  if (!(roughStep > 0)) return 0;
  const digitCount = getDigitCount(roughStep);
  const digitCountValue = 10 ** digitCount;
  const stepRatio = roughStep / digitCountValue;
  const stepRatioScale = digitCount !== 1 ? 0.05 : 0.1;
  const amendStepRatio =
    (Math.ceil(tidy(stepRatio / stepRatioScale)) + correctionFactor) *
    stepRatioScale;
  const formatStep = tidy(amendStepRatio * digitCountValue);
  return allowDecimals ? formatStep : Math.ceil(formatStep);
}

function calculateStep(
  min: number,
  max: number,
  tickCount: number,
  allowDecimals: boolean,
  correctionFactor: number,
): { step: number; tickMin: number; tickMax: number } {
  if (!Number.isFinite((max - min) / (tickCount - 1))) {
    return { step: 0, tickMin: 0, tickMax: 0 };
  }
  const step = getAdaptiveStep(
    (max - min) / (tickCount - 1),
    allowDecimals,
    correctionFactor,
  );
  let middle: number;
  if (min <= 0 && max >= 0) {
    // 0 落在区间内时，0 一定是一个刻度
    middle = 0;
  } else {
    middle = (min + max) / 2;
    middle = middle - (middle % step);
  }
  const belowCount = Math.ceil((middle - min) / step);
  let upCount = Math.ceil((max - middle) / step);
  const scaleCount = belowCount + upCount + 1;
  if (scaleCount > tickCount) {
    // 需要更多刻度才能覆盖区间 → 步长再放大一档
    return calculateStep(min, max, tickCount, allowDecimals, correctionFactor + 1);
  }
  let below = belowCount;
  if (scaleCount < tickCount) {
    // 刻度不足 → 往一侧补
    upCount = max > 0 ? upCount + (tickCount - scaleCount) : upCount;
    below = max > 0 ? below : below + (tickCount - scaleCount);
  }
  return {
    step,
    tickMin: middle - below * step,
    tickMax: middle + upCount * step,
  };
}

/**
 * 对应 recharts 的 `getNiceTickValues`：domain 含 `'auto'` 关键字时使用。
 *
 * @param domain [min, max]
 * @param tickCount recharts 轴默认 5
 */
export function niceTickValues(
  domain: [number, number],
  tickCount = 5,
  allowDecimals = true,
): number[] {
  const [rawMin, rawMax] = domain;
  const count = Math.max(tickCount, 2);
  const cormin = Math.min(rawMin, rawMax);
  const cormax = Math.max(rawMin, rawMax);
  if (!Number.isFinite(cormin) || !Number.isFinite(cormax)) return [rawMin, rawMax];
  if (cormin === cormax) return [cormin];

  const { step, tickMin, tickMax } = calculateStep(
    cormin,
    cormax,
    count,
    allowDecimals,
    0,
  );
  if (!(step > 0)) return [cormin, cormax];

  // 原实现是 rangeStep(tickMin, tickMax + 0.1 * step, step)：严格小于终点才收录。
  // 这里改成下标推进，避免浮点累加漂移。
  const end = tickMax + 0.1 * step;
  const values: number[] = [];
  for (let i = 0; i < 100000; i++) {
    const value = tidy(tickMin + i * step, step);
    if (!(value < end)) break;
    values.push(value);
  }
  return rawMin > rawMax ? values.reverse() : values;
}

/**
 * 对应 recharts 的 `getTickValuesFixedDomain`：domain 是显式数字时使用。
 * 刻度被约束在区间内，并强制把上限补成最后一个刻度。
 */
export function niceTickValuesFixedDomain(
  domain: [number, number],
  tickCount = 5,
  allowDecimals = true,
): number[] {
  const [rawMin, rawMax] = domain;
  const reversed = rawMin > rawMax;
  const cormin = Math.min(rawMin, rawMax);
  const cormax = Math.max(rawMin, rawMax);
  if (!Number.isFinite(cormin) || !Number.isFinite(cormax)) return [rawMin, rawMax];
  if (cormin === cormax) return [cormin];

  const count = Math.max(tickCount, 2);
  const step = getAdaptiveStep((cormax - cormin) / (count - 1), allowDecimals, 0);
  const values: number[] = [];
  if (step > 0) {
    for (let i = 0; i < 100000; i++) {
      const value = tidy(cormin + i * step, step);
      if (!(value < cormax)) break;
      values.push(value);
    }
  }
  values.push(tidy(cormax, step));
  const ticks = allowDecimals ? values : values.map((value) => Math.round(value));
  return reversed ? ticks.reverse() : ticks;
}

/**
 * 复刻 recharts 的柱宽规则（recharts/es6/state/selectors/combiners/
 * combineAllBarPositions.js 里 `sizeList[0].barSize` 为空时的分支）：
 *
 * ```
 * gap  = band × barCategoryGap(默认 10%)
 * size = (band - 2 × gap) / 柱数量   → 大于 1 时按位取整（trunc）
 * 左端 = band 起点 + gap              → 不是居中
 * ```
 */
export function barGeometry(band: number, categoryGap = 0.1) {
  const gap = band * categoryGap;
  const rawSize = band - 2 * gap;
  const size = rawSize > 1 ? Math.trunc(rawSize) : rawSize;
  return { gap, size };
}

/** 刻度文字的字号，与组件里的渲染字号一致。 */
const TICK_FONT = 12;

/**
 * 量文字宽度。recharts 是往 body 上挂一个隐藏 span 去量（`getStringSize`），
 * 这里用等价做法：同样 12px、同样 `white-space: pre`。
 * 无 DOM（Node 单测）时退化成按字数估算，保证纯函数仍可测。
 */
let measureSpan: HTMLSpanElement | null = null;
const widthCache = new Map<string, number>();
export function textWidth(text: string) {
  if (widthCache.has(text)) return widthCache.get(text) ?? 0;
  if (typeof document === 'undefined') return text.length * 6;
  if (!measureSpan) {
    measureSpan = document.createElement('span');
    measureSpan.setAttribute('aria-hidden', 'true');
    Object.assign(measureSpan.style, {
      position: 'absolute',
      top: '-20000px',
      left: '0',
      padding: '0',
      margin: '0',
      border: 'none',
      whiteSpace: 'pre',
      fontSize: `${TICK_FONT}px`,
    });
    document.body.appendChild(measureSpan);
  }
  measureSpan.textContent = text;
  const width = measureSpan.getBoundingClientRect().width;
  widthCache.set(text, width);
  return width;
}

/**
 * 复刻 recharts 的标签稀疏算法（getTicksEnd）：从最后一个刻度向左贪心，
 * 只保留与已保留标签距离 ≥ minTickGap 的刻度；最后一个标签左移半个宽度贴边。
 *
 * 注意要把位移后的坐标一起返回 —— 只返回"显示与否"会导致末标签按原坐标画出去、
 * 溢出绘图区被裁掉（这个 bug 在预览阶段的 11.67px 偏差里暴露过）。
 */
export function thinTicksFromEnd(
  items: Array<{ coord: number; text: string }>,
  minTickGap: number,
  start: number,
  end: number,
) {
  const coords = items.map((item) => item.coord);
  const sizes = items.map((item) => textWidth(item.text));
  const last = coords.length - 1;
  if (last >= 0) {
    const overflow = coords[last] + sizes[last] / 2 - end;
    if (overflow > 0) coords[last] -= overflow;
  }
  const shown = Array.from<boolean>({ length: items.length }).fill(false);
  let limit = end;
  for (let i = last; i >= 0; i--) {
    const right = coords[i] + sizes[i] / 2;
    if (right <= limit && right >= start) {
      shown[i] = true;
      limit = coords[i] - (sizes[i] / 2 + minTickGap);
    }
  }
  return { shown, coords };
}

/**
 * 纯函数版文字宽度估算（12px 字号），用于**服务端与客户端必须一致**的布局计算。
 *
 * 不要在这里用 `textWidth`：它依赖 DOM 测量，SSR 会走 `长度 × 6` 的估算分支、
 * 客户端走真实测量，两端算出的坐标轴宽度不同会让布局在 hydration 前后跳变。
 */
export function estimateTextWidth(text: string) {
  let total = 0;
  for (const char of text) {
    if (char === '.' || char === ',') total += 3.4;
    else if (char === '-' || char === '%' || char === '/') total += 4.2;
    else if (/[\u4e00-\u9fff]/.test(char)) total += 12;
    else total += 6.7;
  }
  return total;
}

/**
 * 纵轴（或分类轴）预留宽度：最宽标签的估算宽度 + 8px 间隙，且不小于 `min`。
 *
 * 起因是一个真实缺陷：指数级别的数值有 8 个字符（如 `26029.46`），
 * 原来固定 48px 的纵轴会把首位裁掉——页面上显示成 `6029.46`，
 * 看起来像"数值算错了"，实际是标签被裁。
 */
export function axisWidthFor(labels: string[], min = 40) {
  const widest = labels.reduce(
    (max, label) => Math.max(max, estimateTextWidth(label)),
    0,
  );
  return Math.max(min, Math.ceil(widest) + 8);
}

