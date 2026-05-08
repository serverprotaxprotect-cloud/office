const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ── GET /api/clients/next-id ─────────────────────────────────
router.get('/next-id', authMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT client_id FROM clients WHERE client_id ~ '^PTPCL[0-9]+$' ORDER BY LENGTH(client_id) DESC, client_id DESC LIMIT 1`
    );
    let next = 'PTPCL0001';
    if (r.rows.length) {
      const last = r.rows[0].client_id;
      const num = parseInt(last.replace('PTPCL', ''), 10);
      next = 'PTPCL' + String(num + 1).padStart(4, '0');
    }
    res.json({ success: true, next_id: next });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/clients/agents  (search agents) ─────────────────
router.get('/agents', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let result;
    if (q) {
      result = await db.query(
        `SELECT agent_id, name, mobile_number, email_id FROM agents
         WHERE agent_id ILIKE $1 OR name ILIKE $1 OR mobile_number ILIKE $1
         ORDER BY name LIMIT 20`,
        [`%${q}%`]
      );
    } else {
      result = await db.query(
        `SELECT agent_id, name, mobile_number, email_id FROM agents ORDER BY name`
      );
    }
    res.json({ success: true, agents: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/clients/agents  (add new agent) ────────────────
router.post('/agents', authMiddleware, async (req, res) => {
  const { name, mobile_number, email_id } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Agent name required' });
  try {
    // Auto-generate agent_id
    const r = await db.query(
      `SELECT agent_id FROM agents WHERE agent_id ~ '^PTPA[0-9]+$' ORDER BY LENGTH(agent_id) DESC, agent_id DESC LIMIT 1`
    );
    let next = 'PTPA0001';
    if (r.rows.length) {
      const num = parseInt(r.rows[0].agent_id.replace('PTPA', ''), 10);
      next = 'PTPA' + String(num + 1).padStart(4, '0');
    }
    await db.query(
      `INSERT INTO agents (agent_id, name, mobile_number, email_id) VALUES ($1,$2,$3,$4)`,
      [next, name, mobile_number || null, email_id || null]
    );
    res.json({ success: true, message: 'Agent added!', agent_id: next, name });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'Agent already exists' });
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/clients/search?q= ────────────────────────────────
router.get('/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    let result;
    if (!q) {
      result = await db.query(
        `SELECT client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, status, city, state, gst_no, pan_no, address
         FROM clients ORDER BY legal_name NULLS LAST LIMIT 80`
      );
    } else {
      result = await db.query(
        `SELECT client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, status, city, state, gst_no, pan_no, address
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
  const {
    client_id, agent_id, agent_name, legal_name, business_name,
    mobile_number, email_id, address, city, state, gst_no, pan_no,
  } = req.body;

  if (!client_id) return res.status(400).json({ success: false, message: 'Client ID required' });
  if (!mobile_number) return res.status(400).json({ success: false, message: 'Mobile number required' });

  try {
    await db.query(
      `INSERT INTO clients (client_id, agent_id, agent_name, legal_name, business_name, mobile_number, email_id, address, city, state, gst_no, pan_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [client_id, agent_id || null, agent_name || null, legal_name || null, business_name || null,
       mobile_number, email_id || null, address || null, city || null, state || null, gst_no || null, pan_no || null]
    );
    res.json({ success: true, message: `Client ${client_id} added successfully!` });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'Client ID already exists' });
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/clients/:id  (update) ───────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
  const {
    agent_id, agent_name, legal_name, business_name,
    mobile_number, email_id, address, city, state, gst_no, pan_no, status,
  } = req.body;

  if (mobile_number === '') return res.status(400).json({ success: false, message: 'Mobile number required' });

  try {
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
        status = COALESCE($12, status)
       WHERE client_id = $13`,
      [
        agent_id || null, agent_name || null, legal_name || null,
        business_name || null, mobile_number || null, email_id || null,
        address || null, city || null, state || null,
        gst_no || null, pan_no || null, status || null, req.params.id,
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
