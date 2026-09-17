import { isMcpRequestAuthorized } from './mcp-auth.ts';

export async function authorizedForecastJob(request: Request) {
  let key = process.env.FORECAST_JOB_KEY;
  try {
    const workers = await import('cloudflare:workers');
    const value = (workers.env as unknown as Record<string, unknown>).FORECAST_JOB_KEY;
    if (typeof value === 'string' && value.length > 0) key = value;
  } catch { /* Node preview uses environment variables. */ }
  return isMcpRequestAuthorized(request, key);
}
