require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS organization_feature_access (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    feature_key VARCHAR(50) NOT NULL,
    access_level VARCHAR(20) NOT NULL DEFAULT 'none',
    updated_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT organization_feature_access_level_chk CHECK (access_level IN ('none','view','full')),
    UNIQUE (organization_id, feature_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_org_feature_access_org_feature ON organization_feature_access (organization_id, feature_key)`,
  `CREATE TABLE IF NOT EXISTS billing_settings (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    invoice_prefix VARCHAR(30) NOT NULL DEFAULT 'INV',
    proforma_prefix VARCHAR(30) NOT NULL DEFAULT 'PRO',
    next_invoice_no INTEGER NOT NULL DEFAULT 1,
    next_proforma_no INTEGER NOT NULL DEFAULT 1,
    gstin VARCHAR(30),
    legal_name VARCHAR(255),
    phone VARCHAR(50),
    email VARCHAR(150),
    address TEXT,
    state VARCHAR(100),
    gst_applicable BOOLEAN NOT NULL DEFAULT TRUE,
    default_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
    upi_id VARCHAR(120),
    upi_name VARCHAR(150),
    terms TEXT,
    bank_details TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (organization_id)
  )`,
  `ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS legal_name VARCHAR(255)`,
  `ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS phone VARCHAR(50)`,
  `ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS email VARCHAR(150)`,
  `ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS address TEXT`,
  `ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS gst_applicable BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS upi_id VARCHAR(120)`,
  `ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS upi_name VARCHAR(150)`,
  `CREATE TABLE IF NOT EXISTS billing_bank_accounts (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    account_name VARCHAR(150) NOT NULL,
    account_type VARCHAR(20) NOT NULL DEFAULT 'Bank',
    bank_name VARCHAR(150),
    account_no VARCHAR(80),
    ifsc VARCHAR(30),
    opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT billing_bank_account_type_chk CHECK (account_type IN ('Bank','Cash')),
    CONSTRAINT billing_bank_account_status_chk CHECK (status IN ('Active','Inactive'))
  )`,
  `CREATE TABLE IF NOT EXISTS billing_documents (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    document_type VARCHAR(20) NOT NULL,
    document_no VARCHAR(80) NOT NULL,
    financial_year VARCHAR(20) NOT NULL,
    document_date DATE NOT NULL DEFAULT CURRENT_DATE,
    client_id VARCHAR(50) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    client_gstin VARCHAR(30),
    client_contact VARCHAR(80),
    client_state VARCHAR(100),
    place_of_supply VARCHAR(120),
    client_address TEXT,
    tax_mode VARCHAR(20) NOT NULL DEFAULT 'Auto',
    taxable_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    cgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    sgst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    igst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'Draft',
    notes TEXT,
    terms TEXT,
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    cancelled_at TIMESTAMPTZ,
    cancelled_by_id VARCHAR(50),
    cancel_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT billing_document_type_chk CHECK (document_type IN ('proforma','invoice')),
    CONSTRAINT billing_document_status_chk CHECK (status IN ('Draft','Final','Cancelled')),
    UNIQUE (organization_id, document_type, document_no)
  )`,
  `ALTER TABLE billing_documents ADD COLUMN IF NOT EXISTS client_contact VARCHAR(80)`,
  `ALTER TABLE billing_documents ADD COLUMN IF NOT EXISTS place_of_supply VARCHAR(120)`,
  `CREATE TABLE IF NOT EXISTS billing_document_lines (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    document_id INTEGER NOT NULL REFERENCES billing_documents(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL DEFAULT 1,
    description TEXT NOT NULL,
    hsn_sac VARCHAR(30),
    quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
    rate NUMERIC(14,2) NOT NULL DEFAULT 0,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE billing_document_lines ADD COLUMN IF NOT EXISTS hsn_sac VARCHAR(30)`,
  `CREATE TABLE IF NOT EXISTS billing_document_tasks (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    document_id INTEGER NOT NULL REFERENCES billing_documents(id) ON DELETE CASCADE,
    line_id INTEGER REFERENCES billing_document_lines(id) ON DELETE CASCADE,
    task_id VARCHAR(100) NOT NULL,
    task_work_name VARCHAR(255),
    task_amount NUMERIC(14,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (organization_id, document_id, task_id)
  )`,
  `CREATE TABLE IF NOT EXISTS billing_receipts (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    receipt_no VARCHAR(80) NOT NULL,
    receipt_date DATE NOT NULL DEFAULT CURRENT_DATE,
    client_id VARCHAR(50) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    bank_account_id INTEGER REFERENCES billing_bank_accounts(id) ON DELETE SET NULL,
    amount NUMERIC(14,2) NOT NULL,
    reference_no VARCHAR(120),
    remarks TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (organization_id, receipt_no)
  )`,
  `CREATE TABLE IF NOT EXISTS billing_receipt_allocations (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    receipt_id INTEGER NOT NULL REFERENCES billing_receipts(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES billing_documents(id) ON DELETE CASCADE,
    amount NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (organization_id, receipt_id, document_id)
  )`,
  `CREATE TABLE IF NOT EXISTS billing_ledger_entries (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    client_id VARCHAR(50) NOT NULL,
    entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
    entry_type VARCHAR(30) NOT NULL,
    document_id INTEGER REFERENCES billing_documents(id) ON DELETE SET NULL,
    receipt_id INTEGER REFERENCES billing_receipts(id) ON DELETE SET NULL,
    debit NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit NUMERIC(14,2) NOT NULL DEFAULT 0,
    narration TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS billing_audit_log (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    entity_type VARCHAR(50) NOT NULL,
    entity_id INTEGER,
    action VARCHAR(50) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    remarks TEXT,
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_billing_docs_org_client ON billing_documents (organization_id, client_id, document_date)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_docs_org_status ON billing_documents (organization_id, document_type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_tasks_org_task ON billing_document_tasks (organization_id, task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_ledger_org_client ON billing_ledger_entries (organization_id, client_id, entry_date)`,
  `CREATE INDEX IF NOT EXISTS idx_billing_receipts_org_client ON billing_receipts (organization_id, client_id, receipt_date)`,
  `ALTER TABLE billing_settings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_bank_accounts ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_documents ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_document_lines ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_document_tasks ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_receipts ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_receipt_allocations ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_ledger_entries ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_audit_log ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_settings FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_bank_accounts FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_documents FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_document_lines FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_document_tasks FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_receipts FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_receipt_allocations FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_ledger_entries FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE billing_audit_log FORCE ROW LEVEL SECURITY`,
  ...['billing_settings','billing_bank_accounts','billing_documents','billing_document_lines','billing_document_tasks','billing_receipts','billing_receipt_allocations','billing_ledger_entries','billing_audit_log'].flatMap(table => [
    `DROP POLICY IF EXISTS ${table}_tenant_policy ON ${table}`,
    `CREATE POLICY ${table}_tenant_policy ON ${table}
      USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`
  ])
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run Billing migration.');
    statements.forEach((stmt, i) => console.log(`${i + 1}. ${stmt.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const stmt of statements) await conn.query(stmt);
    await conn.query('COMMIT');
    console.log('Billing migration applied.');
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
