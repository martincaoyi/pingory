// cf-worker 共享辅助（与 server.js 对应段落逐语义对齐：错误码 / 限流 / 校验 / 状态页 cookie）
// 原则：JSON 响应形状与错误码逐字节一致；仅把 Express 中间件形态翻译为 Hono 中间件形态。

import crypto from 'crypto';
import { isBlockedTarget } from '../ssrf-guard.js';

// ===== API 错误码（与 server.js E 完全一致，勿单独增删）=====
export const E = {
  AUTH_REQUIRED:            'auth_required',
  RATE_LIMITED:             'rate_limited',
  PLAN_MONITOR_LIMIT:       'plan_monitor_limit',
  EMAIL_VERIFY_REQUIRED:    'email_verify_required',
  URL_REQUIRED:             'url_required',
  URL_INVALID:              'url_invalid',
  PLAN_TYPE_NOT_SUPPORTED:  'plan_type_not_supported',
  PLAN_MIN_INTERVAL:        'plan_min_interval',
  MONITOR_NOT_FOUND:        'monitor_not_found',
  MONITOR_NO_PERM:          'monitor_not_found_or_no_perm',
  TREND_REQUIRES_STARTER:   'trend_requires_starter',
  SP_REQUIRES_STARTER:      'status_page_requires_starter',
  SP_PRO_ONLY:              'status_page_pro_only',
  SP_NOT_FOUND:             'status_page_not_found',
  SP_NO_DOMAIN:             'status_page_no_domain',
  WRONG_PASSWORD:           'wrong_password',
  FEEDBACK_EMPTY:           'feedback_empty',
  FEEDBACK_TOO_LONG:        'feedback_too_long',
  WAITLIST_EMAIL_INVALID:   'waitlist_email_invalid',
  WAITLIST_TOKEN_INVALID:   'waitlist_token_invalid',
  ADMIN_REQUIRED:           'admin_required',
  SERVER_ERROR:             'server_error',
  IMPORT_UNSUPPORTED:       'import_unsupported_format',
  IMPORT_NO_DATA:           'import_no_data',
  IMPORT_PARSE_FAILED:      'import_parse_failed',
  IMPORT_NO_MONITORS:       'import_no_monitors',
  SELF_BAN:                 'self_ban',
  SELF_DELETE:              'self_delete',
  INVALID_CONFIRM_LINK:     'invalid_confirmation_link',
  NO_TEAM:                  'no_team',
  MISSING_AUTH_HEADER:      'missing_auth_header',
  INVALID_API_KEY:          'invalid_api_key',
  USER_NOT_FOUND:           'user_not_found',
  INVALID_MONITOR_LIMIT:    'invalid_monitor_limit',
  INVALID_PLAN:             'invalid_plan',
  API_TYPE_NOT_SUPPORTED:   'api_type_not_supported',
  CHANNEL_NOT_SUPPORTED:    'channel_not_supported',
  CHANNEL_NOT_CONFIGURED:   'channel_not_configured',
  ENDPOINT_NOT_FOUND:       'endpoint_not_found',
  TARGET_BLOCKED:           'target_blocked',
};

/** 构造 i18n 错误响应 { error: code, ep: params } */
export function apiErr(code, params) { return { error: code, ep: params || {} }; }

// ===== 客户端 IP（与 server.js clientIp 同优先级；Worker 由 Cloudflare 强制写入 CF-Connecting-IP）=====
export function clientIp(c) {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return String(cf).trim();
  const fly = c.req.header('fly-client-ip');
  if (fly) return String(fly).trim();
  return 'unknown';
}

// recordUserEvent({...,req}) 的 Express req 形状垫片（src/events.js clientInfo 只读这两处）
export function reqShim(c) {
  return {
    headers: {
      'x-forwarded-for': c.req.header('x-forwarded-for'),
      'user-agent': c.req.header('user-agent'),
    },
    ip: clientIp(c),
  };
}

