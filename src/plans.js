// 套餐能力矩阵（本文件为各档位功能与配额上限的唯一权威源）
// 集中定义，避免 server.js / monitors.js / alerts.js 重复硬编码。

export const PLAN_LIMITS = { free: 50, starter: 100, pro: Infinity };

// 各套餐最低检查间隔（秒）
export const PLAN_MIN_INTERVAL = { free: 300, starter: 60, pro: 30 };

// 防薅羊毛：未验证邮箱的账号，监控数上限更低（验证后才放开到套餐上限）
// 目的：用一次性邮箱批量开免费账号只能各拿极少监控，薅不动；想拿满需逐个验证邮箱。
export const EMAIL_VERIFY_MONITOR_CAP = 3;

// 各套餐开放的检查类型
// ai = AI 可读性监护（12 项静态检查）。只给 Pro：免费页 /llms-txt-checker 已向所有人
// 公开单次检查，Starter 再给就没有增量；放在 Pro 才能形成升档动力。
const TYPES = {
  free: ['http', 'keyword'],
  starter: ['http', 'keyword', 'ping', 'tcp', 'ssl', 'domain', 'api', 'dns', 'heartbeat'],
  pro: ['http', 'keyword', 'ping', 'tcp', 'ssl', 'domain', 'api', 'dns', 'heartbeat', 'ai'],
};

// 各套餐开放的告警渠道
const CHANNELS = {
  free: ['email'],
  starter: ['email', 'slack', 'webhook', 'telegram'],
  pro: ['email', 'slack', 'webhook', 'telegram', 'discord', 'teams', 'pagerduty'],
};

const FLAGS = {
  free: { statusPage: false, multiRegion: false, stats: false },
  starter: { statusPage: true, multiRegion: true, stats: true },
  pro: { statusPage: true, multiRegion: true, stats: true },
};

// 🔴 托管（Cloudflare Worker）运行时**不具备**的检查能力（P0-W3，2026-11-18）。
// 这四类依赖 node:child_process / node:tls / node:dns，Workers 下模块缺失，
// 旧行为是「照卖 + 执行时判 down」⇒ 付费用户买到永久 red 的监控 + 持续误告警。
// 因此托管侧必须在**售卖与创建两道口**都收口；自托管仍是 10 类全开。
// 判据不是主观取舍：src/monitors.js:15-40 的懒加载 + PORT-CHECKLIST.md 已自认。
export const HOSTED_UNAVAILABLE_TYPES = Object.freeze(['ping', 'ssl', 'domain', 'dns']);

function filterHosted(types, opts) {
  if (!opts || !opts.hosted) return types;
  return types.filter((t) => !HOSTED_UNAVAILABLE_TYPES.includes(t));
}

// 各套餐的检查历史保留天数（P0-W5，2026-11-18）。
// 对外承诺来自 public/index.html 套餐卡：Free 7 天 / Starter 90 天 / Pro 365 天。
// 此前 src/retention.js 无差别只留 30 天 ⇒ 付费卖点直接虚假（第 31 天就查不到历史）。
// 这里作为唯一真值源，retention 清理与前端文案必须同时对齐。
export const PLAN_RETENTION_DAYS = { free: 7, starter: 90, pro: 365 };

export function planRetentionDays(plan) {
  return PLAN_RETENTION_DAYS[plan] ?? PLAN_RETENTION_DAYS.free;
}

export function planFeatures(plan, opts = {}) {
  return {
    types: filterHosted(TYPES[plan] || TYPES.free, opts),
    channels: CHANNELS[plan] || CHANNELS.free,
    statusPage: FLAGS[plan]?.statusPage ?? false,
    multiRegion: FLAGS[plan]?.multiRegion ?? false,
    stats: FLAGS[plan]?.stats ?? false,
    // 仅托管侧会真的剔除能力；自托管返回空数组，前端据此隐藏首页对应卡片
    unavailableTypes: opts.hosted ? [...HOSTED_UNAVAILABLE_TYPES] : [],
  };
}

// opts.hosted=true 时按托管运行时能力收口（Express/Worker 共用同一判据，避免两套漂移）
export function planHasType(plan, type, opts = {}) {
  if (opts.hosted && HOSTED_UNAVAILABLE_TYPES.includes(type)) return false;
  return (TYPES[plan] || TYPES.free).includes(type);
}

export function planHasChannel(plan, channel) {
  return (CHANNELS[plan] || CHANNELS.free).includes(channel);
}

export function planHasStatusPage(plan) {
  return FLAGS[plan]?.statusPage ?? false;
}

export function planHasStats(plan) {
  return FLAGS[plan]?.stats ?? false;
}

// 生效下限 = max(基础下限, overrides[该档])。
// overrides 只由托管侧（Cloudflare Worker）传入：其 cron 粒度为 1 分钟，30 秒无法兑现，
// 故 wrangler.jsonc 用 PLAN_MIN_INTERVAL_OVERRIDE={"pro":60} 把 Pro 钳到 60。
// 自托管（server.js）不传第二参 ⇒ 30 秒真实保留。基础表 PLAN_MIN_INTERVAL 仍是产品真值，不改。
// 纯函数：override 缺失/非法（非数字、≤0、NaN/Infinity）一律退回基础下限，绝不抛错。
export function planMinInterval(plan, overrides) {
  const key = Object.prototype.hasOwnProperty.call(PLAN_MIN_INTERVAL, plan) ? plan : 'free';
  const base = PLAN_MIN_INTERVAL[key];
  if (!overrides || typeof overrides !== 'object') return base;
  const ov = overrides[key];
  if (typeof ov !== 'number' || !Number.isFinite(ov) || ov <= 0) return base;
  return Math.max(base, ov);
}

// Display names shown in the UI (English site; zh.json mirrors for Chinese)
export const TYPE_LABELS = {
  http: 'HTTP/HTTPS status code',
  keyword: 'Keyword content check',
  ping: 'Ping (ICMP)',
  tcp: 'TCP port',
  ssl: 'SSL certificate',
  domain: 'Domain expiry (WHOIS)',
  api: 'API monitor (Header + JSON assert)',
  dns: 'DNS record',
  heartbeat: 'Heartbeat / Cron dead-man',
  ai: 'AI readability (12 checks)',
};

export const CHANNEL_LABELS = {
  email: 'Email',
  slack: 'Slack',
  webhook: 'Webhook',
  telegram: 'Telegram',
  discord: 'Discord',
  teams: 'MS Teams',
  pagerduty: 'PagerDuty',
};
