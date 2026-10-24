/**
 * AI Readability 检查核心（v1，D40 审阅后修订版）
 *
 * 定位：监护 AI 能否「读到」站点，而非预测排名或引用。
 * 判据真源：方案资料/uptime-monitor/AI-VISIBILITY-SPEC-2026-10-24.md §三/§四
 *
 * 🔴 铁律：只做静态可验证项，绝不伪造 AI 爬虫 UA 去"实测"。
 *   Cloudflare 的「已验证机器人」按来源 IP 判定，非 OpenAI 出口的伪造 UA 会被拦，
 *   结果是「真实 GPTBot 畅通，我们却报被拦」——那是误报机器。
 *
 * 设计约束：
 *  1. 纯检查函数：不碰 DB、不写库，最多发 5 个 HTTP 请求
 *     （首页 / robots.txt / llms.txt / sitemap.xml + 必要的 sitemap 兜底）
 *  2. 返回结构与 monitors.js 的 runLocalCheck 契约一致：{ status, error, responseTime, warn, detail }
 *  3. fetch 可注入；D43 公开端点必须传入带 SSRF 守卫的 safeFetch
 *
 * D40 审阅修复清单（2026-10-24 20:40）：
 *  - noindex 指令按 token 解析，修复 max-image-preview:none 被误判为 noindex
 *  - normalizeDomain 用 URL 解析 + 拒绝 IP/localhost/userinfo，堵 @ 绕过
 *  - HTML 剥离改线性扫描，修复 500KB 恶意页面 51 秒的 CPU 爆炸
 *  - 正文读取纳入超时，流式截断 512KB，防挂起与 OOM
 *  - crawler matrix 同时评估深层路径，修复「只有首页可读」被谎报成全放行
 *  - fingerprint 只喂核心项且纳入被禁爬虫名
 *  - warn 只承载预期外降级，修复 10 分钟一条的永久骚扰
 *  - sitemap 陈旧不再判 warn；JSON-LD 部分失败判 warn；相对 canonical 判 pass
 *  - probe_blocked 返回 up + score:null，不再造成永不恢复的宕机告警
 */

// ============================================================
// 常量
// ============================================================

export const AI_CHECK_VERSION = '2';

/**
 * 8 个 AI 爬虫，按用途分两组。
 * 分组本身就是差异化：工具站通常一律判红，会把「训练类全禁 + 检索类全放行」
 * 这一 2026 年主流正确策略误报成故障。
 */
export const AI_CRAWLERS = [
  // 训练类：影响未来模型是否知道你
  { ua: 'GPTBot', owner: 'OpenAI', group: 'training', note: 'OpenAI 训练抓取' },
  { ua: 'ClaudeBot', owner: 'Anthropic', group: 'training', note: 'Anthropic 训练抓取' },
  { ua: 'Google-Extended', owner: 'Google', group: 'training', note: 'Gemini 训练令牌（作用于 Googlebot）' },
  { ua: 'CCBot', owner: 'Common Crawl', group: 'training', note: 'Common Crawl 上游语料' },
  // 检索类：影响现在用户在 AI 里能不能找到你
  { ua: 'OAI-SearchBot', owner: 'OpenAI', group: 'search', note: 'ChatGPT 搜索索引' },
  { ua: 'ChatGPT-User', owner: 'OpenAI', group: 'search', note: '用户触发时的即时抓取' },
  { ua: 'Claude-User', owner: 'Anthropic', group: 'search', note: 'Claude 用户触发的即时访问' },
  { ua: 'PerplexityBot', owner: 'Perplexity', group: 'search', note: 'Perplexity 索引' },
];

/** 12 项权重，合计 100：核心 88（会告警）+ 增强 12（只进分数） */
export const ITEM_WEIGHTS = {
  robots_txt: 8,
  crawler_matrix: 22,
  llms_txt: 6,
  json_ld: 12,
  text_content: 12,
  sitemap: 6,
  noindex: 18,
  canonical: 4,
  meta: 5,
  open_graph: 3,
  h1: 2,
  alt_text: 2,
};

/**
 * 进入 `result.warn` 的白名单（key:reason）。
 * 只有「预期外的降级」才允许进 warn —— 现有 alerts.js 的 warnFresh 是
 * 「距上次 > 10 分钟即再发」，没有指纹比较，信息项一旦进 warn 就是每天 144 条骚扰。
 */
const WARN_ALERT = new Set([
  'crawler_matrix:partial_block',
  'noindex:restricted',
  'canonical:cross_domain',
  'canonical:protocol_mismatch',
  'canonical:different_path',
  'json_ld:invalid',
  'robots_txt:html_response',
]);

const REQUEST_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 10000;
const MAX_BODY_CHARS = 512 * 1024;
const MAX_PARSE_ERRORS = 20;
const DEFAULT_MIN_TEXT_CHARS = 200;
const MATRIX_PATHS = ['/', '/a/b'];

// ============================================================
// robots.txt — RFC 9309 解析器
// ============================================================

/**
 * 解析 robots.txt 为分组结构。
 *
 * RFC 9309 关键点：
 *  - 组 = 连续的 User-agent 行 + 其后的规则行；多个 User-agent 行共享同一组规则
 *  - 同名 UA 出现在多个组时，规则**合并**（不是后者覆盖前者）
 *  - Sitemap 是全局指令，不属于任何组
 *  - Crawl-delay / Host 等非标准扩展忽略
 *  - 空 Disallow 表示无限制（等于放行），不当作规则
 *
 * @returns {{groups: Array<{agents: string[], rules: Array<{allow: boolean, path: string}>}>, sitemaps: string[], errors: string[], errorCount: number}}
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  const errors = [];
  let errorCount = 0;
  let current = null;
  // 上一个有效行是否为 user-agent。false = 连续 UA 行属同一组；true = 出现 UA 时应新建组。
  // 空行不重置（真实 robots.txt 普遍用空行分隔组，空行后紧跟的规则仍归属上一组更宽容）。
  let lastWasAgent = false;

  const pushError = (msg) => {
    errorCount++;
    if (errors.length < MAX_PARSE_ERRORS) errors.push(msg);
  };

  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const hashAt = rawLine.indexOf('#');
    const line = (hashAt === -1 ? rawLine : rawLine.slice(0, hashAt)).trim();
    if (!line) continue;

    const colonAt = line.indexOf(':');
    if (colonAt === -1) {
      pushError(`line ${i + 1}: missing colon`);
      continue;
    }

    const key = line.slice(0, colonAt).trim().toLowerCase();
    const value = line.slice(colonAt + 1).trim();

    if (key === 'user-agent') {
      if (!value) {
        pushError(`line ${i + 1}: empty user-agent`);
        continue;
      }
      // 连续 UA 行共享同组；已出现过规则/指令后再写 UA 才是新组
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    if (key === 'allow' || key === 'disallow') {
      if (!current) {
        // 规则出现在任何 user-agent 之前 ⇒ 无效
        pushError(`line ${i + 1}: ${key} before any user-agent`);
        continue;
      }
      // 空值：Disallow: 等于不限；Allow: 等于无规则 ⇒ 都不记录
      if (value) current.rules.push({ allow: key === 'allow', path: value });
      lastWasAgent = false;
      continue;
    }

    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      lastWasAgent = false;
      continue;
    }

    // crawl-delay / request-rate / host / clean-param 等：忽略
    lastWasAgent = false;
  }

  return { groups, sitemaps, errors, errorCount };
}

/**
 * 把 robots 路径模式编译为正则。
 * RFC 9309 §2.2.2：只有 `*`（任意序列）与 `$`（结尾锚）是元字符，其余按字面。
 */
function compileRobotsPattern(pattern) {
  let body = pattern;
  let anchoredEnd = false;
  if (body.endsWith('$')) {
    anchoredEnd = true;
    body = body.slice(0, -1);
  }
  let re = '';
  for (const ch of body) {
    if (ch === '*') re += '.*';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + (anchoredEnd ? '$' : ''));
}

/** UA 是否为该组的匹配目标（RFC 9309 §2.2.1 产品 token 前缀匹配） */
function agentMatches(agent, ua) {
  if (agent === ua) return true;
  if (agent === '*') return false;
  // User-agent: GPTBot/1.0 也应匹配 GPTBot
  return agent.startsWith(ua + '/');
}

