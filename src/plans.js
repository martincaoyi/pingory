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

export function planFeatures(plan) {
  return {
    types: TYPES[plan] || TYPES.free,
    channels: CHANNELS[plan] || CHANNELS.free,
    statusPage: FLAGS[plan]?.statusPage ?? false,
    multiRegion: FLAGS[plan]?.multiRegion ?? false,
    stats: FLAGS[plan]?.stats ?? false,
  };
}

export function planHasType(plan, type) {
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
