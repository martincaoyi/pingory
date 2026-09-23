#!/usr/bin/env node
/**
 * dev_gate.js — Pingory SOP 机检门禁（pre-commit / commit-msg 调用）
 *
 * 对应 SOP 实施细则条款：
 *   T4       TDZ 铁律（inline JS 工具函数声明前置）
 *   §3.3.2   数据库设计铁律（禁 DROP TABLE/COLUMN；ALTER TABLE 须 IF NOT EXISTS）
 *   §3.3.3   接口契约（路由变更须同步 docs/API-REFERENCE.md）
 *   §4.1/S5  git commit 带决策/PRD 引用
 *   §11.5    护城河铁律（新功能须过三问 + Q2 差异论证）
 *   业务铁律  付费调用前须校验登录态（Paddle.Checkout.open 须被 ensureAuth/openPaddleCheckout 包裹）
 *
 * 用法：
 *   node tools/dev_gate.js            # pre-commit：检查暂存文件
 *   node tools/dev_gate.js --msg "..." # commit-msg：检查提交说明
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const checks = [];
const fail = (n, d) => checks.push({ l: 'FAIL', n, d });
const warn = (n, d) => checks.push({ l: 'WARN', n, d });
const ok = (n, d) => checks.push({ l: 'OK', n, d });

// 变更文件集 = 已暂存 + 未暂存 + 未跟踪。
// ⚠️ 历史缺陷①（2026-09-13）：此前只用 `git diff --cached`（仅暂存），开发中未 git add 时所有 diff 类检查会静默"跳过"，
//    导致门禁形同虚设（index.html 已改动却报"无 public HTML 变更，跳过"）。
// ⚠️ 历史缺陷②（2026-09-23 固化）：三个 git 调用失败时全被 `catch {}` 静默吞掉 → 返回空集 → 所有 diff 类检查"跳过"
//    → 照样打印「✓ 门禁通过」（沙箱实测 spawnSync cmd.exe→EBUSY）。现改为：跟踪 git 是否可用，
//    全不可用时【响亮失败】，绝不静默通过（见下方 GIT-不可用 检查）。
// git()：吸收 Windows/沙箱偶发 EBUSY（spawnSync cmd.exe 资源忙）——失败重试一次；
//        仍保留"全部失败才返回 null"的语义，不掩盖真正的 git 不可用。
function git(cmd) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return execSync(cmd, { encoding: 'utf8' }); } catch { /* retry once */ }
  }
  return null;
}

function changedFiles() {
  const set = new Set();
  let gitOk = false;
  const head = git('git diff HEAD --name-only');
  if (head !== null) {
    gitOk = true;
    head.split('\n').map(s => s.trim()).filter(Boolean).forEach(f => set.add(f));
  } else {
    const cached = git('git diff --cached --name-only');
    if (cached !== null) {
      gitOk = true;
      cached.split('\n').map(s => s.trim()).filter(Boolean).forEach(f => set.add(f));
    }
  }
  const st = git('git status --porcelain');
  if (st !== null) {
    gitOk = true;
    st.split('\n').filter(Boolean).forEach(l => {
      let p = l.slice(3).trim();
      if (p.includes(' -> ')) p = p.split(' -> ').pop().trim();
      p = p.replace(/^"|"$/g, '');
      if (p) set.add(p);
    });
  }
  return { files: [...set], gitOk };
}
function read(f) {
  try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; }
}
function exists(f) { try { return fs.existsSync(path.join(ROOT, f)); } catch { return false; } }

const isMsg = process.argv.includes('--msg');
const msgArg = isMsg ? process.argv[process.argv.indexOf('--msg') + 1] || '' : '';
// 首次提交（无 HEAD）时放宽：FAIL 降级为 WARN，避免历史债阻断建库，债项留待 Martin 决策
const isInitial = (() => { try { execSync('git rev-parse --verify HEAD', { stdio: 'ignore' }); return false; } catch { return true; } })();

