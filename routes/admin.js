const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const XLSX   = require('xlsx');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const { buildLoginResponse, hashForStorage } = require('../services/authService');
const { ensureOrgSetupComplete, requireOrgSetup } = require('../services/organizationSetupGuard');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

// ── IST helpers (Asia/Kolkata = UTC+5:30) ────────────────────
function nowIST()    { return new Date(Date.now() + (5.5 * 60 * 60 * 1000)); }
function todayIST()  { return nowIST().toISOString().split('T')[0]; }
function dateKey(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value || '').split('T')[0];
}
function canManageAdminUsers(admin) {
  return ['Director', 'Office Manager', 'HR'].includes(admin?.role);
}

const EMPLOYEE_FIELDS = [
  'sl_no', 'date_of_joining', 'name', 'formal_name', 'father_name', 'pan_no', 'aadhaar_no',
  'education', 'designation', 'sex', 'marital_status', 'email_id', 'mobile_no',
  'present_address', 'permanent_address', 'date_of_cessation', 'status', 'dob',
  'blood_group', 'certificate', 'document_status', 'bank_name', 'ifsc_code', 'account_no',
  'photo', 'documents', 'basic_pay', 'related_documents', 'paid_leave_per_year',
  'leave_availed', 'leave_rest', 'salary_effective_from', 'new_basic_salary'
];

function cleanNullable(value) {
  if (value === undefined || value === null || value === '') return null;
  return value;
}

const EMPLOYEE_UPLOAD_FIELDS = [
  { name: 'employee_photo', maxCount: 1 },
  { name: 'doc_aadhaar', maxCount: 1 },
  { name: 'doc_pan', maxCount: 1 },
  { name: 'doc_bank_passbook', maxCount: 1 },
  { name: 'doc_qualification', maxCount: 1 },
];

function fileToDataUrl(file) {
  if (!file) return null;
  return {
    filename: file.originalname,
    mime_type: file.mimetype,
    size: file.size,
    data_url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
    uploaded_at: new Date().toISOString(),
  };
}

function collectEmployeeUploads(files = {}) {
  const photo = fileToDataUrl(files.employee_photo?.[0]);
  const docs = {
    aadhaar: fileToDataUrl(files.doc_aadhaar?.[0]),
    pan: fileToDataUrl(files.doc_pan?.[0]),
    bank_passbook: fileToDataUrl(files.doc_bank_passbook?.[0]),
    qualification: fileToDataUrl(files.doc_qualification?.[0]),
  };
  const cleanDocs = Object.fromEntries(Object.entries(docs).filter(([, v]) => v));
  return { photo, documents: Object.keys(cleanDocs).length ? cleanDocs : null };
}

function parseEmployeePayload(req) {
  const body = { ...req.body };
  const uploads = collectEmployeeUploads(req.files || {});
  if (uploads.photo) body.photo = uploads.photo.data_url;
  if (uploads.documents) {
    let existing = {};
    if (body.documents) {
      try { existing = JSON.parse(body.documents); } catch { existing = { note: body.documents }; }
    }
    body.documents = JSON.stringify({ ...existing, ...uploads.documents });
    body.document_status = body.document_status || 'Uploaded';
  }
  return body;
}

function generatedEmployeePassword() {
  return 'GB' + Math.random().toString(36).slice(2, 8).toUpperCase() + '@1';
}

async function nextSeriesNumber(conn, { table, idColumn, prefix, organizationId, storedNext }) {
  const result = await conn.query(
    `SELECT COALESCE(MAX(substring(${idColumn} from length($1) + 1)::integer), 0) + 1 AS next_no
     FROM ${table}
     WHERE organization_id=$2
       AND left(${idColumn}, length($1))=$1
       AND substring(${idColumn} from length($1) + 1) ~ '^[0-9]+$'`,
    [prefix, organizationId]
  );
  return Math.max(Number(storedNext || 1), Number(result.rows[0]?.next_no || 1));
}

