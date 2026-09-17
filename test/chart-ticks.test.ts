import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  axisWidthFor,
  barGeometry,
  estimateTextWidth,
  niceTickValues,
  niceTickValuesFixedDomain,
  textWidth,
  thinTicksFromEnd,
} from '../lib/chart-ticks.ts';

/**
 * 这里的期望值不是"算出来的应该值"，而是从**线上 recharts 真实渲染的 DOM** 里
 * 抄回来的刻度，用来锁住"换实现后刻度不能漂移"。
 */

test('默认域（含 auto）的刻度：涨跌幅轴要包含负值', () => {
  // 实测：线上那一屏 14 个行业的涨跌幅范围是 -2.09% ~ 0.07%，
  // recharts 画出来的刻度正好是这 5 个。
  assert.deepEqual(niceTickValues([-2.09, 0.07], 5), [-2.1, -1.4, -0.7, 0, 0.7]);
});

test('显式数字域用固定域刻度，不向外取整', () => {
  // 实测：60 日收盘 3764.15 ~ 4163.1，配 ['dataMin - 20', 'dataMax + 20']，
  // recharts 纵轴刻度是这几个"不圆整"的值（末位是硬补上的上限）。
  assert.deepEqual(
    niceTickValuesFixedDomain([3764.15 - 20, 4163.1 + 20], 5),
    [3744.15, 3894.15, 4044.15, 4183.1],
  );
  // 0~100% 的宽度轴
  assert.deepEqual(niceTickValuesFixedDomain([0, 100], 5), [0, 25, 50, 75, 100]);
});

test('量能轴：刻度会外扩到 6 亿，标签因此出现 2/3/5/6 亿', () => {
  const ticks = niceTickValues([0, 579123145], 5);
  assert.deepEqual(ticks, [0, 1.5e8, 3e8, 4.5e8, 6e8]);
  // 组件里的格式化会把 1.5 亿四舍五入显示成"2亿"，这是原样保留的既有行为
  assert.equal((1.5e8 / 1e8).toFixed(0), '2');
});

test('柱宽规则与 recharts 一致：trunc(band - 2×gap)，左端贴 band 起点 + gap', () => {
  const close = (actual: number, expected: number) =>
    Math.abs(actual - expected) < 1e-9;
  // 图 1：band = 360 / 14（实测线上柱子高 20、首根 y = 2.57）
  const bar = barGeometry(360 / 14);
  assert.equal(bar.size, 20);
  assert.ok(close(bar.gap, (360 / 14) * 0.1));
  // 图 4：band = 530 / 20（实测线上柱子宽 21、首根 x = 67.65 = 65 + 2.65）
  const volume = barGeometry(530 / 20);
  assert.equal(volume.size, 21);
  assert.ok(close(volume.gap, 2.65));
});

test('退化为单值或非法区间时不抛错', () => {
  assert.deepEqual(niceTickValues([5, 5], 5), [5]);
  assert.deepEqual(niceTickValuesFixedDomain([7, 7], 5), [7]);
  assert.deepEqual(niceTickValues([0, 0.07], 5), [0, 0.02, 0.04, 0.06, 0.08]);
});

test('密集日期轴：标签从末尾向左贪心，末标签必须左移贴边、不许溢出', () => {
  // 20 个刻度、间距 26.5，绘图区 [65, 595]
  const items = Array.from({ length: 20 }, (_, index) => ({
    coord: 65 + index * 26.5 + 26.5 / 2,
    text: `08-${String(index + 1).padStart(2, '0')}`,
  }));
  const { shown, coords } = thinTicksFromEnd(items, 5, 65, 595);
  const visible = coords.filter((_, index) => shown[index]);

  // 最后一个标签一定显示
  assert.equal(shown.at(-1), true);
  // 末标签被左移过：位移量正好是半个文字宽度
  assert.ok(coords.at(-1)! < items.at(-1)!.coord);
  assert.ok(
    Math.abs(coords.at(-1)! + textWidth(items.at(-1)!.text) / 2 - 595) < 1e-9,
  );
  // 所有显示的标签都落在绘图区内（这是当初漏掉位移时溢出的那条不变量）
  for (const [index, coord] of coords.entries()) {
    if (!shown[index]) continue;
    const half = textWidth(items[index].text) / 2;
    assert.ok(
      coord - half >= 65 - 1e-9 && coord + half <= 595 + 1e-9,
      `标签 ${items[index].text} 越界: ${coord - half} ~ ${coord + half}`,
    );
  }
  // 相邻标签间距不小于 minTickGap（以右边缘起算，与 recharts 一致）
  for (let i = 1; i < visible.length; i++) {
    assert.ok(visible[i] - visible[i - 1] > 5);
  }
});

test('图表不再依赖 recharts，且入场动画有降级开关', () => {
  const dashboard = readFileSync(
    new URL('../components/market-dashboard.tsx', import.meta.url),
    'utf8',
  );
  const detail = readFileSync(
    new URL('../components/sector-detail.tsx', import.meta.url),
    'utf8',
  );
  const charts = readFileSync(
    new URL('../components/charts.tsx', import.meta.url),
    'utf8',
  );
  const css = readFileSync(
    new URL('../app/globals.css', import.meta.url),
    'utf8',
  );
  const pkg = readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  );

  // 组件层不许再引回 recharts（换自绘 SVG 的初衷是为客户端省 ~111KB gzip）
  for (const source of [dashboard, detail, charts]) {
    assert.doesNotMatch(source, /from 'recharts'/);
  }
  assert.doesNotMatch(pkg, /"recharts"/);
  // 用了自绘图表
  assert.match(dashboard, /from '@\/components\/charts'/);
  assert.match(detail, /from '@\/components\/charts'/);
  // 入场动画必须能被 prefers-reduced-motion 关掉
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.chart-anim-grow-x/);
  assert.match(charts, /chart-anim-grow-x|chart-anim-grow-y/);
});

test('轴宽按最宽刻度动态计算：指数级数值不能被裁', () => {
  // 真实缺陷：恒生/日经这类 8 字符的指数点位（26029.46）在固定 48px 纵轴下
  // 首位被裁掉、页面显示成 "6029.46"，看起来像"数值算错了"。
  const indexAxis = axisWidthFor(['22651.86', '26029.46'], 48);
  assert.ok(indexAxis > 48, `指数级刻度应超过最小值 48，实际 ${indexAxis}`);
  assert.ok(
    indexAxis >= estimateTextWidth('26029.46'),
    '轴宽必须容得下最宽刻度',
  );
  // 短标签仍走最小值：4 个中文字 = 48px，加 8px 间隙也小于 68
  assert.equal(axisWidthFor(['国防军工'], 68), 68);
  assert.equal(axisWidthFor(['0', '-2.1'], 48), 48);
  // 6 个中文字的指数名要比 4 个字宽
  assert.ok(axisWidthFor(['纳斯达克100'], 68) > 68);
  // 估算必须是纯函数（SSR 与客户端一致），且对同类字符单调
  assert.equal(estimateTextWidth('26029.46'), estimateTextWidth('26029.46'));
  assert.ok(estimateTextWidth('26029.46') > estimateTextWidth('6029.46'));
});
