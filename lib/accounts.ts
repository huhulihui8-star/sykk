import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type AccountRole = 'OWNER' | 'ADMIN' | 'USER';
export type Account = { id: string; email: string; displayName: string; role: AccountRole; status: 'ACTIVE' | 'DISABLED'; createdAt: string; lastLoginAt: string | null };
type AccountRow = Account & { passwordHash: string };
const derive = (password: string, salt: string, length: number) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, hash) => error ? reject(error) : resolve(hash))); 
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const id = () => randomBytes(24).toString('base64url');
const publicAccount = (row: AccountRow): Account => ({ id: row.id, email: row.email, displayName: row.displayName, role: row.role, status: row.status, createdAt: row.createdAt, lastLoginAt: row.lastLoginAt });
export class AccountError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function accountInput(input: unknown) {
  if (!input || typeof input !== 'object') throw new AccountError(400, '请输入账户信息');
  const value = input as Record<string, unknown>;
  const email = typeof value.email === 'string' ? value.email.trim().toLowerCase() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError(400, '请输入有效邮箱');
  if (password.length < 12 || password.length > 128) throw new AccountError(400, '密码需要 12–128 个字符');
  return { email, password, displayName: typeof value.displayName === 'string' ? value.displayName.trim().slice(0, 40) : '' };
}
async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64);
  return `scrypt-v1$${salt}$${hash.toString('hex')}`;
}
async function verifyPassword(password: string, encoded: string) {
  const [version, salt, expected] = encoded.split('$');
  if (version !== 'scrypt-v1' || !salt || !expected) return false;
  const hash = await derive(password, salt, 64);
  const bytes = Buffer.from(expected, 'hex');
  return bytes.length === hash.length && timingSafeEqual(bytes, hash);
}
const dummyHash = hashPassword(randomBytes(32).toString('hex'));

