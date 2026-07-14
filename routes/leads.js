const express = require('express');
const XLSX = require('xlsx');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { resolveWorkClassification } = require('../services/workClassificationService');

const router = express.Router();

const FEATURE_KEY = 'lead_management';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MANAGER_ROLES = new Set(['Director', 'Owner', 'Proprietor', 'Office Manager', 'HR', 'Manager']);
const ACCOUNTANT_RE = /accountant/i;
const TERMINAL_STATUSES = new Set(['Converted', 'Not Interested', 'Lost', 'Duplicate', 'Closed']);
const STATUSES = ['New', 'Contacted', 'Interested', 'Follow-up Required', 'Proposal Shared', 'Negotiation', 'Converted', 'Not Interested', 'Lost', 'Duplicate', 'Closed'];
const PRIORITIES = ['Hot', 'Warm', 'Cold', 'Normal'];
const FOLLOWUP_TYPES = ['Call', 'WhatsApp', 'Meeting', 'Email', 'Document Pending', 'Proposal Pending'];
const FOLLOWUP_RESULTS = ['Connected', 'Not Reachable', 'Call Back Later', 'Interested', 'Not Interested', 'Converted', 'Pending Decision'];
const DEFAULT_SOURCES = ['Website', 'Referral', 'Walk-in', 'Phone Call', 'WhatsApp', 'Existing Client', 'Other'];

function clean(value) {
  return String(value || '').trim();
}

function actorId(user = {}) {
  return user.emp_id || user.username || String(user.id || '');
}

function actorName(user = {}) {
  return user.formal_name || user.name || user.username || 'User';
}

function isManager(user = {}) {
  const role = user.role || user.designation || '';
  return user.user_type === 'admin' && (MANAGER_ROLES.has(role) || /owner|director|manager|hr/i.test(role));
}

function isAccountant(user = {}) {
  const role = user.role || user.designation || '';
  return ACCOUNTANT_RE.test(role);
}

function canSeeAll(user = {}) {
  return isManager(user) || isAccountant(user);
}

function accessScopeSql(user, alias = 'lr') {
  if (canSeeAll(user)) return { clause: '1=1', params: [] };
  const id = actorId(user);
  return {
    clause: `(${alias}.assigned_to_id=$1 OR ${alias}.created_by_id=$1 OR EXISTS (
      SELECT 1 FROM lead_participants lp
       WHERE lp.lead_id=${alias}.id AND lp.participant_id=$1
    ))`,
    params: [id],
  };
}

async function featureAccess(req) {
  const r = await db.query(
    `SELECT access_level FROM organization_feature_access
      WHERE organization_id=$1 AND feature_key=$2`,
    [req.user.organization_id, FEATURE_KEY]
  );
  const orgAccess = r.rows[0]?.access_level || 'none';
  if (orgAccess === 'none') return { allowed: false, access_level: 'none', can_write: false };
  const roleAllowed = canSeeAll(req.user) || req.user.user_type === 'employee';
  if (!roleAllowed) return { allowed: false, access_level: 'none', can_write: false };
  return {
    allowed: true,
    access_level: orgAccess,
    can_write: orgAccess === 'full' && !isAccountant(req.user),
  };
}

async function requireLeads(req, res, next) {
  try {
    const access = await featureAccess(req);
    if (!access.allowed) return res.status(403).json({ success: false, message: 'Lead Management access is not enabled for this user or organisation' });
    if (WRITE_METHODS.has(req.method) && !access.can_write) return res.status(403).json({ success: false, message: 'Lead Management is view-only for this user or organisation' });
    req.leadAccess = access;
    next();
  } catch (err) {
    console.error('[lead access]', err);
    res.status(500).json({ success: false, message: 'Lead access check failed' });
  }
}

function handleError(res, err) {
  if (err.code === '42P01') return res.status(500).json({ success: false, message: 'Lead Management tables missing. Run Lead migration first.' });
  if (err.code === '23505') return res.status(400).json({ success: false, message: 'Duplicate lead record is not allowed' });
  console.error(err);
  res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
}

