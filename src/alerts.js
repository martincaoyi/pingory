// 告警模块（Phase 1：多渠道 G4 / 恢复+升级 G2 / 慢响应+到期预警）
// 状态或 warning 变化时触发，按监控配置的渠道分发。

import { setCheckResultHandler, saveEvent, saveMonitor, listMonitors, getStats } from './monitors.js';
import { getUserById, isMonitorInMaintenance, getSubscriberEmails, getAlertChannels } from './auth.js';
import nodemailer from 'nodemailer';
import { planHasChannel, planHasStats } from './plans.js';
import { monErrText } from './monerr.js';

// 邮件告警的收件人 = 监控归属账号的注册邮箱（多租户各归各）。
// ⚠️ 不再使用全局 ALERT_TO_EMAIL 作为告警收件人（该变量仅剩「客户反馈通知」用途，见 src/email.js）。

// ===== 邮件 transporter =====
let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

// ===== 渠道发送实现 =====
async function sendEmail(to, subject, text) {
  const t = getTransporter();
  if (!t || !to) return;
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
    console.log('[alert] 邮件已发送 ->', to);
  } catch (err) {
    console.error('[alert] 邮件发送失败:', err.message);
  }
}

// 给指定收件人发（订阅者通知复用）
async function sendEmailTo(to, subject, text) {
  return sendEmail(to, subject, text);
}

// 状态页订阅者通知（G7）：返回实际发送数量
async function notifySubscribers(monitor, title, text) {
  if (!monitor.userId) return;
  try {
    const emails = await getSubscriberEmails(monitor.userId);
    for (const e of emails) {
      await sendEmailTo(e, title, text + '\n\n（你正在订阅该用户的状态页，可忽略此邮件）');
    }
    if (emails.length) console.log(`[alert] 已通知 ${emails.length} 名订阅者: ${monitor.name}`);
  } catch (err) {
    console.error('[alert] 订阅者通知失败:', err.message);
  }
}

async function sendSlack(url, text) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) { console.error('[alert] Slack 失败:', e.message); }
}

async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.error('[alert] Webhook 失败:', e.message); }
}

async function sendTelegram(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('[alert] Telegram 失败:', e.message); }
}

async function sendDiscord(url, text) {
  if (!url) return;
  try {
    const APP_URL = (process.env.APP_URL || 'https://pingory.com').replace(/\/$/, '');
    await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Pingory', avatar_url: `${APP_URL}/icon-192.png`, content: text }),
    });
  } catch (e) { console.error('[alert] Discord 失败:', e.message); }
}

// Teams / PagerDuty 走 webhook 语义
const sendTeams = sendWebhook;
const sendPagerduty = sendWebhook;

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
async function dispatch(monitor, plan, title, text, channelExtra = {}, accountChannels = {}, emailTo = null) {
  const channels = resolveChannels(monitor, plan, accountChannels);
  for (const [ch, cfg] of Object.entries(channels)) {
    try {
      switch (ch) {
        case 'email':
          // 发给该监控归属账号的注册邮箱；无归属邮箱时跳过并留日志，绝不回退到固定个人邮箱。
          if (emailTo) await sendEmail(emailTo, title, text);
          else console.warn(`[alert] email 渠道跳过：监控无归属账号邮箱（${monitor.name}）`);
          break;
        case 'slack': await sendSlack(cfg.url, text); break;
        case 'webhook': await sendWebhook(cfg.url, { title, text, monitor: monitor.name, ...channelExtra }); break;
        case 'telegram': await sendTelegram(cfg.botToken, cfg.chatId, text); break;
        case 'discord': await sendDiscord(cfg.url, text); break;
        case 'teams': await sendTeams(cfg.url, title, text, channelExtra); break;
        case 'pagerduty': await sendPagerduty(cfg.url, { summary: title, source: monitor.name, severity: channelExtra.severity || 'critical' }); break;
        default: break;
      }
    } catch (e) {
      console.error(`[alert] 渠道 ${ch} 异常:`, e.message);
    }
  }
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
      const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { ok: r.ok, status: r.status };
    }
    if (channel === 'webhook' || channel === 'teams' || channel === 'pagerduty') {
      const body = channel === 'webhook'
        ? { title: 'Pingory test alert', text }
        : { title: 'Pingory test alert', text, summary: 'Pingory test alert', source: 'Pingory', severity: 'info' };
      const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
        monitor.lastAlertAt = Date.now();
        monitor.alertCount = 1;
        await saveMonitor(monitor);
        if (inMaintenance) { console.log(`[alert] 维护窗口内跳过告警: ${monitor.name}`); }
        else {
          await dispatch(monitor, plan, `Pingory DOWN: ${monitor.name}`, text, { severity: 'critical' }, accountChannels, userEmail);
          await notifySubscribers(monitor, `Status page alert: ${monitor.name} is DOWN`, text);
        }
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
            await dispatch(monitor, plan, `Pingory STILL DOWN: ${monitor.name}`, text, { severity: 'critical' }, accountChannels, userEmail);
            await notifySubscribers(monitor, `Status page alert: ${monitor.name} still DOWN`, text);
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
          await dispatch(monitor, plan, `Pingory RECOVERED: ${monitor.name}`, text, { severity: 'info' }, accountChannels, userEmail);
          await notifySubscribers(monitor, `Status page alert: ${monitor.name} recovered`, text);
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
        await dispatch(monitor, plan, `Pingory WARNING: ${monitor.name}`, warnText, { severity: 'warning' }, accountChannels, userEmail);
        await saveEvent(monitor.id, { eventType: 'warning', fromStatus: 'up', toStatus: 'up', responseTime: result.responseTime, error: result.warn || null, detail: warnText });
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
  await sendEmail(user.email, 'Pingory 月度报告', text);
  console.log('[report] 月度报告已发送至', user.email);
  return true;
}
