// Shared "New payment request" popup. Works on any page that already loads /assets/auth-session.js.
// Usage: GBPayRequest.open({ onDone: () => {...} })
// Also exposes GBPayRequest.clientList() and GBPayRequest.filterClients(text) for instant client suggestions.
(function () {
  if (window.GBPayRequest) return;
  const PURPOSES = ['Government challan / fee', 'ROC / MCA fee', 'Stamp duty', 'Vendor / professional fee', 'Travel / conveyance', 'Refund of advance', 'Office expense', 'Other'];
  const h = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = v => '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let clients = null, clientsPromise = null, firms = [], accounts = [], ready = null, options = {}, chosenClient = '';

  async function api(path, o = {}) {
    const headers = { Authorization: 'Bearer ' + GBSession.tokenFor('office'), ...(o.headers || {}) };
    if (!(o.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const res = await GBSession.fetch('/api/billing' + path, { ...o, headers }, 'office');
    const d = await res.json().catch(() => ({ success: false, message: 'Invalid server response' }));
    if (!res.ok || !d.success) throw new Error(d.message || 'Request failed');
    return d;
  }

  // All clients are loaded once, then every keystroke is matched in the browser, so suggestions appear instantly.
  function clientList() {
    if (clients) return Promise.resolve(clients);
    if (!clientsPromise) clientsPromise = api('/clients/all').then(d => (clients = d.clients || [])).catch(() => { clientsPromise = null; return []; });
    return clientsPromise;
  }
  function filterClients(text, limit = 30) {
    const q = String(text || '').trim().toLowerCase();
    const list = clients || [];
    if (!q) return list.slice(0, limit);
    const starts = [], contains = [];
    for (const c of list) {
      const name = String(c.name || '').toLowerCase(), id = String(c.client_id || '').toLowerCase();
      if (name.startsWith(q) || id.startsWith(q)) starts.push(c);
      else if (name.includes(q) || id.includes(q)) contains.push(c);
      if (starts.length >= limit) break;
    }
    return starts.concat(contains).slice(0, limit);
  }

  function injectUi() {
    if (document.getElementById('prqModal')) return;
    const style = document.createElement('style');
    style.textContent = `
      #prqModal{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:flex-start;justify-content:center;z-index:9998;padding:24px 14px;overflow:auto;font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:13px;color:#0f172a}
      #prqModal.show{display:flex}
      #prqCard{background:#fff;border-radius:14px;width:100%;max-width:900px;margin:auto;padding:18px;box-shadow:0 20px 60px rgba(15,23,42,.3)}
      #prqCard .hd{display:flex;align-items:center;gap:10px;margin-bottom:12px}#prqCard .hd h2{flex:1;font-size:18px}
      #prqCard label{display:block;font-size:11px;text-transform:uppercase;font-weight:800;color:#475569;margin:0 0 4px;letter-spacing:.3px}
      #prqCard input,#prqCard select,#prqCard textarea{width:100%;border:1.5px solid #e2e8f0;border-radius:8px;padding:8px 10px;font:inherit;background:#f8fafc;color:#0f172a;outline:none}
      #prqCard input:focus,#prqCard select:focus,#prqCard textarea:focus{border-color:#2155f3;background:#fff}
      #prqCard .row2{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:10px}
      #prqCard .btn{border:0;border-radius:8px;padding:9px 14px;font-weight:800;cursor:pointer;font-size:12px;font-family:inherit}
      #prqCard .btn.primary{background:#2155f3;color:#fff}#prqCard .btn.red{background:#fee2e2;color:#b91c1c}
      #prqCard .info{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:8px;padding:9px 12px;margin-bottom:10px}
      #prqCard .err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:9px 12px;margin:8px 0}
      #prqCard .picker{position:relative}
      #prqCard .plist{position:absolute;left:0;right:0;top:100%;background:#fff;border:1.5px solid #e2e8f0;border-radius:8px;z-index:30;max-height:240px;overflow:auto;display:none;box-shadow:0 8px 24px rgba(0,0,0,.14)}
      #prqCard .plist div{padding:8px 10px;cursor:pointer;border-bottom:1px solid #f1f5f9}#prqCard .plist div:hover,#prqCard .plist div.on{background:#eff4ff}
      #prqCard small{color:#64748b}
      #prqToast{position:fixed;right:18px;bottom:18px;z-index:10000;display:none;padding:11px 16px;border-radius:10px;color:#fff;font-weight:700;background:#059669;box-shadow:0 8px 24px rgba(0,0,0,.25);font-family:Inter,'Segoe UI',Arial,sans-serif;font-size:13px}`;
    document.head.appendChild(style);
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div id="prqModal"><div id="prqCard"></div></div><div id="prqToast"></div>';
    document.body.appendChild(wrap);
    document.getElementById('prqModal').addEventListener('mousedown', e => { if (e.target.id === 'prqModal') close(); });
    document.addEventListener('click', e => { if (!e.target.closest('#prqCard .picker')) { const l = document.getElementById('prqList'); if (l) l.style.display = 'none'; } });
  }
  const $ = id => document.getElementById(id);
  function toast(text) { const t = $('prqToast'); t.textContent = text; t.style.display = 'block'; clearTimeout(toast.t); toast.t = setTimeout(() => { t.style.display = 'none'; }, 4500); }
  function close() { const m = $('prqModal'); if (m) { m.classList.remove('show'); $('prqCard').innerHTML = ''; } }
  const err = text => { $('prqMsg').innerHTML = text ? `<div class="err">${h(text)}</div>` : ''; };

  async function open(opts) {
    options = opts || {};
    injectUi();
    chosenClient = '';
    $('prqCard').innerHTML = '<div class="hd"><h2>New payment request</h2><button class="btn red" onclick="GBPayRequest.close()">Close</button></div><div>Loading…</div>';
    $('prqModal').classList.add('show');
    try {
      if (!ready) ready = Promise.all([api('/me'), api('/firms')]).then(([me, f]) => { firms = me.firms || []; accounts = f.accounts || []; });
      await ready;
    } catch (e) { ready = null; $('prqCard').innerHTML = `<div class="hd"><h2>New payment request</h2><button class="btn red" onclick="GBPayRequest.close()">Close</button></div><div class="err">${h(e.message)}</div>`; return; }
    clientList(); // start loading the client list for instant suggestions
    if (!firms.length) { $('prqCard').innerHTML = '<div class="hd"><h2>New payment request</h2><button class="btn red" onclick="GBPayRequest.close()">Close</button></div><div class="err">No firm is set up yet. Please ask an admin to add the firms in Billing > Settings.</div>'; return; }
    $('prqCard').innerHTML = `<div class="hd"><h2>New payment request</h2><button class="btn red" onclick="GBPayRequest.close()">Close</button></div>
      <div class="info">Every payment needs approval first. Choose the client and the work so the payment is linked correctly.</div>
      <div class="row2"><div><label>Payment is for</label><select id="prqPurpose" onchange="GBPayRequest.purposeChanged()">${PURPOSES.map(p => `<option>${h(p)}</option>`).join('')}</select></div>
        <div><label>Payee (who will be paid)</label><input id="prqPayee" placeholder="For example: MCA, GST Dept, vendor name"></div>
        <div><label>Amount</label><input id="prqAmt" type="number" step="0.01" min="0" oninput="GBPayRequest.advanceHint()"></div>
        <div><label>Needed by</label><input id="prqNeed" type="date"></div></div>
      <div id="prqClientRow" class="row2"><div class="picker"><label>Client</label><input id="prqClientText" placeholder="Start typing the client name or ID" autocomplete="off" oninput="GBPayRequest.suggest()" onfocus="GBPayRequest.suggest()" onkeydown="GBPayRequest.suggestKey(event)"><div class="plist" id="prqList"></div></div>
        <div><label>Work</label><select id="prqTask"><option value="">Choose client first</option></select></div></div>
      <div class="row2"><div><label>Pay from firm</label><select id="prqFirm" onchange="GBPayRequest.firmChanged()"><option value="">Choose firm</option>${firms.map(f => `<option value="${f.id}">${h(f.name)}</option>`).join('')}</select></div>
        <div><label>Account (the firm's account the money will go out from)</label><select id="prqAcc"><option value="">Choose firm first</option></select></div>
        <div id="prqFundWrap"><label>Money source</label><select id="prqFund" onchange="GBPayRequest.advanceHint()"><option value="Firm funds">Firm money (recover from client later)</option><option value="Client advance">Client's advance</option></select></div></div>
      <div id="prqAccHint" style="color:#b45309;margin-bottom:6px"></div><div id="prqAdv" style="margin-bottom:8px"></div>
      <div><label>Details (optional)</label><textarea id="prqDesc" rows="2" placeholder="Any detail the approver should know"></textarea></div>
      <div style="margin-top:8px"><label>Challan / invoice copy (optional, PDF or image up to 4 MB)</label><input type="file" id="prqFile" accept=".pdf,image/*"></div>
      <div id="prqMsg"></div><div style="margin-top:12px"><button class="btn primary" id="prqSend" onclick="GBPayRequest.submit()">Send for approval</button></div>`;
    if (firms.length === 1) { $('prqFirm').value = String(firms[0].id); firmChanged(); }
    purposeChanged();
  }

  function purposeChanged() {
    const p = $('prqPurpose').value; const office = p === 'Office expense', refund = p === 'Refund of advance';
    $('prqClientRow').style.display = office ? 'none' : '';
    $('prqFundWrap').style.display = (office || refund) ? 'none' : '';
    advanceHint();
  }
  function firmChanged() {
    const f = $('prqFirm').value;
    const mine = accounts.filter(a => String(a.firm_id) === f && a.status === 'Active');
    $('prqAcc').innerHTML = !f ? '<option value="">Choose firm first</option>' : (mine.length ? '<option value="">Choose account</option>' + mine.map(a => `<option value="${a.id}">${h(a.account_name)} (${h(a.account_type)})</option>`).join('') : '<option value="">No account added for this firm</option>');
    if ($('prqAccHint')) $('prqAccHint').innerHTML = f && !mine.length ? 'This firm has no bank, cash or UPI account yet. An admin must add one in <strong>Billing &gt; Settings &gt; + Account</strong>, then you can send the request.' : '';
    if (mine.length === 1) $('prqAcc').value = String(mine[0].id);
    advanceHint();
  }
  async function advanceHint() {
    const el = $('prqAdv'); if (!el) return;
    const f = $('prqFirm').value;
    if (!chosenClient || !f || $('prqPurpose').value === 'Office expense') { el.textContent = ''; return; }
    try {
      const a = await api(`/advance?client_id=${encodeURIComponent(chosenClient)}&firm_id=${encodeURIComponent(f)}`);
      el.innerHTML = `Advance this client has with this firm: <strong>${rs(a.available)}</strong>${a.available <= 0 ? ' <span style="color:#b45309">(none. The payment will be from firm money and recovered from the client later.)</span>' : ''}`;
    } catch (e) { el.textContent = ''; }
  }

  // Instant suggestions: matched in the browser on every key
  let active = -1;
  async function suggest() {
    const list = $('prqList'); chosenClient = ''; $('prqTask').innerHTML = '<option value="">Choose client first</option>';
    if (!clients) { list.innerHTML = '<div>Loading clients…</div>'; list.style.display = 'block'; await clientList(); }
    const matches = filterClients($('prqClientText').value);
    active = matches.length ? 0 : -1;
    list.innerHTML = matches.map((c, i) => `<div class="${i === 0 ? 'on' : ''}" data-i="${i}" onmousedown="GBPayRequest.choose('${h(c.client_id)}')"><strong>${h(c.name || c.client_id)}</strong> <small>${h(c.client_id)}</small></div>`).join('') || '<div>No client found</div>';
    list.style.display = 'block';
  }
  function suggestKey(e) {
    const list = $('prqList'); const items = [...list.querySelectorAll('[data-i]')];
    if (!items.length || list.style.display === 'none') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((el, i) => el.classList.toggle('on', i === active)); items[active].scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(filterClients($('prqClientText').value)[active].client_id); }
    else if (e.key === 'Escape') list.style.display = 'none';
  }
  async function choose(clientId) {
    const c = (clients || []).find(x => x.client_id === clientId); if (!c) return;
    chosenClient = clientId; $('prqClientText').value = `${c.name || c.client_id} (${c.client_id})`; $('prqList').style.display = 'none';
    try {
      const d = await api('/client-tasks?client_id=' + encodeURIComponent(clientId));
      $('prqTask').innerHTML = '<option value="">Choose the work</option>' + d.tasks.map(t => `<option value="${h(t.task_id)}">${h(t.work_name)} · ${h(t.status || '')} (${h(t.task_id)})</option>`).join('');
    } catch (e) { /* the form still shows an error on submit */ }
    advanceHint();
  }

  async function submit() {
    const btn = $('prqSend'); btn.disabled = true; err('');
    const body = { purpose: $('prqPurpose').value, payee: $('prqPayee').value, amount: $('prqAmt').value, needed_by: $('prqNeed').value, firm_id: $('prqFirm').value, account_id: $('prqAcc').value, funding: $('prqFund').value, description: $('prqDesc').value, client_id: chosenClient, task_id: $('prqTask').value };
    try {
      const d = await api('/payments', { method: 'POST', body: JSON.stringify(body) });
      const file = $('prqFile').files[0];
      if (file) {
        const fd = new FormData(); fd.append('file', file); fd.append('kind', 'request');
        try { await api(`/payments/${d.payment.id}/attachments`, { method: 'POST', body: fd }); } catch (e) { toast('Request sent, but the file could not be added: ' + e.message); }
      }
      close(); toast(d.message || 'Request sent for approval.');
      if (typeof options.onDone === 'function') options.onDone();
    } catch (e) { err(e.message); btn.disabled = false; }
  }

  window.GBPayRequest = { open, close, submit, purposeChanged, firmChanged, advanceHint, suggest, suggestKey, choose, clientList, filterClients };
})();
