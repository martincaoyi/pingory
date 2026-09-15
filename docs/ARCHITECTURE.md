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
│  /api/me          用户信息 / referral(推荐码) / status-page    │
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
      │    Neon Postgres (9 表)                         │
      │    users · monitors · monitor_events           │
      │    monitor_checks · feedback · referrals        │
      │    teams · status_subscribers                   │
      │    maintenance_windows                          │
      └───────────────────────────────────────────────┘
```

> ⚠️ v2.0 修正：早期 v1.1 架构图为设计期草图（含 G7-G11 未落地项）。v2.0 以线上 v30 实际代码为准；前端为「落地页+仪表盘一体」单页（非多页分离），DB 实为 9 表，已补 OAuth/推荐码/导入/团队/订阅者/维护窗口/i18n/支付 模块。

---

## 2. 模块职责

### `server.js`（入口，~1221 行，57 路由）
- Express 应用初始化（静态服务、JSON body、Session(connect-pg-simple 落库)、安全中间件）
- Paddle SDK 实例化（sandbox/live 切换）+ 手动 HMAC 验签 webhook
- 路由注册：auth（注册/登录/登出/邮箱验证/OAuth google+github）/ me（信息/referral/状态页/订阅者）/ monitors（CRUD/import/stats/history）/ heartbeat / maintenance-windows / status(公开+解锁+订阅) / team / account-apikey / v1(Bearer) / plan-features / feedback / admin* / paddle-config / paddle-webhook / health
- 套餐门禁在路由层校验：`PLAN_LIMITS`（配额）、`planHasType`（检查类型）、`planHasChannel`（渠道）、`planHasStatusPage` / `planHasStats`（状态页/趋势图）、`planMinInterval`（最低间隔）
- 启动：`seedAdmin()`（ADMIN_EMAIL/PASSWORD 建超管）+ `initDb()` + `startKeepAlive()` + `initAlerts()` + `startPolling()` + 月度报告 setInterval
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
- 推荐码：`registerReferral`（referral_code/referred_by，被推荐人首次付费 → 推荐人 10%）
- 状态页设置：`updateStatusPage`（enabled/slug/customDomain/whiteLabel/password）
- 团队：建团队/邀请(按邮箱)/退出；admin：ban/delete/quota/role/plan/impersonate

### `src/monitors.js`（监控核心，~613 行）
- `createMonitor`（配额+类型+渠道门禁）/ `listMonitors` / `getMonitor` / `deleteMonitor` / `importMonitors`（uptimerobot/csv/json）
- `saveMonitor` / `saveEvent` / `saveCheck`
- `getHistory` / `getStats`（可用率/平均/P95+时序）/ `getStatusPage` / `getStatusPageByHost`（自定义域名）
- **9 类检查器**：checkHttp / checkKeyword / checkPing / checkTcp / checkSsl / checkDomain(自建WHOIS) / checkApi(header+JSON断言) / checkDns / checkHeartbeat
- `runCheck(monitor, plan)`：读 `PROBE_REGIONS` 多区域，多数确认降误报；`consecutive_failures` 支持连续失败计数（Free 连续 2 次才告警）
- `startPolling()`：每 5 秒扫描 + `inFlight` Set 并发锁
- `setCheckResultHandler(fn)`（注册 alerts handler）

### `src/alerts.js`（告警，~248 行）
- `initAlerts()` → 注册检查结果 handler
- 状态机：down / up / escalation（按 escalationIntervalMin 重发）/ warning（慢响应+SSL/域名到期）
- 渠道发送：sendEmail / sendSlack / sendWebhook / sendTelegram / sendDiscord / sendTeams / sendPagerduty
- `resolveChannels(monitor, plan)`：按套餐过滤启用渠道（降档后超档渠道静默不发、不删配置）
- 维护窗口：命中 active 窗口的监控 down 不派发告警（仍 saveEvent）
- 订阅者通知：状态页订阅者（status_subscribers）在 down/恢复时收邮件
- `generateMonthlyReport`：月度可用率汇总 + 邮件（每月 1 号自动 + admin 手动触发）

### `src/email.js`（邮件封装，~56 行）
- 独立 transporter（复用 SMTP_* 配置），`sendMail(to, subject, text, html)`
- `sendVerificationEmail` / `sendFeedbackNotification`

### `src/db.js`（数据库，~226 行）
- `getPool()` → pg Pool 单例（SSL verify-full）
- `initDb()` → 9 表 CREATE IF NOT EXISTS + ALTER 迁移（幂等、禁 DROP）
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
startPolling() 每 5s 扫 monitors 表
  → 到下次检查时间(last_checked+interval) 且 !inFlight.has(id)
  → runCheck()：PROBE_REGIONS 多节点探测，多数确认 down 才置 down；
     非付费档单点 + consecutive_failures 连续 2 次才告警
  → UPDATE monitors(last_checked/status/last_response_time/last_error/consecutive_failures)
  → INSERT monitor_checks（明细）
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

## 4. 数据库 Schema（Neon Postgres · 9 表 · 2026-09-04 线上实况）

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
▸ monitor_checks：id / monitor_id / ts(BIGINT) / status / response_time / region / error；索引 (monitor_id, ts)

### feedback（客户反馈）
id / user_id(可空) / email(选填) / message / page / status(new/seen/done) / created_at

### referrals（推荐）
▸ 承载 referral_code ↔ referred_by 绑定 + 统计（signups/paid/pending），被推荐人首次付费后推荐人得 10%

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

**无 AI / 无外部 API 依赖**（除 Paddle/Neon/SMTP），边际成本 ≈ $0。

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
