const db = require('../db');
const { reconcileAttendanceAlerts } = require('./performanceService');
const { recalcIfOpenSafe } = require('./salaryService');

function dateKey(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value || '').split('T')[0];
}
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
function salaryNote(rc) {
  if (!rc) return '';
  if (rc.recalculated) return ' Salary for this month was recalculated.';
  if (rc.locked) return " Note: this month's salary is already approved and was NOT changed. Unlock and recalculate it if the pay should change.";
  return '';
}

// Approves or rejects one attendance request and applies it (shared by the admin screen and the auto-approve job).
// Returns { status, body } so the route can reply with it unchanged.
async function processAttendanceRequest({ id, action, adminName, admin_remark, check_in_time, check_out_time }) {
    const reqRow = await db.query(
      `SELECT id, emp_id, employee_name, TO_CHAR(request_date, 'YYYY-MM-DD') AS request_date,
              check_in_time, check_out_time, reason, status, admin_remark,
              reviewed_by, reviewed_at, created_at
       FROM attendance_requests
       WHERE id=$1`,
      [id]
    );
    if (!reqRow.rows.length) return { status: 404, body: { success: false, message: 'Request not found' } };
    const r = reqRow.rows[0];

    await db.query(
      `UPDATE attendance_requests SET status=$1, reviewed_by=$2, reviewed_at=NOW(), admin_remark=$3 WHERE id=$4`,
      [action, adminName, admin_remark || null, id]
    );

    if (action === 'Approved') {
      const dateStr = dateKey(r.request_date);
      const [yearNum, monthNum] = dateStr.split('-').map(Number);
      const month = monthNum;
      const year  = yearNum;

      const empRow = await db.query(`SELECT name, formal_name FROM emplist WHERE emp_id=$1`, [r.emp_id]);
      const empName = empRow.rows[0]?.formal_name || empRow.rows[0]?.name || r.employee_name;

      const existsRow = await db.query(
        `SELECT emp_id, first_in, last_out FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`,
        [r.emp_id, dateStr]
      );
      const existingAttendance = existsRow.rows[0] || {};
      const inTime  = check_in_time  || r.check_in_time  || existingAttendance.first_in;
      const outTime = check_out_time || r.check_out_time || existingAttendance.last_out;

      if (!inTime && !outTime) {
        return { status: 400, body: { success: false, message: 'Approve karne ke liye IN ya OUT time required hai' } };
      }

      const cfg = await getSettings();
      const fullDayMins = parseInt(cfg.FULL_DAY_MINUTES || '480');
      const halfDayMins = parseInt(cfg.HALF_DAY_MINUTES || '240');
      const officeStartMins = toMinutes(cfg.OFFICE_START_TIME || '10:00:00');
      const lateThreshold = parseInt(cfg.LATE_THRESHOLD_MINUTES || '0');
      const lateMinutes = inTime ? Math.max(0, toMinutes(inTime) - officeStartMins - lateThreshold) : 0;
      let workingHours = null;
      let finalStatus = 'Pending';
      if (inTime && outTime) {
        const worked = Math.max(0, toMinutes(outTime) - toMinutes(inTime));
        workingHours = `${Math.floor(worked/60)}h ${worked%60}m`;
        finalStatus = worked >= fullDayMins ? 'Present' : worked >= halfDayMins ? 'Half Day' : 'Short Day';
      }

      if (existsRow.rows.length > 0) {
        await db.query(
          `UPDATE daily_attendance SET
             first_in=COALESCE($1, first_in), last_out=COALESCE($2, last_out),
             working_hours=COALESCE($3, working_hours), final_status=$4,
             late_minutes=$5,
             remark='Backdated - Approved', approved_by=$6, approved_at=NOW()
           WHERE emp_id=$7 AND date::date=$8`,
          [inTime || null, outTime || null, workingHours, finalStatus,
           lateMinutes, adminName, r.emp_id, dateStr]
        );
      } else {
        await db.query(
          `INSERT INTO daily_attendance
             (date, emp_id, employee_name, formal_name, first_in, last_out,
              working_hours, final_status, late_minutes, month, year, remark, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Backdated - Approved',$12,NOW())`,
          [dateStr, r.emp_id, empName, empName,
           inTime || null, outTime || null, workingHours, finalStatus,
           lateMinutes, month, year, adminName]
        );
      }

      const crypto = require('crypto');
      if (inTime) {
        await db.query(
          `INSERT INTO attendance_log
             (log_id, date, emp_id, employee_name, formal_name, action, time, marked_by, created_at)
           SELECT $1::varchar,$2::timestamp,$3::varchar,$4::varchar,$5::varchar,'IN',$6::varchar,'Admin-Approved',NOW()
            WHERE NOT EXISTS (SELECT 1 FROM attendance_log WHERE emp_id=$3 AND date::date=$2::date AND action='IN' AND time=$6)`,
          ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
           dateStr, r.emp_id, empName, empName, inTime]
        ).catch(() => {});
      }
      if (outTime) {
        await db.query(
          `INSERT INTO attendance_log
             (log_id, date, emp_id, employee_name, formal_name, action, time, marked_by, created_at)
           SELECT $1::varchar,$2::timestamp,$3::varchar,$4::varchar,$5::varchar,'OUT',$6::varchar,'Admin-Approved',NOW()
            WHERE NOT EXISTS (SELECT 1 FROM attendance_log WHERE emp_id=$3 AND date::date=$2::date AND action='OUT' AND time=$6)`,
          ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
           dateStr, r.emp_id, empName, empName, outTime]
        ).catch(() => {});
      }
    }

    let rc = null;
    if (action === 'Approved') {
      const approvedDate = dateKey(r.request_date);
      await reconcileAttendanceAlerts(r.emp_id, approvedDate).catch(error => {
        console.error('[Employee Monitor] attendance reconciliation failed:', error.message);
      });
      rc = await recalcIfOpenSafe(r.emp_id, approvedDate);
    }

  return { status: 200, body: { success: true, message: `Request ${action}.` + salaryNote(rc), salary: rc } };
}

