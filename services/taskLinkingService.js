const db = require('../db');
const { getDueDate: gstDueDate, financialYearForPeriod: gstFY, periodLabel: gstPeriodLabel } = require('../utils/gstUtils');
const { dueDateForAssessmentYear, financialYearForAssessmentYear } = require('../utils/incomeTaxUtils');
const { dueDateForPeriod: pfDueDate, financialYearForPeriod: pfFY, periodLabel: pfPeriodLabel } = require('../utils/pfEsicUtils');
const complianceService = require('./complianceService');
const trademarkService = require('./trademarkService');

const COMPANY_RULES = [
  ['INC-20A', 'INC-20A'],
  ['ADT-1-FIRST', 'ADT-1-FIRST'],
  ['SHARE-CERT-FIRST', 'SHARE-CERT-FIRST'],
  ['STATUTORY-SETUP', 'STATUTORY-SETUP'],
  ['FIN-STMT', 'FIN-STMT'],
  ['AOC-4', 'AOC-4'],
  ['AOC-4 Filing', 'AOC-4'],
  ['MGT-7A', 'MGT-7A'],
  ['MGT-7 Filing', 'MGT-7A'],
  ['MGT-7A Filing', 'MGT-7A'],
  ['Financial Statement Filing', 'FIN-STMT'],
  ['AGM-CHECKLIST', 'AGM-CHECKLIST'],
  ['DIR-12', 'DIR-12'],
  ['PAS-3', 'PAS-3'],
  ['MGT-14', 'MGT-14'],
  ['INC-22', 'INC-22'],
  ['SH-7', 'SH-7'],
  ['CHG-1', 'CHG-1'],
  ['CHG-4', 'CHG-4'],
  ['ADT-1-EVENT', 'ADT-1-EVENT'],
];

const RULE_DEFS = [
  ...COMPANY_RULES.map(([name, code]) => ({ name, module_key: 'company_compliance', module_code: code, requires_period: 'financial_year' })),
  { name: 'DIR-3 KYC', module_key: 'director_kyc', module_code: 'DIR-3-KYC', requires_period: 'financial_year' },
  { name: 'DIN KYC Filing', module_key: 'director_kyc', module_code: 'DIR-3-KYC', requires_period: 'financial_year' },
  { name: 'Directors’ KYC Filing', module_key: 'director_kyc', module_code: 'DIR-3-KYC', requires_period: 'financial_year' },
  { name: "Directors' KYC Filing", module_key: 'director_kyc', module_code: 'DIR-3-KYC', requires_period: 'financial_year' },
  { name: 'GSTR-1 Filing', module_key: 'gst', module_code: 'GSTR-1', requires_period: 'month_year' },
  { name: 'GSTR-1 Preparation', module_key: 'gst', module_code: 'GSTR-1', requires_period: 'month_year' },
  { name: 'GSTR-3B Filing', module_key: 'gst', module_code: 'GSTR-3B', requires_period: 'month_year' },
  { name: 'GSTR-3B Preparation', module_key: 'gst', module_code: 'GSTR-3B', requires_period: 'month_year' },
  ...['ITR-1', 'ITR-2', 'ITR-3', 'ITR-4', 'ITR-5', 'ITR-6', 'ITR-7'].map(code => ({ name: `${code} Preparation and Filing`, module_key: 'income_tax', module_code: code, requires_period: 'assessment_year' })),
  { name: 'ITR Filing', module_key: 'income_tax', module_code: 'ITR', requires_period: 'assessment_year' },
  { name: 'PF ECR Filing', module_key: 'pf_esic', module_code: 'PF ECR', requires_period: 'month_year' },
  { name: 'PF ECR Preparation', module_key: 'pf_esic', module_code: 'PF ECR', requires_period: 'month_year' },
  { name: 'PF Challan Payment', module_key: 'pf_esic', module_code: 'PF Challan Payment', requires_period: 'month_year' },
  { name: 'ESIC Contribution Filing', module_key: 'pf_esic', module_code: 'ESIC Contribution', requires_period: 'month_year' },
  { name: 'ESIC Challan Payment', module_key: 'pf_esic', module_code: 'ESIC Challan Payment', requires_period: 'month_year' },
  { name: 'Trademark Filing', module_key: 'trademark', module_code: 'Trademark Filing', requires_period: 'trademark_application' },
  { name: 'Trademark Application', module_key: 'trademark', module_code: 'Trademark Filing', requires_period: 'trademark_application' },
  { name: 'Trademark Registration', module_key: 'trademark', module_code: 'Registration Certificate', requires_period: 'trademark_application' },
  { name: 'Trademark Examination Reply', module_key: 'trademark', module_code: 'Examination Reply', requires_period: 'trademark_application' },
  { name: 'Trademark Hearing', module_key: 'trademark', module_code: 'Show Cause Hearing', requires_period: 'trademark_application' },
  { name: 'Trademark Opposition', module_key: 'trademark', module_code: 'Opposition Reply', requires_period: 'trademark_application' },
  { name: 'Trademark Renewal', module_key: 'trademark', module_code: 'Renewal', requires_period: 'trademark_application' },
];

