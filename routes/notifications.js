const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// IST helper
function nowIST() { return new Date(Date.now() + (5.5 * 60 * 60 * 1000)); }

async function ensureTable() {
  const existing = await db.query(`SELECT to_regclass('public.notifications') AS table_name`);
  if (existing.rows[0]?.table_name) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      emp_id      VARCHAR(50)  NOT NULL,
      type        VARCHAR(50)  NOT NULL,
      title       VARCHAR(200) NOT NULL,
      message     TEXT,
      task_id     VARCHAR(100),
      is_read     BOOLEAN      DEFAULT FALSE,
      created_at  TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
}

// ── Create a notification (exported for use in tasks.js) ─────
async function createNotif(empId, type, title, message, taskId) {
  try {
    await ensureTable();
    await db.query(
      `INSERT INTO notifications (emp_id, type, title, message, task_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [empId, type, title, message || null, taskId || null]
    );
  } catch (err) {
    console.error('[Notif] createNotif error:', err.message);
  }
}

// ── Check overdue tasks → create overdue notifications ────────
async function checkOverdue(empId) {
  try {
    const today = nowIST().toISOString().split('T')[0];
    const rows = await db.query(
      `SELECT task_id, work_name, legal_name, due_date
       FROM tasks
       WHERE assigned_to_id=$1
         AND due_date < $2
         AND status NOT IN ('Completed','Cancelled')
         AND active_flag = true`,
      [empId, today]
    );
    for (const t of rows.rows) {
      // Only once per task
      const exists = await db.query(
        `SELECT id FROM notifications WHERE emp_id=$1 AND task_id=$2 AND type='task_overdue'`,
        [empId, t.task_id]
      );
      if (!exists.rows.length) {
        const dueDate = new Date(t.due_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        const days    = Math.floor((Date.now() - new Date(t.due_date)) / 86400000);
        await createNotif(
          empId, 'task_overdue',
          '⚠️ Task Overdue',
          `"${t.work_name || t.legal_name || t.task_id}" ${days} din se overdue hai. Due date thi: ${dueDate}`,
          t.task_id
        );
      }
    }
  } catch (err) {
    console.error('[Notif] checkOverdue error:', err.message);
  }
}

// ── GET /api/notifications/my ─────────────────────────────────
router.get('/my', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    await ensureTable();
    await checkOverdue(emp_id);

    const result = await db.query(
      `SELECT id, type, title, message, task_id, is_read, created_at
       FROM notifications WHERE emp_id=$1
       ORDER BY created_at DESC LIMIT 50`,
      [emp_id]
    );
    const unread = result.rows.filter(n => !n.is_read).length;
    res.json({ success: true, notifications: result.rows, unread });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/notifications/read/:id ─────────────────────────
router.post('/read/:id', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    await db.query(
      `UPDATE notifications SET is_read=true WHERE id=$1 AND emp_id=$2`,
      [req.params.id, emp_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ── POST /api/notifications/read-all ─────────────────────────
router.post('/read-all', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    await db.query(`UPDATE notifications SET is_read=true WHERE emp_id=$1`, [emp_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

module.exports = { router, createNotif };
