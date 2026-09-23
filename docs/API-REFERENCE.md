# Pingory · API 接口速查

> 本文档描述后端 Express REST API。登录/注册/验证邮箱/OAuth（`/api/auth/*`）与 `/api/paddle-config`、`/api/creem-config` 无需登录态；其余业务端点由各路由内部校验 Session（未登录返回 401）。
>
> **版本**：v2.5（2026-09-23 P1/P2 稳定性：探针改增量取数 + 总并发上限、启动期 DDL 改版本化迁移、数据保留清理、对比页渲染缓存；**端点无增删、错误码仍 37 个、8 语字典零改动**——v2.4 为 P0-2「全局异常兜底与 5xx 语义」；v2.3：2026-09-16 P1-11：未匹配 `/api/*` 统一 JSON 兜底，错误码 36→37；v2.2：安全响应头加固 P1-10；v2.1 更正：删除从未实现的 `GET /api/monitors/:id`，此前 v2.0 新增 SEO 对比页路由 `/compare/uptimerobot` 与 7 语路径）
> **最后更新**：2026-09-23（P1/P2 稳定性改造；对 API 契约的影响见「探针与运维行为变更」，端点与错误码不变）
> **关联代码**：`server.js`（路由，共 80 个端点）、`src/monitors.js`（检查引擎）、`src/alerts.js`（告警）、`src/plans.js`（套餐门禁 / 数量上限单一源）、`src/auth.js`（认证）、`src/email.js`（邮件）；多区域探针另有 `src/worker.js`（`GET /health`、`POST /probe`，独立服务不计入上表）
>
> **2026-09-19 探针可靠性**：本地检查与多区域 `/probe` 均经 `runLocalCheckRetry` 执行——单次检查遇超时 / 网络抖动类错误会重试一次（间隔 1.5s）后再判定 down，消除东京探针偶发抖动造成的假故障；单点 HTTP/Keyword 超时从硬编码 10s 提至 15s（可经 `CHECK_TIMEOUT_MS` 环境变量调参，无需重新部署）。

---

## 统一错误响应约定（错误码 + i18n）★ 2026-09-13 变更

所有业务端点失败时返回**错误码**（机器可读），而不是英文句子：

```json
{ "error": "plan_type_not_supported", "ep": { "plan": "pro", "type": "HTTP/HTTPS status code" } }
```

▸ `error`：错误码（见下表），前端用 `t('err.'+code)` 翻译成当前语言
▸ `ep`：占位符参数，用于替换文案中的 `{plan}` / `{limit}` / `{minInterval}` / `{type}` / `{msg}` / `{cap}`
▸ 前端 `errMsg(d)` 统一负责「翻译 + 占位符替换」；`plan` 参数会再经 `t('plan.'+plan)` 显示为「专业版」等本地化名称
▸ 字典缺键时回退显示原始错误码（便于定位）
▸ 内容自由文本（如监控历史时间线的 `error` 字段记录 HTTP 错误原文）不走错误码，保持原样

### 错误码清单（37）

| 错误码 | HTTP | 含义 / 占位符 |
|---|---|---|
| `auth_required` | 401 | 未登录或会话失效 |
| `missing_auth_header` | 401 | 缺少 `Authorization` 头（v1 API） |
| `invalid_api_key` | 401 | API Key 无效 |
| `user_not_found` | 404 | 用户不存在 |
| `wrong_password` | 401 | 当前密码错误 |
| `invalid_confirmation_link` | 400 | 邮箱验证 / 改邮箱链接无效或过期 |
| `rate_limited` | 429 | 触发频率限制 |
| `plan_monitor_limit` | 403 | 套餐监控数已满 `{plan}` `{limit}` |
| `plan_type_not_supported` | 403 | 套餐不支持该监控类型 `{plan}` `{type}` |
| `plan_min_interval` | 400 | 检查间隔低于套餐下限 `{plan}` `{minInterval}` |
| `email_verify_required` | 403 | 未验证邮箱且达到未验证上限 `{cap}` |
| `trend_requires_starter` | 403 | 趋势图需 Starter 以上 |
| `status_page_requires_starter` | 403 | 状态页需 Starter 以上 |
| `status_page_pro_only` | 403 | 该状态页功能仅 Pro |
| `status_page_not_found` | 404 | 状态页不存在 |
| `status_page_no_domain` | 400 | 未配置自定义域名 |
| `api_type_not_supported` | 403 | 不支持的 API 监控类型 |
| `invalid_plan` | 400 | 无效套餐 |
| `invalid_monitor_limit` | 400 | 无效监控数上限 |
| `url_required` | 400 | 缺少监控目标 URL |
| `channel_not_supported` | 403 | 套餐不支持该告警渠道 `{plan}` `{channel}` |
| `channel_not_configured` | 400 | 该渠道尚未配置凭据 `{channel}`（须先在账户设置配置） |
| `url_invalid` | 400 | 目标不是合法 URL / 域名 `{url}`（只填 `baidu.com` 会自动补全为 `https://baidu.com/`） |
| `monitor_not_found` | 404 | 监控不存在 |
| `monitor_not_found_or_no_perm` | 404 | 监控不存在或无权限 |
| `import_unsupported_format` | 400 | 导入格式不支持 |
| `import_no_data` | 400 | 导入数据为空 |
| `import_parse_failed` | 400 | 导入解析失败 `{msg}` |
| `import_no_monitors` | 400 | 导入未解析出任何监控 |
| `feedback_empty` | 400 | 反馈内容为空 |
| `feedback_too_long` | 400 | 反馈内容过长 |
| `admin_required` | 403 | 需要管理员权限 |
| `self_ban` | 400 | 不能封禁自己 |
| `self_delete` | 400 | 不能删除自己 |
| `no_team` | 404 | 团队不存在 |
| `server_error` | 500 | 服务器内部错误 `{msg}` |
| `endpoint_not_found` | 404 | 请求的 API 路径不存在（未匹配任何 `/api/*` 路由时的统一兜底，2026-09-16 P1-11 新增） |

### 未匹配路由的统一兜底（2026-09-16 P1-11 新增）

未匹配任何 API 路由的请求，原会落到 **Express 默认 404**（HTML 响应体 `Cannot GET /api/xxx`），
与「错误码 + `{error, ep}` JSON」约定不一致 —— 前端按 JSON 解析会拿到 HTML 而抛异常。

现由 `app.use('/api', ...)` 兜底统一返回：

```json
{ "error": "endpoint_not_found", "ep": {} }
```

▸ **注册位置**：全部 API 路由注册之后（`server.js` 的 `/health` 之后），因此不会遮蔽任何真实路由
▸ **作用域**：仅 `/api` 前缀；非 `/api` 路径（静态资源、页面路由、对比页等）**行为完全不变**
▸ **方法无关**：任意 HTTP 方法（含未实现的 `PATCH` 等）命中都会得到该 JSON，而非 HTML