/**
 * 判定某 UA 能否访问某路径。
 *
 * 优先级：精确 UA 组 > `*` 组；最长匹配 > 短匹配；等长时 Allow > Disallow；
 *        无任何匹配规则 ⇒ 允许。
 */
export function matchRobotsRule(parsed, ua, path = '/') {
  const uaLower = String(ua || '').toLowerCase();
  const groups = (parsed && parsed.groups) || [];

  let source = groups.filter((g) => g.agents.some((a) => agentMatches(a, uaLower)));
  let matchedBy = uaLower;

  if (source.length === 0) {
    source = groups.filter((g) => g.agents.includes('*'));
    matchedBy = '*';
  }

  if (source.length === 0) {
    return { allowed: true, matchedRule: null, matchedBy: 'none' };
  }

  const rules = source.flatMap((g) => g.rules);
  let best = null;

  for (const rule of rules) {
    let hit = false;
    try {
      hit = compileRobotsPattern(rule.path).test(path);
    } catch {
      hit = false;
    }
    if (!hit) continue;

    if (!best || rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }

  if (!best) return { allowed: true, matchedRule: null, matchedBy };
  return { allowed: best.allow, matchedRule: best, matchedBy };
}

/**
 * 生成 8 位爬虫放行矩阵。
 *
 * D40 审阅修复：只测 `/` 会把「Disallow: / + Allow: /$」（只有首页可读）
 * 谎报成「8 个爬虫全放行」。改为同时评估深层路径，任一被禁即算被禁。
 *
 * @param {ReturnType<typeof parseRobots>} parsed
 * @param {string[]} paths 要评估的路径，默认首页 + 深层路径
 */
export function buildCrawlerMatrix(parsed, paths = MATRIX_PATHS) {
  const matrix = {};
  const perPath = {};

  for (const crawler of AI_CRAWLERS) {
    const results = paths.map((p) => ({ path: p, allowed: matchRobotsRule(parsed, crawler.ua, p).allowed }));
    perPath[crawler.ua] = results;
    matrix[crawler.ua] = results.every((r) => r.allowed) ? 'allow' : 'disallow';
  }

  return { matrix, perPath };
}

// ============================================================
// HTML 提取工具（线性扫描，避免正则回溯爆炸）
// ============================================================

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    });
}

/**
 * 移除 `<tag ...>...</tag>` 区块（线性扫描）。
 * 用 indexOf 而非 `[\s\S]*?` 惰性正则：后者在 `'<script>'.repeat(60000)` 这类
 * 输入上会退化到 O(n²)，实测 14.5 秒；`'<svg>'.repeat(100000)` 达 51 秒。
 */
function stripTagBlocks(html, tagName) {
  const lower = html.toLowerCase();
  const open = '<' + tagName;
  const close = '</' + tagName;
  let out = '';
  let i = 0;

  while (i < html.length) {
    const start = lower.indexOf(open, i);
    if (start === -1) {
      out += html.slice(i);
      break;
    }
    // 必须是标签边界（避免匹配 <scripting> 之类）
    const after = lower[start + open.length];
    if (after !== undefined && after !== '>' && after !== '/' && !/\s/.test(after)) {
      out += html.slice(i, start + open.length);
      i = start + open.length;
      continue;
    }
    out += html.slice(i, start);
    const closeStart = lower.indexOf(close, start + open.length);
    if (closeStart === -1) break; // 未闭合：丢弃剩余
    const closeEnd = html.indexOf('>', closeStart);
    if (closeEnd === -1) break;
    i = closeEnd + 1;
  }

  return out;
}

/** 移除 HTML 注释（线性） */
function stripComments(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const start = html.indexOf('<!--', i);
    if (start === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, start);
    const end = html.indexOf('-->', start + 4);
    if (end === -1) break;
    i = end + 3;
  }
  return out;
}

/** 去掉所有标签（线性） */
function stripTags(html) {
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf('>', lt);
    if (gt === -1) {
      out += html.slice(lt);
      break;
    }
    out += ' ';
    i = gt + 1;
  }
  return out;
}

/**
 * 取不执行 JS 时的可见文本。
 *
 * 注意：**不剥离 `<noscript>`** —— 非 JS 抓取者确实能看到其中的内容，
 * 剥离它会把「用 noscript 兜底的好站」误判成空壳（D40 审阅）。
 */
export function extractVisibleText(html) {
  let s = String(html || '');
  s = stripTagBlocks(s, 'script');
  s = stripTagBlocks(s, 'style');
  s = stripTagBlocks(s, 'svg');
  s = stripComments(s);
  s = stripTags(s);
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

/** 提取指定标签的原始开标签字符串数组（线性 + 数量上限） */
function extractTags(html, tagName) {
  const out = [];
  const lower = html.toLowerCase();
  const open = '<' + tagName;
  let i = 0;

  while (out.length < 500 && i < lower.length) {
    const start = lower.indexOf(open, i);
    if (start === -1) break;
    const after = lower[start + open.length];
    if (after !== undefined && after !== '>' && after !== '/' && !/\s/.test(after)) {
      i = start + open.length;
      continue;
    }
    const end = html.indexOf('>', start);
    if (end === -1) break;
    out.push(html.slice(start, end + 1));
    i = end + 1;
  }
  return out;
}

/** 解析标签属性（属性名小写） */
function parseAttrs(tagStr) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+))/g;
  let m;
  while ((m = re.exec(tagStr))) {
    attrs[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
  }
  return attrs;
}

function getTitle(html) {
  const lower = html.toLowerCase();
  const start = lower.indexOf('<title');
  if (start === -1) return '';
  const gt = html.indexOf('>', start);
  if (gt === -1) return '';
  const end = lower.indexOf('</title', gt);
  if (end === -1) return '';
  return decodeEntities(html.slice(gt + 1, end)).replace(/\s+/g, ' ').trim();
}

function getMetaContent(html, name) {
  const target = name.toLowerCase();
  for (const tag of extractTags(html, 'meta')) {
    const a = parseAttrs(tag);
    const key = (a.name || a.property || '').toLowerCase();
    if (key === target) return a.content || '';
  }
  return null;
}

function getCanonical(html) {
  for (const tag of extractTags(html, 'link')) {
    const a = parseAttrs(tag);
    const rel = (a.rel || '').toLowerCase();
    if (rel.split(/\s+/).includes('canonical')) return a.href || '';
  }
  return null;
}

function getJsonLdBlocks(html) {
  const out = [];
  const lower = html.toLowerCase();
  let i = 0;

  while (out.length < 20) {
    const start = lower.indexOf('<script', i);
    if (start === -1) break;
    // 标签边界检查：避免把 <scripting type="application/ld+json"> 当成 JSON-LD
    const after = lower[start + 7];
    if (after !== undefined && after !== '>' && after !== '/' && !/\s/.test(after)) {
      i = start + 7;
      continue;
    }
    const gt = html.indexOf('>', start);
    if (gt === -1) break;
    const openTag = html.slice(start, gt + 1);
    const close = lower.indexOf('</script', gt);
    if (close === -1) break;
    if (/application\/ld\+json/i.test(openTag)) out.push(html.slice(gt + 1, close));
    i = close + 8;
  }
  return out;
}

/** 线性统计 Markdown 链接数（`[^\]]+` 类正则在 `'[' × 200000` 上会 33 秒） */
function countMarkdownLinks(text) {
  let count = 0;
  let i = 0;
  const s = String(text || '');

  while (count < 1000 && i < s.length) {
    const open = s.indexOf('[', i);
    if (open === -1) break;
    const close = s.indexOf(']', open + 1);
    if (close === -1) break;
    if (s[close + 1] === '(') {
      const end = s.indexOf(')', close + 2);
      if (end !== -1 && end > close + 2) {
        count++;
        i = end + 1;
        continue;
      }
    }
    i = close + 1;
  }
  return count;
}

/**
 * 判断是否为「空 root 容器」（SPA 空壳信号）。
 * 用 indexOf 线性实现：`/<div[^>]+id=["'](root|app)["'][^>]*>\s*<\/div>/`
 * 在 400KB 的 `'<div'` 输入上实测 34.6 秒，会拖死单线程。
 */
function hasEmptyRootContainer(lowerHtml) {
  for (const id of ['root', 'app']) {
    for (const q of ['"', "'"]) {
      const needle = `id=${q}${id}${q}`;
      const at = lowerHtml.indexOf(needle);
      if (at === -1) continue;
      const gt = lowerHtml.indexOf('>', at);
      if (gt === -1) continue;
      const nextLt = lowerHtml.indexOf('<', gt + 1);
      if (nextLt === -1) continue;
      const between = lowerHtml.slice(gt + 1, nextLt);
      if (/^\s*$/.test(between) && lowerHtml.startsWith('</', nextLt)) return true;
    }
  }
  return false;
}

