(function () {
  'use strict';

  const DEFAULT_ORIGIN = 'https://geebharat.com';
  const USERNAME_SELECTORS = [
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="login" i]',
    'input[id*="login" i]',
    'input[name*="code" i]',
    'input[id*="code" i]',
    'input[type="text"]',
  ];
  const PASSWORD_SELECTORS = [
    'input[name*="password" i]',
    'input[id*="password" i]',
    'input[type="password"]',
  ];

  function paramsFromUrl() {
    const query = new URLSearchParams(window.location.search || '');
    const hash = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
    return {
      token: query.get('gb_pfesic_autofill') || hash.get('gb_pfesic_autofill'),
      origin: query.get('gb_origin') || hash.get('gb_origin') || DEFAULT_ORIGIN,
      portal: query.get('gb_portal') || hash.get('gb_portal') || 'PF',
    };
  }

  function showBadge(message, type) {
    const existing = document.getElementById('gb-pfesic-autofill-badge');
    if (existing) existing.remove();
    const badge = document.createElement('div');
    badge.id = 'gb-pfesic-autofill-badge';
    badge.textContent = message;
    badge.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'max-width:370px',
      'padding:12px 14px',
      'border-radius:10px',
      'font:600 13px system-ui,-apple-system,Segoe UI,sans-serif',
      'box-shadow:0 10px 30px rgba(15,23,42,.22)',
      'background:' + (type === 'error' ? '#fee2e2' : '#dcfce7'),
      'color:' + (type === 'error' ? '#991b1b' : '#166534'),
      'border:1px solid ' + (type === 'error' ? '#fecaca' : '#bbf7d0'),
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
    input.setAttribute('value', value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function scrubUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('gb_pfesic_autofill');
    url.searchParams.delete('gb_origin');
    url.searchParams.delete('gb_portal');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }

  async function run() {
    const { token, origin, portal } = paramsFromUrl();
    if (!token) return;
    showBadge(`GeeBharat ${portal} autofill starting...`, 'ok');
    let data;
    try {
      const resp = await fetch(`${origin.replace(/\/$/, '')}/api/pf-esic/autofill/${encodeURIComponent(token)}`, {
        credentials: 'omit',
      });
      data = await resp.json();
      if (!resp.ok || !data.success) throw new Error(data.message || 'Token failed');
    } catch (err) {
      showBadge(err.message || 'Autofill token expired. Click Login again from GeeBharat.', 'error');
      return;
    }
    const user = firstVisible(USERNAME_SELECTORS);
    const pass = firstVisible(PASSWORD_SELECTORS);
    if (!user || !pass) {
      showBadge('PF/ESIC login fields not found. Portal selector may need update.', 'error');
      return;
    }
    user.focus();
    setNativeValue(user, data.login_id || '');
    setTimeout(() => {
      pass.focus();
      setNativeValue(pass, data.password || '');
      scrubUrl();
      showBadge(`GeeBharat autofilled ${data.portal_type || portal}. Complete captcha/OTP and login manually.`, 'ok');
    }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
