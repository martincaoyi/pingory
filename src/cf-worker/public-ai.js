// 公开 AI Readability 检查端点（D43）—— 免费页 /llms-txt-checker 的数据源
//
// 契约：GET /api/public/ai-check?domain=example.com
//   · 只回公开字段，绝不透出 fingerprint / snapshot / 内部 reason / diff
//   · 落库限流（单 IP 10 次/10 分钟 + 全局 3000 次/天），内存版 makeRateLimiter 在多
//     isolate 下等于没有配额，而本端点每次都会替第三方抓 4 个 URL，必须落库
//   · 命中缓存不消耗配额：先查 Cache API，未命中才计数
//   · 不写 Access-Control-Allow-Origin：本端点只给同源页面用，通配等于开放白嫖
//
// 公开状态与引擎状态的映射：
//   引擎 down                 → down（核心项 fail 或站点不可达）
//   引擎 up + unknown         → unknown（被 WAF 拦，分数未知；绝不能显示 0 分）
//   引擎 up + 核心项含 warn    → warn（增强项 warn 只扣分，不改状态）
//   引擎 up + 其余            → ok

import crypto from 'crypto';
import { getPool } from '../db.js';
import { clientIp } from './util.js';
import { checkAiVisibility, normalizeDomain, AI_CRAWLERS, ITEM_WEIGHTS } from '../ai-visibility.js';
import { safeFetch } from '../ssrf-guard.js';

// ===== 配额 =====
const WINDOW_SECONDS = 600;          // 单 IP 固定窗口 10 分钟
const PER_IP_LIMIT = 10;             // 单 IP 每窗口 10 次
const DAY_SECONDS = 86400;           // 全局日窗口
const GLOBAL_DAILY_LIMIT = 3000;     // 全局日预算（防分布式刷爆上游抓取成本）
const GLOBAL_KEY = '__global__';     // 全局桶的 ip_hash 哨兵值（不是真实 IP 的哈希）

// ===== 缓存 =====
const CACHE_ORIGIN = 'https://pingory.com';
const CACHE_PATH = '/__ai-check-cache/';
const CACHE_TTL_SECONDS = 300;

// ===== 超时 =====
const OUTER_TIMEOUT_MS = 12000;      // checkAiVisibility 内部 10s，外层再兜 2s

const DEFAULT_SALT = 'pingory-ai-check-v1';
const NO_STORE = { 'Cache-Control': 'no-store' };