function getH1Texts(html) {
  const out = [];
  const lower = html.toLowerCase();
  let i = 0;

  while (out.length < 20) {
    const start = lower.indexOf('<h1', i);
    if (start === -1) break;
    const after = lower[start + 3];
    if (after !== undefined && after !== '>' && after !== '/' && !/\s/.test(after)) {
      i = start + 3;
      continue;
    }
    const gt = html.indexOf('>', start);
    if (gt === -1) break;
    const end = lower.indexOf('</h1', gt);
    if (end === -1) break;
    out.push(decodeEntities(stripTags(html.slice(gt + 1, end))).replace(/\s+/g, ' ').trim());
    i = end + 4;
  }
  return out;
}

// ============================================================
// 哈希与指纹
// ============================================================

/** 稳定非密码学哈希（FNV-1a 64 位，逐字符取两字节避免碰撞），仅用于去重与快照比对 */
function stableHash(input) {
  const str = String(input ?? '');
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i) & 0xffff);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 生成告警指纹：状态 + 核心失败项 + 核心 warn 项 + 被禁爬虫名。
 *
 * 两条硬约束（D40 审阅）：
 *  1. **只喂核心项** —— 增强项不得进入，否则「改了个 H1」也会触发空告警
 *  2. **必须含被禁爬虫名** —— 否则从「GPTBot 被禁」变成「PerplexityBot 被禁」
 *     时 key 集相同、指纹不变 ⇒ 不告警，正好打掉「昨天还能进、今天被拦了」的卖点
 */
export function buildFingerprint(status, items, matrix) {
  const core = items.filter((i) => i.group === 'core');
  // 用 key:reason 而非裸 key：否则「没有 JSON-LD」→「JSON-LD 语法错」指纹不变，
  // 而 warn 从 null 变非 null，D41 按指纹门控会漏报
  const keyOf = (i) => `${i.key}:${(i.detail && i.detail.reason) || ''}`;
  const fails = core.filter((i) => i.status === 'fail').map(keyOf).sort();
  const warns = core.filter((i) => i.status === 'warn').map(keyOf).sort();
  const blocked = matrix
    ? Object.entries(matrix).filter(([, v]) => v === 'disallow').map(([k]) => k).sort()
    : [];
  return stableHash(`${status}|${fails.join(',')}|${warns.join(',')}|${blocked.join(',')}`);
}

// ============================================================
// 网络抓取
// ============================================================

/**
 * 读取响应体并截断。
 * 用流式读取而非 `resp.text()`：后者会把整个响应先读进内存再 slice，
 * 一个 200MB 响应会先被完整缓冲。
 *
 * @returns {Promise<{text: string, aborted: boolean, truncated: boolean}>}
 *   aborted=true 表示读取被中断（超时/连接断），调用方**不得**把已读片段当作完整文档
 */
