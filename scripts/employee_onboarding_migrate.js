require('dotenv').config();
const db = require('../db');

async function run() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS employee_onboarding_links (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      status VARCHAR(30) NOT NULL DEFAULT 'Active',
      created_by_id VARCHAR(100),
      created_by_name VARCHAR(200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS employee_onboarding_requests (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL,
      link_id INTEGER REFERENCES employee_onboarding_links(id) ON DELETE SET NULL,
      token TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'Pending',
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      documents JSONB NOT NULL DEFAULT '{}'::jsonb,
      hr_remark TEXT,
      approved_emp_id VARCHAR(100),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_emp_onboarding_links_org ON employee_onboarding_links(organization_id, status)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_emp_onboarding_requests_org ON employee_onboarding_requests(organization_id, status, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_emp_onboarding_requests_link ON employee_onboarding_requests(link_id)`);
  console.log('Employee onboarding migration complete');
}

run().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
