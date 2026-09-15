// 用户认证：注册 / 登录 / 会话辅助
// 密码哈希用 Node 内置 crypto.scrypt（不引入 bcrypt 依赖）

import crypto from 'crypto';
import { getPool } from './db.js';

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt}$${derived.toString('hex')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt') return resolve(false);
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(derived.toString('hex') === hash);
    });
  });
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || null,
    plan: row.plan,
    paddleCustomerId: row.paddle_customer_id,
    paddleSubscriptionId: row.paddle_subscription_id,
    publicSlug: row.public_slug,
    statusPageEnabled: row.status_page_enabled,
    statusCustomDomain: row.status_custom_domain || null,
    statusWhiteLabel: !!row.status_white_label,
    emailVerified: !!row.email_verified,
    hasPassword: !!row.password_hash,
    role: row.role || 'user',
    banned: !!row.banned,
    monitorLimit: row.monitor_limit ?? null,
    lastLogin: row.last_login ?? null,
    apiKey: row.api_key || null,
    teamId: row.team_id || null,
    teamRole: row.team_role || 'owner',
    referralCode: row.referral_code || null,
    referredBy: row.referred_by || null,
    createdAt: row.created_at,
  };
}

// ===== 推荐码系统（替代 MSP 代理：轻量 10% 提成）=====
// 生成全局唯一的推广码（pk_ref_ + base64url 随机串），碰撞时重试
async function genReferralCode() {
  const pool = await getPool();
  for (let i = 0; i < 5; i++) {
    const code = 'pk_ref_' + crypto.randomBytes(9).toString('base64url');
    const { rows } = await pool.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (rows.length === 0) return code;
  }
  // 极端碰撞兜底
  return 'pk_ref_' + crypto.randomBytes(9).toString('base64url') + Date.now().toString(36);
}

// ===== G7 私有状态页密码（复用 scrypt）=====
export async function hashPagePassword(password) {
  return hashPassword(password);
}
export async function verifyPagePassword(password, stored) {
  if (!stored) return false;
  return verifyPassword(password, stored);
}

function genSlug(email) {
  const base = String(email).split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase() || 'user';
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

export async function registerUser(email, password, name, referralCode) {
  const pool = await getPool();
  const normEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) {
    throw new Error('Invalid email format');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  // 解析推荐人：仅当推广码存在且对应到某真实用户时建立推荐关系（不允许填自己的码）
  let referrerId = null;
  if (referralCode && typeof referralCode === 'string' && referralCode.trim()) {
    const code = referralCode.trim();
    const { rows: ref } = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (ref.length > 0) referrerId = ref[0].id;
  }
  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();
  const slug = genSlug(normEmail);
  const myCode = await genReferralCode();
  // 若注册邮箱与超级管理员邮箱一致，自动成为 admin（并解锁 Pro 能力）
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const isAdmin = normEmail === adminEmail;
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash, plan, public_slug, name, role, email_verified, referral_code, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [id, normEmail, passwordHash, isAdmin ? 'pro' : 'free', slug,
     name ? String(name).trim() : null, isAdmin ? 'admin' : 'user', isAdmin ? true : false,
     myCode, referrerId]
  );
  if (rows.length === 0) throw new Error('This email is already registered');
  // 建立推荐记录（pending，待被推荐人付费转化后再记提成）；同一被推荐人仅一次
  if (referrerId) {
    await pool.query(
      `INSERT INTO referrals (id, referrer_id, referred_id, status)
       VALUES ($1,$2,$3,'pending') ON CONFLICT (referred_id) DO NOTHING`,
      [crypto.randomUUID(), referrerId, id]
    );
  }
  return rowToUser(rows[0]);
}

