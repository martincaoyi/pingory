# Pingory · 变更记录

> 记录每次影响产品行为的代码/配置变更。格式：日期 + 变更内容 + 影响范围 + 关联文档。
>
> **维护原则**：每次 Martin 确认的功能上线或关键决策，必须在此追加一条。
>
> ⚠️ **关于历史条目里的文档引用**：2026-09-15 之前的部分条目会引用一些**不在本仓库内**的内部文档（如 `MARTIN-TODO.md`、`DEV-WORKFLOW.md`、`UM-MVP-TECH.md`、`PAYMENTS-SETUP.md`、`方案资料/...` 下的策略文档）。它们属于**方案层/流程层**，按设计不随开源仓库公开（见 `docs/README.md` 的「阅读路径」）。历史条目按「当时写下的事实」保留，不做改写。

---

## 2026-09-23 · SMS 语义正式关闭（Martin 确认 · 无代码变更）

> 承接 2026-09-15「SMS 功能正式取消」，关闭最后一处开放语义问题（该问题此前一直挂在待办里等一句话确认）。

- **Martin 2026-09-23 确认**：SMS 即「用短信通知用户」，本产品**整体不做**，正式关闭。
- **代码零变更**：`src/plans.js` 渠道矩阵与 `src/alerts.js` `dispatch` 从未含 SMS（09-15 已核）；产品自身文案（`index.html` / 定价页 / `public/refund.html`）亦无 SMS 承诺 —— 无需删改任何一行。
- **保留项（勿误删）**：三个对比页（`compare-uptimerobot/betterstack/pingdom.html`）与各语言字典里的 SMS 提法，均为**竞品能力的事实描述**（UptimeRobot / Better Stack / Pingdom 支持短信、电话告警），是对外对比的准确事实，非本产品承诺。
- 关联：`docs/ARCHITECTURE.md §N`（已标注 SMS 于 09-15 决策取消）。

---

## 2026-09-23 · 稳定性系统治理：P0 异常兜底 + P1 放大系数 + P2 容量与慢性病

**背景**：当日两台机器各重启两次，且**性质不同**，必须分开治：

| 机器 | 时间 | 退出码 | OOM 标记 | 性质 |
|---|---|---|---|---|
| `286023eb114de8` | 13:00:27 | `exit_code=1` | `false` | 未捕获异常 / 未处理 rejection ⇒ 进程自杀 |
| `185173db3e2968` | 14:20:25 | `exit_code=137` | **`true`** | **内核 OOM** 杀进程 |

先做了全代码定位（产出 `稳定性审查-代码地图.md`，逐条给「文件:行号 + 现值 + 为什么与稳定性相关」），再分三档实施。

**P0（异常兜底，v126 `da81d87` 已上线）**

- `src/db.js`：连接池从**零配置**改为显式配置。关键项 `connectionTimeoutMillis`——pg-pool 在它为假值时
  **不建超时定时器**，池满后请求永久挂起（不报错、不超时），这正是「API 间歇 502」的机制。现改为 10 秒快速失败，
  失败沿 wrap() → 全局错误中间件返回 503。
- `server.js`：三层异常收口 —— `wrap()` 启动时遍历 router 栈包装**全部 122 个处理器**（不改路由声明、新增路由自动生效）
  + 4 参数全局错误中间件（瞬时故障 503 / 其余 500，响应体仍 `{error, ep}`）+ 进程级 `unhandledRejection`/`uncaughtException`。
  进程级兜底选择「**记录完整堆栈后再退出**」而不是「记录后继续跑」：真正的缺陷是「退出无据可查」，不是「退出」本身；
  带着损坏状态继续服务才是掩盖。
- `tools/dev_gate.js`：修复**死门禁** —— `changedFiles()` 的三个 git 调用全失败时被 `catch {}` 静默吞掉 ⇒ 返回空集
  ⇒ 所有 diff 类检查「跳过」⇒ 照样打印「✓ 门禁通过」。现改为：失败重试一次（吸收沙箱偶发 EBUSY），
  三次全失败则新增 `GIT-不可用` FAIL 并 `exit 1`，**环境异常响亮失败**（该 FAIL 永不参与首次提交降级）。

**P1（拆放大系数）**

- **④ 探针增量取数**（`src/monitors.js` 新增 `listDueMonitors`）：轮询器此前每 5 秒调 `listMonitors()`
  （`SELECT * FROM monitors ORDER BY created_at DESC`，无 WHERE、无 LIMIT）⇒ **17,280 次/天全表读**，随行数线性放大。
  现改为按 `last_checked` 索引只取到期监控，到期判据与原内存判据**逐字等价**；新增索引 `idx_monitors_last_checked`。
- **⑤ 探针总并发上限**：`inFlight` 只能防「同一监控重复检查」，防不住「总并发过大」——到期监控一多会同时起 N 个检查，
  各自要 UPDATE + INSERT 写库，叠上池容量就让全站 API 排队。现加 `activeChecks` 计数器（`POLL_MAX_CONCURRENT`，默认 8）。
  同时把整个 tick 包进 try/catch（轮询回调不是路由，抛错会变成 unhandled rejection ⇒ 进程级兜底会退出进程）。
- **⑥ 启动期 DDL 移出常规路径**：此前每次进程启动都跑约 100 条 CREATE/ALTER，**双机同时启动即两份全量 DDL 并发打库**，
  而启动往往发生在崩溃重启时（数据库本来就紧张）⇒ 二次冲击、放大故障窗口。现改为 `schema_migrations` 版本闸 +
  `pg_advisory_lock` 串行化；DDL 里夹着的**孤儿监控清理 DELETE**（`NOT IN (子查询)`，每次启动执行一次）移出启动路径，
  改为迁移期一次性执行。**本次为该机制的 v1 基线**：首个带此版本的进程会执行一次完整 DDL 并记录 v1。

**P2（容量与慢性病）**

- **⑦ 内存与堆上限**：`fly.toml` `memory_mb` 256 → 512；`Dockerfile` 启动参数新增 `--max-old-space-size=384`。
  此前不设堆上限 ⇒ V8 触顶时表现是「被内核 OOM kill」（无堆栈可查）而不是可控的 GC 压力。
  ⚠️ 成本：Fly 按内存计费，512MB 比 256MB 约贵一倍（两台合计约 +$2~4/月）；要退回最低配需同时下调堆上限。
- **⑧ 数据保留策略**（新增 `src/retention.js`）：此前全仓**没有任何保留策略**，`monitor_checks` 增长最快
  （Pro 档 30 秒检查 ⇒ 单监控 2880 行/天）。现默认保留 30 天，每小时分批清理（`DELETE ... WHERE id IN (SELECT ... LIMIT n)`，
  单条语句短小、不产生长事务），**只在 poll leader 上执行**。新增索引 `idx_monitor_checks_ts`。
- **⑨ 对比页渲染缓存**：`cmpRender()` 此前每个请求都同步读 35KB 模板 + 读盘解析字典 + 两次大字符串 replace（零缓存），
  全在事件循环里 ⇒ 阻塞其它请求；而对比页正是爬虫/社交机器人的批量抓取目标。现按「语言 + 模板/字典 mtime」缓存，
  改文件即自动失效（不需要重启）。

**SEO / 社交卡片（对比页 OG 修复）**

- 三个对比页（`compare-uptimerobot` / `compare-pingdom` / `compare-betterstack`）此前 `og:image` 指向 `icon-512.png`（1:1 方图），
  却声明 `twitter:card=summary_large_image`（约 1.91:1）⇒ 平台侧会被裁切或留白。现改为**真正的 1200×630 横版图**
  （`public/img/og-*.png`，由 `tools/og-image.py` 生成，代码渲染保证图上文字零错字），补 `og:image:width/height/alt` 与 `twitter:image`。
  注：对比页是英文首版静态页（`compare-uptimerobot.html` 同时是 8 语模板），故图片为英文版。

**文档校准**：`docs/ARCHITECTURE.md` 的模块行数/表数量/轮询数据流按实际代码校准（此前 `server.js` 写「~1221 行、57 路由」，
实为 2107 行、86 路由；表数量 13 → 16）；`docs/API-REFERENCE.md` 升级 v2.5（端点与错误码不变，新增「探针与运维行为变更」一节）。

**关联**：`方案资料/uptime-monitor/稳定性审查-代码地图.md`（P0/P1/P2 全文定位索引）。

---

## 2026-09-22 · 启动健壮性：启动失败不再秒崩（P1-14）

**背景**：Fly 上一台机器出现 `start → exit_code=1(3s) → restart → exit_code=1(4s) → stopped`（`oom_killed=false`、`requested_stop=false` ⇒ 排除 OOM 与人为停机）。逐行核查定位到两个叠加缺陷：`server.js` 的启动块是**没有 `.catch()`** 的立即执行异步函数，而 `src/db.js` 的 `initDb()` **没有任何重试逻辑** ⇒ 启动瞬间数据库稍一抖动就变成 unhandled rejection，进程直接退出；Fly 反复重启仍失败，最终停机，全靠另一台机器单机顶着。

**修改**

- `src/db.js`：`initDb()` 拆为「`initDbOnce()`（幂等 DDL，原样保留）+ 指数退避重试包装（2/4/8/16/32s，共 5 次）」；重试用尽后抛给启动层，不再在库层无限阻塞。
- `server.js`：启动块改为 `bootstrap()` + `bootWithRetry()` 循环 —— 失败只 `console.error` 并每 15s 重试，**永不把 rejection 抛到顶层**；`app.listen()` 改为 await（监听失败同样进入重试），并加 `httpListening` / `pollingStarted` / `monthlyReportTimer` 三个幂等守卫，防止重试把定时器/监听叠加注册。
- **刻意未加** `process.on('unhandledRejection')` 全局兜底：那会长期掩盖真实 bug；根因已在源头修掉，其它异步路径若仍有缺陷，仍按 Node 默认行为退出、由 Fly 重启，以便被发现。

**影响范围**：仅启动路径。API 路由、错误码与 `GET /health` 响应结构均不变（契约见 `docs/API-REFERENCE.md` §10）。

---

## 2026-09-17 · 告警邮件发送配额 + 轮询 leader 租约（P1-12）

**背景**：Martin 指出报警邮件可能打爆 Resend 免费档（100 封/天）。经逐行核查，代码中**没有任何邮件数量上限**，且存在两个未被察觉的倍增器与一个可靠性隐患：

1. **双实例重复发送**：`server.js` 无条件调用 `startPolling()`，而并发锁 `inFlight` 是内存级 Set → Fly 两台 nrt 机器各自轮询、各自派发告警 ⇒ **每封告警发两份**（首封 DOWN 在并发读 `alertCount===0` 时两机都发；升级告警两机各自计时）。同时内存级 warning 冷却（`slowState`）在双实例下失效。
2. **订阅者扇出 ×N**：`notifySubscribers()` 对每个事件给**每个订阅者各发一封**，一个事件 = 1 封给 owner + N 封给订阅者。
3. **超额静默丢失**：`sendEmail` 的 `try/catch` 吞掉 Resend 拒发（额度耗尽）→ 配额打满时**最关键的 DOWN 告警会被静默丢掉**。

一次事故测算：1 个监控宕 24h（默认 30 分钟升级）+ 10 订阅者 ≈ 50 事件 ×(1+10)×2 ≈ **1100 封**，一次即爆免费额度 11 倍。

**新增（`src/db.js`）**

- `email_budget(scope, day, used)`：邮件配额计数表（双实例共享、按 UTC 日期分桶、跨天自动归零、支持并发原子自增）。
- `leader_lease(name, holder, expires_at)`：轮询 leader 租约表。

**新增（`src/alerts.js`）**

- `consumeEmailBudget(scope, ceiling)`：原子消费一封配额（`ON CONFLICT ... DO UPDATE ... WHERE used+1 <= ceiling`）。
- `sendAlertEmail(to, subject, text, { priority, accountId })`：发送前先过配额（全局 + 账号），超限跳过并 `console.warn`。
- **方案 A 优先级**（Martin 2026-09-17 拍板）：`warning`（慢响应 / 证书即将到期）只能用全局额度的前 `EMAIL_WARN_SHARE`（默认 40%），其余**预留给关键告警**（down / escalation / recovered）⇒ 保证事故时关键邮件发得出去。
- 月度报告改走 `warning` 档，不占用为关键告警预留的额度。

