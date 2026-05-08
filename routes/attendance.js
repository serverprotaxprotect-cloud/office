const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ── Helper: load all settings as a key-value map ─────────────
async function getSettings() {
  const r = await db.query('SELECT key, value FROM attendance_settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  return s;
}

// Helper: "HH:MM:SS" → total minutes
function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = String(timeStr).split(':').map(Number);
  return h * 60 + m;
}

// ── GET /api/attendance/today ────────────────────────────────
router.get('/today', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  const today = new Date().toISOString().split('T')[0];

  try {
    const [punches, summary, cfg] = await Promise.all([
      db.query(
        `SELECT action, time, latitude, longitude, address, created_at
         FROM attendance_log WHERE emp_id=$1 AND date::date=$2 ORDER BY created_at ASC`,
        [emp_id, today]
      ),
      db.query(
        `SELECT first_in, last_out, working_hours, late_minutes, final_status, grace_minutes_granted
         FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`,
        [emp_id, today]
      ),
      getSettings()
    ]);

    const firstIn  = punches.rows.find(p => p.action === 'IN');
    const lastOut  = punches.rows.find(p => p.action === 'OUT');
    const isIn     = !!firstIn && !lastOut;

    res.json({
      success: true,
      today,
      office_start: cfg.OFFICE_START_TIME || '10:00:00',
      office_end:   cfg.OFFICE_END_TIME   || '18:30:00',
      is_currently_in: isIn,
      first_in:  firstIn?.time  || null,
      last_out:  lastOut?.time  || null,
      punches:   punches.rows,
      summary:   summary.rows[0] || null,
      settings:  cfg
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/attendance/mark ─────────────────────────────────
router.post('/mark', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { action, latitude, longitude, address, device_info } = req.body;

  if (!action || !['IN', 'OUT'].includes(action.toUpperCase()))
    return res.status(400).json({ success: false, message: 'Action must be IN or OUT' });

  const upperAction = action.toUpperCase();
  const now   = new Date();
  const today = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

  try {
    // ── One IN + One OUT per day rule ────────────────────────
    const existing = await db.query(
      `SELECT action FROM attendance_log WHERE emp_id=$1 AND date::date=$2 ORDER BY created_at ASC`,
      [emp_id, today]
    );
    const hasIN  = existing.rows.some(p => p.action === 'IN');
    const hasOUT = existing.rows.some(p => p.action === 'OUT');

    if (upperAction === 'IN') {
      if (hasIN) return res.status(400).json({ success: false, message: 'Aaj aap IN pehle se mark kar chuke hain. Ek din mein sirf ek baar IN allowed hai.' });
    } else {
      if (!hasIN)  return res.status(400).json({ success: false, message: 'Pehle IN punch karo, tab OUT kar sakte hain.' });
      if (hasOUT)  return res.status(400).json({ success: false, message: 'Aaj aap OUT pehle se mark kar chuke hain. Ek din mein sirf ek baar OUT allowed hai.' });
    }

    // ── Load settings ────────────────────────────────────────
    const cfg = await getSettings();
    const officeStartMins = toMinutes(cfg.OFFICE_START_TIME || '10:00:00');
    const lateThreshold   = parseInt(cfg.LATE_THRESHOLD_MINUTES || '0');
    const fullDayMins     = parseInt(cfg.FULL_DAY_MINUTES  || '480');
    const halfDayMins     = parseInt(cfg.HALF_DAY_MINUTES  || '240');

    const logId = 'ATD-' + uuidv4().toUpperCase().replace(/-/g, '').slice(0, 8);

    await db.query(
      `INSERT INTO attendance_log
         (log_id, date, emp_id, employee_name, formal_name, action, time,
          latitude, longitude, address, device_info, marked_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Self',NOW())`,
      [logId, today, emp_id, name, formal_name || name, upperAction, timeStr,
       latitude || null, longitude || null, address || null, device_info || null]
    );

    const month = now.getMonth() + 1;
    const year  = now.getFullYear();

    if (upperAction === 'IN') {
      // ── Calculate late minutes ─────────────────────────────
      const checkInMins = toMinutes(timeStr);
      const rawLate     = checkInMins - officeStartMins - lateThreshold;
      const lateMinutes = Math.max(0, rawLate);

      await db.query(
        `INSERT INTO daily_attendance
           (date, emp_id, employee_name, formal_name, first_in,
            late_minutes, early_leave_minutes, grace_minutes_granted,
            final_status, month, year)
         VALUES ($1,$2,$3,$4,$5,$6,0,0,'Pending',$7,$8)
         ON CONFLICT DO NOTHING`,
        [today, emp_id, name, formal_name || name, timeStr, lateMinutes, month, year]
      );

    } else {
      // ── OUT: calculate working hours and final status ──────
      const inRow = await db.query(
        `SELECT time FROM attendance_log
         WHERE emp_id=$1 AND date::date=$2 AND action='IN'
         ORDER BY created_at ASC LIMIT 1`,
        [emp_id, today]
      );

      if (inRow.rows.length > 0) {
        const inMins  = toMinutes(inRow.rows[0].time);
        const outMins = toMinutes(timeStr);
        const worked  = Math.max(0, outMins - inMins);
        const wh      = Math.floor(worked / 60);
        const wm      = worked % 60;
        const workingHours = `${wh}h ${wm}m`;

        // Determine status from settings
        let finalStatus = 'Absent';
        if (worked >= fullDayMins)     finalStatus = 'Present';
        else if (worked >= halfDayMins) finalStatus = 'Half Day';
        else                            finalStatus = 'Short Day';

        await db.query(
          `UPDATE daily_attendance
           SET last_out=$1, working_hours=$2, final_status=$3
           WHERE emp_id=$4 AND date::date=$5`,
          [timeStr, workingHours, finalStatus, emp_id, today]
        );
      }
    }

    const statusMsg = upperAction === 'IN'
      ? 'Attendance IN marked!'
      : 'Attendance OUT marked!';

    res.json({ success: true, message: statusMsg, action: upperAction, time: timeStr, date: today });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/history ───────────────────────────────
router.get('/history', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();

  try {
    const result = await db.query(
      `SELECT date, first_in, last_out, working_hours, late_minutes,
              early_leave_minutes, final_status, remark
       FROM daily_attendance WHERE emp_id=$1 AND month=$2 AND year=$3
       ORDER BY date ASC`,
      [emp_id, month, year]
    );
    const rows    = result.rows;
    const present = rows.filter(r => r.final_status === 'Present').length;
    const late    = rows.filter(r => r.late_minutes > 0).length;
    const pending = rows.filter(r => r.final_status === 'Pending').length;
    const halfDay = rows.filter(r => r.final_status === 'Half Day').length;

    res.json({
      success: true, month, year,
      records: rows,
      summary: { total: rows.length, present, late, pending, half_day: halfDay }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/profile ───────────────────────────────
router.get('/profile', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    const r = await db.query(
      `SELECT emp_id, name, formal_name, designation, email_id,
              mobile_no, blood_group, date_of_joining, status, photo
       FROM emplist WHERE emp_id=$1`,
      [emp_id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, employee: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/settings (public for display) ─────────
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ success: true, settings: s });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