export class AccountStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, displayName TEXT NOT NULL, passwordHash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('OWNER','ADMIN','USER')), status TEXT NOT NULL CHECK(status IN ('ACTIVE','DISABLED')), createdAt TEXT NOT NULL, lastLoginAt TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_one_owner ON accounts(role) WHERE role='OWNER';
      CREATE TABLE IF NOT EXISTS account_sessions (tokenHash TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id), expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS account_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actorId TEXT, action TEXT NOT NULL, targetId TEXT, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expiresAt INTEGER NOT NULL);`);
  }
  private audit(action: string, actorId: string | null = null, targetId: string | null = null) {
    this.db.prepare('INSERT INTO account_audit(actorId,action,targetId,createdAt) VALUES(?,?,?,?)').run(actorId, action, targetId, new Date().toISOString());
  }
  private limit(key: string, max: number) {
    const now = Date.now();
    this.db.prepare('DELETE FROM account_limits WHERE expiresAt <= ?').run(now);
    this.db.prepare('INSERT INTO account_limits(key,attempts,expiresAt) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(digest(key), now + 15 * 60_000);
    const row = this.db.prepare('SELECT attempts FROM account_limits WHERE key=?').get(digest(key)) as { attempts: number };
    if (row.attempts > max) throw new AccountError(429, '尝试次数过多，请 15 分钟后重试');
  }
  initialized() { return !!this.db.prepare("SELECT id FROM accounts WHERE role='OWNER'").get(); }
  async createOwner(input: unknown) {
    if (this.initialized()) throw new AccountError(409, '主账号已存在');
    return this.create(accountInput(input), 'OWNER');
  }
  private async create(input: ReturnType<typeof accountInput>, role: AccountRole) {
    if (!input.displayName) throw new AccountError(400, '请输入昵称');
    const row: AccountRow = { id: id(), email: input.email, displayName: input.displayName, passwordHash: await hashPassword(input.password), role, status: 'ACTIVE', createdAt: new Date().toISOString(), lastLoginAt: null };
    try {
      this.db.prepare('INSERT INTO accounts(id,email,displayName,passwordHash,role,status,createdAt) VALUES(?,?,?,?,?,?,?)').run(row.id, row.email, row.displayName, row.passwordHash, row.role, row.status, row.createdAt);
    } catch (error) {
      if (/UNIQUE constraint/.test(String(error))) throw new AccountError(409, '无法创建该账户，请尝试登录或联系管理员');
      throw error;
    }
    this.audit('ACCOUNT_CREATED', row.id, row.id);
    return publicAccount(row);
  }
  async register(input: unknown) {
    if (!this.initialized()) throw new AccountError(503, '账号服务尚未启用');
    this.limit('register-global', 50);
    const value = accountInput(input);
    this.limit('register:' + value.email, 5);
    // Role and status from public registration are never accepted.
    return this.create(value, 'USER');
  }
  async login(input: unknown) {
    const value = accountInput(input);
    this.limit('login-global', 200);
    this.limit('login:' + value.email, 10);
    const row = this.db.prepare('SELECT * FROM accounts WHERE email=?').get(value.email) as AccountRow | undefined;
    const valid = await verifyPassword(value.password, row?.passwordHash ?? await dummyHash);
    if (!row || !valid || row.status !== 'ACTIVE') { this.audit('LOGIN_FAILED'); throw new AccountError(401, '邮箱或密码错误，或账户不可用'); }
    this.db.prepare('DELETE FROM account_limits WHERE key=?').run(digest('login:' + value.email));
    this.db.prepare('UPDATE accounts SET lastLoginAt=? WHERE id=?').run(new Date().toISOString(), row.id);
    this.audit('LOGIN_OK', row.id, row.id);
    const token = id();
    const expiresAt = Date.now() + 7 * 86_400_000;
    this.db.prepare('DELETE FROM account_sessions WHERE expiresAt <= ?').run(Date.now());
    this.db.prepare('INSERT INTO account_sessions(tokenHash,accountId,expiresAt) VALUES(?,?,?)').run(digest(token), row.id, expiresAt);
    return { account: this.session(token)!, token };
  }
  session(token: string) {
    if (!token || token.length > 100) return null;
    const row = this.db.prepare("SELECT a.* FROM accounts a JOIN account_sessions s ON a.id=s.accountId WHERE s.tokenHash=? AND s.expiresAt>? AND a.status='ACTIVE'").get(digest(token), Date.now()) as AccountRow | undefined;
    return row ? publicAccount(row) : null;
  }
  logout(token: string) { this.db.prepare('DELETE FROM account_sessions WHERE tokenHash=?').run(digest(token)); }
  dashboard(actor: Account, page = 1) {
    if (!['OWNER','ADMIN'].includes(actor.role)) throw new AccountError(403, '需要管理员权限');
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY createdAt DESC LIMIT 50 OFFSET ?').all((page - 1) * 50) as AccountRow[];
    const audit = this.db.prepare('SELECT id,actorId,action,targetId,createdAt FROM account_audit ORDER BY id DESC LIMIT 50').all();
    const roles = this.db.prepare('SELECT role,COUNT(*) AS count FROM accounts GROUP BY role').all();
    return { users: rows.map(publicAccount), total, page, pageSize: 50, roles, audit };
  }
  update(actor: Account, targetId: string, role: 'ADMIN' | 'USER', status: 'ACTIVE' | 'DISABLED') {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT role,status FROM accounts WHERE id=?').get(actor.id) as Account | undefined;
      const target = this.db.prepare('SELECT role FROM accounts WHERE id=?').get(targetId) as Account | undefined;
      if (current?.role !== 'OWNER' || current.status !== 'ACTIVE') throw new AccountError(403, '只有主账号可修改用户权限');
      if (!target) throw new AccountError(404, '用户不存在');
      if (target.role === 'OWNER') throw new AccountError(403, '主账号不能被降级或停用');
      this.db.prepare('UPDATE accounts SET role=?,status=? WHERE id=?').run(role, status, targetId);
      this.db.prepare('DELETE FROM account_sessions WHERE accountId=?').run(targetId);
      this.audit(`ACCOUNT_UPDATED:${role}:${status}`, actor.id, targetId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

let storePromise: Promise<AccountStore> | null = null;
export function getAccountStore() {
  if (!process.env.AUTH_SQLITE_PATH) throw new AccountError(503, '账号服务尚未启用');
  if (!storePromise) storePromise = (async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const filename = path.resolve(process.env.AUTH_SQLITE_PATH!);
    // Never put private account data in the public market archive.
    const marketFile = path.resolve(process.env.ANALYST_SQLITE_PATH ?? '.data/analyst.sqlite');
    const canonical = async (file: string) => { try { return await fs.realpath(file); } catch { return file; } };
    const accountFile = await canonical(filename), publicFile = await canonical(marketFile);
    if ((process.platform === 'win32' ? accountFile.toLowerCase() === publicFile.toLowerCase() : accountFile === publicFile)) throw new Error('Account database must be separate from market archive');
    try {
      const a = await fs.stat(filename), b = await fs.stat(marketFile);
      if (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev) throw new AccountError(503, '账号库必须独立保存');
    } catch (error) { if (error instanceof AccountError) throw error; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const name = 'node:sqlite';
    const { DatabaseSync } = await import(/* @vite-ignore */ name) as typeof import('node:sqlite');
    const db = new DatabaseSync(filename);
    if (process.platform !== 'win32') await fs.chmod(filename, 0o600);
    db.exec('PRAGMA journal_mode=WAL;');
    return new AccountStore(db);
  })().catch(error => { storePromise = null; throw error; });
  return storePromise;
}
