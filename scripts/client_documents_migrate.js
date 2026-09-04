require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS client_documents (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    party_type VARCHAR(10) NOT NULL,
    party_id VARCHAR(50) NOT NULL,
    financial_year VARCHAR(10) NOT NULL,
    document_name VARCHAR(150) NOT NULL,
    description TEXT,
    drive_file_id VARCHAR(255) NOT NULL,
    filename VARCHAR(255),
    mime_type VARCHAR(100),
    size_bytes INTEGER,
    uploaded_by_id VARCHAR(50),
    uploaded_by_name VARCHAR(255),
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT client_doc_party_type_chk CHECK (party_type IN ('client','agent'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_client_doc_party ON client_documents (organization_id, party_type, party_id, financial_year DESC, uploaded_at DESC)`,
  `ALTER TABLE client_documents ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE client_documents FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS client_doc_tenant_policy ON client_documents`,
  `CREATE POLICY client_doc_tenant_policy ON client_documents
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run client documents migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Client documents migration applied.');
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
