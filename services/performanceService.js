const db = require('../db');
const { createNotif } = require('../routes/notifications');

const REVIEW_ROLES = new Set(['Director', 'Office Manager', 'HR']);
const HR_ROLES = ['HR'];
const DIRECTOR_ROLES = ['Director'];
const UNRESOLVED_STATUSES = ['Open', 'Acknowledged', 'Explanation Submitted', 'Rejected'];
const CORRECTABLE_STATUSES = ['Open', 'Acknowledged', 'Explanation Submitted', 'Rejected'];
const DEFAULT_SETTINGS = {
  enabled: true,
  block_punch_out_on_violation: false,
  active_task_checkpoint: '12:00:00',
  activity_checkpoint: '15:00:00',
  overdue_reminder_time: '10:00:00',
  popup_repeat_minutes: 60,
  repeat_window_days: 30,
  hr_escalation_day: 2,
  director_escalation_day: 3,
};

function nowIST() {
  return new Date(Date.now() + (5.5 * 60 * 60 * 1000));
}

function todayIST() {
  return nowIST().toISOString().split('T')[0];
}

function currentTimeIST() {
  return nowIST().toISOString().slice(11, 19);
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

function timeToMinutes(value) {
  const [hours, minutes] = String(value || '00:00').split(':').map(Number);
  return (hours * 60) + minutes;
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

  for (const field of ['internal_remark', 'client_pending_remark', 'completion_remark']) {
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

async function getMonitorSettings() {
  const result = await db.query(
    `INSERT INTO employee_monitor_settings (organization_id)
     VALUES (current_organization_id())
     ON CONFLICT (organization_id) DO UPDATE SET organization_id=EXCLUDED.organization_id
     RETURNING *`
  );
  return { ...DEFAULT_SETTINGS, ...(result.rows[0] || {}) };
}

async function addMonitorEvent(conn, {
  alertId, organizationId, eventType, oldStatus, newStatus,
  actorType, actorId, actorName, remarks, metadata,
}) {
  await conn.query(
    `INSERT INTO employee_monitor_alert_events
       (organization_id, alert_id, event_type, old_status, new_status,
        actor_type, actor_id, actor_name, remarks, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      organizationId, alertId, eventType, oldStatus || null, newStatus || null,
      actorType || null, actorId || null, actorName || null, remarks || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

// Retained for existing Work Protocol API compatibility.
async function addAlertHistory(conn, payload) {
  await conn.query(
    `INSERT INTO employee_protocol_alert_history
       (organization_id, alert_id, action, old_status, new_status,
        actor_type, actor_id, actor_name, remarks, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      payload.organizationId, payload.alertId, payload.action,
      payload.oldStatus || null, payload.newStatus || null,
      payload.actorType || null, payload.actorId || null, payload.actorName || null,
      payload.remarks || null, payload.metadata ? JSON.stringify(payload.metadata) : null,
    ]
  );
}

async function isExcludedWorkDate(empId, date) {
  const day = new Date(`${date}T00:00:00+05:30`).getDay();
  if (day === 0) return true;
  const result = await db.query(
    `SELECT
       EXISTS (SELECT 1 FROM holidays WHERE holiday_date::date=$1::date) AS is_holiday,
       EXISTS (
         SELECT 1 FROM leave_requests
          WHERE emp_id=$2 AND status='Approved'
            AND $1::date BETWEEN from_date::date AND to_date::date
       ) AS is_leave`,
    [date, empId]
  );
  return !!(result.rows[0]?.is_holiday || result.rows[0]?.is_leave);
}

async function notifyRoles(roles, type, title, message, taskId = null) {
  const admins = await db.query(
    `SELECT username FROM admins WHERE status='Active' AND role=ANY($1::varchar[])`,
    [roles]
  );
  for (const admin of admins.rows) {
    await createNotif(admin.username, type, title, message, taskId);
  }
}

async function createMonitorAlert({
  employee, alertDate, alertType, severity = 'warning', title, message,
  referenceKey = '', metadata = {}, settings,
}) {
  const organizationId = Number(employee.organization_id);
  const repeatWindow = Number(settings.repeat_window_days || 30);
  const prior = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM employee_monitor_alerts
      WHERE emp_id=$1 AND alert_type=$2
        AND alert_date >= $3::date - ($4::int * INTERVAL '1 day')`,
    [employee.emp_id, alertType, alertDate, repeatWindow]
  );
  const occurrenceCount = Number(prior.rows[0]?.count || 0) + 1;
  const inserted = await db.query(
    `INSERT INTO employee_monitor_alerts
       (organization_id, emp_id, employee_name, designation, alert_date,
        alert_type, severity, title, message, reference_key, metadata, occurrence_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     ON CONFLICT (organization_id, emp_id, alert_date, alert_type, reference_key)
     DO UPDATE SET message=EXCLUDED.message, metadata=EXCLUDED.metadata, updated_at=NOW()
     RETURNING *, (xmax=0) AS was_created`,
    [
      organizationId, employee.emp_id, employee.employee_name,
      employee.designation || null, alertDate, alertType, severity,
      title, message, referenceKey || '', JSON.stringify(metadata), occurrenceCount,
    ]
  );
  const alert = inserted.rows[0];
  if (!alert.was_created) return alert;

  await addMonitorEvent(db, {
    alertId: alert.id,
    organizationId,
    eventType: 'Alert Created',
    newStatus: 'Open',
    actorType: 'system',
    actorId: 'monitor',
    actorName: 'Employee Monitor',
    remarks: message,
    metadata: { alert_type: alertType, occurrence_count: occurrenceCount },
  });
  await createNotif(employee.emp_id, 'employee_monitor_alert', title, message, metadata.task_id || null);

  if (occurrenceCount >= 3) {
    await notifyRoles(
      DIRECTOR_ROLES,
      'employee_monitor_escalation',
      `Repeated Monitor Violation: ${employee.employee_name}`,
      `${title} has occurred ${occurrenceCount} times within ${repeatWindow} days.`,
      metadata.task_id || null
    );
    await db.query(`UPDATE employee_monitor_alerts SET escalation_level=3 WHERE id=$1`, [alert.id]);
  } else if (occurrenceCount >= 2) {
    await notifyRoles(
      HR_ROLES,
      'employee_monitor_escalation',
      `Repeated Monitor Violation: ${employee.employee_name}`,
      `${title} has occurred ${occurrenceCount} times within ${repeatWindow} days.`,
      metadata.task_id || null
    );
    await db.query(`UPDATE employee_monitor_alerts SET escalation_level=2 WHERE id=$1`, [alert.id]);
  }
  return alert;
}

async function resolveAlertTypes(empId, alertTypes, reason, referenceKey = null, alertDate = null) {
  const params = [empId, alertTypes, CORRECTABLE_STATUSES];
  const extraConditions = [];
  if (referenceKey !== null) {
    params.push(referenceKey);
    extraConditions.push(`reference_key=$${params.length}`);
  }
  if (alertDate !== null) {
    params.push(alertDate);
    extraConditions.push(`alert_date=$${params.length}::date`);
  }
  params.push(reason);
  const reasonParameter = `$${params.length}`;
  const result = await db.query(
    `WITH pending AS (
       SELECT id, status AS old_status
         FROM employee_monitor_alerts
        WHERE emp_id=$1 AND alert_type=ANY($2::varchar[])
          AND status=ANY($3::varchar[])
          ${extraConditions.length ? `AND ${extraConditions.join(' AND ')}` : ''}
        FOR UPDATE
     )
     UPDATE employee_monitor_alerts a
        SET status='Auto Resolved', resolved_at=NOW(), resolution_reason=${reasonParameter}, updated_at=NOW()
       FROM pending
      WHERE a.id=pending.id
      RETURNING a.id, a.organization_id, pending.old_status`,
    params
  );
  for (const alert of result.rows) {
    await addMonitorEvent(db, {
      alertId: alert.id,
      organizationId: alert.organization_id,
      eventType: 'Auto Resolved',
      oldStatus: alert.old_status,
      newStatus: 'Auto Resolved',
      actorType: 'system',
      actorId: 'monitor',
      actorName: 'Employee Monitor',
      remarks: reason,
    });
  }
  return result.rows.length;
}

async function reconcileAttendanceAlerts(empId, alertDate = todayIST()) {
  const [attendanceResult, settingsResult] = await Promise.all([
    db.query(
      `SELECT first_in, last_out, late_minutes, final_status
         FROM daily_attendance WHERE emp_id=$1 AND date::date=$2::date LIMIT 1`,
      [empId, alertDate]
    ),
    db.query(`SELECT key, value FROM attendance_settings`),
  ]);
  const attendance = attendanceResult.rows[0];
  if (!attendance) return 0;
  const settings = Object.fromEntries(settingsResult.rows.map(row => [row.key, row.value]));
  const officeEnd = settings.OFFICE_END_TIME || '18:30:00';
  const fullDayMinutes = Number(settings.FULL_DAY_MINUTES || 480);
  let resolved = 0;

  if (Number(attendance.late_minutes || 0) <= 0 || attendance.final_status === 'Present') {
    resolved += await resolveAlertTypes(
      empId,
      ['late_arrival'],
      'The attendance correction removed the late-arrival exception.',
      null,
      alertDate
    );
  }
  if (attendance.last_out && (
    timeToMinutes(attendance.last_out) >= timeToMinutes(officeEnd)
    || attendance.final_status === 'Present'
  )) {
    resolved += await resolveAlertTypes(
      empId,
      ['early_departure'],
      'The approved attendance correction resolved the early-departure exception.',
      null,
      alertDate
    );
  }
  const worked = attendance.first_in && attendance.last_out
    ? Math.max(0, timeToMinutes(attendance.last_out) - timeToMinutes(attendance.first_in))
    : 0;
  if (worked >= fullDayMinutes || attendance.final_status === 'Present') {
    resolved += await resolveAlertTypes(
      empId,
      ['incomplete_hours'],
      'The approved attendance correction resolved the working-hours exception.',
      null,
      alertDate
    );
  }
  return resolved;
}

async function employeeContext(empId) {
  const result = await db.query(
    `SELECT e.emp_id, COALESCE(e.formal_name,e.name) AS employee_name,
            e.designation, e.organization_id
       FROM emplist e WHERE e.emp_id=$1 AND e.status='Active' LIMIT 1`,
    [empId]
  );
  return result.rows[0] || null;
}

async function evaluateEmployee(empId, options = {}) {
  const settings = options.settings || await getMonitorSettings();
  if (!settings.enabled) return [];
  const employee = await employeeContext(empId);
  if (!employee) return [];

  const alertDate = options.date || todayIST();
  if (await isExcludedWorkDate(empId, alertDate)) return [];
  const nowTime = options.time || currentTimeIST();
  const nowMinutes = timeToMinutes(nowTime);

  const [attendanceResult, activityResult, activeTasksResult, overdueResult, attendanceSettingsResult] = await Promise.all([
    db.query(
      `SELECT first_in, last_out, working_hours, late_minutes, final_status
         FROM daily_attendance WHERE emp_id=$1 AND date::date=$2::date LIMIT 1`,
      [empId, alertDate]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count FROM employee_work_activity
        WHERE emp_id=$1 AND activity_date=$2::date`,
      [empId, alertDate]
    ),
    db.query(
      `SELECT COUNT(*)::int AS count FROM tasks
        WHERE assigned_to_id=$1 AND active_flag=true
          AND status NOT IN ('Completed','Cancelled')`,
      [empId]
    ),
    db.query(
      `SELECT task_id, work_name, due_date FROM tasks
        WHERE assigned_to_id=$1 AND active_flag=true
          AND due_date<(NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND status NOT IN ('Completed','Cancelled')
        ORDER BY due_date ASC`,
      [empId]
    ),
    db.query(`SELECT key, value FROM attendance_settings`),
  ]);

  const attendance = attendanceResult.rows[0] || {};
  const activityCount = Number(activityResult.rows[0]?.count || 0);
  const activeTaskCount = Number(activeTasksResult.rows[0]?.count || 0);
  const overdueTasks = overdueResult.rows;
  const attendanceSettings = Object.fromEntries(attendanceSettingsResult.rows.map(row => [row.key, row.value]));
  const officeEnd = attendanceSettings.OFFICE_END_TIME || '18:30:00';
  const fullDayMinutes = Number(attendanceSettings.FULL_DAY_MINUTES || 480);
  const alerts = [];

  if (attendance.first_in && Number(attendance.late_minutes || 0) > 0) {
    alerts.push(await createMonitorAlert({
      employee, alertDate, alertType: 'late_arrival', severity: 'warning',
      title: 'Late Arrival',
      message: `You arrived ${attendance.late_minutes} minutes after the permitted reporting time.`,
      metadata: { first_in: attendance.first_in, late_minutes: Number(attendance.late_minutes) },
      settings,
    }));
  }

  if (attendance.last_out) {
    if (timeToMinutes(attendance.last_out) < timeToMinutes(officeEnd)) {
      alerts.push(await createMonitorAlert({
        employee, alertDate, alertType: 'early_departure', severity: 'critical',
        title: 'Early Departure',
        message: `You punched out at ${String(attendance.last_out).slice(0, 5)}, before the office closing time of ${String(officeEnd).slice(0, 5)}.`,
        metadata: { last_out: attendance.last_out, office_end: officeEnd },
        settings,
      }));
    }
    const worked = attendance.first_in && attendance.last_out
      ? Math.max(0, timeToMinutes(attendance.last_out) - timeToMinutes(attendance.first_in))
      : 0;
    if (worked < fullDayMinutes) {
      alerts.push(await createMonitorAlert({
        employee, alertDate, alertType: 'incomplete_hours', severity: 'critical',
        title: 'Required Working Hours Not Completed',
        message: `Your recorded working time is ${worked} minutes. The required full-day duration is ${fullDayMinutes} minutes.`,
        metadata: { worked_minutes: worked, required_minutes: fullDayMinutes },
        settings,
      }));
    }
  }

  if (attendance.first_in && nowMinutes >= timeToMinutes(settings.active_task_checkpoint)) {
    if (activeTaskCount === 0) {
      alerts.push(await createMonitorAlert({
        employee, alertDate, alertType: 'no_active_task', severity: 'critical',
        title: 'No Active Task Assigned',
        message: 'No active task is assigned to you. Create a self-assigned task or request an assignment.',
        metadata: { checkpoint: settings.active_task_checkpoint },
        settings,
      }));
    } else {
      await resolveAlertTypes(empId, ['no_active_task'], 'An active task is now assigned.', null, alertDate);
    }
  }

  if (attendance.first_in && nowMinutes >= timeToMinutes(settings.activity_checkpoint)) {
    if (activityCount === 0) {
      alerts.push(await createMonitorAlert({
        employee, alertDate, alertType: 'no_activity', severity: 'critical',
        title: 'No Meaningful Work Activity Recorded',
        message: 'No meaningful task creation, progress update, reassignment or completion has been recorded today.',
        metadata: { checkpoint: settings.activity_checkpoint },
        settings,
      }));
    } else {
      await resolveAlertTypes(empId, ['no_activity'], 'Meaningful task activity has been recorded.', null, alertDate);
    }
  }

  if (nowMinutes >= timeToMinutes(settings.overdue_reminder_time)) {
    if (overdueTasks.length) {
      alerts.push(await createMonitorAlert({
        employee, alertDate, alertType: 'overdue_work', severity: 'critical',
        title: 'Overdue Work Requires Attention',
        message: `${overdueTasks.length} active task${overdueTasks.length === 1 ? ' is' : 's are'} overdue.`,
        referenceKey: 'daily-overdue',
        metadata: {
          task_ids: overdueTasks.map(task => task.task_id),
          oldest_due_date: overdueTasks[0]?.due_date,
        },
        settings,
      }));
    } else {
      await resolveAlertTypes(empId, ['overdue_work'], 'No overdue active tasks remain.');
    }
  }
  return alerts.filter(Boolean);
}

async function escalateUnresolved(settings) {
  const alerts = await db.query(
    `SELECT id, organization_id, emp_id, employee_name, title, alert_date, escalation_level
       FROM employee_monitor_alerts
      WHERE status=ANY($1::varchar[])`,
    [UNRESOLVED_STATUSES]
  );
  for (const alert of alerts.rows) {
    const ageDays = Math.floor((Date.now() - new Date(`${dateKey(alert.alert_date)}T00:00:00+05:30`).getTime()) / 86400000) + 1;
    if (ageDays >= Number(settings.director_escalation_day || 3) && Number(alert.escalation_level) < 3) {
      await notifyRoles(DIRECTOR_ROLES, 'employee_monitor_escalation', `Critical Employee Monitor Alert: ${alert.employee_name}`, `${alert.title} remains unresolved since ${dateKey(alert.alert_date)}.`);
      await db.query(`UPDATE employee_monitor_alerts SET escalation_level=3, updated_at=NOW() WHERE id=$1`, [alert.id]);
      await addMonitorEvent(db, { alertId: alert.id, organizationId: alert.organization_id, eventType: 'Escalated to Director', actorType: 'system', actorId: 'monitor', actorName: 'Employee Monitor' });
    } else if (ageDays >= Number(settings.hr_escalation_day || 2) && Number(alert.escalation_level) < 2) {
      await notifyRoles(HR_ROLES, 'employee_monitor_escalation', `Employee Monitor Alert: ${alert.employee_name}`, `${alert.title} remains unresolved since ${dateKey(alert.alert_date)}.`);
      await db.query(`UPDATE employee_monitor_alerts SET escalation_level=2, updated_at=NOW() WHERE id=$1`, [alert.id]);
      await addMonitorEvent(db, { alertId: alert.id, organizationId: alert.organization_id, eventType: 'Escalated to HR', actorType: 'system', actorId: 'monitor', actorName: 'Employee Monitor' });
    }
  }
}

async function evaluateOrganization() {
  const settings = await getMonitorSettings();
  if (!settings.enabled) return { employees: 0 };
  const employees = await db.query(`SELECT emp_id FROM emplist WHERE status='Active'`);
  for (const employee of employees.rows) {
    try {
      await evaluateEmployee(employee.emp_id, { settings });
    } catch (error) {
      console.error(`[Employee Monitor] ${employee.emp_id}:`, error.message);
    }
  }
  await escalateUnresolved(settings);
  return { employees: employees.rows.length };
}

async function evaluateAllOrganizations() {
  const organizations = await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `SELECT id FROM organizations WHERE status='Active'`
  ));
  const results = [];
  for (const organization of organizations.rows) {
    const result = await db.runWithTenant(
      { organizationId: organization.id },
      () => evaluateOrganization()
    );
    results.push({ organization_id: organization.id, ...result });
  }
  return results;
}

