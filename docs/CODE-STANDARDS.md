# Pingory · 编码规范（CODE-STANDARDS.md）

> **文档定位**：Pingory 代码库**编码风格与约束的唯一权威**——命名规则、目录结构、API 设计规范、注释要求、错误处理、前后端约定。目的：AI 生成代码风格统一、质量可控、低返工。
> **性质**：项目层实施规范（与代码同库，本仓库根目录）。
> **强制手段**：`tools/dev_gate.js`（pre-commit/commit-msg 机检）承载可机器化的硬规则；本文承载需要判断力的软规则。两者冲突以本文 + dev_gate 联合为准。
> **关联文档**：ARCHITECTURE.md（模块结构）/ API-REFERENCE.md（契约）。踩坑复盘与错误台账属方案层，按设计不随本仓库公开。
> **最后更新**：2026-09-04（首次成文）
> **禁止表格**：遵循全局「禁用表格」铁律，用 ▸ / 编号层级表达。

---

## 1. 总原则

▸ 简单优先：零构建、少依赖、原生能力够用就不引库（栈约束见 TECH-SELECTION.md）
▸ 可被 AI 整体理解：文件小而职责单（一个模块一个文件），避免巨型函数
▸ 可回滚：一切改动可 git revert；不做不可逆迁移
▸ 单一事实源：配额/套餐/能力矩阵只在 src/plans.js；路由契约只在 API-REFERENCE.md；状态只在 STATUS.md
▸ 默认拒绝：鉴权端点默认拒绝未认证访问（曾踩"未登录可付款"大错）

---

## 2. 语言与文件约定

▸ 后端代码：Node.js ESM（`import/export`），`"type": "module"`（package.json 已设）
▸ 前端：原生 HTML + 内联 `<script>`（**禁止** Vue/React/Svelte；禁止引入构建工具）
▸ 语言：代码注释可中文；UI 文案英文为主（i18n 8 语，见 §7）；后端报错/邮件统一英文
▸ 换行/编码：UTF-8、LF；缩进 2 空格（不用 tab）
▸ 分号：语句末带分号（ESM 风格统一）；字符串优先单引号，模板串用反引号

---

## 3. 命名规则