// OAuth 登录（Google / GitHub）：邮箱由身份提供商保证已验证；无密码（仅 OAuth 登录）。
// 推荐码同样生效（从 state 透传的 ref 传入）。
export async function createOAuthUser(email, name, referralCode) {
  const pool = await getPool();
  const normEmail = String(email).trim().toLowerCase();
  let referrerId = null;
  if (referralCode && typeof referralCode === 'string' && referralCode.trim()) {
    const { rows: ref } = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referralCode.trim()]);
    if (ref.length > 0) referrerId = ref[0].id;
  }
  const id = crypto.randomUUID();
  const slug = genSlug(normEmail);
  const myCode = await genReferralCode();
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, password_hash, plan, public_slug, name, role, email_verified, referral_code, referred_by)
     VALUES ($1,$2,NULL,'free',$3,$4,'user',true,$5,$6)
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [id, normEmail, slug, name ? String(name).trim() : null, myCode, referrerId]
  );
  if (rows.length === 0) throw new Error('This email is already registered');
  if (referrerId) {
    await pool.query(
      `INSERT INTO referrals (id, referrer_id, referred_id, status)
       VALUES ($1,$2,$3,'pending') ON CONFLICT (referred_id) DO NOTHING`,
      [crypto.randomUUID(), referrerId, id]
    );
  }
  return rowToUser(rows[0]);
}

export async function loginUser(email, password) {
  const pool = await getPool();
  const normEmail = String(email).trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [normEmail]);
  if (rows.length === 0) throw new Error('Invalid email or password');
  const row = rows[0];
  // 封禁账号直接拒绝登录（不暴露账号是否存在）
  if (row.banned) throw new Error('Invalid email or password');
  // OAuth 用户无密码（password_hash 为 NULL），拒绝密码登录（2026-09-07 schema 已放开 NOT NULL）
  if (!row.password_hash) throw new Error('Invalid email or password');
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) throw new Error('Invalid email or password');
  // 记录最后登录时间
  await pool.query('UPDATE users SET last_login = $2 WHERE id = $1', [row.id, Date.now()]);
  return rowToUser(row);
}

export async function getUserById(id) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

// 按邮箱查（Paddle webhook 用 customer email 关联）
export async function getUserByEmail(email) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).trim().toLowerCase()]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

// ===== 账户级告警渠道凭据（P0-5 Plan A）=====
// 单独存取，不并入 rowToUser，避免凭据泄漏进 /api/me、管理后台用户列表等响应。
export async function getAlertChannels(userId) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT alert_channels FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !rows[0].alert_channels) return {};
  try {
    const o = JSON.parse(rows[0].alert_channels);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}

export async function saveAlertChannels(userId, channels) {
  const pool = await getPool();
  const clean = (channels && typeof channels === 'object' && !Array.isArray(channels)) ? channels : {};
  await pool.query('UPDATE users SET alert_channels = $2 WHERE id = $1', [userId, JSON.stringify(clean)]);
  return clean;
}

// ===== 邮箱验证（G-SEC）=====
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 验证令牌 24 小时有效

// 生成并保存一次性验证令牌，返回 token（邮箱不存在返回 null）
export async function createEmailVerification(email) {
  const pool = await getPool();
  const normEmail = String(email).trim().toLowerCase();
  const token = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + VERIFY_TTL_MS;
  const { rowCount } = await pool.query(
    'UPDATE users SET verify_token = $2, verify_expires = $3 WHERE email = $1',
    [normEmail, token, expires]
  );
  return rowCount > 0 ? token : null;
}

// 校验令牌：有效则置 email_verified=true 并清空令牌，返回 user；否则返回 null
export async function verifyEmailToken(token) {
  if (!token) return null;
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM users WHERE verify_token = $1', [token]);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row.verify_expires || Date.now() > Number(row.verify_expires)) return null;
  await pool.query(
    'UPDATE users SET email_verified = true, verify_token = NULL, verify_expires = NULL WHERE id = $1',
    [row.id]
  );
  return rowToUser(row);
}

// ===== 账户自助管理（P0-3：改密码 / 改昵称 / 改邮箱 / 忘记密码）=====
// 复用 verifyPassword / hashPassword / verify_token；verify_expires 统一 TTL