**修改（`src/monitors.js`）**

- `tryAcquireLease(holder, name)`：DB 租约（TTL 30s、每 5s 续租）；`startPolling()` 仅 leader 实例执行扫描与派发，leader 挂掉后另一实例 ≤30s 接管。
- 该改动同时修复了内存级 `slowState` warning 冷却在多实例下失效的问题（单 leader 轮询后内存状态恢复一致）。

**新增环境变量（均可省略，用默认值）**

- `EMAIL_DAILY_CAP=90`（全局每日上限，留余量给验证/重置邮件）
- `EMAIL_ACCOUNT_CAP=60`（单账号每日上限，防单账号吃光全局额度）
- `EMAIL_WARN_SHARE=0.4`（非关键告警可用额度占比）

**备选（未采用）**：Resend 付费档（2000 封/天 $20/月）Martin 判定过贵；如需扩容，评估 Cloudflare $5/月方案。

**关联文档**：`ARCHITECTURE.md`（startPolling / alerts 章节）、`DEPLOYMENT.md`（环境变量）。

---

## 2026-09-15 · SEO 对比页扩至 3 竞品 + robots.txt / sitemap.xml 基础设施

**背景**：既有 `/compare/uptimerobot`（8 语模板页）已上线；经竞品调研（Better Stack 免费版 10 监控/3 分钟、付费 $29-34/月；Pingdom 无免费版、Starter ~$10-11/月仅 10 监控——2026-09 经多源交叉核实）确定补 Better Stack 与 Pingdom 两页；同时补齐全站缺失的 robots.txt 与 sitemap.xml。UptimeRobot 现有页面价格表述（$9-10 Solo / $35-41 Team）经官方定价页当日复核一致，未改动。

**新增**

- `public/compare-betterstack.html`：英文首版（搜索量以英文为主，起量后再补 7 语与 hreflang）。
  完整 SEO 头：canonical / og:* / twitter / `FAQPage`+`BreadcrumbList` JSON-LD / index,follow。
  内容含定价对照表、「Better Stack 仍赢在哪」（on-call/电话短信告警/日志管理——诚实陈述）、「Pingory 赢在哪」（每监控价格/状态页/开源）、FAQ、跨页内链。
- `public/compare-pingdom.html`：同结构；诚实标注 Pingory **无 RUM/页面速度分析**（Pingdom 的真实强项）。
- `public/robots.txt`：`Allow: /`；`Disallow: /admin.html`、`/api/`、`/signin.html`；声明 Sitemap。
- `public/sitemap.xml`：首页 + `/compare/uptimerobot`（含 7 语变体）+ 两个新对比页，共 11 URL。

**路由（server.js）**

- `GET /compare/betterstack`、`GET /compare/pingdom` → sendFile 静态页
- 别名 301：`/vs/betterstack`、`/compare-betterstack.html`、`/vs/pingdom`、`/compare-pingdom.html`

**内链与首页 SEO**

- `index.html`：新增 `canonical`（https://pingory.com/）与 `sitemap` link；页脚新增「vs Better Stack / vs Pingdom」内链（新增 8 语键 `footer.compareBs` / `footer.comparePd`）。
- `compare-uptimerobot.html` 页脚补两个新页跨链；两个新页均含三页互链 + AGPL §13 页脚 + analytics.js。

**验证**：dev_gate 全绿（API-契约已同步 docs/API-REFERENCE.md §8.1）；server.js 语法通过；两个新页内联脚本 0 错误、JSON-LD 合法（JSON 解析校验）；8 语字典键一致（716 键）。

---

## 2026-09-15 · 新增累计访问数指标 + 彻底移除推荐功能死代码

**一、新增「总访问数」指标（Martin 反馈「只有今日访问，看不到总的访问数」）**

- `GET /api/admin/analytics` 返回体新增 `totalSessions`（`page_sessions` 全量计数，不受当日口径限制）。
- `admin.html` Owner analytics 新增卡片 `Total visits`，紧邻 `Sessions today` 之后排列。
- 8 语字典同步新增 `admin.analytics.totalSessions`（zh 总访问数 / en Total visits / es Visitas totales /
  pt Visitas totais / de Besuche gesamt / fr Visites totales / ja 総訪問数 / ko 총 방문수）。
- 影响：此前只能看到当日访问，无法评估推广渠道的**累计**带量效果。

**二、彻底移除推荐功能死代码（决策：推荐返佣不计划上线）**

按「留死代码 = 留意外」的原则，删除前逐一核实了调用链，确认无其他调用者后才动手：

- `public/index.html`：删除 `REFERRAL_ENABLED = false` 死分支与 `loadReferral()` 函数
  （调用链核实：`loadReferral` 全仓仅 1 处调用，即在死分支内 → 确认无用）。
- `server.js`：删除 `GET /api/me/referral` 路由（唯一调用者即被删的 `loadReferral`，删除后成孤儿）
  及 import 中的 `getReferralStats`。
- `src/auth.js`：删除 `getReferralStats()`（唯一调用者即上述路由）。
- 8 语字典：删除 `referral.*` 全部 11 键 + `admin.analytics.referralPaid`（合计 12 键/语，已验证 8 语键一致）。
- `admin.html`：删除 `Referral paid` 卡片（永久为 0 且功能不上线，属误导性指标）；
  接口同步移除 `referralPaid` / `referralPending` 字段与对应的 `referrals` 分组查询。

**保留（有意不动，非死代码）**：

- `signup.html` 的 `?ref=` 静默记录 + 注册时回传 `referralCode`（活跃链路，不展示任何承诺）。
- `registerUser` / `createOAuthUser` 写入 `referrals` 行、`recordReferralConversion`（Paddle webhook 调用，
  server.js:349/:526 活跃链路）与 `referrals` 表 / `users.referral_code` 列
  —— 保留作为注册来源沉淀；删除需改动注册与支付主链路，风险大于收益。

**三、文档同步**：`API-REFERENCE.md`（删端点 + 更新返回字段说明）、`ARCHITECTURE.md`
（架构图 `/api/me` 行、路由清单、推荐码模块说明、`referrals` 表说明）、`UI-DESIGN.md`（附加面板清单）。

**验证**：`dev_gate` 全绿；`server.js` / `src/auth.js` 语法校验通过；3 个页面内联脚本语法 0 错误；
8 语字典 JSON 合法且键完全一致（714 键）。

---

## 2026-09-15 · admin 分析区块不再被前置接口拖垮 + 移除推荐奖励承诺文案

> 起因：Martin 反馈「后台没看到你说的数据」。排查结论是**数据链路完全正常**——
> 直连生产库实测 `page_sessions` 有 53 条、当日 9 条；`/api/me`、`/api/admin/*` 7 个接口逐个实打**全部 200**；
> 库表列结构与代码期望逐一对账**全部匹配**。问题出在**页面呈现层**，故本次只做前端健壮性与信息架构修复。

**一、`load()` 串行链导致分析区块被「连坐」（真实缺陷）**

- 原 `load()` 是一条 `await` 串行链：`/api/me` → `/api/admin/stats` → `/api/admin/monitors` → `loadUsers()`
  → `loadActivity()` → `loadRanking()` → `/api/admin/feedback` → **最后才是 `loadAnalytics()`**。
  任一步抛错，后续全部不执行，而 `load()` 由 `(async()=>{ await loadI18n(); load(); })()` **不带 catch** 调用，
  失败只落成一条 unhandled rejection，页面上表现为**分析区块整片空白、且没有任何错误提示**。
  而 `loadAnalytics()` 内部原本又自带 `try/catch` + `return`，把自身失败也一起吞掉了。
- 改为：新增 `safe(label, fn, targets)`，7 个区块用 `Promise.all` **并行且互相隔离**加载；
  某块失败只在该块内显示可见错误（`admin.blockErr` + 具体 label 与 message），其余区块照常渲染。
- `loadAnalytics()` 移除内部吞错逻辑，交由 `safe()` 统一暴露；`byProvider` / `topCountries` / `newUsers30` / `revenue30`
  增加空值防御（`|| []`），避免单个字段缺失导致整块渲染中断。
- 顺带把 `load()` 内联的 stats / monitors / feedback 三段抽为 `loadStats()` / `loadMonitors()` / `loadFeedback()`。
  > 注：调用处写成 `() => fn()` 而非直接传函数引用——门禁的调用图按 `函数名(` 文本判定可达性，
  > 传引用会被判为「不在 i18n 钩子链里」而误报。此处写法是为通过 `i18n-动态重绘` 检查，非风格偏好。

**二、分析区块位置调整（信息架构）**

- `Owner analytics` 由页面**最底部**（需滚过用户表 / 活动表 / 排行表 / 监控表 / 反馈表）移至 `#app` **首块**，
  位于 `statsCards` 之上——它是站长打开后台的首要目的，不应被埋在底部。
- 新增 `#analyticsErr` 容器，专用于承接分析区块的加载错误提示。

**三、移除推荐奖励承诺文案（Martin 决策：推荐返佣不计划上线）**

- `public/signup.html`：删除 `#refHint` 元素及其在 `window.__afterLang` 中的渲染逻辑。
  原逻辑会在访客带 `?ref=` 进入时展示「好友可获得 **10% 奖励**」——而 `REFERRAL_ENABLED = false`，
  该承诺无法兑现。`captureRef()` 保留（仅静默记录来源，不再展示任何奖励措辞）。
- 8 个语言字典：删除 `signup.refHint` 键（`en/zh/es/pt/de/fr/ja/ko` 各 1 条）。
- 新增 8 语 `admin.blockErr` 键（加载失败提示，随第一项变更引入，按 i18n 铁律先补字典）。
- **未改动**：`index.html` 的推荐面板仍处于 `REFERRAL_ENABLED = false` 关闭态（该面板及其 `referral.*` 文案
  不会渲染给任何访客）；后端 `referrals` 表、`/api/me/referral`、webhook 提成记账逻辑均未触碰。

**四、影响范围**

- 行为变化：admin 页任一接口故障不再影响其它区块；分析区块可见性显著提升。
- 对访客可见变化：注册页不再出现任何推荐奖励承诺。
- 接口与数据库 schema **均未变更**。
- `tools/dev_gate.js` 门禁：全绿。

---

## 2026-09-15 · 前端埋点抽为共享文件 + 全站访客页覆盖

> 起因：Martin 指令「你现在就把它接上」。背景是一次误判排查——AI 一度判断「埋点链路断裂、`page_sessions` 恒空」，
> 后经线上 `curl` + 直连生产库实测**推翻该判断**：首页埋点一直在正常工作，数据库已有 51 条真实会话记录。
> 真正的问题是**覆盖面**，不是可用性。

**一、问题（实测确认）**

- 埋点脚本原本只内联在 `public/index.html`（原第 1800–1818 行），其余 9 个访客页面**完全未覆盖**。
- 后果：访客若直接落到 `/compare/uptimerobot` 等页面，访问不会被记录 → 渠道效果被系统性低估。

**二、变更**

- 新增 `public/analytics.js`：把内联实现抽为共享文件。行为与逻辑与原实现等价（sessionStorage 一次性 id、无 cookie），
  并把上报方式升级为 **`sendBeacon` 优先、`fetch` + `keepalive` 兜底**（页面卸载时更不易丢包）。
- `public/index.html`：删除内联 IIFE，改为 `<script src="/analytics.js"></script>`（单一实现，避免两份拷贝漂移）。
- 8 个访客页在 `</body>` 前引入：`compare-uptimerobot` / `signup` / `signin` / `status` / `terms` / `privacy` / `refund` / `reset-password`。
- **`admin.html` 刻意不引入**：站长自身浏览会污染统计数据。

**三、顺带修复（门禁既有 FAIL，非本次引入）**

- `public/signup.html`：`captureRef()` 内用 `t()` 拼 `#refHint`，但不在语言切换钩子链里 → 切换语言后提示停留旧语言。
  已将渲染移入 `window.__afterLang`，`captureRef` 只负责写入 localStorage。**文案未改动。**
- `tools/dev_gate.js` 门禁：1 项 FAIL → 全绿。

**四、影响范围**

- 行为变化：9 个页面的访问开始计入 `page_sessions`；`admin.html` 不计入。
- 数据影响：`Sessions today` / `Top countries` 覆盖面扩大；此前仅首页有数据。
- 接口与数据库 schema **均未变更**（`docs/API-REFERENCE.md` 无需更新）。

