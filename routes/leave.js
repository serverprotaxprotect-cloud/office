const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware  = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { getSettings, ymdLocal, recalcIfOpenSafe } = require('../services/salaryService');
const { isOffDate } = require('../services/workCalendar');
const { notifyLeaveApplied, notifyLeaveDecision } = require('../services/leaveMail');

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

const router = express.Router();

async function ensureLeavePayColumns() {
  const columns = [
    { table: 'leave_requests', name: 'pay_type', ddl: "pay_type VARCHAR(20) DEFAULT 'Paid'" },
    { table: 'daily_attendance', name: 'leave_pay_type', ddl: "leave_pay_type VARCHAR(20)" }
  ];
  const existing = await db.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name = ANY($1::text[])
       AND column_name = ANY($2::text[])`,
    [[...new Set(columns.map(col => col.table))], columns.map(col => col.name)]
  );
  const existingKeys = new Set(existing.rows.map(row => `${row.table_name}.${row.column_name}`));
  for (const col of columns) {
    if (!existingKeys.has(`${col.table}.${col.name}`)) {
      await db.query(`ALTER TABLE ${col.table} ADD COLUMN IF NOT EXISTS ${col.ddl}`);
    }
  }
}

function normalizeLeaveAction(action, payType) {
  if (action === 'Approved Paid') return { action: 'Approved', payType: 'Paid' };
  if (action === 'Approved Unpaid') return { action: 'Approved', payType: 'Unpaid' };
  return {
    action,
    payType: String(payType || 'Paid').toLowerCase() === 'unpaid' ? 'Unpaid' : 'Paid'
  };
}

// ── POST /api/leave/apply  (employee) ────────────────────────
router.post('/apply', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { leave_type, from_date, to_date, reason } = req.body;

  if (!leave_type || !from_date || !to_date || !reason)
    return res.status(400).json({ success: false, message: 'All fields required' });

  try {
    await ensureLeavePayColumns();
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
    const mail = await notifyLeaveApplied({ request_id: reqId, emp_id, employee_name: formal_name || name, leave_type, from_date, to_date, days, reason });
    res.json({ success: true, message: 'Leave application submitted', request_id: reqId, days, emailed: mail.approvers > 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/leave/admin-apply  (admin enters a request on the employee's behalf) ──
// For leave the employee reported by WhatsApp / email: it is created as Pending, then approved in the usual way.
router.post('/admin-apply', adminAuth, async (req, res) => {
  const { emp_id, leave_type, from_date, to_date, reason } = req.body;
  if (!emp_id || !leave_type || !from_date || !to_date || !reason)
    return res.status(400).json({ success: false, message: 'All fields are required' });
  if (to_date < from_date)
    return res.status(400).json({ success: false, message: 'To Date cannot be before From Date' });
  try {
    await ensureLeavePayColumns();
    const emp = await db.query(`SELECT emp_id, name, formal_name FROM emplist WHERE emp_id=$1 AND status='Active'`, [emp_id]);
    if (!emp.rows.length) return res.status(404).json({ success: false, message: 'Active employee not found' });
    const overlap = await db.query(
      `SELECT id FROM leave_requests WHERE emp_id=$1 AND status != 'Rejected' AND ($2::date, $3::date) OVERLAPS (from_date::date, to_date::date)`,
      [emp_id, from_date, to_date]);
    if (overlap.rows.length)
      return res.status(400).json({ success: false, message: 'Leave already exists for these dates' });
    const days = Math.round((new Date(to_date) - new Date(from_date)) / 86400000) + 1;
    const reqId = 'LVR-' + uuidv4().toUpperCase().slice(0, 8);
    const name = emp.rows[0].formal_name || emp.rows[0].name;
    await db.query(
      `INSERT INTO leave_requests (request_id, emp_id, employee_name, formal_name, leave_type, from_date, to_date, days, reason, status, applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Pending',NOW())`,
      [reqId, emp_id, name, name, leave_type, from_date, to_date, days, `${reason} (entered by ${req.admin.name} on the employee's behalf)`]);
    res.json({ success: true, message: 'Leave request created. It is now pending; approve it from the list below.', request_id: reqId, days });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/leave/my-leaves  (employee) ────────────────────
router.get('/my-leaves', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    await ensureLeavePayColumns();
    const r = await db.query(
      `SELECT request_id, leave_type, from_date, to_date, days, reason,
              status, pay_type, applied_at, approved_rejected_by, admin_remark
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
    await ensureLeavePayColumns();
    const r = await db.query(
      `SELECT lr.*,
              (SELECT COUNT(*)::int FROM daily_attendance d
                WHERE d.emp_id=lr.emp_id AND d.final_status='Leave' AND COALESCE(d.leave_pay_type,'Paid')<>'Unpaid'
                  AND d.year=EXTRACT(YEAR FROM NOW())::int) AS paid_used_this_year,
              (SELECT e.paid_leave_per_year FROM emplist e WHERE e.emp_id=lr.emp_id LIMIT 1) AS paid_leave_per_year
         FROM leave_requests lr
       ${status ? `WHERE lr.status=$1` : ''}
       ORDER BY lr.applied_at DESC`,
      status ? [status] : []
    );
    res.json({ success: true, leaves: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/leave/action  (admin approve/reject) ───────────
router.post('/action', adminAuth, async (req, res) => {
  const { request_id, remark } = req.body;
  const normalized = normalizeLeaveAction(req.body.action, req.body.pay_type);
  const action = normalized.action;
  const payType = normalized.payType;
  if (!request_id || !['Approved', 'Rejected'].includes(action))
    return res.status(400).json({ success: false, message: 'request_id and action (Approved/Rejected) required' });

  try {
    await ensureLeavePayColumns();
    const r = await db.query(`SELECT * FROM leave_requests WHERE request_id=$1`, [request_id]);
    if (!r.rows.length)
      return res.status(404).json({ success: false, message: 'Leave request not found' });

    const leave = r.rows[0];

    await db.query(
      `UPDATE leave_requests
       SET status=$1, pay_type=$2, approved_rejected_by=$3, approved_rejected_at=NOW(), admin_remark=$4
       WHERE request_id=$5`,
      [action, action === 'Approved' ? payType : null, req.admin.name, remark || null, request_id]
    );

    // If approved: mark daily_attendance as 'Leave' for working days only
    // (weekly offs and declared holidays are not leave days, so they are never charged to the leave).
    let note = '';
    let skippedOffForMail = 0;
    if (action === 'Approved') {
      const settings = await getSettings();
      const fromStr = ymdLocal(leave.from_date), toStr = ymdLocal(leave.to_date);
      const hol = await db.query(
        `SELECT holiday_date::date::text AS d FROM holidays WHERE holiday_date::date BETWEEN $1::date AND $2::date`, [fromStr, toStr]);
      const holSet = new Set(hol.rows.map(h => h.d));
      const months = new Set();
      let marked = 0, skippedOff = 0;
      for (let cur = fromStr; cur <= toStr; cur = nextDay(cur)) {
        if (isOffDate(cur, settings, holSet)) { skippedOff++; continue; }
        // one row per employee per day: insert only when none exists, then set the leave status
        await db.query(
          `INSERT INTO daily_attendance (date, emp_id, employee_name, formal_name, final_status, leave_pay_type, month, year)
           SELECT $1::date,$2::varchar,$3::varchar,$4::varchar,'Leave',$5::varchar,EXTRACT(MONTH FROM $1::date),EXTRACT(YEAR FROM $1::date)
            WHERE NOT EXISTS (SELECT 1 FROM daily_attendance WHERE emp_id=$2::varchar AND date::date=$1::date)`,
          [cur, leave.emp_id, leave.employee_name, leave.formal_name, payType]
        );
        await db.query(
          `UPDATE daily_attendance SET final_status='Leave', leave_pay_type=$3 WHERE emp_id=$1 AND date::date=$2::date`,
          [leave.emp_id, cur, payType]
        );
        marked++;
        months.add(cur.slice(0, 7));
      }
      let recalculated = 0, locked = 0;
      for (const ym of months) {
        const rc = await recalcIfOpenSafe(leave.emp_id, ym + '-01');
        if (rc.recalculated) recalculated++; else if (rc.locked) locked++;
      }
      skippedOffForMail = skippedOff;
      if (skippedOff) note += ` ${skippedOff} weekly off/holiday day(s) in the range were not counted as leave.`;
      if (recalculated) note += ' Salary was recalculated.';
      if (locked) note += ' Note: an already-approved month was not changed; unlock and recalculate it if pay should change.';
    }

    await notifyLeaveDecision(leave, action, { payType, remark: remark || '', skippedOffDays: skippedOffForMail });
    res.json({ success: true, message: `Leave ${action} successfully.` + (typeof note === 'string' ? note : '') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
