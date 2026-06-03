require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS pf_esic_clients (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    client_id VARCHAR(50) NOT NULL,
    firm_name VARCHAR(255) NOT NULL,
    pf_establishment_code VARCHAR(80),
    pf_login_id VARCHAR(150),
    pf_password_enc TEXT,
    esic_code VARCHAR(80),
    esic_login_id VARCHAR(150),
    esic_password_enc TEXT,
    agent_id VARCHAR(50),
    agent_name VARCHAR(255),
    default_assignee_id VARCHAR(50),
    default_assignee_name VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    inactive_reason TEXT,
    inactive_from DATE,
    source VARCHAR(40) NOT NULL DEFAULT 'manual',
    source_sheet VARCHAR(100),
    source_row INTEGER,
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT pf_esic_clients_status_chk CHECK (status IN ('Active','Inactive'))
  )`,
  `ALTER TABLE pf_esic_clients ADD COLUMN IF NOT EXISTS pf_establishment_code VARCHAR(80)`,
  `ALTER TABLE pf_esic_clients ADD COLUMN IF NOT EXISTS pf_login_id VARCHAR(150)`,
  `ALTER TABLE pf_esic_clients ADD COLUMN IF NOT EXISTS pf_password_enc TEXT`,
  `ALTER TABLE pf_esic_clients ADD COLUMN IF NOT EXISTS esic_code VARCHAR(80)`,
  `ALTER TABLE pf_esic_clients ADD COLUMN IF NOT EXISTS esic_login_id VARCHAR(150)`,
  `ALTER TABLE pf_esic_clients ADD COLUMN IF NOT EXISTS esic_password_enc TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pf_esic_clients_org_pf_code
    ON pf_esic_clients (organization_id, UPPER(pf_establishment_code))
    WHERE NULLIF(pf_establishment_code,'') IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pf_esic_clients_org_esic_code
    ON pf_esic_clients (organization_id, UPPER(esic_code))
    WHERE NULLIF(esic_code,'') IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_clients_org_client ON pf_esic_clients (organization_id, client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_clients_org_status ON pf_esic_clients (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_clients_org_assignee ON pf_esic_clients (organization_id, default_assignee_id)`,
  `CREATE TABLE IF NOT EXISTS pf_esic_filing_records (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    pf_esic_client_id INTEGER NOT NULL REFERENCES pf_esic_clients(id) ON DELETE CASCADE,
    client_id VARCHAR(50) NOT NULL,
    firm_name VARCHAR(255) NOT NULL,
    pf_establishment_code VARCHAR(80),
    esic_code VARCHAR(80),
    compliance_type VARCHAR(40) NOT NULL,
    tax_year INTEGER NOT NULL,
    tax_month INTEGER NOT NULL,
    financial_year VARCHAR(20) NOT NULL,
    period_label VARCHAR(40) NOT NULL,
    due_date DATE NOT NULL,
    assigned_to_id VARCHAR(50),
    assigned_to_name VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'Not Started',
    challan_ack_no VARCHAR(120),
    amount NUMERIC(12,2),
    payment_date DATE,
    linked_task_id VARCHAR(80),
    generated_from VARCHAR(40),
    source_status VARCHAR(50),
    filed_date_ist DATE,
    filed_at TIMESTAMPTZ,
    last_status_at TIMESTAMPTZ,
    status_updated_by_id VARCHAR(50),
    status_updated_by_name VARCHAR(255),
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT pf_esic_filing_type_chk CHECK (compliance_type IN ('PF ECR','PF Challan Payment','ESIC Contribution','ESIC Challan Payment')),
    CONSTRAINT pf_esic_filing_status_chk CHECK (status IN ('Not Started','Pending','Pending by Client','Filed','Paid','Not Applicable'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pf_esic_filing_org_period_type
    ON pf_esic_filing_records (organization_id, pf_esic_client_id, tax_year, tax_month, compliance_type)`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_filing_org_period ON pf_esic_filing_records (organization_id, tax_year, tax_month)`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_filing_org_status ON pf_esic_filing_records (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_filing_org_assignee ON pf_esic_filing_records (organization_id, assigned_to_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_filing_task ON pf_esic_filing_records (organization_id, linked_task_id)`,
  `CREATE TABLE IF NOT EXISTS pf_esic_history_log (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    pf_esic_client_id INTEGER,
    filing_id INTEGER,
    action VARCHAR(50) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    remarks TEXT,
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_history_org_client ON pf_esic_history_log (organization_id, pf_esic_client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_history_org_filing ON pf_esic_history_log (organization_id, filing_id)`,
  `CREATE TABLE IF NOT EXISTS pf_esic_autofill_tokens (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    token_hash VARCHAR(128) NOT NULL UNIQUE,
    pf_esic_client_id INTEGER NOT NULL REFERENCES pf_esic_clients(id) ON DELETE CASCADE,
    portal_type VARCHAR(10) NOT NULL,
    created_by_id VARCHAR(50),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT pf_esic_autofill_portal_chk CHECK (portal_type IN ('PF','ESIC'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pf_esic_autofill_org_client ON pf_esic_autofill_tokens (organization_id, pf_esic_client_id)`,
  `ALTER TABLE pf_esic_clients ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE pf_esic_filing_records ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE pf_esic_history_log ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE pf_esic_autofill_tokens ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE pf_esic_clients FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE pf_esic_filing_records FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE pf_esic_history_log FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE pf_esic_autofill_tokens FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS pf_esic_clients_tenant_policy ON pf_esic_clients`,
  `DROP POLICY IF EXISTS pf_esic_filing_tenant_policy ON pf_esic_filing_records`,
  `DROP POLICY IF EXISTS pf_esic_history_tenant_policy ON pf_esic_history_log`,
  `DROP POLICY IF EXISTS pf_esic_autofill_tenant_policy ON pf_esic_autofill_tokens`,
  `CREATE POLICY pf_esic_clients_tenant_policy ON pf_esic_clients
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY pf_esic_filing_tenant_policy ON pf_esic_filing_records
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY pf_esic_history_tenant_policy ON pf_esic_history_log
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY pf_esic_autofill_tenant_policy ON pf_esic_autofill_tokens
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `INSERT INTO work_names (name, organization_id)
   SELECT v.name, o.id
     FROM (VALUES ('PF ECR'), ('PF Challan Payment'), ('ESIC Contribution'), ('ESIC Challan Payment')) AS v(name)
     CROSS JOIN organizations o
    WHERE NOT EXISTS (
      SELECT 1 FROM work_names w
       WHERE w.organization_id=o.id AND lower(w.name)=lower(v.name)
    )`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run PF/ESIC migration.');
    statements.forEach((stmt, i) => console.log(`${i + 1}. ${stmt.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const stmt of statements) await conn.query(stmt);
    await conn.query('COMMIT');
    console.log('PF/ESIC migration applied.');
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
