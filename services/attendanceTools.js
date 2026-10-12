const XLSX = require('xlsx');
const db = require('../db');
const { isOffDate, buildCalendar } = require('./workCalendar');
const { getSettings, istDateStr, isoDate, ymdLocal, MONTHS, settingValue } = require('./salaryService');

function toMinutes(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Auto-Absent ──────────────────────────────────────────────
// Creates an "Absent" record for every active employee who has no attendance record for
// the date. Never touches an existing record, never creates one for a weekly off/holiday,
// a day on approved leave, a day before joining, or for staff flagged "attendance not required".
async function markAbsentForDate(dateStr) {
  const settings = await getSettings();
  const hol = await db.query(`SELECT 1 FROM holidays WHERE holiday_date::date=$1::date LIMIT 1`, [dateStr]);
  if (isOffDate(dateStr, settings, hol.rows.length ? new Set([dateStr]) : new Set())) {
    return { date: dateStr, skipped: 'weekly off / holiday', inserted: 0 };
  }
  const [y, m] = dateStr.split('-').map(Number);
  const ins = await db.query(
    `INSERT INTO daily_attendance
       (organization_id, date, emp_id, employee_name, formal_name, final_status, late_minutes, month, year, remark)
     SELECT current_organization_id(), $1::date, e.emp_id, e.name, COALESCE(e.formal_name, e.name), 'Absent', 0, $2::int, $3::int,
            'Auto-marked absent: no punch recorded'
       FROM emplist e
       LEFT JOIN salary_structure s ON s.emp_id = e.emp_id AND s.active='Yes'
      WHERE e.status='Active'
        AND (e.date_of_joining IS NULL OR e.date_of_joining::date <= $1::date)
        AND COALESCE(s.attendance_exempt, FALSE) = FALSE
        AND NOT EXISTS (SELECT 1 FROM daily_attendance d WHERE d.emp_id = e.emp_id AND d.date::date = $1::date)
        AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.emp_id = e.emp_id AND l.status IN ('Approved','Pending')
                          AND $1::date BETWEEN l.from_date::date AND l.to_date::date)
        AND NOT EXISTS (SELECT 1 FROM attendance_requests r WHERE r.emp_id = e.emp_id AND r.status IN ('Pending','Approved')
                          AND r.request_date::date = $1::date)
     RETURNING emp_id`,
    [dateStr, m, y]
  );
  return { date: dateStr, inserted: ins.rowCount };
}

// Daily job (cron): the day that has just run out of grace, for every active organisation that switched it on.
// A missed day gets GRACE_DAYS to be regularised (request / leave) before it is marked Absent.
async function autoAbsentAllOrgs(dateStr = addDays(istDateStr(), -require('./attendanceReminders').GRACE_DAYS)) {
  const orgs = await db.runWithTenant({ bypassTenant: true }, () =>
    db.query(`SELECT id FROM organizations WHERE status='Active'`));
  const out = [];
  for (const org of orgs.rows) {
    try {
      const r = await db.runWithTenant({ organizationId: org.id }, async () => {
        const settings = await getSettings();
        if (String(settingValue(settings, 'AUTO_ABSENT_ENABLED', 'No')).toLowerCase() !== 'yes') return { enabled: false };
        return markAbsentForDate(dateStr);
      });
      out.push({ organization_id: org.id, ...r });
    } catch (err) {
      console.error('[auto-absent]', org.id, err.message);
      out.push({ organization_id: org.id, error: err.message });
    }
  }
  return out;
}

// ── Days that need a human look (listing only; nothing is changed) ──
async function reviewList(month, year) {
  const today = istDateStr();
  const r = await db.query(
    `SELECT d.id, d.emp_id, d.employee_name, d.date::date::text AS date, d.first_in, d.last_out, d.working_hours,
            d.final_status, d.late_minutes, d.remark,
            CASE WHEN d.first_in IS NOT NULL AND d.last_out IS NOT NULL
                 THEN EXTRACT(EPOCH FROM (d.last_out::time - d.first_in::time)) / 60 END AS worked_minutes
       FROM daily_attendance d
       LEFT JOIN salary_structure s ON s.emp_id = d.emp_id AND s.active='Yes'
      WHERE d.month=$1 AND d.year=$2
        AND (
              (d.final_status='Pending' AND d.date::date < $3::date)
           OR (d.final_status='Short Day' AND d.first_in IS NOT NULL AND d.last_out IS NOT NULL
               AND EXTRACT(EPOCH FROM (d.last_out::time - d.first_in::time)) / 60 < 30)
        )
      ORDER BY d.date DESC, d.emp_id`,
    [month, year, today]
  );
  return r.rows.map(row => ({
    ...row,
    flag: row.final_status === 'Pending' ? 'missing_out' : 'very_short',
    note: row.final_status === 'Pending'
      ? 'Punched IN but no OUT. Currently paid as a full day.'
      : `Only ${Math.round(Number(row.worked_minutes || 0))} minutes recorded. Currently paid as half a day.`,
  }));
}

// ── Monthly attendance report (Excel) ──
// Classification mirrors the salary rules so the report and the salary always agree.
async function buildMonthlyReport(month, year) {
  const m = parseInt(month, 10), y = parseInt(year, 10);
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStr = istDateStr();
  const settings = await getSettings();
  const fullDayMins = parseInt(settingValue(settings, 'FULL_DAY_MINUTES', '480'), 10);
  const holRes = await db.query(
    `SELECT EXTRACT(DAY FROM holiday_date)::int AS d FROM holidays WHERE EXTRACT(MONTH FROM holiday_date)=$1 AND EXTRACT(YEAR FROM holiday_date)=$2`, [m, y]);
  const cal = buildCalendar({ year: y, month: m, settings, declaredDays: new Set(holRes.rows.map(r => r.d)) });

  const emps = await db.query(
    `SELECT e.emp_id, COALESCE(e.formal_name, e.name) AS name, e.designation, e.status, e.date_of_joining, e.date_of_cessation,
            COALESCE(s.attendance_exempt, FALSE) AS exempt
       FROM emplist e
       LEFT JOIN salary_structure s ON s.emp_id = e.emp_id AND s.active='Yes'
      WHERE e.status='Active'
         OR e.emp_id IN (SELECT emp_id FROM daily_attendance WHERE month=$1 AND year=$2)
      ORDER BY e.emp_id`, [m, y]);
  const att = await db.query(
    `SELECT emp_id, date, final_status, first_in, last_out, late_minutes, leave_pay_type FROM daily_attendance WHERE month=$1 AND year=$2 ORDER BY id`, [m, y]);
  const byEmp = {};
  att.rows.forEach(r => { (byEmp[r.emp_id] = byEmp[r.emp_id] || {})[new Date(r.date).getDate()] = r; });

  const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
    const dow = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][new Date(y, m - 1, i + 1).getDay()];
    return `${i + 1} ${dow}`;
  });
  const summaryHeaders = ['Emp ID', 'Name', 'Designation', 'Present', 'Half/Short Day', 'No OUT (Pending)', 'Paid Leave', 'Unpaid Leave', 'Absent', 'Weekly Off/Holiday',
    'Worked on Off Day', 'Late Days', 'Late Minutes', 'Worked Hours', 'Overtime Hours', 'Note'];
  const summary = [summaryHeaders];
  const grid = [['Emp ID', 'Name', ...dayHeaders]];

  for (const e of emps.rows) {
    const rows = byEmp[e.emp_id] || {};
    const doj = ymdLocal(e.date_of_joining);
    const ces = e.status === 'Active' ? null : ymdLocal(e.date_of_cessation);
    const c = { present: 0, half: 0, pending: 0, paidLeave: 0, unpaidLeave: 0, absent: 0, off: 0, offWorked: 0, late: 0, lateMins: 0, workedMins: 0, otMins: 0 };
    const codes = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = isoDate(y, m, d);
      const rec = rows[d]; const st = rec?.final_status; const off = cal.isOff(d);
      const real = ['Present', 'Pending', 'Half Day', 'Short Day', 'Leave'].includes(st);
      let code;
      if (!real && ((doj && dateStr < doj) || (ces && dateStr > ces))) code = 'NE';
      else if (!rec && dateStr > todayStr) code = '';
      else if (st === 'Present' || st === 'Pending' || st === 'Half Day' || st === 'Short Day') {
        code = st === 'Present' ? 'P' : st === 'Pending' ? 'P*' : st === 'Half Day' ? 'H' : 'S';
        if (st === 'Present' || st === 'Pending') c.present++; else c.half++;
        if (st === 'Pending') c.pending++;
        if (off) c.offWorked++;
        if (Number(rec.late_minutes) > 0) { c.late++; c.lateMins += Number(rec.late_minutes); }
        const a = toMinutes(rec.first_in), b = toMinutes(rec.last_out);
        if (a !== null && b !== null && b >= a) { c.workedMins += b - a; if (st === 'Present') c.otMins += Math.max(0, b - a - fullDayMins); }
      } else if (st === 'Leave') {
        const unpaid = String(rec.leave_pay_type || 'Paid').toLowerCase() === 'unpaid';
        code = unpaid ? 'LU' : 'L'; unpaid ? c.unpaidLeave++ : c.paidLeave++;
      } else if (st === 'Holiday' || off) { code = 'WO'; c.off++; }
      else if (e.exempt && st !== 'Absent') { code = 'P'; c.present++; }
      else { code = 'A'; c.absent++; }
      codes.push(code);
    }
    summary.push([e.emp_id, e.name, e.designation || '', c.present, c.half, c.pending, c.paidLeave, c.unpaidLeave, c.absent, c.off, c.offWorked,
      c.late, c.lateMins, Math.round(c.workedMins / 6) / 10, Math.round(c.otMins / 6) / 10,
      e.exempt ? 'Attendance not required' : (e.status !== 'Active' ? e.status : '')]);
    grid.push([e.emp_id, e.name, ...codes]);
  }

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  ws1['!cols'] = summaryHeaders.map((h, i) => ({ wch: i === 1 ? 24 : i === 2 ? 20 : 14 }));
  XLSX.utils.book_append_sheet(wb, ws1, 'Summary');
  const ws2 = XLSX.utils.aoa_to_sheet(grid);
  ws2['!cols'] = [{ wch: 10 }, { wch: 24 }, ...dayHeaders.map(() => ({ wch: 5 }))];
  XLSX.utils.book_append_sheet(wb, ws2, 'Day by day');
  const legend = [['Code', 'Meaning'], ['P', 'Present'], ['P*', 'Punched IN but no OUT (paid as present)'], ['H', 'Half day'], ['S', 'Short day (paid as half)'], ['L', 'Paid leave'],
    ['LU', 'Unpaid leave'], ['A', 'Absent'], ['WO', 'Weekly off / holiday'], ['NE', 'Not employed that day (before joining / after leaving)'], ['(blank)', 'Day has not happened yet']];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(legend), 'Legend');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), filename: `attendance_${MONTHS[m]}_${y}.xlsx` };
}

module.exports = { markAbsentForDate, autoAbsentAllOrgs, reviewList, buildMonthlyReport, addDays };
