require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Per-organisation feature switches (set from the super admin page). Safe to run again: IF NOT EXISTS only.
const statements = [
  `CREATE TABLE IF NOT EXISTS organization_feature_access (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    feature_key VARCHAR(50) NOT NULL,
    access_level VARCHAR(20) NOT NULL DEFAULT 'none',
    updated_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT organization_feature_access_level_chk CHECK (access_level IN ('none','view','full')),
    UNIQUE (organization_id, feature_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_org_feature_access_org_feature ON organization_feature_access (organization_id, feature_key)`,
];

async function run() {
  if (!process.argv.includes('--apply')) {
    console.log('Dry run. Use --apply to run.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  for (const s of statements) await db.rawPool.query(s);
  console.log('Feature access table ready.');
  await db.rawPool.end();
}
run().catch(err => { console.error(err); process.exitCode = 1; });
