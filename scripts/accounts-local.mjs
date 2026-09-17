import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AccountError, getAccountStore } from '../lib/accounts.ts';

const origin = 'http://127.0.0.1:3015';
const setupOrigin = 'http://127.0.0.1:3016';
process.env.AUTH_SQLITE_PATH ??= resolve('.private/accounts.sqlite');
process.env.ACCOUNT_PUBLIC_ORIGIN = origin;
process.env.ANALYST_SQLITE_PATH ??= resolve('.data/analyst.sqlite');
const env = { ...process.env, NEXT_PUBLIC_BASE_PATH: '', NEXT_PUBLIC_STATIC_EXPORT: '', NEXT_PUBLIC_ACCOUNT_API_URL: '', ACCOUNT_ALLOWED_ORIGIN: '', MCP_API_KEY: randomBytes(32).toString('hex'), FORECAST_JOB_KEY: randomBytes(32).toString('hex') };
// Build an ordinary local site; the Pages build uses a different public base path.
const build = spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'build'], { env, stdio: 'inherit', windowsHide: true });
const code = await new Promise(resolve => build.once('exit', resolve));
if (code !== 0) throw new Error('Local account build failed');
const store = await getAccountStore();
const server = spawn(process.execPath, ['node_modules/vinext/dist/cli.js', 'start', '--hostname', '127.0.0.1', '--port', '3015'], { env, stdio: 'inherit', windowsHide: true });
let setup;
function stop() { server.kill(); setup?.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.once('exit', code => { setup?.close(); process.exitCode = code ?? 1; });
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
if (!store.initialized()) {
  const secretPath = '/setup/' + randomBytes(32).toString('base64url');
  let attempts = 0;
  const began = Date.now();
  let submitting = false;
  const page = message => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>最强分析师 · 创建主账号</title><body><h1>创建本地主账号</h1><p>此页面仅在本机首次设置时开放。密码由你自行填写，不需要发送给任何人。</p><p>${escape(message)}</p><form method="post" action="${secretPath}"><p><label>昵称 <input name="displayName" required maxlength="40" value="主账号" autocomplete="off"></label></p><p><label>邮箱 <input name="email" type="email" required maxlength="254" autocomplete="username"></label></p><p><label>密码 <input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label></p><p>密码需要 12–128 个字符。邮箱作为登录名，暂不发送验证邮件。</p><button>创建主账号</button></form></body></html>`;
  setup = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.headers.host !== '127.0.0.1:3016' || request.url !== secretPath) { response.writeHead(404); response.end('404'); return; }
    if (Date.now() - began > 30 * 60_000) { response.writeHead(410); response.end('设置链接已过期，请重新启动本地系统。'); return; }
    if (store.initialized()) { response.writeHead(410); response.end('主账号已创建，请进入账户页登录。'); return; }
    if (request.method === 'GET') { response.end(page('')); return; }
    if (request.method !== 'POST' || request.headers.origin !== setupOrigin || !request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) { response.writeHead(403); response.end('请求来源不匹配'); return; }
    if (submitting || ++attempts > 10) { response.writeHead(429); response.end('请稍后重试或重新启动本地系统。'); return; }
    submitting = true;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 4096) throw new AccountError(413, '请求过大');
        chunks.push(chunk);
      }
      const data = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      await store.createOwner(data);
      response.writeHead(303, { Location: origin + '/account/' }); response.end();
      setup.close();
      console.log('Local owner created. Sign in at ' + origin + '/account/');
    } catch (error) {
      response.writeHead(error instanceof AccountError ? error.status : 503);
      response.end(page(error instanceof AccountError ? error.message : '设置暂时失败，请重试。'));
    } finally { submitting = false; }
  });
  await new Promise((resolve, reject) => { setup.once('error', reject); setup.listen(3016, '127.0.0.1', resolve); });
  console.log('LOCAL_OWNER_SETUP_URL=' + setupOrigin + secretPath);
}
console.log('Local account page: ' + origin + '/account/');
console.log('Local admin page: ' + origin + '/admin/');
