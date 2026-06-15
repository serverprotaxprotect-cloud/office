const db = require('../db');
const { createNotif } = require('../routes/notifications');

const REVIEW_ROLES = new Set(['Director', 'Office Manager', 'HR']);
const RESOLVABLE_STATUSES = ['Open', 'Explanation Submitted', 'Rejected'];

function nowIST() {
  return new Date(Date.now() + (5.5 * 60 * 60 * 1000));
}

function todayIST() {
  return nowIST().toISOString().split('T')[0];
}

function dateKey(value) {
  return value ? String(value).split('T')[0] : '';
}

function normalized(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function changedDate(oldValue, newValue) {
  return newValue !== undefined && newValue !== null && newValue !== ''
    && dateKey(oldValue) !== dateKey(newValue);
}

function meaningfulTaskChange(oldTask, body = {}) {
  const fields = [];
  let activityType = '';

  if (body.status && normalized(body.status) !== normalized(oldTask.status)) {
    fields.push('status');
    activityType = body.status === 'Completed' ? 'task_completed' : 'task_status_changed';
  }
  if (body.assigned_to_id && normalized(body.assigned_to_id) !== normalized(oldTask.assigned_to_id)) {
    fields.push('assignee');
    activityType ||= 'task_reassigned';
  }
  if (changedDate(oldTask.due_date, body.due_date)) {
    fields.push('due_date');
    activityType ||= 'task_due_changed';
  }
  if (changedDate(oldTask.next_followup_date, body.next_followup_date)) {
    fields.push('follow_up');
    activityType ||= 'task_followup_changed';
  }

  const remarkFields = ['internal_remark', 'client_pending_remark', 'completion_remark'];
  for (const field of remarkFields) {
    if (normalized(body[field]) && normalized(body[field]) !== normalized(oldTask[field])) {
      fields.push(field);
      activityType ||= 'task_progress_updated';
    }
  }

  return fields.length ? { activityType, changedFields: fields } : null;
}

function isEmployeeActor(user) {
  return user?.user_type === 'employee' && !!user.emp_id;
}

async function addAlertHistory(conn, {
  alertId, organizationId, action, oldStatus, newStatus,
  actorType, actorId, actorName, remarks, metadata,
}) {
  await conn.query(
    `INSERT INTO employee_protocol_alert_history
       (organization_id, alert_id, action, old_status, new_status,
        actor_type, actor_id, actor_name, remarks, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      organizationId, alertId, action, oldStatus || null, newStatus || null,
      actorType || null, actorId || null, actorName || null, remarks || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

async function recordWorkActivity({
  user, taskId, activityType, description, metadata, client,
}) {
  if (!isEmployeeActor(user) || !activityType) return null;
  const conn = client || await db.pool.connect();
  const ownsConnection = !client;
  const organizationId = Number(user.organization_id);
  const activityDate = todayIST();

  try {
    if (ownsConnection) await conn.query('BEGIN');
    const inserted = await conn.query(
      `INSERT INTO employee_work_activity
         (organization_id, emp_id, employee_name, activity_date, activity_type,
          task_id, description, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING id`,
      [
        organizationId, user.emp_id, user.formal_name || user.name || user.emp_id,
        activityDate, activityType, taskId || null, description || null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    const activityId = inserted.rows[0].id;

    const alertResult = await conn.query(
      `SELECT id, status
         FROM employee_protocol_alerts
        WHERE organization_id=$1 AND emp_id=$2 AND alert_date=$3
          AND status = ANY($4::varchar[])
        FOR UPDATE`,
      [organizationId, user.emp_id, activityDate, RESOLVABLE_STATUSES]
    );
    for (const alert of alertResult.rows) {
      await conn.query(
        `UPDATE employee_protocol_alerts
            SET status='Auto Resolved', resolved_at=NOW(),
                auto_resolved_activity_id=$1, updated_at=NOW()
          WHERE id=$2`,
        [activityId, alert.id]
      );
      await addAlertHistory(conn, {
        alertId: alert.id,
        organizationId,
        action: 'Auto Resolved by Task Activity',
        oldStatus: alert.status,
        newStatus: 'Auto Resolved',
        actorType: 'employee',
        actorId: user.emp_id,
        actorName: user.formal_name || user.name,
        remarks: description || 'Meaningful task activity recorded after protocol alert.',
        metadata: { activity_id: activityId, task_id: taskId, activity_type: activityType },
      });
    }

    if (ownsConnection) await conn.query('COMMIT');
    return activityId;
  } catch (err) {
    if (ownsConnection) await conn.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsConnection) conn.release();
  }
}

async function isExcludedWorkDate(empId, date) {
  const day = new Date(`${date}T00:00:00+05:30`).getDay();
  if (day === 0) return true;
  const excluded = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM holidays WHERE holiday_date::date=$1::date) AS is_holiday,
       EXISTS (
         SELECT 1 FROM leave_requests
          WHERE emp_id=$2 AND status='Approved'
            AND $1::date BETWEEN from_date::date AND to_date::date
       ) AS is_leave`,
    [date, empId]
  );
  return !!(excluded.rows[0]?.is_holiday || excluded.rows[0]?.is_leave);
}

async function notifyManagement(alert, user) {
  const admins = await db.query(
    `SELECT username, name, role
       FROM admins
      WHERE status='Active' AND role = ANY($1::varchar[])`,
    [Array.from(REVIEW_ROLES)]
  );
  for (const admin of admins.rows) {
    await createNotif(
      admin.username,
      'work_protocol_alert',
      'Work Protocol Alert',
      `${alert.employee_name || user.formal_name || user.name || user.emp_id} ne Punch OUT kiya, lekin aaj koi meaningful task activity record nahi hui.`,
      null
    );
  }
}

async function evaluatePunchOut({ user, punchOutTime }) {
  if (!isEmployeeActor(user)) return null;
  const organizationId = Number(user.organization_id);
  const alertDate = todayIST();
  if (await isExcludedWorkDate(user.emp_id, alertDate)) return null;

  const activity = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM employee_work_activity
      WHERE organization_id=$1 AND emp_id=$2 AND activity_date=$3`,
    [organizationId, user.emp_id, alertDate]
  );
  if (Number(activity.rows[0]?.count || 0) > 0) return null;

  const emp = await db.query(
    `SELECT formal_name, name, designation
       FROM emplist WHERE emp_id=$1 LIMIT 1`,
    [user.emp_id]
  );
  const employeeName = emp.rows[0]?.formal_name || emp.rows[0]?.name || user.formal_name || user.name || user.emp_id;
  const inserted = await db.query(
    `INSERT INTO employee_protocol_alerts
       (organization_id, emp_id, employee_name, designation, alert_date, punch_out_time)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organization_id, emp_id, alert_date) DO NOTHING
     RETURNING *`,
    [organizationId, user.emp_id, employeeName, emp.rows[0]?.designation || null, alertDate, punchOutTime || null]
  );
  if (!inserted.rows.length) {
    const current = await db.query(
      `SELECT * FROM employee_protocol_alerts
        WHERE organization_id=$1 AND emp_id=$2 AND alert_date=$3`,
      [organizationId, user.emp_id, alertDate]
    );
    return current.rows[0] || null;
  }

  const alert = inserted.rows[0];
  await addAlertHistory(db, {
    alertId: alert.id,
    organizationId,
    action: 'Alert Created on Punch OUT',
    newStatus: 'Open',
    actorType: 'system',
    actorId: 'system',
    actorName: 'Work Protocol Engine',
    remarks: 'Punch OUT completed with zero meaningful task activity.',
  });
  await notifyManagement(alert, user);
  return alert;
}

async function getTodayState(user) {
  const date = todayIST();
  const [attendance, activity, alert] = await Promise.all([
    db.query(
      `SELECT first_in, last_out, final_status
         FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`,
      [user.emp_id, date]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM employee_work_activity
        WHERE emp_id=$1 AND activity_date=$2`,
      [user.emp_id, date]
    ),
    db.query(
      `SELECT id, alert_date, status, explanation, explanation_submitted_at,
              review_remark, reviewed_at, triggered_at
         FROM employee_protocol_alerts
        WHERE emp_id=$1 AND alert_date=$2`,
      [user.emp_id, date]
    ),
  ]);
  return {
    date,
    punched_in: !!attendance.rows[0]?.first_in,
    punched_out: !!attendance.rows[0]?.last_out,
    activity_count: Number(activity.rows[0]?.count || 0),
    alert: alert.rows[0] || null,
  };
}

module.exports = {
  REVIEW_ROLES,
  todayIST,
  meaningfulTaskChange,
  recordWorkActivity,
  evaluatePunchOut,
  getTodayState,
  addAlertHistory,
};
