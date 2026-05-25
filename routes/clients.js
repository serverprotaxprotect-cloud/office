const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { ensureOrgSetupComplete, requireOrgSetup } = require('../services/organizationSetupGuard');
const { hashPassword } = require('../utils/passwords');

const router = express.Router();

async function nextSeriesNumber(conn, { table, idColumn, prefix, organizationId, storedNext }) {
  const result = await conn.query(
    `SELECT COALESCE(MAX(substring(${idColumn} from length($1) + 1)::integer), 0) + 1 AS next_no
     FROM ${table}
     WHERE organization_id=$2
       AND left(${idColumn}, length($1))=$1
       AND substring(${idColumn} from length($1) + 1) ~ '^[0-9]+$'`,
    [prefix, organizationId]
  );
  return Math.max(Number(storedNext || 1), Number(result.rows[0]?.next_no || 1));
}

function seriesNumberFromId(id, prefix) {
  const value = String(id || '');
  const cleanPrefix = String(prefix || '');
  if (!cleanPrefix || !value.startsWith(cleanPrefix)) return null;
  const suffix = value.slice(cleanPrefix.length);
  if (!/^\d+$/.test(suffix)) return null;
  return Number(suffix);
}

// ── GET /api/clients/next-id ─────────────────────────────────
router.get('/next-id', authMiddleware, async (req, res) => {
  try {
    const org = await db.query(
      `SELECT latitude, longitude, attendance_radius_meters,
              employee_id_prefix, client_id_prefix, agent_id_prefix, client_id_next
       FROM organizations WHERE id=$1`,
      [req.user.organization_id]
    );
    const o = org.rows[0] || {};
    ensureOrgSetupComplete(o);
    const nextNo = await nextSeriesNumber(db, {
      table: 'clients',
      idColumn: 'client_id',
      prefix: o.client_id_prefix,
      organizationId: req.user.organization_id,
      storedNext: o.client_id_next,
    });
    const next = `${o.client_id_prefix}${String(nextNo).padStart(4, '0')}`;
    res.json({ success: true, next_id: next });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
  }
});

