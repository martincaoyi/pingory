/*
 * pw-toggle.js — 密码可见性切换（眼睛按钮）
 * 用法：在页面 </body> 前引入 <script src="/pw-toggle.js"></script>
 * 行为：自动为页面上所有 input[type=password] 注入「眼睛」按钮，点击切换明文/密文。
 *   - 想跳过某个输入框：给它加 data-no-pw-toggle 属性。
 *   - 多语言：读取全局 t()（页面已定义时）的 pw.show / pw.hide；语言切换后调用 window.__pwToggleRefresh() 刷新 aria-label。
 */
(function () {
  'use strict';

  var CSS_ID = 'pw-toggle-css';
  var EYE_OPEN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 3l18 18"/>' +
    '<path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17.4 17.4 0 0 1-3.3 3.9"/>' +
    '<path d="M6.2 7.6A17.3 17.3 0 0 0 2 12s3.6 6 10 6a9.7 9.7 0 0 0 4-.8"/>' +
    '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = [
      /* 包裹层只负责定位，不改变输入框原有宽度表现 */
      '.pw-wrap{position:relative;display:block;width:100%;}',
      /* 给右侧图标留出空间，避免文字压到图标下面 */
      '.pw-wrap>input{padding-right:42px;}',
      /* 注意：min-width:0 必须写，否则会被父级/全局 input 的 min-width 规则撑宽（本项目踩过 min-width>width 的坑） */
      '.pw-eye{position:absolute;top:0;right:0;height:100%;width:42px;min-width:0;max-width:none;',
      'display:flex;align-items:center;justify-content:center;padding:0;margin:0;',
      'background:transparent;border:0;border-radius:0 8px 8px 0;cursor:pointer;',
      'color:var(--muted,#5d6b63);line-height:0;-webkit-appearance:none;appearance:none;}',
      '.pw-eye:hover{color:var(--accent,#1faa6b);}',
      '.pw-eye svg{display:block;width:18px;height:18px;}',
      '.pw-eye:focus-visible{outline:2px solid var(--accent,#1faa6b);outline-offset:-2px;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function labelText(show) {
    var d = show ? 'Show password' : 'Hide password';
    return (typeof window.t === 'function') ? window.t(show ? 'pw.show' : 'pw.hide', d) : d;
  }

  function sync(btn) {
    var inp = btn.__pwInput;
    var shown = inp.type === 'text';
    btn.innerHTML = shown ? EYE_OFF : EYE_OPEN;      // 显示中就换成「闭眼」图标
    var txt = labelText(!shown);                      // 按钮动作 = 切换后的状态
    btn.setAttribute('aria-label', txt);
    btn.setAttribute('title', txt);
    btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
  }

  function makeToggle(inp) {
    if (inp.hasAttribute('data-no-pw-toggle')) return;
    if (inp.hasAttribute('data-pw-done')) return;
    inp.setAttribute('data-pw-done', '1');

    var wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);

    var btn = document.createElement('button');
    btn.type = 'button';                 // 关键：否则会触发 form 提交
    btn.className = 'pw-eye';
    btn.__pwInput = inp;
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      inp.type = (inp.type === 'password') ? 'text' : 'password';
      sync(btn);
      try { inp.focus({ preventScroll: true }); } catch (_) { inp.focus(); }
    });
    wrap.appendChild(btn);
    sync(btn);
  }

  function init() {
    injectCss();
    var list = document.querySelectorAll('input[type="password"]:not([data-pw-done])');
    Array.prototype.forEach.call(list, makeToggle);
  }

  // 语言切换后刷新按钮文案（页面在 applyI18n() 里调用）
  window.__pwToggleRefresh = function () {
    Array.prototype.forEach.call(document.querySelectorAll('.pw-eye'), sync);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
