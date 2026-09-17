import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

if (!process.env.FORECAST_JOB_KEY || !process.env.MCP_API_KEY) throw new Error('Set FORECAST_JOB_KEY and MCP_API_KEY before production startup');
const port = process.env.PORT ?? '3000';
const env = { ...process.env, ANALYST_SQLITE_PATH: process.env.ANALYST_SQLITE_PATH ?? resolve('.data/analyst.sqlite'),
  FORECAST_JOB_KEY: process.env.FORECAST_JOB_KEY,
  FORECAST_SITE_URL: process.env.FORECAST_SITE_URL ?? 'http://127.0.0.1:' + port };
const server = spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'start', '--port', port], { env, stdio: 'inherit', windowsHide: true });
let scheduler;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  scheduler?.kill(); server.kill();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.on('exit', code => { stop(); process.exitCode = code ?? 1; });
for (let attempt = 0; attempt < 30 && !stopping; attempt++) {
  try {
    const response = await fetch(new URL('/api/forecasts', env.FORECAST_SITE_URL), { signal: AbortSignal.timeout(2000) });
    if (response.ok) {
      scheduler = spawn(process.execPath, ['--experimental-strip-types','scripts/forecast-scheduler.mjs'], { env, stdio: 'inherit', windowsHide: true });
      scheduler.on('exit', code => { if (!stopping) { console.error('Forecast scheduler exited:', code); stop(); process.exitCode = 1; } });
      break;
    }
  } catch { /* Server is starting. */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!scheduler && !stopping) { console.error('Persistent preview failed readiness.'); stop(); process.exitCode = 1; }