// 修改密码：需旧密码校验（仅密码用户）；OAuth 用户（password_hash 为 NULL）应先调 setPassword
export async function changePassword(userId, oldPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
  const pool = await getPool();
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) throw new Error('User not found');
  const row = rows[0];
  if (!row.password_hash) throw new Error('This account uses social sign-in; please set a password first');
  const ok = await verifyPassword(oldPassword, row.password_hash);
  if (!ok) throw new Error('Current password is incorrect');
  const passwordHash = await hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

// OAuth 用户设置密码（无需旧密码）——仅限 password_hash 为 NULL 的 OAuth-only 用户；
// 密码用户必须走 changePassword 验旧密码，防止绕过旧密码校验直接覆盖
export async function setPassword(userId, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
  const pool = await getPool();
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (rows.length === 0) throw new Error('User not found');
  if (rows[0].password_hash) throw new Error('Password already set; please use change password with your current password');
  const passwordHash = await hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

// 修改昵称（截断 100 字符，防超长输入）
export async function updateProfileName(userId, name) {
  const pool = await getPool();
  await pool.query('UPDATE users SET name = $2 WHERE id = $1', [userId, name ? String(name).trim().slice(0, 100) : null]);
}

// 请求改邮箱：生成令牌存 pending_email + verify_token，返回 token（供发信）
export async function requestEmailChange(userId, newEmail) {
  const normEmail = String(newEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) throw new Error('Invalid email format');
  const pool = await getPool();
  const { rows: cur } = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  if (cur.length === 0) throw new Error('User not found');
  if (cur[0].email === normEmail) throw new Error('That is already your current email');
  const { rows: ex } = await pool.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [normEmail, userId]);
  if (ex.length > 0) throw new Error('This email is already registered');
  const token = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + VERIFY_TTL_MS;
  await pool.query(
    'UPDATE users SET pending_email = $2, verify_token = $3, verify_expires = $4 WHERE id = $1',
    [userId, normEmail, token, expires]
  );
  return token;
}

// 确认改邮箱：校验 token → 复检新邮箱唯一性（防请求后到确认前的竞态占用）→ 写入并置 verified
export async function confirmEmailChange(token) {
  if (!token) return null;
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM users WHERE verify_token = $1 AND pending_email IS NOT NULL', [token]);
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row.verify_expires || Date.now() > Number(row.verify_expires)) return null;
  const { rows: dup } = await pool.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [row.pending_email, row.id]);
  if (dup.length > 0) {
    // 新邮箱在等待确认期间被他人注册：清空 pending 令牌，让用户重新发起
    await pool.query('UPDATE users SET pending_email = NULL, verify_token = NULL, verify_expires = NULL WHERE id = $1', [row.id]);
    throw new Error('This email is already registered');
  }
  await pool.query(
    'UPDATE users SET email = pending_email, email_verified = true, pending_email = NULL, verify_token = NULL, verify_expires = NULL WHERE id = $1',
    [row.id]
  );
  row.email = row.pending_email;
  row.email_verified = true;
  row.pending_email = null;
  return rowToUser(row);
}

// 请求密码重置（忘记密码）：仅密码用户；OAuth 用户返回 null（不生成令牌，不暴露账号类型）
export async function requestPasswordReset(email) {
  const normEmail = String(email || '').trim().toLowerCase();
  const pool = await getPool();
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [normEmail]);
  if (rows.length === 0 || !rows[0].password_hash) return null;
  const token = crypto.randomBytes(24).toString('hex');
  const expires = Date.now() + VERIFY_TTL_MS;
  await pool.query('UPDATE users SET verify_token = $2, verify_expires = $3, pending_email = NULL WHERE id = $1', [rows[0].id, token, expires]);
  return token;
}

// 用令牌重置密码（忘记密码）：校验后写入新密码并清空令牌
export async function resetPassword(token, newPassword) {
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
  if (!token) throw new Error('Invalid or expired reset link');
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM users WHERE verify_token = $1', [token]);
  if (rows.length === 0) throw new Error('Invalid or expired reset link');
  const row = rows[0];
  if (!row.verify_expires || Date.now() > Number(row.verify_expires)) throw new Error('Invalid or expired reset link');
  const passwordHash = await hashPassword(newPassword);
  await pool.query('UPDATE users SET password_hash = $2, verify_token = NULL, verify_expires = NULL, pending_email = NULL WHERE id = $1', [row.id, passwordHash]);
}

