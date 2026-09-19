import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { Paddle } from '@paddle/paddle-node-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createMonitor, listMonitors, getMonitor, deleteMonitor, saveMonitor, getHistory, getStats, getStatusIncidents, getStatusPage, getStatusPageByHost, getStatusPageAuth, getStatusPageOwnerId, listTeamMonitors, startPolling } from './src/monitors.js';
import { initAlerts, generateMonthlyReport, sendTestAlert } from './src/alerts.js';
import { initDb, startKeepAlive, getPool, pool } from './src/db.js';
import { recordUserEvent, listUserEvents, getUserEventSummary, getUserActivityRanking, getDormantUsers, parseJSON } from './src/events.js';
import { registerUser, loginUser, getUserById, getUserByEmail, updatePlan, updateStatusPage, createEmailVerification, verifyEmailToken, seedAdmin, setRole, addSubscriber, listSubscribers, removeSubscriber, createMaintenanceWindow, listMaintenanceWindows, deleteMaintenanceWindow, ensureApiKey, regenerateApiKey, getUserByApiKey, createTeam, inviteTeamMember, listTeam, leaveTeam, verifyPagePassword, recordReferralConversion, createOAuthUser, recordBillingEvent, changePassword, setPassword, updateProfileName, requestEmailChange, confirmEmailChange, requestPasswordReset, resetPassword, getAlertChannels, saveAlertChannels } from './src/auth.js';
import { sendVerificationEmail, sendFeedbackNotification, sendPasswordResetEmail, sendChangeEmailVerification } from './src/email.js';
import { PLAN_LIMITS, planHasType, planHasChannel, planHasStatusPage, planHasStats, planFeatures, planMinInterval, TYPE_LABELS, CHANNEL_LABELS, EMAIL_VERIFY_MONITOR_CAP } from './src/plans.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ===== API 错误码（i18n 就绪：前端用 errMsg() 映射到 t('err.xxx')）=====
const E = {
  AUTH_REQUIRED:            'auth_required',
  RATE_LIMITED:             'rate_limited',
  PLAN_MONITOR_LIMIT:       'plan_monitor_limit',
  EMAIL_VERIFY_REQUIRED:    'email_verify_required',
  URL_REQUIRED:             'url_required',
  URL_INVALID:              'url_invalid',
  PLAN_TYPE_NOT_SUPPORTED:  'plan_type_not_supported',
  PLAN_MIN_INTERVAL:        'plan_min_interval',
  MONITOR_NOT_FOUND:        'monitor_not_found',
  MONITOR_NO_PERM:          'monitor_not_found_or_no_perm',
  TREND_REQUIRES_STARTER:   'trend_requires_starter',
  SP_REQUIRES_STARTER:      'status_page_requires_starter',
  SP_PRO_ONLY:              'status_page_pro_only',
  SP_NOT_FOUND:             'status_page_not_found',
  SP_NO_DOMAIN:             'status_page_no_domain',
  WRONG_PASSWORD:           'wrong_password',
  FEEDBACK_EMPTY:           'feedback_empty',
  FEEDBACK_TOO_LONG:        'feedback_too_long',
  ADMIN_REQUIRED:           'admin_required',
  SERVER_ERROR:             'server_error',
  IMPORT_UNSUPPORTED:       'import_unsupported_format',
  IMPORT_NO_DATA:           'import_no_data',
  IMPORT_PARSE_FAILED:      'import_parse_failed',
  IMPORT_NO_MONITORS:       'import_no_monitors',
  SELF_BAN:                 'self_ban',
  SELF_DELETE:              'self_delete',
  INVALID_CONFIRM_LINK:     'invalid_confirmation_link',
  NO_TEAM:                  'no_team',
  MISSING_AUTH_HEADER:      'missing_auth_header',
  INVALID_API_KEY:          'invalid_api_key',
  USER_NOT_FOUND:           'user_not_found',
  INVALID_MONITOR_LIMIT:    'invalid_monitor_limit',
  INVALID_PLAN:             'invalid_plan',
  API_TYPE_NOT_SUPPORTED:   'api_type_not_supported',
  CHANNEL_NOT_SUPPORTED:    'channel_not_supported',
  CHANNEL_NOT_CONFIGURED:   'channel_not_configured',
  ENDPOINT_NOT_FOUND:       'endpoint_not_found',
};
/** 构造 i18n 错误响应 { error: code, ep: params } */
function apiErr(code, params) { return { error: code, ep: params || {} }; }

// ===== 基础安全响应头（G-SEC）=====
// 防 MIME 嗅探 / 点击劫持 / 内容注入；CSP 仅限同源资源，避免破坏 Paddle.js 等外链可单独放开
// 不发送 X-Powered-By（默认会暴露 "Express" 框架指纹，便于攻击者按已知漏洞定向探测）
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // 本服务不使用摄像头/麦克风/定位等浏览器能力，显式关闭以缩小攻击面
  // （不含 payment=()：结账依赖 Paddle/Creem 的 iframe，避免误伤支付链路）
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=()');
  res.setHeader(
    'Content-Security-Policy',
    // 注：本项目的 index.html / admin.html 均为内联 <script> 单页，故 script-src 需 'unsafe-inline'；
    // 后续若把前端抽成外部 .js 文件，可去掉 'unsafe-inline' 收紧。
    // Paddle 结账需要：script/style/connect 放行 cdn.paddle.com / sandbox-cdn.paddle.com；frame-src 放行结账浮层。
    // Cloudflare Web Analytics 需要：script-src 放行 static.cloudflareinsights.com，connect-src 放行 cloudflareinsights.com。
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://cdn.paddle.com https://sandbox-cdn.paddle.com https://api.creem.io; style-src 'self' 'unsafe-inline' https://sandbox-cdn.paddle.com; img-src 'self' data:; connect-src 'self' https://cloudflareinsights.com https://cdn.paddle.com https://sandbox-cdn.paddle.com https://api.creem.io https://test-api.creem.io; frame-src https://*.paddle.com https://checkout.creem.io;"
  );
  next();
});

// ===== 简单内存限流（防暴破 / 防刷）=====
// 按真实客户端 IP 计数；生产环境建议换 Redis，但单实例足够挡住绝大多数脚本小子。
// 站点链路：浏览器 → Cloudflare → Fly.io 代理 → 本应用。取 IP 优先级：
//   1) CF-Connecting-IP：Cloudflare 强制覆写（客户端伪造的同名头会被替换），不可伪造；
//   2) Fly-Client-IP：Fly 边缘写入（访问 *.fly.dev 直连时不经 CF，用它兜底）；
//   3) req.ip（trust proxy=1）。
// ⚠️ 不要用 X-Forwarded-For 最左条目：CF 对已有 XFF 是追加而非覆盖，
//    客户端可自带假 XFF 让最左变成假 IP，从而轮换假 IP 绕过限流。
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();
  const fly = req.headers['fly-client-ip'];
  if (fly) return String(fly).trim();
  return req.ip || 'unknown';
}
function makeRateLimiter(max = 10, windowMs = 15 * 60 * 1000) {
  const hits = new Map(); // ip -> [{t}]
  setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const fresh = arr.filter((t) => now - t < windowMs);
      if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
    }
  }, windowMs).unref();
  return (req, res, next) => {
    const ip = clientIp(req);
    const arr = hits.get(ip) || [];
    const now = Date.now();
    const recent = arr.filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      return res.status(429).json(apiErr(E.RATE_LIMITED));
    }
    recent.push(now);
    hits.set(ip, recent);
    next();
  };
}
const authLimiter = makeRateLimiter(15, 15 * 60 * 1000);   // 登录/注册：15 次/15 分钟
const feedbackLimiter = makeRateLimiter(10, 60 * 60 * 1000); // 反馈：10 条/小时
const pwLimiter = makeRateLimiter(5, 60 * 60 * 1000);       // 忘记密码/重置：5 次/小时/IP（防邮件轰炸/令牌爆破）

// ===== Session 中间件（登录态）=====
// ===== 自定义域名根路径返回状态页（G7）：需在静态中间件前拦截 =====
app.get('/', async (req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  try {
    const page = await getStatusPageByHost(host);
    if (page) return res.sendFile('status.html', { root: 'public' });
  } catch { /* 忽略，走默认首页 */ }
  next();
});

