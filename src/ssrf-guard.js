// SSRF 守卫：拒绝服务端去抓取内网 / 链路本地 / 云元数据 / 保留段地址。
// 两层使用：
//   ① 创建时 normalizeTarget 调 isBlockedTarget 拦入库（server.js）
//   ② 运行时 runLocalCheck / safeFetch 再校验（覆盖存量数据 + 多区域 worker）
import dns from 'node:dns';
import net from 'node:net';

// Worker 兼容（ADR-0001）：node:dns 在部分 Workers 版本不可用 → 懒加载；
// 缺失时 assertSafeTarget 对域名目标按「解析失败」语义放行（ok:true，交由实际请求报错），
// 与下方 catch 分支的既有设计一致。Fly 路径：动态 import 结果与静态 import 一致，行为零变化。
let _dnsMod = null;
async function getDns() {
  if (_dnsMod === null) { try { _dnsMod = await import('node:dns'); } catch { _dnsMod = false; } }
  return _dnsMod || null;
}

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

// URL 的 hostname 对 IPv6 字面量返回带方括号的形式（`new URL('http://[::1]/').hostname` === '[::1]'），
// 而 net.isIP('[::1]') === 0 ⇒ 会被当成域名去解析、解析失败后又走「放行」分支。
// 这是 P0-S2 的根因，所有入口必须先剥括号再判类型。
function stripBrackets(host) {
  const s = String(host == null ? '' : host).trim();
  return (s.startsWith('[') && s.endsWith(']')) ? s.slice(1, -1) : s;
}

