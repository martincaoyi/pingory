// Pingory Worker API 路由（cf-worker）—— server.js 全部 /api/* 端点 + /health 的 Hono 迁移
// 对账依据：src/cf-worker/PORT-CHECKLIST.md（每端点一行：源行号 / 状态 / 验证方式）。
// 原则：JSON 响应形状、错误码（apiErr 体系）、401/403/404 语义与 Express 版逐字节一致。

import crypto from 'crypto';
import { setCookie } from 'hono/cookie';
import { getPool } from '../db.js';
import { createMonitor, listMonitors, getMonitor, deleteMonitor, saveMonitor, getHistory, getStats, getStatusIncidents, getStatusPage, getStatusPageByHost, getStatusPageAuth, getStatusPageOwnerId, listTeamMonitors } from '../monitors.js';
import { generateMonthlyReport, sendTestAlert } from '../alerts.js';
import { recordUserEvent, listUserEvents, getUserEventSummary, getUserActivityRanking, getDormantUsers } from '../events.js';
import { registerUser, loginUser, getUserById, getUserByEmail, updatePlan, updateStatusPage, createEmailVerification, verifyEmailToken, setRole, addSubscriber, listSubscribers, removeSubscriber, createMaintenanceWindow, listMaintenanceWindows, deleteMaintenanceWindow, ensureApiKey, regenerateApiKey, getUserByApiKey, createTeam, inviteTeamMember, listTeam, leaveTeam, verifyPagePassword, recordReferralConversion, createOAuthUser, recordBillingEvent, changePassword, setPassword, updateProfileName, requestEmailChange, confirmEmailChange, requestPasswordReset, resetPassword, getAlertChannels, saveAlertChannels } from '../auth.js';
import { sendVerificationEmail, sendFeedbackNotification, sendPasswordResetEmail, sendChangeEmailVerification, sendWaitlistConfirmEmail, sendWaitlistAnnounce } from '../email.js';
import { PLAN_LIMITS, planHasType, planHasChannel, planHasStatusPage, planHasStats, planFeatures, planMinInterval, TYPE_LABELS, CHANNEL_LABELS, EMAIL_VERIFY_MONITOR_CAP } from '../plans.js';
import { E, apiErr, reqShim, makeRateLimiter, normalizeTarget, normalizeChannelCfg, parseImportMonitors, statusPageToken, statusPageUnlocked, dailySpark, requireAdmin, requireApiKey } from './util.js';

// ===== 限流器（内存版；多 isolate 下配额减弱，见 util.js 注释）=====
const authLimiter = makeRateLimiter(15, 15 * 60 * 1000);   // 登录/注册/改密码/渠道测试：15 次/15 分钟
const feedbackLimiter = makeRateLimiter(10, 60 * 60 * 1000); // 反馈：10 条/小时
const pwLimiter = makeRateLimiter(5, 60 * 60 * 1000);       // 忘记密码/重置：5 次/小时/IP
const monitorLimiter = makeRateLimiter(60, 60 * 60 * 1000); // 监控创建/导入：60 次/小时/IP
const waitlistLimiter = makeRateLimiter(5, 60 * 60 * 1000); // 邮件订阅：5 次/小时/IP

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function hostnameOf(c) {
  return (new URL(c.req.url).hostname || '').toLowerCase();
}

// 与 server.js 用的 src/events.js parseJSON(v, null) 完全同语义：
// pg 对 JSON 列返回对象，JSON.parse(对象) 会因 "[object Object]" 抛错 → 返回 null（现网即此行为），
// 字符串则正常解析。保持逐字节一致，不做“聪明”的修正。
function safeMetaParse(v) {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

// ===== Creem 配置（server.js 在模块加载时读 env；Worker 的 env 由请求时桥入，故懒取）=====
function creemConfig() {
  const env = process.env;
  return {
    base: env.CREEM_ENVIRONMENT === 'live' ? 'https://api.creem.io/v1' : 'https://test-api.creem.io/v1',
    active: (env.PAYMENT_PROVIDER || 'paddle') === 'creem',
    productPlan: {
      [env.CREEM_STARTER_PRODUCT]: 'starter',
      [env.CREEM_PRO_PRODUCT]: 'pro',
      [env.CREEM_STARTER_ANNUAL_PRODUCT]: 'starter',
      [env.CREEM_PRO_ANNUAL_PRODUCT]: 'pro',
    },
  };
}
function productPlanFromEnv(cfg, productId) {
  if (!productId) return null;
  return cfg.productPlan[productId] || null;
}

// ===== Paddle webhook 验签（server.js 同款）=====
function verifyPaddleSignature(rawBody, secret, signature) {
  if (!signature || !secret) return false;
  const parts = signature.split(';');
  let ts = '';
  let h1 = '';
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (value) {
      if (key === 'ts') ts = value;
      else if (key === 'h1') h1 = value;
    }
  }
  if (!ts || !h1) return false;
  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || Math.abs(now - tsNum) > 300) return false;
  const payload = `${tsNum}:${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return computed === h1;
}

function verifyCreemSignature(rawBody, secret, signature) {
  if (!signature || !secret) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return computed === signature;
}

// OAuth（#287）
function oauthBase() { return (process.env.APP_URL || 'https://pingory.com').replace(/\/$/, ''); }
function oauthStartUrl(provider, ref) {
  const base = oauthBase();
  const state = ref ? 'ref:' + ref : 'x';
  if (provider === 'google') {
    const cid = process.env.GOOGLE_CLIENT_ID;
    if (!cid) return null;
    const redir = encodeURIComponent(base + '/api/auth/oauth/google/callback');
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${cid}&redirect_uri=${redir}&response_type=code&scope=${encodeURIComponent('openid email profile')}&state=${state}`;
  }
  if (provider === 'github') {
    const cid = process.env.GITHUB_CLIENT_ID;
    if (!cid) return null;
    const redir = encodeURIComponent(base + '/api/auth/oauth/github/callback');
    return `https://github.com/login/oauth/authorize?client_id=${cid}&redirect_uri=${redir}&scope=${encodeURIComponent('read:user user:email')}&state=${state}`;
  }
  return null;
}
async function oauthFinish(c, email, name, state, provider) {
  try {
    if (!email) return c.redirect('/signin.html?err=noemail');
    const ref = (typeof state === 'string' && state.startsWith('ref:')) ? state.slice(4) : '';
    const existed = !!(await getUserByEmail(email));
    let user = await getUserByEmail(email);
    if (!user) user = await createOAuthUser(email, name, ref);
    const sess = c.get('session');
    sess.userId = user.id;
    await sess.save();
    recordUserEvent({ userId: user.id, eventType: existed ? 'user_login' : 'user_signup', metadata: { provider }, req: reqShim(c) });
    return c.redirect('/');
  } catch (e) {
    console.error('[oauth] finish 失败:', e.message);
    return c.redirect('/signin.html?err=oauth_create');
  }
}

