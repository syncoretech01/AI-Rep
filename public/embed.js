/*! Syncore AI Receptionist: web chat loader.
 * <script src="https://<app-origin>/embed.js" data-widget-key="wk_..." async></script>
 * Adds a launcher button; the chat runs in an iframe served by the app, so the host page never sees
 * session tokens or provider credentials. */
(() => {
  'use strict';
  // Included twice, or run again after a <body> swap: just re-attach.
  if (window.__syncoreWidget) return window.__syncoreWidget.attach();

  const findScript = () => {
    const current = document.currentScript;
    if (current && current.src) return current;
    const scripts = document.querySelectorAll('script[src]');
    for (let i = scripts.length - 1; i >= 0; i -= 1) {
      if (/\/embed\.js(?:[?#]|$)/.test(scripts[i].src)) return scripts[i];
    }
    return null;
  };

  const script = findScript();
  const key = script && script.getAttribute('data-widget-key');
  if (!key || !/^wk_[A-Za-z0-9]{24,64}$/.test(key)) {
    console.warn('[Syncore] embed.js: missing or invalid data-widget-key; the chat widget was not loaded.');
    return;
  }
  const origin = new URL(script.src).origin;

  const Z = 2147483000;
  const narrow = window.matchMedia('(max-width: 479px)');
  let isOpen = false;
  let container = null;
  let iframe = null;

  // Built with DOM APIs (no innerHTML) so hosts that enforce Trusted Types still work.
  const icon = (d) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const attrs = {
      viewBox: '0 0 24 24', width: '26', height: '26', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false',
    };
    Object.keys(attrs).forEach((name) => svg.setAttribute(name, attrs[name]));
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  };
  const chatIcon = icon('M7.9 20A9 9 0 1 0 4 16.1L2 22Z');
  const closeIcon = icon('M18 6 6 18M6 6l12 12');

  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.setAttribute('aria-label', 'Open chat');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('aria-controls', 'syncore-chat');
  launcher.appendChild(chatIcon);
  Object.assign(launcher.style, {
    position: 'fixed', margin: '0', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '0', borderRadius: '50%', background: '#4f46e5', color: '#fff', cursor: 'pointer',
    boxShadow: '0 6px 20px rgba(15,23,42,.25)',
  });

  // Full screen on narrow viewports, with the launcher pinned above the panel as a close button that needs no iframe.
  const layout = () => {
    const full = narrow.matches;
    Object.assign(launcher.style, isOpen && full
      ? { top: '8px', right: '8px', bottom: 'auto', width: '44px', height: '44px', zIndex: String(Z + 2) }
      : { top: 'auto', right: '20px', bottom: '20px', width: '56px', height: '56px', zIndex: String(Z) });
    if (!container) return;
    Object.assign(container.style, full
      ? { top: '0', right: '0', bottom: '0', left: '0', width: '100%', height: '100%', maxHeight: 'none', borderRadius: '0' }
      : {
        top: 'auto', right: '20px', bottom: '88px', left: 'auto', width: '380px', height: '600px',
        maxHeight: 'calc(100vh - 108px)', borderRadius: '16px',
      });
    container.style.display = isOpen ? 'block' : 'none';
  };

  // On <html>, after <body>: hosts that swap <body> (Turbo Drive, htmx, pjax) keep the widget running.
  const attach = () => {
    if (!document.body) return;
    const root = document.documentElement;
    if (!launcher.isConnected) root.appendChild(launcher);
    if (container && !container.isConnected) root.appendChild(container);
    layout();
  };

  const mount = () => {
    container = document.createElement('div');
    container.id = 'syncore-chat';
    // Box properties are pinned inline so host CSS (e.g. `div { padding: … }`) cannot shift the panel.
    Object.assign(container.style, {
      position: 'fixed', zIndex: String(Z + 1), margin: '0', padding: '0', border: '0', overflow: 'hidden',
      background: '#fff', boxShadow: '0 12px 48px rgba(15,23,42,.28)',
    });
    iframe = document.createElement('iframe');
    iframe.src = `${origin}/widget/${encodeURIComponent(key)}?embedded=1`;
    iframe.title = 'Chat';
    iframe.setAttribute('allow', 'clipboard-write');
    Object.assign(iframe.style, { display: 'block', width: '100%', height: '100%', border: '0' });
    iframe.addEventListener('load', () => {
      if (isOpen) iframe.focus();
    });
    container.appendChild(iframe);
    attach();
  };

  const setOpen = (next) => {
    if (next === isOpen) return;
    const focusWasInside = Boolean(iframe) && document.activeElement === iframe;
    isOpen = next;
    if (isOpen && !container) mount();
    launcher.setAttribute('aria-expanded', String(isOpen));
    launcher.setAttribute('aria-label', isOpen ? 'Close chat' : 'Open chat');
    launcher.replaceChild(isOpen ? closeIcon : chatIcon, isOpen ? chatIcon : closeIcon);
    layout();
    if (isOpen) iframe.focus();
    else if (focusWasInside) launcher.focus();
  };

  launcher.addEventListener('click', () => setOpen(!isOpen));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) setOpen(false);
  });
  window.addEventListener('message', (event) => {
    // Only the widget's own iframe, served from the app origin, may control the panel.
    if (!iframe || event.origin !== origin || event.source !== iframe.contentWindow) return;
    if (event.data && event.data.type === 'syncore:close') setOpen(false);
  });
  if (narrow.addEventListener) narrow.addEventListener('change', layout);
  else narrow.addListener(layout);

  window.__syncoreWidget = { attach };
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);
})();
