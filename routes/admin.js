const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');

const router = express.Router();

// ── POST /api/admin/login ────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });

  try {
    const r = await db.query(
      `SELECT username, password, name, email_id, role FROM admins WHERE LOWER(username)=LOWER($1)`,
      [username.trim()]
    );
    if (!r.rows.length)
      return res.status(401).json({ success: false, message: 'Username not found' });

    const admin = r.rows[0];
    if (admin.password !== password)
      return res.status(401).json({ success: false, message: 'Incorrect password' });

    const token = jwt.sign(
      { username: admin.username, name: admin.name, role: admin.role, is_admin: true },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ success: true, token, admin: { username: admin.username, name: admin.name, role: admin.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/overview ──────────────────────────────────
router.get('/overview', adminAuth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const [total, present, onLeave, sessions] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM emplist WHERE status='Active'`),
      db.query(`SELECT COUNT(DISTINCT emp_id) FROM daily_attendance WHERE date::date=$1 AND final_status IN ('Present','Pending')`, [today]),
      db.query(`SELECT COUNT(*) FROM leave_requests WHERE $1 BETWEEN from_date::date AND to_date::date AND status='Approved'`, [today]),
      db.query(`SELECT e.emp_id, e.name, e.formal_name, e.designation, a.first_in, a.final_status
                FROM emplist e
                LEFT JOIN daily_attendance a ON a.emp_id=e.emp_id AND a.date::date=$1
                WHERE e.status='Active'
                ORDER BY e.name`, [today])
    ]);

    const totalCount   = parseInt(total.rows[0].count);
    const presentCount = parseInt(present.rows[0].count);
    const leaveCount   = parseInt(onLeave.rows[0].count);
    const absentCount  = totalCount - presentCount - leaveCount;

    res.json({
      success: true,
      today,
      stats: { total: totalCount, present: presentCount, on_leave: leaveCount, absent: Math.max(0, absentCount) },
      employees_today: sessions.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/attendance?month=&year= ───────────────────
router.get('/attendance', adminAuth, async (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  try {
    const records = await db.query(
      `SELECT a.*, e.designation
       FROM daily_attendance a
       JOIN emplist e ON e.emp_id = a.emp_id
       WHERE a.month=$1 AND a.year=$2
       ORDER BY a.date DESC, a.employee_name`,
      [month, year]
    );
    // Summary per employee
    const summary = await db.query(
      `SELECT emp_id, employee_name,
              COUNT(*) as total_days,
              COUNT(*) FILTER (WHERE final_status='Present') as present,
              COUNT(*) FILTER (WHERE final_status='Pending') as pending,
              COUNT(*) FILTER (WHERE late_minutes > 0) as late_days,
              SUM(late_minutes) as total_late_mins
       FROM daily_attendance
       WHERE month=$1 AND year=$2
       GROUP BY emp_id, employee_name
       ORDER BY employee_name`,
      [month, year]
    );
    res.json({ success: true, month, year, records: records.rows, summary: summary.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/attendance/update ───────────────────────
router.post('/attendance/update', adminAuth, async (req, res) => {
  const { emp_id, date, final_status, grace_minutes, remark } = req.body;
  try {
    await db.query(
      `UPDATE daily_attendance
       SET final_status=$1, grace_minutes_granted=COALESCE($2,grace_minutes_granted),
           remark=$3, approved_by=$4, approved_at=NOW()
       WHERE emp_id=$5 AND date::date=$6`,
      [final_status, grace_minutes || null, remark || null, req.admin.name, emp_id, date]
    );
    res.json({ success: true, message: 'Attendance updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/employees ─────────────────────────────────
router.get('/employees', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT emp_id, name, formal_name, designation, email_id, mobile_no,
              date_of_joining, status, blood_group, basic_pay, paid_leave_per_year
       FROM emplist ORDER BY name`
    );
    res.json({ success: true, employees: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/employees/add ───────────────────────────
router.post('/employees/add', adminAuth, async (req, res) => {
  const {
    name, formal_name, designation, email_id, mobile_no,
    date_of_joining, basic_pay, login_password, paid_leave_per_year,
    education, sex, marital_status
  } = req.body;

  if (!name || !designation || !login_password)
    return res.status(400).json({ success: false, message: 'Name, Designation and Password required' });

  try {
    // Auto-generate emp_id
    const last = await db.query(`SELECT emp_id FROM emplist ORDER BY emp_id DESC LIMIT 1`);
    let newId = 'PTP-0001';
    if (last.rows.length) {
      const num = parseInt(last.rows[0].emp_id.replace('PTP-', '')) + 1;
      newId = 'PTP-' + String(num).padStart(4, '0');
    }

    await db.query(
      `INSERT INTO emplist
         (emp_id, name, formal_name, designation, email_id, mobile_no,
          date_of_joining, basic_pay, login_password, paid_leave_per_year,
          education, sex, marital_status, status, leave_availed, leave_rest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'Active',0,$10)`,
      [newId, name, formal_name || name, designation, email_id || null,
       mobile_no || null, date_of_joining || null, basic_pay || null,
       login_password, paid_leave_per_year || 12,
       education || null, sex || null, marital_status || null]
    );
    res.json({ success: true, message: `Employee added with ID: ${newId}`, emp_id: newId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── PUT /api/admin/employees/:id ─────────────────────────────
router.put('/employees/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { designation, email_id, mobile_no, basic_pay, status, login_password, paid_leave_per_year } = req.body;
  try {
    await db.query(
      `UPDATE emplist SET designation=COALESCE($1,designation), email_id=COALESCE($2,email_id),
       mobile_no=COALESCE($3,mobile_no), basic_pay=COALESCE($4,basic_pay),
       status=COALESCE($5,status), login_password=COALESCE($6,login_password),
       paid_leave_per_year=COALESCE($7,paid_leave_per_year)
       WHERE emp_id=$8`,
      [designation||null, email_id||null, mobile_no||null, basic_pay||null,
       status||null, login_password||null, paid_leave_per_year||null, id]
    );
    res.json({ success: true, message: 'Employee updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