// ── GET /api/clients/agents  (search agents) ─────────────────
router.get('/agents', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let result;
    if (q) {
      result = await db.query(
        `SELECT agent_id, name, mobile_number, email_id, portal_enabled, portal_last_login_at,
                (portal_password_hash IS NOT NULL AND portal_password_hash <> '') AS portal_has_password
         FROM agents
         WHERE agent_id ILIKE $1 OR name ILIKE $1 OR mobile_number ILIKE $1 OR email_id ILIKE $1
         ORDER BY name LIMIT 20`,
        [`%${q}%`]
      );
    } else {
      result = await db.query(
        `SELECT agent_id, name, mobile_number, email_id, portal_enabled, portal_last_login_at,
                (portal_password_hash IS NOT NULL AND portal_password_hash <> '') AS portal_has_password
         FROM agents ORDER BY name`
      );
    }
    res.json({ success: true, agents: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/clients/agents/:id/portal ───────────────────────
router.put('/agents/:id/portal', authMiddleware, async (req, res) => {
  const { portal_enabled, password } = req.body;
  const sets = [];
  const params = [];
  if (Object.prototype.hasOwnProperty.call(req.body, 'portal_enabled')) {
    params.push(!!portal_enabled);
    sets.push(`portal_enabled=$${params.length}`);
  }
  if (password) {
    params.push(await hashPassword(password));
    sets.push(`portal_password_hash=$${params.length}`, `portal_password_changed_at=NOW()`);
  }
  if (!sets.length) return res.status(400).json({ success: false, message: 'No portal change supplied' });
  params.push(req.params.id);
  try {
    const result = await db.query(
      `UPDATE agents SET ${sets.join(', ')} WHERE agent_id=$${params.length}
       RETURNING agent_id, name, portal_enabled, portal_last_login_at,
                 (portal_password_hash IS NOT NULL AND portal_password_hash <> '') AS portal_has_password`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Agent not found' });
    res.json({ success: true, message: 'Agent portal access updated', agent: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Portal access update failed' });
  }
});

// ── POST /api/clients/agents  (add new agent) ────────────────
router.post('/agents', authMiddleware, async (req, res) => {
  const { name, mobile_number, email_id, portal_enabled, portal_password } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Agent name required' });
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await requireOrgSetup(conn, req.user.organization_id);
    const org = await conn.query(`SELECT agent_id_prefix, agent_id_next FROM organizations WHERE id=$1 FOR UPDATE`, [req.user.organization_id]);
    const o = org.rows[0] || {};
    const nextNo = await nextSeriesNumber(conn, {
      table: 'agents',
      idColumn: 'agent_id',
      prefix: o.agent_id_prefix,
      organizationId: req.user.organization_id,
      storedNext: o.agent_id_next,
    });
    const next = `${o.agent_id_prefix}${String(nextNo).padStart(4, '0')}`;
    const portalHash = portal_password ? await hashPassword(portal_password) : null;
    await conn.query(
      `INSERT INTO agents (agent_id, name, mobile_number, email_id, portal_enabled, portal_password_hash, portal_password_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END)`,
      [next, name, mobile_number || null, email_id || null, !!portal_enabled, portalHash]
    );
    await conn.query(`UPDATE organizations SET agent_id_next=GREATEST(agent_id_next, $1), updated_at=NOW() WHERE id=$2`, [nextNo + 1, req.user.organization_id]);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Agent added!', agent_id: next, name });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'Agent already exists' });
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
  } finally {
    conn.release();
  }
});

// ── PUT /api/clients/agents/:id  (update agent details) ─────────
router.put('/agents/:id', authMiddleware, async (req, res) => {
  const { name, mobile_number, email_id, portal_enabled, portal_password } = req.body;
  if (name === '') return res.status(400).json({ success: false, message: 'Agent name required' });

  const sets = [];
  const params = [];

  if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
    params.push(name || null);
    sets.push(`name=COALESCE($${params.length}, name)`);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'mobile_number')) {
    params.push(mobile_number || null);
    sets.push(`mobile_number=$${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'email_id')) {
    params.push(email_id || null);
    sets.push(`email_id=$${params.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'portal_enabled')) {
    params.push(!!portal_enabled);
    sets.push(`portal_enabled=$${params.length}`);
  }
  if (portal_password) {
    params.push(await hashPassword(portal_password));
    sets.push(`portal_password_hash=$${params.length}`, `portal_password_changed_at=NOW()`);
  }

  if (!sets.length) return res.status(400).json({ success: false, message: 'No agent change supplied' });
  params.push(req.params.id);

  try {
    const result = await db.query(
      `UPDATE agents
       SET ${sets.join(', ')}
       WHERE agent_id=$${params.length}
       RETURNING agent_id, name, mobile_number, email_id, portal_enabled, portal_last_login_at,
                 (portal_password_hash IS NOT NULL AND portal_password_hash <> '') AS portal_has_password`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Agent not found' });
    res.json({ success: true, message: 'Agent updated!', agent: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Agent update failed' });
  }
});

// ── GET /api/clients/search?q= ────────────────────────────────
router.get('/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let result;
    if (!q) {
      result = await db.query(
        `SELECT client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, status, city, state, gst_no, pan_no, address,
                portal_enabled, portal_last_login_at,
                (portal_password_hash IS NOT NULL AND portal_password_hash <> '') AS portal_has_password
         FROM clients ORDER BY legal_name NULLS LAST LIMIT 80`
      );
    } else {
      result = await db.query(
        `SELECT client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, status, city, state, gst_no, pan_no, address,
                portal_enabled, portal_last_login_at,
                (portal_password_hash IS NOT NULL AND portal_password_hash <> '') AS portal_has_password
         FROM clients
         WHERE client_id ILIKE $1
            OR legal_name ILIKE $1
            OR business_name ILIKE $1
            OR mobile_number ILIKE $1
            OR email_id ILIKE $1
            OR agent_name ILIKE $1
         ORDER BY
           CASE WHEN client_id ILIKE $2 THEN 0
                WHEN legal_name ILIKE $2 THEN 1
                WHEN business_name ILIKE $2 THEN 2
                ELSE 3 END,
           COALESCE(legal_name, business_name)
         LIMIT 50`,
        [`%${q}%`, `${q}%`]
      );
    }
    res.json({ success: true, clients: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/clients/:id/portal ──────────────────────────────
router.put('/:id/portal', authMiddleware, async (req, res) => {
  const { portal_enabled, password } = req.body;
  const sets = [];
  const params = [];
  if (Object.prototype.hasOwnProperty.call(req.body, 'portal_enabled')) {
    params.push(!!portal_enabled);
    sets.push(`portal_enabled=$${params.length}`);
  }
  if (password) {
    params.push(await hashPassword(password));
    sets.push(`portal_password_hash=$${params.length}`, `portal_password_changed_at=NOW()`);
  }
  if (!sets.length) return res.status(400).json({ success: false, message: 'No portal change supplied' });
  params.push(req.params.id);
  try {
    const result = await db.query(
      `UPDATE clients SET ${sets.join(', ')} WHERE client_id=$${params.length}
       RETURNING client_id, portal_enabled, portal_last_login_at,
                 (portal_password_hash IS NOT NULL AND portal_password_hash <> '') AS portal_has_password`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, message: 'Client portal access updated', client: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Portal access update failed' });
  }
});

// ── GET /api/clients/:id ──────────────────────────────────────
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const r = await db.query('SELECT * FROM clients WHERE client_id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Client not found' });

    const tasks = await db.query(
      `SELECT status, COUNT(*) as cnt FROM tasks WHERE client_id=$1 AND active_flag=true GROUP BY status ORDER BY cnt DESC`,
      [req.params.id]
    );
    const recent = await db.query(
      `SELECT task_id, work_name, status, due_date, assigned_to_name, created_at
       FROM tasks WHERE client_id=$1 AND active_flag=true ORDER BY created_at DESC LIMIT 10`,
      [req.params.id]
    );

    res.json({ success: true, client: r.rows[0], task_summary: tasks.rows, recent_tasks: recent.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/clients  (add new) ─────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  let {
    client_id, agent_id, agent_name, legal_name, business_name,
    mobile_number, email_id, address, city, state, gst_no, pan_no,
    portal_enabled, portal_password,
  } = req.body;

  if (!mobile_number) return res.status(400).json({ success: false, message: 'Mobile number required' });

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await requireOrgSetup(conn, req.user.organization_id);
    const org = await conn.query(`SELECT client_id_prefix, client_id_next FROM organizations WHERE id=$1 FOR UPDATE`, [req.user.organization_id]);
    const o = org.rows[0] || {};
    if (!client_id) {
      const nextNo = await nextSeriesNumber(conn, {
        table: 'clients',
        idColumn: 'client_id',
        prefix: o.client_id_prefix,
        organizationId: req.user.organization_id,
        storedNext: o.client_id_next,
      });
      client_id = `${o.client_id_prefix}${String(nextNo).padStart(4, '0')}`;
    }
    const portalHash = portal_password ? await hashPassword(portal_password) : null;
    await conn.query(
      `INSERT INTO clients (client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, address, city, state, gst_no, pan_no,
                            portal_enabled, portal_password_hash, portal_password_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,CASE WHEN $14::text IS NULL THEN NULL ELSE NOW() END)`,
      [client_id, agent_id || null, agent_name || null, legal_name || null, business_name || null,
       mobile_number, email_id || null, address || null, city || null, state || null, gst_no || null, pan_no || null,
       !!portal_enabled, portalHash]
    );
    const clientNo = seriesNumberFromId(client_id, o.client_id_prefix);
    if (clientNo) {
      await conn.query(`UPDATE organizations SET client_id_next=GREATEST(client_id_next, $1), updated_at=NOW() WHERE id=$2`, [clientNo + 1, req.user.organization_id]);
    }
    await conn.query('COMMIT');
    res.json({ success: true, message: `Client ${client_id} added successfully!` });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'Client ID already exists' });
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
  } finally {
    conn.release();
  }
});

// ── PUT /api/clients/:id  (update) ───────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
  const {
    agent_id, agent_name, legal_name, business_name,
    mobile_number, email_id, address, city, state, gst_no, pan_no, status,
    portal_enabled, portal_password,
  } = req.body;

  if (mobile_number === '') return res.status(400).json({ success: false, message: 'Mobile number required' });

  try {
    const portalHash = portal_password ? await hashPassword(portal_password) : null;
    const result = await db.query(
      `UPDATE clients SET
        agent_id = COALESCE($1, agent_id),
        agent_name = COALESCE($2, agent_name),
        legal_name = COALESCE($3, legal_name),
        business_name = COALESCE($4, business_name),
        mobile_number = COALESCE($5, mobile_number),
        email_id = COALESCE($6, email_id),
        address = COALESCE($7, address),
        city = COALESCE($8, city),
        state = COALESCE($9, state),
        gst_no = COALESCE($10, gst_no),
        pan_no = COALESCE($11, pan_no),
        status = COALESCE($12, status),
        portal_enabled = COALESCE($13, portal_enabled),
        portal_password_hash = COALESCE($14, portal_password_hash),
        portal_password_changed_at = CASE WHEN $14 IS NULL THEN portal_password_changed_at ELSE NOW() END
       WHERE client_id = $15`,
      [
        agent_id || null, agent_name || null, legal_name || null,
        business_name || null, mobile_number || null, email_id || null,
        address || null, city || null, state || null,
        gst_no || null, pan_no || null, status || null,
        Object.prototype.hasOwnProperty.call(req.body, 'portal_enabled') ? !!portal_enabled : null,
        portalHash,
        req.params.id,
      ]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, message: 'Client updated!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