async function getMonitorState(user, { evaluate = true } = {}) {
  if (!isEmployeeActor(user)) return { alerts: [], blocking: false, settings: DEFAULT_SETTINGS };
  const settings = await getMonitorSettings();
  if (!settings.enabled) {
    return {
      alerts: [],
      blocking: false,
      popup_repeat_minutes: Number(settings.popup_repeat_minutes || 60),
      settings,
      enabled: false,
    };
  }
  if (evaluate) await evaluateEmployee(user.emp_id, { settings });
  const result = await db.query(
    `SELECT id, alert_date, alert_type, severity, status, title, message,
            reference_key, metadata, occurrence_count, escalation_level,
            explanation, review_remark, created_at, last_popup_at
       FROM employee_monitor_alerts
      WHERE emp_id=$1 AND status=ANY($2::varchar[])
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, alert_date DESC, created_at DESC`,
    [user.emp_id, UNRESOLVED_STATUSES]
  );
  if (result.rows.length) {
    await db.query(
      `UPDATE employee_monitor_alerts SET last_popup_at=NOW()
        WHERE id=ANY($1::bigint[])`,
      [result.rows.map(row => row.id)]
    );
  }
  return {
    alerts: result.rows,
    blocking: result.rows.some(row => row.severity === 'critical' && ['Open', 'Rejected'].includes(row.status)),
    popup_repeat_minutes: Number(settings.popup_repeat_minutes || 60),
    settings,
    enabled: true,
  };
}