### 全局异常兜底与 5xx 语义（2026-09-23 P0-2 新增）

此前含 `await` 的路由处理器**默认没有任何异常出口**：Express 4 不接管 async handler 返回的 Promise，
`await` 抛错会变成 unhandled rejection ⇒ 进程以 `exit_code=1` 退出（2026-09-23 13:00:27 生产实测；
同期另一台机器则是 `exit_code=137 + oom_killed=true` 的内核 OOM，两者性质不同、治法不通用）。
现分三层收口：

| 层 | 实现 | 覆盖范围 |
|---|---|---|
| 处理器 | `wrap()` 把 Promise rejection 转成 `next(err)` | 启动时由 `wrapAllHandlers()` 遍历 Express router 栈统一包装——**不改路由声明，将来新增的路由自动生效** |
| 应用 | 全局错误中间件（4 参数签名，注册在所有路由之后） | 记录完整堆栈 + 统一返回 `{ error: "server_error", ep: {} }` |
| 进程 | `process.on('unhandledRejection' \| 'uncaughtException')` | 先写完整堆栈**再退出**，交由平台重启（保留「响亮失败」，但保证退出有据可查） |

**5xx 状态码语义**（响应体一律 `{ error: "server_error", ep: {} }`，前端解析逻辑无需改动）：

▸ **503** — 上游瞬时故障（连接池等待超时 / 连接被中断 / 认证超时等），**可重试**
▸ **500** — 代码缺陷或非瞬时错误

判定依据为错误消息中的关键词白名单（`timeout` / `Connection terminated` / `ECONNRESET` / `EPIPE` /
`ECONNREFUSED` / `EAUTHTIMEOUT` / `ECIRCUITBREAKER`）。**不新增错误码**，故 8 语字典无需扩键、parity 不变。

> 相关：连接池上限与超时（`max` / `connectionTimeoutMillis` / `statement_timeout` / `query_timeout`）
> 见 `src/db.js` 的 pool 配置注释，其取值依据 Supabase 免费档官方额度（见该文件注释内链接）。

### 探针与运维行为变更（2026-09-23 P1/P2，端点与错误码不变）

对**调用方无影响**（没有新增/删除端点，没有新增错误码，响应体结构不变），但会改变运行期行为与排障方式：

| 变更 | 影响的接口/行为 | 说明 |
|---|---|---|
| 探针扫描改增量（`listDueMonitors`） | 监控状态刷新时延 | 轮询器不再每 5s 全表扫描，改为「只取已到期的监控」（按 `last_checked` 索引）。到期判据与原内存判据**逐字等价** |
| 探针总并发上限 | `GET /api/monitors` 等的可用性 | 同一瞬间进行的检查数 ≤ `POLL_MAX_CONCURRENT`（默认 8）。超出的到期监控留到下一轮（5s 后），**不是丢弃** |
| 启动期 DDL 改版本化迁移 | 冷启动耗时、重启冲击 | 正常启动不再跑 DDL（日志变为 `表结构已是最新（v1），跳过 DDL`）；仅版本升级时执行，且用 `pg_advisory_lock` 串行化 |
| 数据保留清理 | `GET /api/monitors/:id/stats` / `history` 的历史深度 | `monitor_checks` 默认保留 **30 天**（`RETENTION_CHECKS_DAYS` 可调）。超出保留期的趋势图/历史点会被清理，**不影响监控状态与告警** |
| 对比页渲染缓存 | `/compare/*` 与 `/{lang}/compare/uptimerobot` | 按「语言 + 模板/字典 mtime」缓存渲染结果，改文件即失效 |

新增/可调环境变量（都有默认值，无需配置即可运行）：
`POLL_MAX_CONCURRENT`、`POLL_BATCH_LIMIT`、`RETENTION_CHECKS_DAYS`、`RETENTION_BATCH_SIZE`、
`RETENTION_MAX_BATCHES`、`RETENTION_INTERVAL_MS`、`RETENTION_FIRST_DELAY_MS`。

### 变更原因（2026-09-13）

此前后端直接返回英文句子（例：`Your pro plan does not support "", please upgrade`），前端 `showAlert(d.error)` 原样弹出 → **中文界面下显示英文**。现改为「错误码 + 8 语字典」：`err.*` 键在 en/zh/es/pt/de/fr/ja/ko 各 38 个（37 个错误码 + 既有 `err.fail`，v1.8 起；`err.endpoint_not_found` 为 2026-09-16 P1-11 新增），全语言 parity 由 `tools/dev_gate.js` 的 `i18n-缺键` / `i18n-未翻译` 门禁守。

另：`/api/monitors` 的 `url` 字段自 2026-09-13 起支持**只填域名**（如 `baidu.com`），后端自动补全 `https://` 并归一化；非 HTTP 类类型（ping/tcp/ssl/domain/dns）若粘贴完整 URL，自动取 host。

---

## 0. 健康检查（无需登录）

### GET /health
存活探针，供监控/外部探活调用，无需登录态。

**响应**
```json
{ "ok": true, "ts": 1700000000000, "region": "local" }
```

> `region` 取自环境变量 `PROBE_REGION_NAME`（未配置时为 `local`）。
> **v1.6（2026-09-13）**：移除 `env` 字段——该字段原读 `PADDLE_ENVIRONMENT || 'sandbox'`，在 Creem 主收款、Paddle 降为 dormant 备用后具误导性；生产实际收款通道以 `PAYMENT_PROVIDER` 为准（管理后台「Env」列展示）。

## 1. Paddle 配置（无需登录）

### GET /api/paddle-config
返回前端 Paddle.js 初始化所需参数。

**响应**
```json
{
  "environment": "sandbox",
  "clientToken": "test_xxx",
  "starterPriceId": "pri_xxx",
  "proPriceId": "pri_xxx",
  "starterAnnualPriceId": "pri_xxx",
  "proAnnualPriceId": "pri_xxx"
}
```

> `starterAnnualPriceId` / `proAnnualPriceId`（v2.0.1 新增，2026-09-05）：年付订阅价格 ID（Paddle billing period=annually）。前端在计费切换选中「年付」时用年价打开结账；未配置时前端回退到月价 `starterPriceId`/`proPriceId`。

---

## 1.5 Creem 配置（双轨收款，PAYMENT_PROVIDER=creem 启用）

> 与 Paddle 并存，默认 `PAYMENT_PROVIDER=paddle`（Paddle 生效，Creem 全链路 dormant）。Creem 过审后将 `PAYMENT_PROVIDER` 改为 `creem` 即激活，无需改代码；出问题时改回 `paddle` 即可切回。Creem 仅作**提现**通道（Alipay 中国商户），顾客结账仍走 Creem 信用卡。