// ===== SEO 对比页：/compare/uptimerobot（英文）+ /{lang}/compare/uptimerobot（7 语）=====
// 单文件模板 + 服务端注入 → <html lang> / canonical / hreflang / **正文文案** 全部为静态内容，
// 不依赖 JS 就能被搜索引擎（含不执行 JS 的爬虫）按正确语言抓取——多语言 SEO 的关键。
// data-i18n / data-i18n-content 属性保留，前端切语仍走整页跳转。
const CMP_LANGS = new Set(['zh', 'es', 'pt', 'de', 'fr', 'ja', 'ko']);
const CMP_PATH = '/compare/uptimerobot';
const CMP_TEMPLATE = path.join('public', 'compare-uptimerobot.html');
// 只预载本页用到的键，避免整包 35KB 拖慢首屏
const CMP_I18N_KEY = /^(cmp\.|nav\.|footer\.|landing\.ctaFree$)/;
// 裸 & 转义为 &amp;（已是实体的不重复转义）；字典值允许内置 <strong> 等标签，按 innerHTML 语义注入
function cmpEscText(v) {
  return String(v).replace(/&(?!(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+|nbsp);)/g, '&amp;');
}
function cmpEscAttr(v) {
  return cmpEscText(v).replace(/"/g, '&quot;');
}
function cmpReadDict(lang) {
  try {
    return JSON.parse(fs.readFileSync(path.join('public', 'i18n', lang + '.json'), 'utf8'));
  } catch (e) {
    console.error('[compare] 字典读取失败:', lang, e.message);
    return null;
  }
}
function cmpPreloadScript(lang, dict) {
  const sub = {};
  if (dict) for (const k of Object.keys(dict)) if (CMP_I18N_KEY.test(k)) sub[k] = dict[k];
  // < 转义为 \u003c，避免 JSON 中意外出现 </script> 提前闭合
  return '<script>window.__I18N_LANG__=' + JSON.stringify(lang)
    + ';window.__I18N_PRELOAD__=' + JSON.stringify(sub).replace(/</g, '\\u003c') + ';<\/script>';
}
// 服务端把 data-i18n / data-i18n-content 就地替换为目标语言文案（属性保留 → 前端切语不受影响）
// 注：注入译文一律用「函数式 replace」，避免译文里的 $& / $' 被当成替换模式。
function cmpLocalize(html, dict) {
  if (!dict) return html;
  // ① data-i18n-content="key" → 同一标签内的 content="..."（og:title / description 等）
  html = html.replace(/<[^>]*\bdata-i18n-content="([^"]+)"[^>]*>/g, (tag, key) => {
    const v = dict[key];
    if (v == null || !/\bcontent="[^"]*"/.test(tag)) return tag;
    return tag.replace(/\bcontent="[^"]*"/, () => 'content="' + cmpEscAttr(v) + '"');
  });
  // ② data-i18n="key" → 替换元素 inner HTML（按同名标签深度配对取闭合位；模板已验证无同名嵌套）
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>/g;
  let out = '', last = 0, m;
  while ((m = re.exec(html))) {
    const tag = m[1], key = m[2], v = dict[key];
    if (v == null) continue;
    const openEnd = m.index + m[0].length;
    const tagRe = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    tagRe.lastIndex = openEnd;
    let depth = 1, t, closeStart = -1;
    while ((t = tagRe.exec(html))) {
      if (t[1] === '/') { depth--; if (depth === 0) { closeStart = t.index; break; } } else depth++;
    }
    if (closeStart === -1) continue; // 未闭合则保守跳过
    out += html.slice(last, openEnd) + cmpEscText(v);
    last = closeStart;
    re.lastIndex = closeStart;
  }
  out += html.slice(last);
  return out;
}
function cmpRender(lang) {
  let html;
  try {
    html = fs.readFileSync(CMP_TEMPLATE, 'utf8');
  } catch (e) {
    console.error('[compare] 模板读取失败:', e.message);
    return null;
  }
  const dict = lang === 'en' ? null : cmpReadDict(lang);
  if (lang !== 'en') html = cmpLocalize(html, dict);
  const canonical = 'https://pingory.com' + (lang === 'en' ? CMP_PATH : '/' + lang + CMP_PATH);
  return html
    .replace(/__CMP_LANG__/g, lang)
    .replace(/__CMP_CANONICAL__/g, () => canonical)
    .replace('<!--CMP_I18N_PRELOAD-->', () => cmpPreloadScript(lang, dict));
}
function sendComparePage(lang, res) {
  const html = cmpRender(lang);
  if (html == null) return res.status(500).type('text').send('template error');
  res.type('html').send(html);
}
app.get(CMP_PATH, (_req, res) => sendComparePage('en', res));
app.get('/:lang/compare/uptimerobot', (req, res, next) => {
  const lang = String(req.params.lang || '').toLowerCase();
  if (!CMP_LANGS.has(lang)) return next();
  sendComparePage(lang, res);
});
// 别名/直链 301 到规范地址，避免重复内容（SEO）
app.get('/vs/uptimerobot', (_req, res) => res.redirect(301, CMP_PATH));
app.get('/compare-uptimerobot.html', (_req, res) => res.redirect(301, CMP_PATH));

// ===== SEO 对比页（英文首版静态页）：/compare/betterstack · /compare/pingdom =====
// 起量后再补 7 语变体与 hreflang；当前 canonical 固定英文规范 URL。
app.get('/compare/betterstack', (_req, res) => res.sendFile('compare-betterstack.html', { root: 'public' }));
app.get('/compare/pingdom', (_req, res) => res.sendFile('compare-pingdom.html', { root: 'public' }));
app.get('/vs/betterstack', (_req, res) => res.redirect(301, '/compare/betterstack'));
app.get('/compare-betterstack.html', (_req, res) => res.redirect(301, '/compare/betterstack'));
app.get('/vs/pingdom', (_req, res) => res.redirect(301, '/compare/pingdom'));
app.get('/compare-pingdom.html', (_req, res) => res.redirect(301, '/compare/pingdom'));

// Fly.io 等平台在前面终止 TLS，再以 HTTP 转发给本应用，
// 导致应用内 req.secure 为 false；而 session cookie 设了 secure:true 时，
// express-session 会因"请求不安全"而拒绝下发 Cookie（登录/注册后会话丢失，后台变空白）。
// 信任反向代理的 X-Forwarded-Proto，req.secure 才会正确为 true，Cookie 才会下发。
app.set('trust proxy', 1);

// 会话存数据库（PostgreSQL），Fly 多实例共用同一份登录态，避免「时灵时不灵」
const PgSessionStore = pgSession(session);
app.use(session({
  store: new PgSessionStore({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.PADDLE_ENVIRONMENT === 'live' || process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 天
  },
}));

// ===== Paddle SDK 初始化 =====
const paddle = new Paddle(process.env.PADDLE_API_KEY, {
  environment: process.env.PADDLE_ENVIRONMENT === 'live' ? 'production' : 'sandbox',
});

// ===== 前端拿 client token + price id（公开信息，无密钥）=====
app.get('/api/paddle-config', (req, res) => {
  res.json({
    clientToken: process.env.PADDLE_CLIENT_TOKEN,
    environment: process.env.PADDLE_ENVIRONMENT,
    starterPriceId: process.env.STARTER_PRICE_ID,
    proPriceId: process.env.PRO_PRICE_ID,
    starterAnnualPriceId: process.env.STARTER_ANNUAL_PRICE_ID,
    proAnnualPriceId: process.env.PRO_ANNUAL_PRICE_ID,
  });
});

// ===== 静态托管前端 =====
app.use(express.static('public'));

// ===== Paddle Webhook（签名验证 + 更新用户 plan）=====
// 注意：express.raw 必须在 express.json 之前，保证拿到原始 body 验签
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

  // Paddle SDK 默认只容差 5 秒，cloudflared 等隧道可能延迟更高；测试阶段放宽到 5 分钟
  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (isNaN(tsNum) || Math.abs(now - tsNum) > 300) return false;

  const payload = `${tsNum}:${rawBody}`;
  const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return computed === h1;
}

app.post(
  '/api/paddle/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signatureHeader = req.headers['paddle-signature'];
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
    const secret = process.env.PADDLE_WEBHOOK_SECRET;
    const rawBody = req.body.toString();

    try {
      if (!verifyPaddleSignature(rawBody, secret, signature)) {
        console.error('[webhook] 验签失败');
        return res.status(400).send('invalid signature');
      }

      const event = JSON.parse(rawBody);
      console.log('[webhook]', event.event_type, event.data?.id);

      // 注意（方案C · provider-agnostic）：本 webhook 仅处理 Paddle。
      // 未来接入 Creem 时，新增一个 /api/creem/webhook，在对应事件里调用同一个
      // recordBillingEvent({ provider: 'creem', ... }) 即可；owner 分析端点与 admin 页面
      // 无需改动——它们只读 billing_events 归一化账本。
      // 根据事件更新 users.plan
      const customerEmail = event.data?.customer?.email;
      const priceId = event.data?.items?.[0]?.price?.id;
      const subId = event.data?.id;
      const custId = event.data?.customer?.id;

      const planFromPrice = (pid) => {
        if (pid === process.env.STARTER_PRICE_ID || pid === process.env.STARTER_ANNUAL_PRICE_ID) return 'starter';
        if (pid === process.env.PRO_PRICE_ID || pid === process.env.PRO_ANNUAL_PRICE_ID) return 'pro';
        return null;
      };
      // 月付 / 年付识别（金额归一化到 monthly 口径时用）
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
              // 推荐提成：被推荐人付费转化后，给推荐人记 10% 提成（幂等，仅 pending 记一次）
              try {
                const priceObj = event.data?.items?.[0]?.price;
                const amount = Number(priceObj?.unit_price?.amount || 0); // 货币最小单位（如分）
                const currency = priceObj?.unit_price?.currency_code || 'USD';
                if (amount > 0) {
                  const commission = Math.round(amount * 0.1);
                  const credited = await recordReferralConversion(u.id, commission, currency);
                  if (credited) console.log(`[webhook] 已向推荐人发放 ${commission} ${currency} 提成（来自 ${u.email}）`);
                }
              } catch (ce) { console.error('[webhook] 推荐提成记录失败:', ce.message); }
              // 方案C：归一化账单账本（provider-agnostic；与 Paddle/Creem 解耦，换渠道不改此处）
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
              // 方案C：记一笔 churn 标记（金额 0；providerEventId 带 :cancel 后缀避免与订阅创建事件去重重疊）
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
          // 方案C：实际收款事件写入归一化账本（月付/年付按 price id 识别）
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

      res.status(200).send('ok');
    } catch (err) {
      console.error('[webhook] 处理失败:', err.message);
      res.status(400).send('invalid');
    }
  }
);

