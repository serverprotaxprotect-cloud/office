require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Adds draft_answers so an in-progress (not yet submitted) test can be
// auto-saved and resumed after a refresh/disconnect/browser-close.
const statements = [
  `ALTER TABLE assessment_candidates ADD COLUMN IF NOT EXISTS draft_answers JSONB NOT NULL DEFAULT '{}'`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run assessment resume migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.bypass_rls','on', true)`);
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Assessment resume migration applied.');
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
