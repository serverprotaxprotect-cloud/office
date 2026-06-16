require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const statements = [
  `CREATE TABLE IF NOT EXISTS employee_monitor_settings (
    organization_id INTEGER PRIMARY KEY DEFAULT current_organization_id(),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    active_task_checkpoint TIME NOT NULL DEFAULT '12:00',
    activity_checkpoint TIME NOT NULL DEFAULT '15:00',
    block_punch_out_on_violation BOOLEAN NOT NULL DEFAULT FALSE,
    overdue_reminder_time TIME NOT NULL DEFAULT '10:00',
    popup_repeat_minutes INTEGER NOT NULL DEFAULT 60,
    repeat_window_days INTEGER NOT NULL DEFAULT 30,
    hr_escalation_day INTEGER NOT NULL DEFAULT 2,
    director_escalation_day INTEGER NOT NULL DEFAULT 3,
    updated_by VARCHAR(80),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE employee_monitor_settings ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE employee_monitor_settings ADD COLUMN IF NOT EXISTS block_punch_out_on_violation BOOLEAN NOT NULL DEFAULT FALSE`,
  `CREATE TABLE IF NOT EXISTS employee_monitor_alerts (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
    emp_id VARCHAR(50) NOT NULL,
    employee_name VARCHAR(255),
    designation VARCHAR(150),
    alert_date DATE NOT NULL,
    alert_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'warning',
    status VARCHAR(40) NOT NULL DEFAULT 'Open',
    title VARCHAR(200) NOT NULL,
    message TEXT NOT NULL,
    reference_key VARCHAR(150) NOT NULL DEFAULT '',
    metadata JSONB,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    escalation_level INTEGER NOT NULL DEFAULT 0,
    acknowledged_at TIMESTAMPTZ,
    explanation TEXT,
    explanation_submitted_at TIMESTAMPTZ,
    reviewed_by_id VARCHAR(80),
    reviewed_by_name VARCHAR(255),
    reviewed_at TIMESTAMPTZ,
    review_remark TEXT,
    resolved_at TIMESTAMPTZ,
    resolution_reason TEXT,
    last_popup_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT employee_monitor_alert_type_chk CHECK (
      alert_type IN ('late_arrival','early_departure','incomplete_hours','no_active_task','no_activity','overdue_work')
    ),
    CONSTRAINT employee_monitor_alert_status_chk CHECK (
      status IN ('Open','Acknowledged','Explanation Submitted','Justified','Rejected','Auto Resolved','Resolved')
    )
  )`,
  `UPDATE employee_monitor_alerts SET reference_key='' WHERE reference_key IS NULL`,
  `ALTER TABLE employee_monitor_alerts ALTER COLUMN reference_key SET DEFAULT ''`,
  `ALTER TABLE employee_monitor_alerts ALTER COLUMN reference_key SET NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_employee_monitor_daily_rule
    ON employee_monitor_alerts (organization_id, emp_id, alert_date, alert_type, reference_key)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_monitor_org_status_date
    ON employee_monitor_alerts (organization_id, status, alert_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_monitor_org_emp_date
    ON employee_monitor_alerts (organization_id, emp_id, alert_date DESC)`,
  `CREATE TABLE IF NOT EXISTS employee_monitor_alert_events (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
    alert_id BIGINT NOT NULL REFERENCES employee_monitor_alerts(id) ON DELETE CASCADE,
    event_type VARCHAR(60) NOT NULL,
    old_status VARCHAR(40),
    new_status VARCHAR(40),
    actor_type VARCHAR(30),
    actor_id VARCHAR(80),
    actor_name VARCHAR(255),
    remarks TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_employee_monitor_events_org_alert
    ON employee_monitor_alert_events (organization_id, alert_id, created_at DESC)`,
  `INSERT INTO employee_monitor_alerts
     (organization_id, emp_id, employee_name, designation, alert_date, alert_type,
      severity, status, title, message, reference_key, explanation,
      explanation_submitted_at, reviewed_by_id, reviewed_by_name, reviewed_at,
      review_remark, resolved_at, created_at, updated_at)
   SELECT organization_id, emp_id, employee_name, designation, alert_date, 'no_activity',
          'critical', status, 'No Meaningful Work Activity',
          'No meaningful task activity was recorded before Punch OUT.',
          'legacy-protocol', explanation, explanation_submitted_at, reviewed_by_id,
          reviewed_by_name, reviewed_at, review_remark, resolved_at, triggered_at, updated_at
     FROM employee_protocol_alerts
   ON CONFLICT DO NOTHING`,
  `INSERT INTO employee_monitor_alert_events
     (organization_id, alert_id, event_type, old_status, new_status, actor_type,
      actor_id, actor_name, remarks, metadata, created_at)
   SELECT h.organization_id, a.id, h.action, h.old_status, h.new_status, h.actor_type,
          h.actor_id, h.actor_name, h.remarks, h.metadata, h.created_at
     FROM employee_protocol_alert_history h
     JOIN employee_protocol_alerts p ON p.id=h.alert_id
     JOIN employee_monitor_alerts a
       ON a.organization_id=p.organization_id AND a.emp_id=p.emp_id
      AND a.alert_date=p.alert_date AND a.alert_type='no_activity'
      AND a.reference_key='legacy-protocol'
    WHERE NOT EXISTS (
      SELECT 1 FROM employee_monitor_alert_events e
       WHERE e.alert_id=a.id AND e.event_type=h.action AND e.created_at=h.created_at
    )`,
  `ALTER TABLE employee_monitor_settings ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_monitor_settings FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_monitor_alerts ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_monitor_alerts FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_monitor_alert_events ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE employee_monitor_alert_events FORCE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS employee_monitor_settings_tenant_policy ON employee_monitor_settings`,
  `DROP POLICY IF EXISTS employee_monitor_alerts_tenant_policy ON employee_monitor_alerts`,
  `DROP POLICY IF EXISTS employee_monitor_events_tenant_policy ON employee_monitor_alert_events`,
  `CREATE POLICY employee_monitor_settings_tenant_policy ON employee_monitor_settings
    USING (current_setting('app.bypass_rls', true)='on' OR organization_id=current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true)='on' OR organization_id=current_organization_id())`,
  `CREATE POLICY employee_monitor_alerts_tenant_policy ON employee_monitor_alerts
    USING (current_setting('app.bypass_rls', true)='on' OR organization_id=current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true)='on' OR organization_id=current_organization_id())`,
  `CREATE POLICY employee_monitor_events_tenant_policy ON employee_monitor_alert_events
    USING (current_setting('app.bypass_rls', true)='on' OR organization_id=current_organization_id())
    WITH CHECK (current_setting('app.bypass_rls', true)='on' OR organization_id=current_organization_id())`,
];

async function run() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Dry run. Use --apply to run employee monitor migration.');
    statements.forEach((statement, index) => console.log(`${index + 1}. ${statement.split('\n')[0]}`));
    await db.rawPool.end();
    return;
  }

  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    for (const statement of statements) await conn.query(statement);
    await conn.query('COMMIT');
    console.log('Employee monitor migration applied.');
  } catch (error) {
    await conn.query('ROLLBACK');
    console.error(error);
    process.exitCode = 1;
  } finally {
    conn.release();
    await db.rawPool.end();
  }
}

run();