// ===== Creem 集成（双轨并存：Paddle 代码完全保留；PAYMENT_PROVIDER=creem 时启用）=====
// 设计：方案C 归一化账单账本（billing_events）已 provider-agnostic，本块仅新增 Creem 渠道的
// checkout 创建 + webhook 验签 + 调同一 recordBillingEvent/updatePlan，不改动 Paddle 任何逻辑。
// Creem 出问题只需把 PAYMENT_PROVIDER 改回 paddle 即可切回，无需动代码。
const CREEM_BASE = process.env.CREEM_ENVIRONMENT === 'live' ? 'https://api.creem.io/v1' : 'https://test-api.creem.io/v1';
const CREEM_ACTIVE = (process.env.PAYMENT_PROVIDER || 'paddle') === 'creem';

// 前端查询当前激活的收款渠道（公开信息，无密钥）
app.get('/api/creem-config', (req, res) => {
  res.json({ active: CREEM_ACTIVE, environment: process.env.CREEM_ENVIRONMENT || 'test' });
});

// 创建托管结账 session（用户态）；product_id 走服务端环境变量，前端不接触
app.get('/api/creem/checkout', async (req, res) => {
  if (!CREEM_ACTIVE) return res.status(400).json(apiErr(E.SERVER_ERROR, { msg: 'Creem checkout not active' }));
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  if (!user) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const plan = req.query.plan;
  const annual = req.query.annual === '1' || req.query.annual === 'true';
  if (plan !== 'starter' && plan !== 'pro') return res.status(400).json(apiErr(E.INVALID_PLAN));
  const productId = annual
    ? (plan === 'starter' ? process.env.CREEM_STARTER_ANNUAL_PRODUCT : process.env.CREEM_PRO_ANNUAL_PRODUCT)
    : (plan === 'starter' ? process.env.CREEM_STARTER_PRODUCT : process.env.CREEM_PRO_PRODUCT);
  if (!productId) return res.status(500).json(apiErr(E.SERVER_ERROR, { msg: 'Creem product not configured' }));
  try {
    const r = await fetch(CREEM_BASE + '/checkouts', {
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
    if (!data.checkout_url) return res.status(500).json(apiErr(E.SERVER_ERROR, { msg: 'checkout create failed', detail: data }));
    res.json({ url: data.checkout_url });
  } catch (e) {
    console.error('[creem checkout] 失败:', e.message);
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: 'checkout create failed' }));
  }
});

// Creem Webhook（签名验证 + 更新用户 plan + 写归一化账本）
function verifyCreemSignature(rawBody, secret, signature) {
  if (!signature || !secret) return false;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return computed === signature;
}

// 从 Creem product id 反查 plan（metadata 丢失时的兜底，避免"付了钱不升级"）
const CREEM_PRODUCT_PLAN = {
  [process.env.CREEM_STARTER_PRODUCT]: 'starter',
  [process.env.CREEM_PRO_PRODUCT]: 'pro',
  [process.env.CREEM_STARTER_ANNUAL_PRODUCT]: 'starter',
  [process.env.CREEM_PRO_ANNUAL_PRODUCT]: 'pro',
};
function productPlanFromEnv(productId) {
  if (!productId) return null;
  return CREEM_PRODUCT_PLAN[productId] || null;
}

app.post('/api/creem/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['creem-signature'];
  const secret = process.env.CREEM_WEBHOOK_SECRET;
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  try {
    if (!verifyCreemSignature(rawBody, secret, signature)) {
      const computed = crypto.createHmac('sha256', secret || '').update(rawBody).digest('hex');
      console.error('[creem webhook] 验签失败', { received: String(signature || '').slice(0, 24), computed: computed.slice(0, 24), ct: req.headers['content-type'], bodyLen: rawBody.length, hasSecret: !!secret });
      return res.status(400).send('invalid signature');
    }
    const event = JSON.parse(rawBody);
    const eventType = event.event_type || event.eventType; // Creem 实测为 camelCase eventType
    console.log('[creem webhook]', eventType, event.id);
    const obj = event.object || {};
    const meta = obj.metadata || {};
    // 优先用 checkout 时写入的 userId，回退 email
    let u = null;
    if (meta.userId) u = await getUserById(meta.userId);
    if (!u && obj.customer && obj.customer.email) u = await getUserByEmail(obj.customer.email);
    const plan = (meta.plan === 'starter' || meta.plan === 'pro') ? meta.plan
      : productPlanFromEnv(obj.product?.id || obj.product_id); // 兜底：metadata 丢失时从 product_id 反查
    const cycle = meta.cycle === 'yearly' ? 'yearly' : 'monthly';
    const subId = obj.id;
    const custId = obj.customer ? obj.customer.id : null;
    const amount = Number(obj.amount || 0); // Creem 金额最小单位（分）
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
        await grant(true); break;            // 首次激活：发推荐提成
      case 'subscription.paid':
        await grant(false); break;           // 续费：记账但不重复发提成
      case 'subscription.canceled':
      case 'subscription.expired':
      case 'subscription.paused':
        await revoke(); break;
      case 'refund.created':
        try { if (u) await recordBillingEvent({ userId: u.id, provider: 'creem', eventType: 'refund', plan, billingCycle: cycle, amountCents: amount, currency, providerEventId: (obj.id || '') + ':refund' }); } catch (be) { console.error('[creem webhook] refund 账本失败:', be.message); }
        break;
      default: break;
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('[creem webhook] 处理失败:', err.message);
    res.status(400).send('invalid');
  }
});

// 其余 API 用 JSON
app.use(express.json());

// ===== 简单页面分析（来源国家 / 停留时长） =====
// 无 cookie，前端用 sessionStorage 生成一次性 session id；适合 CF-IPCountry 等国家来源。
app.post('/api/analytics/start', async (req, res) => {
  try {
    const sid = String(req.body?.sid || '').slice(0, 64) || crypto.randomUUID();
    const country = String(req.headers['cf-ipcountry'] || req.headers['x-country'] || '').toUpperCase().slice(0, 2) || 'unknown';
    const userId = req.session?.userId || null;
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
    res.json({ ok: true, sid });
  } catch (err) {
    console.error('[analytics start]', err.message);
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: 'analytics error' }));
  }
});

app.post('/api/analytics/ping', async (req, res) => {
  try {
    const sid = String(req.body?.sid || '').slice(0, 64);
    if (!sid) return res.status(400).json(apiErr(E.SERVER_ERROR, { msg: 'missing sid' }));
    const pool = await getPool();
    // 每 ping 增加 30s，但只统计最近 5 分钟内的活跃会话，避免标签页挂后台虚高
    await pool.query(
      `UPDATE page_sessions
       SET duration_seconds = duration_seconds + 30,
           last_seen_at = now()
       WHERE id = $1 AND last_seen_at > now() - interval '5 minutes'`,
      [sid]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[analytics ping]', err.message);
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: 'analytics error' }));
  }
});

