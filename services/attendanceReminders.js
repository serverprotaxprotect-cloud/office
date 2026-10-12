const db = require('../db');
const { isOffDate } = require('./workCalendar');
const { getSettings, ymdLocal, settingValue } = require('./salaryService');

const LOOKBACK_DAYS = 31;
const PUNCH_IN_REMINDER_FROM = 12 * 60 + 30;   // 12:30
const PUNCH_IN_SECOND_REMINDER_FROM = 17 * 60; // 17:00
const PUNCH_OUT_REMINDER_FROM = 18 * 60 + 30;  // 18:30
const GRACE_DAYS = 2;                          // used by auto-absent: a missed day is marked Absent after this many days

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function istNow() {
  const d = new Date(Date.now() + 5.5 * 3600e3);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// What should this employee be reminded about right now?
// Returns { missing_days, missing_out_days, today, grace_days, auto_absent } (all empty for staff who need no attendance).
async function getReminders(empId, nowOverride = null) {
  const now = nowOverride || istNow();
  const empRes = await db.query(
    `SELECT e.emp_id, e.status, e.date_of_joining, e.date_of_cessation, COALESCE(s.attendance_exempt, FALSE) AS exempt
       FROM emplist e LEFT JOIN salary_structure s ON s.emp_id=e.emp_id AND s.active='Yes'
      WHERE e.emp_id=$1 LIMIT 1`, [empId]);
  const emp = empRes.rows[0];
  const empty = { missing_days: [], missing_out_days: [], today: null, grace_days: GRACE_DAYS, auto_absent: false };
  if (!emp || emp.status !== 'Active' || emp.exempt) return empty;

  const settings = await getSettings();
  const autoAbsent = String(settingValue(settings, 'AUTO_ABSENT_ENABLED', 'No')).toLowerCase() === 'yes';
  const doj = ymdLocal(emp.date_of_joining);
  const from = (() => { const lb = addDays(now.date, -LOOKBACK_DAYS); return doj && doj > lb ? doj : lb; })();
  const yesterday = addDays(now.date, -1);

  const [att, hol, reqs, leaves] = await Promise.all([
    db.query(`SELECT date::date::text AS d, final_status, first_in, last_out FROM daily_attendance WHERE emp_id=$1 AND date::date BETWEEN $2::date AND $3::date`, [empId, from, now.date]),
    db.query(`SELECT holiday_date::date::text AS d FROM holidays WHERE holiday_date::date BETWEEN $1::date AND $2::date`, [from, now.date]),
    db.query(`SELECT request_date::date::text AS d FROM attendance_requests WHERE emp_id=$1 AND status IN ('Pending','Approved') AND request_date BETWEEN $2::date AND $3::date`, [empId, from, now.date]),
    db.query(`SELECT from_date::date::text AS f, to_date::date::text AS t FROM leave_requests WHERE emp_id=$1 AND status IN ('Pending','Approved') AND to_date::date >= $2::date AND from_date::date <= $3::date`, [empId, from, now.date]),
  ]);
  const byDate = new Map(att.rows.map(r => [r.d, r]));
  const holSet = new Set(hol.rows.map(r => r.d));
  const reqSet = new Set(reqs.rows.map(r => r.d));
  const onLeave = d => leaves.rows.some(l => d >= l.f && d <= l.t);

  const missing = [], missingOut = [];
  for (let d = from; d <= yesterday; d = addDays(d, 1)) {
    if (isOffDate(d, settings, holSet)) continue;
    if (reqSet.has(d) || onLeave(d)) continue;
    const rec = byDate.get(d);
    if (!rec || rec.final_status === 'Absent') missing.push(d);
    else if (rec.final_status === 'Pending' && rec.first_in && !rec.last_out) missingOut.push(d);
  }

  // Today
  let today = null;
  if (!isOffDate(now.date, settings, holSet) && !reqSet.has(now.date) && !onLeave(now.date)) {
    const rec = byDate.get(now.date);
    const hasIn = !!(rec && rec.first_in);
    const hasOut = !!(rec && rec.last_out);
    if (!hasIn && rec?.final_status !== 'Leave' && now.minutes >= PUNCH_IN_REMINDER_FROM) {
      today = { kind: 'missing_in', date: now.date, slot: now.minutes >= PUNCH_IN_SECOND_REMINDER_FROM ? 2 : 1 };
    } else if (hasIn && !hasOut && now.minutes >= PUNCH_OUT_REMINDER_FROM) {
      today = { kind: 'missing_out', date: now.date, slot: 3 };
    }
  }

  const sortDesc = (a, b) => (a < b ? 1 : -1);
  return {
    missing_days: missing.sort(sortDesc).map(d => ({ date: d, absent_on: addDays(d, GRACE_DAYS) })),
    missing_out_days: missingOut.sort(sortDesc),
    today,
    grace_days: GRACE_DAYS,
    auto_absent: autoAbsent,
  };
}

module.exports = { getReminders, GRACE_DAYS, addDays };