**关联**：`PROMO-PLAN.md`

---

## 2026-09-15 · 开源前内部文档移出 + 公开仓库准备

> 决策：Martin 确认按 `方案资料\uptime-monitor\OPEN-SOURCE-PLAN.md` 执行开源（**AGPL-3.0**）。

**一、三份内部文档移出代码仓（→ 方案层 `方案资料\uptime-monitor\`）**
- `PROJECT-RETROSPECTIVE.md`（全盘复盘：踩坑案例台账、商业策略推演、外部服务清单）
- `docs/DEV-PLAN.md`（功能路线图 + 定价档位 + 收款通道切换史）
- `docs/PRD-首页UI改版.md`（UI 改版专项 PRD）
- 依据：`docs/README.md` 自定的两层边界本就把「PRD / 开发计划 / 项目复盘」划归方案层；对外公开无收益，且暴露未发布规划与商业策略。

**二、同步修正仓库内交叉引用（7 处，消除断链）**
- `docs/ARCHITECTURE.md`（决策史）、`docs/CODE-STANDARDS.md`（头部关联 + 注释规范）：`PROJECT-RETROSPECTIVE.md` 引用 → 改为「方案层复盘文档，不随本仓库公开」
- `docs/UI-DESIGN.md`（关联栏）：移除 `PRD-首页UI改版.md` 引用
- `docs/README.md`：文档矩阵删除 DEV-PLAN 行；「两层边界」与「文件归属说明」把「开发计划 / 项目复盘」补入方案层清单；阅读路径改为以 `src/plans.js` 为档位唯一权威源
- `src/plans.js`（头部注释）：由「与 DEV-PLAN.md §3 一致」改为「本文件为唯一权威源」

**三、公开仓库准备**
- 本地仓库改为**单次初始提交**（`git checkout --orphan`）：原 81 条提交历史已把上述两份文档纳入，`git rm` 无法清除历史版本，故新起无父分支；**原历史完整保留在本地 `archive-full-history` 分支**，未丢弃。
- 受跟踪文件：**69 → 66**；`.env` / `.workbuddy/` / `.pw-browsers/` / `node_modules/` / `preview/` / `tools/cloudflared.exe` 全部仍在 `.gitignore` 保护下，未入库。

**关联**：`OPEN-SOURCE-PLAN.md`、`PROMO-PLAN.md`

---

## 2026-09-15 · 全量代码审查修复（10 项 + 1 项额外发现）

> 起因：Martin 要求「重新完整检查一遍所有代码，涵盖每一处逻辑与文件」，随后指令「可以动手修，同类型内容放在一个文件里，尽量不要新建文件」。
> 审查报告：`方案资料\uptime-monitor\CODE-REVIEW-2026-09-15.md`（**放在方案层，不进代码仓**，保持公开仓库干净）。

**一、安全（P0-1 · 存储型 XSS）**
- `public/status.html`：监控列表的 `m.name` / `m.url` 直插 `innerHTML`，**未调用同文件已定义的 `escapeHtml()`**（而同文件的事故时间线却用了）→ 付费用户可把监控名设为 `<img src=x onerror=...>`，**任何未登录访客**打开 `/status/<slug>` 即触发。已改为 `escapeHtml(m.name)` / `escapeHtml(m.url)`。
- 数据链复核：`POST /api/monitors`（`server.js:860`）仅做 `String(name).trim()` 不做转义，`GET /api/status/:slug` 原样透传 `{...m}` —— 故必须在前端出口转义。`m.status` 经核实**不可被用户设置**（`PATCH` 白名单不含 status），保持原样。

**二、自部署可用性（P0-2 · `.env.example` 与生产事实脱节）**
- 问题：模板仍以 **Paddle 为主**、**全文无 Creem**，与「Creem 唯一生产通道、Paddle 降 dormant」的既定决策相反；且**缺 8 个代码实际读取的变量**（`PAYMENT_PROVIDER` + 7 个 `CREEM_*`）与探针两项（`PROBE_PORT` / `PROBE_REGION_NAME`）。
- 风险：代码默认值 `PAYMENT_PROVIDER || 'paddle'`（`server.js:431`）→ **自部署者照抄模板会永远走在 Paddle 降级分支上**。
- 修复：`PAYMENT_PROVIDER` 提升为显式开关并加粗警示；新增 Creem 段（7 项）；Paddle 段降为「备用通道，不用可整段删除」；新增探针节点三项；删除代码**从不读取**的 `PADDLE_VENDOR_ID`；删除指向不存在文件的 `docs/PAYMENTS-SETUP.md` 引用。**现覆盖全部 39 个环境变量，零缺失零冗余。**

**三、链接与锚点**
- **`#pricing` 锚点从不存在**（真实定价区 id 是 `#plans`）→ 3 处「Pricing」链接长期失效：`index.html` 页脚、`compare-uptimerobot.html` 页脚、**`terms.html` 法务页正文**（合规页面跳转失效）。全部改为 `/#plans`。`git log -S` 确认为长期存在，非本次引入。
- **仓库内死链与本地绝对路径**：`docs/ARCHITECTURE.md` / `docs/CODE-STANDARDS.md` 引用的 `TECHNICAL.md`（不存在于仓库，属方案层）改为指向当时的仓库内复盘文档；`tools/verify_deploy.js` 注释同步；`docs/DEV-PLAN.md` 头部改为不再给出方案层文件的链接；`docs/DEPLOYMENT.md` 的 `rsync` 示例、`docs/README.md`、`docs/CODE-STANDARDS.md` 里的本地绝对路径全部改为相对描述。（注：当日稍后三份内部文档按开源决策移出仓库，上述指向复盘文档的引用已同步改为「方案层，不随本仓库公开」。）
- `docs/CHANGELOG.md` / `docs/README.md` 新增说明：历史条目引用的 `MARTIN-TODO.md`、`DEV-WORKFLOW.md`、`UM-MVP-TECH.md`、`PAYMENTS-SETUP.md` 等属**方案层/流程层文档，不在本仓库内、不随开源公开**，历史条目按原样保留不改写。

**四、文档 ↔ 代码一致性**
- `docs/API-REFERENCE.md`：**删除从未实现的 `GET /api/monitors/:id`**（该路径代码只有 `PATCH`/`DELETE`，`git log -S` 为空，前端也从未调用），并加注说明；版本升 v2.1；头部补充 `/api/creem-config` 为免登录端点；标注 `server.js` 实际端点总数为 **80**（原写 57，长期陈旧）。
- `docs/DEPLOYMENT.md`：**环境变量清单补齐 19 项**并改为 Creem 优先（含 `PAYMENT_PROVIDER` 默认值警示）；新增「Creem Webhook 生产配置」（含代码实际处理的 7 类事件名，与 `server.js:544-557` 逐一对齐），原 Paddle 段降级为 7.2 备用通道；环境清单表的邮件/支付行、故障排查表现已全部按 Creem + Resend 更新；章节 `11 → 13 → 12` 乱序修正为 `11 → 12 → 13`；版本升 v1.1。
- 文档标题统一：`docs/README.md` / `docs/API-REFERENCE.md` / `docs/DEV-PLAN.md` 头的 "Uptime Monitor" → **Pingory**。

**五、前端健壮性（P1）**
- **`--danger` CSS 变量从未定义却在使用**：`index.html` 用 13 次、`signin.html` 用 1 次（只有 `reset-password.html` 定义过）→ 所有错误提示文字拿不到红色。已按 `reset-password.html` 的既有取值在 `:root`（`#e5484d`）与暗色块（`#ff6b6b`）补上定义。
- `index.html` 自助面板监控列表 `${m.name}` / `${m.url}` 未转义（自伤型，风险低）→ 补 `escapeHtml()`。
- `admin.html` 活跃用户榜 `${u.action_types}` 未转义（服务端聚合值，风险极低）→ 补 `esc()`。

**六、【额外发现 · 不在原报告内】用户可见告警标题品牌名错误**
- `src/alerts.js` 的用户可见标题写的是 "**Uptime Monitor** DOWN / STILL DOWN / RECOVERED / WARNING / 月度报告"，而 `src/email.js` 同一类通知用的是 "Pingory" → **客户收到的告警邮件主题与产品名不一致**（项目改名后的遗留）。
- 已统一为 **Pingory**（5 处）；`server.js` 启动日志同步。

**影响范围**：前端 5 个 HTML、后端 2 个 JS（仅字符串与转义，**无业务逻辑变更**）、文档 6 篇、环境变量模板 1 份。
**验证**：`node --check` 全过 · `tools/dev_gate.js` 全过 · 已部署 Fly.io（nrt 双机）· 线上复验通过。

---

## 2026-09-15 · 开源发布准备 + SMS 正式取消 + 法务页支付商纠正

> 起因：Martin 拍板「① 项目确定开源；② SMS 功能暂时不做（需注册美国公司）；③ 完成后启动健康管家角色」。

**一、开源落地（项目正式开源）**
- 决策 **D38**：Pingory 开源，许可 **AGPL-3.0**（依 Martin 2026-09-14 22:44 既有拍板，见 `方案资料/uptime-monitor/OPEN-SOURCE-PLAN.md` 与 `PROMO-PLAN.md` §八）。
- 新增 `LICENSE`（**GNU AGPL-3.0 全文**）、`README.md`（项目说明 + Docker / 裸机两套自部署指南 + 环境变量说明 + 多区域探针说明）。
- `package.json`：`name` 改 `pingory`，补 `license: AGPL-3.0-only` / `description` / `homepage` / `engines.node>=18` / `keywords`，新增 `npm run gate`。
- **修 `docker-compose.yml` 一个真实缺陷**：原文件号称「一条命令起全部」，但**没有数据库服务** → 照 README 执行必然连不上库。现补内置 `postgres:16-alpine`（`pgdata` 卷 + `pg_isready` 健康检查 + `depends_on: service_healthy`），并在 `app` 注入 `DATABASE_URL` 默认值（`.env` 里显式设了外部库则优先用外部库）。
- `.env.example`：头部改为 Pingory 并标注「自部署最小配置只需两个 secret、支付变量可全空」；数据库段改为「用自带 Postgres 可整行注释」。
- **迁移前核查**：`.env` 从未被 git 跟踪（`.gitignore` 早已排除）；全量扫描 67 个受跟踪文件，**无真实密钥**（均为 `xxx` 占位）。

**二、SMS 功能正式取消**
- **原因**：SMS 通道需**美国实体主体**（Twilio 合规与资费要求），当前阶段不投入。属「不做」，非「后置」。
- `public/refund.html`：**删除第 5 条「SMS / Top-up Credits」**（对外的虚假承诺——SMS 从未实现，却写了充值条款），原第 6 条顺延为第 5 条。
- `docs/DEV-PLAN.md`：删「SMS 预充值 $0.03/段」条目（标注已取消）、删渠道表 `SMS / 语音电话` 行、范围外章节改为「决策取消」。
- `docs/ARCHITECTURE.md`：残余未落地项移除 `SMS(Twilio)`，改为标注已决策取消。
- `PROJECT-RETROSPECTIVE.md`：C 组待办移除「SMS 美国实体号」。
- **代码零改动**：核查确认 `src/plans.js` 的渠道矩阵与 `src/alerts.js` 的 `dispatch` 从未包含 SMS，故无代码需删。

**三、法务页支付商纠正（Paddle → Creem）**
- **问题**：`public/refund.html` §1 与 `public/terms.html` §5 均写「Paddle, our Merchant of Record」，但线上 `/api/creem-config` 返回 `{"active":true,"environment":"live"}`、`/api/paddle-config` 仍为 `sandbox` → **生产实际走 Creem**，法务页对客户陈述了错误的收款主体。
- **修复**：两处改为 Creem（Creem 依其 Merchant Terms 亦为 merchant of record / legal seller of record）。`terms.html` 追加一句：源码以 **AGPL-3.0** 发布，本条款仅约束 pingory.com 托管服务，不减损该许可下的权利。
- 两页 `Last updated` 更新为 2026-09-15。

**四、隐私脱敏**
- `public/.well-known/security.txt`（**线上公开文件**）的 `Contact` 由个人 Foxmail 改为 `martin@pingory.com`。
- `docs/CHANGELOG.md`、`PROJECT-RETROSPECTIVE.md` 中的个人邮箱一并脱敏为通用描述。