// ===== 认证 API =====
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name, referralCode } = req.body || {};
    const user = await registerUser(email, password, name, referralCode);
    req.session.userId = user.id;
    // 显式落库后再回包，避免 Fly 多机下重定向瞬间的会话竞态
    await new Promise((r) => req.session.save(r));
    // 发验证邮件（best-effort：SMTP 未配置也不阻塞注册）
    const token = await createEmailVerification(user.email);
    if (token) await sendVerificationEmail(user.email, token);
    recordUserEvent({ userId: user.id, eventType: 'user_signup', metadata: { provider: 'email' }, req });
    res.status(201).json({ user, needsVerification: true });
  } catch (err) {
    res.status(400).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await loginUser(email, password);
    req.session.userId = user.id;
    // 显式落库后再回包，避免 Fly 多机下重定向瞬间的会话竞态
    await new Promise((r) => req.session.save(r));
    recordUserEvent({ userId: user.id, eventType: 'user_login', metadata: { provider: 'email' }, req });
    res.json({ user });
  } catch (err) {
    res.status(401).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 邮箱验证（点击邮件链接后前端带 token 调）
app.get('/api/auth/verify-email', async (req, res) => {
  const token = req.query.token;
  const user = await verifyEmailToken(token);
  if (!user) return res.status(400).json({ ok: false, error: E.INVALID_CONFIRM_LINK });
  recordUserEvent({ userId: user.id, eventType: 'email_verified', metadata: { provider: 'email' }, req });
  res.json({ ok: true, email: user.email });
});

// 重新发送验证邮件（需登录）
app.post('/api/auth/resend-verify', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  if (!user) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  if (user.emailVerified) return res.json({ ok: true, already: true });
  const token = await createEmailVerification(user.email);
  if (!token) return res.status(400).json(apiErr(E.SERVER_ERROR, { msg: 'Account does not exist' }));
  await sendVerificationEmail(user.email, token);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ===== Google / GitHub OAuth 登录（#287）=====
// 手动 OAuth2（不引入 passport）。client id/secret 走环境变量；回调 base 用 APP_URL。
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
app.get('/api/auth/oauth/:provider/start', (req, res) => {
  const provider = req.params.provider;
  const ref = (typeof req.query.ref === 'string' && req.query.ref.trim()) ? req.query.ref.trim() : '';
  const url = oauthStartUrl(provider, ref);
  if (!url) return res.status(400).send('OAuth not configured for ' + provider);
  res.redirect(url);
});
// 统一收尾：按邮箱找/建用户并登录；ref 来自 state
async function oauthFinish(req, res, email, name, state, provider) {
  try {
    if (!email) return res.redirect('/signin.html?err=noemail');
    const ref = (typeof state === 'string' && state.startsWith('ref:')) ? state.slice(4) : '';
    const existed = !!(await getUserByEmail(email));
    let user = await getUserByEmail(email);
    if (!user) user = await createOAuthUser(email, name, ref);
    req.session.userId = user.id;
    await new Promise((r) => req.session.save(r));
    recordUserEvent({ userId: user.id, eventType: existed ? 'user_login' : 'user_signup', metadata: { provider }, req });
    res.redirect('/');
  } catch (e) {
    console.error('[oauth] finish 失败:', e.message);
    res.redirect('/signin.html?err=oauth_create');
  }
}
app.get('/api/auth/oauth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect('/signin.html?err=google_code');
    const base = oauthBase();
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: base + '/api/auth/oauth/google/callback', grant_type: 'authorization_code',
      }),
    });
    const tok = await tokRes.json();
    if (!tok.access_token) { console.error('[oauth google] token 失败:', tok.error, tok.error_description); return res.redirect('/signin.html?err=google_token'); }
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } });
    const info = await infoRes.json();
    await oauthFinish(req, res, (info.email || '').toLowerCase(), info.name || '', state, 'google');
  } catch (e) { console.error('[oauth google]', e.message); res.redirect('/signin.html?err=google_err'); }
});
app.get('/api/auth/oauth/github/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect('/signin.html?err=gh_code');
    const base = oauthBase();
    const tokRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code, client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET,
        redirect_uri: base + '/api/auth/oauth/github/callback',
      }),
    });
    const tok = await tokRes.json();
    if (!tok.access_token) { console.error('[oauth github] token 失败:', tok.error, tok.error_description); return res.redirect('/signin.html?err=gh_token'); }
    const ghRes = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + tok.access_token, 'User-Agent': 'pingory' } });
    const gh = await ghRes.json();
    const emRes = await fetch('https://api.github.com/user/emails', { headers: { Authorization: 'Bearer ' + tok.access_token, 'User-Agent': 'pingory' } });
    const ems = await emRes.json();
    let email = (gh.email || '').toLowerCase();
    if (!email && Array.isArray(ems)) {
      const primary = ems.find((e) => e.primary && e.verified) || ems.find((e) => e.verified) || ems[0];
      if (primary) email = (primary.email || '').toLowerCase();
    }
    await oauthFinish(req, res, email, gh.name || gh.login || '', state, 'github');
  } catch (e) { console.error('[oauth github]', e.message); res.redirect('/signin.html?err=gh_err'); }
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await getUserById(req.session.userId);
  res.json({ user: user || null });
});

// 渠道配置规范化（账户渠道保存 / 测试发送共用）：去空、按渠道字段白名单，全空返回 null。
function normalizeChannelCfg(ch, cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  if (ch === 'telegram') {
    const botToken = s(cfg.botToken), chatId = s(cfg.chatId);
    return (botToken && chatId) ? { botToken, chatId } : null;
  }
  const url = s(cfg.url);
  return url ? { url } : null;
}

// ===== 监控 CRUD API（需登录）=====
// 规范化 + 校验 target：兼容用户只填域名（自动补 https://），非 HTTP 类自动取 host。
// 返回 { url } 或 { err }。
function normalizeTarget(type, rawUrl) {
  const s = String(rawUrl == null ? '' : rawUrl).trim();
  if (!s) return { err: apiErr(E.URL_REQUIRED) };
  const httpLike = ['http', 'keyword', 'api', 'heartbeat'];
  const looksUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (httpLike.includes(type)) {
    const u = looksUrl ? s : 'https://' + s;
    try { return { url: new URL(u).toString() }; }
    catch { return { err: apiErr(E.URL_INVALID, { url: s }) }; }
  }
  // 非 HTTP 类（ping/tcp/ssl/domain/dns）：需要主机名；用户粘贴完整 URL 时自动取其 host
  if (looksUrl) {
    try { return { url: new URL(s).hostname }; }
    catch { return { err: apiErr(E.URL_INVALID, { url: s }) }; }
  }
  return { url: s };
}

app.post('/api/monitors', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  const plan = user?.plan ?? 'free';
  // 管理员可在后台用 monitor_limit 覆盖套餐默认监控数（null 则用套餐默认）
  const limit = user?.monitorLimit != null ? user.monitorLimit : (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free);
  const count = (await listMonitors(userId)).length;
  if (count >= limit) {
    return res.status(403).json(apiErr(E.PLAN_MONITOR_LIMIT, { plan, limit }));
  }
  // 防薅羊毛：未验证邮箱的账号，监控数上限进一步压低（验证后放开到套餐上限）
  if (!user?.emailVerified && count >= EMAIL_VERIFY_MONITOR_CAP) {
    return res.status(403).json(apiErr(E.EMAIL_VERIFY_REQUIRED, { cap: EMAIL_VERIFY_MONITOR_CAP }));
  }
  const { url, name, interval, type: rawType, config = {}, channels = null, statusPublic = false } = req.body || {};
  // 防御：type 缺失或为空串时按 http 处理（否则会直落套餐校验被 403，用户表现为「无法添加监控」）
  const type = (rawType == null || String(rawType).trim() === '') ? 'http' : String(rawType).trim();
  if (!url) return res.status(400).json(apiErr(E.URL_REQUIRED));

  if (!planHasType(plan, type)) {
    return res.status(403).json(apiErr(E.PLAN_TYPE_NOT_SUPPORTED, { plan, type: TYPE_LABELS[type] || type }));
  }
  const minInterval = planMinInterval(plan);
  const parsedInterval = interval ? Number(interval) : minInterval;
  if (parsedInterval < minInterval) {
    return res.status(400).json(apiErr(E.PLAN_MIN_INTERVAL, { plan, minInterval }));
  }
  const nres = normalizeTarget(type, url);
  if (nres.err) return res.status(400).json(nres.err);

  // 渠道按套餐过滤
  let safeChannels = null;
  if (channels && typeof channels === 'object') {
    safeChannels = {};
    for (const [ch, cfg] of Object.entries(channels)) {
      if (cfg && cfg.enabled && planHasChannel(plan, ch)) safeChannels[ch] = cfg;
    }
  }

  // 状态页可见性受套餐限制
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
    recordUserEvent({ userId, eventType: 'monitor_create', metadata: { url: monitor.url, type: monitor.type, interval: monitor.interval }, req });
    res.status(201).json(monitor);
  } catch (err) {
    res.status(400).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// ===== 一键导入（#288）：UptimeRobot 原生 + 通用 CSV/JSON =====
function safeJsonParse(s) { try { return JSON.parse(s); } catch { return {}; } }
function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (!lines.length) return [];
  const splitLine = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  };
  const header = splitLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((l) => {
    const cells = splitLine(l);
    const obj = {};
    header.forEach((h, idx) => { obj[h] = (cells[idx] ?? '').trim(); });
    return obj;
  });
}
function normalizeGeneric(row) {
  const cfg = (typeof row.config === 'string' && row.config) ? safeJsonParse(row.config) : (row.config || {});
  return {
    name: row.name || row.url || 'Imported',
    url: (row.url || row.address || row.target || '').toString().trim(),
    type: (row.type || 'http').toString().toLowerCase(),
    interval: Number(row.interval) || 0,
    config: cfg,
  };
}
function normalizeUptimeRobot(row) {
  let type = (row.type || row.monitor_type || 'HTTPS').toString().toUpperCase();
  let url = (row.url || row.address || '').toString().trim();
  const config = {};
  if (type === 'HTTPS' || type === 'HTTP') type = 'http';
  else if (type === 'PING') type = 'ping';
  else if (type === 'PORT') {
    type = 'tcp';
    const mm = url.match(/:(\d+)\s*$/);
    if (mm) { config.port = Number(mm[1]); url = url.replace(/:\d+\s*$/, ''); }
  } else if (type === 'KEYWORD') type = 'keyword';
  else if (type === 'HEARTBEAT') type = 'heartbeat';
  else type = 'http';
  if (row.keyword) config.keyword = String(row.keyword);
  return { name: row.name || url || 'Imported', url, type: type.toLowerCase(), interval: Number(row.interval) || 0, config };
}
function parseImportMonitors(format, raw) {
  if (format === 'json') {
    const arr = JSON.parse(raw);
    const list = Array.isArray(arr) ? arr : (Array.isArray(arr?.monitors) ? arr.monitors : []);
    return list.map(normalizeGeneric);
  }
  if (format === 'csv') return parseCsv(raw).map(normalizeGeneric);
  if (format === 'uptimerobot') {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map(normalizeUptimeRobot); } catch {}
    return parseCsv(raw).map(normalizeUptimeRobot);
  }
  return [];
}

