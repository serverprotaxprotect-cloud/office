(function () {
  const TOKEN_KEYS = ['gb_access_token', 'att_token', 'office_token', 'admin_token'];
  const USER_KEYS = ['gb_user', 'att_emp', 'office_user', 'admin_info'];
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('geebharat-auth') : null;
  let refreshPromise = null;

  function decode(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch {
      return {};
    }
  }

  function tokenFor(scope) {
    const map = {
      attendance: ['att_token', 'gb_access_token', 'office_token'],
      office: ['office_token', 'gb_access_token', 'att_token'],
      admin: ['admin_token', 'gb_access_token', 'office_token'],
    };
    return (map[scope] || TOKEN_KEYS).map(key => localStorage.getItem(key)).find(Boolean) || '';
  }

  function userFor(scope) {
    const map = {
      attendance: ['att_emp', 'gb_user', 'office_user'],
      office: ['office_user', 'gb_user', 'att_emp'],
      admin: ['admin_info', 'gb_user', 'office_user'],
    };
    for (const key of map[scope] || USER_KEYS) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || 'null');
        if (value) return value;
      } catch {}
    }
    return {};
  }

  function save(token, user, scope) {
    if (!token || !user) return;
    localStorage.setItem('gb_access_token', token);
    localStorage.setItem('gb_user', JSON.stringify(user));
    localStorage.setItem('office_token', token);
    localStorage.setItem('office_user', JSON.stringify(user));
    if (user.user_type === 'employee') {
      localStorage.setItem('att_token', token);
      localStorage.setItem('att_emp', JSON.stringify(user));
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_info');
    } else if (user.is_admin) {
      localStorage.setItem('admin_token', token);
      localStorage.setItem('admin_info', JSON.stringify(user));
      localStorage.removeItem('att_token');
      localStorage.removeItem('att_emp');
    }
  }

  function clear(notify = true) {
    [...TOKEN_KEYS, ...USER_KEYS].forEach(key => localStorage.removeItem(key));
    if (!notify) return;
    try { channel?.postMessage({ type: 'logout' }); } catch {}
    try { localStorage.setItem('gb_logout_event', String(Date.now())); } catch {}
  }

  function expiresSoon(token, seconds = 60) {
    const exp = Number(decode(token).exp || 0);
    return !exp || exp <= Math.floor(Date.now() / 1000) + seconds;
  }

  async function refresh(scope = 'office', force = false) {
    const existing = tokenFor(scope);
    if (!force && existing && !expiresSoon(existing)) {
      return { token: existing, user: userFor(scope) };
    }
    if (refreshPromise) return refreshPromise;
    refreshPromise = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) throw new Error(data.message || 'Session expired');
      save(data.token, data.user, scope);
      return data;
    }).finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function authFetch(url, options = {}, scope = 'office') {
    let current = tokenFor(scope);
    if (!current || expiresSoon(current)) {
      try {
        current = (await refresh(scope, true)).token;
      } catch {
        clear();
        return new Response(JSON.stringify({ success: false, message: 'Session expired. Please login again.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const request = () => fetch(url, {
      ...options,
      credentials: options.credentials || 'same-origin',
      headers: { ...(options.headers || {}), Authorization: `Bearer ${current}` },
    });
    let response = await request();
    if (response.status === 401) {
      try {
        current = (await refresh(scope, true)).token;
        response = await request();
      } catch {
        clear();
      }
    }
    return response;
  }

  async function logout(redirect = '/') {
    const token = tokenFor('office');
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {}
    clear();
    window.location.href = redirect;
  }

  async function restore(scope, loginUrl) {
    const token = tokenFor(scope);
    if (token && !expiresSoon(token)) return true;
    try {
      await refresh(scope, true);
      return true;
    } catch {
      clear(false);
      if (loginUrl) window.location.href = loginUrl;
      return false;
    }
  }

  function remoteLogout() {
    clear(false);
    if (!/login|attendance\.html|^\/$/.test(window.location.pathname)) window.location.href = '/';
  }
  channel?.addEventListener('message', event => {
    if (event.data?.type === 'logout') remoteLogout();
  });
  window.addEventListener('storage', event => {
    if (event.key === 'gb_logout_event') remoteLogout();
  });

  window.GBSession = {
    tokenFor, userFor, save, clear, decode, expiresSoon, refresh,
    fetch: authFetch, logout, restore,
  };
})();
