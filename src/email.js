// 邮件发送封装（G-SEC 邮箱验证 / G-FEEDBACK 反馈通知）
// 复用与 alerts.js 相同的 SMTP 配置；独立 transporter 避免与告警模块耦合。
//
// ===== Worker（Cloudflare）运行时自适应（ADR-0001 迁移规则 #4）=====
// Workers 禁裸 TCP（SMTP 465 不可用）。检测到 globalThis.__USE_RESEND_HTTP__ 时
// 走 Resend HTTP API（POST https://api.resend.com/emails，Bearer RESEND_API_KEY）；
// 否则走原 nodemailer 路径——Fly 行为零变化（nodemailer 改为动态 import：
// Node 下解析结果与静态 import 完全一致，且 Worker 模式下完全不加载该包）。
// 函数签名与返回值语义（boolean）不变，调用方零改动。

let transporter = null;
let nodemailerMod = null;
async function getTransporter() {
  if (globalThis.__USE_RESEND_HTTP__) return null; // Worker：邮件走 Resend HTTP，不加载 nodemailer
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

// 懒取（Worker 的 process.env 在首个请求前由 env 桥注入，模块加载时读会拿到空值）
function appUrl() {
  return (process.env.APP_URL || 'https://pingory.com').replace(/\/$/, '');
}

// Resend HTTP 通道（Worker 专用）。返回值语义与 nodemailer 路径一致：成功 true / 失败 false
async function sendViaResend(to, subject, text, html) {
  if (!to) return false;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.error('[mail] RESEND_API_KEY 未配置，跳过发送');
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
        html,
      }),
    });
    if (!r.ok) {
      console.error('[mail] Resend 发送失败:', r.status, await r.text().catch(() => ''));
      return false;
    }
    console.log('[mail] 已发送 ->', to, '|', subject);
    return true;
  } catch (err) {
    console.error('[mail] 发送失败:', err.message);
    return false;
  }
}

export async function sendMail(to, subject, text, html) {
  if (globalThis.__USE_RESEND_HTTP__) return sendViaResend(to, subject, text, html);
  const t = await getTransporter();
  if (!t || !to) return false;
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
    });
    console.log('[mail] 已发送 ->', to, '|', subject);
    return true;
  } catch (err) {
    console.error('[mail] 发送失败:', err.message);
    return false;
  }
}

// 注册后验证邮件
export async function sendVerificationEmail(email, token) {
  const link = `${appUrl()}/?verify=${token}`;
  const subject = 'Verify your Pingory email';
  const text = `Welcome to Pingory!\n\nPlease click the link below to verify your email (valid for 24 hours):\n${link}\n\nIf you did not sign up for this, you can ignore this email.`;
  const html = `<div style="padding:14px 0 12px;border-bottom:1px solid #e5e7eb;margin-bottom:16px;">
  <img src="${appUrl()}/logo-email.png" width="40" height="40" alt="" style="vertical-align:middle;border-radius:9px;border:1px solid #e5e7eb;"/>
  <span style="font-size:20px;font-weight:700;color:#1faa6b;vertical-align:middle;margin-left:8px;">Pingory</span>
</div>
<p>Welcome to <b>Pingory</b>!</p><p>Please click the link below to verify your email (valid for 24 hours):</p><p><a href="${link}">${link}</a></p><p>If you did not sign up for this, you can ignore this email.</p>`;
  return sendMail(email, subject, text, html);
}

// 客户反馈到达，通知管理员
export async function sendFeedbackNotification({ email, message, page }) {
  const to = process.env.ALERT_TO_EMAIL;
  if (!to) return false;
  const subject = `[Pingory feedback] from ${email || 'anonymous'}`;
  const text = `Page: ${page || 'unknown'}\nEmail: ${email || 'anonymous'}\n\n${message}`;
  return sendMail(to, subject, text);
}

