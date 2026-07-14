const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const {
  TRADEMARK_STAGES,
  TRADEMARK_STATUSES,
  MARK_TYPES,
  cleanText,
  actorId,
  actorName,
  ensureTrademarkSchema,
  logTrademark,
  findEmployee,
  findClient,
  createTaskForApplication,
  syncTaskForApplication,
} = require('../services/trademarkService');

const router = express.Router();

function handleError(res, err) {
  console.error('[trademarks]', err);
  if (err.code === '23505') return res.status(409).json({ success: false, message: 'Duplicate trademark application number already exists' });
  return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
}

function parseClasses(input) {
  if (Array.isArray(input)) {
    return input.map((row) => ({
      class_no: cleanText(row.class_no || row.class || row.classNo),
      goods_services: cleanText(row.goods_services || row.description || row.goodsServices),
    })).filter((row) => row.class_no);
  }
  const text = cleanText(input);
  if (!text) return [];
  return text.split(',').map((item) => ({ class_no: cleanText(item), goods_services: '' })).filter((row) => row.class_no);
}

async function getApplication(conn, id, lock = false) {
  const r = await conn.query(`SELECT * FROM trademark_applications WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  return r.rows[0] || null;
}

async function replaceClasses(conn, applicationId, classes) {
  await conn.query(`DELETE FROM trademark_application_classes WHERE application_id=$1`, [applicationId]);
  for (const cls of classes) {
    await conn.query(
      `INSERT INTO trademark_application_classes (application_id, class_no, goods_services) VALUES ($1,$2,$3)`,
      [applicationId, cls.class_no, cls.goods_services || null]
    );
  }
}

function applicationSelectSql() {
  return `
    SELECT a.*,
           c.legal_name AS client_legal_name,
           c.business_name AS client_business_name,
           c.mobile_number AS client_mobile,
           COALESCE(
             string_agg(DISTINCT NULLIF(tc.class_no,''), ', '),
             ''
           ) AS classes_text,
           COALESCE(
             json_agg(DISTINCT jsonb_build_object('class_no', tc.class_no, 'goods_services', tc.goods_services))
               FILTER (WHERE tc.id IS NOT NULL),
             '[]'
           ) AS classes_json
      FROM trademark_applications a
      LEFT JOIN clients c ON c.client_id=a.client_id
      LEFT JOIN trademark_application_classes tc ON tc.application_id=a.id
  `;
}

router.use(authMiddleware);

router.get('/meta', async (req, res) => {
  try {
    await ensureTrademarkSchema();
    const employees = await db.query(
      `SELECT emp_id, formal_name, name, designation, photo
         FROM (
           SELECT emp_id, formal_name, name, designation, photo FROM emplist WHERE status='Active'
           UNION ALL
           SELECT username AS emp_id, name AS formal_name, name, role AS designation, NULL::text AS photo FROM admins WHERE status='Active'
         ) x
        ORDER BY formal_name, name, emp_id`
    );
    const templates = await db.query(`SELECT * FROM trademark_task_templates WHERE enabled=true ORDER BY template_name`);
    res.json({
      success: true,
      employees: employees.rows,
      stages: TRADEMARK_STAGES,
      status_options: TRADEMARK_STATUSES,
      mark_types: MARK_TYPES,
      templates: templates.rows,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/applications', async (req, res) => {
  try {
    await ensureTrademarkSchema();
    const params = [];
    const where = [];
    const status = cleanText(req.query.status || 'Active');
    const search = cleanText(req.query.search || '');
    const stage = cleanText(req.query.stage || '');
    const currentStatus = cleanText(req.query.current_status || req.query.currentStatus || '');
    const assignee = cleanText(req.query.assignee || '');
    const clientId = cleanText(req.query.client_id || '');
    const limit = Math.min(Number(req.query.limit || 500), 1000);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    if (status !== 'All') {
      if (status === 'Closed') where.push(`a.status IN ('Inactive','Closed')`);
      else {
        params.push(status);
        where.push(`a.status=$${params.length}`);
      }
    }
    if (stage) {
      params.push(stage);
      where.push(`a.current_stage=$${params.length}`);
    }
    if (currentStatus) {
      params.push(currentStatus);
      where.push(`a.current_status=$${params.length}`);
    }
    if (assignee) {
      params.push(assignee);
      where.push(`a.assigned_to_id=$${params.length}`);
    }
    if (clientId) {
      params.push(clientId);
      where.push(`a.client_id=$${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(a.client_id) LIKE $${params.length} OR LOWER(a.trademark_name) LIKE $${params.length} OR LOWER(COALESCE(a.applicant_name,'')) LIKE $${params.length} OR LOWER(COALESCE(a.application_number,'')) LIKE $${params.length} OR LOWER(COALESCE(a.assigned_to_name,'')) LIKE $${params.length})`);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const rows = await db.query(
      `${applicationSelectSql()}
       ${sqlWhere}
       GROUP BY a.id, c.legal_name, c.business_name, c.mobile_number
       ORDER BY a.status, COALESCE(a.due_date, a.created_at::date), a.trademark_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const count = await db.query(`SELECT COUNT(*)::int AS total FROM trademark_applications a ${sqlWhere}`, params.slice(0, -2));
    res.json({ success: true, applications: rows.rows, total: count.rows[0]?.total || 0 });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/applications', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await ensureTrademarkSchema(conn);
    const clientId = cleanText(req.body.client_id);
    const client = await findClient(conn, clientId);
    if (!client) {
      const err = new Error('Client not found');
      err.statusCode = 404;
      throw err;
    }
    const trademarkName = cleanText(req.body.trademark_name);
    if (!trademarkName) {
      const err = new Error('Trademark name is required');
      err.statusCode = 400;
      throw err;
    }
    let assignee = null;
    if (req.body.assigned_to_id) assignee = await findEmployee(conn, cleanText(req.body.assigned_to_id));
    const inserted = await conn.query(
      `INSERT INTO trademark_applications
        (client_id, agent_id, agent_name, trademark_name, applicant_name, application_number, mark_type,
         filing_date, current_stage, current_status, due_date, assigned_to_id, assigned_to_name, remarks,
         created_by_id, created_by_name, updated_by_id, updated_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$15,$16)
       RETURNING *`,
      [
        clientId,
        client.agent_id || null,
        client.agent_name || null,
        trademarkName,
        cleanText(req.body.applicant_name) || client.business_name || client.legal_name || trademarkName,
        cleanText(req.body.application_number) || null,
        cleanText(req.body.mark_type) || 'Word Mark',
        req.body.filing_date || null,
        cleanText(req.body.current_stage) || 'Draft / Data Collection',
        cleanText(req.body.current_status) || 'Draft',
        req.body.due_date || null,
        assignee?.emp_id || null,
        assignee ? (assignee.formal_name || assignee.name || assignee.emp_id) : null,
        cleanText(req.body.remarks) || null,
        actorId(req.user),
        actorName(req.user),
      ]
    );
    const app = inserted.rows[0];
    await replaceClasses(conn, app.id, parseClasses(req.body.classes));
    if (app.assigned_to_id && req.body.create_task !== false) await createTaskForApplication(conn, app, req.user);
    await logTrademark(conn, { application_id: app.id, action: 'created', new_value: app, actor: req.user });
    await conn.query('COMMIT');
    res.json({ success: true, application: app });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/applications/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await ensureTrademarkSchema(conn);
    const old = await getApplication(conn, req.params.id, true);
    if (!old) {
      const err = new Error('Trademark application not found');
      err.statusCode = 404;
      throw err;
    }
    let assignee = null;
    if (req.body.assigned_to_id) assignee = await findEmployee(conn, cleanText(req.body.assigned_to_id));
    const updated = await conn.query(
      `UPDATE trademark_applications SET
         trademark_name=COALESCE(NULLIF($1,''),trademark_name),
         applicant_name=COALESCE(NULLIF($2,''),applicant_name),
         application_number=NULLIF($3,''),
         mark_type=COALESCE(NULLIF($4,''),mark_type),
         filing_date=COALESCE($5::date,filing_date),
         current_stage=COALESCE(NULLIF($6,''),current_stage),
         current_status=COALESCE(NULLIF($7,''),current_status),
         due_date=COALESCE($8::date,due_date),
         assigned_to_id=$9,
         assigned_to_name=$10,
         remarks=COALESCE($11,remarks),
         status=COALESCE(NULLIF($12,''),status),
         updated_by_id=$13,
         updated_by_name=$14,
         updated_at=NOW()
       WHERE id=$15
       RETURNING *`,
      [
        cleanText(req.body.trademark_name),
        cleanText(req.body.applicant_name),
        cleanText(req.body.application_number),
        cleanText(req.body.mark_type),
        req.body.filing_date || null,
        cleanText(req.body.current_stage),
        cleanText(req.body.current_status),
        req.body.due_date || null,
        assignee?.emp_id || old.assigned_to_id || null,
        assignee ? (assignee.formal_name || assignee.name || assignee.emp_id) : old.assigned_to_name || null,
        req.body.remarks === undefined ? null : cleanText(req.body.remarks),
        cleanText(req.body.status),
        actorId(req.user),
        actorName(req.user),
        old.id,
      ]
    );
    const app = updated.rows[0];
    if (req.body.classes !== undefined) await replaceClasses(conn, app.id, parseClasses(req.body.classes));
    if (app.assigned_to_id && !app.linked_task_id && req.body.create_task) await createTaskForApplication(conn, app, req.user);
    else await syncTaskForApplication(conn, app, req.user);
    await logTrademark(conn, { application_id: app.id, action: 'updated', old_value: old, new_value: app, remarks: cleanText(req.body.update_reason), actor: req.user });
    await conn.query('COMMIT');
    res.json({ success: true, application: app });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/applications/:id/assign', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await ensureTrademarkSchema(conn);
    const old = await getApplication(conn, req.params.id, true);
    if (!old) {
      const err = new Error('Trademark application not found');
      err.statusCode = 404;
      throw err;
    }
    const assignee = await findEmployee(conn, cleanText(req.body.assigned_to_id));
    if (!assignee) {
      const err = new Error('Assignee not found');
      err.statusCode = 404;
      throw err;
    }
    const assigneeName = assignee.formal_name || assignee.name || assignee.emp_id;
    const updated = await conn.query(
      `UPDATE trademark_applications
          SET assigned_to_id=$1,
              assigned_to_name=$2,
              current_status=CASE WHEN current_status='Draft' THEN 'Pending' ELSE current_status END,
              updated_by_id=$3,
              updated_by_name=$4,
              updated_at=NOW()
        WHERE id=$5
        RETURNING *`,
      [assignee.emp_id, assigneeName, actorId(req.user), actorName(req.user), old.id]
    );
    const app = updated.rows[0];
    if (!app.linked_task_id) await createTaskForApplication(conn, app, req.user);
    else await syncTaskForApplication(conn, app, req.user);
    await logTrademark(conn, { application_id: app.id, action: 'assigned', old_value: old, new_value: { assigned_to_id: assignee.emp_id, assigned_to_name: assigneeName }, remarks: cleanText(req.body.remarks), actor: req.user });
    await conn.query('COMMIT');
    res.json({ success: true, application: app });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/applications/:id/status', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await ensureTrademarkSchema(conn);
    const old = await getApplication(conn, req.params.id, true);
    if (!old) {
      const err = new Error('Trademark application not found');
      err.statusCode = 404;
      throw err;
    }
    const updated = await conn.query(
      `UPDATE trademark_applications SET
         current_stage=COALESCE(NULLIF($1,''),current_stage),
         current_status=COALESCE(NULLIF($2,''),current_status),
         application_number=COALESCE(NULLIF($3,''),application_number),
         due_date=COALESCE($4::date,due_date),
         filing_date=COALESCE($5::date,filing_date),
         remarks=COALESCE($6,remarks),
         status=CASE WHEN COALESCE(NULLIF($2,''),current_status) IN ('Registered','Renewed','Refused','Abandoned','Withdrawn','Closed') THEN 'Closed' ELSE status END,
         inactive_from=CASE WHEN COALESCE(NULLIF($2,''),current_status) IN ('Registered','Renewed','Refused','Abandoned','Withdrawn','Closed') THEN COALESCE(inactive_from,CURRENT_DATE) ELSE inactive_from END,
         updated_by_id=$7,
         updated_by_name=$8,
         updated_at=NOW()
       WHERE id=$9
       RETURNING *`,
      [
        cleanText(req.body.current_stage),
        cleanText(req.body.current_status),
        cleanText(req.body.application_number),
        req.body.due_date || null,
        req.body.filing_date || null,
        req.body.remarks === undefined ? null : cleanText(req.body.remarks),
        actorId(req.user),
        actorName(req.user),
        old.id,
      ]
    );
    const app = updated.rows[0];
    await syncTaskForApplication(conn, app, req.user);
    await logTrademark(conn, { application_id: app.id, action: 'status_updated', old_value: old, new_value: app, remarks: cleanText(req.body.remarks), actor: req.user });
    await conn.query('COMMIT');
    res.json({ success: true, application: app });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.post('/applications/:id/create-task', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await ensureTrademarkSchema(conn);
    const app = await getApplication(conn, req.params.id, true);
    if (!app) {
      const err = new Error('Trademark application not found');
      err.statusCode = 404;
      throw err;
    }
    if (!app.assigned_to_id) {
      const err = new Error('Assign the trademark application before creating a task');
      err.statusCode = 400;
      throw err;
    }
    if (app.linked_task_id) {
      await conn.query('COMMIT');
      return res.json({ success: true, task_id: app.linked_task_id, existing: true });
    }
    const taskId = await createTaskForApplication(conn, app, req.user);
    await conn.query('COMMIT');
    res.json({ success: true, task_id: taskId });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.get('/clients/:client_id/applications', async (req, res) => {
  try {
    await ensureTrademarkSchema();
    const rows = await db.query(
      `${applicationSelectSql()}
       WHERE a.client_id=$1
       GROUP BY a.id, c.legal_name, c.business_name, c.mobile_number
       ORDER BY a.status, COALESCE(a.due_date, a.created_at::date), a.trademark_name`,
      [req.params.client_id]
    );
    res.json({ success: true, applications: rows.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/reports/summary', async (req, res) => {
  try {
    await ensureTrademarkSchema();
    const summary = await db.query(
      `SELECT current_stage, current_status, COUNT(*)::int AS count
         FROM trademark_applications
        GROUP BY current_stage, current_status
        ORDER BY current_stage, current_status`
    );
    const cards = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE current_stage='Application Filed')::int AS filed,
         COUNT(*) FILTER (WHERE current_stage IN ('Marked for Examination','Examination Report Issued'))::int AS examination_pending,
         COUNT(*) FILTER (WHERE current_status='Reply Due' OR current_stage='Examination Report Issued')::int AS reply_due,
         COUNT(*) FILTER (WHERE current_status='Hearing Due' OR current_stage='Hearing Scheduled')::int AS hearing_due,
         COUNT(*) FILTER (WHERE current_stage='Opposed' OR current_status='Opposed')::int AS opposed,
         COUNT(*) FILTER (WHERE current_status='Registered')::int AS registered,
         COUNT(*) FILTER (WHERE current_stage='Renewal Due' OR current_status='Renewal Due')::int AS renewal_due
       FROM trademark_applications
       WHERE status='Active'`
    );
    res.json({ success: true, cards: cards.rows[0] || {}, summary: summary.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/reports/export', async (req, res) => {
  try {
    await ensureTrademarkSchema();
    const rows = await db.query(
      `${applicationSelectSql()}
       GROUP BY a.id, c.legal_name, c.business_name, c.mobile_number
       ORDER BY a.trademark_name`
    );
    const exportRows = rows.rows.map((r) => ({
      Client: r.client_business_name || r.client_legal_name || r.client_id,
      'Client ID': r.client_id,
      'Trademark Name': r.trademark_name,
      Applicant: r.applicant_name || '',
      'Application No': r.application_number || '',
      Class: r.classes_text || '',
      'Filing Date': r.filing_date ? String(r.filing_date).slice(0, 10) : '',
      Stage: r.current_stage,
      Status: r.current_status,
      Assignee: r.assigned_to_name || '',
      'Due Date': r.due_date ? String(r.due_date).slice(0, 10) : '',
      Remarks: r.remarks || '',
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), 'Trademark Report');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="trademark_report.xlsx"');
    res.send(buffer);
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