// ── Auto-approve ─────────────────────────────────────────────
// Settings: AUTO_APPROVE_REQUESTS = Yes/No (default No), AUTO_APPROVE_DAY = day of month (default 5).
// From that day of a month, requests for EARLIER months that are still Pending (and at least 2 days old,
// so the admin always gets a window) are approved automatically, if the times look sane:
// OUT after IN and under 10 hours. Anything unusual stays Pending for the admin.
const MAX_AUTO_MINUTES = 600;

function looksSane(inTime, outTime) {
  if (!inTime || !outTime) return false;
  const diff = toMinutes(outTime) - toMinutes(inTime);
  return diff > 0 && diff < MAX_AUTO_MINUTES;
}

async function autoApproveForCurrentOrg(todayStr) {
  const cfg = await getSettings();
  if (String(cfg.AUTO_APPROVE_REQUESTS || 'No').toLowerCase() !== 'yes') return { enabled: false };
  const cutoffDay = Math.min(28, Math.max(1, parseInt(cfg.AUTO_APPROVE_DAY || '5', 10) || 5));
  const [y, m, d] = todayStr.split('-').map(Number);
  if (d < cutoffDay) return { enabled: true, waiting: true, approved: 0, skipped: 0 };
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const pend = await db.query(
    `SELECT r.id, r.emp_id, TO_CHAR(r.request_date,'YYYY-MM-DD') AS request_date, r.check_in_time, r.check_out_time,
            da.first_in AS ex_in, da.last_out AS ex_out
       FROM attendance_requests r
       LEFT JOIN daily_attendance da ON da.emp_id = r.emp_id AND da.date::date = r.request_date
      WHERE r.status='Pending' AND r.request_date < $1::date AND r.created_at <= NOW() - INTERVAL '2 days'
      ORDER BY r.request_date, r.id`, [monthStart]);
  let approved = 0, skipped = 0;
  for (const r of pend.rows) {
    const inTime = r.check_in_time || r.ex_in, outTime = r.check_out_time || r.ex_out;
    if (!looksSane(inTime, outTime)) { skipped++; continue; }
    const out = await processAttendanceRequest({
      id: r.id, action: 'Approved', adminName: 'System (auto-approve)',
      admin_remark: `Auto-approved on ${todayStr}: no admin action by day ${cutoffDay}.`,
    });
    if (out.status === 200) approved++; else skipped++;
  }
  if (approved || skipped) {
    const admins = await db.query(`SELECT username FROM admins WHERE status='Active' AND role = ANY($1::varchar[])`, [['Director', 'Office Manager', 'HR']]);
    const { createNotif } = require('../routes/notifications');
    const msg = `${approved} attendance request(s) were auto-approved because they stayed pending past day ${cutoffDay}.` +
      (skipped ? ` ${skipped} unusual request(s) were left for you to review.` : '');
    for (const a of admins.rows) await createNotif(a.username, 'attendance_auto_approve', 'Attendance requests auto-approved', msg, null);
  }
  return { enabled: true, approved, skipped };
}

async function autoApproveAllOrgs(todayStr = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)) {
  const orgs = await db.runWithTenant({ bypassTenant: true }, () => db.query(`SELECT id FROM organizations WHERE status='Active'`));
  const out = [];
  for (const org of orgs.rows) {
    try {
      const r = await db.runWithTenant({ organizationId: org.id }, () => autoApproveForCurrentOrg(todayStr));
      out.push({ organization_id: org.id, ...r });
    } catch (err) {
      console.error('[auto-approve]', org.id, err.message);
      out.push({ organization_id: org.id, error: err.message });
    }
  }
  return out;
}

module.exports = { processAttendanceRequest, autoApproveAllOrgs, autoApproveForCurrentOrg, looksSane, salaryNote, dateKey };
