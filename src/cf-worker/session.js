// DB-backed 会话中间件（cf-worker 专属）—— express-session + connect-pg-simple 的替代实现
//
// 契约（ADR-0001 / 迁移架构规则 #3）：
//   · 复用同一张 "session" 表（sid varchar PK / sess json / expire timestamp(6)），
//     用户从 Fly 版切到 Worker 版登录态不丢；
//   · 读 connect.sid cookie → 查 session 表 → 提供 session.userId / save() / destroy()
//     同款语义（save 落库后才回包，与 server.js 注册/登录的显式 save 行为对齐）；
//   · cookie：httpOnly、sameSite=Lax、secure（PADDLE_ENVIRONMENT=live 或 NODE_ENV=production）、
//     7 天有效期，名字与 express-session 默认一致（connect.sid）。
//
// 与 express-session 的兼容细节：
//   express-session 下发的 cookie 值形如 `s:<sid>.<hmac>`（s: 前缀 = 签名标记）。
//   Worker 读取时剥掉 s: 前缀与 . 后的签名，直接取 sid 查库——sid 本身是随机 128bit，
//   不依赖签名做鉴权（与迁移规则一致：签名可选）。Worker 自己签发同款格式，
//   保证两端来回切换时浏览器 cookie 均有效。
//
// 错误语义对齐：session 表查询失败时向上抛（由 Hono onError 返回 500 server_error），
// 与 express-session store 出错经全局错误中间件返回 500 的行为一致。

import crypto from 'crypto';
import { getPool } from '../db.js';

const COOKIE_NAME = 'connect.sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 与 server.js express-session maxAge 一致

// 与 cookie-signature 包同款：val + '.' + HMAC-SHA256(secret, val) 的 base64（去尾 =）
function signSid(sid) {
  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  return crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '');
}

function cookieSecure() {
  return process.env.PADDLE_ENVIRONMENT === 'live' || process.env.NODE_ENV === 'production';
}

function parseCookie(header, name) {
  const raw = header || '';
  const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

// 's:<sid>.<sig>' → '<sid>'；裸 sid 原样返回
function stripSignature(val) {
  if (typeof val !== 'string') return null;
  let v = val;
  if (v.startsWith('s:')) v = v.slice(2);
  const dot = v.lastIndexOf('.');
  if (dot > 0) v = v.slice(0, dot);
  return v;
}

export function sessionMiddleware() {
  return async (c, next) => {
    const rawCookie = parseCookie(c.req.header('cookie'), COOKIE_NAME);
    const sid = /^[A-Za-z0-9_-]{16,128}$/.test(stripSignature(rawCookie) || '')
      ? stripSignature(rawCookie)
      : null;

    let data = {};
    let currentSid = null;
    if (sid) {
      // 与 connect-pg-simple 的读取语义一致：sid 命中且未过期才有效
      const pool = await getPool();
      const { rows } = await pool.query(
        'SELECT sess, expire FROM "session" WHERE sid = $1 AND expire > now()',
        [sid]
      );
      if (rows[0] && rows[0].sess && typeof rows[0].sess === 'object') {
        data = rows[0].sess;
        currentSid = sid;
      }
    }

    let destroyed = false;
    const sess = {
      get id() { return currentSid; },
      get userId() { return (data && data.userId) || null; },
      set userId(v) { data = { ...(data || {}), userId: v }; },
      // 显式落库后设置 cookie——路由侧 await save() 完成再回包（与 server.js 行为对齐）
      async save() {
        if (destroyed) return;
        if (!currentSid) currentSid = crypto.randomBytes(16).toString('hex');
        const expire = new Date(Date.now() + SESSION_TTL_MS);
        const pool = await getPool();
        await pool.query(
          `INSERT INTO "session" (sid, sess, expire)
           VALUES ($1, $2, $3)
           ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
          [currentSid, JSON.stringify(data), expire]
        );
        c.cookie(COOKIE_NAME, `s:${currentSid}.${signSid(currentSid)}`, {
          path: '/',
          httpOnly: true,
          sameSite: 'Lax',
          secure: cookieSecure(),
          maxAge: Math.floor(SESSION_TTL_MS / 1000),
        });
      },
      async destroy() {
        if (currentSid) {
          const pool = await getPool();
          await pool.query('DELETE FROM "session" WHERE sid = $1', [currentSid]).catch(() => {});
        }
        destroyed = true;
        data = {};
        currentSid = null;
        c.cookie(COOKIE_NAME, '', { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 0 });
      },
    };

    c.set('session', sess);
    await next();
  };
}