let schemaReady = false;
let seedReady = false;

function actorId(actor = {}) { return actor.emp_id || actor.id || actor.username || 'SYSTEM'; }
function actorName(actor = {}) { return actor.formal_name || actor.name || actor.emp_name || 'System'; }
function clean(value) { return String(value || '').trim(); }
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

async function ensureWorkModuleRules(conn = db) {
  if (!schemaReady) {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS work_module_rules (
        id SERIAL PRIMARY KEY,
        work_name_id INTEGER,
        work_name VARCHAR(255) NOT NULL,
        work_category VARCHAR(255),
        department VARCHAR(150),
        module_key VARCHAR(40) NOT NULL,
        module_code VARCHAR(80) NOT NULL,
        requires_period VARCHAR(40) NOT NULL DEFAULT 'none',
        is_mandatory BOOLEAN NOT NULL DEFAULT TRUE,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        source VARCHAR(80) NOT NULL DEFAULT 'system',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_work_module_rules_work_id ON work_module_rules (work_name_id) WHERE enabled=true`);
    await conn.query(`CREATE INDEX IF NOT EXISTS idx_work_module_rules_module ON work_module_rules (module_key, module_code) WHERE enabled=true`);
    await conn.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_work_module_rules_exact
      ON work_module_rules (
        COALESCE(work_name_id,0),
        lower(work_name),
        COALESCE(lower(work_category),''),
        COALESCE(lower(department),''),
        module_key,
        module_code
      )
    `);
    schemaReady = true;
  }
  if (seedReady) return;
  const existingSeed = await conn.query(`SELECT COUNT(*)::int AS count FROM work_module_rules WHERE source='system' AND enabled=true`);
  if ((existingSeed.rows[0]?.count || 0) >= RULE_DEFS.length) {
    seedReady = true;
    return;
  }
  for (const def of RULE_DEFS) {
    const matches = await conn.query(
      `SELECT id, name, work_category, department
         FROM work_names
        WHERE organization_id IS NULL AND lower(name)=lower($1)`,
      [def.name]
    );
    const rows = matches.rows.length ? matches.rows : [{ id: null, name: def.name, work_category: null, department: null }];
    for (const row of rows) {
      await conn.query(
        `INSERT INTO work_module_rules
          (work_name_id, work_name, work_category, department, module_key, module_code, requires_period, is_mandatory, enabled, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,true,'system')
         ON CONFLICT (COALESCE(work_name_id,0), lower(work_name), COALESCE(lower(work_category),''), COALESCE(lower(department),''), module_key, module_code)
         DO UPDATE SET requires_period=EXCLUDED.requires_period, enabled=true, updated_at=NOW()`,
        [row.id, row.name || def.name, row.work_category || null, row.department || null, def.module_key, def.module_code, def.requires_period]
      );
    }
  }
  seedReady = true;
}

async function listRules(conn = db) {
  await ensureWorkModuleRules(conn);
  const r = await conn.query(
    `SELECT id, work_name_id, work_name, work_category, department, module_key, module_code, requires_period, is_mandatory
       FROM work_module_rules
      WHERE enabled=true
      ORDER BY module_key, work_name`
  );
  return r.rows;
}

async function getRule(conn, { rule_id, work_name_id, work_name }) {
  await ensureWorkModuleRules(conn);
  if (rule_id) {
    const r = await conn.query(`SELECT * FROM work_module_rules WHERE id=$1 AND enabled=true`, [rule_id]);
    return r.rows[0] || null;
  }
  if (work_name_id) {
    const r = await conn.query(`SELECT * FROM work_module_rules WHERE work_name_id=$1 AND enabled=true ORDER BY id LIMIT 1`, [work_name_id]);
    if (r.rows[0]) return r.rows[0];
  }
  if (work_name) {
    const r = await conn.query(`SELECT * FROM work_module_rules WHERE lower(work_name)=lower($1) AND enabled=true ORDER BY work_name_id NULLS LAST, id LIMIT 1`, [work_name]);
    return r.rows[0] || null;
  }
  return null;
}

