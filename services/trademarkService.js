const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { resolveWorkClassification } = require('./workClassificationService');

const TRADEMARK_STAGES = [
  'Draft / Data Collection',
  'Application Filed',
  'Formality Check',
  'Vienna Codification',
  'Marked for Examination',
  'Examination Report Issued',
  'Reply Filed',
  'Hearing Scheduled',
  'Accepted / Advertised',
  'Opposition Period',
  'Opposed',
  'Registered',
  'Refused',
  'Abandoned',
  'Withdrawn',
  'Renewal Due',
  'Renewed',
];

const TRADEMARK_STATUSES = [
  'Draft',
  'Pending',
  'In Progress',
  'Pending by Client',
  'Reply Due',
  'Hearing Due',
  'Opposition Watch',
  'Opposed',
  'Registered',
  'Renewed',
  'Refused',
  'Abandoned',
  'Withdrawn',
  'Closed',
];

const MARK_TYPES = ['Word Mark', 'Device / Logo', 'Label', 'Shape', 'Sound', 'Series', 'Certification', 'Collective', 'Other'];

const DEFAULT_TEMPLATES = [
  ['Trademark Filing', 'Application Filed', 0],
  ['Examination Reply', 'Examination Report Issued', 30],
  ['Show Cause Hearing', 'Hearing Scheduled', 7],
  ['Opposition Watch', 'Opposition Period', 120],
  ['Opposition Reply', 'Opposed', 60],
  ['Registration Certificate', 'Registered', 0],
  ['Renewal', 'Renewal Due', 180],
];

function cleanText(value) {
  return String(value ?? '').trim();
}

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

