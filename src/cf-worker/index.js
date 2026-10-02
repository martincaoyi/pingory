// Pingory Worker 入口 —— Fly → Cloudflare 迁移（ADR-0001）
// 注意：目录名 cf-worker 是为避免与既有多区域探针服务 src/worker.js 混淆。
//
// 结构：
//   env.js      环境变量桥 + Hyperdrive 注入（业务模块读 process.env 零改动）
//   session.js  DB-backed 会话中间件（复用 connect-pg-simple 的 session 表）
//   util.js     错误码 / 限流 / 共享辅助（与 server.js 逐语义对齐）
//   pages.js    动态页面路由（/ 、/compare/* ×12 、/status/:slug）
//   api.js      全部 /api/* 端点 + /health + /api 404 兜底
//   cron.js     scheduled：leader 租约 + 到期检查 + 保留清理 + 月报
//
// 路由次序与 server.js 对齐：安全头 → 动态页面路由 → session(/api) → API 路由 →
// /api 404 兜底 → ASSETS 静态兜底（对应 express.static）。
//
// ⚠️ 部署注意（wrangler.jsonc 由 owner 维护，本文件不改动它）：
//   Workers Assets 默认「先静态后 Worker」——与 ASSETS 同路径的请求不会进 Worker。
//   要让 / 、/api/* 、/status/* 、/compare/* 由本 Worker 接管，wrangler.jsonc 的
//   assets 段需要加 "run_worker_first": ["/", "/api/*", "/status/*", "/compare/*", "/vs/*", "/health"]
//   （或等效的 true）。未配置前，静态可直出的资源照常由 Assets 服务，行为兼容，
//   但根路径自定义域名状态页与 compare 别名 301 会被静态层抢先。
import { Hono } from 'hono';
import { setupDb } from './env.js';
import { sessionMiddleware } from './session.js';
import { registerApiRoutes } from './api.js';
import { registerPageRoutes } from './pages.js';
import { runCron } from './cron.js';

const app = new Hono();

// ===== 基础安全响应头（G-SEC，与 server.js 逐字节一致）=====
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()');
  c.header('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://cdn.paddle.com https://sandbox-cdn.paddle.com https://api.creem.io; style-src 'self' 'unsafe-inline' https://sandbox-cdn.paddle.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com https://cdn.paddle.com https://sandbox-cdn.paddle.com https://api.creem.io https://test-api.creem.io; frame-src https://*.paddle.com https://checkout.creem.io;"
  );
  await next();
});

// 动态页面路由（先于 API/静态，与 server.js 中段路由次序一致）
registerPageRoutes(app);

// 会话中间件仅挂 /api/*（express-session 全局挂载，但静态请求经 Assets 兜底后本就不进 Worker；
// 仅挂 /api/* 还省掉了静态路径上的无谓会话查询）
app.use('/api/*', sessionMiddleware());

// 全部 API 端点 + /health + /api 404 兜底
registerApiRoutes(app);

// 全局错误处理（P0-2 对齐：完整堆栈 + 瞬时故障 503 / 其余 500，响应体 {error, ep}）
app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${new URL(c.req.url).pathname} ::`, err && err.stack ? err.stack : err);
  const msg = String((err && err.message) || err || '');
  const transient = /timeout|Connection terminated|ECONNRESET|EPIPE|ECONNREFUSED|EAUTHTIMEOUT|ECIRCUITBREAKER/i.test(msg);
  return c.json({ error: 'server_error', ep: {} }, transient ? 503 : 500);
});

// 静态资源兜底（对应 express.static('public')）——必须注册在所有动态路由之后
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  async fetch(request, env, ctx) {
    // 环境变量桥 + Hyperdrive 连接注入（幂等；业务模块按 process.env 零改动复用）
    setupDb(env);
    return app.fetch(request, env, ctx);
  },

  // Cron：每分钟检查循环（leader 租约防重叠）+ 每小时保留清理 + 每月 1 号月报
  async scheduled(event, env, ctx) {
    setupDb(env);
    ctx.waitUntil(runCron().catch((e) => {
      console.error('[cron] 周期异常（不中断，下一轮继续）:', e && e.message);
    }));
  },
};
