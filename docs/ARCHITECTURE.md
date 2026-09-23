# Pingory · 架构说明（ARCHITECTURE.md）

> 描述各模块职责、数据流、依赖关系（**实现层视图**；"为什么选这些技术"见方案层 `TECH-SELECTION.md`）。
>
> **版本**：v2.0（2026-09-04 对齐线上 v30：9 表全列、补 OAuth/推荐码/导入/团队/订阅者/维护窗口/i18n/支付）
> **最后更新**：2026-09-04
> **关联代码**：`server.js`（入口，~1221 行，57 路由）、`src/`（6 业务模块 + worker）、`public/`（5 前端页面 + i18n 8 语）
> **关联文档**：PRD.md（业务/页面/支付逻辑）/ API-REFERENCE.md（接口契约）/ TECH-SELECTION.md（技术选型论证）

---

## 1. 整体架构图

```
┌────────────────────────────────────────────────────────────┐
│              前端 (public/ · 原生 HTML+JS 零构建)            │
│  index.html(落地页+仪表盘一体) · signin · signup · admin     │
│  status.html(公开状态页) · i18n/*.json(8 语)                 │
│  [Paddle.js v2 仅落地页加载]                                 │
└─────────┬─────────────────────────────┬─────────────────────┘
          │ HTTP + Cookie Session       │ 公开访问
          │ (um_sid, connect-pg-simple) │ (状态页 / Paddle.js / feedback)
┌─────────▼─────────────────────────────▼─────────────────────┐
│            server.js (Express 入口 · ~1221 行 · 57 路由)      │
│  静态服务 │ Session 中间件 │ 安全响应头 │ 内存限流(登录/反馈)  │
│                                                              │
│  /api/auth/*      register / login / logout / verify-email /  │
│                   resend-verify / oauth/:provider(google|github)│
│  /api/me          用户信息 / status-page                       │
│                   (开关/域名/白标/密码) / subscribers(订阅者)  │
│  /api/monitors    CRUD + import + stats + history             │
│  /api/heartbeat/:id  心跳回填(无需登录)                       │
│  /api/maintenance-windows  CRUD(维护窗口)                     │
│  /api/status/:slug  公开状态页数据+HTML / subscribe / unlock   │
│  /api/status-page  自定义域名状态页(Host 解析)                 │
│  /api/team         团队(建/邀/查/退)                          │
│  /api/account/apikey  Account API Key                         │
│  /api/v1/monitors  API Key 鉴权(Bearer)                       │
│  /api/plan-features /api/feedback                             │
│  /api/admin/*      stats/users/monitors/feedback/plan/role/   │
│                    ban/delete/quota/impersonate/monthly-report│
│  /api/paddle-config /api/paddle/webhook /health               │
└───┬──────────┬──────────┬────────────┬──────────────┬────────┘
    │          │          │            │              │
    ▼          ▼          ▼            ▼              ▼
┌────────┐ ┌─────────┐ ┌────────┐ ┌──────────┐ ┌──────────────┐
│src/auth│ │monitors │ │ alerts │ │  email   │ │  plans.js    │
│注册登录 │ │9类检查器 │ │告警状态机│ │SMTP封装  │ │PLAN_LIMITS   │
│scrypt  │ │轮询+多区 │ │7渠道+订 │ │验证邮件  │ │类型/渠道/旗标 │
│session │ │inFlight锁│ │阅者通知 │ │反馈通知  │ │MIN_INTERVAL  │
│OAuth   │ │runCheck │ │维护窗口 │ │          │ │单一源(门禁)  │
│status  │ │         │ │月报     │ │          │ │              │
│页设置  │ │         │ │        │ │          │ │              │
└───┬────┘ └──┬──┬───┘ └───┬────┘ └────┬─────┘ └──────┬───────┘
    │         │  │         │           │              │
    │   探测委托(PROBE_SECRET)          │              │
    │         │  └──► src/worker.js(多区域探针·独立部署)  │
    │         │              │          │              │
    └─────────┼──────────────┼──────────┼──────────────┘
              ▼              ▼          ▼
      ┌───────────────────────────────────────────────┐
      │    src/db.js (pg Pool · initDb 幂等迁移 ·       │
      │    startKeepAlive 每 4min SELECT 1 防休眠)      │
      │    Supabase Session Pooler (Postgres, ap-northeast-1)           │
      │    users · monitors · monitor_events           │
      │    monitor_checks · feedback · referrals        │
      │    teams · status_subscribers                   │
      │    maintenance_windows                          │
      └───────────────────────────────────────────────┘
```

