// cf-worker 页面路由（动态渲染类，必须在 ASSETS 静态兜底之前接管）：
//   · GET /                     自定义域名命中状态页 → status.html；否则回落静态首页
//   · GET /compare/{slug}       SEO 对比页（英文规范地址）
//   · GET /{lang}/compare/{slug} 7 语变体（zh/es/pt/de/fr/ja/ko）
//   · GET /vs/{slug}            301 → /compare/{slug}
//   · GET /compare-{slug}.html  301 → /compare/{slug}
//   · GET /status/:slug         公开状态页 HTML（status.html）
//
// 与 server.js 的差异：模板与 i18n 字典不再读本地 fs（Workers 无文件系统），
// 改为经 env.ASSETS.fetch 读取 public/ 下的同一份文件；渲染逻辑（cmpLocalize /
// 占位符替换 / preload 注入）逐行照搬。渲染缓存按 (slug, lang) 存 isolate 内存
// （Express 版按 mtime 失效；Workers 无 mtime，部署新版本即新 isolate，缓存随之失效）。

import { getStatusPageByHost } from '../monitors.js';

const CMP_LANGS = new Set(['zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko']);
const CMP_PAGES = {
  uptimerobot: { path: '/compare/uptimerobot', template: '/compare-uptimerobot.html' },
  betterstack: { path: '/compare/betterstack', template: '/compare-betterstack.html' },
  pingdom:     { path: '/compare/pingdom',     template: '/compare-pingdom.html' },
};
// 只预载本页用到的键，避免整包拖慢首屏（与 server.js 同款正则）
const CMP_I18N_KEY = /^(cmp\.|cmpbs\.|cmppd\.|nav\.|footer\.|landing\.ctaFree$)/;

const cmpCache = new Map();
const CMP_CACHE_MAX = 64;

// 裸 & 转义为 &amp;（已是实体的不重复转义）
function cmpEscText(v) {
  return String(v).replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|nbsp);)/g, '&amp;');
}
function cmpEscAttr(v) {
  return cmpEscText(v).replace(/"/g, '&quot;');
}
async function assetText(env, baseUrl, assetPath) {
  try {
    const res = await env.ASSETS.fetch(new URL(assetPath, baseUrl));
    if (!res || !res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
async function cmpReadDict(env, baseUrl, lang) {
  const raw = await assetText(env, baseUrl, '/i18n/' + lang + '.json');
  if (raw == null) {
    console.error('[compare] 字典读取失败:', lang);
    return null;
  }
  try { return JSON.parse(raw); } catch (e) {
    console.error('[compare] 字典解析失败:', lang, e.message);
    return null;
  }
}
function cmpPreloadScript(lang, dict) {
  const sub = {};
  if (dict) for (const k of Object.keys(dict)) if (CMP_I18N_KEY.test(k)) sub[k] = dict[k];
  return '<script>window.__I18N_LANG__=' + JSON.stringify(lang)
    + ';window.__I18N_PRELOAD__=' + JSON.stringify(sub).replace(/</g, '\\u003c') + ';<\/script>';
}
// 服务端把 data-i18n / data-i18n-content 就地替换为目标语言文案（属性保留 → 前端切语不受影响）
function cmpLocalize(html, dict) {
  if (!dict) return html;
  html = html.replace(/<[^>]*\bdata-i18n-content="([^"]+)"[^>]*>/g, (tag, key) => {
    const v = dict[key];
    if (v == null || !/\bcontent="[^"]*"/.test(tag)) return tag;
    return tag.replace(/\bcontent="[^"]*"/, () => 'content="' + cmpEscAttr(v) + '"');
  });
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>/g;
  let out = '', last = 0, m;
  while ((m = re.exec(html))) {
    const tag = m[1], key = m[2], v = dict[key];
    if (v == null) continue;
    const openEnd = m.index + m[0].length;
    const tagRe = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    tagRe.lastIndex = openEnd;
    let depth = 1, t, closeStart = -1;
    while ((t = tagRe.exec(html))) {
      if (t[1] === '/') { depth--; if (depth === 0) { closeStart = t.index; break; } } else depth++;
    }
    if (closeStart === -1) continue;
    out += html.slice(last, openEnd) + cmpEscText(v);
    last = closeStart;
    re.lastIndex = closeStart;
  }
  out += html.slice(last);
  return out;
}

async function cmpRender(env, baseUrl, slug, lang) {
  const page = CMP_PAGES[slug];
  const cacheKey = `${slug}|${lang}`;
  const cached = cmpCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const html = await assetText(env, baseUrl, page.template);
  if (html == null) {
    console.error('[compare] 模板读取失败:', slug);
    return null; // 读失败不写入缓存，下次请求重试
  }
  const dict = lang === 'en' ? null : await cmpReadDict(env, baseUrl, lang);
  const localized = lang === 'en' ? html : cmpLocalize(html, dict);
  const canonical = 'https://pingory.com' + (lang === 'en' ? page.path : '/' + lang + page.path);
  const out = localized
    .replace(/__CMP_LANG__/g, lang)
    .replace(/__CMP_CANONICAL__/g, () => canonical)
    .replace('<!--CMP_I18N_PRELOAD-->', () => cmpPreloadScript(lang, dict));

  if (cmpCache.size >= CMP_CACHE_MAX) cmpCache.clear();
  cmpCache.set(cacheKey, out);
  return out;
}

export function registerPageRoutes(app) {
  // 自定义域名根路径返回状态页（G7）：需在静态兜底前拦截（与 server.js 同位置语义）
  app.get('/', async (c) => {
    const host = hostnameSafe(c);
    try {
      const page = await getStatusPageByHost(host);
      if (page) return c.env.ASSETS.fetch(new URL('/status.html', c.req.url));
    } catch { /* 忽略，走默认首页 */ }
    // html_handling:"none" 下 ASSETS 不再做 "/"→index.html 解析，必须显式取文件（Worker 模式专属路径，
    // Fly 的 express.static 自带 index 解析不受影响）
    if (new URL(c.req.url).pathname === '/') {
      return c.env.ASSETS.fetch(new URL('/index.html', c.req.url));
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  // 三张对比页统一注册：英文规范路由 + /{lang} 变体 + 别名 301（避免重复内容，SEO）
  for (const [slug, cfg] of Object.entries(CMP_PAGES)) {
    app.get(cfg.path, async (c) => sendComparePage(c, slug, 'en'));
    app.get('/:lang' + cfg.path, async (c) => {
      const lang = String(c.req.param('lang') || '').toLowerCase();
      if (!CMP_LANGS.has(lang)) return notFoundAsset(c);
      return sendComparePage(c, slug, lang);
    });
    app.get('/vs/' + slug, (c) => c.redirect(cfg.path, 301));
    app.get('/compare-' + slug + '.html', (c) => c.redirect(cfg.path, 301));
  }

  // 公开状态页 HTML（G5/G7，无需登录；slug 不存在也返回壳页面，由前端按数据接口渲染）
  app.get('/status/:slug', (c) => c.env.ASSETS.fetch(new URL('/status.html', c.req.url)));
}

function hostnameSafe(c) {
  return (new URL(c.req.url).hostname || '').toLowerCase();
}

// 非白名单语言：与 Express 版 next() 落到静态/404 的行为一致——交还 ASSETS 兜底
function notFoundAsset(c) {
  return c.env.ASSETS.fetch(c.req.raw);
}

async function sendComparePage(c, slug, lang) {
  const html = await cmpRender(c.env, c.req.url, slug, lang);
  if (html == null) return c.text('template error', 500);
  return c.html(html);
}
