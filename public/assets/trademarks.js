(function () {
  let READY = false;
  let ACTIVE_TAB = 'clients';
  const META = { employees: [], stages: [], status_options: [], mark_types: [] };
  const STATE = { applications: {}, timers: {}, baseClients: [] };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }
  function jsArg(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
  }
  function qs(id) { return document.getElementById(id); }
  function fmtDate(value) { return value ? String(value).slice(0, 10).split('-').reverse().join('-') : '--'; }
  function badge(status) {
    const cls = {
      Registered: 'b-complete',
      Renewed: 'b-complete',
      Closed: 'b-complete',
      Pending: 'b-pending',
      Draft: 'b-hold',
      'In Progress': 'b-progress',
      'Pending by Client': 'b-waiting',
      'Reply Due': 'b-waiting',
      'Hearing Due': 'b-waiting',
      Opposed: 'b-review',
      Refused: 'b-cancel',
      Abandoned: 'b-cancel',
      Withdrawn: 'b-cancel',
    }[status] || 'b-pending';
    return `<span class="badge ${cls}">${esc(status || 'Pending')}</span>`;
  }
  function assigneeLabel(e) {
    const desig = e.designation || e.role || '';
    return `${e.formal_name || e.name || e.emp_id} (${e.emp_id})${desig ? ' - ' + desig : ''}`;
  }
  function employeeOptions(includeAll = false) {
    const opts = includeAll ? ['<option value="">All Assignees</option>'] : ['<option value="">Unassigned</option>'];
    (META.employees || []).forEach((e) => opts.push(`<option value="${esc(e.emp_id)}">${esc(assigneeLabel(e))}</option>`));
    return opts.join('');
  }
  function optionList(values, allText = '') {
    const opts = allText ? [`<option value="">${esc(allText)}</option>`] : [];
    (values || []).forEach((v) => opts.push(`<option value="${esc(v)}">${esc(v)}</option>`));
    return opts.join('');
  }
  async function loadMeta() {
    const data = await api('/trademarks/meta', { cache: false });
    if (!data.success) {
      showToast(data.message || 'Trademark setup pending', 'error');
      return false;
    }
    Object.assign(META, data);
    ['tmkClientAssigneeFilter', 'tmkAssigneeFilter'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = employeeOptions(true); });
    ['tmk_assignee', 'tmk_assign_employee'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = employeeOptions(false); });
    ['tmkStageFilter'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = optionList(META.stages, 'All Stages'); });
    ['tmkStatusFilter'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = optionList(META.status_options, 'All Status'); });
    ['tmk_stage', 'tmk_status_stage'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = optionList(META.stages); });
    ['tmk_status', 'tmk_status_value'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = optionList(META.status_options); });
    const mark = qs('tmk_mark_type');
    if (mark) mark.innerHTML = optionList(META.mark_types);
    READY = true;
    return true;
  }
  async function initTrademarkPanel() {
    if (!READY) {
      const ok = await loadMeta();
      if (!ok) return;
    }
    switchTrademarkTab(ACTIVE_TAB || 'clients');
  }
  function switchTrademarkTab(tab) {
    ACTIVE_TAB = tab;
    ['clients', 'tracker', 'report', 'closed', 'unassigned'].forEach((t) => {
      qs(`tmk-tab-${t}`)?.classList.toggle('active', t === tab);
      qs(`tmk-panel-${t}`)?.classList.toggle('hidden', t !== tab);
    });
    reloadTrademarkPanel();
  }
  function reloadTrademarkPanel() {
    if (ACTIVE_TAB === 'report') loadTrademarkReport();
    else loadTrademarkApplications();
  }
  function debounceTrademark(kind) {
    clearTimeout(STATE.timers[kind]);
    STATE.timers[kind] = setTimeout(loadTrademarkApplications, 300);
  }
  function activeFilters() {
    if (ACTIVE_TAB === 'closed') {
      return { status: 'Closed', search: qs('tmkClosedSearch')?.value || '' };
    }
    if (ACTIVE_TAB === 'unassigned') {
      return { status: 'Active', search: qs('tmkUnassignedSearch')?.value || '' };
    }
    if (ACTIVE_TAB === 'tracker') {
      return {
        status: 'Active',
        search: qs('tmkTrackerSearch')?.value || '',
        stage: qs('tmkStageFilter')?.value || '',
        current_status: qs('tmkStatusFilter')?.value || '',
        assignee: qs('tmkAssigneeFilter')?.value || '',
      };
    }
    return { status: 'Active', search: qs('tmkClientSearch')?.value || '', assignee: qs('tmkClientAssigneeFilter')?.value || '' };
  }
  async function loadTrademarkApplications() {
    const filters = activeFilters();
    const q = new URLSearchParams({
      status: filters.status || 'Active',
      search: filters.search || '',
      stage: filters.stage || '',
      assignee: filters.assignee || '',
      current_status: filters.current_status || '',
    });
    const data = await api(`/trademarks/applications?${q}`, { cache: false });
    if (!data.success) {
      showToast(data.message || 'Trademark data load failed', 'error');
      return;
    }
    (data.applications || []).forEach((a) => { STATE.applications[a.id] = a; });
    if (ACTIVE_TAB === 'clients') renderTrademarkClients(data.applications || []);
    else if (ACTIVE_TAB === 'tracker') renderTrademarkTracker(data.applications || [], 'tmkTrackerTable');
    else if (ACTIVE_TAB === 'closed') renderTrademarkClosed(data.applications || []);
    else if (ACTIVE_TAB === 'unassigned') renderTrademarkUnassigned((data.applications || []).filter((a) => !a.assigned_to_id));
  }
  function renderTrademarkClients(apps) {
    const tbody = qs('tmkClientsTable');
    if (!tbody) return;
    const grouped = new Map();
    apps.forEach((a) => {
      const key = a.client_id || '';
      if (!grouped.has(key)) grouped.set(key, { client_id: key, name: a.client_business_name || a.client_legal_name || key, agent: a.agent_name || '--', mobile: a.client_mobile || '--', apps: [] });
      grouped.get(key).apps.push(a);
    });
    const rows = [...grouped.values()];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No trademark clients found.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((r) => {
      const due = r.apps.filter((a) => a.due_date && new Date(a.due_date) <= new Date()).length;
      return `<tr>
        <td><strong>${esc(r.name)}</strong><div class="muted">${esc(r.client_id)}</div></td>
        <td>${esc(r.agent)}</td>
        <td>${esc(r.mobile)}</td>
        <td><button class="btn-sm btn-view" onclick="openTrademarkClientApplications('${jsArg(r.client_id)}')">${r.apps.length} applications</button></td>
        <td>${due ? `<span class="badge b-waiting">${due} due</span>` : '<span class="badge b-complete">No due</span>'}</td>
        <td><button class="btn-sm btn-view" onclick="openTrademarkApplicationModal(null,'${jsArg(r.client_id)}')">Add Application</button></td>
      </tr>`;
    }).join('');
  }
  function renderTrademarkTracker(apps, tableId) {
    const tbody = qs(tableId);
    if (!tbody) return;
    if (!apps.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty-msg">No trademark applications found.</td></tr>';
      return;
    }
    tbody.innerHTML = apps.map((a) => `<tr>
      <td><strong>${esc(a.client_business_name || a.client_legal_name || a.client_id)}</strong><div class="muted">${esc(a.client_id)}</div></td>
      <td><strong>${esc(a.trademark_name)}</strong><div class="muted">${esc(a.applicant_name || '--')}</div></td>
      <td>${esc(a.application_number || '--')}</td>
      <td>${esc(a.classes_text || '--')}</td>
      <td>${esc(a.current_stage || '--')}</td>
      <td>${badge(a.current_status)}</td>
      <td>${fmtDate(a.due_date)}</td>
      <td>${esc(a.assigned_to_name || '--')}</td>
      <td>${a.linked_task_id ? `<button class="btn-sm btn-view" onclick="viewTask('${jsArg(a.linked_task_id)}')">${esc(a.linked_task_id)}</button>` : '--'}</td>
      <td style="white-space:nowrap">
        <button class="btn-sm btn-view" onclick="openTrademarkApplicationModal(${a.id})">Edit</button>
        <button class="btn-sm btn-view" onclick="openTrademarkAssignModal(${a.id})">Assign</button>
        <button class="btn-sm btn-view" onclick="openTrademarkStatusModal(${a.id})">Update</button>
        <button class="btn-sm btn-green" onclick="createTrademarkTask(${a.id})">Task</button>
        <button class="btn-sm btn-view" onclick="openIPIndiaStatus('${jsArg(a.application_number || '')}')">IP India</button>
      </td>
    </tr>`).join('');
  }
  function renderTrademarkClosed(apps) {
    const tbody = qs('tmkClosedTable');
    if (!tbody) return;
    if (!apps.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-msg">No closed trademark applications found.</td></tr>';
      return;
    }
    tbody.innerHTML = apps.map((a) => `<tr>
      <td><strong>${esc(a.client_business_name || a.client_legal_name || a.client_id)}</strong><div class="muted">${esc(a.client_id)}</div></td>
      <td>${esc(a.trademark_name)}</td><td>${esc(a.application_number || '--')}</td><td>${esc(a.current_stage || '--')}</td><td>${badge(a.current_status)}</td><td>${fmtDate(a.inactive_from)}</td>
      <td><button class="btn-sm btn-view" onclick="openTrademarkApplicationModal(${a.id})">View/Edit</button></td>
    </tr>`).join('');
  }
  function renderTrademarkUnassigned(apps) {
    const tbody = qs('tmkUnassignedTable');
    if (!tbody) return;
    if (!apps.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-msg">No unassigned trademark applications.</td></tr>';
      return;
    }
    tbody.innerHTML = apps.map((a) => `<tr>
      <td><strong>${esc(a.client_business_name || a.client_legal_name || a.client_id)}</strong><div class="muted">${esc(a.client_id)}</div></td>
      <td>${esc(a.trademark_name)}</td><td>${esc(a.application_number || '--')}</td><td>${esc(a.current_stage || '--')}</td><td>${fmtDate(a.due_date)}</td>
      <td><button class="btn-sm btn-view" onclick="openTrademarkAssignModal(${a.id})">Assign</button></td>
    </tr>`).join('');
  }
  async function loadTrademarkReport() {
    const data = await api('/trademarks/reports/summary', { cache: false });
    const summary = qs('tmkReportSummary');
    if (summary && data.success) {
      const cards = data.cards || {};
      const labels = [
        ['total', 'Total'], ['filed', 'Filed'], ['examination_pending', 'Examination Pending'],
        ['reply_due', 'Reply Due'], ['hearing_due', 'Hearing Due'], ['opposed', 'Opposed'],
        ['registered', 'Registered'], ['renewal_due', 'Renewal Due'],
      ];
      summary.innerHTML = labels.map(([k, label]) => `<div class="metric"><strong>${esc(cards[k] || 0)}</strong><span>${label}</span></div>`).join('');
    }
    const apps = await api('/trademarks/applications?status=All&limit=1000', { cache: false });
    const tbody = qs('tmkReportTable');
    if (!tbody) return;
    tbody.innerHTML = (apps.applications || []).length ? (apps.applications || []).map((a) => `<tr>
      <td>${esc(a.client_business_name || a.client_legal_name || a.client_id)}</td>
      <td>${esc(a.trademark_name)}</td><td>${esc(a.application_number || '--')}</td><td>${esc(a.classes_text || '--')}</td>
      <td>${fmtDate(a.filing_date)}</td><td>${esc(a.current_stage || '--')}</td><td>${esc(a.current_status || '--')}</td>
      <td>${esc(a.assigned_to_name || '--')}</td><td>${fmtDate(a.due_date)}</td><td>${esc(a.remarks || '--')}</td>
    </tr>`).join('') : '<tr><td colspan="10" class="empty-msg">No trademark report rows found.</td></tr>';
  }
  async function downloadTrademarkReport() {
    const token = localStorage.getItem('token') || localStorage.getItem('officeToken') || '';
    const res = await fetch('/api/trademarks/reports/export', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      showToast('Trademark report export failed', 'error');
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trademark-report-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  async function openTrademarkClientApplications(clientId) {
    ACTIVE_TAB = 'tracker';
    switchTrademarkTab('tracker');
    const input = qs('tmkTrackerSearch');
    if (input) input.value = clientId;
    await loadTrademarkApplications();
  }
  function openTrademarkApplicationModal(id, clientId = '') {
    const row = id ? STATE.applications[id] : null;
    qs('tmkApplicationTitle').textContent = row ? 'Edit Trademark Application' : 'Add Trademark Application';
    qs('tmk_app_id').value = row?.id || '';
    qs('tmk_client_id').value = row?.client_id || clientId || '';
    qs('tmk_base_client_search').value = row ? `${row.client_id} - ${row.client_business_name || row.client_legal_name || row.trademark_name}` : clientId || '';
    qs('tmk_name').value = row?.trademark_name || '';
    qs('tmk_applicant').value = row?.applicant_name || '';
    qs('tmk_app_no').value = row?.application_number || '';
    qs('tmk_mark_type').value = row?.mark_type || 'Word Mark';
    qs('tmk_filing_date').value = row?.filing_date ? String(row.filing_date).slice(0, 10) : '';
    qs('tmk_due_date').value = row?.due_date ? String(row.due_date).slice(0, 10) : '';
    qs('tmk_stage').value = row?.current_stage || 'Draft / Data Collection';
    qs('tmk_status').value = row?.current_status || 'Draft';
    qs('tmk_assignee').value = row?.assigned_to_id || '';
    qs('tmk_classes_text').value = row?.classes_text || '';
    qs('tmk_remarks').value = row?.remarks || '';
    qs('tmk_base_client_list').classList.add('hidden');
    qs('tmkApplicationErr').classList.add('hidden');
    openModal('tmkApplicationModal');
  }
  async function searchTrademarkBaseClient(q) {
    const box = qs('tmk_base_client_list');
    if (!box) return;
    qs('tmk_client_id').value = '';
    const text = String(q || '').trim();
    if (text.length < 2) { box.classList.add('hidden'); return; }
    try {
      const data = await api(`/clients/search?q=${encodeURIComponent(text)}`, { cache: false });
      STATE.baseClients = (data.clients || []).slice(0, 30);
      box.innerHTML = STATE.baseClients.length
        ? STATE.baseClients.map((c, i) => `<div class="autocomplete-item ac-item" onmousedown="event.preventDefault();selectTrademarkBaseClient(${i})"><strong>${esc(c.legal_name || c.business_name || c.client_id)}</strong><br><small>${esc(c.client_id)} | ${esc(c.agent_name || '--')} | ${esc(c.mobile_number || '--')}</small></div>`).join('')
        : '<div class="autocomplete-item ac-item muted">No clients found</div>';
      box.classList.remove('hidden');
    } catch (e) {
      STATE.baseClients = [];
      box.innerHTML = '<div class="autocomplete-item ac-item muted">Client search failed. Please try again.</div>';
      box.classList.remove('hidden');
    }
  }
  function selectTrademarkBaseClient(i) {
    const c = STATE.baseClients[i];
    if (!c) return;
    qs('tmk_client_id').value = c.client_id;
    qs('tmk_base_client_search').value = `${c.client_id} - ${c.legal_name || c.business_name || ''}`;
    qs('tmk_applicant').value = qs('tmk_applicant').value || c.business_name || c.legal_name || '';
    qs('tmk_base_client_list').classList.add('hidden');
  }
  async function submitTrademarkApplication() {
    const id = qs('tmk_app_id').value;
    const err = qs('tmkApplicationErr');
    err.classList.add('hidden');
    if (!qs('tmk_client_id').value) {
      err.textContent = 'Please select a client from the suggestion list.';
      err.classList.remove('hidden');
      qs('tmk_base_client_search')?.focus();
      return;
    }
    const payload = {
      client_id: qs('tmk_client_id').value,
      trademark_name: qs('tmk_name').value,
      applicant_name: qs('tmk_applicant').value,
      application_number: qs('tmk_app_no').value,
      mark_type: qs('tmk_mark_type').value,
      filing_date: qs('tmk_filing_date').value || null,
      due_date: qs('tmk_due_date').value || null,
      current_stage: qs('tmk_stage').value,
      current_status: qs('tmk_status').value,
      assigned_to_id: qs('tmk_assignee').value,
      classes: qs('tmk_classes_text').value,
      remarks: qs('tmk_remarks').value,
      create_task: true,
    };
    const data = await api(id ? `/trademarks/applications/${id}` : '/trademarks/applications', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
      cache: false,
    });
    if (!data.success) {
      err.textContent = data.message || 'Save failed';
      err.classList.remove('hidden');
      return;
    }
    closeModal('tmkApplicationModal');
    showToast('Trademark application saved', 'success');
    await loadTrademarkApplications();
  }
  function openTrademarkAssignModal(id) {
    const row = STATE.applications[id];
    if (!row) return;
    qs('tmk_assign_app_id').value = id;
    qs('tmk_assign_employee').value = row.assigned_to_id || '';
    qs('tmk_assign_remark').value = '';
    qs('tmkAssignErr').classList.add('hidden');
    openModal('tmkAssignModal');
  }
  async function submitTrademarkAssign() {
    const id = qs('tmk_assign_app_id').value;
    const data = await api(`/trademarks/applications/${id}/assign`, {
      method: 'PUT',
      body: JSON.stringify({ assigned_to_id: qs('tmk_assign_employee').value, remarks: qs('tmk_assign_remark').value }),
      cache: false,
    });
    if (!data.success) {
      qs('tmkAssignErr').textContent = data.message || 'Assign failed';
      qs('tmkAssignErr').classList.remove('hidden');
      return;
    }
    closeModal('tmkAssignModal');
    showToast('Trademark application assigned', 'success');
    await loadTrademarkApplications();
  }
  function openTrademarkStatusModal(id) {
    const row = STATE.applications[id];
    if (!row) return;
    qs('tmk_status_app_id').value = id;
    qs('tmk_status_stage').value = row.current_stage || 'Draft / Data Collection';
    qs('tmk_status_value').value = row.current_status || 'Pending';
    qs('tmk_status_app_no').value = row.application_number || '';
    qs('tmk_status_due_date').value = row.due_date ? String(row.due_date).slice(0, 10) : '';
    qs('tmk_status_remarks').value = row.remarks || '';
    qs('tmkStatusErr').classList.add('hidden');
    openModal('tmkStatusModal');
  }
  async function submitTrademarkStatus() {
    const id = qs('tmk_status_app_id').value;
    const data = await api(`/trademarks/applications/${id}/status`, {
      method: 'PUT',
      body: JSON.stringify({
        current_stage: qs('tmk_status_stage').value,
        current_status: qs('tmk_status_value').value,
        application_number: qs('tmk_status_app_no').value,
        due_date: qs('tmk_status_due_date').value || null,
        remarks: qs('tmk_status_remarks').value,
      }),
      cache: false,
    });
    if (!data.success) {
      qs('tmkStatusErr').textContent = data.message || 'Status update failed';
      qs('tmkStatusErr').classList.remove('hidden');
      return;
    }
    closeModal('tmkStatusModal');
    showToast('Trademark status updated', 'success');
    await loadTrademarkApplications();
  }
  async function createTrademarkTask(id) {
    const data = await api(`/trademarks/applications/${id}/create-task`, { method: 'POST', cache: false });
    if (!data.success) return showToast(data.message || 'Task creation failed', 'error');
    showToast(data.existing ? `Existing task ${data.task_id}` : `Task created ${data.task_id}`, 'success');
    await loadTrademarkApplications();
  }
  function openIPIndiaStatus(applicationNo) {
    window.open('https://tmrsearch.ipindia.gov.in/eregister/', '_blank', 'noopener');
    if (!applicationNo) showToast('Open IP India status page and search by application number manually.', 'success');
  }

  window.initTrademarkPanel = initTrademarkPanel;
  window.switchTrademarkTab = switchTrademarkTab;
  window.reloadTrademarkPanel = reloadTrademarkPanel;
  window.debounceTrademark = debounceTrademark;
  window.loadTrademarkApplications = loadTrademarkApplications;
  window.loadTrademarkReport = loadTrademarkReport;
  window.downloadTrademarkReport = downloadTrademarkReport;
  window.openTrademarkClientApplications = openTrademarkClientApplications;
  window.openTrademarkApplicationModal = openTrademarkApplicationModal;
  window.searchTrademarkBaseClient = searchTrademarkBaseClient;
  window.selectTrademarkBaseClient = selectTrademarkBaseClient;
  window.submitTrademarkApplication = submitTrademarkApplication;
  window.openTrademarkAssignModal = openTrademarkAssignModal;
  window.submitTrademarkAssign = submitTrademarkAssign;
  window.openTrademarkStatusModal = openTrademarkStatusModal;
  window.submitTrademarkStatus = submitTrademarkStatus;
  window.createTrademarkTask = createTrademarkTask;
  window.openIPIndiaStatus = openIPIndiaStatus;
}());
