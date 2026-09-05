require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  // Tracks the one Drive subfolder created for each client/agent, inside the
  // organisation's root Drive folder — so every upload feature (Update Log,
  // Client Documents, Document Collection) puts a party's files in the same
  // place, and we never need to search Drive by name (which would break if
  // a client's display name changes later).
  `CREATE TABLE IF NOT EXISTS party_drive_folders (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    party_type VARCHAR(10) NOT NULL,
    party_id VARCHAR(50) NOT NULL,
    folder_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT party_folder_party_type_chk CHECK (party_type IN ('client','agent')),
    CONSTRAINT party_folder_unique_party UNIQUE (organization_id, party_type, party_id)
  )`,
  `ALTER TABLE party_drive_folders ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE party_drive_folders FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS party_folder_tenant_policy ON party_drive_folders`,
  `CREATE POLICY party_folder_tenant_policy ON party_drive_folders
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run party drive folders migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Party drive folders migration applied.');
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
