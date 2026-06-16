const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const {
  REVIEW_ROLES,
  UNRESOLVED_STATUSES,
  todayIST,
  getTodayState,
  addAlertHistory,
  getMonitorState,
  getMonitorSettings,
  evaluateAllOrganizations,
  addMonitorEvent,
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

function requireMonitorReviewer(req, res, next) {
  if (req.user?.user_type !== 'admin' || !['Director', 'HR'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Director or HR access required' });
  }
  next();
}

function requireMonitorSettingsAccess(req, res, next) {
  if (req.user?.user_type !== 'admin' || !['Director', 'Office Manager'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Director or Office Manager access required' });
  }
  next();
}

router.get('/cron/monitor', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, message: 'CRON_SECRET is not configured' });
  }
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ success: false, message: 'Unauthorized cron request' });
  }
  try {
    const results = await evaluateAllOrganizations();
    res.json({ success: true, organizations: results });
  } catch (error) {
    console.error('[Employee Monitor] cron:', error);
    res.status(500).json({ success: false, message: 'Monitor execution failed' });
  }
});

router.get('/monitor/me', authMiddleware, requireEmployee, async (req, res) => {
  try {
    const state = await getMonitorState(req.user);
    res.json({ success: true, ...state });
  } catch (error) {
    console.error('[Employee Monitor] employee state:', error);
    res.status(500).json({ success: false, message: 'Unable to load employee monitor alerts' });
  }
});

router.post('/monitor/alerts/:id/acknowledge', authMiddleware, requireEmployee, async (req, res) => {
  try {
    const conn = await db.pool.connect();
    try {
      await conn.query('BEGIN');
      const current = await conn.query(
        `SELECT id, organization_id, status FROM employee_monitor_alerts
          WHERE id=$1 AND emp_id=$2 FOR UPDATE`,
        [req.params.id, req.user.emp_id]
      );
      if (!current.rows.length) {
        const error = new Error('Alert not found');
        error.statusCode = 404;
        throw error;
      }
      if (!['Open', 'Rejected'].includes(current.rows[0].status)) {
        const error = new Error('This alert does not require acknowledgement');
        error.statusCode = 400;
        throw error;
      }
      await conn.query(
        `UPDATE employee_monitor_alerts
            SET status='Acknowledged', acknowledged_at=NOW(), updated_at=NOW()
          WHERE id=$1`,
        [req.params.id]
      );
      await addMonitorEvent(conn, {
        alertId: req.params.id,
        organizationId: req.user.organization_id,
        eventType: 'Acknowledged by Employee',
        oldStatus: current.rows[0].status,
        newStatus: 'Acknowledged',
        actorType: 'employee',
        actorId: req.user.emp_id,
        actorName: req.user.formal_name || req.user.name,
        remarks: 'The employee acknowledged the warning.',
      });
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
    res.json({ success: true, message: 'Warning acknowledged' });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Unable to acknowledge warning',
    });
  }
});

router.post('/monitor/alerts/:id/explanation', authMiddleware, requireEmployee, async (req, res) => {
  const explanation = String(req.body.explanation || '').trim();
  if (!explanation) return res.status(400).json({ success: false, message: 'Explanation is required' });
  try {
    const conn = await db.pool.connect();
    try {
      await conn.query('BEGIN');
      const current = await conn.query(
        `SELECT id, organization_id, status FROM employee_monitor_alerts
          WHERE id=$1 AND emp_id=$2 FOR UPDATE`,
        [req.params.id, req.user.emp_id]
      );
      if (!current.rows.length) {
        const error = new Error('Alert not found');
        error.statusCode = 404;
        throw error;
      }
      if (['Justified', 'Auto Resolved', 'Resolved'].includes(current.rows[0].status)) {
        const error = new Error('Resolved alerts cannot be changed');
        error.statusCode = 400;
        throw error;
      }
      await conn.query(
        `UPDATE employee_monitor_alerts
            SET explanation=$1, explanation_submitted_at=NOW(),
                status='Explanation Submitted', updated_at=NOW()
          WHERE id=$2`,
        [explanation, req.params.id]
      );
      await addMonitorEvent(conn, {
        alertId: req.params.id,
        organizationId: req.user.organization_id,
        eventType: 'Explanation Submitted',
        oldStatus: current.rows[0].status,
        newStatus: 'Explanation Submitted',
        actorType: 'employee',
        actorId: req.user.emp_id,
        actorName: req.user.formal_name || req.user.name,
        remarks: explanation,
      });
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
    res.json({ success: true, message: 'Explanation submitted for management review' });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Unable to submit explanation',
    });
  }
});

