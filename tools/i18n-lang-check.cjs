// tools/i18n-lang-check.cjs — 多语言「切换后动态区跟随」真机回归测试（2026-09-14 固化）
//
// 为什么需要它：静态门禁只能查「缺键 / 未翻译 / 硬编码中文 / 钩子覆盖」，
// 但「切换语言后某个动态区块停留在旧语言」这类缺陷必须真机跑一遍才靠得住 ——
// 本脚本断言：非中文语言下页面不出现中日韩文字，并逐项覆盖动态区。
//
// 覆盖：告警渠道区 / 套餐用量行 / 账户设置弹窗（含分区保持）/ 检查失败原因错误码
//       / 事件历史（含轮询重建后不清空）/ 重置密码副标题 / 登录注册副标题行 / 眼按钮
//
// 前置：本机已启动实例（默认 http://127.0.0.1:3111，端口用 BASE 覆盖），
//       项目根目录存在 .env（DATABASE_URL，用于临时账号升降级与清理）。
// 副作用：注册临时账号 i18n.check.<ts>@example.com 并置为 pro，跑完自动删除该账号与其监控；
//         FATAL 退出时会打印 TEMP_EMAIL，需按提示手动清理。
// 用法：PORT=3111 node server.js &  然后  node tools/i18n-lang-check.cjs
const path0 = require('path');
const ROOT = path0.join(__dirname, '..');
const PW = require('C:/Users/曹易/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const BASE = process.env.BASE || ('http://127.0.0.1:' + (process.env.PORT || 3111));
const EMAIL = 'i18n.check.' + Date.now() + '@example.com';
const PASS = 'Test1234!x';
let TMP_MON = null;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;   // 中日韩
const HAN = /[\u4e00-\u9fff]/;

// 取可见文本（排除 select 内的语言名 / script / style）
const VISIBLE_TEXT = () => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const out = []; let n;
  while ((n = walker.nextNode())) {
    const el = n.parentElement;
    if (!el) continue;
    if (el.closest('select')) continue;
    if (el.closest('script,style,svg')) continue;
    const s = (n.nodeValue || '').trim();
    if (s) out.push(s);
  }
  return out.join('\n');
};

