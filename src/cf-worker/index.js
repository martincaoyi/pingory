// Pingory Worker 入口 —— Fly → Cloudflare 迁移（阶段 1 脚手架）
// 注意：目录名 cf-worker 是为避免与既有多区域探针服务 src/worker.js 混淆。
// 方案：D:\创业助手\方案资料\uptime-monitor\迁移-Fly到永久免费主机-方案.md（§0.5 复审结论）
//
// 端口映射总览：
//   Express app(server.js)  → Hono（本文件逐步接管）
//   setInterval ×2          → scheduled()（每分钟检查循环 + 月报按日判断）
//   express-session(pg存储) → DB-backed 会话中间件（同款 session.userId/save/destroy 接口）
//   pg Pool(Fly 直连)       → 每请求 new Client + env.HYPERDRIVE.connectionString（SQL 全保留）
//   nodemailer/SMTP         → Resend HTTP API（email.js / alerts.js 发送函数替换）
//   express.static(public)  → env.ASSETS.fetch()
import { Hono } from 'hono';

const app = new Hono();

// 健康检查（与 Fly 版 /health 语义对齐；region 标记 worker 便于切流观察）
app.get('/health', (c) => c.json({ ok: true, region: 'worker', ts: Date.now() }));

// TODO(阶段1) 迁移清单（按 server.js 端点顺序逐条搬）：
//  1) 全局中间件：session(DB-backed) / json body / rate limit(落库版) / 安全头
//  2) 路由：monitors CRUD、checks、auth、status pages、waitlist×3、admin、billing(Creem/Paddle)
//  3) db.js 连接层适配 Hyperdrive；SQL 语句零改动
//  4) email.js / alerts.js → Resend HTTP API（需 RESEND_API_KEY）
//  5) /api/* 之外仍有动态渲染的路径（状态页、sitemap 等）逐条接入 Hono 后才交给 ASSETS

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // API 与健康检查 → Hono 动态处理
    if (url.pathname === '/health' || url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    // TODO(阶段1)：动态路径补齐后，此处回落改为“Hono 全量接管 + ASSETS 兜底”
    return env.ASSETS.fetch(request);
  },

  // setInterval(检查循环) + monthlyReportTimer 的 Worker 形态
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      // TODO(阶段1)：
      //  1) leader_lease 抢租约（防 cron 重叠双发检查）
      //  2) 扫描 due 监控 → 逐个/并发下发检查（注意免费档 50 subrequest/次 上限，必要时分批）
      //  3) 落库检查结果 + 告警判定 + 慢响应/警告状态机
      //  4) 月初触发月报
    })());
  },
};
