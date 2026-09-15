// 套餐能力矩阵（本文件为各档位功能与配额上限的唯一权威源）
// 集中定义，避免 server.js / monitors.js / alerts.js 重复硬编码。

export const PLAN_LIMITS = { free: 50, starter: 100, pro: Infinity };

// 各套餐最低检查间隔（秒）
export const PLAN_MIN_INTERVAL = { free: 300, starter: 60, pro: 30 };

// 防薅羊毛：未验证邮箱的账号，监控数上限更低（验证后才放开到套餐上限）
// 目的：用一次性邮箱批量开免费账号只能各拿极少监控，薅不动；想拿满需逐个验证邮箱。
export const EMAIL_VERIFY_MONITOR_CAP = 3;

// 各套餐开放的检查类型
const TYPES = {
  free: ['http', 'keyword'],
  starter: ['http', 'keyword', 'ping', 'tcp', 'ssl', 'domain', 'api', 'dns', 'heartbeat'],
  pro: ['http', 'keyword', 'ping', 'tcp', 'ssl', 'domain', 'api', 'dns', 'heartbeat'],
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

export function planMinInterval(plan) {
  return PLAN_MIN_INTERVAL[plan] ?? PLAN_MIN_INTERVAL.free;
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
