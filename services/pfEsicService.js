const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const {
  PF_ESIC_STATUSES,
  PF_ESIC_TYPES,
  cleanText,
  nowIST,
  todayIST,
  isPFESICAdmin,
  financialYearForPeriod,
  periodLabel,
  dueDateForPeriod,
} = require('../utils/pfEsicUtils');

function actorName(actor = {}) {
  return actor.formal_name || actor.name || actor.emp_name || 'System';
}

function actorId(actor = {}) {
  return actor.emp_id || actor.id || actor.username || 'SYSTEM';
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

async function logPFESIC(conn, payload) {
  await conn.query(
    `INSERT INTO pf_esic_history_log
      (pf_esic_client_id, filing_id, action, old_value, new_value, remarks, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      payload.pf_esic_client_id || null,
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
    `SELECT emp_id, formal_name, name, designation, photo_url
       FROM (
         SELECT emp_id, formal_name, name, designation, photo_url FROM emplist WHERE emp_id=$1 AND status='Active'
         UNION ALL
         SELECT username AS emp_id, name AS formal_name, name, role AS designation, photo_url FROM admins WHERE username=$1 AND status='Active'
       ) x
      LIMIT 1`,
    [empId]
  );
  return r.rows[0] || null;
}

async function findClient(conn, clientId) {
  if (!clientId) return null;
  const r = await conn.query(`SELECT * FROM clients WHERE client_id=$1 LIMIT 1`, [clientId]);
  return r.rows[0] || null;
}

async function orgTaskPrefix(conn) {
  const r = await conn.query(`SELECT org_code FROM organizations WHERE id=current_organization_id() LIMIT 1`);
  const code = cleanText(r.rows[0]?.org_code || 'PTP').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return code || 'PTP';
}

async function nextTaskId(conn) {
  const prefix = await orgTaskPrefix(conn);
  const stamp = nowIST().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await conn.query(`SELECT COUNT(*)::int AS cnt FROM tasks WHERE task_id LIKE $1`, [`TSK${prefix}-${stamp}-%`]);
  const next = Number(r.rows[0]?.cnt || 0) + 1;
  return `TSK${prefix}-${stamp}-${String(next).padStart(3, '0')}`;
}

function taskStatusForPFESIC(status) {
  if (status === 'Filed' || status === 'Paid') return 'Completed';
  if (status === 'Pending by Client') return 'Waiting for Client';
  if (status === 'Not Applicable') return 'Cancelled';
  return 'Pending';
}

function pfEsicStatusForTask(taskStatus, complianceType) {
  if (taskStatus === 'Completed') {
    return String(complianceType || '').includes('Challan Payment') ? 'Paid' : 'Filed';
  }
  if (taskStatus === 'Waiting for Client') return 'Pending by Client';
  if (taskStatus === 'Cancelled') return 'Not Applicable';
  if (['Pending', 'In Progress', 'Under Process', 'Reassigned'].includes(taskStatus)) return 'Pending';
  return null;
}

async function createTaskForFiling(conn, pfClient, filing, actor) {
  if (!filing.assigned_to_id) return null;
  if (filing.linked_task_id) return filing.linked_task_id;
  const baseClient = await findClient(conn, pfClient.client_id);
  const taskId = await nextTaskId(conn);
  const createdAt = nowIST();
  const createdById = actorId(actor);
  const createdByName = actorName(actor);
  const assigneeName = filing.assigned_to_name || pfClient.default_assignee_name || filing.assigned_to_id;
  const workName = filing.compliance_type;
  const description = `${filing.compliance_type} for ${pfClient.firm_name || pfClient.client_id} - ${filing.period_label}`;

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
      pfClient.client_id,
      baseClient?.agent_id || pfClient.agent_id || null,
      baseClient?.agent_name || pfClient.agent_name || null,
      baseClient?.legal_name || pfClient.firm_name || null,
      baseClient?.business_name || pfClient.firm_name || null,
      baseClient?.mobile_number || null,
      baseClient?.email_id || null,
      baseClient?.drive_link || null,
      workName,
      description,
      dateOnly(filing.due_date),
      `Linked PF/ESIC monthly tracker #${filing.id}`,
      createdById === filing.assigned_to_id,
    ]
  );
  await conn.query(
    `INSERT INTO task_history (log_id, task_id, action, new_status, new_assigned_to, new_due_date, updated_by_id, updated_by_name, updated_at, remark)
     VALUES ($1,$2,'Created','Pending',$3,$4,$5,$6,NOW(),$7)`,
    ['LOG_' + uuidv4().replace(/-/g, '').slice(0, 10), taskId, assigneeName, dateOnly(filing.due_date), createdById, createdByName, 'Created from PF/ESIC tracker']
  );
  await conn.query(`UPDATE pf_esic_filing_records SET linked_task_id=$1, updated_at=NOW() WHERE id=$2`, [taskId, filing.id]);
  await logPFESIC(conn, {
    pf_esic_client_id: pfClient.id,
    filing_id: filing.id,
    action: 'task_created',
    new_value: { task_id: taskId },
    actor,
  });
  return taskId;
}

