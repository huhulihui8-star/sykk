import { sitePath } from '@/lib/site-path';
import { forecastSummary } from '@/lib/forecast-store';
import { getMarketDatabase } from '@/lib/market-repository';

export const dynamic = 'force-dynamic';
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1)}%`;

export default async function EvaluationPage() {
  let summary;
  try { summary = await forecastSummary(await getMarketDatabase()); }
  catch { summary = null; }
  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 text-slate-200">
      <a href={sitePath('/')} className="text-sm text-cyan-300">返回市场看板</a>
      <h1 className="text-3xl font-semibold">分析效果评估</h1>
      <p className="text-base leading-7 text-slate-400">收盘后固定窗口保存当时的方向、评分与证据，再与下一交易日结果比较。零涨跌单独统计；只有相同历史代理口径的数据参与评估。</p>
      {!summary ? <output className="block">预测评估持久存储暂时不可用，无法读取留档结果。</output>
        : summary.groups.length === 0 ? <output className="block">尚无固定时点预测留档，暂时没有可评估样本。</output>
          : <div className="overflow-x-auto rounded-xl border border-white/10">
            <table className="w-full whitespace-nowrap text-left text-sm">
              <caption className="p-4 text-left">按市场和模型版本统计；基准为沿用当日涨跌方向，同样本命中率只比较基准有方向的记录。</caption>
              <thead className="bg-white/5"><tr>{['市场 / 模型','留档','预测涨 / 跌','已评估 / 零涨跌','有效样本','命中率','基准样本','同样本命中率','基准命中率'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead>
              <tbody>{summary.groups.map(group => <tr key={`${group.session}:${group.modelVersion}`} className="border-t border-white/10">
                <td className="p-3">{group.session} / {group.modelVersion}</td><td className="p-3">{group.archived}</td>
                <td className="p-3">{group.predictedUp} / {group.predictedDown}</td><td className="p-3">{group.evaluated} / {group.flat}</td>
                <td className="p-3">{group.validSamples}</td><td className="p-3">{percent(group.hitRate)}</td><td className="p-3">{group.baselineSamples}</td>
                <td className="p-3">{percent(group.comparableHitRate)}</td><td className="p-3">{percent(group.baselineHitRate)}</td>
              </tr>)}</tbody>
            </table>
          </div>}
      <p className="text-sm leading-6 text-slate-400">首批结果仅用于评估。命中率与涨跌信号占比都不代表真实概率，不承诺价格结果，也不自动调整模型权重。</p>
    </main>
  );
}
