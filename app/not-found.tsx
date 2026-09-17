import { sitePath } from '@/lib/site-path';
import { Compass, Radar } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[720px] flex-col items-center justify-center px-6 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-cyan-400/12 text-cyan-300 ring-1 ring-cyan-300/25">
          <Compass className="size-6" />
        </span>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          没有这个行业或指数
        </h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">
          请求的代码不在当前覆盖范围内。A 股为申万一级行业，
          美股为 11 个 GICS 行业代理，指数为国内外主流指数。
        </p>
        <a
          href={sitePath('/')}
          className="mt-8 inline-flex items-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/15"
        >
          <Radar className="size-4" />
          返回行业信息全景
        </a>
      </div>
    </main>
  );
}
