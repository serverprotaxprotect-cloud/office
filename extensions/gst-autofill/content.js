(function () {
  'use strict';

  const DEFAULT_ORIGIN = 'https://geebharat.com';
  const USERNAME_SELECTORS = [
    'input[name="username"]',
    'input[id="username"]',
    'input[formcontrolname="username"]',
    'input[placeholder*="Username" i]',
    'input[placeholder*="User Name" i]',
    'input[type="text"]'
  ];
  const PASSWORD_SELECTORS = [
    'input[name="password"]',
    'input[id="password"]',
    'input[formcontrolname="password"]',
    'input[placeholder*="Password" i]',
    'input[type="password"]'
  ];

  function parseHash() {
    const raw = String(window.location.hash || '').replace(/^#/, '');
    if (!raw) return {};
    return Object.fromEntries(new URLSearchParams(raw));
  }

  function showBadge(message, type) {
    const existing = document.getElementById('gb-gst-autofill-badge');
    if (existing) existing.remove();
    const badge = document.createElement('div');
    badge.id = 'gb-gst-autofill-badge';
    badge.textContent = message;
    badge.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'max-width:360px',
      'padding:12px 14px',
      'border-radius:10px',
      'font:600 13px system-ui,-apple-system,Segoe UI,sans-serif',
      'box-shadow:0 10px 30px rgba(15,23,42,.22)',
      'background:' + (type === 'error' ? '#fee2e2' : '#dcfce7'),
      'color:' + (type === 'error' ? '#991b1b' : '#166534'),
      'border:1px solid ' + (type === 'error' ? '#fecaca' : '#bbf7d0')
    ].join(';');
    document.documentElement.appendChild(badge);
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const found = nodes.find((node) => {
        const rect = node.getBoundingClientRect();
        return !node.disabled && !node.readOnly && rect.width > 0 && rect.height > 0;
      });
      if (found) return found;
    }
    return null;
  }

  function setNativeValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function removeTokenFromHash() {
    const hash = parseHash();
    delete hash.gb_autofill;
    delete hash.gb_origin;
    const next = new URLSearchParams(hash).toString();
    history.replaceState(null, document.title, window.location.pathname + window.location.search + (next ? '#' + next : ''));
  }

  async function run() {
    const hash = parseHash();
    const token = hash.gb_autofill;
    if (!token) return;

    const origin = String(hash.gb_origin || DEFAULT_ORIGIN);
    if (!/^https:\/\/geebharat\.com$/.test(origin) && !/^http:\/\/localhost:\d+$/.test(origin)) {
      showBadge('GeeBharat GST autofill origin invalid.', 'error');
      return;
    }

    showBadge('GeeBharat GST autofill credentials fetch ho raha hai...', 'success');
    let data;
    try {
      const response = await fetch(origin + '/api/gst/autofill/' + encodeURIComponent(token), {
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store'
      });
      data = await response.json();
    } catch (err) {
      showBadge('GeeBharat se credential fetch nahi ho paya. Extension/network check karein.', 'error');
      return;
    }

    if (!data || data.success === false) {
      showBadge(data?.message || 'Autofill token expired. Click Login again from GeeBharat.', 'error');
      return;
    }

    const usernameInput = firstVisible(USERNAME_SELECTORS);
    const passwordInput = firstVisible(PASSWORD_SELECTORS);
    if (!usernameInput || !passwordInput) {
      showBadge('GST login fields nahi mile. Portal page load hone ke baad GeeBharat se Login dobara click karein.', 'error');
      return;
    }

    setNativeValue(usernameInput, data.gst_login_id || '');
    setNativeValue(passwordInput, data.gst_password || '');
    removeTokenFromHash();
    showBadge('GeeBharat autofilled. Captcha complete karke Login manually karein.', 'success');
  }

  setTimeout(run, 500);
})();
