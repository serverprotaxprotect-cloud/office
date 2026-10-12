require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Purely additive: new nullable columns plus one new table. Nothing existing is
// altered, dropped or deleted. Lets the admin see which phone each punch came
// from and spot one phone being used by two employees (alert only).
const statements = [
  `ALTER TABLE employee_passkeys ADD COLUMN IF NOT EXISTS device_uid VARCHAR(64)`,
  `ALTER TABLE employee_passkeys ADD COLUMN IF NOT EXISTS user_agent TEXT`,
  `ALTER TABLE employee_passkeys ADD COLUMN IF NOT EXISTS ip_address VARCHAR(80)`,
  `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS passkey_id INTEGER`,
  `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS device_uid VARCHAR(64)`,

  `CREATE TABLE IF NOT EXISTS employee_device_sightings (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    emp_id VARCHAR(50) NOT NULL,
    device_uid VARCHAR(64) NOT NULL,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    seen_count INTEGER NOT NULL DEFAULT 1,
    last_ip VARCHAR(80),
    user_agent TEXT,
    CONSTRAINT employee_device_sightings_unique UNIQUE (organization_id, emp_id, device_uid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_device_sightings_uid ON employee_device_sightings (organization_id, device_uid)`,
  `ALTER TABLE employee_device_sightings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_device_sightings FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS employee_device_sightings_tenant_policy ON employee_device_sightings`,
  `CREATE POLICY employee_device_sightings_tenant_policy ON employee_device_sightings
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run passkey devices migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Passkey devices migration applied.');
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
