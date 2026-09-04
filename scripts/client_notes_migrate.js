require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Client Update Log — a date-wise, locked conversation/instruction record per
// client or agent, with categories and screenshot/PDF attachments. Gated by
// the existing organization_feature_access table (feature_key
// 'client_conversation_log'), same pattern as billing/lead_management.
const statements = [
  `CREATE TABLE IF NOT EXISTS client_conversation_logs (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    party_type VARCHAR(10) NOT NULL,
    party_id VARCHAR(50) NOT NULL,
    category VARCHAR(40) NOT NULL DEFAULT 'Other',
    entry_text TEXT NOT NULL,
    attachments JSONB NOT NULL DEFAULT '[]',
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    edited_by_id VARCHAR(50),
    edited_by_name VARCHAR(255),
    edited_at TIMESTAMPTZ,
    edit_history JSONB NOT NULL DEFAULT '[]',
    CONSTRAINT client_conv_log_party_type_chk CHECK (party_type IN ('client','agent')),
    CONSTRAINT client_conv_log_category_chk CHECK (category IN ('Instruction Given','Client Unreachable','Payment Pending','Estimated Data Used','Follow-up Required','Other'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_client_conv_log_party ON client_conversation_logs (organization_id, party_type, party_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_client_conv_log_org_created ON client_conversation_logs (organization_id, created_at DESC)`,
  `ALTER TABLE client_conversation_logs ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE client_conversation_logs FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS client_conv_log_tenant_policy ON client_conversation_logs`,
  `CREATE POLICY client_conv_log_tenant_policy ON client_conversation_logs
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run client notes migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Client notes migration applied.');
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
