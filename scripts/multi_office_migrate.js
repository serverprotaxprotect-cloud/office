require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}

const db = require('../db');
const { isBcryptHash, hashPassword } = require('../utils/passwords');

const APPLY = process.argv.includes('--apply');
const DEFAULT_ORG_CODE = 'GB-001';

const TENANT_TABLES = [
  'activity_log',
  'admins',
  'agents',
  'attendance_log',
  'attendance_requests',
  'attendance_sessions',
  'attendance_settings',
  'auto_salary_slip',
  'board_meetings',
  'clients',
  'companies',
  'compliance_activity_log',
  'compliance_master',
  'compliance_records',
  'compliance_tracking',
  'daily_attendance',
  'director_details',
  'director_kyc_tracking',
  'directors',
  'document_vault',
  'emp_sessions',
  'emplist',
  'grace_log',
  'gst_clients',
  'gst_filing_records',
  'gst_history_log',
  'holidays',
  'income_tax_clients',
  'income_tax_filing_records',
  'income_tax_history_log',
  'index_of_charges',
  'leave_requests',
  'master_data',
  'notices',
  'notifications',
  'password_reset_tokens',
  'salary',
  'salary_slip',
  'salary_structure',
  'salary_verify',
  'share_links',
  'shareholders',
  'systems_dashboard',
  'task_history',
  'tasks',
  'work_names',
];

const SHARED_TABLES = ['task_priority_master', 'task_status_master'];

async function tableExists(conn, table) {
  const res = await conn.query(
    `SELECT to_regclass($1) AS exists`,
    [`public.${table}`]
  );
  return Boolean(res.rows[0].exists);
}

async function columnExists(conn, table, column) {
  const res = await conn.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return Boolean(res.rows.length);
}

async function exec(conn, sql) {
  if (!APPLY) {
    console.log(`[dry-run] ${sql.trim().replace(/\s+/g, ' ').slice(0, 220)}`);
    return;
  }
  await conn.query(sql);
}

