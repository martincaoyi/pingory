// 公开 AI 检查端点 + 免费页的常驻回归测试（D44 审阅 P1-6）
//
// 为什么要有这个文件：D43 的自测脚本是临时的，删掉之后端点、限流、缓存、
// 页面 SEO 骨架就再也没有机检。这些恰好是最容易在后续改动里悄悄坏掉的部分
// （改个字段名就泄漏内部状态、改行文案就让 FAQ 结构化数据与正文不一致）。
//
// 运行：node tools/test-public-ai.mjs
// 退出码 0 = 全过；1 = 有 FAIL（可挂进 CI / dev_gate 的后续扩展）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkAiVisibility, ITEM_WEIGHTS } from '../src/ai-visibility.js';
import {
  strictPublicDomain, toPublicPayload, gradeOf, createPublicAiHandler,
} from '../src/cf-worker/public-ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];

function ok(cond, label, extra) {
  if (cond) { pass++; return; }
  fails.push(label + (extra ? '  →  ' + extra : ''));
}
function eq(a, b, label) {
  ok(Object.is(a, b), label, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

// ============================================================
// 1. 域名严格校验（SSRF 第一道闸）
// ============================================================
const GOOD = ['example.com', 'www.example.co.uk', 'a-b.example.io', 'pingory.com'];
const BAD = [
  '', ' ', 'localhost', 'LOCALHOST', '127.0.0.1', '2130706433', '0x7f000001', '0177.0.0.1',
  '127.1', '[::1]', '::1', 'example.com.', 'foo@internal', '//evil.com', 'https://example.com',
  'example.com/path', 'example.com:8080', 'user:pass@example.com', 'a b.com', '<script>',
  'foo.local', 'foo.internal', 'a'.repeat(64) + '.com', 'example',
];
for (const g of GOOD) ok(strictPublicDomain(g) === g, `接受合法域名 ${g}`);
for (const b of BAD) eq(strictPublicDomain(b), '', `拒绝危险输入 ${JSON.stringify(b)}`);

// ============================================================
// 2. payload 白名单（内部状态绝不外泄）
// ============================================================
const fakeEngineResult = (over = {}) => ({
  status: 'up',
  detail: {
    version: '2',
    checkedAt: '2026-10-24T00:00:00.000Z',
    score: 82,
    fingerprint: 'deadbeef',
    snapshot: { secret: 'internal' },
    items: [
      { key: 'robots_txt', group: 'core', status: 'pass', weight: 8, detail: { reason: 'ok', internalNote: 'x' } },
      { key: 'crawler_matrix', group: 'core', status: 'warn', weight: 22, detail: { reason: 'training_opt_out' } },
      { key: 'llms_txt', group: 'core', status: 'warn', weight: 6, detail: { reason: 'missing', exists: false, bytes: 0 } },
      { key: 'meta', group: 'extra', status: 'warn', weight: 5, detail: { reason: 'issues' } },
    ],
    matrix: { GPTBot: 'disallow', ClaudeBot: 'disallow', CCBot: 'disallow', 'Google-Extended': 'disallow',
      'OAI-SearchBot': 'allow', 'ChatGPT-User': 'allow', 'Claude-User': 'allow', PerplexityBot: 'allow' },
    ...over,
  },
});

const payload = toPublicPayload('example.com', fakeEngineResult());
const serialized = JSON.stringify(payload);
for (const forbidden of ['fingerprint', 'snapshot', 'internalNote', 'deadbeef', 'version']) {
  ok(!serialized.includes(forbidden), `payload 不含内部字段 ${forbidden}`);
}
eq(payload.ok, true, 'payload.ok');
eq(payload.domain, 'example.com', 'payload.domain');
eq(payload.grade, 'B', '82 分 → B');
eq(payload.status, 'warn', '有核心 warn → status=warn');

// 训练组禁 + 检索组放行 ⇒ 必须是 pass（不是 warn），否则与页面文案矛盾
const cm = payload.items.find((i) => i.key === 'crawler_matrix');
eq(cm.status, 'pass', 'training_opt_out 降级为 pass');
eq(cm.reason, 'training_opt_out', '保留 reason 供 UI 标注');
ok(/valid 2026 policy/.test(cm.hint), 'training_opt_out 的 hint 说明这是正确策略');

// 增强项 warn 不得改变整体状态
const extraOnly = toPublicPayload('example.com', {
  status: 'up',
  detail: {
    score: 95, checkedAt: 'x',
    items: [
      { key: 'robots_txt', group: 'core', status: 'pass', weight: 8, detail: { reason: 'ok' } },
      { key: 'meta', group: 'extra', status: 'warn', weight: 5, detail: { reason: 'issues' } },
    ],
    matrix: {},
  },
});
eq(extraOnly.status, 'ok', '只有增强项 warn ⇒ 状态仍 ok');

// WAF 拦截：status=up + unknown ⇒ 公开层必须是 unknown 且 score 为 null，不能是 0/down
const blocked = toPublicPayload('npmjs.com', {
  status: 'up',
  detail: { score: null, unknown: true, reason: 'probe_blocked', items: [], matrix: {}, checkedAt: 'x' },
});
eq(blocked.status, 'unknown', 'probe_blocked ⇒ unknown');
eq(blocked.score, null, 'probe_blocked ⇒ score=null');
eq(blocked.grade, '?', 'probe_blocked ⇒ grade=?');

// 一项都没跑成也不能默认 healthy
const empty = toPublicPayload('example.com', { status: 'up', detail: { score: 100, items: [], matrix: {} } });
eq(empty.status, 'unknown', '无 items ⇒ unknown（不得默认 ok）');

// 未知内部 reason 不得透传原文
const weird = toPublicPayload('example.com', {
  status: 'up',
  detail: { score: 50, items: [{ key: 'x', group: 'core', status: 'fail', weight: 1, detail: { reason: 'INTERNAL_LEAK_XYZ' } }], matrix: {} },
});
ok(!JSON.stringify(weird).includes('INTERNAL_LEAK_XYZ'), '未知 reason 不透传原文');

// 权重与引擎真源一致
for (const it of payload.items) {
  eq(it.weight, ITEM_WEIGHTS[it.key], `权重与 ITEM_WEIGHTS 一致 ${it.key}`);
}

// 等级边界
eq(gradeOf(90), 'A', 'gradeOf 90 → A');
eq(gradeOf(89), 'B', 'gradeOf 89 → B');
eq(gradeOf(80), 'B', 'gradeOf 80 → B');
eq(gradeOf(79), 'C', 'gradeOf 79 → C');
eq(gradeOf(69), 'D', 'gradeOf 69 → D');
eq(gradeOf(null), '?', 'gradeOf null → ?');

// ============================================================
// 3. 端点行为（注入 mock：pool / 检查函数 / 缓存）
// ============================================================
function makeCtx({ domain = 'example.com', ip = '1.2.3.4', env = {}, execCtx = null } = {}) {
  const out = { status: 200, body: null, headers: {} };
  const c = {
    req: { query: (k) => (k === 'domain' ? domain : undefined), header: (h) => (h === 'cf-connecting-ip' ? ip : null) },
    env,
    get executionCtx() { if (!execCtx) throw new Error('no ctx'); return execCtx; },
    json(body, status = 200, headers = {}) {
      out.status = status; out.body = body; out.headers = headers; return out;
    },
  };
  return { c, out };
}

function makePool() {
  const counters = new Map();
  return {
    calls: 0,
    async query(_sql, params) {
      this.calls++;
      const key = params[0];
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      return { rows: [{ hits: next, retry_after: 600 }] };
    },
    reset() { counters.clear(); this.calls = 0; },
  };
}

function makeCache() {
  const store = new Map();
  return {
    async match(k) { const v = store.get(k); return v ? new Response(v, { headers: { 'content-type': 'application/json' } }) : null; },
    async put(req, res) { store.set(typeof req === 'string' ? req : req.url, await res.text()); },
    _store: store,
  };
}

async function testEndpoint() {
  const pool = makePool();
  let checks = 0;
  const handler = createPublicAiHandler({
    getPool: async () => pool,
    runCheck: async () => { checks++; return fakeEngineResult(); },
    cacheStore: () => null, // 第一条：关缓存验证限流本身
  });

  // 400
  {
    const { c, out } = makeCtx({ domain: 'https://evil.com/x' });
    await handler(c);
    eq(out.status, 400, '完整 URL ⇒ 400');
    eq(out.body.error.code, 'invalid_domain', '400 错误码');
  }

  // 第 1..10 次通过，第 11 次 429
  {
    const seen = [];
    for (let i = 1; i <= 11; i++) {
      const { c, out } = makeCtx();
      await handler(c);
      seen.push(out.status);
    }
    eq(seen.slice(0, 10).every((s) => s === 200), true, '前 10 次 200');
    eq(seen[10], 429, '第 11 次 429');
  }

  // 全局日预算耗尽 ⇒ 503 且不消耗单 IP 配额
  {
    const p2 = makePool();
    const h2 = createPublicAiHandler({
      getPool: async () => p2,
      runCheck: async () => fakeEngineResult(),
      cacheStore: () => null,
    });
    let last;
    for (let i = 1; i <= 3001; i++) {
      const { c, out } = makeCtx({ ip: 'ip-' + i }); // 每次换 IP，只撞全局
      await h2(c);
      last = out;
    }
    eq(last.status, 503, '全局 3001 次 ⇒ 503');
    eq(last.body.error.code, 'capacity', '503 错误码 capacity');
  }
}

async function testCache() {
  const pool = makePool();
  const cache = makeCache();
  let checks = 0;
  const handler = createPublicAiHandler({
    getPool: async () => pool,
    runCheck: async () => { checks++; return fakeEngineResult(); },
    cacheStore: () => cache,
  });

  const first = makeCtx();
  await handler(first.c);
  eq(first.out.body.cached, false, '首次 cached=false');
  eq(checks, 1, '首次真的跑了检查');
  const quotaAfterFirst = pool.calls;

  // 等微任务（cache.put 在无 executionCtx 时是 await 的，这里应该已写入）
  const second = makeCtx();
  await handler(second.c);
  eq(second.out.body.cached, true, '二次命中缓存 cached=true');
  eq(checks, 1, '命中缓存不重复检查');
  eq(pool.calls, quotaAfterFirst, '命中缓存不消耗配额（不碰 DB）');

  // down / unknown 不写缓存
  const cache2 = makeCache();
  const h2 = createPublicAiHandler({
    getPool: async () => makePool(),
    runCheck: async () => ({ status: 'up', detail: { score: null, unknown: true, items: [], matrix: {} } }),
    cacheStore: () => cache2,
  });
  await h2(makeCtx().c);
  eq(cache2._store.size, 0, 'unknown 结果不写缓存');
}

// ============================================================
// 4. 页面 SEO 骨架 + 文案真实性
// ============================================================
function testPage() {
  const file = path.join(ROOT, 'public/llms-txt-checker.html');
  ok(fs.existsSync(file), '页面文件存在');
  if (!fs.existsSync(file)) return;
  const html = fs.readFileSync(file, 'utf8');

  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
  ok(title.length >= 30 && title.length <= 65, 'title 长度 30–65', title.length);
  ok(/llms\.txt checker/i.test(title), 'title 含主词 llms.txt checker');

  const desc = (/<meta name="description" content="([^"]*)"/.exec(html) || [])[1] || '';
  ok(desc.length >= 120 && desc.length <= 160, 'description 120–160', desc.length);
  ok(/llms\.txt checker/i.test(desc), 'description 含主词');

  const canon = (/<link rel="canonical" href="([^"]*)"/.exec(html) || [])[1] || '';
  eq(canon, 'https://pingory.com/llms-txt-checker', 'canonical 指向规范 URL');

  ok(/<html lang="en"/.test(html), 'html lang=en');
  ok(/hreflang="x-default"/.test(html), '有 x-default');

  const h1 = [...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/gs)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  eq(h1.length, 1, '恰好一个 H1');

  const h2 = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gs)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  ok(h2.length >= 8, 'H2 至少 8 个（含 FAQ 标题）', h2.length);

  // 不冒充 crawler、不宣称多区域、不写 AI Visibility
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ');
  ok(!/AI Visibility/.test(visible), '正文不出现 AI Visibility（口径应为 AI Readability）');
  ok(!/\bmulti[- ]region\b/i.test(visible), '不宣称多区域探测');
  ok(/single-region/.test(visible), '明示单区域');

  // 无编造统计：正文里不应有「xx% 的站点」这类数字断言
  ok(!/\b\d{2,3}% of (sites|websites|pages)\b/i.test(visible), '不出现编造的站点比例统计');

  // 免费承诺与限流口径
  ok(/10 checks per 10 minutes/.test(visible), '明示 10 次/10 分钟');

  // 付费口径必须与 plans.js 一致（AI 类型仅 Pro）
  ok(/Pro plan/.test(visible), '页面说明 AI 监控属于 Pro');
  ok(!/\$4\/month[^.]*AI monitor/i.test(visible), '不把 $4 套餐与 AI 监控绑定');

  // JSON-LD 与可见 FAQ 逐字一致
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let graph = null;
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      if (j['@graph']) graph = j['@graph'];
      else if (Array.isArray(j)) graph = j;
      else graph = [j];
      if (graph) break;
    } catch { /* 下一个 */ }
  }
  ok(!!graph, 'JSON-LD 可解析');
  if (graph) {
    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    ok(!!faq, '有 FAQPage');
    const qs = (faq && faq.mainEntity) || [];
    eq(qs.length, 10, 'FAQ 恰好 10 条');

    const textOnly = visible.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&mdash;/g, '—')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ');
    for (const q of qs) {
      const qText = String(q.name || '').replace(/\s+/g, ' ');
      const aText = String(q.acceptedAnswer && q.acceptedAnswer.text || '').replace(/\s+/g, ' ');
      ok(textOnly.includes(qText), 'FAQ 问句与正文一致: ' + qText.slice(0, 40));
      ok(textOnly.includes(aText), 'FAQ 答句与正文一致: ' + aText.slice(0, 40));
    }

    const app = graph.find((n) => n['@type'] === 'WebApplication');
    ok(!!app, '有 WebApplication');
    const offer = app && (Array.isArray(app.offers) ? app.offers[0] : app.offers);
    ok(!!offer && Number(offer.price) === 0, 'offers.price = 0');

    ok(!JSON.stringify(graph).includes('aggregateRating'), '不写 aggregateRating（无真实评分）');
  }

  // 脚本可解析（内联 JS 语法错误会让整页交互失效）
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const [i, s] of scripts.entries()) {
    let bad = null;
    try { new Function(s); } catch (e) { bad = e.message; }
    ok(!bad, `内联脚本 #${i} 语法可解析`, bad);
  }

  // 服务端直出：去掉脚本与样式后仍有足够正文
  const plain = visible.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  ok(plain.length > 5000, '正文服务端直出（纯文本 > 5000 字符）', plain.length);
}