async function readBodyLimited(resp, limit) {
  if (!resp || !resp.body || typeof resp.body.getReader !== 'function') {
    try {
      const text = String((await resp.text()) || '');
      return {
        text: text.length > limit ? text.slice(0, limit) : text,
        aborted: false,
        truncated: text.length > limit,
      };
    } catch {
      return { text: '', aborted: true, truncated: false };
    }
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let bytes = 0;
  let aborted = false;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (bytes >= limit) {
        truncated = true;
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
    out += decoder.decode();
  } catch {
    // 读取被中断（含 AbortController 超时）：这是「内容不完整」，不是空内容
    aborted = true;
    try { await reader.cancel(); } catch { /* ignore */ }
  }

  if (out.length > limit) {
    out = out.slice(0, limit);
    truncated = true;
  }

  return { text: out, aborted, truncated };
}

async function fetchText(fetchImpl, url, timeoutMs) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        // 中性 UA：不冒充任何 AI 爬虫（铁律）
        'User-Agent': 'Pingory-AIReadability/1.0 (+https://pingory.com)',
        Accept: 'text/html,text/plain,application/xml,*/*',
      },
      signal: controller.signal,
    });

    // 头部与正文都在同一个超时窗口内（原实现头到达后就 clearTimeout，
    // 正文可无限挂起，实测 9.5 秒仍不返回）
    const read = await readBodyLimited(resp, MAX_BODY_CHARS);
    const getHeader = (n) => (resp.headers && resp.headers.get ? resp.headers.get(n) || '' : '');

    return {
      // aborted ⇒ 内容不完整，按抓取失败处理（首页走 unreachable，robots 走 fetch_failed）
      ok: !read.aborted,
      status: resp.status,
      contentType: getHeader('content-type'),
      xRobotsTag: getHeader('x-robots-tag'),
      server: getHeader('server'),
      body: read.text,
      aborted: read.aborted,
      truncated: read.truncated,
      elapsed: Date.now() - started,
      finalUrl: typeof resp.url === 'string' ? resp.url : url,
      error: read.aborted ? 'timeout' : null,
    };
  } catch (err) {
    const msg = String((err && err.message) || err || 'fetch failed');
    return {
      ok: false,
      status: 0,
      contentType: '',
      xRobotsTag: '',
      server: '',
      body: '',
      aborted: true,
      truncated: false,
      elapsed: Date.now() - started,
      error: /abort|timeout/i.test(msg) ? 'timeout' : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 识别「探测被 WAF / bot 防护拦截」。
 * 大站（如 npmjs.com）对非浏览器 UA 返 403 + Cloudflare 挑战页。这不是故障。
 */
function detectProbeBlock(res) {
  const status = res.status;
  const body = String(res.body || '');
  const server = String(res.server || '');

  const challenge = /just a moment|cf-browser-verification|__cf_chl|checking your browser|attention required|enable javascript and cookies/i.test(body);
  const wafStatus = status === 401 || status === 403 || status === 406 || status === 429;

  if (!challenge && !wafStatus) return null;

  let vendor = null;
  if (/cloudflare/i.test(server) || /__cf_chl|cf-ray/i.test(body)) vendor = 'cloudflare';
  else if (/akamai/i.test(server)) vendor = 'akamai';
  else if (/sucuri/i.test(server)) vendor = 'sucuri';
  else if (/cloudfront/i.test(server)) vendor = 'cloudfront';

  return { status, challenge, vendor, server: server || null };
}

// ============================================================
// 12 项检查
// ============================================================

function item(key, label, group, status, message, detail = {}) {
  return { key, label, group, weight: ITEM_WEIGHTS[key], status, message, detail };
}

/** 判据：robots.txt 存在且是文本。返回 HTML ⇒ warn（与「没有 robots.txt」同义） */
function checkRobotsTxt(res) {
  if (!res || !res.ok) {
    return item('robots_txt', 'robots.txt', 'core', 'warn',
      'robots.txt could not be fetched. AI crawlers fall back to allow-all.',
      { reason: 'fetch_failed', error: res && res.error });
  }
  if (res.status === 404) {
    return item('robots_txt', 'robots.txt', 'core', 'warn',
      'No robots.txt (equivalent to allow-all). You lose the ability to control AI crawlers.',
      { reason: 'missing', httpStatus: 404 });
  }
  if (res.status !== 200) {
    return item('robots_txt', 'robots.txt', 'core', 'warn',
      `robots.txt returned HTTP ${res.status}.`,
      { reason: 'http_error', httpStatus: res.status });
  }

  const looksHtml = /text\/html/i.test(res.contentType) || /^\s*<(!doctype|html)/i.test(res.body);
  if (looksHtml) {
    return item('robots_txt', 'robots.txt', 'core', 'warn',
      'robots.txt returns an HTML page (usually a SPA fallback). AI crawlers treat this as no robots.txt — you lose control over them.',
      { reason: 'html_response', contentType: res.contentType });
  }

  const parsed = parseRobots(res.body);
  const ruleCount = parsed.groups.reduce((n, g) => n + g.rules.length, 0);

  if (parsed.errorCount > 0) {
    return item('robots_txt', 'robots.txt', 'core', 'warn',
      `robots.txt has ${parsed.errorCount} malformed line(s); parsing may be unreliable.`,
      {
        reason: 'parse_warnings',
        errors: parsed.errors,
        errorCount: parsed.errorCount,
        groups: parsed.groups.length,
        rules: ruleCount,
      });
  }

  return item('robots_txt', 'robots.txt', 'core', 'pass',
    `robots.txt parsed (${parsed.groups.length} group(s), ${ruleCount} rule(s)).`,
    {
      reason: 'ok',
      groups: parsed.groups.length,
      rules: ruleCount,
      sitemaps: parsed.sitemaps,
      hash: stableHash(res.body),
    });
}

/** 判据：8 位爬虫矩阵 + 训练/检索分组语义 */
function checkCrawlerMatrix(robotsRes) {
  const robotsOk = robotsRes && robotsRes.ok && robotsRes.status === 200 &&
    !(/text\/html/i.test(robotsRes.contentType) || /^\s*<(!doctype|html)/i.test(robotsRes.body));

  const trainingList = AI_CRAWLERS.filter((c) => c.group === 'training');
  const searchList = AI_CRAWLERS.filter((c) => c.group === 'search');

  if (!robotsOk) {
    const matrix = {};
    // 404 / 200-HTML ⇒ 等于没有 robots.txt，默认全放行（RFC 9309）
    const missing = robotsRes && robotsRes.status === 404;
    const htmlFallback = robotsRes && robotsRes.ok && robotsRes.status === 200;

    if (missing || htmlFallback) {
      for (const c of AI_CRAWLERS) matrix[c.ua] = 'allow';
      return {
        item: item('crawler_matrix', 'AI crawler access', 'core', 'pass',
          'No robots.txt restrictions found: all 8 AI crawlers are allowed.',
          { reason: 'no_restrictions', matrix, paths: MATRIX_PATHS, perPath: null, trainingBlocked: [], searchBlocked: [] }),
        matrix,
      };
    }

    // 抓取失败 / 5xx / 超时：无法判定。不能按 RFC 的「5xx 假定全禁」也不该谎报放行
    for (const c of AI_CRAWLERS) matrix[c.ua] = 'unknown';
    return {
      item: item('crawler_matrix', 'AI crawler access', 'core', 'skip',
        'robots.txt is unavailable, so crawler access cannot be determined.',
        {
          reason: 'unavailable',
          matrix,
          paths: MATRIX_PATHS,
          perPath: null,
          trainingBlocked: [],
          searchBlocked: [],
          error: (robotsRes && robotsRes.error) || null,
        }),
      matrix,
    };
  }

  const parsed = parseRobots(robotsRes.body);
  const { matrix, perPath } = buildCrawlerMatrix(parsed, MATRIX_PATHS);

  const trainingBlocked = trainingList.filter((c) => matrix[c.ua] === 'disallow').map((c) => c.ua);
  const searchBlocked = searchList.filter((c) => matrix[c.ua] === 'disallow').map((c) => c.ua);
  const allTrainingBlocked = trainingBlocked.length === trainingList.length;
  const allSearchBlocked = searchBlocked.length === searchList.length;

  const baseDetail = {
    matrix,
    perPath,
    paths: MATRIX_PATHS,
    trainingBlocked,
    searchBlocked,
  };

  if (allSearchBlocked) {
    return {
      item: item('crawler_matrix', 'AI crawler access', 'core', 'fail',
        'All retrieval-class AI crawlers are blocked. You are invisible when users ask ChatGPT / Claude / Perplexity about your topic.',
        { ...baseDetail, reason: 'all_search_blocked' }),
      matrix,
    };
  }

  // 训练类全禁 + 检索类放行 = 合法策略（只进 detail，不进 warn）
  if (allTrainingBlocked && searchBlocked.length === 0) {
    return {
      item: item('crawler_matrix', 'AI crawler access', 'core', 'warn',
        'Training crawlers are all blocked while retrieval crawlers are allowed. This is a valid opt-out policy — no action needed.',
        { ...baseDetail, reason: 'training_opt_out' }),
      matrix,
    };
  }

  if (trainingBlocked.length || searchBlocked.length) {
    const parts = [];
    if (trainingBlocked.length) parts.push(`training: ${trainingBlocked.join(', ')}`);
    if (searchBlocked.length) parts.push(`retrieval: ${searchBlocked.join(', ')}`);
    return {
      item: item('crawler_matrix', 'AI crawler access', 'core', 'warn',
        `Some AI crawlers are blocked (${parts.join(' | ')}).`,
        { ...baseDetail, reason: 'partial_block' }),
      matrix,
    };
  }

  return {
    item: item('crawler_matrix', 'AI crawler access', 'core', 'pass',
      'All 8 AI crawlers can reach both the homepage and deeper pages.',
      { ...baseDetail, reason: 'all_allowed' }),
    matrix,
  };
}

/** 判据：llms.txt 存在 + 最低格式（H1 + 至少 1 个链接）；404 只 warn（仍是提案） */
function checkLlmsTxt(res) {
  if (!res || !res.ok) {
    return item('llms_txt', 'llms.txt', 'core', 'warn',
      'llms.txt could not be fetched.',
      { reason: 'fetch_failed', error: res && res.error, exists: false });
  }
  if (res.status === 404) {
    return item('llms_txt', 'llms.txt', 'core', 'warn',
      'No llms.txt. It is still a proposal, not a requirement — but AI engines use it as a curated summary.',
      { reason: 'missing', httpStatus: 404, exists: false });
  }
  if (res.status !== 200) {
    return item('llms_txt', 'llms.txt', 'core', 'warn',
      `llms.txt returned HTTP ${res.status}.`,
      { reason: 'http_error', httpStatus: res.status, exists: false });
  }

  const body = String(res.body || '');
  if (!body.trim()) {
    return item('llms_txt', 'llms.txt', 'core', 'warn',
      'llms.txt is empty.',
      { reason: 'empty', exists: true });
  }

  const hasH1 = /^#\s+\S/m.test(body);
  const linkCount = countMarkdownLinks(body);
  const hasSummary = /^>\s+\S/m.test(body);
  const contentTypeOk = /text\/(plain|markdown)/i.test(res.contentType) || !res.contentType;

  if (!hasH1 || linkCount === 0) {
    const missing = [];
    if (!hasH1) missing.push('H1 heading');
    if (linkCount === 0) missing.push('Markdown link');
    return item('llms_txt', 'llms.txt', 'core', 'warn',
      `llms.txt exists but is missing ${missing.join(' and ')}.`,
      { reason: 'invalid_format', exists: true, hasH1, linkCount, hasSummary, contentTypeOk });
  }

  return item('llms_txt', 'llms.txt', 'core', 'pass',
    `llms.txt is valid (${linkCount} link(s)${hasSummary ? ', with summary' : ''}).`,
    { reason: 'ok', exists: true, hasH1, linkCount, hasSummary, contentTypeOk });
}

/** 判据：首页 JSON-LD 可解析且含 @context + @type */
function checkJsonLd(ctx) {
  const html = ctx.raw && ctx.raw.ok ? ctx.raw.body : '';
  const blocks = getJsonLdBlocks(html);

  if (blocks.length === 0) {
    return item('json_ld', 'Structured data (JSON-LD)', 'core', 'warn',
      'No JSON-LD found. AI engines lose the cheapest, most reliable signal about what this page is.',
      { reason: 'missing', blocks: 0, types: [] });
  }

  let valid = 0;
  let invalid = 0;
  const types = new Set();
  let hasGraph = false;

  for (const raw of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      invalid++;
      continue;
    }

    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const hasCtx = !!node['@context'];

      // @graph：必须至少有一个子节点带 @type 才算有效
      if (Array.isArray(node['@graph'])) {
        hasGraph = true;
        let typedChildren = 0;
        for (const g of node['@graph']) {
          if (!g || !g['@type']) continue;
          typedChildren++;
          [].concat(g['@type']).forEach((t) => typeof t === 'string' && types.add(t));
        }
        if (hasCtx && typedChildren > 0) valid++;
        continue;
      }

      const nodeTypes = [].concat(node['@type'] || []).filter((t) => typeof t === 'string');
      nodeTypes.forEach((t) => types.add(t));
      if (hasCtx && nodeTypes.length > 0) valid++;
    }
  }

  const typeList = [...types];
  const baseDetail = { blocks: blocks.length, valid, invalid, types: typeList, hasGraph };

  // SPEC §3.4：至少一个块解析失败 ⇒ warn（语法错等于没有）
  if (invalid > 0) {
    return item('json_ld', 'Structured data (JSON-LD)', 'core', 'warn',
      `${invalid} of ${blocks.length} JSON-LD block(s) failed to parse. Broken JSON-LD is worse than none: engines silently drop it.`,
      { ...baseDetail, reason: 'invalid' });
  }

  if (valid === 0) {
    return item('json_ld', 'Structured data (JSON-LD)', 'core', 'warn',
      `Found ${blocks.length} JSON-LD block(s) but none has both @context and @type.`,
      { ...baseDetail, reason: 'incomplete' });
  }

  return item('json_ld', 'Structured data (JSON-LD)', 'core', 'pass',
    `Valid JSON-LD found (${typeList.slice(0, 4).join(', ') || 'no @type'}${typeList.length > 4 ? '…' : ''}).`,
    { ...baseDetail, reason: 'ok' });
}