async function syncTaskForFiling(conn, filing, actor) {
  if (!filing.linked_task_id) return;
  const taskStatus = taskStatusForPFESIC(filing.status);
  await conn.query(
    `UPDATE tasks
        SET status=$1,
            assigned_to_id=COALESCE($2, assigned_to_id),
            assigned_to_name=COALESCE($3, assigned_to_name),
            due_date=COALESCE($4::date, due_date),
            completion_date=CASE WHEN $1 IN ('Completed','Cancelled') AND completion_date IS NULL THEN CURRENT_DATE ELSE completion_date END,
            last_updated_at=NOW(),
            last_updated_by_id=$5,
            last_updated_by_name=$6
      WHERE task_id=$7`,
    [taskStatus, filing.assigned_to_id || null, filing.assigned_to_name || null, dateOnly(filing.due_date), actorId(actor), actorName(actor), filing.linked_task_id]
  );
}

async function createOrAttachFiling(conn, pfClient, complianceType, taxYear, taxMonth, actor, source = 'manual') {
  const isPF = complianceType.startsWith('PF');
  const isESIC = complianceType.startsWith('ESIC');
  if (isPF && !cleanText(pfClient.pf_establishment_code)) return { skipped: true };
  if (isESIC && !cleanText(pfClient.esic_code)) return { skipped: true };
  const dueDate = dueDateForPeriod(taxYear, taxMonth);
  const fy = financialYearForPeriod(taxYear, taxMonth);
  const period = periodLabel(taxYear, taxMonth);
  const existing = await conn.query(
    `SELECT * FROM pf_esic_filing_records
      WHERE pf_esic_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND compliance_type=$4
      LIMIT 1`,
    [pfClient.id, taxYear, taxMonth, complianceType]
  );
  if (existing.rows.length) {
    const row = existing.rows[0];
    if (row.assigned_to_id && !row.linked_task_id) await createTaskForFiling(conn, pfClient, row, actor);
    return { existing: true, task_created: Boolean(row.assigned_to_id && !row.linked_task_id) };
  }
  const inserted = await conn.query(
    `INSERT INTO pf_esic_filing_records
      (pf_esic_client_id, client_id, firm_name, pf_establishment_code, esic_code, compliance_type,
       tax_year, tax_month, financial_year, period_label, due_date, assigned_to_id, assigned_to_name,
       status, generated_from, created_by_id, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending',$14,$15,$16)
     RETURNING *`,
    [
      pfClient.id,
      pfClient.client_id,
      pfClient.firm_name,
      pfClient.pf_establishment_code || null,
      pfClient.esic_code || null,
      complianceType,
      taxYear,
      taxMonth,
      fy,
      period,
      dueDate,
      pfClient.default_assignee_id || null,
      pfClient.default_assignee_name || null,
      source,
      actorId(actor),
      actorName(actor),
    ]
  );
  const filing = inserted.rows[0];
  let taskCreated = false;
  if (filing.assigned_to_id) {
    await createTaskForFiling(conn, pfClient, filing, actor);
    taskCreated = true;
  }
  await logPFESIC(conn, {
    pf_esic_client_id: pfClient.id,
    filing_id: filing.id,
    action: 'generated',
    new_value: { compliance_type: complianceType, tax_year: taxYear, tax_month: taxMonth },
    actor,
  });
  return { created: true, task_created: taskCreated };
}

