require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Purely additive: two new tables and one nullable column. Nothing existing
// is altered, dropped or deleted. The feature itself stays OFF until an admin
// sets PASSKEY_POLICY (attendance_settings) to 'optional' or 'enforced'.
const tenantPolicy = (table, name) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${name} ON ${table}`,
  `CREATE POLICY ${name} ON ${table}
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

const statements = [
  `CREATE TABLE IF NOT EXISTS employee_passkeys (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    emp_id VARCHAR(50) NOT NULL,
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0,
    transports TEXT,
    device_label VARCHAR(120),
    backed_up BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by VARCHAR(100),
    CONSTRAINT employee_passkeys_credential_unique UNIQUE (credential_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_employee_passkeys_emp ON employee_passkeys (organization_id, emp_id)`,
  ...tenantPolicy('employee_passkeys', 'employee_passkeys_tenant_policy'),

  // Challenges live in the DB (Vercel serverless has no shared memory).
  // One-time use, short expiry. organization_id is NULL for pre-login challenges.
  `CREATE TABLE IF NOT EXISTS passkey_challenges (
    token VARCHAR(64) PRIMARY KEY,
    organization_id INTEGER,
    emp_id VARCHAR(50),
    purpose VARCHAR(20) NOT NULL,
    challenge TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT passkey_challenge_purpose_chk CHECK (purpose IN ('register','login','punch'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_passkey_challenges_expiry ON passkey_challenges (expires_at)`,
  ...tenantPolicy('passkey_challenges', 'passkey_challenges_tenant_policy'),

  `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS verified_by VARCHAR(20)`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run passkeys migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Passkeys migration applied.');
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
