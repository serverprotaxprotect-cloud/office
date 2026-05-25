const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { hasPermission, requirePermission } = require('../services/permissions');
const {
  ITR_STATUSES,
  ITR_TYPES,
  cleanText,
  encryptText,
  decryptText,
  normalizePan,
  normalizeStatus,
  isIncomeTaxAdmin,
  currentAssessmentYear,
  dueDateForAssessmentYear,
  financialYearForAssessmentYear,
  assessmentYearToNumber,
  parseIncomeTaxWorkbook,
  summarizeIncomeTaxRows,
  todayIST,
} = require('../utils/incomeTaxUtils');
const {
  findEmployee,
  findClient,
  generateFilingsForYear,
  updateFilingStatus,
  assignFiling,
  assignUnassignedFilingsForClient,
  logIncomeTax,
} = require('../services/incomeTaxService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function handleError(res, err) {
  console.error('[income-tax]', err);
  if (err.code === '42P01') {
    return res.status(500).json({ success: false, message: 'Income Tax tables are not migrated yet' });
  }
  if (err.code === '23505') {
    return res.status(409).json({ success: false, message: 'Duplicate PAN or yearly filing already exists' });
  }
  return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
}

function requireAdmin(req, res) {
  if (hasPermission(req.user, 'income_tax.edit')) return true;
  res.status(403).json({ success: false, message: 'Access denied', required_permission: 'income_tax.edit' });
  return false;
}

function mapIncomeTaxClient(row) {
  return {
    ...row,
    password: decryptText(row.password_enc),
    password_enc: undefined,
  };
}

function ayOptions() {
  const current = assessmentYearToNumber(currentAssessmentYear()) || new Date().getFullYear() + 1;
  const years = [];
  for (let year = current + 1; year >= current - 5; year -= 1) {
    years.push(`${year}-${String((year + 1) % 100).padStart(2, '0')}`);
  }
  return years;
}

function normalizeDueDate(value, assessmentYear) {
  if (!value) return dueDateForAssessmentYear(assessmentYear);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? dueDateForAssessmentYear(assessmentYear) : parsed.toISOString().slice(0, 10);
}

async function loadAssigneeOptions() {
  const result = await db.query(
    `SELECT emp_id, formal_name, name, source, role
     FROM (
       SELECT emp_id, formal_name, name, 'Employee' AS source, designation AS role
       FROM emplist
       WHERE status='Active'
       UNION ALL
       SELECT username AS emp_id, name AS formal_name, name, 'Admin' AS source, role
       FROM admins
       WHERE status='Active'
     ) x
     ORDER BY name`
  );
  return result.rows;
}

