// 用户行为事件：记录注册用户在站内做了什么操作，便于 admin 判断用户是否真正在使用 SaaS
// 设计原则：只记关键业务动作，不写页面浏览（已有 page_sessions）；metadata 用 JSON 保持灵活。

import crypto from 'crypto';
import { getPool } from './db.js';

export function parseJSON(str, fallback = null) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function clientInfo(req) {
  if (!req) return { ip: null, userAgent: null };
  const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim())
    || req.ip
    || req.socket?.remoteAddress
    || null;
  return { ip, userAgent: req.headers['user-agent'] || null };
}

export async function recordUserEvent({ userId, eventType, metadata = {}, req }) {
  if (!userId || !eventType) return;
  const pool = await getPool();
  const { ip, userAgent } = clientInfo(req);
  const meta = metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : null;
  try {
    await pool.query(
      `INSERT INTO user_events (id, user_id, event_type, metadata, ip, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [crypto.randomUUID(), userId, eventType, meta, ip, userAgent]
    );
  } catch (e) {
    console.error('[user_events] 记录失败:', e.message);
  }
}

export async function listUserEvents({ userId, eventType, limit = 100, offset = 0 }) {
  const pool = await getPool();
  const where = [];
  const params = [];
  let i = 1;
  if (userId) { where.push(`e.user_id = $${i++}`); params.push(userId); }
  if (eventType) { where.push(`e.event_type = $${i++}`); params.push(eventType); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT e.*, u.email AS user_email
     FROM user_events e
     LEFT JOIN users u ON u.id = e.user_id
     ${w}
     ORDER BY e.created_at DESC
     LIMIT $${i++} OFFSET $${i++}`,
    params
  );
  return rows.map((r) => ({ ...r, metadata: parseJSON(r.metadata, {}) }));
}

export async function getUserEventSummary(days = 1) {
  const pool = await getPool();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT event_type, COUNT(*)::int AS c
     FROM user_events
     WHERE created_at >= $1
     GROUP BY event_type ORDER BY c DESC`,
    [since]
  );
  const activeRes = await pool.query(
    `SELECT COUNT(DISTINCT user_id)::int AS c FROM user_events
     WHERE created_at >= $1 AND user_id IS NOT NULL`,
    [since]
  );
  return { since, counts: rows, activeUsers: activeRes.rows[0]?.c || 0 };
}

// 按用户分组活跃度排行：挑出高价值（高频）用户
export async function getUserActivityRanking({ days = 30, limit = 20 } = {}) {
  const pool = await getPool();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT e.user_id, u.email AS user_email,
            COUNT(*)::int AS event_count,
            COUNT(DISTINCT e.event_type)::int AS action_types,
            MAX(e.created_at) AS last_active
     FROM user_events e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.created_at >= $1 AND e.user_id IS NOT NULL
     GROUP BY e.user_id, u.email
     ORDER BY event_count DESC
     LIMIT $2`,
    [since, limit]
  );
  return rows;
}

// 沉睡用户：注册后几乎无动作 / 长时间未活跃，便于 admin 做召回
export async function getDormantUsers({ sinceDays = 30, limit = 20 } = {}) {
  const pool = await getPool();
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.email,
            u.created_at,
            COALESCE((SELECT COUNT(*)::int FROM user_events e WHERE e.user_id = u.id), 0) AS total_events,
            (SELECT MAX(e.created_at) FROM user_events e WHERE e.user_id = u.id) AS last_active
     FROM users u
     WHERE u.role = 'user'
       AND (
         (SELECT MAX(e.created_at) FROM user_events e WHERE e.user_id = u.id) IS NULL
         OR (SELECT MAX(e.created_at) FROM user_events e WHERE e.user_id = u.id) < $1
       )
     ORDER BY (SELECT MAX(e.created_at) FROM user_events e WHERE e.user_id = u.id) ASC NULLS FIRST,
              u.created_at DESC
     LIMIT $2`,
    [since, limit]
  );
  return rows;
}
