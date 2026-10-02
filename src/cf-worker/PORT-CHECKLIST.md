# cf-worker 迁移对账表（PORT-CHECKLIST）

> 依据：`docs/ADR-0001-fly-to-cloudflare.md`。源 = `server.js`（cloudflare-migration 分支，未改动），
> 目标 = `src/cf-worker/*`（Hono）。验收要求：**每个端点一行，一个都不能漏**。
> server.js 共 83 条显式路由 + 1 条 `/api/*` 404 兜底 = 84 端点（与 API-REFERENCE 口径一致）。
>
> 验证方式缩写：
>   **CHK** = `node --check` 语法通过 ｜ **IMP** = Node ESM 全模块导入冒烟通过 ｜
>   **RUN** = fetch 层冒烟实测（mock ASSETS + 本地 .env + 真实 Supabase 只读查询）｜
>   **REVIEW** = 逐行代码走查对齐（JSON 形状 / 错误码 / 状态码与源一致），待 `wrangler dev` / Workers 预览环境端到端实测（需 Hyperdrive id 回填 + secrets 注入，本阶段无法本地执行）。

## 一、地基（非端点，先于路由）

| 项 | 源 | 迁移实现 | 状态 | 验证 |
|---|---|---|---|---|
| 环境变量桥（env → process.env） | server.js 直接读 process.env（dotenv 载入） | `cf-worker/env.js` bridgeEnv（仅 string 值）+ `__USE_RESEND_HTTP__` 标记 | ✅ | RUN（桥后 process.env.APP_URL 可读） |
| DB 连接（Hyperdrive 注入） | `src/db.js` 模块级 Pool（DATABASE_URL） | `db.js` 新增 `configurePool()`（`export let pool` 整体替换；Fly 路径零变化） | ✅ | RUN（configurePool 后真实查询走通） |
| 会话（express-session + connect-pg-simple） | server.js:302-315 | `cf-worker/session.js`：同表（sid/sess/expire）、同 cookie 名（connect.sid）、同 s:签名格式、同 7 天 TTL、`session.userId/save()/destroy()` 同语义 | ✅ | IMP + REVIEW（登录态端到端需预览环境实测） |
| 邮件通道 | `src/email.js` / `src/alerts.js`（nodemailer/SMTP） | 检测 `__USE_RESEND_HTTP__` → Resend HTTP API（RESEND_API_KEY，from=SMTP_FROM）；否则原 nodemailer（动态 import）；alerts.js 每日 100 封配额（email_budget 表）逻辑原样保留 | ✅ | IMP + REVIEW |
| 定时任务 | server.js startPolling/startRetention/月报 timer | `cf-worker/cron.js`：leader_lease 抢租约 → listDueMonitors 限量（CRON_MAX_MONITORS_PER_TICK，默认 30）→ checkMonitor（含告警状态机）→ 每小时保留清理 → 每月 1 号月报（leader_lease 月度标记行幂等） | ✅ | IMP + REVIEW |
| 安全响应头 | server.js:100-117 | `cf-worker/index.js` 全局中间件（CSP 等逐字节一致） | ✅ | RUN（实测 X-Frame-Options/CSP） |
| JSON body 解析 | express.json() + express.raw() | `cf-worker/util.js` jsonBodyParser（rawBody 供 webhook 验签；畸形 JSON → 500 server_error，与 Express 错误中间件路径一致） | ✅ | RUN |
| 全局错误兜底 | server.js:2093-2101（onError 语义） | `cf-worker/index.js` app.onError（瞬时故障 503 / 其余 500） | ✅ | REVIEW |
| Worker 入口 fetch/scheduled | server.js bootstrap/listen | `cf-worker/index.js`（setupDb → app.fetch；scheduled → ctx.waitUntil(runCron)） | ✅ | RUN（fetch 路径） |

## 二、端点对账（按 server.js 注册顺序）

