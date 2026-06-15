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

  let monitorTimer = null;
  let monitorState = null;

  function monitorEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function ensureMonitorUi() {
    if (document.getElementById('gbEmployeeMonitorOverlay')) return;
    const style = document.createElement('style');
    style.textContent = `
      #gbEmployeeMonitorOverlay{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.72);display:none;align-items:center;justify-content:center;padding:18px;font-family:Arial,sans-serif}
      #gbEmployeeMonitorOverlay.open{display:flex}
      #gbEmployeeMonitorDialog{width:min(720px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:8px;box-shadow:0 24px 70px rgba(15,23,42,.35);color:#0f172a}
      .gb-monitor-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 22px;border-bottom:1px solid #e2e8f0}
      .gb-monitor-head h2{font-size:20px;margin:0 0 4px;letter-spacing:0}.gb-monitor-head p{font-size:12px;color:#64748b;margin:0;line-height:1.5}
      .gb-monitor-close{border:0;background:#f1f5f9;width:34px;height:34px;border-radius:6px;font-size:20px;cursor:pointer}
      .gb-monitor-list{display:grid;gap:10px;padding:18px 22px}
      .gb-monitor-alert{border:1px solid #fca5a5;border-left:4px solid #dc2626;background:#fff7f7;border-radius:6px;padding:14px}
      .gb-monitor-alert.warning{border-color:#fcd34d;border-left-color:#d97706;background:#fffbeb}
      .gb-monitor-row{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.gb-monitor-title{font-size:14px;font-weight:800}.gb-monitor-date{font-size:11px;color:#64748b;white-space:nowrap}
      .gb-monitor-message{font-size:12px;line-height:1.55;color:#475569;margin-top:5px}
      .gb-monitor-meta{font-size:11px;color:#7c2d12;margin-top:7px;font-weight:700}
      .gb-monitor-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
      .gb-monitor-btn{border:0;border-radius:6px;padding:8px 11px;font-size:12px;font-weight:800;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
      .gb-monitor-primary{background:#2563eb;color:#fff}.gb-monitor-danger{background:#dc2626;color:#fff}.gb-monitor-neutral{background:#e2e8f0;color:#1e293b}
      .gb-monitor-explanation{display:none;margin-top:10px}.gb-monitor-explanation.open{display:block}
      .gb-monitor-explanation textarea{width:100%;min-height:82px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:9px;font:inherit;font-size:12px;resize:vertical}
      .gb-monitor-footer{padding:0 22px 20px;color:#64748b;font-size:11px;line-height:1.5}
      body.gb-monitor-blocked{overflow:hidden}
      @media(max-width:600px){#gbEmployeeMonitorOverlay{padding:8px}.gb-monitor-head{padding:16px}.gb-monitor-list{padding:14px 16px}.gb-monitor-row{display:block}.gb-monitor-date{display:block;margin-top:4px}}
    `;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.id = 'gbEmployeeMonitorOverlay';
    overlay.innerHTML = `
      <div id="gbEmployeeMonitorDialog" role="dialog" aria-modal="true" aria-labelledby="gbMonitorTitle">
        <div class="gb-monitor-head">
          <div><h2 id="gbMonitorTitle">Employee Work and Attendance Monitor</h2><p id="gbMonitorSubtitle"></p></div>
          <button class="gb-monitor-close" id="gbMonitorClose" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="gb-monitor-list" id="gbMonitorList"></div>
        <div class="gb-monitor-footer">Warnings remain in the audit history after acknowledgement or resolution. Attendance actions are never restricted.</div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('gbMonitorClose').addEventListener('click', () => {
      if (monitorState?.blocking) return;
      overlay.classList.remove('open');
    });
  }

  function monitorActionUrl(alert) {
    if (['late_arrival', 'early_departure', 'incomplete_hours'].includes(alert.alert_type)) {
      return { url: '/dashboard.html', label: 'Open Attendance' };
    }
    if (alert.alert_type === 'overdue_work') {
      return { url: '/office.html#mytasks', label: 'Review Overdue Tasks' };
    }
    return { url: '/office.html#mytasks', label: 'Create or Update Task' };
  }

  function renderMonitor(state) {
    ensureMonitorUi();
    monitorState = state;
    const overlay = document.getElementById('gbEmployeeMonitorOverlay');
    const closeButton = document.getElementById('gbMonitorClose');
    const list = document.getElementById('gbMonitorList');
    const subtitle = document.getElementById('gbMonitorSubtitle');
    const alerts = state.alerts || [];
    if (!alerts.length) {
      overlay.classList.remove('open');
      document.body.classList.remove('gb-monitor-blocked');
      return;
    }
    subtitle.textContent = state.blocking
      ? 'Corrective action, acknowledgement or an explanation is required before continuing.'
      : 'Please review the following unresolved warnings.';
    closeButton.style.display = state.blocking ? 'none' : '';
    document.body.classList.toggle('gb-monitor-blocked', !!state.blocking);
    list.innerHTML = alerts.map(alert => {
      const action = monitorActionUrl(alert);
      return `
        <section class="gb-monitor-alert ${alert.severity === 'critical' ? '' : 'warning'}">
          <div class="gb-monitor-row">
            <div class="gb-monitor-title">${monitorEscape(alert.title)}</div>
            <span class="gb-monitor-date">${monitorEscape(String(alert.alert_date).slice(0,10))}</span>
          </div>
          <div class="gb-monitor-message">${monitorEscape(alert.message)}</div>
          <div class="gb-monitor-meta">Status: ${monitorEscape(alert.status)} | Occurrence: ${Number(alert.occurrence_count || 1)} | Escalation level: ${Number(alert.escalation_level || 0)}</div>
          ${alert.review_remark ? `<div class="gb-monitor-message"><strong>Management remarks:</strong> ${monitorEscape(alert.review_remark)}</div>` : ''}
          <div class="gb-monitor-actions">
            <a class="gb-monitor-btn gb-monitor-primary" href="${action.url}">${action.label}</a>
            ${['Open','Rejected'].includes(alert.status) ? `<button class="gb-monitor-btn gb-monitor-neutral" type="button" data-monitor-ack="${alert.id}">Acknowledge</button>` : ''}
            ${!['Justified','Auto Resolved','Resolved'].includes(alert.status) ? `<button class="gb-monitor-btn gb-monitor-danger" type="button" data-monitor-explain="${alert.id}">Submit Explanation</button>` : ''}
          </div>
          <div class="gb-monitor-explanation" id="gbMonitorExplanation${alert.id}">
            <textarea placeholder="Provide a clear and factual explanation." maxlength="2000"></textarea>
            <div class="gb-monitor-actions"><button class="gb-monitor-btn gb-monitor-primary" type="button" data-monitor-submit="${alert.id}">Send for Review</button></div>
          </div>
        </section>`;
    }).join('');
    overlay.classList.add('open');
  }

  async function loadEmployeeMonitor() {
    const user = userFor('office');
    if (user?.user_type !== 'employee' || !tokenFor('office')) return;
    try {
      const response = await authFetch('/api/performance/monitor/me', {}, 'office');
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) return;
      renderMonitor(data);
      clearInterval(monitorTimer);
      monitorTimer = setInterval(loadEmployeeMonitor, Math.max(1, Number(data.popup_repeat_minutes || 60)) * 60000);
    } catch (error) {
      console.warn('[Employee Monitor]', error.message);
    }
  }

  document.addEventListener('click', async event => {
    const explainButton = event.target.closest('[data-monitor-explain]');
    if (explainButton) {
      document.getElementById(`gbMonitorExplanation${explainButton.dataset.monitorExplain}`)?.classList.toggle('open');
      return;
    }
    const acknowledgeButton = event.target.closest('[data-monitor-ack]');
    if (acknowledgeButton) {
      acknowledgeButton.disabled = true;
      await authFetch(`/api/performance/monitor/alerts/${acknowledgeButton.dataset.monitorAck}/acknowledge`, { method: 'POST' }, 'office');
      await loadEmployeeMonitor();
      return;
    }
    const submitButton = event.target.closest('[data-monitor-submit]');
    if (submitButton) {
      const container = document.getElementById(`gbMonitorExplanation${submitButton.dataset.monitorSubmit}`);
      const explanation = container?.querySelector('textarea')?.value.trim();
      if (!explanation) {
        container?.querySelector('textarea')?.focus();
        return;
      }
      submitButton.disabled = true;
      await authFetch(`/api/performance/monitor/alerts/${submitButton.dataset.monitorSubmit}/explanation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ explanation }),
      }, 'office');
      await loadEmployeeMonitor();
    }
  });

  if (!/login|forgot-password|signup/.test(window.location.pathname)) {
    window.addEventListener('load', () => setTimeout(loadEmployeeMonitor, 500));
  }
})();
