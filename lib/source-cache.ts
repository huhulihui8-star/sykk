import { AsyncLocalStorage } from 'node:async_hooks';

export type SourceDiagnostic = {
  source: string;
  kind: 'NEWS' | 'QUOTE';
  status: 'NETWORK' | 'CACHED' | 'STALE' | 'FAILED';
  fetchedAt: string | null;
  requests: number;
  durationMs: number;
  error: string | null;
};

const context = new AsyncLocalStorage<SourceDiagnostic[]>();
const cacheCalls = new WeakMap<SourceDiagnostic[], number>();
/** Workers Free has a separate 50-call Cache API budget. Reserve before match/put. */
export function reserveSourceCacheCall() {
  const current = context.getStore();
  if (!current) return true;
  const calls = cacheCalls.get(current) ?? 0;
  if (calls >= 50) return false;
  cacheCalls.set(current, calls + 1);
  return true;
}
export function withSourceDiagnostics<T>(load: () => Promise<T>) {
  const sources: SourceDiagnostic[] = [];
  return context.run(sources, async () => ({ value: await load(), sources }));
}

export function canonicalSourceKey(url: string) {
  const key = new URL(url);
  for (const field of ['req_trace', '_', 'callback']) key.searchParams.delete(field);
  key.searchParams.sort();
  return key.href;
}

type Entry = { at: number; body: string; failures: number; retryAt: number };
const FRESH_MS = 5 * 60_000;
const STALE_MS = 30 * 60_000;

/** Bounded per-source cache. Failed refreshes never extend the original timestamp. */
export class NewsSourceCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<{ body: string; diagnostic: SourceDiagnostic }>>();

  private store: () => Cache | null;
  constructor(store: () => Cache | null = () => null) { this.store = store; }

  async read(url: string, load: () => Promise<string>, now = Date.now()) {
    const key = canonicalSourceKey(url);
    const started = Date.now();
    const cacheUrl = `https://analyst-cache.invalid/news/${encodeURIComponent(key)}`;
    let cached = this.entries.get(key);
    if (!cached) {
      try {
        const store = this.store();
        const hit = store && reserveSourceCacheCall() ? await store.match(cacheUrl) : undefined;
        if (hit) {
          const entry = await hit.json() as Entry;
          if (Number.isFinite(entry.at) && typeof entry.body === 'string') {
            cached = entry;
            this.remember(key, entry);
          }
        }
      } catch { /* Cache API is optional. */ }
    }
    const age = cached ? now - cached.at : Infinity;
    const report = (status: SourceDiagnostic['status'], requests: number, error: string | null = null) => ({
      source: key, kind: 'NEWS' as const, status, requests, error,
      fetchedAt: cached && cached.at > 0 ? new Date(cached.at).toISOString() : null,
      durationMs: Date.now() - started,
    });
    if (cached && age >= 0 && age < FRESH_MS) {
      return { body: cached.body, diagnostic: report('CACHED', 0) };
    }
    if (cached && now < cached.retryAt) {
      if (cached.at > 0 && age >= 0 && age < STALE_MS) {
        return { body: cached.body, diagnostic: report('STALE', 0, '上游失败，退避期间复用缓存') };
      }
      const error = new Error('上游失败，退避期间暂无可用缓存');
      context.getStore()?.push(report('FAILED', 0, error.message));
      throw error;
    }
    const pending = this.pending.get(key);
    if (pending) {
      const result = await pending;
      return { ...result, diagnostic: { ...result.diagnostic, requests: 0 } };
    }
    const task = (async () => {
      try {
        const body = await load();
        cached = { at: now, body, failures: 0, retryAt: 0 };
        this.remember(key, cached);
        await this.persist(cacheUrl, cached);
        return { body, diagnostic: report('NETWORK', 1) };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        const failures = (cached?.failures ?? 0) + 1;
        const entry = { at: cached?.at ?? 0, body: cached?.body ?? '', failures,
          retryAt: now + Math.min(60_000 * 2 ** (failures - 1), FRESH_MS) };
        this.remember(key, entry);
        await this.persist(cacheUrl, entry);
        if (cached && cached.at > 0 && age >= 0 && age < STALE_MS) {
          return { body: cached.body, diagnostic: report('STALE', 1, message) };
        }
        context.getStore()?.push(report('FAILED', 1, message));
        throw error;
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, task);
    return task;
  }

  private remember(key: string, entry: Entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > 128) this.entries.delete(this.entries.keys().next().value!);
  }

  private async persist(url: string, entry: Entry) {
    try {
      const store = this.store();
      if (!store || !reserveSourceCacheCall()) return;
      await store.put(url, new Response(JSON.stringify(entry), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' },
      }));
    } catch { /* Memory cache still works. */ }
  }
}

function cacheStore() {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
}
const newsCache = new NewsSourceCache(cacheStore);

/** FIFO concurrency limit; timeout starts after admission, not while queued. */
export class SourceLimiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private limit: number;
  constructor(limit = 6) { this.limit = limit; }
  async run<T>(load: () => Promise<T>) {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.queue.push(resolve));
    else this.active++;
    try { return await load(); }
    finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}
const limiter = new SourceLimiter();

export async function readSourceBody(url: string, kind: 'NEWS' | 'QUOTE', load: () => Promise<string>) {
  if (kind === 'NEWS') {
    const result = await newsCache.read(url, () => limiter.run(load));
    context.getStore()?.push(result.diagnostic);
    return result.body;
  }
  const started = Date.now();
  try {
    const body = await limiter.run(load);
    context.getStore()?.push({ source: canonicalSourceKey(url), kind, status: 'NETWORK',
      fetchedAt: new Date().toISOString(), requests: 1, durationMs: Date.now() - started, error: null });
    return body;
  } catch (error) {
    context.getStore()?.push({ source: canonicalSourceKey(url), kind, status: 'FAILED',
      fetchedAt: null, requests: 1, durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown' });
    throw error;
  }
}
