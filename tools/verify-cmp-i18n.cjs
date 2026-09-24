// 对比页多语验证（2026-09-24，P2）
// 复刻 server.js 的 cmpRender 纯文件流水线（不 require server.js——它连生产库，禁止本地起服）。
// 检查项：
//  A. 三页 × 8 语渲染：无 __CMP_* 占位泄漏、无 <!--CMP_I18N_PRELOAD--> 泄漏、<html lang> 与 canonical 正确、非英语页 preload 注入且含译文
//  B. 静态英文 vs en 字典漂移对账：每个 data-i18n / data-i18n-content 键，en 值必须与模板静态文本一致
//  C. 8 语字典键集一致性
//  D. sitemap.xml 可解析、URL 数与预期一致、新变体齐全
'use strict';
const fs = require('fs');
const path = require('path');
const langs = ['en', 'zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko'];
const PAGES = {
  uptimerobot: '/compare/uptimerobot',
  betterstack: '/compare/betterstack',
  pingdom: '/compare/pingdom',
};
let fails = 0;
function fail(msg) { console.log('  ❌ ' + msg); fails++; }
function ok(msg) { console.log('  ✅ ' + msg); }

// ===== 与 server.js 相同的流水线（复制自 server.js，勿改语义）=====
function cmpEscText(v) {
  return String(v).replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|nbsp);)/g, '&amp;');
}
function cmpEscAttr(v) {
  return cmpEscText(v).replace(/"/g, '&quot;');
}
function cmpReadDict(lang) {
  return JSON.parse(fs.readFileSync(path.join('public', 'i18n', lang + '.json'), 'utf8'));
}
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
function cmpRender(slug, lang) {
  const pagePath = path.join('public', 'compare-' + slug + '.html');
  let html = fs.readFileSync(pagePath, 'utf8');
  const dict = lang === 'en' ? null : cmpReadDict(lang);
  if (lang !== 'en') html = cmpLocalize(html, dict);
  const canonical = 'https://pingory.com' + (lang === 'en' ? PAGES[slug] : '/' + lang + PAGES[slug]);
  // preload 注入（与 server.js 同语义：按 CMP_I18N_KEY 子集）
  const sub = {};
  if (dict) for (const k of Object.keys(dict)) if (/^(cmp\.|cmpbs\.|cmppd\.|nav\.|footer\.|landing\.ctaFree$)/.test(k)) sub[k] = dict[k];
  const preload = '<script>window.__I18N_LANG__=' + JSON.stringify(lang)
    + ';window.__I18N_PRELOAD__=' + JSON.stringify(sub).replace(/</g, '\\u003c') + ';<\/script>';
  return html
    .replace(/__CMP_LANG__/g, lang)
    .replace(/__CMP_CANONICAL__/g, () => canonical)
    .replace('<!--CMP_I18N_PRELOAD-->', () => preload);
}

// ===== A. 渲染检查 =====
console.log('== A. 渲染检查（3 页 × 8 语）==');
for (const slug of Object.keys(PAGES)) {
  for (const lang of langs) {
    const out = cmpRender(slug, lang);
    const label = slug + '/' + lang;
    if (/__CMP_(LANG|CANONICAL)__/.test(out)) fail(label + ': 占位符泄漏 __CMP_*');
    if (out.includes('<!--CMP_I18N_PRELOAD-->')) fail(label + ': preload 注释未替换');
    const langAttr = (out.match(/<html lang="([^"]+)"/) || [])[1];
    if (langAttr !== lang) fail(label + ': html lang=' + langAttr + ' 应为 ' + lang);
    const canon = (out.match(/rel="canonical" href="([^"]+)"/) || [])[1];
    if (canon !== 'https://pingory.com' + (lang === 'en' ? PAGES[slug] : '/' + lang + PAGES[slug])) fail(label + ': canonical=' + canon);
    if (lang !== 'en') {
      if (!out.includes('window.__I18N_PRELOAD__')) fail(label + ': 缺 preload 脚本');
      // 抽查：h1 应已本地化（不再是英文原文）
      const h1 = (out.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
      if (h1.includes('An Honest Comparison') && lang !== 'en') fail(label + ': h1 疑似未本地化: ' + h1.slice(0, 60));
      // hreflang 自指：当前语言变体链接应存在
      if (!out.includes('hreflang="' + lang + '"')) fail(label + ': 缺自身 hreflang');
    }
    // JSON-LD 保持可解析
    const ld = out.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!ld) { fail(label + ': 缺 JSON-LD'); }
    else { try { JSON.parse(ld[1]); } catch (e) { fail(label + ': JSON-LD 解析失败 ' + e.message); } }
  }
}
ok('渲染检查完成（失败数计入总失败）');

// ===== B. 静态英文 vs en 字典漂移对账 =====
console.log('== B. 静态英文 vs en 字典漂移对账 ==');
const en = cmpReadDict('en');
function norm(s) {
  return String(s).replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
for (const slug of Object.keys(PAGES)) {
  const html = fs.readFileSync(path.join('public', 'compare-' + slug + '.html'), 'utf8');
  let checked = 0;
  // data-i18n-content：比对 content 属性
  const reC = /<[^>]*\bdata-i18n-content="([^"]+)"[^>]*>/g;
  let m;
  while ((m = reC.exec(html))) {
    const key = m[1];
    const cm = m[0].match(/\bcontent="([^"]*)"/);
    if (!cm) { fail(slug + ': content 属性缺失 ' + key); continue; }
    if (en[key] == null) { fail(slug + ': en 字典缺 ' + key); continue; }
    if (norm(cm[1]) !== norm(en[key])) {
      fail(slug + ' 漂移(' + key + '):\n    静态=' + norm(cm[1]).slice(0, 100) + '\n    字典=' + norm(en[key]).slice(0, 100));
    }
    checked++;
  }
  // data-i18n：比对元素内部文本（同 server.js 配对逻辑）
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>/g;
  while ((m = re.exec(html))) {
    const tag = m[1], key = m[2];
    const openEnd = m.index + m[0].length;
    const tagRe = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    tagRe.lastIndex = openEnd;
    let depth = 1, t, closeStart = -1;
    while ((t = tagRe.exec(html))) {
      if (t[1] === '/') { depth--; if (depth === 0) { closeStart = t.index; break; } } else depth++;
    }
    if (closeStart === -1) { fail(slug + ': ' + key + ' 标签未闭合'); continue; }
    const staticInner = html.slice(openEnd, closeStart);
    if (en[key] == null) { fail(slug + ': en 字典缺 ' + key); continue; }
    if (norm(staticInner) !== norm(en[key])) {
      fail(slug + ' 漂移(' + key + '):\n    静态=' + norm(staticInner).slice(0, 100) + '\n    字典=' + norm(en[key]).slice(0, 100));
    }
    checked++;
  }
  console.log('  ' + slug + ': 对账 ' + checked + ' 个键');
}

