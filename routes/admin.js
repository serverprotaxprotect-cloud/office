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

// ── Helpers for admin routes ──────────────────────────────────
async function getSettings() {
  const r = await db.query('SELECT key, value FROM attendance_settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  return s;
}
function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = String(timeStr).split(':').map(Number);
  return h * 60 + (m || 0);
}
async function ensureHolidaysTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      holiday_date DATE NOT NULL UNIQUE,
      holiday_name VARCHAR(100) NOT NULL,
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
async function ensureRequestsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_requests (
      id SERIAL PRIMARY KEY,
      emp_id VARCHAR(50) NOT NULL,
      employee_name VARCHAR(100),
      request_date DATE NOT NULL,
      check_in_time TIME,
      check_out_time TIME,
      reason TEXT,
      status VARCHAR(20) DEFAULT 'Pending',
      reviewed_by VARCHAR(100),
      reviewed_at TIMESTAMPTZ,
      admin_remark TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── GET /api/admin/holidays ───────────────────────────────────
router.get('/holidays', adminAuth, async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();
  try {
    await ensureHolidaysTable();
    const result = await db.query(
      `SELECT id, holiday_date, holiday_name, created_by FROM holidays
       WHERE EXTRACT(YEAR FROM holiday_date) = $1 ORDER BY holiday_date`,
      [year]
    );
    res.json({ success: true, holidays: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/admin/holidays ──────────────────────────────────
router.post('/holidays', adminAuth, async (req, res) => {
  const { holiday_date, holiday_name } = req.body;
  if (!holiday_date || !holiday_name)
    return res.status(400).json({ success: false, message: 'Date and name required' });
  try {
    await ensureHolidaysTable();
    await db.query(
      `INSERT INTO holidays (holiday_date, holiday_name, created_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (holiday_date) DO UPDATE SET holiday_name=$2, created_by=$3`,
      [holiday_date, holiday_name.trim(), req.admin.name]
    );
    res.json({ success: true, message: 'Holiday saved!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/admin/holidays/:id ───────────────────────────
router.delete('/holidays/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`DELETE FROM holidays WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Holiday removed' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/admin/attendance-requests ───────────────────────
router.get('/attendance-requests', adminAuth, async (req, res) => {
  const status = req.query.status || 'Pending';
  try {
    await ensureRequestsTable();
    const result = await db.query(
      `SELECT ar.*, e.designation FROM attendance_requests ar
       LEFT JOIN emplist e ON e.emp_id = ar.emp_id
       WHERE ar.status=$1 ORDER BY ar.created_at DESC`,
      [status]
    );
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/admin/attendance-requests/:id ───────────────────
router.put('/attendance-requests/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { action, admin_remark, check_in_time, check_out_time } = req.body;
  if (!['Approved', 'Rejected'].includes(action))
    return res.status(400).json({ success: false, message: 'Invalid action' });
  try {
    const reqRow = await db.query(`SELECT * FROM attendance_requests WHERE id=$1`, [id]);
    if (!reqRow.rows.length) return res.status(404).json({ success: false, message: 'Request not found' });
    const r = reqRow.rows[0];

    await db.query(
      `UPDATE attendance_requests SET status=$1, reviewed_by=$2, reviewed_at=NOW(), admin_remark=$3 WHERE id=$4`,
      [action, req.admin.name, admin_remark || null, id]
    );

    if (action === 'Approved') {
      const inTime  = check_in_time  || r.check_in_time;
      const outTime = check_out_time || r.check_out_time;
      const dateStr = r.request_date instanceof Date
        ? r.request_date.toISOString().split('T')[0]
        : String(r.request_date).split('T')[0];
      const dateObj = new Date(dateStr);
      const month = dateObj.getMonth() + 1;
      const year  = dateObj.getFullYear();

      let workingHours = null;
      let finalStatus  = 'Present';
      if (inTime && outTime) {
        const cfg = await getSettings();
        const fullDayMins = parseInt(cfg.FULL_DAY_MINUTES || '480');
        const halfDayMins = parseInt(cfg.HALF_DAY_MINUTES || '240');
        const worked = Math.max(0, toMinutes(outTime) - toMinutes(inTime));
        workingHours = `${Math.floor(worked/60)}h ${worked%60}m`;
        finalStatus  = worked >= fullDayMins ? 'Present' : worked >= halfDayMins ? 'Half Day' : 'Short Day';
      }

      const empRow = await db.query(`SELECT name, formal_name FROM emplist WHERE emp_id=$1`, [r.emp_id]);
      const empName = empRow.rows[0]?.formal_name || empRow.rows[0]?.name || r.employee_name;

      const existsRow = await db.query(
        `SELECT emp_id FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`,
        [r.emp_id, dateStr]
      );
      if (existsRow.rows.length > 0) {
        await db.query(
          `UPDATE daily_attendance SET
             first_in=COALESCE($1, first_in), last_out=COALESCE($2, last_out),
             working_hours=COALESCE($3, working_hours), final_status=$4,
             remark='Backdated - Approved', approved_by=$5, approved_at=NOW()
           WHERE emp_id=$6 AND date::date=$7`,
          [inTime || null, outTime || null, workingHours, finalStatus,
           req.admin.name, r.emp_id, dateStr]
        );
      } else {
        await db.query(
          `INSERT INTO daily_attendance
             (date, emp_id, employee_name, formal_name, first_in, last_out,
              working_hours, final_status, month, year, remark, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Backdated - Approved',$11,NOW())`,
          [dateStr, r.emp_id, empName, empName,
           inTime || null, outTime || null, workingHours, finalStatus,
           month, year, req.admin.name]
        );
      }

      const crypto = require('crypto');
      if (inTime) {
        await db.query(
          `INSERT INTO attendance_log
             (log_id, date, emp_id, employee_name, formal_name, action, time, marked_by, created_at)
           VALUES ($1,$2,$3,$4,$5,'IN',$6,'Admin-Approved',NOW())
           ON CONFLICT DO NOTHING`,
          ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
           dateStr, r.emp_id, empName, empName, inTime]
        ).catch(() => {});
      }
      if (outTime) {
        await db.query(
          `INSERT INTO attendance_log
             (log_id, date, emp_id, employee_name, formal_name, action, time, marked_by, created_at)
           VALUES ($1,$2,$3,$4,$5,'OUT',$6,'Admin-Approved',NOW())
           ON CONFLICT DO NOTHING`,
          ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
           dateStr, r.emp_id, empName, empName, outTime]
        ).catch(() => {});
      }
    }

    res.json({ success: true, message: `Request ${action}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── POST /api/admin/attendance/modify-time ───────────────────
router.post('/attendance/modify-time', adminAuth, async (req, res) => {
  const { emp_id, date, check_in_time, check_out_time } = req.body;
  if (!emp_id || !date) return res.status(400).json({ success: false, message: 'emp_id and date required' });
  try {
    const cfg = await getSettings();
    const fullDayMins = parseInt(cfg.FULL_DAY_MINUTES || '480');
    const halfDayMins = parseInt(cfg.HALF_DAY_MINUTES || '240');

    const sets = [];
    const vals = [];
    let idx = 1;
    if (check_in_time)  { sets.push(`first_in=$${idx++}`);  vals.push(check_in_time); }
    if (check_out_time) { sets.push(`last_out=$${idx++}`);  vals.push(check_out_time); }

    if (check_in_time && check_out_time) {
      const worked = Math.max(0, toMinutes(check_out_time) - toMinutes(check_in_time));
      const wh = `${Math.floor(worked/60)}h ${worked%60}m`;
      const fs = worked >= fullDayMins ? 'Present' : worked >= halfDayMins ? 'Half Day' : 'Short Day';
      sets.push(`working_hours=$${idx++}`, `final_status=$${idx++}`);
      vals.push(wh, fs);
    }

    sets.push(`approved_by=$${idx++}`, `approved_at=NOW()`);
    vals.push(req.admin.name, emp_id, date);

    await db.query(
      `UPDATE daily_attendance SET ${sets.join(',')} WHERE emp_id=$${idx++} AND date::date=$${idx}`,
      vals
    );
    res.json({ success: true, message: 'Attendance time updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
