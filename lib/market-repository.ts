import { getLocalDatabase } from './local-database.ts';
import { FORECAST_SCHEMA } from './forecast-store.ts';
import {
  createMarketSnapshot,
  fetchHistoryFromProviders,
  snapshotCacheTtlMs,
  mergeCurrentBreadth,
  type MarketHistoryMeta,
  type MarketHistoryRow,
  type MarketSnapshot,
  type QuoteFreshness,
  type SectorSnapshot,
  historyFreshness,
  refreshSnapshotFreshness,
} from './market.ts';

let initialized = false;
let schemaPromise: Promise<void> | null = null;
let memorySnapshot: MarketSnapshot | null = null;
let refreshPromise: Promise<MarketSnapshot> | null = null;

export async function getBinding(): Promise<D1Database | null> {
  try {
    const workers = await import('cloudflare:workers');
    return workers.env.DB ?? null;
  } catch {
    if (process.env.ANALYST_SQLITE_PATH) return getLocalDatabase(process.env.ANALYST_SQLITE_PATH);
    return null;
  }
}

export async function getMarketDatabase() {
  const db = await getBinding();
  if (!db) throw new Error('持久数据库未绑定；预测留档不会退化为内存存储');
  await ensureSchema(db);
  return db;
}

/**
 * 运行时 schema 的唯一真值。
 *
 * 这里只创建应用真正读写的表；原实现还顺带建了 `sector_history`（早期版本遗留）
 * 和 `model_runs`（从未读写），已一并移除以避免"描述的表"与"实际用的表"长期漂移。
 * 全部语句都是 CREATE ... IF NOT EXISTS，不会修改或删除任何既有数据。
 */
async function ensureSchema(db: D1Database | null) {
  if (initialized || !db) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
  await db.batch([
    ...FORECAST_SCHEMA.map(sql => db.prepare(sql)),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS market_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_date TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, data_status TEXT NOT NULL, payload TEXT NOT NULL)',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_market_snapshots_updated_at ON market_snapshots(updated_at)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS sector_history_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, sector_code TEXT NOT NULL, trade_date TEXT NOT NULL, close REAL NOT NULL, change REAL NOT NULL, volume REAL NOT NULL, breadth REAL, quote_symbol TEXT NOT NULL, source TEXT NOT NULL, fetched_at TEXT NOT NULL, UNIQUE(sector_code, trade_date))',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_sector_history_cache_code_date ON sector_history_cache(sector_code, trade_date)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS news_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, published_at TEXT NOT NULL, tone TEXT NOT NULL, sectors TEXT NOT NULL, url TEXT NOT NULL)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS provider_health (provider_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, last_success_at TEXT, message TEXT NOT NULL, updated_at TEXT NOT NULL)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS refresh_locks (lock_name TEXT PRIMARY KEY, locked_until INTEGER NOT NULL, owner TEXT NOT NULL)',
    ),
  ]);
  initialized = true;
  })().catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}

/** 全市场都没取到行情时，只等 60 秒就重试，不占用完整的缓存周期。 */
export function cacheTtlMs(snapshot: MarketSnapshot, now = new Date()) {
  return snapshotCacheTtlMs(snapshot, now);
}

function isFresh(snapshot: MarketSnapshot, now = new Date()) {
  const age = now.getTime() - new Date(snapshot.updatedAt).getTime();
  return age >= 0 && age < cacheTtlMs(snapshot, now);
}

function isCompatible(snapshot: MarketSnapshot) {
  return Boolean(
    snapshot.freshness?.CN &&
    snapshot.freshness?.US &&
    snapshot.freshness?.INDEX &&
    Array.isArray(snapshot.providerStatus) &&
    snapshot.methodology?.modelVersion === 'provider-split-direction-share-v10' &&
    snapshot.diagnostics && snapshot.indexes.every(item => item.freshness.session) &&
    [...snapshot.sectors, ...snapshot.usSectors, ...snapshot.indexes].every(
      (sector) =>
        sector.freshness &&
        typeof sector.dataAvailable === 'boolean' &&
        typeof sector.volumeRatio === 'number' &&
        typeof sector.newsConfidence === 'number' &&
        (sector.momentum5d === null || typeof sector.momentum5d === 'number') &&
        (sector.nextSessionUpPct === null ||
          typeof sector.nextSessionUpPct === 'number') &&
        (sector.nextSessionDownPct === null ||
          typeof sector.nextSessionDownPct === 'number'),
    ),
  );
}

function staleMeta(meta: QuoteFreshness): QuoteFreshness {
  return { ...meta, delayLevel: 'STALE', dataStatus: 'STALE' };
}

