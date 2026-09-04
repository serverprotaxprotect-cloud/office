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
    const sql = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('ROLLBACK ')) {
      return rawQuery(text, params);
    }
    await applyTenantContext(rawQuery);
    return rawQuery(text, params);
  };
  return client;
}

async function query(text, params) {
  const client = await pool.connect();
  try {
    const rawQuery = client.query.bind(client);
    // Our DATABASE_URL points at Neon's pooler endpoint (PgBouncer,
    // transaction-mode pooling). Outside an explicit transaction, PgBouncer
    // is free to hand each statement to a *different* physical backend
    // connection — so a bare "SET app.organization_id" followed by the real
    // query as two separate statements can silently lose that setting
    // between them, making current_organization_id() resolve to nothing and
    // RLS hide rows that should be visible. Wrapping both statements in one
    // BEGIN/COMMIT keeps them pinned to the same backend connection.
    await rawQuery('BEGIN');
    try {
      await applyTenantContext(rawQuery);
      const result = await rawQuery(text, params);
      await rawQuery('COMMIT');
      return result;
    } catch (err) {
      await rawQuery('ROLLBACK').catch(() => {});
      throw err;
    }
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