> ⚠️ v2.0 修正：早期 v1.1 架构图为设计期草图（含 G7-G11 未落地项）。v2.0 以线上 v30 实际代码为准；前端为「落地页+仪表盘一体」单页（非多页分离），DB 实为 9 表，已补 OAuth/推荐码/导入/团队/订阅者/维护窗口/i18n/支付 模块。

---

## 2. 模块职责

### `server.js`（入口，~2107 行，86 路由）
- Express 应用初始化（静态服务、JSON body、Session(connect-pg-simple 落库)、安全中间件）
- Paddle SDK 实例化（sandbox/live 切换）+ 手动 HMAC 验签 webhook
- 路由注册：auth（注册/登录/登出/邮箱验证/OAuth google+github）/ me（信息/状态页/订阅者）/ monitors（CRUD/import/stats/history）/ heartbeat / maintenance-windows / status(公开+解锁+订阅) / team / account-apikey / v1(Bearer) / plan-features / feedback / admin* / paddle-config / paddle-webhook / health
- 套餐门禁在路由层校验：`PLAN_LIMITS`（配额）、`planHasType`（检查类型）、`planHasChannel`（渠道）、`planHasStatusPage` / `planHasStats`（状态页/趋势图）、`planMinInterval`（最低间隔）
- 启动：`seedAdmin()`（ADMIN_EMAIL/PASSWORD 建超管）+ `initDb()` + `startKeepAlive()` + `initAlerts()` + `startPolling()` + `startRetention()`（数据保留清理，复用 leader 租约）+ 月度报告 setInterval
- 异常兜底三层收口（2026-09-23 P0-2）：`wrap()` 包装全部路由 handler + 4 参数全局错误中间件 + 进程级 `unhandledRejection`/`uncaughtException`（记录完整堆栈后退出）；详见 `docs/API-REFERENCE.md` 的 5xx 语义
- 邮箱未验证账号监控数压至 `EMAIL_VERIFY_MONITOR_CAP=3`（防薅）

### `src/plans.js`（套餐能力矩阵，~84 行 · 单一源）
- `PLAN_LIMITS`：free 50 / starter 100 / pro ∞（v2.0 确认：非早期 20/50）
- `PLAN_MIN_INTERVAL`：free 300s / starter 60s / pro 30s
- `TYPES` / `CHANNELS` / `FLAGS`（statusPage / multiRegion / stats）+ `EMAIL_VERIFY_MONITOR_CAP`
- 导出 `planFeatures / planHasType / planHasChannel / planHasStatusPage / planHasStats / planMinInterval`
- `TYPE_LABELS` / `CHANNEL_LABELS`（前端展示英文名；zh 由 i18n 镜像）
- dev_gate 机检：除本文件外任何文件定义 `PLAN_LIMITS` 即拦截

### `src/auth.js`（认证，~461 行）
- `hashPassword(password)` → scrypt；`verifyPassword` 比对
- `registerUser` / `loginUser` / `logout` / `getUserById` / `getUserByEmail` / `updatePlan`
- 邮箱验证：`verifyEmail(token)` / `resendVerify`（email_verified / verify_token / verify_expires）
- OAuth：google + github start/callback（未配凭据优雅 400，不崩）
- 推荐码：注册时经 `?ref=` 静默记录来源（referral_code/referred_by，被推荐人首次付费 → 推荐人 10% 入 `referrals` 记账）。
  ⚠️ 2026-09-15：推荐功能确定不计划上线，已移除前端面板与 `GET /api/me/referral` 统计端点及 `getReferralStats`；
  注册来源记录与 webhook 提成记账保留（不对外展示任何承诺）
