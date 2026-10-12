const db = require('../db');
const { buildCalendar } = require('./workCalendar');

// ── IST helpers (Asia/Kolkata = UTC+5:30) ────────────────────
function nowIST()   { return new Date(Date.now() + (5.5 * 60 * 60 * 1000)); }
function istMonth() { return nowIST().getUTCMonth() + 1; }
function istYear()  { return nowIST().getUTCFullYear(); }
function istDateStr() { return nowIST().toISOString().split('T')[0]; }

const MONTHS = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

async function getSettings() {
  const r = await db.query('SELECT key, value FROM attendance_settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  return s;
}

const SALARY_STRUCTURE_INCREMENT_COLUMNS = {
  increment_effective_date: 'increment_effective_date DATE',
  new_monthly_salary: 'new_monthly_salary NUMERIC(10,2)',
};

const SALARY_POLICY_COLUMNS = {
  paid_leave_days: 'paid_leave_days NUMERIC(8,2) DEFAULT 0',
  unpaid_leave_days: 'unpaid_leave_days NUMERIC(8,2) DEFAULT 0',
  sandwich_days: 'sandwich_days NUMERIC(8,2) DEFAULT 0',
  lop_days: 'lop_days NUMERIC(8,2) DEFAULT 0',
  salary_day_basis: "salary_day_basis VARCHAR(40) DEFAULT 'fixed_30'",
  per_day_salary: 'per_day_salary NUMERIC(12,2)',
  effective_grace_minutes: 'effective_grace_minutes NUMERIC(8,2) DEFAULT 0',
  chargeable_late_minutes: 'chargeable_late_minutes NUMERIC(8,2) DEFAULT 0',
};

function settingValue(settings, key, fallback) {
  const value = settings?.[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function settingBool(settings, key, fallback = false) {
  const value = settingValue(settings, key, fallback ? 'Yes' : 'No');
  return ['yes', 'true', '1', 'enabled', 'on'].includes(String(value).toLowerCase());
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// A timestamp-without-time-zone column arrives as a local-midnight Date.
function ymdLocal(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function normalizeLeavePayType(value, fallback = 'Paid') {
  const v = String(value || fallback).toLowerCase();
  return v === 'unpaid' ? 'Unpaid' : 'Paid';
}

async function ensureIncrementColumns() {
  const columnNames = Object.keys(SALARY_STRUCTURE_INCREMENT_COLUMNS);
  const existing = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='salary_structure'
       AND column_name = ANY($1::text[])`,
    [columnNames]
  );
  const existingNames = new Set(existing.rows.map(row => row.column_name));
  const missing = columnNames.filter(column => !existingNames.has(column));
  if (!missing.length) return;

  try {
    for (const column of missing) {
      await db.query(`ALTER TABLE salary_structure ADD COLUMN IF NOT EXISTS ${SALARY_STRUCTURE_INCREMENT_COLUMNS[column]}`);
    }
  } catch (err) {
    if (err.code === '42501') {
      const e = new Error(`Salary structure migration pending. Missing columns: ${missing.join(', ')}`);
      e.statusCode = 500;
      throw e;
    }
    throw err;
  }
}

async function ensureSalaryPolicyColumns() {
  const salaryColumns = Object.keys(SALARY_POLICY_COLUMNS);
  const existing = await db.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='salary'
       AND column_name = ANY($1::text[])`,
    [salaryColumns]
  );
  const existingNames = new Set(existing.rows.map(row => row.column_name));
  const missing = salaryColumns.filter(column => !existingNames.has(column));
  if (!missing.length) return;

  for (const column of missing) {
    await db.query(`ALTER TABLE salary ADD COLUMN IF NOT EXISTS ${SALARY_POLICY_COLUMNS[column]}`);
  }
}

// ── Salary calculation ───────────────────────────────────────
// Method (unchanged from the original):
//   Per Day  = monthly_salary / divisor (30 by default)
//   Present/Pending = full day, Half/Short Day = 0.5 loss, Leave Paid = full,
//   Leave Unpaid / Absent (non-holiday) = 1 day loss (LOP)
//   Late fine: (fine_per_mark × lateCount) + (fine_per_minute × chargeable late minutes)
//   Mid-month increment: split calculation at increment_effective_date
// Added on top (each only changes results where it applies):
//   * attendance_exempt staff are treated as present on working days without a record
//   * a day with status "Holiday" is a paid holiday even if not in the holidays table
//   * days before joining / after leaving are shown as "not employed" (unpaid) rather than Absent
//   * days that have not happened yet (current month) are not counted as Absent
//   * weekly off days come from settings (default Sunday only), see workCalendar.js
//   * optional extra pay for working on a weekly off / holiday (SALARY_HOLIDAY_WORK_PAY=extra_day)
async function calculateSalary({ month, year, empId = null, settings = null, today = null, dryRun = false } = {}) {
  const m = parseInt(month, 10), y = parseInt(year, 10);
  const daysInMonth = new Date(y, m, 0).getDate();
  const todayStr = today || istDateStr();

  await ensureIncrementColumns();
  await ensureSalaryPolicyColumns();
  const cfg = settings || await getSettings();
  const salaryDayBasis = settingValue(cfg, 'SALARY_DAY_BASIS', 'fixed_30');
  const sandwichEnabled = settingBool(cfg, 'SALARY_SANDWICH_LEAVE', false);
  const holidayCreditMode = settingValue(cfg, 'SALARY_HOLIDAY_CREDIT', 'paid');
  const defaultLeavePayType = normalizeLeavePayType(settingValue(cfg, 'SALARY_LEAVE_DEFAULT_PAY_TYPE', 'Paid'));
  const holidayWorkExtra = String(settingValue(cfg, 'SALARY_HOLIDAY_WORK_PAY', 'none')).toLowerCase() === 'extra_day';

  const holRes = await db.query(
    `SELECT EXTRACT(DAY FROM holiday_date)::int AS d FROM holidays
     WHERE EXTRACT(MONTH FROM holiday_date)=$1 AND EXTRACT(YEAR FROM holiday_date)=$2`,
    [m, y]
  );
  const declaredHolidays = new Set(holRes.rows.map(r => r.d));
  const cal = buildCalendar({ year: y, month: m, settings: cfg, declaredDays: declaredHolidays });
  const isDayHoliday = d => cal.isOff(d);
  const workingDays = cal.workingDays();
  const divisor = salaryDayBasis === 'calendar_days'
    ? daysInMonth
    : salaryDayBasis === 'fixed_26'
      ? 26
      : salaryDayBasis === 'working_days'
        ? Math.max(1, workingDays)
        : 30;

  const monthStart = isoDate(y, m, 1);
  // Bulk run: active staff, plus staff who left during or after this month (their last month is still owed).
  const empQuery = empId
    ? `SELECT s.*, e.status, e.date_of_joining, e.date_of_cessation FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id WHERE s.emp_id=$1 AND s.active='Yes'`
    : `SELECT s.*, e.status, e.date_of_joining, e.date_of_cessation FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id
        WHERE s.active='Yes'
          AND (e.status='Active' OR (e.date_of_cessation IS NOT NULL AND e.date_of_cessation::date >= $1::date))`;
  const structs = await db.query(empQuery, empId ? [empId] : [monthStart]);

  const results = [];
  const hints = [];
  if (declaredHolidays.size === 0) {
    hints.push(`No holidays are declared for ${MONTHS[m]} ${y}. Festival days will be counted as Absent unless you add them in Holidays (weekly offs are already handled).`);
  }
  let monthInProgress = false;

  for (const s of structs.rows) {
    const att = await db.query(
      `SELECT date, final_status, late_minutes, grace_minutes_granted, leave_pay_type
       FROM daily_attendance WHERE emp_id=$1 AND month=$2 AND year=$3 ORDER BY id`,
      [s.emp_id, m, y]
    );
    const leaveRows = await db.query(
      `SELECT from_date::date AS from_date, to_date::date AS to_date, pay_type
       FROM leave_requests
       WHERE emp_id=$1
         AND status='Approved'
         AND from_date::date <= $2::date
         AND to_date::date >= $3::date`,
      [s.emp_id, isoDate(y, m, daysInMonth), isoDate(y, m, 1)]
    );

    const dayMap = {};
    att.rows.forEach(r => {
      const d = new Date(r.date).getDate();
      dayMap[d] = {
        status: r.final_status,
        late_minutes: parseInt(r.late_minutes) || 0,
        grace: parseInt(r.grace_minutes_granted) || 0,
        leave_pay_type: r.leave_pay_type
      };
    });
    const leavePayByDay = {};
    for (const leave of leaveRows.rows) {
      const from = new Date(leave.from_date);
      const to = new Date(leave.to_date);
      for (let d = 1; d <= daysInMonth; d++) {
        const current = new Date(Date.UTC(y, m - 1, d));
        if (current >= from && current <= to) leavePayByDay[d] = normalizeLeavePayType(leave.pay_type, defaultLeavePayType);
      }
    }

    // Mid-month increment: split at incDay
    let incDay = 0;
    const incDate = s.increment_effective_date ? new Date(s.increment_effective_date) : null;
    if (incDate && incDate.getFullYear() === y && (incDate.getMonth() + 1) === m)
      incDay = incDate.getDate();

    const salaryOld = parseFloat(s.monthly_salary);
    const salaryNew = (incDay > 0 && s.new_monthly_salary) ? parseFloat(s.new_monthly_salary) : salaryOld;
    const perDayOld = salaryOld / divisor;
    const perDayNew = salaryNew / divisor;
    const fullOldUnits = incDay > 0 ? divisor * ((incDay - 1) / daysInMonth) : divisor;
    const fullNewUnits = incDay > 0 ? divisor - fullOldUnits : 0;
    const fullMonthGross = Math.round((perDayOld * fullOldUnits + perDayNew * fullNewUnits) * 100) / 100;

    let doj = ymdLocal(s.date_of_joining);
    // A cessation date only matters for someone who is no longer Active.
    let cessation = s.status === 'Active' ? null : ymdLocal(s.date_of_cessation);
    // If real attendance exists outside the joining/leaving dates, those dates are wrong
    // in the employee record; trust the attendance and never cut pay because of bad data.
    const REAL = ['Present', 'Pending', 'Half Day', 'Short Day', 'Leave'];
    const realDates = Object.entries(dayMap).filter(([, e]) => REAL.includes(e.status)).map(([day]) => isoDate(y, m, Number(day)));
    if (doj && realDates.some(ds => ds < doj)) doj = null;
    if (cessation && realDates.some(ds => ds > cessation)) cessation = null;
    const exempt = !!s.attendance_exempt;

    let presentDays = 0, halfDays = 0, paidLeaveDays = 0, unpaidLeaveDays = 0;
    let leaveDays = 0, absentDays = 0, holidayCredited = 0, sandwichDays = 0, notEmployedDays = 0;
    let holidayWorked = 0, extraOld = 0, extraNew = 0, futureDays = 0;
    let lopOld = 0, lopNew = 0, lateCount = 0, chargeableLateCount = 0, totalLateMins = 0, manualGraceMins = 0;
    const unpaidBoundary = {};
    const addLop = (day, units) => {
      if (units <= 0) return;
      if (incDay === 0 || day < incDay) lopOld += units; else lopNew += units;
    };
    const addExtra = (day, units) => {
      if (!holidayWorkExtra || units <= 0) return;
      if (incDay === 0 || day < incDay) extraOld += units; else extraNew += units;
    };

    for (let d = 1; d <= daysInMonth; d++) {
      const entry = dayMap[d];
      const st = entry?.status;
      const isHol = isDayHoliday(d);
      const dateStr = isoDate(y, m, d);
      const hasRealRecord = ['Present', 'Pending', 'Half Day', 'Short Day', 'Leave'].includes(st);

      // Outside the employment window (before joining / after leaving) with no real attendance on that day.
      if (!hasRealRecord && ((doj && dateStr < doj) || (cessation && dateStr > cessation))) {
        notEmployedDays++;
        addLop(d, 1);
        continue;
      }
      // A day that has not happened yet (current month) with nothing recorded is not an absence.
      if (!entry && dateStr > todayStr) { futureDays++; continue; }

      if (st === 'Present' || st === 'Pending') {
        presentDays++;
        if (isHol) { holidayWorked += 1; addExtra(d, 1); }
        if (entry.late_minutes > 0) {
          lateCount++;
          totalLateMins += entry.late_minutes;
          manualGraceMins += entry.grace || 0;
        }
      } else if (st === 'Half Day' || st === 'Short Day') {
        halfDays++;
        // A weekly off / holiday is already paid, so a short stint on that day must not cost half a day.
        if (!isHol) addLop(d, 0.5);
        if (isHol) { holidayWorked += 0.5; addExtra(d, 0.5); }
        if (entry.late_minutes > 0) {
          lateCount++;
          totalLateMins += entry.late_minutes;
          manualGraceMins += entry.grace || 0;
        }
      } else if (st === 'Leave') {
        leaveDays++;
        const payType = normalizeLeavePayType(entry.leave_pay_type || leavePayByDay[d], defaultLeavePayType);
        if (payType === 'Unpaid') {
          unpaidLeaveDays++;
          unpaidBoundary[d] = true;
          addLop(d, 1);
        } else {
          paidLeaveDays++;
        }
      } else if (st === 'Holiday') {
        // Marked as a holiday by the admin: paid, even if the date is not in the Holidays list.
        if (holidayCreditMode !== 'none') holidayCredited++;
      } else if (!isHol) {
        if (exempt && st !== 'Absent') {
          presentDays++;           // attendance not required for this person: paid as present
        } else {
          absentDays++;
          unpaidBoundary[d] = true;
          addLop(d, 1);
        }
      } else if (holidayCreditMode !== 'none') {
        holidayCredited++;
      }
    }
    if (futureDays > 0) monthInProgress = true;

    if (sandwichEnabled) {
      let d = 1;
      while (d <= daysInMonth) {
        if (!isDayHoliday(d)) { d++; continue; }
        const chainStart = d;
        while (d <= daysInMonth && isDayHoliday(d)) d++;
        const chainEnd = d - 1;
        const prevUnpaid = chainStart > 1 && unpaidBoundary[chainStart - 1];
        const nextUnpaid = chainEnd < daysInMonth && unpaidBoundary[chainEnd + 1];
        if (prevUnpaid && nextUnpaid) {
          for (let cd = chainStart; cd <= chainEnd; cd++) {
            sandwichDays++;
            addLop(cd, 1);
          }
        }
      }
    }

    const lopDays = Math.round((lopOld + lopNew) * 100) / 100;
    const extraDays = Math.round((extraOld + extraNew) * 100) / 100;
    const payableUnits = Math.max(0, Math.round((divisor - lopDays + extraDays) * 100) / 100);
    const grossSalary = Math.max(0, Math.round((fullMonthGross - (perDayOld * lopOld + perDayNew * lopNew) + (perDayOld * extraOld + perDayNew * extraNew)) * 100) / 100);
    const gracePool = (parseFloat(s.grace_allowed) || 0) + manualGraceMins;
    const effectiveGrace = Math.min(totalLateMins, gracePool);
    const chargeableLateMins = Math.max(0, totalLateMins - effectiveGrace);
    chargeableLateCount = chargeableLateMins > 0 ? lateCount : 0;
    const lateFine = Math.round(
      (parseFloat(s.late_fine_per_mark) || 0) * chargeableLateCount +
      (parseFloat(s.late_fine_per_minute) || 0) * chargeableLateMins
    );

    // Preserve existing manual adj if record already exists
    const existing = await db.query(
      `SELECT other_deduction, manual_addition, remark, calculation_status FROM salary WHERE emp_id=$1 AND month=$2 AND year=$3`,
      [s.emp_id, m, y]
    );
    const existingRow = existing.rows[0];
    // Don't overwrite Approved records
    if (existingRow?.calculation_status === 'Approved') {
      results.push({ emp_id: s.emp_id, employee_name: s.employee_name, skipped: true, reason: 'Already Approved' });
      continue;
    }
    const otherDed = parseFloat(existingRow?.other_deduction) || 0;
    const manualAdd = parseFloat(existingRow?.manual_addition) || 0;
    const netSalary = Math.max(0, grossSalary - lateFine - otherDed + manualAdd);

    if (!dryRun) await db.query(
      `INSERT INTO salary
         (month, year, emp_id, employee_name, formal_name, monthly_salary,
          present_days, half_days, absent_days, leave_days, holiday_days,
          late_count, total_late_minutes, grace_used, payable_days,
          gross_salary, late_fine, other_deduction, manual_addition,
          net_salary, calculation_status, paid_leave_days, unpaid_leave_days,
          sandwich_days, lop_days, salary_day_basis, per_day_salary, effective_grace_minutes,
          chargeable_late_minutes, not_employed_days, holiday_work_days, extra_pay_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$18,$14,$15,$16,0,0,$17,'Calculated',
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       ON CONFLICT (organization_id, month, year, emp_id) DO UPDATE SET
         present_days=$7, half_days=$8, absent_days=$9, leave_days=$10, holiday_days=$11,
         late_count=$12, total_late_minutes=$13, grace_used=$18, payable_days=$14,
         gross_salary=$15, late_fine=$16, net_salary=$17, calculation_status='Calculated',
         paid_leave_days=$19, unpaid_leave_days=$20, sandwich_days=$21, lop_days=$22,
         salary_day_basis=$23, per_day_salary=$24, effective_grace_minutes=$25,
         chargeable_late_minutes=$26, not_employed_days=$27, holiday_work_days=$28, extra_pay_days=$29`,
      [m, y, s.emp_id, s.employee_name, s.formal_name, incDay > 0 ? salaryNew : salaryOld,
       presentDays, halfDays, absentDays, leaveDays, holidayCredited,
       lateCount, totalLateMins, payableUnits, grossSalary, lateFine, netSalary,
       effectiveGrace, paidLeaveDays, unpaidLeaveDays, sandwichDays, lopDays,
       salaryDayBasis, Math.round(perDayOld * 100) / 100, effectiveGrace, chargeableLateMins,
       notEmployedDays, holidayWorked, extraDays]
    );

    results.push({
      emp_id: s.emp_id, employee_name: s.employee_name,
      present_days: presentDays, half_days: halfDays,
      leave_days: leaveDays, paid_leave_days: paidLeaveDays, unpaid_leave_days: unpaidLeaveDays,
      absent_days: absentDays, sandwich_days: sandwichDays, lop_days: lopDays,
      holiday_credited: holidayCredited,
      not_employed_days: notEmployedDays, holiday_work_days: holidayWorked, extra_pay_days: extraDays,
      attendance_exempt: exempt, future_days_skipped: futureDays,
      late_count: lateCount, total_late_minutes: totalLateMins,
      grace_used: effectiveGrace, chargeable_late_minutes: chargeableLateMins,
      payable_units: payableUnits,
      per_day_old: Math.round(perDayOld * 100) / 100,
      per_day_new: incDay > 0 ? Math.round(perDayNew * 100) / 100 : null,
      increment_from_day: incDay || null,
      salary_day_basis: salaryDayBasis,
      gross_salary: grossSalary, late_fine: lateFine, net_salary: netSalary
    });
  }

  if (monthInProgress) {
    hints.push(`${MONTHS[m]} ${y} is still in progress: days that have not happened yet are not counted as Absent. Calculate again after the month ends before approving.`);
  }
  return { results, hints, month_in_progress: monthInProgress };
}

// Re-run an employee's salary for a month after their attendance changed — only if
// a record already exists and is not locked. An approved (locked) record is never touched.
async function recalcIfOpen(empId, month, year) {
  const ex = await db.query(
    `SELECT calculation_status FROM salary WHERE emp_id=$1 AND month=$2 AND year=$3`,
    [empId, month, year]
  );
  if (!ex.rows.length) return { recalculated: false, reason: 'no_salary_record' };
  if (ex.rows[0].calculation_status === 'Approved') return { recalculated: false, locked: true };
  await calculateSalary({ month, year, empId });
  return { recalculated: true };
}

// Safe wrapper: a salary problem must never break the attendance action that triggered it.
async function recalcIfOpenSafe(empId, dateLike) {
  try {
    const d = String(dateLike).slice(0, 10);
    const [yy, mm] = d.split('-').map(Number);
    if (!yy || !mm) return { recalculated: false };
    return await recalcIfOpen(empId, mm, yy);
  } catch (err) {
    console.error('[salary auto-recalc]', err.message);
    return { recalculated: false, error: true };
  }
}

module.exports = {
  nowIST, istMonth, istYear, istDateStr, MONTHS, isoDate, ymdLocal,
  getSettings, settingValue, settingBool, normalizeLeavePayType,
  ensureIncrementColumns, ensureSalaryPolicyColumns,
  calculateSalary, recalcIfOpen, recalcIfOpenSafe,
};