async function setupCore(conn) {
  await exec(conn, `
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      org_code VARCHAR(40) NOT NULL UNIQUE,
      office_name VARCHAR(200) NOT NULL,
      contact_person VARCHAR(150),
      contact_email VARCHAR(150),
      contact_mobile VARCHAR(40),
      logo_data_url TEXT,
      address TEXT,
      city VARCHAR(100),
      state VARCHAR(100),
      latitude NUMERIC(12,8),
      longitude NUMERIC(12,8),
      attendance_radius_meters INTEGER NOT NULL DEFAULT 400,
      status VARCHAR(30) NOT NULL DEFAULT 'Active',
      valid_from DATE DEFAULT CURRENT_DATE,
      valid_until DATE,
      force_read_only BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT organizations_status_chk CHECK (status IN ('Pending','Active','Suspended','Inactive'))
    )
  `);

  await exec(conn, `
    INSERT INTO organizations
      (org_code, office_name, contact_person, contact_email, attendance_radius_meters, status, valid_from, valid_until)
    VALUES
      ('${DEFAULT_ORG_CODE}', 'Gee Bharat Office', 'Default Admin', NULL, 400, 'Active', CURRENT_DATE, CURRENT_DATE + INTERVAL '10 years')
    ON CONFLICT (org_code) DO UPDATE SET
      office_name=COALESCE(organizations.office_name, EXCLUDED.office_name),
      status='Active',
      updated_at=NOW()
  `);

  await exec(conn, `
    CREATE TABLE IF NOT EXISTS organization_signup_requests (
      id SERIAL PRIMARY KEY,
      organization_name VARCHAR(200) NOT NULL,
      contact_person VARCHAR(150) NOT NULL,
      contact_email VARCHAR(150) NOT NULL,
      contact_mobile VARCHAR(40) NOT NULL,
      contact_designation VARCHAR(80),
      firm_type VARCHAR(80),
      registration_no VARCHAR(80),
      pan_no VARCHAR(20),
      gstin VARCHAR(20),
      whatsapp_mobile VARCHAR(40),
      pincode VARCHAR(10),
      district VARCHAR(100),
      address TEXT,
      city VARCHAR(100),
      state VARCHAR(100),
      notes TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      reviewed_by INTEGER,
      reviewed_at TIMESTAMPTZ,
      admin_remark TEXT,
      created_organization_id INTEGER REFERENCES organizations(id),
      created_admin_username VARCHAR(80),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      CONSTRAINT org_signup_status_chk CHECK (status IN ('Pending','Approved','Rejected'))
    )
  `);

  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS contact_designation VARCHAR(80)`);
  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS firm_type VARCHAR(80)`);
  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS registration_no VARCHAR(80)`);
  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS pan_no VARCHAR(20)`);
  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS gstin VARCHAR(20)`);
  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS whatsapp_mobile VARCHAR(40)`);
  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS pincode VARCHAR(10)`);
  await exec(conn, `ALTER TABLE organization_signup_requests ADD COLUMN IF NOT EXISTS district VARCHAR(100)`);

  await exec(conn, `
    CREATE TABLE IF NOT EXISTS super_admins (
      id SERIAL PRIMARY KEY,
      username VARCHAR(80) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name VARCHAR(150) NOT NULL,
      email_id VARCHAR(150),
      status VARCHAR(30) NOT NULL DEFAULT 'Active',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      CONSTRAINT super_admins_status_chk CHECK (status IN ('Active','Inactive'))
    )
  `);

  await exec(conn, `
    CREATE TABLE IF NOT EXISTS organization_subscription_history (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      old_valid_until DATE,
      new_valid_until DATE,
      old_force_read_only BOOLEAN,
      new_force_read_only BOOLEAN,
      old_status VARCHAR(30),
      new_status VARCHAR(30),
      remarks TEXT,
      updated_by INTEGER REFERENCES super_admins(id),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await exec(conn, `
    CREATE TABLE IF NOT EXISTS super_admin_notifications (
      id SERIAL PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(200) NOT NULL,
      message TEXT,
      signup_request_id INTEGER REFERENCES organization_signup_requests(id) ON DELETE SET NULL,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS employee_id_prefix VARCHAR(30)`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS employee_id_next INTEGER NOT NULL DEFAULT 1`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS employee_id_series_locked BOOLEAN NOT NULL DEFAULT FALSE`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_id_prefix VARCHAR(30)`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_id_next INTEGER NOT NULL DEFAULT 1`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS client_id_series_locked BOOLEAN NOT NULL DEFAULT FALSE`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS agent_id_prefix VARCHAR(30)`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS agent_id_next INTEGER NOT NULL DEFAULT 1`);
  await exec(conn, `ALTER TABLE organizations ADD COLUMN IF NOT EXISTS agent_id_series_locked BOOLEAN NOT NULL DEFAULT FALSE`);

  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS accuracy_meters NUMERIC(10,2)`);
  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS formatted_address TEXT`);
  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS place_id VARCHAR(255)`);
  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS location_type VARCHAR(80)`);
  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS geocode_provider VARCHAR(80)`);
  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS distance_from_office_meters INTEGER`);
  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS geofence_radius_meters INTEGER`);
  await exec(conn, `ALTER TABLE attendance_log ADD COLUMN IF NOT EXISTS within_geofence BOOLEAN`);

  await exec(conn, `
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_type VARCHAR(20) NOT NULL,
      user_ref_id INTEGER NOT NULL,
      login_id VARCHAR(120) NOT NULL,
      channel VARCHAR(20) NOT NULL,
      destination VARCHAR(200) NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await exec(conn, `CREATE INDEX IF NOT EXISTS idx_password_reset_lookup ON password_reset_tokens(organization_id, login_id, channel, expires_at DESC)`);

  await exec(conn, `
    CREATE OR REPLACE FUNCTION current_organization_id()
    RETURNS INTEGER
    LANGUAGE sql
    STABLE
    AS $$
      SELECT NULLIF(current_setting('app.organization_id', true), '')::INTEGER
    $$
  `);
}

async function addTenantColumns(conn) {
  let defaultOrgId = 1;
  if (APPLY) {
    const org = await conn.query(`SELECT id FROM organizations WHERE org_code=$1`, [DEFAULT_ORG_CODE]);
    defaultOrgId = org.rows[0].id;
  }

  for (const table of TENANT_TABLES) {
    if (!(await tableExists(conn, table))) continue;
    await exec(conn, `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS organization_id INTEGER`);
    await exec(conn, `UPDATE ${table} SET organization_id=${defaultOrgId} WHERE organization_id IS NULL`);
    await exec(conn, `ALTER TABLE ${table} ALTER COLUMN organization_id SET DEFAULT current_organization_id()`);
    await exec(conn, `ALTER TABLE ${table} ALTER COLUMN organization_id SET NOT NULL`);
    await exec(conn, `CREATE INDEX IF NOT EXISTS idx_${table}_organization_id ON ${table}(organization_id)`);
  }
}

async function relaxGlobalConstraints(conn) {
  const statements = [
    `ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_username_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_admins_org_username_lower ON admins(organization_id, lower(username))`,

    `ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_pkey`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_agents_org_agent_id ON agents(organization_id, agent_id)`,

    `ALTER TABLE attendance_settings DROP CONSTRAINT IF EXISTS attendance_settings_key_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_attendance_settings_org_key ON attendance_settings(organization_id, key)`,

    `ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_pkey`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_org_client_id ON clients(organization_id, client_id)`,

    `ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_cin_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_org_cin_upper ON companies(organization_id, upper(cin))`,

    `ALTER TABLE compliance_tracking DROP CONSTRAINT IF EXISTS compliance_tracking_cin_financial_year_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_compliance_tracking_org_cin_fy ON compliance_tracking(organization_id, upper(cin), financial_year)`,

    `ALTER TABLE emplist DROP CONSTRAINT IF EXISTS emplist_emp_id_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_emplist_org_emp_id_lower ON emplist(organization_id, lower(emp_id))`,
    `CREATE INDEX IF NOT EXISTS idx_emplist_org_email_lower ON emplist(organization_id, lower(email_id)) WHERE email_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_emplist_org_mobile ON emplist(organization_id, regexp_replace(coalesce(mobile_no,''), '[^0-9]', '', 'g')) WHERE mobile_no IS NOT NULL`,

    `ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_date_unique`,
    `ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_holiday_date_key`,
    `ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_date_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_holidays_org_date ON holidays(organization_id, holiday_date)`,

    `ALTER TABLE salary DROP CONSTRAINT IF EXISTS salary_month_year_emp`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_org_month_year_emp ON salary(organization_id, month, year, emp_id)`,

    `ALTER TABLE salary_structure DROP CONSTRAINT IF EXISTS salary_structure_emp_id_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_salary_structure_org_emp ON salary_structure(organization_id, emp_id)`,

    `ALTER TABLE work_names DROP CONSTRAINT IF EXISTS work_names_name_key`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS work_category VARCHAR(255)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS grouping_name VARCHAR(255)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS department VARCHAR(150)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS sac_code VARCHAR(30)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS sac_description TEXT`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS source VARCHAR(150)`,
    `DROP INDEX IF EXISTS ux_work_names_org_name_lower`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_work_names_org_name_category_department
      ON work_names(organization_id, lower(name), lower(coalesce(work_category,'')), lower(coalesce(department,'')))`,

    `DROP INDEX IF EXISTS ux_gst_clients_gst_no_nonblank`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_gst_clients_org_gst_no_nonblank ON gst_clients(organization_id, gst_no) WHERE NULLIF(gst_no,'') IS NOT NULL`,
  ];

  for (const sql of statements) {
    const tableName = sql.match(/ALTER TABLE\s+([a-z_]+)/i)?.[1] || sql.match(/\sON\s+([a-z_]+)/i)?.[1];
    if (tableName && TENANT_TABLES.includes(tableName) && !(await tableExists(conn, tableName))) continue;
    await exec(conn, sql);
  }
}