- 状态页设置：`updateStatusPage`（enabled/slug/customDomain/whiteLabel/password）
- 团队：建团队/邀请(按邮箱)/退出；admin：ban/delete/quota/role/plan/impersonate

### `src/monitors.js`（监控核心，~745 行）
- `createMonitor`（配额+类型+渠道门禁）/ `listMonitors` / `getMonitor` / `deleteMonitor` / `importMonitors`（uptimerobot/csv/json）
- `listDueMonitors(nowMs, limit)`：**只取已到期的监控**（`last_checked IS NULL OR last_checked <= now - interval*1000`，走 `idx_monitors_last_checked`）。
  2026-09-23 P1-④：轮询器此前直接调 `listMonitors()`（无 WHERE / 无 LIMIT）⇒ 5 秒一次全表读 = 17,280 次/天，且随行数增长。现在按索引增量取数，到期判据与原内存判据逐字等价。
- `isPollLeader()`：对外暴露 leader 状态，供数据保留清理等定时任务复用同一把租约
- `saveMonitor` / `saveEvent` / `saveCheck`
- `getHistory` / `getStats`（可用率/平均/P95+时序）/ `getStatusPage` / `getStatusPageByHost`（自定义域名）
- **9 类检查器**：checkHttp / checkKeyword / checkPing / checkTcp / checkSsl / checkDomain(自建WHOIS) / checkApi(header+JSON断言) / checkDns / checkHeartbeat
- `runCheck(monitor, plan)`：读 `PROBE_REGIONS` 多区域，多数确认降误报；`consecutive_failures` 支持连续失败计数（Free 连续 2 次才告警）
- `startPolling()`：每 5 秒扫描 + `inFlight` Set 并发锁 + `POLL_MAX_CONCURRENT` 总并发上限 + **DB leader 租约**（`tryAcquireLease`）
  ▸ **仅 leader 实例执行扫描与告警派发**。Fly 双实例下若都轮询，会各自派发 ⇒ 每封告警发两份、内存级冷却失效；
    故用 `leader_lease` 表做租约（TTL 30s、每 5s 续租），leader 挂掉后另一实例 ≤30s 接管（P1-12）
  ▸ **总并发上限（2026-09-23 P1-⑤）**：`inFlight` 只能防「同一监控重复检查」，防不住「总并发过大」——
    到期监控一多会同时起 N 个检查，各自要写库（UPDATE + INSERT），叠上池容量就绪会让全站 API 排队。
    现在 `activeChecks` 计数器把同时在跑的检查数限制在 `POLL_MAX_CONCURRENT`（默认 8），超出的留到下一轮
  ▸ 整个 tick 包在 try/catch 内：轮询回调不是路由，抛出去会变成 unhandled rejection（P0 后进程级兜底会退出进程）
- `setCheckResultHandler(fn)`（注册 alerts handler）

### `src/retention.js`（数据保留清理，~75 行 · 2026-09-23 P2-⑧ 新增）
- 背景：此前全仓**没有任何保留策略**，`monitor_checks` 增长最快（Pro 档 30 秒检查 ⇒ 单监控 2880 行/天）
- `pruneByTs(table, tsColumn, cutoffMs)`：分批删（`DELETE ... WHERE id IN (SELECT id ... LIMIT n)`），单条语句短小，不产生长事务、不易撞 `statement_timeout`
- `pruneMonitorChecks()`：`monitor_checks` 默认保留 30 天（`RETENTION_CHECKS_DAYS`）
- `startRetention(isLeaderFn)`：定时执行（默认每小时，启动后延迟 5 分钟），**只在 poll leader 上跑**；失败只 WARN、下一轮重试
- 其它表（`page_sessions` / `user_events` / `monitor_events`）按同一模式扩展即可，但需先确定各自允许的保留期

