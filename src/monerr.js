// 检查失败原因：统一用「稳定错误码」入库与传输，展示层按当前语言翻译。
//
// 背景（2026-09-14 教训）：此前直接把中文串写进 monitors.last_error / monitor_events.error，
// 于是英文/西语用户会在三处看到中文——仪表盘监控列表、事件历史、以及**公开状态页**的事件时间线。
// 与「已修复的告警渠道区不随语言切换」同属一类缺陷：面向用户的多语言位置漏了一处。
//
// 约定：值 = `code` 或 `code|detail...`（detail 用 `|` 分隔，最多 3 段）。
//   前端：t('monerr.'+code) 后替换 {detail} / {p} {a} {e}
//   服务端：告警邮件等无语言偏好的出口用 monErrText() 转成可读英文
//
// ⚠️ 新增检查类型时，错误码必须同步补进：
//   src/monerr.js（本文件）+ public/i18n/*.json 的 monerr.* 8 语键
//   + public/index.html、public/status.html 的 MONERR_CODES 列表。

export const MON_ERR = {
  TIMEOUT: 'timeout',                        // HTTP/fetch 超时（err.name === 'AbortError'）
  KW_MISSING: 'kw_missing',
  KW_NOT_FOUND: 'kw_not_found',
  PING_NO_RESPONSE: 'ping_no_response',
  PING_FAILED: 'ping_failed',
  CONNECT_TIMEOUT: 'connect_timeout',
  SSL_NO_CERT: 'ssl_no_cert',
  SSL_EXPIRED: 'ssl_expired',
  SSL_HANDSHAKE: 'ssl_handshake',
  SSL_TIMEOUT: 'ssl_timeout',
  WHOIS_NO_EXPIRY: 'whois_no_expiry',
  DOMAIN_EXPIRED: 'domain_expired',
  ASSERT_FAILED: 'assert_failed',
  HEARTBEAT_NEVER: 'heartbeat_never',
  HEARTBEAT_LATE: 'heartbeat_late',
  SSL_EXPIRING: 'ssl_expiring',
  DOMAIN_EXPIRING: 'domain_expiring',
};

// 所有已知错误码（前端用；与 public/index.html / status.html 的 MONERR_CODES 保持一致）
export const MON_ERR_CODES = Object.values(MON_ERR);

// 服务端英文文案（告警邮件 / Slack / Webhook / Discord / Telegram 等出口）
const EN = {
  timeout: 'Request timed out',
  kw_missing: 'Keyword check not configured',
  kw_not_found: 'Page does not contain the keyword',
  ping_no_response: 'No ping response',
  ping_failed: 'Ping failed or timed out',
  connect_timeout: 'Connection timed out',
  ssl_no_cert: 'No SSL certificate',
  ssl_expired: 'SSL certificate has expired',
  ssl_handshake: 'SSL handshake failed',
  ssl_timeout: 'SSL connection timed out',
  whois_no_expiry: 'WHOIS did not return expiry information',
  domain_expired: 'Domain has expired',
  assert_failed: 'Assertion failed',
  heartbeat_never: 'No heartbeat received yet',
  heartbeat_late: 'No heartbeat within the expected interval',
  ssl_expiring: 'SSL certificate expires in {detail} days',
  domain_expiring: 'Domain expires in {detail} days',
};

/**
 * 把入库的 `code|detail` 转成可读英文（告警邮件/IM 用）。
 * 未知值（HTTP 500 / ECONNREFUSED / err.message 等本就语言中立）原样返回。
 */
export function monErrText(raw) {
  if (!raw) return '';
  const parts = String(raw).split('|');
  const code = parts[0];
  const label = EN[code];
  if (!label) return String(raw);
  if (code === MON_ERR.ASSERT_FAILED) {
    const [, p, a, e] = parts;
    return `${label}: ${p}=${a}${e ? ' (expected ' + e + ')' : ''}`;
  }
  return parts[1] ? `${label}: ${parts[1]}` : label;
}
