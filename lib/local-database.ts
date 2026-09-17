import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/** Explicit opt-in durable SQLite for Node hosting; Cloudflare deployments keep D1. */
export function d1Adapter(sqlite: DatabaseSync): D1Database {
  const execute = (sql: string, values: SQLInputValue[]) => {
    const result = sqlite.prepare(sql).run(...values);
    return { results: [], success: true, meta: { changes: Number(result.changes) } };
  };
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...bound: SQLInputValue[]) => prepare(sql, bound),
    first: async (column?: string) => {
      const row = sqlite.prepare(sql).get(...values) ?? null;
      return column && row ? row[column] : row;
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...values), success: true, meta: {} }),
    execute: () => execute(sql, values),
    run: async () => execute(sql, values),
  });
  return {
    prepare,
    batch: async (statements: Array<ReturnType<typeof prepare>>) => {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
}

let databasePromise: Promise<D1Database> | null = null;
export function getLocalDatabase(filename: string) {
  if (!databasePromise) databasePromise = (async () => {
    const absolute = resolve(filename);
    await mkdir(dirname(absolute), { recursive: true });
    const moduleName = 'node:sqlite';
    const { DatabaseSync } = await import(/* @vite-ignore */ moduleName) as typeof import('node:sqlite');
    const sqlite = new DatabaseSync(absolute);
    sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    return d1Adapter(sqlite);
  })().catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}