app.post('/api/monitors/import', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  const plan = user?.plan ?? 'free';
  const { format, data } = req.body || {};
  if (!['uptimerobot', 'csv', 'json'].includes(format)) return res.status(400).json(apiErr(E.IMPORT_UNSUPPORTED));
  if (!data || typeof data !== 'string' || !data.trim()) return res.status(400).json(apiErr(E.IMPORT_NO_DATA));
  let rows;
  try { rows = parseImportMonitors(format, data); }
  catch (e) { return res.status(400).json(apiErr(E.IMPORT_PARSE_FAILED, { msg: e.message })); }
  if (!rows.length) return res.status(400).json(apiErr(E.IMPORT_NO_MONITORS));
  const limit = user?.monitorLimit != null ? user.monitorLimit : (PLAN_LIMITS[plan] ?? PLAN_LIMITS.free);
  const minInterval = planMinInterval(plan);
  let created = 0, skipped = 0; const reasons = new Set();
  for (const r of rows) {
    if ((await listMonitors(userId)).length >= limit) { reasons.add('plan monitor limit reached'); break; }
    let type = (r.type || 'http').toString().toLowerCase();
    if (!planHasType(plan, type)) type = 'http'; // 不支持的类型降级到 http（free 也支持）
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
  recordUserEvent({ userId, eventType: 'monitor_import', metadata: { format, created, skipped }, req });
  res.json({ ok: true, created, skipped, skippedReasons: [...reasons] });
});

