require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS organization_drive_links (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id() UNIQUE,
    connected_email VARCHAR(255) NOT NULL,
    folder_id VARCHAR(255) NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    connected_by_id VARCHAR(50),
    connected_by_name VARCHAR(255),
    connected_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `ALTER TABLE organization_drive_links ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE organization_drive_links FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS org_drive_link_tenant_policy ON organization_drive_links`,
  `CREATE POLICY org_drive_link_tenant_policy ON organization_drive_links
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run Google Drive link migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Google Drive link migration applied.');
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