router.get('/monitor/admin/summary', authMiddleware, requireReviewer, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status=ANY($1::varchar[]))::int AS unresolved,
         COUNT(*) FILTER (WHERE status=ANY($1::varchar[]) AND severity='critical')::int AS critical,
         COUNT(*) FILTER (WHERE status='Explanation Submitted')::int AS explanations,
         COUNT(*) FILTER (WHERE status=ANY($1::varchar[]) AND escalation_level>=2)::int AS escalated,
         COUNT(*) FILTER (WHERE alert_type='late_arrival' AND alert_date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date)::int AS late_today,
         COUNT(*) FILTER (WHERE alert_type IN ('early_departure','incomplete_hours') AND alert_date=(NOW() AT TIME ZONE 'Asia/Kolkata')::date)::int AS attendance_issues_today,
         COUNT(*) FILTER (WHERE alert_type='overdue_work' AND status=ANY($1::varchar[]))::int AS overdue_alerts
       FROM employee_monitor_alerts`,
      [UNRESOLVED_STATUSES]
    );
    res.json({ success: true, summary: result.rows[0] });
  } catch (error) {
    console.error('[Employee Monitor] summary:', error);
    res.status(500).json({ success: false, message: 'Unable to load monitor summary' });
  }
});

router.get('/monitor/admin/alerts', authMiddleware, requireReviewer, async (req, res) => {
  const params = [];
  const conditions = ['1=1'];
  if (!req.query.status || req.query.status === 'unresolved') {
    conditions.push(`a.status=ANY($${params.push(UNRESOLVED_STATUSES)}::varchar[])`);
  } else if (req.query.status !== 'all') {
    conditions.push(`a.status=$${params.push(req.query.status)}`);
  }
  if (req.query.emp_id) conditions.push(`a.emp_id=$${params.push(req.query.emp_id)}`);
  if (req.query.alert_type) conditions.push(`a.alert_type=$${params.push(req.query.alert_type)}`);
  if (req.query.date_from) conditions.push(`a.alert_date>=$${params.push(req.query.date_from)}::date`);
  if (req.query.date_to) conditions.push(`a.alert_date<=$${params.push(req.query.date_to)}::date`);
  try {
    const alerts = await db.query(
      `SELECT a.* FROM employee_monitor_alerts a
        WHERE ${conditions.join(' AND ')}
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 ELSE 1 END,
                 a.alert_date DESC, a.created_at DESC LIMIT 500`,
      params
    );
    const events = alerts.rows.length
      ? await db.query(
        `SELECT * FROM employee_monitor_alert_events
          WHERE alert_id=ANY($1::bigint[]) ORDER BY created_at DESC`,
        [alerts.rows.map(alert => alert.id)]
      )
      : { rows: [] };
    res.json({
      success: true,
      alerts: alerts.rows.map(alert => ({
        ...alert,
        events: events.rows.filter(event => String(event.alert_id) === String(alert.id)),
      })),
    });
  } catch (error) {
    console.error('[Employee Monitor] alerts:', error);
    res.status(500).json({ success: false, message: 'Unable to load monitor alerts' });
  }
});

router.put('/monitor/admin/alerts/:id/review', authMiddleware, requireMonitorReviewer, async (req, res) => {
  const status = String(req.body.status || '').trim();
  const remark = String(req.body.remark || '').trim();
  if (!['Justified', 'Rejected', 'Resolved'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid review decision' });
  }
  if (!remark) return res.status(400).json({ success: false, message: 'Review remarks are required' });
  try {
    const conn = await db.pool.connect();
    try {
      await conn.query('BEGIN');
      const current = await conn.query(
        `SELECT id, organization_id, status FROM employee_monitor_alerts WHERE id=$1 FOR UPDATE`,
        [req.params.id]
      );
      if (!current.rows.length) {
        const error = new Error('Alert not found');
        error.statusCode = 404;
        throw error;
      }
      await conn.query(
        `UPDATE employee_monitor_alerts
            SET status=$1, review_remark=$2, reviewed_by_id=$3,
                reviewed_by_name=$4, reviewed_at=NOW(),
                resolved_at=CASE WHEN $1 IN ('Justified','Resolved') THEN NOW() ELSE NULL END,
                updated_at=NOW()
          WHERE id=$5`,
        [status, remark, req.user.username || req.user.emp_id, req.user.name, req.params.id]
      );
      await addMonitorEvent(conn, {
        alertId: req.params.id,
        organizationId: req.user.organization_id,
        eventType: `Management Review: ${status}`,
        oldStatus: current.rows[0].status,
        newStatus: status,
        actorType: 'admin',
        actorId: req.user.username || req.user.emp_id,
        actorName: req.user.name,
        remarks: remark,
      });
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
    res.json({ success: true, message: `Alert marked as ${status}` });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Unable to review alert',
    });
  }
});

router.get('/monitor/admin/employees/:emp_id/timeline', authMiddleware, requireReviewer, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days || 30)));
  try {
    const [employee, alerts, activity, tasks] = await Promise.all([
      db.query(
        `SELECT emp_id, COALESCE(formal_name,name) AS employee_name, designation
           FROM emplist WHERE emp_id=$1 LIMIT 1`,
        [req.params.emp_id]
      ),
      db.query(
        `SELECT * FROM employee_monitor_alerts
          WHERE emp_id=$1 AND alert_date>=CURRENT_DATE-($2::int*INTERVAL '1 day')
          ORDER BY alert_date DESC, created_at DESC`,
        [req.params.emp_id, days]
      ),
      db.query(
        `SELECT * FROM employee_work_activity
          WHERE emp_id=$1 AND activity_date>=CURRENT_DATE-($2::int*INTERVAL '1 day')
          ORDER BY created_at DESC LIMIT 500`,
        [req.params.emp_id, days]
      ),
      db.query(
        `SELECT task_id, work_name, status, due_date, last_updated_at
           FROM tasks WHERE assigned_to_id=$1 AND active_flag=true
          ORDER BY due_date NULLS LAST LIMIT 200`,
        [req.params.emp_id]
      ),
    ]);
    if (!employee.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({
      success: true,
      employee: employee.rows[0],
      alerts: alerts.rows,
      activity: activity.rows,
      active_tasks: tasks.rows,
    });
  } catch (error) {
    console.error('[Employee Monitor] timeline:', error);
    res.status(500).json({ success: false, message: 'Unable to load employee timeline' });
  }
});

router.get('/monitor/settings', authMiddleware, requireReviewer, async (req, res) => {
  try {
    res.json({ success: true, settings: await getMonitorSettings() });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Unable to load monitor settings' });
  }
});

router.put('/monitor/settings', authMiddleware, requireMonitorSettingsAccess, async (req, res) => {
  const integerFields = [
    'popup_repeat_minutes', 'repeat_window_days', 'hr_escalation_day', 'director_escalation_day',
  ];
  for (const field of integerFields) {
    if (!Number.isInteger(Number(req.body[field])) || Number(req.body[field]) < 1) {
      return res.status(400).json({ success: false, message: `${field} must be a positive integer` });
    }
  }
  if (Number(req.body.director_escalation_day) <= Number(req.body.hr_escalation_day)) {
    return res.status(400).json({ success: false, message: 'Director escalation must occur after HR escalation' });
  }
  try {
    const result = await db.query(
      `INSERT INTO employee_monitor_settings
         (organization_id, enabled, active_task_checkpoint, activity_checkpoint,
          overdue_reminder_time, popup_repeat_minutes, repeat_window_days,
          hr_escalation_day, director_escalation_day, updated_by, updated_at)
       VALUES (current_organization_id(),$1,$2::time,$3::time,$4::time,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (organization_id) DO UPDATE SET
         enabled=EXCLUDED.enabled,
         active_task_checkpoint=EXCLUDED.active_task_checkpoint,
         activity_checkpoint=EXCLUDED.activity_checkpoint,
         overdue_reminder_time=EXCLUDED.overdue_reminder_time,
         popup_repeat_minutes=EXCLUDED.popup_repeat_minutes,
         repeat_window_days=EXCLUDED.repeat_window_days,
         hr_escalation_day=EXCLUDED.hr_escalation_day,
         director_escalation_day=EXCLUDED.director_escalation_day,
         updated_by=EXCLUDED.updated_by,
         updated_at=NOW()
       RETURNING *`,
      [
        req.body.enabled !== false,
        req.body.active_task_checkpoint,
        req.body.activity_checkpoint,
        req.body.overdue_reminder_time,
        Number(req.body.popup_repeat_minutes),
        Number(req.body.repeat_window_days),
        Number(req.body.hr_escalation_day),
        Number(req.body.director_escalation_day),
        req.user.username || req.user.emp_id,
      ]
    );
    res.json({ success: true, message: 'Employee monitor settings saved', settings: result.rows[0] });
  } catch (error) {
    console.error('[Employee Monitor] settings:', error);
    res.status(500).json({ success: false, message: 'Unable to save monitor settings' });
  }
});

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
       activity_events AS (
         SELECT emp_id, activity_date::date AS activity_date, activity_type
           FROM employee_work_activity
          WHERE activity_date BETWEEN $1::date AND $2::date
         UNION ALL
         SELECT updated_by_id AS emp_id,
                ((updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS activity_date,
                CASE
                  WHEN action='Created' THEN 'task_created'
                  WHEN new_status='Completed' THEN 'task_completed'
                  WHEN action ILIKE '%Reassigned%' THEN 'task_reassigned'
                  ELSE 'task_updated'
                END AS activity_type
           FROM task_history
          WHERE updated_by_id IS NOT NULL
            AND ((updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
            AND action IN ('Created','Updated','GST Status Sync','GST Reassigned')
            AND (
              action <> 'Updated'
              OR COALESCE(old_status,'') <> COALESCE(new_status,'')
              OR COALESCE(old_assigned_to,'') <> COALESCE(new_assigned_to,'')
              OR old_due_date IS DISTINCT FROM new_due_date
              OR NULLIF(BTRIM(COALESCE(remark,'')), '') IS NOT NULL
            )
         UNION ALL
         SELECT created_by_id AS emp_id,
                ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS activity_date,
                'task_created' AS activity_type
           FROM tasks
          WHERE created_by_id IS NOT NULL
            AND ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
            AND NOT EXISTS (
              SELECT 1 FROM task_history th
               WHERE th.task_id=tasks.task_id
                 AND th.action='Created'
            )
         UNION ALL
         SELECT last_updated_by_id AS emp_id,
                ((last_updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date AS activity_date,
                CASE WHEN status='Completed' THEN 'task_completed' ELSE 'task_updated' END AS activity_type
           FROM tasks
          WHERE last_updated_by_id IS NOT NULL
            AND ((last_updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
            AND NOT EXISTS (
              SELECT 1 FROM task_history th
               WHERE th.task_id=tasks.task_id
                 AND th.updated_by_id=tasks.last_updated_by_id
                 AND ((th.updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date =
                     ((tasks.last_updated_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata')::date
            )
       ),
       activity_days AS (
         SELECT emp_id, activity_date, COUNT(*)::int AS cnt
           FROM activity_events
          WHERE emp_id IS NOT NULL
          GROUP BY emp_id, activity_date
       ),
       activity_totals AS (
         SELECT emp_id,
                COUNT(*) FILTER (WHERE activity_type='task_created')::int AS tasks_created,
                COUNT(*) FILTER (WHERE activity_type NOT IN ('task_created','task_completed'))::int AS tasks_updated,
                COUNT(*) FILTER (WHERE activity_type='task_completed')::int AS tasks_completed
           FROM activity_events
          WHERE emp_id IS NOT NULL
          GROUP BY emp_id
       ),
       alert_totals AS (
         SELECT emp_id,
                COUNT(*) FILTER (WHERE status='Auto Resolved')::int AS late_resolved,
                COUNT(*) FILTER (WHERE status='Justified')::int AS justified,
                COUNT(*) FILTER (WHERE status IN ('Open','Acknowledged','Explanation Submitted','Rejected'))::int AS unresolved
           FROM (
             SELECT emp_id, status, alert_date FROM employee_monitor_alerts
              WHERE alert_date BETWEEN $1::date AND $2::date
             UNION ALL
             SELECT emp_id, status, alert_date FROM employee_protocol_alerts
              WHERE alert_date BETWEEN $1::date AND $2::date
           ) alerts
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
