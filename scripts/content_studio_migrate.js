require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

// Purely additive: three new tables for Gee Bharat Studio. Nothing existing is altered, dropped or deleted.
// Usage: node scripts/content_studio_migrate.js          (dry run: prints the plan)
//        node scripts/content_studio_migrate.js --apply   (creates the tables)
const tenantPolicy = (table, name) => [
  `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS ${name} ON ${table}`,
  `CREATE POLICY ${name} ON ${table}
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

const statements = [
  // People who can use the Studio: employees of the office (chosen by an admin) and outside "guests".
  `CREATE TABLE IF NOT EXISTS studio_members (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    member_type VARCHAR(10) NOT NULL,
    emp_id VARCHAR(50),
    name VARCHAR(150) NOT NULL,
    mobile VARCHAR(30),
    email VARCHAR(255),
    login_id VARCHAR(120),
    password_hash TEXT,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    role VARCHAR(12) NOT NULL DEFAULT 'Presenter',
    status VARCHAR(10) NOT NULL DEFAULT 'Active',
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_login_at TIMESTAMPTZ,
    CONSTRAINT studio_member_type_chk CHECK (member_type IN ('employee','guest')),
    CONSTRAINT studio_member_role_chk CHECK (role IN ('Presenter','Writer')),
    CONSTRAINT studio_member_status_chk CHECK (status IN ('Active','Disabled'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_studio_member_emp ON studio_members (organization_id, emp_id) WHERE emp_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_studio_member_login ON studio_members (LOWER(login_id)) WHERE login_id IS NOT NULL`,
  ...tenantPolicy('studio_members', 'studio_member_tenant_policy'),

  `CREATE TABLE IF NOT EXISTS studio_topics (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    title VARCHAR(250) NOT NULL,
    category VARCHAR(40),
    platform VARCHAR(40),
    hook TEXT,
    script TEXT,
    key_points TEXT,
    reference_url TEXT,
    duration_label VARCHAR(40),
    shoot_date DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'Idea',
    presenter_id INTEGER,
    writer_id INTEGER,
    presenter_note TEXT,
    video_url TEXT,
    created_by VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT studio_topic_status_chk CHECK (status IN ('Idea','Script Ready','Ready to Shoot','Shot','Editing','Published','Archived'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_studio_topic_org_status ON studio_topics (organization_id, status)`,
  ...tenantPolicy('studio_topics', 'studio_topic_tenant_policy'),

  `CREATE TABLE IF NOT EXISTS studio_ideas (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER DEFAULT current_organization_id(),
    idea_text TEXT NOT NULL,
    submitted_by_member INTEGER,
    submitted_by_name VARCHAR(150),
    status VARCHAR(12) NOT NULL DEFAULT 'New',
    topic_id INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT studio_idea_status_chk CHECK (status IN ('New','Converted','Dismissed'))
  )`,
  ...tenantPolicy('studio_ideas', 'studio_idea_tenant_policy'),
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('DRY RUN. Statements that would run:\n');
    statements.forEach(s => console.log(s.split('\n')[0].trim()));
    console.log('\nRun again with --apply to create the tables.');
    return;
  }
  for (const sql of statements) await db.rawPool.query(sql);
  console.log('Content Studio tables ready.');
}

run().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => db.rawPool.end());