**五、许可证纠正（MIT → AGPL-3.0）**
- **问题**：本次落地时误将许可证定为 **MIT**（AI 自行研究后推荐，未先检索既有决策记录），而 Martin 已于 **2026-09-14 22:44 拍板 AGPL-3.0**（见 `OPEN-SOURCE-PLAN.md` 头部与 `PROMO-PLAN.md` §八）。属**违背既有决策**，非选项变更。
- **纠正**：`LICENSE` 换成 **GNU AGPL-3.0 全文**（gnu.org 官方文本，34,523 字节）；`package.json` → `AGPL-3.0-only`；`README.md` 许可节与首屏「Self-hosted」行改写为 AGPL-3.0（含 §13 网络服务须提供修改后源码的说明 + 托管服务为开发资金来源）；`public/terms.html` 许可句改为 AGPL-3.0。
- **教训（已固化全局规则）**：改协议/许可等既有决策类事项前，**必须先检索方案层与决策日志**，不得凭"档案没看到"就自行拍板；**档案无记录 ≠ 决策未作出**。
- **连带待办**：AGPL §13 要求网络服务使用者可获取源码 → **官网页脚需加 GitHub 仓库链接**（仓库公开后执行）。

**六、隐私与陈旧事实补修**
- `docs/DEPLOYMENT.md` SMTP 示例 `smtp.aliyun.com` → 通用占位（生产发件实为 Resend `alerts@pingory.com`，原示例既陈旧又暴露具体服务商）。
- `PROJECT-RETROSPECTIVE.md` 中「转发 foxmail」→ 通用表述。

- **影响范围**：文档、法务页、部署配置与许可证；**服务端代码无逻辑改动**（`server.js` 未动）。
- **待办（Martin）**：① 创建公开仓库并推送；② 仓库地址确定后：把「开源 + 自部署」卖点补进对比页 8 语 + **官网页脚加 GitHub 链接**（AGPL §13 合规要求）；③ 复核 `terms.html` 第 3 条「禁止反向工程」在开源后是否仍适用；④ 决定 `PROJECT-RETROSPECTIVE.md` / `docs/DEV-PLAN.md` / `docs/PRD-首页UI改版.md` 三份内部文档是否移出代码仓（`OPEN-SOURCE-PLAN.md` 已建议移出）。

---

## 2026-09-14 夜 · SEO 对比页上线（Pingory vs UptimeRobot，8 语）

> 起因：Martin 要求把「Pingory vs UptimeRobot 2026 真实对比」落成 pingory.com 下的**独立内容页**，长期承接 "UptimeRobot alternative" 等搜索流量；并明确「对比页需要把多语言准备好」。

- **新增页面**：`/compare/uptimerobot`（英文规范地址）+ `/{zh|es|pt|de|fr|ja|ko}/compare/uptimerobot`（7 语路径）。
  别名 `/vs/uptimerobot` 与直链 `/compare-uptimerobot.html` 均 **301** 到规范地址（防重复内容）。
- **多语言 SEO 实现**：模板单文件 `public/compare-uptimerobot.html`，服务端读取后替换 `__CMP_LANG__` / `__CMP_CANONICAL__` →
  `<html lang>`、`canonical`、8 条 `hreflang`（含 `x-default`）**全部为静态 HTML**，不依赖 JS 渲染即可被搜索引擎识别。
- **文案 i18n**：新增 `cmp.*` 命名空间 **100 键 × 8 语**（含 `nav.compare` / `footer.compare`），字典 624 → **724 键/语**。
  正文用 `data-i18n` 静态渲染（不是 JS 生成），Google 可直接抓取；`data-i18n-content` 用于 meta description / og 标签。
- **页内语言切换**：切换语言 = 整页 URL 跳转，保证「URL 语言 == 内容语言」，便于各语言分别收录。
- **结构化数据**：`FAQPage` + `BreadcrumbList` JSON-LD；`og:*` 齐全。
- **首页入口**：落地页定价区下方加 `Compare with UptimeRobot →` 内链；全站页脚加 `Compare` 链接。
- **门禁加固**：`tools/dev_gate.js` 的 i18n 属性扫描补 `data-i18n-content`（此前只扫 `-ph`/`-title`，meta 类键会逃逸）。
- **影响范围**：仅新增页面与静态路由；不改动任何既有 API 与页面行为。`server.js` 新增 `fs`/`path` 导入。
- **同步**：`docs/API-REFERENCE.md` §5 / §8.1（路由与实现要点）。

**上线后补强（同日，`3d6cf17`）**：
- **问题**：首版只把 `<html lang>`/`canonical`/`hreflang` 做成静态，**正文仍靠前端 JS 换字** → 部署后复验发现 `/{lang}/...` 的**原始 HTML 的 title/H1/description 全是英文**，`<html lang="de">` 配英文正文自相矛盾；不执行 JS 的爬虫（Bing / 社交 / 多数 SEO 工具）会把 8 个语言页都判为英文，多语言 SEO 形同虚设。
- **修复**：`server.js` 新增 `cmpLocalize` —— 服务端读对应语言字典**就地替换** `data-i18n` 的 inner HTML、`data-i18n-content` 的 `content` 属性，**保留 `data-i18n` 属性**（前端切语逻辑不受影响）。注入用函数式 `replace`（防译文含 `$&` 被当替换模式）；译文裸 `&`→`&amp;`，但不整体转义 `<`（字典刻意含 `<strong>`）。结构前提：`data-i18n` 节点不得同名标签嵌套（已扫 110 节点 / 0 嵌套）。
- **验证**：8 语**原始 HTML（无 JS）**逐一断言 title/H1/description 已本地化、标签数与 `data-i18n` 属性数与英文基线一致（463/463、110/110）、模板自带 `<script>` 逐字节不变、无占位残留 → 0 失败；真机回归新增 7b「静态可抓」段 → **96/0** 通过；线上 pingory.com 8 语复验 0 失败。
- **状态**：已部署（`447908a` + `3d6cf17`，nrt 双机），线上 `/compare/uptimerobot` + 7 语路径 + 2 条 301 别名 + 首页 2 处内链全部复验通过。
- **决策**：D37（`创业助手/startup-project.md`）。

---

## 2026-09-14 夜 · 邮件告警收件人修复（去掉全局个人邮箱）

> 起因：Martin 反馈「个人邮箱仍能收到报警邮件」。

- **根因**：`src/alerts.js` 的 email 渠道恒发往全局 `ALERT_TO_EMAIL`（单用户期遗留），导致**所有账号**的监控告警都进同一个个人邮箱；同文件早已取好 `userEmail` 却从未使用（半成品代码）。
- **修复**：邮件告警改为发往「监控归属账号」的注册邮箱（`dispatch(monitor, plan, title, text, extra, accountChannels, emailTo)`）；归属账号无邮箱时跳过并打印日志，**不再回退到任何固定个人邮箱**；删除 `EMAIL_RECIPIENT` 常量。
- **保留**：`ALERT_TO_EMAIL` 仅用于「客户反馈通知」（`src/email.js` —— 匿名访客反馈需要固定的管理员收件人）；`.env` / Fly secret 的值由个人邮箱换为 `martin@pingory.com`。
- **影响范围**：所有套餐的 email 告警。其余渠道（Slack/Webhook/Telegram/Discord/Teams/PagerDuty）与状态页订阅者通知不受影响。
- **同步**：`docs/API-REFERENCE.md` 渠道表、`.env.example`、`docs/DEPLOYMENT.md` 注释。

---

## 2026-09-14 晚 · 多语言遗漏全面修复（动态区 + 错误码 + 轮询状态）

> 起因：Martin 切到西班牙语后发现新增的「告警渠道」区整块仍是中文。按要求「检查一遍所有多语言位置」，同轮共发现并修复 4 处同类缺陷 + 2 处连带缺陷。

- **动态区随语言重绘（P0-7）**：`public/index.html` 的 `window.__afterLang` 补齐 `renderChannels()`（本次报告的问题）、`renderMonitors()`、`refreshPlanInfo()`、`redrawMonitorExtras()`、`loadStatusPage()`；新增弹窗重建注册表 `OPEN_MODAL`（`showAlert/showConfirm/showPrompt/openAccountSettings/openImportModal` 注册重建函数，重建前快照并回填输入框、恢复账户设置分区）。
  - 影响范围：8 语言下切换语言后，告警渠道区、监控列表、套餐用量行、已展开的历史/趋势、状态页开关条、打开中的弹窗全部跟随重绘。
- **重置密码页副标题恒为英文**：`public/reset-password.html` 的 `#sub` 原先在脚本顶层直接调 `t()`（早于 i18n 加载）；抽成 `renderSub()` 并挂进 `applyI18n`。
- **重复初始化**：移除 `public/index.html` 中遗留的早期 `mountFeedbackWidget(); handleVerifyParam(); checkAuth();`（与文件末尾 `startApp()` 重复 → 验证链接会被请求两次，第二次报 token 失效；登录态与监控列表也各拉两遍）。
- **检查失败原因错误码化**：新增 `src/monerr.js`（17 个错误码，单一事实源）；`src/monitors.js` 不再写中文句子，改存 `code|detail`；`public/index.html`、`public/status.html` 用 `fmtMonitorError()` 按语言翻译；`src/alerts.js` 用 `monErrText()` 输出可读英文给邮件/Slack/Webhook/Telegram/Discord。
  - 影响面：仪表盘监控列表 `lastError`、事件历史 `error`、**公开状态页 incidents[].error**（原先英文/西语用户会看到中文）。库中历史数据经核查无中文串，无需迁移。
  - 顺带：`POST /api/status/:slug/subscribe` 的裸中文 404 改为错误码 `status_page_not_found`。
- **轮询清空已展开面板**：`loadMonitors` 每 5 秒整体重建 `#monList`，用户点开的「历史 / 趋势」会在 5 秒内消失；`renderMonitors` 末尾改为调用 `redrawMonitorExtras()` 从缓存恢复。
- **Pro 套餐上限显示 `Infinity`**：套餐用量行改用 `∞`（与落地页一致）。
- **i18n 字典**：+17 键 × 8 语 = 624 键 parity（`monerr.*`）。
- **门禁加固**：`tools/dev_gate.js` 新增 `i18n-动态重绘`（语言切换钩子调用链覆盖扫描，负向自测已验证会 FAIL）与 `i18n-硬编码中文`（public/ 注释外出现中文即 FAIL）。
- **真机回归脚本固化**：`tools/i18n-lang-check.cjs`（36 项断言：非中文语言下页面无中日韩文字 + 动态区逐项覆盖 + 错误码翻译 + 轮询后展开态保持）。
- **文档**：`docs/API-REFERENCE.md` → v1.9（新增「检查失败原因错误码」章节 + subscribe 404 错误码）。

## 2026-09-14 · 密码可见性切换 + 孤儿监控根因修复

- **密码框「眼睛」按钮**：`public/signin.html` / `public/signup.html` / `public/reset-password.html` 引入共享脚本 `public/pw-toggle.js`，自动为页面上所有 `input[type=password]` 注入可见性切换按钮（点击在明文/密文间切换，图标与 `aria-label` 同步，随浅/暗主题变色）。
  - 实现要点：按钮必须 `type="button"`（否则点一下就把表单提交了）；图标按钮宽度显式 `42px` 且 `min-width:0`（避免被全局 `input` / `button` 宽度规则撑开 —— 本项目已两次踩 `min-width` 优先级坑）；`.pw-wrap` 包裹层不改变输入框原有宽度。
  - i18n 新增 `pw.show` / `pw.hide`（8 语真实译文），全语言 **607 键 parity**；语言切换后由页面 `applyI18n()` 调用 `window.__pwToggleRefresh()` 刷新按钮文案。
- **孤儿监控（管理后台显示「匿名」）根因修复**
  - 现象：管理后台「全部监控」出现一条 `owner = 匿名` 的监控 `https://probe2.example.com/`。
  - 根因：`monitors.user_id` 自加入起一直是**裸列、无外键约束**；所有者账号被删除后（如验证 / 测试账号清理），监控行残留 → `LEFT JOIN users` 取不到邮箱 → 前端回退显示 `admin.anon`（匿名）。**并非未鉴权创建** —— `POST /api/monitors` 第一步就是 `401 auth_required`。
  - 修复：① `src/db.js` 启动迁移新增**孤儿监控清理**（删除 `user_id` 非空但已无对应用户的行）；② 幂等补外键 `monitors_user_id_fkey ... ON DELETE CASCADE`（`DO $$` + 独立 try/catch，加不上也不拖垮启动）。此后删除用户自动级联删监控，孤儿不再产生。
  - 已对生产库执行清理（删 1 条孤儿）并装外键；用「建临时用户 → 建监控 → 删用户 → 监控消失」事务测试验证级联生效（回滚，零残留）。
