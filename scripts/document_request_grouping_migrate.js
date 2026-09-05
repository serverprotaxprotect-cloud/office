require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Adds bunching (work_name / group_heading), a front/back "side" marker for
// two-sided documents (Aadhaar etc.), and a text-answer path (input_kind /
// text_value) for items that are just information (Mobile Number, Email ID)
// rather than a file — to document_requests. All columns are nullable /
// defaulted so existing rows keep working unchanged.
const statements = [
  `ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS work_name VARCHAR(150)`,
  `ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS group_heading VARCHAR(150)`,
  `ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS input_kind VARCHAR(10) NOT NULL DEFAULT 'file'`,
  `ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS side VARCHAR(10)`,
  `ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS text_value TEXT`,
  `DO $$ BEGIN
    ALTER TABLE document_requests ADD CONSTRAINT doc_req_input_kind_chk CHECK (input_kind IN ('file','text'));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
    ALTER TABLE document_requests ADD CONSTRAINT doc_req_side_chk CHECK (side IS NULL OR side IN ('front','back'));
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run document request grouping migration.');
    statements.forEach((s, i) => console.log(`${i + 1}. ${s.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const s of statements) await conn.query(s);
    await conn.query('COMMIT');
    console.log('Document request grouping migration applied.');
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