/**
 * 判据：不执行 JS 时的可见文本量。
 * 修复（D40 审阅）：`< 200` 只有在同时存在 JS 空壳信号时才 fail，
 * 否则极简单页（落地页 / 登录页 / link-in-bio）会被误判成 down。
 */
function checkTextContent(ctx, opts) {
  const minChars = Number(opts.minTextChars) || DEFAULT_MIN_TEXT_CHARS;
  const html = ctx.raw && ctx.raw.ok ? ctx.raw.body : '';
  const text = extractVisibleText(html);
  const charCount = text.length;

  const lowerHtml = html.toLowerCase();
  const hasNextData = lowerHtml.includes('__next_data__');
  const hasNuxt = lowerHtml.includes('window.__nuxt__');
  const hasEmptyRoot = hasEmptyRootContainer(lowerHtml);
  const hasNoscript = lowerHtml.includes('<noscript');
  const shellSignal = hasNextData || hasNuxt || hasEmptyRoot;

  const detail = {
    chars: charCount,
    threshold: minChars,
    shellSignal,
    signals: { hasNextData, hasNuxt, hasEmptyRoot, hasNoscript },
    sample: text.slice(0, 160),
  };

  if (charCount < minChars) {
    if (shellSignal) {
      return item('text_content', 'Readable text without JS', 'core', 'fail',
        `Only ${charCount} characters of text in the raw HTML, and the page is a JS-rendered shell. AI crawlers that do not execute JavaScript see nothing.`,
        { ...detail, reason: 'js_shell' });
    }
    return item('text_content', 'Readable text without JS', 'core', 'warn',
      `Only ${charCount} characters of text in the raw HTML. Fine for a minimal landing page, thin if you expect AI to summarize it.`,
      { ...detail, reason: 'thin_minimal' });
  }

  if (charCount < minChars * 4) {
    return item('text_content', 'Readable text without JS', 'core', 'warn',
      `Only ${charCount} characters of text in the raw HTML. Enough to be indexed, thin for summarization.`,
      { ...detail, reason: 'thin' });
  }

  return item('text_content', 'Readable text without JS', 'core', 'pass',
    `${charCount} characters of text in the raw HTML.`,
    { ...detail, reason: 'ok' });
}

/** 判据：sitemap 存在且可解析。lastmod 陈旧只记录，不判错（SPEC §3.6） */
function checkSitemap(res) {
  if (!res || !res.ok) {
    return item('sitemap', 'sitemap.xml', 'core', 'warn',
      'sitemap.xml could not be fetched.',
      { reason: 'fetch_failed', error: res && res.error });
  }
  if (res.status === 404) {
    return item('sitemap', 'sitemap.xml', 'core', 'warn',
      'No sitemap.xml. AI engines rely on crawling; a sitemap makes discovery deterministic.',
      { reason: 'missing', httpStatus: 404 });
  }
  if (res.status !== 200) {
    return item('sitemap', 'sitemap.xml', 'core', 'warn',
      `sitemap.xml returned HTTP ${res.status}.`,
      { reason: 'http_error', httpStatus: res.status });
  }

  const body = String(res.body || '');
  const isIndex = /<sitemapindex[\s>]/i.test(body);
  const isUrlset = /<urlset[\s>]/i.test(body);

  if (!isIndex && !isUrlset) {
    return item('sitemap', 'sitemap.xml', 'core', 'warn',
      'sitemap.xml is not a valid urlset or sitemapindex.',
      { reason: 'invalid', urlCount: 0 });
  }

  const urlCount = (body.match(/<url[\s>]/gi) || []).length;
  const sitemapCount = (body.match(/<sitemap[\s>]/gi) || []).length;

  if (isIndex && sitemapCount === 0) {
    return item('sitemap', 'sitemap.xml', 'core', 'warn',
      'sitemap.xml is a sitemapindex with no child sitemaps.',
      { reason: 'empty', isIndex: true, sitemapCount: 0 });
  }
  if (!isIndex && urlCount === 0) {
    return item('sitemap', 'sitemap.xml', 'core', 'warn',
      'sitemap.xml contains no URLs.',
      { reason: 'empty', urlCount: 0 });
  }

  let latestLastmod = null;
  const lastmods = body.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi) || [];
  for (const raw of lastmods) {
    const val = raw.replace(/<\/?lastmod>/gi, '').trim();
    const t = Date.parse(val);
    if (Number.isFinite(t) && (!latestLastmod || t > latestLastmod)) latestLastmod = t;
  }
  const daysSinceUpdate = latestLastmod ? Math.floor((Date.now() - latestLastmod) / 86400000) : null;
  const stale = daysSinceUpdate !== null && daysSinceUpdate > 180;
  const count = isIndex ? sitemapCount : urlCount;

  // 陈旧只记录，状态仍 pass（文档站一年不更新 sitemap 很常见）
  return item('sitemap', 'sitemap.xml', 'core', 'pass',
    isIndex
      ? `Sitemap index with ${count} child sitemap(s)${res.declaredIn ? ` (declared in ${res.declaredIn})` : ''}.`
      : `${count} URL(s) in sitemap${res.declaredIn ? ` (declared in ${res.declaredIn})` : ''}${stale ? `, last updated ${daysSinceUpdate} days ago` : ''}.`,
    {
      reason: 'ok',
      isIndex,
      urlCount,
      sitemapCount,
      latestLastmod,
      daysSinceUpdate,
      stale,
      declaredIn: res.declaredIn || null,
    });
}

/** 8 个 AI 爬虫 UA（小写），用于 X-Robots-Tag 的作用域匹配 */
const AI_UA_LOWER = new Set(AI_CRAWLERS.map((c) => c.ua.toLowerCase()));

/**
 * 已知指令名。用于区分 `X-Robots-Tag: googlebot: noindex`（作用域）
 * 与 `X-Robots-Tag: max-snippet: 0`（指令）—— 两者冒号前都有个词。
 */
const KNOWN_DIRECTIVES = new Set([
  'index', 'noindex', 'follow', 'nofollow', 'all', 'none',
  'noarchive', 'nosnippet', 'noimageindex', 'nocache', 'notranslate',
  'noodp', 'noydir', 'noai', 'noimageai', 'nositelinkssearchbox',
  'indexifembedded', 'nopagereadaloud', 'noyaca',
  'max-snippet', 'max-image-preview', 'max-video-preview',
  'unavailable_after', 'unavailable-after', 'visit-after',
]);

/**
 * 解析 robots 指令串。
 *
 * 关键：**先按逗号分条，再对每条取 name/value**。
 * 若先按逗号+空格拆 token，`max-image-preview: none` 会被拆出独立的 `none`，
 * 被误判成 noindex（实测会把好站判 down 并走 critical 通道）。
 *
 * 但反过来也有坑（第三轮复审发现）：`max-image-preview:none noindex` 这种
 * 「紧凑冒号 + 空格分隔」的写法，若整条 value 都吞给第一个指令，noindex 会被
 * 静默丢掉 —— 属于假阴性（告诉用户「没问题」实则被 noindex）。因此 value
 * 内部的多余 token 必须重新拆成独立指令。
 *
 * @param {string} raw
 * @param {{scopeAware?: boolean}} opts scopeAware 用于 X-Robots-Tag（支持 `googlebot: noindex`）
 * @returns {Array<{name: string, value: string|null, scope: string|null}>}
 */
