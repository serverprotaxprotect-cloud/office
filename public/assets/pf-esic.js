(function () {
  let META = { employees: [], status_options: [], compliance_types: [], current_period: {} };
  let READY = false;
  let ACTIVE_TAB = 'clients';
  const STATE = { clients: {}, filings: {}, timers: {}, baseClients: [] };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function qs(id) { return document.getElementById(id); }
  function apiPath(path) { return path.startsWith('/pf-esic') ? path : `/pf-esic${path}`; }
  function fmtDate(value) { return value ? String(value).slice(0, 10).split('-').reverse().join('-') : '--'; }
  function badge(status) {
    const cls = {
      'Filed': 'b-complete',
      'Paid': 'b-complete',
      'Pending': 'b-pending',
      'Pending by Client': 'b-waiting',
      'Not Started': 'b-hold',
      'Not Applicable': 'b-inactive',
    }[status] || 'b-pending';
    return `<span class="badge ${cls}">${esc(status || 'Not Started')}</span>`;
  }

  function assigneeLabel(e) {
    const desig = e.designation || e.role || '';
    return `${e.formal_name || e.name || e.emp_id} (${e.emp_id})${desig ? ' - ' + desig : ''}`;
  }

  function employeeOptions(includeAll = false) {
    const opts = includeAll ? ['<option value="">All Employees</option>'] : ['<option value="">Unassigned</option>'];
    (META.employees || []).forEach((e) => opts.push(`<option value="${esc(e.emp_id)}">${esc(assigneeLabel(e))}</option>`));
    return opts.join('');
  }

  function periodOptions(monthId, yearId) {
    const p = META.current_period || {};
    const month = Number(p.taxMonth || new Date().getMonth() + 1);
    const year = Number(p.taxYear || new Date().getFullYear());
    const monthEl = qs(monthId);
    const yearEl = qs(yearId);
    if (monthEl && !monthEl.options.length) {
      monthEl.innerHTML = MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === month ? 'selected' : ''}>${m}</option>`).join('');
    }
    if (yearEl && !yearEl.options.length) {
      const years = [];
      for (let y = year - 2; y <= year + 1; y += 1) years.push(y);
      yearEl.innerHTML = years.map((y) => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('');
    }
  }

  async function loadMeta() {
    const data = await api(apiPath('/meta'), { cache: false });
    if (!data.success) {
      showToast(data.message || 'PF/ESIC setup pending', 'error');
      return false;
    }
    META = data;
    ['pfesicAssigneeFilter', 'pfesicTrackEmployee'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = employeeOptions(true); });
    ['pfesic_default_assignee', 'pfesic_assign_employee'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = employeeOptions(false); });
    const statusOpts = '<option value="">All Status</option>' + (META.status_options || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    ['pfesicTrackStatus'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = statusOpts; });
    const statusEdit = qs('pfesic_status_select');
    if (statusEdit) statusEdit.innerHTML = (META.status_options || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    const typeOpts = '<option value="">All Types</option>' + (META.compliance_types || []).map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    ['pfesicTrackType'].forEach((id) => { const el = qs(id); if (el) el.innerHTML = typeOpts; });
    ['pfesicTrackMonth', 'pfesicTrackYear', 'pfesicReportMonth', 'pfesicReportYear', 'pfesicUnassignedMonth', 'pfesicUnassignedYear', 'pfesic_generate_month', 'pfesic_generate_year'].forEach((_, idx, ids) => {
      if (idx % 2 === 0) periodOptions(ids[idx], ids[idx + 1]);
    });
    READY = true;
    return true;
  }

  async function initPFESICPanel() {
    if (!READY) {
      const ok = await loadMeta();
      if (!ok) return;
    }
    switchPFESICTab(ACTIVE_TAB || 'clients');
  }

  function switchPFESICTab(tab) {
    ACTIVE_TAB = tab;
    ['clients', 'tracker', 'report', 'inactive', 'unassigned'].forEach((t) => {
      qs(`pfesic-tab-${t}`)?.classList.toggle('active', t === tab);
      qs(`pfesic-panel-${t}`)?.classList.toggle('hidden', t !== tab);
    });
    reloadPFESICPanel();
  }

  function reloadPFESICPanel() {
    if (ACTIVE_TAB === 'clients') loadPFESICClients();
    else if (ACTIVE_TAB === 'tracker') loadPFESICFilings();
    else if (ACTIVE_TAB === 'report') loadPFESICReport();
    else if (ACTIVE_TAB === 'inactive') loadPFESICInactive();
    else loadPFESICUnassigned();
  }

  function debouncePFESIC(kind) {
    clearTimeout(STATE.timers[kind]);
    STATE.timers[kind] = setTimeout(() => {
      if (kind === 'clients') loadPFESICClients();
      else if (kind === 'inactive') loadPFESICInactive();
      else if (kind === 'unassigned') loadPFESICUnassigned();
      else loadPFESICFilings();
    }, 300);
  }

  async function loadPFESICClients(status = 'Active') {
    const search = status === 'Inactive' ? qs('pfesicInactiveSearch')?.value || '' : qs('pfesicClientSearch')?.value || '';
    const assignee = status === 'Active' ? qs('pfesicAssigneeFilter')?.value || '' : '';
    const data = await api(apiPath(`/clients?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}&assignee=${encodeURIComponent(assignee)}`), { cache: false });
    const tbody = qs(status === 'Inactive' ? 'pfesicInactiveTable' : 'pfesicClientsTable');
    if (!tbody) return;
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="9" class="empty-msg">${esc(data.message || 'Load failed')}</td></tr>`;
      return;
    }
    data.clients.forEach((c) => { STATE.clients[c.id] = c; });
    if (!data.clients.length) {
      tbody.innerHTML = `<tr><td colspan="${status === 'Inactive' ? 7 : 9}" class="empty-msg">No PF/ESIC clients found</td></tr>`;
      return;
    }
    if (status === 'Inactive') {
      tbody.innerHTML = data.clients.map((c) => `<tr>
        <td><strong>${esc(c.client_id)}</strong></td><td>${esc(c.firm_name)}</td><td>${esc(c.pf_establishment_code || '--')}</td><td>${esc(c.esic_code || '--')}</td>
        <td>${fmtDate(c.inactive_from)}</td><td>${esc(c.inactive_reason || '--')}</td>
        <td><button class="btn-sm btn-view" onclick="restorePFESICClient(${c.id})">Activate</button></td>
      </tr>`).join('');
      return;
    }
    tbody.innerHTML = data.clients.map((c) => `<tr>
      <td><strong>${esc(c.client_id)}</strong><div class="muted">${esc(c.agent_name || '--')}</div></td>
      <td>${esc(c.firm_name)}</td>
      <td>${esc(c.pf_establishment_code || '--')}</td>
      <td>${esc(c.esic_code || '--')}</td>
      <td>${esc(c.pf_login_id || '--')}</td>
      <td>${esc(c.esic_login_id || '--')}</td>
      <td><span class="masked-pass">••••••</span> <button class="btn-sm btn-view" onclick="revealPFESICPassword(this, ${c.id})">Show</button></td>
      <td>${esc(c.default_assignee_name || '--')}<div class="muted">${esc(c.default_assignee_id || '')}</div></td>
      <td style="white-space:nowrap">
        <button class="btn-sm btn-green" onclick="openPFESICPortalLogin(${c.id}, 'PF')" ${c.can_autofill_pf ? '' : 'disabled'}>PF Login</button>
        <button class="btn-sm btn-green" onclick="openPFESICPortalLogin(${c.id}, 'ESIC')" ${c.can_autofill_esic ? '' : 'disabled'}>ESIC Login</button>
        <button class="btn-sm btn-view" onclick="openPFESICClientModal(${c.id})">Edit</button>
        <button class="btn-sm btn-view" onclick="openPFESICAssignModal('client', ${c.id})">Assign</button>
        <button class="btn-sm btn-danger" onclick="deactivatePFESICClient(${c.id})">Inactive</button>
      </td>
    </tr>`).join('');
  }

  function loadPFESICInactive() { loadPFESICClients('Inactive'); }

  async function loadPFESICFilings() {
    const q = new URLSearchParams({
      tax_month: qs('pfesicTrackMonth')?.value || META.current_period.taxMonth,
      tax_year: qs('pfesicTrackYear')?.value || META.current_period.taxYear,
      type: qs('pfesicTrackType')?.value || '',
      status: qs('pfesicTrackStatus')?.value || '',
      assignee: qs('pfesicTrackEmployee')?.value || '',
      search: qs('pfesicTrackSearch')?.value || '',
    });
    const data = await api(apiPath(`/filings?${q}`), { cache: false });
    const tbody = qs('pfesicFilingsTable');
    if (!tbody) return;
    if (!data.success || !data.filings?.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="empty-msg">${esc(data.message || 'No monthly records found. Generate Monthly Tasks use karein.')}</td></tr>`;
      qs('pfesicTrackerSummary').innerHTML = '';
      return;
    }
    data.filings.forEach((f) => { STATE.filings[f.id] = f; });
    const counts = data.filings.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
    qs('pfesicTrackerSummary').innerHTML = Object.entries(counts).map(([k, v]) => `<div class="metric"><strong>${v}</strong><span>${esc(k)}</span></div>`).join('');
    tbody.innerHTML = data.filings.map((f) => `<tr>
      <td>${esc(f.period_label)}</td><td><strong>${esc(f.firm_name)}</strong><div class="muted">${esc(f.client_id)}</div></td>
      <td>${esc(f.compliance_type)}</td><td>${fmtDate(f.due_date)}</td>
      <td>${esc(f.assigned_to_name || '--')}</td><td>${badge(f.status)}</td>
      <td>${esc(f.challan_ack_no || '--')}</td><td>${f.amount ? esc(f.amount) : '--'}</td>
      <td>${f.linked_task_id ? `<button class="btn-sm btn-view" onclick="viewTask('${esc(f.linked_task_id)}')">${esc(f.linked_task_id)}</button>` : '--'}</td>
      <td style="white-space:nowrap"><button class="btn-sm btn-view" onclick="openPFESICAssignModal('filing', ${f.id})">Assign</button> <button class="btn-sm btn-view" onclick="openPFESICStatusModal(${f.id})">Update</button></td>
    </tr>`).join('');
  }

  async function loadPFESICReport() {
    const q = new URLSearchParams({
      tax_month: qs('pfesicReportMonth')?.value || META.current_period.taxMonth,
      tax_year: qs('pfesicReportYear')?.value || META.current_period.taxYear,
    });
    const data = await api(apiPath(`/reports/summary?${q}`), { cache: false });
    const tbody = qs('pfesicReportTable');
    if (!tbody) return;
    if (!data.success) {
      tbody.innerHTML = `<tr><td colspan="12" class="empty-msg">${esc(data.message || 'Report failed')}</td></tr>`;
      return;
    }
    qs('pfesicReportSummary').innerHTML = (data.summary || []).map((r) => `<div class="metric"><strong>${esc(r.count)}</strong><span>${esc(r.compliance_type)} - ${esc(r.status)}</span></div>`).join('');
    tbody.innerHTML = (data.rows || []).length ? data.rows.map((r) => `<tr>
      <td>${esc(r.period_label)}</td><td><strong>${esc(r.firm_name)}</strong><div class="muted">${esc(r.client_id)}</div></td>
      <td>${esc(r.pf_establishment_code || '--')}</td><td>${esc(r.esic_code || '--')}</td><td>${esc(r.compliance_type)}</td><td>${fmtDate(r.due_date)}</td>
      <td>${esc(r.assigned_to_name || '--')}</td><td>${badge(r.status)}</td><td>${esc(r.challan_ack_no || '--')}</td><td>${r.amount || '--'}</td><td>${fmtDate(r.payment_date)}</td>
      <td>${r.linked_task_id ? esc(r.linked_task_id) : '--'}</td>
    </tr>`).join('') : '<tr><td colspan="12" class="empty-msg">No report rows found.</td></tr>';
  }

  async function loadPFESICUnassigned() {
    const data = await api(apiPath(`/clients?status=Active&search=${encodeURIComponent(qs('pfesicUnassignedSearch')?.value || '')}`), { cache: false });
    const tbody = qs('pfesicUnassignedTable');
    if (!tbody) return;
    const rows = (data.clients || []).filter((c) => !c.default_assignee_id);
    tbody.innerHTML = rows.length ? rows.map((c) => `<tr>
      <td><strong>${esc(c.client_id)}</strong></td><td>${esc(c.firm_name)}</td><td>${esc(c.pf_establishment_code || '--')}</td><td>${esc(c.esic_code || '--')}</td><td>--</td>
      <td><button class="btn-sm btn-view" onclick="openPFESICAssignModal('client', ${c.id})">Assign</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-msg">No unassigned PF/ESIC clients.</td></tr>';
  }

  function revealPFESICPassword(btn, id) {
    const row = STATE.clients[id] || {};
    btn.closest('td').querySelector('.masked-pass').textContent = [row.pf_password, row.esic_password].filter(Boolean).join(' / ') || '--';
    btn.remove();
  }

  async function openPFESICPortalLogin(id, portalType) {
    const data = await api(apiPath(`/clients/${id}/autofill-token`), { method: 'POST', body: JSON.stringify({ portal_type: portalType, origin: location.origin }), cache: false });
    if (!data.success) return showToast(data.message || `${portalType} autofill token failed`, 'error');
    const opened = window.open(data.extension_url_hint, '_blank', 'noopener');
    if (!opened) return showToast('Popup blocked. Browser popup allow karke dobara Login click karein.', 'error');
    showToast(`${portalType} login page open ho gaya. Extension installed hoga to ID/password auto-fill honge.`, 'success');
  }

  function openPFESICClientModal(id) {
    const row = id ? STATE.clients[id] : null;
    qs('pfesicClientTitle').textContent = row ? 'Edit PF/ESIC Client' : 'Add PF/ESIC Client';
    qs('pfesic_client_row_id').value = row?.id || '';
    qs('pfesic_client_id').value = row?.client_id || '';
    qs('pfesic_base_client_search').value = row ? `${row.client_id} - ${row.firm_name}` : '';
    qs('pfesic_firm_name').value = row?.firm_name || '';
    qs('pfesic_pf_code').value = row?.pf_establishment_code || '';
    qs('pfesic_pf_login').value = row?.pf_login_id || '';
    qs('pfesic_pf_password').value = '';
    qs('pfesic_esic_code').value = row?.esic_code || '';
    qs('pfesic_esic_login').value = row?.esic_login_id || '';
    qs('pfesic_esic_password').value = '';
    qs('pfesic_default_assignee').value = row?.default_assignee_id || '';
    qs('pfesicClientErr').classList.add('hidden');
    openModal('pfesicClientModal');
  }

  async function searchPFESICBaseClient(q) {
    const box = qs('pfesic_base_client_list');
    if (!box) return;
    const text = String(q || '').trim();
    if (text.length < 2) { box.classList.add('hidden'); return; }
    const data = await api(`/clients/search?q=${encodeURIComponent(text)}`, { cache: false });
    const rows = data.clients || [];
    STATE.baseClients = rows;
    box.innerHTML = rows.length ? rows.slice(0, 20).map((c, idx) => `<div class="autocomplete-item ac-item" onclick="selectPFESICBaseClient(${idx})">
      <div class="ac-name">${esc(c.legal_name || c.business_name || c.client_id)}</div>
      <div class="ac-meta">${esc(c.client_id)} | ${esc(c.mobile_number || '--')}</div>
    </div>`).join('') : '<div class="autocomplete-item ac-item">No client found</div>';
    box.classList.remove('hidden');
  }

  function selectPFESICBaseClient(idx) {
    const c = STATE.baseClients[idx];
    if (!c) return;
    qs('pfesic_client_id').value = c.client_id;
    qs('pfesic_base_client_search').value = `${c.client_id} - ${c.legal_name || c.business_name || ''}`;
    if (!qs('pfesic_firm_name').value) qs('pfesic_firm_name').value = c.business_name || c.legal_name || c.client_id;
    qs('pfesic_base_client_list').classList.add('hidden');
  }

  async function submitPFESICClient() {
    const id = qs('pfesic_client_row_id').value;
    const payload = {
      client_id: qs('pfesic_client_id').value,
      firm_name: qs('pfesic_firm_name').value,
      pf_establishment_code: qs('pfesic_pf_code').value,
      pf_login_id: qs('pfesic_pf_login').value,
      pf_password: qs('pfesic_pf_password').value,
      esic_code: qs('pfesic_esic_code').value,
      esic_login_id: qs('pfesic_esic_login').value,
      esic_password: qs('pfesic_esic_password').value,
      default_assignee_id: qs('pfesic_default_assignee').value,
    };
    const data = await api(apiPath(id ? `/clients/${id}` : '/clients'), { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload), cache: false });
    if (!data.success) {
      qs('pfesicClientErr').textContent = data.message || 'Save failed';
      qs('pfesicClientErr').classList.remove('hidden');
      return;
    }
    closeModal('pfesicClientModal');
    showToast('PF/ESIC client saved', 'success');
    loadPFESICClients();
  }

  function openPFESICAssignModal(kind, id) {
    qs('pfesic_assign_target_kind').value = kind;
    qs('pfesic_assign_target_id').value = id;
    qs('pfesic_assign_employee').value = '';
    qs('pfesic_assign_remark').value = '';
    qs('pfesicAssignTitle').textContent = kind === 'client' ? 'Assign PF/ESIC Client' : 'Assign PF/ESIC Filing';
    openModal('pfesicAssignModal');
  }

  async function submitPFESICAssign() {
    const kind = qs('pfesic_assign_target_kind').value;
    const id = qs('pfesic_assign_target_id').value;
    const emp = qs('pfesic_assign_employee').value;
    if (!emp) return showToast('Select employee', 'error');
    const path = kind === 'client' ? `/clients/${id}/assign` : `/filings/${id}/assign`;
    const body = kind === 'client' ? { assignee_id: emp, remark: qs('pfesic_assign_remark').value } : { assignee_id: emp, remark: qs('pfesic_assign_remark').value };
    const data = await api(apiPath(path), { method: 'PUT', body: JSON.stringify(body), cache: false });
    closeModal('pfesicAssignModal');
    showToast(data.message || (data.success ? 'Assigned' : 'Assign failed'), data.success ? 'success' : 'error');
    if (data.success) reloadPFESICPanel();
  }

  function openPFESICStatusModal(id) {
    const row = STATE.filings[id];
    if (!row) return showToast('Filing row not loaded', 'error');
    qs('pfesic_status_filing_id').value = id;
    qs('pfesicStatusTitle').textContent = `${row.compliance_type} - ${row.firm_name}`;
    qs('pfesic_status_select').value = row.status || 'Pending';
    qs('pfesic_status_due').value = String(row.due_date || '').slice(0, 10);
    qs('pfesic_status_ack').value = row.challan_ack_no || '';
    qs('pfesic_status_amount').value = row.amount || '';
    qs('pfesic_status_payment_date').value = String(row.payment_date || '').slice(0, 10);
    qs('pfesic_status_remark').value = '';
    openModal('pfesicStatusModal');
  }

  async function submitPFESICStatus() {
    const id = qs('pfesic_status_filing_id').value;
    const payload = {
      status: qs('pfesic_status_select').value,
      due_date: qs('pfesic_status_due').value,
      challan_ack_no: qs('pfesic_status_ack').value,
      amount: qs('pfesic_status_amount').value,
      payment_date: qs('pfesic_status_payment_date').value,
      remark: qs('pfesic_status_remark').value,
    };
    const data = await api(apiPath(`/filings/${id}/status`), { method: 'PUT', body: JSON.stringify(payload), cache: false });
    closeModal('pfesicStatusModal');
    showToast(data.message || (data.success ? 'Status saved' : 'Status failed'), data.success ? 'success' : 'error');
    if (data.success) loadPFESICFilings();
  }

  function openPFESICGenerateModal() {
    periodOptions('pfesic_generate_month', 'pfesic_generate_year');
    openModal('pfesicGenerateModal');
  }

  async function submitPFESICGenerate() {
    const data = await api(apiPath('/generate'), {
      method: 'POST',
      body: JSON.stringify({ tax_month: qs('pfesic_generate_month').value, tax_year: qs('pfesic_generate_year').value }),
      cache: false,
    });
    closeModal('pfesicGenerateModal');
    const s = data.summary || {};
    showToast(data.success ? `Generated: ${s.filings_created || 0}, existing: ${s.existing || 0}, tasks: ${s.tasks_created || 0}` : (data.message || 'Generate failed'), data.success ? 'success' : 'error');
    if (data.success) { switchPFESICTab('tracker'); loadPFESICFilings(); }
  }

  function deactivatePFESICClient(id) {
    const reason = prompt('Inactive reason:', 'Not active');
    if (reason === null) return;
    api(apiPath(`/clients/${id}/status`), { method: 'PUT', body: JSON.stringify({ status: 'Inactive', reason }), cache: false })
      .then((data) => { showToast(data.message || (data.success ? 'Client inactive' : 'Update failed'), data.success ? 'success' : 'error'); if (data.success) loadPFESICClients(); });
  }

  function restorePFESICClient(id) {
    api(apiPath(`/clients/${id}/status`), { method: 'PUT', body: JSON.stringify({ status: 'Active' }), cache: false })
      .then((data) => { showToast(data.message || (data.success ? 'Client active' : 'Update failed'), data.success ? 'success' : 'error'); if (data.success) loadPFESICInactive(); });
  }

  function openPFESICImportModal() {
    qs('pfesic_import_file').value = '';
    qs('pfesicImportSummary').textContent = '';
    qs('pfesicImportErr').classList.add('hidden');
    openModal('pfesicImportModal');
  }

  async function pfesicImportForm() {
    const file = qs('pfesic_import_file')?.files?.[0];
    if (!file) { showToast('Select Excel file first', 'error'); return null; }
    const fd = new FormData();
    fd.append('file', file);
    return fd;
  }

  async function previewPFESICImport() {
    const fd = await pfesicImportForm();
    if (!fd) return;
    const data = await api(apiPath('/import/preview'), { method: 'POST', body: fd, cache: false });
    qs('pfesicImportSummary').textContent = data.success ? `Sheet: ${data.sheet}, Total: ${data.total}` : '';
    if (!data.success) {
      qs('pfesicImportErr').textContent = data.message || 'Preview failed';
      qs('pfesicImportErr').classList.remove('hidden');
    }
  }

  async function submitPFESICImport() {
    const fd = await pfesicImportForm();
    if (!fd) return;
    const data = await api(apiPath('/import'), { method: 'POST', body: fd, cache: false });
    if (!data.success) {
      qs('pfesicImportErr').textContent = data.message || 'Import failed';
      qs('pfesicImportErr').classList.remove('hidden');
      return;
    }
    closeModal('pfesicImportModal');
    const s = data.summary || {};
    showToast(`Import done. Inserted ${s.inserted || 0}, updated ${s.updated || 0}, skipped ${s.skipped || 0}`, 'success');
    loadPFESICClients();
  }

  window.initPFESICPanel = initPFESICPanel;
  window.switchPFESICTab = switchPFESICTab;
  window.reloadPFESICPanel = reloadPFESICPanel;
  window.debouncePFESIC = debouncePFESIC;
  window.loadPFESICClients = loadPFESICClients;
  window.loadPFESICFilings = loadPFESICFilings;
  window.loadPFESICReport = loadPFESICReport;
  window.loadPFESICInactive = loadPFESICInactive;
  window.loadPFESICUnassigned = loadPFESICUnassigned;
  window.revealPFESICPassword = revealPFESICPassword;
  window.openPFESICPortalLogin = openPFESICPortalLogin;
  window.openPFESICClientModal = openPFESICClientModal;
  window.searchPFESICBaseClient = searchPFESICBaseClient;
  window.selectPFESICBaseClient = selectPFESICBaseClient;
  window.submitPFESICClient = submitPFESICClient;
  window.openPFESICAssignModal = openPFESICAssignModal;
  window.submitPFESICAssign = submitPFESICAssign;
  window.openPFESICStatusModal = openPFESICStatusModal;
  window.submitPFESICStatus = submitPFESICStatus;
  window.openPFESICGenerateModal = openPFESICGenerateModal;
  window.submitPFESICGenerate = submitPFESICGenerate;
  window.deactivatePFESICClient = deactivatePFESICClient;
  window.restorePFESICClient = restorePFESICClient;
  window.openPFESICImportModal = openPFESICImportModal;
  window.previewPFESICImport = previewPFESICImport;
  window.submitPFESICImport = submitPFESICImport;
})();
