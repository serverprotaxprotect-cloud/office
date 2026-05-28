(function () {
  const state = {
    ready: false,
    meta: { doc_types: [] },
    companies: [],
    activeCin: '',
    company: null,
    tab: 'overview',
    searchTimer: null,
  };

  function token() {
    return localStorage.getItem('office_token') || localStorage.getItem('officeToken') || '';
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function attr(value) {
    return esc(value).replace(/`/g, '&#96;');
  }

  function val(id) {
    const el = document.getElementById(id);
    if (!el) return '';
    if (el.type === 'checkbox') return el.checked;
    return el.value;
  }

  function msg(text, type = 'info') {
    if (window.showToast) return window.showToast(text, type);
    alert(text);
  }

  async function req(path, options = {}) {
    const isForm = options.body instanceof FormData;
    const res = await fetch(`/api/mca${path}`, {
      ...options,
      headers: {
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${token()}`,
        ...(options.headers || {}),
      },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res;
    }
    const data = await res.json();
    if (!res.ok || data.success === false) throw new Error(data.message || 'Request failed');
    return data;
  }

  function shell() {
    const box = document.getElementById('mcaPanelContent');
    if (!box) return;
    box.className = '';
    box.innerHTML = `
      <style>
        .mca-shell{display:grid;grid-template-columns:360px minmax(0,1fr);gap:14px}
        .mca-card{background:#fff;border-radius:8px;box-shadow:0 8px 22px rgba(15,23,42,.07);padding:16px}
        .mca-list{max-height:calc(100vh - 270px);overflow:auto;border:1px solid #e5edf7;border-radius:8px}
        .mca-company{padding:10px 12px;border-bottom:1px solid #edf2f7;cursor:pointer}
        .mca-company:hover,.mca-company.active{background:#eff6ff}
        .mca-company b{display:block;font-size:13px}.mca-company small{color:#64748b}
        .mca-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 14px}
        .mca-tabs button,.mca-btn{border:0;border-radius:7px;padding:8px 12px;font-weight:700;cursor:pointer;background:#eef4ff;color:#0f3f9f}
        .mca-tabs button.active,.mca-btn.primary{background:#2f5cf6;color:#fff}
        .mca-btn.green{background:#dcfce7;color:#166534}.mca-btn.dark{background:#1e293b;color:#fff}
        .mca-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
        .mca-grid.three{grid-template-columns:repeat(3,minmax(0,1fr))}
        .mca-field label{display:block;font-size:11px;text-transform:uppercase;font-weight:800;color:#536b90;margin:0 0 5px}
        .mca-field input,.mca-field select,.mca-field textarea{width:100%;border:1px solid #d7e2f0;border-radius:7px;padding:9px 10px;font:inherit;background:#fff}
        .mca-field textarea{min-height:72px}
        .mca-muted{color:#64748b}.mca-doc-preview{height:520px;overflow:auto;border:1px solid #d9e2ef;border-radius:8px;background:#fff}
        .mca-table-wrap{overflow:auto;border:1px solid #e5edf7;border-radius:8px}.mca-table{min-width:900px;width:100%;border-collapse:collapse}
        .mca-table th{background:#f6f8fb;text-align:left;color:#334155;font-size:12px}.mca-table th,.mca-table td{border-bottom:1px solid #edf2f7;padding:9px 10px;vertical-align:top}
        .mca-top{display:flex;justify-content:space-between;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px}
        @media(max-width:900px){.mca-shell{grid-template-columns:1fr}.mca-grid,.mca-grid.three{grid-template-columns:1fr}}
      </style>
      <div class="mca-shell">
        <div class="mca-card">
          <div class="mca-top">
            <div>
              <h3 style="margin:0 0 4px">Companies</h3>
              <small class="mca-muted">GeeBharat company master se data load hota hai</small>
            </div>
            <button class="mca-btn" onclick="mcaReloadCompanies()">Load</button>
          </div>
          <div class="mca-grid" style="grid-template-columns:1fr 130px;margin-bottom:10px">
            <input id="mcaSearch" placeholder="Search company, CIN, client..." oninput="mcaSearchChanged()" style="border:1px solid #d7e2f0;border-radius:7px;padding:10px">
            <select id="mcaStatus" onchange="mcaReloadCompanies()" style="border:1px solid #d7e2f0;border-radius:7px;padding:10px">
              <option value="">All Status</option>
              <option>Active</option>
              <option>Inactive</option>
            </select>
          </div>
          <div id="mcaCompanyList" class="mca-list"><div class="mca-muted" style="padding:14px">Loading...</div></div>
        </div>
        <div id="mcaWorkspace" class="mca-card">
          <div class="mca-muted">Company select karke MCA filing report workspace open karein.</div>
        </div>
      </div>`;
  }

  async function loadMeta() {
    state.meta = await req('/meta');
  }

  async function reloadCompanies() {
    const search = encodeURIComponent(document.getElementById('mcaSearch')?.value || '');
    const status = encodeURIComponent(document.getElementById('mcaStatus')?.value || '');
    const data = await req(`/companies?search=${search}&status=${status}`);
    state.companies = data.companies || [];
    renderCompanyList();
    if (!state.activeCin && state.companies[0]) openCompany(state.companies[0].cin);
  }

  function renderCompanyList() {
    const box = document.getElementById('mcaCompanyList');
    if (!box) return;
    if (!state.companies.length) {
      box.innerHTML = '<div class="mca-muted" style="padding:14px">No companies found.</div>';
      return;
    }
    box.innerHTML = state.companies.map(c => `
      <div class="mca-company ${String(c.cin).toUpperCase() === String(state.activeCin).toUpperCase() ? 'active' : ''}" onclick="mcaOpenCompany('${attr(c.cin)}')">
        <b>${esc(c.company_name || c.cin)}</b>
        <small>${esc(c.cin)} &nbsp; Directors: ${esc(c.director_count || 0)} &nbsp; Shareholders: ${esc(c.shareholder_count || 0)}</small><br>
        <small>${esc(c.client_id || '--')} ${esc(c.company_status || '')}</small>
      </div>`).join('');
  }

  async function openCompany(cin) {
    if (!cin) return;
    state.activeCin = cin;
    renderCompanyList();
    const ws = document.getElementById('mcaWorkspace');
    if (ws) ws.innerHTML = '<div class="mca-muted">Loading company...</div>';
    const data = await req(`/companies/${encodeURIComponent(cin)}`);
    state.company = data.company;
    state.tab = 'overview';
    renderWorkspace();
  }

  function renderWorkspace() {
    const c = state.company;
    const ws = document.getElementById('mcaWorkspace');
    if (!ws || !c) return;
    const tabs = [
      ['overview', 'Overview'], ['info', 'Company Info'], ['directors', 'Directors'],
      ['shareholders', 'Shareholders'], ['auditor', 'Auditor'], ['documents', 'Documents']
    ];
    ws.innerHTML = `
      <div class="mca-top">
        <div>
          <h2 style="margin:0">${esc(c.companyName || c.cin)}</h2>
          <small class="mca-muted">CIN: ${esc(c.cin)} | Status: ${esc(c.companyStatus || '--')} | Paid-up: ${esc(c.paidUpCapital || '--')}</small>
        </div>
        <button class="mca-btn" onclick="mcaRefreshCompany()">Refresh</button>
      </div>
      <div class="mca-tabs">${tabs.map(t => `<button class="${state.tab === t[0] ? 'active' : ''}" onclick="mcaSetTab('${t[0]}')">${t[1]}</button>`).join('')}</div>
      <div id="mcaTabBody">${renderTabBody()}</div>`;
  }

  function renderTabBody() {
    if (state.tab === 'info') return infoTab();
    if (state.tab === 'directors') return directorsTab();
    if (state.tab === 'shareholders') return shareholdersTab();
    if (state.tab === 'auditor') return auditorTab();
    if (state.tab === 'documents') return documentsTab();
    return overviewTab();
  }

  function overviewTab() {
    const c = state.company;
    return `
      <div class="mca-grid three">
        ${kv('Company Name', c.companyName)}
        ${kv('ROC', c.rocName)}
        ${kv('Registration No', c.regNumber)}
        ${kv('Incorporation Date', c.doi)}
        ${kv('Email', c.email)}
        ${kv('Category', c.category)}
        ${kv('Sub Category', c.subCategory)}
        ${kv('Authorised Capital', c.authorizedCapital)}
        ${kv('Paid-up Capital', c.paidUpCapital)}
      </div>
      <div style="margin-top:12px">${kv('Registered Office', c.registeredAddr)}</div>`;
  }

  function kv(label, value) {
    return `<div class="mca-field"><label>${esc(label)}</label><div style="padding:9px 10px;background:#f8fafc;border-radius:7px;min-height:38px">${esc(value || '--')}</div></div>`;
  }

  function infoTab() {
    const c = state.company;
    const signatoryOptions = [''].concat(c.directors || []).map(d => `<option value="${attr(d.name)}" ${d.name === c.directorSignatory ? 'selected' : ''}>${esc(d.name || '--')}</option>`).join('');
    return `
      <div class="mca-grid">
        ${field('mcaFyFrom', 'FY From', 'date', c.financialYearFrom)}
        ${field('mcaFyTo', 'FY To', 'date', c.financialYearTo)}
        ${field('mcaBoardDate', 'Board Meeting Date', 'date', c.boardMeetingDate)}
        ${field('mcaBoardPlace', 'Board Meeting Place', 'text', c.boardMeetingPlace)}
        ${field('mcaWebsite', 'Website', 'text', c.website)}
        <div class="mca-field"><label>Amount Unit</label><select id="mcaAmountUnit"><option ${c.amountUnit === 'Thousand' ? 'selected' : ''}>Thousand</option><option ${c.amountUnit === 'Lakh' ? 'selected' : ''}>Lakh</option><option ${c.amountUnit === 'Rupees' ? 'selected' : ''}>Rupees</option></select></div>
        ${field('mcaUdin', 'UDIN', 'text', c.udin)}
        <div class="mca-field"><label>Director Signatory</label><select id="mcaDirectorSignatory">${signatoryOptions}</select></div>
        <div class="mca-field" style="grid-column:1/-1"><label>Books Address</label><textarea id="mcaBooksAddress">${esc(c.booksAddr || '')}</textarea></div>
        <label style="display:flex;gap:8px;align-items:center;font-weight:700"><input type="checkbox" id="mcaMsme" ${c.msmeProvision ? 'checked' : ''}> MSME provision applicable</label>
      </div>
      <div style="margin-top:12px"><button class="mca-btn primary" onclick="mcaSaveSettings()">Save Report Settings</button></div>`;
  }

  function field(id, label, type, value) {
    return `<div class="mca-field"><label>${esc(label)}</label><input id="${id}" type="${type}" value="${attr(value || '')}"></div>`;
  }

  function directorsTab() {
    const rows = (state.company.directors || []).map(d => `<tr>
      <td>${esc(d.srNo)}</td><td>${esc(d.name)}</td><td>${esc(d.dinOrPan)}</td><td>${esc(d.designation)}</td>
      <td>${esc(d.appointmentDate || '--')}</td><td>${esc(d.cessationDate || '--')}</td><td>${esc(d.email || '--')}</td>
    </tr>`).join('');
    return table(['#', 'Director', 'DIN/PAN', 'Designation', 'Appointment', 'Cessation', 'Email'], rows);
  }

  function shareholdersTab() {
    const rows = (state.company.shareholders || []).map(s => `<tr>
      <td>${esc(s.srNo)}</td><td>${esc(s.name)}</td><td>${esc(s.securityType)}</td><td>${esc(s.folioNo || '--')}</td>
      <td>${esc(s.shares)}</td><td>${esc(s.faceValue)}</td>
    </tr>`).join('');
    return table(['#', 'Shareholder', 'Security', 'Folio', 'Shares', 'Face Value'], rows);
  }

  function auditorTab() {
    const current = (state.company.auditors || []).find(a => a.isCurrent) || {};
    const previous = (state.company.auditors || []).find(a => !a.isCurrent) || {};
    return `
      <h3>Current Auditor</h3>${auditorFields('cur', current)}
      <h3 style="margin-top:18px">Previous Auditor</h3>${auditorFields('prev', previous)}
      <div style="margin-top:12px"><button class="mca-btn primary" onclick="mcaSaveAuditors()">Save Auditors</button></div>`;
  }

  function auditorFields(prefix, a) {
    return `<div class="mca-grid three">
      ${field(`${prefix}FirmName`, 'Firm Name', 'text', a.firmName)}
      ${field(`${prefix}FirmNo`, 'Firm Reg No', 'text', a.firmNo)}
      ${field(`${prefix}FirmDesig`, 'Firm Designation', 'text', a.firmDesig || 'Chartered Accountants')}
      ${field(`${prefix}CaName`, 'CA Name', 'text', a.caName)}
      ${field(`${prefix}MemberNo`, 'Member No', 'text', a.memberNo)}
      ${field(`${prefix}CaDesig`, 'CA Designation', 'text', a.caDesig || 'Partner')}
    </div>`;
  }

  function documentsTab() {
    const opts = (state.meta.doc_types || []).map(d => `<option value="${attr(d.key)}">${esc(d.label)}</option>`).join('');
    return `
      <div class="mca-top">
        <div class="mca-field" style="min-width:280px"><label>Document Type</label><select id="mcaDocType">${opts}</select></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="mca-btn primary" onclick="mcaPreviewDoc()">Preview</button>
          <button class="mca-btn green" onclick="mcaDownloadDoc('docx')">Word</button>
          <button class="mca-btn green" onclick="mcaDownloadDoc('excel')">Excel</button>
          <button class="mca-btn dark" onclick="mcaPrintPreview()">Print / Save PDF</button>
        </div>
      </div>
      <div id="mcaPreview" class="mca-doc-preview"><div class="mca-muted" style="padding:18px">Preview generate karein.</div></div>`;
  }

  function table(headers, rows) {
    return `<div class="mca-table-wrap"><table class="mca-table"><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${headers.length}" class="mca-muted">No records found.</td></tr>`}</tbody></table></div>`;
  }

  async function saveSettings() {
    const body = {
      financial_year_from: val('mcaFyFrom'),
      financial_year_to: val('mcaFyTo'),
      board_meeting_date: val('mcaBoardDate'),
      board_meeting_place: val('mcaBoardPlace'),
      website: val('mcaWebsite'),
      amount_unit: val('mcaAmountUnit'),
      msme_provision: val('mcaMsme'),
      udin: val('mcaUdin'),
      director_signatory: val('mcaDirectorSignatory'),
      books_address: val('mcaBooksAddress'),
    };
    await req(`/companies/${encodeURIComponent(state.activeCin)}/settings`, { method: 'PUT', body: JSON.stringify(body) });
    msg('MCA report settings saved', 'success');
    await refreshCompany();
  }

  async function saveAuditors() {
    const pack = prefix => ({
      firm_name: val(`${prefix}FirmName`),
      firm_no: val(`${prefix}FirmNo`),
      firm_desig: val(`${prefix}FirmDesig`),
      ca_name: val(`${prefix}CaName`),
      member_no: val(`${prefix}MemberNo`),
      ca_desig: val(`${prefix}CaDesig`),
    });
    await req(`/companies/${encodeURIComponent(state.activeCin)}/auditors`, { method: 'PUT', body: JSON.stringify({ current: pack('cur'), previous: pack('prev') }) });
    msg('Auditor details saved', 'success');
    await refreshCompany();
  }

  async function previewDoc() {
    const docType = val('mcaDocType');
    const data = await req('/generate/html', { method: 'POST', body: JSON.stringify({ cin: state.activeCin, docType }) });
    const box = document.getElementById('mcaPreview');
    if (box) box.innerHTML = `<iframe title="MCA Preview" style="width:100%;height:100%;border:0" srcdoc="${attr(data.html)}"></iframe>`;
    state.lastHtml = data.html;
  }

  async function downloadDoc(kind) {
    const docType = val('mcaDocType');
    const res = await fetch(`/api/mca/generate/${kind === 'excel' ? 'excel' : 'docx'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ cin: state.activeCin, docType }),
    });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docType}_${state.activeCin}.${kind === 'excel' ? 'xlsx' : 'docx'}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function printPreview() {
    if (!state.lastHtml) await previewDoc();
    const w = window.open('', '_blank');
    if (!w) return msg('Popup blocked. Please allow popups for print.', 'error');
    w.document.write(state.lastHtml);
    w.document.close();
    setTimeout(() => w.print(), 500);
  }

  async function refreshCompany() {
    const tab = state.tab;
    const data = await req(`/companies/${encodeURIComponent(state.activeCin)}`);
    state.company = data.company;
    state.tab = tab;
    renderWorkspace();
  }

  async function init() {
    if (!state.ready) {
      shell();
      state.ready = true;
      await loadMeta();
    }
    await reloadCompanies();
  }

  window.initMCAFilingPanel = () => init().catch(err => msg(err.message || 'MCA Filing load failed', 'error'));
  window.mcaReloadCompanies = () => reloadCompanies().catch(err => msg(err.message, 'error'));
  window.mcaSearchChanged = () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => reloadCompanies().catch(err => msg(err.message, 'error')), 300);
  };
  window.mcaOpenCompany = cin => openCompany(cin).catch(err => msg(err.message, 'error'));
  window.mcaSetTab = tab => { state.tab = tab; renderWorkspace(); };
  window.mcaRefreshCompany = () => refreshCompany().catch(err => msg(err.message, 'error'));
  window.mcaSaveSettings = () => saveSettings().catch(err => msg(err.message, 'error'));
  window.mcaSaveAuditors = () => saveAuditors().catch(err => msg(err.message, 'error'));
  window.mcaPreviewDoc = () => previewDoc().catch(err => msg(err.message, 'error'));
  window.mcaDownloadDoc = kind => downloadDoc(kind).catch(err => msg(err.message, 'error'));
  window.mcaPrintPreview = () => printPreview().catch(err => msg(err.message, 'error'));
})();
