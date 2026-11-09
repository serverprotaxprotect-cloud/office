require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Billing v2: a register (not an invoice maker). Purely additive: new bill_* tables; the old billing_* tables are not touched.
// Usage: node scripts/billing_v2_migrate.js          (dry run)
//        node scripts/billing_v2_migrate.js --apply
const tenantTables = [
  'bill_firms', 'bill_accounts', 'bill_entries', 'bill_entry_tasks', 'bill_task_holds', 'bill_receipts',
  'bill_receipt_allocations', 'bill_payment_requests', 'bill_attachments', 'bill_timeline',
];

const statements = [
  // Firms / brands under one organisation (for example a proprietorship and a private limited company)
  `CREATE TABLE IF NOT EXISTS bill_firms (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    name VARCHAR(200) NOT NULL,
    code VARCHAR(12) NOT NULL,
    legal_type VARCHAR(40),
    pan VARCHAR(20),
    gstin VARCHAR(30),
    address TEXT,
    phone VARCHAR(50),
    email VARCHAR(150),
    status VARCHAR(10) NOT NULL DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_firm_status_chk CHECK (status IN ('Active','Inactive')),
    UNIQUE (organization_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS bill_accounts (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    firm_id INTEGER NOT NULL REFERENCES bill_firms(id),
    account_name VARCHAR(150) NOT NULL,
    account_type VARCHAR(10) NOT NULL DEFAULT 'Bank',
    bank_name VARCHAR(150),
    account_no VARCHAR(80),
    ifsc VARCHAR(30),
    upi_id VARCHAR(120),
    status VARCHAR(10) NOT NULL DEFAULT 'Active',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_account_type_chk CHECK (account_type IN ('Bank','Cash','UPI')),
    CONSTRAINT bill_account_status_chk CHECK (status IN ('Active','Inactive'))
  )`,
  // A bill that was made outside (Tally etc.) and recorded here against works
  `CREATE TABLE IF NOT EXISTS bill_entries (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    firm_id INTEGER NOT NULL REFERENCES bill_firms(id),
    client_id VARCHAR(50) NOT NULL,
    client_name VARCHAR(255),
    bill_no VARCHAR(80) NOT NULL,
    bill_date DATE NOT NULL,
    fees_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    challan_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    gst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    notes TEXT,
    status VARCHAR(10) NOT NULL DEFAULT 'Active',
    cancel_reason TEXT,
    cancelled_by VARCHAR(150),
    cancelled_at TIMESTAMPTZ,
    created_by_id VARCHAR(60),
    created_by_name VARCHAR(150),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_entry_status_chk CHECK (status IN ('Active','Cancelled'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bill_entry_no ON bill_entries (organization_id, firm_id, LOWER(bill_no)) WHERE status='Active'`,
  `CREATE INDEX IF NOT EXISTS idx_bill_entry_client ON bill_entries (organization_id, client_id)`,
  `CREATE TABLE IF NOT EXISTS bill_entry_tasks (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    bill_id INTEGER NOT NULL REFERENCES bill_entries(id),
    task_id VARCHAR(100) NOT NULL,
    task_name VARCHAR(255),
    fees_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    challan_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    other_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    gst_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // A work can be in only one live bill
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bill_task_active ON bill_entry_tasks (organization_id, task_id) WHERE is_active`,
  `CREATE INDEX IF NOT EXISTS idx_bill_task_bill ON bill_entry_tasks (bill_id)`,
  // Works that will not be billed: free, internal, written off
  `CREATE TABLE IF NOT EXISTS bill_task_holds (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    task_id VARCHAR(100) NOT NULL,
    flag VARCHAR(12) NOT NULL,
    reason TEXT,
    set_by VARCHAR(150),
    set_at TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    released_by VARCHAR(150),
    released_at TIMESTAMPTZ,
    CONSTRAINT bill_hold_flag_chk CHECK (flag IN ('Free','Internal','Write-off'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bill_hold_active ON bill_task_holds (organization_id, task_id) WHERE is_active`,
  `CREATE TABLE IF NOT EXISTS bill_receipts (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    receipt_no VARCHAR(80) NOT NULL,
    receipt_date DATE NOT NULL,
    firm_id INTEGER NOT NULL REFERENCES bill_firms(id),
    account_id INTEGER REFERENCES bill_accounts(id),
    client_id VARCHAR(50) NOT NULL,
    client_name VARCHAR(255),
    amount NUMERIC(14,2) NOT NULL,
    mode VARCHAR(20),
    reference_no VARCHAR(120),
    remarks TEXT,
    status VARCHAR(10) NOT NULL DEFAULT 'Active',
    cancel_reason TEXT,
    cancelled_by VARCHAR(150),
    cancelled_at TIMESTAMPTZ,
    created_by_id VARCHAR(60),
    created_by_name VARCHAR(150),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_receipt_status_chk CHECK (status IN ('Active','Cancelled')),
    CONSTRAINT bill_receipt_amount_chk CHECK (amount > 0),
    UNIQUE (organization_id, receipt_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bill_receipt_client ON bill_receipts (organization_id, client_id, firm_id)`,
  `CREATE TABLE IF NOT EXISTS bill_receipt_allocations (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    receipt_id INTEGER NOT NULL REFERENCES bill_receipts(id),
    bill_id INTEGER NOT NULL REFERENCES bill_entries(id),
    amount NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_alloc_amount_chk CHECK (amount > 0),
    UNIQUE (receipt_id, bill_id)
  )`,
  // Payments staff want to make for clients: request, approval, then payment with proof
  `CREATE TABLE IF NOT EXISTS bill_payment_requests (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    request_no VARCHAR(40) NOT NULL,
    client_id VARCHAR(50),
    client_name VARCHAR(255),
    task_id VARCHAR(100),
    task_name VARCHAR(255),
    purpose VARCHAR(40) NOT NULL,
    payee VARCHAR(200),
    amount NUMERIC(14,2) NOT NULL,
    needed_by DATE,
    firm_id INTEGER NOT NULL REFERENCES bill_firms(id),
    account_id INTEGER REFERENCES bill_accounts(id),
    funding VARCHAR(20) NOT NULL DEFAULT 'Firm funds',
    description TEXT,
    status VARCHAR(10) NOT NULL DEFAULT 'Requested',
    requested_by_id VARCHAR(60),
    requested_by_name VARCHAR(150),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    approved_by_id VARCHAR(60),
    approved_by_name VARCHAR(150),
    approved_at TIMESTAMPTZ,
    approved_amount NUMERIC(14,2),
    decision_note TEXT,
    paid_amount NUMERIC(14,2),
    paid_on DATE,
    paid_by_name VARCHAR(150),
    paid_reference VARCHAR(120),
    paid_note TEXT,
    recovered_bill_id INTEGER REFERENCES bill_entries(id),
    refund_receipt_id INTEGER REFERENCES bill_receipts(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_pay_status_chk CHECK (status IN ('Requested','Approved','Rejected','Query','Paid','Cancelled')),
    CONSTRAINT bill_pay_funding_chk CHECK (funding IN ('Client advance','Firm funds')),
    CONSTRAINT bill_pay_amount_chk CHECK (amount > 0),
    UNIQUE (organization_id, request_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bill_pay_status ON bill_payment_requests (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_bill_pay_client ON bill_payment_requests (organization_id, client_id, firm_id)`,
  `CREATE TABLE IF NOT EXISTS bill_attachments (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    request_id INTEGER NOT NULL REFERENCES bill_payment_requests(id),
    kind VARCHAR(10) NOT NULL DEFAULT 'request',
    filename VARCHAR(255),
    mime VARCHAR(80),
    size_bytes INTEGER,
    data BYTEA NOT NULL,
    uploaded_by_name VARCHAR(150),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_attach_kind_chk CHECK (kind IN ('request','proof'))
  )`,
  // Timeline + audit trail for everything (nothing is ever deleted)
  `CREATE TABLE IF NOT EXISTS bill_timeline (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    entity_type VARCHAR(20) NOT NULL,
    entity_id INTEGER NOT NULL,
    action VARCHAR(40) NOT NULL,
    note TEXT,
    actor_name VARCHAR(150),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bill_timeline_entity ON bill_timeline (organization_id, entity_type, entity_id, created_at)`,
  ...tenantTables.flatMap(t => [
    `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ${t}_tenant_policy ON ${t}`,
    `CREATE POLICY ${t}_tenant_policy ON ${t}
       USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
       WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  ]),
];

async function run() {
  if (!process.argv.includes('--apply')) {
    console.log('DRY RUN. Statements that would run:\n');
    statements.forEach(s => console.log(s.split('\n')[0].trim()));
    console.log('\nRun again with --apply.');
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const sql of statements) await conn.query(sql);
    await conn.query('COMMIT');
    console.log('Billing v2 tables ready.');
  } catch (err) {
    await conn.query('ROLLBACK');
    console.error(err);
    process.exitCode = 1;
  } finally {
    conn.release();
  }
}
run().finally(() => db.rawPool.end());
