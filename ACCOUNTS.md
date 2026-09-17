# 账号注册、登录与管理后台

入口 /account/ 和 /admin/。普通用户仅查看本人账户；主账号及管理员可查看后台用户列表、数量、注册/登录时间、最近 50 条操作记录。仅主账号能授予/撤销管理员、启用/停用用户；主账号不能从接口创建、修改或降级。注册用户固定 USER，账户角色每次服务端请求重新核验。

## 当前托管限制

GitHub Pages 仅发布公开页面外壳，没有服务端账号数据库，因此账号服务未启用时页面禁用注册/登录并明确披露。不能用前端密码、localStorage 角色或公开 GitHub 分支替代账号服务。完整能力需要 Node 22.13+ 后端与独立持久磁盘；优先同域 HTTPS 访问。未使用旧服务器或额外云账号。

## 本地启用

1. 在运行环境设置 AUTH_SQLITE_PATH=.private/accounts.sqlite 和 ACCOUNT_PUBLIC_ORIGIN=http://localhost:3000。账号库不得等于 ANALYST_SQLITE_PATH；从版本管理、Docker 上下文与公开行情归档排除。
2. 私下设置 AUTH_OWNER_EMAIL、AUTH_OWNER_PASSWORD（12–128 字符）及可选 AUTH_OWNER_NAME，运行 npm run accounts:owner。只允许一个主账号，没有默认密码。创建后移除 AUTH_OWNER_PASSWORD。
3. npm run build，然后使用 npm run preview:persistent（本地）或已配置密钥的 npm run serve:persistent（生产）。本地构建不使用 scripts/build-pages.mjs，以免把静态站的 /sykk 前缀带入普通后端。
4. 主账号登录 /account/，进入 /admin/，给已注册用户授予管理员权限。权限或状态变更撤销该用户的全部会话。

## 生产

ACCOUNT_PUBLIC_ORIGIN 必须是真实 HTTPS 来源，如 https://example.com，不含路径。TLS 由反向代理终止；AUTH_SQLITE_PATH 放独立私有持久卷，限制文件访问和备份权限。多个实例不能各自使用孤立的 SQLite 文件；当前方案为单实例。可以部署完整 Node 站点，或以 NEXT_PUBLIC_ACCOUNT_API_URL 指向 HTTPS 后端，并将 ACCOUNT_ALLOWED_ORIGIN 设置为唯一允许的前端来源。跨站 Cookie 可能受浏览器第三方 Cookie 策略阻止，优先前后端同站部署。

密码使用带随机盐的 scrypt（N=32768、r=8、p=1）。7 天有效的随机会话令牌仅以 SHA-256 摘要存库，浏览器通过 HttpOnly/SameSite Cookie 接收；生产加 Secure，返回体不含令牌。所有写入检查 Origin 和 JSON 类型、限制 4KB 请求；登录/注册有持久限速，后台私有响应 no-store。日志不含密码和会话令牌。

目前不含邮箱验证、邮件找回密码或双因素验证；邮箱仅作登录名，不表示已验证其归属。尚未创建真实主账号或发布实际后端，不得宣称线上账号系统已可使用。
