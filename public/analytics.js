/**
 * analytics.js — 轻量页面分析上报（无 cookie，无第三方）
 *
 * 上报内容：来源国家（经 Cloudflare 注入的 cf-ipcountry 头）与停留时长。
 * 身份识别用 sessionStorage 里的一次性 id，关掉标签页即失效，不跨会话追踪。
 *
 * 用法：在每个面向访客的页面 </body> 前引入
 *   <script src="/analytics.js"></script>
 *
 * 切勿引入 admin.html —— 站长自身浏览会污染统计数据。
 *
 * 配套后端：POST /api/analytics/start 与 /api/analytics/ping（见 server.js）
 *   start 每加载一个页面调用一次（page_count +1）
 *   ping  页面可见时每 30 秒一次（duration_seconds +30）
 */
(function () {
  'use strict';
  try {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    var KEY = 'pingory_analytics_sid';
    var sid = sessionStorage.getItem(KEY);
    if (!sid) {
      sid = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(KEY, sid);
    }

    function send(path) {
      var url = '/api/analytics/' + path;
      var body = JSON.stringify({ sid: sid });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
          return;
        }
      } catch (e) {}
      try {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    }

    send('start');
    setInterval(function () { if (!document.hidden) send('ping'); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) send('ping'); });
    window.addEventListener('pagehide', function () { send('ping'); });
  } catch (e) {}
})();