// ===== 内存限流（照搬 server.js makeRateLimiter；差异见下）=====
// ⚠️ 与 Express 版差异：Map 清理由「每请求惰性过滤」替代 setInterval（Workers 无常驻定时器）；
//    多 isolate 下各持一份计数，实际配额 = N × max（迁移规则允许：多 isolate 下减弱，DB 限流优先）。
export function makeRateLimiter(max = 10, windowMs = 15 * 60 * 1000) {
  const hits = new Map(); // ip -> [t]
  return async (c, next) => {
    const ip = clientIp(c);
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return c.json(apiErr(E.RATE_LIMITED), 429);
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10000) hits.clear(); // 异常保护，防 isolate 内存膨胀
    await next();
  };
}

// ===== JSON body 解析中间件（对齐 express.json() + express.raw() 的组合行为）=====
// · 保存原始文本到 rawBody（Paddle/Creem webhook 验签需要原文）
// · content-type 含 application/json 时解析为 body；无 content-type 时 body = {}（express.json 同款）
// · 畸形 JSON 抛给 onError → 500 server_error（与 Express 路径一致：body-parser 错误走全局错误中间件）
export async function jsonBodyParser(c, next) {
  const m = c.req.method;
  if (m === 'POST' || m === 'PATCH' || m === 'PUT' || m === 'DELETE') {
    let raw = '';
    try { raw = await c.req.raw.text(); } catch { raw = ''; }
    c.set('rawBody', raw);
    const ct = (c.req.header('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      if (raw.trim()) {
        try { c.set('body', JSON.parse(raw)); }
        catch { throw new Error('entity.parse.failed'); }
      } else {
        c.set('body', {});
      }
    } else {
      c.set('body', {});
    }
  }
  await next();
}

// ===== 监控 target 规范化（与 server.js normalizeTarget 逐行对齐）=====
export function normalizeTarget(type, rawUrl) {
  const s = String(rawUrl == null ? '' : rawUrl).trim();
  if (!s) return { err: apiErr(E.URL_REQUIRED) };
  const httpLike = ['http', 'keyword', 'api', 'heartbeat'];
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let candidate;
  if (httpLike.includes(type)) {
    const u = looksUrl ? s : 'https://' + s;
    try { candidate = new URL(u).toString(); }
    catch { return { err: apiErr(E.URL_INVALID, { url: s }) }; }
  } else if (looksUrl) {
    try { candidate = new URL(s).hostname; }
    catch { return { err: apiErr(E.URL_INVALID, { url: s }) }; }
  } else {
    candidate = s;
  }
  if (isBlockedTarget(candidate)) return { err: apiErr(E.TARGET_BLOCKED, { url: s }) };
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/i.test(candidate)) {
    console.warn('[security] 收到内嵌凭据的监控 URL（user:pass@），按原样入库；凭据内容绝不写入日志');
  }
  return { url: candidate };
}

// 渠道配置规范化（server.js normalizeChannelCfg 同款）
export function normalizeChannelCfg(ch, cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  if (ch === 'telegram') {
    const botToken = s(cfg.botToken), chatId = s(cfg.chatId);
    return (botToken && chatId) ? { botToken, chatId } : null;
  }
  const url = s(cfg.url);
  return url ? { url } : null;
}