// IPv6 展开成 8 个 16 位整数。返回 null 表示畸形。
// 必须自己展开的原因：只看字符串前缀会漏掉 `0:0:0:0:0:0:0:1`（环回）与
// `::ffff:7f00:1`（IPv4-mapped 127.0.0.1）这类等价写法。
function ipv6Groups(ip) {
  let s = String(ip == null ? '' : ip).toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);         // 去 zone id（fe80::1%eth0）
  const v4 = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) {
    const p = v4[2].split('.').map(Number);
    if (p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${v4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = (halves.length > 1 && halves[1]) ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 1 ? 0 : fill).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

// 危险 IP（内网 / 链路本地 / 云元数据 / CGNAT / 保留段）
function isBlockedIp(ip) {
  const bare = stripBrackets(ip);
  if (!net.isIP(bare)) return true;             // 非法 IP = 危险
  if (net.isIPv4(bare)) {
    const [a, b] = bare.split('.').map(Number);
    if (a === 10) return true;                  // 10.0.0.0/8
    if (a === 127) return true;                 // 127.0.0.0/8 环回
    if (a === 0) return true;                   // 0.0.0.0/8
    if (a === 169 && b === 254) return true;    // 169.254.0.0/16 链路本地 + 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;    // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  // IPv6：展开后按数值判断，覆盖所有等价写法
  const g = ipv6Groups(bare);
  if (!g) return true;                          // 畸形 IPv6 一律按危险处理
  if (g.every((x) => x === 0)) return true;     // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  // ::ffff:a.b.c.d（IPv4-mapped）——按内嵌的 IPv4 再判一次
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isBlockedIp([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.'));
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true;  // fc00::/7 唯一本地
  if ((g[0] & 0xffc0) === 0xfe80) return true;  // fe80::/10 链路本地
  if ((g[0] & 0xff00) === 0xff00) return true;  // ff00::/8 组播
  return false;
}

// 从 URL 字符串安全取出主机名；非 URL（裸主机名）原样返回。
// IPv6 字面量统一剥掉方括号，调用方（含 tls.connect / dns.lookup）才能拿到可用的主机名。
export function hostnameFromUrl(urlStr) {
  try {
    return stripBrackets(new URL(urlStr).hostname);
  } catch {
    return stripBrackets(String(urlStr == null ? '' : urlStr).trim());
  }
}

// 创建时同步校验（不解析 DNS，仅字面量 IP + 主机名规则）
export function isBlockedTarget(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return true;
  let host;
  try { host = stripBrackets(new URL(s).hostname); } catch { host = stripBrackets(s); }   // 裸主机名
  if (isBlockedHostname(host)) return true;
  if (net.isIP(host)) return isBlockedIp(host);
  // 含冒号但不是合法 IP ⇒ 畸形的 IPv6 字面量。绝不能当域名放行（解析必失败 → 旧逻辑判 ok）。
  if (host.includes(':')) return true;
  return false;
}

// 运行时异步校验（含 DNS 解析所有 IP），返回 { ok, reason }
// 注意：仅对「确认危险」返回 ok:false（blocked-*）；DNS 解析失败（no-ip / dns-fail）一律 ok:true，
// 交由实际 fetch / connect 自然失败并产出常规错误 —— 避免把瞬时 DNS 抖动误标成「目标被拦截」。
export async function assertSafeTarget(hostname) {
  const host = stripBrackets(hostnameFromUrl(hostname));
  if (isBlockedHostname(host)) return { ok: false, reason: 'blocked-hostname' };
  if (net.isIP(host)) {
    if (isBlockedIp(host)) return { ok: false, reason: 'blocked-ip' };
    return { ok: true };
  }
  // 含冒号却不是合法 IP = 畸形 IPv6 字面量，直接拒绝（否则会走 DNS 失败 → ok:true 的放行分支）
  if (host.includes(':')) return { ok: false, reason: 'blocked-ip' };
  // 域名：解析全部 IP，任一危险即拒（覆盖"域名解析到内网"）；解析失败则放行交由实际请求报错
  try {
    const dns = await getDns();
    if (!dns || !dns.promises || !dns.promises.lookup) return { ok: true }; // Worker：无 DNS 能力
    const { addresses } = await dns.promises.lookup(host, { all: true });
    if (!addresses || addresses.length === 0) return { ok: true };
    for (const item of addresses) {
      const ip = typeof item === 'string' ? item : item.address;
      if (isBlockedIp(ip)) return { ok: false, reason: 'blocked-resolved-ip' };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

// 带 SSRF 守卫的 fetch：手动处理重定向（对跳转目标再校验），拒绝内网。
// 注：DNS 重绑定(TOCTOU)的理论窗口未完全封堵——需 undici 自定义 connect 钉死解析 IP；
// 本范围以 dns.lookup 预校验 + 重定向再校验覆盖主威胁（认证用户直填内网地址 / 内网域名）。
//
// maxRedirects 默认 1 = 保持历史行为（只跟一跳），9 种既有检查类型逐字节不变。
// 需要跟随完整跳转链的调用方（如 AI 可读性检查，站点常见 http→https→www 两跳）显式传大值。
//
// timeoutMs（P0-S3）：统一超时兜底。fetch 不带 signal 时，对方「只握手不吐 body」
// 会让检查永久挂起、activeChecks 不回收，8 个这样的监控即可占满全局并发导致全站停检。
// 超时对响应体读取同样生效（AbortSignal 会中断 body stream），故 res.text() 也被保护。
export async function safeFetch(urlStr, init = {}, { maxRedirects = 1, timeoutMs = 15000 } = {}) {
  let current = urlStr;
  let hops = 0;

  for (;;) {
    const pre = await assertSafeTarget(hostnameFromUrl(current));
    if (!pre.ok) throw new Error('TARGET_BLOCKED:' + (hops === 0 ? pre.reason : 'redirect'));

    const signal = init.signal
      || (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(timeoutMs)
        : undefined);
    const res = await fetch(current, { ...init, redirect: 'manual', signal });
    if (res.status < 300 || res.status >= 400) return res;

    const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
    if (!loc) return res;
    if (hops >= maxRedirects) return res; // 与旧行为一致：超出预算时把 3xx 原样交回调用方

    let next;
    try { next = new URL(loc, current).toString(); } catch { return res; }
    // 拒绝非 http(s) 跳转（否则 file: / data: 会绕过主机校验）
    if (!/^https?:/i.test(next)) return res;

    hops += 1;
    current = next;
  }
}