后端（server.js / src/*.js）
▸ 文件/模块：小驼峰（`server.js` / `alerts.js` / `email.js`）——已有 `plans.js`/`auth.js`/`monitors.js`/`db.js`/`worker.js` 保持
▸ 函数：小驼峰动词开头（`createMonitor` / `sendEmail` / `getUserByEmail` / `runCheck`）
▸ 常量：大写蛇形（`PLAN_LIMITS` / `EMAIL_VERIFY_MONITOR_CAP` / `PROBE_REGIONS` / `PROBE_SECRET`）
▸ 路由路径：小写 kebab（`/api/monitors/:id/stats`、`/api/maintenance-windows`、`/api/paddle/webhook`）
▸ 查询参数/body 字段：小驼峰（`statusPublic` / `whiteLabel` / `slowThresholdMs`）

前端（public/*.html 内联 JS）
▸ DOM id/class：kebab-case（`topnav-actions` / `lang-mount` / `feedback-fab`）
▸ JS 全局/函数：小驼峰（`openPaddleCheckout` / `ensureAuth` / `applyI18n` / `langSwitcher`）
▸ 工具函数（`t()` / `I18N` / `loadI18n` / `__afterLang`）**必须声明在所有调用者之前**（TDZ 铁律，dev_gate 机检）
▸ 事件处理器：`on<Event><Target>`（如 `onClickUpgrade`）或内联 `onclick="fn()"` 统一小驼峰

数据库
▸ 表名：蛇形复数（`users` / `monitors` / `monitor_events` / `maintenance_windows`）
▸ 列名：蛇形（`last_checked` / `status_public` / `email_verified`）——⚠️ 与 JS 字段小驼峰互转处用 rowToMonitor 类映射函数集中处理，禁止散落 `Number(row.x)` 到处转换

---

## 4. 目录结构（唯一权威，勿新建顶层散文件）

▸ `server.js`：Express 入口（路由注册、中间件、启动编排）——已有 1221 行偏大，**新路由逻辑放 src/ 模块，server.js 只做薄注册**
▸ `src/`：业务模块（auth / monitors / alerts / email / plans / db / worker）
▸ `public/`：前端页面（index / signin / signup / status / admin）+ i18n/（8 语言 JSON）
▸ `tools/`：开发脚本（dev_gate.js 门禁 / verify_deploy.js 回归）
▸ `docs/`：实施文档（API-REFERENCE / ARCHITECTURE / CODE-STANDARDS / DEV-PLAN / CHANGELOG / DEPLOYMENT）
▸ `deploy/`：部署配置（nginx / systemd / docker-compose 等参考）
▸ 根目录：Dockerfile / fly.toml / .env.example / package.json
▸ ⚠️ 禁止：在项目根或 docs/ 放 PRD/竞品/需求分析（两层边界，方案层在 `D:\创业助手\方案资料\uptime-monitor\`）

新增模块规则
▸ 单文件超 ~400 行且职责可拆 → 拆 src/ 下新文件
▸ 新文件必须：职责注释头 + 命名小驼峰 + 在 ARCHITECTURE.md 模块职责登记（dev_gate 可扫）
▸ 禁止"万能 utils.js"——工具函数就近放使用模块或按域命名

---

## 5. API 设计规范（后端路由）

路由分层（鉴权双轨，勿混）
▸ `/api/*`：浏览器 Session（express-session，Cookie um_sid）
▸ `/api/v1/*`：程序化访问 Bearer api_key（requireApiKey）
▸ `/api/admin/*`：role=admin（requireAdmin）
▸ 公开：`/api/auth/*`、`/api/paddle-config`、`/api/paddle/webhook`、`/api/heartbeat/:id`、`/api/status/:slug`、`/api/feedback`、`/health`

命名与一致性
▸ 资源路由 REST 风格：`POST /api/monitors`（建）/ `GET`（列）/ `PATCH :id`（改）/ `DELETE :id`（删）/ `:id/stats`、`:id/history`（子资源）
▸ 复数资源名（monitors、maintenance-windows）；动词动作放子路径（import、subscribe、unlock、ban、impersonate）
▸ 统一前缀 `/api`；页面路由（`/status/:slug`、`/`、`/signin.html`）与 API 严格分开

请求/响应约定
▸ 请求体 JSON；响应一律 JSON（`res.json(...)`）；文件服务除外
▸ 错误响应带 HTTP 状态码：400 参数错 / 401 未登录 / 403 权限或套餐不支持 / 404 不存在 / 500 服务错
▸ 成功创建 201（register、createMonitor、feedback）；其余成功 200
▸ 错误信息简短可读（英文），不在响应体暴露内部堆栈
▸ 列表接口返回数组或 `{ items }` 视现状（monitors 返回数组——保持，勿破坏既有契约）

门禁放置（防漏）
▸ 配额/类型/渠道门禁在**路由层**调用 src/plans.js 函数（勿下放到业务函数深处）
▸ 归属校验：所有按 id 操作先 `req.user.id === row.user_id`，否则 404（防越权）

安全默认
▸ 任何付费动作前 ensureAuth()（未登录跳注册）——dev_gate PAY-登录态机检
▸ 输入校验：必填字段缺失 400；target 用 validateTarget 按 type 校验
▸ 密码 scrypt；session httpOnly+sameSite=lax（live 自动 secure）
▸ 防注入：一律参数化查询（pg 占位符 $1），禁止字符串拼 SQL
▸ 幂等迁移：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS；禁 DROP

---

## 6. 注释要求

▸ 文件头注释：每个 src/*.js 顶部一句话说明职责 + 关键导出（参照现有文件风格）
▸ 函数注释：复杂逻辑（状态机、多数确认、escalation）写"做什么+为什么"；简单函数不必逐行注释
▸ **决策注释**：非常规选择必须写理由（如"手动 HMAC 而非 SDK：v3 无 verifyNotification"），防止后人"优化"回坑
▸ TODO/坑：临时方案标 `// TODO(2026-09-04): ...` 带日期；已知坑见方案层复盘文档（不随本仓库公开）
▸ 前端 i18n：文案不写死在 HTML，走 `data-i18n` + 语言 JSON
▸ 禁止：注释与代码不符的过期注释；大段被注释的废代码（直接删，git 有历史）

---

## 7. i18n 约定（前端 8 语）

▸ 语言文件：public/i18n/{en,zh,es,pt,de,fr,ja,ko}.json
▸ 新增文案键：必须 8 个语言文件全部补齐（verify_deploy/parity 脚本校验 0 缺失；缺失会 FAIL）
▸ 键命名：点分分组（`plans.starter.monitors`、`nav.signIn`、`common.save`）
▸ 语言切换器改动后必须回归 `langMount` 数量（曾踩双下拉 bug：append 前先 innerHTML=''）

---

## 8. Git / 提交规范

▸ 提交信息格式：`<类型>(<范围>): <简述> [引用 Dxx / P0-x / PRD-*]`（dev_gate commit-ref 强制带决策/PRD 引用）
▸ 类型：feat / fix / docs / refactor / test / chore / revert
▸ 提交前自动跑 dev_gate.js；提交后部署跑 verify_deploy.js（/health + 8 语 parity）
▸ 禁提交：.env、node_modules（.gitignore 已配）
▸ 分支：验证期直接主分支开发（单人项目）；大重构可开 feature 分支

---

## 9. 错误处理模式

▸ 同步路由：try/catch → next(err) 或 res.status(500).json（参考现有 auth/monitors 写法）
▸ 异步轮询/告警：顶层 try/catch + console.error，**单监控失败不中断整轮轮询**
▸ webhook：验签失败 400/401 并记录；处理成功必须 200（Paddle 重试机制）
▸ 幂等：webhook event_id / 推荐绑定等需要防重复的，先查后插或用唯一约束
▸ 邮件发送失败：记日志不抛（告警邮件失败不能拖垮主流程）；555/554 拦截见 TECHNICAL

---

## 10. 提交前自检清单（S4.5 人工版 · dev_gate 自动兜底）

▸ UI 一致性：改主题/样式是否同步了全部 public/*.html（dev_gate UI-一致性扫描）
▸ 业务流：视觉改动是否破坏了登录/付费/权限流（曾踩定价按钮未登录可付款）
▸ 权限默认拒绝：新端点默认 requireAuth/requireAdmin/requireApiKey，显式豁免才公开
▸ i18n：新文案 8 语补全；语言切换器回归 langMount
▸ API 契约：改路由必须同步 API-REFERENCE.md（dev_gate API-契约扫描）
▸ 配额单一源：改监控数只改 src/plans.js（dev_gate PLAN-单一源扫描）
▸ TDZ：前端新工具函数声明在所有调用者之前（dev_gate TDZ 扫描）
▸ 汇报对齐：对外地址只报 pingory.com（不报 fly.dev）
▸ DB：新列 ADD COLUMN IF NOT EXISTS；不动存量数据（幂等）
