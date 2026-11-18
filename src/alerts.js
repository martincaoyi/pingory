// 告警模块（Phase 1：多渠道 G4 / 恢复+升级 G2 / 慢响应+到期预警）
// 状态或 warning 变化时触发，按监控配置的渠道分发。

import { setCheckResultHandler, saveEvent, saveMonitor, listMonitors, getStats } from './monitors.js';
import { getUserById, isMonitorInMaintenance, getSubscriberEmails, getAlertChannels } from './auth.js';
import { planHasChannel, planHasStats } from './plans.js';
import { monErrText } from './monerr.js';
import { getPool } from './db.js';
import { safeFetch } from './ssrf-guard.js';

// 邮件告警的收件人 = 监控归属账号的注册邮箱（多租户各归各）。
// ⚠️ 不再使用全局 ALERT_TO_EMAIL 作为告警收件人（该变量仅剩「客户反馈通知」用途，见 src/email.js）。

// ===== 邮件 transporter（Worker 自适应：与 src/email.js 同款机制，见该文件注释）=====
let transporter = null;
let nodemailerMod = null;
async function getTransporter() {
  if (globalThis.__USE_RESEND_HTTP__) return null; // Worker：走 Resend HTTP，不加载 nodemailer
  if (!process.env.SMTP_HOST) return null;
  if (transporter) return transporter;
  if (!nodemailerMod) nodemailerMod = await import('nodemailer');
  const nodemailer = nodemailerMod.default || nodemailerMod;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

// Resend HTTP 通道（Worker 专用，ADR-0001 迁移规则 #4）。返回值语义与 nodemailer 路径一致。
async function sendViaResend(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[alert] RESEND_API_KEY 未配置，跳过发送');
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: [to],
        subject,
        text,
      }),
    });
    if (!r.ok) {
      console.error('[alert] Resend 发送失败:', r.status, await r.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[alert] 邮件发送失败:', err.message);
    return false;
  }
}

// ===== 邮件发送配额（P1-12）=====
// 背景：SMTP = Resend 免费档 100 封/天。一次事故（监控长时间宕机 × 多订阅者）即可打爆额度，
// 额度耗尽后 Resend 拒发 ⇒ 关键告警会静默丢失。故发送前先消费配额，超限则跳过并**响亮记录**。
// 计数落库（双实例共享），按 UTC 日期分桶、跨天自动归零。
const EMAIL_DAILY_CAP = Number(process.env.EMAIL_DAILY_CAP || 90);     // 全站每日上限（留余量给验证/重置邮件）
const EMAIL_ACCOUNT_CAP = Number(process.env.EMAIL_ACCOUNT_CAP || 60); // 单账号每日上限（防单账号吃光全局额度）
// 非关键告警（warning：慢响应 / 证书即将到期）只能用全局额度的前 X%；
// 其余额度**预留给关键告警**（down / escalation / recovered），保证事故时关键邮件发得出去。
const EMAIL_WARN_SHARE = Number(process.env.EMAIL_WARN_SHARE || 0.4);

// 原子消费一封配额；返回 true = 允许发送。scope：'global' | 'acct:<userId>'
export async function consumeEmailBudget(scope, ceiling) {
  if (!(ceiling > 0)) return false;
  try {
    const pool = await getPool();
    const { rows } = await pool.query(
      `INSERT INTO email_budget (scope, day, used, updated_at)
       VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1, now())
       ON CONFLICT (scope, day) DO UPDATE
         SET used = email_budget.used + 1, updated_at = now()
         WHERE email_budget.used + 1 <= $2
       RETURNING used`,
      [scope, ceiling]
    );
    return rows.length > 0;
  } catch (e) {
    // 配额表故障时放行（宁可发也不因计数故障彻底静默），但留日志便于排查
    console.error('[alert] 邮件配额检查失败（放行）:', e.message);
    return true;
  }
}

