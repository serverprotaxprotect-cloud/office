require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const APPLY = process.argv.includes('--apply');

const statements = [
  `CREATE TABLE IF NOT EXISTS auth_sessions (
     id UUID PRIMARY KEY,
     organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
     user_type VARCHAR(20) NOT NULL,
     user_ref_id INTEGER NOT NULL,
     login_id VARCHAR(120) NOT NULL,
     refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
     user_agent TEXT,
     ip_address VARCHAR(80),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ NOT NULL,
     revoked_at TIMESTAMPTZ,
     revoke_reason TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
     ON auth_sessions (organization_id, user_type, user_ref_id, revoked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
     ON auth_sessions (expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh_hash
     ON auth_sessions (refresh_token_hash)`,
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const client = await db.rawPool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of statements) {
      if (APPLY) {
        await client.query(sql);
        console.log(`OK   ${sql.trim().replace(/\s+/g, ' ').slice(0, 180)}`);
      } else {
        console.log(`PLAN ${sql.trim().replace(/\s+/g, ' ').slice(0, 180)}`);
      }
    }
    await client.query(APPLY ? 'COMMIT' : 'ROLLBACK');
    console.log(APPLY ? 'Auth session migration applied.' : 'Run npm run auth-sessions:migrate:apply to apply.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await db.rawPool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
