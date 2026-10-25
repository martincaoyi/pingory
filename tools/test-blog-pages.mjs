#!/usr/bin/env node
/**
 * B1 + B2 content cluster regression test (D45 / D47).
 *
 * Why this file exists: the five new pages carry a lot of claims that are easy to
 * break silently — a title that drifts past 60 characters, a FAQ answer that no
 * longer matches its JSON-LD twin, an internal link that disappears, a route that
 * stops redirecting. None of that shows up in dev_gate, and all of it is
 * embarrassing in exactly the way this cluster cannot afford.
 *
 * Two modes:
 *   node tools/test-blog-pages.mjs                        static assertions on local files
 *   node tools/test-blog-pages.mjs --url https://pingory.com   assertions against a live deploy
 *
 * Exit code 0 = every assertion passed, 1 = at least one FAIL.
 * Pure Node, no dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const urlArgIndex = process.argv.indexOf('--url');
const BASE = urlArgIndex > -1 && process.argv[urlArgIndex + 1]
  ? process.argv[urlArgIndex + 1].replace(/\/+$/, '')
  : '';
const LIVE = Boolean(BASE);

let pass = 0;
const fails = [];

function ok(condition, label, extra) {
  if (condition) {
    pass++;
    console.log('PASS  ' + label);
    return true;
  }
  fails.push(label + (extra ? '  →  ' + extra : ''));
  console.log('FAIL  ' + label + (extra ? '  →  ' + extra : ''));
  return false;
}

function eq(actual, expected, label) {
  ok(Object.is(actual, expected), label, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
}

// ============================================================
// Page expectations (single source for both modes)
// ============================================================
const PAGES = [
  {
    url: '/blog',
    file: 'public/blog.html',
    keyword: 'AI Readability',
    h1: 'Pingory Guides: AI Readability and Crawler Policy',
    ogType: 'website',
    types: ['WebPage', 'BreadcrumbList', 'ItemList'],
    article: false,
    faq: false,
    minH2: 3,
    words: [300, 500],
    date: '2026-10-25',
  },
  {
    url: '/blog/what-is-llms-txt',
    file: 'public/blog/what-is-llms-txt.html',
    keyword: 'llms.txt',
    h1: 'llms.txt: What It Is, How to Write One, and Whether AI Actually Reads It',
    ogType: 'article',
    types: ['Article', 'BreadcrumbList', 'FAQPage'],
    article: true,
    faq: true,
    minH2: 6,
    words: [1400, 1800],
  },
  {
    url: '/blog/ai-crawlers-list',
    file: 'public/blog/ai-crawlers-list.html',
    keyword: 'AI Crawlers',
    h1: 'AI Crawlers in 2026: The Full List (GPTBot, ClaudeBot, CCBot, PerplexityBot)',
    ogType: 'article',
    types: ['Article', 'BreadcrumbList'],
    article: true,
    faq: false,
    minH2: 6,
    words: [1600, 2000],
  },
  {
    url: '/blog/block-ai-crawlers',
    file: 'public/blog/block-ai-crawlers.html',
    keyword: 'Block AI Crawlers',
    h1: 'How to Block (or Allow) AI Crawlers Without Breaking Google',
    ogType: 'article',
    types: ['Article', 'BreadcrumbList', 'FAQPage'],
    article: true,
    faq: true,
    minH2: 6,
    words: [1400, 1800],
  },
  // ---- B2 (D47): fault-intent guides -------------------------------------
  {
    url: '/blog/robots-txt-guide',
    file: 'public/blog/robots-txt-guide.html',
    keyword: 'robots.txt',
    h1: 'robots.txt: The Rules Crawlers Actually Parse',
    ogType: 'article',
    types: ['Article', 'BreadcrumbList', 'FAQPage'],
    article: true,
    faq: true,
    minH2: 7,
    words: [1600, 2000],
    date: '2026-10-25',
  },
  {
    url: '/blog/schema-validation-errors',
    file: 'public/blog/schema-validation-errors.html',
    keyword: 'schema validation errors',
    h1: 'Schema Validation Errors: What Each Validator Message Means',
    ogType: 'article',
    types: ['Article', 'BreadcrumbList', 'FAQPage'],
    article: true,
    faq: true,
    minH2: 6,
    words: [1500, 1900],
    date: '2026-10-25',
  },
  {
    url: '/blog/xml-sitemap-guide',
    file: 'public/blog/xml-sitemap-guide.html',
    keyword: 'XML sitemap',
    h1: "XML Sitemap: What Belongs In It, and Why Yours Isn't Indexed",
    ogType: 'article',
    types: ['Article', 'BreadcrumbList', 'FAQPage'],
    article: true,
    faq: true,
    minH2: 8,
    words: [1500, 1900],
    date: '2026-10-25',
  },
  {
    url: '/blog/canonical-tag-guide',
    file: 'public/blog/canonical-tag-guide.html',
    keyword: 'canonical tag',
    h1: 'Canonical Tag: A Hint Google Can Overrule',
    ogType: 'article',
    types: ['Article', 'BreadcrumbList', 'FAQPage'],
    article: true,
    faq: true,
    minH2: 7,
    words: [1300, 1700],
    date: '2026-10-25',
  },
  {
    url: '/blog/json-ld-structured-data',
    file: 'public/blog/json-ld-structured-data.html',
    keyword: 'JSON-LD vs Microdata',
    h1: 'JSON-LD vs Microdata vs RDFa: Which Format Google Reads',
    ogType: 'article',
    types: ['Article', 'BreadcrumbList', 'FAQPage'],
    article: true,
    faq: true,
    minH2: 7,
    words: [1400, 1800],
    date: '2026-10-25',
  },
  {
    url: '/ai-readability',
    file: 'public/ai-readability.html',
    keyword: 'AI Readability',
    h1: 'AI Readability vs AI Visibility: What You Can Actually Measure',
    ogType: 'website',
    types: ['WebPage', 'BreadcrumbList'],
    article: false,
    faq: false,
    minH2: 6,
    words: [1000, 1400],
  },
];

// ============================================================
// Tiny HTML helpers
// ============================================================
function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function textOf(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
}

function words(value) {
  return textOf(value).split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length;
}

function mainHtml(html) {
  const start = html.indexOf('<main');
  const end = html.lastIndexOf('</main>');
  if (start === -1 || end === -1) return '';
  return html.slice(start, end);
}

// Remove a <div class="…"> block, counting nested divs so the CTA's inner
// cta-actions wrapper does not end the block early.
function removeDiv(html, className) {
  const marker = '<div class="' + className + '">';
  const start = html.indexOf(marker);
  if (start === -1) return html;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = re.exec(html))) {
    if (match[0] === '</div>') {
      depth--;
      if (depth === 0) return html.slice(0, start) + html.slice(re.lastIndex);
    } else {
      depth++;
    }
  }
  return html;
}

function attr(html, pattern) {
  const match = html.match(pattern);
  return match ? match[1].trim() : '';
}

function parseJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) blocks.push(match[1]);
  return blocks;
}

function graphOf(blocks) {
  const nodes = [];
  for (const raw of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { error: error.message, nodes: [] };
    }
    if (Array.isArray(parsed['@graph'])) nodes.push(...parsed['@graph']);
    else nodes.push(parsed);
  }
  return { error: '', nodes };
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

// ============================================================
// Load documents (filesystem or network)
// ============================================================
async function loadPage(page) {
  if (LIVE) {
    const res = await fetch(BASE + page.url, { redirect: 'manual' });
    const body = await res.text();
    return { status: res.status, type: res.headers.get('content-type') || '', body };
  }
  const full = path.join(ROOT, page.file);
  if (!fs.existsSync(full)) return { status: 0, type: '', body: '' };
  return { status: 200, type: 'text/html', body: fs.readFileSync(full, 'utf8') };
}

async function loadText(url, file) {
  if (LIVE) {
    const res = await fetch(BASE + url);
    return { status: res.status, body: await res.text() };
  }
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return { status: 0, body: '' };
  return { status: 200, body: fs.readFileSync(full, 'utf8') };
}

// ============================================================
// Per-page assertions
// ============================================================
async function checkPage(page) {
  console.log('\n── ' + page.url + ' ──');
  const doc = await loadPage(page);
  const html = doc.body;

  eq(doc.status, 200, page.url + ' 返回 200');
  ok(html.length > 2000, page.url + ' 正文非空', 'bytes=' + html.length);
  if (LIVE) ok(/text\/html/i.test(doc.type), page.url + ' Content-Type 为 text/html', doc.type);

  // --- head -------------------------------------------------
  const title = attr(html, /<title>([\s\S]*?)<\/title>/i);
  ok(title.length > 0, page.url + ' 有 <title>');
  ok(title.length <= 60, page.url + ' title ≤ 60 字符', title.length + ' 字符');
  ok(title.toLowerCase().includes(page.keyword.toLowerCase()), page.url + ' title 含主词 ' + page.keyword, title);

  const description = attr(html, /<meta name="description" content="([^"]*)"/i);
  ok(description.length >= 140 && description.length <= 160,
    page.url + ' meta description 140–160 字符', description.length + ' 字符');

  const canonical = attr(html, /<link rel="canonical" href="([^"]+)"/i);
  eq(canonical, 'https://pingory.com' + page.url, page.url + ' canonical 指向自身');

  const hreflangEn = attr(html, /<link rel="alternate" hreflang="en" href="([^"]+)"/i);
  const hreflangDefault = attr(html, /<link rel="alternate" hreflang="x-default" href="([^"]+)"/i);
  eq(hreflangEn, canonical, page.url + ' hreflang=en 指向自身');
  eq(hreflangDefault, canonical, page.url + ' hreflang=x-default 指向自身');

  const ogType = attr(html, /<meta property="og:type" content="([^"]+)"/i);
  eq(ogType, page.ogType, page.url + ' og:type=' + page.ogType);
  eq(attr(html, /<meta property="og:image" content="([^"]+)"/i),
    'https://pingory.com/icon-512.png', page.url + ' og:image 使用站点图标');
  ok(/<meta name="twitter:card"/i.test(html), page.url + ' 有 twitter:card');

  const ogUrl = attr(html, /<meta property="og:url" content="([^"]+)"/i);
  eq(ogUrl, canonical, page.url + ' og:url 与 canonical 一致');

  // --- structure --------------------------------------------
  const h1s = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || [];
  eq(h1s.length, 1, page.url + ' 恰好一个 <h1>');
  eq(textOf(h1s[0] || ''), page.h1, page.url + ' H1 文本符合计划');

  ok(html.includes('<article'), page.url + ' 使用 <article>');
  ok(html.includes('<nav'), page.url + ' 使用 <nav>');
  ok(!/role="heading"/i.test(html), page.url + ' 不把标题伪装成 div + role=heading');

  // --- GEO hooks --------------------------------------------
  ok(/Last verified: October 2026/.test(textOf(html)), page.url + ' 正文含 Last verified: October 2026');

  // CTA headings carry the same answer-first rule; "Keep reading" is a nav list.
  const contentOnly = removeDiv(mainHtml(html), 'related');
  const h2Re = /<h2\b[^>]*>[\s\S]*?<\/h2>/gi;
  const missingAnswer = [];
  const longAnswer = [];
  let h2Count = 0;
  let m;
  while ((m = h2Re.exec(contentOnly))) {
    h2Count++;
    const heading = textOf(m[0]).slice(0, 48);
    const after = contentOnly.slice(h2Re.lastIndex).replace(/^\s+/, '');
    const answer = after.match(/^<p class="answer">([\s\S]*?)<\/p>/i);
    if (!answer) missingAnswer.push(heading);
    else if (words(answer[1]) > 25) longAnswer.push(heading + '=' + words(answer[1]));
  }
  ok(h2Count >= page.minH2, page.url + ' 至少 ' + page.minH2 + ' 个 <h2>', 'count=' + h2Count);
  ok(missingAnswer.length === 0, page.url + ' 每个 H2 后紧跟 class="answer" 的首句',
    missingAnswer.join(' | '));
  ok(longAnswer.length === 0, page.url + ' 每个 answer 首句 ≤ 25 词', longAnswer.join(' | '));

  // --- tables -----------------------------------------------
  const tables = [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((match) => match[0]);
  ok(tables.length >= 1, page.url + ' 含 <table>', 'count=' + tables.length);
  ok(tables.every((t) => /<thead>[\s\S]*?<th scope="col"/i.test(t)),
    page.url + ' 每张表都用 <thead><th scope="col">');
  ok(tables.some((t) => /\d/.test(textOf(t))), page.url + ' 至少一张表含具体数字');

  // --- CTA --------------------------------------------------
  ok(/href="\/llms-txt-checker"[^>]*>Check any site free</.test(html)
    || /Check any site free<\/a>/.test(html) && html.includes('href="/llms-txt-checker"'),
    page.url + ' 主 CTA 指向 /llms-txt-checker');
  ok(/href="\/#plans"/.test(html), page.url + ' 次 CTA 指向 /#plans');
  ok(/<div class="cta">/.test(html), page.url + ' 有独立 CTA 区块');

  // --- styles -----------------------------------------------
  ok(/<link rel="stylesheet" href="\/blog\.css">/.test(html), page.url + ' 引用 /blog.css');
  ok(html.includes("localStorage.getItem('pingory_theme')"), page.url + ' 保留主题初始化脚本');

  const externalCss = /<link[^>]+rel="stylesheet"[^>]+href="(?:https?:)?\/\//i.test(html);
  const externalJs = /<script[^>]+src="(?:https?:)?\/\//i.test(html);
  const webfont = /fonts\.googleapis|fonts\.gstatic|@import\s+url\(\s*['"]?https?:/i.test(html);
  ok(!externalCss, page.url + ' 无外链 CSS');
  ok(!externalJs, page.url + ' 无外链 JS');
  ok(!webfont, page.url + ' 无外部字体');

  // --- forbidden claims -------------------------------------
  ok(!/aggregateRating/i.test(html), page.url + ' 不含 aggregateRating');
  ok(!/multi-?region/i.test(html), page.url + ' 不含 multi-region 表述');
  ok(!/global network/i.test(html), page.url + ' 不含 global network 表述');

  // ChatGPT-User 是用户触发，OpenAI 明确 robots.txt 可能不适用 —— 不得标成「遵循」
  if (html.includes('ChatGPT-User')) {
    const line = html.split('\n').find((l) => l.includes('ChatGPT-User')) || '';
    ok(!/Yes\s*—\s*OpenAI/i.test(line), page.url + ' ChatGPT-User 未误标为遵循 robots.txt');
  }
  if (page.url === '/blog/block-ai-crawlers') {
    ok(!/8 of 8/.test(html), 'block 页不宣称 robots.txt 可挡 8/8（ChatGPT-User 需边缘规则）');
  }

  const bodyText = textOf(html);
  const pricingClash = sentences(bodyText).filter((s) => /\$4/.test(s) && /AI monitor/i.test(s));
  ok(pricingClash.length === 0, page.url + ' 没有把 $4 与 AI monitor 放进同一句', pricingClash[0] || '');

  // --- JSON-LD ----------------------------------------------
  const blocks = parseJsonLd(html);
  ok(blocks.length === 1, page.url + ' 只有一个 JSON-LD 脚本', 'count=' + blocks.length);
  const graph = graphOf(blocks);
  ok(!graph.error, page.url + ' JSON-LD 可被 JSON.parse 解析', graph.error);
  const types = graph.nodes.map((node) => node['@type']);
  for (const expected of page.types) {
    ok(types.includes(expected), page.url + ' @graph 含 ' + expected);
  }

  if (page.article) {
    const article = graph.nodes.find((node) => node['@type'] === 'Article');
    if (article) {
      eq(article.headline, textOf(h1s[0] || ''), page.url + ' Article.headline 与 H1 逐字一致');
      const pageDate = page.date || '2026-10-24';
      eq(article.datePublished, pageDate, page.url + ' Article.datePublished=' + pageDate);
      eq(article.dateModified, pageDate, page.url + ' Article.dateModified=' + pageDate);
      ok(Boolean(article.author && article.publisher), page.url + ' Article 含 author 与 publisher');
      ok(Boolean(article.mainEntityOfPage), page.url + ' Article 含 mainEntityOfPage');
    }
    const crumbs = graph.nodes.find((node) => node['@type'] === 'BreadcrumbList');
    ok(crumbs && crumbs.itemListElement.length >= 3, page.url + ' Breadcrumb 至少三级（Home → Blog → 本文）');
  } else {
    const webpage = graph.nodes.find((node) => node['@type'] === 'WebPage');
    ok(Boolean(webpage), page.url + ' 使用 WebPage 而非 Article');
    ok(!types.includes('Article'), page.url + ' 定位页不伪造成 Article');
  }

  if (page.faq) {
    const faqNode = graph.nodes.find((node) => node['@type'] === 'FAQPage');
    ok(Boolean(faqNode), page.url + ' 有 FAQPage');
    const entries = (faqNode && faqNode.mainEntity) || [];
    ok(entries.length >= 4, page.url + ' FAQ 至少 4 条', 'count=' + entries.length);
    const text = textOf(html);
    const missingQ = entries.filter((entry) => !text.includes(entry.name));
    ok(missingQ.length === 0, page.url + ' FAQPage 的每条 name 在正文中逐字存在',
      missingQ.map((entry) => entry.name).join(' | '));
    const missingA = entries.filter((entry) => !text.includes(entry.acceptedAnswer.text));
    ok(missingA.length === 0, page.url + ' FAQPage 的每条 answer 在正文中逐字存在',
      missingA.map((entry) => entry.name).join(' | '));
  }

  // --- length -----------------------------------------------
  const count = words(mainHtml(html));
  ok(count >= page.words[0] && count <= page.words[1],
    page.url + ' 正文字数 ' + page.words[0] + '–' + page.words[1], count + ' 词');

  // --- internal links --------------------------------------
  ok(html.includes('href="/llms-txt-checker"'), page.url + ' 至少链接 /llms-txt-checker 一次');

  return { html, text: bodyText };
}

// ============================================================
// Cross-page cluster assertions
// ============================================================
function checkLinks(loaded) {
  console.log('\n── 集群内链 ──');
  const at = (url) => loaded[url].html;
  const edges = [
    ['/blog/what-is-llms-txt', '/blog/ai-crawlers-list'],
    ['/blog/ai-crawlers-list', '/blog/block-ai-crawlers'],
    ['/blog/block-ai-crawlers', '/ai-readability'],
    ['/ai-readability', '/blog/what-is-llms-txt'],
    // B2 (D47): every B1 page links into the fault-intent cluster, and the
    // five new pages cross-link so no orphan sits at the edge of the graph.
    ['/blog/what-is-llms-txt', '/blog/robots-txt-guide'],
    ['/blog/ai-crawlers-list', '/blog/robots-txt-guide'],
    ['/blog/block-ai-crawlers', '/blog/robots-txt-guide'],
    ['/ai-readability', '/blog/json-ld-structured-data'],
    ['/blog/robots-txt-guide', '/blog/block-ai-crawlers'],
    ['/blog/robots-txt-guide', '/blog/xml-sitemap-guide'],
    ['/blog/schema-validation-errors', '/blog/json-ld-structured-data'],
    ['/blog/json-ld-structured-data', '/blog/schema-validation-errors'],
    ['/blog/xml-sitemap-guide', '/blog/canonical-tag-guide'],
    ['/blog/canonical-tag-guide', '/blog/xml-sitemap-guide'],
  ];
  for (const [from, to] of edges) {
    ok(at(from).includes('href="' + to + '"'), from + ' → ' + to);
  }
  for (const page of PAGES) {
    ok(at('/blog').includes('href="' + page.url + '"'), '/blog 索引链接到 ' + page.url);
  }
}

async function checkSitemap() {
  console.log('\n── sitemap.xml / llms.txt ──');
  const sitemap = await loadText('/sitemap.xml', 'public/sitemap.xml');
  eq(sitemap.status, 200, 'sitemap.xml 可访问');
  const locs = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  eq(locs.length, 36, 'sitemap 恰好 36 条 <loc>');
  for (const page of PAGES) {
    const loc = 'https://pingory.com' + page.url;
    const index = locs.indexOf(loc);
    ok(index > -1, 'sitemap 含 ' + page.url);
    if (index > -1) {
      const chunk = sitemap.body.slice(sitemap.body.indexOf(loc), sitemap.body.indexOf(loc) + 400);
      const pageDate = page.date || '2026-10-24';
      ok(chunk.includes('<lastmod>' + pageDate + '</lastmod>'), page.url + ' lastmod=' + pageDate);
    }
  }
  const priorities = { '/blog': '0.7', '/ai-readability': '0.9' };
  for (const [url, priority] of Object.entries(priorities)) {
    const start = sitemap.body.indexOf('https://pingory.com' + url + '<');
    const chunk = sitemap.body.slice(start, start + 400);
    ok(chunk.includes('<priority>' + priority + '</priority>'), url + ' priority=' + priority);
  }

  const llms = await loadText('/llms.txt', 'public/llms.txt');
  eq(llms.status, 200, 'llms.txt 可访问');
  ok(llms.body.includes('https://pingory.com/llms-txt-checker'), 'llms.txt 含 /llms-txt-checker 条目');
  ok(/## Guides \(AI Readability\)/.test(llms.body), 'llms.txt 有 Guides 区');
  for (const page of PAGES) {
    ok(llms.body.includes('https://pingory.com' + page.url), 'llms.txt 含 ' + page.url);
  }
}

async function checkRedirects() {
  console.log('\n── 线上路由 ──');
  const cases = [
    ['/blog/', 301, '/blog'],
    ['/blog.html', 301, '/blog'],
    ['/blog/what-is-llms-txt/', 301, '/blog/what-is-llms-txt'],
    ['/blog/what-is-llms-txt.html', 301, '/blog/what-is-llms-txt'],
    ['/ai-readability/', 301, '/ai-readability'],
    ['/ai-readability.html', 301, '/ai-readability'],
  ];
  for (const [from, status, to] of cases) {
    const res = await fetch(BASE + from, { redirect: 'manual' });
    eq(res.status, status, from + ' → ' + status);
    const location = res.headers.get('location') || '';
    ok(location.endsWith(to), from + ' 指向 ' + to, location);
  }
  const missing = await fetch(BASE + '/blog/does-not-exist', { redirect: 'manual' });
  eq(missing.status, 404, '/blog/does-not-exist 落到 404');
}

// 内容页响应头（D46）：静态直出 + 可缓存 + 安全头。
// 这三件事任一退化都会静默发生（页面照常打开），所以必须在线上逐条断言。
async function checkContentHeaders() {
  console.log('\n── 内容页响应头 ──');
  const urls = ['/blog', '/blog/what-is-llms-txt', '/blog/ai-crawlers-list',
    '/blog/block-ai-crawlers', '/blog/robots-txt-guide', '/blog/xml-sitemap-guide',
    '/ai-readability', '/llms-txt-checker'];
  for (const url of urls) {
    const res = await fetch(BASE + url, { redirect: 'manual' });
    const cc = res.headers.get('cache-control') || '';
    const csp = res.headers.get('content-security-policy') || '';
    const maxAge = Number((cc.match(/max-age=(\d+)/) || [])[1]);
    ok(maxAge >= 300, url + ' 浏览器缓存 ≥300s（max-age=0 会让每个访客都回源验证）', cc);
    ok(/default-src 'self'/.test(csp), url + ' CSP 的 default-src 限制为 self', csp.slice(0, 48));
    ok(!/unsafe-eval/.test(csp), url + ' CSP 不含 unsafe-eval');
    eq(res.headers.get('x-content-type-options'), 'nosniff', url + ' X-Content-Type-Options');
    eq(res.headers.get('x-frame-options'), 'SAMEORIGIN', url + ' X-Frame-Options');
    eq(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', url + ' Referrer-Policy');
    ok((res.headers.get('content-type') || '').includes('text/html'), url + ' 仍以 text/html 直出');
  }
}

// ============================================================
// Static-only: routes and shared stylesheet
// ============================================================
function readRepoFile(relative) {
  const full = path.join(ROOT, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function checkRoutes() {
  console.log('\n── 路由与配置 ──');
  const pages = readRepoFile('src/cf-worker/pages.js');
  const server = readRepoFile('server.js');
  const wrangler = readRepoFile('wrangler.jsonc');
  const css = readRepoFile('public/blog.css');

  ok(pages.includes("app.get('/blog',"), 'pages.js 注册 GET /blog');
  ok(pages.includes("app.get('/blog/',"), 'pages.js 注册 /blog/ 尾斜杠');
  ok(pages.includes("app.get('/blog.html',"), 'pages.js 注册 /blog.html');
  ok(pages.includes("app.get('/blog/*', (c) => c.notFound())"), 'pages.js 未匹配 /blog/* 显式 404');
  ok(pages.includes('BLOG_PAGES'), 'pages.js 使用白名单映射');
  ok(!/app\.get\('\/blog\/:slug'/.test(pages), 'pages.js 不用动态 /blog/:slug');

  for (const page of PAGES.filter((p) => p.url.startsWith('/blog/'))) {
    ok(pages.includes("'" + page.url + "'"), 'pages.js 白名单含 ' + page.url);
    ok(pages.includes("'" + page.url + ".html'"), 'pages.js 白名单含 ' + page.url + '.html');
  }
  ok(pages.includes("app.get('/ai-readability',"), 'pages.js 注册 GET /ai-readability');
  ok(pages.includes("app.get('/ai-readability.html',"), 'pages.js 注册 /ai-readability.html');

  ok(server.includes("sendContentFile(res, 'blog.html')"), 'server.js 直出 blog.html');
  ok(server.includes("req.path.endsWith('/')"), 'server.js 在 handler 内区分尾斜杠（Express 非严格路由）');
  ok(server.includes("res.redirect(301, '/blog')"), 'server.js /blog/ 301 到 /blog');
  for (const page of PAGES.filter((p) => p.url.startsWith('/blog/'))) {
    ok(server.includes("'" + page.url + "'"), 'server.js 含路由 ' + page.url);
    ok(server.includes("'" + page.url.slice(1) + ".html'"), 'server.js 含文件 ' + page.url + '.html');
  }
  ok(server.includes("sendContentFile(res, 'ai-readability.html')"), 'server.js 直出 ai-readability.html');

  // D46：内容页响应头（缓存 + 安全）——两条部署路径必须给同一套，否则行为分叉
  const wCache = (pages.match(/CONTENT_CACHE = '([^']+)'/) || [])[1] || '';
  const sCache = (server.match(/CONTENT_CACHE = '([^']+)'/) || [])[1] || '';
  ok(wCache.length > 0 && wCache === sCache, 'Worker 与自托管的 CONTENT_CACHE 逐字一致', wCache);
  const wMaxAge = Number((wCache.match(/max-age=(\d+)/) || [])[1]);
  ok(wMaxAge >= 300, 'CONTENT_CACHE 浏览器缓存 ≥300s', 'max-age=' + wMaxAge);
  ok(/stale-while-revalidate=/.test(wCache), 'CONTENT_CACHE 含 stale-while-revalidate');
  ok(pages.includes('CONTENT_CSP') && server.includes('CONTENT_CSP'), '两条路径都输出 CSP');
  ok(/default-src 'self'/.test(pages) && /default-src 'self'/.test(server), "CSP 的 default-src 为 'self'");
  ok(pages.includes("serveContentAsset(c, '/blog.html')"), 'pages.js /blog 走 serveContentAsset');
  ok(pages.includes("serveContentAsset(c, '/ai-readability.html')"), 'pages.js /ai-readability 走 serveContentAsset');
  ok(pages.includes("serveContentAsset(c, '/llms-txt-checker.html')"), 'pages.js /llms-txt-checker 走 serveContentAsset');

  const rwf = (wrangler.match(/"run_worker_first":\s*\[[\s\S]*?\]/) || [''])[0];
  for (const entry of ['"/blog"', '"/blog.html"', '"/blog/*"', '"/ai-readability"', '"/ai-readability.html"']) {
    ok(rwf.includes(entry), 'wrangler run_worker_first 含 ' + entry);
  }

  ok(css.length > 1000, 'public/blog.css 存在且非空', 'bytes=' + css.length);
  ok(css.includes('@media (max-width: 760px)'), 'blog.css 有 760px 移动端断点');
  ok(css.includes('overflow-x: auto'), 'blog.css 表格横向滚动');
  ok(/#fff/.test(css) && /--accent: #1faa6b/.test(css) && /--accent: #2bd585/.test(css),
    'blog.css 双主题 accent 与实心按钮 #fff');
}

// ============================================================
// Run
// ============================================================
console.log('Pingory B1+B2 content cluster test (D45 / D47)');
console.log(LIVE ? 'Mode: live — ' + BASE : 'Mode: static — ' + ROOT);

const loaded = {};
for (const page of PAGES) {
  loaded[page.url] = await checkPage(page);
}

checkLinks(loaded);
await checkSitemap();
if (LIVE) {
  await checkRedirects();
  await checkContentHeaders();
} else {
  checkRoutes();
}

console.log('\n────────────────────────────────────────────');
console.log((fails.length === 0 ? 'ALL GREEN  ' : 'FAILED     ') + pass + ' passed, ' + fails.length + ' failed, total ' + (pass + fails.length));
if (fails.length) {
  console.log('\nFailures:');
  fails.forEach((failure, index) => console.log('  ' + (index + 1) + '. ' + failure));
  process.exit(1);
}
