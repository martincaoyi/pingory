// 监控存储 + 轮询核心（PostgreSQL 持久化）
// Phase 1 扩展：多检查类型(G1) / 区域探针(G3) / 检查明细(G6)

import crypto from 'crypto';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getPool } from './db.js';
import { getUserById } from './auth.js';
import { planFeatures } from './plans.js';
import { MON_ERR } from './monerr.js';

const execAsync = promisify(exec);

// 单点 HTTP/Keyword 检查超时（ms）。东京探针探远端偶发抖动，10s 偏紧易误判 down；
// 提到 15s，并允许经环境变量 CHECK_TIMEOUT_MS 调参，无需重新部署即可微调。
const HTTP_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS) || 15000;

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
  return {
    id,
    url,
    name: name || url,
    interval,
    type,
    config,
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

export async function saveMonitor(monitor) {
  const pool = await getPool();
  const cfg = monitor.config && typeof monitor.config === 'object' ? JSON.stringify(monitor.config) : (monitor.config || null);
  const ch = monitor.channels && typeof monitor.channels === 'object' ? JSON.stringify(monitor.channels) : (monitor.channels || null);
  await pool.query(
    `INSERT INTO monitors (id, url, name, interval, type, config, channels, status, status_public, last_checked, last_response_time, last_error, last_alert_at, alert_count, consecutive_failures, last_success_at, user_id, team_id)
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
       last_success_at     = EXCLUDED.last_success_at,
       team_id             = EXCLUDED.team_id`,
    [
      monitor.id, monitor.url, monitor.name, monitor.interval, monitor.type, cfg, ch,
      monitor.status, monitor.statusPublic ?? false, monitor.lastChecked ?? null,
      monitor.lastResponseTime ?? null, monitor.lastError ?? null, monitor.lastAlertAt ?? null,
      monitor.alertCount ?? 0, monitor.consecutiveFailures ?? 0, monitor.lastSuccessAt ?? null, monitor.userId || null,
      monitor.teamId || null,
    ]
  );
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
async function loadStatusPageUser(slugOrHost, byHost) {
  const pool = await getPool();
  const col = byHost ? 'status_custom_domain' : 'public_slug';
  const { rows } = await pool.query(
    `SELECT id, email, name, public_slug, status_page_enabled, status_white_label, status_password_hash, status_page_title
     FROM users WHERE ${col} = $1`,
    [slugOrHost]
  );
  if (!rows.length || !rows[0].status_page_enabled) return null;
  return rows[0];
}

export async function getStatusPage(slug) {
  const u = await loadStatusPageUser(slug, false);
  if (!u) return null;
  return buildStatusPage(u);
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

export async function deleteMonitor(id, userId) {
  const pool = await getPool();
  let rowCount;
  if (userId) {
    const { rowCount: n } = await pool.query('DELETE FROM monitors WHERE id = $1 AND user_id = $2', [id, userId]);
    rowCount = n;
  } else {
    const { rowCount: n } = await pool.query('DELETE FROM monitors WHERE id = $1 AND user_id IS NULL', [id]);
    rowCount = n;
  }
  return rowCount > 0;
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
  const p95Rt = rts.length ? rts.sort((a, b) => a - b)[Math.floor(rts.length * 0.95)] : null;
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
    const res = await fetch(url, {
      method: config.method || 'GET',
      redirect: 'follow',
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
    return { status: 'down', error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

async function checkKeyword(url, config) {
  const kw = config.keyword;
  if (!kw) return { status: 'down', error: MON_ERR.KW_MISSING };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Pingory/1.0' } });
    clearTimeout(timeout);
    if (!res.ok) return { status: 'down', error: `HTTP ${res.status}` };
    const body = await res.text();
    const found = config.keywordCaseSensitive
      ? body.includes(kw)
      : body.toLowerCase().includes(kw.toLowerCase());
    return found
      ? { status: 'up', error: null }
      : { status: 'down', error: MON_ERR.KW_NOT_FOUND + "|" + kw };
  } catch (err) {
    clearTimeout(timeout);
    return { status: 'down', error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

async function checkPing(host) {
  const flag = os.platform() === 'win32' ? '-n 1' : '-c 1';
  try {
    const { stdout } = await execAsync(`ping ${flag} ${host}`, { timeout: 8000 });
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

function checkSsl(host, port = 443, warnDays = 30) {
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

// 极简 WHOIS 客户端（仅取到期日，覆盖常见 TLD）
const WHOIS_SERVERS = {
  com: 'whois.verisign-grs.com', net: 'whois.verisign-grs.com', org: 'whois.pir.org',
  io: 'whois.nic.io', ai: 'whois.nic.ai', co: 'whois.nic.co', info: 'whois.afilias.net',
  me: 'whois.nic.me', dev: 'whois.nic.dev', app: 'whois.nic.app', xyz: 'whois.nic.xyz',
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
  const re = /(expiry date|expiration date|registry expiry date|paid-till|renewal date)\s*:\s*(.+)/i;
  const m = whoisText.match(re);
  if (!m) return null;
  const d = new Date(m[2].trim());
  return isNaN(d.getTime()) ? null : d.getTime();
}
async function checkDomain(domain, warnDays = 30) {
  const text = await whoisQuery(domain);
  const exp = parseExpiry(text);
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
    const res = await fetch(url, { method, headers, body, redirect: 'follow' });
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
    return { status: 'down', error: err.name === 'AbortError' ? 'timeout' : err.message };
  }
}

function checkDns(host, recordType = 'A', expected = []) {
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
export async function runLocalCheck(monitor) {
  const c = monitor.config || {};
  const t = monitor.type;
  const target = monitor.url;
  switch (t) {
    case 'keyword': return checkKeyword(target, c);
    case 'ping': return checkPing(target);
    case 'tcp': return checkTcp(target, c.port || 80);
    case 'ssl': return checkSsl(target, c.port || 443, c.sslWarnDays || 30);
    case 'domain': return checkDomain(target, c.domainWarnDays || 30);
    case 'api': return checkApi(target, c);
    case 'dns': return checkDns(target, c.recordType || 'A', c.expectedValues || []);
    case 'heartbeat': return checkHeartbeat(monitor);
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
export async function runLocalCheckRetry(monitor) {
  const start = Date.now();
  let res = await runLocalCheck(monitor);
  if (res.status === 'down' && isTransientError(res.error)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await runLocalCheck(monitor);
  }
  res.responseTime = res.responseTime ?? (Date.now() - start);
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
    if (res.status === 'down') { down++; lastError = res.error; }
    if (res.responseTime != null) lastRt = res.responseTime;
    if (res.warn) warn = res.warn;
  }
  const status = down >= confirm ? 'down' : 'up';
  return { status, responseTime: lastRt, error: status === 'down' ? lastError : null, warn, regions: regions.length };
}

// ============================================================
// 检查调度
// ============================================================
async function checkMonitor(monitor) {
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
  const isWarn = !!result.warn;
  const prevWarnAt = slowState.get(monitor.id) || 0;
  const warnFresh = isWarn && Date.now() - prevWarnAt > 10 * 60 * 1000;
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

  // Heartbeat 上报成功时间戳在端点更新；此处若 up 则刷新
  if (monitor.type === 'heartbeat' && result.status === 'up') {
    monitor.lastSuccessAt = Date.now();
  }

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
const INSTANCE_ID = `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
let isLeader = false;

// 供其它定时任务（如数据保留清理）复用同一把 leader 租约，避免双机重复劳动
export function isPollLeader() {
  return isLeader;
}

// 尝试取得/续租 leader 租约；返回 true = 本实例当前持有租约。
// holder/name 参数化以便测试模拟多实例竞争（生产用默认值）。
export async function tryAcquireLease(holder = INSTANCE_ID, name = LEASE_NAME) {
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
          console.log(`[poll] 本实例取得 leader 租约，开始轮询 (${INSTANCE_ID})`);
        } else if (!won && isLeader) {
          isLeader = false;
          console.warn(`[poll] leader 租约丢失，转为 standby (${INSTANCE_ID})`);
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