function markStale(snapshot: MarketSnapshot): MarketSnapshot {
  return {
    ...snapshot,
    dataStatus: 'STALE',
    sectors: snapshot.sectors.map(item => ({ ...item, freshness: staleMeta(item.freshness) })),
    usSectors: snapshot.usSectors.map(item => ({ ...item, freshness: staleMeta(item.freshness) })),
    indexes: snapshot.indexes.map(item => ({ ...item, freshness: staleMeta(item.freshness) })),
    freshness: {
      CN: staleMeta(snapshot.freshness.CN),
      US: staleMeta(snapshot.freshness.US),
      INDEX: staleMeta(snapshot.freshness.INDEX),
    },
  };
}

function mergeRegionItems(
  current: SectorSnapshot[],
  previous: SectorSnapshot[],
  now: number,
) {
  const previousByCode = new Map(previous.map((item) => [item.code, item]));
  let fallbackCount = 0;
  const items = current.map((item) => {
    if (item.dataAvailable) return item;
    const cached = previousByCode.get(item.code);
    if (!cached?.dataAvailable) return item;
    const age = now - Date.parse(cached.freshness.quoteTime);
    if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60 * 1000) return item;
    fallbackCount += 1;
    return {
      ...cached,
      freshness: staleMeta(cached.freshness),
    };
  });
  return { items, fallbackCount };
}

function summarizeRegion(
  items: SectorSnapshot[],
  eventCount: number,
): MarketSnapshot['market'] {
  return {
    positive: items.filter((item) => item.informationTone === '积极').length,
    cautious: items.filter((item) => item.informationTone === '谨慎').length,
    eventCount,
  };
}

export function mergeSnapshotCoverage(
  current: MarketSnapshot,
  previous: MarketSnapshot,
  now = Date.now(),
): MarketSnapshot {
  const cn = mergeRegionItems(current.sectors, previous.sectors, now);
  const us = mergeRegionItems(current.usSectors, previous.usSectors, now);
  const indexes = mergeRegionItems(current.indexes, previous.indexes, now);
  const usedFallback =
    cn.fallbackCount + us.fallbackCount + indexes.fallbackCount > 0;
  if (!usedFallback) return current;
  return {
    ...current,
    dataStatus: 'STALE',
    sectors: cn.items,
    usSectors: us.items,
    indexes: indexes.items,
    market: summarizeRegion(cn.items, current.market.eventCount),
    usMarket: summarizeRegion(us.items, current.usMarket.eventCount),
    indexMarket: summarizeRegion(indexes.items, current.indexMarket.eventCount),
    freshness: {
      CN: cn.fallbackCount
        ? staleMeta(previous.freshness.CN)
        : current.freshness.CN,
      US: us.fallbackCount
        ? staleMeta(previous.freshness.US)
        : current.freshness.US,
      INDEX: indexes.fallbackCount
        ? staleMeta(previous.freshness.INDEX)
        : current.freshness.INDEX,
    },
  };
}

async function acquireRefreshLock(db: D1Database | null) {
  if (!db) return { acquired: true, owner: 'memory' };
  const owner = crypto.randomUUID();
  const now = Date.now();
  const result = await db
    .prepare(
      'INSERT INTO refresh_locks (lock_name, locked_until, owner) VALUES (?, ?, ?) ON CONFLICT(lock_name) DO UPDATE SET locked_until=excluded.locked_until, owner=excluded.owner WHERE refresh_locks.locked_until < ?',
    )
    .bind('market-snapshot', now + 90_000, owner, now)
    .run();
  return { acquired: Boolean(result.meta.changes), owner };
}

async function releaseRefreshLock(db: D1Database | null, owner: string) {
  if (!db || owner === 'memory') return;
  await db
    .prepare(
      'UPDATE refresh_locks SET locked_until = 0 WHERE lock_name = ? AND owner = ?',
    )
    .bind('market-snapshot', owner)
    .run();
}