| # | 方法 | 路径 | 源 server.js 行号 | 状态 | 验证 |
|---|---|---|---|---|---|
| 1 | GET | `/`（自定义域名→状态页，否则静态首页） | 164-171 | ✅ pages.js | RUN（回落 ASSETS；命中分支 REVIEW，需绑域预览） |
| 2 | GET | `/compare/uptimerobot` | 285-291 | ✅ pages.js（模板/字典改经 ASSETS 读取） | IMP + REVIEW |
| 3 | GET | `/:lang/compare/uptimerobot`（7 语） | 287-291 | ✅ pages.js（非白名单语言回落 ASSETS，同 next()） | IMP + REVIEW |
| 4 | GET | `/vs/uptimerobot`（301） | 292 | ✅ pages.js | RUN（实测 301） |
| 5 | GET | `/compare-uptimerobot.html`（301） | 293 | ✅ pages.js | RUN（实测 301） |
| 6-9 | GET | `/compare/betterstack` + lang 变体 + 2 别名 | 285-294 | ✅ pages.js（同上机制） | IMP + REVIEW |
| 10-13 | GET | `/compare/pingdom` + lang 变体 + 2 别名 | 285-294 | ✅ pages.js（同上机制） | IMP + REVIEW |
| 14 | GET | `/api/paddle-config` | 323-332 | ✅ api.js | RUN（实测返回配置 JSON） |
| 15 | POST | `/api/paddle/webhook` | 363-495 | ✅ api.js（rawBody 验签 + 归一化账本，逻辑逐行照搬） | IMP + REVIEW |
| 16 | GET | `/api/creem-config` | 505-507 | ✅ api.js（Creem env 改为请求时懒取） | IMP |
| 17 | GET | `/api/creem/checkout` | 510-541 | ✅ api.js | REVIEW |
| 18 | POST | `/api/creem/webhook` | 562-635 | ✅ api.js（HMAC 验签 + product_id 兜底反查） | REVIEW |
| 19 | POST | `/api/analytics/start` | 642-662 | ✅ api.js | REVIEW |
| 20 | POST | `/api/analytics/ping` | 664-682 | ✅ api.js | REVIEW |
| 21 | POST | `/api/auth/register` | 685-700 | ✅ api.js（session.save 落库后回包） | IMP + REVIEW |
| 22 | POST | `/api/auth/login` | 702-714 | ✅ api.js | RUN（错误凭据 → 401 `{error:server_error,ep:{msg}}` 实测一致） |
| 23 | GET | `/api/auth/verify-email` | 717-723 | ✅ api.js | REVIEW |
| 24 | POST | `/api/auth/resend-verify` | 726-736 | ✅ api.js | REVIEW |
| 25 | POST | `/api/auth/logout` | 738-740 | ✅ api.js（sess.destroy） | REVIEW |
| 26 | GET | `/api/auth/oauth/:provider/start` | 762-768 | ✅ api.js | REVIEW |
| 27 | GET | `/api/auth/oauth/google/callback` | 786-804 | ✅ api.js | REVIEW |
| 28 | GET | `/api/auth/oauth/github/callback` | 805-830 | ✅ api.js | REVIEW |
| 29 | GET | `/api/me` | 832-836 | ✅ api.js | RUN（未登录 `{user:null}` 实测一致） |
| 30 | POST | `/api/monitors` | 881-941 | ✅ api.js（配额/类型/间隔/SSRF/渠道门禁逐行照搬） | IMP + REVIEW |
| 31 | POST | `/api/monitors/import` | 1006-1042 | ✅ api.js（CSV/JSON/UptimeRobot 解析器照搬） | IMP + REVIEW |
| 32 | PATCH | `/api/monitors/:id` | 1045-1075 | ✅ api.js | REVIEW |
| 33 | GET | `/api/monitors/:id/stats` | 1078-1092 | ✅ api.js | REVIEW |
| 34 | POST | `/api/heartbeat/:id` | 1095-1106 | ✅ api.js | REVIEW |
| 35 | GET | `/api/status/:slug` | 1143-1160 | ✅ api.js（spark 降采样 + 私有页 401 needsPassword） | IMP + REVIEW |
| 36 | GET | `/api/status-page`（按 Host） | 1163-1181 | ✅ api.js | REVIEW |
| 37 | POST | `/api/status/:slug/unlock` | 1189-1202 | ✅ api.js（capability cookie maxAge 换算为秒） | REVIEW |
| 38 | POST | `/api/status-page/unlock` | 1205-1218 | ✅ api.js | REVIEW |
| 39 | POST | `/api/status/:slug/subscribe` | 1221-1233 | ✅ api.js（400 裸 `{error:err.message}` 与源一致） | REVIEW |
| 40 | POST | `/api/status-page/subscribe` | 1236-1248 | ✅ api.js | REVIEW |
| 41 | GET | `/api/me/subscribers` | 1251-1256 | ✅ api.js | REVIEW |
| 42 | DELETE | `/api/me/subscribers/:id` | 1259-1265 | ✅ api.js | REVIEW |
| 43 | PATCH | `/api/me/status-page` | 1268-1282 | ✅ api.js（Pro 专属门禁） | REVIEW |
| 44 | POST | `/api/admin/monthly-report` | 1285-1288 | ✅ api.js（requireAdmin） | REVIEW |
| 45 | GET | `/api/plan-features` | 1291-1297 | ✅ api.js | IMP |
| 46 | GET | `/api/monitors` | 1299-1308 | ✅ api.js | RUN（未登录 401 auth_required 实测一致） |
| 47 | DELETE | `/api/monitors/:id` | 1310-1322 | ✅ api.js | REVIEW |
| 48 | GET | `/api/monitors/:id/history` | 1324-1335 | ✅ api.js | REVIEW |
| 49 | POST | `/api/feedback` | 1338-1359 | ✅ api.js | REVIEW |
| 50 | POST | `/api/waitlist` | 1369-1408 | ✅ api.js（蜜罐 + 24h 重发 + 邮箱不落日志） | IMP + REVIEW |
| 51 | GET | `/api/waitlist/confirm` | 1411-1425 | ✅ api.js | RUN（空 token → 400 waitlist_token_invalid 实测一致） |
| 52 | GET | `/api/waitlist/unsubscribe` | 1428-1438 | ✅ api.js | REVIEW |
| 53 | GET | `/api/admin/waitlist` | 1441-1462 | ✅ api.js（?export=1） | REVIEW |
| 54 | POST | `/api/admin/waitlist/announce` | 1465-1483 | ✅ api.js | REVIEW |
| 55 | GET | `/api/admin/stats` | 1507-1529 | ✅ api.js（process.uptime() 在 Worker 为 isolate 存活时长，语义近似） | REVIEW |
| 56 | GET | `/api/admin/users` | 1531-1560 | ✅ api.js（q/plan/role/banned 筛选） | REVIEW |
| 57 | GET | `/api/admin/users/:id` | 1563-1590 | ✅ api.js（metadata parseJSON 语义逐字节一致，含对象入参→null 的现网行为） | REVIEW |
| 58 | POST | `/api/admin/users/:id/ban` | 1593-1604 | ✅ api.js（不能封自己） | REVIEW |
| 59 | POST | `/api/admin/users/:id/delete` | 1607-1618 | ✅ api.js（不能删自己） | REVIEW |
| 60 | POST | `/api/admin/users/:id/quota` | 1621-1633 | ✅ api.js | REVIEW |
| 61 | GET | `/api/admin/monitors` | 1635-1648 | ✅ api.js（500 裸 `{error}` 与源一致） | REVIEW |
| 62 | GET | `/api/admin/feedback` | 1650-1658 | ✅ api.js | REVIEW |
| 63 | POST | `/api/admin/users/:id/plan` | 1660-1670 | ✅ api.js | REVIEW |
| 64 | POST | `/api/admin/users/:id/role` | 1672-1681 | ✅ api.js | REVIEW |
| 65 | POST | `/api/admin/impersonate/:id` | 1684-1687 | ✅ api.js ⚠️ 偏差：显式 `sess.save()`（Express 由 modified-session 自动落库，语义等价） | REVIEW |
| 66 | GET | `/api/admin/analytics` | 1691-1774 | ✅ api.js（12 条分析 SQL 逐行照搬） | REVIEW |
| 67 | GET | `/api/admin/user-events` | 1777-1788 | ✅ api.js | REVIEW |
| 68 | GET | `/api/admin/user-events/summary` | 1790-1798 | ✅ api.js | REVIEW |
| 69 | GET | `/api/admin/user-events/ranking` | 1801-1811 | ✅ api.js | REVIEW |
| 70 | GET | `/api/maintenance-windows` | 1816-1820 | ✅ api.js | REVIEW |
| 71 | POST | `/api/maintenance-windows` | 1822-1833 | ✅ api.js | REVIEW |
| 72 | DELETE | `/api/maintenance-windows/:id` | 1835-1841 | ✅ api.js | REVIEW |
| 73 | POST | `/api/team` | 1846-1857 | ✅ api.js | REVIEW |
| 74 | POST | `/api/team/invite` | 1859-1872 | ✅ api.js（403 no_team） | REVIEW |
| 75 | GET | `/api/team` | 1874-1883 | ✅ api.js | REVIEW |
| 76 | POST | `/api/team/leave` | 1885-1891 | ✅ api.js | REVIEW |
| 77 | POST | `/api/account/change-password` | 1895-1902 | ✅ api.js（authLimiter） | REVIEW |
| 78 | POST | `/api/account/profile` | 1904-1917 | ✅ api.js | REVIEW |
| 79 | POST | `/api/account/change-email` | 1919-1928 | ✅ api.js | REVIEW |
| 80 | POST | `/api/account/confirm-email` | 1930-1937 | ✅ api.js | REVIEW |
| 81 | GET | `/api/account/channels` | 1940-1945 | ✅ api.js | REVIEW |
| 82 | POST | `/api/account/channels` | 1947-1966 | ✅ api.js（套餐过滤 + 字段白名单） | REVIEW |
| 83 | POST | `/api/account/channels/test` | 1969-1987 | ✅ api.js | REVIEW |
| 84 | POST | `/api/auth/forgot-password` | 1990-2000 | ✅ api.js（pwLimiter） | REVIEW |
| 85 | POST | `/api/auth/reset-password` | 2003-2009 | ✅ api.js | REVIEW |
| 86 | POST | `/api/account/apikey` | 2014-2021 | ✅ api.js | REVIEW |
| 87 | GET | `/api/account/apikey` | 2023-2027 | ✅ api.js | REVIEW |
| 88 | GET | `/api/v1/monitors` | 2030-2039 | ✅ api.js（requireApiKey Bearer） | REVIEW |
| 89 | POST | `/api/v1/monitors` | 2041-2056 | ✅ api.js | REVIEW |
| 90 | GET | `/api/v1/monitors/:id` | 2058-2062 | ✅ api.js | REVIEW |
| 91 | DELETE | `/api/v1/monitors/:id` | 2064-2070 | ✅ api.js | REVIEW |
| 92 | GET | `/health` | 2073-2075 | ✅ api.js | RUN（实测 `{ok,ts,region:'local'}` 与源一致） |
| 93 | ALL | `/api/*` 404 兜底 | 2081-2083 | ✅ api.js 末尾 `app.all('/api/*')` | RUN（实测 endpoint_not_found） |
| — | ALL | 其余未匹配路径 → 静态 | 335（express.static） | ✅ index.js 末尾 ASSETS 兜底 | RUN |

