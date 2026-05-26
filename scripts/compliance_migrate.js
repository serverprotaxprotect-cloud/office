require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}

const db = require('../db');
const { ensureSchema, ensureKycAssignmentSchema } = require('../services/complianceService');

const APPLY = process.argv.includes('--apply');

async function exec(conn, sql) {
  if (!APPLY) {
    console.log(`[dry-run] ${sql.trim().replace(/\s+/g, ' ').slice(0, 220)}`);
    return;
  }
  await conn.query(sql);
}

async function tableExists(conn, table) {
  const r = await conn.query(`SELECT to_regclass($1) AS table_name`, [`public.${table}`]);
  return Boolean(r.rows[0].table_name);
}

async function main() {
  const conn = await db.pool.connect();
  try {
    if (!APPLY) console.log('Dry run. Use --apply to execute.');

    const orgs = await conn.query(`SELECT id, org_code FROM organizations ORDER BY id`);
    for (const org of orgs.rows) {
      await db.runWithTenant({ organizationId: org.id }, async () => {
        if (APPLY) {
          await ensureSchema(conn);
          await ensureKycAssignmentSchema(conn);
        } else {
          console.log(`[dry-run] ensure compliance schema/templates/KYC assignment columns for ${org.org_code}`);
        }
      });
    }

    for (const table of ['compliance_templates', 'company_compliance_events', 'company_compliance_records', 'company_compliance_history']) {
      if (!(await tableExists(conn, table))) continue;
      await exec(conn, `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await exec(conn, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await exec(conn, `
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${table}' AND policyname='${table}_tenant_select'
          ) THEN
            CREATE POLICY ${table}_tenant_select ON ${table}
              FOR SELECT USING (
                current_setting('app.bypass_rls', true)='on'
                OR organization_id::text = current_setting('app.organization_id', true)
              );
          END IF;
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='${table}' AND policyname='${table}_tenant_write'
          ) THEN
            CREATE POLICY ${table}_tenant_write ON ${table}
              FOR ALL USING (
                current_setting('app.bypass_rls', true)='on'
                OR organization_id::text = current_setting('app.organization_id', true)
              )
              WITH CHECK (
                current_setting('app.bypass_rls', true)='on'
                OR organization_id::text = current_setting('app.organization_id', true)
              );
          END IF;
        END $$;
      `);
    }

    console.log(APPLY ? 'Compliance migration applied.' : 'Compliance migration dry-run complete.');
  } finally {
    conn.release();
    await db.rawPool.end();
  }
}

main().catch(async (err) => {
  console.error(err);
  try { await db.rawPool.end(); } catch (e) {}
  process.exit(1);
});
