import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureWindow } from '../lib/forecast-store.ts';

const output = resolve('out');
const database = resolve('.data/analyst.sqlite');
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/sykk';
const origin = 'http://127.0.0.1:3011';
const key = randomUUID();
const env = { ...process.env, AUTH_SQLITE_PATH: '', AUTH_OWNER_PASSWORD: '', NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_STATIC_EXPORT: '1', ANALYST_SQLITE_PATH: database, FORECAST_JOB_KEY: key, MCP_API_KEY: randomUUID() };
await mkdir(resolve('.data'), { recursive: true });
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'start', '--host', '127.0.0.1', '--port', '3011'], { env, stdio: 'inherit', windowsHide: true });
const exited = new Promise(resolve => server.once('exit', resolve));
async function request(route, options = {}) {
  return fetch(origin + basePath + route, { ...options, signal: AbortSignal.timeout(180_000) });
}
async function save(route, file, expected = 200) {
  const response = await request(route);
  if (response.status !== expected) throw new Error(`${route}: HTTP ${response.status}`);
  const target = join(output, file);
  await mkdir(resolve(target, '..'), { recursive: true });
  await writeFile(target, await response.text());
}
async function job(code, mode) {
  const response = await request('/api/forecasts/capture', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ code, mode }) });
  if (!response.ok) throw new Error(`${code}/${mode}: HTTP ${response.status}`);
  console.log(JSON.stringify({ code, mode, ...(await response.json()) }));
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { ready = (await request('/api/forecasts')).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Export server failed readiness');
  const response = await request('/api/market?refresh=1');
  if (!response.ok) throw new Error(`Market generation failed: ${response.status}`);
  const snapshot = await response.json();
  const sectors = [...snapshot.sectors, ...snapshot.usSectors, ...snapshot.indexes];
  await writeFile(join(output, 'market.json'), JSON.stringify(snapshot));
  // Capture only within the verified close window; delayed Actions never backdate a forecast.
  for (const sector of sectors) {
    if (captureWindow(sector.code, new Date()).eligible) {
      try { await job(sector.code, 'evaluate'); await job(sector.code, 'capture'); }
      catch (error) { console.error('Forecast job:', error.message); }
    }
  }
  await save('/', 'index.html');
  await save('/evaluation', 'evaluation/index.html');
  await save('/account', 'account/index.html');
  await save('/admin', 'admin/index.html');
  await save('/sectors/UNKNOWN', '404.html', 404);
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < sectors.length) {
      const sector = sectors[next++];
      await save(`/sectors/${sector.code}`, `sectors/${sector.code}/index.html`);
      await save(`/api/sectors/${sector.code}`, `data/${sector.code}.json`);
    }
  }));
  await cp(resolve('dist/client', basePath.slice(1)), output, { recursive: true });
  await cp(resolve('public'), output, { recursive: true });
  await writeFile(join(output, '.nojekyll'), '');
  await writeFile(join(output, 'generation.json'), JSON.stringify({ generatedAt: new Date().toISOString(), evidenceUpdatedAt: snapshot.updatedAt, model: snapshot.methodology.modelVersion, coverage: snapshot.diagnostics?.coverage, sectors: sectors.length, hosting: 'GitHub Pages', intervalMinutes: 30 }));
  // Verify local assets referenced by exported HTML actually exist in the artifact.
  const html = await (await import('node:fs/promises')).readFile(join(output, 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1];
    if (!url.startsWith(basePath + '/_next/')) continue;
    await (await import('node:fs/promises')).access(join(output, url.slice(basePath.length).split('?')[0]));
  }
  console.log(`Exported ${sectors.length} real-data detail pages and dashboard.`);
} finally {
  server.kill();
  await exited;
  const db = new DatabaseSync(database);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}