### GET /api/creem-config
返回当前激活的收款渠道（前端据此决定走 Creem 还是 Paddle 结账）。

**响应**
```json
{ "active": false, "environment": "test" }
```

### GET /api/creem/checkout
服务端创建 Creem 托管结账 session（需登录态）。`product_id` 走服务端环境变量，前端不接触。

**Query**
- `plan`：`starter` | `pro`
- `annual`：`1` | `0`（是否年付）

**响应**
```json
{ "url": "https://checkout.creem.io/ch_xxx" }
```
失败返回 400/401/500 + `{ error: <code>, ep }`（错误码见文首「统一错误响应约定」）。

### POST /api/creem/webhook
Creem 订阅事件通知。签名用 `creem-signature` 头，HMAC-SHA256 原始 body 十六进制比对。详见 §4。

---

## 1.6 页面分析（无需登录，无 cookie）

### POST /api/analytics/start
前端落地页生成一次性 session id（`sessionStorage`）后上报，服务端记录访问开始时间、来源国家（优先 `CF-IPCountry` 头，取不到则 `unknown`）。幂等：同一 `sid` 重复 start 只刷新 `last_seen_at` 并 `page_count + 1`。

**Request Body** `{ "sid": "uuid" }`

**响应** `{ "ok": true, "sid": "uuid" }`

### POST /api/analytics/ping
前端每 30 秒（且页面可见时）上报一次心跳，服务端在 `last_seen_at > now() - 5 分钟` 的前提下为该 session 增加 30 秒停留时长，避免标签页挂后台虚高。

**Request Body** `{ "sid": "uuid" }`

**响应** `{ "ok": true }`

---

## 2. 认证

### POST /api/auth/register
注册新用户。密码在服务端用 scrypt 哈希。

**Request Body**
```json
{ "email": "user@example.com", "password": "min6chars" }
```

**响应 201** `{ id, email, plan: "free" }`
**响应 400** 邮箱已存在 / 密码 < 6 字符

### POST /api/auth/login
登录，设置 express-session Cookie。

**Request Body**
```json
{ "email": "user@example.com", "password": "..." }
```

**响应 200** `{ id, email, plan }`
**响应 401** 密码错误

### POST /api/auth/logout
清除 Session。

**响应 200** `{ ok: true }`

### GET /api/me
获取当前登录用户信息。

**响应 200** `{ id, email, plan, monitors_count }`
**响应 401** 未登录

### GET /api/auth/oauth/:provider/start
发起 OAuth 社交登录。`provider` ∈ `google` | `github`。可选 `?ref=` 透传推荐码（写入 state，登录成功即绑定推荐关系）。

**响应 302** 重定向到对应 OAuth 授权页
**响应 400** `OAuth not configured for <provider>`（该 provider 未配凭据时，不影响其他功能）

### GET /api/auth/oauth/google/callback
### GET /api/auth/oauth/github/callback
OAuth 回调终点。用 code 换取 token 并获取邮箱，按邮箱找/建用户并登录；`state=ref:xxx` 时为新用户写入推荐来源。成功后重定向 `/`。

**失败重定向** `/signin.html?err=<code>`（2026-09-07 修正：原误跳 signup，已统一回登录页便于重试）。错误码：`google_code` / `gh_code`（授权被取消或未返回授权码）、`google_token` / `gh_token`（换取令牌失败，多为线上 client secret 未配置/不匹配）、`google_err` / `gh_err`（回调异常）、`noemail`（provider 未返回邮箱）、`oauth_create`（找/建用户失败）、`oauth`（其他）。前端 `signin.html` 读取 `?err=` 显示对应中文提示。
> 注意：provider 凭据（`GOOGLE_CLIENT_ID/SECRET`、`GITHUB_CLIENT_ID/SECRET`）未配置时，`start` 返回 400，本回调不会被访问——功能优雅降级，不影响邮箱/密码登录。

---

## 3. 监控管理

### 监控类型（type）与 target 格式
| type | 目标 `url` 格式 | 套餐 | 说明 |
|---|---|---|---|
| `http` | 合法 URL | free+ | 状态码检查，默认 2xx/3xx 为 up |
| `keyword` | 合法 URL | free+ | 页面内容必须含关键字 |
| `ping` | 主机名/IP（非 URL） | starter+ | ICMP 存活 |
| `tcp` | `host:port` | starter+ | TCP 端口连通 |
| `ssl` | 主机名/IP | starter+ | 证书有效 + 到期预警 |
| `domain` | 域名 | starter+ | WHOIS 到期预警 |
| `api` | 合法 URL | starter+ | 自定义 header + JSON 断言 |
| `dns` | 域名 | starter+ | 记录值比对 |
| `heartbeat` | 合法 URL（回填端点） | starter+ | 后台任务按时上报 |

- Free 仅 `http` / `keyword`；Starter/Pro 全 9 类。不支持的类型返回 **403**。
- `validateTarget(type, url)`：http/keyword/api/heartbeat 要求合法 URL；其余仅要求非空字符串。

### config 配置字段（按 type）
| type | config 字段 | 说明 |
|---|---|---|
| `http` | `expectedStatuses: number[]` | 视为 up 的状态码集合，默认 [200,201,…,399] |
| `http` | `method` | 默认 GET |
| `http` | `slowThresholdMs: number` | 超过则触发慢响应 warning（G2） |
| `keyword` | `keyword: string` | 页面文本必须包含 |
| `tcp` | `port: number` | 端口（url 仅填 host 时必填） |
| `ssl` | `port: number`（默认 443）、`sslWarnDays: number`（默认 30） | 提前 N 天预警 |
| `domain` | `domainWarnDays: number`（默认 30） | 提前 N 天预警 |
| `api` | `method`、`headers`、`body`、`assertPath: string`、`assertEquals` | JSON 断言（如 `assertPath: "data.ok"`） |
| `dns` | `recordType: string`（默认 A）、`expectedValues: string[]` | 解析值比对 |
| `heartbeat` | （无） | 由 `POST /api/heartbeat/:id` 回填 `lastSuccessAt` |

### channels 告警渠道配置（v1.8 · 2026-09-14 Plan A 改版）
`channels` 为对象，键为渠道名，值**至少含 `enabled: true`**；**按套餐过滤**，非本档渠道被静默丢弃，返回 201 时只保留有效渠道。

**凭据位置（Plan A）**：渠道凭据（Slack/Webhook URL、Telegram Bot Token + Chat ID 等）改为**账户级配置一次**（见 §7.6），监控的 `channels` 只存**开关**：

```json
{ "email": { "enabled": true }, "slack": { "enabled": true }, "telegram": { "enabled": true } }
```