function pubErr(code) {
  return { ok: false, error: { code } };
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

/**
 * 严格域名校验：本端点只接受裸域名。
 *
 * normalizeDomain 本身允许 `https://example.com/path`（监控场景需要），但公开端点接受
 * 完整 URL 会带来两个问题：① 用户以为可以贴任意页面，实际只检查首页；② URL 里的
 * userinfo / 端口 / 路径会扩大探测面。故先做「不含 scheme / 路径 / userinfo / 端口」的字面拒绝。
 *
 * @returns {string} 合法 hostname，非法返回 ''
 */
export function strictPublicDomain(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 253) return '';
  if (/[\s<>"'`\\]/.test(s)) return '';
  if (s.includes('://') || s.includes('/') || s.includes('?') || s.includes('#') ||
    s.includes('@') || s.includes(':')) return '';
  // normalizeDomain 负责 IP 字面量 / localhost / .local / .internal / 标签长度等硬校验
  return normalizeDomain(s);
}

/**
 * 原子自增固定窗口计数器。
 *
 * window_start 只用 SQL 计算（不使用 Node 侧时间），避免多 isolate 时钟漂移把
 * 同一个窗口切成两个桶 → 配额翻倍。
 *
 * @returns {Promise<{hits:number, retryAfter:number}>}
 */
export async function bumpCounter(pool, ipHash, windowSeconds) {
  const { rows } = await pool.query(
    `WITH w AS (
       SELECT to_timestamp(floor(extract(epoch from now()) / $2::double precision) * $2::double precision) AS ws
     )
     INSERT INTO ai_check_rate (ip_hash, window_start, hits)
     SELECT $1, w.ws, 1 FROM w
     ON CONFLICT (ip_hash, window_start)
     DO UPDATE SET hits = ai_check_rate.hits + 1
     RETURNING hits,
       GREATEST(1, ceil(extract(epoch from (
         window_start + ($2::double precision * interval '1 second') - now()
       ))))::int AS retry_after`,
    [ipHash, windowSeconds]
  );
  return { hits: Number(rows[0].hits), retryAfter: Number(rows[0].retry_after) || 1 };
}

// ===== 公开文案（内部 reason → 公开短码 / 人话建议）=====

// 白名单映射：任何不在表里的内部 reason 一律降级为 status，绝不透传原文
const PUBLIC_REASON = {
  ok: 'ok',
  missing: 'missing',
  fetch_failed: 'unreachable',
  http_error: 'http_error',
  parse_warnings: 'malformed',
  html_response: 'html_response',
  no_restrictions: 'no_restrictions',
  unavailable: 'unavailable',
  training_opt_out: 'training_opt_out',
  partial_block: 'partial_block',
  all_search_blocked: 'search_blocked',
  all_allowed: 'all_allowed',
  invalid_format: 'invalid_format',
  empty: 'empty',
  invalid: 'invalid',
  incomplete: 'incomplete',
  js_shell: 'js_shell',
  thin_minimal: 'thin',
  thin: 'thin',
  noindex: 'noindex',
  restricted: 'restricted',
  cross_domain: 'cross_domain',
  different_path: 'different_path',
  protocol_mismatch: 'protocol_mismatch',
  issues: 'issues',
  missing_all: 'missing',
  partial: 'partial',
  multiple: 'multiple',
  no_images: 'no_images',
  missing_alt: 'missing_alt',
  unreachable: 'unreachable',
  probe_blocked: 'probe_blocked',
};

const HINTS = {
  robots_txt: {
    pass: 'robots.txt is served as plain text. Keep your AI crawler rules explicit.',
    warn: 'Serve a valid /robots.txt as text/plain so crawlers can read your rules.',
    fail: 'Serve a valid /robots.txt as text/plain so crawlers can read your rules.',
  },
  crawler_matrix: {
    pass: 'All eight tracked AI crawlers can reach the page. No change needed.',
    warn: 'Review the blocked names: if you want AI answers to cite you, keep retrieval crawlers allowed.',
    fail: 'Every retrieval crawler is blocked, so ChatGPT, Claude and Perplexity cannot fetch this page.',
  },
  // D44 审阅修复：训练组禁用 + 检索组放行是 2026 主流正确策略，不是问题。
  // 引擎仍把它标成 warn（它只是一个「与默认不同」的信号），公开层必须降级为 pass，
  // 否则页面文案写「不是失败」而徽章显示 warn，自相矛盾。
  crawler_matrix__training_opt_out: {
    pass: 'Training-group crawlers are blocked while retrieval crawlers are allowed. This is a valid 2026 policy: it limits future model training without removing you from answers today.',
  },
  llms_txt: {
    pass: 'llms.txt is present and well-formed. Re-check it when your key pages change.',
    warn: 'Add a Markdown llms.txt with one H1 and at least one link, served as text/plain.',
    fail: 'Add a Markdown llms.txt with one H1 and at least one link, served as text/plain.',
  },
  json_ld: {
    pass: 'JSON-LD parses. Keep @context and @type on every block.',
    warn: 'Emit valid JSON-LD with both @context and @type; broken blocks are dropped silently.',
    fail: 'Emit valid JSON-LD with both @context and @type.',
  },
  text_content: {
    pass: 'The raw HTML already contains substantial text. No action needed.',
    warn: 'Server-render the main copy; crawlers that skip JavaScript see only the shell.',
    fail: 'Server-render the main copy; this page is a JavaScript-only shell to non-JS crawlers.',
  },
  sitemap: {
    pass: 'sitemap.xml is valid. Keep it in sync with new pages.',
    warn: 'Publish a valid sitemap.xml and list it in robots.txt.',
    fail: 'Publish a valid sitemap.xml and list it in robots.txt.',
  },
  noindex: {
    pass: 'No noindex directive found. No action needed.',
    warn: 'Remove restrictive robots directives if you want this page indexed and cited.',
    fail: 'Remove the noindex directive; search and AI engines will drop this page.',
  },
  canonical: {
    pass: 'The canonical URL points at this page.',
    warn: 'Point the canonical at this page, on the same host and protocol.',
    fail: 'Point the canonical at this page, on the same host and protocol.',
  },
  meta: {
    pass: 'Title and description lengths are within range.',
    warn: 'Keep the title under 60 characters and the description between 50 and 160.',
    fail: 'Keep the title under 60 characters and the description between 50 and 160.',
  },
  open_graph: {
    pass: 'Open Graph title, description and image are present.',
    warn: 'Add og:title, og:description and og:image so summaries start from your own words.',
    fail: 'Add og:title, og:description and og:image.',
  },
  h1: {
    pass: 'Exactly one H1 was found.',
    warn: 'Use a single non-empty H1 for the main heading.',
    fail: 'Use a single non-empty H1 for the main heading.',
  },
  alt_text: {
    pass: 'Every image has an alt attribute.',
    warn: 'Add alt attributes to informative images (alt="" is fine for decoration).',
    fail: 'Add alt attributes to informative images.',
  },
};

const SKIP_HINT = 'This check did not run for this page.';

function publicReason(item) {
  const raw = (item && item.detail && item.detail.reason) || '';
  return PUBLIC_REASON[raw] || (item && item.status) || 'unknown';
}

function hintFor(key, status, reason) {
  if (status === 'skip') return SKIP_HINT;
  const special = HINTS[key + '__' + reason];
  if (special && special[status]) return special[status];
  const set = HINTS[key];
  if (!set) return '';
  return set[status] || set.warn || '';
}

/**
 * 引擎结果 → 公开 payload。
 * 字段白名单是硬约束：detail 里除下列派生值之外的一切都不出去。
 */
export function toPublicPayload(domain, result) {
  const d = (result && result.detail) || {};
  const unknown = d.unknown === true;
  const rawItems = Array.isArray(d.items) ? d.items : [];

  const items = rawItems.map((it) => {
    const reason = publicReason(it);
    let status = it.status === 'pass' || it.status === 'warn' || it.status === 'fail' || it.status === 'skip'
      ? it.status
      : 'skip';
    // 「训练组禁 + 检索组放行」是正确策略，引擎的 warn 只是「与默认不同」，
    // 到公开层必须降级为 pass，否则页面文案与徽章互相打脸（D44 审阅 P1-1）。
    if (it.key === 'crawler_matrix' && reason === 'training_opt_out' && status === 'warn') status = 'pass';
    return {
      key: String(it.key || ''),
      status,
      weight: typeof it.weight === 'number' ? it.weight : (ITEM_WEIGHTS[it.key] || 0),
      reason,
      hint: hintFor(it.key, status, reason),
    };
  });

  const score = typeof d.score === 'number' && Number.isFinite(d.score) ? d.score : null;

  // 状态只由核心项决定（与引擎一致，也与页面「8 项核心决定状态、4 项增强只进分数」的说明对齐）。
  // 增强项即便全是 warn，也只能通过 score 体现，不得把状态改成 warn。
  const coreWarns = rawItems.some((i) => i.group === 'core' && i.status === 'warn');

  let status;
  if (unknown) status = 'unknown';
  else if (result && result.status === 'down') status = 'down';
  else if (rawItems.length === 0) status = 'unknown'; // 一项都没跑成 ⇒ 未知，不能默认 healthy
  else if (coreWarns) status = 'warn';
  else status = 'ok';

  const crawlers = {};
  for (const crawler of AI_CRAWLERS) {
    const v = d.matrix && d.matrix[crawler.ua];
    crawlers[crawler.ua] = v === 'allow' ? 'allow' : v === 'disallow' ? 'block' : 'unknown';
  }

  const llmsItem = rawItems.find((i) => i.key === 'llms_txt');
  const llmsDetail = (llmsItem && llmsItem.detail) || {};

  return {
    ok: true,
    domain,
    status,
    score,
    grade: gradeOf(score),
    checkedAt: d.checkedAt || new Date().toISOString(),
    cached: false,
    items,
    crawlers,
    llms: {
      found: !!llmsDetail.exists,
      bytes: Number.isFinite(Number(llmsDetail.bytes)) ? Number(llmsDetail.bytes) : 0,
    },
  };
}

/** A ≥ 90 / B ≥ 80 / C ≥ 70 / D < 70；无分（down / unknown）为 '?' */
export function gradeOf(score) {
  if (score == null || !Number.isFinite(score)) return '?';
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  return 'D';
}

function cacheStore() {
  try {
    if (typeof caches !== 'undefined' && caches && caches.default) return caches.default;
  } catch { /* 非 Worker 运行时（本地脚本 / 单测） */ }
  return null;
}

/** 12 秒硬上限 + 每跳 SSRF 守卫 */
async function runCheck(domain) {
  const outer = new AbortController();
  const abortTimer = setTimeout(() => outer.abort(), OUTER_TIMEOUT_MS);

  const fetchImpl = (url, init = {}) => {
    let signal = outer.signal;
    if (init.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([init.signal, outer.signal]);
    }
    return safeFetch(url, { ...init, signal }, { maxRedirects: 5 });
  };

  let gateTimer;
  const gate = new Promise((resolve) => {
    gateTimer = setTimeout(() => resolve({ __outerTimeout: true }), OUTER_TIMEOUT_MS);
  });

  const work = checkAiVisibility(domain, { fetchImpl });
  try {
    const raced = await Promise.race([work, gate]);
    if (raced && raced.__outerTimeout) {
      work.catch(() => {}); // 丢弃迟到结果，防未处理的 rejection
      throw new Error('check_timeout');
    }
    return raced;
  } finally {
    clearTimeout(gateTimer);
    clearTimeout(abortTimer);
  }
}

/**
 * 端点处理器工厂。
 *
 * 依赖可注入（getPool / runCheck / cacheStore）不是为了“灵活”，而是因为本端点有两条
 * 必须被测试证明的硬约束：① 命中缓存不消耗配额；② 第 11 次请求返回 429。
 * 没有注入点就只能连真库跑，回归测试永远不会被执行。
 */
export function createPublicAiHandler(overrides = {}) {
  const loadPool = overrides.getPool || getPool;
  const doCheck = overrides.runCheck || runCheck;
  const getCache = overrides.cacheStore || cacheStore;

  return async function publicAiCheck(c) {
    const domain = strictPublicDomain(c.req.query('domain'));
    if (!domain) return c.json(pubErr('invalid_domain'), 400, NO_STORE);

    // ① 缓存（命中不消耗配额，也不碰 DB）
    const store = getCache();
    const cacheKey = CACHE_ORIGIN + CACHE_PATH + domain;
    if (store) {
      try {
        const hit = await store.match(cacheKey);
        if (hit) {
          const body = await hit.json();
          body.cached = true;
          return c.json(body, 200, NO_STORE);
        }
      } catch (e) {
        console.warn('[public-ai-check] 缓存读取失败（继续走实时检查）:', e && e.message);
      }
    }

    // ② 限流（落库）
    try {
      const pool = await loadPool();
      const salt = (c.env && c.env.AI_CHECK_SALT) || DEFAULT_SALT;
      const ipHash = sha256Hex(clientIp(c) + '|' + salt); // 绝不落原始 IP
      // 先判全局再判单 IP（D44 审阅 P2-2）：容量耗尽是我们自己的问题，
      // 不该让用户背一次「你超频了」的账。
      const global = await bumpCounter(pool, GLOBAL_KEY, DAY_SECONDS);
      if (global.hits > GLOBAL_DAILY_LIMIT) {
        return c.json(pubErr('capacity'), 503, {
          'Cache-Control': 'no-store',
          'Retry-After': String(global.retryAfter),
        });
      }
      const perIp = await bumpCounter(pool, ipHash, WINDOW_SECONDS);
      if (perIp.hits > PER_IP_LIMIT) {
        return c.json(pubErr('rate_limited'), 429, {
          'Cache-Control': 'no-store',
          'Retry-After': String(perIp.retryAfter),
        });
      }
    } catch (e) {
      // 配额表不可用 ⇒ 拒绝服务而不是放行：本端点每请求都会替第三方抓 4 个 URL，
      // 无配额的「失败开放」等于把上游抓取成本敞开给任何人。
      console.error('[public-ai-check] 限流失败（失败关闭）:', e && e.message);
      return c.json(pubErr('capacity'), 503, NO_STORE);
    }

    // ③ 实时检查
    let payload;
    try {
      const result = await doCheck(domain);
      payload = toPublicPayload(domain, result);
    } catch (e) {
      // 只记日志，绝不把异常 message 透给公网
      console.error('[public-ai-check] 检查失败:', domain, e && e.message);
      return c.json(pubErr('check_failed'), 502, NO_STORE);
    }

    // ④ 只缓存确定结果：down / unknown 多为瞬时故障或 WAF 误判，缓存 5 分钟会放大误导
    if (store && (payload.status === 'ok' || payload.status === 'warn')) {
      try {
        const cachedBody = JSON.stringify({ ...payload, cached: false });
        const put = store.put(
          new Request(cacheKey, { method: 'GET' }),
          new Response(cachedBody, {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS,
            },
          })
        );
        let ctx = null;
        try { ctx = c.executionCtx; } catch { ctx = null; }
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
        else await put;
      } catch (e) {
        console.warn('[public-ai-check] 缓存写入失败:', e && e.message);
      }
    }

    return c.json(payload, 200, NO_STORE);
  };
}

export function registerPublicAiRoutes(app) {
  app.get('/api/public/ai-check', createPublicAiHandler());
}

export const AI_CHECK_LIMITS = {
  windowSeconds: WINDOW_SECONDS,
  perIpLimit: PER_IP_LIMIT,
  daySeconds: DAY_SECONDS,
  globalDailyLimit: GLOBAL_DAILY_LIMIT,
  cacheTtlSeconds: CACHE_TTL_SECONDS,
};