### `src/ssrf-guard.js`（SSRF 守卫，2026-09-23 P0-1 新增）
- 背景：监控目标由用户提交，服务端 `fetch` / TCP / SSL / ping 直接出网，原先**无任何内网过滤**（`normalizeTarget` 只 `new URL()` 解析、`monitors.js` 三处 `fetch` 带 `redirect:'follow'`）→ 认证用户可探 `169.254.169.254` 云元数据、`10.x`/`localhost` 内网
- `isBlockedTarget(raw)`：创建时同步校验（字面量 IP + 主机名规则），`normalizeTarget` 调用 → 拦入库（覆盖 `POST /api/monitors` 与 `/import` 两条写入路由）
- `assertSafeTarget(hostname)`：运行时异步校验（`dns.promises.lookup` 解析全部 IP，任一危险即拒），`runLocalCheck` 对非 fetch 类（ping/tcp/ssl/domain）调用。**仅确认危险才返回 `ok:false`（blocked-*）；DNS 解析失败（no-ip / dns-fail）一律 `ok:true` 放行，交由实际 fetch / connect 自然报错** —— 避免把瞬时 DNS 抖动误标成「目标被拦截」（线上曾出现滚动重启瞬间 10 个公网监控因解析未就绪被误标 TARGET_BLOCKED:no-ip，修订后恢复）
- `safeFetch(url, init)`：带守卫的 `fetch` —— `redirect:'manual'`，对 3xx 跳转目标**再校验**后最多跟随 1 跳；HTTP/Keyword/Api 三类检查改用它
- 拦截段：`127/10/172.16-31/192.168/0.0.0.0/8`、`169.254.0.0/16`（含云元数据）、`100.64.0.0/10` CGNAT；IPv6 `::1` / `fc00::/7` / `fe80::/10`；主机名 `localhost` / `*.local` / `*.internal` / `*.svc` / `*.cluster`
- 已知边界：DNS 重绑定(TOCTOU)理论窗口未用 undici 自定义 connect 钉死解析 IP；主威胁（认证用户直填内网地址 / 内网域名）已覆盖

### `src/alerts.js`（告警，~248 行）
- `initAlerts()` → 注册检查结果 handler
- 状态机：down / up / escalation（按 escalationIntervalMin 重发）/ warning（慢响应+SSL/域名到期）
- 渠道发送：sendAlertEmail（带配额）/ sendSlack / sendWebhook / sendTelegram / sendDiscord / sendTeams / sendPagerduty
- **邮件发送配额（P1-12）**：`consumeEmailBudget(scope, ceiling)` 原子自增（`email_budget` 表，双实例共享、按 UTC 日分桶）
  ▸ 全局闸 `EMAIL_DAILY_CAP`（默认 90，护 Resend 免费档 100/天）+ 单账号闸 `EMAIL_ACCOUNT_CAP`（默认 60）
  ▸ **方案 A 优先级**：warning（慢响应/即将到期）只能用全局额度前 `EMAIL_WARN_SHARE`（默认 40%），
    其余**预留给关键告警**（down / escalation / recovered）⇒ 事故时关键邮件发得出去；超限跳过并 `console.warn`（不静默）
- `resolveChannels(monitor, plan)`：按套餐过滤启用渠道（降档后超档渠道静默不发、不删配置）
- 维护窗口：命中 active 窗口的监控 down 不派发告警（仍 saveEvent）
- 订阅者通知：状态页订阅者（status_subscribers）在 down/恢复时收邮件
- `generateMonthlyReport`：月度可用率汇总 + 邮件（每月 1 号自动 + admin 手动触发）

### `src/email.js`（邮件封装，~56 行）
- 独立 transporter（复用 SMTP_* 配置），`sendMail(to, subject, text, html)`
- `sendVerificationEmail` / `sendFeedbackNotification`

