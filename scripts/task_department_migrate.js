require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_name_id INTEGER`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_category VARCHAR(255)`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS grouping_name VARCHAR(255)`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS department VARCHAR(150)`,
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_custom_work BOOLEAN DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_org_department ON tasks (organization_id, department)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_org_work_category ON tasks (organization_id, work_category)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_org_grouping ON tasks (organization_id, grouping_name)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_work_name_id ON tasks (work_name_id) WHERE work_name_id IS NOT NULL`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run task department migration.');
    statements.forEach((stmt, i) => console.log(`${i + 1}. ${stmt.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const stmt of statements) await conn.query(stmt);
    await conn.query('COMMIT');
    console.log('Task department migration applied.');
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