// ===== 邮件订阅名单（v2 / 2026-09-29）=====
// 双重选择加入的确认信。链接落在首页 ?wl=TOKEN，由首页读参数后调 confirm 接口，
// 这样确认成功/失败都能按访客当前语言提示。
export async function sendWaitlistConfirmEmail(email, token) {
  const link = `${appUrl()}/?wl=${encodeURIComponent(token)}`;
  const subject = 'Confirm your Pingory launch subscription';
  const text = `You asked to hear from us when Pingory launches.\n\nConfirm your address (this link expires in 7 days):\n${link}\n\nIf this was not you, just ignore this email — nothing else will be sent.`;
  const html = `<div style="padding:14px 0 12px;border-bottom:1px solid #e5e7eb;margin-bottom:16px;">
  <img src="${appUrl()}/logo-email.png" width="40" height="40" alt="" style="vertical-align:middle;border-radius:9px;border:1px solid #e5e7eb;"/>
  <span style="font-size:20px;font-weight:700;color:#1faa6b;vertical-align:middle;margin-left:8px;">Pingory</span>
</div>
<p>You asked to hear from us when <b>Pingory</b> launches.</p>
<p>Confirm your address — this link expires in 7 days:</p>
<p><a href="${link}" style="background:#1faa6b;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">Confirm my email</a></p>
<p style="color:#6b7280;font-size:13px;">If this was not you, just ignore this email — nothing else will be sent.</p>`;
  return sendMail(email, subject, text, html);
}

// 名单公告（launch 通知）。每条都带独立一键退订链接。
export async function sendWaitlistAnnounce(email, unsubscribeToken, subject, body) {
  const link = `${appUrl()}/?wlu=${encodeURIComponent(unsubscribeToken)}`;
  const text = `${body}\n\n---\nYou are getting this because you subscribed at ${appUrl()}. Unsubscribe: ${link}`;
  const html = `<div style="padding:14px 0 12px;border-bottom:1px solid #e5e7eb;margin-bottom:16px;">
  <img src="${appUrl()}/logo-email.png" width="40" height="40" alt="" style="vertical-align:middle;border-radius:9px;border:1px solid #e5e7eb;"/>
  <span style="font-size:20px;font-weight:700;color:#1faa6b;vertical-align:middle;margin-left:8px;">Pingory</span>
</div>
<p>${String(body).replace(/\n/g, '<br>')}</p>
<p style="margin-top:24px;"><a href="${link}" style="color:#6b7280;font-size:12px;">Unsubscribe from launch updates</a></p>`;
  return sendMail(email, subject, text, html);
}

// 忘记密码：发送重置链接（一次性令牌，24 小时有效）
export async function sendPasswordResetEmail(email, token) {
  const link = `${appUrl()}/reset-password.html?token=${token}`;
  const subject = 'Reset your Pingory password';
  const text = `We received a request to reset your Pingory password.\n\nIf this was you, click the link below to set a new password (valid for 24 hours):\n${link}\n\nIf you did not request this, you can safely ignore this email.`;
  const html = `<div style="padding:14px 0 12px;border-bottom:1px solid #e5e7eb;margin-bottom:16px;">
  <img src="${appUrl()}/logo-email.png" width="40" height="40" alt="" style="vertical-align:middle;border-radius:9px;border:1px solid #e5e7eb;"/>
  <span style="font-size:20px;font-weight:700;color:#1faa6b;vertical-align:middle;margin-left:8px;">Pingory</span>
</div>
<p>We received a request to reset your <b>Pingory</b> password.</p>
<p>If this was you, click the link below to set a new password (valid for 24 hours):</p>
<p><a href="${link}">${link}</a></p>
<p>If you did not request this, you can safely ignore this email.</p>`;
  return sendMail(email, subject, text, html);
}

// 改邮箱：向新邮箱发送确认链接（一次性令牌，24 小时有效）
export async function sendChangeEmailVerification(email, token) {
  const link = `${appUrl()}/?confirmEmail=${token}`;
  const subject = 'Confirm your new Pingory email';
  const text = `You requested to change your Pingory account email to this address.\n\nClick the link below to confirm (valid for 24 hours):\n${link}\n\nIf you did not request this, you can safely ignore this email.`;
  const html = `<div style="padding:14px 0 12px;border-bottom:1px solid #e5e7eb;margin-bottom:16px;">
  <img src="${appUrl()}/logo-email.png" width="40" height="40" alt="" style="vertical-align:middle;border-radius:9px;border:1px solid #e5e7eb;"/>
  <span style="font-size:20px;font-weight:700;color:#1faa6b;vertical-align:middle;margin-left:8px;">Pingory</span>
</div>
<p>You requested to change your <b>Pingory</b> account email to this address.</p>
<p>Click the link below to confirm (valid for 24 hours):</p>
<p><a href="${link}">${link}</a></p>
<p>If you did not request this, you can safely ignore this email.</p>`;
  return sendMail(email, subject, text, html);
}
