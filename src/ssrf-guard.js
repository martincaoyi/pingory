// SSRF 守卫：拒绝服务端去抓取内网 / 链路本地 / 云元数据 / 保留段地址。
// 两层使用：
//   ① 创建时 normalizeTarget 调 isBlockedTarget 拦入库（server.js）
//   ② 运行时 runLocalCheck / safeFetch 再校验（覆盖存量数据 + 多区域 worker）
import dns from 'node:dns';
import net from 'node:net';

// 危险主机名（无需解析即可判定）
function isBlockedHostname(host) {
  const h = String(host == null ? '' : host).toLowerCase().trim();
  if (!h) return true;                          // 无主机名 = 危险
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  if (h.endsWith('.svc')) return true;
  if (h.endsWith('.cluster')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  return false;
}

// 危险 IP（内网 / 链路本地 / 云元数据 / CGNAT / 保留段）
function isBlockedIp(ip) {
  if (!net.isIP(ip)) return true;               // 非法 IP = 危险
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                  // 10.0.0.0/8
    if (a === 127) return true;                 // 127.0.0.0/8 环回
    if (a === 0) return true;                   // 0.0.0.0/8
    if (a === 169 && b === 254) return true;    // 169.254.0.0/16 链路本地 + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;    // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  // IPv6
  const h = ip.toLowerCase();
  if (h === '::1') return true;                                  // 环回
  if (h.startsWith('fc') || h.startsWith('fd')) return true;     // fc00::/7 唯一本地
  if (h.startsWith('fe8') || h.startsWith('fe9') ||
      h.startsWith('fea') || h.startsWith('feb')) return true;   // fe80::/10 链路本地
  return false;
}

// 从 URL 字符串安全取出主机名；非 URL（裸主机名）原样返回
export function hostnameFromUrl(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return String(urlStr == null ? '' : urlStr).trim();
  }
}

// 创建时同步校验（不解析 DNS，仅字面量 IP + 主机名规则）
export function isBlockedTarget(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return true;
  let host;
  try { host = new URL(s).hostname; } catch { host = s; }   // 裸主机名
  if (isBlockedHostname(host)) return true;
  if (net.isIP(host) && isBlockedIp(host)) return true;
  return false;
}

// 运行时异步校验（含 DNS 解析所有 IP），返回 { ok, reason }
export async function assertSafeTarget(hostname) {
  const host = hostnameFromUrl(hostname);
  if (isBlockedHostname(host)) return { ok: false, reason: 'blocked-hostname' };
  if (net.isIP(host)) {
    if (isBlockedIp(host)) return { ok: false, reason: 'blocked-ip' };
    return { ok: true };
  }
  // 域名：解析全部 IP，任一危险即拒（覆盖"域名解析到内网"）
  try {
    const { addresses } = await dns.promises.lookup(host, { all: true });
    if (!addresses || addresses.length === 0) return { ok: false, reason: 'no-ip' };
    for (const item of addresses) {
      const ip = typeof item === 'string' ? item : item.address;
      if (isBlockedIp(ip)) return { ok: false, reason: 'blocked-resolved-ip' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'dns-fail' };
  }
}

// 带 SSRF 守卫的 fetch：手动处理重定向（对跳转目标再校验），拒绝内网。
// 注：DNS 重绑定(TOCTOU)的理论窗口未完全封堵——需 undici 自定义 connect 钉死解析 IP；
// 本范围以 dns.lookup 预校验 + 重定向再校验覆盖主威胁（认证用户直填内网地址 / 内网域名）。
export async function safeFetch(urlStr, init = {}) {
  const host = hostnameFromUrl(urlStr);
  const pre = await assertSafeTarget(host);
  if (!pre.ok) throw new Error('TARGET_BLOCKED:' + pre.reason);
  const res = await fetch(urlStr, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location');
    if (loc) {
      let next;
      try { next = new URL(loc, urlStr).toString(); } catch { return res; }
      const ns = await assertSafeTarget(hostnameFromUrl(next));
      if (!ns.ok) throw new Error('TARGET_BLOCKED:redirect');
      return fetch(next, { ...init, redirect: 'manual' });
    }
  }
  return res;
}
