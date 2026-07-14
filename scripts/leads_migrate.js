const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS lead_sources (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    name VARCHAR(120) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'Active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_sources_org_name
      ON lead_sources (organization_id, lower(name))`,
  `CREATE TABLE IF NOT EXISTS lead_settings (
    organization_id INTEGER PRIMARY KEY,
    next_lead_no INTEGER NOT NULL DEFAULT 1,
    default_agent_id VARCHAR(50),
    default_source VARCHAR(120),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS lead_records (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    lead_no VARCHAR(40) NOT NULL,
    name VARCHAR(180) NOT NULL,
    mobile VARCHAR(30),
    whatsapp VARCHAR(30),
    email VARCHAR(180),
    city VARCHAR(120),
    state VARCHAR(120),
    pincode VARCHAR(12),
    business_name VARCHAR(220),
    service_required VARCHAR(220),
    source VARCHAR(120),
    priority VARCHAR(20) NOT NULL DEFAULT 'Normal',
    status VARCHAR(40) NOT NULL DEFAULT 'New',
    assigned_to_id VARCHAR(50),
    assigned_to_name VARCHAR(180),
    next_followup_date DATE,
    expected_value NUMERIC(14,2) NOT NULL DEFAULT 0,
    remarks TEXT,
    converted_client_id VARCHAR(50),
    converted_at TIMESTAMPTZ,
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(180),
    updated_by_id VARCHAR(50),
    updated_by_name VARCHAR(180),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, lead_no)
  )`,
  `CREATE TABLE IF NOT EXISTS lead_participants (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
    participant_id VARCHAR(50) NOT NULL,
    participant_name VARCHAR(180),
    role VARCHAR(60) NOT NULL DEFAULT 'Collaborator',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, lead_id, participant_id)
  )`,
  `CREATE TABLE IF NOT EXISTS lead_followups (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
    followup_date DATE NOT NULL DEFAULT CURRENT_DATE,
    followup_type VARCHAR(40) NOT NULL DEFAULT 'Call',
    result VARCHAR(60) NOT NULL DEFAULT 'Pending Decision',
    summary TEXT,
    next_followup_date DATE,
    created_by_id VARCHAR(50),
    created_by_name VARCHAR(180),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS lead_status_history (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL REFERENCES lead_records(id) ON DELETE CASCADE,
    action VARCHAR(80) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    remarks TEXT,
    actor_id VARCHAR(50),
    actor_name VARCHAR(180),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_org_status ON lead_records (organization_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_org_assignee ON lead_records (organization_id, assigned_to_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_org_followup ON lead_records (organization_id, next_followup_date, status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_search ON lead_records (organization_id, name, mobile, business_name)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_followups_org_lead ON lead_followups (organization_id, lead_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_participants_user ON lead_participants (organization_id, participant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lead_history_org_lead ON lead_status_history (organization_id, lead_id, created_at DESC)`,
  `ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_settings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_records ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_participants ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_followups ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_status_history ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_sources FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_settings FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_records FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_participants FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_followups FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE lead_status_history FORCE ROW LEVEL SECURITY`,
  ...['lead_sources','lead_settings','lead_records','lead_participants','lead_followups','lead_status_history'].flatMap(table => [
    `DROP POLICY IF EXISTS ${table}_tenant_policy ON ${table}`,
    `CREATE POLICY ${table}_tenant_policy ON ${table}
      USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
      WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`
  ])
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run Lead Management migration.');
    statements.forEach((stmt, i) => console.log(`${i + 1}. ${stmt.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }
  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const stmt of statements) await conn.query(stmt);
    await conn.query('COMMIT');
    console.log('Lead Management migration applied.');
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
