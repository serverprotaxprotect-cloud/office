require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS gst_clients (
    id SERIAL PRIMARY KEY,
    client_id VARCHAR(50) NOT NULL,
    firm_name VARCHAR(255) NOT NULL,
    gst_no VARCHAR(30),
    gst_login_id VARCHAR(150),
    gst_password_enc TEXT,
    agent_id VARCHAR(50),
    agent_name VARCHAR(255),
    filing_frequency VARCHAR(20) NOT NULL DEFAULT 'Monthly',
    qrmp_gstr3b_due_day INTEGER NOT NULL DEFAULT 22,
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
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT gst_clients_frequency_chk CHECK (filing_frequency IN ('Monthly','QRMP')),
    CONSTRAINT gst_clients_due_day_chk CHECK (qrmp_gstr3b_due_day IN (22,24)),
    CONSTRAINT gst_clients_status_chk CHECK (status IN ('Active','Inactive'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_gst_clients_gst_no_nonblank
    ON gst_clients (UPPER(gst_no))
    WHERE gst_no IS NOT NULL AND BTRIM(gst_no) <> ''`,
  `CREATE INDEX IF NOT EXISTS idx_gst_clients_client_id ON gst_clients (client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_gst_clients_status ON gst_clients (status)`,
  `CREATE TABLE IF NOT EXISTS gst_filing_records (
    id SERIAL PRIMARY KEY,
    gst_client_id INTEGER NOT NULL REFERENCES gst_clients(id) ON DELETE CASCADE,
    client_id VARCHAR(50) NOT NULL,
    firm_name VARCHAR(255) NOT NULL,
    gst_no VARCHAR(30),
    return_type VARCHAR(20) NOT NULL,
    tax_year INTEGER NOT NULL,
    tax_month INTEGER NOT NULL,
    financial_year VARCHAR(20) NOT NULL,
    period_label VARCHAR(40) NOT NULL,
    due_date DATE NOT NULL,
    assigned_to_id VARCHAR(50),
    assigned_to_name VARCHAR(255),
    status VARCHAR(30) NOT NULL DEFAULT 'Not Started',
    linked_task_id VARCHAR(80),
    generated_from VARCHAR(40),
    source_status VARCHAR(50),
    filed_date_ist DATE,
    filed_at TIMESTAMP,
    last_status_at TIMESTAMP,
    status_updated_by_id VARCHAR(50),
    status_updated_by_name VARCHAR(255),
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT gst_filing_return_type_chk CHECK (return_type IN ('GSTR-1','GSTR-3B')),
    CONSTRAINT gst_filing_month_chk CHECK (tax_month BETWEEN 1 AND 12),
    CONSTRAINT gst_filing_status_chk CHECK (status IN ('Not Started','Pending','Pending by Client','Filed','Not Applicable')),
    CONSTRAINT ux_gst_filing_period UNIQUE (gst_client_id, tax_year, tax_month, return_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gst_filing_period ON gst_filing_records (tax_year, tax_month, return_type)`,
  `CREATE INDEX IF NOT EXISTS idx_gst_filing_assignee ON gst_filing_records (assigned_to_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_gst_filing_client ON gst_filing_records (gst_client_id, financial_year)`,
  `CREATE INDEX IF NOT EXISTS idx_gst_filing_task ON gst_filing_records (linked_task_id)`,
  `CREATE TABLE IF NOT EXISTS gst_history_log (
    id SERIAL PRIMARY KEY,
    gst_client_id INTEGER REFERENCES gst_clients(id) ON DELETE SET NULL,
    filing_id INTEGER REFERENCES gst_filing_records(id) ON DELETE SET NULL,
    action VARCHAR(80) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    remarks TEXT,
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    updated_at TIMESTAMP DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gst_history_client ON gst_history_log (gst_client_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_gst_history_filing ON gst_history_log (filing_id, updated_at DESC)`,
  `INSERT INTO work_names (name)
   SELECT 'GSTR-1 Filing'
   WHERE NOT EXISTS (SELECT 1 FROM work_names WHERE name='GSTR-1 Filing')`,
  `INSERT INTO work_names (name)
   SELECT 'GSTR-3B Filing'
   WHERE NOT EXISTS (SELECT 1 FROM work_names WHERE name='GSTR-3B Filing')`,
];

async function main() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run only. Re-run with --apply to create GST tables.');
    console.log(statements.map((s, i) => `-- ${i + 1}\n${s};`).join('\n\n'));
    await db.pool.end();
    return;
  }

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    for (const sql of statements) await conn.query(sql);
    await conn.query('COMMIT');
    console.log('GST migration completed.');
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
