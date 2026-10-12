require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Purely additive: new nullable/defaulted columns only. Nothing existing is
// altered, dropped or deleted, and every existing row keeps its current values.
const statements = [
  // Staff who do not mark attendance (e.g. Director/Manager) and are paid in full.
  `ALTER TABLE salary_structure ADD COLUMN IF NOT EXISTS attendance_exempt BOOLEAN NOT NULL DEFAULT FALSE`,
  // Days before joining / after leaving (shown separately, not as Absent).
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS not_employed_days NUMERIC(8,2) DEFAULT 0`,
  // Weekly-off/holiday days actually worked, and the extra paid days they earned (only if enabled).
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS holiday_work_days NUMERIC(8,2) DEFAULT 0`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS extra_pay_days NUMERIC(8,2) DEFAULT 0`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run salary improvements migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Salary improvements migration applied.');
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