async function logLead(conn, req, leadId, action, oldValue, newValue, remarks) {
  await conn.query(
    `INSERT INTO lead_status_history
      (organization_id, lead_id, action, old_value, new_value, remarks, actor_id, actor_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      req.user.organization_id,
      leadId,
      action,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      remarks || null,
      actorId(req.user),
      actorName(req.user),
    ]
  );
}

async function ensureDefaultSources() {
  for (const name of DEFAULT_SOURCES) {
    await db.query(
      `INSERT INTO lead_sources (organization_id, name)
       VALUES (current_organization_id(), $1)
       ON CONFLICT DO NOTHING`,
      [name]
    );
  }
}

async function nextLeadNo(conn, orgId) {
  await conn.query(
    `INSERT INTO lead_settings (organization_id, next_lead_no)
     VALUES ($1,1) ON CONFLICT (organization_id) DO NOTHING`,
    [orgId]
  );
  const r = await conn.query(
    `UPDATE lead_settings
        SET next_lead_no=next_lead_no+1, updated_at=NOW()
      WHERE organization_id=$1
      RETURNING next_lead_no - 1 AS no`,
    [orgId]
  );
  return `LD-${String(r.rows[0].no).padStart(5, '0')}`;
}

async function findEmployee(conn, empId) {
  if (!empId) return null;
  const r = await conn.query(
    `SELECT emp_id, formal_name, name, designation FROM emplist WHERE emp_id=$1 AND status='Active'
     UNION ALL
     SELECT username AS emp_id, name AS formal_name, name, role AS designation FROM admins WHERE username=$1 AND status='Active'
     LIMIT 1`,
    [empId]
  );
  return r.rows[0] || null;
}

async function notify(conn, orgId, recipientId, title, message, link) {
  if (!recipientId) return;
  try {
    await conn.query(
      `INSERT INTO notifications (organization_id, recipient_id, title, message, link, is_read, created_at)
       VALUES ($1,$2,$3,$4,$5,false,NOW())`,
      [orgId, recipientId, title, message, link || '/lead.html']
    );
  } catch (err) {
    console.warn('[lead notification skipped]', err.message);
  }
}

async function visibleLead(conn, req, id, lock = false) {
  const scope = accessScopeSql(req.user, 'lr');
  const params = [id, ...scope.params];
  const scopeClause = scope.clause === '1=1' ? '1=1' : scope.clause.replace(/\$1/g, '$2');
  const r = await conn.query(
    `SELECT lr.* FROM lead_records lr
      WHERE lr.id=$1 AND ${scopeClause}
      ${lock ? 'FOR UPDATE OF lr' : ''}`,
    params
  );
  return r.rows[0] || null;
}

router.use(authMiddleware, requireLeads);

router.get('/me', async (req, res) => {
  res.json({
    success: true,
    user: req.user,
    access: req.leadAccess,
    can_see_all: canSeeAll(req.user),
    is_manager: isManager(req.user),
  });
});

router.get('/meta', async (req, res) => {
  try {
    await ensureDefaultSources();
    const [emps, sources, agents] = await Promise.all([
      db.query(
        `SELECT emp_id, formal_name, name, designation
           FROM (
             SELECT emp_id, formal_name, name, designation FROM emplist WHERE status='Active'
             UNION ALL
             SELECT username AS emp_id, name AS formal_name, name, role AS designation FROM admins WHERE status='Active'
           ) x ORDER BY formal_name NULLS LAST, name`
      ),
      db.query(`SELECT name FROM lead_sources WHERE status='Active' ORDER BY name`),
      db.query(`SELECT agent_id, agent_name FROM agents WHERE status='Active' ORDER BY agent_name`)
    ]);
    res.json({
      success: true,
      statuses: STATUSES,
      priorities: PRIORITIES,
      followup_types: FOLLOWUP_TYPES,
      followup_results: FOLLOWUP_RESULTS,
      employees: emps.rows,
      sources: sources.rows.map(r => r.name),
      agents: agents.rows,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/', async (req, res) => {
  try {
    const params = [];
    const conds = [];
    const scope = accessScopeSql(req.user, 'lr');
    conds.push(scope.clause);
    params.push(...scope.params);
    if (req.query.status) { params.push(req.query.status); conds.push(`lr.status=$${params.length}`); }
    if (req.query.priority) { params.push(req.query.priority); conds.push(`lr.priority=$${params.length}`); }
    if (req.query.assignee) { params.push(req.query.assignee); conds.push(`lr.assigned_to_id=$${params.length}`); }
    if (req.query.source) { params.push(req.query.source); conds.push(`lr.source=$${params.length}`); }
    if (req.query.followup === 'today') conds.push(`lr.next_followup_date=CURRENT_DATE AND lr.status <> ALL($${params.push(Array.from(TERMINAL_STATUSES))}::text[])`);
    if (req.query.followup === 'overdue') conds.push(`lr.next_followup_date<CURRENT_DATE AND lr.status <> ALL($${params.push(Array.from(TERMINAL_STATUSES))}::text[])`);
    if (req.query.search) {
      params.push(`%${clean(req.query.search)}%`);
      const n = params.length;
      conds.push(`(lr.name ILIKE $${n} OR lr.mobile ILIKE $${n} OR lr.whatsapp ILIKE $${n} OR lr.email ILIKE $${n} OR lr.business_name ILIKE $${n} OR lr.service_required ILIKE $${n} OR lr.lead_no ILIKE $${n})`);
    }
    const limit = Math.min(Number(req.query.limit || 200), 500);
    params.push(limit);
    const rows = await db.query(
      `SELECT lr.*
         FROM lead_records lr
        WHERE ${conds.join(' AND ')}
        ORDER BY
          CASE lr.priority WHEN 'Hot' THEN 1 WHEN 'Warm' THEN 2 WHEN 'Normal' THEN 3 ELSE 4 END,
          COALESCE(lr.next_followup_date, CURRENT_DATE + 3650),
          lr.updated_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, leads: rows.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/', async (req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ success: false, message: 'Lead name is required' });
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'New';
  if (!TERMINAL_STATUSES.has(status) && !req.body.next_followup_date) {
    return res.status(400).json({ success: false, message: 'Next follow-up date is required for open leads' });
  }
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const leadNo = await nextLeadNo(conn, req.user.organization_id);
    let assignee = null;
    if (req.body.assigned_to_id) assignee = await findEmployee(conn, req.body.assigned_to_id);
    const assignedId = assignee?.emp_id || req.body.assigned_to_id || actorId(req.user);
    const assignedName = assignee ? (assignee.formal_name || assignee.name) : (req.body.assigned_to_name || actorName(req.user));
    const inserted = await conn.query(
      `INSERT INTO lead_records
        (organization_id, lead_no, name, mobile, whatsapp, email, city, state, pincode, business_name,
         service_required, source, priority, status, assigned_to_id, assigned_to_name, next_followup_date,
         expected_value, remarks, created_by_id, created_by_name, updated_by_id, updated_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$20,$21)
       RETURNING *`,
      [
        req.user.organization_id, leadNo, name, clean(req.body.mobile) || null, clean(req.body.whatsapp) || null,
        clean(req.body.email) || null, clean(req.body.city) || null, clean(req.body.state) || null, clean(req.body.pincode) || null,
        clean(req.body.business_name) || null, clean(req.body.service_required) || null, clean(req.body.source) || 'Other',
        PRIORITIES.includes(req.body.priority) ? req.body.priority : 'Normal', status, assignedId, assignedName,
        req.body.next_followup_date || null, Number(req.body.expected_value || 0), clean(req.body.remarks) || null,
        actorId(req.user), actorName(req.user),
      ]
    );
    await logLead(conn, req, inserted.rows[0].id, 'Lead Created', null, inserted.rows[0], null);
    await notify(conn, req.user.organization_id, assignedId, 'New lead assigned', `${name} has been assigned to you.`, '/lead.html');
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Lead created', lead: inserted.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.get('/reports/summary', async (req, res) => {
  try {
    const scope = accessScopeSql(req.user, 'lr');
    const params = [...scope.params];
    const scopeClause = scope.clause;
    const terminal = Array.from(TERMINAL_STATUSES);
    params.push(terminal);
    const t = params.length;
    const r = await db.query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status='New')::int AS new_leads,
        COUNT(*) FILTER (WHERE priority='Hot' AND status <> ALL($${t}::text[]))::int AS hot_leads,
        COUNT(*) FILTER (WHERE status='Converted' AND converted_at >= date_trunc('month', NOW()))::int AS converted_month,
        COUNT(*) FILTER (WHERE status='Lost')::int AS lost,
        COUNT(*) FILTER (WHERE next_followup_date=CURRENT_DATE AND status <> ALL($${t}::text[]))::int AS today_followups,
        COUNT(*) FILTER (WHERE next_followup_date<CURRENT_DATE AND status <> ALL($${t}::text[]))::int AS overdue_followups
       FROM lead_records lr WHERE ${scopeClause}`,
      params
    );
    const statusRows = await db.query(
      `SELECT status, COUNT(*)::int AS count FROM lead_records lr WHERE ${scopeClause} GROUP BY status ORDER BY status`,
      scope.params
    );
    res.json({ success: true, summary: r.rows[0], by_status: statusRows.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/reports/export', async (req, res) => {
  try {
    const scope = accessScopeSql(req.user, 'lr');
    const rows = await db.query(
      `SELECT lead_no, name, mobile, whatsapp, email, business_name, service_required, source,
              priority, status, assigned_to_name, next_followup_date, expected_value, remarks, created_at
         FROM lead_records lr WHERE ${scope.clause}
        ORDER BY created_at DESC`,
      scope.params
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.rows), 'Leads');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="lead-report.xlsx"');
    res.send(buf);
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    const lead = await visibleLead(conn, req, req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    const [followups, history, participants] = await Promise.all([
      conn.query(`SELECT * FROM lead_followups WHERE lead_id=$1 ORDER BY created_at DESC`, [lead.id]),
      conn.query(`SELECT * FROM lead_status_history WHERE lead_id=$1 ORDER BY created_at DESC`, [lead.id]),
      conn.query(`SELECT * FROM lead_participants WHERE lead_id=$1 ORDER BY participant_name`, [lead.id]),
    ]);
    res.json({ success: true, lead, followups: followups.rows, history: history.rows, participants: participants.rows });
  } catch (err) {
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await visibleLead(conn, req, req.params.id, true);
    if (!old) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
    const status = STATUSES.includes(req.body.status) ? req.body.status : old.status;
    if (!TERMINAL_STATUSES.has(status) && !req.body.next_followup_date && !old.next_followup_date) {
      throw Object.assign(new Error('Next follow-up date is required for open leads'), { statusCode: 400 });
    }
    const updated = await conn.query(
      `UPDATE lead_records SET
        name=$1, mobile=$2, whatsapp=$3, email=$4, city=$5, state=$6, pincode=$7, business_name=$8,
        service_required=$9, source=$10, priority=$11, status=$12, next_followup_date=$13,
        expected_value=$14, remarks=$15, updated_by_id=$16, updated_by_name=$17, updated_at=NOW()
       WHERE id=$18 RETURNING *`,
      [
        clean(req.body.name) || old.name, clean(req.body.mobile) || null, clean(req.body.whatsapp) || null,
        clean(req.body.email) || null, clean(req.body.city) || null, clean(req.body.state) || null,
        clean(req.body.pincode) || null, clean(req.body.business_name) || null, clean(req.body.service_required) || null,
        clean(req.body.source) || null, PRIORITIES.includes(req.body.priority) ? req.body.priority : old.priority,
        status, req.body.next_followup_date || null, Number(req.body.expected_value || 0), clean(req.body.remarks) || null,
        actorId(req.user), actorName(req.user), old.id,
      ]
    );
    await logLead(conn, req, old.id, 'Lead Updated', old, updated.rows[0], req.body.remarks);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Lead updated', lead: updated.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/:id/status', async (req, res) => {
  const status = STATUSES.includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ success: false, message: 'Valid lead status is required' });
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await visibleLead(conn, req, req.params.id, true);
    if (!old) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
    const updated = await conn.query(
      `UPDATE lead_records SET status=$1, next_followup_date=$2, updated_by_id=$3, updated_by_name=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [status, req.body.next_followup_date || old.next_followup_date, actorId(req.user), actorName(req.user), old.id]
    );
    await logLead(conn, req, old.id, 'Status Updated', { status: old.status }, { status }, req.body.remarks);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Lead status updated', lead: updated.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/:id/assign', async (req, res) => {
  const emp = await findEmployee(db, req.body.assigned_to_id);
  if (!emp) return res.status(400).json({ success: false, message: 'Active employee is required' });
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await visibleLead(conn, req, req.params.id, true);
    if (!old) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
    if (!canSeeAll(req.user) && old.created_by_id !== actorId(req.user)) throw Object.assign(new Error('Only managers or lead creator can reassign this lead'), { statusCode: 403 });
    const name = emp.formal_name || emp.name;
    const updated = await conn.query(
      `UPDATE lead_records SET assigned_to_id=$1, assigned_to_name=$2, updated_by_id=$3, updated_by_name=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [emp.emp_id, name, actorId(req.user), actorName(req.user), old.id]
    );
    await logLead(conn, req, old.id, 'Lead Assigned', { assigned_to_id: old.assigned_to_id }, { assigned_to_id: emp.emp_id, assigned_to_name: name }, req.body.remarks);
    await notify(conn, req.user.organization_id, emp.emp_id, 'Lead assigned', `${old.name} has been assigned to you.`, '/lead.html');
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Lead assigned', lead: updated.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.post('/:id/followups', async (req, res) => {
  if (!FOLLOWUP_TYPES.includes(req.body.followup_type)) return res.status(400).json({ success: false, message: 'Valid follow-up type is required' });
  const result = FOLLOWUP_RESULTS.includes(req.body.result) ? req.body.result : 'Pending Decision';
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const lead = await visibleLead(conn, req, req.params.id, true);
    if (!lead) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
    const followup = await conn.query(
      `INSERT INTO lead_followups
        (organization_id, lead_id, followup_date, followup_type, result, summary, next_followup_date, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        req.user.organization_id, lead.id, req.body.followup_date || new Date().toISOString().slice(0, 10),
        req.body.followup_type, result, clean(req.body.summary) || null, req.body.next_followup_date || null,
        actorId(req.user), actorName(req.user),
      ]
    );
    const newStatus = result === 'Converted' ? 'Converted'
      : result === 'Not Interested' ? 'Not Interested'
      : result === 'Interested' ? 'Interested'
      : 'Follow-up Required';
    await conn.query(
      `UPDATE lead_records SET status=$1, next_followup_date=$2, updated_by_id=$3, updated_by_name=$4, updated_at=NOW()
       WHERE id=$5`,
      [newStatus, req.body.next_followup_date || lead.next_followup_date, actorId(req.user), actorName(req.user), lead.id]
    );
    await logLead(conn, req, lead.id, 'Follow-up Added', null, followup.rows[0], req.body.summary);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Follow-up saved', followup: followup.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.get('/:id/timeline', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    const lead = await visibleLead(conn, req, req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    const timeline = await conn.query(
      `SELECT 'history' AS type, action AS title, remarks AS body, actor_name, created_at FROM lead_status_history WHERE lead_id=$1
       UNION ALL
       SELECT 'followup' AS type, followup_type || ' - ' || result AS title, summary AS body, created_by_name AS actor_name, created_at FROM lead_followups WHERE lead_id=$1
       ORDER BY created_at DESC`,
      [lead.id]
    );
    res.json({ success: true, timeline: timeline.rows });
  } catch (err) {
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.post('/:id/convert-client', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const lead = await visibleLead(conn, req, req.params.id, true);
    if (!lead) throw Object.assign(new Error('Lead not found'), { statusCode: 404 });
    if (lead.converted_client_id) throw Object.assign(new Error('Lead is already converted'), { statusCode: 400 });
    const org = await conn.query(`SELECT client_id_prefix, client_id_next FROM organizations WHERE id=$1`, [req.user.organization_id]);
    const prefix = org.rows[0]?.client_id_prefix || 'PTPCL';
    const next = await conn.query(
      `SELECT COALESCE(MAX(substring(client_id from length($1)+1)::int), 0) + 1 AS n
       FROM clients WHERE left(client_id, length($1))=$1 AND substring(client_id from length($1)+1) ~ '^[0-9]+$'`,
      [prefix]
    );
    const clientId = req.body.client_id || `${prefix}${String(next.rows[0].n).padStart(4, '0')}`;
    const agentId = clean(req.body.agent_id) || 'PTPA0001';
    const agent = await conn.query(`SELECT agent_name FROM agents WHERE agent_id=$1 LIMIT 1`, [agentId]);
    const agentName = agent.rows[0]?.agent_name || 'Direct';
    await conn.query(
      `INSERT INTO clients
        (organization_id, client_id, legal_name, business_name, mobile_number, email_id, city, state, address, agent_id, agent_name, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Active',NOW(),NOW())
       ON CONFLICT (organization_id, client_id) DO UPDATE SET
         legal_name=EXCLUDED.legal_name, business_name=EXCLUDED.business_name, mobile_number=EXCLUDED.mobile_number,
         email_id=EXCLUDED.email_id, updated_at=NOW()`,
      [
        req.user.organization_id, clientId, lead.name, lead.business_name || lead.name, lead.mobile || lead.whatsapp,
        lead.email, lead.city, lead.state, null, agentId, agentName,
      ]
    );
    const taskId = `TSK${req.user.organization_code || 'ORG'}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${uuidv4().slice(0,4).toUpperCase()}`;
    const workClass = await resolveWorkClassification(conn, {
      work_name: 'Client Onboarding',
      fallback: { work_category: 'Office Administration & Internal Tasks', grouping_name: 'Office Administration Department', department: 'Internal Office' },
    });
    await conn.query(
      `INSERT INTO tasks
        (task_id, created_at, created_by_id, created_by_name, assigned_to_id, assigned_to_name, client_id, agent_id, agent_name,
         legal_name, business_name, mobile_number, email_id, work_name, work_description, priority, status, due_date, self_assigned, billing_status, active_flag,
         work_name_id, work_category, grouping_name, department, is_custom_work)
       VALUES ($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Client Onboarding',$13,'Medium','Pending',$14,false,'Not Applicable',true,$15,$16,$17,$18,$19)`,
      [
        taskId, actorId(req.user), actorName(req.user), lead.assigned_to_id || actorId(req.user), lead.assigned_to_name || actorName(req.user),
        clientId, agentId, agentName, lead.name, lead.business_name || lead.name, lead.mobile || lead.whatsapp, lead.email,
        `Converted from lead ${lead.lead_no}. Service required: ${lead.service_required || 'Not specified'}`,
        req.body.due_date || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        workClass.work_name_id, workClass.work_category, workClass.grouping_name, workClass.department, workClass.is_custom_work,
      ]
    );
    const updated = await conn.query(
      `UPDATE lead_records SET status='Converted', converted_client_id=$1, converted_at=NOW(), updated_by_id=$2, updated_by_name=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [clientId, actorId(req.user), actorName(req.user), lead.id]
    );
    await logLead(conn, req, lead.id, 'Lead Converted', lead, { client_id: clientId, task_id: taskId }, req.body.remarks);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Lead converted to client', lead: updated.rows[0], client_id: clientId, task_id: taskId });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

module.exports = router;
