const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { hashForStorage } = require('../services/authService');
const { requireOrgSetup } = require('../services/organizationSetupGuard');
const { encryptText, normalizeGstNo } = require('../utils/gstUtils');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ADMIN_ROLES = new Set(['Director', 'Office Manager', 'HR']);
const POLICIES = new Set(['create_only', 'update_existing', 'skip_duplicates']);

const EMPLOYEE_FIELDS = [
  'sl_no', 'date_of_joining', 'name', 'formal_name', 'father_name', 'pan_no', 'aadhaar_no',
  'education', 'designation', 'sex', 'marital_status', 'email_id', 'mobile_no',
  'present_address', 'permanent_address', 'date_of_cessation', 'status', 'dob',
  'blood_group', 'certificate', 'document_status', 'bank_name', 'ifsc_code', 'account_no',
  'photo', 'documents', 'basic_pay', 'related_documents', 'paid_leave_per_year',
  'leave_availed', 'leave_rest', 'salary_effective_from', 'new_basic_salary'
];

const TYPES = {
  agents: {
    title: 'Agent Import Template',
    sheet: 'Agents',
    columns: ['agent_id', 'agent_name', 'mobile_number', 'email_id'],
    required: ['agent_id', 'agent_name'],
    sample: { agent_id: 'AG-0001', agent_name: 'Example Agent', mobile_number: '9876543210', email_id: 'agent@example.com' },
  },
  clients: {
    title: 'Client Import Template',
    sheet: 'Clients',
    columns: ['client_id', 'legal_name', 'business_name', 'mobile_number', 'agent_id', 'agent_name', 'email_id', 'gst_no', 'pan_no', 'address', 'city', 'state', 'status'],
    required: ['client_id', 'mobile_number'],
    sample: { client_id: 'CL-0001', legal_name: 'Example Client', business_name: 'Example Trade', mobile_number: '9876543210', agent_id: 'AG-0001', status: 'Active' },
  },
  employees: {
    title: 'Employee Import Template',
    sheet: 'Employees',
    columns: ['emp_id', ...EMPLOYEE_FIELDS, 'login_password'],
    required: ['emp_id', 'name', 'designation'],
    sample: { emp_id: 'EMP-0001', name: 'Example Employee', formal_name: 'Mr. Example Employee', designation: 'Accountant', mobile_no: '9876543210', paid_leave_per_year: 12, status: 'Active' },
  },
  'gst-clients': {
    title: 'GST Client Import Template',
    sheet: 'GST Clients',
    columns: ['client_id', 'firm_name', 'gst_no', 'default_assignee_id', 'gst_login_id', 'gst_password', 'filing_frequency', 'qrmp_gstr3b_due_day', 'status', 'inactive_from', 'inactive_reason'],
    required: ['client_id', 'firm_name', 'gst_no', 'default_assignee_id'],
    sample: { client_id: 'CL-0001', firm_name: 'Example Firm', gst_no: '10ABCDE1234F1Z5', default_assignee_id: 'EMP-0001', filing_frequency: 'Monthly', qrmp_gstr3b_due_day: 22, status: 'Active' },
  },
};

function requireImportAdmin(req, res) {
  if (req.user?.user_type !== 'admin' || !ADMIN_ROLES.has(req.user?.role)) {
    res.status(403).json({ success: false, message: 'Director, Office Manager or HR access required' });
    return false;
  }
  return true;
}

async function requireSetupForImportType(type, organizationId) {
  if (!['agents', 'clients', 'employees'].includes(type)) return;
  const conn = await db.pool.connect();
  try {
    await requireOrgSetup(conn, organizationId);
  } finally {
    conn.release();
  }
}

