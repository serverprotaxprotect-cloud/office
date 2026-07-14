const express = require('express');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const authMiddleware = require('../middleware/auth');
const XLSX = require('xlsx');

const router = express.Router();

// ── IST helpers (Asia/Kolkata = UTC+5:30) ────────────────────
function nowIST()   { return new Date(Date.now() + (5.5 * 60 * 60 * 1000)); }
function istMonth() { return nowIST().getUTCMonth() + 1; }
function istYear()  { return nowIST().getUTCFullYear(); }

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

// ── GET /api/salary/structure ────────────────────────────────
router.get('/structure', adminAuth, async (req, res) => {
  try {
    await ensureIncrementColumns();
    const r = await db.query(
      `SELECT s.*, e.designation FROM salary_structure s
       JOIN emplist e ON e.emp_id=s.emp_id ORDER BY s.employee_name`
    );
    const missing = await db.query(
      `SELECT emp_id, name, formal_name, designation, basic_pay
       FROM emplist WHERE status='Active'
         AND emp_id NOT IN (SELECT emp_id FROM salary_structure WHERE active='Yes')
       ORDER BY name`
    );
    res.json({ success: true, structures: r.rows, missing: missing.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/structure ───────────────────────────────
router.post('/structure', adminAuth, async (req, res) => {
  const { emp_id, monthly_salary, late_fine_per_mark, late_fine_per_minute,
          grace_allowed, increment_effective_date, new_monthly_salary } = req.body;
  if (!emp_id || !monthly_salary)
    return res.status(400).json({ success: false, message: 'emp_id and monthly_salary required' });
  try {
    await ensureIncrementColumns();
    const emp = await db.query(`SELECT name, formal_name FROM emplist WHERE emp_id=$1`, [emp_id]);
    if (!emp.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    const { name, formal_name } = emp.rows[0];
    const perDay = (parseFloat(monthly_salary) / 30).toFixed(2);
    await db.query(
      `INSERT INTO salary_structure
         (emp_id, employee_name, formal_name, monthly_salary, per_day_salary,
          half_day_rule, late_fine_per_mark, late_fine_per_minute, grace_allowed,
          increment_effective_date, new_monthly_salary, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,'Half Day = 0.5',$6,$7,$8,$9,$10,'Yes',NOW())
       ON CONFLICT (organization_id, emp_id) DO UPDATE SET
         monthly_salary=$4, per_day_salary=$5,
         late_fine_per_mark=$6, late_fine_per_minute=$7, grace_allowed=$8,
         increment_effective_date=$9, new_monthly_salary=$10,
         active='Yes', updated_at=NOW()`,
      [emp_id, name, formal_name || name, monthly_salary, perDay,
       late_fine_per_mark || 0, late_fine_per_minute || 0, grace_allowed || 0,
       increment_effective_date || null, new_monthly_salary || null]
    );
    res.json({ success: true, message: 'Salary structure saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/calculate ───────────────────────────────
// Method: Google App Script
//   Per Day  = monthly_salary / 30
//   Units    : Present/Pending=1, Half/Short=0.5, Leave=1, Absent=0
//   Holiday chain: consecutive non-worked holidays adjacent to worked day = 1 unit
//   Normalization: no absents → 30; else min(rawUnits, 30)
//   Late fine: (fine_per_mark × lateCount) + (fine_per_minute × totalLateMins)
//   Mid-month increment: split calculation at increment_effective_date
router.post('/calculate', adminAuth, async (req, res) => {
  const { month, year, emp_id } = req.body;
  if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
  const m = parseInt(month), y = parseInt(year);
  const daysInMonth = new Date(y, m, 0).getDate();

  try {
    await ensureIncrementColumns();
    await ensureSalaryPolicyColumns();
    const settings = await getSettings();
    const salaryDayBasis = settingValue(settings, 'SALARY_DAY_BASIS', 'fixed_30');
    const sandwichEnabled = settingBool(settings, 'SALARY_SANDWICH_LEAVE', false);
    const holidayCreditMode = settingValue(settings, 'SALARY_HOLIDAY_CREDIT', 'paid');
    const defaultLeavePayType = normalizeLeavePayType(settingValue(settings, 'SALARY_LEAVE_DEFAULT_PAY_TYPE', 'Paid'));

    const holRes = await db.query(
      `SELECT EXTRACT(DAY FROM holiday_date)::int AS d FROM holidays
       WHERE EXTRACT(MONTH FROM holiday_date)=$1 AND EXTRACT(YEAR FROM holiday_date)=$2`,
      [m, y]
    );
    const declaredHolidays = new Set(holRes.rows.map(r => r.d));
    const isDayHoliday = d => new Date(y, m - 1, d).getDay() === 0 || declaredHolidays.has(d);
    const workingDays = Array.from({ length: daysInMonth }, (_, i) => i + 1).filter(d => !isDayHoliday(d)).length;
    const divisor = salaryDayBasis === 'calendar_days'
      ? daysInMonth
      : salaryDayBasis === 'fixed_26'
        ? 26
        : salaryDayBasis === 'working_days'
          ? Math.max(1, workingDays)
          : 30;

    const empQuery = emp_id
      ? `SELECT s.*, e.status FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id WHERE s.emp_id=$1 AND s.active='Yes'`
      : `SELECT s.*, e.status FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id WHERE s.active='Yes' AND e.status='Active'`;
    const structs = await db.query(empQuery, emp_id ? [emp_id] : []);

    const results = [];

    for (const s of structs.rows) {
      const att = await db.query(
        `SELECT date, final_status, late_minutes, grace_minutes_granted, leave_pay_type
         FROM daily_attendance WHERE emp_id=$1 AND month=$2 AND year=$3`,
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

      let presentDays = 0, halfDays = 0, paidLeaveDays = 0, unpaidLeaveDays = 0;
      let leaveDays = 0, absentDays = 0, holidayCredited = 0, sandwichDays = 0;
      let lopOld = 0, lopNew = 0, lateCount = 0, chargeableLateCount = 0, totalLateMins = 0, manualGraceMins = 0;
      const unpaidBoundary = {};
      const addLop = (day, units) => {
        if (units <= 0) return;
        if (incDay === 0 || day < incDay) lopOld += units; else lopNew += units;
      };

      for (let d = 1; d <= daysInMonth; d++) {
        const entry = dayMap[d];
        const st = entry?.status;
        const isHol = isDayHoliday(d);

        if (st === 'Present' || st === 'Pending') {
          presentDays++;
          if (entry.late_minutes > 0) {
            lateCount++;
            totalLateMins += entry.late_minutes;
            manualGraceMins += entry.grace || 0;
          }
        } else if (st === 'Half Day' || st === 'Short Day') {
          halfDays++;
          addLop(d, 0.5);
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
        } else if (!isHol) {
          absentDays++;
          unpaidBoundary[d] = true;
          addLop(d, 1);
        } else if (holidayCreditMode !== 'none') {
          holidayCredited++;
        }
      }

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
      const payableUnits = Math.max(0, Math.round((divisor - lopDays) * 100) / 100);
      const grossSalary = Math.max(0, Math.round((fullMonthGross - (perDayOld * lopOld + perDayNew * lopNew)) * 100) / 100);
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

      await db.query(
        `INSERT INTO salary
           (month, year, emp_id, employee_name, formal_name, monthly_salary,
            present_days, half_days, absent_days, leave_days, holiday_days,
            late_count, total_late_minutes, grace_used, payable_days,
            gross_salary, late_fine, other_deduction, manual_addition,
            net_salary, calculation_status, paid_leave_days, unpaid_leave_days,
            sandwich_days, lop_days, salary_day_basis, per_day_salary, effective_grace_minutes,
            chargeable_late_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$18,$14,$15,$16,0,0,$17,'Calculated',
                 $19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (organization_id, month, year, emp_id) DO UPDATE SET
           present_days=$7, half_days=$8, absent_days=$9, leave_days=$10, holiday_days=$11,
           late_count=$12, total_late_minutes=$13, grace_used=$18, payable_days=$14,
           gross_salary=$15, late_fine=$16, net_salary=$17, calculation_status='Calculated',
           paid_leave_days=$19, unpaid_leave_days=$20, sandwich_days=$21, lop_days=$22,
           salary_day_basis=$23, per_day_salary=$24, effective_grace_minutes=$25,
           chargeable_late_minutes=$26`,
        [m, y, s.emp_id, s.employee_name, s.formal_name, incDay > 0 ? salaryNew : salaryOld,
         presentDays, halfDays, absentDays, leaveDays, holidayCredited,
         lateCount, totalLateMins, payableUnits, grossSalary, lateFine, netSalary,
         effectiveGrace, paidLeaveDays, unpaidLeaveDays, sandwichDays, lopDays,
         salaryDayBasis, Math.round(perDayOld * 100) / 100, effectiveGrace, chargeableLateMins]
      );

      results.push({
        emp_id: s.emp_id, employee_name: s.employee_name,
        present_days: presentDays, half_days: halfDays,
        leave_days: leaveDays, paid_leave_days: paidLeaveDays, unpaid_leave_days: unpaidLeaveDays,
        absent_days: absentDays, sandwich_days: sandwichDays, lop_days: lopDays,
        holiday_credited: holidayCredited,
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

    res.json({ success: true, message: `Salary calculated for ${results.filter(r => !r.skipped).length} employees`, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── GET /api/salary/records ──────────────────────────────────
router.get('/records', adminAuth, async (req, res) => {
  const month = parseInt(req.query.month) || istMonth();
  const year  = parseInt(req.query.year)  || istYear();
  try {
    const r = await db.query(
      `SELECT s.*, e.designation FROM salary s
       LEFT JOIN emplist e ON e.emp_id=s.emp_id
       WHERE s.month=$1 AND s.year=$2 ORDER BY s.employee_name`,
      [month, year]
    );
    const totals = r.rows.reduce((acc, row) => ({
      gross: acc.gross + (parseFloat(row.gross_salary) || 0),
      deductions: acc.deductions + (parseFloat(row.late_fine) || 0) + (parseFloat(row.other_deduction) || 0),
      net: acc.net + (parseFloat(row.net_salary) || 0)
    }), { gross: 0, deductions: 0, net: 0 });
    res.json({ success: true, month, year, records: r.rows, totals });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/salary/records/export ──────────────────────────
router.get('/records/export', adminAuth, async (req, res) => {
  const month = parseInt(req.query.month) || istMonth();
  const year  = parseInt(req.query.year)  || istYear();
  try {
    await ensureSalaryPolicyColumns();
    const r = await db.query(
      `SELECT s.emp_id, s.employee_name, s.monthly_salary,
              s.present_days, s.half_days, s.leave_days, s.absent_days, s.holiday_days,
              s.paid_leave_days, s.unpaid_leave_days, s.sandwich_days, s.lop_days,
              s.late_count, s.total_late_minutes, s.grace_used, s.chargeable_late_minutes, s.payable_days,
              s.salary_day_basis, s.per_day_salary,
              s.gross_salary, s.late_fine, s.other_deduction, s.manual_addition, s.net_salary,
              s.calculation_status, s.verified_by, s.remark
       FROM salary s WHERE s.month=$1 AND s.year=$2 ORDER BY s.employee_name`,
      [month, year]
    );
    const wb = XLSX.utils.book_new();
    const headers = ['Emp ID','Employee Name','Basic Salary','Present','Half Day','Leave','Paid Leave','Unpaid Leave','Absent','Sandwich','LOP','Holiday+','Late Count','Late Mins','Grace Used','Chargeable Late Mins','Payable Units','Salary Basis','Per Day','Gross','Late Fine','Other Deduction','Bonus','Net Salary','Status','Approved By','Remark'];
    const rows = r.rows.map(row => [
      row.emp_id, row.employee_name, row.monthly_salary,
      row.present_days, row.half_days, row.leave_days, row.paid_leave_days, row.unpaid_leave_days,
      row.absent_days, row.sandwich_days, row.lop_days, row.holiday_days,
      row.late_count, row.total_late_minutes, row.grace_used, row.chargeable_late_minutes, row.payable_days,
      row.salary_day_basis, row.per_day_salary,
      row.gross_salary, row.late_fine, row.other_deduction, row.manual_addition, row.net_salary,
      row.calculation_status, row.verified_by || '', row.remark || ''
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    ws['!cols'] = headers.map(() => ({ wch: 15 }));
    XLSX.utils.book_append_sheet(wb, ws, `${MONTHS[month]} ${year}`);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="salary_${MONTHS[month]}_${year}.xlsx"`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/approve ─────────────────────────────────
router.post('/approve', adminAuth, async (req, res) => {
  const { emp_id, month, year } = req.body;
  try {
    await db.query(
      `UPDATE salary SET calculation_status='Approved', verified_by=$1, verified_at=NOW()
       WHERE emp_id=$2 AND month=$3 AND year=$4`,
      [req.admin.name, emp_id, month, year]
    );
    res.json({ success: true, message: 'Salary approved and locked' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/approve-all ────────────────────────────
router.post('/approve-all', adminAuth, async (req, res) => {
  const { month, year } = req.body;
  try {
    const r = await db.query(
      `UPDATE salary SET calculation_status='Approved', verified_by=$1, verified_at=NOW()
       WHERE month=$2 AND year=$3 AND calculation_status='Calculated'`,
      [req.admin.name, month, year]
    );
    res.json({ success: true, message: `${r.rowCount} employees ka salary approved` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/salary/approve ───────────────────────────────
router.delete('/approve', adminAuth, async (req, res) => {
  const { emp_id, month, year } = req.body;
  try {
    await db.query(
      `UPDATE salary SET calculation_status='Calculated', verified_by=NULL, verified_at=NULL
       WHERE emp_id=$1 AND month=$2 AND year=$3`,
      [emp_id, month, year]
    );
    res.json({ success: true, message: 'Salary unlocked' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/adjust ──────────────────────────────────
router.post('/adjust', adminAuth, async (req, res) => {
  const { month, year, emp_id, other_deduction, manual_addition, remark } = req.body;
  try {
    await db.query(
      `UPDATE salary SET
         other_deduction=$1, manual_addition=$2,
         net_salary = GREATEST(0, gross_salary - late_fine - $1 + $2),
         remark=$3
       WHERE month=$4 AND year=$5 AND emp_id=$6`,
      [parseFloat(other_deduction) || 0, parseFloat(manual_addition) || 0,
       remark || null, month, year, emp_id]
    );
    res.json({ success: true, message: 'Salary adjusted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/salary/slip/:emp_id ─────────────────────────────
router.get('/slip/:emp_id', adminAuth, async (req, res) => {
  const { emp_id } = req.params;
  const month = parseInt(req.query.month) || istMonth();
  const year  = parseInt(req.query.year)  || istYear();
  try {
    await ensureSalaryPolicyColumns();
    const [salRow, empRow, cfg] = await Promise.all([
      db.query(`SELECT * FROM salary WHERE emp_id=$1 AND month=$2 AND year=$3`, [emp_id, month, year]),
      db.query(`SELECT emp_id, name, formal_name, designation, date_of_joining FROM emplist WHERE emp_id=$1`, [emp_id]),
      getSettings()
    ]);
    if (!salRow.rows.length) return res.status(404).json({ success: false, message: 'Salary record not found for this month' });
    res.json({ success: true, slip: salRow.rows[0], employee: empRow.rows[0], hr_name: cfg.HR_SIGNATORY_NAME || '' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/salary/my-salary (employee) ────────────────────
router.get('/my-salary', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    await ensureSalaryPolicyColumns();
    const r = await db.query(
      `SELECT month, year, monthly_salary, present_days, half_days, leave_days, absent_days,
              paid_leave_days, unpaid_leave_days, sandwich_days, holiday_days,
              late_count, total_late_minutes, chargeable_late_minutes, payable_days, gross_salary, late_fine,
              other_deduction, manual_addition, net_salary, calculation_status, verified_at
       FROM salary WHERE emp_id=$1 ORDER BY year DESC, month DESC LIMIT 12`,
      [emp_id]
    );
    res.json({ success: true, salary: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/salary/my-slip?month=&year= (employee's own slip) ──
router.get('/my-slip', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  const month = parseInt(req.query.month) || istMonth();
  const year  = parseInt(req.query.year)  || istYear();
  try {
    await ensureSalaryPolicyColumns();
    const [salRow, empRow, cfg] = await Promise.all([
      db.query(`SELECT * FROM salary WHERE emp_id=$1 AND month=$2 AND year=$3`, [emp_id, month, year]),
      db.query(`SELECT emp_id, name, formal_name, designation, date_of_joining FROM emplist WHERE emp_id=$1`, [emp_id]),
      getSettings()
    ]);
    if (!salRow.rows.length) return res.status(404).json({ success: false, message: 'Is mahine ka salary record abhi nahi hai' });
    res.json({ success: true, slip: salRow.rows[0], employee: empRow.rows[0], hr_name: cfg.HR_SIGNATORY_NAME || '' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
