const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware  = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ── POST /api/leave/apply  (employee) ────────────────────────
router.post('/apply', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { leave_type, from_date, to_date, reason } = req.body;

  if (!leave_type || !from_date || !to_date || !reason)
    return res.status(400).json({ success: false, message: 'All fields required' });

  try {
    // Check if leave already applied for overlapping dates
    const overlap = await db.query(
      `SELECT id FROM leave_requests
       WHERE emp_id=$1 AND status != 'Rejected'
         AND ($2::date, $3::date) OVERLAPS (from_date::date, to_date::date)`,
      [emp_id, from_date, to_date]
    );
    if (overlap.rows.length)
      return res.status(400).json({ success: false, message: 'Leave already applied for these dates' });

    const from = new Date(from_date);
    const to   = new Date(to_date);
    const days = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    const reqId = 'LVR-' + uuidv4().toUpperCase().slice(0, 8);

    await db.query(
      `INSERT INTO leave_requests
         (request_id, emp_id, employee_name, formal_name, leave_type,
          from_date, to_date, days, reason, status, applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pending',NOW())`,
      [reqId, emp_id, name, formal_name || name, leave_type, from_date, to_date, days, reason]
    );
    res.json({ success: true, message: 'Leave application submitted', request_id: reqId, days });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/leave/my-leaves  (employee) ────────────────────
router.get('/my-leaves', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    const r = await db.query(
      `SELECT request_id, leave_type, from_date, to_date, days, reason,
              status, applied_at, approved_rejected_by, admin_remark
       FROM leave_requests WHERE emp_id=$1
       ORDER BY applied_at DESC`,
      [emp_id]
    );
    res.json({ success: true, leaves: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/leave/all  (admin) ──────────────────────────────
router.get('/all', adminAuth, async (req, res) => {
  const { status } = req.query;
  try {
    const r = await db.query(
      `SELECT * FROM leave_requests
       ${status ? `WHERE status=$1` : ''}
       ORDER BY applied_at DESC`,
      status ? [status] : []
    );
    res.json({ success: true, leaves: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/leave/action  (admin approve/reject) ───────────
router.post('/action', adminAuth, async (req, res) => {
  const { request_id, action, remark } = req.body;
  if (!request_id || !['Approved', 'Rejected'].includes(action))
    return res.status(400).json({ success: false, message: 'request_id and action (Approved/Rejected) required' });

  try {
    const r = await db.query(`SELECT * FROM leave_requests WHERE request_id=$1`, [request_id]);
    if (!r.rows.length)
      return res.status(404).json({ success: false, message: 'Leave request not found' });

    const leave = r.rows[0];

    await db.query(
      `UPDATE leave_requests
       SET status=$1, approved_rejected_by=$2, approved_rejected_at=NOW(), admin_remark=$3
       WHERE request_id=$4`,
      [action, req.admin.name, remark || null, request_id]
    );

    // If approved: mark daily_attendance as 'Leave' for those dates
    if (action === 'Approved') {
      const from = new Date(leave.from_date);
      const to   = new Date(leave.to_date);
      for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        // Upsert daily_attendance with Leave status
        await db.query(
          `INSERT INTO daily_attendance (date, emp_id, employee_name, formal_name, final_status, month, year)
           VALUES ($1,$2,$3,$4,'Leave',EXTRACT(MONTH FROM $1::date),EXTRACT(YEAR FROM $1::date))
           ON CONFLICT DO NOTHING`,
          [dateStr, leave.emp_id, leave.employee_name, leave.formal_name]
        );
        await db.query(
          `UPDATE daily_attendance SET final_status='Leave' WHERE emp_id=$1 AND date::date=$2`,
          [leave.emp_id, dateStr]
        );
      }
    }

    res.json({ success: true, message: `Leave ${action} successfully` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