async function enableRls(conn) {
  for (const table of TENANT_TABLES) {
    if (!(await tableExists(conn, table))) continue;
    await exec(conn, `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await exec(conn, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await exec(conn, `DROP POLICY IF EXISTS tenant_isolation_${table} ON ${table}`);
    await exec(conn, `
      CREATE POLICY tenant_isolation_${table} ON ${table}
      USING (
        current_setting('app.bypass_rls', true) = 'on'
        OR organization_id::text = current_setting('app.organization_id', true)
      )
      WITH CHECK (
        current_setting('app.bypass_rls', true) = 'on'
        OR organization_id::text = current_setting('app.organization_id', true)
      )
    `);
  }

  for (const table of SHARED_TABLES) {
    if (!(await tableExists(conn, table))) continue;
    await exec(conn, `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
  }
}

async function addAdminMobileColumn(conn) {
  if (await tableExists(conn, 'admins')) {
    await exec(conn, `ALTER TABLE admins ADD COLUMN IF NOT EXISTS mobile_no VARCHAR(40)`);
    await exec(conn, `ALTER TABLE admins ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'Active'`);
    await exec(conn, `ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);
    await exec(conn, `ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
    await exec(conn, `CREATE INDEX IF NOT EXISTS idx_admins_org_email_lower ON admins(organization_id, lower(email_id)) WHERE email_id IS NOT NULL`);
    await exec(conn, `CREATE INDEX IF NOT EXISTS idx_admins_org_mobile ON admins(organization_id, regexp_replace(coalesce(mobile_no,''), '[^0-9]', '', 'g')) WHERE mobile_no IS NOT NULL`);
  }
}

async function seedOrganizationSeries(conn) {
  await exec(conn, `
    UPDATE organizations o SET
      employee_id_prefix=COALESCE(employee_id_prefix, 'PTP-'),
      employee_id_next=GREATEST(employee_id_next, COALESCE((
        SELECT MAX((regexp_match(emp_id, '^PTP-([0-9]+)$'))[1]::int) + 1
        FROM emplist e WHERE e.organization_id=o.id AND e.emp_id ~ '^PTP-[0-9]+$'
      ), employee_id_next)),
      client_id_prefix=COALESCE(client_id_prefix, 'PTPCL'),
      client_id_next=GREATEST(client_id_next, COALESCE((
        SELECT MAX((regexp_match(client_id, '^PTPCL([0-9]+)$'))[1]::int) + 1
        FROM clients c WHERE c.organization_id=o.id AND c.client_id ~ '^PTPCL[0-9]+$'
      ), client_id_next)),
      agent_id_prefix=COALESCE(agent_id_prefix, 'PTPA'),
      agent_id_next=GREATEST(agent_id_next, COALESCE((
        SELECT MAX((regexp_match(agent_id, '^PTPA([0-9]+)$'))[1]::int) + 1
        FROM agents a WHERE a.organization_id=o.id AND a.agent_id ~ '^PTPA[0-9]+$'
      ), agent_id_next))
  `);
}

async function hashExistingPasswords(conn) {
  if (!APPLY) {
    console.log('[dry-run] hash existing admin and employee passwords');
    return;
  }

  if (await tableExists(conn, 'admins')) {
    const admins = await conn.query(`SELECT id, password FROM admins WHERE password IS NOT NULL`);
    for (const row of admins.rows) {
      if (!isBcryptHash(row.password)) {
        await conn.query(`UPDATE admins SET password=$1 WHERE id=$2`, [await hashPassword(row.password), row.id]);
      }
    }
  }

  if (await tableExists(conn, 'emplist')) {
    const employees = await conn.query(`SELECT id, login_password FROM emplist WHERE login_password IS NOT NULL`);
    for (const row of employees.rows) {
      if (!isBcryptHash(row.login_password)) {
        await conn.query(`UPDATE emplist SET login_password=$1 WHERE id=$2`, [await hashPassword(row.login_password), row.id]);
      }
    }
  }
}

async function summarize(conn) {
  const summary = {};
  for (const table of ['organizations', 'organization_signup_requests', 'super_admins', 'emplist', 'admins', 'clients', 'tasks', 'gst_clients', 'gst_filing_records']) {
    if (!(await tableExists(conn, table))) continue;
    const count = await conn.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    summary[table] = count.rows[0].count;
  }
  return summary;
}

async function main() {
  await db.runWithTenant({ bypassTenant: true }, async () => {
    const conn = await db.pool.connect();
    try {
      await conn.query('BEGIN');
      await setupCore(conn);
      await addTenantColumns(conn);
      await addAdminMobileColumn(conn);
      await seedOrganizationSeries(conn);
      await relaxGlobalConstraints(conn);
      await enableRls(conn);
      await hashExistingPasswords(conn);
      const summary = APPLY ? await summarize(conn) : {};
      await conn.query('COMMIT');
      console.log(JSON.stringify({ applied: APPLY, default_org_code: DEFAULT_ORG_CODE, summary }, null, 2));
    } catch (error) {
      await conn.query('ROLLBACK');
      console.error(error.stack || error.message);
      process.exitCode = 1;
    } finally {
      conn.release();
      await db.pool.end();
    }
  });
}

main();
