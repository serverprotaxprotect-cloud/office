(function () {
  'use strict';

  const DEFAULT_ORIGIN = 'https://geebharat.com';
  let credentials = null;
  let started = false;

  function parseTokenParams() {
    const params = new URLSearchParams(window.location.search || '');
    const hash = String(window.location.hash || '');
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash.replace(/^#/, '');
    const hashParams = new URLSearchParams(hashQuery);
    return {
      token: params.get('gb_itr_autofill') || hashParams.get('gb_itr_autofill'),
      origin: params.get('gb_origin') || hashParams.get('gb_origin') || DEFAULT_ORIGIN,
    };
  }

  function showBadge(message, type = 'success') {
    const existing = document.getElementById('gb-itr-autofill-badge');
    if (existing) existing.remove();
    const badge = document.createElement('div');
    badge.id = 'gb-itr-autofill-badge';
    badge.textContent = message;
    badge.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'max-width:390px',
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

  function visible(el) {
    if (!el || el.disabled) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).find(visible);
      if (found) return found;
    }
    return null;
  }

  function findButton(text) {
    const normalized = String(text || '').trim().toLowerCase();
    return Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
      .find((el) => visible(el) && String(el.textContent || el.value || '').trim().toLowerCase().includes(normalized));
  }

  function setNativeValue(input, value) {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.setAttribute('value', value);
    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: value ? value.slice(-1) : ''
      }));
    } catch (err) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  function clickElement(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
    return true;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(fn, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = fn();
      if (result) return result;
      await wait(250);
    }
    return null;
  }

  function userIdInput() {
    return firstVisible([
      'input[placeholder*="PAN" i]',
      'input[placeholder*="AADHAAR" i]',
      'input[placeholder*="USER ID" i]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[formcontrolname*="user" i]',
      'input[type="text"]'
    ]);
  }

  function passwordInput() {
    return firstVisible([
      'input[type="password"]',
      'input[placeholder*="password" i]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[formcontrolname*="password" i]'
    ]);
  }

  function secureCheckbox() {
    return firstVisible([
      'input[type="checkbox"]',
      '[role="checkbox"]',
      '.mat-checkbox',
      '.mat-mdc-checkbox'
    ]);
  }

  async function fillUserAndContinue(input) {
    input = input || await waitFor(userIdInput, 15000);
    if (!input) throw new Error('User ID field not found');
    input.focus();
    setNativeValue(input, credentials.pan_number || '');
    await wait(500);
    const button = await waitFor(() => {
      const btn = findButton('Continue');
      return btn && !btn.disabled ? btn : null;
    }, 8000);
    if (!button) throw new Error('First Continue button not enabled');
    clickElement(button);
  }

  async function fillPasswordAndContinue() {
    const checkbox = await waitFor(secureCheckbox, 15000);
    if (checkbox && checkbox.getAttribute('aria-checked') !== 'true' && !checkbox.checked) {
      clickElement(checkbox);
      await wait(500);
    }
    const input = await waitFor(passwordInput, 15000);
    if (!input) throw new Error('Password field not found');
    input.focus();
    setNativeValue(input, credentials.password || '');
    await wait(700);
    const button = await waitFor(() => {
      const btn = findButton('Continue');
      return btn && !btn.disabled ? btn : null;
    }, 10000);
    if (!button) throw new Error('Password Continue button not enabled');
    clickElement(button);
  }

  async function fetchCredentials(token, origin) {
    if (!/^https:\/\/geebharat\.com$/.test(origin) && !/^http:\/\/localhost:\d+$/.test(origin)) {
      throw new Error('GeeBharat origin invalid');
    }
    const response = await fetch(origin + '/api/income-tax/autofill/' + encodeURIComponent(token), {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok || !data || data.success === false) {
      throw new Error(data?.message || 'Autofill token failed');
    }
    return data;
  }

  async function run() {
    if (started) return;
    const { token, origin } = parseTokenParams();
    if (!token) return;
    started = true;
    try {
      showBadge('GeeBharat Income Tax login start ho raha hai...');
      const initialInput = await waitFor(userIdInput, 30000);
      if (!initialInput) {
        started = false;
        showBadge('Income Tax login page wait ho raha hai. Session Expire page ho to Login click karein.', 'error');
        return;
      }
      credentials = await fetchCredentials(token, origin);
      await fillUserAndContinue(initialInput);
      showBadge('User ID submitted. Password step wait ho raha hai...');
      await fillPasswordAndContinue();
      showBadge('Income Tax login submitted. Agar OTP/warning aaye to manually complete karein.');
    } catch (err) {
      showBadge(err.message || 'Income Tax autofill failed', 'error');
    }
  }

  setTimeout(run, 700);
  setInterval(() => {
    if (!credentials && parseTokenParams().token) run();
  }, 1500);
}());
