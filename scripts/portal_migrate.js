require('dotenv').config();
const { Pool } = require('pg');
const { hashPassword, isBcryptHash } = require('../utils/passwords');

const statements = [
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_password_hash text`,
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_password_changed_at timestamptz`,
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_last_login_at timestamptz`,
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS portal_enabled boolean NOT NULL DEFAULT false`,
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS portal_password_hash text`,
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS portal_password_changed_at timestamptz`,
  `ALTER TABLE agents ADD COLUMN IF NOT EXISTS portal_last_login_at timestamptz`,
  `CREATE TABLE IF NOT EXISTS portal_reset_tokens (
     id serial PRIMARY KEY,
     organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     account_type varchar(20) NOT NULL CHECK (account_type IN ('client','agent')),
     account_ref_id varchar(80) NOT NULL,
     login_id varchar(120) NOT NULL,
     purpose varchar(20) NOT NULL DEFAULT 'reset',
     channel varchar(20) NOT NULL,
     destination varchar(160) NOT NULL,
     code_hash text NOT NULL,
     expires_at timestamptz NOT NULL,
     used_at timestamptz,
     created_at timestamptz DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_reset_lookup
     ON portal_reset_tokens (account_type, purpose, lower(trim(login_id)), channel, expires_at)`,
  `CREATE TABLE IF NOT EXISTS portal_requests (
     id serial PRIMARY KEY,
     organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     account_type varchar(20) NOT NULL CHECK (account_type IN ('client','agent')),
     client_id varchar(80),
     agent_id varchar(80),
     request_type varchar(80) NOT NULL,
     subject varchar(200) NOT NULL,
     message text NOT NULL,
     status varchar(40) NOT NULL DEFAULT 'Open',
     admin_remark text,
     created_at timestamptz DEFAULT NOW(),
     updated_at timestamptz DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_portal_requests_org_client ON portal_requests (organization_id, client_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_portal_requests_org_agent ON portal_requests (organization_id, agent_id, created_at DESC)`,
];

async function main() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log(statements.join(';\n') + ';');
    return;
  }
  const pool = new Pool({
    connectionString: process.env.OWNER_DATABASE_URL || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    for (const sql of statements) {
      console.log(sql.split('\n')[0]);
      await pool.query(sql);
    }
    for (const table of ['clients', 'agents']) {
      const idColumn = table === 'clients' ? 'client_id' : 'agent_id';
      const rows = await pool.query(
        `SELECT organization_id, ${idColumn} AS id, portal_password_hash
         FROM ${table}
         WHERE portal_password_hash IS NOT NULL AND portal_password_hash <> ''`
      );
      for (const row of rows.rows) {
        if (!isBcryptHash(row.portal_password_hash)) {
          await pool.query(
            `UPDATE ${table}
             SET portal_password_hash=$1, portal_password_changed_at=NOW()
             WHERE organization_id=$2 AND ${idColumn}=$3`,
            [await hashPassword(row.portal_password_hash), row.organization_id, row.id]
          );
        }
      }
    }
    if (process.env.OWNER_DATABASE_URL && process.env.DATABASE_URL) {
      const appUser = new URL(process.env.DATABASE_URL).username.replace(/[^a-zA-Z0-9_]/g, '');
      if (appUser) {
        await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON portal_reset_tokens, portal_requests TO ${appUser}`);
        await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appUser}`);
      }
    }
  } finally {
    await pool.end();
  }
  console.log('Portal migration applied');
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