export function registerApiRoutes(app) {
  // ===== 健康检查（与 server.js /health 响应形状一致）=====
  // 追加 last_check_at：最近一次监控检查的 UTC 毫秒时间戳（monitor_checks.ts 为毫秒）。
  // 用途：/health 只反映 Web 层存活，不反映 cron 检查引擎是否在跑；外部/守护监控
  // 可用 last_check_at 判据发现「引擎停摆但 Web 正常」这类静默故障（10-02 迁移后曾发生）。
  // DB 异常时仅缺字段，不影响 ok 与 Web 层存活判定。
  app.get('/health', async (c) => {
    const body = { ok: true, ts: Date.now(), region: process.env.PROBE_REGION_NAME || 'local' };
    try {
      const pool = await getPool();
      const { rows } = await pool.query('SELECT MAX(ts) AS last_check_ts FROM monitor_checks');
      const t = rows[0]?.last_check_ts;
      if (t != null) body.last_check_at = Number(t);
    } catch (e) {
      console.warn('[health] 读取 last_check_at 失败:', e && e.message);
    }
    return c.json(body);
  });

  // ===== Paddle / Creem 配置（公开）=====
  app.get('/api/paddle-config', (c) => c.json({
    clientToken: process.env.PADDLE_CLIENT_TOKEN,
    environment: process.env.PADDLE_ENVIRONMENT,
    starterPriceId: process.env.STARTER_PRICE_ID,
    proPriceId: process.env.PRO_PRICE_ID,
    starterAnnualPriceId: process.env.STARTER_ANNUAL_PRICE_ID,
    proAnnualPriceId: process.env.PRO_ANNUAL_PRICE_ID,
  }));

  const cc = () => creemConfig();
  app.get('/api/creem-config', (c) => c.json({ active: cc().active, environment: process.env.CREEM_ENVIRONMENT || 'test' }));

  // ===== Paddle Webhook（原始 body 验签）=====
  app.post('/api/paddle/webhook', async (c) => {
    const signatureHeader = c.req.header('paddle-signature');
    const signature = signatureHeader;
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    const rawBody = c.get('rawBody') || '';
    try {
      if (!verifyPaddleSignature(rawBody, secret, signature)) {
        console.error('[webhook] 验签失败');
        return c.text('invalid signature', 400);
      }
      const event = JSON.parse(rawBody);
      console.log('[webhook]', event.event_type, event.data?.id);
      const customerEmail = event.data?.customer?.email;
      const priceId = event.data?.items?.[0]?.price?.id;
      const subId = event.data?.id;
      const custId = event.data?.customer?.id;

      const planFromPrice = (pid) => {
        if (pid === process.env.STARTER_PRICE_ID || pid === process.env.STARTER_ANNUAL_PRICE_ID) return 'starter';
        if (pid === process.env.PRO_PRICE_ID || pid === process.env.PRO_ANNUAL_PRICE_ID) return 'pro';
        return null;
      };
      const billingCycleFromPrice = (pid) => {
        if (pid === process.env.STARTER_ANNUAL_PRICE_ID || pid === process.env.PRO_ANNUAL_PRICE_ID) return 'annual';
        return 'monthly';
      };

      switch (event.event_type) {
        case 'subscription.created':
        case 'subscription.activated':
        case 'subscription.updated': {
          const plan = planFromPrice(priceId);
          if (customerEmail && plan) {
            const u = await getUserByEmail(customerEmail);
            if (u) {
              await updatePlan(u.id, plan, { customerId: custId, subscriptionId: subId });
              recordUserEvent({ userId: u.id, eventType: 'plan_upgrade', metadata: { provider: 'paddle', plan }, req: null });
              console.log(`[webhook] 用户 ${u.email} 升级到 ${plan}`);
              try {
                const priceObj = event.data?.items?.[0]?.price;
                const amount = Number(priceObj?.unit_price?.amount || 0);
                const currency = priceObj?.unit_price?.currency_code || 'USD';
                if (amount > 0) {
                  const commission = Math.round(amount * 0.1);
                  const credited = await recordReferralConversion(u.id, commission, currency);
                  if (credited) console.log(`[webhook] 已向推荐人发放 ${commission} ${currency} 提成（来自 ${u.email}）`);
                }
              } catch (ce) { console.error('[webhook] 推荐提成记录失败:', ce.message); }
              try {
                const bePrice = event.data?.items?.[0]?.price;
                const beAmount = Number(bePrice?.unit_price?.amount || 0);
                const beCurrency = bePrice?.unit_price?.currency_code || 'USD';
                await recordBillingEvent({
                  userId: u.id, provider: 'paddle', eventType: 'subscription_active',
                  plan, billingCycle: billingCycleFromPrice(bePrice?.id),
                  amountCents: beAmount, currency: beCurrency, providerEventId: subId,
                });
              } catch (be) { console.error('[webhook] 账单账本写入失败:', be.message); }
            } else {
              console.log('[webhook] 未找到对应用户（邮箱）:', customerEmail);
            }
          }
          break;
        }
        case 'subscription.canceled':
        case 'subscription.paused': {
          if (customerEmail) {
            const u = await getUserByEmail(customerEmail);
            if (u) {
              await updatePlan(u.id, 'free', { customerId: custId, subscriptionId: null });
              recordUserEvent({ userId: u.id, eventType: 'plan_downgrade', metadata: { provider: 'paddle', plan: 'free' }, req: null });
              console.log(`[webhook] 用户 ${u.email} 降回 free`);
              try {
                await recordBillingEvent({
                  userId: u.id, provider: 'paddle', eventType: 'subscription_canceled',
                  plan: 'free', billingCycle: 'monthly', amountCents: 0, currency: 'USD',
                  providerEventId: (subId || '') + ':cancel',
                });
              } catch (be) { console.error('[webhook] 账单账本写入失败:', be.message); }
            }
          }
          break;
        }
        case 'transaction.paid':
        case 'transaction.completed': {
          console.log('[webhook] 收到付款:', event.data?.details?.totals?.total);
          try {
            if (customerEmail) {
              const u = await getUserByEmail(customerEmail);
              if (u) {
                const bePrice = event.data?.items?.[0]?.price;
                const beTotals = event.data?.details?.totals;
                const beAmount = Number(beTotals?.total?.amount || bePrice?.unit_price?.amount || 0);
                const beCurrency = beTotals?.total?.currency_code || bePrice?.unit_price?.currency_code || 'USD';
                if (beAmount > 0) {
                  await recordBillingEvent({
                    userId: u.id, provider: 'paddle', eventType: 'payment',
                    plan: planFromPrice(bePrice?.id), billingCycle: billingCycleFromPrice(bePrice?.id),
                    amountCents: beAmount, currency: beCurrency, providerEventId: event.data?.id,
                  });
                }
              }
            }
          } catch (be) { console.error('[webhook] 账单账本写入失败:', be.message); }
          break;
        }
        default:
          break;
      }
      return c.text('ok', 200);
    } catch (err) {
      console.error('[webhook] 处理失败:', err.message);
      return c.text('invalid', 400);
    }
  });

  // ===== Creem checkout（需登录）=====
  app.get('/api/creem/checkout', async (c) => {
    if (!cc().active) return c.json(apiErr(E.SERVER_ERROR, { msg: 'Creem checkout not active' }), 400);
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    if (!user) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const plan = c.req.query('plan');
    const annual = c.req.query('annual') === '1' || c.req.query('annual') === 'true';
    if (plan !== 'starter' && plan !== 'pro') return c.json(apiErr(E.INVALID_PLAN), 400);
    const productId = annual
      ? (plan === 'starter' ? process.env.CREEM_STARTER_ANNUAL_PRODUCT : process.env.CREEM_PRO_ANNUAL_PRODUCT)
      : (plan === 'starter' ? process.env.CREEM_STARTER_PRODUCT : process.env.CREEM_PRO_PRODUCT);
    if (!productId) return c.json(apiErr(E.SERVER_ERROR, { msg: 'Creem product not configured' }), 500);
    try {
      const r = await fetch(cc().base + '/checkouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.CREEM_API_KEY },
        body: JSON.stringify({
          product_id: productId,
          success_url: (process.env.APP_URL || 'https://pingory.com') + '/?creem=success',
          customer: { email: user.email },
          metadata: { userId: String(user.id), plan, cycle: annual ? 'yearly' : 'monthly' },
        }),
      });
      const data = await r.json();
      if (!data.checkout_url) return c.json(apiErr(E.SERVER_ERROR, { msg: 'checkout create failed', detail: data }), 500);
      return c.json({ url: data.checkout_url });
    } catch (e) {
      console.error('[creem checkout] 失败:', e.message);
      return c.json(apiErr(E.SERVER_ERROR, { msg: 'checkout create failed' }), 500);
    }
  });

  // ===== Creem Webhook（原始 body 验签）=====
  app.post('/api/creem/webhook', async (c) => {
    const signature = c.req.header('creem-signature');
    const secret = process.env.CREEM_WEBHOOK_SECRET;
    const rawBody = c.get('rawBody') || '';
    try {
      if (!verifyCreemSignature(rawBody, secret, signature)) {
        const computed = crypto.createHmac('sha256', secret || '').update(rawBody).digest('hex');
        console.error('[creem webhook] 验签失败', { received: String(signature || '').slice(0, 24), computed: computed.slice(0, 24), ct: c.req.header('content-type'), bodyLen: rawBody.length, hasSecret: !!secret });
        return c.text('invalid signature', 400);
      }
      const event = JSON.parse(rawBody);
      const eventType = event.event_type || event.eventType;
      console.log('[creem webhook]', eventType, event.id);
      const cfg = cc();
      const obj = event.object || {};
      const meta = obj.metadata || {};
      let u = null;
      if (meta.userId) u = await getUserById(meta.userId);
      if (!u && obj.customer && obj.customer.email) u = await getUserByEmail(obj.customer.email);
      const plan = (meta.plan === 'starter' || meta.plan === 'pro') ? meta.plan
        : productPlanFromEnv(cfg, obj.product?.id || obj.product_id);
      const cycle = meta.cycle === 'yearly' ? 'yearly' : 'monthly';
      const subId = obj.id;
      const custId = obj.customer ? obj.customer.id : null;
      const amount = Number(obj.amount || 0);
      const currency = (obj.currency || 'USD').toUpperCase();

      const grant = async (doCommission) => {
        if (!u || !plan) return;
        await updatePlan(u.id, plan, { customerId: custId, subscriptionId: subId });
        recordUserEvent({ userId: u.id, eventType: 'plan_upgrade', metadata: { provider: 'creem', plan, cycle }, req: null });
        console.log('[creem webhook] 用户', u.email, '升级到', plan);
        try {
          if (doCommission && amount > 0) {
            const commission = Math.round(amount * 0.1);
            const credited = await recordReferralConversion(u.id, commission, currency);
            if (credited) console.log('[creem webhook] 已向推荐人发放', commission, currency, '提成');
          }
        } catch (ce) { console.error('[creem webhook] 推荐提成失败:', ce.message); }
        try {
          await recordBillingEvent({ userId: u.id, provider: 'creem', eventType: 'subscription_active', plan, billingCycle: cycle, amountCents: amount, currency, providerEventId: subId });
        } catch (be) { console.error('[creem webhook] 账单账本失败:', be.message); }
      };
      const revoke = async () => {
        if (!u) return;
        await updatePlan(u.id, 'free', { customerId: custId, subscriptionId: null });
        recordUserEvent({ userId: u.id, eventType: 'plan_downgrade', metadata: { provider: 'creem', plan: 'free' }, req: null });
        console.log('[creem webhook] 用户', u.email, '降回 free');
        try {
          await recordBillingEvent({ userId: u.id, provider: 'creem', eventType: 'subscription_canceled', plan: 'free', billingCycle: cycle, amountCents: 0, currency, providerEventId: (subId || '') + ':cancel' });
        } catch (be) { console.error('[creem webhook] 账单账本失败:', be.message); }
      };

      switch (eventType) {
        case 'subscription.active':
        case 'subscription.trialing':
          await grant(true); break;
        case 'subscription.paid':
          await grant(false); break;
        case 'subscription.canceled':
        case 'subscription.expired':
        case 'subscription.paused':
          await revoke(); break;
        case 'refund.created':
          try { if (u) await recordBillingEvent({ userId: u.id, provider: 'creem', eventType: 'refund', plan, billingCycle: cycle, amountCents: amount, currency, providerEventId: (obj.id || '') + ':refund' }); } catch (be) { console.error('[creem webhook] refund 账本失败:', be.message); }
          break;
        default: break;
      }
      return c.text('ok', 200);
    } catch (err) {
      console.error('[creem webhook] 处理失败:', err.message);
      return c.text('invalid', 400);
    }
  });

  // ===== 页面分析 =====
  app.post('/api/analytics/start', async (c) => {
    try {
      const body = c.get('body') || {};
      const sid = String(body?.sid || '').slice(0, 64) || crypto.randomUUID();
      const country = String(c.req.header('cf-ipcountry') || c.req.header('x-country') || '').toUpperCase().slice(0, 2) || 'unknown';
      const sess = c.get('session');
      const userId = (sess && sess.userId) || null;
      const pool = await getPool();
      await pool.query(
        `INSERT INTO page_sessions (id, country, user_id, started_at, last_seen_at, duration_seconds, page_count)
         VALUES ($1, $2, $3, now(), now(), 0, 1)
         ON CONFLICT (id) DO UPDATE SET
           last_seen_at = now(),
           page_count = page_sessions.page_count + 1,
           user_id = COALESCE(EXCLUDED.user_id, page_sessions.user_id)`,
        [sid, country, userId]
      );
      return c.json({ ok: true, sid });
    } catch (err) {
      console.error('[analytics start]', err.message);
      return c.json(apiErr(E.SERVER_ERROR, { msg: 'analytics error' }), 500);
    }
  });

  app.post('/api/analytics/ping', async (c) => {
    try {
      const body = c.get('body') || {};
      const sid = String(body?.sid || '').slice(0, 64);
      if (!sid) return c.json(apiErr(E.SERVER_ERROR, { msg: 'missing sid' }), 400);
      const pool = await getPool();
      await pool.query(
        `UPDATE page_sessions
         SET duration_seconds = duration_seconds + 30,
             last_seen_at = now()
         WHERE id = $1 AND last_seen_at > now() - interval '5 minutes'`,
        [sid]
      );
      return c.json({ ok: true });
    } catch (err) {
      console.error('[analytics ping]', err.message);
      return c.json(apiErr(E.SERVER_ERROR, { msg: 'analytics error' }), 500);
    }
  });

  // ===== 认证 =====
  app.post('/api/auth/register', authLimiter, async (c) => {
    try {
      const { email, password, name, referralCode } = c.get('body') || {};
      const user = await registerUser(email, password, name, referralCode);
      const sess = c.get('session');
      sess.userId = user.id;
      await sess.save();
      const token = await createEmailVerification(user.email);
      if (token) await sendVerificationEmail(user.email, token);
      recordUserEvent({ userId: user.id, eventType: 'user_signup', metadata: { provider: 'email' }, req: reqShim(c) });
      return c.json({ user, needsVerification: true }, 201);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 400);
    }
  });

  app.post('/api/auth/login', authLimiter, async (c) => {
    try {
      const { email, password } = c.get('body') || {};
      const user = await loginUser(email, password);
      const sess = c.get('session');
      sess.userId = user.id;
      await sess.save();
      recordUserEvent({ userId: user.id, eventType: 'user_login', metadata: { provider: 'email' }, req: reqShim(c) });
      return c.json({ user });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 401);
    }
  });

  app.get('/api/auth/verify-email', async (c) => {
    const token = c.req.query('token');
    const user = await verifyEmailToken(token);
    if (!user) return c.json({ ok: false, error: E.INVALID_CONFIRM_LINK }, 400);
    recordUserEvent({ userId: user.id, eventType: 'email_verified', metadata: { provider: 'email' }, req: reqShim(c) });
    return c.json({ ok: true, email: user.email });
  });

  app.post('/api/auth/resend-verify', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    if (!user) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    if (user.emailVerified) return c.json({ ok: true, already: true });
    const token = await createEmailVerification(user.email);
    if (!token) return c.json(apiErr(E.SERVER_ERROR, { msg: 'Account does not exist' }), 400);
    await sendVerificationEmail(user.email, token);
    return c.json({ ok: true });
  });

  app.post('/api/auth/logout', async (c) => {
    const sess = c.get('session');
    await sess.destroy();
    return c.json({ ok: true });
  });

  // ===== OAuth =====
  app.get('/api/auth/oauth/:provider/start', (c) => {
    const provider = c.req.param('provider');
    const refRaw = c.req.query('ref');
    const ref = (typeof refRaw === 'string' && refRaw.trim()) ? refRaw.trim() : '';
    const url = oauthStartUrl(provider, ref);
    if (!url) return c.text('OAuth not configured for ' + provider, 400);
    return c.redirect(url);
  });

  app.get('/api/auth/oauth/google/callback', async (c) => {
    try {
      const code = c.req.query('code');
      const state = c.req.query('state');
      if (!code) return c.redirect('/signin.html?err=google_code');
      const base = oauthBase();
      const tokRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: base + '/api/auth/oauth/google/callback', grant_type: 'authorization_code',
        }),
      });
      const tok = await tokRes.json();
      if (!tok.access_token) { console.error('[oauth google] token 失败:', tok.error, tok.error_description); return c.redirect('/signin.html?err=google_token'); }
      const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } });
      const info = await infoRes.json();
      return await oauthFinish(c, (info.email || '').toLowerCase(), info.name || '', state, 'google');
    } catch (e) { console.error('[oauth google]', e.message); return c.redirect('/signin.html?err=google_err'); }
  });

  app.get('/api/auth/oauth/github/callback', async (c) => {
    try {
      const code = c.req.query('code');
      const state = c.req.query('state');
      if (!code) return c.redirect('/signin.html?err=gh_code');
      const base = oauthBase();
      const tokRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code, client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET,
          redirect_uri: base + '/api/auth/oauth/github/callback',
        }),
      });
      const tok = await tokRes.json();
      if (!tok.access_token) { console.error('[oauth github] token 失败:', tok.error, tok.error_description); return c.redirect('/signin.html?err=gh_token'); }
      const ghRes = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + tok.access_token, 'User-Agent': 'pingory' } });
      const gh = await ghRes.json();
      const emRes = await fetch('https://api.github.com/user/emails', { headers: { Authorization: 'Bearer ' + tok.access_token, 'User-Agent': 'pingory' } });
      const ems = await emRes.json();
      let email = (gh.email || '').toLowerCase();
      if (!email && Array.isArray(ems)) {
        const primary = ems.find((e) => e.primary && e.verified) || ems.find((e) => e.verified) || ems[0];
        if (primary) email = (primary.email || '').toLowerCase();
      }
      return await oauthFinish(c, email, gh.name || gh.login || '', state, 'github');
    } catch (e) { console.error('[oauth github]', e.message); return c.redirect('/signin.html?err=gh_err'); }
  });

  app.get('/api/me', async (c) => {
    const sess = c.get('session');
    if (!sess.userId) return c.json({ user: null });
    const user = await getUserById(sess.userId);
    return c.json({ user: user || null });
  });

  // ===== 监控 CRUD =====
  app.post('/api/monitors', monitorLimiter, async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    const plan = user?.plan ?? 'free';
    const limit = user?.monitorLimit != null ? user.monitorLimit : (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free);
    const count = (await listMonitors(userId)).length;
    if (count >= limit) {
      return c.json(apiErr(E.PLAN_MONITOR_LIMIT, { plan, limit }), 403);
    }
    if (!user?.emailVerified && count >= EMAIL_VERIFY_MONITOR_CAP) {
      return c.json(apiErr(E.EMAIL_VERIFY_REQUIRED, { cap: EMAIL_VERIFY_MONITOR_CAP }), 403);
    }
    const { url, name, interval, type: rawType, config = {}, channels = null, statusPublic = false } = c.get('body') || {};
    const type = (rawType == null || String(rawType).trim() === '') ? 'http' : String(rawType).trim();
    if (!url) return c.json(apiErr(E.URL_REQUIRED), 400);
    if (!planHasType(plan, type)) {
      return c.json(apiErr(E.PLAN_TYPE_NOT_SUPPORTED, { plan, type: TYPE_LABELS[type] || type }), 403);
    }
    const minInterval = planMinInterval(plan);
    const parsedInterval = interval ? Number(interval) : minInterval;
    if (parsedInterval < minInterval) {
      return c.json(apiErr(E.PLAN_MIN_INTERVAL, { plan, minInterval }), 400);
    }
    const nres = normalizeTarget(type, url);
    if (nres.err) return c.json(nres.err, 400);

    let safeChannels = null;
    if (channels && typeof channels === 'object') {
      safeChannels = {};
      for (const [ch, cfg] of Object.entries(channels)) {
        if (cfg && cfg.enabled && planHasChannel(plan, ch)) safeChannels[ch] = cfg;
      }
    }
    const finalPublic = statusPublic && planHasStatusPage(plan);

    try {
      const monitor = createMonitor({
        url: nres.url,
        name: name ? String(name).trim() : null,
        interval: parsedInterval,
        type,
        config,
        channels: safeChannels,
        statusPublic: finalPublic,
        userId,
      });
      await saveMonitor(monitor);
      recordUserEvent({ userId, eventType: 'monitor_create', metadata: { url: monitor.url, type: monitor.type, interval: monitor.interval }, req: reqShim(c) });
      return c.json(monitor, 201);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 400);
    }
  });

  app.post('/api/monitors/import', monitorLimiter, async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    const plan = user?.plan ?? 'free';
    const { format, data } = c.get('body') || {};
    if (!['uptimerobot', 'csv', 'json'].includes(format)) return c.json(apiErr(E.IMPORT_UNSUPPORTED), 400);
    if (!data || typeof data !== 'string' || !data.trim()) return c.json(apiErr(E.IMPORT_NO_DATA), 400);
    let rows;
    try { rows = parseImportMonitors(format, data); }
    catch (e) { return c.json(apiErr(E.IMPORT_PARSE_FAILED, { msg: e.message }), 400); }
    if (!rows.length) return c.json(apiErr(E.IMPORT_NO_MONITORS), 400);
    const limit = user?.monitorLimit != null ? user.monitorLimit : (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free);
    const minInterval = planMinInterval(plan);
    let created = 0, skipped = 0; const reasons = new Set();
    for (const r of rows) {
      if ((await listMonitors(userId)).length >= limit) { reasons.add('plan monitor limit reached'); break; }
      let type = (r.type || 'http').toString().toLowerCase();
      if (!planHasType(plan, type)) type = 'http';
      const url = (r.url || '').toString().trim();
      if (!url) { skipped++; reasons.add('missing url'); continue; }
      const parsedInterval = r.interval ? Number(r.interval) : minInterval;
      const finalInterval = parsedInterval >= minInterval ? parsedInterval : minInterval;
      const nres = normalizeTarget(type, url);
      if (nres.err) { skipped++; reasons.add(nres.err.ep && nres.err.ep.msg ? nres.err.ep.msg : nres.err.error); continue; }
      try {
        const monitor = createMonitor({
          url: nres.url, name: r.name ? String(r.name).trim() : null,
          interval: finalInterval, type, config: r.config || {}, channels: null, statusPublic: false, userId,
        });
        await saveMonitor(monitor);
        created++;
      } catch (e) { skipped++; reasons.add(e.message); }
    }
    recordUserEvent({ userId, eventType: 'monitor_import', metadata: { format, created, skipped }, req: reqShim(c) });
    return c.json({ ok: true, created, skipped, skippedReasons: [...reasons] });
  });

  app.patch('/api/monitors/:id', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      const m = await getMonitor(c.req.param('id'));
      if (!m || m.userId !== userId) return c.json(apiErr(E.MONITOR_NOT_FOUND), 404);
      const plan = (await getUserById(userId))?.plan ?? 'free';
      const { config, channels, statusPublic, interval, name } = c.get('body') || {};
      if (config !== undefined) m.config = config;
      if (interval !== undefined) {
        const minI = planMinInterval(plan);
        const v = Number(interval);
        if (v < minI) return c.json(apiErr(E.PLAN_MIN_INTERVAL, { plan, minInterval: minI }), 400);
        m.interval = v;
      }
      if (name !== undefined) m.name = String(name).trim() || m.url;
      if (statusPublic !== undefined) m.statusPublic = !!statusPublic && planHasStatusPage(plan);
      if (channels !== undefined && typeof channels === 'object') {
        const safe = {};
        for (const [ch, cfg] of Object.entries(channels)) {
          if (cfg && cfg.enabled && planHasChannel(plan, ch)) safe[ch] = cfg;
        }
        m.channels = safe;
      }
      await saveMonitor(m);
      recordUserEvent({ userId, eventType: 'monitor_update', metadata: { id: m.id, url: m.url, type: m.type }, req: reqShim(c) });
      return c.json(m);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/monitors/:id/stats', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      const m = await getMonitor(c.req.param('id'));
      if (!m || m.userId !== userId) return c.json(apiErr(E.MONITOR_NOT_FOUND), 404);
      const plan = (await getUserById(userId))?.plan ?? 'free';
      if (!planHasStats(plan)) return c.json(apiErr(E.TREND_REQUIRES_STARTER), 403);
      const days = Number(c.req.query('days')) || 30;
      const stats = await getStats(c.req.param('id'), days);
      return c.json(stats);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/heartbeat/:id', async (c) => {
    try {
      const m = await getMonitor(c.req.param('id'));
      if (!m) return c.json(apiErr(E.MONITOR_NOT_FOUND), 404);
      m.lastSuccessAt = Date.now();
      if (m.status === 'down') m.status = 'up';
      await saveMonitor(m);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/monitors', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      const monitors = await listMonitors(userId);
      return c.json(monitors);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.delete('/api/monitors/:id', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      const m = await getMonitor(c.req.param('id'));
      const ok = await deleteMonitor(c.req.param('id'), userId);
      if (!ok) return c.json(apiErr(E.MONITOR_NO_PERM), 404);
      recordUserEvent({ userId, eventType: 'monitor_delete', metadata: { id: c.req.param('id'), url: m?.url, type: m?.type }, req: reqShim(c) });
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/monitors/:id/history', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      const m = await getMonitor(c.req.param('id'));
      if (!m || m.userId !== userId) return c.json(apiErr(E.MONITOR_NOT_FOUND), 404);
      const events = await getHistory(c.req.param('id'), 50);
      return c.json(events);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // ===== 公开状态页数据 =====
  app.get('/api/status/:slug', async (c) => {
    try {
      const slug = c.req.param('slug');
      const page = await getStatusPage(slug);
      if (!page) return c.json(apiErr(E.SP_NOT_FOUND), 404);
      if (page.private && !statusPageUnlocked(c, slug)) {
        return c.json({ needsPassword: true, whiteLabel: page.whiteLabel }, 401);
      }
      const enriched = await Promise.all(page.monitors.map(async (m) => {
        const s = await getStats(m.id, 30);
        return { ...m, uptime: s.uptime, avgRt: s.avgRt, spark: dailySpark(s.series) };
      }));
      const incidents = await getStatusIncidents(page.monitors.map((m) => m.id), 30, 20);
      return c.json({ title: page.title, whiteLabel: page.whiteLabel, monitors: enriched, incidents });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // 自定义域名：按 Host 解析状态页
  app.get('/api/status-page', async (c) => {
    try {
      const host = hostnameOf(c);
      const page = await getStatusPageByHost(host);
      if (!page) return c.json(apiErr(E.SP_NO_DOMAIN), 404);
      if (page.private && !statusPageUnlocked(c, host)) {
        return c.json({ needsPassword: true, whiteLabel: page.whiteLabel }, 401);
      }
      const enriched = await Promise.all(page.monitors.map(async (m) => {
        const s = await getStats(m.id, 30);
        return { ...m, uptime: s.uptime, avgRt: s.avgRt, spark: dailySpark(s.series) };
      }));
      const incidents = await getStatusIncidents(page.monitors.map((m) => m.id), 30, 20);
      return c.json({ title: page.title, whiteLabel: page.whiteLabel, monitors: enriched, incidents });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // 私有状态页解锁（slug）
  app.post('/api/status/:slug/unlock', async (c) => {
    try {
      const slug = c.req.param('slug');
      const auth = await getStatusPageAuth(slug, false);
      if (!auth) return c.json(apiErr(E.SP_NOT_FOUND), 404);
      const { password } = c.get('body') || {};
      const ok = await verifyPagePassword(password || '', auth.passwordHash);
      if (!ok) return c.json(apiErr(E.WRONG_PASSWORD), 401);
      setCookie(c, 'pingory_sp', `${slug}|${statusPageToken(slug)}`, { httpOnly: true, sameSite: 'Lax', maxAge: 7 * 86400 });
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // 私有状态页解锁（自定义域名，按 Host）
  app.post('/api/status-page/unlock', async (c) => {
    try {
      const host = hostnameOf(c);
      const auth = await getStatusPageAuth(host, true);
      if (!auth) return c.json(apiErr(E.SP_NO_DOMAIN), 404);
      const { password } = c.get('body') || {};
      const ok = await verifyPagePassword(password || '', auth.passwordHash);
      if (!ok) return c.json(apiErr(E.WRONG_PASSWORD), 401);
      setCookie(c, 'pingory_sp', `${host}|${statusPageToken(host)}`, { httpOnly: true, sameSite: 'Lax', maxAge: 7 * 86400 });
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // 订阅状态页（slug）
  app.post('/api/status/:slug/subscribe', async (c) => {
    try {
      const slug = c.req.param('slug');
      const ownerId = await getStatusPageOwnerId(slug, false);
      if (!ownerId) return c.json(apiErr(E.SP_NOT_FOUND), 404);
      const { email } = c.get('body') || {};
      const added = await addSubscriber(ownerId, email);
      recordUserEvent({ userId: ownerId, eventType: 'subscriber_add', metadata: { email: added, source: 'status_page' }, req: reqShim(c) });
      return c.json({ ok: true, email: added });
    } catch (err) {
      return c.json({ error: err.message }, 400); // 与 server.js 一致：裸 error 串（非 apiErr）
    }
  });

  // 订阅状态页（自定义域名，按 Host）
  app.post('/api/status-page/subscribe', async (c) => {
    try {
      const host = hostnameOf(c);
      const ownerId = await getStatusPageOwnerId(host, true);
      if (!ownerId) return c.json(apiErr(E.SP_NO_DOMAIN), 404);
      const { email } = c.get('body') || {};
      const added = await addSubscriber(ownerId, email);
      recordUserEvent({ userId: ownerId, eventType: 'subscriber_add', metadata: { email: added, source: 'status_page_custom_domain' }, req: reqShim(c) });
      return c.json({ ok: true, email: added });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 400);
    }
  });

  // 订阅者管理
  app.get('/api/me/subscribers', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const list = await listSubscribers(userId);
    return c.json(list);
  });

  app.delete('/api/me/subscribers/:id', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const ok = await removeSubscriber(userId, c.req.param('id'));
    if (ok) recordUserEvent({ userId, eventType: 'subscriber_remove', metadata: { id: c.req.param('id') }, req: reqShim(c) });
    return c.json({ ok });
  });

  // 状态页设置
  app.patch('/api/me/status-page', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    if (!planHasStatusPage(user?.plan)) return c.json(apiErr(E.SP_REQUIRES_STARTER), 403);
    const { enabled, slug, customDomain, whiteLabel, password, title } = c.get('body') || {};
    if ((customDomain !== undefined || whiteLabel !== undefined || password !== undefined || title !== undefined) && user.plan !== 'pro') {
      return c.json(apiErr(E.SP_PRO_ONLY), 403);
    }
    await updateStatusPage(userId, { enabled, slug, customDomain, whiteLabel, password, title });
    recordUserEvent({ userId, eventType: 'status_page_update', metadata: { enabled, slug, customDomain, whiteLabel, title }, req: reqShim(c) });
    const updated = await getUserById(userId);
    return c.json({ user: updated });
  });

  // 套餐能力
  app.get('/api/plan-features', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    const plan = user?.plan ?? 'free';
    return c.json({ plan, features: planFeatures(plan), typeLabels: TYPE_LABELS, channelLabels: CHANNEL_LABELS, minInterval: planMinInterval(plan) });
  });

  // ===== 客户反馈 =====
  app.post('/api/feedback', feedbackLimiter, async (c) => {
    try {
      const { message, email, page } = c.get('body') || {};
      if (!message || !String(message).trim()) return c.json(apiErr(E.FEEDBACK_EMPTY), 400);
      if (String(message).length > 2000) return c.json(apiErr(E.FEEDBACK_TOO_LONG), 400);
      const sess = c.get('session');
      const userId = (sess && sess.userId) || null;
      const id = crypto.randomUUID();
      const refPage = (page ? String(page) : (c.req.header('referer') || '')).slice(0, 500);
      const normEmail = email ? String(email).trim().toLowerCase()
        : (userId ? (await getUserById(userId))?.email : null);
      const pool = await getPool();
      await pool.query(
        `INSERT INTO feedback (id, user_id, email, message, page) VALUES ($1,$2,$3,$4,$5)`,
        [id, userId, normEmail, String(message).trim(), refPage]
      );
      await sendFeedbackNotification({ email: normEmail, message: String(message).trim(), page: refPage });
      recordUserEvent({ userId, eventType: 'feedback_submit', metadata: { email: normEmail, page: refPage }, req: reqShim(c) });
      return c.json({ ok: true }, 201);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // ===== 邮件订阅名单（waitlist ×4）=====
  app.post('/api/waitlist', waitlistLimiter, async (c) => {
    try {
      const { email, lang, source, hz } = c.get('body') || {};
      if (hz) return c.json({ ok: true }, 201); // 蜜罐：假装成功
      if (!email || !EMAIL_RE.test(String(email).trim()) || String(email).trim().length > 254) {
        return c.json(apiErr(E.WAITLIST_EMAIL_INVALID), 400);
      }
      const normEmail = String(email).trim().toLowerCase();
      const normLang = (lang && /^[a-z]{2}$/.test(String(lang)) ? String(lang) : 'en').toLowerCase();
      const normSource = (source ? String(source).replace(/[^a-z0-9_-]/gi, '').slice(0, 32) : 'homepage') || 'homepage';
      const token = crypto.randomBytes(18).toString('base64url');
      const db = await getPool();

      const inserted = await db.query(
        `INSERT INTO waitlist (id, email, lang, source, unsubscribe_token)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING RETURNING id`,
        [crypto.randomUUID(), normEmail, normLang, normSource, token]
      );

      if (inserted.rowCount === 0) {
        const { rows } = await db.query(
          `SELECT unsubscribe_token FROM waitlist
           WHERE email = $1 AND confirmed_at IS NULL AND created_at > now() - interval '24 hours'`,
          [normEmail]
        );
        if (rows[0]) await sendWaitlistConfirmEmail(normEmail, rows[0].unsubscribe_token);
        return c.json({ ok: true }, 201);
      }

      await sendWaitlistConfirmEmail(normEmail, token);
      recordUserEvent({ userId: null, eventType: 'waitlist_signup', metadata: { source: normSource, lang: normLang }, req: reqShim(c) });
      return c.json({ ok: true }, 201);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/waitlist/confirm', async (c) => {
    try {
      const token = String(c.req.query('token') || '');
      if (!token) return c.json(apiErr(E.WAITLIST_TOKEN_INVALID), 400);
      const db = await getPool();
      const { rowCount } = await db.query(
        `UPDATE waitlist SET confirmed_at = now()
         WHERE unsubscribe_token = $1 AND confirmed_at IS NULL AND created_at > now() - interval '7 days'`,
        [token]
      );
      return c.json({ ok: rowCount > 0 });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/waitlist/unsubscribe', async (c) => {
    try {
      const token = String(c.req.query('token') || '');
      if (!token) return c.json(apiErr(E.WAITLIST_TOKEN_INVALID), 400);
      const db = await getPool();
      await db.query('DELETE FROM waitlist WHERE unsubscribe_token = $1', [token]);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // ===== 管理员：waitlist =====
  app.get('/api/admin/waitlist', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const db = await getPool();
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(confirmed_at)::int AS confirmed
         FROM waitlist`
      );
      const wantExport = String(c.req.query('export') || '') === '1';
      const out = { total: rows[0].total, confirmed: rows[0].confirmed };
      if (wantExport) {
        const { rows: list } = await db.query(
          `SELECT email FROM waitlist WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at`
        );
        out.emails = list.map((r) => r.email);
        const sess = c.get('session');
        recordUserEvent({ userId: sess.userId, eventType: 'waitlist_export', req: reqShim(c) });
      }
      return c.json(out);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/waitlist/announce', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const { subject, body } = c.get('body') || {};
      if (!subject || !body) return c.json(apiErr(E.FEEDBACK_EMPTY), 400);
      const db = await getPool();
      const { rows } = await db.query(
        `SELECT email, unsubscribe_token FROM waitlist WHERE confirmed_at IS NOT NULL ORDER BY confirmed_at`
      );
      let sent = 0, failed = 0;
      for (const r of rows) {
        const ok = await sendWaitlistAnnounce(r.email, r.unsubscribe_token, String(subject).slice(0, 200), String(body).slice(0, 5000));
        if (ok) sent++; else failed++;
      }
      const sess = c.get('session');
      recordUserEvent({ userId: sess.userId, eventType: 'waitlist_announce', metadata: { sent, failed }, req: reqShim(c) });
      return c.json({ ok: true, recipients: rows.length, sent, failed });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  // ===== 管理员：统计 / 用户 / 监控 / 反馈 / 事件 =====
  app.get('/api/admin/stats', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const pool = await getPool();
      const users = await pool.query('SELECT COUNT(*) FROM users');
      const monitors = await pool.query('SELECT COUNT(*) FROM monitors');
      const down = await pool.query("SELECT COUNT(*) FROM monitors WHERE status = 'down'");
      const fb = await pool.query("SELECT COUNT(*) FROM feedback WHERE status = 'new'");
      const paid = await pool.query("SELECT COUNT(*) FROM users WHERE plan <> 'free'");
      return c.json({
        users: Number(users.rows[0].count),
        paidUsers: Number(paid.rows[0].count),
        monitors: Number(monitors.rows[0].count),
        downMonitors: Number(down.rows[0].count),
        newFeedback: Number(fb.rows[0].count),
        serverUptime: Math.floor(process.uptime()),
        env: (process.env.PAYMENT_PROVIDER || 'paddle') === 'creem'
          ? (process.env.CREEM_ENVIRONMENT || 'test')
          : (process.env.PADDLE_ENVIRONMENT || 'sandbox'),
      });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/admin/users', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const pool = await getPool();
      const q = c.req.query('q'), plan = c.req.query('plan'), role = c.req.query('role'), banned = c.req.query('banned');
      const where = [];
      const params = [];
      let i = 1;
      if (q) { where.push(`(u.email ILIKE $${i} OR u.name ILIKE $${i})`); params.push('%' + String(q) + '%'); i++; }
      if (plan) { where.push(`u.plan = $${i++}`); params.push(plan); }
      if (role) { where.push(`u.role = $${i++}`); params.push(role); }
      if (banned === 'true') where.push('u.banned = true');
      else if (banned === 'false') where.push('u.banned = false');
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const { rows } = await pool.query(
        `SELECT u.id, u.email, u.name, u.plan, u.role, u.email_verified, u.banned, u.monitor_limit, u.last_login, u.created_at,
                (SELECT COUNT(*) FROM monitors m WHERE m.user_id = u.id) AS monitor_count
         FROM users u ${w} ORDER BY u.created_at DESC LIMIT 500`,
        params
      );
      return c.json(rows.map((r) => ({
        ...r,
        monitorCount: Number(r.monitor_count),
        banned: !!r.banned,
        monitorLimit: r.monitor_limit ?? null,
        lastLogin: r.last_login ?? null,
      })));
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/admin/users/:id', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const pool = await getPool();
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [c.req.param('id')]);
      if (rows.length === 0) return c.json(apiErr(E.USER_NOT_FOUND), 404);
      const u = rows[0];
      const mon = await pool.query(
        'SELECT id, name, url, type, status, interval, last_checked FROM monitors WHERE user_id = $1 ORDER BY created_at DESC',
        [u.id]
      );
      const sub = await pool.query('SELECT COUNT(*) FROM status_subscribers WHERE user_id = $1', [u.id]);
      const events = await pool.query(
        `SELECT event_type, metadata, created_at FROM user_events
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [u.id]
      );
      return c.json({
        id: u.id, email: u.email, name: u.name, plan: u.plan, role: u.role,
        emailVerified: !!u.email_verified, banned: !!u.banned,
        monitorLimit: u.monitor_limit ?? null, lastLogin: u.last_login ?? null,
        createdAt: u.created_at, monitorCount: Number(mon.rowCount),
        subscriberCount: Number(sub.rows[0].count), monitors: mon.rows,
        events: events.rows.map((r) => ({ eventType: r.event_type, metadata: safeMetaParse(r.metadata), createdAt: r.created_at })),
      });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/users/:id/ban', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const sess = c.get('session');
      if (sess.userId === c.req.param('id')) return c.json(apiErr(E.SELF_BAN), 400);
      const { banned } = c.get('body') || {};
      const pool = await getPool();
      await pool.query('UPDATE users SET banned = $2 WHERE id = $1', [c.req.param('id'), banned ? true : false]);
      recordUserEvent({ userId: c.get('admin').id, eventType: 'admin_ban_user', metadata: { targetUserId: c.req.param('id'), banned: !!banned }, req: reqShim(c) });
      return c.json({ ok: true, banned: !!banned });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/users/:id/delete', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const sess = c.get('session');
      if (sess.userId === c.req.param('id')) return c.json(apiErr(E.SELF_DELETE), 400);
      const pool = await getPool();
      recordUserEvent({ userId: c.get('admin').id, eventType: 'admin_delete_user', metadata: { targetUserId: c.req.param('id') }, req: reqShim(c) });
      await pool.query('DELETE FROM monitors WHERE user_id = $1', [c.req.param('id')]);
      await pool.query('DELETE FROM users WHERE id = $1', [c.req.param('id')]);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/users/:id/quota', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const { limit } = c.get('body') || {};
      const lim = (limit === null || limit === '' || limit === undefined) ? null : Number(limit);
      if (lim !== null && (!Number.isInteger(lim) || lim < 1)) return c.json(apiErr(E.INVALID_MONITOR_LIMIT), 400);
      const pool = await getPool();
      await pool.query('UPDATE users SET monitor_limit = $2 WHERE id = $1', [c.req.param('id'), lim]);
      recordUserEvent({ userId: c.get('admin').id, eventType: 'admin_set_quota', metadata: { targetUserId: c.req.param('id'), limit: lim }, req: reqShim(c) });
      return c.json({ ok: true, monitorLimit: lim });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/admin/monitors', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const pool = await getPool();
      const { rows } = await pool.query(
        `SELECT m.id, m.url, m.name, m.type, m.status, m.interval, m.last_checked,
                u.email AS owner_email
         FROM monitors m LEFT JOIN users u ON u.id = m.user_id
         ORDER BY m.last_checked DESC NULLS LAST LIMIT 500`
      );
      return c.json(rows);
    } catch (err) {
      return c.json({ error: err.message }, 500); // 与 server.js 一致（非 apiErr）
    }
  });

  app.get('/api/admin/feedback', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const pool = await getPool();
      const { rows } = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 200');
      return c.json(rows);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/users/:id/plan', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const { plan } = c.get('body') || {};
      if (!['free', 'starter', 'pro'].includes(plan)) return c.json(apiErr(E.INVALID_PLAN), 400);
      await updatePlan(c.req.param('id'), plan);
      recordUserEvent({ userId: c.get('admin').id, eventType: 'admin_set_plan', metadata: { targetUserId: c.req.param('id'), plan }, req: reqShim(c) });
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/users/:id/role', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const { role } = c.get('body') || {};
      await setRole(c.req.param('id'), role === 'admin' ? 'admin' : 'user');
      recordUserEvent({ userId: c.get('admin').id, eventType: 'admin_set_role', metadata: { targetUserId: c.req.param('id'), role }, req: reqShim(c) });
      return c.json({ ok: true });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/impersonate/:id', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    const sess = c.get('session');
    sess.userId = c.req.param('id');
    await sess.save(); // Express 版由 modified-session 自动落库；此处显式 save 等价
    return c.json({ ok: true });
  });

  app.get('/api/admin/analytics', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const pool = await getPool();
      const totalRes = await pool.query('SELECT COUNT(*) FROM users');
      const totalUsers = Number(totalRes.rows[0].count);
      const planRes = await pool.query('SELECT plan, COUNT(*) AS c FROM users GROUP BY plan');
      const planMap = {};
      planRes.rows.forEach((r) => { planMap[r.plan] = Number(r.c); });
      const paidUsers = (planMap.starter || 0) + (planMap.pro || 0);
      const freeUsers = planMap.free || 0;

      const revRes = await pool.query(`
        SELECT COALESCE(SUM(amount_cents),0) AS total,
               COALESCE(SUM(CASE WHEN ts >= now() - interval '30 days' THEN amount_cents END),0) AS last30,
               (SELECT currency FROM billing_events ORDER BY ts DESC LIMIT 1) AS cur
        FROM billing_events`);
      const totalCents = Number(revRes.rows[0].total);
      const rev30Cents = Number(revRes.rows[0].last30);
      const currency = revRes.rows[0].cur || 'USD';

      const mrrRes = await pool.query(`
        SELECT COALESCE(SUM(CASE WHEN billing_cycle='annual' THEN amount_cents/12.0 ELSE amount_cents END),0) AS mrr
        FROM billing_events WHERE ts >= now() - interval '30 days' AND event_type <> 'subscription_canceled'`);
      const mrrCents = Math.round(Number(mrrRes.rows[0].mrr));

      const byProvider = await pool.query(`
        SELECT provider, COALESCE(SUM(amount_cents),0) AS cents FROM billing_events GROUP BY provider ORDER BY cents DESC`);
      const todayRes = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS new_users,
          (SELECT COALESCE(SUM(amount_cents),0) FROM billing_events
            WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AND event_type <> 'subscription_canceled') AS today_cents,
          (SELECT COUNT(*) FROM monitors) AS total_monitors`);
      const todayNewUsers = Number(todayRes.rows[0].new_users);
      const todayCents = Number(todayRes.rows[0].today_cents);
      const totalMonitors = Number(todayRes.rows[0].total_monitors);

      const sessRes = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM page_sessions WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS sessions,
          (SELECT COUNT(*) FROM page_sessions) AS total_sessions,
          (SELECT COALESCE(AVG(duration_seconds),0)::int FROM page_sessions WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS avg_duration,
          (SELECT COUNT(*) FROM page_sessions WHERE last_seen_at >= now() - interval '5 minutes') AS online_now`);
      const todaySessions = Number(sessRes.rows[0].sessions);
      const totalSessions = Number(sessRes.rows[0].total_sessions);
      const avgDurationSec = Number(sessRes.rows[0].avg_duration);
      const onlineNow = Number(sessRes.rows[0].online_now);
      const countriesRes = await pool.query(`
        SELECT COALESCE(NULLIF(country,''), 'unknown') AS country, COUNT(*) AS c
        FROM page_sessions
        WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC')
        GROUP BY COALESCE(NULLIF(country,''), 'unknown')
        ORDER BY c DESC LIMIT 8`);
      const newUsers30 = await pool.query(`
        SELECT to_char(created_at, 'YYYY-MM-DD') AS d, COUNT(*) AS c FROM users
        WHERE created_at >= now() - interval '30 days' GROUP BY d ORDER BY d`);
      const revenue30 = await pool.query(`
        SELECT to_char(ts, 'YYYY-MM-DD') AS d, COALESCE(SUM(amount_cents),0) AS cents FROM billing_events
        WHERE ts >= now() - interval '30 days' AND event_type <> 'subscription_canceled' GROUP BY d ORDER BY d`);

      const conversionRate = totalUsers ? +((paidUsers / totalUsers) * 100).toFixed(1) : 0;
      const arpuCents = totalUsers ? Math.round(totalCents / totalUsers) : 0;

      return c.json({
        currency,
        todayNewUsers, todayCents, totalMonitors,
        todaySessions, totalSessions, avgDurationSec, onlineNow,
        topCountries: countriesRes.rows.map((r) => ({ country: r.country, c: Number(r.c) })),
        mrrCents, totalCents, rev30Cents,
        totalUsers, paidUsers, freeUsers,
        starterCount: planMap.starter || 0, proCount: planMap.pro || 0,
        conversionRate, arpuCents,
        byProvider: byProvider.rows.map((r) => ({ provider: r.provider, cents: Number(r.cents) })),
        newUsers30: newUsers30.rows.map((r) => ({ d: r.d, c: Number(r.c) })),
        revenue30: revenue30.rows.map((r) => ({ d: r.d, cents: Number(r.cents) })),
      });
    } catch (err) {
      return c.json({ error: err.message }, 500); // 与 server.js 一致（非 apiErr）
    }
  });

  app.get('/api/admin/user-events', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const userId = c.req.query('userId') || null;
      const eventType = c.req.query('eventType') || null;
      const limit = Math.min(Number(c.req.query('limit')) || 100, 500);
      const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
      const events = await listUserEvents({ userId, eventType, limit, offset });
      return c.json(events);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/admin/user-events/summary', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const days = Math.min(Number(c.req.query('days')) || 1, 90);
      const summary = await getUserEventSummary(days);
      return c.json(summary);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.get('/api/admin/user-events/ranking', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    try {
      const days = Math.min(Number(c.req.query('days')) || 30, 365);
      const limit = Math.min(Number(c.req.query('limit')) || 20, 100);
      const active = await getUserActivityRanking({ days, limit });
      const dormant = await getDormantUsers({ sinceDays: days, limit });
      return c.json({ active, dormant });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/admin/monthly-report', async (c) => {
    const g = await requireAdmin(c); if (g) return g;
    const sent = await generateMonthlyReport(c.get('admin').id);
    return c.json({ sent });
  });

  // ===== 维护窗口 =====
  app.get('/api/maintenance-windows', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    return c.json(await listMaintenanceWindows(userId));
  });

  app.post('/api/maintenance-windows', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      const { title, monitorIds, startAt, endAt } = c.get('body') || {};
      const id = await createMaintenanceWindow(userId, { title, monitorIds, startAt, endAt });
      recordUserEvent({ userId, eventType: 'maintenance_create', metadata: { id, title, monitorIds }, req: reqShim(c) });
      return c.json({ id, ok: true }, 201);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 400);
    }
  });

  app.delete('/api/maintenance-windows/:id', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const ok = await deleteMaintenanceWindow(userId, c.req.param('id'));
    if (ok) recordUserEvent({ userId, eventType: 'maintenance_delete', metadata: { id: c.req.param('id') }, req: reqShim(c) });
    return c.json({ ok });
  });

  // ===== 团队 =====
  app.post('/api/team', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const { name } = c.get('body') || {};
    try {
      const id = await createTeam(userId, name);
      recordUserEvent({ userId, eventType: 'team_create', metadata: { id, name }, req: reqShim(c) });
      return c.json({ id, ok: true }, 201);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 400);
    }
  });

  app.post('/api/team/invite', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    if (!user?.teamId) return c.json(apiErr(E.NO_TEAM), 403);
    try {
      const email = (c.get('body') || {}).email;
      const r = await inviteTeamMember(user.teamId, userId, email);
      recordUserEvent({ userId, eventType: 'team_invite', metadata: { teamId: user.teamId, email, result: r }, req: reqShim(c) });
      return c.json({ ok: true, result: r });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 400);
    }
  });

  app.get('/api/team', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const user = await getUserById(userId);
    if (!user?.teamId) return c.json({ team: null });
    const team = await listTeam(user.teamId);
    const monitors = user.teamId ? await listTeamMonitors(user.teamId) : [];
    return c.json({ team: team ? { ...team, monitors } : null });
  });

  app.post('/api/team/leave', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    await leaveTeam(userId);
    recordUserEvent({ userId, eventType: 'team_leave', req: reqShim(c) });
    return c.json({ ok: true });
  });

  // ===== 账户自助管理 =====
  app.post('/api/account/change-password', authLimiter, async (c) => {
    const sess = c.get('session');
    if (!sess.userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const { oldPassword, newPassword } = c.get('body') || {};
    try {
      await changePassword(sess.userId, oldPassword, newPassword);
      return c.json({ ok: true });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  app.post('/api/account/profile', async (c) => {
    const sess = c.get('session');
    if (!sess.userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const { name, password } = c.get('body') || {};
    try {
      if (password) {
        await setPassword(sess.userId, password);
      } else if (name !== undefined) {
        await updateProfileName(sess.userId, name);
      }
      const user = await getUserById(sess.userId);
      return c.json({ ok: true, user });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  app.post('/api/account/change-email', async (c) => {
    const sess = c.get('session');
    if (!sess.userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const { newEmail } = c.get('body') || {};
    try {
      const token = await requestEmailChange(sess.userId, newEmail);
      const user = await getUserById(sess.userId);
      if (token && user) await sendChangeEmailVerification(newEmail, token);
      return c.json({ ok: true, message: 'We sent a confirmation link to your new email' });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  app.post('/api/account/confirm-email', async (c) => {
    const { token } = c.get('body') || {};
    try {
      const user = await confirmEmailChange(token);
      if (!user) return c.json({ error: E.INVALID_CONFIRM_LINK }, 400);
      return c.json({ ok: true, email: user.email });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  // ===== 账户级告警渠道 =====
  app.get('/api/account/channels', async (c) => {
    const sess = c.get('session');
    if (!sess.userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      return c.json({ ok: true, channels: await getAlertChannels(sess.userId) });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 500); }
  });

  app.post('/api/account/channels', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    try {
      const plan = (await getUserById(userId))?.plan ?? 'free';
      const incoming = (c.get('body') || {}).channels;
      const clean = {};
      if (incoming && typeof incoming === 'object') {
        for (const [ch, cfg] of Object.entries(incoming)) {
          if (ch === 'email' || !planHasChannel(plan, ch)) continue;
          const norm = normalizeChannelCfg(ch, cfg);
          if (norm) clean[ch] = norm;
        }
      }
      const saved = await saveAlertChannels(userId, clean);
      recordUserEvent({ userId, eventType: 'account_channels_update', metadata: { channels: Object.keys(saved) }, req: reqShim(c) });
      return c.json({ ok: true, channels: saved });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  app.post('/api/account/channels/test', authLimiter, async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const body = c.get('body') || {};
    const channel = String(body.channel || '');
    if (channel === 'email') return c.json(apiErr(E.CHANNEL_NOT_SUPPORTED, { plan: 'n/a', channel }), 400);
    try {
      const plan = (await getUserById(userId))?.plan ?? 'free';
      if (!planHasChannel(plan, channel)) {
        return c.json(apiErr(E.CHANNEL_NOT_SUPPORTED, { plan, channel: CHANNEL_LABELS[channel] || channel }), 403);
      }
      let cfg = body.config ? normalizeChannelCfg(channel, body.config) : null;
      if (!cfg) cfg = (await getAlertChannels(userId))[channel] || null;
      if (!cfg) return c.json(apiErr(E.CHANNEL_NOT_CONFIGURED, { channel: CHANNEL_LABELS[channel] || channel }), 400);
      const r = await sendTestAlert(channel, cfg);
      if (!r.ok) return c.json(apiErr(E.SERVER_ERROR, { msg: r.reason || ('HTTP ' + r.status) }), 400);
      return c.json({ ok: true });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  // ===== 忘记密码 / 重置 =====
  app.post('/api/auth/forgot-password', pwLimiter, async (c) => {
    const { email } = c.get('body') || {};
    try {
      const token = await requestPasswordReset(email);
      if (token) {
        const user = await getUserByEmail(email);
        if (user) await sendPasswordResetEmail(user.email, token);
      }
      return c.json({ ok: true, message: 'If the email exists, a reset link has been sent' });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  app.post('/api/auth/reset-password', pwLimiter, async (c) => {
    const { token, newPassword } = c.get('body') || {};
    try {
      await resetPassword(token, newPassword);
      return c.json({ ok: true });
    } catch (e) { return c.json(apiErr(E.SERVER_ERROR, { msg: e.message }), 400); }
  });

  // ===== Account API（api_key）=====
  app.post('/api/account/apikey', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    const regenerate = (c.get('body') || {}).regenerate;
    const key = regenerate ? await regenerateApiKey(userId) : await ensureApiKey(userId);
    recordUserEvent({ userId, eventType: regenerate ? 'api_key_regenerate' : 'api_key_view', req: reqShim(c) });
    return c.json({ apiKey: key });
  });

  app.get('/api/account/apikey', async (c) => {
    const sess = c.get('session');
    const userId = sess && sess.userId;
    if (!userId) return c.json(apiErr(E.AUTH_REQUIRED), 401);
    return c.json({ apiKey: await ensureApiKey(userId) });
  });

  // ---- Account API v1（Bearer api_key）----
  app.get('/api/v1/monitors', async (c) => {
    const g = await requireApiKey(c); if (g) return g;
    try {
      const apiUser = c.get('apiUser');
      const own = await listMonitors(apiUser.id);
      let team = [];
      if (apiUser.teamId) team = await listTeamMonitors(apiUser.teamId);
      return c.json({ monitors: [...own, ...team] });
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 500);
    }
  });

  app.post('/api/v1/monitors', async (c) => {
    const g = await requireApiKey(c); if (g) return g;
    try {
      const apiUser = c.get('apiUser');
      const plan = apiUser.plan;
      const { url, name, interval, type = 'http', config = {}, channels = null, statusPublic = false } = c.get('body') || {};
      if (!url) return c.json(apiErr(E.URL_REQUIRED), 400);
      if (!planHasType(plan, type)) return c.json(apiErr(E.API_TYPE_NOT_SUPPORTED, { type }), 403);
      const mon = createMonitor({ url, name, interval, userId: apiUser.id, type, config, channels });
      mon.statusPublic = !!statusPublic && planHasStatusPage(plan);
      mon.teamId = apiUser.teamId || null;
      await saveMonitor(mon);
      recordUserEvent({ userId: apiUser.id, eventType: 'monitor_create', metadata: { url: mon.url, type: mon.type, source: 'api' }, req: reqShim(c) });
      return c.json(mon, 201);
    } catch (err) {
      return c.json(apiErr(E.SERVER_ERROR, { msg: err.message }), 400);
    }
  });

  app.get('/api/v1/monitors/:id', async (c) => {
    const g = await requireApiKey(c); if (g) return g;
    const apiUser = c.get('apiUser');
    const m = await getMonitor(c.req.param('id'));
    if (!m || (m.userId !== apiUser.id && m.teamId !== apiUser.teamId)) return c.json(apiErr(E.MONITOR_NOT_FOUND), 404);
    return c.json(m);
  });

  app.delete('/api/v1/monitors/:id', async (c) => {
    const g = await requireApiKey(c); if (g) return g;
    const apiUser = c.get('apiUser');
    const m = await getMonitor(c.req.param('id'));
    if (!m || (m.userId !== apiUser.id && m.teamId !== apiUser.teamId)) return c.json(apiErr(E.MONITOR_NOT_FOUND), 404);
    await deleteMonitor(c.req.param('id'), apiUser.id);
    recordUserEvent({ userId: apiUser.id, eventType: 'monitor_delete', metadata: { id: c.req.param('id'), url: m.url, type: m.type, source: 'api' }, req: reqShim(c) });
    return c.json({ ok: true });
  });

  // ===== 未匹配的 /api/* 统一兜底（P1-11；必须注册在全部 API 路由之后）=====
  app.all('/api/*', (c) => c.json(apiErr(E.ENDPOINT_NOT_FOUND), 404));
}
