require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
const db = require('../db');
// Receipts / payments that were entered by hand but are not on the bank statement are kept out of the bank balance until checked.
const statements = [
  `ALTER TABLE bill_receipts ADD COLUMN IF NOT EXISTS not_in_bank BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE bill_payment_requests ADD COLUMN IF NOT EXISTS not_in_bank BOOLEAN NOT NULL DEFAULT FALSE`,
];
(async () => {
  if (!process.argv.includes('--apply')) { statements.forEach(s => console.log(s)); return; }
  for (const s of statements) await db.rawPool.query(s);
  console.log('not_in_bank columns ready.');
})().finally(() => db.rawPool.end());
