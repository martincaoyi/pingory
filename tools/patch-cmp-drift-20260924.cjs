// 一次性补丁（2026-09-24）：修 uptimerobot 模板/en 字典的 3 处既有漂移（P2 验证发现）
// ① en['cmp.iv.p'] 补 <strong>（与模板静态一致，否则 en 用户 JS 渲染后加粗消失）
// ② en['cmp.uw.1'] 同上
// ③ uptimerobot 模板 og:description 静态文案 → 对齐字典 en['cmp.meta.desc']（单一来源，非 en 页本就用该键）
'use strict';
const fs = require('fs');

// ①② en 字典
const p = 'public/i18n/en.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
const ivOld = "Free plans are identical at 5-minute checks. Pingory runs 60-second checks at $4 and 30-second checks at $6; UptimeRobot runs 60-second checks from $9–$10, 30-second from $35, and 15-second from $65–$77. On geography, UptimeRobot still leads for a hosted service — four selectable regions on paid plans (North America only on Free), versus Pingory's single managed region; Pingory's probe workers can run in any region only when self-hosted (Starter+).";
const ivNew = "Free plans are identical at <strong>5-minute checks</strong>. Pingory runs <strong>60-second checks at $4</strong> and <strong>30-second checks at $6</strong>; UptimeRobot runs 60-second checks from <strong>$9–$10</strong>, 30-second from <strong>$35</strong>, and 15-second from <strong>$65–$77</strong>. On geography, UptimeRobot still leads for a hosted service — <strong>four selectable regions on paid plans</strong> (North America only on Free), versus Pingory's single managed region; Pingory's probe workers can run in any region only when self-hosted (Starter+).";
const uwOld = 'Scale and trust. UptimeRobot has been running since 2010 with 3M+ users monitoring millions of endpoints. Its track record and community are hard to match.';
const uwNew = '<strong>Scale and trust.</strong> UptimeRobot has been running since 2010 with <strong>3M+ users</strong> monitoring millions of endpoints. Its track record and community are hard to match.';
if (d['cmp.iv.p'] !== ivOld) { console.error('cmp.iv.p 现值与预期不符，中止'); process.exit(1); }
if (d['cmp.uw.1'] !== uwOld) { console.error('cmp.uw.1 现值与预期不符，中止'); process.exit(1); }
d['cmp.iv.p'] = ivNew;
d['cmp.uw.1'] = uwNew;
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');

// ③ uptimerobot 模板 og:desc
const tp = 'public/compare-uptimerobot.html';
let html = fs.readFileSync(tp, 'utf8');
const ogOld = '<meta property="og:description" content="Pingory vs UptimeRobot 2026: pricing, monitor limits, alerts and status pages compared — including where UptimeRobot still wins." data-i18n-content="cmp.meta.desc" />';
const ogNew = '<meta property="og:description" content="Pingory vs UptimeRobot 2026: an honest UptimeRobot alternative comparison — pricing, monitor limits, alerts, status pages, and where UptimeRobot still wins." data-i18n-content="cmp.meta.desc" />';
if (!html.includes(ogOld)) { console.error('og:description 现值与预期不符，中止'); process.exit(1); }
html = html.replace(ogOld, ogNew);
fs.writeFileSync(tp, html);

console.log('PATCH OK: en.json cmp.iv.p/cmp.uw.1 加粗对齐 + uptimerobot og:desc 对齐字典');
