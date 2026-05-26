require('dotenv').config();
const db = require('../db');

const APPLY = process.argv.includes('--apply');

const indexes = [
  {
    table: 'tasks',
    columns: ['organization_id', 'assigned_to_id', 'status', 'due_date'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_tasks_org_assignee_status_due ON tasks (organization_id, assigned_to_id, status, due_date)'
  },
  {
    table: 'tasks',
    columns: ['organization_id', 'created_at'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_tasks_org_created_at ON tasks (organization_id, created_at DESC)'
  },
  {
    table: 'tasks',
    columns: ['organization_id', 'status', 'due_date'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_tasks_org_status_due ON tasks (organization_id, status, due_date)'
  },
  {
    table: 'clients',
    columns: ['organization_id', 'status', 'legal_name'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_clients_org_status_name ON clients (organization_id, status, legal_name)'
  },
  {
    table: 'clients',
    columns: ['organization_id', 'client_id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_clients_org_client_id ON clients (organization_id, client_id)'
  },
  {
    table: 'clients',
    columns: ['organization_id', 'mobile_number'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_clients_org_mobile ON clients (organization_id, mobile_number)'
  },
  {
    table: 'agents',
    columns: ['organization_id', 'status', 'name'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_agents_org_status_name ON agents (organization_id, status, name)'
  },
  {
    table: 'agents',
    columns: ['organization_id', 'agent_id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_agents_org_agent_id ON agents (organization_id, agent_id)'
  },
  {
    table: 'companies',
    columns: ['organization_id', 'company_status', 'company_name'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_companies_org_status_name ON companies (organization_id, company_status, company_name)'
  },
  {
    table: 'companies',
    columns: ['organization_id', 'cin'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_companies_org_cin_upper ON companies (organization_id, UPPER(cin))'
  },
  {
    table: 'company_compliance_records',
    columns: ['organization_id', 'financial_year', 'cin', 'status'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_company_comp_org_fy_cin_status ON company_compliance_records (organization_id, financial_year, UPPER(cin), status)'
  },
  {
    table: 'company_compliance_records',
    columns: ['organization_id', 'assigned_to_id', 'status'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_company_comp_org_assignee_status ON company_compliance_records (organization_id, assigned_to_id, status)'
  },
  {
    table: 'director_kyc_tracking',
    columns: ['organization_id', 'financial_year', 'kyc_status'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_director_kyc_org_fy_status ON director_kyc_tracking (organization_id, financial_year, kyc_status)'
  },
  {
    table: 'director_kyc_tracking',
    columns: ['organization_id', 'cin', 'financial_year'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_director_kyc_org_cin_fy ON director_kyc_tracking (organization_id, UPPER(cin), financial_year)'
  },
  {
    table: 'director_kyc_tracking',
    columns: ['organization_id', 'assigned_to_id', 'kyc_status'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_director_kyc_org_assignee_status ON director_kyc_tracking (organization_id, assigned_to_id, kyc_status)'
  },
  {
    table: 'gst_filing_records',
    columns: ['organization_id', 'tax_year', 'tax_month', 'status', 'assigned_to_id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_gst_filing_org_period_status_assignee ON gst_filing_records (organization_id, tax_year, tax_month, status, assigned_to_id)'
  },
  {
    table: 'gst_clients',
    columns: ['organization_id', 'status', 'firm_name'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_gst_clients_org_status_name ON gst_clients (organization_id, status, firm_name)'
  },
  {
    table: 'income_tax_filing_records',
    columns: ['organization_id', 'assessment_year', 'status', 'assigned_to_id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_income_tax_filing_org_ay_status_assignee ON income_tax_filing_records (organization_id, assessment_year, status, assigned_to_id)'
  },
  {
    table: 'income_tax_clients',
    columns: ['organization_id', 'status', 'taxpayer_name'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_income_tax_clients_org_status_name ON income_tax_clients (organization_id, status, taxpayer_name)'
  }
];

async function tableExists(client, table) {
  const result = await client.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(result.rows[0]?.name);
}

async function columnsExist(client, table, columns) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
    [table, columns]
  );
  const existing = new Set(result.rows.map((row) => row.column_name));
  return columns.every((column) => existing.has(column));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const client = await db.rawPool.connect();
  try {
    let planned = 0;
    let applied = 0;
    let skipped = 0;

    for (const item of indexes) {
      const hasTable = await tableExists(client, item.table);
      const hasColumns = hasTable && await columnsExist(client, item.table, item.columns);

      if (!hasTable || !hasColumns) {
        skipped += 1;
        console.log(`SKIP ${item.table}: missing table/columns (${item.columns.join(', ')})`);
        continue;
      }

      planned += 1;
      if (APPLY) {
        try {
          await client.query(item.sql);
          applied += 1;
          console.log(`OK   ${item.sql}`);
        } catch (err) {
          skipped += 1;
          console.log(`SKIP ${item.table}: ${err.message}`);
        }
      } else {
        console.log(`PLAN ${item.sql}`);
      }
    }

    console.log(`${APPLY ? 'Applied' : 'Planned'} ${APPLY ? applied : planned} performance indexes, skipped ${skipped}.`);
    if (!APPLY) console.log('Run npm run perf:migrate:apply to apply.');
  } finally {
    client.release();
    await db.rawPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