派发时后端把账户级凭据与监控开关**合并**（`src/alerts.js` 的 `resolveChannels(monitor, plan, accountChannels)`）；**向后兼容**——若监控自带同名字段凭据（旧数据，或调用方通过 API 显式传入），同名字段覆盖账户级，老监控行为不变。**缺少凭据的渠道会被跳过**并打印一条 `[alert] 渠道 X 已启用但缺少凭据，跳过` 日志，不会让整次告警失败。

| 渠道 | 套餐 | 账户级凭据字段（§7.6） |
|---|---|---|
| `email` | free+ | 无需（发往监控归属账号的注册邮箱，恒开） |
| `slack` | starter+ | `{ url }` |
| `webhook` | starter+ | `{ url }` |
| `telegram` | starter+ | `{ botToken, chatId }` |
| `discord` | pro | `{ url }` |
| `teams` | pro | `{ url }` |
| `pagerduty` | pro | `{ url }` |

> ⚠️ v1.7 及更早文档把 slack/discord/teams 写作 `webhookUrl`、pagerduty 写作 `integrationKey`，与代码不符——实际派发统一读取 `cfg.url`（见 `src/alerts.js` dispatch）。v1.8 已按代码更正。

### POST /api/monitors
新建监控（受配额 + 类型 + 渠道门禁限制）。

**Request Body**
```json
{
  "url": "https://example.com",
  "name": "My Site",
  "interval": 60,
  "type": "http",
  "config": { "expectedStatuses": [200, 201], "slowThresholdMs": 800 },
  "channels": { "email": { "enabled": true }, "slack": { "enabled": true } },
  "statusPublic": false
}
```
- `interval`：秒，默认 60（注意：MVP 默认 300，Phase 1 起默认 60），最小 30
- `type`：默认 `http`，受 `planHasType` 门禁（见上表）
- `statusPublic`：仅 Starter+ 生效，否则强制 false

**配额**：Free 50 / Starter 100 / Pro 无限（`src/plans.js` PLAN_LIMITS 单一源）。超限 **403**。
**门禁响应**：类型不支持 **403**；target 非法 **400**；缺 url **400**。
**响应 201** 新建的 monitor 对象（含 id / type / config / channels / statusPublic）

> `channels` 现在只需传开关（凭据在账户级，见 §7.6）；仍兼容在 `channels.slack.url` 等处传 per-monitor 凭据（会覆盖账户级）。

### POST /api/monitors/import
批量导入监控。支持从 UptimeRobot 导出（JSON）、通用 CSV、JSON 数组三种格式。

**Request Body**
```json
{ "format": "uptimerobot", "data": "<粘贴 UptimeRobot 导出的原样文本>" }
```
- `format`：`uptimerobot` | `csv` | `json`
- 解析后逐条走与 `POST /api/monitors` 相同的配额/类型/校验门禁；不支持的类型自动降级为 `http`，interval 低于套餐最小值时抬到最小值
- 到达配额上限即停止，返回已创建数与跳过数

**响应 200**
```json
{ "ok": true, "created": 8, "skipped": 2, "skippedReasons": ["plan monitor limit reached", "missing url"] }
```
**响应 400** 格式不支持 / data 缺失或为空 / 解析失败 / 无有效监控
**响应 401** 未登录

### GET /api/monitors
列出当前用户的监控（按创建时间倒序）。

**响应 200** `[ { id, url, name, interval, type, status, last_checked, last_response_time, status_public, created_at, ... } ]`

> 注：**没有** `GET /api/monitors/:id`（单监控读取）。前端列表接口已返回全部字段，无需单条读取；如需单条请按 id 在列表结果里筛。历史版本文档曾列出该端点，实为从未实现。

### PATCH /api/monitors/:id
部分更新监控（校验归属 + 套餐门禁）。

**Request Body**（以下字段均可选，仅传需改的）
```json
{ "config": { "slowThresholdMs": 1000 }, "channels": { "telegram": { "enabled": true, "botToken": "...", "chatId": "..." } }, "statusPublic": true, "interval": 120, "name": "Renamed" }
```
- `statusPublic` / `channels` 同样受套餐门禁（非本档强制 false / 丢弃）
- `config` 整体替换

**响应 200** 更新后的 monitor 对象；**404** 不存在或非本用户；**500** 保存失败

### DELETE /api/monitors/:id
删除监控（校验归属）。

**响应 200** `{ deleted: true }`
**响应 404** 监控不存在或非本用户

### GET /api/monitors/:id/stats
响应时间趋势统计（G6，需 Starter+）。

**Query**
- `days`：统计天数，默认 30

**响应 200**
```json
{ "uptime": 0.998, "avgRt": 124, "p95Rt": 380, "series": [ { "ts": 1693000000000, "status": "up", "rt": 122 }, ... ] }
```
**响应 403** 当前套餐不支持趋势图；**404** 监控不存在

### GET /api/monitors/:id/history
获取状态变化历史（从 `monitor_events` 表）。

**Query**
- `limit`：条数，默认 50，最大 200

**响应 200** `[ { id, event_type, from_status, to_status, response_time, error, detail, created_at } ]`
- `event_type`：`down` | `up` | `check` | `warning`
- `from_status` / `to_status`：`up` | `down` | `error`
- ⚠️ `error` 为**检查失败原因错误码**，格式 `code` 或 `code|detail...`（见下节），前端须用 `fmtMonitorError()` 翻译后再展示

---

### 检查失败原因错误码（v1.9 · 2026-09-14 变更）★

`GET /api/monitors` 的 `lastError`、`GET /api/monitors/:id/history` 的 `error`、状态页 `incidents[].error`
统一存放**稳定错误码**，不再直接存中文/英文句子（旧版本存中文串，英文/西语界面会露出中文）。

▸ 格式：`code` 或 `code|detail`
▸ 前端：`t('monerr.' + code)`，并把 `{detail}` / `{p}` `{a}` `{e}` 替换为实际值（`public/index.html`、`public/status.html` 的 `fmtMonitorError()`）
▸ 服务端对人不带语言偏好的出口（告警邮件 / Slack / Webhook / Telegram / Discord）：`src/monerr.js` 的 `monErrText()`
▸ 语言中立原文（`HTTP 500`、`ECONNREFUSED`、`err.message`）不属错误码，原样存储与展示

错误码清单（17，均须在 8 语字典有 `monerr.*` 键）

▸ `timeout`｜`kw_missing`｜`kw_not_found|{keyword}`｜`ping_no_response`｜`ping_failed`
▸ `connect_timeout`｜`ssl_no_cert`｜`ssl_expired`｜`ssl_handshake|{errCode}`｜`ssl_timeout`
▸ `whois_no_expiry`｜`domain_expired`｜`assert_failed|{path}|{actual}|{expected}`
▸ `heartbeat_never`｜`heartbeat_late`｜`ssl_expiring|{days}`｜`domain_expiring|{days}`
（最后两个为 `warning` 事件的 `error` 字段，取值为剩余天数）

