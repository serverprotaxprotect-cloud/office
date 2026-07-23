require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS assessment_tests (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    title VARCHAR(200) NOT NULL,
    description TEXT,
    duration_minutes INTEGER NOT NULL DEFAULT 0,
    pass_percent INTEGER NOT NULL DEFAULT 0,
    public_token VARCHAR(64) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT assessment_tests_status_chk CHECK (status IN ('Active','Inactive'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_tests_org ON assessment_tests (organization_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_tests_token ON assessment_tests (public_token)`,

  `CREATE TABLE IF NOT EXISTS assessment_questions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    test_id INTEGER NOT NULL REFERENCES assessment_tests(id) ON DELETE CASCADE,
    sr_no INTEGER NOT NULL DEFAULT 0,
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL DEFAULT '',
    option_b TEXT NOT NULL DEFAULT '',
    option_c TEXT NOT NULL DEFAULT '',
    option_d TEXT NOT NULL DEFAULT '',
    correct_option CHAR(1) NOT NULL,
    marks INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT assessment_questions_correct_chk CHECK (correct_option IN ('A','B','C','D'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_questions_test ON assessment_questions (test_id, sr_no)`,

  `CREATE TABLE IF NOT EXISTS assessment_submissions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    test_id INTEGER NOT NULL REFERENCES assessment_tests(id) ON DELETE CASCADE,
    candidate_name VARCHAR(200) NOT NULL,
    mobile VARCHAR(20),
    email VARCHAR(150),
    position VARCHAR(150),
    total_questions INTEGER NOT NULL DEFAULT 0,
    correct_count INTEGER NOT NULL DEFAULT 0,
    total_marks INTEGER NOT NULL DEFAULT 0,
    scored_marks INTEGER NOT NULL DEFAULT 0,
    score_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
    passed BOOLEAN NOT NULL DEFAULT false,
    answers JSONB NOT NULL DEFAULT '[]',
    interview_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
    remarks TEXT,
    ip_address VARCHAR(50),
    started_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT assessment_submissions_interview_chk CHECK (interview_status IN ('Pending','Shortlisted','Rejected','Interviewed','Selected'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_submissions_test ON assessment_submissions (test_id, submitted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_submissions_org ON assessment_submissions (organization_id, submitted_at DESC)`,

  `ALTER TABLE assessment_tests ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_questions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_submissions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_tests FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_questions FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_submissions FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS assessment_tests_tenant_policy ON assessment_tests`,
  `DROP POLICY IF EXISTS assessment_questions_tenant_policy ON assessment_questions`,
  `DROP POLICY IF EXISTS assessment_submissions_tenant_policy ON assessment_submissions`,
  `CREATE POLICY assessment_tests_tenant_policy ON assessment_tests
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY assessment_questions_tenant_policy ON assessment_questions
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY assessment_submissions_tenant_policy ON assessment_submissions
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run assessment migration.');
    statements.forEach((stmt, i) => console.log(`${i + 1}. ${stmt.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const stmt of statements) await conn.query(stmt);
    await conn.query('COMMIT');
    console.log('Assessment migration applied.');
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