(async () => {
  const browser = await PW.chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

  // ---- 1) 注册临时账号（浏览器上下文带会话）----
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  const reg = await p.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email, password }) });
    return { status: r.status, body: await r.json() };
  }, { email: EMAIL, password: PASS });
  ok(reg.status === 201, '临时账号注册 HTTP ' + reg.status + '（' + EMAIL + '）');

  // 临时把该账号升到 pro + 标记邮箱已验证：告警渠道区仅在 starter/pro 出现（free 只有 email）
  {
    const fs = require('fs');
    const env = fs.readFileSync(path0.join(ROOT, '.env'), 'utf8');
    for (const line of env.split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const r = await c.query("UPDATE users SET plan='pro', email_verified=true WHERE email=$1", [EMAIL]);
    await c.end();
    ok(r.rowCount === 1, '临时账号已置为 pro + 邮箱已验证（用于验证渠道区）');
  }

  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p.waitForSelector('#chanBox', { timeout: 10000 });
  const chanCount = await p.locator('#chanBox .chan-row').count();
  ok(chanCount === 6, '告警渠道勾选框数量 = ' + chanCount + '（期望 6：Slack/Webhook/Telegram/Discord/MS Teams/PagerDuty）');

  // 等 __afterLang 真正跑完（页面内有 __langSeq 完成标记），避免固定 sleep 造成的假失败
  const switchLang = async (lang) => {
    const before = await p.evaluate(() => window.__langSeq || 0);
    await p.selectOption('select.lang-select', lang);
    await p.waitForFunction((n) => (window.__langSeq || 0) > n, before, { timeout: 10000 });
    await p.waitForTimeout(120);
  };

  // ---- 2) 核心：切换语言后渠道区必须跟随 ----
  console.log('\n=== 告警渠道区随语言切换 ===');
  for (const lang of ['es', 'pt', 'de', 'fr', 'zh']) {
    await switchLang(lang);
    const boxText = await p.locator('#chanBox').innerText();
    const hasCJK = CJK.test(boxText);
    if (lang === 'zh') {
      ok(hasCJK, '[zh] 渠道区显示中文（' + boxText.split('\n')[0].slice(0, 24) + '…）');
    } else {
      ok(!hasCJK, '[' + lang + '] 渠道区无中日韩文字 → ' + JSON.stringify(boxText.split('\n').slice(0, 3).join(' / ').slice(0, 90)));
    }
    const pageText = await p.evaluate(VISIBLE_TEXT);
    const pageHasCJK = CJK.test(pageText.replace(/[\u3040-\u30ff\uac00-\ud7af]/g, ''));
    if (lang !== 'zh') {
      ok(!pageHasCJK, '[' + lang + '] 整页（除语言名）无中文残留');
      if (pageHasCJK) {
        const lines = pageText.split('\n').filter((l) => HAN.test(l)).slice(0, 6);
        console.log('        泄漏行: ' + JSON.stringify(lines));
      }
    }
  }

  // ---- 3) 监控列表 / 套餐行 / 未配置提示是否跟随 ----
  console.log('\n=== 其他动态区（切 en→es 后） ===');
  await switchLang('es');
  const planText = await p.locator('#planInfo').innerText();
  ok(!CJK.test(planText), '套餐用量行已西语：' + JSON.stringify(planText.slice(0, 70)));
  ok(!/Infinity/.test(planText) && /∞/.test(planText), 'Pro 上限显示为 ∞ 而非 Infinity');
  const hint = await p.locator('#chanBox .chan-note').last().innerText();
  ok(!CJK.test(hint), '「去配置」引导文案已西语：' + JSON.stringify(hint.slice(0, 80)));

  // ---- 4) 账户设置弹窗：打开 → 切语言 → 应重建且保持当前分区 ----
  console.log('\n=== 账户设置弹窗（语言切换后重建） ===');
  await p.locator('#chanBox [data-open-acct]').first().click();
  await p.waitForSelector('#acSection', { timeout: 5000 });
  await p.selectOption('#acSection', 'channels');
  await p.waitForTimeout(200);
  const paneEs = await p.locator('#acPane-channels').innerText();
  ok(!CJK.test(paneEs), '打开时（es）渠道分区无中文');
  await switchLang('zh');
  const paneZh = await p.locator('#acPane-channels').innerText();
  ok(HAN.test(paneZh), '切到 zh 后弹窗重建为中文（' + paneZh.split('\n')[0].slice(0, 20) + '）');
  const stillChannels = await p.locator('#acPane-channels').evaluate((el) => el.classList.contains('active'));
  ok(stillChannels, '重建后仍停留在「告警渠道」分区（未被重置回资料页）');
  const secVal = await p.locator('#acSection').inputValue();
  ok(secVal === 'channels', '分区下拉值保留 = ' + secVal);
  await switchLang('fr');
  const paneFr = await p.locator('#acPane-channels').innerText();
  ok(!HAN.test(paneFr), '再切 fr 后弹窗为法语：' + JSON.stringify(paneFr.split('\n').slice(0, 3).join(' / ').slice(0, 90)));
  await p.keyboard.press('Escape').catch(() => {});
  await p.locator('#pingoryModal .pm-actions button').first().click().catch(() => {});
  await p.waitForTimeout(200);

  // ---- 4b) 检查失败原因错误码 → 多语言 ----
  console.log('\n=== 检查失败原因（服务端存的错误码按语言翻译） ===');
  await switchLang('es');
  const unit = await p.evaluate(() => ({
    timeout: fmtMonitorError('connect_timeout'),
    kw: fmtMonitorError('kw_not_found|hello'),
    assert: fmtMonitorError('assert_failed|data.status|foo|ok'),
    neutral: fmtMonitorError('HTTP 500'),
    nodeErr: fmtMonitorError('ECONNREFUSED'),
  }));
  ok(/Tiempo de conexi/.test(unit.timeout), 'connect_timeout → 西语「' + unit.timeout + '」');
  ok(/hello/.test(unit.kw) && !CJK.test(unit.kw), 'kw_not_found 保留关键字并翻译：「' + unit.kw + '」');
  ok(/foo/.test(unit.assert) && /ok/.test(unit.assert) && !CJK.test(unit.assert), 'assert_failed 三段参数填充：「' + unit.assert + '」');
  ok(unit.neutral === 'HTTP 500' && unit.nodeErr === 'ECONNREFUSED', '语言中立原文（HTTP 500 / ECONNREFUSED）原样显示');

  // 用真实数据验证列表与历史渲染（写一条 down 监控 + 一条事件）
  {
    const fs = require('fs');
    const { Client } = require('pg');
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c.connect();
    const u = await c.query('SELECT id FROM users WHERE email=$1', [EMAIL]);
    const uid = u.rows[0].id;
    const ins = await c.query(
      `INSERT INTO monitors (id, user_id, url, name, type, interval, status, last_error, last_checked, channels)
       VALUES ($1,$2,$3,$4,'http',300,'down',$5,$6,NULL) RETURNING id`,
      ['i18n-mon-' + Date.now(), uid, 'https://probe-i18n.example.com/', 'i18n probe', 'connect_timeout', Date.now()]
    );
    const mid = ins.rows[0].id;
    await c.query(
      `INSERT INTO monitor_events (monitor_id, event_type, from_status, to_status, error, created_at)
       VALUES ($1,'down','up','down',$2,$3)`,
      [mid, 'assert_failed|data.status|foo|ok', new Date()]
    );
    TMP_MON = mid;
    await c.end();
    ok(true, '已写入一条 down 监控（错误码 connect_timeout）+ 一条事件（assert_failed|…）');
  }
  await switchLang('zh');
  await switchLang('es');   // 触发重新拉取监控列表
  await p.waitForTimeout(800);
  const meta = await p.locator('#monList .mon .meta').first().innerText();
  ok(!CJK.test(meta) && /Tiempo de conexi/.test(meta), '监控列表错误文案已西语：' + JSON.stringify(meta.slice(0, 90)));
  await p.locator('#monList button.hist').first().click();
  await p.waitForSelector('#monList .history:not(.hidden)', { timeout: 5000 });
  await p.waitForTimeout(300);
  const histText = await p.locator('#monList .history').first().innerText();
  ok(!CJK.test(histText) && /foo/.test(histText), '事件历史错误文案已西语：' + JSON.stringify(histText.slice(0, 110)));
  // 回归：轮询（5s 一次）整体重建 #monList 时，已展开的历史不能被清空
  await p.waitForTimeout(6200);
  const histAfterPoll = await p.locator('#monList .history').first().innerText();
  ok(/foo/.test(histAfterPoll) && !(await p.locator('#monList .history').first().evaluate((el) => el.classList.contains('hidden'))), '轮询重建列表后已展开的历史仍在：' + JSON.stringify(histAfterPoll.slice(0, 60)));
  // 切换语言后已展开的历史也要跟随重绘
  await switchLang('zh');
  const histZh = await p.locator('#monList .history').first().innerText();
  ok(HAN.test(histZh), '切换语言后已展开的事件历史跟随重绘为中文：' + JSON.stringify(histZh.slice(0, 60)));

  // ---- 5) 重置密码页副标题随语言（此前恒为英文） ----
  console.log('\n=== 重置密码页副标题 ===');
  for (const lang of ['zh', 'es']) {
    await p.goto(BASE + '/reset-password.html?token=demo', { waitUntil: 'networkidle' });
    await p.evaluate((l) => localStorage.setItem('pingory_lang', l), lang);
    await p.reload({ waitUntil: 'networkidle' });
    const subText = await p.locator('#sub').innerText();
    if (lang === 'zh') ok(HAN.test(subText), '[zh] 副标题中文：' + JSON.stringify(subText.slice(0, 40)));
    else ok(!HAN.test(subText), '[es] 副标题西语：' + JSON.stringify(subText.slice(0, 60)));
  }

  // ---- 6) 登录/注册页副标题行 ----
  console.log('\n=== 登录 / 注册页 ===');
  for (const [page, lang, expectHan] of [['signin.html', 'es', false], ['signup.html', 'zh', true]]) {
    await p.goto(BASE + '/' + page, { waitUntil: 'networkidle' });
    await p.evaluate((l) => localStorage.setItem('pingory_lang', l), lang);
    await p.reload({ waitUntil: 'networkidle' });
    const alt = await p.locator('#alt').innerText();
    ok(expectHan ? HAN.test(alt) : !HAN.test(alt), '[' + page + '/' + lang + '] 副标题行：' + JSON.stringify(alt.slice(0, 60)));
    const eye = await p.locator('.pw-eye').count();
    ok(eye >= 1, '[' + page + '] 密码可见性按钮 ' + eye + ' 个');
  }

  // ---- 7) SEO 对比页：各语言 URL / canonical / hreflang / 语言切换 ----
  console.log('\n=== SEO 对比页（/compare/uptimerobot + 7 语路径） ===');
  const cmpPath = '/compare/uptimerobot';
  const H1_WORD = { zh: '对比', es: 'comparación', pt: 'comparação', de: 'Vergleich', fr: 'comparaison', ja: '比較', ko: '비교' };
  // 等 i18n 应用完成（页面内 __langSeq 完成标记），避免竞态导致的假失败
  const gotoCmp = async (u) => {
    await p.goto(u, { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => (window.__langSeq || 0) >= 1, null, { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(80);
  };

  // 清掉语言偏好，模拟「首次到访 / 搜索引擎」的确定性状态。
  // 必须先等首页 networkidle：首页自身会在 i18n 加载完成后写回 localStorage，
  // 若在 domcontentloaded 就删，会被它异步写回覆盖（曾导致 [en] 断言出现"语言漂移"假失败）。
  const clearLang = async () => {
    await p.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p.evaluate(() => { try { localStorage.removeItem('pingory_lang'); } catch {} });
  };

  // 规范英文路径（无语言偏好的访客 = 搜索引擎看到的版本）
  await clearLang();
  await gotoCmp(BASE + cmpPath);
  const enDoc = await p.evaluate(() => ({
    lang: document.documentElement.lang,
    canonical: (document.querySelector('link[rel=canonical]') || {}).href,
    hreflangs: document.querySelectorAll('link[rel=alternate][hreflang]').length,
    desc: (document.querySelector('meta[name=description]') || {}).getAttribute('content'),
    h1: document.querySelector('h1').innerText.trim(),
  }));
  ok(enDoc.lang === 'en', '[en] <html lang> = ' + enDoc.lang);
  ok(enDoc.canonical === 'https://pingory.com/compare/uptimerobot', '[en] canonical = ' + enDoc.canonical);
  ok(enDoc.hreflangs === 9, 'hreflang 条数 = ' + enDoc.hreflangs + '（期望 9 = 8 语 + x-default）');
  ok(!HAN.test(enDoc.h1) && /UptimeRobot/.test(enDoc.h1), '[en] H1：' + JSON.stringify(enDoc.h1));
  ok(/UptimeRobot alternative/.test(enDoc.desc), '[en] meta description 含目标关键词（' + enDoc.desc.length + ' 字符）');

  // 已存非英语偏好的访客访问「规范英文路径」→ 应跳到对应语言路径（canonical 路径本身始终英文）
  await p.goto(BASE + cmpPath, { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => { try { localStorage.setItem('pingory_lang', 'fr'); } catch {} });
  await p.goto(BASE + cmpPath, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => location.pathname === '/fr/compare/uptimerobot', null, { timeout: 8000 }).catch(() => {});
  ok(new URL(p.url()).pathname === '/fr/compare/uptimerobot', '偏好 fr 的访客打开规范英文路径 → 自动跳到 ' + new URL(p.url()).pathname);
  await p.evaluate(() => { try { localStorage.removeItem('pingory_lang'); } catch {} });

  // 各语言路径：lang / canonical / 语言正确性 / meta 已本地化
  // 注意：日语共用汉字，不能用「有汉字=中文」判断；用简体专用字集合区分。
  const ZHS = /[这对页价监们让说为个语够关见闭]/;
  for (const lang of ['zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko']) {
    await gotoCmp(BASE + '/' + lang + cmpPath);
    const d = await p.evaluate(() => ({
      lang: document.documentElement.lang,
      canonical: (document.querySelector('link[rel=canonical]') || {}).href,
      h1: document.querySelector('h1').innerText.trim(),
      desc: (document.querySelector('meta[name=description]') || {}).getAttribute('content'),
      text: (() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const o = []; let n; while ((n = w.nextNode())) { const e = n.parentElement; if (!e || e.closest('select,script,style,svg')) continue; const s = (n.nodeValue || '').trim(); if (s) o.push(s); } return o.join('\n'); })(),
    }));
    ok(d.lang === lang, '[' + lang + '] <html lang> = ' + d.lang);
    ok(d.canonical === 'https://pingory.com/' + lang + cmpPath, '[' + lang + '] canonical 指向自身');
    ok(new RegExp(H1_WORD[lang]).test(d.h1), '[' + lang + '] H1 已本地化：' + JSON.stringify(d.h1.slice(0, 52)));
    ok(d.desc !== enDoc.desc && !/^Pingory vs UptimeRobot 2026: an honest/.test(d.desc), '[' + lang + '] meta description 已本地化');
    if (lang === 'zh') ok(ZHS.test(d.text), '[zh] 页面为简体中文');
    else if (lang === 'ja') ok(!ZHS.test(d.text) && /[\u3040-\u30ff]/.test(d.text), '[ja] 页面为日文（含假名、无简体专用字）');
    else if (lang === 'ko') ok(!ZHS.test(d.text) && /[\uac00-\ud7af]/.test(d.text), '[ko] 页面为韩文');
    else ok(!HAN.test(d.text), '[' + lang + '] 全页无中日韩文字 → ' + JSON.stringify(d.text.split('\n')[1].slice(0, 60)));
    if (!['zh', 'ja', 'ko'].includes(lang) && HAN.test(d.text)) {
      console.log('        CJK 泄漏行: ' + JSON.stringify(d.text.split('\n').filter((l) => HAN.test(l)).slice(0, 5)));
    }
  }

  // 别名 / 直链 301 → 规范地址（清偏好，否则会因为语言偏好跳到 /{lang}/... —— 那是另一个正确行为）
  await clearLang();
  await p.goto(BASE + '/vs/uptimerobot', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => location.pathname === '/compare/uptimerobot', null, { timeout: 8000 }).catch(() => {});
  ok(/\/compare\/uptimerobot$/.test(p.url()), '/vs/uptimerobot 301 → ' + p.url().replace(BASE, ''));
  await p.goto(BASE + '/compare-uptimerobot.html', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => location.pathname === '/compare/uptimerobot', null, { timeout: 8000 }).catch(() => {});
  ok(/\/compare\/uptimerobot$/.test(p.url()), '/compare-uptimerobot.html 301 → ' + p.url().replace(BASE, ''));

  // 页内语言切换 = 整页 URL 跳转（URL 与内容语言保持一致）
  await gotoCmp(BASE + cmpPath);
  await p.selectOption('#langSel', 'de');
  await p.waitForURL('**/de/compare/uptimerobot', { timeout: 8000 });
  await p.waitForFunction(() => (window.__langSeq || 0) >= 1, null, { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(120);
  const afterSwitch = await p.evaluate(() => ({ lang: document.documentElement.lang, h1: document.querySelector('h1').innerText }));
  ok(afterSwitch.lang === 'de' && /Vergleich/.test(afterSwitch.h1), '下拉切到 de → URL/内容同步为德语：' + p.url().replace(BASE, ''));
  await p.selectOption('#langSel', 'en');
  await p.waitForURL('**/compare/uptimerobot', { timeout: 8000 });
  await p.waitForFunction(() => (window.__langSeq || 0) >= 1, null, { timeout: 8000 }).catch(() => {});
  const enBack = await p.evaluate(() => document.querySelector('h1').innerText);
  ok(/\/compare\/uptimerobot$/.test(p.url()) && /Honest Comparison/.test(enBack), '切回 en → 回到规范英文路径且内容为英文');

  // 首页入口 + 页脚内链
  await p.goto(BASE + '/', { waitUntil: 'networkidle' });
  const entry = await p.locator('a[href="/compare/uptimerobot"]').count();
  ok(entry >= 2, '首页含对比页内链 ' + entry + ' 处（首页入口 + 页脚）');

  // ---- 7b) 静态可抓性：不执行 JS 的原始 HTML 就该是目标语言（SEO 核心，防「服务端本地化被移除」回归）----
  console.log('\n=== 对比页「静态可抓」原始 HTML（无 JS） ===');
  {
    const raw = async (u) => (await p.request.get(u)).text();
    const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const pick = (s, re) => { const m = s.match(re); return m ? m[1] : ''; };
    const base = await raw(BASE + cmpPath);
    const baseTitle = strip(pick(base, /<title[^>]*>([\s\S]*?)<\/title>/));
    const baseH1 = strip(pick(base, /<h1[^>]*>([\s\S]*?)<\/h1>/));
    const baseTags = (base.match(/<\/?[a-zA-Z][a-zA-Z0-9]*/g) || []).length;
    const baseAttrs = (base.match(/data-i18n="/g) || []).length;
    for (const lang of ['zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko']) {
      const html = await raw(BASE + '/' + lang + cmpPath);
      const title = strip(pick(html, /<title[^>]*>([\s\S]*?)<\/title>/));
      const h1 = strip(pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/));
      const desc = pick(html, /<meta name="description" content="([^"]*)"/);
      const tags = (html.match(/<\/?[a-zA-Z][a-zA-Z0-9]*/g) || []).length;
      const attrs = (html.match(/data-i18n="/g) || []).length;
      const ph = (html.match(/__CMP_|CMP_I18N_PRELOAD/g) || []).length;
      const localized = title !== baseTitle && h1 !== baseH1 && desc !== pick(base, /<meta name="description" content="([^"]*)"/);
      ok(localized, '[' + lang + '] 原始 HTML 标题/H1/描述已本地化（无需 JS）：' + h1.slice(0, 40));
      ok(tags === baseTags && attrs === baseAttrs && ph === 0,
        '[' + lang + '] 原始 HTML 结构不变且无占位残留（tags ' + tags + '/' + baseTags + '，data-i18n ' + attrs + '/' + baseAttrs + '）');
    }
  }

  ok(errs.length === 0, '控制台错误 ' + errs.length + (errs.length ? ' → ' + errs.slice(0, 3).join(' | ') : ''));
  // 清理：删除临时监控 + 临时账号（本脚本自建自销，避免生产库残留 i18n.check.* 垃圾账号）
  {
    const { Client: C2 } = require('pg');
    const c2 = new C2({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await c2.connect();
    if (TMP_MON) {
      await c2.query('DELETE FROM monitor_events WHERE monitor_id=$1', [TMP_MON]).catch(() => {});
      await c2.query('DELETE FROM monitors WHERE id=$1', [TMP_MON]).catch(() => {});
    }
    const del = await c2.query('DELETE FROM users WHERE email=$1 RETURNING id', [EMAIL]).catch(() => ({ rowCount: 0 }));
    await c2.end();
    console.log('（临时监控 + 临时账号已删除，账号 ' + del.rowCount + ' 个）');
  }
  await browser.close();
  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); console.log('TEMP_EMAIL=' + EMAIL + '（请手动清理：DELETE FROM users WHERE email=$1）'); process.exit(2); });