- **验证**：`node --check`（server.js + src 模块 + pw-toggle.js）、8 语 parity（607 键）、`dev_gate` 9 项全过；**真机 Edge 测试 36 项断言全绿**（3 个页面：按钮数量 / 初始密文 / 明文切换 / 图标与 aria-label 切换 / 切中文后本地化 / 不触发表单提交 / 包裹层不破坏宽度 / 0 控制台错误）。
- **影响范围**：登录 / 注册 / 重置密码页 UI；数据库 `monitors` 表约束；管理后台监控列表数据。

---

## 2026-09-14 · 账户级告警渠道凭据（Plan A，已上线）

- **动机**：告警渠道凭据（Slack / Telegram / Webhook 等）原先放在**每个监控的添加表单**里 → 加 N 个监控要重复贴 N 次。竞品（UptimeRobot「My Alert Contacts」、Healthchecks「Integrations」）做法是**账户级配一次 + 每个监控勾选**。Martin 拍板采用 Plan A。
- **后端**
  - 新增 `users.alert_channels` 列（JSON）。`src/auth.js` 新增 `getAlertChannels` / `saveAlertChannels`，**单独存取、不并入 `rowToUser`**，避免凭据泄漏进 `/api/me`、管理后台用户列表等响应。
  - 新增 3 条端点（`docs/API-REFERENCE.md` §7.6）：`GET /api/account/channels`、`POST /api/account/channels`（整体覆盖、按套餐过滤、字段白名单去空）、`POST /api/account/channels/test`（测试发送，**直接读下游 HTTP 状态判定成败**，可带未保存的 `config` 临时测试）。
  - `src/alerts.js`：`resolveChannels(monitor, plan, accountChannels)` 把**账户级凭据与监控开关合并**；同名字段以监控级优先 → **存量监控自带凭据的老数据行为完全不变**。新增 `channelCredOk()`，**缺凭据的渠道跳过并记日志**，不会因某个渠道配置不全而让整次告警失败。`dispatch` 增加 `accountChannels` 形参（4 处调用同步）。新增导出 `sendTestAlert`。
  - 新增错误码 `channel_not_supported` / `channel_not_configured`（8 语译文）；错误码总数 36。
- **前端 `public/index.html`**
  - 账户设置弹窗新增「告警渠道」面板（每个套餐内渠道一组输入 + 「发送测试」+ 底部「保存全部渠道」）；OAuth 用户的分段选择器现为 4 段。
  - 监控添加表单的渠道区**只渲染复选框**：**已配置 → 默认勾选；未配置 → 禁用并给出「去配置」链接 + 提示**，从根上杜绝「勾了但没凭据」的静默失效。
  - 渠道凭据输入标签不再重复渠道名（渠道名已是卡片标题），改为通用「URL / 地址」（新键 `chan.url`）。
- **i18n**：8 语各新增 14 键（`ac.channels*`、`chan.notConfigured/configure/acctHint/noneInPlan/saveAll/saved/test/testSent/needCred/url`、`err.channel_*`），全语言 **605 键 parity**。
- **文档**：`API-REFERENCE.md` 升 v1.8（§3 channels 章节按 Plan A 重写、新增 §7.6、错误码清单 34→36）；顺带**更正 v1.7 及更早文档的错误**——slack/discord/teams 写 `webhookUrl`、pagerduty 写 `integrationKey`，与代码不符，实际统一读 `cfg.url`。
- **验证**：`node --check`、内联脚本语法、8 语 parity、`dev_gate` 9 项全过；`resolveChannels`/`normalizeChannelCfg` 16 项单元断言（含老数据覆盖、缺凭据跳过、套餐过滤）；**线上 API E2E** 12 项（含 free 过滤 / starter 落库 / 未配置渠道 400 / 不可达 URL 真实失败 / 监控只存开关）；**真机 Edge 全流程**（登录 → 账户面板中文 → 保存 → 表单只勾选 → 裸域名添加监控成功），无 JS 报错。
- **影响范围**：告警渠道配置方式（行为兼容）、账户设置 UI、API 新增 3 端点。

---

## 2026-09-13 · 多语言漏译大扫除（二）：账户页 / 管理后台 / 账单 / 页脚 / 状态页 + 门禁加固（commit `e314fa2`，已上线）

- **现象**：Martin 上线后浏览发现（1）退出登录左侧的账户按钮始终英文；（2）管理后台链接在部分语言不跟随切换。复查后确认远不止两处。
- **根因**：P0-3 新增的 39 个键只填了中文与英文，**es/pt/de/fr/ja/ko 六语全部沿用英文值**（`nav.account`、`ac.*` 23 键、`reset.*` 13 键、`signin.forgot`）；另有 `admin.link` 在 es/pt/de/fr 未译；并存在**从未定义**的引用键（`signin.or`、`signup.or`、`signup.refHint`、`status.allOk/partial/major/nomon/incDown/incUp`）与**从未国际化**的静态文案（账单切换 Monthly/Annual/Save 2 months + `billed {yr}/yr` 拼接、页脚 Terms/Privacy/Refund/Pricing/Contact/版权、状态页事故时间线、各页 `<title>`）。
- **修复**：
  - 8 语字典全量补齐至 **557 键 parity**（新增 `billing.*`、`footer.*`、`status.timeline`、`meta.title.*`、`status.allOk` 等 27 键；补齐 60+ 键的 es/pt/de/fr/ja/ko 译文）。
  - `public/index.html`：按 Martin 建议**移除退出登录左侧账户按钮**（账户入口保留在顶栏「账户」）；账单区、页脚、`applyBilling()` 动态拼接全部接入 i18n；顶栏「账户」「管理后台」动态元素补 `data-i18n` 作语言切换双保险。
  - `public/status.html`：事故时间线标题接入 i18n；`public/admin.html`：18 个活动类型筛选 `<option>` 接入 i18n。
  - `public/signin.html|signup.html|reset-password.html`：`<title>` 改用带品牌的 `meta.title.*`。
- **门禁加固 `tools/dev_gate.js`**：
  - `i18n-缺键` 扫描范围由仅 `t('key')` **扩展到 `data-i18n(-ph/-title)` 属性**（`signin.or`/`signup.or` 即因此前漏检而逃逸）。
  - **新增 `i18n-未翻译`**：某键在 6 个非英文语言中值全部等于英文即 FAIL（品牌/协议/价格白名单豁免），专防"新增键但六语全填英文"的静默漏译回归。
  - i18n 检查触发条件扩展为 HTML **或** i18n JSON 变更均执行（此前仅 HTML 变更时执行）。
- **影响范围**：全站 8 语 UI 文案（主站/登录注册/重置密码/公开状态页/管理后台）。
- **验证**：门禁 7 项全过；8 语各 557 键 parity；线上冒烟 `/health` ok、首页·登录·重置·管理后台均 200、ja/ko/zh 字典实拉校验译文正确。

---

## 2026-09-13 · P0-3 账户自助管理闭环：改昵称 / 改密码 / 忘记密码 / 改邮箱 / OAuth 设密码（commit `95519f5` + 审查修复 `267a7b3`，已上线）

- **现象**：Martin 登录后反馈「没有个人账户页面，无修改个人信息 / 修改密码功能」。核对后发现账户生命周期必备项全部缺失（收尾验收漏了"账户自助"维度）。
- **修复**：
  - 后端 `src/auth.js`：新增 7 个函数 `changePassword` / `setPassword` / `updateProfileName` / `requestEmailChange` / `confirmEmailChange` / `requestPasswordReset` / `resetPassword`；`rowToUser` 增加 `hasPassword` 区分密码用户与 OAuth 用户；复用既有 `verify_token` / `VERIFY_TTL_MS`(24h)。
  - `src/email.js`：新增 `sendPasswordResetEmail` / `sendChangeEmailVerification`（复用既有邮件模板风格）。
  - `src/db.js`：`users` 增加 `pending_email` 列（`ALTER ... IF NOT EXISTS`），改邮箱流程暂存待验证新邮箱。
  - `server.js`：新增 6 条路由 `/api/account/change-password` / `/api/account/profile`（改昵称 + OAuth 设密码） / `/api/account/change-email` / `/api/account/confirm-email` / `/api/auth/forgot-password`（统一响应不暴露账号是否存在） / `/api/auth/reset-password`。
  - 前端 `public/index.html`：登录后顶栏「账户」按钮 → `openAccountSettings` 弹窗（改昵称 / 改密码 / 改邮箱三段；OAuth 用户显示「设置密码」）；`startApp()` 处理 `?confirmEmail=` 自动完成邮箱验证并清参。
  - `public/signin.html`：表单下方加「Forgot password?」入口；`public/reset-password.html`：新建重置页（有/无 token 两态 + 8 语 + 暗色）。
  - i18n：8 语补 39 键（`nav.account` / `ac.*` / `signin.forgot` / `reset.*`），8 语 JSON 均达 531 键、全 parity。
- **安全**：改密码须验旧密码；忘记密码 / 改邮箱统一返回不暴露账号是否存在或是否密码账号；OAuth 用户 `password_hash=NULL`，须先 `setPassword` 才能密码登录。
- **文档**：`docs/API-REFERENCE.md` §7.4 补 `pending_email` 字段、§7.5 新增账户自助端点段。
- **验证**：`node --check` 后端 4 文件全过；dev_gate 全套机检通过（i18n 8 语 parity / API-契约同步 / PAY-登录态 / UI-一致性 / 顶栏 flex 布局）。
- **上线前全面审查（2026-09-13 傍晚，commit `267a7b3`）**：发现并修复 9 项——P1 setPassword 越权绕过（密码用户可绕过旧密码校验直接设密，改为仅 OAuth-only 可设密）；P1 confirm-email 唯一性竞态（确认时复检，被占清 pending 令牌友好报错）；P1 password_hash NOT NULL 迁移缺失（前置遗留：createOAuthUser 插 NULL 但无 DROP NOT NULL，全新库 OAuth 必崩，db.js 已补幂等迁移）；P2 新增 pwLimiter(5次/时/IP) 挂 forgot/reset-password + change-password 挂 authLimiter；P3 昵称截断 100 字符 / 拦截新邮箱=当前邮箱 / OAuth 设密后禁用按钮防重复点击崩 / 文档删不实 sent 标志。复验（node --check + dev_gate 全套）通过后 flyctl deploy 双机上线。
- **部署状态**：✅ 已上线（2026-09-13 傍晚，双机 nrt started v77；/health ok、首页/重置页 200、forgot-password 防枚举统一响应正确）。
- **踩坑备忘（收尾铁律补全）**：Web/SaaS 产品收尾前必须走"账户生命周期完整性验收"——注册 → 登录 → 改昵称 → 改密码 → 忘记密码 → 改邮箱 → OAuth 设密码，任一缺失即 blocker。本次因"特性驱动开发"盲区 + 收尾清单缺该维度而漏做，已固化为全局/STATUS 收尾门禁。

## 2026-09-07 · i18n 漏译大扫除：导入弹窗 / 推荐 / 团队 / OAuth 按钮 / 后台筛选器（commit `361c429`）

- **现象**：Martin 截图反馈「导入监控」弹窗底部 Cancel / Import 按钮始终英文；进一步扫描发现同类漏译散布在推荐面板、团队面板、OAuth 按钮、管理后台筛选器。
- **根因**：代码里已用 `t('key','English fallback')` 调用，但 8 语 i18n JSON 字典缺失对应 key；t() 找不到 key 时 fallback 英文，切换语言无效。
- **修复**：
  - import 段补 10 键：format / ph / cancel / go / fail / done / skipped / empty / fmtCsv / fmtJson。
  - referral 段补 5 键：loading / none / copy / copied / copyfail。
  - team 段补 2 键：title / loading。
  - signin/oauth 段确认并补齐 2 键：signin.oauthGoogle / signin.oauthGithub。
  - index.html：升级引流条 Dismiss 按钮改 `t('upgrade.dismiss')`；导入下拉 Generic CSV/JSON 改 `t('import.fmtCsv')` / `t('import.fmtJson')`。
  - signin.html / signup.html：Google/GitHub OAuth 按钮加 `data-i18n`。
  - admin.html：套餐/角色筛选器 option 加 `data-i18n`。
