require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS pay_type VARCHAR(20) DEFAULT 'Paid'`,
  `ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS leave_pay_type VARCHAR(20)`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS paid_leave_days NUMERIC(8,2) DEFAULT 0`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS unpaid_leave_days NUMERIC(8,2) DEFAULT 0`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS sandwich_days NUMERIC(8,2) DEFAULT 0`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS lop_days NUMERIC(8,2) DEFAULT 0`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS salary_day_basis VARCHAR(40) DEFAULT 'fixed_30'`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS per_day_salary NUMERIC(12,2)`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS effective_grace_minutes NUMERIC(8,2) DEFAULT 0`,
  `ALTER TABLE salary ADD COLUMN IF NOT EXISTS chargeable_late_minutes NUMERIC(8,2) DEFAULT 0`
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to add salary policy columns.');
    statements.forEach((sql, i) => console.log(`${i + 1}. ${sql}`));
    return;
  }

  for (const sql of statements) {
    await db.query(sql);
  }
  console.log('Salary policy migration applied.');
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