// ===== 渠道发送实现 =====
// 发送一封告警邮件：先过配额（全局 + 账号），再发。priority='critical' | 'warning'
async function sendAlertEmail(to, subject, text, { priority = 'critical', accountId = null } = {}) {
  if (!to) return false;
  // 通道可用性预检（未配置 SMTP / RESEND_API_KEY：直接返回，不消耗配额）
  let t = null;
  if (globalThis.__USE_RESEND_HTTP__) {
    if (!process.env.RESEND_API_KEY) return false;
  } else {
    t = await getTransporter();
    if (!t) return false;
  }
  const isWarn = priority === 'warning';
  const globalCeiling = isWarn ? Math.max(1, Math.floor(EMAIL_DAILY_CAP * EMAIL_WARN_SHARE)) : EMAIL_DAILY_CAP;
  if (!(await consumeEmailBudget('global', globalCeiling))) {
    console.warn(`[alert] 全局邮件配额已用尽（priority=${priority}, ceiling=${globalCeiling}），已跳过: ${subject} -> ${to}`);
    return false;
  }
  if (accountId) {
    const acctCeiling = isWarn ? Math.max(1, Math.floor(EMAIL_ACCOUNT_CAP * EMAIL_WARN_SHARE)) : EMAIL_ACCOUNT_CAP;
    if (!(await consumeEmailBudget(`acct:${accountId}`, acctCeiling))) {
      console.warn(`[alert] 账号邮件配额已用尽（${accountId}, priority=${priority}, ceiling=${acctCeiling}），已跳过: ${subject} -> ${to}`);
      return false;
    }
  }
  try {
    if (globalThis.__USE_RESEND_HTTP__) {
      const ok = await sendViaResend(to, subject, text);
      if (!ok) return false;
    } else {
      await t.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject,
        text,
      });
    }
    console.log('[alert] 邮件已发送 ->', to);
    return true;
  } catch (err) {
    console.error('[alert] 邮件发送失败:', err.message);
    return false;
  }
}

// 状态页订阅者通知（G7）：逐人发送，配额耗尽即停
async function notifySubscribers(monitor, title, text, priority = 'critical') {
  if (!monitor.userId) return;
  // P1：订阅者只能看到**公开**状态页上的监控。旧实现对全部监控通知订阅者，
  // 会把私有监控的名称与 URL 直接发给无关订阅者（隐私泄露）。
  if (!monitor.statusPublic) return;
  try {
    const emails = await getSubscriberEmails(monitor.userId);
    let sent = 0;
    for (const e of emails) {
      const ok = await sendAlertEmail(e, title, text + '\n\n（你正在订阅该用户的状态页，可忽略此邮件）', { priority, accountId: monitor.userId });
      if (!ok) break; // 配额耗尽 → 后续订阅者不再尝试（避免刷日志与无谓请求）
      sent += 1;
    }
    if (emails.length) console.log(`[alert] 已通知 ${sent}/${emails.length} 名订阅者: ${monitor.name}`);
  } catch (err) {
    console.error('[alert] 订阅者通知失败:', err.message);
  }
}

