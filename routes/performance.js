const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const {
  REVIEW_ROLES,
  todayIST,
  getTodayState,
  addAlertHistory,
} = require('../services/performanceService');

const router = express.Router();

function requireEmployee(req, res, next) {
  if (req.user?.user_type !== 'employee') {
    return res.status(403).json({ success: false, message: 'Employee access required' });
  }
  next();
}

function requireReviewer(req, res, next) {
  if (req.user?.user_type !== 'admin' || !REVIEW_ROLES.has(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Director, HR or Office Manager access required' });
  }
  next();
}

router.get('/me/today', authMiddleware, requireEmployee, async (req, res) => {
  try {
    res.json({ success: true, ...(await getTodayState(req.user)) });
  } catch (err) {
    console.error('[Performance] today:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/me/alerts/:id/explanation', authMiddleware, requireEmployee, async (req, res) => {
  const explanation = String(req.body.explanation || '').trim();
  if (!explanation) {
    return res.status(400).json({ success: false, message: 'Explanation required' });
  }
  try {
    const conn = await db.pool.connect();
    try {
      await conn.query('BEGIN');
      const result = await conn.query(
        `SELECT id, status FROM employee_protocol_alerts
          WHERE id=$1 AND emp_id=$2 FOR UPDATE`,
        [req.params.id, req.user.emp_id]
      );
      if (!result.rows.length) {
        const err = new Error('Alert not found');
        err.statusCode = 404;
        throw err;
      }
      if (['Justified', 'Auto Resolved'].includes(result.rows[0].status)) {
        const err = new Error('Resolved alert cannot be changed');
        err.statusCode = 400;
        throw err;
      }
      await conn.query(
        `UPDATE employee_protocol_alerts
            SET explanation=$1, explanation_submitted_at=NOW(),
                status='Explanation Submitted', updated_at=NOW()
          WHERE id=$2`,
        [explanation, req.params.id]
      );
      await addAlertHistory(conn, {
        alertId: req.params.id,
        organizationId: req.user.organization_id,
        action: 'Explanation Submitted',
        oldStatus: result.rows[0].status,
        newStatus: 'Explanation Submitted',
        actorType: 'employee',
        actorId: req.user.emp_id,
        actorName: req.user.formal_name || req.user.name,
        remarks: explanation,
      });
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    } finally {
      conn.release();
    }
    res.json({ success: true, message: 'Explanation submitted for management review' });
  } catch (err) {
    console.error('[Performance] explanation:', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Server error' });
  }
});

router.get('/admin/alerts', authMiddleware, requireReviewer, async (req, res) => {
  const params = [];
  const conditions = ['1=1'];
  const unresolvedOnly = req.query.status === undefined || req.query.status === 'unresolved';
  if (unresolvedOnly) {
    conditions.push(`a.status = ANY($${params.push(['Open', 'Explanation Submitted', 'Rejected'])}::varchar[])`);
  } else if (req.query.status) {
    conditions.push(`a.status=$${params.push(req.query.status)}`);
  }
  if (req.query.emp_id) conditions.push(`a.emp_id=$${params.push(req.query.emp_id)}`);
  if (req.query.date_from) conditions.push(`a.alert_date >= $${params.push(req.query.date_from)}::date`);
  if (req.query.date_to) conditions.push(`a.alert_date <= $${params.push(req.query.date_to)}::date`);

  try {
    const result = await db.query(
      `SELECT a.*,
              COALESCE(act.activity_count,0)::int AS activity_count,
              COALESCE(t.overdue_count,0)::int AS overdue_tasks
         FROM employee_protocol_alerts a
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS activity_count
             FROM employee_work_activity wa
            WHERE wa.emp_id=a.emp_id AND wa.activity_date=a.alert_date
         ) act ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS overdue_count
             FROM tasks
            WHERE assigned_to_id=a.emp_id AND active_flag=true
              AND due_date<CURRENT_DATE AND status NOT IN ('Completed','Cancelled')
         ) t ON true
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.alert_date DESC, a.triggered_at DESC
        LIMIT 300`,
      params
    );
    const history = result.rows.length
      ? await db.query(
        `SELECT * FROM employee_protocol_alert_history
          WHERE alert_id = ANY($1::bigint[]) ORDER BY created_at DESC`,
        [result.rows.map(r => r.id)]
      )
      : { rows: [] };
    res.json({
      success: true,
      alerts: result.rows.map(row => ({
        ...row,
        history: history.rows.filter(h => String(h.alert_id) === String(row.id)),
      })),
      unresolved: result.rows.filter(r => ['Open', 'Explanation Submitted', 'Rejected'].includes(r.status)).length,
    });
  } catch (err) {
    console.error('[Performance] alerts:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/admin/alerts/:id/review', authMiddleware, requireReviewer, async (req, res) => {
  const status = String(req.body.status || '').trim();
  const remark = String(req.body.remark || '').trim();
  if (!['Justified', 'Rejected'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Status must be Justified or Rejected' });
  }
  if (!remark) return res.status(400).json({ success: false, message: 'Review remark required' });

  try {
    const conn = await db.pool.connect();
    try {
      await conn.query('BEGIN');
      const result = await conn.query(
        `SELECT id, status FROM employee_protocol_alerts WHERE id=$1 FOR UPDATE`,
        [req.params.id]
      );
      if (!result.rows.length) {
        const err = new Error('Alert not found');
        err.statusCode = 404;
        throw err;
      }
      await conn.query(
        `UPDATE employee_protocol_alerts
            SET status=$1, review_remark=$2, reviewed_by_id=$3,
                reviewed_by_name=$4, reviewed_at=NOW(),
                resolved_at=CASE WHEN $1='Justified' THEN NOW() ELSE NULL END,
                updated_at=NOW()
          WHERE id=$5`,
        [status, remark, req.user.emp_id || req.user.username, req.user.formal_name || req.user.name, req.params.id]
      );
      await addAlertHistory(conn, {
        alertId: req.params.id,
        organizationId: req.user.organization_id,
        action: `Management Review: ${status}`,
        oldStatus: result.rows[0].status,
        newStatus: status,
        actorType: 'admin',
        actorId: req.user.emp_id || req.user.username,
        actorName: req.user.formal_name || req.user.name,
        remarks: remark,
      });
      await conn.query('COMMIT');
    } catch (err) {
      await conn.query('ROLLBACK');
      throw err;
    } finally {
      conn.release();
    }
    res.json({ success: true, message: `Alert marked ${status}` });
  } catch (err) {
    console.error('[Performance] review:', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Server error' });
  }
});

router.get('/admin/report', authMiddleware, requireReviewer, async (req, res) => {
  const dateTo = req.query.date_to || todayIST();
  const dateFrom = req.query.date_from || new Date(`${dateTo}T00:00:00Z`).toISOString().slice(0, 10);
  const calculatedFrom = req.query.date_from
    ? dateFrom
    : new Date(new Date(`${dateTo}T00:00:00Z`).getTime() - (29 * 86400000)).toISOString().slice(0, 10);
  const params = [calculatedFrom, dateTo];
  const empCondition = req.query.emp_id ? `AND e.emp_id=$${params.push(req.query.emp_id)}` : '';

  try {
    const result = await db.query(
      `WITH eligible AS (
         SELECT d.emp_id, d.date::date AS work_date
           FROM daily_attendance d
          WHERE d.date::date BETWEEN $1::date AND $2::date
            AND d.first_in IS NOT NULL
            AND d.final_status NOT IN ('Leave','Holiday')
            AND EXTRACT(DOW FROM d.date::date) <> 0
            AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date::date=d.date::date)
       ),
       activity_days AS (
         SELECT emp_id, activity_date, COUNT(*)::int AS cnt
           FROM employee_work_activity
          WHERE activity_date BETWEEN $1::date AND $2::date
          GROUP BY emp_id, activity_date
       ),
       activity_totals AS (
         SELECT emp_id,
                COUNT(*) FILTER (WHERE activity_type='task_created')::int AS tasks_created,
                COUNT(*) FILTER (WHERE activity_type NOT IN ('task_created','task_completed'))::int AS tasks_updated,
                COUNT(*) FILTER (WHERE activity_type='task_completed')::int AS tasks_completed
           FROM employee_work_activity
          WHERE activity_date BETWEEN $1::date AND $2::date
          GROUP BY emp_id
       ),
       alert_totals AS (
         SELECT emp_id,
                COUNT(*) FILTER (WHERE status='Auto Resolved')::int AS late_resolved,
                COUNT(*) FILTER (WHERE status='Justified')::int AS justified,
                COUNT(*) FILTER (WHERE status IN ('Open','Explanation Submitted','Rejected'))::int AS unresolved
           FROM employee_protocol_alerts
          WHERE alert_date BETWEEN $1::date AND $2::date
          GROUP BY emp_id
       ),
       overdue AS (
         SELECT assigned_to_id AS emp_id, COUNT(*)::int AS overdue_tasks
           FROM tasks
          WHERE active_flag=true AND due_date<CURRENT_DATE
            AND status NOT IN ('Completed','Cancelled')
          GROUP BY assigned_to_id
       )
       SELECT e.emp_id, COALESCE(e.formal_name,e.name) AS employee_name, e.designation,
              COUNT(el.work_date)::int AS present_working_days,
              COUNT(el.work_date) FILTER (WHERE ad.cnt>0)::int AS activity_compliant_days,
              COUNT(el.work_date) FILTER (WHERE COALESCE(ad.cnt,0)=0)::int AS zero_activity_days,
              COALESCE(at.tasks_created,0)::int AS tasks_created,
              COALESCE(at.tasks_updated,0)::int AS tasks_updated,
              COALESCE(at.tasks_completed,0)::int AS tasks_completed,
              COALESCE(alt.late_resolved,0)::int AS late_resolved,
              COALESCE(alt.justified,0)::int AS justified,
              COALESCE(alt.unresolved,0)::int AS unresolved,
              COALESCE(od.overdue_tasks,0)::int AS overdue_tasks,
              CASE WHEN COUNT(el.work_date)=0 THEN 100
                   ELSE ROUND(100.0 * COUNT(el.work_date) FILTER (WHERE ad.cnt>0) / COUNT(el.work_date), 1)
               END AS adherence_percentage
         FROM emplist e
         LEFT JOIN eligible el ON el.emp_id=e.emp_id
         LEFT JOIN activity_days ad ON ad.emp_id=el.emp_id AND ad.activity_date=el.work_date
         LEFT JOIN activity_totals at ON at.emp_id=e.emp_id
         LEFT JOIN alert_totals alt ON alt.emp_id=e.emp_id
         LEFT JOIN overdue od ON od.emp_id=e.emp_id
        WHERE e.status='Active' ${empCondition}
        GROUP BY e.emp_id, e.formal_name, e.name, e.designation,
                 at.tasks_created, at.tasks_updated, at.tasks_completed,
                 alt.late_resolved, alt.justified, alt.unresolved, od.overdue_tasks
        ORDER BY adherence_percentage ASC, employee_name`,
      params
    );
    res.json({ success: true, date_from: calculatedFrom, date_to: dateTo, report: result.rows });
  } catch (err) {
    console.error('[Performance] report:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