// ===== C. 8 语字典键集一致性 =====
console.log('== C. 字典键集一致性 ==');
const keysets = langs.map((l) => Object.keys(cmpReadDict(l)).sort());
const base = keysets[0];
let mismatch = 0;
langs.forEach((l, i) => {
  const ks = keysets[i];
  const onlyBase = base.filter((k) => !ks.includes(k));
  const onlyThis = ks.filter((k) => !base.includes(k));
  if (onlyBase.length || onlyThis.length) {
    mismatch++;
    fail(l + ' 键集不一致: 仅en有=' + onlyBase.join(',') + ' 仅' + l + '有=' + onlyThis.join(','));
  }
});
if (!mismatch) ok('8 语键集完全一致（' + base.length + ' 键）');

// ===== D. sitemap =====
console.log('== D. sitemap.xml ==');
const sm = fs.readFileSync('public/sitemap.xml', 'utf8');
const urls = (sm.match(/<loc>([^<]+)<\/loc>/g) || []).map((s) => s.replace(/<\/?loc>/g, ''));
try {
  // 简单良构检查：成对标签计数
  const open = (sm.match(/<url>/g) || []).length, close = (sm.match(/<\/url>/g) || []).length;
  if (open !== close) fail('sitemap <url> 不配对 ' + open + '/' + close);
} catch (e) { fail('sitemap 解析: ' + e.message); }
const expect = ['zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko'].flatMap((l) => ['betterstack', 'pingdom'].map((s) => 'https://pingory.com/' + l + '/compare/' + s));
const missing = expect.filter((u) => !urls.includes(u));
if (missing.length) fail('sitemap 缺变体: ' + missing.join(', '));
if (!missing.length) ok('sitemap ' + urls.length + ' 个 URL，14 个新变体齐全');

console.log(fails === 0 ? '\n✅ 全部通过' : '\n❌ 失败 ' + fails + ' 项');
process.exit(fails === 0 ? 0 : 1);