// ===== 渠道发送 =====
// 统一约定（P1，2026-11-18 修复）：
//   ① 用户可填 URL 的渠道（slack / webhook / discord / teams / pagerduty）必须走 safeFetch，
//      否则可被用来探测内网与云元数据；
//   ② 必须检查 res.ok —— 旧实现全部不判，Telegram token 失效 / Webhook 404 一律当成功；
//   ③ 返回 true/false，由 dispatch 汇总失败渠道，避免「以为发了其实没发」。
async function sendSlack(url, text) {
  if (!url) return false;
  try {
    const res = await safeFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }, { timeoutMs: 10000 });
    if (!res.ok) { console.error(`[alert] Slack 返回 HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { console.error('[alert] Slack 失败:', e.message); return false; }
}

async function sendWebhook(url, payload) {
  if (!url) return false;
  try {
    const res = await safeFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { timeoutMs: 10000 });
    if (!res.ok) { console.error(`[alert] Webhook 返回 HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { console.error('[alert] Webhook 失败:', e.message); return false; }
}

async function sendTelegram(botToken, chatId, text) {
  if (!botToken || !chatId) return false;
  try {
    // 目标域名固定为 api.telegram.org，不存在 SSRF 面；仅需超时兜底
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(10000) : undefined;
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal,
    });
    if (!res.ok) { console.error(`[alert] Telegram 返回 HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { console.error('[alert] Telegram 失败:', e.message); return false; }
}

async function sendDiscord(url, text) {
  if (!url) return false;
  try {
    const APP_URL = (process.env.APP_URL || 'https://pingory.com').replace(/\/$/, '');
    const res = await safeFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Pingory', avatar_url: `${APP_URL}/icon-192.png`, content: text }),
    }, { timeoutMs: 10000 });
    if (!res.ok) { console.error(`[alert] Discord 返回 HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { console.error('[alert] Discord 失败:', e.message); return false; }
}

// MS Teams：旧实现直接复用 sendWebhook，但调用处按 (url,title,text,extra) 传 4 参
// ⇒ 实际 body 是 JSON.stringify(title)（裸字符串），Teams 侧必然拒收。这里显式实现。
async function sendTeams(url, title, text) {
  if (!url) return false;
  try {
    const res = await safeFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        '@type': 'MessageCard',
        '@context': 'https://schema.org/extensions',
        summary: title,
        themeColor: 'D93025',
        title,
        text,
      }),
    }, { timeoutMs: 10000 });
    if (!res.ok) { console.error(`[alert] Teams 返回 HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { console.error('[alert] Teams 失败:', e.message); return false; }
}

// PagerDuty Events API v2：routing_key 必填，且必须放在 body 里。
// 兼容两种既有填法：URL 带 ?routing_key= / 或直接把 integration key 当 url 填。
async function sendPagerduty(url, { summary, source, severity }) {
  if (!url) return false;
  let endpoint = url;
  let routingKey = null;
  const raw = String(url).trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      routingKey = u.searchParams.get('routing_key') || u.searchParams.get('integration_key') || null;
      if (u.hostname === 'events.pagerduty.com') endpoint = raw;
    } catch { /* 落到下面 */ }
  } else if (/^[A-Za-z0-9]{20,}$/.test(raw)) {
    routingKey = raw;
    endpoint = 'https://events.pagerduty.com/v2/enqueue';
  }
  if (!routingKey) { console.error('[alert] PagerDuty 缺少 routing key，跳过'); return false; }
  try {
    const res = await safeFetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: 'trigger',
        payload: { summary, source, severity: severity || 'critical' },
      }),
    }, { timeoutMs: 10000 });
    if (!res.ok) { console.error(`[alert] PagerDuty 返回 HTTP ${res.status}`); return false; }
    return true;
  } catch (e) { console.error('[alert] PagerDuty 失败:', e.message); return false; }
}

// ===== 渠道凭据完整性：缺凭据的渠道直接跳过，避免无意义的失败与噪声 =====
function channelCredOk(ch, cfg) {
  if (!cfg) return false;
  if (ch === 'email') return true;
  if (ch === 'telegram') return !!(cfg.botToken && cfg.chatId);
  return !!cfg.url;
}

// ===== 渠道解析（账户级凭据 + 监控级覆盖 + 套餐过滤 + 默认邮件）=====
// Plan A（2026-09-14）：凭据存在账户级（accountChannels），监控只存 {enabled:true} 开关。
// 向后兼容：存量监控若自带 per-monitor 凭据，同名字段覆盖账户级 → 老数据行为不变。
function resolveChannels(monitor, plan, accountChannels) {
  const acct = (accountChannels && typeof accountChannels === 'object') ? accountChannels : {};
  const raw = monitor.channels;
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const [ch, cfg] of Object.entries(raw)) {
      if (!cfg || !cfg.enabled || !planHasChannel(plan, ch)) continue;
      const merged = Object.assign({}, acct[ch] || {}, cfg);
      if (!channelCredOk(ch, merged)) {
        console.warn(`[alert] 渠道 ${ch} 已启用但缺少凭据，跳过（${monitor.name}）`);
        continue;
      }
      out[ch] = merged;
    }
  }
  if (Object.keys(out).length === 0 && planHasChannel(plan, 'email')) out.email = true;
  return out;
}

// ===== 统一分发 =====
async function dispatch(monitor, plan, title, text, channelExtra = {}, accountChannels = {}, emailTo = null, priority = 'critical') {
  const channels = resolveChannels(monitor, plan, accountChannels);
  const failed = [];
  for (const [ch, cfg] of Object.entries(channels)) {
    try {
      let ok = true;
      switch (ch) {
        case 'email':
          // 发给该监控归属账号的注册邮箱；无归属邮箱时跳过并留日志，绝不回退到固定个人邮箱。
          if (emailTo) ok = await sendAlertEmail(emailTo, title, text, { priority, accountId: monitor.userId });
          else { console.warn(`[alert] email 渠道跳过：监控无归属账号邮箱（${monitor.name}）`); ok = false; }
          break;
        case 'slack': ok = await sendSlack(cfg.url, text); break;
        case 'webhook': ok = await sendWebhook(cfg.url, { title, text, monitor: monitor.name, ...channelExtra }); break;
        case 'telegram': ok = await sendTelegram(cfg.botToken, cfg.chatId, text); break;
        case 'discord': ok = await sendDiscord(cfg.url, text); break;
        case 'teams': ok = await sendTeams(cfg.url, title, text); break;
        case 'pagerduty': ok = await sendPagerduty(cfg.url, { summary: title, source: monitor.name, severity: channelExtra.severity || 'critical' }); break;
        default: break;
      }
      if (ok === false) failed.push(ch);
    } catch (e) {
      failed.push(ch);
      console.error(`[alert] 渠道 ${ch} 异常:`, e.message);
    }
  }
  // 失败必须可见：旧实现静默吞掉，运维与用户都无法得知「告警其实没送达」
  if (failed.length) console.warn(`[alert] 渠道未送达 [${failed.join(', ')}] ${monitor.name}`);
  // 控制台始终打印（方便本地调试）
  console.log(`[alert][${title}] ${monitor.name} (${monitor.url}): ${text}`);
}

// ===== 测试发送（账户设置「发送测试」用）：直接调用并返回真实结果，不吞异常 =====
export async function sendTestAlert(channel, cfg) {
  const text = `✅ Pingory test alert — channel "${channel}" is working. Time: ${fmt()}`;
  try {
    if (channel === 'slack' || channel === 'discord') {
      const body = channel === 'discord'
        ? { username: 'Pingory', content: text }
        : { text };
      // 用户可填 URL ⇒ 必须过 SSRF 守卫（否则「发送测试」可探测内网并回显状态码）
      const r = await safeFetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { timeoutMs: 10000 });
      return { ok: r.ok, status: r.status };
    }
    if (channel === 'webhook' || channel === 'teams' || channel === 'pagerduty') {
      const body = channel === 'webhook'
        ? { title: 'Pingory test alert', text }
        : { title: 'Pingory test alert', text, summary: 'Pingory test alert', source: 'Pingory', severity: 'info' };
      const r = await safeFetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, { timeoutMs: 10000 });
      return { ok: r.ok, status: r.status };
    }
    if (channel === 'telegram') {
      const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text }),
      });
      return { ok: r.ok, status: r.status };
    }
    return { ok: false, reason: 'unsupported' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

function fmt(ts) {
  return new Date(ts || Date.now()).toISOString();
}

export function initAlerts() {
  setCheckResultHandler(async (monitor, result, ctx) => {
    let userEmail = null;
    let plan = 'free';
    let accountChannels = {};
    if (monitor.userId) {
      try {
        const u = await getUserById(monitor.userId);
        userEmail = u?.email || null;
        plan = u?.plan || 'free';
        accountChannels = await getAlertChannels(monitor.userId);
      } catch { /* ignore */ }
    }

    // ---- G8 维护窗口：覆盖该监控时不派发告警（仍记录状态变化）----
    let inMaintenance = false;
    if (monitor.userId) {
      try { inMaintenance = await isMonitorInMaintenance(monitor.userId, monitor.id); } catch { /* ignore */ }
    }

    // ---- 真正宕机才告警：连续失败确认后才派发（Free 需连续 2 次，付费档 1 次；多区域时 runCheck 已多数确认）----
    if (result.status === 'down') {
      if (ctx.downConfirmed && (monitor.alertCount || 0) === 0) {
        const text = `🔴 DOWN ${monitor.name} (${monitor.url})\nError: ${monErrText(result.error) || 'Unknown'}\nTime: ${fmt()}`;
        await saveEvent(monitor.id, { eventType: 'down', fromStatus: ctx.prevStatus, toStatus: 'down', responseTime: result.responseTime, error: result.error, detail: text });
        if (inMaintenance) {
          // 维护窗口内**不占用告警状态位**：旧实现仍置 alertCount=1，维护结束后恢复时会
          // 发出一条从未有过对应 DOWN 的 RECOVERED（幽灵恢复）。这里只记事件，不派发。
          console.log(`[alert] 维护窗口内跳过告警: ${monitor.name}`);
          return;
        }
        monitor.lastAlertAt = Date.now();
        monitor.alertCount = 1;
        await saveMonitor(monitor);
        await dispatch(monitor, plan, `Pingory DOWN: ${monitor.name}`, text, { severity: 'critical' }, accountChannels, userEmail, 'critical');
        await notifySubscribers(monitor, `Status page alert: ${monitor.name} is DOWN`, text, 'critical');
      } else if ((monitor.alertCount || 0) > 0) {
        // 持续 down：升级告警（G2）
        const escMin = (monitor.config?.escalationIntervalMin) || 30;
        const last = monitor.lastAlertAt || 0;
        if (Date.now() - last >= escMin * 60 * 1000) {
          const count = (monitor.alertCount || 0) + 1;
          const text = `🔁 STILL DOWN (attempt ${count}) ${monitor.name} (${monitor.url})\nError: ${monErrText(result.error) || 'Unknown'}\nTime: ${fmt()}`;
          await saveEvent(monitor.id, { eventType: 'escalation', fromStatus: 'down', toStatus: 'down', responseTime: result.responseTime, error: result.error, detail: text });
          monitor.lastAlertAt = Date.now();
          monitor.alertCount = count;
          await saveMonitor(monitor);
          if (!inMaintenance) {
            await dispatch(monitor, plan, `Pingory STILL DOWN: ${monitor.name}`, text, { severity: 'critical' }, accountChannels, userEmail, 'critical');
            await notifySubscribers(monitor, `Status page alert: ${monitor.name} still DOWN`, text, 'critical');
          }
        }
      }
      // 未确认的 down（连续次数未达标）：仅更新状态，不告警（降误报）
      return;
    }

    // ---- 恢复：仅当本 outage 已派发过告警才发 RECOVERED（避免单次抖动产生幽灵恢复）----
    if (result.status === 'up') {
      const hadOutage = (monitor.alertCount || 0) > 0;
      if (hadOutage) {
        const text = `✅ RECOVERED ${monitor.name} (${monitor.url})\nResponse: ${result.responseTime ?? '?'}ms\nTime: ${fmt()}`;
        await saveEvent(monitor.id, { eventType: 'up', fromStatus: 'down', toStatus: 'up', responseTime: result.responseTime, error: null, detail: text });
        monitor.alertCount = 0;
        await saveMonitor(monitor);
        if (!inMaintenance) {
          await dispatch(monitor, plan, `Pingory RECOVERED: ${monitor.name}`, text, { severity: 'info' }, accountChannels, userEmail, 'critical');
          await notifySubscribers(monitor, `Status page alert: ${monitor.name} recovered`, text, 'critical');
        }
      }
      // ---- up 状态下的 warning：慢响应 / 证书或域名即将到期（G2 / G1）----
      let warnText = null;
      if (ctx.isSlow && !ctx.prevSlow) {
        warnText = `🐢 SLOW ${monitor.name} (${monitor.url})\nResponse ${result.responseTime}ms exceeds threshold ${monitor.config.slowThresholdMs}ms\nTime: ${fmt()}`;
      } else if (ctx.isWarn && ctx.warnFresh && result.warn) {
        warnText = `⚠️ WARNING ${monitor.name} (${monitor.url})\n${monErrText(result.warn)}\nTime: ${fmt()}`;
      }
      if (warnText) {
        await saveEvent(monitor.id, { eventType: 'warning', fromStatus: 'up', toStatus: 'up', responseTime: result.responseTime, error: result.warn || null, detail: warnText });
        // 维护窗口同样覆盖 warning（旧实现只挡 DOWN/RECOVERED，维护期仍会收到慢响应/到期预警）
        if (inMaintenance) console.log(`[alert] 维护窗口内跳过 warning: ${monitor.name}`);
        else await dispatch(monitor, plan, `Pingory WARNING: ${monitor.name}`, warnText, { severity: 'warning' }, accountChannels, userEmail, 'warning');
      }
      return;
    }
  });
}

// ===== 月度报告（G6）=====
export async function generateMonthlyReport(userId) {
  const user = await getUserById(userId);
  if (!user) return false;
  if (!planHasStats(user.plan)) return false; // 仅付费档
  const monitors = await listMonitors(userId);
  const lines = [`Monthly report — ${user.email}`, `Generated: ${new Date().toISOString()}`, ''];

  if (!monitors.length) {
    lines.push('No monitors this period.');
  } else {
    for (const m of monitors) {
      const s = await getStats(m.id, 30);
      const uptime = s.uptime == null ? 'N/A' : s.uptime.toFixed(2) + '%';
      lines.push(`• ${m.name} (${m.url})`);
      lines.push(`    Uptime: ${uptime} | Checks: ${s.checks} | Avg response: ${s.avgRt ?? 'N/A'}ms | P95: ${s.p95Rt ?? 'N/A'}ms`);
    }
  }

  const text = lines.join('\n');
  // 月度报告属非关键邮件：走 warning 档，不占用为关键告警预留的额度
  const ok = await sendAlertEmail(user.email, 'Pingory 月度报告', text, { priority: 'warning', accountId: userId });
  if (!ok) { console.warn('[report] 月度报告未发送（配额或发送失败）:', user.email); return false; }
  console.log('[report] 月度报告已发送至', user.email);
  return true;
}
