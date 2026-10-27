#!/usr/bin/env node
/**
 * D49 回归：托管侧检查间隔钳制（纯 Node，无外部依赖，无网络）。
 *
 * 背景：Worker cron 是 "* * * * *"（1 分钟粒度），托管环境的 Pro「30 秒」无法兑现。
 * 决策：托管侧把 Pro 钳到 60 秒（wrangler vars 的 PLAN_MIN_INTERVAL_OVERRIDE），
 *      自托管保持 30 秒真实；两者都必须通过 /api/plan-features 的 intervalClamped
 *      对用户明示，不能静默钳制。
 *
 * 本文件守四件事：
 *   1. 基础表本身没被改坏（产品真值 free=300 / starter=60 / pro=30）
 *   2. override 生效且只抬不降（max 语义），未覆盖的档位不受影响
 *   3. override 写坏（字符串 / 负数 / 非 JSON）绝不抛错，退回基础值
 *   4. 配置落点正确：wrangler.jsonc 有该变量且值为 {"pro":60}；server.js 绝不出现该变量名
 *      （出现即意味着有人把钳制误加进自托管，会直接抹掉「30 秒」这个卖点）
 *
 * 用法：node tools/test-interval-clamp.mjs   （失败以非零码退出）
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

const { planMinInterval, PLAN_MIN_INTERVAL } = await import('../src/plans.js');

console.log('=== D49 interval clamp ===');

// ① 无 override：托管以外的真实值，尤其 Pro 必须是 30（自托管卖点）
check('无 override 时 pro = 30（自托管真实值）', () => {
  assert.equal(planMinInterval('pro'), 30);
  assert.equal(planMinInterval('pro', undefined), 30);
  assert.equal(planMinInterval('pro', null), 30);
  assert.equal(planMinInterval('pro', {}), 30);
});

check('基础表未被修改：free=300 / starter=60 / pro=30', () => {
  assert.deepEqual(PLAN_MIN_INTERVAL, { free: 300, starter: 60, pro: 30 });
  assert.equal(planMinInterval('free'), 300);
  assert.equal(planMinInterval('starter'), 60);
});

// ② {pro:60} 生效：只抬高 Pro，其余档位不动
check('{pro:60} 时 pro = 60，starter 仍 60，free 仍 300', () => {
  const ov = { pro: 60 };
  assert.equal(planMinInterval('pro', ov), 60);
  assert.equal(planMinInterval('starter', ov), 60);
  assert.equal(planMinInterval('free', ov), 300);
});

check('override 只抬不降：{pro:15} 不把 Pro 降到 15', () => {
  assert.equal(planMinInterval('pro', { pro: 15 }), 30);
});

check('未知档位退回 free 下限并接受 free 的 override', () => {
  assert.equal(planMinInterval('enterprise'), 300);
  assert.equal(planMinInterval('enterprise', { free: 600 }), 600);
});

// ③ 非法 override 绝不抛错，且必须退回基础值
check('非法 override（字符串/负数/NaN/Infinity/数组/非 JSON 文本）不抛错且退回基础值', () => {
  const bad = [
    '{"pro":60}',   // 整个映射传成字符串（未 parse）
    '{not json}',   // 非 JSON 文本
    { pro: '60' },  // 值是字符串
    { pro: -1 },    // 负数
    { pro: 0 },     // 0
    { pro: NaN },
    { pro: Infinity },
    { pro: null },
    { pro: [] },
    [],
    42,
    true,
  ];
  for (const ov of bad) {
    assert.equal(planMinInterval('pro', ov), 30, 'override=' + JSON.stringify(ov));
    assert.equal(planMinInterval('free', ov), 300, 'override=' + JSON.stringify(ov));
  }
});

check('函数是纯函数：同一输入多次调用结果一致，不修改入参', () => {
  const ov = { pro: 60 };
  const snapshot = JSON.stringify(ov);
  assert.equal(planMinInterval('pro', ov), planMinInterval('pro', ov));
  assert.equal(JSON.stringify(ov), snapshot);
  assert.deepEqual(PLAN_MIN_INTERVAL, { free: 300, starter: 60, pro: 30 });
});

// ④ 托管配置落点
check('wrangler.jsonc 声明 PLAN_MIN_INTERVAL_OVERRIDE 且值为 {"pro":60}', () => {
  const w = read('wrangler.jsonc');
  assert.ok(w.includes('PLAN_MIN_INTERVAL_OVERRIDE'), 'wrangler.jsonc 缺少 PLAN_MIN_INTERVAL_OVERRIDE');
  // vars 里的值是一个 JSON 字符串字面量：  "PLAN_MIN_INTERVAL_OVERRIDE": "{\"pro\":60}"
  const m = w.match(/PLAN_MIN_INTERVAL_OVERRIDE"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(m, 'wrangler.jsonc 中该变量不是字符串字面量');
  const raw = JSON.parse('"' + m[1] + '"');   // 反转义成 {\"pro\":60} 的实际字符串
  assert.deepEqual(JSON.parse(raw), { pro: 60 });
  assert.equal(planMinInterval('pro', JSON.parse(raw)), 60, 'wrangler 配置未把 Pro 钳到 60');
  // 告知文案里的数字写死了，必须与配置同步（8 语共用同一句语义，抽查 en 即可）
  const en = JSON.parse(read('public/i18n/en.json'));
  assert.ok(
    String(en['form.intervalHostedNote'] || '').includes('60 seconds'),
    'form.intervalHostedNote 的秒数与 PLAN_MIN_INTERVAL_OVERRIDE 不一致（改了配置要同步 8 语文案）'
  );
});

// ⑤ 自托管不得被钳制
check('server.js 不出现托管覆盖变量名（自托管必须保留 30 秒）', () => {
  const s = read('server.js');
  assert.equal(
    s.includes('PLAN_MIN_INTERVAL_OVERRIDE'), false,
    'server.js 出现了托管覆盖变量名：钳制会跟随自托管部署，Pro 的 30 秒将永久消失'
  );
});

// ⑥ 接线完整性：钳制逻辑再对，没接到入口上等于零（D49 审阅抓到 v1 端点漏接）
check('api.js 四个写入口 + plan-features 都走 effMinInterval', () => {
  const a = read('src/cf-worker/api.js');
  const uses = (a.match(/effMinInterval\(c,\s*plan\)/g) || []).length;
  assert.ok(uses >= 4, `effMinInterval 调用点只有 ${uses} 处（应 ≥4：创建/导入/PATCH/plan-features）`);
  assert.ok(a.includes('E.PLAN_MIN_INTERVAL_HOSTED'), '未使用托管专用错误码：顶档 Pro 会被劝「升级更快」');
  const i = a.indexOf("app.post('/api/v1/monitors'");
  assert.ok(i > -1, '找不到 POST /api/v1/monitors');
  const v1 = a.slice(i, a.indexOf('app.get(', i) > i ? a.indexOf('app.get(', i) : undefined);
  assert.ok(/effMinInterval\(c,\s*plan\)/.test(v1), 'POST /api/v1/monitors 未套间隔下限：托管 Pro 可经 API 绕过 60 秒钳制');
});

console.log('\n' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