async function checkPunchOutBlock(user) {
  const settings = await getMonitorSettings();
  if (!isEmployeeActor(user) || !settings.enabled || !settings.block_punch_out_on_violation) {
    return { blocked: false, settings };
  }

  const alertDate = todayIST();
  await evaluateEmployee(user.emp_id, { settings, date: alertDate });

  const result = await db.query(
    `SELECT id, alert_date, alert_type, severity, status, title, message,
            reference_key, metadata, explanation, review_remark
       FROM employee_monitor_alerts
      WHERE emp_id=$1
        AND alert_date=$2::date
        AND alert_type=ANY($3::varchar[])
        AND status=ANY($4::varchar[])
      ORDER BY CASE alert_type WHEN 'no_active_task' THEN 0 ELSE 1 END, created_at ASC`,
    [user.emp_id, alertDate, ['no_active_task', 'no_activity'], UNRESOLVED_STATUSES]
  );

  if (!result.rows.length) return { blocked: false, settings };

  const actorName = user.formal_name || user.name || user.emp_id;
  for (const alert of result.rows) {
    await addMonitorEvent(db, {
      alertId: alert.id,
      organizationId: Number(user.organization_id),
      eventType: 'Punch OUT Blocked',
      oldStatus: alert.status,
      newStatus: alert.status,
      actorType: 'employee',
      actorId: user.emp_id,
      actorName,
      remarks: 'Punch OUT was blocked because required task activity was not completed.',
      metadata: {
        alert_type: alert.alert_type,
        required_actions: [
          'Create or self-assign an active task',
          'Record a meaningful task update',
          'Submit an explanation for HR or Director review',
        ],
      },
    });
  }

  return {
    blocked: true,
    settings,
    blocking_alerts: result.rows,
    required_actions: [
      'Create or self-assign an active task',
      'Record a meaningful task update',
      'Submit an explanation for HR or Director approval',
    ],
  };
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
    const monitorAlerts = await conn.query(
      `WITH pending AS (
         SELECT id, status AS old_status
           FROM employee_monitor_alerts
          WHERE emp_id=$1 AND alert_type='no_activity' AND alert_date=$2
            AND status=ANY($3::varchar[])
          FOR UPDATE
       )
       UPDATE employee_monitor_alerts a
          SET status='Auto Resolved', resolved_at=NOW(),
              resolution_reason='Meaningful task activity was recorded.', updated_at=NOW()
         FROM pending
        WHERE a.id=pending.id
        RETURNING a.id, pending.old_status`,
      [user.emp_id, activityDate, CORRECTABLE_STATUSES]
    );
    for (const alert of monitorAlerts.rows) {
      await addMonitorEvent(conn, {
        alertId: alert.id,
        organizationId,
        eventType: 'Auto Resolved by Task Activity',
        oldStatus: alert.old_status,
        newStatus: 'Auto Resolved',
        actorType: 'employee',
        actorId: user.emp_id,
        actorName: user.formal_name || user.name,
        remarks: description,
        metadata: { activity_id: inserted.rows[0].id, task_id: taskId, activity_type: activityType },
      });
    }
    if (ownsConnection) await conn.query('COMMIT');
    return inserted.rows[0].id;
  } catch (error) {
    if (ownsConnection) await conn.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsConnection) conn.release();
  }
}

