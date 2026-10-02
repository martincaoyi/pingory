# ADR-0001 托管迁移：Fly.io → Cloudflare Workers（不绑卡、永久免费）

- 状态：已接受（2026-10-02）
- 关联方案：`D:\创业助手\方案资料\uptime-monitor\迁移-Fly到永久免费主机-方案.md`（§0.5 复审结论）

## 背景
Fly.io 账单实锤（2026-09 账期 $5.49，10-01 自动扣 Visa 4133）：org 为 Pay As You Go、新 org 无免费计算额度，2× shared-cpu-1x:512MB nrt 24/7 必然月费。Martin 铁律：**做项目不花钱 + 不绑卡**（Fly 曾称"绑卡不扣款"仍被扣）。Oracle Always-Free 因必须绑卡核验被排除。经复审唯一同时满足「不绑卡 + 永久 $0 + 24/7」的路径 = Cloudflare Workers（免费档，无需绑卡）。

## 决策
1. 运行时：Express 长驻进程 → Cloudflare Worker（Hono 路由，84 端点逐条迁移）。
2. 数据库：**SQL 零改动**，db.js 连接层改为每请求 `new Client({ connectionString: env.HYPERDRIVE.connectionString })`，经 Hyperdrive（免费档：10 万查询/天、2 条源库连接）连 Supabase Session Pooler（5432）。pg ≥ 8.16.3 + `nodejs_compat`（现用 pg@8.23 已满足）。
3. 定时任务：server.js 两个 setInterval → Cron Triggers（`* * * * *` 主检查循环 + 月报按日判断），沿用 `leader_lease` 防 cron 重叠双发。
4. 会话：express-session（connect-pg-simple，本就 DB 存储）→ 自研 DB-backed 会话中间件，保持 `session.userId / save / destroy` 接口语义。
5. 邮件：nodemailer/SMTP（裸 TCP 465，Workers 不可用）→ Resend HTTP API；email.js / alerts.js 仅换发送通道，模板不动。需 `RESEND_API_KEY`。
6. 静态资源：`public/` → Workers Assets（免费、请求不限量）。
7. 密钥：`.env` → Worker Secrets（不进 git）。
8. 切流：Cloudflare Worker Route 绑 `pingory.com`，秒级生效；回滚 = 移除 Route（Fly 在过渡期保留作热备）。

## 影响
- 检查间隔下限从 30s 变为 1 分钟（免费档 Cron 粒度）。
- 免费额度新约束：Workers 10 万请求/天、Hyperdrive 10 万查询/天、免费档每次调用 50 个 subrequest（监控量大时 cron 需分批）。
- 免费档 CPU 10ms/次：监控检查为 I/O 等待型，不构成瓶颈。
- Fly org 关停后保留不删（零成本热备位）。