function parseDirectives(raw, { scopeAware = false } = {}) {
  const out = [];
  for (const chunk of String(raw || '').toLowerCase().split(',')) {
    let part = chunk.trim();
    if (!part) continue;

    let scope = null;
    if (scopeAware) {
      const m = /^([a-z0-9_.*-]+)\s*:\s*(.+)$/.exec(part);
      // 冒号前若不是已知指令名 ⇒ 它是爬虫作用域；不是我们的爬虫就整条忽略
      if (m && !KNOWN_DIRECTIVES.has(m[1])) {
        if (m[1] !== '*' && !AI_UA_LOWER.has(m[1])) continue;
        scope = m[1];
        part = m[2].trim();
      }
    }

    const idx = part.indexOf(':');
    if (idx === -1) {
      // 无冒号：空格分隔的多条指令
      for (const t of part.split(/\s+/)) if (t) out.push({ name: t, value: null, scope });
      continue;
    }

    const name = part.slice(0, idx).trim();
    const tokens = part.slice(idx + 1).trim().split(/\s+/).filter(Boolean);

    if (tokens.length === 0) {
      out.push({ name, value: null, scope });
      continue;
    }

    out.push({ name, value: tokens[0], scope });
    // value 之后还剩 token ⇒ 是空格分隔的独立指令
    // （`max-image-preview:none noindex`、`unavailable_after: 25 Jun 2010` 后者
    //   多出的 token 不匹配任何检查项，仅为安全起见保留）
    for (const t of tokens.slice(1)) out.push({ name: t, value: null, scope });
  }
  return out;
}

/**
 * 判据：meta robots + X-Robots-Tag 双查。
 * 按指令名解析，`max-image-preview:none` / `max-image-preview: none` 均不得判成 noindex；
 * `X-Robots-Tag: googlebot: noindex` 这种作用域限定不影响 AI 检查。
 */
function checkNoindex(ctx) {
  const html = ctx.clean;
  const headerTag = (ctx.raw && ctx.raw.xRobotsTag) || '';
  const metaTag = getMetaContent(html, 'robots') || getMetaContent(html, 'googlebot') || '';

  const sources = [];
  if (metaTag) sources.push('meta');
  if (headerTag) sources.push('header');

  const directives = [
    ...parseDirectives(metaTag, { scopeAware: false }),
    ...parseDirectives(headerTag, { scopeAware: true }),
  ];

  if (directives.length === 0) {
    return item('noindex', 'Indexing allowed', 'core', 'pass',
      'No robots restrictions found.',
      { reason: 'ok', metaTag: metaTag || null, headerTag: headerTag || null, directives: [] });
  }

  // `none` 只有作为独立指令（无 value）才等价于 noindex
  const hasNoindex = directives.some((d) => d.name === 'noindex' ||
    (d.name === 'none' && d.value === null));
  if (hasNoindex) {
    return item('noindex', 'Indexing allowed', 'core', 'fail',
      `The page tells crawlers "noindex" (${sources.join(' + ')}). Search and AI engines will drop it.`,
      {
        reason: 'noindex',
        metaTag: metaTag || null,
        headerTag: headerTag || null,
        directives: directives.map((d) => d.name),
      });
  }

  const restrictions = [];
  for (const name of ['nofollow', 'noarchive', 'noai', 'noimageai', 'nosnippet']) {
    if (directives.some((d) => d.name === name)) restrictions.push(name);
  }
  if (directives.some((d) => d.name === 'max-snippet' && String(d.value).trim() === '0')) {
    restrictions.push('max-snippet:0');
  }

  if (restrictions.length) {
    return item('noindex', 'Indexing allowed', 'core', 'warn',
      `Indexing is restricted: ${restrictions.join(', ')} (${sources.join(' + ')}).`,
      {
        reason: 'restricted',
        restrictions,
        metaTag: metaTag || null,
        headerTag: headerTag || null,
      });
  }

  return item('noindex', 'Indexing allowed', 'core', 'pass',
    `robots directives present but not blocking: ${[metaTag, headerTag].filter(Boolean).join(', ')}`,
    {
      reason: 'ok',
      metaTag: metaTag || null,
      headerTag: headerTag || null,
      directives: directives.map((d) => d.name),
    });
}

/** 判据：canonical 指向自身 / 跨域 / 缺失；相对路径按 RFC 6596 判 pass */
function checkCanonical(ctx, domain) {
  const html = ctx.clean;
  const href = getCanonical(html);

  if (href === null || href === '') {
    return item('canonical', 'Canonical URL', 'core', 'warn',
      'No canonical tag. AI engines may attribute the content to a duplicate URL.',
      { reason: 'missing', href: null });
  }

  let resolved;
  try {
    resolved = new URL(href, `https://${domain}/`);
  } catch {
    return item('canonical', 'Canonical URL', 'core', 'warn',
      `Canonical tag has an unparseable href: ${href}`,
      { reason: 'invalid', href });
  }

  const isRelative = !/^https?:\/\//i.test(href);
  const sameHost = resolved.hostname.replace(/^www\./, '') === domain.replace(/^www\./, '');
  const pathNorm = (p) => (p || '/').replace(/\/+$/, '') || '/';
  const samePath = pathNorm(resolved.pathname) === '/';

  if (!sameHost) {
    return item('canonical', 'Canonical URL', 'core', 'warn',
      `Canonical points to another domain (${resolved.hostname}). Your content may be credited to that page.`,
      { reason: 'cross_domain', href, resolved: resolved.href, isRelative });
  }
  if (!samePath) {
    return item('canonical', 'Canonical URL', 'core', 'warn',
      `Homepage canonical points to a different path (${resolved.pathname}).`,
      { reason: 'different_path', href, resolved: resolved.href, isRelative });
  }
  if (resolved.protocol !== 'https:' && !isRelative) {
    return item('canonical', 'Canonical URL', 'core', 'warn',
      `Canonical uses ${resolved.protocol} while the site is served over https.`,
      { reason: 'protocol_mismatch', href, resolved: resolved.href, isRelative });
  }

  return item('canonical', 'Canonical URL', 'core', 'pass',
    isRelative ? 'Canonical is relative and resolves to this page.' : 'Canonical points to this page.',
    { reason: 'ok', href, resolved: resolved.href, isRelative });
}

/** 增强项：meta title & description */
function checkMeta(ctx) {
  const html = ctx.clean;
  const title = getTitle(html);
  const desc = getMetaContent(html, 'description');

  const issues = [];
  if (!title) issues.push('title missing');
  else if (title.length > 60) issues.push(`title too long (${title.length} chars)`);

  if (desc === null || desc === '') issues.push('description missing');
  else if (desc.length < 50) issues.push(`description too short (${desc.length} chars)`);
  else if (desc.length > 160) issues.push(`description too long (${desc.length} chars)`);

  if (title && desc && title === desc) issues.push('title and description are identical');

  if (issues.length) {
    return item('meta', 'Meta title & description', 'extras', 'warn',
      `Improve for clearer AI summaries: ${issues.join('; ')}.`,
      { reason: 'issues', issues, titleLength: title.length, descriptionLength: desc ? desc.length : 0 });
  }

  return item('meta', 'Meta title & description', 'extras', 'pass',
    `Title ${title.length} chars, description ${desc.length} chars.`,
    { reason: 'ok', titleLength: title.length, descriptionLength: desc.length });
}

/** 增强项：Open Graph */
function checkOpenGraph(ctx) {
  const html = ctx.clean;
  const ogTitle = getMetaContent(html, 'og:title');
  const ogDesc = getMetaContent(html, 'og:description');
  const ogImage = getMetaContent(html, 'og:image');

  const missing = [];
  if (!ogTitle) missing.push('og:title');
  if (!ogDesc) missing.push('og:description');
  if (!ogImage) missing.push('og:image');

  if (missing.length === 3) {
    return item('open_graph', 'Open Graph tags', 'extras', 'warn',
      'No Open Graph tags. AI summarizers fall back to the first paragraph instead of a curated summary.',
      { reason: 'missing_all', missing });
  }
  if (missing.length) {
    return item('open_graph', 'Open Graph tags', 'extras', 'warn',
      `Missing Open Graph: ${missing.join(', ')}.`,
      { reason: 'partial', missing });
  }
  return item('open_graph', 'Open Graph tags', 'extras', 'pass',
    'og:title, og:description and og:image are all present.',
    { reason: 'ok', ogImage });
}