- **检查范围**：扫描 public/*.html，确认无其他按钮/标签硬编码英文（品牌名、URL、语言本地名保留）。
- **键数**：8 语 JSON 从 371 键 → 390 键。
- **验证**：`node --check server.js` 通过；8 语 JSON parse 全过；`fly deploy` 双机 healthy。
- **踩坑备忘**：t() 的"缺 key fallback 英文"是 i18n 漏译的隐形来源；以后新增 UI 文案必须先在 8 语字典补键、再引用。建议把"i18n 缺键扫描"纳入上线前 checklist。

## 2026-09-07（午后）· Free 升级入口改对比弹窗（方案二）+ 修月/年计费周期 bug

- **改动**：免费用户的"看看 Starter 悄悄多给了什么"链接不再直接调起 Paddle checkout，改为弹出 **Free vs Starter 对比弹窗**（叙事句 + 左 Free 现状 / 右 Starter 权益高亮列 + 底部月付 $4/月 / 年付 $40/年 双按钮自选）。
- **bug 修复**：`openPaddleCheckout` 原读首页价目表 `billToggle`（dashboard 中隐藏但默认勾选年付）导致升级链接直接跳年付付款页、用户无法选月付 → 新增 `annualOverride` 显式传参，弹窗路径不再依赖隐藏开关。
- **i18n**：新增 `upgrade.modalTitle/freeLabel/starterLabel/billNote/monthlyBtn/yearlyBtn` 6 键 × 8 语（371 键齐平）；对比列复用 `landing.plan.*` 键（8 语校验全部存在）。
- **竞品依据**：UptimeRobot / Better Stack 升级路径均含"看清权益 → 选计费周期"决策层，无一家一句话链接直跳付款页。
- **关联**：MARTIN-TODO、STATUS.md、API-REFERENCE.md（无 API 变更）。

## 2026-09-07 · OAuth 登录闭环 bug 修复（失败回跳 signin + 错误码细分 + 线上凭据重同步）（commit `d53de47`）

- **现象**：Martin 实测 signin 页点 GitHub/Google 授权，授权页能弹出但点授权后回 signup 页（闭环失败）。
- **根因①（代码）**：callback 失败硬编码 `redirect('/signup.html?err=...')`，但 OAuth 按钮在 signin.html → 失败被误导到注册页。
- **根因②（配置 · 共因推测）**：两 provider 同时失败=共因，最可能为线上 `GOOGLE/GITHUB_CLIENT_SECRET` 与控制台不匹配（9/6 set 可能复制错）；授权页能弹说明 client_id+redirect_uri 在白名单 OK、卡在换 token 环节。
- **修复**：① 失败统一回跳 `signin.html?err=<细分码>`（google_code/google_token/google_err/gh_code/gh_token/gh_err/noemail/oauth_create）；② signin.html 读 `?err=` 显示中文提示；③ `fly secrets set` 用本地 .env 干净值重同步 4 个 OAuth 凭据（触发双机 rolling 重启）；④ API-REFERENCE.md 失败重定向契约同步。
- **验证**：`node --check` 语法过；signin.html 2 个 script 块语法过；curl 线上 start 端点 302 且 client_id+redirect_uri=pingory.com/callback 正确。
- **待确认**：Martin 重测 pingory.com/signin.html 闭环；若 `?err=google_token/gh_token` → 控制台 secret 仍不匹配，需重发。
- **第二轮（11:51）· Martin 重测进阶 → err=oauth_create，根因③已修**：
  - 进展确认：授权页未弹是 provider 记住已授权静默回跳（正常）；换 token 已成功（secret 重同步生效）→ 卡在最后一环**建用户被 DB 拒**。
  - 根因③（本地直连线上库复现证实）：`null value in column "password_hash" ... violates not-null constraint` —— 线上 users 表该列 NOT NULL，拒绝 OAuth 无密码用户 INSERT。
  - 修复：① `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`（线上已执行，is_nullable NO→YES 验证通过）；② `loginUser` 加 `password_hash` 空防护（OAuth 用户密码登录兜底拒绝）；③ 前端错误提示 **i18n 多语言化**：`signin.oauthErr*` 9 键 × 8 语（zh/en/ja/ko/es/fr/de/pt，356 键齐平），替换硬编码中文，跟随站点语言切换。
  - 闭环验证（线上库实测）：`createOAuthUser` 真实建号成功（plan=free）→ `getUserByEmail` 命中 → 测试号清理；`node --check` ×2、signin.html 2/2 scripts、8 语 JSON parse 全过。
- **关联**：MARTIN-TODO-⑤⑥、STATUS.md、API-REFERENCE.md。

---

## 2026-09-06（晚间）· Discord 告警渠道验证通过（commit `565cf12` 部署 + `5da6dad` 清理）

- **背景**：原计划用 MS Teams 作为 Pro 告警渠道。复查发现 (1) Microsoft 2026-05 已彻底关停旧的 O365 Connectors（含 Incoming Webhook），新 Workflows webhook 需 Adaptive Card 格式；(2) 个人版 Teams 无 Workflows 权限，需 E5 开发者租户；(3) Power Automate 免费档 750 次/月 + 90 天静默关停，对无人值守告警致命。
- **决策**：改走 **Discord webhook**（永久免费、无月度限制、无静默关停、代码已支持）。
- **实施**：
  - 临时 admin 端点 `/api/_test/alert`（commit `565cf12`）：直接调 `dispatch()` 验证告警链路，避免依赖真实 DOWN 等待
  - 临时 export `dispatch`（commit `565cf12`）：给 server.js 用，验证后立即清理
  - 临时端点清理 + dispatch 还原（commit `5da6dad`）：零代码残留
- **结果**：Martin Discord #常规 频道收到 pingory APP bot 测试消息 → Discord 告警渠道完整闭环。
- **影响**：Pro 监控现在可在「告警渠道」加 Discord → webhook URL → 自动告警，零额外开发成本。
- **关联**：MARTIN-TODO.md ⑫、STATUS.md。

---

## 2026-09-05（晚间）· 企业发信切换 Resend（配置级 · 实现 commit `18338cc`）

> Martin 拍板选 Resend（服务器+客户都在海外，海外原生送达最优、Free 3000封/月够早期）；Martin 实操注册 resend.com + 域名 `pingory.com`（Cloudflare Auto configure 一键加 DNS，DKIM/MX/SPF/DMARC 全 Verified）+ 建 API key；我负责配置 + 测试送达。

- **根因**：原阿里云个人邮箱 SMTP 有 554 拦截风险（用户收不到验证码/告警）。
- **改动（纯配置，代码零改动）**：`.env` + `.env.example` 六项切 Resend SMTP relay——`SMTP_HOST=smtp.resend.com`、`SMTP_PORT=465`、`SMTP_USER=resend`、`SMTP_PASS=<API key>`、`SMTP_FROM="Pingory Alerts <alerts@pingory.com>"`；`SMTP_SECURE=true` 不变。nodemailer（email.js/alerts.js）走 Resend SMTP relay 直通，无需改发送逻辑。
- **Fly secrets**：`flyctl secrets set SMTP_HOST/PORT/SECURE/USER/PASS/FROM`（双机 rolling 重启 OK）。
- **验证**：nodemailer 发真实验证邮件到测试邮箱 **送达成功**（messageId `...@pingory.com`）。
- **注意**：Resend API key 只创建时显示一次，已存本地 `.env`（gitignored）+ Fly secrets，勿外泄/commit。
- 影响：所有出站邮件（注册验证/告警/反馈通知）发件域名从 aliyun 个人邮箱换为 `alerts@pingory.com`。关联：MARTIN-TODO.md ⑧、STATUS.md。

---

## 2026-09-05 · 真年付购买 + 年付月均等价展示 + 软引导简化（PRD v2.0.1，commit `9395f51` + 部署）

> Martin 提供年付 Paddle price id（Starter `pri_01m1qnrx3ngcvd8wfwsy64q1jy`、Pro `pri_01m1qnxbj8zy3832094fk34658`），授权「完成后代码、检查、直接部署」。

- **真年付购买落地**（此前年付只是视觉省价、结账走月价）：`server.js` `/api/paddle-config` 下发 `starterAnnualPriceId`/`proAnnualPriceId`；webhook `planFromPrice` 识别年价 id 正常升档；前端 `openPaddleCheckout` 按年/月切换选对应 price id。
- **年付月均等价展示**（学 UptimeRobot，消除"$40/年整数总额"的视觉冲击）：首页年付默认态显示 Starter **$3.33/mo**（划掉 $4）、Pro **$5/mo**（划掉 $6）+ `billed $40|$60/yr · save 2 months` 小字；billToggle 仍默认勾选年付。
- **软引导简化**：`landing.sub` 8 语改简洁 "Free for 50 monitors. Real-time alerts when things go down. No credit card required."。
- **环境**：本地 `.env` + Fly secrets 新增 `STARTER_ANNUAL_PRICE_ID`/`PRO_ANNUAL_PRICE_ID`（Fly 运行环境为独立 secrets，必须 `flyctl secrets set` 才生效——见部署踩坑）。
- **门禁**：dev_gate 全过（API-契约同步 API-REFERENCE.md；PAY-登录态因年价逻辑把 Checkout.open 推远 400 字符需重构守卫位置到 open 前）。
- 影响：定价展示/真实购买链路升级；影响范围 首页 + 结账 + webhook 升档。关联：PRD v2.0、MARTIN-TODO.md A-①/②。

---

## 2026-09-04（晚间）· 定价重构 PRD v2.0 定稿（决策 6 · 方向 C）

> Martin 拍板：基础档 $3/$5 → **$4/$6**；目标收窄仅个人开发者（弃 MSP）；砍增强 H 多状态页；状态页锁 Starter/Pro 不拆卖；白标/域名/订阅通知并入 Pro；砍全部订阅加成 add-on；SMS 各档可单充。
> 影响：文档层定价基准变更，代码价格在 Paddle 后台改（价格非代码硬编码）。功能代码不变。

### 文档更新（2026-09-04 晚间）
- **PRD.md 升 v2.0**（方案层权威）：§1.2 删 MSP、§1.4/§3.1/§4.1-4.7/§5/§6 全面 $4/$6 对齐；删 §3.3-A 状态页实体化（随 H 砍）；修正三档间隔错误（对齐 plans.js：Free 5min/Starter 60s/Pro 30s，原误写 1min/30s/15s）；财务 §4.6 按 $4/$6 重算；砍订阅加成 add-on 模型。
- **STATUS.md**（方案层）：待办改为 v2.0 基准 + 决策日志。
- **DEV-PLAN.md**（docs/）：定价表改 $4/$6 + Free50/Starter100（原误写 Free20/Starter50）+ 标注过时、以 PRD/plans.js 为准。
- **PRODUCT.md**（方案层）：价格头改 $4/$6 + 标注 8/28 过时、以 PRD/plans.js 为准。
- **ARCHITECTURE.md / TECH-SELECTION.md**（docs/方案层）：清除对已删 §3.3-A 状态页实体化引用。
- **UI-DESIGN.md**（docs/）：定价三卡改 $4/$6。
- **COMPETITOR-ANALYSIS.md / UM-PRICING-COMP.md**（方案层）：加标注"Pingory 自身价已 v2.0 改 $4/$6"。

---

## 2026-09-05 · 首页定价 v2.0 代码落地（commit `88272dc`，尚未部署）

> Martin 指令开始全面写代码。第一单：把 09-04 只在文档层的定价 v2.0（$4/$6）落进代码——此前首页展示价仍是硬编码 $3/$5。
> 影响：线上首页价格展示 + 月/年切换默认行为 + 8 语价格文案。**本 commit 尚未 fly deploy**，等 Paddle 后台 price 改 $4/$6 后同批上线。

### 代码变更（2026-09-05）
- **public/index.html**：
  - 定价卡 Starter/Pro 月付 **$3/$5 → $4/$6**、年付 $30/$50 → **$40/$60**；
  - **年付改为默认主视觉**（billToggle 默认 checked；静态价 div 与 JS `applyBilling()` 同步到年付 $40/$60）；月付切换为 $4/$6；
  - 省 2 月徽标逻辑修正：改回在**年付（选中）状态显示**（原逻辑在月付默认态显示、年付隐藏，语义相反）；
  - 副标题 / FAQ a4 价格数字同步 $4/$6。
- **public/i18n/*8 语 json**：`landing.sub` / `landing.plan.starter.price`($4) / `pro.price`($6) / `faq.a4` 价格数字同步；新增 `landing.plan.{starter,pro}.periodAnn` 键 8 语补齐（"/ year" 各语）；键数 345→347 parity 保持。
- **说明**：纯数字替换、保留各语原句式，未造新营销翻译（软引导 v2.0 长文案待 Martin 定稿后补 8 语）。

### 门禁 / 提交
- dev_gate pre-commit + commit-msg 双钩全过（T4-TDZ / API-契约 / PAY-登录态 / UI-一致性 / UI-顶栏 / PLAN-单一源 / commit-ref）。
- 顺带把 09-04 文档交付批次（API/ARCHITECTURE/CHANGELOG/DEV-PLAN/README/CODE-STANDARDS/UI-DESIGN）一同入库。
- **未部署**：涉线上价格展示，Paddle 后台仍是 $3/$5，若贸然上线会"标价 $4 实扣 $3"不一致；待 Martin 后台改价后同批 fly deploy。

---

## 2026-09-04 · 文档体系补齐（动手前准备，无代码行为变更）

### 文档更新（详见方案层 STATUS.md 2026-09-04 段）
- **PRD.md 升 v1.2**（方案层）：新增第 2.5 节「页面间逻辑 + 业务间逻辑 + 支付逻辑」三套图；第 4.7 节 docx V4.0 建议外部验证结论；增强功能 H「多状态页 add-on」；§3.3-A 状态页实体化设计。
- **ARCHITECTURE.md 升 v2.0**（docs/）：9 表全列、57 路由清单、OAuth/推荐码/团队/订阅者/维护窗口/i18n/支付模块补全，修正设计期旧图。
- **API-REFERENCE.md 升 v1.5**（docs/）：补 admin ban/delete/quota/详情 4 个已在生产但缺文档的端点。
- **CODE-STANDARDS.md 新建**（docs/）：编码规范（命名/目录/API 设计/注释/i18n/Git/提交前自检）。
- **UI-DESIGN.md 新建**（docs/）：UI/UX 设计稿（设计 token/5 页布局/组件/交互/视觉回归清单）。
- **TECH-SELECTION.md 新建**（方案层）：技术选型说明单一事实源，取代 UM-MVP-TECH.md 早期草案。

---

## 2026-08-30（续）· UI 全做 + 安全基线固化（综合轮，#265/#267/#268/#269/#270/#266）

### 新增/修正：状态页重做（护城河首战，#267）
- 公开状态页 `/api/status/:slug` 与 `/api/status-page` 新增返回 `spark`（30 天响应时间序列）+ `incidents`（事故时间线，复用 `monitor_events`）。
- `public/status.html` 重写为四要素：总状态横幅（绿/黄/红/蓝 + 文字图标防色盲）+ 每监控可用率 + sparkline + 事故时间线 + 状态图例。对标 Better Uptime / GitHub。
- `src/monitors.js` 新增 `getStatusIncidents(monitorIds, days, limit)`；`docs/API-REFERENCE.md` 同步字段。

### 修正：定价三处真相冲突（#268）
- `server.js:275` `PLAN_LIMITS.free` 20 → 50，与 `plans.js`/首页/FAQ 统一（对齐 UptimeRobot 免费 50）。前端新增月/年计费切换（学 Hyperping，年付省 2 个月）。

### 新增：暗色模式开关（#265，全站 5 页）
- `index/signin/signup/status/admin` 统一语义 token + `[data-theme="dark"]` 覆盖 + `localStorage` 持久化 + 顶栏 🌙/☀️ 开关；首屏无闪烁（head 内 early script）。

### 新增：首页信任感（#269）
- `index.html` 新增实时统计条（50 / 1 min / 24-7 / ∞）+ 三步上手卡（Add → Alerted → Share）。

### 收口：状态色 token（#270）
- 全站 `:root` 统一 `--ok/--warn/--down/--maint`；清除旧黑主题/旧绿 `#3ddc84`/旧蓝 `#1677ff`（dev_gate UI-一致性扫描兜底）。

### 安全基线确认（#266，三决策待 Martin 拍板）
- 防瘫痪靠平台（Fly anycast + 可选 Cloudflare 边缘）+ 自己运维；防窃取靠自己（TLS/scrypt/最小权限/不落密钥/CSP/输入校验/会话加固）；登录验证邮箱最便宜且已落地（SMS 最贵、OAuth 免费但集成成本）。Cloudflare 全量边缘 / 登录 2FA / OAuth 社交登录 待 Martin 拍板。

- **原因**：综合轮 Martin 指令「UI 全做 + 竞品参照固化 + 安全两问」，按 DEV-WORKFLOW S0–S8 闭环执行。
- **影响**：前端 5 页 + `server.js`/`monitors.js` 两处常量 + `status.html` 重写 + API 文档；回滚 = git revert。
- **文档**：`API-REFERENCE.md` 已同步；本 CHANGELOG 追加。

## 2026-08-30（续）· 监控数量定档 + 首页 UI 国际化与明暗开关修复 + 业务逻辑审计

### 决策：监控数量三档定档（#276）
- **Martin 拍板**：Free = **50**、Starter = **100**、Pro = **∞**（Unlimited）。依据：UptimeRobot 免费 50 为行业标杆；真实小企业需求 3–15 个，Free 已覆盖绝大多数场景；Starter 100 = 2×Free 形成清晰升级阶梯；Pro 面向代理/MSSP。
- **防薅羊毛逻辑**：收费不靠「数量卡脖子」，而靠功能阶梯——Free 仅 HTTP/keyword + 5 分钟间隔 + 7 天历史 + 邮件告警 + 无状态页；Starter 加 1 分钟间隔 + 全部类型 + 状态页 + Slack/Telegram/Webhook + 90 天历史；Pro 加 30 秒间隔 + 自定义域名白标 + 团队席位 + 全渠道 + 365 天历史。

### 修正：业务逻辑审计发现的隐患（#276 续）
- `src/plans.js`：`PLAN_LIMITS.starter` 50 → **100**；`PLAN_LIMITS` 作为套餐数量唯一事实源。
- `server.js`：删除本地重复定义的 `PLAN_LIMITS`，改为从 `./src/plans.js` 导入；修正残留的旧兜底 `?? 20` → `?? PLAN_LIMITS.free`。
- `public/index.html`：Starter 定价卡文案由「50 monitors」改为「100 monitors」。
- `dev_gate.js`：新增 **PLAN-单一源** 机检——PLAN_LIMITS 只能在 `src/plans.js` 定义，server.js 必须导入；否则 FAIL。
- `docs/API-REFERENCE.md`：同步更新为 v1.3，记录 PLAN_LIMITS 单一源约定。

### 修正：首页 UI 两个截图问题（#275/#277）
- **语言选择器**：`langSwitcher()` 改为左右横向排列（`.lang-wrap` inline-flex + `.lang-label` + `.lang-select`）；标签 `lang.label` 改为 `data-i18n` 属性，语言切换时通过 `window.__afterLang` 重新渲染，确保英文模式下显示「Language:」而非「语言：」。
- **明暗开关**：`#themeToggle` 改为圆形按钮样式（34px、背景、边框、hover 放大），更凸显；增加 `data-i18n-title="theme.toggle"` 并在 `applyI18n()` 中支持 `data-i18n-title` 属性翻译。
- **统计条 + 三步卡**：原本硬编码英文，现接入 i18n（`landing.stat.*`、`landing.step*.*`），8 语 JSON 同步更新。
- **顺手修复**：`index.html` DNS 卡片 `class="mt-src"` 错写为 `mt-desc`（导致样式未命中）。

### 固化：用户吐槽搜索纳入前期调研工作流（#277）
- `DEV-WORKFLOW.md` S1.5 强制「竞品参照」步骤新增：**必须专门搜索用户真实吐槽/差评/切换原因**，并作为独立产出项。
- `~/.workbuddy/MEMORY.md` 新增「用户吐槽搜索铁律」，跨项目生效。
- `dev_gate.js` 机器门禁清单新增「PLAN_LIMITS 单一事实源」FAIL 项。

## 2026-08-30（续）· 修复首页悬浮顶栏登录注册堆叠 + 安全/计划数量决策落地

### 修正：首页悬浮顶栏登录/注册按钮堆叠
- `public/index.html`：`.topnav-actions` 加 `flex-wrap:nowrap`；新增 `#topnavRight { display:flex; align-items:center; gap:8px; }`；`.topnav-login` 加 `white-space:nowrap`；`langSwitcher` 容器改为 `display:inline-flex` 无外边距；悬浮胶囊宽度由 720px 调至 780px。
- **根因**：增加 theme toggle 与语言选择器时未检查 logged-out + 中文 + `.nav-float` 态，inline-block 按钮在窄胶囊内纵向堆叠。
- **固化**：`DEV-WORKFLOW.md` S4.5 新增「UI 布局防堆叠」自检项；`dev_gate.js` 新增 UI-顶栏布局 FAIL 扫描（index.html 改动时检查 #topnavRight 是否为 flex）。

### 决策落地（Martin 2026-08-30 拍板）
- **网络安全**：正式把 Cloudflare 列为「防瘫痪第一责任人」，开启 WAF + 速率限制；限流阈值须评估业务影响后写入 TECHNICAL。
- **登录验证**：不做 2FA/TOTP，仅保留邮箱验证（最便宜）。
- **OAuth 登录**：接入 Google + GitHub 社交登录。
- **监控数量**：重新审视 Free/Starter/Pro 三档数量（此前 free 20/50 冲突，竞品说法待核；用户提议 Starter 60）。

---

## 2026-08-28

### 新增：账户安全 / 客户反馈 / 超级管理员后台（G-SEC / G-FEEDBACK / G-ADMIN）
- **变更**：在现有认证体系上补齐「客户账号安全 + 反馈收集 + 内部管理」三块能力。
  - **邮箱验证（G-SEC）**：`users` 新增 `email_verified / verify_token / verify_expires`；注册后发验证邮件，新增 `GET /api/auth/verify-email?token=` 与 `POST /api/auth/resend-verify`；前端未验证时显示横幅可重发。密码最小长度 8。
  - **账号安全加固**：Session Cookie 加 `secure`（live 环境）+ 7 天 `maxAge`；新增基础安全响应头（X-Content-Type-Options / X-Frame-Options: DENY / CSP 放行 Paddle CDN）；登录/注册/反馈接口加内存限流防暴破/防刷；`users` 预留 `twofa_secret`（TOTP 第二因子列，后续启用）。
  - **客户反馈（G-FEEDBACK）**：新增 `feedback` 表 + `POST /api/feedback`（公开、限流）；前端 `index.html` 增加悬浮「反馈」按钮 + 弹窗，提交入库并邮件通知 `ALERT_TO_EMAIL`。
  - **超级管理员（G-ADMIN）**：`users.role` 字段（user/admin）；启动时按 `ADMIN_EMAIL/ADMIN_PASSWORD` 自动建超级账号（`seedAdmin()`）；新增 `requireAdmin` 中间件与 `/api/admin/*`（stats / users / monitors / feedback / 改套餐 / 改角色 / impersonate / 月报）；新增 `public/admin.html` 管理后台（用户表 / 监控表 / 反馈 / 系统监控摘要，可一键「以此身份测试」跳回官网）。
- **原因**：Martin 要求补齐「客户账号安全、反馈闭环、可测试的超级账号、系统监控入口」——支付跑通后，账号与运营基础能力是正式上线前的硬缺口。
- **影响**：DB schema 新增 5 个 users 列 + `feedback` 表；新增 `src/email.js`；`server.js` 增加安全中间件 + 限流 + 验证/反馈/管理路由；前端增加验证横幅 / 反馈组件 / 管理入口。
- **验证**：`node --check` 四个 JS 文件全过；逻辑自审通过。运行期需 Neon + SMTP 才能实测邮件/验证链路。
- **方案文档**：`方案资料/uptime-monitor/PAYMENT-DEBUG-RETRO.md`（支付调试复盘，含「第 2 项」上线待办）；本 CHANGELOG 仅记代码变更。

---

## 2026-08-28（续）· G7–G11 收尾

### 新增：状态页增强 / 维护窗口 / 团队 + Account API / i18n / 部署配置（G7–G11）
- **G7 状态页增强**：`users` 新增 `status_custom_domain / status_white_label / status_password_hash`；新增 `status_subscribers` 表。
  - 自定义域名：`getStatusPageByHost(host)` 按 Host 解析；`app.get('/')` 在静态中间件前拦截，命中自定义域名则返回 `status.html`。
  - 白标 / 私有：状态页数据接口返回 `whiteLabel`；私有页返回 `401 {needsPassword}`，前端密码解锁写 capability cookie（`STATUS_PAGE_SECRET` HMAC）。
  - 订阅者：`POST /api/status/:slug/subscribe`（公开）、`/api/me/subscribers`（管理增删）；down/恢复事件经 `notifySubscribers()` 邮件通知。
  - 设置接口 `PATCH /api/me/status-page` 扩展 `customDomain / whiteLabel / password`（Pro 专属）。
- **G8 维护窗口**：新增 `maintenance_windows` 表；`alerts.js` 告警派发前 `isMonitorInMaintenance()` 命中则跳过 down/升级告警（仍记录事件）。
- **G9 团队 + Account API**：新增 `teams` 表 + `users.api_key / team_id / team_role` + `monitors.team_id`。
  - 团队：`POST /api/team`、`POST /api/team/invite`、`GET /api/team`、`POST /api/team/leave`；成员监控经 `team_id` 共享可见（`listTeamMonitors`）。
  - Account API：`POST /api/account/apikey`（生成/重置）、`/api/v1/monitors`（`GET/POST`）、`/api/v1/monitors/:id`（`GET/DELETE`），均 `Bearer <api_key>` 鉴权（`requireApiKey`）。
- **G10 i18n**：`public/i18n/{en,es,pt,de,fr,ja,ko}.json` 语言包 + 前端 `t()` 加载器 + 语言切换器；核心 UI 文案（状态页/设置/团队/维护窗口/订阅）接入 `data-i18n`。后端错误保持英文 API 响应。
- **G11 部署配置**：新增 `deploy/nginx.conf`（反代+HTTPS）、`deploy/pingory.service`（systemd）；`DEPLOYMENT.md` 增加自定义域名 + 上线前核对清单；`.env.example` 增 `STATUS_PAGE_SECRET`。
- **原因**：Martin 要求「继续把 G7–G11 代码和部署都做掉」。Phase 2–4 全部功能补齐，仅剩真实部署动作（Martin 执行 `fly deploy` / 填生产 secret）。
- **影响**：DB schema 新增 3 个 users 列 + `status_subscribers`/`maintenance_windows`/`teams` 表 + `monitors.team_id`；`src/auth.js` 增订阅者/维护/团队/api_key 函数；`src/monitors.js` 增按 Host 解析/订阅者通知/团队列表；`src/alerts.js` 增维护窗口跳过 + 订阅通知；`server.js` 增 G7/G8/G9 路由与 `requireApiKey`；前端 `index.html`/`status.html` 增高级面板与 i18n。
- **验证**：`node --check` 全过；导出/导入符号一致性已 grep 核对；前端 i18n JSON 已建 7 份。

---

## 2026-08-27

### 新增：Phase 1 收费档功能对齐（G1–G6 全部完成）
- **变更**：在 MVP 基础上补齐竞品收费档功能基线，代码已落地并通过本地端到端冒烟。
  - **G1 多检查类型**：`src/monitors.js` 新增 `checkKeyword/checkPing/checkTcp/checkSsl/checkDomain(WHOIS)/checkApi/checkDns/checkHeartbeat` 检查器 + `type` 字段与 `config` JSON；按套餐门禁（free 仅 http/keyword，starter+ 全开）。
  - **G2 告警逻辑**：`src/alerts.js` 补全恢复通知（原已有，规范化）、持续 down 升级告警（按 `escalationIntervalMin` 重发）、慢响应阈值告警、SSL/域名到期预警（warning 类事件）。
  - **G3 多区域探针**：`runCheck` 支持 `PROBE_REGIONS` 多节点 + 多数确认降误报（单节点默认）；`src/monitors.js` 加 `inFlight` 锁防同监控并发检查。
  - **G4 多告警渠道**：邮件（SMTP）+ Slack + Webhook + Telegram + Discord/Teams/PagerDuty（pro），按套餐过滤。
  - **G5 公开状态页**：`/status/:slug`（公开 HTML）+ `/api/status/:slug`（JSON）；用户 `public_slug` + `status_page_enabled`，监控 `status_public` 开关。
  - **G6 趋势图+月报**：`monitor_checks` 明细表 + `getStats()`（可用率/平均/P95 + 时序）；前端 SVG 趋势图；`generateMonthlyReport()` 月度邮件 + 每月 1 号自动触发。
- **原因**：DEV-PLAN G1–G6 是"收费档功能对齐"的硬缺口，补齐后才能与竞品收费档同台竞争。
- **影响**：DB schema 新增 `monitors.type/config/channels/status_public/last_alert_at/alert_count/last_success_at`、`users.public_slug/status_page_enabled`、`monitor_checks` 表；新增 `src/plans.js` 套餐能力矩阵；前端新增类型/渠道/状态页/趋势图 UI。
- **验证**：`node --check` 全过；启动连 Neon 成功、表结构迁移成功；注册→登录→`/api/plan-features`→创建 http(201)/tcp(free 403 门禁)/keyword(201)→轮询真实检查（http 变 up）→不可达监控触发 down 事件（修复并发后唯一落库）→stats/状态页门禁(403) 全部符合预期。
- **遗留**：多区域需配真实 worker；渠道需真实凭据实测；生产部署 G11 未做。

### 新增：多区域探针 Worker 服务 + 部署配置（P1 收尾，代码全部完成）
- **变更**：补齐 G3 真正可部署的探针闭环，并实现一条命令部署。
  - **Worker 服务**：新增 `src/worker.js`，暴露 `POST /probe`（接收 `{monitor,region}`，复用 `src/monitors.js` 的 `runLocalCheck` 做本地检查并回传 `{status,error,responseTime,warn,region}`）+ `GET /health`；`PROBE_SECRET` 共享密钥鉴权（两端都设才启用 `x-probe-secret` 校验）。`src/monitors.js` 导出 `runLocalCheck`，`runCheck` 委托 worker 的 fetch 已带 `x-probe-secret` 头。
  - **主服务**：`server.js` 新增 `GET /health` 健康检查端点（供编排平台 / Uptime Robot 探测存活）。
  - **部署配置**：新增 `Dockerfile` / `.dockerignore` / `docker-compose.yml`（app + 可选多区域 probe 节点）/ `ecosystem.config.cjs`（PM2）/ `render.yaml`（Render，healthCheckPath=/health）；`.env.example` 补 `PROBE_SECRET` 说明并修正 worker 部署提示。
  - **文档**：`ARCHITECTURE.md` 补 worker 模块与"多区域探针拆为独立 worker"技术决策；`DEPLOYMENT.md` 第 11 节勾选已完成项（状态页 / Slack+Webhook 渠道 / health），新增第 12 节容器化部署；`PROBE_REGIONS` 与 `PROBE_SECRET` 说明同步。
- **原因**：此前 G3 仅实现"调度委托"未实现 worker，多区域无法真正落地；部署只能手动 VPS，缺容器化 / 平台配置。
- **影响**：项目现具备完整可部署形态；G3 从"逻辑就绪"升级为"端到端可跑"（worker 已实测：启动正常、http/tcp 检查正确回传、无密钥 401）。
- **验证**：`node --check` 全过；worker 实测三类响应（http / tcp / 401）符合预期；`PROBE_REGIONS` 不配则主服务自动单点回退。
- **结论**：**Phase 1（G1–G6）+ 部署准备 代码层面 100% 完成**，无半截 / 漏写。

### 新增：OPC 收款模块调整（Paddle 加入，Stripe/PayPal 保留）
- **变更**：OPC 总方针 docx 及 generate_plan.py 追加 Paddle 作为起步收款选项（中国身份首选），原有 Stripe/PayPal 个人版保留为备用。
- **原因**：Martin 大陆身份无法直接开 Stripe；Paddle MoR 自动代扣全球 VAT/销售税，且 Uptime Monitor sandbox 已实测跑通。
- **影响**：支付接入参考 `docs/PAYMENTS-SETUP.md`；生产环境启用 Paddle live key。
- **记忆**：`MEMORY.md` 技术方案段更新；`startup-project.md` OPC 专节更新。

### 新增：OPC 方案 docx 唯一路径固化
- **变更**：删除 `D:\创业助手\根目录` 下的冗余副本，保留 `D:\创业助手\方案资料\OPC指导方针\AI一人公司（OPC）全球网站创建与运营完整行动方案.docx` 为**单一事实源**。
- **原因**：Martin 明确"改 py / 改 word 都需要我确认"，避免多处副本不同步。
- **影响**：以后任何引用/修改 OPC 方案只用此路径。
- **记忆**：`MEMORY.md` 新增「⚠️ 唯一路径」说明；`startup-project.md` OPC 读取规则更新。

### 新增：项目文档补全（API 速查 + 部署手册 + 架构说明）
- **变更**：新建 `docs/API-REFERENCE.md` / `docs/DEPLOYMENT.md` / `docs/ARCHITECTURE.md`。
- **原因**：MVP 功能已跑通但零对应文档，部署前必须补全（对齐 OPC 红线「先验证后投入」的延伸——部署也是"投入"的一部分）。
- **影响**：部署流程标准化；后续新增端点/模块需同步更新这三份文档。

---

## 2026-08-26

### 初始 MVP 完成（核心功能）
- **变更**：认证（scrypt + session）、监控 CRUD（Neon 持久化）、轮询引擎（每 5 秒）、告警（阿里云 SMTP）、Paddle webhook（手动 HMAC 验签）、配额限制、前端 UI。
- **影响**：MVP 可本地运行（`node server.js`，默认 3000 端口）。
- **文档**：`docs/UM-MVP-TECH.md` / `docs/UM-PRICING-COMP.md` / `docs/PAYMENTS-SETUP.md` / `docs/DEV-PLAN.md`。

### Paddle webhook 跑通
- **变更**：从 SDK `verifyNotification`（不存在）→ `webhooks.unmarshal`（失败）→ 手动 HMAC-SHA256 验签 + 300 秒时间戳容差。
- **影响**：webhook 端点稳定 200；subscription.activated 事件正确触发 plan 升级。
- **注意**：生产环境时间戳容差可调回严格（当前 300 秒为防 cloudflared 延迟）。

### Neon keepalive 机制
- **变更**：`src/db.js:startKeepAlive()` 每 4 分钟发 `SELECT 1`。
- **原因**：Neon 免费档 5 分钟无查询休眠，首次请求 10–30 秒唤醒导致注册/登录卡顿。
- **影响**：首请求延迟从 10–30s 降至 <1s。

### 文件体系大整理
- **变更**：C 盘 memory 按角色分文件夹（头条猛兽/盐选写手/知乎钱粮/健康管家/漫剧导演/创业助手）；D 盘 `smoke-test-d1d2` 拆分为 `项目/uptime-monitor` + `项目/landing-d1` + `项目/landing-d2` + `方案资料/OPC指导方针` + `方案资料/landing-d1` + `方案资料/landing-d2`。
- **影响**：记忆系统层级清晰；项目代码归 D 盘，记忆归 C 盘。
- **记忆**：`MEMORY.md` 索引全量更新；`startup-project.md` 项目编号刷新为 1–7（3 已启动 + 4 候选）。

---

## 历史记录（早期）

### 2026-08-24 ~ 08-25：D1/D2 等待列表验证
- **变更**：搭建 `smoke-test-d1d2/`（server.js + d1.html + d2.html + waitlist.jsonl），改 Netlify Forms，i18n 英/中/日/西/法。
- **状态**：D1 暂停、D2 待验证（waiting list smoke test ≥20 注册才开工）。
- **产物**：`项目/landing-d1/`、`项目/landing-d2/`、`方案资料/landing-d1/`、`方案资料/landing-d2/`。
