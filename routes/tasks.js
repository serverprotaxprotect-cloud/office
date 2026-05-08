const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Helper: is this user an admin with full-view rights?
const isAdminView = u => u.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(u.role);

// ── GET /api/tasks/meta ───────────────────────────────────────
router.get('/meta', authMiddleware, async (req, res) => {
  try {
    const [wn, st, pr, emps] = await Promise.all([
      db.query('SELECT name FROM work_names ORDER BY name'),
      db.query('SELECT status FROM task_status_master ORDER BY id'),
      db.query('SELECT priority FROM task_priority_master ORDER BY id'),
      db.query("SELECT emp_id, formal_name, name FROM emplist WHERE status='Active' ORDER BY name"),
    ]);
    res.json({
      success: true,
      work_names: wn.rows.map(r => r.name),
      statuses: st.rows.map(r => r.status),
      priorities: pr.rows.map(r => r.priority),
      employees: emps.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/tasks/dashboard ──────────────────────────────────
router.get('/dashboard', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    if (isAdminView(req.user)) {
      // Admin view: all-employee stats
      const [allActive, overdue, completedToday, empBreakdown, statusBreak] = await Promise.all([
        db.query(`SELECT COUNT(*) FROM tasks WHERE active_flag=true AND status NOT IN ('Completed','Cancelled')`),
        db.query(`SELECT COUNT(*) FROM tasks WHERE active_flag=true AND due_date < CURRENT_DATE AND status NOT IN ('Completed','Cancelled')`),
        db.query(`SELECT COUNT(*) FROM tasks WHERE status='Completed' AND completion_date::date = CURRENT_DATE`),
        db.query(`SELECT assigned_to_name, assigned_to_id, COUNT(*) as cnt FROM tasks WHERE active_flag=true AND status NOT IN ('Completed','Cancelled') GROUP BY assigned_to_id, assigned_to_name ORDER BY cnt DESC LIMIT 15`),
        db.query(`SELECT status, COUNT(*) as cnt FROM tasks WHERE active_flag=true AND status NOT IN ('Cancelled') GROUP BY status ORDER BY cnt DESC`),
      ]);
      return res.json({
        success: true,
        is_admin_view: true,
        all_active: parseInt(allActive.rows[0].count),
        overdue: parseInt(overdue.rows[0].count),
        completed_today: parseInt(completedToday.rows[0].count),
        emp_breakdown: empBreakdown.rows,
        status_breakdown: statusBreak.rows,
      });
    }

    // Employee view
    const [mine, assignedByMe, allActive, overdue] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM tasks WHERE assigned_to_id=$1 AND active_flag=true AND status NOT IN ('Completed','Cancelled')`, [emp_id]),
      db.query(`SELECT COUNT(*) FROM tasks WHERE created_by_id=$1 AND assigned_to_id<>$1 AND active_flag=true AND status NOT IN ('Completed','Cancelled')`, [emp_id]),
      db.query(`SELECT COUNT(*) FROM tasks WHERE active_flag=true AND status NOT IN ('Completed','Cancelled')`),
      db.query(`SELECT COUNT(*) FROM tasks WHERE assigned_to_id=$1 AND active_flag=true AND due_date < CURRENT_DATE AND status NOT IN ('Completed','Cancelled')`, [emp_id]),
    ]);
    const statusBreak = await db.query(
      `SELECT status, COUNT(*) as cnt FROM tasks WHERE assigned_to_id=$1 AND active_flag=true GROUP BY status ORDER BY cnt DESC`,
      [emp_id]
    );
    res.json({
      success: true,
      is_admin_view: false,
      my_active: parseInt(mine.rows[0].count),
      assigned_by_me: parseInt(assignedByMe.rows[0].count),
      all_active: parseInt(allActive.rows[0].count),
      overdue: parseInt(overdue.rows[0].count),
      status_breakdown: statusBreak.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/tasks ────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  const { view = 'my', status, priority, work_name, search, emp_filter, page = 1, limit = 100 } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  const conds = ['t.active_flag = true'];

  if (view === 'my') {
    params.push(emp_id); conds.push(`t.assigned_to_id = $${params.length}`);
    conds.push(`t.self_assigned = false`);
    conds.push(`t.status NOT IN ('Completed','Cancelled')`);
  } else if (view === 'assigned_by_me') {
    params.push(emp_id); conds.push(`t.created_by_id = $${params.length}`);
    params.push(emp_id); conds.push(`t.assigned_to_id <> $${params.length}`);
    conds.push(`t.status NOT IN ('Completed','Cancelled')`);
  } else if (view === 'completed') {
    // Employee's own completed tasks
    conds.push(`t.status IN ('Completed','Cancelled')`);
    params.push(emp_id); conds.push(`(t.assigned_to_id = $${params.length} OR t.created_by_id = $${params.length})`);
  } else if (view === 'all_completed') {
    // Admin: all employees' completed tasks
    conds.push(`t.status IN ('Completed','Cancelled')`);
    if (emp_filter) { params.push(emp_filter); conds.push(`(t.assigned_to_id = $${params.length} OR t.created_by_id = $${params.length})`); }
  } else if (view === 'all') {
    // Admin: all active tasks
    conds.push(`t.status NOT IN ('Completed','Cancelled')`);
    if (emp_filter) { params.push(emp_filter); conds.push(`(t.assigned_to_id = $${params.length} OR t.created_by_id = $${params.length})`); }
  }

  if (status) { params.push(status); conds.push(`t.status = $${params.length}`); }
  if (priority) { params.push(priority); conds.push(`t.priority = $${params.length}`); }
  if (work_name) { params.push(work_name); conds.push(`t.work_name = $${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(t.task_id ILIKE $${n} OR t.legal_name ILIKE $${n} OR t.business_name ILIKE $${n} OR t.work_name ILIKE $${n} OR t.client_id ILIKE $${n} OR t.assigned_to_name ILIKE $${n})`);
  }

  const where = conds.join(' AND ');
  try {
    params.push(parseInt(limit)); params.push(offset);
    const result = await db.query(
      `SELECT t.task_id, t.created_at, t.assigned_to_id, t.assigned_to_name,
              t.created_by_id, t.created_by_name,
              t.client_id, t.legal_name, t.business_name, t.agent_name,
              t.work_name, t.priority, t.status, t.due_date, t.start_date,
              t.internal_remark, t.client_pending_remark, t.next_followup_date,
              t.professional_fees, t.total_amount, t.billing_status,
              t.last_updated_at, t.completion_date, t.drive_link,
              CASE WHEN t.due_date < CURRENT_DATE AND t.status NOT IN ('Completed','Cancelled') THEN true ELSE false END as is_overdue
       FROM tasks t WHERE ${where}
       ORDER BY
         CASE WHEN t.status IN ('Completed','Cancelled') THEN 1 ELSE 0 END,
         t.due_date ASC NULLS LAST, t.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const cntParams = params.slice(0, -2);
    const cnt = await db.query(`SELECT COUNT(*) FROM tasks t WHERE ${where}`, cntParams);
    res.json({ success: true, tasks: result.rows, total: parseInt(cnt.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/tasks/notifications ─────────────────────────────
router.get('/notifications', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    if (isAdminView(req.user)) {
      // Admin: all-employee overdue + due today + attendance reminder
      const [dueTodayRes, overdueRes, assignedRes, absentRes] = await Promise.all([
        db.query(
          `SELECT task_id, work_name, legal_name, business_name, client_id, due_date, status, priority, assigned_to_name, created_by_name
           FROM tasks WHERE due_date::date = CURRENT_DATE AND status NOT IN ('Completed','Cancelled') AND active_flag=true ORDER BY priority DESC`
        ),
        db.query(
          `SELECT task_id, work_name, legal_name, business_name, client_id, due_date, status, priority, assigned_to_name, created_by_name
           FROM tasks WHERE due_date < CURRENT_DATE AND status NOT IN ('Completed','Cancelled') AND active_flag=true ORDER BY due_date ASC LIMIT 50`
        ),
        db.query(
          `SELECT task_id, work_name, legal_name, business_name, client_id, due_date, status, priority, created_by_name, assigned_to_name, created_at
           FROM tasks WHERE created_at >= NOW() - INTERVAL '7 days' AND active_flag=true ORDER BY created_at DESC LIMIT 30`
        ),
        db.query(
          `SELECT e.emp_id, e.formal_name, e.name, e.designation
           FROM emplist e
           WHERE e.status = 'Active'
             AND e.emp_id NOT IN (
               SELECT DISTINCT emp_id FROM attendance_log WHERE date::date = CURRENT_DATE
             )
           ORDER BY e.name`
        ),
      ]);
      return res.json({
        success: true,
        is_admin_view: true,
        due_today: dueTodayRes.rows,
        overdue: overdueRes.rows,
        recently_assigned: assignedRes.rows,
        attendance_not_marked: absentRes.rows,
        total_alerts: dueTodayRes.rows.length + overdueRes.rows.length + absentRes.rows.length,
      });
    }

    // Employee view
    const [dueTodayRes, overdueRes, assignedRes] = await Promise.all([
      db.query(
        `SELECT task_id, work_name, legal_name, business_name, client_id, due_date, status, priority, assigned_to_name, created_by_name
         FROM tasks WHERE assigned_to_id=$1 AND due_date::date=CURRENT_DATE AND status NOT IN ('Completed','Cancelled') AND active_flag=true ORDER BY priority DESC`,
        [emp_id]
      ),
      db.query(
        `SELECT task_id, work_name, legal_name, business_name, client_id, due_date, status, priority, created_by_name
         FROM tasks WHERE assigned_to_id=$1 AND due_date < CURRENT_DATE AND status NOT IN ('Completed','Cancelled') AND active_flag=true ORDER BY due_date ASC LIMIT 20`,
        [emp_id]
      ),
      db.query(
        `SELECT task_id, work_name, legal_name, business_name, client_id, due_date, status, priority, created_by_name, created_at
         FROM tasks WHERE assigned_to_id=$1 AND self_assigned=false AND created_at >= NOW()-INTERVAL '7 days' AND active_flag=true ORDER BY created_at DESC LIMIT 20`,
        [emp_id]
      ),
    ]);
    res.json({
      success: true,
      is_admin_view: false,
      due_today: dueTodayRes.rows,
      overdue: overdueRes.rows,
      recently_assigned: assignedRes.rows,
      attendance_not_marked: [],
      total_alerts: dueTodayRes.rows.length + overdueRes.rows.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/tasks/:id ────────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM tasks WHERE task_id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const hist = await db.query('SELECT * FROM task_history WHERE task_id=$1 ORDER BY updated_at DESC', [req.params.id]);
    res.json({ success: true, task: r.rows[0], history: hist.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/tasks (create) ──────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const {
    client_id, agent_id, agent_name, legal_name, business_name,
    mobile_number, email_id, drive_link,
    work_name, work_description, priority, due_date,
    assigned_to_id, assigned_to_name,
    internal_remark, professional_fees, challan_amount, other_expense, fees_applicable,
  } = req.body;
  if (!work_name) return res.status(400).json({ success: false, message: 'Work name required' });
  const now = new Date();
  const dateKey = now.toISOString().split('T')[0].replace(/-/g, '');
  try {
    const cnt = await db.query(`SELECT COUNT(*) FROM tasks WHERE created_at::date = CURRENT_DATE`);
    const seq = String(parseInt(cnt.rows[0].count) + 1).padStart(3, '0');
    const taskId = `TSKPTP-${dateKey}-${seq}`;
    const isSelf = !assigned_to_id || assigned_to_id === emp_id;
    const toId = assigned_to_id || emp_id;
    const toName = assigned_to_name || formal_name || name;
    const total = (parseFloat(professional_fees) || 0) + (parseFloat(challan_amount) || 0) + (parseFloat(other_expense) || 0);
    await db.query(
      `INSERT INTO tasks (task_id,created_at,created_by_id,created_by_name,assigned_to_id,assigned_to_name,client_id,agent_id,agent_name,legal_name,business_name,mobile_number,email_id,drive_link,work_name,work_description,priority,status,due_date,internal_remark,fees_applicable,challan_amount,professional_fees,other_expense,total_amount,self_assigned,billing_status,active_flag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'Pending',$18,$19,$20,$21,$22,$23,$24,$25,'Not Applicable',true)`,
      [taskId, now, emp_id, formal_name || name, toId, toName, client_id||null, agent_id||null, agent_name||null, legal_name||null, business_name||null, mobile_number||null, email_id||null, drive_link||null, work_name, work_description||null, priority||'Medium', due_date||null, internal_remark||null, fees_applicable||null, parseFloat(challan_amount)||null, parseFloat(professional_fees)||null, parseFloat(other_expense)||null, total||null, isSelf]
    );
    await db.query(
      `INSERT INTO task_history (log_id,task_id,action,new_status,new_assigned_to,new_due_date,updated_by_id,updated_by_name,updated_at,remark)
       VALUES ($1,$2,'Created','Pending',$3,$4,$5,$6,NOW(),$7)`,
      ['LOG_' + uuidv4().replace(/-/g,'').slice(0,10), taskId, toName, due_date||null, emp_id, formal_name||name, internal_remark||null]
    );
    res.json({ success: true, message: 'Task created!', task_id: taskId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/tasks/:id (update) ───────────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const taskId = req.params.id;
  const { status, priority, due_date, assigned_to_id, assigned_to_name, internal_remark, client_pending_remark, completion_remark, next_followup_date, drive_link, professional_fees, challan_amount, other_expense, fees_applicable } = req.body;
  try {
    const existing = await db.query('SELECT * FROM tasks WHERE task_id=$1', [taskId]);
    if (!existing.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const old = existing.rows[0];
    const total = (parseFloat(professional_fees) ?? old.professional_fees ?? 0) + (parseFloat(challan_amount) ?? old.challan_amount ?? 0) + (parseFloat(other_expense) ?? old.other_expense ?? 0);
    const completionDate = status && ['Completed','Cancelled'].includes(status) && !old.completion_date ? new Date().toISOString().split('T')[0] : old.completion_date;
    await db.query(
      `UPDATE tasks SET status=COALESCE($1,status), priority=COALESCE($2,priority), due_date=COALESCE($3::date,due_date), assigned_to_id=COALESCE($4,assigned_to_id), assigned_to_name=COALESCE($5,assigned_to_name), internal_remark=COALESCE($6,internal_remark), client_pending_remark=COALESCE($7,client_pending_remark), completion_remark=COALESCE($8,completion_remark), next_followup_date=COALESCE($9::date,next_followup_date), drive_link=COALESCE($10,drive_link), professional_fees=COALESCE($11,professional_fees), challan_amount=COALESCE($12,challan_amount), other_expense=COALESCE($13,other_expense), total_amount=$14, fees_applicable=COALESCE($15,fees_applicable), completion_date=$16, last_updated_at=NOW(), last_updated_by_id=$17, last_updated_by_name=$18 WHERE task_id=$19`,
      [status||null, priority||null, due_date||null, assigned_to_id||null, assigned_to_name||null, internal_remark||null, client_pending_remark||null, completion_remark||null, next_followup_date||null, drive_link||null, parseFloat(professional_fees)||null, parseFloat(challan_amount)||null, parseFloat(other_expense)||null, total||null, fees_applicable||null, completionDate||null, emp_id, formal_name||name, taskId]
    );
    await db.query(
      `INSERT INTO task_history (log_id,task_id,action,old_status,new_status,old_assigned_to,new_assigned_to,old_due_date,new_due_date,updated_by_id,updated_by_name,updated_at,remark)
       VALUES ($1,$2,'Updated',$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)`,
      ['LOG_' + uuidv4().replace(/-/g,'').slice(0,10), taskId, old.status, status||old.status, old.assigned_to_name, assigned_to_name||old.assigned_to_name, old.due_date, due_date||old.due_date, emp_id, formal_name||name, internal_remark||completion_remark||null]
    );
    res.json({ success: true, message: 'Task updated!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
