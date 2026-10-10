require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Purely additive: one new nullable column on emplist plus three new tables.
// Nothing existing is altered, dropped or deleted.
const tenantPolicy = (table, name) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${name} ON ${table}`,
  `CREATE POLICY ${name} ON ${table}
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

const statements = [
  // Where the previous (company-issued) email goes when an employee's
  // email_id is replaced by their personal one.
  `ALTER TABLE emplist ADD COLUMN IF NOT EXISTS official_email VARCHAR(255)`,

  `CREATE TABLE IF NOT EXISTS employee_campaigns (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    title VARCHAR(200) NOT NULL,
    instruction TEXT,
    field_key VARCHAR(40) NOT NULL,
    field_label VARCHAR(120),
    input_type VARCHAR(20) NOT NULL DEFAULT 'text',
    require_otp BOOLEAN NOT NULL DEFAULT FALSE,
    mandatory_after_days INTEGER,
    blocked_keywords TEXT,
    audience_type VARCHAR(20) NOT NULL DEFAULT 'all',
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    CONSTRAINT emp_campaign_status_chk CHECK (status IN ('Active','Closed')),
    CONSTRAINT emp_campaign_audience_chk CHECK (audience_type IN ('all','selected','designation'))
  )`,
  ...tenantPolicy('employee_campaigns', 'emp_campaign_tenant_policy'),

  `CREATE TABLE IF NOT EXISTS employee_campaign_targets (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    campaign_id INTEGER NOT NULL REFERENCES employee_campaigns(id),
    emp_id VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Pending',
    value TEXT,
    previous_value TEXT,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    submitted_via VARCHAR(20),
    submitted_at TIMESTAMPTZ,
    snoozed_on DATE,
    last_reminded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT emp_campaign_target_status_chk CHECK (status IN ('Pending','Submitted')),
    CONSTRAINT emp_campaign_target_unique UNIQUE (campaign_id, emp_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_emp_campaign_target_emp ON employee_campaign_targets (organization_id, emp_id, status)`,
  ...tenantPolicy('employee_campaign_targets', 'emp_campaign_target_tenant_policy'),

  `CREATE TABLE IF NOT EXISTS employee_campaign_otps (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    campaign_id INTEGER NOT NULL,
    emp_id VARCHAR(50) NOT NULL,
    new_value TEXT NOT NULL,
    code_hash VARCHAR(128) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_emp_campaign_otp_lookup ON employee_campaign_otps (organization_id, campaign_id, emp_id, created_at DESC)`,
  ...tenantPolicy('employee_campaign_otps', 'emp_campaign_otp_tenant_policy'),
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run employee campaigns migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Employee campaigns migration applied.');
  } catch (err) {
    await conn.query('ROLLBACK');
    console.error(err);
    process.exitCode = 1;
  } finally {
    conn.release();
    await db.rawPool.end();
  }
}

run();