/** 增强项：H1 结构 */
function checkH1(ctx) {
  const html = ctx.clean;
  const h1s = getH1Texts(html);

  if (h1s.length === 0) {
    return item('h1', 'H1 heading', 'extras', 'warn',
      'No H1 found. Extractors may pick the wrong block as the main content.',
      { reason: 'missing', count: 0 });
  }
  if (h1s.length > 1) {
    return item('h1', 'H1 heading', 'extras', 'warn',
      `Found ${h1s.length} H1 headings. A single H1 makes the main content unambiguous.`,
      { reason: 'multiple', count: h1s.length, sample: h1s.slice(0, 3) });
  }
  if (!h1s[0]) {
    return item('h1', 'H1 heading', 'extras', 'warn',
      'H1 exists but is empty.',
      { reason: 'empty', count: 1 });
  }
  return item('h1', 'H1 heading', 'extras', 'pass',
    'Exactly one H1.',
    { reason: 'ok', count: 1, sample: h1s[0].slice(0, 120) });
}

/** 增强项：图片 alt 覆盖（无图 ⇒ skip，不计入分母） */
function checkAltText(ctx) {
  const html = ctx.clean;
  const imgs = extractTags(html, 'img');

  if (imgs.length === 0) {
    return item('alt_text', 'Image alt text', 'extras', 'skip',
      'No images on this page, check skipped.',
      { reason: 'no_images', total: 0, missing: 0 });
  }

  let missing = 0;
  for (const tag of imgs) {
    const a = parseAttrs(tag);
    // alt="" 视为显式装饰图，算合格
    if (a.alt === undefined) missing++;
  }

  if (missing === 0) {
    return item('alt_text', 'Image alt text', 'extras', 'pass',
      `All ${imgs.length} images have alt text.`,
      { reason: 'ok', total: imgs.length, missing: 0 });
  }

  return item('alt_text', 'Image alt text', 'extras', 'warn',
    `${missing} of ${imgs.length} images have no alt attribute.`,
    { reason: 'missing_alt', total: imgs.length, missing, ratio: missing / imgs.length });
}

// ============================================================
// 分数
// ============================================================

/**
 * 加权通过率。跳过项从分母扣除后归一 —— 否则「没图的好站」会被白白扣分。
 * pass=1, warn=0.5, fail=0, skip=不参与。
 */
export function computeScore(items) {
  let earned = 0;
  let total = 0;
  for (const it of items) {
    if (it.status === 'skip') continue;
    total += it.weight;
    if (it.status === 'pass') earned += it.weight;
    else if (it.status === 'warn') earned += it.weight * 0.5;
  }
  if (total === 0) return 0;
  return Math.round((earned / total) * 100);
}

// ============================================================
// 变更归因（时间壁垒：人话解释「什么变了」）
// ============================================================

/**
 * 与上一次快照对比，生成人话差异。
 * 这是护城河的核心：抄的人上线第一天历史是空的，这段时间买不到。
 */
export function diffSnapshots(prev, current) {
  const out = [];
  if (!prev || !current) return out;

  if (prev.snapshot && current.snapshot) {
    const p = prev.snapshot;
    const c = current.snapshot;

    if (p.robotsHash && c.robotsHash && p.robotsHash !== c.robotsHash) {
      out.push('robots.txt content changed');
    }
    if (typeof p.llmsExists === 'boolean' && typeof c.llmsExists === 'boolean' && p.llmsExists !== c.llmsExists) {
      out.push(c.llmsExists ? 'llms.txt appeared' : 'llms.txt disappeared');
    }
    if (typeof p.noindex === 'boolean' && typeof c.noindex === 'boolean' && p.noindex !== c.noindex) {
      out.push(c.noindex ? 'noindex was added' : 'noindex was removed');
    }
  }

  // 爬虫矩阵逐项变化（最有价值：谁从 allow 变 disallow）
  // `unknown` = robots.txt 本次没抓到，是「没测到」而不是「状态变了」
  // （第三轮复审：不做这个过滤，一次网络抖动会给用户刷出 8 条假变更）
  if (prev.matrix && current.matrix) {
    for (const [ua, val] of Object.entries(current.matrix)) {
      const before = prev.matrix[ua];
      if (!before || before === val) continue;
      if (before === 'unknown' || val === 'unknown') continue;
      out.push(`${ua}: ${before} → ${val}`);
    }
  }

  if (prev.status && current.status && prev.status !== current.status) {
    out.push(`status: ${prev.status} → ${current.status}`);
  }

  return out;
}

// ============================================================
// 主函数
// ============================================================

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * 规范化并校验域名为 hostname。
 *
 * 安全要点（D40 审阅）：拒绝 userinfo（`evil.com@127.0.0.1`）、IP 字面量（v4/v6）、
 * `localhost` / `.local` / `.internal`、超长 host。D43 接公开端点时仍须叠加
 * ssrf-guard（DNS rebinding 只能靠解析后 IP 校验解决）。
 *
 * @returns {string} 合法 hostname，非法返回 ''
 */