// 修改角色（user / admin）——超级管理员后台用
export async function setRole(userId, role) {
  const pool = await getPool();
  await pool.query('UPDATE users SET role = $2 WHERE id = $1', [userId, role === 'admin' ? 'admin' : 'user']);
}

// 启动时自动建立超级管理员（从环境变量读取凭据；不设置则不建）
// 已存在则保证其为 admin + 已验证邮箱（不覆盖密码）
export async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const pool = await getPool();
  const normEmail = String(email).trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [normEmail]);
  if (rows.length === 0) {
    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    const slug = genSlug(normEmail);
    const myCode = await genReferralCode();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, plan, public_slug, email_verified, role, referral_code)
       VALUES ($1,$2,$3,'pro',$4,true,'admin',$5)`,
      [id, normEmail, passwordHash, slug, myCode]
    );
    console.log('[auth] 已创建超级管理员账号:', normEmail);
  } else {
    const myCode = await genReferralCode();
    await pool.query(
      'UPDATE users SET role = $2, email_verified = true, plan = $3, referral_code = COALESCE(referral_code, $4) WHERE id = $1',
      [rows[0].id, 'admin', 'pro', myCode]
    );
    console.log('[auth] 超级管理员账号已就绪:', normEmail);
  }
}

export async function updatePlan(userId, plan, extra = {}) {
  const pool = await getPool();
  await pool.query(
    `UPDATE users SET plan = $2, paddle_customer_id = COALESCE($3, paddle_customer_id),
       paddle_subscription_id = COALESCE($4, paddle_subscription_id) WHERE id = $1`,
    [userId, plan, extra.customerId || null, extra.subscriptionId || null]
  );
}

// 方案C：归一化账单事件落库（provider-agnostic，Paddle / Creem / 未来渠道统一入口）
// 幂等：同一 (provider, provider_event_id) 仅写一次（webhook 重放/重试安全）。
// 入参 ev: { userId, provider, eventType, plan?, billingCycle?, amountCents?, currency?, providerEventId? }
export async function recordBillingEvent(ev) {
  const pool = await getPool();
  const {
    userId, provider, eventType, plan = null,
    billingCycle = 'monthly', amountCents = 0, currency = 'USD', providerEventId = null,
  } = ev || {};
  if (!userId || !provider || !eventType) throw new Error('recordBillingEvent: userId / provider / eventType 必填');
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO billing_events (id, user_id, provider, event_type, plan, billing_cycle, amount_cents, currency, provider_event_id, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [id, userId, provider, eventType, plan, billingCycle, Number(amountCents) || 0, currency, providerEventId]
  );
  return id;
}

// 更新公开状态页设置（G7 扩展：自定义域名 / 白标 / 私有密码）
export async function updateStatusPage(userId, { enabled, slug, customDomain, whiteLabel, password } = {}) {
  const pool = await getPool();
  const sets = [];
  const params = [userId];
  let i = 2;
  if (enabled !== undefined) { sets.push(`status_page_enabled = $${i++}`); params.push(!!enabled); }
  if (slug) { sets.push(`public_slug = $${i++}`); params.push(slug); }
  if (customDomain !== undefined) {
    const cd = String(customDomain || '').trim().toLowerCase() || null;
    sets.push(`status_custom_domain = $${i++}`); params.push(cd);
  }
  if (whiteLabel !== undefined) { sets.push(`status_white_label = $${i++}`); params.push(!!whiteLabel); }
  if (password !== undefined) {
    if (password) {
      const h = await hashPagePassword(password);
      sets.push(`status_password_hash = $${i++}`); params.push(h);
    } else {
      sets.push(`status_password_hash = NULL`);
    }
  }
  if (sets.length === 0) return;
  await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
}

// ===== G7 状态页订阅者 =====
export async function addSubscriber(userId, email) {
  const pool = await getPool();
  const normEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normEmail)) throw new Error('Subscriber email format is invalid');
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO status_subscribers (id, user_id, email) VALUES ($1,$2,$3) ON CONFLICT (user_id, email) DO NOTHING',
    [id, userId, normEmail]
  );
  return normEmail;
}
export async function listSubscribers(userId) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT id, email, created_at FROM status_subscribers WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return rows;
}
export async function removeSubscriber(userId, subId) {
  const pool = await getPool();
  const { rowCount } = await pool.query('DELETE FROM status_subscribers WHERE id = $1 AND user_id = $2', [subId, userId]);
  return rowCount > 0;
}
// 取某状态页主的所有订阅者邮箱（用于事件通知）
export async function getSubscriberEmails(userId) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT email FROM status_subscribers WHERE user_id = $1', [userId]);
  return rows.map((r) => r.email);
}

// ===== G8 维护窗口 =====
export async function createMaintenanceWindow(userId, { title, monitorIds, startAt, endAt }) {
  const pool = await getPool();
  if (!startAt || !endAt) throw new Error('Maintenance window requires start and end time');
  if (Number(endAt) <= Number(startAt)) throw new Error('End time must be after start time');
  const ids = Array.isArray(monitorIds) ? JSON.stringify(monitorIds) : (monitorIds === 'all' ? 'all' : null);
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO maintenance_windows (id, user_id, monitor_ids, title, start_at, end_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, userId, ids, title || '维护窗口', Number(startAt), Number(endAt)]
  );
  return id;
}
export async function listMaintenanceWindows(userId) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM maintenance_windows WHERE user_id = $1 ORDER BY start_at DESC', [userId]);
  return rows.map((r) => ({
    id: r.id, title: r.title, monitorIds: r.monitor_ids === 'all' ? 'all' : (r.monitor_ids ? JSON.parse(r.monitor_ids) : []),
    startAt: Number(r.start_at), endAt: Number(r.end_at), createdAt: r.created_at,
  }));
}
export async function deleteMaintenanceWindow(userId, mwId) {
  const pool = await getPool();
  const { rowCount } = await pool.query('DELETE FROM maintenance_windows WHERE id = $1 AND user_id = $2', [mwId, userId]);
  return rowCount > 0;
}
// 判断某监控此刻是否处于维护窗口（覆盖则跳过告警）。monitorIds 为空数组表示未指定（不覆盖）。
export async function isMonitorInMaintenance(userId, monitorId) {
  const pool = await getPool();
  const now = Date.now();
  const { rows } = await pool.query(
    'SELECT monitor_ids FROM maintenance_windows WHERE user_id = $1 AND start_at <= $2 AND end_at >= $2',
    [userId, now]
  );
  for (const r of rows) {
    if (r.monitor_ids === 'all') return true;
    try {
      const arr = JSON.parse(r.monitor_ids || '[]');
      if (Array.isArray(arr) && arr.includes(monitorId)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// ===== G9 Account API：api_key =====
export async function ensureApiKey(userId) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT api_key FROM users WHERE id = $1', [userId]);
  if (rows[0]?.api_key) return rows[0].api_key;
  const key = 'pk_' + crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET api_key = $2 WHERE id = $1', [userId, key]);
  return key;
}
export async function regenerateApiKey(userId) {
  const pool = await getPool();
  const key = 'pk_' + crypto.randomBytes(24).toString('hex');
  await pool.query('UPDATE users SET api_key = $2 WHERE id = $1', [userId, key]);
  return key;
}
export async function getUserByApiKey(apiKey) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM users WHERE api_key = $1', [apiKey]);
  return rows[0] ? rowToUser(rows[0]) : null;
}
// 团队与 Account API 共用：按 api_key 取可操作监控归属（自身或团队）
export async function getMonitorOwnerScope(userId) {
  const u = await getUserById(userId);
  if (!u) return { userId };
  if (u.teamId) return { userId, teamId: u.teamId };
  return { userId };
}

// ===== G9 团队席位 =====
export async function createTeam(ownerId, name) {
  const pool = await getPool();
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO teams (id, name, owner_id) VALUES ($1,$2,$3)', [id, name || 'My Team', ownerId]);
  // 创建者归入团队并设为 owner
  await pool.query('UPDATE users SET team_id = $2, team_role = $3 WHERE id = $1', [ownerId, id, 'owner']);
  // 其已有监控一并归入团队（共享可见）
  await pool.query('UPDATE monitors SET team_id = $2 WHERE user_id = $1', [ownerId, id]);
  return id;
}
// 邀请成员：按邮箱；已注册则直接归入团队，未注册则标记待加入（注册后由 acceptTeamInvite 处理）
export async function inviteTeamMember(teamId, ownerId, email) {
  const pool = await getPool();
  const normEmail = String(email).trim().toLowerCase();
  // 校验团队归属
  const { rows: t } = await pool.query('SELECT * FROM teams WHERE id = $1 AND owner_id = $2', [teamId, ownerId]);
  if (rows.length === 0) throw new Error('No permission to operate this team');  const { rows: u } = await pool.query('SELECT * FROM users WHERE email = $1', [normEmail]);
  if (u.length === 0) throw new Error('This email is not registered yet; ask them to sign up first');
  if (u[0].team_id === teamId) return 'already';
  // 归入团队
  await pool.query('UPDATE users SET team_id = $2, team_role = $3 WHERE id = $1', [u[0].id, teamId, 'member']);
  await pool.query('UPDATE monitors SET team_id = $2 WHERE user_id = $1', [u[0].id, teamId]);
  return 'joined';
}
export async function listTeam(teamId) {
  const pool = await getPool();
  const { rows: t } = await pool.query('SELECT * FROM teams WHERE id = $1', [teamId]);
  if (rows.length === 0) return null;
  const { rows: members } = await pool.query(
    'SELECT id, email, plan, team_role FROM users WHERE team_id = $1 ORDER BY team_role, email',
    [teamId]
  );
  const { rows: mon } = await pool.query(
    'SELECT id, name, url, type, status FROM monitors WHERE team_id = $1 ORDER BY created_at DESC',
    [teamId]
  );
  return { id: t[0].id, name: t[0].name, members, monitors: mon };
}
export async function leaveTeam(userId) {
  const pool = await getPool();
  await pool.query('UPDATE monitors SET team_id = NULL WHERE user_id = $1', [userId]);
  await pool.query('UPDATE users SET team_id = NULL, team_role = $3 WHERE id = $1', [userId, 'owner']);
}

// ===== 推荐码：付费转化记提成 + 推荐人统计 =====
// 被推荐人付费转化后由 Paddle webhook 调用：把该推荐记录从 pending 改为 paid，并写入 10% 提成。
// 幂等：仅当仍为 pending 时才记，避免 subscription.updated / 重复事件重复发提成。
export async function recordReferralConversion(referredId, commission, currency) {
  const pool = await getPool();
  const { rowCount } = await pool.query(
    `UPDATE referrals SET status = 'paid', commission = $2, currency = $3
     WHERE referred_id = $1 AND status = 'pending'`,
    [referredId, commission, currency || 'USD']
  );
  return rowCount > 0;
}

// 推荐人视角：累计推荐数、已付费数、待付费数、累计提成（已 paid 之和，按主单位换算）
export async function getReferralStats(referrerId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS cnt, COALESCE(SUM(commission),0) AS sum
     FROM referrals WHERE referrer_id = $1 GROUP BY status`,
    [referrerId]
  );
  let total = 0, paid = 0, pending = 0, earnings = 0;
  for (const r of rows) {
    const cnt = Number(r.cnt);
    if (r.status === 'paid') { paid = cnt; earnings = Number(r.sum) / 100; }
    else { pending += cnt; }
    total += cnt;
  }
  return { totalReferred: total, paidCount: paid, pendingCount: pending, earnings, currency: 'USD' };
}