async function ensureTrademarkSchema(conn = db) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS trademark_applications (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
      client_id VARCHAR(50) NOT NULL,
      agent_id VARCHAR(50),
      agent_name VARCHAR(255),
      trademark_name VARCHAR(255) NOT NULL,
      applicant_name VARCHAR(255),
      application_number VARCHAR(80),
      mark_type VARCHAR(50),
      filing_date DATE,
      current_stage VARCHAR(100) NOT NULL DEFAULT 'Draft / Data Collection',
      current_status VARCHAR(80) NOT NULL DEFAULT 'Draft',
      due_date DATE,
      assigned_to_id VARCHAR(50),
      assigned_to_name VARCHAR(255),
      linked_task_id VARCHAR(100),
      remarks TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      inactive_reason TEXT,
      inactive_from DATE,
      created_by_id VARCHAR(80),
      created_by_name VARCHAR(255),
      updated_by_id VARCHAR(80),
      updated_by_name VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS trademark_application_classes (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
      application_id INTEGER NOT NULL REFERENCES trademark_applications(id) ON DELETE CASCADE,
      class_no VARCHAR(20) NOT NULL,
      goods_services TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS trademark_stage_history (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
      application_id INTEGER REFERENCES trademark_applications(id) ON DELETE CASCADE,
      action VARCHAR(80) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      remarks TEXT,
      updated_by_id VARCHAR(80),
      updated_by_name VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS trademark_documents (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
      application_id INTEGER NOT NULL REFERENCES trademark_applications(id) ON DELETE CASCADE,
      document_type VARCHAR(80),
      file_name VARCHAR(255),
      file_url TEXT,
      mime_type VARCHAR(100),
      file_size INTEGER,
      uploaded_by_id VARCHAR(80),
      uploaded_by_name VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await conn.query(`
    CREATE TABLE IF NOT EXISTS trademark_task_templates (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
      template_name VARCHAR(120) NOT NULL,
      stage VARCHAR(100) NOT NULL,
      default_due_days INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await conn.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_trademark_app_no_unique ON trademark_applications (organization_id, UPPER(application_number)) WHERE application_number IS NOT NULL AND application_number <> ''`);
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_trademark_apps_client ON trademark_applications (organization_id, client_id, status)`);
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_trademark_apps_stage ON trademark_applications (organization_id, current_stage, current_status)`);
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_trademark_apps_assignee ON trademark_applications (organization_id, assigned_to_id, due_date)`);
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_trademark_classes_app ON trademark_application_classes (organization_id, application_id)`);
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_trademark_history_app ON trademark_stage_history (organization_id, application_id, created_at DESC)`);

  for (const table of ['trademark_applications', 'trademark_application_classes', 'trademark_stage_history', 'trademark_documents', 'trademark_task_templates']) {
    await conn.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await conn.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await conn.query(`DROP POLICY IF EXISTS ${table}_tenant_policy ON ${table}`);
    await conn.query(`
      CREATE POLICY ${table}_tenant_policy ON ${table}
      USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    `);
  }

  for (const [templateName, stage, days] of DEFAULT_TEMPLATES) {
    await conn.query(
      `INSERT INTO trademark_task_templates (template_name, stage, default_due_days)
       SELECT $1::text,$2::text,$3::int
       WHERE NOT EXISTS (
         SELECT 1 FROM trademark_task_templates
          WHERE LOWER(template_name)=LOWER($1::text) AND LOWER(stage)=LOWER($2::text)
       )`,
      [templateName, stage, days]
    );
  }
}

async function logTrademark(conn, payload) {
  await conn.query(
    `INSERT INTO trademark_stage_history
      (application_id, action, old_value, new_value, remarks, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      payload.application_id || null,
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
    `SELECT emp_id, formal_name, name, designation, photo
       FROM (
         SELECT emp_id, formal_name, name, designation, photo FROM emplist WHERE emp_id=$1 AND status='Active'
         UNION ALL
         SELECT username AS emp_id, name AS formal_name, name, role AS designation, NULL::text AS photo FROM admins WHERE username=$1 AND status='Active'
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
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await conn.query(`SELECT COUNT(*)::int AS cnt FROM tasks WHERE task_id LIKE $1`, [`TSK${prefix}-${stamp}-%`]);
  const next = Number(r.rows[0]?.cnt || 0) + 1;
  return `TSK${prefix}-${stamp}-${String(next).padStart(3, '0')}`;
}

function taskStatusForTrademark(app) {
  const value = app.current_status || app.current_stage;
  if (['Registered', 'Renewed', 'Closed'].includes(value)) return 'Completed';
  if (['Refused', 'Abandoned', 'Withdrawn'].includes(value)) return 'Cancelled';
  if (value === 'Pending by Client') return 'Waiting for Client';
  if (['In Progress', 'Reply Due', 'Hearing Due', 'Opposed', 'Opposition Watch'].includes(value)) return 'In Progress';
  return 'Pending';
}

function trademarkStatusForTask(taskStatus) {
  if (taskStatus === 'Completed') return 'Closed';
  if (taskStatus === 'Waiting for Client') return 'Pending by Client';
  if (taskStatus === 'Cancelled') return 'Abandoned';
  if (['In Progress', 'Under Process', 'Reassigned'].includes(taskStatus)) return 'In Progress';
  if (taskStatus === 'Pending') return 'Pending';
  return null;
}

function applicationTaskName(app) {
  const name = app.trademark_name || 'Trademark';
  const stage = app.current_stage || app.current_status || 'Work';
  return `Trademark - ${name} - ${stage}`;
}

async function createTaskForApplication(conn, app, actor) {
  if (!app.assigned_to_id) return null;
  if (app.linked_task_id) return app.linked_task_id;
  const client = await findClient(conn, app.client_id);
  const taskId = await nextTaskId(conn);
  const createdById = actorId(actor);
  const createdByName = actorName(actor);
  const assigneeName = app.assigned_to_name || app.assigned_to_id;
  const workName = applicationTaskName(app);
  const description = `${workName}${app.application_number ? ` | Application No: ${app.application_number}` : ''}`;
  const workClass = await resolveWorkClassification(conn, {
    work_name: workName,
    fallback: { work_category: 'Trademark, Copyright & Intellectual Property', grouping_name: 'Trademark & IP Department', department: 'Common Services' },
  });

  await conn.query(
    `INSERT INTO tasks
      (task_id, created_at, created_by_id, created_by_name, assigned_to_id, assigned_to_name,
       client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, drive_link,
       work_name, work_description, priority, status, due_date, internal_remark,
       self_assigned, billing_status, active_flag,
       work_name_id, work_category, grouping_name, department, is_custom_work)
     VALUES
      ($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Medium',$16,$17,$18,$19,'Not Applicable',true,$20,$21,$22,$23,$24)`,
    [
      taskId,
      createdById,
      createdByName,
      app.assigned_to_id,
      assigneeName,
      app.client_id,
      client?.agent_id || app.agent_id || null,
      client?.agent_name || app.agent_name || null,
      client?.legal_name || app.applicant_name || app.trademark_name || null,
      client?.business_name || app.applicant_name || app.trademark_name || null,
      client?.mobile_number || null,
      client?.email_id || null,
      client?.drive_link || null,
      workName,
      description,
      taskStatusForTrademark(app),
      dateOnly(app.due_date),
      `Linked trademark application #${app.id}`,
      createdById === app.assigned_to_id,
      workClass.work_name_id,
      workClass.work_category,
      workClass.grouping_name,
      workClass.department,
      workClass.is_custom_work,
    ]
  );
  await conn.query(
    `INSERT INTO task_history (log_id, task_id, action, new_status, new_assigned_to, new_due_date, updated_by_id, updated_by_name, updated_at, remark)
     VALUES ($1,$2,'Created',$3,$4,$5,$6,$7,NOW(),$8)`,
    [
      'LOG_' + uuidv4().replace(/-/g, '').slice(0, 10),
      taskId,
      taskStatusForTrademark(app),
      assigneeName,
      dateOnly(app.due_date),
      createdById,
      createdByName,
      'Created from Trademark tracker',
    ]
  );
  await conn.query(`UPDATE trademark_applications SET linked_task_id=$1, updated_at=NOW() WHERE id=$2`, [taskId, app.id]);
  await logTrademark(conn, { application_id: app.id, action: 'task_created', new_value: { task_id: taskId }, actor });
  return taskId;
}

async function syncTaskForApplication(conn, app, actor) {
  if (!app.linked_task_id) return;
  await conn.query(
    `UPDATE tasks
        SET status=$1,
            work_name=$2,
            assigned_to_id=COALESCE($3, assigned_to_id),
            assigned_to_name=COALESCE($4, assigned_to_name),
            due_date=COALESCE($5::date, due_date),
            completion_date=CASE WHEN $1 IN ('Completed','Cancelled') AND completion_date IS NULL THEN CURRENT_DATE ELSE completion_date END,
            last_updated_at=NOW(),
            last_updated_by_id=$6,
            last_updated_by_name=$7
      WHERE task_id=$8`,
    [
      taskStatusForTrademark(app),
      applicationTaskName(app),
      app.assigned_to_id || null,
      app.assigned_to_name || null,
      dateOnly(app.due_date),
      actorId(actor),
      actorName(actor),
      app.linked_task_id,
    ]
  );
}

async function syncTrademarkForTaskStatus(conn, taskId, status, actor) {
  await ensureTrademarkSchema(conn);
  const appResult = await conn.query(`SELECT * FROM trademark_applications WHERE linked_task_id=$1 FOR UPDATE`, [taskId]);
  if (!appResult.rows.length) return null;
  const app = appResult.rows[0];
  const nextStatus = trademarkStatusForTask(status);
  if (!nextStatus || nextStatus === app.current_status) return app;
  const updated = await conn.query(
    `UPDATE trademark_applications
        SET current_status=$1,
            updated_by_id=$2,
            updated_by_name=$3,
            updated_at=NOW()
      WHERE id=$4
      RETURNING *`,
    [nextStatus, actorId(actor), actorName(actor), app.id]
  );
  await logTrademark(conn, {
    application_id: app.id,
    action: 'task_status_sync',
    old_value: { current_status: app.current_status, task_status: status },
    new_value: { current_status: nextStatus, task_id: taskId },
    actor,
  });
  return updated.rows[0];
}

module.exports = {
  TRADEMARK_STAGES,
  TRADEMARK_STATUSES,
  MARK_TYPES,
  cleanText,
  actorId,
  actorName,
  dateOnly,
  ensureTrademarkSchema,
  logTrademark,
  findEmployee,
  findClient,
  createTaskForApplication,
  syncTaskForApplication,
  syncTrademarkForTaskStatus,
  applicationTaskName,
};