### `src/db.js`（数据库，~472 行）
- `getPool()` → pg Pool 单例（`ssl:{rejectUnauthorized:false}`，理由见文件内注释）
- **连接池显式配置（2026-09-23 P0-1）**：`max=6` / `connectionTimeoutMillis=10000` / `idleTimeoutMillis=30000` /
  `statement_timeout=15000` / `idle_in_transaction_session_timeout=30000` / `query_timeout=15000` / `application_name='pingory'`，全部可 env 覆盖。
  关键一项是 `connectionTimeoutMillis`：pg-pool 默认**不建超时定时器**，池满时请求会永久挂起（不报错、不超时）——
  这正是「API 间歇 502」的机制。取值依据 Supabase 免费档官方额度（Nano：直接连接 60 / Supavisor 客户端 200）。
- `initDb()` → **版本化迁移**（2026-09-23 P1-⑥）：`schema_migrations` 记版本，版本已是最新则**正常启动完全不碰 DDL**；
  仅版本落后时执行幂等基线 DDL，并用 `pg_advisory_lock` 串行化双机（避免两份全量 DDL 并发打库）
- 一次性数据迁移：孤儿监控清理（原在每次启动路径上，现只在迁移期执行一次）+ `monitors.user_id` 外键级联补建
- `startKeepAlive(intervalMs)` → 每 4 分钟 SELECT 1

### 多区域探针 Worker（`src/worker.js`，~56 行）
- 独立轻量 HTTP 服务：仅本地检查、不连库、不调度、不告警
- `POST /probe`（x-probe-secret 校验）→ runLocalCheck 回传结果；`GET /health`
- 与主服务同镜像，部署 CMD 切 `node src/worker.js` + `PROBE_REGION_NAME` 区分节点
- 主服务 `runCheck` 在 `PROBE_REGIONS` 配置节点下委托（验证期单点，多节点待配置）

---

## 3. 数据流

### 正常轮询（含多区域 + 并发锁 + 连续失败）
```
startPolling() 每 5s（2026-09-23 P1-④/P1-⑤ 改造后）
  → 先续租 leader（非 leader 直接返回）
  → listDueMonitors()：只取「已到期」的监控（按 last_checked 索引，单轮上限 POLL_BATCH_LIMIT=200）
  → 受 POLL_MAX_CONCURRENT=8 约束派发；超出的留到下一轮（不丢弃）
  → runCheck()：PROBE_REGIONS 多节点探测，多数确认 down 才置 down；
     非付费档单点 + consecutive_failures 连续 2 次才告警
  → UPDATE monitors(last_checked/status/last_response_time/last_error/consecutive_failures)
  → INSERT monitor_checks（明细；由 startRetention() 默认保留 30 天）
  → status 变化 / warning / escalation → alerts handler
```

### 用户创建监控
```
前端 POST /api/monitors {url,name,interval,type,config,channels,statusPublic}
  → 路由校验登录 + 配额(PLAN_LIMITS/email-verify cap) + planHasType + planHasChannel
  → monitors.createMonitor() → INSERT + 立即触发一次检查
```

### 公开状态页（G5 已上线 / 单状态页设计，多状态页 H 已随 PRD v2.0 决策 6 砍除）
```
用户 PATCH /api/me/status-page {enabled, slug/customDomain/whiteLabel/password}
  → auth.updateStatusPage 写 users.*
  → 访客 GET /status/:slug 或 GET /（Host=自定义域名 → /api/status-page）
  → 仅返回 status_public=true monitors + 近 30 天聚合（spark/incidents）
  → 私有页：password → POST .../unlock 写 capability cookie(HMAC)
  → 订阅：POST .../subscribe 入库 status_subscribers
```