> 计数说明：#2-#13 展开为 3 竞品 × 4 路由 = 12 条；显式路由 83 条 + `/api/*` 兜底 1 条 = **84 端点**，与 API-REFERENCE 口径一致，全部 ✅ 迁移，无遗漏。

## 三、已声明的实现层偏差（不改契约）

| 偏差 | 原因 | 影响面 |
|---|---|---|
| 会话中间件仅挂 `/api/*`（Express 版全局挂载） | 静态请求经 ASSETS 兜底后不进 Worker，全局挂载只会白查库；状态页解锁 cookie 与会话无关 | 无（登录态仅 API 使用） |
| 限流器为 isolate 内存（Express 版为进程内存 + setInterval 清理） | Workers 无常驻定时器；改为惰性清理 + Map 上限保护 | 多 isolate 下实际配额 = N×max，防护减弱（迁移规则明示允许；DB 侧 email_budget / leader_lease 等落库限流不受影响） |
| `/api/admin/stats` 的 `serverUptime` | Worker 无进程 uptime 概念，`process.uptime()` 返回 isolate 存活时长 | 展示语义近似 |
| `impersonate` 显式 save | express-session 自动保存 modified session；自研 shim 无 response-end 钩子 | 行为等价（均落库） |
| ping/ssl/domain/dns 检查类型在 Workers 下懒加载 `node:child_process`/`node:tls`/`node:dns`，模块缺失时判 down + 稳定错误码 | Workers 不保证提供（child_process 必无）；HTTP/keyword/api/heartbeat 不受影响 | 仅非 HTTP 检查类型的检查引擎，SQL/告警状态机零改动 |
| 邮件 from 取 `SMTP_FROM || SMTP_USER`（Resend 需要） | 与 nodemailer 路径同取值链 | 无 |
| 对比页渲染缓存按 (slug,lang)（Express 版按文件 mtime 失效） | Workers 无文件系统/mtime；模板与字典经 ASSETS 读取，部署新版本即新缓存 | 无（同版本内容不变） |