function seriesNumberFromId(id, prefix) {
  const value = String(id || '');
  const cleanPrefix = String(prefix || '');
  if (!cleanPrefix || !value.startsWith(cleanPrefix)) return null;
  const suffix = value.slice(cleanPrefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}

async function nextEmployeeId() {
  const org = await db.query(
    `SELECT latitude, longitude, attendance_radius_meters,
            employee_id_prefix, employee_id_next, employee_id_series_locked,
            client_id_prefix, agent_id_prefix
     FROM organizations WHERE id=$1 FOR UPDATE`,
    [db.getTenantContext().organizationId]
  );
  const o = org.rows[0] || {};
  ensureOrgSetupComplete(o);
  const prefix = o.employee_id_prefix;
  const next = await nextSeriesNumber(db, {
    table: 'emplist',
    idColumn: 'emp_id',
    prefix,
    organizationId: db.getTenantContext().organizationId,
    storedNext: o.employee_id_next,
  });
  const empId = `${prefix}${String(next).padStart(4, '0')}`;
  await db.query(`UPDATE organizations SET employee_id_next=GREATEST(employee_id_next, $1), updated_at=NOW() WHERE id=$2`, [next + 1, db.getTenantContext().organizationId]);
  return empId;
}

// ── POST /api/admin/login ────────────────────────────────────
router.post('/login', async (req, res) => {
  const loginId = req.body.login_id || req.body.username;
  const { password } = req.body;
  if (!loginId || !password)
    return res.status(400).json({ success: false, message: 'Login ID and password required' });

  try {
    const result = await buildLoginResponse(loginId, password, 'admin');
    if (result.requires_selection) return res.json({ success: true, ...result });
    res.json({ success: true, token: result.token, admin: result.user, user: result.user });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Server error' });
  }
});

// ── GET /api/admin/overview ──────────────────────────────────
router.get('/session-from-office', adminAuth, async (req, res) => {
  if (!canManageAdminUsers(req.admin)) {
    return res.status(403).json({ success: false, message: 'Employee Management access not allowed for this admin.' });
  }
  res.json({
    success: true,
    token: req.headers.authorization?.split(' ')[1] || '',
    admin: {
      id: req.admin.id,
      username: req.admin.username,
      name: req.admin.name,
      role: req.admin.role,
      organization_code: req.admin.organization_code,
      organization_name: req.admin.organization_name,
      read_only: req.admin.read_only,
    },
  });
});

router.get('/overview', adminAuth, async (req, res) => {
  const today = todayIST();
  try {
    const [total, present, onLeave, sessions] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM emplist WHERE status='Active'`),
      db.query(`SELECT COUNT(DISTINCT emp_id) FROM daily_attendance WHERE date::date=$1 AND final_status IN ('Present','Pending')`, [today]),
      db.query(`SELECT COUNT(*) FROM leave_requests WHERE $1 BETWEEN from_date::date AND to_date::date AND status='Approved'`, [today]),
      db.query(`SELECT e.emp_id, e.name, e.formal_name, e.designation, a.first_in, a.final_status
                FROM emplist e
                LEFT JOIN daily_attendance a ON a.emp_id=e.emp_id AND a.date::date=$1
                WHERE e.status='Active'
                ORDER BY e.name`, [today])
    ]);

    const totalCount   = parseInt(total.rows[0].count);
    const presentCount = parseInt(present.rows[0].count);
    const leaveCount   = parseInt(onLeave.rows[0].count);
    const absentCount  = totalCount - presentCount - leaveCount;

    res.json({
      success: true,
      today,
      stats: { total: totalCount, present: presentCount, on_leave: leaveCount, absent: Math.max(0, absentCount) },
      employees_today: sessions.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/attendance?month=&year= ───────────────────
router.get('/admin-users', adminAuth, async (req, res) => {
  if (!canManageAdminUsers(req.admin)) {
    return res.status(403).json({ success: false, message: 'Admin user management access required' });
  }
  try {
    const users = await db.query(
      `SELECT id, username, name, email_id, mobile_no, role, COALESCE(status,'Active') AS status, created_at
       FROM admins
       ORDER BY name, username`
    );
    res.json({ success: true, admins: users.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/admin-users', adminAuth, async (req, res) => {
  if (!canManageAdminUsers(req.admin)) {
    return res.status(403).json({ success: false, message: 'Admin user management access required' });
  }
  const { username, password, name, email_id, mobile_no, role } = req.body;
  const allowedRoles = ['Director', 'Office Manager', 'HR', 'Accountant'];
  if (!username || !password || !name || !allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, message: 'Username, name, password and valid role are required' });
  }
  try {
    const inserted = await db.query(
      `INSERT INTO admins (username, password, name, email_id, mobile_no, role, status)
       VALUES ($1,$2,$3,$4,$5,$6,'Active')
       RETURNING id, username, name, email_id, mobile_no, role, status, created_at`,
      [
        String(username).trim(),
        await hashForStorage(password),
        String(name).trim(),
        email_id ? String(email_id).trim() : null,
        mobile_no ? String(mobile_no).trim() : null,
        role,
      ]
    );
    res.json({ success: true, message: 'Admin user created', admin: inserted.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(err.code === '23505' ? 400 : 500).json({
      success: false,
      message: err.code === '23505' ? 'Admin login ID already exists in this organisation' : 'Server error',
    });
  }
});

router.put('/admin-users/:id', adminAuth, async (req, res) => {
  if (!canManageAdminUsers(req.admin)) {
    return res.status(403).json({ success: false, message: 'Admin user management access required' });
  }
  const { name, email_id, mobile_no, role, status, password } = req.body;
  const allowedRoles = ['Director', 'Office Manager', 'HR', 'Accountant'];
  const allowedStatuses = ['Active', 'Inactive'];
  if (role && !allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid role' });
  }
  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  try {
    const updated = await db.query(
      `UPDATE admins SET
         name=COALESCE($1, name),
         email_id=COALESCE($2, email_id),
         mobile_no=COALESCE($3, mobile_no),
         role=COALESCE($4, role),
         status=COALESCE($5, status),
         password=COALESCE($6, password),
         updated_at=NOW()
       WHERE id=$7
       RETURNING id, username, name, email_id, mobile_no, role, status, created_at`,
      [
        name ? String(name).trim() : null,
        email_id ? String(email_id).trim() : null,
        mobile_no ? String(mobile_no).trim() : null,
        role || null,
        status || null,
        password ? await hashForStorage(password) : null,
        req.params.id,
      ]
    );
    if (!updated.rows.length) return res.status(404).json({ success: false, message: 'Admin user not found' });
    res.json({ success: true, message: 'Admin user updated', admin: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/attendance', adminAuth, async (req, res) => {
  const month = parseInt(req.query.month) || (nowIST().getUTCMonth() + 1);
  const year  = parseInt(req.query.year)  || nowIST().getUTCFullYear();
  try {
    const records = await db.query(
      `SELECT a.*, to_char(a.date::date, 'YYYY-MM-DD') AS date, e.designation
       FROM daily_attendance a
       JOIN emplist e ON e.emp_id = a.emp_id
       WHERE a.month=$1 AND a.year=$2
       ORDER BY a.date DESC, a.employee_name`,
      [month, year]
    );
    const punches = await db.query(
      `SELECT emp_id, to_char(date::date, 'YYYY-MM-DD') AS punch_date, action, time, latitude, longitude,
              accuracy_meters, address, formatted_address, place_id, location_type,
              geocode_provider, distance_from_office_meters, geofence_radius_meters,
              within_geofence, created_at
       FROM attendance_log
       WHERE EXTRACT(MONTH FROM date)=$1 AND EXTRACT(YEAR FROM date)=$2
       ORDER BY created_at ASC`,
      [month, year]
    );
    const punchMap = new Map();
    punches.rows.forEach(p => {
      const key = `${p.emp_id}|${p.punch_date}`;
      if (!punchMap.has(key)) punchMap.set(key, []);
      punchMap.get(key).push(p);
    });
    const attendanceRecords = records.rows.map(r => ({
      ...r,
      punches: punchMap.get(`${r.emp_id}|${r.date}`) || []
    }));
    // Summary per employee
    const summary = await db.query(
      `SELECT emp_id, employee_name,
              COUNT(*) as total_days,
              COUNT(*) FILTER (WHERE final_status='Present') as present,
              COUNT(*) FILTER (WHERE final_status='Pending') as pending,
              COUNT(*) FILTER (WHERE late_minutes > 0) as late_days,
              SUM(late_minutes) as total_late_mins
       FROM daily_attendance
       WHERE month=$1 AND year=$2
       GROUP BY emp_id, employee_name
       ORDER BY employee_name`,
      [month, year]
    );
    res.json({ success: true, month, year, records: attendanceRecords, summary: summary.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/attendance/update ───────────────────────
router.post('/attendance/update', adminAuth, async (req, res) => {
  const { emp_id, date, final_status, grace_minutes, remark } = req.body;
  try {
    await db.query(
      `UPDATE daily_attendance
       SET final_status=$1, grace_minutes_granted=COALESCE($2,grace_minutes_granted),
           remark=$3, approved_by=$4, approved_at=NOW()
       WHERE emp_id=$5 AND date::date=$6`,
      [final_status, grace_minutes || null, remark || null, req.admin.name, emp_id, date]
    );
    res.json({ success: true, message: 'Attendance updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/employees ─────────────────────────────────
router.get('/employees', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, sl_no, emp_id, date_of_joining, name, formal_name, father_name, pan_no, aadhaar_no,
              education, designation, sex, marital_status, email_id, mobile_no, present_address,
              permanent_address, date_of_cessation, status, dob, blood_group, certificate,
              document_status, bank_name, ifsc_code, account_no, photo, documents, basic_pay,
              related_documents, paid_leave_per_year, leave_availed, leave_rest,
              salary_effective_from, new_basic_salary
       FROM emplist ORDER BY name`
    );
    res.json({ success: true, employees: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/employees/add ───────────────────────────
router.post('/employees/add', adminAuth, upload.fields(EMPLOYEE_UPLOAD_FIELDS), async (req, res) => {
  const body = parseEmployeePayload(req);
  const { login_password } = body;
  const name = body.name;
  const designation = body.designation;

  if (!name || !designation || !login_password)
    return res.status(400).json({ success: false, message: 'Name, Designation and Password required' });

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await requireOrgSetup(conn, req.user.organization_id);
    const org = await conn.query(
      `SELECT employee_id_prefix, employee_id_next FROM organizations WHERE id=$1 FOR UPDATE`,
      [req.user.organization_id]
    );
    const o = org.rows[0] || {};
    const prefix = o.employee_id_prefix;
    const next = await nextSeriesNumber(conn, {
      table: 'emplist',
      idColumn: 'emp_id',
      prefix,
      organizationId: req.user.organization_id,
      storedNext: o.employee_id_next,
    });
    const newId = `${prefix}${String(next).padStart(4, '0')}`;
    const passwordHash = await hashForStorage(login_password);
    const payload = { ...body, formal_name: body.formal_name || name, status: body.status || 'Active', leave_availed: body.leave_availed || 0, paid_leave_per_year: body.paid_leave_per_year || 12 };
    payload.leave_rest = payload.leave_rest || payload.paid_leave_per_year;
    const cols = ['emp_id', ...EMPLOYEE_FIELDS, 'login_password'];
    const values = [newId, ...EMPLOYEE_FIELDS.map(f => cleanNullable(payload[f])), passwordHash];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
    await conn.query(`INSERT INTO emplist (${cols.join(',')}) VALUES (${placeholders})`, values);
    const employeeNo = seriesNumberFromId(newId, prefix);
    if (employeeNo) {
      await conn.query(`UPDATE organizations SET employee_id_next=GREATEST(employee_id_next, $1), updated_at=NOW() WHERE id=$2`, [employeeNo + 1, req.user.organization_id]);
    }
    await conn.query('COMMIT');
    res.json({ success: true, message: `Employee added with ID: ${newId}`, emp_id: newId });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    conn.release();
  }
});

// ── PUT /api/admin/employees/:id ─────────────────────────────
router.put('/employees/:id', adminAuth, upload.fields(EMPLOYEE_UPLOAD_FIELDS), async (req, res) => {
  const { id } = req.params;
  try {
    const body = parseEmployeePayload(req);
    const setParts = [];
    const values = [];
    for (const field of EMPLOYEE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        values.push(cleanNullable(body[field]));
        setParts.push(`${field}=$${values.length}`);
      }
    }
    if (body.login_password) {
      values.push(await hashForStorage(body.login_password));
      setParts.push(`login_password=$${values.length}`);
    }
    if (!setParts.length) return res.status(400).json({ success: false, message: 'No fields to update' });
    values.push(id);
    const updated = await db.query(
      `UPDATE emplist SET ${setParts.join(', ')} WHERE emp_id=$${values.length} RETURNING emp_id`,
      values
    );
    if (!updated.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, message: 'Employee updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── Helpers for admin routes ──────────────────────────────────
// Employee onboarding links and requests
router.get('/employee-onboarding/requests', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT r.id, r.token, r.status, r.data, r.documents, r.hr_remark,
              r.created_at, r.updated_at, l.expires_at, l.status AS link_status
       FROM employee_onboarding_requests r
       LEFT JOIN employee_onboarding_links l ON l.id=r.link_id
       WHERE r.organization_id=$1
       ORDER BY r.created_at DESC`,
      [req.user.organization_id]
    );
    res.json({ success: true, requests: r.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

router.post('/employee-onboarding/links', adminAuth, async (req, res) => {
  try {
    const token = uuidv4().replace(/-/g, '');
    const days = Math.max(1, Math.min(30, Number(req.body.valid_days || 7)));
    await db.query(
      `INSERT INTO employee_onboarding_links
       (organization_id, token, status, created_by_id, created_by_name, expires_at)
       VALUES ($1,$2,'Active',$3,$4,NOW() + ($5 || ' days')::interval)`,
      [req.user.organization_id, token, req.user.emp_id || req.user.username || req.user.id, req.user.name || req.user.username, days]
    );
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, link: `${base}/employee-onboarding.html?token=${token}`, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

router.put('/employee-onboarding/requests/:id/reupload', adminAuth, async (req, res) => {
  try {
    const remark = cleanNullable(req.body.remark) || 'Please reupload required documents.';
    const r = await db.query(
      `UPDATE employee_onboarding_requests
       SET status='Needs Reupload', hr_remark=$1, updated_at=NOW()
       WHERE id=$2 AND organization_id=$3 RETURNING id`,
      [remark, req.params.id, req.user.organization_id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Request not found' });
    res.json({ success: true, message: 'Reupload request marked' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

router.post('/employee-onboarding/requests/:id/approve', adminAuth, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await requireOrgSetup(conn, req.user.organization_id);
    const reqRes = await conn.query(
      `SELECT * FROM employee_onboarding_requests
       WHERE id=$1 AND organization_id=$2 FOR UPDATE`,
      [req.params.id, req.user.organization_id]
    );
    const row = reqRes.rows[0];
    if (!row) {
      await conn.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Request not found' });
    }
    if (row.status === 'Approved') {
      await conn.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Already approved' });
    }
    const data = { ...(row.data || {}), ...(req.body.employee || {}) };
    if (!data.name || !data.designation) {
      await conn.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Name and designation required before approval' });
    }
    const org = await conn.query(`SELECT employee_id_prefix, employee_id_next FROM organizations WHERE id=$1 FOR UPDATE`, [req.user.organization_id]);
    const o = org.rows[0] || {};
    const next = await nextSeriesNumber(conn, {
      table: 'emplist',
      idColumn: 'emp_id',
      prefix: o.employee_id_prefix,
      organizationId: req.user.organization_id,
      storedNext: o.employee_id_next,
    });
    const newId = `${o.employee_id_prefix}${String(next).padStart(4, '0')}`;
    const password = req.body.login_password || generatedEmployeePassword();
    const payload = {
      ...data,
      formal_name: data.formal_name || data.name,
      status: 'Active',
      document_status: data.document_status || 'Uploaded',
      documents: JSON.stringify(row.documents || {}),
      paid_leave_per_year: data.paid_leave_per_year || 12,
      leave_availed: data.leave_availed || 0,
      leave_rest: data.leave_rest || data.paid_leave_per_year || 12,
    };
    const cols = ['emp_id', ...EMPLOYEE_FIELDS, 'login_password'];
    const values = [newId, ...EMPLOYEE_FIELDS.map(f => cleanNullable(payload[f])), await hashForStorage(password)];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(',');
    await conn.query(`INSERT INTO emplist (${cols.join(',')}) VALUES (${placeholders})`, values);
    const employeeNo = seriesNumberFromId(newId, o.employee_id_prefix);
    if (employeeNo) {
      await conn.query(`UPDATE organizations SET employee_id_next=GREATEST(employee_id_next, $1), updated_at=NOW() WHERE id=$2`, [employeeNo + 1, req.user.organization_id]);
    }
    await conn.query(`UPDATE employee_onboarding_requests SET status='Approved', approved_emp_id=$1, updated_at=NOW() WHERE id=$2`, [newId, row.id]);
    await conn.query(`UPDATE employee_onboarding_links SET status='Used' WHERE id=$1`, [row.link_id]);
    await conn.query('COMMIT');
    res.json({ success: true, message: `Employee approved and added: ${newId}`, emp_id: newId, login_password: password });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  } finally {
    conn.release();
  }
});

router.get('/employee-onboarding/public/:token', async (req, res) => {
  try {
    const link = await db.query(
      `SELECT l.id, l.organization_id, l.status, l.expires_at, o.office_name, o.org_code,
              r.status AS request_status, r.hr_remark, r.data, r.documents
       FROM employee_onboarding_links l
       JOIN organizations o ON o.id=l.organization_id
       LEFT JOIN employee_onboarding_requests r ON r.link_id=l.id
       WHERE l.token=$1`,
      [req.params.token]
    );
    const row = link.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'Invalid onboarding link' });
    if (row.status !== 'Active' && row.request_status !== 'Needs Reupload') return res.status(400).json({ success: false, message: 'This onboarding link is not active' });
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(400).json({ success: false, message: 'This onboarding link has expired' });
    res.json({
      success: true,
      organization: { name: row.office_name, code: row.org_code },
      request_status: row.request_status,
      hr_remark: row.hr_remark,
      data: row.data || {},
      documents: row.documents || {}
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/employee-onboarding/public/:token', upload.fields(EMPLOYEE_UPLOAD_FIELDS), async (req, res) => {
  try {
    const link = await db.query(`SELECT * FROM employee_onboarding_links WHERE token=$1`, [req.params.token]);
    const l = link.rows[0];
    if (!l || l.status !== 'Active') return res.status(400).json({ success: false, message: 'Invalid or inactive onboarding link' });
    if (l.expires_at && new Date(l.expires_at) < new Date()) return res.status(400).json({ success: false, message: 'This onboarding link has expired' });
    const uploads = collectEmployeeUploads(req.files || {});
    const data = { ...req.body };
    if (uploads.photo) data.photo = uploads.photo.data_url;
    const documents = uploads.documents || {};
    const existing = await db.query(`SELECT id, documents FROM employee_onboarding_requests WHERE link_id=$1`, [l.id]);
    if (existing.rows.length) {
      const mergedDocs = { ...(existing.rows[0].documents || {}), ...documents };
      await db.query(
        `UPDATE employee_onboarding_requests SET data=$1::jsonb, documents=$2::jsonb, status='Pending', updated_at=NOW() WHERE id=$3`,
        [JSON.stringify(data), JSON.stringify(mergedDocs), existing.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO employee_onboarding_requests (organization_id, link_id, token, status, data, documents)
         VALUES ($1,$2,$3,'Pending',$4::jsonb,$5::jsonb)`,
        [l.organization_id, l.id, req.params.token, JSON.stringify(data), JSON.stringify(documents)]
      );
    }
    res.json({ success: true, message: 'Details submitted for HR review' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

async function getSettings() {
  const r = await db.query('SELECT key, value FROM attendance_settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  return s;
}
function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = String(timeStr).split(':').map(Number);
  return h * 60 + (m || 0);
}
async function ensureHolidaysTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      holiday_date DATE NOT NULL,
      holiday_name VARCHAR(100) NOT NULL,
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS holidays_org_date_unique ON holidays(organization_id, holiday_date)`);
}
async function ensureRequestsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_requests (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      emp_id VARCHAR(50) NOT NULL,
      employee_name VARCHAR(100),
      request_date DATE NOT NULL,
      check_in_time TIME,
      check_out_time TIME,
      reason TEXT,
      status VARCHAR(20) DEFAULT 'Pending',
      reviewed_by VARCHAR(100),
      reviewed_at TIMESTAMPTZ,
      admin_remark TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── GET /api/admin/holidays ───────────────────────────────────
router.get('/holidays', adminAuth, async (req, res) => {
  const year = parseInt(req.query.year) || nowIST().getUTCFullYear();
  try {
    await ensureHolidaysTable();
    const result = await db.query(
      `SELECT id, holiday_date, holiday_name, created_by FROM holidays
       WHERE EXTRACT(YEAR FROM holiday_date) = $1 ORDER BY holiday_date`,
      [year]
    );
    res.json({ success: true, holidays: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/holidays ──────────────────────────────────
router.post('/holidays', adminAuth, async (req, res) => {
  const { holiday_date, holiday_name } = req.body;
  if (!holiday_date || !holiday_name)
    return res.status(400).json({ success: false, message: 'Date and name required' });
  try {
    await ensureHolidaysTable();
    await db.query(
      `INSERT INTO holidays (holiday_date, holiday_name, created_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (organization_id, holiday_date) DO UPDATE SET holiday_name=$2, created_by=$3`,
      [holiday_date, holiday_name.trim(), req.admin.name]
    );
    res.json({ success: true, message: 'Holiday saved!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/admin/holidays/:id ───────────────────────────
router.delete('/holidays/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM holidays WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Holiday removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/notices ────────────────────────────────────
router.get('/notices', adminAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, title, message, start_at, end_at, created_by, created_at
       FROM notices ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ success: true, notices: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/notices ───────────────────────────────────
router.post('/notices', adminAuth, async (req, res) => {
  const { title, message, start_at, end_at } = req.body;
  if (!title || !message || !start_at || !end_at)
    return res.status(400).json({ success: false, message: 'Title, message, start and end time required' });
  try {
    const r = await db.query(
      `INSERT INTO notices (title, message, start_at, end_at, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [title.trim(), message.trim(), start_at, end_at, req.admin.name]
    );
    res.json({ success: true, message: 'Notice published!', id: r.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/admin/notices/:id ────────────────────────────
router.delete('/notices/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM notices WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Notice deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/attendance-requests ───────────────────────
router.get('/attendance-requests', adminAuth, async (req, res) => {
  const status = req.query.status || 'Pending';
  try {
    await ensureRequestsTable();
    const result = await db.query(
      `SELECT ar.id, ar.emp_id, ar.employee_name, TO_CHAR(ar.request_date, 'YYYY-MM-DD') AS request_date,
              ar.check_in_time, ar.check_out_time, ar.reason, ar.status, ar.admin_remark,
              ar.reviewed_by, ar.reviewed_at, ar.created_at, e.designation
       FROM attendance_requests ar
       LEFT JOIN emplist e ON e.emp_id = ar.emp_id
       WHERE ar.status=$1 ORDER BY ar.created_at DESC`,
      [status]
    );
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/admin/attendance-requests/:id ───────────────────
router.put('/attendance-requests/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { action, admin_remark, check_in_time, check_out_time } = req.body;
  if (!['Approved', 'Rejected'].includes(action))
    return res.status(400).json({ success: false, message: 'Invalid action' });
  try {
    const reqRow = await db.query(
      `SELECT id, emp_id, employee_name, TO_CHAR(request_date, 'YYYY-MM-DD') AS request_date,
              check_in_time, check_out_time, reason, status, admin_remark,
              reviewed_by, reviewed_at, created_at
       FROM attendance_requests
       WHERE id=$1`,
      [id]
    );
    if (!reqRow.rows.length) return res.status(404).json({ success: false, message: 'Request not found' });
    const r = reqRow.rows[0];

    await db.query(
      `UPDATE attendance_requests SET status=$1, reviewed_by=$2, reviewed_at=NOW(), admin_remark=$3 WHERE id=$4`,
      [action, req.admin.name, admin_remark || null, id]
    );

    if (action === 'Approved') {
      const dateStr = dateKey(r.request_date);
      const [yearNum, monthNum] = dateStr.split('-').map(Number);
      const month = monthNum;
      const year  = yearNum;

      const empRow = await db.query(`SELECT name, formal_name FROM emplist WHERE emp_id=$1`, [r.emp_id]);
      const empName = empRow.rows[0]?.formal_name || empRow.rows[0]?.name || r.employee_name;

      const existsRow = await db.query(
        `SELECT emp_id, first_in, last_out FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`,
        [r.emp_id, dateStr]
      );
      const existingAttendance = existsRow.rows[0] || {};
      const inTime  = check_in_time  || r.check_in_time  || existingAttendance.first_in;
      const outTime = check_out_time || r.check_out_time || existingAttendance.last_out;

      if (!inTime && !outTime) {
        return res.status(400).json({ success: false, message: 'Approve karne ke liye IN ya OUT time required hai' });
      }

      const cfg = await getSettings();
      const fullDayMins = parseInt(cfg.FULL_DAY_MINUTES || '480');
      const halfDayMins = parseInt(cfg.HALF_DAY_MINUTES || '240');
      const officeStartMins = toMinutes(cfg.OFFICE_START_TIME || '10:00:00');
      const lateThreshold = parseInt(cfg.LATE_THRESHOLD_MINUTES || '0');
      const lateMinutes = inTime ? Math.max(0, toMinutes(inTime) - officeStartMins - lateThreshold) : 0;
      let workingHours = null;
      let finalStatus = 'Pending';
      if (inTime && outTime) {
        const worked = Math.max(0, toMinutes(outTime) - toMinutes(inTime));
        workingHours = `${Math.floor(worked/60)}h ${worked%60}m`;
        finalStatus = worked >= fullDayMins ? 'Present' : worked >= halfDayMins ? 'Half Day' : 'Short Day';
      }

      if (existsRow.rows.length > 0) {
        await db.query(
          `UPDATE daily_attendance SET
             first_in=COALESCE($1, first_in), last_out=COALESCE($2, last_out),
             working_hours=COALESCE($3, working_hours), final_status=$4,
             late_minutes=$5,
             remark='Backdated - Approved', approved_by=$6, approved_at=NOW()
           WHERE emp_id=$7 AND date::date=$8`,
          [inTime || null, outTime || null, workingHours, finalStatus,
           lateMinutes, req.admin.name, r.emp_id, dateStr]
        );
      } else {
        await db.query(
          `INSERT INTO daily_attendance
             (date, emp_id, employee_name, formal_name, first_in, last_out,
              working_hours, final_status, late_minutes, month, year, remark, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Backdated - Approved',$12,NOW())`,
          [dateStr, r.emp_id, empName, empName,
           inTime || null, outTime || null, workingHours, finalStatus,
           lateMinutes, month, year, req.admin.name]
        );
      }

      const crypto = require('crypto');
      if (inTime) {
        await db.query(
          `INSERT INTO attendance_log
             (log_id, date, emp_id, employee_name, formal_name, action, time, marked_by, created_at)
           VALUES ($1,$2,$3,$4,$5,'IN',$6,'Admin-Approved',NOW())
           ON CONFLICT DO NOTHING`,
          ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
           dateStr, r.emp_id, empName, empName, inTime]
        ).catch(() => {});
      }
      if (outTime) {
        await db.query(
          `INSERT INTO attendance_log
             (log_id, date, emp_id, employee_name, formal_name, action, time, marked_by, created_at)
           VALUES ($1,$2,$3,$4,$5,'OUT',$6,'Admin-Approved',NOW())
           ON CONFLICT DO NOTHING`,
          ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
           dateStr, r.emp_id, empName, empName, outTime]
        ).catch(() => {});
      }
    }

    res.json({ success: true, message: `Request ${action}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── POST /api/admin/attendance/modify-time ───────────────────
router.post('/attendance/modify-time', adminAuth, async (req, res) => {
  const { emp_id, date, check_in_time, check_out_time } = req.body;
  if (!emp_id || !date) return res.status(400).json({ success: false, message: 'emp_id and date required' });
  try {
    const cfg = await getSettings();
    const fullDayMins = parseInt(cfg.FULL_DAY_MINUTES || '480');
    const halfDayMins = parseInt(cfg.HALF_DAY_MINUTES || '240');

    const sets = [];
    const vals = [];
    let idx = 1;
    if (check_in_time)  { sets.push(`first_in=$${idx++}`);  vals.push(check_in_time); }
    if (check_out_time) { sets.push(`last_out=$${idx++}`);  vals.push(check_out_time); }

    if (check_in_time && check_out_time) {
      const worked = Math.max(0, toMinutes(check_out_time) - toMinutes(check_in_time));
      const wh = `${Math.floor(worked/60)}h ${worked%60}m`;
      const fs = worked >= fullDayMins ? 'Present' : worked >= halfDayMins ? 'Half Day' : 'Short Day';
      sets.push(`working_hours=$${idx++}`, `final_status=$${idx++}`);
      vals.push(wh, fs);
    }

    sets.push(`approved_by=$${idx++}`, `approved_at=NOW()`);
    vals.push(req.admin.name, emp_id, date);

    await db.query(
      `UPDATE daily_attendance SET ${sets.join(',')} WHERE emp_id=$${idx++} AND date::date=$${idx}`,
      vals
    );
    res.json({ success: true, message: 'Attendance time updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/attendance/template ───────────────────────
// Returns a downloadable Excel template for attendance import
router.get('/attendance/template', adminAuth, async (req, res) => {
  try {
    const empRes = await db.query(
      `SELECT emp_id, formal_name, name FROM emplist WHERE status='Active' ORDER BY emp_id`
    );

    const wb = XLSX.utils.book_new();

    // Sheet 1: Attendance Data (to be filled)
    const attHeaders = ['Date (DD/MM/YYYY)', 'Emp ID', 'Employee Name', 'IN Time (HH:MM)', 'OUT Time (HH:MM)', 'Location', 'Remark'];
    const attData = [attHeaders];
    // Add one example row
    attData.push(['01/05/2026', empRes.rows[0]?.emp_id || 'PTP-0001', empRes.rows[0]?.formal_name || empRes.rows[0]?.name || 'Employee Name', '10:00', '19:00', 'Ground Floor, A3, Kankarbagh...', '']);
    const ws1 = XLSX.utils.aoa_to_sheet(attData);
    ws1['!cols'] = [{ wch: 20 }, { wch: 12 }, { wch: 22 }, { wch: 16 }, { wch: 16 }, { wch: 40 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'Attendance');

    // Sheet 2: Employee List (reference)
    const empHeaders = ['Emp ID', 'Name', 'Designation'];
    const empData = [empHeaders, ...empRes.rows.map(e => [e.emp_id, e.formal_name || e.name, ''])];
    const ws2 = XLSX.utils.aoa_to_sheet(empData);
    ws2['!cols'] = [{ wch: 12 }, { wch: 25 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Employees');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_import_template.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/attendance/import ────────────────────────
router.post('/attendance/import', adminAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

  const results = { imported: 0, skipped: 0, errors: [] };

  // ── Shared helpers ──────────────────────────────────────────
  // Parse Excel serial or DD/MM/YYYY or DD-MM-YYYY → { dateStr, timeStr }
  function parseDateTime(val) {
    if (!val && val !== 0) return { dateStr: null, timeStr: null };
    if (typeof val === 'number') {
      // Excel datetime serial: integer = date, fraction = time
      const totalSec = Math.round((val - Math.floor(val)) * 86400);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      const timeStr = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      const d = new Date(Math.round((Math.floor(val) - 25569) * 86400 * 1000));
      const dateStr = d.toISOString().split('T')[0];
      return { dateStr, timeStr: h > 0 || m > 0 ? timeStr : null };
    }
    const s = val.toString().trim();
    // DD/MM/YYYY HH:MM or DD-MM-YYYY HH:MM
    const dtm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}:\d{2}(:\d{2})?)$/);
    if (dtm) return { dateStr: `${dtm[3]}-${dtm[2].padStart(2,'0')}-${dtm[1].padStart(2,'0')}`, timeStr: dtm[4] };
    // DD/MM/YYYY only
    const dm = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dm) return { dateStr: `${dm[3]}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`, timeStr: null };
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { dateStr: s, timeStr: null };
    return { dateStr: null, timeStr: null };
  }

  function parseTimeOnly(val) {
    if (!val && val !== 0) return null;
    const s = val.toString().trim();
    if (!s || s === '-') return null;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s.includes(':') && s.split(':').length === 2 ? s + ':00' : s;
    if (typeof val === 'number' && val > 0 && val < 1) {
      const sec = Math.round(val * 86400);
      return `${String(Math.floor(sec/3600)).padStart(2,'0')}:${String(Math.floor((sec%3600)/60)).padStart(2,'0')}:00`;
    }
    return null;
  }

  const crypto = require('crypto');

  async function upsertAttendance(empId, empName, dateStr, inTime, outTime, lateMinutes, workingHours, finalStatus, remark, location, adminName) {
    const dateObj = new Date(dateStr);
    const month   = dateObj.getMonth() + 1;
    const year    = dateObj.getFullYear();

    const existing = await db.query(
      `SELECT emp_id FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`,
      [empId, dateStr]
    );
    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE daily_attendance SET
           first_in=COALESCE($1, first_in), last_out=COALESCE($2, last_out),
           working_hours=COALESCE($3, working_hours), final_status=$4,
           late_minutes=$5, remark=COALESCE($6, remark), approved_by=$7, approved_at=NOW()
         WHERE emp_id=$8 AND date::date=$9`,
        [inTime, outTime, workingHours, finalStatus, lateMinutes, remark, adminName, empId, dateStr]
      );
    } else {
      await db.query(
        `INSERT INTO daily_attendance
           (date, emp_id, employee_name, formal_name, first_in, last_out,
            working_hours, final_status, late_minutes, month, year, remark, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())`,
        [dateStr, empId, empName, empName, inTime, outTime,
         workingHours, finalStatus, lateMinutes, month, year, remark, adminName]
      );
    }

    // Also insert attendance_log entries so punches are visible in employee view
    if (inTime) {
      await db.query(
        `INSERT INTO attendance_log
           (log_id, date, emp_id, employee_name, formal_name, action, time, address, marked_by, created_at)
         VALUES ($1,$2,$3,$4,$5,'IN',$6,$7,'Admin-Import',NOW())
         ON CONFLICT DO NOTHING`,
        ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
         dateStr, empId, empName, empName, inTime, location || null]
      ).catch(() => {});
    }
    if (outTime) {
      await db.query(
        `INSERT INTO attendance_log
           (log_id, date, emp_id, employee_name, formal_name, action, time, address, marked_by, created_at)
         VALUES ($1,$2,$3,$4,$5,'OUT',$6,$7,'Admin-Import',NOW())
         ON CONFLICT DO NOTHING`,
        ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
         dateStr, empId, empName, empName, outTime, location || null]
      ).catch(() => {});
    }
  }

  try {
    const cfg = await getSettings();
    const fullDayMins     = parseInt(cfg.FULL_DAY_MINUTES    || '480');
    const halfDayMins     = parseInt(cfg.HALF_DAY_MINUTES    || '240');
    const officeStartMins = toMinutes(cfg.OFFICE_START_TIME  || '10:00:00');
    const lateThreshold   = parseInt(cfg.LATE_THRESHOLD_MINUTES || '0');

    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    const ws = wb.Sheets['Attendance'] || wb.Sheets[wb.SheetNames[0]];
    if (!ws) return res.status(400).json({ success: false, message: 'No sheet found in file' });

    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (rows.length < 2) return res.status(400).json({ success: false, message: 'File has no data rows' });

    const headers = rows[0].map(h => h.toString().toLowerCase().trim());
    const col = {
      date:     headers.findIndex(h => h.includes('date')),
      emp_id:   headers.findIndex(h => (h.includes('emp') && h.includes('id')) || h === 'employee id' || h === 'employeeid'),
      name:     headers.findIndex(h => h === 'name' || h === 'employee name'),
      action:   headers.findIndex(h => h === 'action' || h === 'type' || h === 'punch'),
      in:       headers.findIndex(h => (h.includes('in') || h.includes('login')) && !h.includes('emp') && !h.includes('lati') && !h.includes('name') && !h.includes('out')),
      out:      headers.findIndex(h => h.includes('out') || h.includes('logout')),
      time:     headers.findIndex(h => h === 'time' || h === 'punch time'),
      location: headers.findIndex(h => h.includes('location') || h.includes('address') || h.includes('place')),
      remark:   headers.findIndex(h => h.includes('remark') || h.includes('note')),
    };

    if (col.date < 0 || col.emp_id < 0)
      return res.status(400).json({ success: false, message: `Columns not found. Need "Date" and "Employee ID". Found: ${headers.join(', ')}` });

    const dataRows = rows.slice(1).filter(r => r.some(c => c !== ''));

    // ── Detect format ─────────────────────────────────────────
    // Format A: Raw punch log with Login/Logout in Action column
    // Format B: Summary sheet with IN and OUT columns
    const hasActionCol = col.action >= 0 &&
      dataRows.some(r => /^(login|logout|in|out)$/i.test((r[col.action] || '').toString().trim()));

    if (hasActionCol) {
      // ── FORMAT A: Punch log (Login/Logout rows) ─────────────
      // Group all punches by (dateStr, empId)
      const groups = new Map(); // key = "dateStr|empId"

      for (const row of dataRows) {
        const rawDate = row[col.date];
        const { dateStr, timeStr: dtTime } = parseDateTime(rawDate);
        if (!dateStr) continue;

        const empId = row[col.emp_id]?.toString().trim();
        if (!empId) continue;

        const action = (row[col.action] || '').toString().trim().toLowerCase();
        // Extract time: from datetime column, or from separate time column
        let timeStr = dtTime;
        if (!timeStr && col.time >= 0) timeStr = parseTimeOnly(row[col.time]);

        const loc = col.location >= 0 ? (row[col.location]?.toString().trim() || null) : null;
        const key = `${dateStr}|${empId}`;
        if (!groups.has(key)) groups.set(key, { dateStr, empId, empName: row[col.name]?.toString().trim() || '', logins: [], logouts: [], location: null });
        const g = groups.get(key);
        if (!g.empName && row[col.name]) g.empName = row[col.name].toString().trim();
        if (loc && !g.location) g.location = loc;
        if (timeStr) {
          if (action === 'login' || action === 'in') g.logins.push(timeStr);
          else if (action === 'logout' || action === 'out') g.logouts.push(timeStr);
        } else {
          if (action === 'login' || action === 'in') g.logins.push(null);
          else g.logouts.push(null);
        }
      }

      // Load all employees once
      const empCache = {};
      const allEmps = await db.query(`SELECT emp_id, name, formal_name FROM emplist`);
      allEmps.rows.forEach(e => { empCache[e.emp_id.toLowerCase()] = e; });

      for (const [key, g] of groups) {
        try {
          const emp = empCache[g.empId.toLowerCase()];
          if (!emp) { results.errors.push(`Emp ID "${g.empId}" not found`); results.skipped++; continue; }
          const empName = emp.formal_name || emp.name;

          const inTime  = g.logins[0]  || null;
          const outTime = g.logouts[g.logouts.length - 1] || null;
          const location = g.location || null;

          let workingHours = null;
          let finalStatus  = inTime ? 'Pending' : 'Absent';
          let lateMinutes  = 0;

          if (inTime) lateMinutes = Math.max(0, toMinutes(inTime) - officeStartMins - lateThreshold);
          if (inTime && outTime) {
            const worked = Math.max(0, toMinutes(outTime) - toMinutes(inTime));
            workingHours = `${Math.floor(worked/60)}h ${worked%60}m`;
            finalStatus  = worked >= fullDayMins ? 'Present' : worked >= halfDayMins ? 'Half Day' : 'Short Day';
          } else if (inTime) {
            finalStatus = 'Pending';
          }

          await upsertAttendance(emp.emp_id, empName, g.dateStr, inTime, outTime, lateMinutes, workingHours, finalStatus, null, location, req.admin.name);
          results.imported++;
        } catch (e) {
          results.errors.push(`${key}: ${e.message}`);
          results.skipped++;
        }
      }

    } else {
      // ── FORMAT B: Summary sheet (IN / OUT columns) ──────────
      const empCache = {};
      const allEmps = await db.query(`SELECT emp_id, name, formal_name FROM emplist`);
      allEmps.rows.forEach(e => { empCache[e.emp_id.toLowerCase()] = e; });

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNum = i + 2;
        try {
          const { dateStr } = parseDateTime(row[col.date]);
          if (!dateStr) { results.errors.push(`Row ${rowNum}: Invalid date`); results.skipped++; continue; }

          const empId = row[col.emp_id]?.toString().trim();
          if (!empId) { results.errors.push(`Row ${rowNum}: Emp ID missing`); results.skipped++; continue; }

          const emp = empCache[empId.toLowerCase()];
          if (!emp) { results.errors.push(`Row ${rowNum}: Emp ID "${empId}" not found`); results.skipped++; continue; }
          const empName = emp.formal_name || emp.name;

          const inTime   = col.in       >= 0 ? parseTimeOnly(row[col.in])               : null;
          const outTime  = col.out      >= 0 ? parseTimeOnly(row[col.out])              : null;
          const location = col.location >= 0 ? (row[col.location]?.toString().trim() || null) : null;
          const remark   = col.remark   >= 0 ? (row[col.remark]?.toString().trim()  || null) : null;

          let workingHours = null;
          let finalStatus  = inTime ? 'Pending' : 'Absent';
          let lateMinutes  = 0;

          if (inTime) lateMinutes = Math.max(0, toMinutes(inTime) - officeStartMins - lateThreshold);
          if (inTime && outTime) {
            const worked = Math.max(0, toMinutes(outTime) - toMinutes(inTime));
            workingHours = `${Math.floor(worked/60)}h ${worked%60}m`;
            finalStatus  = worked >= fullDayMins ? 'Present' : worked >= halfDayMins ? 'Half Day' : 'Short Day';
          }

          await upsertAttendance(emp.emp_id, empName, dateStr, inTime, outTime, lateMinutes, workingHours, finalStatus, remark, location, req.admin.name);
          results.imported++;
        } catch (rowErr) {
          results.errors.push(`Row ${rowNum}: ${rowErr.message}`);
          results.skipped++;
        }
      }
    }

    res.json({
      success: true,
      message: `Import complete! ${results.imported} records imported, ${results.skipped} skipped.`,
      results,
      format_detected: hasActionCol ? 'Punch Log (Login/Logout)' : 'Summary (IN/OUT columns)'
    });
  } catch (err) {
    console.error('Attendance import error:', err);
    res.status(500).json({ success: false, message: 'Import failed: ' + err.message });
  }
});

// ── GET /api/admin/settings ──────────────────────────────────
router.get('/settings', adminAuth, async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ success: true, settings: s });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/settings ─────────────────────────────────
router.post('/settings', adminAuth, async (req, res) => {
  const updates = req.body; // { KEY: value, ... }
  try {
    for (const [key, value] of Object.entries(updates)) {
      await db.query(
        `INSERT INTO attendance_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (organization_id, key) DO UPDATE SET value=$2`,
        [key, value]
      );
    }
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