### 告警与订阅者通知
```
check 结果 → alerts handler
  → 维护窗口命中？→ 跳过派发(仍落库)
  → resolveChannels(monitor, plan) → 各渠道发送
  → down/恢复事件 → notifySubscribers(该状态页订阅者) 邮件
```

### 月度报告
```
server.js setInterval（每月 1 号）或 POST /api/admin/monthly-report
  → generateMonthlyReport(userId) → 汇总可用率/P95 → nodemailer
```

### Paddle 订阅/支付事件（PRD §2.5-D 逻辑落地）
```
Paddle POST /api/paddle/webhook
  → 手动 HMAC 验签(paddle-signature + paddle-event-ts 容差 300s) 失败 400/401
  → subscription.activated → updatePlan(starter/pro)
  → subscription.canceled → updatePlan(free)
  → subscription.updated → 升降级
  → transaction.paid → 记录(不升 plan)
  → 200 {ok:true}
```

---

## 4. 数据库 Schema（Supabase Postgres · 16 表 · 2026-09-23 核对 `src/db.js` 的 CREATE TABLE 计数，含 connect-pg-simple 的 `session` 表与新增的 `schema_migrations`）

### users
| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT (PK) | UUID v4 |
| email | TEXT (UNIQUE) | 登录邮箱 |
| password_hash | TEXT | scrypt 哈希 |
| plan | TEXT | free/starter/pro |
| public_slug | TEXT | 状态页 slug（注册生成 base-6hex） |
| status_page_enabled | BOOLEAN | 状态页开关 |
| status_custom_domain | TEXT | 自定义域名（G7） |
| status_white_label | BOOLEAN | 白标（G7） |
| status_password_hash | TEXT | 私有页密码（G7） |
| email_verified | BOOLEAN | 邮箱验证 |
| verify_token / verify_expires | TEXT / BIGINT | 验证令牌 |
| role | TEXT | user/admin |
| twofa_secret | TEXT | 预留 TOTP（未启用） |
| referral_code | TEXT | 本人推荐码 |
| referred_by | TEXT | 来源推荐人 |
| api_key | TEXT | Account API Key（G9） |
| team_id / team_role | TEXT / TEXT | 团队归属（G9） |
| banned | BOOLEAN | 封禁拒登（admin） |
| monitor_limit | INT | 配额覆盖（NULL=套餐默认） |
| last_login | BIGINT | 上次登录（admin） |
| created_at | TIMESTAMPTZ | 创建时间 |

### monitors
| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT (PK) | UUID v4 |
| user_id | TEXT (FK) | 归属用户 |
| team_id | TEXT | 团队共享（G9，可空） |
| url / name | TEXT | 目标 / 名称 |
| interval | INT | 检查间隔（秒） |
| type | TEXT | http/keyword/ping/tcp/ssl/domain/api/dns/heartbeat |
| config | TEXT(JSON) | 类型配置 |
| channels | TEXT(JSON) | 告警渠道及凭据 |
| status | TEXT | up/down/error/pending |
| status_public | BOOLEAN | 是否进公开状态页 |
| last_checked / last_response_time / last_error | BIGINT / INT / TEXT | 最近检查 |
| last_alert_at / alert_count | BIGINT / INT | escalation 控制 |
| last_success_at | BIGINT | heartbeat 判定 |
| consecutive_failures | INT | 连续失败计数（Free 防误报） |
| created_at | TIMESTAMPTZ | 创建时间 |

### monitor_events / monitor_checks
▸ monitor_events：id / monitor_id / event_type(down/up/check/warning) / from_status / to_status / response_time / error / detail / created_at；索引 monitor_id + created_at
▸ monitor_checks：id / monitor_id / ts(BIGINT) / status / response_time / region / error；索引 (monitor_id, ts) + 单独 `ts`（供保留清理按时间筛过期行，2026-09-23 P2-⑧ 新增）
  ▸ **保留策略**：默认保留 30 天，由 `src/retention.js` 分批清理（`RETENTION_CHECKS_DAYS` 可调）。这是全仓第一个数据保留策略

