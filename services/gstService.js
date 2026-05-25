const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const {
  RETURN_TYPES,
  GST_STATUSES,
  cleanText,
  normalizeGstNo,
  isGstAdmin,
  nowIST,
  todayIST,
  periodEndDate,
  periodLabel,
  financialYearForPeriod,
  getDueDate,
  isQuarterEndingMonth,
} = require('../utils/gstUtils');

function actorName(actor = {}) {
  return actor.formal_name || actor.name || actor.emp_name || 'System';
}

function actorId(actor = {}) {
  return actor.emp_id || actor.id || 'SYSTEM';
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

async function logGST(conn, payload) {
  await conn.query(
    `INSERT INTO gst_history_log
      (gst_client_id, filing_id, action, old_value, new_value, remarks, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      payload.gst_client_id || null,
      payload.filing_id || null,
      payload.action,
      payload.old_value ? JSON.stringify(payload.old_value) : null,
      payload.new_value ? JSON.stringify(payload.new_value) : null,
      payload.remarks || null,
      actorId(payload.actor),
      actorName(payload.actor),
    ]
  );
}

async function findEmployee(conn, empId) {
  if (!empId) return null;
  const r = await conn.query(
    `SELECT emp_id, formal_name, name
     FROM (
       SELECT emp_id, formal_name, name FROM emplist WHERE emp_id=$1 AND status='Active'
       UNION ALL
       SELECT username AS emp_id, name AS formal_name, name FROM admins WHERE username=$1 AND status='Active'
     ) x
     LIMIT 1`,
    [empId]
  );
  return r.rows[0] || null;
}

async function findClient(conn, clientId) {
  const r = await conn.query(
    `SELECT client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, drive_link
     FROM clients WHERE client_id=$1 LIMIT 1`,
    [clientId]
  );
  return r.rows[0] || null;
}

function orgTaskPrefix(actor = {}) {
  return String(actor.organization_code || 'ORG').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8) || 'ORG';
}

async function nextTaskId(conn, actor) {
  const now = nowIST();
  const dateKey = now.toISOString().slice(0, 10).replace(/-/g, '');
  const countRes = await conn.query(`SELECT COUNT(*) FROM tasks WHERE created_at::date = CURRENT_DATE`);
  const base = parseInt(countRes.rows[0].count, 10) + 1;
  const prefix = orgTaskPrefix(actor);

  for (let offset = 0; offset < 20; offset += 1) {
    const taskId = `TSK${prefix}-${dateKey}-${String(base + offset).padStart(3, '0')}`;
    const exists = await conn.query('SELECT 1 FROM tasks WHERE task_id=$1', [taskId]);
    if (!exists.rows.length) return taskId;
  }
  return `TSK${prefix}-${dateKey}-${uuidv4().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

async function createTaskForFiling(conn, gstClient, filing, actor) {
  if (!filing.assigned_to_id) return null;

  const client = await findClient(conn, gstClient.client_id);
  const taskId = await nextTaskId(conn, actor);
  const createdAt = nowIST();
  const createdById = actorId(actor);
  const createdByName = actorName(actor);
  const assigneeName = filing.assigned_to_name || gstClient.default_assignee_name || filing.assigned_to_id;
  const workName = `${filing.return_type} Filing`;
  const description = `${filing.return_type} filing for ${gstClient.firm_name || gstClient.client_id} - ${periodLabel(filing.tax_year, filing.tax_month)}`;

  await conn.query(
    `INSERT INTO tasks
      (task_id, created_at, created_by_id, created_by_name, assigned_to_id, assigned_to_name,
       client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, drive_link,
       work_name, work_description, priority, status, due_date, internal_remark,
       self_assigned, billing_status, active_flag)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'Medium','Pending',$17,$18,$19,'Not Applicable',true)`,
    [
      taskId,
      createdAt,
      createdById,
      createdByName,
      filing.assigned_to_id,
      assigneeName,
      gstClient.client_id,
      client?.agent_id || gstClient.agent_id || null,
      client?.agent_name || gstClient.agent_name || null,
      client?.legal_name || gstClient.firm_name || null,
      gstClient.firm_name || client?.business_name || null,
      client?.mobile_number || null,
      client?.email_id || null,
      client?.drive_link || null,
      workName,
      description,
      filing.due_date,
      `Auto GST task: ${filing.return_type} ${periodLabel(filing.tax_year, filing.tax_month)}`,
      createdById === filing.assigned_to_id,
    ]
  );

  await conn.query(
    `INSERT INTO task_history
      (log_id, task_id, action, new_status, new_assigned_to, new_due_date,
       updated_by_id, updated_by_name, updated_at, remark)
     VALUES ($1,$2,'Created','Pending',$3,$4,$5,$6,NOW(),$7)`,
    [
      `LOG_${uuidv4().replace(/-/g, '').slice(0, 10)}`,
      taskId,
      assigneeName,
      filing.due_date,
      createdById,
      createdByName,
      'Created from GST filing tracker',
    ]
  );

  return taskId;
}

function taskStatusForGST(status) {
  if (status === 'Filed') return 'Completed';
  if (status === 'Not Applicable') return 'Cancelled';
  if (status === 'Pending by Client') return 'Waiting for Client';
  return 'Pending';
}

function gstStatusForTask(status) {
  if (status === 'Completed') return 'Filed';
  if (status === 'Waiting for Client') return 'Pending by Client';
  if (['Pending', 'In Progress', 'Waiting for Government', 'Under Review', 'On Hold', 'Reassigned'].includes(status)) {
    return 'Pending';
  }
  return null;
}

async function syncTaskForFiling(conn, filing, status, actor, remark) {
  if (!filing.linked_task_id) return;

  const oldTask = await conn.query('SELECT * FROM tasks WHERE task_id=$1', [filing.linked_task_id]);
  if (!oldTask.rows.length) return;

  const old = oldTask.rows[0];
  const taskStatus = taskStatusForGST(status);
  const completionDate = ['Completed', 'Cancelled'].includes(taskStatus) ? todayIST() : null;
  await conn.query(
    `UPDATE tasks SET
       status=$1,
       completion_date=$2,
       client_pending_remark=CASE WHEN $3='Waiting for Client' THEN COALESCE($4, client_pending_remark) ELSE client_pending_remark END,
       completion_remark=CASE WHEN $3 IN ('Completed','Cancelled') THEN COALESCE($4, completion_remark) ELSE completion_remark END,
       last_updated_at=NOW(),
       last_updated_by_id=$5,
       last_updated_by_name=$6
     WHERE task_id=$7`,
    [taskStatus, completionDate, taskStatus, remark || null, actorId(actor), actorName(actor), filing.linked_task_id]
  );

  await conn.query(
    `INSERT INTO task_history
      (log_id, task_id, action, old_status, new_status, old_assigned_to, new_assigned_to,
       old_due_date, new_due_date, updated_by_id, updated_by_name, updated_at, remark)
     VALUES ($1,$2,'GST Status Sync',$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)`,
    [
      `LOG_${uuidv4().replace(/-/g, '').slice(0, 10)}`,
      filing.linked_task_id,
      old.status,
      taskStatus,
      old.assigned_to_name,
      old.assigned_to_name,
      old.due_date,
      old.due_date,
      actorId(actor),
      actorName(actor),
      remark || `GST filing marked ${status}`,
    ]
  );
}

async function syncGSTForTaskStatus(conn, task, status, actor, remark) {
  const gstStatus = gstStatusForTask(status);
  if (!gstStatus) return null;

  let filingRes;
  try {
    filingRes = await conn.query(
      `SELECT * FROM gst_filing_records WHERE linked_task_id=$1 FOR UPDATE`,
      [task.task_id]
    );
  } catch (err) {
    if (err.code === '42P01') return null;
    throw err;
  }
  if (!filingRes.rows.length) return null;

  const filing = filingRes.rows[0];
  const admin = isGstAdmin(actor);
  const assigned = filing.assigned_to_id === actor.emp_id || task.assigned_to_id === actor.emp_id;
  if (!admin && !assigned) {
    const err = new Error('Only assigned employee or admin can update linked GST filing status');
    err.statusCode = 403;
    throw err;
  }
  if (!admin && filing.status === 'Filed' && dateOnly(filing.filed_date_ist) && dateOnly(filing.filed_date_ist) < todayIST() && gstStatus !== 'Filed') {
    const err = new Error('Filed GST record is locked. Admin can reopen it.');
    err.statusCode = 403;
    throw err;
  }
  if (filing.status === gstStatus) return { filing_id: filing.id, status: gstStatus, changed: false };

  const filedDate = gstStatus === 'Filed' ? todayIST() : null;
  const filedAtSql = gstStatus === 'Filed' ? 'NOW()' : 'NULL';
  await conn.query(
    `UPDATE gst_filing_records SET
       status=$1,
       filed_date_ist=$2,
       filed_at=${filedAtSql},
       status_updated_by_id=$3,
       status_updated_by_name=$4,
       last_status_at=NOW(),
       updated_at=NOW()
     WHERE id=$5`,
    [gstStatus, filedDate, actorId(actor), actorName(actor), filing.id]
  );
  await logGST(conn, {
    gst_client_id: filing.gst_client_id,
    filing_id: filing.id,
    action: filing.status === 'Filed' && gstStatus !== 'Filed' ? (admin ? 'AdminTaskRewriteStatus' : 'TaskRewriteFiledSameDay') : 'TaskStatusSync',
    old_value: { status: filing.status, task_status: task.status },
    new_value: { status: gstStatus, task_status: status },
    remarks: remark || `Task marked ${status}`,
    actor,
  });
  return { filing_id: filing.id, status: gstStatus, changed: true };
}

async function createOrAttachFiling(conn, gstClient, returnType, taxYear, taxMonth, actor, source = 'manual') {
  const frequency = gstClient.filing_frequency || 'Monthly';
  if (frequency === 'QRMP' && !isQuarterEndingMonth(taxMonth)) {
    return { skipped: true, reason: 'QRMP_NON_QUARTER_MONTH' };
  }

  const dueDate = getDueDate({
    taxYear,
    taxMonth,
    returnType,
    frequency,
    qrmpGstr3bDueDay: gstClient.qrmp_gstr3b_due_day || 22,
  });
  const assignedToId = gstClient.default_assignee_id || null;
  const assignedToName = gstClient.default_assignee_name || null;
  const fy = financialYearForPeriod(taxYear, taxMonth);

  let filingRes = await conn.query(
    `INSERT INTO gst_filing_records
      (gst_client_id, client_id, firm_name, gst_no, return_type, tax_year, tax_month,
       financial_year, period_label, due_date, assigned_to_id, assigned_to_name,
       status, generated_from, created_by_id, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Not Started',$13,$14,$15)
     ON CONFLICT (gst_client_id, tax_year, tax_month, return_type) DO NOTHING
     RETURNING *`,
    [
      gstClient.id,
      gstClient.client_id,
      gstClient.firm_name,
      normalizeGstNo(gstClient.gst_no),
      returnType,
      taxYear,
      taxMonth,
      fy,
      periodLabel(taxYear, taxMonth),
      dueDate,
      assignedToId,
      assignedToName,
      source,
      actorId(actor),
      actorName(actor),
    ]
  );

  let created = true;
  if (!filingRes.rows.length) {
    created = false;
    filingRes = await conn.query(
      `SELECT * FROM gst_filing_records
       WHERE gst_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND return_type=$4`,
      [gstClient.id, taxYear, taxMonth, returnType]
    );
  }

  const filing = filingRes.rows[0];
  if (!filing) return { skipped: true, reason: 'NO_FILING_ROW' };

  let taskId = filing.linked_task_id;
  if (!taskId && !['Filed', 'Not Applicable'].includes(filing.status) && filing.assigned_to_id) {
    taskId = await createTaskForFiling(conn, gstClient, filing, actor);
    if (taskId) {
      await conn.query(
        `UPDATE gst_filing_records SET linked_task_id=$1, updated_at=NOW() WHERE id=$2`,
        [taskId, filing.id]
      );
    }
  }

  if (created) {
    await logGST(conn, {
      gst_client_id: gstClient.id,
      filing_id: filing.id,
      action: 'GenerateFiling',
      new_value: { return_type: returnType, tax_year: taxYear, tax_month: taxMonth, task_id: taskId },
      actor,
    });
  }

  return { created, task_created: Boolean(taskId && taskId !== filing.linked_task_id), filing_id: filing.id, task_id: taskId };
}

async function generateFilingsForPeriod({ taxYear, taxMonth, actor, source = 'manual' }) {
  const conn = await db.pool.connect();
  const summary = {
    tax_year: Number(taxYear),
    tax_month: Number(taxMonth),
    clients_seen: 0,
    filings_created: 0,
    tasks_created: 0,
    existing: 0,
    skipped: 0,
    errors: [],
  };

  try {
    await conn.query('BEGIN');
    const periodEnd = periodEndDate(Number(taxYear), Number(taxMonth));
    const clients = await conn.query(
      `SELECT * FROM gst_clients
       WHERE status='Active'
         AND (inactive_from IS NULL OR inactive_from::date > $1::date)
       ORDER BY firm_name, id`,
      [periodEnd]
    );
    summary.clients_seen = clients.rows.length;

    for (const gstClient of clients.rows) {
      for (const returnType of RETURN_TYPES) {
        const result = await createOrAttachFiling(conn, gstClient, returnType, Number(taxYear), Number(taxMonth), actor, source);
        if (result.skipped) summary.skipped += 1;
        else if (result.created) summary.filings_created += 1;
        else summary.existing += 1;
        if (result.task_created) summary.tasks_created += 1;
      }
    }

    await conn.query('COMMIT');
    return summary;
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function updateFilingStatus(filingId, status, remark, actor) {
  if (!GST_STATUSES.includes(status)) {
    const err = new Error('Invalid GST status');
    err.statusCode = 400;
    throw err;
  }

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const r = await conn.query('SELECT * FROM gst_filing_records WHERE id=$1 FOR UPDATE', [filingId]);
    if (!r.rows.length) {
      const err = new Error('GST filing not found');
      err.statusCode = 404;
      throw err;
    }
    const filing = r.rows[0];
    const admin = isGstAdmin(actor);
    const assigned = filing.assigned_to_id === actor.emp_id;
    if (!admin && !assigned) {
      const err = new Error('Only assigned employee or admin can update this GST filing');
      err.statusCode = 403;
      throw err;
    }
    if (!admin && filing.status === 'Filed' && dateOnly(filing.filed_date_ist) && dateOnly(filing.filed_date_ist) < todayIST()) {
      const err = new Error('Filed GST record is locked. Admin can reopen it.');
      err.statusCode = 403;
      throw err;
    }

    const filedDate = status === 'Filed' ? todayIST() : null;
    const filedAtSql = status === 'Filed' ? 'NOW()' : 'NULL';
    await conn.query(
      `UPDATE gst_filing_records SET
         status=$1,
         filed_date_ist=$2,
         filed_at=${filedAtSql},
         status_updated_by_id=$3,
         status_updated_by_name=$4,
         last_status_at=NOW(),
         updated_at=NOW()
       WHERE id=$5`,
      [status, filedDate, actorId(actor), actorName(actor), filingId]
    );

    await logGST(conn, {
      gst_client_id: filing.gst_client_id,
      filing_id: filing.id,
      action: filing.status === 'Filed' && status !== 'Filed' ? (admin ? 'AdminRewriteStatus' : 'RewriteFiledSameDay') : 'UpdateStatus',
      old_value: { status: filing.status },
      new_value: { status },
      remarks: remark,
      actor,
    });

    await syncTaskForFiling(conn, filing, status, actor, remark);
    await conn.query('COMMIT');
    return { success: true };
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function assignFiling(filingId, assigneeId, remark, actor) {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const employee = await findEmployee(conn, assigneeId);
    if (!employee) {
      const err = new Error('Active employee not found');
      err.statusCode = 400;
      throw err;
    }

    const r = await conn.query('SELECT * FROM gst_filing_records WHERE id=$1 FOR UPDATE', [filingId]);
    if (!r.rows.length) {
      const err = new Error('GST filing not found');
      err.statusCode = 404;
      throw err;
    }
    const filing = r.rows[0];
    const admin = isGstAdmin(actor);
    const assigned = filing.assigned_to_id === actor.emp_id;
    const unassigned = !filing.assigned_to_id;
    if (!admin && !assigned && !unassigned) {
      const err = new Error('Only assigned employee or admin can reassign this GST filing');
      err.statusCode = 403;
      throw err;
    }

    const assigneeName = employee.formal_name || employee.name;
    await conn.query(
      `UPDATE gst_filing_records SET assigned_to_id=$1, assigned_to_name=$2, updated_at=NOW() WHERE id=$3`,
      [employee.emp_id, assigneeName, filingId]
    );

    if (filing.linked_task_id) {
      const oldTask = await conn.query('SELECT assigned_to_name, due_date FROM tasks WHERE task_id=$1', [filing.linked_task_id]);
      await conn.query(
        `UPDATE tasks SET assigned_to_id=$1, assigned_to_name=$2, last_updated_at=NOW(),
          last_updated_by_id=$3, last_updated_by_name=$4 WHERE task_id=$5`,
        [employee.emp_id, assigneeName, actorId(actor), actorName(actor), filing.linked_task_id]
      );
      await conn.query(
        `INSERT INTO task_history
          (log_id, task_id, action, old_assigned_to, new_assigned_to, old_due_date, new_due_date,
           updated_by_id, updated_by_name, updated_at, remark)
         VALUES ($1,$2,'GST Reassigned',$3,$4,$5,$6,$7,$8,NOW(),$9)`,
        [
          `LOG_${uuidv4().replace(/-/g, '').slice(0, 10)}`,
          filing.linked_task_id,
          oldTask.rows[0]?.assigned_to_name || filing.assigned_to_name,
          assigneeName,
          oldTask.rows[0]?.due_date || filing.due_date,
          oldTask.rows[0]?.due_date || filing.due_date,
          actorId(actor),
          actorName(actor),
          remark || 'GST filing reassigned',
        ]
      );
    } else if (!['Filed', 'Not Applicable'].includes(filing.status)) {
      const client = await conn.query('SELECT * FROM gst_clients WHERE id=$1', [filing.gst_client_id]);
      const updatedFiling = { ...filing, assigned_to_id: employee.emp_id, assigned_to_name: assigneeName };
      const taskId = await createTaskForFiling(conn, client.rows[0], updatedFiling, actor);
      if (taskId) {
        await conn.query('UPDATE gst_filing_records SET linked_task_id=$1 WHERE id=$2', [taskId, filingId]);
      }
    }

    await logGST(conn, {
      gst_client_id: filing.gst_client_id,
      filing_id: filing.id,
      action: 'ReassignFiling',
      old_value: { assigned_to_id: filing.assigned_to_id, assigned_to_name: filing.assigned_to_name },
      new_value: { assigned_to_id: employee.emp_id, assigned_to_name: assigneeName },
      remarks: remark,
      actor,
    });

    await conn.query('COMMIT');
    return { assignee_id: employee.emp_id, assignee_name: assigneeName };
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function assignUnassignedFilingsForClient(conn, gstClientId, employee, actor, options = {}) {
  const clientRes = await conn.query('SELECT * FROM gst_clients WHERE id=$1', [gstClientId]);
  const gstClient = clientRes.rows[0];
  if (!gstClient || !employee) return { updated: 0, tasks_created: 0 };

  const taxYear = Number(options.taxYear);
  const taxMonth = Number(options.taxMonth);
  const assigneeName = employee.formal_name || employee.name;
  const filings = [];

  if (taxYear && taxMonth) {
    if (gstClient.filing_frequency === 'QRMP' && !isQuarterEndingMonth(taxMonth)) {
      return { updated: 0, tasks_created: 0, skipped: 'QRMP_NON_QUARTER_MONTH' };
    }

    for (const returnType of RETURN_TYPES) {
      const dueDate = getDueDate({
        taxYear,
        taxMonth,
        returnType,
        frequency: gstClient.filing_frequency || 'Monthly',
        qrmpGstr3bDueDay: gstClient.qrmp_gstr3b_due_day || 22,
      });
      const created = await conn.query(
        `INSERT INTO gst_filing_records
          (gst_client_id, client_id, firm_name, gst_no, return_type, tax_year, tax_month,
           financial_year, period_label, due_date, assigned_to_id, assigned_to_name,
           status, generated_from, created_by_id, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Not Started',$13,$14,$15)
         ON CONFLICT (gst_client_id, tax_year, tax_month, return_type) DO NOTHING
         RETURNING *`,
        [
          gstClient.id,
          gstClient.client_id,
          gstClient.firm_name,
          normalizeGstNo(gstClient.gst_no),
          returnType,
          taxYear,
          taxMonth,
          financialYearForPeriod(taxYear, taxMonth),
          periodLabel(taxYear, taxMonth),
          dueDate,
          employee.emp_id,
          assigneeName,
          options.source || 'manual',
          actorId(actor),
          actorName(actor),
        ]
      );

      if (created.rows.length) {
        filings.push(created.rows[0]);
      } else {
        const existing = await conn.query(
          `SELECT gf.*, t.task_id AS active_task_id
           FROM gst_filing_records gf
           LEFT JOIN tasks t ON t.task_id=gf.linked_task_id AND t.active_flag=true
           WHERE gf.gst_client_id=$1 AND gf.tax_year=$2 AND gf.tax_month=$3 AND gf.return_type=$4
           FOR UPDATE OF gf`,
          [gstClient.id, taxYear, taxMonth, returnType]
        );
        const filing = existing.rows[0];
        if (
          filing &&
          !['Filed', 'Not Applicable'].includes(filing.status) &&
          (!filing.assigned_to_id || !filing.linked_task_id || !filing.active_task_id)
        ) {
          filings.push(filing);
        }
      }
    }
  } else {
    const existing = await conn.query(
      `SELECT gf.*, t.task_id AS active_task_id
       FROM gst_filing_records gf
       LEFT JOIN tasks t ON t.task_id=gf.linked_task_id AND t.active_flag=true
       WHERE gf.gst_client_id=$1
         AND gf.status NOT IN ('Filed','Not Applicable')
         AND (COALESCE(gf.assigned_to_id,'')='' OR gf.linked_task_id IS NULL OR t.task_id IS NULL)
       ORDER BY gf.tax_year, gf.tax_month, gf.return_type
       FOR UPDATE OF gf`,
      [gstClientId]
    );
    filings.push(...existing.rows);
  }

  let tasksCreated = 0;
  let updated = 0;

  for (const filing of filings) {
    const oldAssignedId = filing.assigned_to_id;
    const oldAssignedName = filing.assigned_to_name;
    await conn.query(
      `UPDATE gst_filing_records
       SET assigned_to_id=$1, assigned_to_name=$2, updated_at=NOW()
       WHERE id=$3`,
      [employee.emp_id, assigneeName, filing.id]
    );

    if (filing.linked_task_id && filing.active_task_id) {
      await conn.query(
        `UPDATE tasks
         SET assigned_to_id=$1, assigned_to_name=$2,
             last_updated_at=NOW(), last_updated_by_id=$3, last_updated_by_name=$4
         WHERE task_id=$5`,
        [employee.emp_id, assigneeName, actorId(actor), actorName(actor), filing.linked_task_id]
      );
    } else {
      const updatedFiling = { ...filing, assigned_to_id: employee.emp_id, assigned_to_name: assigneeName };
      const taskId = await createTaskForFiling(conn, gstClient, updatedFiling, actor);
      if (taskId) {
        tasksCreated += 1;
        await conn.query(
          'UPDATE gst_filing_records SET linked_task_id=$1, updated_at=NOW() WHERE id=$2',
          [taskId, filing.id]
        );
      }
    }
    updated += 1;

    await logGST(conn, {
      gst_client_id: gstClientId,
      filing_id: filing.id,
      action: 'AssignUnassignedFiling',
      old_value: { assigned_to_id: oldAssignedId, assigned_to_name: oldAssignedName, linked_task_id: filing.linked_task_id },
      new_value: { assigned_to_id: employee.emp_id, assigned_to_name: assigneeName },
      remarks: options.remark || 'Assigned from unassigned GST client',
      actor,
    });
  }

  return { updated, tasks_created: tasksCreated };
}

module.exports = {
  logGST,
  findEmployee,
  findClient,
  generateFilingsForPeriod,
  updateFilingStatus,
  assignFiling,
  assignUnassignedFilingsForClient,
  syncGSTForTaskStatus,
};
