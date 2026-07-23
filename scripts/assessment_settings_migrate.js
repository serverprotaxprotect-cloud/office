require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Incremental: move assessment_config from "questions_per_area" to a fixed
// "total_questions" (split equally across the areas a candidate selects) plus a
// uniform "marks_per_question", and set the new default duration (60 min).
const statements = [
  `ALTER TABLE assessment_config ADD COLUMN IF NOT EXISTS total_questions INTEGER NOT NULL DEFAULT 40`,
  `ALTER TABLE assessment_config ADD COLUMN IF NOT EXISTS marks_per_question NUMERIC(5,2) NOT NULL DEFAULT 2.5`,
  `ALTER TABLE assessment_config ALTER COLUMN duration_minutes SET DEFAULT 60`,
  // No live assessment data yet — align existing config rows with the new defaults.
  `UPDATE assessment_config SET total_questions = 40, marks_per_question = 2.5, duration_minutes = 60`,
  `ALTER TABLE assessment_config DROP COLUMN IF EXISTS questions_per_area`,
  // Candidate marks can now be fractional (2.5 each).
  `ALTER TABLE assessment_candidates ALTER COLUMN total_marks TYPE NUMERIC(7,2)`,
  `ALTER TABLE assessment_candidates ALTER COLUMN scored_marks TYPE NUMERIC(7,2)`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run assessment settings migration.');
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
    console.log('Assessment settings migration applied.');
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