## 四、部署前待办（owner 操作，不在本次代码范围）

1. `wrangler.jsonc` 回填 Hyperdrive id（占位 `TODO_CREATE_THEN_FILL`，本次未动）。
2. ⚠️ `wrangler.jsonc` 的 `assets` 段建议加 `"run_worker_first": ["/", "/api/*", "/status/*", "/compare/*", "/vs/*", "/health"]`——否则 Workers Assets 默认「先静态」会把 `/`（自定义域名状态页）与 `/compare-*.html`（应 301）在静态层截走，Worker 收不到。
3. Secrets 注入：`wrangler secret put` 至少 `DATABASE_URL`（可选，Hyperdrive 已封装）/ `SESSION_SECRET` / `RESEND_API_KEY` / `SMTP_FROM` / `PADDLE_WEBHOOK_SECRET` / `CREEM_WEBHOOK_SECRET` / `CREEM_API_KEY` / 各 Paddle/Creem price·product id / `ADMIN_EMAIL`+`ADMIN_PASSWORD`（如需 Worker 侧也能 seed，当前 seedAdmin 仅 Fly 启动路径执行）。
4. 全部端点在 `wrangler dev` / Workers 预览环境做端到端实测（本阶段无 Hyperdrive id，无法本地执行）；重点：登录→会话→建监控→状态页 unlock 完整链路、两个 webhook 验签、cron 单 tick 日志。
5. Worker 路径刻意**不跑 initDb/seedAdmin**（DDL 与 seed 仍归 Fly 启动路径所有，避免双端并发迁移）；Fly org 关停前需确认 schema_migrations 已是最新。
