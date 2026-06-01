const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const COMPLIANCE_STATUSES = [
  'Draft',
  'Pending',
  'Assigned',
  'In Progress',
  'Pending by Client',
  'Prepared',
  'Filed',
  'Not Applicable',
  'Closed',
];

const TEMPLATE_TYPES = ['annual', 'first_year', 'event_based', 'director_kyc', 'itr_linked'];

const DEFAULT_TEMPLATES = [
  { code: 'INC-20A', name: 'Declaration for Commencement of Business', type: 'first_year', due_rule: 'INCORPORATION_PLUS_180', priority: 'High', sort_order: 10 },
  { code: 'ADT-1-FIRST', name: 'First Auditor Appointment', type: 'first_year', due_rule: 'INCORPORATION_PLUS_30', priority: 'High', sort_order: 20 },
  { code: 'SHARE-CERT-FIRST', name: 'Share Certificate Issue', type: 'first_year', due_rule: 'INCORPORATION_PLUS_60', priority: 'High', sort_order: 25 },
  { code: 'STATUTORY-SETUP', name: 'Statutory Registers / First Year Setup', type: 'first_year', due_rule: 'INCORPORATION_PLUS_30', priority: 'Medium', sort_order: 30 },
  { code: 'FIN-STMT', name: 'Financial Statement Preparation', type: 'annual', due_rule: 'FY_PLUS_SEP_30', priority: 'High', sort_order: 100 },
  { code: 'AOC-4', name: 'AOC-4 Filing', type: 'annual', due_rule: 'FY_PLUS_OCT_29', priority: 'High', sort_order: 110 },
  { code: 'MGT-7A', name: 'MGT-7 / MGT-7A Annual Return', type: 'annual', due_rule: 'FY_PLUS_NOV_28', priority: 'High', sort_order: 120 },
  { code: 'AGM-CHECKLIST', name: 'AGM Minutes / Annual Checklist', type: 'annual', due_rule: 'FY_PLUS_SEP_30', priority: 'Medium', sort_order: 130 },
  { code: 'DIR-3-KYC', name: 'DIR-3 KYC', type: 'director_kyc', due_rule: 'FY_PLUS_SEP_30', priority: 'Medium', sort_order: 140 },
  { code: 'ITR-COMPANY', name: 'Company ITR Filing Status', type: 'itr_linked', due_rule: 'FY_PLUS_OCT_31', priority: 'High', sort_order: 150 },
  { code: 'DIR-12', name: 'DIR-12 Director Appointment / Resignation', type: 'event_based', event_type: 'director_change', due_rule: 'EVENT_PLUS_30', priority: 'High', sort_order: 200 },
  { code: 'PAS-3', name: 'PAS-3 Return of Allotment', type: 'event_based', event_type: 'share_allotment', due_rule: 'EVENT_PLUS_30', priority: 'High', sort_order: 210 },
  { code: 'MGT-14', name: 'MGT-14 Board / Shareholder Resolution', type: 'event_based', event_type: 'resolution', due_rule: 'EVENT_PLUS_30', priority: 'Medium', sort_order: 220 },
  { code: 'INC-22', name: 'INC-22 Registered Office Change', type: 'event_based', event_type: 'registered_office_change', due_rule: 'EVENT_PLUS_30', priority: 'High', sort_order: 230 },
  { code: 'SH-7', name: 'SH-7 Capital Alteration', type: 'event_based', event_type: 'capital_change', due_rule: 'EVENT_PLUS_30', priority: 'Medium', sort_order: 240 },
  { code: 'CHG-1', name: 'CHG-1 Charge Creation / Modification', type: 'event_based', event_type: 'charge_creation', due_rule: 'EVENT_PLUS_30', priority: 'High', sort_order: 250 },
  { code: 'CHG-4', name: 'CHG-4 Charge Satisfaction', type: 'event_based', event_type: 'charge_satisfaction', due_rule: 'EVENT_PLUS_30', priority: 'High', sort_order: 260 },
  { code: 'ADT-1-EVENT', name: 'ADT-1 Auditor Appointment / Change', type: 'event_based', event_type: 'auditor_change', due_rule: 'EVENT_PLUS_15', priority: 'High', sort_order: 270 },
];

let schemaReady = false;
const seededTenants = new Set();
const syncedIncorporationTenants = new Set();

function actorName(actor = {}) {
  return actor.formal_name || actor.name || actor.emp_name || 'System';
}

function actorId(actor = {}) {
  return actor.emp_id || actor.id || 'SYSTEM';
}

function orgTaskPrefix(actor = {}) {
  return String(actor.organization_code || 'ORG').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8) || 'ORG';
}

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function todayIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

