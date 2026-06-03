(function () {
  let ITR_META = { is_admin: false, employees: [], status_options: [], itr_types: [], ay_options: [] };
  let ITR_READY = false;
  let ITR_ACTIVE_TAB = 'clients';
  const ITR_STATE = { clientMap: {}, filingMap: {}, reportRows: [] };
  const timers = {};
  const ITR_ASSIGNEE_LOOKUP = new Map();

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function itrAdmin() {
    return !!ITR_META.is_admin;
  }

  function badge(status) {
    const cls = {
      'Filed': 'b-complete',
      'Pending': 'b-pending',
      'Pending by Client': 'b-waiting',
      'Not Started': 'b-hold',
      'Not Applicable': 'b-inactive',
    }[status] || 'b-pending';
    return `<span class="badge ${cls}">${esc(status || 'Not Started')}</span>`;
  }

  function revealPassword(btn, password) {
    btn.closest('td').querySelector('.masked-pass').textContent = password || '--';
    btn.remove();
  }

  function ayDueDate(assessmentYear) {
    const year = Number(String(assessmentYear || '').slice(0, 4));
    return year ? `${year}-07-31` : '';
  }

  function assignees() {
    const seen = new Set();
    return (ITR_META.employees || []).filter((e) => {
      const id = e.emp_id || '';
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function assigneeLabel(e) {
    const role = e.designation || e.role || '';
    return `${e.formal_name || e.name || e.emp_id} (${e.emp_id}${e.source ? ' - ' + e.source : ''})${role ? ' - ' + role : ''}`;
  }

  function rebuildAssigneeLookup(people) {
    ITR_ASSIGNEE_LOOKUP.clear();
    people.forEach((e) => {
      const id = e.emp_id || '';
      const label = assigneeLabel(e);
      [id, label, e.formal_name, e.name].filter(Boolean).forEach((key) => {
        ITR_ASSIGNEE_LOOKUP.set(String(key).trim().toLowerCase(), { id, label });
      });
    });
  }

  async function loadITRMeta() {
    try {
      const data = await api('/income-tax/meta');
      if (!data.success) {
        showToast(data.message || 'Income Tax setup pending', 'error');
        return false;
      }
      ITR_META = data;
      ITR_READY = true;
      document.querySelectorAll('.itr-admin-only').forEach((el) => { el.style.display = itrAdmin() ? '' : 'none'; });
      populateITRControls();
      return true;
    } catch (err) {
      showToast('Income Tax assignee list load nahi ho paya', 'error');
      return false;
    }
  }

  function populateITRControls() {
    const people = assignees();
    rebuildAssigneeLookup(people);
    const empOptions = '<option value="">All Assignees</option>' + people.map((e) =>
      `<option value="${esc(e.emp_id)}">${esc(assigneeLabel(e))}</option>`
    ).join('');
    ['itrAssigneeFilter', 'itrTrackEmployee', 'itrReportEmployee'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = empOptions;
    });

    const assignOptions = '<option value="">Unassigned</option>' + people.map((e) =>
      `<option value="${esc(e.emp_id)}">${esc(assigneeLabel(e))}</option>`
    ).join('');
    ['itr_default_assignee', 'itr_assign_employee'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = assignOptions;
    });
    const assigneeDatalist = document.getElementById('itr_assignee_datalist');
    if (assigneeDatalist) {
      assigneeDatalist.innerHTML = people.map((e) => `<option value="${esc(assigneeLabel(e))}"></option>`).join('');
    }

    const statusOptions = '<option value="">All Status</option>' + ITR_META.status_options.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    ['itrTrackStatus', 'itrReportStatus'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = statusOptions;
    });
    const statusEdit = document.getElementById('itr_status_select');
    if (statusEdit) statusEdit.innerHTML = ITR_META.status_options.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

    const typeOptions = '<option value="">All ITR Types</option>' + ITR_META.itr_types.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    ['itrTrackType', 'itrReportType'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = typeOptions;
    });
    const typeEdit = document.getElementById('itr_status_type');
    if (typeEdit) typeEdit.innerHTML = '<option value="">Select ITR Type</option>' + ITR_META.itr_types.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

    const selectedAY = ITR_META.latest_year?.assessment_year || ITR_META.ay_options?.[0] || '';
    const ayOptions = (ITR_META.ay_options || []).map((ay) => `<option value="${esc(ay)}" ${ay === selectedAY ? 'selected' : ''}>${esc(ay)}</option>`).join('');
    ['itrTrackAY', 'itrReportAY', 'itr_generate_ay', 'itrUnassignedAY'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = ayOptions;
    });
    const genAy = document.getElementById('itr_generate_ay');
    if (genAy) genAy.onchange = () => {
      const due = document.getElementById('itr_generate_due_date');
      if (due) due.value = ayDueDate(genAy.value);
    };
    const due = document.getElementById('itr_generate_due_date');
    if (due) due.value = ayDueDate(selectedAY);
  }

  function setModalError(message) {
    const err = document.getElementById('itrClientErr');
    if (!err) return;
    if (!message) {
      err.textContent = '';
      err.classList.add('hidden');
      return;
    }
    err.textContent = message;
    err.classList.remove('hidden');
  }

  function setAssigneeInput(kind, id) {
    const hidden = document.getElementById(kind === 'assign' ? 'itr_assign_employee' : 'itr_default_assignee');
    const input = document.getElementById(kind === 'assign' ? 'itr_assign_employee_search' : 'itr_default_assignee_search');
    if (!hidden || !input) return;
    hidden.value = id || '';
    const found = [...ITR_ASSIGNEE_LOOKUP.values()].find((v) => v.id === id);
    input.value = found ? found.label : (id || '');
  }

  function syncITRAssigneeInput(kind) {
    const hidden = document.getElementById(kind === 'assign' ? 'itr_assign_employee' : 'itr_default_assignee');
    const input = document.getElementById(kind === 'assign' ? 'itr_assign_employee_search' : 'itr_default_assignee_search');
    if (!hidden || !input) return;
    const raw = input.value.trim();
    if (!raw) { hidden.value = ''; return; }
    const match = ITR_ASSIGNEE_LOOKUP.get(raw.toLowerCase());
    hidden.value = match ? match.id : raw;
    showITRAssigneeList(kind, raw);
  }

  function showITRAssigneeList(kind, query = '') {
    const list = document.getElementById(kind === 'assign' ? 'itr_assign_employee_list' : 'itr_default_assignee_list');
    if (!list) return;
    const q = String(query || '').trim().toLowerCase();
    const people = assignees().filter((e) => {
      const text = `${e.emp_id || ''} ${e.formal_name || ''} ${e.name || ''} ${e.source || ''} ${e.role || ''}`.toLowerCase();
      return !q || text.includes(q);
    });
    list.innerHTML = people.length ? people.slice(0, 40).map((e) => {
      const item = { id: e.emp_id, label: assigneeLabel(e) };
      return `<div class="autocomplete-item ac-item" onclick="selectITRAssigneeData('${kind}','${encodeURIComponent(JSON.stringify(item))}')">
        <div class="ac-name">${esc(e.formal_name || e.name || e.emp_id)}</div>
        <div class="ac-meta">${esc(e.emp_id || '')}${e.source ? ' | ' + esc(e.source) : ''}${e.role ? ' | ' + esc(e.role) : ''}</div>
      </div>`;
    }).join('') : '<div class="autocomplete-item ac-item">No assignee found</div>';
    list.classList.remove('hidden');
  }

  function selectITRAssigneeData(kind, encoded) {
    const item = JSON.parse(decodeURIComponent(encoded));
    setAssigneeInput(kind, item.id);
    const list = document.getElementById(kind === 'assign' ? 'itr_assign_employee_list' : 'itr_default_assignee_list');
    if (list) list.classList.add('hidden');
  }

  async function initIncomeTaxPanel() {
    if (!ITR_READY) {
      const ok = await loadITRMeta();
      if (!ok) return;
    }
    switchITRTab(ITR_ACTIVE_TAB || 'clients');
  }

  function reloadIncomeTaxPanel() {
    if (ITR_ACTIVE_TAB === 'clients') loadITRClients();
    else if (ITR_ACTIVE_TAB === 'inactive') loadITRInactive();
    else if (ITR_ACTIVE_TAB === 'unassigned') loadITRUnassigned();
    else if (ITR_ACTIVE_TAB === 'report') loadITRReport();
    else loadITRFilings();
  }

  function switchITRTab(tab) {
    ITR_ACTIVE_TAB = tab;
    ['clients', 'tracker', 'report', 'inactive', 'unassigned'].forEach((t) => {
      document.getElementById(`itr-tab-${t}`)?.classList.toggle('active', t === tab);
      document.getElementById(`itr-panel-${t}`)?.classList.toggle('hidden', t !== tab);
    });
    reloadIncomeTaxPanel();
  }

  function debounceITR(kind) {
    clearTimeout(timers[kind]);
    timers[kind] = setTimeout(() => {
      if (kind === 'clients') loadITRClients();
      if (kind === 'inactive') loadITRInactive();
      if (kind === 'unassigned') loadITRUnassigned();
      if (kind === 'filings') loadITRFilings();
      if (kind === 'report') loadITRReport();
    }, 280);
  }

  function clientRows(rows, targetId, inactiveMode = false, unassignedMode = false) {
    const tbody = document.getElementById(targetId);
    ITR_STATE.clientMap = {};
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No Income Tax clients found</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((c) => {
      ITR_STATE.clientMap[c.id] = c;
      const pass = c.password ? `<span class="masked-pass">••••••</span> <button class="btn-sm btn-view" onclick="ITRRevealPassword(this,'${esc(c.password)}')">Show</button>` : '--';
      if (unassignedMode) {
        const loginAction = c.can_autofill && c.pan_number && c.password
          ? `<button class="btn-sm btn-green" title="Open Income Tax portal and auto-login" onclick="openITRPortalLogin(${c.id})">&#128272; Login</button>`
          : '';
        return `<tr>
          <td><div class="itr-name">${esc(c.taxpayer_name)}</div><div class="itr-client-id">${esc(c.client_id)} | AY ${esc(c.assessment_year || '')}</div></td>
          <td>${esc(c.pan_number || '--')}</td><td>${esc(c.contact_number || c.client_mobile || '--')}</td><td>${esc(c.agent_name || '--')}</td>
          <td>${loginAction} <button class="btn-sm btn-view" onclick="openITRAssign('client',${c.id})">Assign</button></td>
        </tr>`;
      }
      if (inactiveMode) {
        return `<tr>
          <td><div class="itr-name">${esc(c.taxpayer_name)}</div><div class="itr-client-id">${esc(c.client_id)}</div></td>
          <td>${esc(c.pan_number || '--')}</td><td>${fmtDate(c.inactive_from)}</td><td>${esc(c.inactive_reason || '--')}</td>
          <td>${esc(c.default_assignee_name || '--')}<div class="itr-client-id">${esc(c.default_assignee_id || '')}</div></td>
          <td><button class="btn-sm btn-green itr-admin-only" onclick="openITRClientStatus(${c.id},'Active')">Activate</button></td>
        </tr>`;
      }
      const actions = itrAdmin()
        ? `<button class="btn-sm btn-view itr-admin-only" onclick="openITRClientModal(${c.id})">Edit</button>
           <button class="btn-sm btn-view itr-admin-only" onclick="openITRAssign('client',${c.id})">Assign</button>
           <button class="btn-sm btn-danger itr-admin-only" onclick="openITRClientStatus(${c.id},'Inactive')">Deactivate</button>`
        : (!c.default_assignee_id
          ? `<button class="btn-sm btn-view" onclick="openITRAssign('client',${c.id})">Assign</button>`
          : '<small style="color:#94a3b8">View only</small>');
      const loginAction = c.can_autofill && c.pan_number && c.password
        ? `<button class="btn-sm btn-green" title="Open Income Tax portal and auto-login" onclick="openITRPortalLogin(${c.id})">&#128272; Login</button>`
        : '';
      return `<tr>
        <td><div class="itr-name">${esc(c.taxpayer_name)}</div><div class="itr-client-id">${esc(c.client_id)}</div></td>
        <td>${esc(c.pan_number || '--')}</td><td>${esc(c.contact_number || c.client_mobile || '--')}</td>
        <td>${esc(c.reference_client_name || '--')}</td><td>${esc(c.agent_name || '--')}</td><td>${pass}</td>
        <td>${esc(c.default_assignee_name || '--')}<div class="itr-client-id">${esc(c.default_assignee_id || '')}</div></td>
        <td style="white-space:nowrap">
          ${loginAction}
          ${actions}
        </td>
      </tr>`;
    }).join('');
    document.querySelectorAll('.itr-admin-only').forEach((el) => { el.style.display = itrAdmin() ? '' : 'none'; });
  }

  async function loadITRClients() {
    const q = new URLSearchParams({ status: 'Active', limit: '500' });
    const s = document.getElementById('itrClientSearch')?.value?.trim();
    const a = document.getElementById('itrAssigneeFilter')?.value;
    if (s) q.set('search', s);
    if (a) q.set('assignee_id', a);
    const data = await api('/income-tax/clients?' + q.toString());
    clientRows(data.clients || [], 'itrClientsTable');
  }

  async function openITRPortalLogin(id) {
    const row = ITR_STATE.clientMap[id];
    if (!row) return showToast('Income Tax client not loaded', 'error');
    if (!row.pan_number || !row.password) {
      return showToast('PAN/password missing', 'error');
    }
    const data = await api('/income-tax/clients/' + id + '/autofill-token', {
      method: 'POST',
      body: JSON.stringify({ origin: window.location.origin }),
    });
    if (!data.success) return showToast(data.message || 'Income Tax autofill token failed', 'error');
    const opened = window.open(data.extension_url_hint || data.login_url, '_blank', 'noopener');
    if (!opened) return showToast('Popup blocked. Browser popup allow karke dobara Login click karein.', 'error');
    showToast('Income Tax portal open ho gaya. Extension installed hoga to login steps auto-fill/click honge.', 'success');
  }

  async function loadITRInactive() {
    const q = new URLSearchParams({ status: 'Inactive', limit: '500' });
    const s = document.getElementById('itrInactiveSearch')?.value?.trim();
    if (s) q.set('search', s);
    const data = await api('/income-tax/clients?' + q.toString());
    clientRows(data.clients || [], 'itrInactiveTable', true);
  }

  async function loadITRUnassigned() {
    const q = new URLSearchParams({ limit: '500' });
    const ay = document.getElementById('itrUnassignedAY')?.value;
    if (ay) q.set('assessment_year', ay);
    const s = document.getElementById('itrUnassignedSearch')?.value?.trim();
    if (s) q.set('search', s);
    const data = await api('/income-tax/unassigned?' + q.toString());
    clientRows(data.clients || [], 'itrUnassignedTable', false, true);
  }

  function filingRows(rows, tableId) {
    const tbody = document.getElementById(tableId);
    ITR_STATE.filingMap = {};
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No yearly filing records found</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((f) => {
      ITR_STATE.filingMap[f.id] = f;
      const taskBtn = f.linked_task_id ? `<button class="btn-sm btn-green" onclick="viewTask('${esc(f.linked_task_id)}')">Task</button>` : '--';
      const statusBtn = f.can_edit_status ? `<button class="btn-sm btn-view" onclick="openITRStatus(${f.id})">Status</button>` : '';
      const assignBtn = f.can_reassign ? `<button class="btn-sm btn-view" onclick="openITRAssign('filing',${f.id})">Assign</button>` : '';
      return `<tr>
        <td><b>AY ${esc(f.assessment_year)}</b><div class="itr-client-id">FY ${esc(f.financial_year || '')}</div></td>
        <td><div class="itr-name">${esc(f.taxpayer_name)}</div><div class="itr-client-id">${esc(f.client_id)}</div></td>
        <td>${esc(f.itr_type || '--')}</td><td>${fmtDate(f.due_date)}</td>
        <td>${esc(f.assigned_to_name || '--')}<div class="itr-client-id">${esc(f.assigned_to_id || '')}</div></td>
        <td>${badge(f.status)}</td><td>${esc(f.pan_number || '--')}</td>
        <td style="white-space:nowrap">${statusBtn} ${assignBtn} ${taskBtn}</td>
      </tr>`;
    }).join('');
  }

  async function loadITRFilings() {
    const q = new URLSearchParams({ limit: '800' });
    [['assessment_year', 'itrTrackAY'], ['itr_type', 'itrTrackType'], ['status', 'itrTrackStatus'], ['assigned_to_id', 'itrTrackEmployee']].forEach(([key, id]) => {
      const v = document.getElementById(id)?.value;
      if (v) q.set(key, v);
    });
    const s = document.getElementById('itrTrackSearch')?.value?.trim();
    if (s) q.set('search', s);
    const data = await api('/income-tax/filings?' + q.toString());
    const rows = data.filings || [];
    filingRows(rows, 'itrFilingsTable');
    renderITRSummary(rows, 'itrTrackerSummary');
  }

  async function loadITRReport() {
    const q = new URLSearchParams({ limit: '1000' });
    [['assessment_year', 'itrReportAY'], ['itr_type', 'itrReportType'], ['status', 'itrReportStatus'], ['assigned_to_id', 'itrReportEmployee']].forEach(([key, id]) => {
      const v = document.getElementById(id)?.value;
      if (v) q.set(key, v);
    });
    const s = document.getElementById('itrReportSearch')?.value?.trim();
    if (s) q.set('search', s);
    const data = await api('/income-tax/filings?' + q.toString());
    const rows = data.filings || [];
    ITR_STATE.reportRows = rows;
    const tbody = document.getElementById('itrReportTable');
    tbody.innerHTML = rows.length ? rows.map((f) => `
      <tr>
        <td>AY ${esc(f.assessment_year)}<div class="itr-client-id">FY ${esc(f.financial_year || '')}</div></td>
        <td><div class="itr-name">${esc(f.taxpayer_name)}</div><div class="itr-client-id">${esc(f.client_id)}</div></td>
        <td>${esc(f.itr_type || '--')}</td><td>${fmtDate(f.due_date)}</td>
        <td>${esc(f.assigned_to_name || '--')}<div class="itr-client-id">${esc(f.assigned_to_id || '')}</div></td>
        <td>${badge(f.status)}</td><td>${f.linked_task_id ? esc(f.linked_task_id) : '--'}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">No report data found</td></tr>';
    renderITRSummary(rows, 'itrReportSummary');
  }

  function renderITRSummary(rows, targetId) {
    const counts = { total: rows.length };
    (ITR_META.status_options || []).forEach((s) => { counts[s] = 0; });
    rows.forEach((r) => { counts[r.status || 'Not Started'] = (counts[r.status || 'Not Started'] || 0) + 1; });
    document.getElementById(targetId).innerHTML = [
      ['Total', counts.total],
      ['Filed', counts.Filed || 0],
      ['Pending', counts.Pending || 0],
      ['Pending by Client', counts['Pending by Client'] || 0],
      ['Not Started', counts['Not Started'] || 0],
      ['Not Applicable', counts['Not Applicable'] || 0],
    ].map(([label, value]) => `<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  }

  async function openITRClientModal(id) {
    const isEdit = !!id;
    const client = isEdit ? ITR_STATE.clientMap[id] : null;
    document.getElementById('itrClientModalTitle').textContent = isEdit ? 'Edit Income Tax Client' : 'Add Income Tax Client';
    document.getElementById('itr_client_row_id').value = id || '';
    document.getElementById('itrClientSelectBlock').style.display = isEdit ? 'none' : '';
    ['itr_client_search_input', 'itr_base_client_id', 'itr_taxpayer_name', 'itr_contact_number', 'itr_pan_number', 'itr_password', 'itr_reference_client_name'].forEach((field) => {
      const el = document.getElementById(field);
      if (el) el.value = '';
    });
    document.getElementById('itr_client_chip').classList.add('hidden');
    setModalError('');
    setAssigneeInput('default', '');
    const list = document.getElementById('itr_default_assignee_list');
    if (list && !ITR_READY) {
      list.innerHTML = '<div class="autocomplete-item ac-item">Loading assignees...</div>';
    }
    if (client) {
      document.getElementById('itr_taxpayer_name').value = client.taxpayer_name || '';
      document.getElementById('itr_contact_number').value = client.contact_number || '';
      document.getElementById('itr_pan_number').value = client.pan_number || '';
      document.getElementById('itr_reference_client_name').value = client.reference_client_name || '';
      setAssigneeInput('default', client.default_assignee_id || '');
    }
    openModal('itrClientModal');
    if (!ITR_READY) {
      const ok = await loadITRMeta();
      if (!ok) setModalError('Assignee list load nahi hua. Page hard refresh karke dobara try karein.');
      else if (client) setAssigneeInput('default', client.default_assignee_id || '');
    }
  }

  async function itrClientSearch(q) {
    const list = document.getElementById('itr_client_search_list');
    clearTimeout(timers.clientSearch);
    if (!q || q.length < 2) { list.classList.add('hidden'); return; }
    timers.clientSearch = setTimeout(async () => {
      const data = await api('/clients/search?q=' + encodeURIComponent(q));
      const rows = data.clients || [];
      list.innerHTML = rows.length ? rows.slice(0, 20).map((c) => `
        <div class="autocomplete-item ac-item" onclick="selectITRBaseClientData('${encodeURIComponent(JSON.stringify(c))}')">
          <b>${esc(c.legal_name || c.business_name || c.client_id)}</b>
          <span>${esc(c.client_id)} ${c.mobile_number ? '- ' + esc(c.mobile_number) : ''} ${c.agent_name ? '- ' + esc(c.agent_name) : ''}</span>
        </div>`).join('') : '<div class="autocomplete-item">No client found</div>';
      list.classList.remove('hidden');
    }, 250);
  }

  function selectITRBaseClient(c) {
    document.getElementById('itr_base_client_id').value = c.client_id || '';
    document.getElementById('itr_client_search_list').classList.add('hidden');
    document.getElementById('itr_client_search_input').value = c.client_id || '';
    document.getElementById('itr_taxpayer_name').value = c.legal_name || c.business_name || '';
    document.getElementById('itr_contact_number').value = c.mobile_number || '';
    document.getElementById('itr_reference_client_name').value = c.legal_name || c.business_name || '';
    const chip = document.getElementById('itr_client_chip');
    chip.innerHTML = `<div class="client-selected-chip"><div><div class="cs-name">${esc(c.legal_name || c.business_name || c.client_id)}</div><div class="cs-meta">${esc(c.client_id)} ${c.agent_name ? '- Agent: ' + esc(c.agent_name) : ''}</div></div></div>`;
    chip.classList.remove('hidden');
  }

  function selectITRBaseClientData(encoded) {
    selectITRBaseClient(JSON.parse(decodeURIComponent(encoded)));
  }

  async function itrReferenceSearch(q) {
    const list = document.getElementById('itr_reference_search_list');
    const datalist = document.getElementById('itr_reference_datalist');
    clearTimeout(timers.referenceSearch);
    if (!q || q.length < 1) {
      list.classList.add('hidden');
      if (datalist) datalist.innerHTML = '';
      return;
    }
    list.innerHTML = '<div class="autocomplete-item ac-item">Searching...</div>';
    list.classList.remove('hidden');
    timers.referenceSearch = setTimeout(async () => {
      let clientData = { clients: [] };
      let agentData = { agents: [] };
      try {
        [clientData, agentData] = await Promise.all([
          api('/clients/search?q=' + encodeURIComponent(q)),
          api('/clients/agents?q=' + encodeURIComponent(q)),
        ]);
      } catch (err) {
        list.innerHTML = '<div class="autocomplete-item ac-item">Search failed. Please try again.</div>';
        list.classList.remove('hidden');
        return;
      }
      const clients = (clientData.clients || []).slice(0, 12).map((c) => ({
        type: 'Client',
        label: c.legal_name || c.business_name || c.client_id,
        meta: `${c.client_id || ''}${c.agent_name ? ' | Agent: ' + c.agent_name : ''}${c.mobile_number ? ' | ' + c.mobile_number : ''}`,
        value: c.legal_name || c.business_name || c.client_id,
      }));
      const agents = (agentData.agents || []).slice(0, 8).map((a) => ({
        type: 'Agent',
        label: a.name || a.agent_id,
        meta: `${a.agent_id || ''}${a.mobile_number ? ' | ' + a.mobile_number : ''}${a.email_id ? ' | ' + a.email_id : ''}`,
        value: a.name || a.agent_id,
      }));
      const rows = [...clients, ...agents];
      if (datalist) {
        datalist.innerHTML = rows.map((r) => `<option value="${esc(r.value)}">${esc(r.type)} - ${esc(r.meta)}</option>`).join('');
      }
      list.innerHTML = rows.length ? rows.map((r) => `
        <div class="autocomplete-item ac-item" onclick="selectITRReferenceData('${encodeURIComponent(JSON.stringify(r))}')">
          <div class="ac-name">${esc(r.label)} <span style="font-size:10px;color:#64748b;font-weight:700">(${esc(r.type)})</span></div>
          <div class="ac-meta">${esc(r.meta)}</div>
        </div>`).join('') : '<div class="autocomplete-item ac-item">No client or agent found</div>';
      list.classList.remove('hidden');
    }, 250);
  }

  function selectITRReference(item) {
    document.getElementById('itr_reference_client_name').value = item.value || '';
    document.getElementById('itr_reference_search_list').classList.add('hidden');
  }

  function selectITRReferenceData(encoded) {
    selectITRReference(JSON.parse(decodeURIComponent(encoded)));
  }

  async function submitITRClient() {
    const id = document.getElementById('itr_client_row_id').value;
    syncITRAssigneeInput('default');
    const payload = {
      client_id: document.getElementById('itr_base_client_id').value,
      taxpayer_name: document.getElementById('itr_taxpayer_name').value.trim(),
      contact_number: document.getElementById('itr_contact_number').value.trim(),
      pan_number: document.getElementById('itr_pan_number').value.trim(),
      password: document.getElementById('itr_password').value,
      reference_client_name: document.getElementById('itr_reference_client_name').value.trim(),
      default_assignee_id: document.getElementById('itr_default_assignee').value,
    };
    if (id) delete payload.client_id;
    const data = await api('/income-tax/clients' + (id ? '/' + id : ''), {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    if (!data.success) {
      const err = document.getElementById('itrClientErr');
      err.textContent = data.message || 'Unable to save Income Tax client';
      err.classList.remove('hidden');
      return;
    }
    closeModal('itrClientModal');
    showToast('Income Tax client saved', 'success');
    reloadIncomeTaxPanel();
  }

  async function openITRAssign(kind, id) {
    if (!ITR_READY) {
      const ok = await loadITRMeta();
      if (!ok) return;
    }
    document.getElementById('itr_assign_kind').value = kind;
    document.getElementById('itr_assign_id').value = id;
    document.getElementById('itr_assign_remark').value = '';
    const current = kind === 'client' ? ITR_STATE.clientMap[id]?.default_assignee_id : ITR_STATE.filingMap[id]?.assigned_to_id;
    setAssigneeInput('assign', current || '');
    document.getElementById('itrAssignTitle').textContent = kind === 'client' ? 'Assign Default Employee' : 'Reassign ITR Filing';
    openModal('itrAssignModal');
  }

  async function submitITRAssign() {
    syncITRAssigneeInput('assign');
    const kind = document.getElementById('itr_assign_kind').value;
    const id = document.getElementById('itr_assign_id').value;
    const assigned_to_id = document.getElementById('itr_assign_employee').value;
    const remark = document.getElementById('itr_assign_remark').value;
    if (!assigned_to_id) { showToast('Select employee first', 'error'); return; }
    const path = kind === 'client' ? `/income-tax/clients/${id}/assign` : `/income-tax/filings/${id}/assign`;
    const body = kind === 'client' ? { default_assignee_id: assigned_to_id, remark } : { assigned_to_id, remark };
    if (kind === 'client' && ITR_ACTIVE_TAB === 'unassigned') {
      body.assessment_year = document.getElementById('itrUnassignedAY')?.value || null;
    }
    const data = await api(path, { method: 'PUT', body: JSON.stringify(body) });
    closeModal('itrAssignModal');
    showToast(data.message || 'Assignment updated', data.success ? 'success' : 'error');
    if (data.success) {
      try { ['mytasks', 'assignedby', 'alltasks', 'dashboard'].forEach((p) => { panelLoaded[p] = false; }); } catch (e) {}
      reloadIncomeTaxPanel();
    }
  }

  function openITRStatus(id) {
    const filing = ITR_STATE.filingMap[id];
    if (!filing) return;
    document.getElementById('itr_status_filing_id').value = id;
    document.getElementById('itr_status_info').textContent = `${filing.taxpayer_name} - AY ${filing.assessment_year}`;
    document.getElementById('itr_status_select').value = filing.status || 'Not Started';
    document.getElementById('itr_status_type').value = filing.itr_type || '';
    document.getElementById('itr_status_due_date').value = String(filing.due_date || '').slice(0, 10);
    document.getElementById('itr_status_remark').value = '';
    openModal('itrStatusModal');
  }

  async function submitITRStatus() {
    const id = document.getElementById('itr_status_filing_id').value;
    const payload = {
      status: document.getElementById('itr_status_select').value,
      itr_type: document.getElementById('itr_status_type').value,
      due_date: document.getElementById('itr_status_due_date').value,
      remark: document.getElementById('itr_status_remark').value,
    };
    const data = await api(`/income-tax/filings/${id}/status`, { method: 'PUT', body: JSON.stringify(payload) });
    closeModal('itrStatusModal');
    showToast(data.message || 'Status updated', data.success ? 'success' : 'error');
    if (data.success) {
      try { ['mytasks', 'assignedby', 'alltasks', 'dashboard', 'completed'].forEach((p) => { panelLoaded[p] = false; }); } catch (e) {}
      reloadIncomeTaxPanel();
    }
  }

  function openITRClientStatus(id, status) {
    document.getElementById('itr_deactivate_id').value = id;
    document.getElementById('itr_deactivate_status').value = status;
    document.getElementById('itrDeactivateTitle').textContent = status === 'Inactive' ? 'Deactivate Income Tax Client' : 'Activate Income Tax Client';
    document.getElementById('itr_inactive_from').value = status === 'Inactive' ? new Date().toISOString().slice(0, 10) : '';
    document.getElementById('itr_inactive_reason').value = '';
    openModal('itrDeactivateModal');
  }

  async function submitITRClientStatus() {
    const id = document.getElementById('itr_deactivate_id').value;
    const status = document.getElementById('itr_deactivate_status').value;
    const data = await api(`/income-tax/clients/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({
        status,
        inactive_from: document.getElementById('itr_inactive_from').value,
        inactive_reason: document.getElementById('itr_inactive_reason').value,
      }),
    });
    closeModal('itrDeactivateModal');
    showToast(data.message || 'Client status updated', data.success ? 'success' : 'error');
    if (data.success) reloadIncomeTaxPanel();
  }

  function openITRGenerateModal() {
    const ay = document.getElementById('itr_generate_ay').value;
    document.getElementById('itr_generate_due_date').value = ayDueDate(ay);
    openModal('itrGenerateModal');
  }

  async function submitITRGenerate() {
    const assessment_year = document.getElementById('itr_generate_ay').value;
    const due_date = document.getElementById('itr_generate_due_date').value;
    const data = await api('/income-tax/generate', { method: 'POST', body: JSON.stringify({ assessment_year, due_date }) });
    closeModal('itrGenerateModal');
    showToast(data.message || 'Generation completed', data.success ? 'success' : 'error');
    if (data.success) {
      try { ['mytasks', 'assignedby', 'alltasks', 'dashboard', 'notifications'].forEach((p) => { panelLoaded[p] = false; }); } catch (e) {}
      switchITRTab('tracker');
    }
  }

  function openITRImportModal() {
    document.getElementById('itr_import_file').value = '';
    document.getElementById('itrImportPreview').classList.add('hidden');
    document.getElementById('itrImportErr').classList.add('hidden');
    document.getElementById('itrImportCommitBtn').disabled = true;
    openModal('itrImportModal');
  }

  async function downloadITRTemplate() {
    const res = await fetch('/api/income-tax/import/template', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      showToast('Template download failed', 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'income_tax_clients_template.xlsx';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function postITRImport(path) {
    const file = document.getElementById('itr_import_file').files[0];
    if (!file) { showToast('Select Excel file first', 'error'); return null; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('duplicate_policy', document.getElementById('itr_import_policy').value);
    const res = await fetch('/api' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    return res.json();
  }

  async function previewITRImport() {
    const data = await postITRImport('/income-tax/import/preview');
    if (!data) return;
    const box = document.getElementById('itrImportPreview');
    const err = document.getElementById('itrImportErr');
    err.classList.add('hidden');
    if (!data.success) {
      err.textContent = data.message || 'Preview failed';
      err.classList.remove('hidden');
      return;
    }
    const p = data.preview;
    box.innerHTML = `
      <b>Sheet:</b> ${esc(p.sheet)}<br>
      <b>Total:</b> ${p.summary.row_count}, <b>Valid:</b> ${p.valid_rows}, <b>Error Rows:</b> ${p.error_rows}, <b>Existing PAN:</b> ${p.duplicate_existing_pan}<br>
      ${p.error_rows ? '<b>Fix first error rows:</b><br>' + p.rows.filter((r) => r.errors.length).slice(0, 8).map((r) => `Row ${r.row_number}: ${esc(r.errors.join(', '))}`).join('<br>') : 'Ready for final import.'}
    `;
    box.classList.remove('hidden');
    document.getElementById('itrImportCommitBtn').disabled = !p.can_import;
  }

  async function submitITRImport() {
    const data = await postITRImport('/income-tax/import');
    if (!data) return;
    showToast(data.message || 'Import completed', data.success ? 'success' : 'error');
    if (data.success) {
      closeModal('itrImportModal');
      switchITRTab('clients');
    } else {
      document.getElementById('itrImportErr').textContent = data.message || 'Import failed';
      document.getElementById('itrImportErr').classList.remove('hidden');
    }
  }

  window.initIncomeTaxPanel = initIncomeTaxPanel;
  window.reloadIncomeTaxPanel = reloadIncomeTaxPanel;
  window.switchITRTab = switchITRTab;
  window.debounceITR = debounceITR;
  window.syncITRAssigneeInput = syncITRAssigneeInput;
  window.showITRAssigneeList = showITRAssigneeList;
  window.selectITRAssigneeData = selectITRAssigneeData;
  window.openITRClientModal = openITRClientModal;
  window.itrClientSearch = itrClientSearch;
  window.selectITRBaseClient = selectITRBaseClient;
  window.selectITRBaseClientData = selectITRBaseClientData;
  window.itrReferenceSearch = itrReferenceSearch;
  window.selectITRReference = selectITRReference;
  window.selectITRReferenceData = selectITRReferenceData;
  window.submitITRClient = submitITRClient;
  window.openITRAssign = openITRAssign;
  window.submitITRAssign = submitITRAssign;
  window.openITRStatus = openITRStatus;
  window.submitITRStatus = submitITRStatus;
  window.openITRClientStatus = openITRClientStatus;
  window.submitITRClientStatus = submitITRClientStatus;
  window.openITRGenerateModal = openITRGenerateModal;
  window.submitITRGenerate = submitITRGenerate;
  window.openITRImportModal = openITRImportModal;
  window.downloadITRTemplate = downloadITRTemplate;
  window.previewITRImport = previewITRImport;
  window.submitITRImport = submitITRImport;
  window.ITRRevealPassword = revealPassword;
  window.openITRPortalLogin = openITRPortalLogin;
}());