// ============================================================
// 5. sitemap / 路由接线
// ============================================================
function testWiring() {
  const sm = fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8');
  ok(sm.includes('<loc>https://pingory.com/llms-txt-checker</loc>'), 'sitemap 含新页面');
  eq((sm.match(/<url>/g) || []).length, 26, 'sitemap 共 26 条');

  const wr = fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8');
  ok(wr.includes('"/llms-txt-checker"'), 'run_worker_first 含 /llms-txt-checker');

  const pages = fs.readFileSync(path.join(ROOT, 'src/cf-worker/pages.js'), 'utf8');
  ok(pages.includes("'/llms-txt-checker.html'"), '.html 301 已注册');

  const idx = fs.readFileSync(path.join(ROOT, 'src/cf-worker/index.js'), 'utf8');
  const atPublic = idx.indexOf('registerPublicAiRoutes(app)');
  const atApi = idx.indexOf('registerApiRoutes(app)');
  ok(atPublic > -1 && atApi > -1 && atPublic < atApi, '公开端点在 /api/* 兜底之前注册');

  // i18n 键 8 语齐全
  for (const lang of ['en', 'zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko']) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/i18n', lang + '.json'), 'utf8'));
    ok(typeof dict['nav.llmsChecker'] === 'string' && dict['nav.llmsChecker'].length > 0, `nav.llmsChecker 存在于 ${lang}`);
  }
}