if (isMsg) {
  // ---- commit-msg 模式：提交说明须带可追溯引用 ----
  const m = msgArg || '';
  const ref = /(D\d{2}|P0-\d|P1-\d|P2-\d|PRD-|ADR)/i;
  const escape = /^(init|chore|docs|ci|test|deps|merge|revert|wip|release|snapshot)\b/i;
  if (ref.test(m)) {
    ok('commit-ref', `提交说明含决策/PRD 引用：${m.split('\n')[0]}`);
  } else if (escape.test(m)) {
    ok('commit-ref', `非功能提交（${m.split('\n')[0].split(' ')[0]}），免引用`);
  } else {
    fail('commit-ref', `提交说明缺少决策/PRD 引用（Dxx/P0-x/PRD-*）。SOP §4.1/S5 要求每次提交可追溯到决策。功能提交请补引用，纯文档/杂务可用 init/chore/docs 等前缀。`);
  }
} else {
  // ---- pre-commit 模式：检查变更文件（暂存 + 未暂存 + 未跟踪）----
  const { files, gitOk } = changedFiles();
  const codeFiles = files.filter(f => /\.(js|sql)$/.test(f) && !/node_modules/.test(f));
  const htmlFiles = files.filter(f => /\.html$/.test(f) && /public[\\/]/.test(f));
  const routeFiles = files.filter(f => /(^server\.js$|^src[\\/])/.test(f));
  const apiDocChanged = files.includes('docs/API-REFERENCE.md');
  const newSrcFiles = files.filter(f => /(^src[\\/]|^public[\\/])/.test(f) && !exists(f));

  // 1) T4 TDZ：inline <script> 中 I18N/loadI18n/t 声明须早于调用
  let tdzHit = false;
  for (const f of htmlFiles) {
    const c = read(f);
    const blocks = c.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
    for (const b of blocks) {
      const body = b.replace(/<\/?script[^>]*>/g, '');
      // 真正的 TDZ 风险：let/const I18N 在声明行之前被访问（let 有暂时性死区，会抛 ReferenceError）。
      // 函数声明 function t/loadI18n 是 hoisted 的，调用早于定义不报错，故不计入 TDZ。
      const i18nDecl = body.search(/(const|let|var)\s+I18N\b/);
      const i18nAccess = body.search(/I18N\[|I18N\./);
      if (i18nDecl >= 0 && i18nAccess >= 0 && i18nAccess < i18nDecl) {
        fail('T4-TDZ', `${f}: 工具函数调用早于声明（声明@${decl}, 调用@${call}），违反 TDZ 铁律`);
        tdzHit = true;
      }
    }
  }
  if (!tdzHit) ok('T4-TDZ', htmlFiles.length ? 'inline JS 声明前置检查通过' : '无 inline JS 变更，跳过');

  // 2) §3.3.2 数据库铁律（仅检查 server.js / src / .sql；门禁脚本自身含关键词，排除）
  const dbFiles = codeFiles.filter(f => /(^server\.js$|^src[\\/]|\.sql$)/i.test(f));
  for (const f of dbFiles) {
    const c = read(f);
    if (/\bDROP\s+(TABLE|COLUMN)\b/i.test(c)) fail('DB-铁律', `禁止 DROP TABLE/DROP COLUMN（SOP §3.3.2）: ${f}`);
    if (/\bALTER\s+TABLE\b/i.test(c) &&
        !/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i.test(c) &&
        !/\bCREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\b/i.test(c)) {
      warn('DB-幂等', `ALTER TABLE 建议带 IF NOT EXISTS / 新建表用 CREATE TABLE IF NOT EXISTS（SOP §3.3.2）: ${f}`);
    }
  }

  // 3) §3.3.3 接口契约：路由变更须同步 API-REFERENCE.md
  if (routeFiles.length && !apiDocChanged) {
    const c = routeFiles.map(read).join('\n');
    if (/\b(?:app|router)\.(get|post|put|delete|patch)\s*\(/.test(c)) {
      fail('API-契约', 'server.js/src 路由变更但 docs/API-REFERENCE.md 未同步更新（SOP §3.3.3）');
    } else {
      ok('API-契约', '路由文件变更但未检出新路由定义，跳过');
    }
  } else if (apiDocChanged) {
    ok('API-契约', 'API-REFERENCE.md 已同步');
  }

  // 4) §11.5 护城河：新增源码/页面须已通过三问 + Q2 差异论证
  if (newSrcFiles.length) {
    warn('护城河-11.5', `检测到新增源码/页面文件 ${newSrcFiles.join(', ')}；请确认已通过 §11.2 三问 + Q2 竞品差异论证。无差异的新功能须归入 Backlog，禁止抄 UptimeRobot 全功能。`);
  }

  // 5) 业务铁律：Paddle.Checkout.open 必须被登录态守卫包裹
  let payGuardHit = false;
  for (const f of htmlFiles) {
    const c = read(f);
    const blocks = c.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [];
    for (const b of blocks) {
      const body = b.replace(/<\/?script[^>]*>/g, '');
      // 找到所有 Paddle.Checkout.open 调用，检查其周围 300 字符内是否有 ensureAuth/openPaddleCheckout
      const matches = [...body.matchAll(/Paddle\.Checkout\.open\s*\(/g)];
      for (const m of matches) {
        const start = Math.max(0, m.index - 400);
        const snippet = body.slice(start, m.index + 200);
        if (!/ensureAuth\s*\(|openPaddleCheckout\s*\(/.test(snippet)) {
          fail('PAY-登录态', `${f}: Paddle.Checkout.open 附近未出现 ensureAuth/openPaddleCheckout 登录态守卫，未登录用户可能直接触发付费。请在调用前校验 window.__currentUser。`);
          payGuardHit = true;
        }
      }
    }
  }
  if (!payGuardHit) ok('PAY-登录态', htmlFiles.length ? '付费调用登录态守卫检查通过' : '无 public HTML 变更，跳过');

  // 6) S4.5 UI 一致性：public/*.html 不得回退到旧黑主题 / 旧绿 / 旧蓝强调色
  //    防止"只改首页、忘改其他页面"的回退（2026-08-30 教训）。所有页面须统一浅绿调色板（--accent:#1faa6b）。
  const LEGACY_UI = /#0f1115|#1a1d24|#2a2e37|rgba\(15,17,21|#3ddc84|#1677ff/i;
  let uiRegress = false;
  for (const f of htmlFiles) {
    const c = read(f);
    const hit = c.match(LEGACY_UI);
    if (hit) {
      fail('UI-一致性', `${f}: 检出旧主题色 "${hit[0]}"（旧黑主题/旧绿 #3ddc84/旧蓝 #1677ff）。所有 public 页面须统一浅绿调色板（--accent:#1faa6b，--bg:#f5f8f6），禁止只改首页。请同步所有页面后重试。`);
      uiRegress = true;
    }
  }
  if (!uiRegress) ok('UI-一致性', htmlFiles.length ? '所有改动页面均使用统一浅绿调色板，无回退黑主题' : '无 public HTML 变更，跳过');

  // 7) S4.5 UI 顶栏布局防堆叠：index.html 顶部导航登录注册按钮必须水平排列（2026-08-30 教训）
  if (htmlFiles.includes('public/index.html')) {
    const c = read('public/index.html');
    if (c.includes('id="topnavRight"')) {
      const navStyle = c.match(/#topnavRight\s*\{[^}]*\}/);
      if (!navStyle || !/display\s*:\s*flex/.test(navStyle[0])) {
        fail('UI-顶栏布局', 'public/index.html: #topnavRight 未使用 display:flex，登录/注册按钮在窄顶栏中可能纵向堆叠。请设为 display:flex; align-items:center; gap; 并为按钮加 white-space:nowrap。');
      } else {
        ok('UI-顶栏布局', 'public/index.html 顶栏按钮容器已使用 flex，布局防堆叠');
      }
      const actionsStyle = c.match(/\.topnav-actions\s*\{[^}]*\}/);
      if (!actionsStyle || !/flex-wrap\s*:\s*nowrap/.test(actionsStyle[0])) {
        warn('UI-顶栏布局', 'public/index.html: .topnav-actions 建议加 flex-wrap:nowrap 防止顶栏元素折行。');
      }
    }
  }

  // 8) 套餐监控数量单一事实源：PLAN_LIMITS 必须只在 src/plans.js 定义，server.js 须导入使用（2026-08-30 教训）
  const planLimitsDefs = codeFiles.filter(f => f !== 'src/plans.js').filter(f => /\bconst\s+PLAN_LIMITS\s*=/.test(read(f)));
  const serverImportsPlans = /import\s*\{[^}]*\bPLAN_LIMITS\b[^}]*\}\s*from\s*['"]\.\/src\/plans\.js['"]/.test(read('server.js'));
  if (planLimitsDefs.length) {
    fail('PLAN-单一源', `PLAN_LIMITS 只能在 src/plans.js 定义，以下文件重复定义会导致前后端不一致：${planLimitsDefs.join(', ')}`);
  } else if (!serverImportsPlans) {
    warn('PLAN-单一源', 'server.js 未从 ./src/plans.js 导入 PLAN_LIMITS，请确认没有本地副本导致前后端不一致。');
  } else {
    ok('PLAN-单一源', 'PLAN_LIMITS 单一事实源检查通过（仅 src/plans.js 定义，server.js 已导入）');
  }

  // 9) i18n 缺键 + 未翻译扫描（2026-09-13 固化铁律工具化；2026-09-13 加固）
  //    (a) 缺键：public/*.html 的 t('key') 调用 + data-i18n(-ph/-title) 属性引用的键须在全部 8 语存在
  //        防新增 UI 文案时静默 fallback 英文（SOP i18n 铁律：先补 8 语字典键再写引用）
  //    (b) 未翻译：某键在 6 个非英文语言中值全部等于英文 → 视为"新增键但未翻译"回归
  //        （品牌名/协议名/价格字面量等刻意保留英文的键走白名单豁免）
  const i18nLangs = ['en','zh','es','pt','de','fr','ja','ko'];
  const i18nNonEn = i18nLangs.filter(L => L !== 'en');
  const i18nDict = {};
  for (const L of i18nLangs) {
    try { i18nDict[L] = JSON.parse(read(`public/i18n/${L}.json`)); } catch { i18nDict[L] = {}; }
  }
  const i18nJsonChanged = files.some(f => /^public[\\/]i18n[\\/].*\.json$/.test(f));
  if (htmlFiles.length || i18nJsonChanged) {
    let i18nMiss = false;
    for (const f of htmlFiles) {
      const c = read(f);
      const used = new Set();
      // 独立 t('key') / t('key','default') 调用（排除 createElement 等方法尾 t( 及动态拼接，避免误报）
      for (const m of c.matchAll(/(?<![.\w])t\(\s*['"]([^'"]+?)['"]\s*(?:,\s*['"][^'"]*['"])?\s*\)/g)) used.add(m[1]);
      // data-i18n / data-i18n-ph / data-i18n-title / data-i18n-content 属性引用
      // （此前漏检：signin.or、signup.or 因只扫 t() 而逃逸；2026-09-14 补 -content，并放宽为
      //   任意 data-i18n-* 变体，顺带把 data-i18n-tilte 这类拼写错误也纳入检查）
      for (const m of c.matchAll(/data-i18n(?:-[a-z]+)?\s*=\s*["']([^"']+)["']/g)) used.add(m[1]);
      for (const k of used) {
        if (/\$\{/.test(k) || k.includes('+')) continue; // 动态模板键跳过
        const miss = i18nLangs.filter(L => !(k in i18nDict[L]));
        if (miss.length) {
          fail('i18n-缺键', `${f}: 键 "${k}" 在 ${miss.join('/')} 缺失（i18n 铁律：新增 UI 文案须先补 8 语字典键再写 t()/data-i18n 引用）`);
          i18nMiss = true;
        }
      }
    }
    if (!i18nMiss) ok('i18n-缺键', htmlFiles.length ? 'i18n 键 8 语全存在（含 data-i18n 属性），无漏译' : 'i18n JSON 变更：引用键检查通过');

    // (b) 未翻译回归扫描：白名单 = 刻意保留英文的键（品牌/协议/价格）
    const i18nEnAllowed = new Set([
      'channel.discord','channel.pagerduty','channel.slack','channel.teams','channel.telegram','channel.webhook',
      'landing.plan.free.price','landing.plan.starter.price','landing.plan.pro.price',
      'landing.plan.starter.title','landing.plan.pro.title',
      'landing.type.heartbeat.title','landing.type.http.title','type.ping',
    ]);
    const i18nUntranslated = [];
    for (const k of Object.keys(i18nDict.en || {})) {
      if (i18nEnAllowed.has(k)) continue;
      const en = i18nDict.en[k];
      if (typeof en !== 'string' || !en.trim()) continue;
      if (i18nNonEn.every(L => i18nDict[L][k] === en)) i18nUntranslated.push(k);
    }
    if (i18nUntranslated.length) {
      fail('i18n-未翻译', `${i18nUntranslated.length} 个键在 6 个非英文语言中全部等于英文（疑似新增键未翻译）：${i18nUntranslated.join(', ')}。若属品牌/协议/价格等刻意保留英文，请加入 tools/dev_gate.js 的 i18nEnAllowed 白名单。`);
    } else {
      ok('i18n-未翻译', '无“六语全英文”的疑似漏译键');
    }
  }

  // 10) T5 辅助函数遮蔽扫描（2026-09-13 教训固化，P0 级）
  //     形参 / catch 捕获变量与同文件内已声明的函数同名，且函数体内又调用了该名字 → 运行时 TypeError。
  //     实例①：FEATURES.types.map((t) => ... t('type.'+t) ...) 遮蔽全局 t()，类型下拉恒为空 → type='' → 无法添加监控；
  //     实例②：错误码化新增 err() 辅助函数，与既有 34 处 catch (err) 同名 → catch 内 err(E.X) 全部抛 TypeError。
  const shadowFiles = files.filter(f => /\.(js|html)$/.test(f)
    && !/node_modules/.test(f) && !/tools[\\/]dev_gate\.js$/.test(f) && exists(f));
  const shadowHits = [];
  for (const f of shadowFiles) {
    const raw = read(f);
    const bodies = /\.html$/.test(f)
      ? (raw.match(/<script[^>]*>[\s\S]*?<\/script>/g) || []).map(b => b.replace(/<\/?script[^>]*>/g, ''))
      : [raw];
    for (const body of bodies) {
      const declared = new Set();
      for (const m of body.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
      if (!declared.size) continue;
      const braceEnd = (start) => {
        let d = 0;
        for (let i = start; i < body.length; i++) {
          const ch = body[i];
          if (ch === '{' || ch === '(' || ch === '[') d++;
          else if (ch === '}' || ch === ')' || ch === ']') { d--; if (!d) return i; }
        }
        return body.length - 1;
      };
      const scan = (name, from) => {
        if (!name || !declared.has(name)) return;
        const open = body.indexOf('{', from);
        if (open < 0) return;
        const inner = body.slice(open + 1, braceEnd(open));
        if (new RegExp('(^|[^\\w$.])' + name + '\\s*\\(').test(inner)) {
          shadowHits.push(`${f}: "${name}" 被形参/catch 遮蔽后仍在体内调用 ${name}(...)（约第 ${body.slice(0, from).split('\n').length} 行）`);
        }
      };
      for (const m of body.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{/g)) scan(m[1], m.index + m[0].length - 1);
      for (const m of body.matchAll(/[(,]\s*([A-Za-z_$][\w$]*)\s*(?:,[^)]*)?\)\s*=>/g)) scan(m[1], m.index);
      for (const m of body.matchAll(/\bfunction\s+[\w$]*\s*\(([^)]*)\)\s*\{/g)) {
        for (const p of m[1].split(',').map(x => x.trim().split('=')[0].trim())) scan(p, m.index + m[0].length - 1);
      }
    }
  }
  if (shadowHits.length) {
    for (const h of shadowHits) fail('T5-遮蔽', `辅助函数被同名变量遮蔽：${h}。请改形参名（如 map((ty)=>...)）或重命名辅助函数。`);
  } else {
    ok('T5-遮蔽', shadowFiles.length ? '无"形参/catch 遮蔽同文件函数"隐患' : '无 JS/HTML 变更，跳过');
  }

  // 11) i18n 动态重绘覆盖扫描（2026-09-14 教训固化）
  //     背景：applyI18n 只能刷新带 data-i18n 的静态节点；凡用 t() 拼 innerHTML / textContent
  //           的函数都必须在语言切换钩子（window.__afterLang → applyI18n）里被（传递）调用，
  //           否则切换语言后该区块停留在旧语言。
  //     实例：告警渠道区 renderChannels() 未挂进 __afterLang，西语页面里该区块仍是中文；
  //           重置页副标题 renderSub() 同理恒为英文。
  const i18nHookFiles = htmlFiles.filter(f => exists(f) && /\bfunction\s+t\s*\(/.test(read(f)));
  // 一次性初始化 / 图标 / 由弹窗注册表（OPEN_MODAL）另行重建的函数，无需钩子覆盖
  const i18nHookAllowed = new Set([
    'applyI18n', 'langSwitcher',            // 钩子自身与语言选择器
    'mountFeedbackWidget',                  // 只建外壳，内容由 renderFeedbackModal 随语言重绘
    'showDash',                             // 登录后一次性初始化
    'syncThemeIcon',                        // 只换图标，无文案
    'load', 'showLock',                     // status/admin：数据驱动，结果缓存在 __lastStatusData / 由 load() 重入
    'openImportModal', 'openAccountSettings', // 通过 OPEN_MODAL 注册表在语言切换时重建
  ]);
  const i18nHookMiss = [];
  for (const f of i18nHookFiles) {
    const raw = read(f);
    // ⚠️ 必须合并全部内联脚本再建调用图：函数分散在多个 <script> 块里（如 applyI18n 在块 1，
    //    动态渲染函数在块 2），按块单独分析会把整页误判成「没接到钩子」。
    const scripts = (raw.match(/<script[^>]*>[\s\S]*?<\/script>/g) || []).map(s => s.replace(/<\/?script[^>]*>/g, ''));
    for (const body of [scripts.join('\n')]) {
      // 收集函数名 → 函数体（含 window.xxx = function(){...} 形式）
      const declRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\bwindow\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*function\s*\(/g;
      const fns = {};
      for (const m of body.matchAll(declRe)) {
        const name = m[1] || m[2];
        if (!name) continue;
        const open = body.indexOf('{', m.index);
        if (open < 0) continue;
        let d = 0, end = body.length - 1;
        for (let i = open; i < body.length; i++) {
          const ch = body[i];
          if (ch === '{') d++; else if (ch === '}') { d--; if (!d) { end = i; break; } }
        }
        fns[name] = body.slice(open, end + 1);
      }
      // 事件处理器体内的调用不能算「刷新链路上的证据」：
      // 形如 a.onclick = () => { renderX(); } 的调用只在用户点击时才发生，
      // 切换语言时并不会执行（否则会误判 renderChannels 已覆盖 —— 实测漏报）。
      const stripHandlers = (s) => {
        const handlerPrefix = /(\.\s*on[a-z]+\s*=\s*$)|(addEventListener\s*\([^)]*,\s*$)/;
        let out = s;
        for (let pass = 0; pass < 3; pass++) {
          let changed = false;
          const re = /(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>|function\s*\([^()]*\)/g;
          let m;
          while ((m = re.exec(out))) {
            if (!handlerPrefix.test(out.slice(Math.max(0, m.index - 120), m.index))) continue;
            const open = out.indexOf('{', m.index);
            if (open < 0) continue;
            let d = 0, end = -1;
            for (let i = open; i < out.length; i++) {
              const ch = out[i];
              if (ch === '{') d++;
              else if (ch === '}') { d--; if (!d) { end = i; break; } }
            }
            if (end < 0) continue;
            out = out.slice(0, m.index) + ' ' + out.slice(end + 1);
            changed = true;
            break;
          }
          if (!changed) break;
        }
        return out;
      };
      const names = Object.keys(fns);
      if (!names.length) continue;
      // 根：语言切换实际会调用到的函数
      // ⚠️ 2026-09-15 补 `loadI18n`：它是唯一真正绑在语言选择器上的入口
      //    （如 admin.html `langSel.onchange = (e)=> loadI18n(e.target.value)`），
      //    且它内部会调用 applyI18n() + load()。此前只把 applyI18n / __afterLang 当根，
      //    导致「由 load() 重入」的整条刷新链（loadUsers / loadActivity / loadRanking / loadAnalytics）
      //    被误判为「不在钩子调用链里」—— 白名单里那条 `load` 注释写的就是这个意图，但白名单只豁免 load 自身，
      //    不会把可达性传递给它的被调函数。这是门禁自身的漏报（铁律 10「门禁绿≠有效」的镜像面：门禁红也可能误报）。
      const roots = ['applyI18n', '__afterLang', 'loadI18n'].filter(n => names.includes(n));
      if (!roots.length) continue;
      // 可达集（按函数名文本调用近似）
      const reach = new Set(roots);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of [...reach]) {
          const src = stripHandlers(fns[n]);
          for (const g of names) {
            if (reach.has(g)) continue;
            if (new RegExp('(^|[^\\w$.])' + g + '\\s*\\(').test(src)) { reach.add(g); grew = true; }
          }
        }
      }
      // 候选：用 t() 且写 DOM 的函数
      for (const n of names) {
        if (i18nHookAllowed.has(n) || reach.has(n)) continue;
        const b = fns[n];
        if (!/(^|[^\w$.])t\s*\(/.test(b)) continue;
        if (!/innerHTML|insertAdjacentHTML|textContent\s*=|textContent\s*\+=|placeholder\s*=/.test(b)) continue;
        i18nHookMiss.push(`${f}: ${n}()`);
      }
    }
  }
  if (i18nHookMiss.length) {
    fail('i18n-动态重绘', `以下函数用 t() 拼 DOM 但不在语言切换钩子（window.__afterLang/applyI18n）的调用链里，切换语言后这些区块会停留在旧语言：${i18nHookMiss.join('、')}。请在 __afterLang 中重绘，或加入 tools/dev_gate.js 的 i18nHookAllowed 白名单并写明理由。`);
  } else {
    ok('i18n-动态重绘', i18nHookFiles.length ? '所有含 t() 的动态渲染函数均在语言切换钩子调用链内' : '无 HTML 变更，跳过');
  }

  // 12) i18n 硬编码中文扫描（2026-09-14 教训固化）
  //     客户端（public/）任何非注释处出现中文，都会让 7 个非中文语言界面露出中文。
  //     文案一律走 t('key') / data-i18n + 8 语字典；语言名下拉（I18N_LANGS / value="zh"）豁免。
  const cjkFiles = [...new Set([...htmlFiles, ...files.filter(f => /^public[\\/].*\.js$/.test(f))])]
    .filter(f => !/node_modules/.test(f) && exists(f));
  const cjkExempt = /(I18N_LANGS|value="zh"|id="langSel"|class="lang-select")/;
  // ⚠️ 顺序敏感（2026-09-14 踩坑）：必须先剥离 HTML 注释再剥离块注释。
  //    若反过来，HTML 注释内出现 `/*`（如文档路径 public/i18n/*.json）会让块注释正则
  //    一路吞到正文里下一个 `*/`，把 `-->` 结束符一起吃掉 → HTML 注释内的中文被误判为硬编码中文。
  const stripComments = (src) => src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  const cjkHits = [];
  for (const f of cjkFiles) {
    const lines = stripComments(read(f)).split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!/[\u4e00-\u9fff]/.test(l)) return;
      if (cjkExempt.test(l)) return;
      cjkHits.push(`${f}:${i + 1} ${l.trim().slice(0, 70)}`);
    });
  }
  if (cjkHits.length) {
    fail('i18n-硬编码中文', `客户端出现硬编码中文（非注释），非中文语言界面会露出中文：${cjkHits.join(' | ')}。请改为 t('key') / data-i18n 并补 8 语字典。`);
  } else {
    ok('i18n-硬编码中文', cjkFiles.length ? 'public/ 无硬编码中文（注释外）' : '无客户端文件变更，跳过');
  }

  // 13) GIT 可用性兜底（2026-09-23 固化）：三个 git 调用全失败 ⇒ 门禁无法枚举变更
  //     ⇒ 上方所有 diff 类检查（i18n / UI / DB / API 契约 / T5 / PAY 等）一条都没跑 ⇒
  //     绝不能打印「✓ 门禁通过」。此前被 catch 静默吞掉，等于门禁形同虚设。
  //     现在：git 全不可用时响亮失败，逼出环境异常（git 未安装 / 仓库损坏 / 沙箱资源忙 EBUSY）。
  if (!gitOk) {
    fail('GIT-不可用', '无法获取变更文件清单：git diff / git status 全部调用失败（环境异常——可能 git 未安装、仓库损坏、或沙箱资源忙 EBUSY）。门禁无法验证任何 diff 类检查，禁止静默通过。请修复 git 环境后重试。');
  }

}

// ---- 汇总 ----
// 首次提交（无 HEAD）：历史债项 FAIL 降级为 WARN；但 GIT-不可用 属环境异常，永不降级，必须响亮失败。
if (isInitial && !isMsg) {
  const degraded = checks.filter(c => c.l === 'FAIL' && c.n !== 'GIT-不可用');
  if (degraded.length) {
    console.log('\n（首次提交：FAIL 降级为 WARN，历史债项请 Martin 后续决策清理）');
    for (const c of degraded) c.l = 'WARN';
  }
}
let bad = checks.filter(c => c.l === 'FAIL');
console.log('\n=== Pingory dev_gate（SOP 机检门禁）===');
for (const c of checks) console.log(`[${c.l}] ${c.n}: ${c.d || ''}`);
if (bad.length) {
  console.log(`\n✗ ${bad.length} 项 FAIL，已拦截。请修正后重试（WARN 项人工确认即可）。`);
  process.exit(1);
}
console.log('\n✓ 门禁通过（WARN 项请人工确认）。');
