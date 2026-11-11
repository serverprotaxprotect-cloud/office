require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Additive only: opening balance for accounts, and the task created for an approved payment.
const statements = [
  `ALTER TABLE bill_accounts ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0`,
  `ALTER TABLE bill_accounts ADD COLUMN IF NOT EXISTS opening_date DATE`,
  `ALTER TABLE bill_payment_requests ADD COLUMN IF NOT EXISTS pay_task_id VARCHAR(100)`,
  `CREATE INDEX IF NOT EXISTS idx_bill_pay_task ON bill_payment_requests (pay_task_id) WHERE pay_task_id IS NOT NULL`,
];

async function run() {
  if (!process.argv.includes('--apply')) {
    console.log('DRY RUN:'); statements.forEach(s => console.log(' ', s)); return;
  }
  for (const s of statements) await db.rawPool.query(s);
  console.log('Billing v2 phase 2 migration applied.');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.rawPool.end());