export function normalizeDomain(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (s.length > 2048) return '';

  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;

  let u;
  try {
    u = new URL(s);
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  // userinfo 会让人误读主机：`evil.com@127.0.0.1` 实际请求 127.0.0.1
  if (u.username || u.password) return '';

  const host = u.hostname.toLowerCase();
  if (!host || host.length > 253) return '';
  if (host.startsWith('[') || host.includes(':')) return ''; // IPv6 字面量
  if (IPV4_RE.test(host)) return '';
  if (host === 'localhost' || host.endsWith('.localhost')) return '';
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return '';
  if (!HOST_RE.test(host)) return '';
  if (host.split('.').some((label) => label.length > 63)) return '';

  return host;
}

/** 首页 3xx（连续重定向）⇒ 视为探测失败，避免把空 body 当"无文本" */
function isRedirectOnly(res) {
  return res && res.ok && res.status >= 300 && res.status < 400;
}

/**
 * 检查一个域名的 AI 可读性。
 *
 * @param {string} domain 域名（如 example.com）
 * @param {object} opts
 * @param {Function} [opts.fetchImpl] 可注入的 fetch（生产必须传 SSRF 守卫版）
 * @param {object} [opts.prev] 上一次的 detail（用于生成 changes）
 * @param {number} [opts.minTextChars] 文本阈值覆盖
 * @returns {Promise<{status:'up'|'down', error:null|string, responseTime:number, warn:null|string, detail:object}>}
 */
export async function checkAiVisibility(domain, opts = {}) {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const host = normalizeDomain(domain);

  if (!host) {
    return {
      status: 'down',
      error: 'INVALID_DOMAIN',
      responseTime: 0,
      warn: null,
      detail: {
        version: AI_CHECK_VERSION,
        checkedAt: new Date().toISOString(),
        reason: 'invalid_domain',
        items: [],
        score: null,
        matrix: {},
        snapshot: null,
        fingerprint: stableHash('invalid'),
      },
    };
  }

  const work = runChecks(host, fetchImpl, opts, started);

  // 总预算：4 个并行请求 + sitemap 兜底最坏 16s，钳到 10s
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __budgetExceeded: true }), TOTAL_BUDGET_MS);
  });

  try {
    const result = await Promise.race([work, budget]);
    if (result && result.__budgetExceeded) {
      return {
        status: 'down',
        error: 'TIMEOUT',
        responseTime: Date.now() - started,
        warn: null,
        detail: {
          version: AI_CHECK_VERSION,
          checkedAt: new Date().toISOString(),
          reason: 'timeout',
          host,
          items: [],
          score: null,
          matrix: {},
          snapshot: null,
          fingerprint: stableHash('timeout'),
        },
      };
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function runChecks(host, fetchImpl, opts, started) {
  const base = `https://${host}`;

  const [homeSettled, robotsSettled, llmsSettled, sitemapSettled] = await Promise.allSettled([
    fetchText(fetchImpl, `${base}/`, REQUEST_TIMEOUT_MS),
    fetchText(fetchImpl, `${base}/robots.txt`, REQUEST_TIMEOUT_MS),
    fetchText(fetchImpl, `${base}/llms.txt`, REQUEST_TIMEOUT_MS),
    fetchText(fetchImpl, `${base}/sitemap.xml`, REQUEST_TIMEOUT_MS),
  ]);

  const unwrap = (s) => (s.status === 'fulfilled'
    ? s.value
    : { ok: false, status: 0, body: '', contentType: '', xRobotsTag: '', server: '', error: 'fetch_settled_reject' });

  const home = unwrap(homeSettled);
  const robots = unwrap(robotsSettled);
  const llms = unwrap(llmsSettled);
  const sitemap = unwrap(sitemapSettled);

  // 前置：站点可达性
  if (!home.ok || home.status === 0) {
    return {
      status: 'down',
      error: `SITE_UNREACHABLE:${home.error || 'fetch_failed'}`,
      responseTime: Date.now() - started,
      warn: null,
      detail: {
        version: AI_CHECK_VERSION,
        checkedAt: new Date().toISOString(),
        reason: 'unreachable',
        host,
        items: [],
        score: null,
        matrix: {},
        snapshot: null,
        fingerprint: stableHash('unreachable'),
      },
    };
  }

  if (isRedirectOnly(home)) {
    return {
      status: 'down',
      error: `SITE_REDIRECT_LOOP:${home.status}`,
      responseTime: Date.now() - started,
      warn: null,
      detail: {
        version: AI_CHECK_VERSION,
        checkedAt: new Date().toISOString(),
        reason: 'redirect_unresolved',
        host,
        httpStatus: home.status,
        items: [],
        score: null,
        matrix: {},
        snapshot: null,
        fingerprint: stableHash('redirect'),
      },
    };
  }

  // 200 但正文为空：内容读不到，不能当正常站（服务器回 200 但 body 永不返回的典型）
  if (home.status === 200 && !home.body.trim() && !home.truncated) {
    return {
      status: 'down',
      error: 'SITE_EMPTY_BODY',
      responseTime: Date.now() - started,
      warn: null,
      detail: {
        version: AI_CHECK_VERSION,
        checkedAt: new Date().toISOString(),
        reason: 'empty_body',
        host,
        httpStatus: 200,
        items: [],
        score: null,
        matrix: {},
        snapshot: null,
        fingerprint: stableHash('empty_body'),
      },
    };
  }

  if (home.status >= 400) {
    const block = detectProbeBlock(home);

    // 被 WAF 拦：站点是活的，只是拒绝了我们的探测 ⇒ 返回 up + score:null，
    // 不进告警。判 down 会造成 npmjs.com 这类站永不 RECOVERED（D40 审阅）。
    if (block) {
      return {
        status: 'up',
        error: null,
        responseTime: Date.now() - started,
        warn: null,
        detail: {
          version: AI_CHECK_VERSION,
          checkedAt: new Date().toISOString(),
          reason: 'probe_blocked',
          unknown: true,
          host,
          httpStatus: block.status,
          blockedBy: block.vendor,
          server: block.server,
          challengePage: block.challenge,
          items: [],
          score: null,
          matrix: {},
          snapshot: null,
          fingerprint: stableHash(`probe_blocked|${block.vendor || ''}|${block.status}`),
          hint: 'Your firewall blocked our crawler. Strict bot protection often blocks AI crawlers too — check that GPTBot / OAI-SearchBot / ClaudeBot / PerplexityBot are allowed at the WAF level.',
          note: 'Technical prerequisites only. Not a ranking or citation prediction.',
        },
      };
    }

    return {
      status: 'down',
      error: `SITE_HTTP_${home.status}`,
      responseTime: Date.now() - started,
      warn: null,
      detail: {
        version: AI_CHECK_VERSION,
        checkedAt: new Date().toISOString(),
        reason: 'http_error',
        host,
        httpStatus: home.status,
        items: [],
        score: null,
        matrix: {},
        snapshot: null,
        fingerprint: stableHash(`http_${home.status}`),
      },
    };
  }

  // 12 项检查
  const robotsItem = checkRobotsTxt(robots);
  const { item: matrixItem, matrix } = checkCrawlerMatrix(robots);

  // sitemap 兜底：/sitemap.xml 不可用时，用 robots.txt 声明的同域 https 地址重试一次。
  // 很多站点（如 github.com）只在 robots 里声明真实地址，硬拼路径会误判「没有 sitemap」。
  let sitemapRes = sitemap;
  const robotsParsable = robots.ok && robots.status === 200 &&
    !(/text\/html/i.test(robots.contentType) || /^\s*<(!doctype|html)/i.test(robots.body));
  const sitemapUnusable = !sitemap.ok || sitemap.status !== 200 ||
    !(/<urlset[\s>]|<sitemapindex[\s>]/i.test(String(sitemap.body || '')));

  if (sitemapUnusable && robotsParsable) {
    const declared = pickDeclaredSitemap(parseRobots(robots.body).sitemaps, host);
    if (declared) {
      sitemapRes = await fetchText(fetchImpl, declared.href, REQUEST_TIMEOUT_MS);
      if (sitemapRes.ok && sitemapRes.status === 200) sitemapRes.declaredIn = 'robots.txt';
    }
  }

  // 页面上下文：raw 保留 script（JSON-LD 在 script 里），clean 剥掉 script/style
  // 后再解析 meta / link / h1 / img —— 避免把 <script> 字符串里的伪标签采信
  // （实测 '<script>var s="<meta name=robots content=noindex>"</script>' 会把好站判 down）
  const pageCtx = {
    raw: home,
    clean: stripTagBlocks(stripTagBlocks(home.body, 'script'), 'style'),
  };

  const items = [
    robotsItem,
    matrixItem,
    checkLlmsTxt(llms),
    checkJsonLd(pageCtx),
    checkTextContent(pageCtx, opts),
    checkSitemap(sitemapRes),
    checkNoindex(pageCtx),
    checkCanonical(pageCtx, host),
    checkMeta(pageCtx),
    checkOpenGraph(pageCtx),
    checkH1(pageCtx),
    checkAltText(pageCtx),
  ];

  // 状态：核心项任一 fail ⇒ down（fail 的定义就是「该维度上 AI 不可用」）
  // 增强项无论怎么差都只影响分数，绝不改变状态
  const coreItems = items.filter((i) => i.group === 'core');
  const coreFails = coreItems.filter((i) => i.status === 'fail');
  const coreWarns = coreItems.filter((i) => i.status === 'warn');

  const status = coreFails.length > 0 ? 'down' : 'up';

  let score = computeScore(items);
  if (coreFails.length > 0 && score > 25) score = 25;

  // warn 只承载预期外降级（白名单），避免 10 分钟一条的永久骚扰
  const alertWarns = coreWarns.filter((i) => WARN_ALERT.has(`${i.key}:${i.detail && i.detail.reason}`));
  const warnMessage = status === 'up' && alertWarns.length
    ? alertWarns.map((i) => i.label).join(', ')
    : null;

  const errorMessage = status === 'down'
    ? `${coreFails[0].label}: ${coreFails[0].message}`
    : null;

  const robotsDetail = robotsItem.detail || {};
  const llmsDetail = (items.find((i) => i.key === 'llms_txt') || {}).detail || {};
  const noindexDetail = (items.find((i) => i.key === 'noindex') || {}).detail || {};

  const snapshot = {
    robotsHash: robotsDetail.hash || null,
    robotsGroups: robotsDetail.groups || 0,
    robotsRules: robotsDetail.rules || 0,
    llmsExists: !!llmsDetail.exists,
    noindex: noindexDetail.reason === 'noindex',
    homeStatus: home.status,
    checkedAt: new Date().toISOString(),
  };

  const fingerprint = buildFingerprint(status, items, matrix);
  const changes = diffSnapshots(opts.prev, { status, matrix, snapshot });

  return {
    status,
    error: errorMessage,
    responseTime: Date.now() - started,
    warn: warnMessage,
    detail: {
      version: AI_CHECK_VERSION,
      host,
      score,
      status,
      fingerprint,
      checkedAt: snapshot.checkedAt,
      items,
      matrix,
      snapshot,
      changes,
      coreFailCount: coreFails.length,
      coreWarnCount: coreWarns.length,
      note: 'Technical prerequisites only. Not a ranking or citation prediction.',
    },
  };
}

/** 从 robots 声明的 Sitemap 中挑一个安全的同域 https 地址（防 SSRF / 明文 / 任意端口） */
function pickDeclaredSitemap(sitemaps, host) {
  for (const raw of sitemaps || []) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue;
    if (u.username || u.password) continue;
    if (u.port && u.port !== '443') continue;
    const h = u.hostname.toLowerCase().replace(/^www\./, '');
    if (h !== host.replace(/^www\./, '')) continue;
    return { href: u.href };
  }
  return null;
}

export default {
  checkAiVisibility,
  parseRobots,
  matchRobotsRule,
  buildCrawlerMatrix,
  computeScore,
  buildFingerprint,
  diffSnapshots,
  normalizeDomain,
  extractVisibleText,
  AI_CRAWLERS,
  ITEM_WEIGHTS,
};
