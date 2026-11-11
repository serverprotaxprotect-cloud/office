require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
const db = require('../db');

// Bank statement lines that are not yet a client receipt or payment (proprietor money, salary, taxes, unidentified...).
// Each line keeps its place in the bank balance; it can be moved to its real head later.
const T = 'bill_bank_entries';
const statements = [
  `CREATE TABLE IF NOT EXISTS ${T} (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    account_id INTEGER NOT NULL REFERENCES bill_accounts(id),
    tran_id VARCHAR(80),
    entry_date DATE NOT NULL,
    remarks TEXT,
    credit NUMERIC(14,2) NOT NULL DEFAULT 0,
    debit NUMERIC(14,2) NOT NULL DEFAULT 0,
    head VARCHAR(60) NOT NULL DEFAULT 'Suspense',
    auto_head BOOLEAN NOT NULL DEFAULT FALSE,
    note TEXT,
    client_id VARCHAR(50),
    client_name VARCHAR(255),
    linked_receipt_id INTEGER,
    linked_payment_id INTEGER,
    updated_by VARCHAR(150),
    updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT bill_bank_amt_chk CHECK (credit >= 0 AND debit >= 0 AND (credit > 0 OR debit > 0))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_bill_bank_tran ON ${T} (organization_id, account_id, tran_id) WHERE tran_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_bill_bank_head ON ${T} (organization_id, account_id, head, entry_date)`,
  `ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${T}_tenant_policy ON ${T}`,
  `CREATE POLICY ${T}_tenant_policy ON ${T}
     USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
     WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  if (!process.argv.includes('--apply')) { console.log('DRY RUN:'); statements.forEach(s => console.log(' ', s.split('\n')[0])); return; }
  const conn = await db.rawPool.connect();
  try { await conn.query('BEGIN'); for (const s of statements) await conn.query(s); await conn.query('COMMIT'); console.log('Bank entries table ready.'); }
  catch (e) { await conn.query('ROLLBACK'); console.error(e); process.exitCode = 1; } finally { conn.release(); }
}
run().finally(() => db.rawPool.end());
