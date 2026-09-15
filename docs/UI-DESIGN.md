# Pingory · UI/UX 设计稿（UI-DESIGN.md）

> **文档定位**：Pingory 前端视觉与交互的**实现参照**——设计 token、页面布局、组件规范、状态与交互。让 AI 生成/修改前端时有统一视觉基准，避免"只改首页/风格漂移/堆叠错位"类返工。
> **性质**：项目层实施文档（与 public/ 同库）。
> **当前线上视觉**：**深空灰底 + 荧光绿强调**（主视觉，2026-08-30 定调，非纯黑）+ 浅色模式（`data-theme` 切换）。配色实际值见 §2，以代码为准。
> **页面文件**：`public/index.html`（落地+仪表盘一体）/ `signin.html` / `signup.html` / `status.html`（公开状态页）/ `admin.html`。
> **关联**：CODE-STANDARDS.md §7（i18n）、API-REFERENCE.md。（首页改版专项 PRD 属方案层，按设计不随本仓库公开）
> **最后更新**：2026-09-04（首次成文，对齐线上 v30）
> **禁止表格**：遵循全局「禁用表格」铁律。

---

## 1. 设计原则

▸ 深空科技感但不纯黑：`#0e1310` 级底色 + 荧光绿 `#2bd585` 强调（浅色模式 `#f5f8f6` + `#1faa6b`）
▸ 层次靠"可见边框 + 卡片提亮 + 微差底色"制造，不靠纯色深浅（历史坑：色阶太弱糊成一片）
▸ 层次化卡片（Bento grid）：功能模块卡片化，宽卡重点展示
▸ 交互：hover 悬浮 + 阴影；悬浮导航三态（顶栏 ↔ 居中胶囊 ↔ 底栏）随滚动
▸ 移动优先的响应式；语言与明暗切换常驻可见
▸ 尊重用户历史反馈：不堆功能清单，首页讲清楚"真正宕机才告警 + 多区域 + 低价"即可

---

## 2. 设计 Token（以 public/index.html `:root` 实际值为准）

深色主题（默认）
▸ `--bg: #0e1310`（页面底）
▸ `--card: #161d18`（卡片）
▸ `--border: #2a322c`（边框——必须可见，勿低于此暗度）
▸ `--text: #e6efe9`（正文）
▸ `--muted: #9fb0a6`（次要文字）
▸ `--accent: #2bd585`（荧光绿强调：按钮/链接/激活态）

浅色主题（data-theme=light）
▸ `--bg: #f5f8f6` / `--card: #ffffff` / `--border: #dbe4df`
▸ `--text: #16241d` / `--muted: #5d6b63` / `--accent: #1faa6b`

规则
▸ 颜色一律走 CSS 变量，禁止页面内硬编码十六进制色（dev_gate UI-一致性会拦旧色值）
▸ 强调色只用于：主 CTA、激活/成功态、关键数据高亮；告警红/绿按语义（宕机红、在线绿）
▸ 圆角：卡片 12px；按钮 8px；胶囊导航 999px
▸ 阴影：卡片 hover `0 16px 32px rgba(...)` 级；常态轻阴影或无

---

## 3. 页面总览与跳转（PRD §2.5-A/B 的视觉落地）

▸ `/` index.html = 落地页（未登录）+ 仪表盘（已登录）**一体单页**，区块切换显示
▸ /signin.html、/signup.html = 独立认证页（简洁居中卡片）
▸ /status/:slug = 公开状态页（极简、品牌化、可订阅）
▸ /admin.html = 超管后台（数据密集表格 + 抽屉详情）

---

## 4. index.html 区块与布局（核心页）

### 4.1 顶部导航（topnav）
▸ 未登录：Logo「Pingory」+ Language 切换 + Sign In / Get Started（荧光绿主按钮）
▸ 已登录：Logo + 监控数/套餐信息（planInfo）+ Language + 明暗切换（themeToggle）+ Logout
▸ 悬浮三态：页面顶部 = 常规顶栏；向下滚动 = 居中胶囊悬浮（nav-float）；到底部 = 贴底
▸ ⚠️ 防堆叠：`.topnav-actions` flex + nowrap + gap；langSwitcher inline-flex 无 margin（历史 bug 记录）

### 4.2 落地页区块（未登录 · landing 区）
▸ Hero：一句话价值主张（"真正宕机才告警 + 用户想看的 status page"）+ 主 CTA
▸ 功能模块 Bento（monitorTypes）：HTTP/关键字/Ping/SSL/域名/API/DNS/心跳 等卡片化；宽卡给重点
▸ 定价三卡（plans）：Free $0 / Starter $4（年 $40）/ Pro $6（年 $60）（v2.0 价格，原 $3/$5 已上调；默认年付主视觉）
  ▸ 默认展示**年付价**为主视觉（利润杠杆，PRD §4.6），月付切换（billToggle / billAnnual / billMonthly）
  ▸ 三卡色阶：Free 基础卡 → Starter 强调绿 → Pro 次强调（hover 抬升 + 阴影）
  ▸ 按钮：Free="Get Started Free"（跳注册，**不禁用**）；付费卡=升级按钮
  ▸ 价格卡下方：**柔和引导语**（小灰字："增强功能注册后展开"——8 语）