async function persistSnapshot(
  db: D1Database | null,
  snapshot: MarketSnapshot,
) {
  if (!db) return;
  await db
    .prepare(
      'INSERT INTO market_snapshots (trade_date, updated_at, data_status, payload) VALUES (?, ?, ?, ?) ON CONFLICT(trade_date) DO UPDATE SET updated_at=excluded.updated_at, data_status=excluded.data_status, payload=excluded.payload',
    )
    .bind(
      snapshot.tradeDate,
      snapshot.updatedAt,
      snapshot.dataStatus,
      JSON.stringify(snapshot),
    )
    .run();
  const newsStatements = snapshot.events.map((event) =>
    db
      .prepare(
        'INSERT INTO news_events (id, title, source, published_at, tone, sectors, url) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, source=excluded.source, published_at=excluded.published_at, tone=excluded.tone, sectors=excluded.sectors, url=excluded.url',
      )
      .bind(
        event.id,
        event.title,
        event.source,
        event.publishedAt,
        event.tone,
        JSON.stringify(event.sectors),
        event.url,
      ),
  );
  const providerStatements = snapshot.providerStatus.map((provider) =>
    db
      .prepare(
        'INSERT INTO provider_health (provider_id, name, role, status, last_success_at, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET name=excluded.name, role=excluded.role, status=excluded.status, last_success_at=excluded.last_success_at, message=excluded.message, updated_at=excluded.updated_at',
      )
      .bind(
        provider.id,
        provider.name,
        provider.role,
        provider.status,
        provider.lastSuccessAt,
        provider.message,
        snapshot.updatedAt,
      ),
  );
  const statements = [...newsStatements, ...providerStatements];
  if (statements.length) await db.batch(statements);
}

let requestPromise: Promise<MarketSnapshot> | null = null;
export function getMarketSnapshot(force = false): Promise<MarketSnapshot> {
  if (requestPromise) return requestPromise;
  requestPromise = loadMarketSnapshot(force).then(snapshot => refreshSnapshotFreshness(snapshot)).finally(() => { requestPromise = null; });
  return requestPromise;
}

async function loadMarketSnapshot(
  force = false,
): Promise<MarketSnapshot> {
  if (!force && memorySnapshot && (process.env.NEXT_PUBLIC_STATIC_EXPORT === '1' || isFresh(memorySnapshot)))
    return memorySnapshot;
  if (refreshPromise) return refreshPromise;

  const db = await getBinding();
  let cached = memorySnapshot;
  try {
    await ensureSchema(db);
    if (db) {
      const row = await db
        .prepare(
          'SELECT payload FROM market_snapshots ORDER BY updated_at DESC LIMIT 1',
        )
        .first<{ payload: string }>();
      if (row?.payload) {
        const parsed = JSON.parse(row.payload) as MarketSnapshot;
        if (isCompatible(parsed)) {
          cached = parsed;
          memorySnapshot = parsed;
          if (!force && isFresh(parsed)) return parsed;
        }
      }
    }
  } catch {
    /* D1 remains optional during local preview. */
  }

  let lock = { acquired: true, owner: 'memory' };
  try {
    lock = await acquireRefreshLock(db);
  } catch {
    /* In-memory de-duplication still protects the current worker. */
  }
  if (!lock.acquired) {
    if (cached) return markStale(cached);
    throw new Error('快照刷新已在其他实例进行，暂时无可用缓存');
  }

  refreshPromise = (async () => {
    try {
      const created = await createMarketSnapshot();
      const next = cached ? mergeSnapshotCoverage(created, cached) : created;
      if (next.dataStatus === 'DEMO' && cached) return markStale(cached);
      memorySnapshot = next;
      try {
        await ensureSchema(db);
        await persistSnapshot(db, next);
      } catch {
        /* Live data is returned even when persistence is unavailable. */
      }
      return next;
    } catch (error) {
      if (cached) return markStale(cached);
      throw error;
    } finally {
      refreshPromise = null;
      try {
        await releaseRefreshLock(db, lock.owner);
      } catch {
        /* The lock expires automatically after 90 seconds. */
      }
    }
  })();
  return refreshPromise;
}

type CachedHistoryRow = MarketHistoryRow & {
  source: string;
  fetchedAt: string;
};

export type SectorHistoryResult = {
  rows: MarketHistoryRow[];
  meta: MarketHistoryMeta;
};

function historyMeta(
  rows: MarketHistoryRow[],
  status: MarketHistoryMeta['status'],
  source: string,
  updatedAt: string | null,
  sector: SectorSnapshot,
  message: string,
): MarketHistoryMeta {
  const breadthPoints = rows.filter(
    (row) => typeof row.breadth === 'number',
  ).length;
  const freshness = historyFreshness(sector.code, rows.at(-1)?.date);
  return {
    status: status === 'FRESH' && !freshness.fresh ? 'CACHED' : status,
    lastTradeDate: freshness.lastDate,
    expectedTradeDate: freshness.expectedDate,
    calendarCovered: freshness.calendarCovered,
    source,
    updatedAt,
    volumeAvailable: rows.some((row) => row.volume > 0),
    breadthStatus:
      breadthPoints >= 1
        ? 'AVAILABLE'
        : sector.code.startsWith('801')
          ? 'ACCUMULATING'
          : 'NOT_AVAILABLE',
    volumeDisclosure: source.includes('成交量代理')
      ? `指数点位使用原始代码，成交量使用 ${source.split('成交量代理 ')[1]} 代理。`
      : rows.some((row) => row.volume > 0)
        ? '成交量来自当前历史行情源。'
        : '当前原始指数源未提供可核验成交量。',
    message: !freshness.fresh && rows.length ? `${message} 末条交易日 ${freshness.lastDate}，预期至少 ${freshness.expectedDate}。${freshness.calendarCovered ? '' : '官方日历未覆盖，无法确认最新。'}` : message,
  };
}