// 部分更新（配置 / 渠道 / 状态页可见性）
app.patch('/api/monitors/:id', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    const m = await getMonitor(req.params.id);
    if (!m || m.userId !== userId) return res.status(404).json(apiErr(E.MONITOR_NOT_FOUND));
    const plan = (await getUserById(userId))?.plan ?? 'free';
    const { config, channels, statusPublic, interval, name } = req.body || {};
    if (config !== undefined) m.config = config;
    if (interval !== undefined) {
      const minI = planMinInterval(plan);
      const v = Number(interval);
      if (v < minI) return res.status(400).json(apiErr(E.PLAN_MIN_INTERVAL, { plan, minInterval: minI }));
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
    recordUserEvent({ userId, eventType: 'monitor_update', metadata: { id: m.id, url: m.url, type: m.type }, req });
    res.json(m);
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 趋势统计（G6）
app.get('/api/monitors/:id/stats', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    const m = await getMonitor(req.params.id);
    if (!m || m.userId !== userId) return res.status(404).json(apiErr(E.MONITOR_NOT_FOUND));
    const plan = (await getUserById(userId))?.plan ?? 'free';
    if (!planHasStats(plan)) return res.status(403).json(apiErr(E.TREND_REQUIRES_STARTER));
    const days = Number(req.query.days) || 30;
    const stats = await getStats(req.params.id, days);
    res.json(stats);
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// Heartbeat 上报端点（G1，无需登录，凭监控 id）
app.post('/api/heartbeat/:id', async (req, res) => {
  try {
    const m = await getMonitor(req.params.id);
    if (!m) return res.status(404).json(apiErr(E.MONITOR_NOT_FOUND));
    m.lastSuccessAt = Date.now();
    if (m.status === 'down') m.status = 'up';
    await saveMonitor(m);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// ===== G7 私有状态页访问令牌（HMAC capability cookie，避免引入 cookie-parser 依赖）=====
const STATUS_PAGE_SECRET = process.env.STATUS_PAGE_SECRET || process.env.SESSION_SECRET || 'pingory-status-default-secret';
function statusPageToken(slug) {
  return crypto.createHmac('sha256', STATUS_PAGE_SECRET).update('sp:' + slug).digest('hex');
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
function statusPageUnlocked(req, slug) {
  const c = getCookie(req, 'pingory_sp');
  if (!c) return false;
  const [s, t] = c.split('|');
  return s === slug && t === statusPageToken(slug);
}

// 把监控原始时序降采样为每日 sparkline（至多 30 点），供公开状态页展示
function dailySpark(series) {
  if (!series || !series.length) return [];
  const byDay = new Map();
  for (const p of series) {
    const day = new Date(p.ts).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(p);
  }
  const out = [];
  for (const [day, arr] of byDay) {
    const rts = arr.filter((p) => p.rt != null).map((p) => p.rt);
    out.push({ day, avgRt: rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null, down: arr.some((p) => p.status === 'down') });
  }
  return out.slice(-30);
}

// 公开状态页数据（G5/G7，无需登录）
app.get('/api/status/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const page = await getStatusPage(slug);
    if (!page) return res.status(404).json(apiErr(E.SP_NOT_FOUND));
    if (page.private && !statusPageUnlocked(req, slug)) {
      return res.status(401).json({ needsPassword: true, whiteLabel: page.whiteLabel });
    }
    const enriched = await Promise.all(page.monitors.map(async (m) => {
      const s = await getStats(m.id, 30);
      return { ...m, uptime: s.uptime, avgRt: s.avgRt, spark: dailySpark(s.series) };
    }));
    const incidents = await getStatusIncidents(page.monitors.map((m) => m.id), 30, 20);
    res.json({ title: page.title, whiteLabel: page.whiteLabel, monitors: enriched, incidents });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 自定义域名：按 Host 解析状态页（G7）
app.get('/api/status-page', async (req, res) => {
  try {
    const host = (req.hostname || '').toLowerCase();
    const page = await getStatusPageByHost(host);
    if (!page) return res.status(404).json(apiErr(E.SP_NO_DOMAIN));
    const slug = req.params.slug; // undefined；host 解析无需 slug
    if (page.private && !statusPageUnlocked(req, host)) {
      return res.status(401).json({ needsPassword: true, whiteLabel: page.whiteLabel });
    }
    const enriched = await Promise.all(page.monitors.map(async (m) => {
      const s = await getStats(m.id, 30);
      return { ...m, uptime: s.uptime, avgRt: s.avgRt, spark: dailySpark(s.series) };
    }));
    const incidents = await getStatusIncidents(page.monitors.map((m) => m.id), 30, 20);
    res.json({ title: page.title, whiteLabel: page.whiteLabel, monitors: enriched, incidents });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 公开状态页 HTML（G5/G7，无需登录）
app.get('/status/:slug', (req, res) => {
  res.sendFile('status.html', { root: 'public' });
});

// 私有状态页解锁（G7，公开）
app.post('/api/status/:slug/unlock', async (req, res) => {
  try {
    const slug = req.params.slug;
    const auth = await getStatusPageAuth(slug, false);
    if (!auth) return res.status(404).json(apiErr(E.SP_NOT_FOUND));
    const { password } = req.body || {};
    const ok = await verifyPagePassword(password || '', auth.passwordHash);
    if (!ok) return res.status(401).json(apiErr(E.WRONG_PASSWORD));
    res.cookie('pingory_sp', `${slug}|${statusPageToken(slug)}`, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400 * 1000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 自定义域名解锁（G7，按 Host）
app.post('/api/status-page/unlock', async (req, res) => {
  try {
    const host = (req.hostname || '').toLowerCase();
    const auth = await getStatusPageAuth(host, true);
    if (!auth) return res.status(404).json(apiErr(E.SP_NO_DOMAIN));
    const { password } = req.body || {};
    const ok = await verifyPagePassword(password || '', auth.passwordHash);
    if (!ok) return res.status(401).json(apiErr(E.WRONG_PASSWORD));
    res.cookie('pingory_sp', `${host}|${statusPageToken(host)}`, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 86400 * 1000 });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 订阅状态页（G7，公开）
app.post('/api/status/:slug/subscribe', async (req, res) => {
  try {
    const slug = req.params.slug;
    const ownerId = await getStatusPageOwnerId(slug, false);
    if (!ownerId) return res.status(404).json(apiErr(E.SP_NOT_FOUND));   // 错误码化：禁止裸中文串（前端按 err.sp_not_found 翻译）
    const { email } = req.body || {};
    const added = await addSubscriber(ownerId, email);
    recordUserEvent({ userId: ownerId, eventType: 'subscriber_add', metadata: { email: added, source: 'status_page' }, req });
    res.json({ ok: true, email: added });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 自定义域名订阅（G7，按 Host）
app.post('/api/status-page/subscribe', async (req, res) => {
  try {
    const host = (req.hostname || '').toLowerCase();
    const ownerId = await getStatusPageOwnerId(host, true);
    if (!ownerId) return res.status(404).json(apiErr(E.SP_NO_DOMAIN));
    const { email } = req.body || {};
    const added = await addSubscriber(ownerId, email);
    recordUserEvent({ userId: ownerId, eventType: 'subscriber_add', metadata: { email: added, source: 'status_page_custom_domain' }, req });
    res.json({ ok: true, email: added });
  } catch (err) {
    res.status(400).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 管理：列出订阅者（G7，需登录且为状态页主）
app.get('/api/me/subscribers', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const list = await listSubscribers(userId);
  res.json(list);
});

// 管理：删除订阅者（G7）
app.delete('/api/me/subscribers/:id', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const ok = await removeSubscriber(userId, req.params.id);
  if (ok) recordUserEvent({ userId, eventType: 'subscriber_remove', metadata: { id: req.params.id }, req });
  res.json({ ok });
});

// 状态页设置（G5/G7 扩展：自定义域名 / 白标 / 私有密码）
app.patch('/api/me/status-page', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  if (!planHasStatusPage(user?.plan)) return res.status(403).json(apiErr(E.SP_REQUIRES_STARTER));
  const { enabled, slug, customDomain, whiteLabel, password, title } = req.body || {};
  // 高级状态页能力（自定义域名/白标/私有/自定义标题）仅 Pro
  if ((customDomain !== undefined || whiteLabel !== undefined || password !== undefined || title !== undefined) && user.plan !== 'pro') {
    return res.status(403).json(apiErr(E.SP_PRO_ONLY));
  }
  await updateStatusPage(userId, { enabled, slug, customDomain, whiteLabel, password, title });
  recordUserEvent({ userId, eventType: 'status_page_update', metadata: { enabled, slug, customDomain, whiteLabel, title }, req });
  const updated = await getUserById(userId);
  res.json({ user: updated });
});

// 手动触发月度报告（G6，仅管理员）
app.post('/api/admin/monthly-report', requireAdmin, async (req, res) => {
  const sent = await generateMonthlyReport(req.admin.id);
  res.json({ sent });
});

// 当前套餐可用能力（前端渲染表单用）
app.get('/api/plan-features', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  const plan = user?.plan ?? 'free';
  res.json({ plan, features: planFeatures(plan), typeLabels: TYPE_LABELS, channelLabels: CHANNEL_LABELS, minInterval: planMinInterval(plan) });
});

app.get('/api/monitors', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    const monitors = await listMonitors(userId);
    res.json(monitors);
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.delete('/api/monitors/:id', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    const m = await getMonitor(req.params.id);
    const ok = await deleteMonitor(req.params.id, userId);
    if (!ok) return res.status(404).json(apiErr(E.MONITOR_NO_PERM));
    recordUserEvent({ userId, eventType: 'monitor_delete', metadata: { id: req.params.id, url: m?.url, type: m?.type }, req });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.get('/api/monitors/:id/history', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    const m = await getMonitor(req.params.id);
    if (!m || m.userId !== userId) return res.status(404).json(apiErr(E.MONITOR_NOT_FOUND));
    const events = await getHistory(req.params.id, 50);
    res.json(events);
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// ===== 客户反馈（G-FEEDBACK，公开、限流）=====
app.post('/api/feedback', feedbackLimiter, async (req, res) => {
  try {
    const { message, email, page } = req.body || {};
    if (!message || !String(message).trim()) return res.status(400).json(apiErr(E.FEEDBACK_EMPTY));
    if (String(message).length > 2000) return res.status(400).json(apiErr(E.FEEDBACK_TOO_LONG));
    const userId = req.session.userId || null;
    const id = crypto.randomUUID();
    const refPage = (page ? String(page) : (req.headers.referer || '')).slice(0, 500);
    const normEmail = email ? String(email).trim().toLowerCase()
      : (userId ? (await getUserById(userId))?.email : null);
    const pool = await getPool();
    await pool.query(
      `INSERT INTO feedback (id, user_id, email, message, page) VALUES ($1,$2,$3,$4,$5)`
      , [id, userId, normEmail, String(message).trim(), refPage]
    );
    await sendFeedbackNotification({ email: normEmail, message: String(message).trim(), page: refPage });
    recordUserEvent({ userId, eventType: 'feedback_submit', metadata: { email: normEmail, page: refPage }, req });
    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// ===== 超级管理员后台（G-ADMIN）=====
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  getUserById(req.session.userId).then((u) => {
    if (!u || u.role !== 'admin') return res.status(403).json(apiErr(E.ADMIN_REQUIRED));
    req.admin = u;
    next();
  }).catch(() => res.status(500).json(apiErr(E.SERVER_ERROR)));
}

// Account API 鉴权（G9）：Bearer <api_key>
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json(apiErr(E.MISSING_AUTH_HEADER));
  getUserByApiKey(m[1].trim()).then((u) => {
    if (!u) return res.status(403).json(apiErr(E.INVALID_API_KEY));
    req.apiUser = u;
    next();
  }).catch(() => res.status(500).json(apiErr(E.SERVER_ERROR)));
}

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const users = await pool.query('SELECT COUNT(*) FROM users');
    const monitors = await pool.query('SELECT COUNT(*) FROM monitors');
    const down = await pool.query("SELECT COUNT(*) FROM monitors WHERE status = 'down'");
    const fb = await pool.query("SELECT COUNT(*) FROM feedback WHERE status = 'new'");
    const paid = await pool.query("SELECT COUNT(*) FROM users WHERE plan <> 'free'");
    res.json({
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
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const { q, plan, role, banned } = req.query;
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
    res.json(rows.map((r) => ({
      ...r,
      monitorCount: Number(r.monitor_count),
      banned: !!r.banned,
      monitorLimit: r.monitor_limit ?? null,
      lastLogin: r.last_login ?? null,
    })));
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 用户详情：基本信息 + 监控列表 + 订阅数（超级管理员排查用）
app.get('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json(apiErr(E.USER_NOT_FOUND));
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
    res.json({
      id: u.id, email: u.email, name: u.name, plan: u.plan, role: u.role,
      emailVerified: !!u.email_verified, banned: !!u.banned,
      monitorLimit: u.monitor_limit ?? null, lastLogin: u.last_login ?? null,
      createdAt: u.created_at, monitorCount: Number(mon.rowCount),
      subscriberCount: Number(sub.rows[0].count), monitors: mon.rows,
      events: events.rows.map((r) => ({ eventType: r.event_type, metadata: parseJSON(r.metadata), createdAt: r.created_at })),
    });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 封禁 / 解封（不能封自己，避免锁死管理员）
app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  try {
    if (req.session.userId === req.params.id) return res.status(400).json(apiErr(E.SELF_BAN));
    const { banned } = req.body || {};
    const pool = await getPool();
    await pool.query('UPDATE users SET banned = $2 WHERE id = $1', [req.params.id, banned ? true : false]);
    recordUserEvent({ userId: req.admin.id, eventType: 'admin_ban_user', metadata: { targetUserId: req.params.id, banned: !!banned }, req });
    res.json({ ok: true, banned: !!banned });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 删除用户及其全部监控（不能删自己）
app.post('/api/admin/users/:id/delete', requireAdmin, async (req, res) => {
  try {
    if (req.session.userId === req.params.id) return res.status(400).json(apiErr(E.SELF_DELETE));
    const pool = await getPool();
    recordUserEvent({ userId: req.admin.id, eventType: 'admin_delete_user', metadata: { targetUserId: req.params.id }, req });
    await pool.query('DELETE FROM monitors WHERE user_id = $1', [req.params.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 监控数配额覆盖（limit 为 null 则恢复套餐默认）
app.post('/api/admin/users/:id/quota', requireAdmin, async (req, res) => {
  try {
    const { limit } = req.body || {};
    const lim = (limit === null || limit === '' || limit === undefined) ? null : Number(limit);
    if (lim !== null && (!Number.isInteger(lim) || lim < 1)) return res.status(400).json(apiErr(E.INVALID_MONITOR_LIMIT));
    const pool = await getPool();
    await pool.query('UPDATE users SET monitor_limit = $2 WHERE id = $1', [req.params.id, lim]);
    recordUserEvent({ userId: req.admin.id, eventType: 'admin_set_quota', metadata: { targetUserId: req.params.id, limit: lim }, req });
    res.json({ ok: true, monitorLimit: lim });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.get('/api/admin/monitors', requireAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT m.id, m.url, m.name, m.type, m.status, m.interval, m.last_checked,
              u.email AS owner_email
       FROM monitors m LEFT JOIN users u ON u.id = m.user_id
       ORDER BY m.last_checked DESC NULLS LAST LIMIT 500`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/feedback', requireAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const { rows } = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC LIMIT 200');
    res.json(rows);
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.post('/api/admin/users/:id/plan', requireAdmin, async (req, res) => {
  try {
    const { plan } = req.body || {};
    if (!['free', 'starter', 'pro'].includes(plan)) return res.status(400).json(apiErr(E.INVALID_PLAN));
    await updatePlan(req.params.id, plan);
    recordUserEvent({ userId: req.admin.id, eventType: 'admin_set_plan', metadata: { targetUserId: req.params.id, plan }, req });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.post('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const { role } = req.body || {};
    await setRole(req.params.id, role === 'admin' ? 'admin' : 'user');
    recordUserEvent({ userId: req.admin.id, eventType: 'admin_set_role', metadata: { targetUserId: req.params.id, role }, req });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 以某用户身份登录（便于超级账号测试各项功能）
app.post('/api/admin/impersonate/:id', requireAdmin, async (req, res) => {
  req.session.userId = req.params.id;
  res.json({ ok: true });
});

// 方案C + 方案一：owner 收入/增长分析（读归一化账本 billing_events + 现有 users/referrals 数据；与具体收款方解耦）
// 集成在既有管理后台，owner 用同一超级管理员账号进入 /admin.html 即可查看。
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const totalRes = await pool.query('SELECT COUNT(*) FROM users');
    const totalUsers = Number(totalRes.rows[0].count);
    const planRes = await pool.query('SELECT plan, COUNT(*) AS c FROM users GROUP BY plan');
    const planMap = {};
    planRes.rows.forEach((r) => { planMap[r.plan] = Number(r.c); });
    const paidUsers = (planMap.starter || 0) + (planMap.pro || 0);
    const freeUsers = planMap.free || 0;

    // 方案C 账本：总收入 / 近30天收入 / 主币种
    const revRes = await pool.query(`
      SELECT COALESCE(SUM(amount_cents),0) AS total,
             COALESCE(SUM(CASE WHEN ts >= now() - interval '30 days' THEN amount_cents END),0) AS last30,
             (SELECT currency FROM billing_events ORDER BY ts DESC LIMIT 1) AS cur
      FROM billing_events`);
    const totalCents = Number(revRes.rows[0].total);
    const rev30Cents = Number(revRes.rows[0].last30);
    const currency = revRes.rows[0].cur || 'USD';

    // MRR（近30天口径）：年付金额除以 12 归一为月，订阅取消事件不计入收入
    const mrrRes = await pool.query(`
      SELECT COALESCE(SUM(CASE WHEN billing_cycle='annual' THEN amount_cents/12.0 ELSE amount_cents END),0) AS mrr
      FROM billing_events WHERE ts >= now() - interval '30 days' AND event_type <> 'subscription_canceled'`);
    const mrrCents = Math.round(Number(mrrRes.rows[0].mrr));

    const byProvider = await pool.query(`
      SELECT provider, COALESCE(SUM(amount_cents),0) AS cents FROM billing_events GROUP BY provider ORDER BY cents DESC`);
    // 当日口径（UTC 零点起）：今日新增用户 / 今日收入 / 平台总监控数
    const todayRes = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')) AS new_users,
        (SELECT COALESCE(SUM(amount_cents),0) FROM billing_events
          WHERE ts >= date_trunc('day', now() AT TIME ZONE 'UTC') AND event_type <> 'subscription_canceled') AS today_cents,
        (SELECT COUNT(*) FROM monitors) AS total_monitors`);
    const todayNewUsers = Number(todayRes.rows[0].new_users);
    const todayCents = Number(todayRes.rows[0].today_cents);
    const totalMonitors = Number(todayRes.rows[0].total_monitors);

    // 简单页面分析：今日访问、来源国家、平均停留时长、当前在线
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

    const conversionRate = totalUsers ? +( (paidUsers / totalUsers) * 100 ).toFixed(1) : 0;
    const arpuCents = totalUsers ? Math.round(totalCents / totalUsers) : 0;

    res.json({
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
    res.status(500).json({ error: err.message });
  }
});

// ===== 用户行为事件（admin 判断用户是否真正在使用 SaaS）=====
app.get('/api/admin/user-events', requireAdmin, async (req, res) => {
  try {
    const userId = req.query.userId || null;
    const eventType = req.query.eventType || null;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const events = await listUserEvents({ userId, eventType, limit, offset });
    res.json(events);
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.get('/api/admin/user-events/summary', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 1, 90);
    const summary = await getUserEventSummary(days);
    res.json(summary);
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// 按用户分组活跃度排行：高频用户 + 沉睡用户
app.get('/api/admin/user-events/ranking', requireAdmin, async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const active = await getUserActivityRanking({ days, limit });
    const dormant = await getDormantUsers({ sinceDays: days, limit });
    res.json({ active, dormant });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

// ============================================================
// G8 维护窗口（计划性停机期间不误报告警）
// ============================================================
app.get('/api/maintenance-windows', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  res.json(await listMaintenanceWindows(userId));
});

app.post('/api/maintenance-windows', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    const { title, monitorIds, startAt, endAt } = req.body || {};
    const id = await createMaintenanceWindow(userId, { title, monitorIds, startAt, endAt });
    recordUserEvent({ userId, eventType: 'maintenance_create', metadata: { id, title, monitorIds }, req });
    res.status(201).json({ id, ok: true });
  } catch (err) {
    res.status(400).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.delete('/api/maintenance-windows/:id', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const ok = await deleteMaintenanceWindow(userId, req.params.id);
  if (ok) recordUserEvent({ userId, eventType: 'maintenance_delete', metadata: { id: req.params.id }, req });
  res.json({ ok });
});

// ============================================================
// G9 团队席位
// ============================================================
app.post('/api/team', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const { name } = req.body || {};
  try {
    const id = await createTeam(userId, name);
    recordUserEvent({ userId, eventType: 'team_create', metadata: { id, name }, req });
    res.status(201).json({ id, ok: true });
  } catch (err) {
    res.status(400).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.post('/api/team/invite', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  if (!user?.teamId) return res.status(403).json(apiErr(E.NO_TEAM));
  try {
    const email = (req.body || {}).email;
    const r = await inviteTeamMember(user.teamId, userId, email);
    recordUserEvent({ userId, eventType: 'team_invite', metadata: { teamId: user.teamId, email, result: r }, req });
    res.json({ ok: true, result: r });
  } catch (err) {
    res.status(400).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.get('/api/team', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const user = await getUserById(userId);
  if (!user?.teamId) return res.json({ team: null });
  const team = await listTeam(user.teamId);
  // 附带团队监控（共享可见）
  const monitors = user.teamId ? await listTeamMonitors(user.teamId) : [];
  res.json({ team: team ? { ...team, monitors } : null });
});

app.post('/api/team/leave', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  await leaveTeam(userId);
  recordUserEvent({ userId, eventType: 'team_leave', req });
  res.json({ ok: true });
});

// ===== 账户自助管理（P0-3：改密码 / 改昵称 / 改邮箱 / 忘记密码）=====
// 登录态校验统一内联（与现有 /api/me 等一致）
app.post('/api/account/change-password', authLimiter, async (req, res) => {
  if (!req.session.userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const { oldPassword, newPassword } = req.body || {};
  try {
    await changePassword(req.session.userId, oldPassword, newPassword);
    res.json({ ok: true });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

app.post('/api/account/profile', async (req, res) => {
  if (!req.session.userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const { name, password } = req.body || {};
  try {
    if (password) {
      // OAuth 用户设置密码（无需旧密码）
      await setPassword(req.session.userId, password);
    } else if (name !== undefined) {
      await updateProfileName(req.session.userId, name);
    }
    const user = await getUserById(req.session.userId);
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

app.post('/api/account/change-email', async (req, res) => {
  if (!req.session.userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const { newEmail } = req.body || {};
  try {
    const token = await requestEmailChange(req.session.userId, newEmail);
    const user = await getUserById(req.session.userId);
    if (token && user) await sendChangeEmailVerification(newEmail, token);
    res.json({ ok: true, message: 'We sent a confirmation link to your new email' });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

app.post('/api/account/confirm-email', async (req, res) => {
  const { token } = req.body || {};
  try {
    const user = await confirmEmailChange(token);
    if (!user) return res.status(400).json({ error: E.INVALID_CONFIRM_LINK });
    res.json({ ok: true, email: user.email });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

// ===== 账户级告警渠道（P0-5 Plan A）：凭据配一次，每个监控只勾选开关 =====
app.get('/api/account/channels', async (req, res) => {
  if (!req.session.userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    res.json({ ok: true, channels: await getAlertChannels(req.session.userId) });
  } catch (e) { res.status(500).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

app.post('/api/account/channels', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  try {
    const plan = (await getUserById(userId))?.plan ?? 'free';
    const incoming = (req.body || {}).channels;
    const clean = {};
    if (incoming && typeof incoming === 'object') {
      for (const [ch, cfg] of Object.entries(incoming)) {
        // 套餐外渠道忽略；email 无需凭据（恒开）
        if (ch === 'email' || !planHasChannel(plan, ch)) continue;
        const norm = normalizeChannelCfg(ch, cfg);
        if (norm) clean[ch] = norm;
      }
    }
    const saved = await saveAlertChannels(userId, clean);
    recordUserEvent({ userId, eventType: 'account_channels_update', metadata: { channels: Object.keys(saved) }, req });
    res.json({ ok: true, channels: saved });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

// 测试发送：可用已保存凭据，也可带 config 临时测试未保存的输入（不落库）
app.post('/api/account/channels/test', authLimiter, async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const body = req.body || {};
  const channel = String(body.channel || '');
  if (channel === 'email') return res.status(400).json(apiErr(E.CHANNEL_NOT_SUPPORTED, { plan: 'n/a', channel }));
  try {
    const plan = (await getUserById(userId))?.plan ?? 'free';
    if (!planHasChannel(plan, channel)) {
      return res.status(403).json(apiErr(E.CHANNEL_NOT_SUPPORTED, { plan, channel: CHANNEL_LABELS[channel] || channel }));
    }
    let cfg = body.config ? normalizeChannelCfg(channel, body.config) : null;
    if (!cfg) cfg = (await getAlertChannels(userId))[channel] || null;
    if (!cfg) return res.status(400).json(apiErr(E.CHANNEL_NOT_CONFIGURED, { channel: CHANNEL_LABELS[channel] || channel }));
    const r = await sendTestAlert(channel, cfg);
    if (!r.ok) return res.status(400).json(apiErr(E.SERVER_ERROR, { msg: r.reason || ('HTTP ' + r.status) }));
    res.json({ ok: true });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

// 忘记密码：统一返回，不暴露邮箱是否存在 / 是否密码账号（pwLimiter 防邮件轰炸）
app.post('/api/auth/forgot-password', pwLimiter, async (req, res) => {
  const { email } = req.body || {};
  try {
    const token = await requestPasswordReset(email);
    if (token) {
      const user = await getUserByEmail(email);
      if (user) await sendPasswordResetEmail(user.email, token);
    }
    res.json({ ok: true, message: 'If the email exists, a reset link has been sent' });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

// 用令牌重置密码（pwLimiter 防令牌爆破）
app.post('/api/auth/reset-password', pwLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  try {
    await resetPassword(token, newPassword);
    res.json({ ok: true });
  } catch (e) { res.status(400).json(apiErr(E.SERVER_ERROR, { msg: e.message })); }
});

// ============================================================
// G9 Account API（api_key 鉴权）
// ============================================================
app.post('/api/account/apikey', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  const regenerate = (req.body || {}).regenerate;
  const key = regenerate ? await regenerateApiKey(userId) : await ensureApiKey(userId);
  recordUserEvent({ userId, eventType: regenerate ? 'api_key_regenerate' : 'api_key_view', req });
  res.json({ apiKey: key });
});

app.get('/api/account/apikey', async (req, res) => {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json(apiErr(E.AUTH_REQUIRED));
  res.json({ apiKey: await ensureApiKey(userId) });
});

// ---- Account API v1：用 Bearer api_key 管理监控（无需会话）----
app.get('/api/v1/monitors', requireApiKey, async (req, res) => {
  try {
    const own = await listMonitors(req.apiUser.id);
    let team = [];
    if (req.apiUser.teamId) team = await listTeamMonitors(req.apiUser.teamId);
    res.json({ monitors: [...own, ...team] });
  } catch (err) {
    res.status(500).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.post('/api/v1/monitors', requireApiKey, async (req, res) => {
  try {
    const plan = req.apiUser.plan;
    const { url, name, interval, type = 'http', config = {}, channels = null, statusPublic = false } = req.body || {};
    if (!url) return res.status(400).json(apiErr(E.URL_REQUIRED));
    if (!planHasType(plan, type)) return res.status(403).json(apiErr(E.API_TYPE_NOT_SUPPORTED, { type }));
    const mon = createMonitor({ url, name, interval, userId: req.apiUser.id, type, config, channels });
    mon.statusPublic = !!statusPublic && planHasStatusPage(plan);
    mon.teamId = req.apiUser.teamId || null;
    await saveMonitor(mon);
    recordUserEvent({ userId: req.apiUser.id, eventType: 'monitor_create', metadata: { url: mon.url, type: mon.type, source: 'api' }, req });
    res.status(201).json(mon);
  } catch (err) {
    res.status(400).json(apiErr(E.SERVER_ERROR, { msg: err.message }));
  }
});

app.get('/api/v1/monitors/:id', requireApiKey, async (req, res) => {
  const m = await getMonitor(req.params.id);
  if (!m || (m.userId !== req.apiUser.id && m.teamId !== req.apiUser.teamId)) return res.status(404).json(apiErr(E.MONITOR_NOT_FOUND));
  res.json(m);
});

app.delete('/api/v1/monitors/:id', requireApiKey, async (req, res) => {
  const m = await getMonitor(req.params.id);
  if (!m || (m.userId !== req.apiUser.id && m.teamId !== req.apiUser.teamId)) return res.status(404).json(apiErr(E.MONITOR_NOT_FOUND));
  await deleteMonitor(req.params.id, req.apiUser.id);
  recordUserEvent({ userId: req.apiUser.id, eventType: 'monitor_delete', metadata: { id: req.params.id, url: m.url, type: m.type, source: 'api' }, req });
  res.json({ ok: true });
});

// 健康检查（供编排平台 / Uptime Robot 探测本服务存活）
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), region: process.env.PROBE_REGION_NAME || 'local' });
});

// ===== 未匹配的 /api/* 统一兜底（P1-11）=====
// 背景：未匹配任何 API 路由的请求会落到 Express 默认 404（HTML `Cannot GET /api/xxx`），
// 与全局「错误码 + {error, ep} JSON」约定不一致 —— 前端按 JSON 解析会拿到 HTML 而抛异常。
// 必须注册在全部 API 路由之后、且不拦截非 /api 路径（静态资源/SPA 的默认行为保持不变）。
app.use('/api', (_req, res) => {
  res.status(404).json(apiErr(E.ENDPOINT_NOT_FOUND));
});

// ===== 启动告警 + 轮询 + 数据库初始化 =====
(async () => {
  await initDb();
  await seedAdmin(); // 启动时按 ADMIN_EMAIL/ADMIN_PASSWORD 建立超级管理员
  startKeepAlive(); // 防止查询间歇冷却（Supabase free 档无休眠，但保留此机制）
  initAlerts();
  startPolling();

  // 月度报告定时任务（G6）：每月 1 号近似触发（每小时检查一次，避免漏跑）
  let lastReportMonth = 0;
  setInterval(async () => {
    const now = new Date();
    const ym = now.getUTCFullYear() * 100 + now.getUTCMonth();
    if (now.getUTCDate() === 1 && ym !== lastReportMonth) {
      lastReportMonth = ym;
      try {
        const { rows } = await (await getPool()).query('SELECT id, plan FROM users');
        for (const u of rows) {
          if (planHasStats(u.plan)) await generateMonthlyReport(u.id);
        }
      } catch (e) {
        console.error('[report] 月度报告失败:', e.message);
      }
    }
  }, 60 * 60 * 1000);

  // === 临时测试端点已删除（Discord 验证通过 2026-09-06） ===

  app.listen(PORT, () => {
    console.log(`Pingory 运行中: http://localhost:${PORT}`);
    console.log(`Paddle 环境: ${process.env.PADDLE_ENVIRONMENT}`);
  });
})();