// ===== 一键导入解析（server.js 同款）=====
export function safeJsonParse(s) { try { return JSON.parse(s); } catch { return {}; } }
export function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (!lines.length) return [];
  const splitLine = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const header = splitLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = splitLine(l);
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    return obj;
  });
}
export function normalizeGeneric(row) {
  const cfg = (typeof row.config === 'string' && row.config) ? safeJsonParse(row.config) : (row.config || {});
  return {
    name: row.name || row.url || 'Imported',
    url: (row.url || row.address || row.target || '').toString().trim(),
    type: (row.type || 'http').toString().toLowerCase(),
    interval: Number(row.interval) || 0,
    config: cfg,
  };
}
export function normalizeUptimeRobot(row) {
  let type = (row.type || row.monitor_type || 'HTTPS').toString().toUpperCase();
  let url = (row.url || row.address || '').toString().trim();
  const config = {};
  if (type === 'HTTPS' || type === 'HTTP') type = 'http';
  else if (type === 'PING') type = 'ping';
  else if (type === 'PORT') {
    type = 'tcp';
    const mm = url.match(/:(\d+)\s*$/);
    if (mm) { config.port = Number(mm[1]); url = url.replace(/:\d+\s*$/, ''); }
  } else if (type === 'KEYWORD') type = 'keyword';
  else if (type === 'HEARTBEAT') type = 'heartbeat';
  else type = 'http';
  if (row.keyword) config.keyword = String(row.keyword);
  return { name: row.name || url || 'Imported', url, type: type.toLowerCase(), interval: Number(row.interval) || 0, config };
}
export function parseImportMonitors(format, raw) {
  if (format === 'json') {
    const arr = JSON.parse(raw);
    const list = Array.isArray(arr) ? arr : (Array.isArray(arr?.monitors) ? arr.monitors : []);
    return list.map(normalizeGeneric);
  }
  if (format === 'csv') return parseCsv(raw).map(normalizeGeneric);
  if (format === 'uptimerobot') {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map(normalizeUptimeRobot); } catch {}
    return parseCsv(raw).map(normalizeUptimeRobot);
  }
  return [];
}

// ===== G7 私有状态页 capability cookie（server.js 同款 HMAC token）=====
function statusPageSecret() {
  return process.env.STATUS_PAGE_SECRET || process.env.SESSION_SECRET || 'pingory-status-default-secret';
}
export function statusPageToken(slug) {
  return crypto.createHmac('sha256', statusPageSecret()).update('sp:' + slug).digest('hex');
}
export function getCookie(c, name) {
  const raw = c.req.header('cookie') || '';
  const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
export function statusPageUnlocked(c, slug) {
  const v = getCookie(c, 'pingory_sp');
  if (!v) return false;
  const [s, t] = v.split('|');
  return s === slug && t === statusPageToken(slug);
}

// 公开状态页 sparkline 降采样（server.js dailySpark 同款）
export function dailySpark(series) {
  if (!series || !series.length) return [];
  const byDay = new Map();
  for (const p of series) {
    const day = new Date(p.ts).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p);
  }
  const out = [];
  for (const [day, arr] of byDay) {
    const rts = arr.filter((p) => p.rt != null).map((p) => p.rt);
    out.push({ day, avgRt: rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null, down: arr.some((p) => p.status === 'down') });
  }
  return out.slice(-30);
}

// ===== 守卫：管理员 / API Key（对齐 server.js requireAdmin / requireApiKey 的状态码语义）=====
// 注意：查询失败时向上抛（Hono onError → 500 server_error），与 Express 版 .catch(500) 对齐；
// 不能吞成 403，否则数据库抖动会被误报成「无权限」。
export async function requireAdmin(c) {
  const sess = c.get('session');
  if (!sess || !sess.userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
  const { getUserById } = await import('../auth.js');
  const u = await getUserById(sess.userId); // 抛错交 onError
  if (!u || u.role !== 'admin') return c.json(apiErr(E.ADMIN_REQUIRED), 403);
  c.set('admin', u);
  return null;
}
export async function requireApiKey(c) {
  const auth = c.req.header('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json(apiErr(E.MISSING_AUTH_HEADER), 401);
  const { getUserByApiKey } = await import('../auth.js');
  const u = await getUserByApiKey(m[1].trim()); // 抛错交 onError
  if (!u) return c.json(apiErr(E.INVALID_API_KEY), 403);
  c.set('apiUser', u);
  return null;
}
