import { getAccountStore } from '../lib/accounts.ts';
if (!process.env.AUTH_SQLITE_PATH || !process.env.AUTH_OWNER_EMAIL || !process.env.AUTH_OWNER_PASSWORD) {
  throw new Error('Set AUTH_SQLITE_PATH, AUTH_OWNER_EMAIL and AUTH_OWNER_PASSWORD in your private runtime environment. No default owner password exists.');
}
await (await getAccountStore()).createOwner({ email: process.env.AUTH_OWNER_EMAIL, password: process.env.AUTH_OWNER_PASSWORD, displayName: process.env.AUTH_OWNER_NAME ?? '主账号' });
console.log('Owner created. Remove AUTH_OWNER_PASSWORD from your runtime environment.');
