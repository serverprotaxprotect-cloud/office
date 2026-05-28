require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS mca_report_settings (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    cin VARCHAR(50) NOT NULL,
    financial_year_from DATE,
    financial_year_to DATE,
    board_meeting_date DATE,
    board_meeting_place VARCHAR(255),
    website VARCHAR(255),
    amount_unit VARCHAR(40) DEFAULT 'Thousand',
    msme_provision BOOLEAN DEFAULT FALSE,
    udin VARCHAR(100),
    director_signatory VARCHAR(255),
    books_address TEXT,
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_mca_report_settings_org_cin ON mca_report_settings (organization_id, UPPER(cin))`,
  `CREATE TABLE IF NOT EXISTS mca_company_auditors (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    cin VARCHAR(50) NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT TRUE,
    firm_name VARCHAR(255) DEFAULT '',
    firm_desig VARCHAR(255) DEFAULT 'Chartered Accountants',
    firm_no VARCHAR(100) DEFAULT '',
    ca_name VARCHAR(255) DEFAULT '',
    ca_desig VARCHAR(100) DEFAULT 'Partner',
    member_no VARCHAR(100) DEFAULT '',
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_mca_company_auditors_org_cin_current ON mca_company_auditors (organization_id, UPPER(cin), is_current)`,
  `CREATE TABLE IF NOT EXISTS mca_firm_auditors (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    nickname VARCHAR(120) DEFAULT '',
    firm_name VARCHAR(255) NOT NULL,
    firm_desig VARCHAR(255) DEFAULT 'Chartered Accountants',
    firm_no VARCHAR(100) DEFAULT '',
    ca_name VARCHAR(255) DEFAULT '',
    ca_desig VARCHAR(100) DEFAULT 'Partner',
    member_no VARCHAR(100) DEFAULT '',
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mca_firm_auditors_org_name ON mca_firm_auditors (organization_id, firm_name)`,
  `CREATE TABLE IF NOT EXISTS mca_format_versions (
    financial_year VARCHAR(20) PRIMARY KEY,
    source_financial_year VARCHAR(20),
    is_available BOOLEAN NOT NULL DEFAULT FALSE,
    title VARCHAR(255) DEFAULT 'Annual Filing Report Preparation',
    applicability_note TEXT DEFAULT 'Only for Small Private Limited Company. Not for Public Company and not for Section 8 Company.',
    release_note TEXT DEFAULT '',
    replacements JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `INSERT INTO mca_format_versions
     (financial_year, source_financial_year, is_available, release_note)
   VALUES
     ('2023-24','2023-24',true,'Format available for Small Private Limited Company annual filing reports.'),
     ('2024-25','2024-25',true,'Format available for Small Private Limited Company annual filing reports.'),
     ('2025-26','2024-25',false,'Format for FY 2025-26 has not been released yet.')
   ON CONFLICT (financial_year) DO NOTHING`,
  `ALTER TABLE mca_report_settings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE mca_report_settings FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation_mca_report_settings ON mca_report_settings`,
  `CREATE POLICY tenant_isolation_mca_report_settings ON mca_report_settings
    USING (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )
    WITH CHECK (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )`,
  `ALTER TABLE mca_company_auditors ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE mca_company_auditors FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation_mca_company_auditors ON mca_company_auditors`,
  `CREATE POLICY tenant_isolation_mca_company_auditors ON mca_company_auditors
    USING (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )
    WITH CHECK (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )`,
  `ALTER TABLE mca_firm_auditors ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE mca_firm_auditors FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS tenant_isolation_mca_firm_auditors ON mca_firm_auditors`,
  `CREATE POLICY tenant_isolation_mca_firm_auditors ON mca_firm_auditors
    USING (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )
    WITH CHECK (
      current_setting('app.bypass_rls', true) = 'on'
      OR organization_id::text = current_setting('app.organization_id', true)
    )`,
];

async function main() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to create MCA Filing tables.');
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
    console.log('MCA Filing migration completed.');
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
    await db.pool.end();
  }
}

main().catch(async (err) => {
  console.error(err);
  try { await db.pool.end(); } catch {}
  process.exit(1);
});