### schema_migrations（迁移版本 · 2026-09-23 P1-⑥ 新增）
▸ version(主键) / applied_at —— 记录已应用到哪个 schema 版本
▸ 作用：让 `initDb()` 在版本已是最新时**完全跳过 DDL**（旧行为是每次进程启动都跑约 100 条 CREATE/ALTER，
  双机同时启动即两份全量 DDL 并发打库）；版本落后时才迁移，并用 `pg_advisory_lock` 串行化

### feedback（客户反馈）
id / user_id(可空) / email(选填) / message / page / status(new/seen/done) / created_at

### referrals（推荐 · 仅记账）
▸ 承载 referral_code ↔ referred_by 绑定，被推荐人首次付费后推荐人得 10%（webhook 写入）
▸ 2026-09-15 起推荐功能不计划上线：统计端点 `GET /api/me/referral` 与 `getReferralStats` 已移除，
  前端面板与 `referral.*` 文案已删；表结构保留作为注册来源沉淀（如需重启功能无需重新迁移）

### teams（团队 · G9）
id / name / owner / created_at（+ users.team_id/team_role 关联）

### status_subscribers（状态页订阅者 · G7）
id / user_id(页主) / slug(或 status_page_id) / email / created_at（down/恢复时邮件通知）

### maintenance_windows（维护窗口 · G8）
id / user_id / title / monitor_ids(JSON 'all' 或数组) / start_at / end_at / created_at

---

## 5. 依赖清单

| 包 | 用途 |
|---|---|
| express | Web 框架 |
| dotenv | 环境变量 |
| @paddle/paddle-node-sdk | Paddle API（client token；验签手动） |
| pg / connect-pg-simple | Postgres 连接池 + session 落库 |
| nodemailer | SMTP 邮件 |
| express-session | Cookie Session |

**无 AI / 无外部 API 依赖**（除 Paddle/Supabase/SMTP），边际成本 ≈ $0。

---

## 6. 关键技术决策记录（追加 v2.0）

| 决策 | 原因 | 时间 |
|---|---|---|
| session 改 connect-pg-simple 落库 | Fly 双机内存 session 不同步 → 登录态丢失 | 2026-08-27 |
| PLAN_LIMITS 收敛 src/plans.js 单一源 | 曾 server.js 本地副本 free=20 与 plans.js 50 不一致 | 2026-08-30 |
| Free 连续 2 次失败才告警（consecutive_failures） | 免费档不"刻意做吵"，反竞品单点即报误报模式 | 2026-08-30 |
| OAuth google+github 优雅降级 | 未配凭据 400 不崩溃，邮箱登录不受影响 | 2026-09-02 |
| 状态页订阅者入库 status_subscribers | 护城河（状态页订阅通知）基础 | G7 |
| 维护窗口只抑制派发不抑制落库 | 事件留痕 + 可用率统计真实 | G8 |
| 自定义域名经 Host 解析 + capability cookie(HMAC) | 免引入 cookie-parser，私有页轻量解锁 | G7 |
| 多区域探针拆 worker 独立服务 | 探测节点可独立多区部署，复用 runLocalCheck | Phase 1 |

（完整决策史含早期错误见方案层复盘文档，按设计不随本仓库公开；v1.1 其余决策保留于 git 历史）

---

## N. 设计期模块说明（历史参考 · 大部分已在 v30 落地）

> v1.1 曾列 G7-G11「设计说明」。截至 v2.0，G7（状态页增强）、G8（维护窗口）、G9（团队+Account API）、G10（i18n）、G11（部署）均已实现上线；早期「未部署」标注已失效。残余未落地项：多区域真实多节点（PROBE_REGIONS 验证期单点）、MS Teams 真实凭据。SMS(Twilio) 已于 2026-09-15 决策取消（需美国实体主体）。多状态页/状态页实体化已随 PRD v2.0 决策 6 砍除。细节以上方 v2.0 正文为准。