router.get('/meta', authMiddleware, requirePermission('income_tax.view'), async (req, res) => {
  try {
    const [emps, latest] = await Promise.all([
      loadAssigneeOptions(),
      db.query(
        `SELECT assessment_year, financial_year
         FROM income_tax_filing_records
         ORDER BY assessment_year DESC
         LIMIT 1`
      ).catch(() => ({ rows: [] })),
    ]);
    const selectedAY = latest.rows[0]?.assessment_year || currentAssessmentYear();
    res.json({
      success: true,
      is_admin: isIncomeTaxAdmin(req.user),
      status_options: ITR_STATUSES,
      itr_types: ITR_TYPES,
      ay_options: ayOptions(),
      employees: emps,
      latest_year: {
        assessment_year: selectedAY,
        financial_year: latest.rows[0]?.financial_year || financialYearForAssessmentYear(selectedAY),
      },
      today_ist: todayIST(),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/clients', authMiddleware, requirePermission('income_tax.view'), async (req, res) => {
  const { search, status = 'Active', assignee_id, unassigned, page = 1, limit = 300 } = req.query;
  const params = [];
  const conds = ['1=1'];
  if (status) {
    params.push(status);
    conds.push(`itc.status=$${params.length}`);
  }
  if (assignee_id) {
    params.push(assignee_id);
    conds.push(`itc.default_assignee_id=$${params.length}`);
  }
  if (unassigned === '1' || unassigned === 'true') conds.push(`COALESCE(itc.default_assignee_id, '')=''`);
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(itc.client_id ILIKE $${n} OR itc.taxpayer_name ILIKE $${n} OR itc.pan_number ILIKE $${n} OR itc.agent_name ILIKE $${n} OR itc.default_assignee_name ILIKE $${n})`);
  }
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  try {
    params.push(parseInt(limit, 10), offset);
    const data = await db.query(
      `SELECT itc.*,
              COALESCE(itc.default_assignee_name, ea.formal_name, ea.name, aa.name) AS default_assignee_name,
              c.legal_name, c.business_name, c.mobile_number AS client_mobile, c.email_id AS client_email
       FROM income_tax_clients itc
       LEFT JOIN clients c ON c.client_id=itc.client_id
       LEFT JOIN emplist ea ON ea.emp_id=itc.default_assignee_id
       LEFT JOIN admins aa ON aa.username=itc.default_assignee_id
       WHERE ${conds.join(' AND ')}
       ORDER BY itc.status, itc.taxpayer_name, itc.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const count = await db.query(`SELECT COUNT(*) FROM income_tax_clients itc WHERE ${conds.join(' AND ')}`, params.slice(0, -2));
    res.json({
      success: true,
      is_admin: isIncomeTaxAdmin(req.user),
      clients: data.rows.map(mapIncomeTaxClient),
      total: parseInt(count.rows[0].count, 10),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/unassigned', authMiddleware, requirePermission('income_tax.view'), async (req, res) => {
  const assessmentYear = cleanText(req.query.assessment_year || currentAssessmentYear());
  const limit = Math.min(Number(req.query.limit || 500), 1000);
  const search = cleanText(req.query.search || '');
  if (!assessmentYear) {
    return res.status(400).json({ success: false, message: 'Assessment year required' });
  }

  const dueDate = dueDateForAssessmentYear(assessmentYear);
  const params = [assessmentYear, dueDate];
  const conds = [
    "itc.status='Active'",
    "(itc.inactive_from IS NULL OR itc.inactive_from::date > $2::date)",
  ];
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(itc.client_id ILIKE $${n} OR itc.taxpayer_name ILIKE $${n} OR itc.pan_number ILIKE $${n} OR itc.agent_name ILIKE $${n})`);
  }

  try {
    params.push(limit);
    const result = await db.query(
      `SELECT itc.*,
              COALESCE(itc.default_assignee_name, ea.formal_name, ea.name, aa.name) AS default_assignee_name,
              c.legal_name AS client_legal_name, c.business_name AS client_business_name,
              c.mobile_number AS client_mobile, c.email_id AS client_email,
              ifr.id AS filing_id, ifr.status AS filing_status, ifr.assigned_to_id,
              ifr.assigned_to_name, ifr.linked_task_id, t.task_id AS active_task_id
       FROM income_tax_clients itc
       LEFT JOIN income_tax_filing_records ifr
         ON ifr.income_tax_client_id=itc.id AND ifr.assessment_year=$1
       LEFT JOIN tasks t ON t.task_id=ifr.linked_task_id AND t.active_flag=true
       LEFT JOIN clients c ON c.client_id=itc.client_id
       LEFT JOIN emplist ea ON ea.emp_id=itc.default_assignee_id
       LEFT JOIN admins aa ON aa.username=itc.default_assignee_id
       WHERE ${conds.join(' AND ')}
         AND (
           ifr.id IS NULL OR (
             ifr.status NOT IN ('Filed','Not Applicable')
             AND (COALESCE(ifr.assigned_to_id,'')='' OR ifr.linked_task_id IS NULL OR t.task_id IS NULL)
           )
         )
       ORDER BY itc.taxpayer_name, itc.id
       LIMIT $${params.length}`,
      params
    );

    const clients = result.rows.map((row) => mapIncomeTaxClient({
      ...row,
      assessment_year: assessmentYear,
      financial_year: financialYearForAssessmentYear(assessmentYear),
      due_date: dueDate,
      needs_filing_task: true,
    }));

    res.json({ success: true, clients, total: clients.length });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/clients', authMiddleware, requirePermission('income_tax.edit'), async (req, res) => {
  const {
    client_id,
    taxpayer_name,
    contact_number,
    pan_number,
    password,
    reference_client_name,
    default_assignee_id,
  } = req.body;

  if (!client_id) return res.status(400).json({ success: false, message: 'Client ID required' });
  if (!taxpayer_name) return res.status(400).json({ success: false, message: 'Name of taxpayer required' });
  if (!pan_number) return res.status(400).json({ success: false, message: 'PAN number required' });

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const client = await findClient(conn, client_id);
    if (!client) {
      const err = new Error('Client ID not found');
      err.statusCode = 404;
      throw err;
    }
    let emp = null;
    if (default_assignee_id) {
      emp = await findEmployee(conn, default_assignee_id);
      if (!emp) {
        const err = new Error('Active assignee employee not found');
        err.statusCode = 400;
        throw err;
      }
    }
    const assigneeName = emp ? (emp.formal_name || emp.name) : null;
    const result = await conn.query(
      `INSERT INTO income_tax_clients
        (client_id, taxpayer_name, contact_number, pan_number, password_enc, reference_client_name,
         agent_id, agent_name, default_assignee_id, default_assignee_name,
         status, created_by_id, created_by_name, updated_by_id, updated_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Active',$11,$12,$11,$12)
       RETURNING *`,
      [
        client_id,
        cleanText(taxpayer_name),
        cleanText(contact_number || client.mobile_number || ''),
        normalizePan(pan_number),
        encryptText(password || ''),
        cleanText(reference_client_name || client.legal_name || client.business_name || ''),
        client.agent_id || null,
        client.agent_name || null,
        emp?.emp_id || null,
        assigneeName,
        req.user.emp_id,
        req.user.formal_name || req.user.name,
      ]
    );
    await logIncomeTax(conn, {
      income_tax_client_id: result.rows[0].id,
      action: 'CreateIncomeTaxClient',
      new_value: result.rows[0],
      actor: req.user,
    });
    await conn.query('COMMIT');
    res.json({ success: true, client: mapIncomeTaxClient(result.rows[0]) });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/clients/:id', authMiddleware, requirePermission('income_tax.edit'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const allowed = ['taxpayer_name', 'contact_number', 'pan_number', 'reference_client_name'];
  const sets = [];
  const params = [];
  try {
    const old = await db.query('SELECT * FROM income_tax_clients WHERE id=$1', [id]);
    if (!old.rows.length) return res.status(404).json({ success: false, message: 'Income Tax client not found' });
    allowed.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        let value = req.body[field];
        if (field === 'pan_number') value = normalizePan(value);
        else value = cleanText(value || '');
        params.push(value || null);
        sets.push(`${field}=$${params.length}`);
      }
    });
    if (Object.prototype.hasOwnProperty.call(req.body, 'password')) {
      params.push(req.body.password ? encryptText(req.body.password) : null);
      sets.push(`password_enc=$${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No changes supplied' });
    params.push(req.user.emp_id, req.user.formal_name || req.user.name, id);
    const result = await db.query(
      `UPDATE income_tax_clients SET ${sets.join(', ')},
        updated_by_id=$${params.length - 2}, updated_by_name=$${params.length - 1}, updated_at=NOW()
       WHERE id=$${params.length} RETURNING *`,
      params
    );
    await logIncomeTax(db, {
      income_tax_client_id: id,
      action: 'UpdateIncomeTaxClient',
      old_value: old.rows[0],
      new_value: req.body,
      actor: req.user,
    });
    res.json({ success: true, client: mapIncomeTaxClient(result.rows[0]) });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/clients/:id/assign', authMiddleware, requirePermission('income_tax.edit'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await conn.query('SELECT * FROM income_tax_clients WHERE id=$1 FOR UPDATE', [id]);
    if (!old.rows.length) {
      const err = new Error('Income Tax client not found');
      err.statusCode = 404;
      throw err;
    }
    const yearAssign = Boolean(req.body.assessment_year);
    const admin = hasPermission(req.user, 'income_tax.edit');
    if (!admin && old.rows[0].default_assignee_id && !yearAssign) {
      const err = new Error('Only admin can change an already assigned Income Tax client');
      err.statusCode = 403;
      throw err;
    }
    const emp = await findEmployee(conn, req.body.default_assignee_id);
    if (!emp) {
      const err = new Error('Active employee not found');
      err.statusCode = 400;
      throw err;
    }
    const name = emp.formal_name || emp.name;
    let result = { rows: [old.rows[0]] };
    const updateDefault = admin || !old.rows[0].default_assignee_id;
    if (updateDefault) {
      result = await conn.query(
        `UPDATE income_tax_clients SET default_assignee_id=$1, default_assignee_name=$2,
          updated_by_id=$3, updated_by_name=$4, updated_at=NOW()
         WHERE id=$5 RETURNING *`,
        [emp.emp_id, name, req.user.emp_id, req.user.formal_name || req.user.name, id]
      );
      await logIncomeTax(conn, {
        income_tax_client_id: id,
        action: 'AssignDefaultAssignee',
        old_value: { default_assignee_id: old.rows[0].default_assignee_id, default_assignee_name: old.rows[0].default_assignee_name },
        new_value: { default_assignee_id: emp.emp_id, default_assignee_name: name },
        remarks: req.body.remark || null,
        actor: req.user,
      });
    }
    const filingSummary = await assignUnassignedFilingsForClient(conn, id, emp, req.user, {
      assessmentYear: req.body.assessment_year,
      remark: req.body.remark || null,
    });
    await conn.query('COMMIT');
    res.json({
      success: true,
      message: updateDefault ? 'Default assignee updated' : 'Filing task assignment updated',
      client: mapIncomeTaxClient(result.rows[0]),
      filing_summary: filingSummary,
    });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/clients/:id/status', authMiddleware, requirePermission('income_tax.edit'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const status = req.body.status === 'Inactive' ? 'Inactive' : 'Active';
  try {
    const old = await db.query('SELECT * FROM income_tax_clients WHERE id=$1', [id]);
    if (!old.rows.length) return res.status(404).json({ success: false, message: 'Income Tax client not found' });
    const result = await db.query(
      `UPDATE income_tax_clients
       SET status=$1, inactive_from=CASE WHEN $1='Inactive' THEN COALESCE($2::date, CURRENT_DATE) ELSE NULL END,
           inactive_reason=CASE WHEN $1='Inactive' THEN NULLIF($3,'') ELSE NULL END,
           updated_by_id=$4, updated_by_name=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [status, req.body.inactive_from || null, req.body.inactive_reason || '', req.user.emp_id, req.user.formal_name || req.user.name, id]
    );
    await logIncomeTax(db, {
      income_tax_client_id: id,
      action: status === 'Inactive' ? 'DeactivateIncomeTaxClient' : 'ActivateIncomeTaxClient',
      old_value: { status: old.rows[0].status, inactive_from: old.rows[0].inactive_from, inactive_reason: old.rows[0].inactive_reason },
      new_value: req.body,
      actor: req.user,
    });
    res.json({ success: true, client: mapIncomeTaxClient(result.rows[0]) });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/filings', authMiddleware, requirePermission('income_tax.view'), async (req, res) => {
  const { assessment_year, financial_year, client_id, income_tax_client_id, itr_type, status, assigned_to_id, unassigned, search, limit = 500 } = req.query;
  const params = [];
  const conds = ['1=1'];
  if (assessment_year) { params.push(assessment_year); conds.push(`ifr.assessment_year=$${params.length}`); }
  if (financial_year) { params.push(financial_year); conds.push(`ifr.financial_year=$${params.length}`); }
  if (client_id) { params.push(client_id); conds.push(`ifr.client_id=$${params.length}`); }
  if (income_tax_client_id) { params.push(Number(income_tax_client_id)); conds.push(`ifr.income_tax_client_id=$${params.length}`); }
  if (itr_type) { params.push(itr_type); conds.push(`ifr.itr_type=$${params.length}`); }
  if (status) { params.push(status); conds.push(`ifr.status=$${params.length}`); }
  if (assigned_to_id) { params.push(assigned_to_id); conds.push(`ifr.assigned_to_id=$${params.length}`); }
  if (unassigned === '1' || unassigned === 'true') conds.push(`COALESCE(ifr.assigned_to_id,'')=''`);
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(ifr.client_id ILIKE $${n} OR ifr.taxpayer_name ILIKE $${n} OR ifr.pan_number ILIKE $${n} OR ifr.assigned_to_name ILIKE $${n})`);
  }
  try {
    params.push(parseInt(limit, 10));
    const result = await db.query(
      `SELECT ifr.*,
              COALESCE(ifr.assigned_to_name, ea.formal_name, ea.name, aa.name) AS assigned_to_name,
              itc.status AS income_tax_client_status, itc.password_enc, itc.contact_number, itc.reference_client_name,
              itc.inactive_from, itc.inactive_reason
       FROM income_tax_filing_records ifr
       JOIN income_tax_clients itc ON itc.id=ifr.income_tax_client_id
       LEFT JOIN emplist ea ON ea.emp_id=ifr.assigned_to_id
       LEFT JOIN admins aa ON aa.username=ifr.assigned_to_id
       WHERE ${conds.join(' AND ')}
       ORDER BY ifr.assessment_year DESC, ifr.taxpayer_name, ifr.id
       LIMIT $${params.length}`,
      params
    );
    const admin = isIncomeTaxAdmin(req.user);
    res.json({
      success: true,
      filings: result.rows.map((row) => ({
        ...row,
        password: decryptText(row.password_enc),
        password_enc: undefined,
        can_edit_status: admin || row.assigned_to_id === req.user.emp_id,
        can_reassign: admin || row.assigned_to_id === req.user.emp_id || !row.assigned_to_id,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/generate', authMiddleware, requirePermission('income_tax.edit'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const assessmentYear = req.body.assessment_year || currentAssessmentYear();
  const dueDate = normalizeDueDate(req.body.due_date, assessmentYear);
  try {
    const summary = await generateFilingsForYear({ assessmentYear, dueDate, actor: req.user, source: 'manual' });
    res.json({ success: true, message: 'Income Tax yearly filing generation completed', summary });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/filings/:id/status', authMiddleware, requirePermission('income_tax.edit'), async (req, res) => {
  try {
    await updateFilingStatus(parseInt(req.params.id, 10), {
      status: req.body.status,
      itr_type: req.body.itr_type,
      due_date: req.body.due_date,
      remark: req.body.remark || null,
    }, req.user);
    res.json({ success: true, message: 'Income Tax filing status updated' });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/filings/:id/assign', authMiddleware, requirePermission('income_tax.edit'), async (req, res) => {
  try {
    const result = await assignFiling(parseInt(req.params.id, 10), req.body.assigned_to_id, req.body.remark || null, req.user);
    res.json({ success: true, message: 'Income Tax filing reassigned', ...result });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/reports/summary', authMiddleware, requirePermission('income_tax.view'), async (req, res) => {
  const { assessment_year, financial_year, client_id, assigned_to_id, itr_type } = req.query;
  const params = [];
  const conds = ['1=1'];
  if (assessment_year) { params.push(assessment_year); conds.push(`assessment_year=$${params.length}`); }
  if (financial_year) { params.push(financial_year); conds.push(`financial_year=$${params.length}`); }
  if (client_id) { params.push(client_id); conds.push(`client_id=$${params.length}`); }
  if (assigned_to_id) { params.push(assigned_to_id); conds.push(`assigned_to_id=$${params.length}`); }
  if (itr_type) { params.push(itr_type); conds.push(`itr_type=$${params.length}`); }
  try {
    const [byStatus, byItr, totals] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count FROM income_tax_filing_records WHERE ${conds.join(' AND ')} GROUP BY status ORDER BY status`, params),
      db.query(`SELECT itr_type, COUNT(*)::int AS count FROM income_tax_filing_records WHERE ${conds.join(' AND ')} GROUP BY itr_type ORDER BY itr_type`, params),
      db.query(`SELECT COUNT(*)::int AS total FROM income_tax_filing_records WHERE ${conds.join(' AND ')}`, params),
    ]);
    res.json({ success: true, by_status: byStatus.rows, by_itr_type: byItr.rows, total: totals.rows[0].total });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/history', authMiddleware, requirePermission('income_tax.view'), async (req, res) => {
  const params = [];
  const conds = ['1=1'];
  if (req.query.client_id) { params.push(Number(req.query.client_id)); conds.push(`income_tax_client_id=$${params.length}`); }
  if (req.query.filing_id) { params.push(Number(req.query.filing_id)); conds.push(`filing_id=$${params.length}`); }
  try {
    params.push(parseInt(req.query.limit || '100', 10));
    const result = await db.query(
      `SELECT * FROM income_tax_history_log WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, history: result.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/import/template', authMiddleware, requirePermission('income_tax.edit'), (req, res) => {
  const headers = [
    'client_id',
    'taxpayer_name',
    'contact_number',
    'pan_number',
    'password',
    'reference_client_name',
    'default_assignee_id',
    'status',
    'inactive_from',
    'inactive_reason',
    'assessment_year',
    'itr_type',
    'filing_status',
    'due_date',
  ];
  const sample = {
    client_id: 'GBCL0001',
    taxpayer_name: 'RAJU KUMAR',
    contact_number: '9876543210',
    pan_number: 'ABCDE1234F',
    password: 'income-tax-password',
    reference_client_name: 'ABC PRIVATE LIMITED',
    default_assignee_id: 'EMP001',
    status: 'Active',
    inactive_from: '',
    inactive_reason: '',
    assessment_year: currentAssessmentYear(),
    itr_type: 'ITR-1',
    filing_status: 'Not Started',
    due_date: dueDateForAssessmentYear(currentAssessmentYear()),
  };
  const sheet = XLSX.utils.json_to_sheet([sample], { header: headers });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Income Tax Clients');
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="income_tax_clients_template.xlsx"');
  res.send(buffer);
});

async function buildImportPreview(parsed) {
  const rows = parsed.rows;
  const summary = summarizeIncomeTaxRows(rows);
  const clientIds = [...new Set(rows.map((r) => cleanText(r.client_id)).filter(Boolean))];
  const assigneeIds = [...new Set(rows.map((r) => cleanText(r.default_assignee_id)).filter(Boolean))];
  const pans = [...new Set(rows.map((r) => normalizePan(r.pan_number)).filter(Boolean))];
  const [clientRes, empRes, existingPanRes] = await Promise.all([
    clientIds.length ? db.query('SELECT client_id, agent_id, agent_name, legal_name, business_name, mobile_number FROM clients WHERE client_id = ANY($1)', [clientIds]) : { rows: [] },
    assigneeIds.length ? db.query(
      `SELECT emp_id, formal_name, name
       FROM (
         SELECT emp_id, formal_name, name FROM emplist WHERE emp_id = ANY($1) AND status='Active'
         UNION ALL
         SELECT username AS emp_id, name AS formal_name, name FROM admins WHERE username = ANY($1) AND status='Active'
       ) x`,
      [assigneeIds]
    ) : { rows: [] },
    pans.length ? db.query('SELECT pan_number FROM income_tax_clients WHERE UPPER(pan_number) = ANY($1)', [pans]) : { rows: [] },
  ]);
  const clients = new Set(clientRes.rows.map((r) => r.client_id));
  const employees = new Set(empRes.rows.map((r) => r.emp_id));
  const existingPans = new Set(existingPanRes.rows.map((r) => normalizePan(r.pan_number)));
  const panSeen = new Map();
  const rowResults = rows.map((row) => {
    const rowNumber = row.__row_number;
    const errors = [];
    const warnings = [];
    const clientId = cleanText(row.client_id);
    const taxpayerName = cleanText(row.taxpayer_name || row.name_of_taxpayer);
    const pan = normalizePan(row.pan_number || row.pan);
    const assignee = cleanText(row.default_assignee_id || row.assignee_id);
    const status = cleanText(row.status || 'Active');
    const filingStatus = row.filing_status ? normalizeStatus(row.filing_status) : '';
    const itrType = cleanText(row.itr_type);
    if (!clientId) errors.push('client_id required');
    if (!taxpayerName) errors.push('taxpayer_name required');
    if (!pan) errors.push('pan_number required');
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) errors.push('Invalid PAN format');
    if (clientId && !clients.has(clientId)) errors.push('Client ID not found');
    if (assignee && !employees.has(assignee)) errors.push('Assignee employee not found or inactive');
    if (status && !['Active', 'Inactive'].includes(status)) errors.push('status must be Active or Inactive');
    if (filingStatus && !ITR_STATUSES.includes(filingStatus)) errors.push('Invalid filing_status');
    if (itrType && !ITR_TYPES.includes(itrType)) errors.push('Invalid itr_type');
    if (pan) {
      if (panSeen.has(pan)) errors.push(`Duplicate PAN in file at row ${panSeen.get(pan)}`);
      else panSeen.set(pan, rowNumber);
      if (existingPans.has(pan)) warnings.push('PAN already exists; import will update this client');
    }
    return { row_number: rowNumber, client_id: clientId, taxpayer_name: taxpayerName, pan_number: pan, errors, warnings };
  });
  const errorRows = rowResults.filter((r) => r.errors.length);
  return {
    sheet: parsed.sheetName,
    summary,
    rows: rowResults,
    valid_rows: rowResults.length - errorRows.length,
    error_rows: errorRows.length,
    duplicate_existing_pan: rowResults.filter((r) => r.warnings.some((w) => w.includes('already exists'))).length,
    can_import: errorRows.length === 0,
  };
}

router.post('/import/preview', authMiddleware, requirePermission('income_tax.edit'), upload.single('file'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
    const parsed = parseIncomeTaxWorkbook(req.file.buffer);
    const preview = await buildImportPreview(parsed);
    res.json({ success: true, preview });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/import', authMiddleware, requirePermission('income_tax.edit'), upload.single('file'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const duplicatePolicy = req.body.duplicate_policy || 'update_existing';
  const conn = await db.pool.connect();
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
    const parsed = parseIncomeTaxWorkbook(req.file.buffer);
    const preview = await buildImportPreview(parsed);
    if (!preview.can_import) {
      return res.status(400).json({ success: false, message: 'Please fix import errors first', preview });
    }
    await conn.query('BEGIN');
    const summary = { inserted: 0, updated: 0, skipped: 0, filings_upserted: 0 };
    for (const row of parsed.rows) {
      const clientId = cleanText(row.client_id);
      const taxpayerName = cleanText(row.taxpayer_name || row.name_of_taxpayer);
      const pan = normalizePan(row.pan_number || row.pan);
      const baseClient = await findClient(conn, clientId);
      const assigneeId = cleanText(row.default_assignee_id || row.assignee_id);
      let assignee = null;
      if (assigneeId) assignee = await findEmployee(conn, assigneeId);
      const existing = await conn.query('SELECT * FROM income_tax_clients WHERE UPPER(pan_number)=UPPER($1) LIMIT 1', [pan]);
      let incomeTaxClient;
      if (existing.rows.length) {
        if (duplicatePolicy === 'create_only') {
          const err = new Error(`Duplicate PAN at row ${row.__row_number}`);
          err.statusCode = 409;
          throw err;
        }
        if (duplicatePolicy === 'skip_duplicates') {
          summary.skipped += 1;
          incomeTaxClient = existing.rows[0];
        } else {
          const updated = await conn.query(
            `UPDATE income_tax_clients SET client_id=$1, taxpayer_name=$2, contact_number=$3, password_enc=COALESCE($4,password_enc),
               reference_client_name=$5, agent_id=$6, agent_name=$7, default_assignee_id=$8, default_assignee_name=$9,
               status=$10, inactive_from=$11, inactive_reason=$12, source='excel_import',
               source_sheet=$13, source_row=$14, updated_by_id=$15, updated_by_name=$16, updated_at=NOW()
             WHERE id=$17 RETURNING *`,
            [
              clientId,
              taxpayerName,
              cleanText(row.contact_number || baseClient.mobile_number || ''),
              row.password ? encryptText(row.password) : null,
              cleanText(row.reference_client_name || baseClient.legal_name || baseClient.business_name || ''),
              baseClient.agent_id || null,
              baseClient.agent_name || null,
              assignee?.emp_id || existing.rows[0].default_assignee_id || null,
              assignee ? (assignee.formal_name || assignee.name) : existing.rows[0].default_assignee_name,
              cleanText(row.status || existing.rows[0].status || 'Active'),
              row.inactive_from || null,
              cleanText(row.inactive_reason || ''),
              parsed.sheetName,
              row.__row_number,
              req.user.emp_id,
              req.user.formal_name || req.user.name,
              existing.rows[0].id,
            ]
          );
          incomeTaxClient = updated.rows[0];
          summary.updated += 1;
        }
      } else {
        const inserted = await conn.query(
          `INSERT INTO income_tax_clients
            (client_id, taxpayer_name, contact_number, pan_number, password_enc, reference_client_name,
             agent_id, agent_name, default_assignee_id, default_assignee_name, status, inactive_from, inactive_reason,
             source, source_sheet, source_row, created_by_id, created_by_name, updated_by_id, updated_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'excel_import',$14,$15,$16,$17,$16,$17)
           RETURNING *`,
          [
            clientId,
            taxpayerName,
            cleanText(row.contact_number || baseClient.mobile_number || ''),
            pan,
            encryptText(row.password || ''),
            cleanText(row.reference_client_name || baseClient.legal_name || baseClient.business_name || ''),
            baseClient.agent_id || null,
            baseClient.agent_name || null,
            assignee?.emp_id || null,
            assignee ? (assignee.formal_name || assignee.name) : null,
            cleanText(row.status || 'Active'),
            row.inactive_from || null,
            cleanText(row.inactive_reason || ''),
            parsed.sheetName,
            row.__row_number,
            req.user.emp_id,
            req.user.formal_name || req.user.name,
          ]
        );
        incomeTaxClient = inserted.rows[0];
        summary.inserted += 1;
      }

      const assessmentYear = cleanText(row.assessment_year || '');
      if (assessmentYear) {
        const fy = financialYearForAssessmentYear(assessmentYear);
        const filingStatus = row.filing_status ? normalizeStatus(row.filing_status) : 'Not Started';
        const dueDate = normalizeDueDate(row.due_date, assessmentYear);
        await conn.query(
          `INSERT INTO income_tax_filing_records
            (income_tax_client_id, client_id, taxpayer_name, pan_number, financial_year, assessment_year,
             due_date, itr_type, assigned_to_id, assigned_to_name, status, source, source_sheet, source_row,
             updated_by_id, updated_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'excel_import',$12,$13,$14,$15)
           ON CONFLICT (organization_id, income_tax_client_id, assessment_year)
           DO UPDATE SET taxpayer_name=EXCLUDED.taxpayer_name, pan_number=EXCLUDED.pan_number,
             due_date=EXCLUDED.due_date, itr_type=EXCLUDED.itr_type, assigned_to_id=EXCLUDED.assigned_to_id,
             assigned_to_name=EXCLUDED.assigned_to_name, status=EXCLUDED.status,
             source='excel_import', source_sheet=EXCLUDED.source_sheet, source_row=EXCLUDED.source_row,
             updated_by_id=EXCLUDED.updated_by_id, updated_by_name=EXCLUDED.updated_by_name, updated_at=NOW()`,
          [
            incomeTaxClient.id,
            incomeTaxClient.client_id,
            incomeTaxClient.taxpayer_name,
            incomeTaxClient.pan_number,
            fy,
            assessmentYear,
            dueDate,
            ITR_TYPES.includes(cleanText(row.itr_type)) ? cleanText(row.itr_type) : null,
            incomeTaxClient.default_assignee_id,
            incomeTaxClient.default_assignee_name,
            filingStatus,
            parsed.sheetName,
            row.__row_number,
            req.user.emp_id,
            req.user.formal_name || req.user.name,
          ]
        );
        summary.filings_upserted += 1;
      }
    }
    await logIncomeTax(conn, {
      action: 'ImportIncomeTaxClients',
      new_value: summary,
      remarks: `Rows imported from ${parsed.sheetName}`,
      actor: req.user,
    });
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Income Tax client import completed', preview, imported: summary });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

module.exports = router;
