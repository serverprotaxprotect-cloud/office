const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const { createNotif } = require('./notifications');
const { syncGSTForTaskStatus } = require('../services/gstService');
const { syncIncomeTaxForTaskStatus } = require('../services/incomeTaxService');
const { syncComplianceForTaskStatus } = require('../services/complianceService');
const { syncPFESICForTaskStatus } = require('../services/pfEsicService');
const {
  meaningfulTaskChange,
  recordWorkActivity,
  evaluateEmployee,
} = require('../services/performanceService');

// ── IST helper (Asia/Kolkata = UTC+5:30) ─────────────────────
function nowIST()   { return new Date(Date.now() + (5.5 * 60 * 60 * 1000)); }
function todayIST() { return nowIST().toISOString().split('T')[0]; }
function optionalAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

// Helper: is this user an admin with full-view rights?
const isAdminView = u => u.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(u.role);
const orgTaskPrefix = u => String(u.organization_code || 'ORG').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8) || 'ORG';

// ── GET /api/tasks/meta ───────────────────────────────────────
router.get('/meta', authMiddleware, async (req, res) => {
  try {
    const [wn, st, pr, emps] = await Promise.all([
      db.query(
        `SELECT id, name, work_category, grouping_name, department, sac_code, sac_description
           FROM work_names
          ORDER BY name, work_category NULLS LAST, department NULLS LAST`
      ),
      db.query('SELECT status FROM task_status_master ORDER BY id'),
      db.query('SELECT priority FROM task_priority_master ORDER BY id'),
      db.query("SELECT emp_id, formal_name, name, designation, photo FROM emplist WHERE status='Active' ORDER BY name"),
    ]);
    res.json({
      success: true,
      work_names: wn.rows,
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
        db.query(
          `SELECT t.assigned_to_name, t.assigned_to_id,
                  COALESCE(e.designation, a.role, '--') AS designation,
                  COUNT(*) as cnt
             FROM tasks t
             LEFT JOIN emplist e ON e.emp_id=t.assigned_to_id
             LEFT JOIN admins a ON a.username=t.assigned_to_id
            WHERE t.active_flag=true AND t.status NOT IN ('Completed','Cancelled')
            GROUP BY t.assigned_to_id, t.assigned_to_name, e.designation, a.role
            ORDER BY cnt DESC
            LIMIT 15`
        ),
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
  const { view = 'my', status, priority, work_name, search, emp_filter, date_from, date_to, sort_order, page = 1, limit = 100 } = req.query;

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  const conds = ['t.active_flag = true'];

  if (view === 'my') {
    params.push(emp_id); conds.push(`t.assigned_to_id = $${params.length}`);
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
    if (!status) conds.push(`t.status NOT IN ('Completed','Cancelled')`);
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

  const dateColumn = ['completed', 'all_completed'].includes(view) ? 't.completion_date::date' : 't.due_date::date';
  if (date_from) { params.push(date_from); conds.push(`${dateColumn} >= $${params.length}::date`); }
  if (date_to) { params.push(date_to); conds.push(`${dateColumn} <= $${params.length}::date`); }

  let orderBy = `CASE WHEN t.status IN ('Completed','Cancelled') THEN 1 ELSE 0 END,
         t.due_date ASC NULLS LAST, t.created_at DESC`;
  if (sort_order === 'oldest' || sort_order === 'newest') {
    const dir = sort_order === 'oldest' ? 'ASC' : 'DESC';
    orderBy = `${dateColumn} ${dir} NULLS LAST, t.created_at ${dir}`;
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
       ORDER BY ${orderBy}
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
    const [dueTodayRes, overdueRes, assignedRes, attCheckRes] = await Promise.all([
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
      db.query(
        `SELECT COUNT(*) FROM attendance_log WHERE emp_id=$1 AND date::date=CURRENT_DATE`,
        [emp_id]
      ),
    ]);
    const forgotAttendance = parseInt(attCheckRes.rows[0].count) === 0;
    res.json({
      success: true,
      is_admin_view: false,
      due_today: dueTodayRes.rows,
      overdue: overdueRes.rows,
      recently_assigned: assignedRes.rows,
      attendance_not_marked: [],
      forgot_attendance: forgotAttendance,
      total_alerts: dueTodayRes.rows.length + overdueRes.rows.length + (forgotAttendance ? 1 : 0),
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
    const compliance = await db.query(
      `SELECT id, compliance_code, compliance_name, financial_year, srn
         FROM company_compliance_records
        WHERE linked_task_id=$1
        LIMIT 1`,
      [req.params.id]
    );
    res.json({ success: true, task: r.rows[0], history: hist.rows, company_compliance: compliance.rows[0] || null });
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
  if (!due_date) return res.status(400).json({ success: false, message: 'Due date required' });
  const now = nowIST();
  const dateKey = now.toISOString().split('T')[0].replace(/-/g, '');
  try {
    const cnt = await db.query(`SELECT COUNT(*) FROM tasks WHERE created_at::date = CURRENT_DATE`);
    const seq = String(parseInt(cnt.rows[0].count) + 1).padStart(3, '0');
    const taskId = `TSK${orgTaskPrefix(req.user)}-${dateKey}-${seq}`;
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
    try {
      await recordWorkActivity({
        user: req.user,
        taskId,
        activityType: 'task_created',
        description: `Task created: ${work_name}`,
        metadata: { assigned_to_id: toId, self_assigned: isSelf, due_date },
      });
    } catch (activityErr) {
      console.error('[Performance] task create activity:', activityErr.message);
    }
    evaluateEmployee(toId).catch(error => {
      console.error('[Employee Monitor] task assignment evaluation:', error.message);
    });
    // ── Notification: task assigned ──────────────────────────
    if (!isSelf) {
      await createNotif(
        toId, 'task_assigned',
        '📋 Naya Task Assign Hua',
        `"${work_name}" aapko assign kiya gaya hai by ${formal_name || name}${due_date ? '. Due: ' + new Date(due_date).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'}) : ''}`,
        taskId
      );
    }
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
  const { status, priority, due_date, assigned_to_id, assigned_to_name, internal_remark, client_pending_remark, completion_remark, next_followup_date, drive_link, professional_fees, challan_amount, other_expense, fees_applicable, srn_udin } = req.body;
  let old;
  let meaningfulChange = null;
  try {
    const conn = await db.pool.connect();
    try {
      await conn.query('BEGIN');
      const existing = await conn.query('SELECT * FROM tasks WHERE task_id=$1 FOR UPDATE', [taskId]);
      if (!existing.rows.length) {
        const err = new Error('Task not found');
        err.statusCode = 404;
        throw err;
      }
      old = existing.rows[0];
      meaningfulChange = meaningfulTaskChange(old, req.body);
      if (assigned_to_id && assigned_to_id !== old.assigned_to_id && !due_date && !old.due_date) {
        const err = new Error('Due date required before reassigning task');
        err.statusCode = 400;
        throw err;
      }
      let linkedCompliance = null;
      if (status === 'Completed') {
        const completionText = String(completion_remark || '').trim();
        if (!completionText) {
          const err = new Error('Completion remarks required before completing task');
          err.statusCode = 400;
          throw err;
        }
        const compRes = await conn.query(
          `SELECT id, compliance_code, compliance_name, srn
             FROM company_compliance_records
            WHERE linked_task_id=$1
            FOR UPDATE`,
          [taskId]
        );
        linkedCompliance = compRes.rows[0] || null;
        if (linkedCompliance && !String(srn_udin || linkedCompliance.srn || '').trim()) {
          const err = new Error('SRN/UDIN required before completing company compliance task');
          err.statusCode = 400;
          throw err;
        }
      }
      const professionalFees = optionalAmount(professional_fees);
      const challanAmount = optionalAmount(challan_amount);
      const otherExpense = optionalAmount(other_expense);
      const total = (professionalFees ?? Number(old.professional_fees || 0)) + (challanAmount ?? Number(old.challan_amount || 0)) + (otherExpense ?? Number(old.other_expense || 0));
      const completionDate = status && ['Completed','Cancelled'].includes(status) && !old.completion_date ? todayIST() : old.completion_date;
      await conn.query(
        `UPDATE tasks SET status=COALESCE($1,status), priority=COALESCE($2,priority), due_date=COALESCE($3::date,due_date), assigned_to_id=COALESCE($4,assigned_to_id), assigned_to_name=COALESCE($5,assigned_to_name), internal_remark=COALESCE($6,internal_remark), client_pending_remark=COALESCE($7,client_pending_remark), completion_remark=COALESCE($8,completion_remark), next_followup_date=COALESCE($9::date,next_followup_date), drive_link=COALESCE($10,drive_link), professional_fees=COALESCE($11,professional_fees), challan_amount=COALESCE($12,challan_amount), other_expense=COALESCE($13,other_expense), total_amount=$14, fees_applicable=COALESCE($15,fees_applicable), completion_date=$16, last_updated_at=NOW(), last_updated_by_id=$17, last_updated_by_name=$18 WHERE task_id=$19`,
        [status||null, priority||null, due_date||null, assigned_to_id||null, assigned_to_name||null, internal_remark||null, client_pending_remark||null, completion_remark||null, next_followup_date||null, drive_link||null, professionalFees, challanAmount, otherExpense, total||null, fees_applicable||null, completionDate||null, emp_id, formal_name||name, taskId]
      );
      await conn.query(
        `INSERT INTO task_history (log_id,task_id,action,old_status,new_status,old_assigned_to,new_assigned_to,old_due_date,new_due_date,updated_by_id,updated_by_name,updated_at,remark)
         VALUES ($1,$2,'Updated',$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)`,
        ['LOG_' + uuidv4().replace(/-/g,'').slice(0,10), taskId, old.status, status||old.status, old.assigned_to_name, assigned_to_name||old.assigned_to_name, old.due_date, due_date||old.due_date, emp_id, formal_name||name, internal_remark||completion_remark||null]
      );
      if (status && status !== old.status) {
        const syncRemark = completion_remark || client_pending_remark || internal_remark || null;
        await syncGSTForTaskStatus(
          conn,
          { ...old, assigned_to_id: assigned_to_id || old.assigned_to_id, status: old.status },
          status,
          req.user,
          syncRemark
        );
        await syncIncomeTaxForTaskStatus(
          conn,
          { ...old, assigned_to_id: assigned_to_id || old.assigned_to_id, status: old.status },
          status,
          req.user,
          syncRemark
        );
        await syncComplianceForTaskStatus(
          conn,
          { ...old, assigned_to_id: assigned_to_id || old.assigned_to_id, status: old.status },
          status,
          req.user,
          syncRemark,
          srn_udin
        );
        await syncPFESICForTaskStatus(
          conn,
          { ...old, assigned_to_id: assigned_to_id || old.assigned_to_id, status: old.status },
          status,
          req.user,
          syncRemark,
          srn_udin
        );
      }
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    } finally {
      conn.release();
    }
    const newAssignee = assigned_to_id || old.assigned_to_id;
    const newAssigneeName = assigned_to_name || old.assigned_to_name;
    const taskLabel = `"${old.work_name || old.task_id}"`;
    const byName = formal_name || name;
    if (meaningfulChange) {
      try {
        await recordWorkActivity({
          user: req.user,
          taskId,
          activityType: meaningfulChange.activityType,
          description: `${old.work_name || taskId}: ${meaningfulChange.changedFields.join(', ')} updated`,
          metadata: {
            changed_fields: meaningfulChange.changedFields,
            old_status: old.status,
            new_status: status || old.status,
          },
        });
      } catch (activityErr) {
        console.error('[Performance] task update activity:', activityErr.message);
      }
    }
    const affectedEmployees = new Set([old.assigned_to_id, assigned_to_id].filter(Boolean));
    for (const affectedEmpId of affectedEmployees) {
      evaluateEmployee(affectedEmpId).catch(error => {
        console.error('[Employee Monitor] task update evaluation:', error.message);
      });
    }

    // ── Notification: reassigned ──────────────────────────────
    if (assigned_to_id && assigned_to_id !== old.assigned_to_id) {
      // Notify new assignee
      await createNotif(
        assigned_to_id, 'task_reassigned',
        '🔄 Task Aapko Reassign Hua',
        `${taskLabel} ab aapko assign kiya gaya hai by ${byName}${due_date ? '. Due: ' + new Date(due_date||old.due_date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}) : ''}`,
        taskId
      );
      // Notify old assignee
      if (old.assigned_to_id && old.assigned_to_id !== emp_id) {
        await createNotif(
          old.assigned_to_id, 'task_reassigned',
          '🔄 Task Reassign Hua',
          `${taskLabel} ab ${newAssigneeName} ko assign kiya gaya hai by ${byName}`,
          taskId
        );
      }
    }

    // ── Notification: status changed (notify creator if someone else updated) ──
    if (status && status !== old.status && old.created_by_id && old.created_by_id !== emp_id) {
      const statusLabels = { 'Completed': '✅ Complete', 'Cancelled': '❌ Cancel', 'Pending by Client': '⏳ Client Pending' };
      await createNotif(
        old.created_by_id, 'task_status',
        `${statusLabels[status] || '📝 Status Update'}: ${taskLabel}`,
        `${taskLabel} ka status "${status}" ho gaya by ${byName}`,
        taskId
      );
    }

    res.json({ success: true, message: 'Task updated!' });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Server error' });
  }
});

module.exports = router;