function clean(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function nullable(value) {
  const v = clean(value);
  return v === '' ? null : v;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function normalizeMobile(value) {
  return clean(value).replace(/\D/g, '');
}

function validEmail(value) {
  const v = clean(value);
  return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function validDate(value) {
  const v = clean(value);
  return !v || /^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(v);
}

function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = 'Gb@';
  for (let i = 0; i < 8; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function parseWorkbook(buffer, type) {
  const cfg = TYPES[type];
  if (!cfg) {
    const err = new Error('Unsupported import type');
    err.statusCode = 404;
    throw err;
  }
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames.includes(cfg.sheet) ? cfg.sheet : workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
  return rows.map((raw, idx) => {
    const row = { __row: idx + 2 };
    Object.entries(raw).forEach(([key, value]) => { row[normalizeHeader(key)] = clean(value); });
    return row;
  }).filter(row => cfg.columns.some(col => clean(row[col])));
}

function addFieldErrors(type, row, errors) {
  const cfg = TYPES[type];
  cfg.required.forEach(col => {
    if (!clean(row[col])) errors.push(`${col} required`);
  });
  if (type === 'clients' && !clean(row.legal_name) && !clean(row.business_name)) {
    errors.push('legal_name or business_name required');
  }
  if (type === 'gst-clients') {
    row.gst_no = normalizeGstNo(row.gst_no || '');
    if (row.filing_frequency && !['Monthly', 'QRMP'].includes(row.filing_frequency)) errors.push('filing_frequency must be Monthly or QRMP');
    if (row.qrmp_gstr3b_due_day && !['22', '24', 22, 24].includes(row.qrmp_gstr3b_due_day)) errors.push('qrmp_gstr3b_due_day must be 22 or 24');
    if (row.status && !['Active', 'Inactive'].includes(row.status)) errors.push('status must be Active or Inactive');
  }
  if (type === 'clients' && row.status && !['Active', 'Inactive'].includes(row.status)) errors.push('status must be Active or Inactive');
  if (type === 'employees') {
    if (row.status && !['Active', 'Inactive', 'Resigned'].includes(row.status)) errors.push('status must be Active, Inactive or Resigned');
    ['date_of_joining', 'dob', 'date_of_cessation', 'salary_effective_from'].forEach(col => {
      if (!validDate(row[col])) errors.push(`${col} invalid date`);
    });
  }
  ['email_id', 'email'].forEach(col => {
    if (!validEmail(row[col])) errors.push(`${col} invalid email`);
  });
}

function duplicateRows(rows, keyFn) {
  const seen = new Map();
  rows.forEach(row => {
    const key = keyFn(row);
    if (!key) return;
    seen.set(key, [...(seen.get(key) || []), row.__row]);
  });
  return seen;
}

async function existingMap(type, rows) {
  if (type === 'agents') {
    const ids = rows.map(r => r.agent_id).filter(Boolean);
    if (!ids.length) return new Set();
    const r = await db.query('SELECT lower(agent_id) AS key FROM agents WHERE lower(agent_id)=ANY($1)', [ids.map(v => v.toLowerCase())]);
    return new Set(r.rows.map(x => x.key));
  }
  if (type === 'clients') {
    const ids = rows.map(r => r.client_id).filter(Boolean);
    if (!ids.length) return new Set();
    const r = await db.query('SELECT lower(client_id) AS key FROM clients WHERE lower(client_id)=ANY($1)', [ids.map(v => v.toLowerCase())]);
    return new Set(r.rows.map(x => x.key));
  }
  if (type === 'employees') {
    const ids = rows.map(r => r.emp_id).filter(Boolean);
    if (!ids.length) return new Set();
    const r = await db.query('SELECT lower(emp_id) AS key FROM emplist WHERE lower(emp_id)=ANY($1)', [ids.map(v => v.toLowerCase())]);
    return new Set(r.rows.map(x => x.key));
  }
  const gstNos = rows.map(r => normalizeGstNo(r.gst_no)).filter(Boolean);
  if (!gstNos.length) return new Set();
  const r = await db.query('SELECT upper(gst_no) AS key FROM gst_clients WHERE upper(gst_no)=ANY($1)', [gstNos.map(v => v.toUpperCase())]);
  return new Set(r.rows.map(x => x.key));
}

async function referenceSets(type, rows) {
  const refs = {};
  if (type === 'clients') {
    const agentIds = [...new Set(rows.map(r => clean(r.agent_id)).filter(Boolean))];
    refs.agents = new Set();
    if (agentIds.length) {
      const r = await db.query('SELECT lower(agent_id) AS key FROM agents WHERE lower(agent_id)=ANY($1)', [agentIds.map(v => v.toLowerCase())]);
      refs.agents = new Set(r.rows.map(x => x.key));
    }
  }
  if (type === 'gst-clients') {
    const clientIds = [...new Set(rows.map(r => clean(r.client_id)).filter(Boolean))];
    const empIds = [...new Set(rows.map(r => clean(r.default_assignee_id)).filter(Boolean))];
    refs.clients = new Set();
    refs.employees = new Map();
    if (clientIds.length) {
      const r = await db.query('SELECT lower(client_id) AS key, agent_id, agent_name FROM clients WHERE lower(client_id)=ANY($1)', [clientIds.map(v => v.toLowerCase())]);
      refs.clients = new Set(r.rows.map(x => x.key));
      refs.clientMap = new Map(r.rows.map(x => [x.key, x]));
    }
    if (empIds.length) {
      const r = await db.query("SELECT lower(emp_id) AS key, emp_id, formal_name, name FROM emplist WHERE lower(emp_id)=ANY($1) AND status='Active'", [empIds.map(v => v.toLowerCase())]);
      refs.employees = new Map(r.rows.map(x => [x.key, x]));
    }
  }
  return refs;
}

async function buildPreview(type, rows, policy = 'create_only') {
  if (!POLICIES.has(policy)) policy = 'create_only';
  const cfg = TYPES[type];
  const existing = await existingMap(type, rows);
  const refs = await referenceSets(type, rows);
  const dupes = duplicateRows(rows, row => {
    if (type === 'gst-clients') return normalizeGstNo(row.gst_no).toUpperCase();
    return clean(row[type === 'agents' ? 'agent_id' : type === 'clients' ? 'client_id' : 'emp_id']).toLowerCase();
  });
  const rowResults = rows.map(row => {
    const errors = [];
    const warnings = [];
    addFieldErrors(type, row, errors);
    const keyField = type === 'agents' ? 'agent_id' : type === 'clients' ? 'client_id' : type === 'employees' ? 'emp_id' : 'gst_no';
    const key = type === 'gst-clients' ? normalizeGstNo(row.gst_no).toUpperCase() : clean(row[keyField]).toLowerCase();
    if (key && (dupes.get(key) || []).length > 1) errors.push(`${keyField} duplicate in file`);
    if (key && existing.has(key)) {
      warnings.push(`${keyField} already exists`);
      if (policy === 'create_only') errors.push(`${keyField} already exists`);
    }
    if (type === 'clients' && row.agent_id && !refs.agents.has(row.agent_id.toLowerCase())) errors.push('agent_id not found');
    if (type === 'gst-clients') {
      if (row.client_id && !refs.clients.has(row.client_id.toLowerCase())) errors.push('client_id not found');
      if (row.default_assignee_id && !refs.employees.has(row.default_assignee_id.toLowerCase())) errors.push('default_assignee_id active employee not found');
    }
    return {
      row: row.__row,
      key: clean(row[keyField]),
      status: errors.length ? 'error' : (warnings.length ? 'warning' : 'valid'),
      errors,
      warnings,
    };
  });
  return {
    type,
    title: cfg.title,
    total_rows: rows.length,
    valid_rows: rowResults.filter(r => r.status !== 'error').length,
    error_rows: rowResults.filter(r => r.status === 'error').length,
    duplicate_rows: rowResults.filter(r => r.errors.some(e => e.includes('duplicate')) || r.warnings.some(w => w.includes('already exists'))).length,
    missing_references: rowResults.filter(r => r.errors.some(e => e.includes('not found'))).length,
    generated_passwords: type === 'employees' ? rows.filter(r => !clean(r.login_password)).length : 0,
    rows: rowResults,
  };
}

function workbookBuffer(type) {
  const cfg = TYPES[type];
  if (!cfg) return null;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([cfg.sample], { header: cfg.columns });
  XLSX.utils.sheet_add_aoa(ws, [cfg.columns], { origin: 'A1' });
  ws['!cols'] = cfg.columns.map(col => ({ wch: Math.max(14, col.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, cfg.sheet);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function updateSequence(conn, kind, ids) {
  const cols = {
    agents: ['agent_id_prefix', 'agent_id_next'],
    clients: ['client_id_prefix', 'client_id_next'],
    employees: ['employee_id_prefix', 'employee_id_next'],
  }[kind];
  if (!cols) return;
  const org = await conn.query(`SELECT ${cols[0]} AS prefix, ${cols[1]} AS next FROM organizations WHERE id=$1`, [db.getTenantContext().organizationId]);
  const prefix = org.rows[0]?.prefix;
  if (!prefix) return;
  let max = Number(org.rows[0]?.next || 1) - 1;
  ids.forEach(id => {
    if (!String(id).startsWith(prefix)) return;
    const num = Number(String(id).slice(prefix.length));
    if (Number.isFinite(num) && num > max) max = num;
  });
  if (max >= Number(org.rows[0]?.next || 1)) {
    await conn.query(`UPDATE organizations SET ${cols[1]}=$1, updated_at=NOW() WHERE id=$2`, [max + 1, db.getTenantContext().organizationId]);
  }
}

async function commitRows(type, rows, policy) {
  const preview = await buildPreview(type, rows, policy);
  if (preview.error_rows) {
    const err = new Error('Fix validation errors before import');
    err.statusCode = 400;
    err.preview = preview;
    throw err;
  }
  const conn = await db.pool.connect();
  const result = { inserted: 0, updated: 0, skipped: 0, failed: 0, credentials: [], rows: [] };
  try {
    await conn.query('BEGIN');
    for (const row of rows) {
      const action = await commitOne(conn, type, row, policy);
      result[action.status] += 1;
      result.rows.push(action);
      if (action.credential) result.credentials.push(action.credential);
    }
    if (type === 'agents') await updateSequence(conn, 'agents', rows.map(r => r.agent_id));
    if (type === 'clients') await updateSequence(conn, 'clients', rows.map(r => r.client_id));
    if (type === 'employees') await updateSequence(conn, 'employees', rows.map(r => r.emp_id));
    await conn.query('COMMIT');
    return { ...result, preview };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function commitOne(conn, type, row, policy) {
  if (type === 'agents') return commitAgent(conn, row, policy);
  if (type === 'clients') return commitClient(conn, row, policy);
  if (type === 'employees') return commitEmployee(conn, row, policy);
  return commitGSTClient(conn, row, policy);
}

async function existingBy(conn, table, field, value) {
  const r = await conn.query(`SELECT 1 FROM ${table} WHERE lower(${field})=lower($1) LIMIT 1`, [value]);
  return !!r.rows.length;
}

async function commitAgent(conn, row, policy) {
  const exists = await existingBy(conn, 'agents', 'agent_id', row.agent_id);
  if (exists && policy === 'skip_duplicates') return { row: row.__row, key: row.agent_id, status: 'skipped' };
  if (exists) {
    await conn.query(
      `UPDATE agents SET name=$1, mobile_number=COALESCE(NULLIF($2,''), mobile_number), email_id=COALESCE(NULLIF($3,''), email_id) WHERE lower(agent_id)=lower($4)`,
      [row.agent_name, nullable(row.mobile_number), nullable(row.email_id), row.agent_id]
    );
    return { row: row.__row, key: row.agent_id, status: 'updated' };
  }
  await conn.query(
    `INSERT INTO agents (agent_id, name, mobile_number, email_id) VALUES ($1,$2,$3,$4)`,
    [row.agent_id, row.agent_name, nullable(row.mobile_number), nullable(row.email_id)]
  );
  return { row: row.__row, key: row.agent_id, status: 'inserted' };
}

async function commitClient(conn, row, policy) {
  const exists = await existingBy(conn, 'clients', 'client_id', row.client_id);
  if (exists && policy === 'skip_duplicates') return { row: row.__row, key: row.client_id, status: 'skipped' };
  if (exists) {
    await conn.query(
      `UPDATE clients SET
         agent_id=COALESCE(NULLIF($1,''), agent_id),
         agent_name=COALESCE(NULLIF($2,''), agent_name),
         legal_name=COALESCE(NULLIF($3,''), legal_name),
         business_name=COALESCE(NULLIF($4,''), business_name),
         mobile_number=$5,
         email_id=COALESCE(NULLIF($6,''), email_id),
         address=COALESCE(NULLIF($7,''), address),
         city=COALESCE(NULLIF($8,''), city),
         state=COALESCE(NULLIF($9,''), state),
         gst_no=COALESCE(NULLIF($10,''), gst_no),
         pan_no=COALESCE(NULLIF($11,''), pan_no),
         status=COALESCE(NULLIF($12,''), status)
       WHERE lower(client_id)=lower($13)`,
      [row.agent_id || '', row.agent_name || '', row.legal_name || '', row.business_name || '',
       row.mobile_number, row.email_id || '', row.address || '', row.city || '', row.state || '',
       row.gst_no || '', row.pan_no || '', row.status || '', row.client_id]
    );
    return { row: row.__row, key: row.client_id, status: 'updated' };
  }
  await conn.query(
    `INSERT INTO clients (client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, address, city, state, gst_no, pan_no, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13,'Active'))`,
    [row.client_id, nullable(row.agent_id), nullable(row.agent_name), nullable(row.legal_name), nullable(row.business_name),
     row.mobile_number, nullable(row.email_id), nullable(row.address), nullable(row.city), nullable(row.state),
     nullable(row.gst_no), nullable(row.pan_no), nullable(row.status)]
  );
  return { row: row.__row, key: row.client_id, status: 'inserted' };
}

async function commitEmployee(conn, row, policy) {
  const exists = await existingBy(conn, 'emplist', 'emp_id', row.emp_id);
  if (exists && policy === 'skip_duplicates') return { row: row.__row, key: row.emp_id, status: 'skipped' };
  const password = row.login_password || generatePassword();
  const fields = EMPLOYEE_FIELDS;
  if (exists) {
    const sets = [];
    let params = [];
    fields.forEach(f => {
      if (clean(row[f]) === '') return;
      params.push(nullable(row[f]));
      sets.push(`${f}=$${params.length}`);
    });
    if (row.login_password) {
      params.push(await hashForStorage(row.login_password));
      sets.push(`login_password=$${params.length}`);
    }
    if (!sets.length) return { row: row.__row, key: row.emp_id, status: 'skipped' };
    params.push(row.emp_id);
    await conn.query(`UPDATE emplist SET ${sets.join(', ')} WHERE lower(emp_id)=lower($${params.length})`, params);
    return { row: row.__row, key: row.emp_id, status: 'updated' };
  }
  const passwordHash = await hashForStorage(password);
  const payload = {
    ...row,
    formal_name: row.formal_name || row.name,
    status: row.status || 'Active',
    paid_leave_per_year: row.paid_leave_per_year || 12,
    leave_availed: row.leave_availed || 0,
  };
  payload.leave_rest = row.leave_rest || payload.paid_leave_per_year;
  const insertValues = [row.emp_id, ...fields.map(f => nullable(payload[f])), passwordHash];
  await conn.query(
    `INSERT INTO emplist (emp_id, ${fields.join(', ')}, login_password)
     VALUES (${insertValues.map((_, i) => `$${i + 1}`).join(', ')})`,
    insertValues
  );
  return {
    row: row.__row,
    key: row.emp_id,
    status: 'inserted',
    credential: { emp_id: row.emp_id, name: row.name, email_id: row.email_id || '', mobile_no: row.mobile_no || '', password },
  };
}

async function commitGSTClient(conn, row, policy) {
  row.gst_no = normalizeGstNo(row.gst_no);
  const exists = await conn.query('SELECT id FROM gst_clients WHERE upper(gst_no)=upper($1) LIMIT 1', [row.gst_no]);
  if (exists.rows.length && policy === 'skip_duplicates') return { row: row.__row, key: row.gst_no, status: 'skipped' };
  const client = await conn.query('SELECT client_id, agent_id, agent_name FROM clients WHERE lower(client_id)=lower($1)', [row.client_id]);
  const emp = await conn.query("SELECT emp_id, formal_name, name FROM emplist WHERE lower(emp_id)=lower($1) AND status='Active'", [row.default_assignee_id]);
  const c = client.rows[0];
  const e = emp.rows[0];
  const passwordEnc = row.gst_password ? encryptText(row.gst_password) : null;
  const frequency = row.filing_frequency === 'QRMP' ? 'QRMP' : 'Monthly';
  const dueDay = Number(row.qrmp_gstr3b_due_day) === 24 ? 24 : 22;
  if (exists.rows.length) {
    await conn.query(
      `UPDATE gst_clients SET client_id=$1, firm_name=$2, gst_login_id=NULLIF($3,''), gst_password_enc=COALESCE($4,gst_password_enc),
         agent_id=$5, agent_name=$6, filing_frequency=$7, qrmp_gstr3b_due_day=$8,
         default_assignee_id=$9, default_assignee_name=$10, status=COALESCE($11,'Active'),
         inactive_from=$12, inactive_reason=$13, updated_by_id=$14, updated_by_name=$15, updated_at=NOW()
       WHERE id=$16`,
      [row.client_id, row.firm_name, row.gst_login_id || '', passwordEnc, c.agent_id || null, c.agent_name || null,
       frequency, dueDay, e.emp_id, e.formal_name || e.name, row.status || 'Active',
       nullable(row.inactive_from), nullable(row.inactive_reason), 'IMPORT', 'Onboarding Import', exists.rows[0].id]
    );
    return { row: row.__row, key: row.gst_no, status: 'updated' };
  }
  await conn.query(
    `INSERT INTO gst_clients
      (client_id, firm_name, gst_no, gst_login_id, gst_password_enc, agent_id, agent_name,
       filing_frequency, qrmp_gstr3b_due_day, default_assignee_id, default_assignee_name,
       status, inactive_from, inactive_reason, created_by_id, created_by_name, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,COALESCE($12,'Active'),$13,$14,'IMPORT','Onboarding Import','IMPORT','Onboarding Import')`,
    [row.client_id, row.firm_name, row.gst_no, row.gst_login_id || '', passwordEnc, c.agent_id || null, c.agent_name || null,
     frequency, dueDay, e.emp_id, e.formal_name || e.name, row.status || 'Active', nullable(row.inactive_from), nullable(row.inactive_reason)]
  );
  return { row: row.__row, key: row.gst_no, status: 'inserted' };
}

router.use(authMiddleware);

router.get('/template/:type', authMiddleware, (req, res) => {
  if (!requireImportAdmin(req, res)) return;
  const buffer = workbookBuffer(req.params.type);
  if (!buffer) return res.status(404).json({ success: false, message: 'Unsupported import type' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}_template.xlsx"`);
  res.send(buffer);
});

router.post('/preview/:type', authMiddleware, upload.single('file'), async (req, res) => {
  if (!requireImportAdmin(req, res)) return;
  try {
    await requireSetupForImportType(req.params.type, req.user.organization_id);
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
    const rows = parseWorkbook(req.file.buffer, req.params.type);
    const preview = await buildPreview(req.params.type, rows, req.body.duplicate_policy || 'create_only');
    res.json({ success: true, preview });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Preview failed' });
  }
});

router.post('/commit/:type', authMiddleware, upload.single('file'), async (req, res) => {
  if (!requireImportAdmin(req, res)) return;
  try {
    await requireSetupForImportType(req.params.type, req.user.organization_id);
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
    const policy = POLICIES.has(req.body.duplicate_policy) ? req.body.duplicate_policy : 'create_only';
    const rows = parseWorkbook(req.file.buffer, req.params.type);
    const result = await commitRows(req.params.type, rows, policy);
    res.json({ success: true, message: 'Import completed', result });
  } catch (err) {
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message || 'Import failed',
      preview: err.preview,
    });
  }
});

module.exports = router;