async function evaluatePunchOut({ user }) {
  if (!isEmployeeActor(user)) return [];
  return evaluateEmployee(user.emp_id);
}

async function getTodayState(user) {
  const date = todayIST();
  const [attendance, activity, monitor] = await Promise.all([
    db.query(`SELECT first_in, last_out, final_status FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`, [user.emp_id, date]),
    db.query(`SELECT COUNT(*)::int AS count FROM employee_work_activity WHERE emp_id=$1 AND activity_date=$2`, [user.emp_id, date]),
    getMonitorState(user),
  ]);
  return {
    date,
    punched_in: !!attendance.rows[0]?.first_in,
    punched_out: !!attendance.rows[0]?.last_out,
    activity_count: Number(activity.rows[0]?.count || 0),
    alert: monitor.alerts.find(row => row.alert_type === 'no_activity') || null,
    monitor,
  };
}

module.exports = {
  REVIEW_ROLES,
  UNRESOLVED_STATUSES,
  DEFAULT_SETTINGS,
  todayIST,
  meaningfulTaskChange,
  recordWorkActivity,
  evaluateEmployee,
  reconcileAttendanceAlerts,
  evaluateOrganization,
  evaluateAllOrganizations,
  evaluatePunchOut,
  checkPunchOutBlock,
  getMonitorState,
  getMonitorSettings,
  getTodayState,
  addAlertHistory,
  addMonitorEvent,
};