单一事实源：`src/monerr.js`（`MON_ERR` / `MON_ERR_CODES` / `monErrText`）。新增检查类型时必须同步 8 语 `monerr.*` 键与两个页面的 `MONERR_CODES`。

---

## 3.5 状态页 / 心跳 / 套餐能力 / 月报（Phase 1 新增）

### POST /api/heartbeat/:id
Heartbeat 监控的回填端点（G1，**无需登录**，凭监控 id）。

**Request Body**：空（由服务端写入 `lastSuccessAt = now()`，若当前为 down 则置 up）

**响应 200** `{ ok: true }`；**404** 监控不存在

> 用法：被监控的后台任务/cron 在成功执行后 `curl -X POST https://your-domain/api/heartbeat/<id>`；超过约定间隔未上报即判定 down。

### GET /api/status/:slug
公开状态页数据（G5，**无需登录**）。

**响应 200**
```json
{ "title": "Acme Inc", "whiteLabel": false,
  "monitors": [ { "id": "...", "name": "My Site", "status": "up", "uptime": 0.998, "avgRt": 124,
                  "spark": [ { "day": "2026-08-01", "avgRt": 120, "down": false }, ... ] } ],
  "incidents": [ { "monitor_id": "...", "event_type": "status", "to_status": "down", "error": "HTTP 503", "created_at": 1693000000000 } ] }
```
- `monitors[].spark`：近 30 日每日降采样（avgRt + 当日是否 down），供状态页 sparkline。
- `incidents`：近 30 日该状态页下监控的 down/up 事件（倒序），供事故时间线。
**响应 404** slug 不存在或用户未开启状态页

### GET /status/:slug
公开状态页 HTML（G5，**无需登录**），渲染 `public/status.html`。

### PATCH /api/me/status-page
开关当前用户公开状态页（G5，需登录，需 Starter+）。

**Request Body**
```json
{ "enabled": true, "slug": "my-status" }
```
- `slug`：可选，缺省保留原 slug 或自动生成；含 `public_slug` 字段
- `title`：可选（**Pro**），公开状态页标题，≤80 字符；留空=清除。未设置时状态页标题回退到 `users.name`，再回退到前端通用文案

**响应 200** `{ user }`（含 `statusPageEnabled` / `publicSlug` / `statusPageTitle`）；**403** 套餐不支持；**401** 未登录

### GET /api/plan-features
返回当前用户套餐的可用能力（前端渲染表单用，需登录）。

**响应 200**
```json
{ "plan": "starter",
  "features": { "types": ["http","keyword","ping","tcp","ssl","domain","api","dns","heartbeat"], "channels": ["email","slack","webhook","telegram"], "statusPage": true, "multiRegion": true, "stats": true },
  "typeLabels": { "http": "HTTP/HTTPS 状态码", ... },
  "channelLabels": { "email": "邮件", ... } }
```

### POST /api/admin/monthly-report
手动触发月度报告（G6，测试用，需登录）。

**响应 200** `{ "sent": 1 }`（实际发出的报告数）

> 生产环境由 `server.js` 启动时的 `setInterval` 在每月 1 号自动触发 `generateMonthlyReport(userId)`。

---

## 4. Webhook（Paddle / Creem → 服务端）

### POST /api/paddle/webhook
Paddle 订阅事件通知。签名手动 HMAC-SHA256 验签，时间戳容差 300 秒。

**Header**
- `paddle-signature`：`h1=<hex>`
- `paddle-event-ts`：秒级时间戳

**Event 处理**
| event | action |
|---|---|
| `subscription.activated` | 升级 plan（starter/pro），更新 `users.plan` |
| `subscription.canceled` | 降级为 free |
| `subscription.updated` | 升降级处理 |
| `transaction.paid` | 记录支付事件，不改 plan |

**响应** 200 `{ ok: true }` 或 400/401 验签失败

### POST /api/creem/webhook
Creem 订阅事件通知（双轨收款启用时）。`creem-signature` 头 = HMAC-SHA256(原始 body, CREEM_WEBHOOK_SECRET) 十六进制；body 解析用 `express.raw({type:'*/*'})`（兼容任意 content-type），取 Buffer 原文做 HMAC，复用方案C 归一化账单账本（`recordBillingEvent({provider:'creem'})`）+ `updatePlan`，owner 分析与 Paddle 同源。

**Event 字段说明**
- Creem 实测 payload 用 camelCase `eventType`（非 `event_type`）；服务端读取 `event.event_type || event.eventType` 双兼容，避免落入 `default` 不升级。
- `object` 内含 `metadata`（checkout 时写入的 `userId/plan/cycle`）、`customer`、`amount`、`currency`。
- **plan 兜底**：当 `metadata.plan` 缺失时，`productPlanFromEnv(obj.product.id || obj.product_id)` 从 4 个 `CREEM_*_PRODUCT` 环境变量反查 starter/pro，避免"付了钱但因 metadata 丢失而套餐不升级"的静默失败（2026-09-09 加固）。

**Event 处理**
| event（eventType） | action |
|---|---|
| `subscription.active` / `subscription.trialing` | 升级 plan + 发推荐提成（首次） |
| `subscription.paid` | 续费：记账，不发提成 |
| `subscription.canceled` / `subscription.expired` / `subscription.paused` | 降级为 free |
| `refund.created` | 记退款事件 |

**诊断**：验签失败时打印 `{ received, computed, ct, bodyLen, hasSecret }` 日志，用于区分「密钥不匹配 / content-type 边界 / body 为空」三类根因。

**响应** 200 `ok` 或 400 验签失败

---

## 5. 前端静态文件

| 路径 | 说明 |
|---|---|
| `/` | 落地页（index.html，含 Paddle.js v2） |
| `/public/...` | 静态资源目录 |

> 例外：`public/compare-uptimerobot.html` 是**模板**，不走 `express.static` 直出——它在 `express.static` 之前被显式路由接管：直链 `/compare-uptimerobot.html` 会 **301** 到规范地址 `/compare/uptimerobot`（避免重复内容）。同目录其余 `.html` 仍为普通静态文件。

---

## 6. 认证方式

- **Session**：express-session，Cookie name `um_sid`，生命周期 24h
- **密码**：Node.js `crypto.scrypt` 哈希，不可逆
- **跨用户隔离**：所有 monitors 操作强制 `req.user.id === monitor.user_id` 校验

---

## 7. 账户安全 / 反馈 / 管理后台（2026-08-28 新增）

### 7.1 邮箱验证（G-SEC）
注册后服务端生成一次性令牌并发验证邮件；未验证账号前端显示横幅提示。

- **GET /api/auth/verify-email?token=`<hex>`**（无需登录）
  校验令牌，有效则置 `email_verified=true`。**响应 200** `{ ok:true, email }`；**400** 令牌无效/过期。