async function generateFilingsForPeriod({ taxYear, taxMonth, actor, source = 'manual' }) {
  const conn = await db.pool.connect();
  const summary = { tax_year: Number(taxYear), tax_month: Number(taxMonth), clients_seen: 0, filings_created: 0, tasks_created: 0, existing: 0, skipped: 0 };
  try {
    await conn.query('BEGIN');
    const clients = await conn.query(
      `SELECT * FROM pf_esic_clients
       WHERE status='Active'
         AND (inactive_from IS NULL OR inactive_from::date > CURRENT_DATE)
       ORDER BY firm_name, id`
    );
    summary.clients_seen = clients.rows.length;
    for (const pfClient of clients.rows) {
      for (const type of PF_ESIC_TYPES) {
        const result = await createOrAttachFiling(conn, pfClient, type, taxYear, taxMonth, actor, source);
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

async function updateFilingStatus(filingId, payload, actor) {
  const status = payload.status ? cleanText(payload.status) : null;
  if (status && !PF_ESIC_STATUSES.includes(status)) {
    const err = new Error('Invalid PF/ESIC status');
    err.statusCode = 400;
    throw err;
  }
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const r = await conn.query(`SELECT * FROM pf_esic_filing_records WHERE id=$1 FOR UPDATE`, [filingId]);
    if (!r.rows.length) {
      const err = new Error('PF/ESIC filing record not found');
      err.statusCode = 404;
      throw err;
    }
    const old = r.rows[0];
    const admin = isPFESICAdmin(actor);
    const assigned = old.assigned_to_id === actor.emp_id;
    if (!admin && !assigned) {
      const err = new Error('Only assigned employee or admin can update PF/ESIC filing');
      err.statusCode = 403;
      throw err;
    }
    const nextStatus = status || old.status;
    const challanAck = cleanText(payload.challan_ack_no || old.challan_ack_no || '');
    if ((nextStatus === 'Filed' || nextStatus === 'Paid') && !challanAck) {
      const err = new Error('Challan/Ack No required before marking PF/ESIC filing Filed/Paid');
      err.statusCode = 400;
      throw err;
    }
    const updated = await conn.query(
      `UPDATE pf_esic_filing_records SET
         status=$1,
         due_date=COALESCE($2::date,due_date),
         challan_ack_no=COALESCE(NULLIF($3,''),challan_ack_no),
         amount=COALESCE($4::numeric,amount),
         payment_date=COALESCE($5::date,payment_date),
         filed_date_ist=CASE WHEN $1 IN ('Filed','Paid') THEN COALESCE(filed_date_ist, $6::date) ELSE filed_date_ist END,
         filed_at=CASE WHEN $1 IN ('Filed','Paid') THEN COALESCE(filed_at, NOW()) ELSE filed_at END,
         last_status_at=NOW(),
         status_updated_by_id=$7,
         status_updated_by_name=$8,
         updated_at=NOW()
       WHERE id=$9
       RETURNING *`,
      [
        nextStatus,
        payload.due_date || null,
        payload.challan_ack_no || null,
        payload.amount === '' || payload.amount === undefined ? null : Number(payload.amount),
        payload.payment_date || null,
        todayIST(),
        actorId(actor),
        actorName(actor),
        filingId,
      ]
    );
    const row = updated.rows[0];
    await syncTaskForFiling(conn, row, actor);
    await logPFESIC(conn, {
      pf_esic_client_id: row.pf_esic_client_id,
      filing_id: row.id,
      action: 'status_updated',
      old_value: old,
      new_value: row,
      remarks: payload.remark || null,
      actor,
    });
    await conn.query('COMMIT');
    return row;
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
      const err = new Error('Assignee not found');
      err.statusCode = 404;
      throw err;
    }
    const r = await conn.query(`SELECT f.*, c.firm_name AS client_firm_name FROM pf_esic_filing_records f JOIN pf_esic_clients c ON c.id=f.pf_esic_client_id WHERE f.id=$1 FOR UPDATE`, [filingId]);
    if (!r.rows.length) {
      const err = new Error('PF/ESIC filing record not found');
      err.statusCode = 404;
      throw err;
    }
    const old = r.rows[0];
    const name = employee.formal_name || employee.name || assigneeId;
    const updated = await conn.query(
      `UPDATE pf_esic_filing_records
          SET assigned_to_id=$1, assigned_to_name=$2,
              status=CASE WHEN status='Not Started' THEN 'Pending' ELSE status END,
              updated_at=NOW()
        WHERE id=$3
        RETURNING *`,
      [assigneeId, name, filingId]
    );
    const row = updated.rows[0];
    const clientRes = await conn.query(`SELECT * FROM pf_esic_clients WHERE id=$1`, [row.pf_esic_client_id]);
    if (row.linked_task_id) {
      await conn.query(
        `UPDATE tasks SET assigned_to_id=$1, assigned_to_name=$2, due_date=$3::date, last_updated_at=NOW(), last_updated_by_id=$4, last_updated_by_name=$5 WHERE task_id=$6`,
        [assigneeId, name, dateOnly(row.due_date), actorId(actor), actorName(actor), row.linked_task_id]
      );
    } else {
      await createTaskForFiling(conn, clientRes.rows[0], row, actor);
    }
    await logPFESIC(conn, {
      pf_esic_client_id: row.pf_esic_client_id,
      filing_id: row.id,
      action: 'assigned',
      old_value: { assigned_to_id: old.assigned_to_id, assigned_to_name: old.assigned_to_name },
      new_value: { assigned_to_id: assigneeId, assigned_to_name: name },
      remarks: remark || null,
      actor,
    });
    await conn.query('COMMIT');
    return row;
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function assignUnassignedFilingsForClient(conn, pfEsicClientId, employee, actor, options = {}) {
  const params = [pfEsicClientId];
  const filters = [`pf_esic_client_id=$1`, `assigned_to_id IS NULL`];
  if (options.taxYear) {
    params.push(Number(options.taxYear));
    filters.push(`tax_year=$${params.length}`);
  }
  if (options.taxMonth) {
    params.push(Number(options.taxMonth));
    filters.push(`tax_month=$${params.length}`);
  }
  const rows = await conn.query(`SELECT * FROM pf_esic_filing_records WHERE ${filters.join(' AND ')} FOR UPDATE`, params);
  let updated = 0;
  for (const filing of rows.rows) {
    const res = await conn.query(
      `UPDATE pf_esic_filing_records
          SET assigned_to_id=$1, assigned_to_name=$2, status=CASE WHEN status='Not Started' THEN 'Pending' ELSE status END, updated_at=NOW()
        WHERE id=$3
        RETURNING *`,
      [employee.emp_id, employee.formal_name || employee.name || employee.emp_id, filing.id]
    );
    const clientRes = await conn.query(`SELECT * FROM pf_esic_clients WHERE id=$1`, [filing.pf_esic_client_id]);
    await createTaskForFiling(conn, clientRes.rows[0], res.rows[0], actor);
    updated += 1;
  }
  return updated;
}

async function syncPFESICForTaskStatus(conn, task, status, actor, remark, challanAckNo) {
  const r = await conn.query(`SELECT * FROM pf_esic_filing_records WHERE linked_task_id=$1 FOR UPDATE`, [task.task_id]);
  if (!r.rows.length) return null;
  const filing = r.rows[0];
  const nextStatus = pfEsicStatusForTask(status, filing.compliance_type);
  if (!nextStatus) return null;
  const admin = isPFESICAdmin(actor);
  const assigned = filing.assigned_to_id === actor.emp_id || task.assigned_to_id === actor.emp_id;
  if (!admin && !assigned) {
    const err = new Error('Only assigned employee or admin can update linked PF/ESIC filing status');
    err.statusCode = 403;
    throw err;
  }
  const ack = cleanText(challanAckNo || filing.challan_ack_no || '');
  if ((nextStatus === 'Filed' || nextStatus === 'Paid') && !ack) {
    const err = new Error('Challan/Ack No required before completing PF/ESIC task');
    err.statusCode = 400;
    throw err;
  }
  if (filing.status === nextStatus && (!challanAckNo || filing.challan_ack_no)) {
    return { filing_id: filing.id, status: nextStatus, changed: false };
  }
  const updated = await conn.query(
    `UPDATE pf_esic_filing_records SET
       status=$1,
       challan_ack_no=COALESCE(NULLIF($2,''), challan_ack_no),
       filed_date_ist=CASE WHEN $1 IN ('Filed','Paid') THEN COALESCE(filed_date_ist, $3::date) ELSE filed_date_ist END,
       filed_at=CASE WHEN $1 IN ('Filed','Paid') THEN COALESCE(filed_at, NOW()) ELSE filed_at END,
       last_status_at=NOW(),
       status_updated_by_id=$4,
       status_updated_by_name=$5,
       updated_at=NOW()
     WHERE id=$6
     RETURNING *`,
    [nextStatus, challanAckNo || null, todayIST(), actorId(actor), actorName(actor), filing.id]
  );
  await logPFESIC(conn, {
    pf_esic_client_id: filing.pf_esic_client_id,
    filing_id: filing.id,
    action: 'task_status_sync',
    old_value: { status: filing.status, challan_ack_no: filing.challan_ack_no },
    new_value: { status: nextStatus, challan_ack_no: updated.rows[0].challan_ack_no },
    remarks: remark || null,
    actor,
  });
  return { filing_id: filing.id, status: nextStatus, changed: true };
}

module.exports = {
  logPFESIC,
  findEmployee,
  findClient,
  createOrAttachFiling,
  generateFilingsForPeriod,
  updateFilingStatus,
  assignFiling,
  assignUnassignedFilingsForClient,
  syncPFESICForTaskStatus,
};