async function readHistoryCache(
  db: D1Database | null,
  sectorCode: string,
  days: number,
) {
  if (!db) return [];
  const result = await db
    .prepare(
      'SELECT trade_date AS date, close, change, volume, breadth, source, fetched_at AS fetchedAt FROM sector_history_cache WHERE sector_code = ? ORDER BY trade_date DESC LIMIT ?',
    )
    .bind(sectorCode, days)
    .all<CachedHistoryRow>();
  return (result.results ?? []).reverse();
}

async function persistHistoryCache(
  db: D1Database | null,
  sector: SectorSnapshot,
  rows: MarketHistoryRow[],
  source: string,
  fetchedAt: string,
) {
  if (!db || !sector.quoteSymbol || !rows.length) return;
  const statements = rows.map((row) =>
    db
      .prepare(
        'INSERT INTO sector_history_cache (sector_code, trade_date, close, change, volume, breadth, quote_symbol, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sector_code, trade_date) DO UPDATE SET close=excluded.close, change=excluded.change, volume=excluded.volume, breadth=COALESCE(excluded.breadth, sector_history_cache.breadth), quote_symbol=excluded.quote_symbol, source=excluded.source, fetched_at=excluded.fetched_at',
      )
      .bind(
        sector.code,
        row.date,
        row.close,
        row.change,
        row.volume,
        row.breadth,
        sector.quoteSymbol,
        source,
        fetchedAt,
      ),
  );
  for (let index = 0; index < statements.length; index += 75) {
    await db.batch(statements.slice(index, index + 75));
  }
}

export async function getSectorHistory(
  sector: SectorSnapshot,
  days = 60,
): Promise<SectorHistoryResult> {
  const db = await getBinding();
  try {
    await ensureSchema(db);
  } catch {
    /* The live provider path remains available when D1 is unavailable. */
  }

  let cached: CachedHistoryRow[] = [];
  try {
    cached = await readHistoryCache(db, sector.code, days);
  } catch {
    /* A missing or migrating cache must not hide live history. */
  }
  const cachedAt = cached.at(-1)?.fetchedAt ?? null;
  const cachedAge = cachedAt
    ? Date.now() - new Date(cachedAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (cached.length && cachedAge >= 0 && cachedAge < 15 * 60 * 1000) {
    const cachedRows = cached.map(
      ({ source: _source, fetchedAt: _fetchedAt, ...row }) => row,
    );
    const rows = mergeCurrentBreadth(cachedRows, sector);
    return {
      rows,
      meta: historyMeta(
        rows,
        'FRESH',
        cached.at(-1)!.source,
        cachedAt,
        sector,
        '最近成功历史数据已缓存。',
      ),
    };
  }

  try {
    const fetched = await fetchHistoryFromProviders(sector, days);
    const rows = mergeCurrentBreadth(fetched.rows, sector);
    const fetchedAt = new Date().toISOString();
    try {
      await persistHistoryCache(db, sector, rows, fetched.source, fetchedAt);
    } catch {
      /* Live history is still returned if persistence fails. */
    }
    return {
      rows,
      meta: historyMeta(
        rows,
        'FRESH',
        fetched.source,
        fetchedAt,
        sector,
        '历史行情已从公开数据源更新。',
      ),
    };
  } catch {
    if (cached.length) {
      const cachedRows = cached.map(
        ({ source: _source, fetchedAt: _fetchedAt, ...row }) => row,
      );
      const rows = mergeCurrentBreadth(cachedRows, sector);
      return {
        rows,
        meta: historyMeta(
          rows,
          'CACHED',
          cached.at(-1)!.source,
          cachedAt,
          sector,
          '上游暂时不可用，正在展示最近一次成功缓存。',
        ),
      };
    }
    return {
      rows: [],
      meta: historyMeta(
        [],
        'UNAVAILABLE',
        '暂无可用历史行情源',
        null,
        sector,
        '上游历史行情暂时不可用，且尚无可回退缓存。',
      ),
    };
  }
}