▸ FAQ（faq）+ 三步引导 + 页脚

### 4.3 仪表盘区（已登录 · dash 区）
▸ 邮箱未验证横幅（resendVerify，验证后消失）
▸ 监控列表（monList）：每行 = 名称 + URL + 状态点（绿/红）+ 间隔 + 最后检查；点击展开详情
▸ 新建/编辑监控：表单（nameInput/urlInput/intervalInput/typeInput/cfgBox/chanBox）
  ▸ type 切换联动 cfgBox（各类型专属配置项：keyword→cfgKeyword、tcp→cfgPort、api→cfgAssertPath/assertEquals、ssl/domain→cfgWarnDays、http→cfgCodes/cfgSlow…）
  ▸ 渠道勾选（chanBox：email/slack/webhook/telegram…）按套餐过滤
▸ 单监控详情：状态 + 可用率 + 趋势（stats/history）+ 事件时间线
▸ 状态页开关面板（spEnable/spDomain/spWhite/spPw/spSave）——公开链接展示
▸ 增强功能区（Enhanced capabilities，已注册付费档用户可见 add-on 列表）
▸ 附加面板：维护窗口（mw*）、团队（team*）、推荐码（refBox/refCopy/refLink）、Account API（apiKey*）、一键导入（importBtn/impData/impFmt）、升级提示横幅（upgradeNudge/upgradeLink/upgradeDismiss）
▸ 悬浮反馈组件（feedback-fab：默认居中悬浮 → 到底贴底；feedbackMsg/Email/Send/Cancel）
▸ 监控数超限/配额提示（statusBar 等）

### 4.4 认证页（signin / signup）
▸ 居中窄卡片（~420px）双主题适配；Logo 顶部
▸ signup：邮箱 + 密码 + 确认密码 + 姓名字段 +「Get Started」+ 下方 Google/GitHub OAuth 按钮
▸ signin：邮箱 + 密码 +「Sign In」+ OAuth + 忘记/注册跳转链接
▸ 错误提示行（红色）；验证邮件提示态
▸ 已登录访问 → JS 跳回 `/`

---

## 5. status.html 公开状态页（护城河 · 核心展示）

▸ 品牌区：服务名（白标可去 Pingory logo）+ 总状态横幅（All Systems Operational 绿 / 有事故红 / 维护黄）
▸ 指标区：总可用率 + 各组件（监控）状态卡片：名称 + 状态 + 30 天 sparkline
▸ 事故时间线（incidents）：down/up 事件倒序（时间 + 说明 + 时长）——护城河两点之一
▸ 订阅区（subZone）：邮箱订阅框（收到通知）——护城河两点之二
▸ 私有页（password 启用）：解锁框 → capability cookie 后展示
▸ 自定义域名：白标 + 独立域渲染（G7）
▸ 设计：极简、移动优先、读秒级理解当前是否宕机；不泄露内部字段

---

## 6. admin.html 超管后台

▸ 顶部：环境/统计摘要（用户/付费/监控/down/反馈/运行时长）
▸ Tabs：用户（搜索 q + 筛选 plan/role/banned）→ 行内操作：详情抽屉（监控列表/订阅）/ 封禁 / 删除 / 改套餐 / 配额 / impersonate
▸ 监控表：全部监控 + 归属邮箱
▸ 反馈表：列表 + seen/done 状态
▸ 系统监控：/health 相关摘要
▸ 数据密集用表格；操作按钮小图标 + 确认弹窗（禁误删）

---

## 7. 交互与状态规范

▸ 异步请求：按钮 loading 态（disable + spinner/文案），成功/失败 toast 或行内提示
▸ 表单校验：前端即时校验 + 后端 400 回显；密码最小 8 位
▸ 空态：监控列表空 → 引导创建/导入插画文案；无反馈空态提示
▸ 加载态：列表/图表初次加载 skeleton 或 spinner
▸ 权限不可见：非本档功能按钮隐藏或禁用并提示升级（软引导）
▸ 语言切换：切换即重渲染当前文案（`applyI18n`），不刷新丢状态
▸ 明暗切换：`data-theme` 切换持久化 localStorage；两套 token 全量一致

---

## 8. 响应式断点

▸ 移动 < 768px：导航折叠/胶囊简化；Bento 单列；表单全宽；三卡纵向堆叠
▸ 平板 768–1024px：两列布局
▸ 桌面 > 1024px：三卡横排 + 多列 Bento
▸ 顶栏宽度基准 780px（曾因 720px 导致按钮堆叠，勿回调）

---

## 9. 视觉回归清单（改 UI 后自检，dev_gate UI-一致性兜底）

▸ 全部 5 个 public/*.html 同步（勿只改 index）
▸ 双主题（深/浅）都过一遍关键区块
▸ 语言切换后布局不崩、langMount 无重复
▸ 登录前/后、免费/付费视角各看一遍
▸ 无硬编码旧色值（#0f1115/#1a1d24/#3ddc84/#1677ff 等为拦截目标）
▸ hover/focus/active 三态完整
