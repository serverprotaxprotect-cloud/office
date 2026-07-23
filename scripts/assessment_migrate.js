require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Adaptive candidate assessment: questions tagged by Area + Level, one public
// link per org, candidate self-selects level + expertise areas.
const statements = [
  // Remove the first (simple) version's tables — safe, they held no live data.
  `DROP TABLE IF EXISTS assessment_submissions CASCADE`,
  `DROP TABLE IF EXISTS assessment_questions CASCADE`,
  `DROP TABLE IF EXISTS assessment_tests CASCADE`,

  `CREATE TABLE IF NOT EXISTS assessment_areas (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    name VARCHAR(100) NOT NULL,
    sr_no INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_assessment_areas_org_name ON assessment_areas (organization_id, lower(name))`,

  `CREATE TABLE IF NOT EXISTS assessment_config (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER UNIQUE DEFAULT current_organization_id(),
    public_token VARCHAR(64) NOT NULL UNIQUE,
    questions_per_area INTEGER NOT NULL DEFAULT 5,
    duration_minutes INTEGER NOT NULL DEFAULT 0,
    pass_percent INTEGER NOT NULL DEFAULT 0,
    welcome_text TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_by VARCHAR(255),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT assessment_config_status_chk CHECK (status IN ('Active','Inactive'))
  )`,

  `CREATE TABLE IF NOT EXISTS assessment_questions (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    area_id INTEGER NOT NULL REFERENCES assessment_areas(id) ON DELETE CASCADE,
    level VARCHAR(20) NOT NULL,
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL DEFAULT '',
    option_b TEXT NOT NULL DEFAULT '',
    option_c TEXT NOT NULL DEFAULT '',
    option_d TEXT NOT NULL DEFAULT '',
    correct_option CHAR(1) NOT NULL,
    marks INTEGER NOT NULL DEFAULT 1,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT assessment_questions_correct_chk CHECK (correct_option IN ('A','B','C','D')),
    CONSTRAINT assessment_questions_level_chk CHECK (level IN ('Intern','Executive','Intermediate','Expert'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_questions_pick ON assessment_questions (organization_id, area_id, level, active)`,

  `CREATE TABLE IF NOT EXISTS assessment_candidates (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    name VARCHAR(200) NOT NULL,
    mobile VARCHAR(20) NOT NULL,
    email VARCHAR(150),
    position VARCHAR(150),
    level VARCHAR(20),
    areas JSONB NOT NULL DEFAULT '[]',
    served_question_ids JSONB NOT NULL DEFAULT '[]',
    submit_token VARCHAR(64),
    status VARCHAR(20) NOT NULL DEFAULT 'Registered',
    total_questions INTEGER NOT NULL DEFAULT 0,
    correct_count INTEGER NOT NULL DEFAULT 0,
    total_marks INTEGER NOT NULL DEFAULT 0,
    scored_marks INTEGER NOT NULL DEFAULT 0,
    score_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
    passed BOOLEAN NOT NULL DEFAULT false,
    answers JSONB NOT NULL DEFAULT '[]',
    area_breakdown JSONB NOT NULL DEFAULT '[]',
    interview_status VARCHAR(30) NOT NULL DEFAULT 'Pending',
    remarks TEXT,
    ip_address VARCHAR(50),
    started_at TIMESTAMPTZ DEFAULT NOW(),
    submitted_at TIMESTAMPTZ,
    CONSTRAINT assessment_candidates_status_chk CHECK (status IN ('Registered','Completed')),
    CONSTRAINT assessment_candidates_interview_chk CHECK (interview_status IN ('Pending','Shortlisted','Rejected','Interviewed','Selected'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_candidates_mobile ON assessment_candidates (organization_id, mobile)`,
  `CREATE INDEX IF NOT EXISTS idx_assessment_candidates_org ON assessment_candidates (organization_id, submitted_at DESC)`,

  `ALTER TABLE assessment_areas ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_config ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_questions ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_candidates ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_areas FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_config FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_questions FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE assessment_candidates FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS assessment_areas_tenant_policy ON assessment_areas`,
  `DROP POLICY IF EXISTS assessment_config_tenant_policy ON assessment_config`,
  `DROP POLICY IF EXISTS assessment_questions_tenant_policy ON assessment_questions`,
  `DROP POLICY IF EXISTS assessment_candidates_tenant_policy ON assessment_candidates`,
  `CREATE POLICY assessment_areas_tenant_policy ON assessment_areas
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY assessment_config_tenant_policy ON assessment_config
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY assessment_questions_tenant_policy ON assessment_questions
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY assessment_candidates_tenant_policy ON assessment_candidates
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run adaptive assessment migration.');
    statements.forEach((stmt, i) => console.log(`${i + 1}. ${stmt.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const stmt of statements) await conn.query(stmt);
    await conn.query('COMMIT');
    console.log('Adaptive assessment migration applied.');
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