function fiscalEndYear(financialYear) {
  const m = String(financialYear || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return new Date().getFullYear();
  return parseInt(m[1], 10) + 1;
}

function fiscalStartYear(financialYear) {
  const m = String(financialYear || '').match(/^(\d{4})-(\d{2})$/);
  return m ? parseInt(m[1], 10) : null;
}

function compareFY(a, b) {
  const ay = fiscalStartYear(a);
  const by = fiscalStartYear(b);
  if (ay === null || by === null) return 0;
  return ay - by;
}

function firstYearApplicableSql(recordAlias = 'r', companyAlias = 'c') {
  return `(${recordAlias}.compliance_type <> 'first_year'
    OR ${companyAlias}.incorporation_date IS NULL
    OR (
      CASE
        WHEN EXTRACT(MONTH FROM ${companyAlias}.incorporation_date)::int >= 4
          THEN EXTRACT(YEAR FROM ${companyAlias}.incorporation_date)::int
        ELSE EXTRACT(YEAR FROM ${companyAlias}.incorporation_date)::int - 1
      END
    ) = substring(${recordAlias}.financial_year from 1 for 4)::int)`;
}

function addDays(dateValue, days) {
  if (!dateValue) return null;
  const d = new Date(`${dateOnly(dateValue)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dueDateForRule(rule, ctx = {}) {
  const fyEnd = fiscalEndYear(ctx.financial_year);
  const eventDate = ctx.event_date || ctx.incorporation_date;
  const rules = {
    FY_PLUS_SEP_30: `${fyEnd}-09-30`,
    FY_PLUS_OCT_29: `${fyEnd}-10-29`,
    FY_PLUS_OCT_31: `${fyEnd}-10-31`,
    FY_PLUS_NOV_28: `${fyEnd}-11-28`,
    INCORPORATION_PLUS_30: addDays(ctx.incorporation_date, 30),
    INCORPORATION_PLUS_60: addDays(ctx.incorporation_date, 60),
    INCORPORATION_PLUS_180: addDays(ctx.incorporation_date, 180),
    EVENT_PLUS_15: addDays(eventDate, 15),
    EVENT_PLUS_30: addDays(eventDate, 30),
  };
  return rules[rule] || null;
}

function normalizeStatus(status) {
  if (!status) return 'Draft';
  if (status === 'Under Process') return 'In Progress';
  if (status === 'Received') return 'Prepared';
  if (COMPLIANCE_STATUSES.includes(status)) return status;
  return 'Pending';
}

function isCompanyApplicableForFY(company, financialYear) {
  const incFY = financialYearForDate(company?.incorporation_date);
  if (!incFY || !financialYear) return true;
  return compareFY(incFY, financialYear) <= 0;
}

function taskStatusForCompliance(status) {
  if (status === 'Filed' || status === 'Closed') return 'Completed';
  if (status === 'Not Applicable') return 'Cancelled';
  if (status === 'Pending by Client') return 'Waiting for Client';
  if (status === 'In Progress' || status === 'Prepared') return 'In Progress';
  return 'Pending';
}

function complianceStatusForTask(status) {
  if (status === 'Completed') return 'Filed';
  if (status === 'Cancelled') return 'Not Applicable';
  if (status === 'Waiting for Client') return 'Pending by Client';
  if (['In Progress', 'Under Review', 'Waiting for Government', 'On Hold', 'Reassigned'].includes(status)) return 'In Progress';
  if (status === 'Pending') return 'Assigned';
  return null;
}

function kycStatusForTask(status) {
  if (status === 'Completed') return 'Filed';
  if (status === 'Cancelled') return 'Not Applicable';
  if (status === 'Waiting for Client') return 'Pending by Client';
  if (['In Progress', 'Under Review', 'Waiting for Government', 'On Hold', 'Reassigned'].includes(status)) return 'In Progress';
  if (status === 'Pending') return 'Pending';
  return null;
}

function taskStatusForKyc(status) {
  if (status === 'Filed') return 'Completed';
  if (status === 'Not Applicable') return 'Cancelled';
  if (status === 'Pending by Client') return 'Waiting for Client';
  if (status === 'In Progress' || status === 'Prepared') return 'In Progress';
  return 'Pending';
}

async function ensureSchema(conn = db) {
  if (!schemaReady) {
    const existing = await conn.query(`SELECT to_regclass('public.company_compliance_records') AS records_table`);
    if (existing.rows[0].records_table) {
      schemaReady = true;
    }
  }
  if (!schemaReady) {
    await conn.query(`
    CREATE TABLE IF NOT EXISTS compliance_templates (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      code VARCHAR(80) NOT NULL,
      name VARCHAR(220) NOT NULL,
      template_type VARCHAR(30) NOT NULL,
      event_type VARCHAR(80),
      due_rule VARCHAR(80),
      default_priority VARCHAR(30) NOT NULL DEFAULT 'Medium',
      default_assignee_id VARCHAR(80),
      default_assignee_name VARCHAR(150),
      applicable_company_types TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 100,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT ux_compliance_template_org_code UNIQUE (organization_id, code)
    )
    `);
    await conn.query(`
    CREATE TABLE IF NOT EXISTS company_compliance_events (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      cin VARCHAR(80) NOT NULL,
      company_name VARCHAR(250),
      event_type VARCHAR(80) NOT NULL,
      event_title VARCHAR(220) NOT NULL,
      event_date DATE NOT NULL,
      remarks TEXT,
      created_by_id VARCHAR(80),
      created_by_name VARCHAR(150),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
    `);
    await conn.query(`
    CREATE TABLE IF NOT EXISTS company_compliance_records (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      template_id INTEGER REFERENCES compliance_templates(id) ON DELETE SET NULL,
      event_id INTEGER REFERENCES company_compliance_events(id) ON DELETE SET NULL,
      cin VARCHAR(80) NOT NULL,
      company_name VARCHAR(250),
      client_id VARCHAR(80),
      agent_name VARCHAR(200),
      compliance_code VARCHAR(80) NOT NULL,
      compliance_name VARCHAR(220) NOT NULL,
      compliance_type VARCHAR(30) NOT NULL,
      financial_year VARCHAR(20),
      event_type VARCHAR(80),
      event_date DATE,
      due_date DATE,
      assigned_to_id VARCHAR(80),
      assigned_to_name VARCHAR(150),
      linked_task_id VARCHAR(100),
      status VARCHAR(40) NOT NULL DEFAULT 'Draft',
      srn VARCHAR(100),
      filing_date DATE,
      remarks TEXT,
      source VARCHAR(40) NOT NULL DEFAULT 'manual',
      legacy_tracking_id INTEGER,
      legacy_field VARCHAR(80),
      active_flag BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_id VARCHAR(80),
      created_by_name VARCHAR(150),
      updated_by_id VARCHAR(80),
      updated_by_name VARCHAR(150),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
    `);
    await conn.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_company_compliance_instance
    ON company_compliance_records (
      organization_id,
      UPPER(cin),
      COALESCE(financial_year, ''),
      compliance_code,
      COALESCE(event_id, 0),
      COALESCE(legacy_tracking_id, 0),
      COALESCE(legacy_field, '')
    )
    `);
    await conn.query(`
    CREATE TABLE IF NOT EXISTS company_compliance_history (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      record_id INTEGER REFERENCES company_compliance_records(id) ON DELETE CASCADE,
      action VARCHAR(80) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      remarks TEXT,
      updated_by_id VARCHAR(80),
      updated_by_name VARCHAR(150),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
    `);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_company_compliance_org_cin ON company_compliance_records (organization_id, UPPER(cin), financial_year)`);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_company_compliance_org_status ON company_compliance_records (organization_id, status, due_date)`);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_company_compliance_org_assignee ON company_compliance_records (organization_id, assigned_to_id, status)`);
    schemaReady = true;
  }
  const ctx = db.getTenantContext ? db.getTenantContext() : {};
  const tenantKey = String(ctx.organizationId || ctx.organization_id || 'default');
  if (!syncedIncorporationTenants.has(tenantKey)) {
    await syncCompanyIncorporationDates(conn);
    syncedIncorporationTenants.add(tenantKey);
  }
  if (!seededTenants.has(tenantKey)) {
    await seedTemplates(conn);
    await migrateLegacyTracking(conn);
    seededTenants.add(tenantKey);
  }
}

async function syncCompanyIncorporationDates(conn = db) {
  const masterExists = await conn.query(`SELECT to_regclass('public.master_data') AS table_name`);
  if (!masterExists.rows[0].table_name) return;
  await conn.query(`
    UPDATE companies c
    SET incorporation_date = md.date_of_incorporation
    FROM (
      SELECT DISTINCT ON (UPPER(cin)) cin, date_of_incorporation
      FROM master_data
      WHERE date_of_incorporation IS NOT NULL
      ORDER BY UPPER(cin), id DESC
    ) md
    WHERE UPPER(c.cin)=UPPER(md.cin)
      AND c.incorporation_date IS NULL
  `);
}

async function ensureKycAssignmentSchema(conn = db) {
  await conn.query(`ALTER TABLE director_kyc_tracking ALTER COLUMN active_flag TYPE VARCHAR(20)`);
  await conn.query(`ALTER TABLE director_kyc_tracking ADD COLUMN IF NOT EXISTS assigned_to_id VARCHAR(80)`);
  await conn.query(`ALTER TABLE director_kyc_tracking ADD COLUMN IF NOT EXISTS assigned_to_name VARCHAR(150)`);
  await conn.query(`ALTER TABLE director_kyc_tracking ADD COLUMN IF NOT EXISTS linked_task_id VARCHAR(100)`);
  await conn.query(`CREATE INDEX IF NOT EXISTS idx_director_kyc_org_assignee ON director_kyc_tracking (organization_id, assigned_to_id, kyc_status)`);
}

async function seedTemplates(conn = db) {
  for (const t of DEFAULT_TEMPLATES) {
    await conn.query(
      `INSERT INTO compliance_templates
        (code, name, template_type, event_type, due_rule, default_priority, sort_order, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (organization_id, code) DO NOTHING`,
      [t.code, t.name, t.type, t.event_type || null, t.due_rule, t.priority, t.sort_order]
    );
  }
}

async function logHistory(conn, payload) {
  await conn.query(
    `INSERT INTO company_compliance_history
      (record_id, action, old_value, new_value, remarks, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      payload.record_id || null,
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
     ) x LIMIT 1`,
    [empId]
  );
  return r.rows[0] || null;
}

async function nextTaskId(conn, actor) {
  const dateKey = nowIST().toISOString().slice(0, 10).replace(/-/g, '');
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

async function createTaskForRecord(conn, record, actor) {
  if (!record.assigned_to_id) return null;
  const taskId = await nextTaskId(conn, actor);
  const createdById = actorId(actor);
  const createdByName = actorName(actor);
  const assigneeName = record.assigned_to_name || record.assigned_to_id;
  const fyLabel = record.financial_year ? ` (${record.financial_year})` : '';
  const eventLabel = record.event_type ? ` - ${record.event_type.replace(/_/g, ' ')}` : '';
  const description = `${record.compliance_name}${fyLabel}${eventLabel} for ${record.company_name || record.cin}`;
  await conn.query(
    `INSERT INTO tasks
      (task_id, created_at, created_by_id, created_by_name, assigned_to_id, assigned_to_name,
       client_id, agent_name, legal_name, business_name, work_name, work_description, priority,
       status, due_date, internal_remark, self_assigned, billing_status, active_flag)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending',$14,$15,$16,'Not Applicable',true)`,
    [
      taskId,
      nowIST(),
      createdById,
      createdByName,
      record.assigned_to_id,
      assigneeName,
      record.client_id || null,
      record.agent_name || null,
      record.company_name || record.cin,
      record.company_name || record.cin,
      record.compliance_code,
      description,
      record.default_priority || 'Medium',
      record.due_date || null,
      `Auto Companies Act compliance task: ${record.compliance_code}`,
      createdById === record.assigned_to_id,
    ]
  );
  await conn.query(
    `INSERT INTO task_history
      (log_id, task_id, action, new_status, new_assigned_to, new_due_date, updated_by_id, updated_by_name, updated_at, remark)
     VALUES ($1,$2,'Created','Pending',$3,$4,$5,$6,NOW(),$7)`,
    [
      `LOG_${uuidv4().replace(/-/g, '').slice(0, 10)}`,
      taskId,
      assigneeName,
      record.due_date || null,
      createdById,
      createdByName,
      'Created from Companies compliance tracker',
    ]
  );
  return taskId;
}

async function migrateLegacyTracking(conn = db) {
  const exists = await conn.query(`SELECT to_regclass('public.compliance_tracking') AS table_name`);
  if (!exists.rows[0].table_name) return;
  const legacyDone = await conn.query(`SELECT 1 FROM company_compliance_records WHERE source='legacy' LIMIT 1`);
  if (legacyDone.rows.length) return;
  await conn.query(`
    INSERT INTO company_compliance_records
      (template_id, cin, company_name, client_id, agent_name, compliance_code, compliance_name,
       compliance_type, financial_year, due_date, status, srn, remarks, source,
       legacy_tracking_id, legacy_field, created_by_id, created_by_name, updated_by_id, updated_by_name)
    SELECT
      t.id,
      UPPER(ct.cin),
      ct.company_name,
      ct.client_id,
      ct.agent_name,
      t.code,
      t.name,
      t.template_type,
      ct.financial_year,
      CASE t.due_rule
        WHEN 'FY_PLUS_SEP_30' THEN ((substring(ct.financial_year from 1 for 4)::int + 1)::text || '-09-30')::date
        WHEN 'FY_PLUS_OCT_29' THEN ((substring(ct.financial_year from 1 for 4)::int + 1)::text || '-10-29')::date
        WHEN 'FY_PLUS_OCT_31' THEN ((substring(ct.financial_year from 1 for 4)::int + 1)::text || '-10-31')::date
        WHEN 'FY_PLUS_NOV_28' THEN ((substring(ct.financial_year from 1 for 4)::int + 1)::text || '-11-28')::date
        ELSE NULL
      END,
      CASE v.status
        WHEN 'Under Process' THEN 'In Progress'
        WHEN 'Received' THEN 'Prepared'
        WHEN 'Draft' THEN 'Draft'
        WHEN 'Assigned' THEN 'Assigned'
        WHEN 'In Progress' THEN 'In Progress'
        WHEN 'Pending by Client' THEN 'Pending by Client'
        WHEN 'Prepared' THEN 'Prepared'
        WHEN 'Filed' THEN 'Filed'
        WHEN 'Not Applicable' THEN 'Not Applicable'
        WHEN 'Closed' THEN 'Closed'
        ELSE 'Pending'
      END,
      v.srn,
      ct.remarks,
      'legacy',
      ct.id,
      v.legacy_field,
      COALESCE(ct.updated_by_id, 'SYSTEM'),
      COALESCE(ct.updated_by_name, 'System'),
      COALESCE(ct.updated_by_id, 'SYSTEM'),
      COALESCE(ct.updated_by_name, 'System')
    FROM compliance_tracking ct
    CROSS JOIN LATERAL (VALUES
      ('inc20a','INC-20A',ct.inc20a,ct.srn_inc20a),
      ('adt1','ADT-1-FIRST',ct.adt1,ct.srn_adt1),
      ('aoc4','AOC-4',ct.aoc4,ct.srn_aoc4),
      ('mgt7a','MGT-7A',ct.mgt7a,ct.srn_mgt7a),
      ('itr','ITR-COMPANY',ct.itr,NULL),
      ('documents_status','STATUTORY-SETUP',ct.documents_status,NULL),
      ('financial_statement','FIN-STMT',ct.financial_statement,NULL)
    ) AS v(legacy_field, template_code, status, srn)
    JOIN compliance_templates t ON t.code=v.template_code AND t.enabled=true
    WHERE v.status IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM company_compliance_records r
        WHERE UPPER(r.cin)=UPPER(ct.cin)
          AND COALESCE(r.financial_year,'')=COALESCE(ct.financial_year,'')
          AND r.compliance_code=t.code
          AND COALESCE(r.legacy_tracking_id,0)=ct.id
          AND COALESCE(r.legacy_field,'')=v.legacy_field
      )
  `);
}

async function insertComplianceRecord(conn, payload) {
  const t = payload.template;
  const c = payload.company || {};
  const dueDate = payload.due_date || dueDateForRule(t.due_rule, {
    financial_year: payload.financial_year,
    incorporation_date: c.incorporation_date,
    event_date: payload.event_date,
  });
  const status = normalizeStatus(payload.status);
  const r = await conn.query(
    `INSERT INTO company_compliance_records
      (template_id, event_id, cin, company_name, client_id, agent_name, compliance_code, compliance_name,
       compliance_type, financial_year, event_type, event_date, due_date, assigned_to_id, assigned_to_name,
       status, srn, filing_date, remarks, source, legacy_tracking_id, legacy_field, created_by_id, created_by_name,
       updated_by_id, updated_by_name)
     SELECT $1::integer,$2::integer,UPPER($3::text),$4,$5,$6,$7::varchar,$8,$9,$10::varchar,$11,$12::date,$13::date,$14,$15,$16,$17,$18::date,$19,$20,$21::integer,$22::varchar,$23,$24,$23,$24
     WHERE NOT EXISTS (
       SELECT 1 FROM company_compliance_records
       WHERE UPPER(cin)=UPPER($3)
         AND COALESCE(financial_year,'')=COALESCE($10::varchar,'')
         AND compliance_code=$7::varchar
         AND (
           ($2::integer IS NULL AND event_id IS NULL)
           OR ($2::integer IS NOT NULL AND COALESCE(event_id,0)=COALESCE($2::integer,0))
         )
     )
     RETURNING *`,
    [
      t.id,
      payload.event_id || null,
      c.cin || payload.cin,
      c.company_name || payload.company_name || '',
      c.client_id || payload.client_id || '',
      c.agent_name || payload.agent_name || '',
      t.code,
      t.name,
      t.template_type,
      payload.financial_year || null,
      payload.event_type || t.event_type || null,
      payload.event_date || null,
      dueDate,
      payload.assigned_to_id || t.default_assignee_id || null,
      payload.assigned_to_name || t.default_assignee_name || null,
      status,
      payload.srn || null,
      payload.filing_date || null,
      payload.remarks || null,
      payload.source || 'generated',
      payload.legacy_tracking_id || null,
      payload.legacy_field || null,
      actorId(payload.actor),
      actorName(payload.actor),
    ]
  );
  return r.rows[0] || null;
}

async function generateCompanyCompliances(cin, financialYear, actor, options = {}) {
  await ensureSchema();
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const co = await conn.query(`SELECT * FROM companies WHERE UPPER(cin)=UPPER($1) FOR UPDATE`, [cin]);
    if (!co.rows.length) {
      const err = new Error('Company not found. Add company first.');
      err.statusCode = 404;
      throw err;
    }
    const company = co.rows[0];
    if (company.company_status === 'Inactive' && !options.allowInactive) {
      const err = new Error('Company is Inactive. Cannot generate new compliance.');
      err.statusCode = 400;
      throw err;
    }
    if (!isCompanyApplicableForFY(company, financialYear)) {
      await conn.query('COMMIT');
      return { created: 0, skipped: true, reason: 'Company was not incorporated in selected financial year' };
    }
    const templates = await conn.query(
      `SELECT * FROM compliance_templates
       WHERE enabled=true AND template_type IN ('annual','first_year','itr_linked')
       ORDER BY sort_order, code`
    );
    let created = 0;
    for (const template of templates.rows) {
      if (template.template_type === 'first_year' && financialYear) {
        const incFY = financialYearForDate(company.incorporation_date);
        if (incFY && incFY !== financialYear) continue;
      }
      const rec = await insertComplianceRecord(conn, { template, company, financial_year: financialYear, status: 'Draft', source: options.source || 'generated', actor });
      if (rec) created += 1;
    }
    await conn.query('COMMIT');
    return { created };
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function bulkGenerateCompanyCompliances(financialYear, actor) {
  await ensureSchema();
  if (!financialYear) {
    const err = new Error('Financial Year required');
    err.statusCode = 400;
    throw err;
  }
  const companies = await db.query(
    `SELECT cin FROM companies
     WHERE COALESCE(company_status,'Active')='Active'
     ORDER BY company_name`
  );
  let processed = 0;
  let created = 0;
  let skipped = 0;
  const errors = [];
  for (const company of companies.rows) {
    try {
      const result = await generateCompanyCompliances(company.cin, financialYear, actor, { source: 'bulk' });
      processed += 1;
      created += result.created || 0;
      if (result.skipped) skipped += 1;
    } catch (err) {
      errors.push({ cin: company.cin, message: err.message });
    }
  }
  return { processed, created, skipped, errors };
}

function financialYearForDate(dateValue) {
  if (!dateValue) return null;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

async function autoGenerateForCompany(cin, actor) {
  const c = await db.query(`SELECT incorporation_date, company_status FROM companies WHERE UPPER(cin)=UPPER($1)`, [cin]);
  if (!c.rows.length || c.rows[0].company_status === 'Inactive') return { created: 0 };
  const fy = financialYearForDate(c.rows[0].incorporation_date) || currentFY();
  return generateCompanyCompliances(cin, fy, actor, { source: 'auto' });
}

function currentFY() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

async function listRecords(query = {}) {
  await ensureSchema();
  const conds = ['1=1', firstYearApplicableSql('r', 'c')];
  const params = [];
  const add = (value, sql) => {
    params.push(value);
    conds.push(sql(params.length));
  };
  if (query.cin) add(query.cin, (n) => `UPPER(r.cin)=UPPER($${n})`);
  if (query.financial_year) add(query.financial_year, (n) => `r.financial_year=$${n}`);
  if (query.status) add(query.status, (n) => `r.status=$${n}`);
  if (query.company_text) add(`%${query.company_text}%`, (n) => `(r.company_name ILIKE $${n} OR r.cin ILIKE $${n} OR r.compliance_code ILIKE $${n})`);
  if (query.agent_name) add(`%${query.agent_name}%`, (n) => `r.agent_name ILIKE $${n}`);
  if (query.assigned_to_id) add(query.assigned_to_id, (n) => `r.assigned_to_id=$${n}`);
  if (query.compliance_type) add(query.compliance_type, (n) => `r.compliance_type=$${n}`);
  if (query.company_status) add(query.company_status, (n) => `COALESCE(c.company_status,'Active')=$${n}`);
  const r = await db.query(
    `SELECT r.*, COALESCE(c.company_status,'Active') AS company_status,
            t.default_priority, NULL::varchar AS itr_status, NULL::varchar AS assessment_year
     FROM company_compliance_records r
     LEFT JOIN companies c ON UPPER(c.cin)=UPPER(r.cin)
     LEFT JOIN compliance_templates t ON t.id=r.template_id
     WHERE ${conds.join(' AND ')}
     ORDER BY COALESCE(r.due_date, r.created_at::date), r.company_name, r.compliance_code
     LIMIT 800`,
    params
  );
  return r.rows;
}

async function workspaceCompanyList(financialYear) {
  await ensureSchema();
  const fy = financialYear || currentFY();
  const r = await db.query(
    `SELECT
       c.cin,
       c.company_name,
       c.client_id,
       c.agent_name,
       c.pan_no,
       c.incorporation_date,
       c.company_status,
       COUNT(r.id)::int AS compliance_count,
       COUNT(r.id) FILTER (WHERE r.assigned_to_id IS NOT NULL)::int AS assigned_count,
       COUNT(r.id) FILTER (WHERE r.assigned_to_id IS NULL)::int AS unassigned_count,
       COUNT(r.id) FILTER (WHERE r.status='Filed')::int AS filed_count,
       BOOL_OR(r.id IS NOT NULL)::boolean AS generated
     FROM companies c
     LEFT JOIN company_compliance_records r
       ON UPPER(r.cin)=UPPER(c.cin)
      AND r.financial_year=$1
      AND r.compliance_type <> 'director_kyc'
      AND ${firstYearApplicableSql('r', 'c')}
     WHERE COALESCE(c.company_status,'Active')='Active'
     GROUP BY c.cin, c.company_name, c.client_id, c.agent_name, c.pan_no, c.incorporation_date, c.company_status
     ORDER BY c.company_name
     LIMIT 1000`,
    [fy]
  );
  return {
    financial_year: fy,
    companies: r.rows.map((company) => ({
      ...company,
      applicable: isCompanyApplicableForFY(company, fy),
    })),
  };
}

async function listTemplates() {
  await ensureSchema();
  const [templates, employees] = await Promise.all([
    db.query(`SELECT * FROM compliance_templates ORDER BY sort_order, code`),
    db.query(`SELECT emp_id, COALESCE(formal_name, name) AS name, formal_name, designation, photo FROM emplist WHERE status='Active' ORDER BY COALESCE(formal_name, name)`),
  ]);
  return { templates: templates.rows, employees: employees.rows };
}

async function updateTemplate(id, body, actor) {
  await ensureSchema();
  const old = await db.query(`SELECT * FROM compliance_templates WHERE id=$1`, [id]);
  if (!old.rows.length) {
    const err = new Error('Template not found');
    err.statusCode = 404;
    throw err;
  }
  let assigneeName = body.default_assignee_name || null;
  if (body.default_assignee_id) {
    const emp = await findEmployee(db, body.default_assignee_id);
    if (!emp) {
      const err = new Error('Assignee employee not found or inactive');
      err.statusCode = 400;
      throw err;
    }
    assigneeName = emp.formal_name || emp.name;
  }
  const r = await db.query(
    `UPDATE compliance_templates SET
       name=COALESCE($1,name),
       template_type=COALESCE($2,template_type),
       event_type=$3,
       due_rule=COALESCE($4,due_rule),
       default_priority=COALESCE($5,default_priority),
       default_assignee_id=$6,
       default_assignee_name=$7,
       applicable_company_types=$8,
       enabled=COALESCE($9,enabled),
       sort_order=COALESCE($10,sort_order),
       updated_at=NOW()
     WHERE id=$11 RETURNING *`,
    [
      body.name || null,
      body.template_type && TEMPLATE_TYPES.includes(body.template_type) ? body.template_type : null,
      body.event_type || null,
      body.due_rule || null,
      body.default_priority || null,
      body.default_assignee_id || null,
      assigneeName,
      body.applicable_company_types || null,
      typeof body.enabled === 'boolean' ? body.enabled : null,
      body.sort_order === undefined ? null : parseInt(body.sort_order, 10),
      id,
    ]
  );
  await logHistory(db, { action: 'TemplateUpdate', old_value: old.rows[0], new_value: r.rows[0], actor });
  return r.rows[0];
}

async function createEvent(cin, body, actor) {
  await ensureSchema();
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const co = await conn.query(`SELECT * FROM companies WHERE UPPER(cin)=UPPER($1)`, [cin]);
    if (!co.rows.length) {
      const err = new Error('Company not found');
      err.statusCode = 404;
      throw err;
    }
    const c = co.rows[0];
    const eventRes = await conn.query(
      `INSERT INTO company_compliance_events
        (cin, company_name, event_type, event_title, event_date, remarks, created_by_id, created_by_name)
       VALUES (UPPER($1),$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [cin, c.company_name, body.event_type, body.event_title || body.event_type, body.event_date || todayIST(), body.remarks || null, actorId(actor), actorName(actor)]
    );
    const event = eventRes.rows[0];
    const templates = await conn.query(
      `SELECT * FROM compliance_templates
       WHERE enabled=true AND template_type='event_based' AND event_type=$1
       ORDER BY sort_order, code`,
      [event.event_type]
    );
    let created = 0;
    for (const template of templates.rows) {
      const rec = await insertComplianceRecord(conn, {
        template,
        company: c,
        event_id: event.id,
        financial_year: body.financial_year || financialYearForDate(event.event_date),
        event_type: event.event_type,
        event_date: event.event_date,
        due_date: body.due_date || null,
        assigned_to_id: body.assigned_to_id || null,
        assigned_to_name: body.assigned_to_name || null,
        status: 'Draft',
        source: 'event',
        actor,
      });
      if (rec) {
        created += 1;
        if (rec.assigned_to_id) {
          const taskId = await createTaskForRecord(conn, rec, actor);
          await conn.query(
            `UPDATE company_compliance_records SET linked_task_id=$1, status='Assigned', updated_at=NOW() WHERE id=$2`,
            [taskId, rec.id]
          );
        }
      }
    }
    await conn.query('COMMIT');
    return { event, created };
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function listEvents(cin) {
  await ensureSchema();
  const r = await db.query(`SELECT * FROM company_compliance_events WHERE UPPER(cin)=UPPER($1) ORDER BY event_date DESC, id DESC`, [cin]);
  return r.rows;
}

async function assignRecord(id, assigneeId, actor, remark) {
  await ensureSchema();
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const oldRes = await conn.query(`SELECT r.*, t.default_priority FROM company_compliance_records r LEFT JOIN compliance_templates t ON t.id=r.template_id WHERE r.id=$1 FOR UPDATE OF r`, [id]);
    if (!oldRes.rows.length) {
      const err = new Error('Compliance record not found');
      err.statusCode = 404;
      throw err;
    }
    const old = oldRes.rows[0];
    const emp = await findEmployee(conn, assigneeId);
    if (!emp) {
      const err = new Error('Assignee employee not found or inactive');
      err.statusCode = 400;
      throw err;
    }
    const assigneeName = emp.formal_name || emp.name;
    let linkedTaskId = old.linked_task_id;
    if (linkedTaskId) {
      await conn.query(
        `UPDATE tasks SET assigned_to_id=$1, assigned_to_name=$2, due_date=COALESCE($3::date,due_date),
           last_updated_at=NOW(), last_updated_by_id=$4, last_updated_by_name=$5 WHERE task_id=$6`,
        [emp.emp_id, assigneeName, old.due_date || null, actorId(actor), actorName(actor), linkedTaskId]
      );
    } else {
      linkedTaskId = await createTaskForRecord(conn, { ...old, assigned_to_id: emp.emp_id, assigned_to_name: assigneeName }, actor);
    }
    const upd = await conn.query(
      `UPDATE company_compliance_records SET
         assigned_to_id=$1, assigned_to_name=$2, linked_task_id=$3,
         status=CASE WHEN status='Draft' THEN 'Assigned' ELSE status END,
         remarks=COALESCE($4,remarks), updated_by_id=$5, updated_by_name=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [emp.emp_id, assigneeName, linkedTaskId, remark || null, actorId(actor), actorName(actor), id]
    );
    await logHistory(conn, {
      record_id: id,
      action: 'Assign',
      old_value: { assigned_to_id: old.assigned_to_id, assigned_to_name: old.assigned_to_name, linked_task_id: old.linked_task_id },
      new_value: { assigned_to_id: emp.emp_id, assigned_to_name: assigneeName, linked_task_id: linkedTaskId },
      remarks: remark,
      actor,
    });
    await conn.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function updateRecord(id, body, actor) {
  await ensureSchema();
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const oldRes = await conn.query(`SELECT * FROM company_compliance_records WHERE id=$1 FOR UPDATE`, [id]);
    if (!oldRes.rows.length) {
      const err = new Error('Compliance record not found');
      err.statusCode = 404;
      throw err;
    }
    const old = oldRes.rows[0];
    const status = body.status ? normalizeStatus(body.status) : null;
    const filingDate = status === 'Filed' ? (body.filing_date || todayIST()) : (body.filing_date || null);
    const upd = await conn.query(
      `UPDATE company_compliance_records SET
         status=COALESCE($1,status),
         due_date=COALESCE($2::date,due_date),
         srn=COALESCE($3,srn),
         filing_date=COALESCE($4::date,filing_date),
         remarks=COALESCE($5,remarks),
         updated_by_id=$6,
         updated_by_name=$7,
         updated_at=NOW()
       WHERE id=$8 RETURNING *`,
      [status, body.due_date || null, body.srn || null, filingDate, body.remarks || null, actorId(actor), actorName(actor), id]
    );
    const updated = upd.rows[0];
    if (status && status !== old.status && old.linked_task_id) {
      const taskStatus = taskStatusForCompliance(status);
      const completionDate = ['Completed', 'Cancelled'].includes(taskStatus) ? todayIST() : null;
      await conn.query(
        `UPDATE tasks SET status=$1, completion_date=$2,
           completion_remark=CASE WHEN $1 IN ('Completed','Cancelled') THEN COALESCE($3, completion_remark) ELSE completion_remark END,
           client_pending_remark=CASE WHEN $1='Waiting for Client' THEN COALESCE($3, client_pending_remark) ELSE client_pending_remark END,
           last_updated_at=NOW(), last_updated_by_id=$4, last_updated_by_name=$5
         WHERE task_id=$6`,
        [taskStatus, completionDate, body.remarks || null, actorId(actor), actorName(actor), old.linked_task_id]
      );
    }
    await logHistory(conn, { record_id: id, action: 'Update', old_value: old, new_value: updated, remarks: body.remarks, actor });
    await conn.query('COMMIT');
    return updated;
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function createTaskForRecordId(id, actor) {
  await ensureSchema();
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const recRes = await conn.query(`SELECT r.*, t.default_priority FROM company_compliance_records r LEFT JOIN compliance_templates t ON t.id=r.template_id WHERE r.id=$1 FOR UPDATE OF r`, [id]);
    if (!recRes.rows.length) {
      const err = new Error('Compliance record not found');
      err.statusCode = 404;
      throw err;
    }
    const rec = recRes.rows[0];
    if (!rec.assigned_to_id) {
      const err = new Error('Assign employee before creating task');
      err.statusCode = 400;
      throw err;
    }
    if (rec.linked_task_id) {
      await conn.query('COMMIT');
      return { task_id: rec.linked_task_id, existed: true };
    }
    const taskId = await createTaskForRecord(conn, rec, actor);
    await conn.query(`UPDATE company_compliance_records SET linked_task_id=$1, status=CASE WHEN status='Draft' THEN 'Assigned' ELSE status END, updated_at=NOW() WHERE id=$2`, [taskId, id]);
    await logHistory(conn, { record_id: id, action: 'TaskCreate', new_value: { task_id: taskId }, actor });
    await conn.query('COMMIT');
    return { task_id: taskId, existed: false };
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function syncComplianceForTaskStatus(conn, task, status, actor, remark, srnUdin) {
  await ensureSchema(conn);
  const complianceStatus = complianceStatusForTask(status);
  const kycStatus = kycStatusForTask(status);
  if (!complianceStatus && !kycStatus) return null;
  const recRes = await conn.query(`SELECT * FROM company_compliance_records WHERE linked_task_id=$1 FOR UPDATE`, [task.task_id]);
  if (!recRes.rows.length) {
    const kycRes = await conn.query(`SELECT * FROM director_kyc_tracking WHERE linked_task_id=$1 FOR UPDATE`, [task.task_id]);
    if (!kycRes.rows.length || !kycStatus) return null;
    const kyc = kycRes.rows[0];
    if (kyc.kyc_status === kycStatus) return { kyc_id: kyc.id, status: kycStatus, changed: false };
    await conn.query(
      `UPDATE director_kyc_tracking SET kyc_status=$1, remarks=COALESCE($2,remarks),
         updated_by_id=$3, updated_by_name=$4, updated_at=NOW() WHERE id=$5`,
      [kycStatus, remark || null, actorId(actor), actorName(actor), kyc.id]
    );
    return { kyc_id: kyc.id, status: kycStatus, changed: true };
  }
  const rec = recRes.rows[0];
  const srnValue = String(srnUdin || '').trim() || null;
  if (rec.status === complianceStatus && !remark && !srnValue) return { record_id: rec.id, status: complianceStatus, changed: false };
  const filingDate = complianceStatus === 'Filed' ? todayIST() : rec.filing_date;
  await conn.query(
    `UPDATE company_compliance_records SET status=$1, filing_date=$2, srn=COALESCE($3,srn), remarks=COALESCE($4,remarks),
       updated_by_id=$5, updated_by_name=$6, updated_at=NOW() WHERE id=$7`,
    [complianceStatus, filingDate, srnValue, remark || null, actorId(actor), actorName(actor), rec.id]
  );
  await logHistory(conn, {
    record_id: rec.id,
    action: 'TaskStatusSync',
    old_value: { status: rec.status, task_status: task.status, srn: rec.srn || null },
    new_value: { status: complianceStatus, task_status: status, srn: srnValue || rec.srn || null },
    remarks: remark,
    actor,
  });
  return { record_id: rec.id, status: complianceStatus, changed: true };
}

async function summary(query = {}) {
  await ensureSchema();
  const records = await listRecords(query);
  const today = todayIST();
  const open = records.filter((r) => !['Filed', 'Closed', 'Not Applicable'].includes(r.status));
  return {
    total: records.length,
    open: open.length,
    filed: records.filter((r) => r.status === 'Filed').length,
    overdue: open.filter((r) => r.due_date && dateOnly(r.due_date) < today).length,
    due_today: open.filter((r) => r.due_date && dateOnly(r.due_date) === today).length,
    draft: records.filter((r) => r.status === 'Draft').length,
    by_assignee: Object.values(open.reduce((acc, r) => {
      const key = r.assigned_to_id || 'UNASSIGNED';
      if (!acc[key]) acc[key] = { assigned_to_id: r.assigned_to_id, assigned_to_name: r.assigned_to_name || 'Unassigned', count: 0 };
      acc[key].count += 1;
      return acc;
    }, {})).sort((a, b) => b.count - a.count).slice(0, 20),
  };
}

async function dashboard(financialYear) {
  await ensureSchema();
  const fy = financialYear || currentFY();
  const today = todayIST();
  const [companyCounts, recordCounts, formRows] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE company_status='Active')::int AS active_companies,
         COUNT(*) FILTER (WHERE company_status='Inactive')::int AS inactive_companies
       FROM companies`
    ),
    db.query(
      `WITH active_companies AS (
         SELECT UPPER(cin) AS cin FROM companies WHERE company_status='Active'
       ), fy_records AS (
         SELECT r.* FROM company_compliance_records r
         LEFT JOIN companies c ON UPPER(c.cin)=UPPER(r.cin)
         WHERE r.financial_year=$1
           AND r.compliance_type <> 'director_kyc'
           AND ${firstYearApplicableSql('r', 'c')}
       )
       SELECT
         COUNT(*)::int AS total_records,
         COUNT(*) FILTER (WHERE assigned_to_id IS NOT NULL)::int AS assigned_records,
         COUNT(*) FILTER (WHERE assigned_to_id IS NULL)::int AS unassigned_records,
         COUNT(*) FILTER (WHERE status='Filed')::int AS filed_records,
         COUNT(*) FILTER (WHERE status NOT IN ('Filed','Closed','Not Applicable') AND due_date < $2::date)::int AS overdue_records,
         COUNT(*) FILTER (WHERE status NOT IN ('Filed','Closed','Not Applicable') AND due_date = $2::date)::int AS due_today_records,
         (SELECT COUNT(*)::int FROM active_companies ac
          WHERE EXISTS (SELECT 1 FROM fy_records fr WHERE UPPER(fr.cin)=ac.cin)
            AND NOT EXISTS (SELECT 1 FROM fy_records fr WHERE UPPER(fr.cin)=ac.cin AND fr.assigned_to_id IS NOT NULL)
         ) AS active_companies_not_assigned
       FROM fy_records`,
      [fy, today]
    ),
    db.query(
      `SELECT
         COALESCE(compliance_code, 'DIR-3-KYC') AS form_code,
         COALESCE(compliance_name, 'DIR-3 KYC') AS form_name,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status='Pending')::int AS pending,
         COUNT(*) FILTER (WHERE status='In Progress')::int AS in_progress,
         COUNT(*) FILTER (WHERE status='Pending by Client')::int AS pending_by_client,
         COUNT(*) FILTER (WHERE status='Prepared')::int AS prepared,
         COUNT(*) FILTER (WHERE status='Filed')::int AS filed,
         COUNT(*) FILTER (WHERE status='Not Applicable')::int AS not_applicable,
         COUNT(*) FILTER (WHERE assigned_to_id IS NULL)::int AS unassigned
       FROM (
         SELECT r.compliance_code, r.compliance_name, r.status, r.assigned_to_id
         FROM company_compliance_records r
         LEFT JOIN companies c ON UPPER(c.cin)=UPPER(r.cin)
         WHERE r.financial_year=$1
           AND r.compliance_type <> 'director_kyc'
           AND ${firstYearApplicableSql('r', 'c')}
         UNION ALL
         SELECT 'DIR-3-KYC', 'DIR-3 KYC', kyc_status AS status, assigned_to_id
         FROM director_kyc_tracking
         WHERE financial_year=$1
       ) x
       GROUP BY form_code, form_name
       ORDER BY form_code`,
      [fy]
    ),
  ]);
  return {
    financial_year: fy,
    active_companies: companyCounts.rows[0]?.active_companies || 0,
    inactive_companies: companyCounts.rows[0]?.inactive_companies || 0,
    ...(recordCounts.rows[0] || {}),
    form_status: formRows.rows,
  };
}

async function workspace(cin, financialYear) {
  await ensureSchema();
  const fy = financialYear || currentFY();
  const [companyRes, complianceRes, directorsRes, kycRes, employeeRes, templateRes, itrRes] = await Promise.all([
    db.query(`SELECT * FROM companies WHERE UPPER(cin)=UPPER($1)`, [cin]),
    listRecords({ cin, financial_year: fy }),
    db.query(`SELECT * FROM directors WHERE UPPER(cin)=UPPER($1) AND COALESCE(director_status,'Active')='Active' ORDER BY director_name`, [cin]),
    db.query(`SELECT * FROM director_kyc_tracking WHERE UPPER(cin)=UPPER($1) AND financial_year=$2 ORDER BY director_name`, [cin, fy]),
    db.query(`SELECT emp_id, COALESCE(formal_name, name) AS name, formal_name, designation, photo FROM emplist WHERE status='Active' ORDER BY COALESCE(formal_name, name)`),
    db.query(`SELECT * FROM compliance_templates WHERE enabled=true ORDER BY sort_order, code`),
    db.query(
      `SELECT ifr.*
       FROM income_tax_filing_records ifr
       JOIN income_tax_clients itc ON itc.id=ifr.income_tax_client_id
       JOIN companies c ON (UPPER(c.pan_no)=UPPER(itc.pan_number) OR c.client_id=itc.client_id)
       WHERE UPPER(c.cin)=UPPER($1) AND ifr.financial_year=$2
       ORDER BY ifr.id DESC LIMIT 1`,
      [cin, fy]
    ).catch(() => ({ rows: [] })),
  ]);
  if (!companyRes.rows.length) {
    const err = new Error('Company not found');
    err.statusCode = 404;
    throw err;
  }
  const records = complianceRes || [];
  return {
    financial_year: fy,
    company: companyRes.rows[0],
    annual_records: records.filter((r) => ['annual', 'first_year', 'itr_linked'].includes(r.compliance_type)),
    event_records: records.filter((r) => r.compliance_type === 'event_based'),
    directors: directorsRes.rows,
    kyc_records: kycRes.rows,
    employees: employeeRes.rows,
    templates: templateRes.rows,
    itr_status: itrRes.rows[0] || null,
    status_options: COMPLIANCE_STATUSES,
  };
}

async function fyReport(query = {}) {
  await ensureSchema();
  const fy = query.financial_year || currentFY();
  const conds = [`r.financial_year=$1`, `r.compliance_type <> 'director_kyc'`, firstYearApplicableSql('r', 'c')];
  const params = [fy];
  const add = (value, sql) => {
    params.push(value);
    conds.push(sql(params.length));
  };
  if (query.company_text) add(`%${query.company_text}%`, (n) => `(r.company_name ILIKE $${n} OR r.cin ILIKE $${n})`);
  if (query.form_name) add(`%${query.form_name}%`, (n) => `(r.compliance_code ILIKE $${n} OR r.compliance_name ILIKE $${n})`);
  if (query.status) add(query.status, (n) => `r.status=$${n}`);
  if (query.assigned_to_id) add(query.assigned_to_id, (n) => `r.assigned_to_id=$${n}`);
  if (query.company_status) add(query.company_status, (n) => `COALESCE(c.company_status,'Active')=$${n}`);
  const compliance = await db.query(
    `SELECT
       r.company_name, r.cin, COALESCE(c.company_status,'Active') AS company_status,
       r.compliance_code AS form_name, r.status AS form_status, r.srn AS srn_udin,
       r.assigned_to_name AS assignee_name, r.due_date,
       CASE WHEN r.compliance_type='event_based' THEN r.compliance_name ELSE NULL END AS event_compliance_name,
       r.event_date,
       CASE WHEN r.compliance_type='event_based' THEN r.srn ELSE NULL END AS event_srn_udin,
       CASE WHEN r.compliance_type='event_based' THEN r.assigned_to_name ELSE NULL END AS event_assignee_name,
       NULL::varchar AS director_name, NULL::varchar AS din, NULL::varchar AS kyc_status, NULL::varchar AS kyc_assignee_name,
       'company_compliance' AS row_type
     FROM company_compliance_records r
     LEFT JOIN companies c ON UPPER(c.cin)=UPPER(r.cin)
     WHERE ${conds.join(' AND ')}
     ORDER BY r.company_name, r.compliance_code, r.event_date NULLS LAST
     LIMIT 1000`,
    params
  );

  const kConds = [`dk.financial_year=$1`];
  const kParams = [fy];
  const kAdd = (value, sql) => {
    kParams.push(value);
    kConds.push(sql(kParams.length));
  };
  if (query.company_text) kAdd(`%${query.company_text}%`, (n) => `(dk.company_name ILIKE $${n} OR dk.cin ILIKE $${n})`);
  if (query.status) kAdd(query.status, (n) => `dk.kyc_status=$${n}`);
  if (query.assigned_to_id) kAdd(query.assigned_to_id, (n) => `dk.assigned_to_id=$${n}`);
  if (query.company_status) kAdd(query.company_status, (n) => `COALESCE(c.company_status,'Active')=$${n}`);
  const kyc = await db.query(
    `SELECT
       dk.company_name, dk.cin, COALESCE(c.company_status,'Active') AS company_status,
       'DIR-3 KYC' AS form_name, dk.kyc_status AS form_status, dk.srn AS srn_udin,
       dk.assigned_to_name AS assignee_name, NULL::date AS due_date,
       NULL::varchar AS event_compliance_name, NULL::date AS event_date,
       NULL::varchar AS event_srn_udin, NULL::varchar AS event_assignee_name,
       dk.director_name, dk.din, dk.kyc_status, dk.assigned_to_name AS kyc_assignee_name,
       'director_kyc' AS row_type
     FROM director_kyc_tracking dk
     LEFT JOIN companies c ON UPPER(c.cin)=UPPER(dk.cin)
     WHERE ${kConds.join(' AND ')}
     ORDER BY dk.company_name, dk.director_name
     LIMIT 1000`,
    kParams
  );
  return { financial_year: fy, rows: [...compliance.rows, ...kyc.rows] };
}

async function createTaskForKyc(conn, kyc, actor) {
  if (!kyc.assigned_to_id) return null;
  const taskId = await nextTaskId(conn, actor);
  const createdById = actorId(actor);
  const createdByName = actorName(actor);
  const assigneeName = kyc.assigned_to_name || kyc.assigned_to_id;
  await conn.query(
    `INSERT INTO tasks
      (task_id, created_at, created_by_id, created_by_name, assigned_to_id, assigned_to_name,
       client_id, agent_name, legal_name, business_name, work_name, work_description, priority,
       status, internal_remark, self_assigned, billing_status, active_flag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Medium','Pending',$13,$14,'Not Applicable',true)`,
    [
      taskId,
      nowIST(),
      createdById,
      createdByName,
      kyc.assigned_to_id,
      assigneeName,
      kyc.client_id || null,
      kyc.agent_name || null,
      kyc.company_name || kyc.cin,
      kyc.company_name || kyc.cin,
      `DIR-3 KYC - ${kyc.director_name || kyc.din}`,
      `DIR-3 KYC for ${kyc.director_name || kyc.din} (${kyc.financial_year})`,
      'Auto Director KYC compliance task',
      createdById === kyc.assigned_to_id,
    ]
  );
  await conn.query(
    `INSERT INTO task_history
      (log_id, task_id, action, new_status, new_assigned_to, updated_by_id, updated_by_name, updated_at, remark)
     VALUES ($1,$2,'Created','Pending',$3,$4,$5,NOW(),$6)`,
    [`LOG_${uuidv4().replace(/-/g, '').slice(0, 10)}`, taskId, assigneeName, createdById, createdByName, 'Created from Director KYC tracker']
  );
  return taskId;
}

async function assignKycRecord(id, assigneeId, actor, remark) {
  await ensureSchema();
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const kycRes = await conn.query(`SELECT * FROM director_kyc_tracking WHERE id=$1 FOR UPDATE`, [id]);
    if (!kycRes.rows.length) {
      const err = new Error('KYC record not found');
      err.statusCode = 404;
      throw err;
    }
    const old = kycRes.rows[0];
    const emp = await findEmployee(conn, assigneeId);
    if (!emp) {
      const err = new Error('Assignee employee not found or inactive');
      err.statusCode = 400;
      throw err;
    }
    const assignedName = emp.formal_name || emp.name;
    let taskId = old.linked_task_id;
    if (taskId) {
      await conn.query(
        `UPDATE tasks SET assigned_to_id=$1, assigned_to_name=$2, work_name=$3, last_updated_at=NOW(),
          last_updated_by_id=$4, last_updated_by_name=$5 WHERE task_id=$6`,
        [emp.emp_id, assignedName, `DIR-3 KYC - ${old.director_name || old.din}`, actorId(actor), actorName(actor), taskId]
      );
    } else {
      taskId = await createTaskForKyc(conn, { ...old, assigned_to_id: emp.emp_id, assigned_to_name: assignedName }, actor);
    }
    const upd = await conn.query(
      `UPDATE director_kyc_tracking SET assigned_to_id=$1, assigned_to_name=$2, linked_task_id=$3,
         kyc_status=CASE WHEN kyc_status='Draft' THEN 'Pending' ELSE kyc_status END,
         remarks=COALESCE($4,remarks), updated_by_id=$5, updated_by_name=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [emp.emp_id, assignedName, taskId, remark || null, actorId(actor), actorName(actor), id]
    );
    await conn.query('COMMIT');
    return upd.rows[0];
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function syncTaskForKycStatus(id, status, actor, remark) {
  await ensureSchema();
  if (!status) return null;
  const taskStatus = taskStatusForKyc(status);
  const completionDate = ['Completed', 'Cancelled'].includes(taskStatus) ? todayIST() : null;
  const upd = await db.query(
    `UPDATE tasks t SET status=$1,
       work_name='DIR-3 KYC - ' || COALESCE(NULLIF(dk.director_name,''), dk.din, 'Director'),
       completion_date=CASE WHEN $2::date IS NOT NULL THEN $2::date ELSE completion_date END,
       completion_remark=CASE WHEN $1 IN ('Completed','Cancelled') THEN COALESCE($3, completion_remark) ELSE completion_remark END,
       client_pending_remark=CASE WHEN $1='Waiting for Client' THEN COALESCE($3, client_pending_remark) ELSE client_pending_remark END,
       last_updated_at=NOW(), last_updated_by_id=$4, last_updated_by_name=$5
     FROM director_kyc_tracking dk
     WHERE dk.id=$6 AND dk.linked_task_id=t.task_id
     RETURNING t.task_id, t.status`,
    [taskStatus, completionDate, remark || null, actorId(actor), actorName(actor), id]
  );
  return upd.rows[0] || null;
}

module.exports = {
  COMPLIANCE_STATUSES,
  TEMPLATE_TYPES,
  ensureSchema,
  listTemplates,
  updateTemplate,
  listRecords,
  workspaceCompanyList,
  generateCompanyCompliances,
  bulkGenerateCompanyCompliances,
  autoGenerateForCompany,
  createEvent,
  listEvents,
  assignRecord,
  updateRecord,
  createTaskForRecordId,
  syncComplianceForTaskStatus,
  summary,
  dashboard,
  workspace,
  fyReport,
  ensureKycAssignmentSchema,
  assignKycRecord,
  syncTaskForKycStatus,
};
