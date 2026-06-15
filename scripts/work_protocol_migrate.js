require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS employee_work_activity (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
    emp_id VARCHAR(50) NOT NULL,
    employee_name VARCHAR(255),
    activity_date DATE NOT NULL,
    activity_type VARCHAR(50) NOT NULL,
    task_id VARCHAR(100),
    description TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_employee_work_activity_org_emp_date
    ON employee_work_activity (organization_id, emp_id, activity_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_work_activity_org_task
    ON employee_work_activity (organization_id, task_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS employee_protocol_alerts (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
    emp_id VARCHAR(50) NOT NULL,
    employee_name VARCHAR(255),
    designation VARCHAR(150),
    alert_date DATE NOT NULL,
    status VARCHAR(40) NOT NULL DEFAULT 'Open',
    punch_out_time TIME,
    explanation TEXT,
    explanation_submitted_at TIMESTAMPTZ,
    reviewed_by_id VARCHAR(80),
    reviewed_by_name VARCHAR(255),
    reviewed_at TIMESTAMPTZ,
    review_remark TEXT,
    resolved_at TIMESTAMPTZ,
    auto_resolved_activity_id BIGINT REFERENCES employee_work_activity(id),
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT employee_protocol_alert_status_chk CHECK (
      status IN ('Open','Explanation Submitted','Justified','Rejected','Auto Resolved')
    ),
    UNIQUE (organization_id, emp_id, alert_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_employee_protocol_alerts_org_status_date
    ON employee_protocol_alerts (organization_id, status, alert_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_protocol_alerts_org_emp_date
    ON employee_protocol_alerts (organization_id, emp_id, alert_date DESC)`,
  `CREATE TABLE IF NOT EXISTS employee_protocol_alert_history (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
    alert_id BIGINT NOT NULL REFERENCES employee_protocol_alerts(id) ON DELETE CASCADE,
    action VARCHAR(60) NOT NULL,
    old_status VARCHAR(40),
    new_status VARCHAR(40),
    actor_type VARCHAR(30),
    actor_id VARCHAR(80),
    actor_name VARCHAR(255),
    remarks TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_employee_protocol_history_org_alert
    ON employee_protocol_alert_history (organization_id, alert_id, created_at DESC)`,
  `ALTER TABLE employee_work_activity ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_work_activity FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_protocol_alerts ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_protocol_alerts FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_protocol_alert_history ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_protocol_alert_history FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS employee_work_activity_tenant_policy ON employee_work_activity`,
  `DROP POLICY IF EXISTS employee_protocol_alerts_tenant_policy ON employee_protocol_alerts`,
  `DROP POLICY IF EXISTS employee_protocol_history_tenant_policy ON employee_protocol_alert_history`,
  `CREATE POLICY employee_work_activity_tenant_policy ON employee_work_activity
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY employee_protocol_alerts_tenant_policy ON employee_protocol_alerts
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
  `CREATE POLICY employee_protocol_history_tenant_policy ON employee_protocol_alert_history
    USING (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR organization_id = current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run work protocol migration.');
    statements.forEach((stmt, i) => console.log(`${i + 1}. ${stmt.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }

  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const stmt of statements) await conn.query(stmt);
    await conn.query('COMMIT');
    console.log('Work protocol migration applied.');
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
