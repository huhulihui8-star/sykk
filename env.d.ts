// Cloudflare Workers 运行时绑定的类型声明。
// 运行时 schema 的唯一真值在 lib/market-repository.ts 的 ensureSchema()，
// 这里只声明绑定，不再维护第二份表结构描述。
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
