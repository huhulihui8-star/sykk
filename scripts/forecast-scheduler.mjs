import { SECTORS, US_SECTORS, MARKET_INDEXES } from '../lib/market.ts';
import { captureWindow } from '../lib/forecast-store.ts';

// Existing Node hosting can run this alongside vinext. No cloud scheduler is assumed.
const origin = process.env.FORECAST_SITE_URL ?? 'http://localhost:3000';
const key = process.env.FORECAST_JOB_KEY;
const dryRun = process.argv.includes('--dry-run');
const once = process.argv.includes('--once');
if (!key && !dryRun) throw new Error('FORECAST_JOB_KEY is required');
const completed = new Map();
const definitions = [...SECTORS, ...US_SECTORS, ...MARKET_INDEXES];

async function request(code, mode) {
  const response = await fetch(new URL('/api/forecasts/capture', origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ code, mode }), signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${code}/${mode}`);
  return response.json();
}

let ticking = false;
async function tick() {
  if (ticking) return 0;
  ticking = true;
  try {
  const now = new Date();
  let failures = 0;
  for (const definition of definitions) {
    const window = captureWindow(definition.code, now);
    if (!window.eligible || completed.get(definition.code) === window.decisionDate) continue;
    if (dryRun) { console.log(JSON.stringify({ code: definition.code, ...window })); continue; }
    try {
      const evaluation = await request(definition.code, 'evaluate');
      const capture = await request(definition.code, 'capture');
      console.log(JSON.stringify({ at: new Date().toISOString(), code: definition.code, evaluation, capture }));
      if (capture.status === 'SAVED' || capture.status === 'EXISTS') completed.set(definition.code, window.decisionDate);
      else failures++;
    } catch (error) { failures++; console.error(error.message); }
  }
  return failures;
  } finally { ticking = false; }
}

if (once) process.exitCode = await tick() > 0 ? 1 : 0;
else {
  console.log('Forecast scheduler started; polling fixed close windows every 5 minutes.');
  await tick();
  setInterval(() => { void tick().catch(error => console.error(error.message)); }, 300_000);
}