function firstYearFY(dateValue) {
  if (!dateValue) return null;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

function dueDateForCompliance(template, company, financialYear, fallback) {
  if (fallback) return fallback;
  const end = Number(String(financialYear || '').slice(0, 4)) + 1;
  const inc = company?.incorporation_date ? new Date(company.incorporation_date) : null;
  const addDays = (days) => {
    if (!inc || Number.isNaN(inc.getTime())) return null;
    const d = new Date(Date.UTC(inc.getUTCFullYear(), inc.getUTCMonth(), inc.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const rules = {
    FY_PLUS_SEP_30: `${end}-09-30`,
    FY_PLUS_OCT_29: `${end}-10-29`,
    FY_PLUS_OCT_31: `${end}-10-31`,
    FY_PLUS_NOV_28: `${end}-11-28`,
    INCORPORATION_PLUS_30: addDays(30),
    INCORPORATION_PLUS_60: addDays(60),
    INCORPORATION_PLUS_180: addDays(180),
    EVENT_PLUS_15: fallback || null,
    EVENT_PLUS_30: fallback || null,
  };
  return rules[template?.due_rule] || fallback || null;
}

async function getLinkContext(conn, user, query) {
  const rule = await getRule(conn, query);
  if (!rule) return { rule: null, candidates: [], existing_record: null };
  const clientId = clean(query.client_id);
  const out = { rule, candidates: [], existing_record: null, directors: [], message: '' };

  if (rule.module_key === 'company_compliance' || rule.module_key === 'director_kyc') {
    const companies = await conn.query(
      `WITH selected_client AS (
         SELECT legal_name, business_name
           FROM clients
          WHERE client_id=$1
          LIMIT 1
       )
       SELECT c.cin, c.company_name, c.client_id, c.agent_name, c.company_status, c.incorporation_date
         FROM companies c
         LEFT JOIN selected_client sc ON true
        WHERE ($1='' OR c.client_id=$1
          OR regexp_replace(upper(COALESCE(c.company_name,'')), '[^A-Z0-9]', '', 'g') =
             regexp_replace(upper(COALESCE(sc.legal_name,'')), '[^A-Z0-9]', '', 'g')
          OR regexp_replace(upper(COALESCE(c.company_name,'')), '[^A-Z0-9]', '', 'g') =
             regexp_replace(upper(COALESCE(sc.business_name,'')), '[^A-Z0-9]', '', 'g'))
        ORDER BY company_name LIMIT 50`,
      [clientId]
    );
    out.candidates = companies.rows;
    const cin = clean(query.cin || companies.rows[0]?.cin);
    const fy = clean(query.financial_year);
    if (rule.module_key === 'director_kyc' && cin) {
      const directors = await conn.query(
        `SELECT din, director_name, designation, last_kyc_financial_year,
                last_kyc_completed_date, next_kyc_due_date, kyc_cycle_status, kyc_due_reason
           FROM director_details
          WHERE UPPER(cin)=UPPER($1)
          ORDER BY director_name LIMIT 100`,
        [cin]
      );
      out.directors = directors.rows;
    }
    if (cin && fy) {
      if (rule.module_key === 'company_compliance') {
        const rec = await conn.query(
          `SELECT id, compliance_code, compliance_name, financial_year, due_date, status, assigned_to_name, linked_task_id
             FROM company_compliance_records
            WHERE UPPER(cin)=UPPER($1) AND financial_year=$2 AND compliance_code=$3
            ORDER BY id LIMIT 1`,
          [cin, fy, rule.module_code]
        );
        out.existing_record = rec.rows[0] || null;
      } else {
        const din = clean(query.din || out.directors[0]?.din);
        if (din) {
          const directorRow = out.directors.find(d => String(d.din || '') === String(din));
          if (directorRow) {
            out.kyc_cycle = complianceService.deriveDirectorKycCycle(
              directorRow,
              fy,
              { forceReason: clean(query.force_reason) }
            );
          }
          const rec = await conn.query(
            `SELECT id, din, director_name, financial_year, kyc_status AS status, assigned_to_name, linked_task_id
               FROM director_kyc_tracking
              WHERE UPPER(cin)=UPPER($1) AND financial_year=$2 AND din=$3
              ORDER BY id LIMIT 1`,
            [cin, fy, din]
          );
          out.existing_record = rec.rows[0] || null;
        }
      }
    }
    return out;
  }

  if (rule.module_key === 'gst') {
    const clients = await conn.query(`SELECT id, client_id, firm_name, gst_no, filing_frequency, qrmp_gstr3b_due_day FROM gst_clients WHERE client_id=$1 AND status='Active' ORDER BY firm_name`, [clientId]);
    out.candidates = clients.rows;
    const taxYear = num(query.tax_year);
    const taxMonth = num(query.tax_month);
    if (clients.rows[0] && taxYear && taxMonth) {
      const rec = await conn.query(
        `SELECT id, return_type, tax_year, tax_month, period_label, due_date, status, assigned_to_name, linked_task_id
           FROM gst_filing_records
          WHERE gst_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND return_type=$4
          LIMIT 1`,
        [clients.rows[0].id, taxYear, taxMonth, rule.module_code]
      );
      out.existing_record = rec.rows[0] || null;
    }
    return out;
  }

  if (rule.module_key === 'income_tax') {
    const clients = await conn.query(`SELECT id, client_id, taxpayer_name, pan_number FROM income_tax_clients WHERE client_id=$1 AND status='Active' ORDER BY taxpayer_name`, [clientId]);
    out.candidates = clients.rows;
    const ay = clean(query.assessment_year);
    if (clients.rows[0] && ay) {
      const rec = await conn.query(
        `SELECT id, itr_type, assessment_year, due_date, status, assigned_to_name, linked_task_id
           FROM income_tax_filing_records
          WHERE income_tax_client_id=$1 AND assessment_year=$2
          LIMIT 1`,
        [clients.rows[0].id, ay]
      );
      out.existing_record = rec.rows[0] || null;
    }
    return out;
  }

  if (rule.module_key === 'pf_esic') {
    const clients = await conn.query(`SELECT id, client_id, firm_name, pf_establishment_code, esic_code FROM pf_esic_clients WHERE client_id=$1 AND status='Active' ORDER BY firm_name`, [clientId]);
    out.candidates = clients.rows;
    const taxYear = num(query.tax_year);
    const taxMonth = num(query.tax_month);
    if (clients.rows[0] && taxYear && taxMonth) {
      const rec = await conn.query(
        `SELECT id, compliance_type, tax_year, tax_month, period_label, due_date, status, assigned_to_name, linked_task_id
           FROM pf_esic_filing_records
          WHERE pf_esic_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND compliance_type=$4
          LIMIT 1`,
        [clients.rows[0].id, taxYear, taxMonth, rule.module_code]
      );
      out.existing_record = rec.rows[0] || null;
    }
  }

  if (rule.module_key === 'trademark') {
    await trademarkService.ensureTrademarkSchema(conn);
    const apps = await conn.query(
      `SELECT id, client_id, trademark_name, applicant_name, application_number, current_stage,
              current_status, due_date, assigned_to_name, linked_task_id
         FROM trademark_applications
        WHERE client_id=$1 AND status='Active'
        ORDER BY trademark_name, id`,
      [clientId]
    );
    out.candidates = apps.rows;
    const trademarkId = num(query.trademark_id || query.application_id);
    if (trademarkId) {
      const rec = await conn.query(
        `SELECT id, trademark_name, application_number, current_stage, current_status,
                due_date, assigned_to_name, linked_task_id
           FROM trademark_applications
          WHERE id=$1 AND client_id=$2
          LIMIT 1`,
        [trademarkId, clientId]
      );
      out.existing_record = rec.rows[0] || null;
    }
  }
  return out;
}

function duplicateError(taskId) {
  const err = new Error(`This reportable work is already linked to active task ${taskId}.`);
  err.statusCode = 409;
  err.existing_task_id = taskId;
  return err;
}

async function assertNoActiveLinkedTask(conn, taskId) {
  if (!taskId) return;
  const r = await conn.query(`SELECT task_id FROM tasks WHERE task_id=$1 AND active_flag=true AND status NOT IN ('Completed','Cancelled')`, [taskId]);
  if (r.rows.length) throw duplicateError(taskId);
}

async function prepareModuleLink(conn, user, task, taskId) {
  const link = task.module_link || {};
  const rule = await getRule(conn, { rule_id: link.rule_id, work_name_id: task.work_name_id, work_name: task.work_name });
  if (!rule) return null;
  if (!link || !link.confirmed) {
    const err = new Error('Reportable Work Link is required for the selected work name.');
    err.statusCode = 400;
    throw err;
  }
  if (rule.module_key === 'company_compliance') return linkCompanyCompliance(conn, user, task, taskId, rule, link);
  if (rule.module_key === 'director_kyc') return linkDirectorKyc(conn, user, task, taskId, rule, link);
  if (rule.module_key === 'gst') return linkGst(conn, user, task, taskId, rule, link);
  if (rule.module_key === 'income_tax') return linkIncomeTax(conn, user, task, taskId, rule, link);
  if (rule.module_key === 'pf_esic') return linkPfEsic(conn, user, task, taskId, rule, link);
  if (rule.module_key === 'trademark') return linkTrademark(conn, user, task, taskId, rule, link);
  return null;
}

async function linkCompanyCompliance(conn, user, task, taskId, rule, link) {
  const cin = clean(link.cin);
  const financialYear = clean(link.financial_year);
  if (!cin || !financialYear) {
    const err = new Error('Company and financial year are required for reportable company compliance work.');
    err.statusCode = 400;
    throw err;
  }
  const companyRes = await conn.query(`SELECT * FROM companies WHERE UPPER(cin)=UPPER($1) FOR UPDATE`, [cin]);
  if (!companyRes.rows.length) {
    const err = new Error('Company not found for the selected client.');
    err.statusCode = 404;
    throw err;
  }
  const company = companyRes.rows[0];
  const templateRes = await conn.query(`SELECT * FROM compliance_templates WHERE code=$1 AND enabled=true ORDER BY id LIMIT 1`, [rule.module_code]);
  if (!templateRes.rows.length) {
    const err = new Error(`Compliance template ${rule.module_code} is not configured.`);
    err.statusCode = 400;
    throw err;
  }
  const template = templateRes.rows[0];
  if (template.template_type === 'first_year' && firstYearFY(company.incorporation_date) && firstYearFY(company.incorporation_date) !== financialYear) {
    const err = new Error(`${rule.module_code} is first-year only and is not applicable for selected financial year.`);
    err.statusCode = 400;
    throw err;
  }
  let rec = await conn.query(
    `SELECT * FROM company_compliance_records WHERE UPPER(cin)=UPPER($1) AND financial_year=$2 AND compliance_code=$3 FOR UPDATE`,
    [cin, financialYear, rule.module_code]
  );
  if (!rec.rows.length) {
    rec = await conn.query(
      `INSERT INTO company_compliance_records
        (template_id, cin, company_name, client_id, agent_name, compliance_code, compliance_name, compliance_type,
         financial_year, due_date, status, source, created_by_id, created_by_name, updated_by_id, updated_by_name)
       VALUES ($1,UPPER($2),$3,$4,$5,$6,$7,$8,$9,$10,'Assigned','task_direct',$11,$12,$11,$12)
       RETURNING *`,
      [
        template.id, cin, company.company_name, company.client_id, company.agent_name,
        template.code, template.name, template.template_type, financialYear,
        dueDateForCompliance(template, company, financialYear, task.due_date),
        actorId(user), actorName(user),
      ]
    );
  }
  const row = rec.rows[0];
  await assertNoActiveLinkedTask(conn, row.linked_task_id);
  await conn.query(
    `UPDATE company_compliance_records
        SET linked_task_id=$1, assigned_to_id=$2, assigned_to_name=$3,
            status=CASE WHEN status IN ('Draft','Not Started','Pending') THEN 'Assigned' ELSE status END,
            due_date=COALESCE(due_date,$4::date), updated_by_id=$5, updated_by_name=$6, updated_at=NOW()
      WHERE id=$7`,
    [taskId, task.assigned_to_id, task.assigned_to_name, task.due_date || null, actorId(user), actorName(user), row.id]
  );
  return { module_key: rule.module_key, record_id: row.id, label: `${rule.module_code} ${financialYear}` };
}

async function linkDirectorKyc(conn, user, task, taskId, rule, link) {
  await complianceService.ensureKycCycleSchema(conn);
  const cin = clean(link.cin);
  const financialYear = clean(link.financial_year);
  const din = clean(link.din);
  if (!cin || !financialYear || !din) {
    const err = new Error('Company, financial year and director are required for Director KYC work.');
    err.statusCode = 400;
    throw err;
  }
  const company = await conn.query(`SELECT * FROM companies WHERE UPPER(cin)=UPPER($1) LIMIT 1`, [cin]);
  const director = await conn.query(`SELECT * FROM director_details WHERE UPPER(cin)=UPPER($1) AND din=$2 LIMIT 1`, [cin, din]);
  if (!company.rows.length || !director.rows.length) {
    const err = new Error('Company director not found for Director KYC link.');
    err.statusCode = 404;
    throw err;
  }
  const cycle = complianceService.deriveDirectorKycCycle(director.rows[0], financialYear, { forceReason: link.force_reason });
  if (!cycle.due) {
    const err = new Error(cycle.kyc_due_reason || 'Director KYC is not due under the 3-year cycle.');
    err.statusCode = 400;
    throw err;
  }
  let rec = await conn.query(`SELECT * FROM director_kyc_tracking WHERE UPPER(cin)=UPPER($1) AND financial_year=$2 AND din=$3 FOR UPDATE`, [cin, financialYear, din]);
  if (!rec.rows.length) {
    rec = await conn.query(
      `INSERT INTO director_kyc_tracking
        (agent_name, client_id, cin, company_name, din, director_name, financial_year,
         kyc_status, assigned_to_id, assigned_to_name, cycle_due_date, due_reason, generated_under_rule, updated_by_id, updated_by_name)
       VALUES ($1,$2,UPPER($3),$4,$5,$6,$7,'Pending',$8,$9,$10,$11,'DIR3_KYC_3_YEAR_2026',$12,$13)
       RETURNING *`,
      [
        company.rows[0].agent_name || null, company.rows[0].client_id || null, cin, company.rows[0].company_name,
        din, director.rows[0].director_name, financialYear,
        task.assigned_to_id, task.assigned_to_name, cycle.cycle_due_date || null, cycle.kyc_due_reason || null, actorId(user), actorName(user),
      ]
    );
  }
  const row = rec.rows[0];
  await assertNoActiveLinkedTask(conn, row.linked_task_id);
  await conn.query(
    `UPDATE director_kyc_tracking
        SET linked_task_id=$1, assigned_to_id=$2, assigned_to_name=$3,
            kyc_status=CASE WHEN kyc_status IN ('Draft','Not Started') THEN 'Pending' ELSE kyc_status END,
            updated_at=NOW()
      WHERE id=$4`,
    [taskId, task.assigned_to_id, task.assigned_to_name, row.id]
  );
  return { module_key: rule.module_key, record_id: row.id, label: `DIR-3 KYC ${director.rows[0].director_name}` };
}

async function linkGst(conn, user, task, taskId, rule, link) {
  const taxYear = num(link.tax_year);
  const taxMonth = num(link.tax_month);
  if (!taxYear || !taxMonth) {
    const err = new Error('GST month and year are required for reportable GST work.');
    err.statusCode = 400;
    throw err;
  }
  const c = await conn.query(`SELECT * FROM gst_clients WHERE client_id=$1 AND status='Active' ORDER BY id LIMIT 1 FOR UPDATE`, [task.client_id]);
  if (!c.rows.length) {
    const err = new Error('GST client master is not available for the selected client.');
    err.statusCode = 404;
    throw err;
  }
  const client = c.rows[0];
  const due = gstDueDate({ taxYear, taxMonth, returnType: rule.module_code, frequency: client.filing_frequency || 'Monthly', qrmpGstr3bDueDay: client.qrmp_gstr3b_due_day || 22 });
  let rec = await conn.query(`SELECT * FROM gst_filing_records WHERE gst_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND return_type=$4 FOR UPDATE`, [client.id, taxYear, taxMonth, rule.module_code]);
  if (!rec.rows.length) {
    rec = await conn.query(
      `INSERT INTO gst_filing_records
        (gst_client_id, client_id, firm_name, gst_no, return_type, tax_year, tax_month, financial_year,
         period_label, due_date, assigned_to_id, assigned_to_name, status, generated_from, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Pending','task_direct',$13,$14)
       RETURNING *`,
      [client.id, client.client_id, client.firm_name, client.gst_no, rule.module_code, taxYear, taxMonth, gstFY(taxYear, taxMonth), gstPeriodLabel(taxYear, taxMonth), due, task.assigned_to_id, task.assigned_to_name, actorId(user), actorName(user)]
    );
  }
  const row = rec.rows[0];
  await assertNoActiveLinkedTask(conn, row.linked_task_id);
  await conn.query(`UPDATE gst_filing_records SET linked_task_id=$1, assigned_to_id=$2, assigned_to_name=$3, status=CASE WHEN status='Not Started' THEN 'Pending' ELSE status END, updated_at=NOW() WHERE id=$4`, [taskId, task.assigned_to_id, task.assigned_to_name, row.id]);
  return { module_key: rule.module_key, record_id: row.id, label: `${rule.module_code} ${gstPeriodLabel(taxYear, taxMonth)}` };
}

async function linkIncomeTax(conn, user, task, taskId, rule, link) {
  const ay = clean(link.assessment_year);
  if (!ay) {
    const err = new Error('Assessment year is required for reportable Income Tax work.');
    err.statusCode = 400;
    throw err;
  }
  const c = await conn.query(`SELECT * FROM income_tax_clients WHERE client_id=$1 AND status='Active' ORDER BY id LIMIT 1 FOR UPDATE`, [task.client_id]);
  if (!c.rows.length) {
    const err = new Error('Income Tax client master is not available for the selected client.');
    err.statusCode = 404;
    throw err;
  }
  const client = c.rows[0];
  let rec = await conn.query(`SELECT * FROM income_tax_filing_records WHERE income_tax_client_id=$1 AND assessment_year=$2 FOR UPDATE`, [client.id, ay]);
  if (!rec.rows.length) {
    rec = await conn.query(
      `INSERT INTO income_tax_filing_records
        (income_tax_client_id, client_id, taxpayer_name, pan_number, financial_year, assessment_year,
         due_date, itr_type, assigned_to_id, assigned_to_name, status, generated_from, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending','task_direct',$11,$12)
       RETURNING *`,
      [client.id, client.client_id, client.taxpayer_name, client.pan_number, financialYearForAssessmentYear(ay), ay, dueDateForAssessmentYear(ay), rule.module_code === 'ITR' ? null : rule.module_code, task.assigned_to_id, task.assigned_to_name, actorId(user), actorName(user)]
    );
  }
  const row = rec.rows[0];
  await assertNoActiveLinkedTask(conn, row.linked_task_id);
  await conn.query(`UPDATE income_tax_filing_records SET linked_task_id=$1, assigned_to_id=$2, assigned_to_name=$3, itr_type=COALESCE(itr_type,$4), status=CASE WHEN status='Not Started' THEN 'Pending' ELSE status END, updated_at=NOW() WHERE id=$5`, [taskId, task.assigned_to_id, task.assigned_to_name, rule.module_code === 'ITR' ? null : rule.module_code, row.id]);
  return { module_key: rule.module_key, record_id: row.id, label: `${rule.module_code} ${ay}` };
}

async function linkPfEsic(conn, user, task, taskId, rule, link) {
  const taxYear = num(link.tax_year);
  const taxMonth = num(link.tax_month);
  if (!taxYear || !taxMonth) {
    const err = new Error('PF/ESIC month and year are required for reportable work.');
    err.statusCode = 400;
    throw err;
  }
  const c = await conn.query(`SELECT * FROM pf_esic_clients WHERE client_id=$1 AND status='Active' ORDER BY id LIMIT 1 FOR UPDATE`, [task.client_id]);
  if (!c.rows.length) {
    const err = new Error('PF/ESIC client master is not available for the selected client.');
    err.statusCode = 404;
    throw err;
  }
  const client = c.rows[0];
  let rec = await conn.query(`SELECT * FROM pf_esic_filing_records WHERE pf_esic_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND compliance_type=$4 FOR UPDATE`, [client.id, taxYear, taxMonth, rule.module_code]);
  if (!rec.rows.length) {
    rec = await conn.query(
      `INSERT INTO pf_esic_filing_records
        (pf_esic_client_id, client_id, firm_name, pf_establishment_code, esic_code, compliance_type,
         tax_year, tax_month, financial_year, period_label, due_date, assigned_to_id, assigned_to_name,
         status, generated_from, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Pending','task_direct',$14,$15)
       RETURNING *`,
      [client.id, client.client_id, client.firm_name, client.pf_establishment_code, client.esic_code, rule.module_code, taxYear, taxMonth, pfFY(taxYear, taxMonth), pfPeriodLabel(taxYear, taxMonth), pfDueDate(taxYear, taxMonth), task.assigned_to_id, task.assigned_to_name, actorId(user), actorName(user)]
    );
  }
  const row = rec.rows[0];
  await assertNoActiveLinkedTask(conn, row.linked_task_id);
  await conn.query(`UPDATE pf_esic_filing_records SET linked_task_id=$1, assigned_to_id=$2, assigned_to_name=$3, status=CASE WHEN status='Not Started' THEN 'Pending' ELSE status END, updated_at=NOW() WHERE id=$4`, [taskId, task.assigned_to_id, task.assigned_to_name, row.id]);
  return { module_key: rule.module_key, record_id: row.id, label: `${rule.module_code} ${pfPeriodLabel(taxYear, taxMonth)}` };
}

async function linkTrademark(conn, user, task, taskId, rule, link) {
  await trademarkService.ensureTrademarkSchema(conn);
  const trademarkId = num(link.trademark_id || link.application_id);
  if (!trademarkId) {
    const err = new Error('Trademark application selection is required for reportable trademark work.');
    err.statusCode = 400;
    throw err;
  }
  const rec = await conn.query(
    `SELECT * FROM trademark_applications
      WHERE id=$1 AND client_id=$2 AND status='Active'
      FOR UPDATE`,
    [trademarkId, task.client_id]
  );
  if (!rec.rows.length) {
    const err = new Error('Trademark application was not found for the selected client.');
    err.statusCode = 404;
    throw err;
  }
  const row = rec.rows[0];
  await assertNoActiveLinkedTask(conn, row.linked_task_id);
  const nextStage = row.current_stage || rule.module_code || 'Application Filed';
  await conn.query(
    `UPDATE trademark_applications
        SET linked_task_id=$1,
            assigned_to_id=$2,
            assigned_to_name=$3,
            current_stage=COALESCE(NULLIF(current_stage,''),$4),
            current_status=CASE WHEN current_status IN ('Draft','Not Started') THEN 'Pending' ELSE current_status END,
            due_date=COALESCE(due_date,$5::date),
            updated_by_id=$6,
            updated_by_name=$7,
            updated_at=NOW()
      WHERE id=$8`,
    [taskId, task.assigned_to_id, task.assigned_to_name, nextStage, task.due_date || null, actorId(user), actorName(user), row.id]
  );
  await trademarkService.logTrademark(conn, {
    application_id: row.id,
    action: 'task_linked',
    old_value: { linked_task_id: row.linked_task_id },
    new_value: { linked_task_id: taskId, rule: rule.work_name },
    actor: user,
  });
  return { module_key: rule.module_key, record_id: row.id, label: `${row.trademark_name} - ${row.current_stage || rule.module_code}` };
}

async function unlinkedReportableTasks(conn = db, filters = {}) {
  await ensureWorkModuleRules(conn);
  await trademarkService.ensureTrademarkSchema(conn);
  const params = [];
  const conds = [`t.active_flag=true`, `t.status NOT IN ('Completed','Cancelled')`];
  if (filters.search) {
    params.push(`%${filters.search}%`);
    conds.push(`(t.work_name ILIKE $${params.length} OR t.legal_name ILIKE $${params.length} OR t.business_name ILIKE $${params.length} OR t.client_id ILIKE $${params.length})`);
  }
  return conn.query(
    `WITH linked_tasks AS (
       SELECT linked_task_id AS task_id FROM company_compliance_records WHERE linked_task_id IS NOT NULL
       UNION SELECT linked_task_id FROM director_kyc_tracking WHERE linked_task_id IS NOT NULL
       UNION SELECT linked_task_id FROM gst_filing_records WHERE linked_task_id IS NOT NULL
       UNION SELECT linked_task_id FROM income_tax_filing_records WHERE linked_task_id IS NOT NULL
       UNION SELECT linked_task_id FROM pf_esic_filing_records WHERE linked_task_id IS NOT NULL
       UNION SELECT linked_task_id FROM trademark_applications WHERE linked_task_id IS NOT NULL
     )
     SELECT t.task_id, t.client_id, t.legal_name, t.business_name, t.work_name, t.status, t.due_date,
            t.assigned_to_id, t.assigned_to_name,
            COALESCE(r.module_key,
              CASE
                WHEN t.work_name ~* '(AOC\\s*-?\\s*4|MGT\\s*-?\\s*7|INC\\s*-?\\s*20A|ADT\\s*-?\\s*1|PAS\\s*-?\\s*3|DIR\\s*-?\\s*12|INC\\s*-?\\s*22|SH\\s*-?\\s*7|CHG\\s*-?\\s*[14])' THEN 'company_compliance'
                WHEN t.work_name ~* '(DIR\\s*-?\\s*3\\s*KYC|DIN\\s*KYC|Director.*KYC)' THEN 'director_kyc'
                WHEN t.work_name ~* '(GSTR\\s*-?\\s*1|GSTR\\s*-?\\s*3B)' THEN 'gst'
                WHEN t.work_name ~* '(ITR\\s*-?\\s*[1-7]|ITR\\s+Filing)' THEN 'income_tax'
                WHEN t.work_name ~* '(PF\\s+ECR|PF\\s+Challan|ESIC\\s+Contribution|ESIC\\s+Challan)' THEN 'pf_esic'
                WHEN t.work_name ~* '(Trade\\s*mark|Trademark|TM\\s+Application|TM\\s+Reply|TM\\s+Hearing|TM\\s+Opposition|TM\\s+Renewal)' THEN 'trademark'
                ELSE NULL
              END
            ) AS module_key,
            COALESCE(r.module_code,
              CASE
                WHEN t.work_name ~* 'AOC\\s*-?\\s*4' THEN 'AOC-4'
                WHEN t.work_name ~* 'MGT\\s*-?\\s*7' THEN 'MGT-7A'
                WHEN t.work_name ~* 'INC\\s*-?\\s*20A' THEN 'INC-20A'
                WHEN t.work_name ~* 'ADT\\s*-?\\s*1' THEN 'ADT-1'
                WHEN t.work_name ~* 'PAS\\s*-?\\s*3' THEN 'PAS-3'
                WHEN t.work_name ~* 'DIR\\s*-?\\s*12' THEN 'DIR-12'
                WHEN t.work_name ~* 'INC\\s*-?\\s*22' THEN 'INC-22'
                WHEN t.work_name ~* 'SH\\s*-?\\s*7' THEN 'SH-7'
                WHEN t.work_name ~* 'CHG\\s*-?\\s*1' THEN 'CHG-1'
                WHEN t.work_name ~* 'CHG\\s*-?\\s*4' THEN 'CHG-4'
                WHEN t.work_name ~* '(DIR\\s*-?\\s*3\\s*KYC|DIN\\s*KYC|Director.*KYC)' THEN 'DIR-3-KYC'
                WHEN t.work_name ~* 'GSTR\\s*-?\\s*1' THEN 'GSTR-1'
                WHEN t.work_name ~* 'GSTR\\s*-?\\s*3B' THEN 'GSTR-3B'
                WHEN t.work_name ~* 'ITR\\s*-?\\s*([1-7])' THEN upper(regexp_replace(t.work_name, '.*(ITR\\s*-?\\s*[1-7]).*', '\\1', 'i'))
                WHEN t.work_name ~* 'PF\\s+ECR' THEN 'PF ECR'
                WHEN t.work_name ~* 'PF\\s+Challan' THEN 'PF Challan Payment'
                WHEN t.work_name ~* 'ESIC\\s+Contribution' THEN 'ESIC Contribution'
                WHEN t.work_name ~* 'ESIC\\s+Challan' THEN 'ESIC Challan Payment'
                WHEN t.work_name ~* '(Renewal)' THEN 'Renewal'
                WHEN t.work_name ~* '(Opposition)' THEN 'Opposition Reply'
                WHEN t.work_name ~* '(Hearing)' THEN 'Show Cause Hearing'
                WHEN t.work_name ~* '(Reply)' THEN 'Examination Reply'
                WHEN t.work_name ~* '(Trade\\s*mark|Trademark|TM\\s+Application)' THEN 'Trademark Filing'
                ELSE NULL
              END
            ) AS module_code
       FROM tasks t
       LEFT JOIN work_module_rules r ON lower(r.work_name)=lower(t.work_name) AND r.enabled=true
       LEFT JOIN linked_tasks lt ON lt.task_id=t.task_id
      WHERE ${conds.join(' AND ')} AND lt.task_id IS NULL
        AND (
          r.id IS NOT NULL
          OR t.work_name ~* '(AOC\\s*-?\\s*4|MGT\\s*-?\\s*7|INC\\s*-?\\s*20A|ADT\\s*-?\\s*1|PAS\\s*-?\\s*3|DIR\\s*-?\\s*12|INC\\s*-?\\s*22|SH\\s*-?\\s*7|CHG\\s*-?\\s*[14]|DIR\\s*-?\\s*3\\s*KYC|DIN\\s*KYC|Director.*KYC|GSTR\\s*-?\\s*1|GSTR\\s*-?\\s*3B|ITR\\s*-?\\s*[1-7]|ITR\\s+Filing|PF\\s+ECR|PF\\s+Challan|ESIC\\s+Contribution|ESIC\\s+Challan|Trade\\s*mark|Trademark|TM\\s+Application|TM\\s+Reply|TM\\s+Hearing|TM\\s+Opposition|TM\\s+Renewal)'
        )
      ORDER BY t.created_at DESC
      LIMIT 300`,
    params
  );
}

module.exports = {
  ensureWorkModuleRules,
  listRules,
  getLinkContext,
  prepareModuleLink,
  unlinkedReportableTasks,
};
