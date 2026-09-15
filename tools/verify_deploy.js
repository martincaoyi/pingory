#!/usr/bin/env node
/**
 * verify_deploy.js — Pingory 部署后回归（脚本化「上线后回归清单」）
 *
 * 检查项：
 *   1. /health → {"ok":true}
 *   2. 8 语言 i18n 键 parity（en/zh/ja/es/fr/de/ko/pt 任一缺失键即 FAIL）
 *   3. Neon keepAlive / 支付 webhook 等需凭证项 → 仅提示人工确认（脚本不持密钥）
 *
 * 用法：
 *   node tools/verify_deploy.js                # 默认 http://localhost:3000
 *   node tools/verify_deploy.js https://pingory.com
 */
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const BASE = process.argv[2] || 'http://localhost:3000';
const LANGS = ['en', 'zh', 'ja', 'es', 'fr', 'de', 'ko', 'pt'];

const checks = [];
const fail = (n, d) => checks.push({ l: 'FAIL', n, d });
const warn = (n, d) => checks.push({ l: 'WARN', n, d });
const ok = (n, d) => checks.push({ l: 'OK', n, d });

(async () => {
  // 1) /health
  try {
    const r = await fetch(`${BASE}/health`);
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok === true) ok('health', `/health → {"ok":true} (${r.status})`);
    else fail('health', `/health 返回异常：${r.status} ${JSON.stringify(j)}`);
  } catch (e) {
    fail('health', `/health 不可达（${BASE}）：${e.message}。若部署在 Fly，请确认 BASE 指向线上地址。`);
  }

  // 2) 8 语言键 parity
  const i18nDir = path.join(ROOT, 'public/i18n');
  if (fs.existsSync(i18nDir)) {
    const keysByLang = {};
    let missing = [];
    for (const lg of LANGS) {
      const fp = path.join(i18nDir, `${lg}.json`);
      if (!fs.existsSync(fp)) { missing.push(lg); continue; }
      try { keysByLang[lg] = new Set(Object.keys(JSON.parse(fs.readFileSync(fp, 'utf8')))); }
      catch { warn('i18n', `${lg}.json 解析失败`); }
    }
    if (missing.length) fail('i18n', `缺少语言文件：${missing.join(', ')}（应为 8 语）`);
    else {
      const base = keysByLang['en'];
      const problems = [];
      for (const lg of LANGS) {
        if (lg === 'en') continue;
        for (const k of base) if (!keysByLang[lg].has(k)) problems.push(`${lg} 缺 ${k}`);
        for (const k of keysByLang[lg]) if (!base.has(k)) problems.push(`${lg} 多 ${k}`);
      }
      if (problems.length) fail('i18n', `键不一致（${problems.length} 处），示例：${problems.slice(0, 5).join('; ')}`);
      else ok('i18n', `8 语言键 parity 一致（基准 en ${base.size} 键）`);
    }
  } else {
    warn('i18n', '未找到 public/i18n，跳过键 parity 检查');
  }

  // 3) 需凭证项（人工）
  warn('session/keepAlive/Paddle/邮件', '以下需登录态或密钥，脚本不持凭证，请人工回归：session 跨双机、Neon 首请求无卡顿、Paddle Checkout 测试卡、告警邮件实际送达（TECHNICAL 第4节）');

  // 汇总
  const bad = checks.filter(c => c.l === 'FAIL');
  console.log('\n=== Pingory verify_deploy（部署回归）===');
  for (const c of checks) console.log(`[${c.l}] ${c.n}: ${c.d || ''}`);
  if (bad.length) { console.log(`\n✗ ${bad.length} 项 FAIL，部署回归未通过。`); process.exit(1); }
  console.log('\n✓ 可机检回归通过（凭证类项请人工确认）。');
})();