- **POST /api/auth/resend-verify**（需登录）
  重新发送验证邮件。**响应 200** `{ ok:true }` 或 `{ ok:true, already:true }`（已验证）。

> 验证链接形如 `https://pingory.com/?verify=<token>`，由 `APP_URL` 环境变量决定前缀。

### 7.2 客户反馈（G-FEEDBACK）
- **POST /api/feedback**（无需登录，限流 10 条/小时/IP）
  **Request Body** `{ "message": "建议…", "email": "可选", "page": "可选(默认取 referer)" }`
  入库 `feedback` 表 + 邮件通知 `ALERT_TO_EMAIL`。**响应 201** `{ ok:true }`；**400** 内容为空/过长。

### 7.3 超级管理员后台（G-ADMIN）
所有 `/api/admin/*` 需 `role=admin`（否则 403）。超级账号启动时按 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 自动建立。

- **GET /api/admin/stats**：全局统计（用户数 / 付费数 / 监控数 / 当前 down 数 / 待处理反馈 / 运行时长 / 环境）
- **GET /api/admin/analytics**：owner 收入/增长分析（复用 users + 方案C 读归一化账本 `billing_events` + 页面分析 `page_sessions`；返回 今日新增用户 todayNewUsers / 今日收入 todayCents / 总监控数 totalMonitors / 今日访问数 todaySessions / 累计访问数 totalSessions / 平均停留时长 avgDurationSec（秒）/ 当前在线 onlineNow / 来源国家 topCountries（{country, c}）/ MRR 近30天口径 / 总收入 / 近30天收入 / 付费数 / 转化率 / ARPU / 各渠道收入拆分 / 30天新增用户曲线 / 30天每日收入曲线）。分析只读 `billing_events`/`page_sessions`，与具体收款方解耦——换 Paddle/Creem 不改此端点。
- **GET /api/admin/users**：用户列表（含套餐 / 角色 / 邮箱验证 / 监控数；支持 q/plan/role/banned 筛选）
- **GET /api/admin/users/:id**：用户详情 + 监控列表 + 订阅数
- **POST /api/admin/users/:id/plan** `{ "plan": "free|starter|pro" }`：改套餐（测试用）
- **POST /api/admin/users/:id/role** `{ "role": "user|admin" }`：改角色
- **POST /api/admin/users/:id/ban** `{ "banned": true|false }`：封禁/解封（拒登；禁操作自己）
- **POST /api/admin/users/:id/delete**：删除用户（禁操作自己）
- **POST /api/admin/users/:id/quota** `{ "monitorLimit": 100 }`：设置监控配额覆盖（NULL=套餐默认）
- **POST /api/admin/impersonate/:id**：将当前 Session 切换为该用户（便于以用户身份测试功能）
- **POST /api/admin/monthly-report**：手动触发月报（仅管理员）
- **GET /api/admin/monitors**：全部监控（含归属邮箱）
- **GET /api/admin/feedback**：反馈列表
- **GET /api/admin/user-events**：用户行为事件列表（可选 `?userId=&eventType=&limit=&offset=`）
- **GET /api/admin/user-events/summary**：近 N 天事件汇总（`?days=1`，默认 1 天，最大 90），返回 `{since, counts:[{event_type,c}], activeUsers}`
- **GET /api/admin/user-events/ranking**：按用户分组活跃度排行（`?days=30`，默认 30 天，最大 365；`?limit=20`，最大 100）。返回 `{ active:[{user_id,user_email,event_count,action_types,last_active}], dormant:[{user_id,email,created_at,total_events,last_active}] }`——`active` 为高频用户（按事件数降序），`dormant` 为注册后无动作或长时间未活跃用户（用于召回）。
- 页面入口：`/admin.html`（内置用户表 / 监控表 / 反馈 / 系统监控摘要 / 用户活动流，可一键「以此身份测试」跳回官网）