// ============================================================
// 6. 引擎未被公开层改坏（避免 D43 为加 bytes 引入回归）
// ============================================================
async function testEngine() {
  const r = await checkAiVisibility('not a domain');
  eq(r.status, 'down', '非法域名 ⇒ down');
  eq(r.detail.reason, 'invalid_domain', '非法域名 reason');
  ok(Array.isArray(r.detail.items), '非法域名 items 是数组');

  // bytes 必须是真字节数：UTF-8 中文 3 字节/字，emoji 4 字节
  const html = `<!doctype html><html><head><title>t</title></head><body><h1>t</h1><p>${'文'.repeat(100)}</p></body></html>`;
  const body = '# 标题\n\n> 摘要\n\n- [a](https://example.com/a)\n' + '文'.repeat(100);
  const res = await checkAiVisibility('example.com', {
    fetchImpl: async (url) => {
      const p = new URL(url).pathname;
      if (p === '/robots.txt') return new Response('User-agent: *\nAllow: /', { status: 200, headers: { 'content-type': 'text/plain' } });
      if (p === '/llms.txt') return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
      if (p === '/sitemap.xml') return new Response('<?xml version="1.0"?><urlset><url><loc>https://example.com/</loc></url></urlset>', { status: 200, headers: { 'content-type': 'application/xml' } });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  const item = (res.detail.items || []).find((i) => i.key === 'llms_txt');
  ok(!!item, 'llms_txt 项存在');
  if (item) {
    const expect = Buffer.byteLength(body, 'utf8');
    eq(item.detail.bytes, expect, 'bytes 是 UTF-8 字节数（非 UTF-16 长度）');
    ok(item.detail.bytes > body.length, 'bytes 大于字符数（中文场景）');
  }
}

// ============================================================
const t0 = Date.now();
await testEngine();
await testEndpoint();
await testCache();
testPage();
testWiring();

console.log(`\n=== 结果: ${pass} PASS / ${fails.length} FAIL （${Date.now() - t0}ms）===`);
if (fails.length) {
  for (const f of fails) console.log('FAIL  ' + f);
  process.exitCode = 1;
}
