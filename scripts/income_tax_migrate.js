require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS income_tax_clients (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    client_id VARCHAR(50) NOT NULL,
    taxpayer_name VARCHAR(255) NOT NULL,
    contact_number VARCHAR(50),
    pan_number VARCHAR(20) NOT NULL,
    password_enc TEXT,
    reference_client_name VARCHAR(255),
    agent_id VARCHAR(50),
    agent_name VARCHAR(255),
    default_assignee_id VARCHAR(50),
    default_assignee_name VARCHAR(255),
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    inactive_reason TEXT,
    inactive_from DATE,
    source_sheet VARCHAR(100),
    source_row INTEGER,
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT income_tax_clients_status_chk CHECK (status IN ('Active','Inactive'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_income_tax_clients_org_pan
    ON income_tax_clients (organization_id, UPPER(pan_number))
    WHERE NULLIF(pan_number,'') IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_income_tax_clients_org_client ON income_tax_clients (organization_id, client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_income_tax_clients_org_status ON income_tax_clients (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_income_tax_clients_org_assignee ON income_tax_clients (organization_id, default_assignee_id)`,
  `CREATE TABLE IF NOT EXISTS income_tax_filing_records (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    income_tax_client_id INTEGER NOT NULL REFERENCES income_tax_clients(id) ON DELETE CASCADE,
    client_id VARCHAR(50) NOT NULL,
    taxpayer_name VARCHAR(255) NOT NULL,
    pan_number VARCHAR(20) NOT NULL,
    financial_year VARCHAR(20) NOT NULL,
    assessment_year VARCHAR(20) NOT NULL,
    due_date DATE NOT NULL,
    itr_type VARCHAR(20),
    assigned_to_id VARCHAR(50),
    assigned_to_name VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'Not Started',
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
    CONSTRAINT income_tax_filing_status_chk CHECK (status IN ('Not Started','Pending','Pending by Client','Filed','Not Applicable')),
    CONSTRAINT ux_income_tax_filing_year UNIQUE (organization_id, income_tax_client_id, assessment_year)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_income_tax_filing_org_year ON income_tax_filing_records (organization_id, assessment_year)`,
  `CREATE INDEX IF NOT EXISTS idx_income_tax_filing_org_assignee ON income_tax_filing_records (organization_id, assigned_to_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_income_tax_filing_org_task ON income_tax_filing_records (organization_id, linked_task_id)`,
  `CREATE TABLE IF NOT EXISTS income_tax_history_log (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    income_tax_client_id INTEGER REFERENCES income_tax_clients(id) ON DELETE SET NULL,
    filing_id INTEGER REFERENCES income_tax_filing_records(id) ON DELETE SET NULL,
    action VARCHAR(80) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    remarks TEXT,
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_income_tax_history_org_client ON income_tax_history_log (organization_id, income_tax_client_id, updated_at DESC)`,
  `ALTER TABLE income_tax_clients ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE income_tax_clients FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation_income_tax_clients ON income_tax_clients`,
  `CREATE POLICY tenant_isolation_income_tax_clients ON income_tax_clients
    USING (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )
    WITH CHECK (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )`,
  `ALTER TABLE income_tax_filing_records ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE income_tax_filing_records FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation_income_tax_filing_records ON income_tax_filing_records`,
  `CREATE POLICY tenant_isolation_income_tax_filing_records ON income_tax_filing_records
    USING (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )
    WITH CHECK (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )`,
  `ALTER TABLE income_tax_history_log ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE income_tax_history_log FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation_income_tax_history_log ON income_tax_history_log`,
  `CREATE POLICY tenant_isolation_income_tax_history_log ON income_tax_history_log
    USING (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )
    WITH CHECK (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )`,
  `INSERT INTO work_names (name, organization_id)
   SELECT 'ITR Filing', id
   FROM organizations o
   WHERE NOT EXISTS (
     SELECT 1 FROM work_names w
     WHERE w.name='ITR Filing' AND w.organization_id=o.id
   )`,
];

async function main() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to create Income Tax tables.');
    console.log(statements.map((s, i) => `-- ${i + 1}\n${s};`).join('\n\n'));
    await db.pool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.bypass_rls', 'on', false)`);
    for (const sql of statements) await conn.query(sql);
    await conn.query('COMMIT');
    console.log('Income Tax migration completed.');
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
    await db.pool.end();
  }
}

main().catch(async err => {
  console.error(err);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