### 7.4 安全加固
- Cookie：`httpOnly` + `sameSite=lax`；`PADDLE_ENVIRONMENT=live` 时自动 `secure`；生命周期 7 天。
- 基础响应头：`X-Content-Type-Options: nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy` / `X-XSS-Protection` / `Content-Security-Policy`（放行 Paddle CDN）。
- 框架指纹：`app.disable('x-powered-by')` —— 不返回 `X-Powered-By: Express`，避免暴露后端技术栈（P1-10，2026-09-16）。
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()` —— 显式关闭页面无需的浏览器能力；**刻意不含 `payment=()`**，避免误伤 Paddle / Creem 结账 iframe（P1-10，2026-09-16）。
- 限流（内存）：登录/注册 15 次/15 分钟/IP；反馈 10 条/小时/IP。限流 IP 取值优先级（2026-09-13 B2 修正）：`CF-Connecting-IP`（Cloudflare 强制覆写，不可伪造）→ `Fly-Client-IP`（`*.fly.dev` 直连兜底）→ `req.ip`；禁用 XFF 最左条目（CF 对已有 XFF 为追加语义，客户端可伪造假 IP 轮换绕过限流）。
- 安全联系人文件：`GET /.well-known/security.txt`（静态文件 `public/.well-known/security.txt`，RFC 9116；2026-09-13 B2 新增，清 Cloudflare Security Insights「Security.txt 未配置」项）。
- 密码策略：注册最小 8 位。
- 预留 `users.twofa_secret` 列（TOTP 第二因子，后续启用）。
- 新增 `users.alert_channels` 列（Plan A，2026-09-14）：账户级告警渠道凭据（JSON）。单独存取、**不并入 `rowToUser`**，避免凭据泄漏进 `/api/me`、管理后台用户列表等响应。
- 新增 `users.pending_email` 列（P0-3，2026-09-13）：改邮箱流程中暂存待验证新邮箱；`confirm-email` 校验通过后写入 `email` 并将该用户置为已验证。`rowToUser` 同时返回 `hasPassword: !!password_hash`，供前端区分密码用户 / OAuth 用户（OAuth 用户 `password_hash=NULL`，需先「设置密码」才能使用密码登录与改密码）。

### 7.5 账户自助管理端点（P0-3，2026-09-13）

账户生命周期完整闭环：注册/登录 → 改昵称 → 改密码 → 忘记密码重置 → 改邮箱 → OAuth 设密码。所有端点返回统一不暴露账号是否存在；错误统一走 `{error}` 结构。

- **POST /api/account/change-password**：已登录密码用户改密码。body `{ oldPassword, newPassword }`。新密码需 ≥8 位。OAuth 用户（无旧密码）调用返回 400 引导先 `setPassword`。
- **POST /api/account/profile**：已登录改昵称 / OAuth 设密码。body 含 `name` → 改昵称；含 `password` → 为 OAuth 用户设置密码（无需旧密码）。返回更新后的 user（`/api/me` 同结构）。
- **POST /api/account/change-email**：已登录发起改邮箱。body `{ newEmail }`。查重后生成 `verify_token`（复用 `VERIFY_TTL_MS=24h`），将新邮箱暂存 `pending_email`，发送验证邮件（链接 `APP_URL/?confirmEmail=`）。统一响应不暴露邮箱是否已存在。
- **POST /api/account/confirm-email**：body `{ token }`。校验 token 与 TTL 后将 `pending_email` 写入 `email` 并置 `verified=true`；token 失效/过期返回 400。
- **POST /api/auth/forgot-password**：未登录发起重置。body `{ email }`。仅密码用户返回 token 并发送重置邮件（链接 `APP_URL/reset-password.html?token=`）；OAuth-only 用户或不存在账号均返回统一成功响应（不暴露账号类型/存在性，响应体恒为 `{ok:true,message}`，无 sent 标志位）。
- **POST /api/auth/reset-password**：body `{ token, newPassword }`。校验 token 与 TTL 后写新密码（覆盖 `password_hash`，OAuth 用户借此获得密码登录能力）。token 失效/过期返回 400。
- 限流（2026-09-13 审查加固）：`/api/auth/forgot-password` 与 `/api/auth/reset-password` 共用 5 次/小时/IP（防邮件轰炸/令牌爆破）；`/api/account/change-password` 挂登录/注册同款 15 次/15 分钟/IP（防旧密码爆破）。
- 一致性保证：`setPassword` 仅允许 `password_hash IS NULL` 的 OAuth-only 用户（密码用户必须走 change-password 验旧密码）；`confirmEmailChange` 确认时复检新邮箱唯一性（防请求→确认窗口期被他人注册，被占则清 pending 令牌并报错）；昵称截断 100 字符。

前端入口：`index.html` 登录后顶部「账户」按钮 → `openAccountSettings(user)` 弹窗（改昵称 / 改密码 / 改邮箱 / **告警渠道**四段；OAuth 用户显示「设置密码」）；`signin.html` 表单下方「Forgot password?」→ `reset-password.html`；`startApp()` 处理 `?confirmEmail=` 自动完成邮箱验证并清参。

### 7.6 账户级告警渠道凭据（Plan A，2026-09-14）

把「Slack/Telegram/Webhook 凭据」从每个监控的添加表单迁到账户设置，**配一次、所有监控复用**；监控表单只勾选要用哪些渠道（竞品 UptimeRobot「My Alert Contacts」/ Healthchecks「Integrations」同构）。凭据仅按套餐过滤，存储于 `users.alert_channels`，**接口只返回当前登录用户自己的凭据**。

- **GET /api/account/channels**：返回已保存的账户渠道凭据。**响应 200** `{ ok:true, channels: { slack:{url}, telegram:{botToken,chatId}, ... } }`（未配置的渠道不出现）；未登录 **401**。
- **POST /api/account/channels**：整体覆盖保存。body `{ channels: { slack:{url}, telegram:{botToken,chatId}, ... } }`。服务端按套餐过滤（非本档渠道静默丢弃）、`email` 忽略（恒开、无需凭据）、逐渠道字段白名单去空（telegram 需 `botToken`+`chatId` 同时存在，其余需 `url`），全空即删除该渠道。**响应 200** `{ ok:true, channels }` 返回清洗后的结果；未登录 **401**。**注意：为整体覆盖语义，前端每次提交完整集合**（漏传即视为删除）。
- **POST /api/account/channels/test**：发送一条测试告警，验证凭据是否可用。body `{ channel, config? }`——`config` 可选，传入则**临时测试未保存的输入**（不落库），不传则用已保存凭据。**直接读取下游 HTTP 状态判定成功/失败**（不吞异常）。**响应 200** `{ ok:true }`；渠道未配置 **400** `channel_not_configured`；套餐不支持 **403** `channel_not_supported`；下游失败 **400** `server_error`。**限流** 15 次/15 分钟/IP。

前端行为：`index.html` 账户弹窗新增「Alert channels」段（每个渠道一组输入 + 「Send test」）；监控添加表单的渠道区只渲染复选框——**已配置 → 默认勾选，未配置 → 禁用并给出「去配置」链接**，从根上避免「勾了但没凭据」的静默失效。

---

## 8. 前端页面

| 路径 | 说明 |
|---|---|
| `/` | 落地页（index.html）：注册/登录、监控列表、状态页开关、**邮箱验证横幅**、**悬浮反馈组件** |
| `/admin.html` | 管理后台（仅超级管理员可进） |
| `/status/:slug` | 公开状态页（G5，Starter+ 可开启） |
| `/`（自定义域名根路径） | 若该 Host 命中 `users.status_custom_domain`，返回状态页（G7） |

### 8.1 SEO 对比页（2026-09-14 新增；2026-09-15 扩至 3 竞品）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/compare/uptimerobot` | 英文（规范地址，canonical 指向自身） |
| GET | `/{lang}/compare/uptimerobot` | `lang ∈ zh,es,pt,de,fr,ja,ko`；非白名单语言 `next()` 落到 404 |
| GET | `/vs/uptimerobot` | **301** → `/compare/uptimerobot`（用户给出的候选 URL 别名） |
| GET | `/compare-uptimerobot.html` | **301** → `/compare/uptimerobot`（防止模板被直出造成重复内容） |
| GET | `/compare/betterstack` | 英文首版静态页（`express` 显式路由 sendFile；canonical 固定英文规范 URL） |
| GET | `/vs/betterstack` | **301** → `/compare/betterstack` |
| GET | `/compare-betterstack.html` | **301** → `/compare/betterstack` |
| GET | `/compare/pingdom` | 英文首版静态页（同上） |
| GET | `/vs/pingdom` | **301** → `/compare/pingdom` |
| GET | `/compare-pingdom.html` | **301** → `/compare/pingdom` |

▸ **robots.txt / sitemap.xml**（2026-09-15 新增，`public/` 静态直出）：robots 禁 `/admin.html`、`/api/`、`/signin.html` 并声明 sitemap；sitemap 列出首页 + 3 个对比页（uptimerobot 含 7 语变体，共 11 URL）。

实现要点：

▸ 模板 `public/compare-uptimerobot.html` 单文件承载 8 语；服务端替换 `__CMP_LANG__` / `__CMP_CANONICAL__` / `<!--CMP_I18N_PRELOAD-->` 再返回 → `<html lang>` 与 `canonical` 均为**静态可抓取**内容，不依赖 JS。
▸ **正文文案也由服务端就地替换**（`cmpLocalize`）：按 `data-i18n="key"`（同名标签深度配对取闭合位）替换元素 inner HTML、按 `data-i18n-content="key"` 替换同标签 `content` 属性 → **不执行 JS 的爬虫也能抓到目标语言正文/标题/描述**；`data-i18n` 属性保留，故前端切语逻辑不受影响。译文中的裸 `&` 转义为 `&amp;`；注入一律用函数式 `replace`（防译文含 `$&` 被当替换模式）。
  - ⚠️ 该实现依赖模板结构约束：`data-i18n` 节点**不得**出现同名标签嵌套（当前 110 个节点已验证 0 嵌套）。
