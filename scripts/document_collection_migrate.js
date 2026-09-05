require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  // One row per requested document. status flow:
  // Pending -> Submitted -> Approved
  //                      \-> (rejected) back to Pending with a remark
  `CREATE TABLE IF NOT EXISTS document_requests (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    party_type VARCHAR(10) NOT NULL,
    party_id VARCHAR(50) NOT NULL,
    document_name VARCHAR(150) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Pending',
    remark TEXT,
    drive_file_id VARCHAR(255),
    filename VARCHAR(255),
    mime_type VARCHAR(100),
    size_bytes INTEGER,
    requested_by_id VARCHAR(50),
    requested_by_name VARCHAR(255),
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    reviewed_by_id VARCHAR(50),
    reviewed_by_name VARCHAR(255),
    reviewed_at TIMESTAMPTZ,
    CONSTRAINT doc_req_party_type_chk CHECK (party_type IN ('client','agent')),
    CONSTRAINT doc_req_status_chk CHECK (status IN ('Pending','Submitted','Approved'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_doc_req_party ON document_requests (organization_id, party_type, party_id, requested_at DESC)`,
  `ALTER TABLE document_requests ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE document_requests FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS doc_req_tenant_policy ON document_requests`,
  `CREATE POLICY doc_req_tenant_policy ON document_requests
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,

  // One reusable, regenerable public upload link per client/agent.
  `CREATE TABLE IF NOT EXISTS party_upload_tokens (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    party_type VARCHAR(10) NOT NULL,
    party_id VARCHAR(50) NOT NULL,
    token VARCHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT party_token_party_type_chk CHECK (party_type IN ('client','agent')),
    CONSTRAINT party_token_unique_party UNIQUE (organization_id, party_type, party_id)
  )`,
  `ALTER TABLE party_upload_tokens ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE party_upload_tokens FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS party_token_tenant_policy ON party_upload_tokens`,
  `CREATE POLICY party_token_tenant_policy ON party_upload_tokens
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,

  // One KYC record per client/agent. Aadhaar is stored encrypted (same
  // AES-256-GCM helper used for Drive refresh tokens) — never plaintext at
  // rest, and only ever decrypted for an explicit admin "show" request.
  `CREATE TABLE IF NOT EXISTS client_kyc_details (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    party_type VARCHAR(10) NOT NULL,
    party_id VARCHAR(50) NOT NULL,
    aadhaar_encrypted TEXT,
    aadhaar_last4 VARCHAR(4),
    date_of_birth DATE,
    category VARCHAR(40),
    bank_account_no VARCHAR(40),
    bank_ifsc VARCHAR(20),
    bank_name VARCHAR(150),
    spouse_father_name VARCHAR(150),
    nominee_name VARCHAR(150),
    nominee_relation VARCHAR(60),
    nominee_mobile VARCHAR(15),
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(255),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT client_kyc_party_type_chk CHECK (party_type IN ('client','agent')),
    CONSTRAINT client_kyc_unique_party UNIQUE (organization_id, party_type, party_id)
  )`,
  `ALTER TABLE client_kyc_details ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE client_kyc_details FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS client_kyc_tenant_policy ON client_kyc_details`,
  `CREATE POLICY client_kyc_tenant_policy ON client_kyc_details
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run document collection migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Document collection migration applied.');
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
