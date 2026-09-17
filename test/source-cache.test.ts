import assert from 'node:assert/strict';
import test from 'node:test';
import { NewsSourceCache, SourceLimiter, canonicalSourceKey } from '../lib/source-cache.ts';

test('news cache reuses stable keys, refreshes at five minutes, and expires fallback at thirty', async () => {
  const cache = new NewsSourceCache();
  const now = Date.parse('2026-09-16T07:00:00Z');
  let calls = 0;
  const load = async () => { calls++; return 'first'; };
  await cache.read('https://news.example/feed?req_trace=1', load, now);
  const hit = await cache.read('https://news.example/feed?req_trace=2', load, now + 299_999);
  assert.equal(hit.diagnostic.status, 'CACHED');
  assert.equal(calls, 1);
  const failure = async (): Promise<string> => { calls++; throw new Error('HTTP 503'); };
  const stale = await cache.read('https://news.example/feed', failure, now + 300_000);
  assert.equal(stale.body, 'first');
  assert.equal(stale.diagnostic.status, 'STALE');
  assert.equal(stale.diagnostic.fetchedAt, new Date(now).toISOString());
  const backoff = await cache.read('https://news.example/feed', failure, now + 310_000);
  assert.equal(backoff.diagnostic.requests, 0);
  assert.equal(calls, 2);
  await assert.rejects(cache.read('https://news.example/feed', failure, now + 1_800_000));
});

test('failed cold sources back off without returning fabricated content', async () => {
  const cache = new NewsSourceCache();
  let calls = 0;
  const load = async (): Promise<string> => { calls++; throw new Error('down'); };
  await assert.rejects(cache.read('https://news.example/cold', load, 1_000_000));
  await assert.rejects(cache.read('https://news.example/cold', load, 1_010_000));
  assert.equal(calls, 1);
});

test('parallel readers share one request and fresh refresh replaces expired content', async () => {
  const cache = new NewsSourceCache();
  let resolve!: (value: string) => void;
  let calls = 0;
  const load = () => { calls++; return new Promise<string>(done => { resolve = done; }); };
  const first = cache.read('https://news.example/shared', load, 1_000_000);
  const second = cache.read('https://news.example/shared', load, 1_000_000);
  await new Promise<void>(done => setImmediate(done));
  resolve('body');
  assert.deepEqual((await Promise.all([first, second])).map(result => result.body), ['body','body']);
  assert.equal(calls, 1);
  assert.equal((await cache.read('https://news.example/shared', async () => 'new', 1_300_000)).body, 'new');
});

test('limiter admits at most the configured number of simultaneous requests', async () => {
  const limiter = new SourceLimiter(3);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 15 }, () => limiter.run(async () => {
    active++; peak = Math.max(active, peak);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
  })));
  assert.equal(peak, 3);
  assert.equal(canonicalSourceKey('https://news.example/feed?z=2&req_trace=123&a=1'), 'https://news.example/feed?a=1&z=2');
});
