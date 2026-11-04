#!/usr/bin/env node
/**
 * waitlist 清单钩子回归（纯 Node，无外部依赖，无网络，不发信）。
 *
 * 背景：官网首页 "Notify me" 订阅框走双重确认（double opt-in），确认邮件原先
 *      只有确认链接。为兑现「留邮箱 → 送 up ≠ healthy 自查清单」这个转化钩子，
 *      清单改为随确认邮件正文一起到达（纯文本、无 PDF、无附件、不单独发送）。
 *
 * 本文件守八件事：
 *   1. 清单正文结构完整（10 条 + 收尾句），且不使用被审阅否决的过度断言
 *   2. 确认链接置顶、是唯一主 CTA（链接沉到清单后面会拉低确认率）
 *   3. 同意对象单一：邮件里不含推广链接，避免「点确认是为了拿清单」的误解
 *   4. 清单与确认解耦：说清是索取的内容、无附件、不单独发送
 *   5. 上线通知承诺与首页一致，且不写具体日期 / 自动发送暗示
 *   6. text / html 两版同步，且都不带红线词
 *   7. 接线完整：sendWaitlistConfirmEmail 仍走 buildWaitlistConfirmEmail + sendMail
 *   8. 文档真源同步：77 号 md 的清单代码块与 email.js 常量逐字一致；76 号 md 无占位符/编造/空头承诺
 *
 * 内容真源：方案资料/推广方法论/出海获客/77-up≠healthy自查清单.md（改正文须两边同步）
 * 文档层断言需设 PINGORY_DOCS_DIR 指向「方案资料/推广方法论/出海获客」；未设则跳过，
 * 保证仓库在任意机器上都能独立跑（开源仓库不硬编码本机盘符）。
 *
 * 用法：node tools/test-waitlist-confirm.mjs   （失败以非零码退出）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass++;
    console.log('PASS  ' + label);
  } catch (e) {
    failures.push(label + '  →  ' + e.message);
    console.log('FAIL  ' + label + '  →  ' + e.message);
  }
}

const { WAITLIST_CHECKLIST, buildWaitlistConfirmEmail } =
  await import('../src/email.js');

const LINK = 'https://pingory.com/?wl=test-token-123';
const mail = buildWaitlistConfirmEmail(LINK);

// only 作范围限定（"only signs you up"）是「同意对象单一」的合规表述，
// 不是营销最高级；只拦真正的最高级与 "the only" 这类独占断言。
const SUPERLATIVE = /\b(best|unique|cheapest|#1)\b|\bthe only\b|\bonly (tool|product|solution|monitor)\b/i;
const REDLINE = /AI Visibility|multi-region|global probes|30 seconds/i;

console.log('=== waitlist checklist hook ===');

// ① 清单正文结构
check('清单是 10 条编号项，且带 up ≠ healthy 标题', () => {
  assert.ok(WAITLIST_CHECKLIST.includes('Ten checks for when "up" doesn\'t mean "healthy"'));
  for (let i = 1; i <= 10; i++) {
    assert.ok(WAITLIST_CHECKLIST.includes(`\n${i}. `), `缺第 ${i} 条`);
  }
  assert.equal((WAITLIST_CHECKLIST.match(/^\d+\. /gm) || []).length, 10);
});

check('收尾用「单靠状态码判断不出」而非被否决的 None 过度断言', () => {
  assert.ok(WAITLIST_CHECKLIST.includes("A status code alone won't tell you any of this."));
  assert.ok(!WAITLIST_CHECKLIST.includes('None of this shows up in a status code'));
});

check('清单每条都是读者可自主动手验证的动作（不出现产品名/套餐档位）', () => {
  assert.ok(!/Pingory|Pro plan|free plan|Starter/i.test(WAITLIST_CHECKLIST));
  assert.ok(!REDLINE.test(WAITLIST_CHECKLIST));
});

// ② 确认链接置顶
check('text 第一行就是确认链接（主 CTA 不被清单淹没）', () => {
  const first = mail.text.split('\n')[0];
  assert.ok(first.startsWith('Confirm your email'), '首行不是确认入口：' + first);
  assert.ok(first.includes(LINK), '首行不含确认链接');
  assert.ok(mail.text.indexOf(LINK) < mail.text.indexOf(WAITLIST_CHECKLIST.slice(0, 30)),
    '确认链接没有排在清单之前');
});

check('subject 保持原值（不破坏现有邮件线程/过滤规则）', () => {
  assert.equal(mail.subject, 'Confirm your Pingory launch subscription');
});

// ③ 同意对象单一：双重确认邮件里不放推广链接
check('text 与 html 都不含推广链接（checker / GitHub repo）', () => {
  for (const body of [mail.text, mail.html]) {
    assert.ok(!body.includes('llms-txt-checker'), '确认邮件里出现了检查器推广链接');
    assert.ok(!body.includes('github.com/martincaoyi'), '确认邮件里出现了仓库推广链接');
  }
});

check('html 里确认按钮置顶于清单，且按钮仍是 accent 实心底 + 白字', () => {
  const btn = mail.html.indexOf('Confirm my email');
  const list = mail.html.indexOf('Ten checks');
  assert.ok(btn > -1 && list > -1 && btn < list, '确认按钮没有排在清单之前');
  assert.ok(mail.html.includes('background:#1faa6b;color:#fff'), '按钮不符合 UI 铁律');
  assert.equal((mail.html.match(/<a /g) || []).length, 1, '确认邮件里出现了第二个 CTA 链接');
});

// ④ 清单与确认解耦
check('明确「你索取的内容」+ 纯文本无附件不单独发送 + 无第一人称承诺口吻', () => {
  for (const body of [mail.text, mail.html]) {
    assert.ok(body.includes('The checklist you asked for'), '缺少解耦说明');
    assert.ok(/plain text, no PDF, no attachment, nothing sent separately/.test(body),
      '缺少「纯文本/无附件/不单独发送」声明');
    assert.ok(!body.includes('I promised'), '出现了第一人称承诺口吻');
  }
});

// ⑤ 上线通知承诺与首页一致，不越界
check('上线通知承诺与首页文案一致，且无具体日期/自动发送暗示（text+html 两版）', () => {
  for (const body of [mail.text, mail.html]) {
    assert.ok(body.includes('one email when Pingory ships'), '缺少与首页一致的上线通知承诺');
    assert.ok(/unsubscribe anytime/i.test(body), '缺少随时退订');
    assert.ok(!/automatically|scheduled|on November|launch day|we'll remind you/i.test(body),
      '出现自动发送 / 具体日期 / 定时提醒暗示（announce 是手动发送、无自动调度）');
  }
  assert.ok(mail.text.includes('nothing else will be sent'), '缺少「非本人可忽略」免责句');
});

// ⑥ text / html 同步 + 红线词
check('html 版完整包含清单全文（与 text 同源派生，无内容丢失）', () => {
  const htmlList = WAITLIST_CHECKLIST
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  assert.ok(mail.html.includes(htmlList), 'html 版清单与常量派生结果不一致');
  assert.ok(mail.text.includes(WAITLIST_CHECKLIST), 'text 版缺清单全文');
  assert.ok(!/[&<>]/.test(WAITLIST_CHECKLIST), '清单出现了需转义字符，请复核 html 转义顺序');
});

check('text/html 都不出现红线词（最高级 / AI Visibility / 多区域 / 30 秒托管）', () => {
  for (const body of [mail.text, mail.html]) {
    assert.ok(!SUPERLATIVE.test(body), '出现绝对化/独占表述');
    assert.ok(!REDLINE.test(body), '出现红线词');
  }
});

check('同进程内输出确定；html 的 logo 随 APP_URL 变（非严格纯函数，已如实标注）', () => {
  assert.deepEqual(buildWaitlistConfirmEmail(LINK), mail);
  const prev = process.env.APP_URL;
  try {
    process.env.APP_URL = 'https://example.test';
    const changed = buildWaitlistConfirmEmail(LINK);
    assert.equal(changed.text, mail.text, 'text 不应依赖 env');
    assert.ok(changed.html.includes('https://example.test/logo-email.png'), 'html logo 未跟随 APP_URL');
    assert.notEqual(changed.html, mail.html);
  } finally {
    if (prev === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prev;
  }
});

// ⑦ 接线完整性：写对了没接上等于零（D49 教训）
check('sendWaitlistConfirmEmail 调用 buildWaitlistConfirmEmail 且仍走 sendMail', () => {
  const s = read('src/email.js');
  assert.ok(/export async function sendWaitlistConfirmEmail\(email, token\)/.test(s));
  const body = s.slice(s.indexOf('export async function sendWaitlistConfirmEmail'));
  assert.ok(body.includes('buildWaitlistConfirmEmail(link)'), '没有调用纯函数拼装');
  assert.ok(body.includes('return sendMail(email, subject, text, html)'), '发信链路断了');
  assert.ok(body.includes('encodeURIComponent(token)'), '确认 token 未编码');
});

check('首页订阅框仍指向 /api/waitlist（钩子落地入口没被改坏）', () => {
  const h = read('public/index.html');
  assert.ok(h.includes("fetch('/api/waitlist'"), '首页订阅框未接 /api/waitlist');
  assert.ok(h.includes('One email when Pingory ships. Unsubscribe anytime.'),
    '首页承诺文案与确认邮件不一致');
});

check('确认 token 的 7 天有效期与后端一致（不是文案自造数字）', () => {
  const a = read('src/cf-worker/api.js');
  assert.ok(/created_at > now\(\) - interval '7 days'/.test(a), '后端确认窗口不是 7 天');
  assert.ok(mail.text.includes('expires in 7 days') && mail.html.includes('expires in 7 days'));
});

// ⑧ 文档真源同步 + 文档层红线（避免「内容 7 条必改」无回归保护）
const DOCS = process.env.PINGORY_DOCS_DIR;
if (!DOCS) {
  console.log('SKIP  文档层回归（设 PINGORY_DOCS_DIR 指向「方案资料/推广方法论/出海获客」后启用）');
} else {
  const doc76 = fs.readFileSync(path.join(DOCS, '76-引流到waitlist话术.md'), 'utf8');
  const doc77 = fs.readFileSync(path.join(DOCS, '77-up≠healthy自查清单.md'), 'utf8');

  check('77 号 md 的清单代码块与 email.js 常量逐字一致（防真源漂移）', () => {
    const m = doc77.match(/```\n(Ten checks[\s\S]*?)\n```/);
    assert.ok(m, '77 文档里找不到清单代码块');
    assert.equal(m[1].trim(), WAITLIST_CHECKLIST.trim());
  });

  check('76 号无 {{WAITLIST_URL}} 占位符，落地链接统一为 https://pingory.com', () => {
    assert.ok(!doc76.includes('{{WAITLIST_URL}}'), '仍残留占位符');
    assert.ok(doc76.includes('https://pingory.com'), '缺落地链接');
  });

  // 只检查「对外话术块」（> 引用行），排除顶部 > ⚠️ 元说明、> 用途 与 ❌ 禁令行：
  // 那些行本身会引用被禁词做反面示例，全文搜会自指误伤（同 only 误伤的教训）。
  const talk = doc76.split('\n')
    .filter(l => l.startsWith('> ') && !l.startsWith('> ⚠️') && !l.startsWith('> 用途'))
    .join('\n');

  check('对外话术块无第一人称亲历、无编造统计、无 PDF/附件正向承诺', () => {
    assert.ok(talk.length > 100, '没提取到对外话术块');
    assert.ok(!/我某次|半夜爬起来|转化高 10 倍|我爬起来|我们 side project/.test(talk),
      '对外话术出现第一人称亲历或编造统计');
    assert.ok(!/导出 PDF|网页版清单|另发一封邮件给清单/.test(talk));
  });

  check('76 号保留条件式对照、AI Readability 仅 Pro、JS 渲染降调句', () => {
    assert.ok(doc76.includes('一个常见场景：告警触发了'), '条件式对照被删');
    assert.ok(doc76.includes('AI Readability 检查是 Pro 档提供的功能'), '档位标注被删或误绑通用技术讨论');
    assert.ok(doc76.includes('不少依赖 JavaScript 渲染的站点'), '降调句被误删');
  });

  check('对外话术块无具体 launch 日期 / 倒计时 / 自动提醒承诺', () => {
    assert.ok(!/launch 前 2[–-]4 周|届时自动提醒|准时推送|launch 当天会发提醒/.test(talk));
  });
}

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