▸ 页面 `<head>` 内置 8 条 `hreflang`（含 `x-default`）+ `og:*` + `FAQPage` / `BreadcrumbList` JSON-LD。
▸ 文案走 i18n 字典 `cmp.*`（100 键 × 8 语）。
▸ 页内语言切换 = **整页 URL 跳转**（`/compare/uptimerobot` ↔ `/de/compare/uptimerobot`），保证 URL 语言与内容语言一致。
▸ 服务端另注入 `window.__I18N_PRELOAD__`（`cmp.*`/`nav.*`/`footer.*` 子集）供前端复用，避免二次 fetch。

---

## 9. G7–G11 新增端点

### 9.1 状态页增强（G7，Pro）
- **PATCH /api/me/status-page**：扩展字段 `{ customDomain, whiteLabel, password, title }`（Pro 专属；`password` 留空=取消私有；`title` 留空=清除自定义标题）。
- **GET /api/status/:slug**：返回 `{ title, whiteLabel, monitors[], incidents[] }`；`title` = 状态页展示名，回退链 `status_page_title → users.name → null`（前端回退通用文案）。**⚠️ 不返回 email**——状态页是公开页面，回退到邮箱会把用户邮箱印在公开页面上（P1-5 修复）；`monitors[].spark` 为近 30 日每日降采样；`incidents` 为近 30 日 down/up 事件（供状态页横幅/可用率/sparkline/事故时间线）。私有页未解锁返回 `401 {needsPassword:true,whiteLabel}`。
- **GET /api/status-page**：按 `Host` 解析自定义域名状态页（同上结构）。
- **POST /api/status/:slug/unlock** / **POST /api/status-page/unlock**：私有页密码解锁，成功写 capability cookie。
- **POST /api/status/:slug/subscribe** / **POST /api/status-page/subscribe**：公开订阅（入库 `status_subscribers`，事件时邮件通知）。slug 不存在 → **404** `{ error: "status_page_not_found" }`（v1.9 起错误码化，此前返回裸中文串）。
- **GET /api/me/subscribers** / **DELETE /api/me/subscribers/:id**：订阅者管理（需登录且为页主）。

### 9.2 维护窗口（G8，Pro）
- **GET /api/maintenance-windows**、**POST /api/maintenance-windows**（`{title,monitorIds:'all'|[],startAt,endAt}`）、**DELETE /api/maintenance-windows/:id**。窗口覆盖的监控 down 时不派发告警（仍记录事件）。

### 9.3 团队 + Account API（G9，Pro）
- **POST /api/team**（`{name}`）创建团队；**POST /api/team/invite**（`{email}`）邀请（按邮箱归入团队，共享监控）；**GET /api/team** 查看成员与共享监控；**POST /api/team/leave** 退出。
- **POST /api/account/apikey**（`{regenerate?}`）生成/重置 API Key；**GET /api/account/apikey** 查看。
- **Account API（Bearer 鉴权）**：`GET /api/v1/monitors`（含团队共享）、`POST /api/v1/monitors`（`{url,name,type,interval,config,channels,statusPublic}`）、`GET|DELETE /api/v1/monitors/:id`。

### 9.4 i18n（G10）
- 语言包：`GET /i18n/:lang.json`（en/es/pt/de/fr/ja/ko）；前端 `index.html` 含语言切换器，核心文案经 `data-i18n` 应用。

### 9.5 用户行为事件（G-EVENTS）
内部无 cookie 埋点，关键业务操作后端自动写入 `user_events`，供 admin 判断注册用户是否真正使用 SaaS。

- 记录事件：`user_signup` / `user_login` / `email_verified` / `monitor_create` / `monitor_update` / `monitor_delete` / `monitor_import` / `plan_upgrade` / `plan_downgrade` / `status_page_update` / `subscriber_add` / `subscriber_remove` / `maintenance_create` / `maintenance_delete` / `team_create` / `team_invite` / `team_leave` / `api_key_view` / `api_key_regenerate` / `feedback_submit` / `admin_set_plan` / `admin_set_role` / `admin_ban_user` / `admin_delete_user` / `admin_set_quota`。
- 表结构：`user_events(id, user_id, event_type, metadata JSON, ip, user_agent, created_at)`。
- 聚合查询：`getUserEventSummary(days)` 近 N 天按事件类型计数 + 去重活跃用户数；`getUserActivityRanking({days,limit})` 按用户聚合（事件数降序）挑高频用户；`getDormantUsers({sinceDays,limit})` 挑注册后无动作 / 长时间未活跃用户（用于召回）。对应 admin 端点 `/api/admin/user-events/ranking`。

---

## 10. 启动与运行契约（P1-14 启动健壮性，2026-09-22）

> 本节**不涉及任何 API 路由的增删改** —— 第 1–9 节的端点、参数与错误码全部照旧。这里记录的是「进程如何启动」的对外行为契约，供运维对照 `fly logs` 判断状态。

### 10.1 启动失败不再导致进程退出

▸ **旧行为（故障）**：`server.js` 的启动块是无 `.catch()` 的立即执行异步函数，`src/db.js` 的 `initDb()` 无重试 ⇒ 启动瞬间数据库抖动 = unhandled rejection = 进程 `exit_code=1` 秒退（Fly 表现为 `start → exit_code=1 → restart → stopped`）。
▸ **现行为**
  ▸ `initDb()` 内部按指数退避重试（`2s / 4s / 8s / 16s / 32s`，共 5 次）；
  ▸ 仍失败则由 `server.js` 的 `bootWithRetry()` 每 **15s** 重试整条启动链，**进程保持存活**；
  ▸ 初始化成功后才执行 `app.listen(PORT)`。
▸ **运维含义**：数据库长时间不可用时，进程存活但**尚未监听端口**（`/health` 不可达）；恢复后自动完成监听，**无需人工 `fly machine restart`**。
▸ **`GET /health`**：响应结构不变（`{ ok, ts, region }`）。

### 10.2 幂等保证（重试安全）

启动链可能被重复执行，以下副作用均有守卫，不会因重试叠加：轮询定时器（`pollingStarted`）、HTTP 监听（`httpListening`，仅 `listen` 成功回调后置位）、月度报告定时器（`monthlyReportTimer`）、保活定时器（`src/db.js` 的 `keepAliveTimer`）；`initDb()` 的 DDL 全部为 `IF NOT EXISTS` 幂等语句。

