'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-[720px] flex-col items-center justify-center px-6 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-amber-300/12 text-amber-300 ring-1 ring-amber-300/25">
          <AlertTriangle className="size-6" />
        </span>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          公开数据暂时不可用
        </h1>
        <p className="mt-3 max-w-md text-sm leading-6 text-slate-400">
          上游行情或新闻源本次没有返回可核验数据。本站不使用模拟数据补位，
          请稍后重试；若持续失败，说明对应数据源正在限流或维护。
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-[11px] text-slate-600">
            诊断编号 {error.digest}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          className="mt-8 inline-flex items-center gap-2 rounded-xl border border-cyan-300/25 bg-cyan-400/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/15"
        >
          <RotateCcw className="size-4" />
          重新获取
        </button>
      </div>
    </main>
  );
}
