import { AccountError, getAccountStore, type AccountStore } from './accounts.ts';
function readToken(request: Request, cookieName: string) { return request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? ''; }
export async function handleAccountRequest(request: Request, route: string, supplied?: AccountStore) {
  const origin = request.headers.get('Origin');
  const expected = process.env.ACCOUNT_PUBLIC_ORIGIN ?? new URL(request.url).origin;
  const allowed = process.env.ACCOUNT_ALLOWED_ORIGIN;
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' });
  const crossOrigin = origin && origin === allowed;
  if (crossOrigin) { headers.set('Access-Control-Allow-Origin', origin); headers.set('Access-Control-Allow-Credentials', 'true'); }
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
  try {
    if (request.method === 'OPTIONS') {
      if (!origin || (origin !== expected && origin !== allowed)) throw new AccountError(403, '不允许的来源');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); headers.set('Access-Control-Allow-Headers', 'Content-Type');
      return new Response(null, { status: 204, headers });
    }
    if (request.method === 'POST' && (!origin || (origin !== expected && origin !== allowed))) throw new AccountError(403, '请求来源不匹配，请刷新页面');
    if (request.method === 'POST' && !request.headers.get('Content-Type')?.startsWith('application/json')) throw new AccountError(415, '请求需要 JSON');
    const store = supplied ?? await getAccountStore();
    if (!store.initialized()) throw new AccountError(503, '账号服务尚未启用');
    if (new URL(expected).protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(expected).hostname)) throw new AccountError(503, '账号服务需要 HTTPS');
    const cookieName = new URL(expected).protocol === 'https:' ? '__Host-analyst_session' : 'analyst_session';
    const token = readToken(request, cookieName);
    const actor = store.session(token);
    if (request.method === 'GET' && route === 'me') return json({ account: actor });
    if (request.method === 'GET' && route === 'admin') {
      if (!actor) throw new AccountError(401, '请先登录');
      const page = Math.max(1, Math.min(100_000, Math.floor(Number(new URL(request.url).searchParams.get('page')) || 1)));
      return json(store.dashboard(actor, page));
    }
    if (request.method !== 'POST') throw new AccountError(404, '接口不存在');
    const reader = request.body?.getReader();
    let raw = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) { await reader.cancel(); throw new AccountError(413, '请求过大'); }
        raw += decoder.decode(chunk.value, { stream: true });
      }
      raw += decoder.decode();
    }
    let input: Record<string, unknown>;
    try { input = JSON.parse(raw); } catch { throw new AccountError(400, '请求格式错误'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AccountError(400, '请求格式错误');
    const secure = new URL(expected).protocol === 'https:';
    const cookie = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=${crossOrigin ? 'None' : 'Lax'}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
    if (crossOrigin && !secure) throw new AccountError(503, '跨站账号服务需要 HTTPS');
    if (route === 'register') return json({ account: await store.register(input) }, 201);
    if (route === 'login') {
      const result = await store.login(input);
      if (token) store.logout(token);
      headers.set('Set-Cookie', cookie(result.token, 7 * 86400));
      return json({ account: result.account });
    }
    if (route === 'logout') { store.logout(token); headers.set('Set-Cookie', cookie('', 0)); return json({ ok: true }); }
    if (route === 'admin/update') {
      if (!actor) throw new AccountError(401, '请先登录');
      if (typeof input.id !== 'string' || !['USER','ADMIN'].includes(String(input.role)) || !['ACTIVE','DISABLED'].includes(String(input.status))) throw new AccountError(400, '无效用户或权限');
      store.update(actor, input.id, input.role as 'ADMIN' | 'USER', input.status as 'ACTIVE' | 'DISABLED');
      return json({ ok: true });
    }
    throw new AccountError(404, '接口不存在');
  } catch (error) {
    if (error instanceof AccountError) return json({ error: error.message }, error.status);
    console.error('[accounts] request failed');
    return json({ error: '账号服务暂时不可用' }, 503);
  }
}
