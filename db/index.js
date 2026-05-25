const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const tenantContext = new AsyncLocalStorage();

pool.on('error', (err) => {
  console.error('DB pool error:', err);
});

async function applyTenantContext(rawQuery) {
  const ctx = tenantContext.getStore() || {};
  const organizationId = ctx.organizationId || ctx.organization_id || '';
  const bypass = ctx.bypassTenant ? 'on' : 'off';
  await rawQuery(
    `SELECT
       set_config('app.organization_id', $1, false),
       set_config('app.bypass_rls', $2, false)`,
    [organizationId ? String(organizationId) : '', bypass]
  );
}

function wrapClient(client) {
  const rawQuery = client.query.bind(client);
  client.query = async (text, params) => {
    await applyTenantContext(rawQuery);
    return rawQuery(text, params);
  };
  return client;
}

async function query(text, params) {
  const client = await pool.connect();
  try {
    const rawQuery = client.query.bind(client);
    await applyTenantContext(rawQuery);
    return rawQuery(text, params);
  } finally {
    client.release();
  }
}

async function connect() {
  const client = await pool.connect();
  return wrapClient(client);
}

function runWithTenant(context, fn) {
  return tenantContext.run(context || {}, fn);
}

function getTenantContext() {
  return tenantContext.getStore() || {};
}

module.exports = {
  query,
  pool: {
    connect,
    end: pool.end.bind(pool),
  },
  rawPool: pool,
  runWithTenant,
  getTenantContext,
};
