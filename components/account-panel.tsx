'use client';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { sitePath } from '@/lib/site-path';
import type { Account } from '@/lib/accounts';
type Dashboard = { users: Account[]; total: number; page: number; pageSize: number; audit: Array<{ id: number; action: string; actorId: string | null; targetId: string | null; createdAt: string }> };
const roleNames = { OWNER: '主账号', ADMIN: '管理员', USER: '普通用户' };
async function api<T = { account: Account | null }>(route: string, input?: unknown) {
  const base = (process.env.NEXT_PUBLIC_ACCOUNT_API_URL ?? '').replace(/\/$/, '');
  const endpoint = base ? base + '/api/accounts/' + route : sitePath('/api/accounts/' + route);
  const response = await fetch(endpoint, { credentials: 'include', cache: 'no-store', ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }) });
  if (!(response.headers.get('Content-Type') ?? '').includes('application/json')) throw new Error('账号服务尚未启用');
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? '操作失败');
  return data;
}
const inputClass = 'w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-slate-100';
const buttonClass = 'rounded-lg bg-cyan-300 px-4 py-2 font-medium text-slate-950 disabled:opacity-40';
export function AccountPanel({ admin = false }: { admin?: boolean }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => {
    let active = true;
    api('me').then(data => { if (active) { setAccount(data.account); setAvailable(true); } })
      .catch(error => { if (active) setMessage(error instanceof Error ? error.message : '账号服务暂时不可用'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let active = true;
    if (admin && account && account.role !== 'USER') {
      api<Dashboard>('admin?page=' + page).then(data => { if (active) setDashboard(data); })
        .catch(error => { if (active) { setDashboard(null); setMessage(error instanceof Error ? error.message : '读取失败'); } });
    }
    return () => { active = false; };
  }, [admin, account, page]);
  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !available) return;
    setBusy(true); setMessage('');
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      if (register) { await api('register', values); setRegister(false); setMessage('注册成功，请登录。'); form.reset(); }
      else { const data = await api('login', values); setAccount(data.account); form.reset(); }
    } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true);
    try { await api('logout', {}); setAccount(null); setDashboard(null); setMessage('已退出登录'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '退出失败'); }
    finally { setBusy(false); }
  }
  async function update(user: Account, role = user.role, status = user.status) {
    if (busy || role === 'OWNER') return;
    setBusy(true); setMessage('');
    try {
      await api('admin/update', { id: user.id, role, status });
      setDashboard(await api('admin?page=' + page));
      setMessage('用户权限已更新，该用户需要重新登录。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '修改失败'); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-6xl space-y-6 px-4 py-10 text-slate-200">
    <div className="flex flex-wrap items-center justify-between gap-4"><a href={sitePath('/')} className="text-cyan-300">返回市场看板</a><a href={sitePath(admin ? '/account/' : '/admin/')} className="text-cyan-300">{admin ? '我的账户' : '管理后台'}</a></div>
    <h1 className="text-3xl font-semibold">{admin ? '账号管理后台' : '我的账户'}</h1>
    {message && <output className="rounded-lg border border-white/10 bg-slate-900 p-4 block">{message}</output>}
    {loading ? <p>正在连接账号服务…</p> : !available ? <p className="text-slate-400">账号服务尚未启用，暂时无法注册、登录或查看后台。</p> : !account ? <section className="max-w-md rounded-xl border border-white/10 bg-slate-900 p-6">
      <h2 className="mb-4 text-xl">{register ? '注册账号' : '登录账号'}</h2>
      <form onSubmit={submit} className="space-y-4">
        {register && <label className="block space-y-2"><span>昵称</span><input name="displayName" autoComplete="off" required maxLength={40} className={inputClass}/></label>}
        <label className="block space-y-2"><span>邮箱</span><input name="email" type="email" autoComplete="username" required maxLength={254} className={inputClass}/></label>
        <label className="block space-y-2"><span>密码</span><input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} className={inputClass}/><small className="text-slate-400">12–128 个字符</small></label>
        <button disabled={busy} className={buttonClass}>{busy ? '正在处理…' : register ? '注册' : '登录'}</button>
      </form><button disabled={busy} onClick={() => { setRegister(!register); setMessage(''); }} className="mt-4 text-cyan-300">{register ? '已有账号，去登录' : '没有账号，去注册'}</button>
    </section> : <>
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-white/10 bg-slate-900 p-6"><div><p className="text-xl">{account.displayName} · {roleNames[account.role]}</p><p className="mt-2 text-slate-400">{account.email}</p></div><button onClick={logout} disabled={busy} className={buttonClass}>退出登录</button></section>
      {admin && account.role === 'USER' ? <p role="alert">当前账户没有管理后台访问权限。</p> : admin && dashboard ? <>
        <div className="flex flex-wrap items-center justify-between gap-4"><h2 className="text-xl">用户列表 · 共 {dashboard.total} 人</h2><p className="text-sm text-slate-400">{account.role === 'OWNER' ? '主账号可授予管理员权限或停用用户' : '管理员可查看用户及登录记录'}</p></div>
        <div className="overflow-x-auto rounded-xl border border-white/10"><table className="w-full whitespace-nowrap text-left text-sm"><thead className="bg-white/5"><tr>{['昵称 / 邮箱','权限','状态','注册时间','最近登录',...(account.role === 'OWNER' ? ['操作'] : [])].map(label => <th className="p-3" key={label}>{label}</th>)}</tr></thead><tbody>{dashboard.users.map(user => <tr key={user.id} className="border-t border-white/10"><td className="p-3">{user.displayName}<br/><span className="text-slate-400">{user.email}</span></td><td className="p-3">{roleNames[user.role]}</td><td className="p-3">{user.status === 'ACTIVE' ? '正常' : '停用'}</td><td className="p-3">{new Date(user.createdAt).toLocaleString('zh-CN')}</td><td className="p-3">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString('zh-CN') : '尚未登录'}</td>{account.role === 'OWNER' && <td className="space-x-3 p-3">{user.role !== 'OWNER' && <><button disabled={busy} onClick={() => update(user, user.role === 'ADMIN' ? 'USER' : 'ADMIN')} className="text-cyan-300">{user.role === 'ADMIN' ? '取消管理员' : '设为管理员'}</button><button disabled={busy} onClick={() => update(user, user.role, user.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')} className="text-cyan-300">{user.status === 'ACTIVE' ? '停用' : '启用'}</button></>}</td>}</tr>)}</tbody></table></div>
        <div className="flex items-center gap-4"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40">上一页</button><span>第 {page} 页</span><button disabled={page * 50 >= dashboard.total} onClick={() => setPage(page + 1)} className="disabled:opacity-40">下一页</button></div>
        <h2 className="text-xl">最近操作与登录记录</h2><ul className="space-y-2 text-sm text-slate-400">{dashboard.audit.map(item => <li key={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {({ LOGIN_OK: '登录成功', LOGIN_FAILED: '登录失败', ACCOUNT_CREATED: '账号创建' } as Record<string,string>)[item.action] ?? '用户权限更新'} · {item.actorId ? dashboard.users.find(user => user.id === item.actorId)?.displayName ?? '用户' : '未登录'} </li>)}</ul>
      </> : admin && account.role !== 'USER' ? <p>正在读取后台数据…</p> : <p className="text-slate-400">注册时间：{new Date(account.createdAt).toLocaleString('zh-CN')}{account.role !== 'USER' && <> · <a href={sitePath('/admin/')} className="text-cyan-300">进入管理后台</a></>}</p>}
    </>}
  </main>;
}
