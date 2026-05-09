const express = require('express');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const authMiddleware = require('../middleware/auth');
const XLSX = require('xlsx');

const router = express.Router();

const MONTHS = ['','January','February','March','April','May','June','July','August','September','October','November','December'];

async function getSettings() {
  const r = await db.query('SELECT key, value FROM attendance_settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  return s;
}

async function ensureIncrementColumns() {
  await db.query(`ALTER TABLE salary_structure ADD COLUMN IF NOT EXISTS increment_effective_date DATE`);
  await db.query(`ALTER TABLE salary_structure ADD COLUMN IF NOT EXISTS new_monthly_salary NUMERIC(10,2)`);
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
       ON CONFLICT (emp_id) DO UPDATE SET
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

    const holRes = await db.query(
      `SELECT EXTRACT(DAY FROM holiday_date)::int AS d FROM holidays
       WHERE EXTRACT(MONTH FROM holiday_date)=$1 AND EXTRACT(YEAR FROM holiday_date)=$2`,
      [m, y]
    );
    const declaredHolidays = new Set(holRes.rows.map(r => r.d));
    const isDayHoliday = d => new Date(y, m - 1, d).getDay() === 0 || declaredHolidays.has(d);

    const empQuery = emp_id
      ? `SELECT s.*, e.status FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id WHERE s.emp_id=$1 AND s.active='Yes'`
      : `SELECT s.*, e.status FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id WHERE s.active='Yes' AND e.status='Active'`;
    const structs = await db.query(empQuery, emp_id ? [emp_id] : []);

    const results = [];

    for (const s of structs.rows) {
      const att = await db.query(
        `SELECT date, final_status, late_minutes, grace_minutes_granted
         FROM daily_attendance WHERE emp_id=$1 AND month=$2 AND year=$3`,
        [s.emp_id, m, y]
      );

      const dayMap = {};
      att.rows.forEach(r => {
        const d = new Date(r.date).getDate();
        dayMap[d] = {
          status: r.final_status,
          late_minutes: parseInt(r.late_minutes) || 0,
          grace: parseInt(r.grace_minutes_granted) || 0
        };
      });

      const statusUnit = st => {
        if (!st) return null;
        if (st === 'Present' || st === 'Pending') return 1;
        if (st === 'Half Day' || st === 'Short Day') return 0.5;
        if (st === 'Leave') return 1;
        return 0;
      };

      const presenceFlag = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const st = dayMap[d]?.status;
        presenceFlag[d] = st !== undefined && st !== 'Absent';
      }

      // Mid-month increment: split at incDay
      let incDay = 0;
      const incDate = s.increment_effective_date ? new Date(s.increment_effective_date) : null;
      if (incDate && incDate.getFullYear() === y && (incDate.getMonth() + 1) === m)
        incDay = incDate.getDate();

      const salaryOld = parseFloat(s.monthly_salary);
      const salaryNew = (incDay > 0 && s.new_monthly_salary) ? parseFloat(s.new_monthly_salary) : salaryOld;
      const perDayOld = salaryOld / 30;
      const perDayNew = salaryNew / 30;

      let unitsOld = 0, unitsNew = 0;
      let presentDays = 0, halfDays = 0, leaveDays = 0, absentDays = 0, holidayCredited = 0;
      let lateCount = 0, totalLateMins = 0;

      // First pass: worked days
      for (let d = 1; d <= daysInMonth; d++) {
        const entry = dayMap[d];
        const st = entry?.status;
        const isHol = isDayHoliday(d);
        const isOld = incDay === 0 || d < incDay;

        if (presenceFlag[d]) {
          const unit = statusUnit(st);
          const actualUnit = isHol ? Math.min(2, unit * 2) : unit;
          if (isOld) unitsOld += actualUnit; else unitsNew += actualUnit;
          if (st === 'Present' || st === 'Pending') presentDays++;
          else if (st === 'Half Day' || st === 'Short Day') halfDays++;
          else if (st === 'Leave') leaveDays++;
          if (entry && entry.late_minutes > 0) { lateCount++; totalLateMins += entry.late_minutes; }
        } else if (!isHol) {
          absentDays++;
        }
      }

      // Second pass: holiday chain credit
      let d = 1;
      while (d <= daysInMonth) {
        if (isDayHoliday(d) && !presenceFlag[d]) {
          const chainStart = d;
          while (d <= daysInMonth && isDayHoliday(d) && !presenceFlag[d]) d++;
          const chainEnd = d - 1;
          const prevWorked = chainStart > 1 && presenceFlag[chainStart - 1];
          const nextWorked = chainEnd < daysInMonth && presenceFlag[chainEnd + 1];
          if (prevWorked || nextWorked) {
            for (let cd = chainStart; cd <= chainEnd; cd++) {
              const isOld = incDay === 0 || cd < incDay;
              if (isOld) unitsOld += 1; else unitsNew += 1;
              holidayCredited++;
            }
          }
        } else { d++; }
      }

      // Normalize to 30-day rule
      let normOld, normNew;
      const totalRaw = unitsOld + unitsNew;
      if (absentDays === 0) {
        if (incDay === 0) { normOld = 30; normNew = 0; }
        else {
          const shareOld = (incDay - 1) / daysInMonth;
          normOld = 30 * shareOld;
          normNew = 30 * (1 - shareOld);
        }
      } else {
        const capped = Math.min(totalRaw, 30);
        if (totalRaw === 0) { normOld = 0; normNew = 0; }
        else { normOld = unitsOld * (capped / totalRaw); normNew = unitsNew * (capped / totalRaw); }
      }

      const grossSalary = Math.round((perDayOld * normOld + perDayNew * normNew) * 100) / 100;
      const lateFine = Math.round(
        (parseFloat(s.late_fine_per_mark) || 0) * lateCount +
        (parseFloat(s.late_fine_per_minute) || 0) * totalLateMins
      );
      const payableUnits = Math.round((normOld + normNew) * 100) / 100;

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
            net_salary, calculation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,0,0,$17,'Calculated')
         ON CONFLICT (month, year, emp_id) DO UPDATE SET
           present_days=$7, half_days=$8, absent_days=$9, leave_days=$10, holiday_days=$11,
           late_count=$12, total_late_minutes=$13, payable_days=$14,
           gross_salary=$15, late_fine=$16, net_salary=$17, calculation_status='Calculated'`,
        [m, y, s.emp_id, s.employee_name, s.formal_name, incDay > 0 ? salaryNew : salaryOld,
         presentDays, halfDays, absentDays, leaveDays, holidayCredited,
         lateCount, totalLateMins, payableUnits, grossSalary, lateFine, netSalary]
      ).catch(() => {
        db.query(
          `INSERT INTO salary
             (month, year, emp_id, employee_name, formal_name, monthly_salary,
              present_days, half_days, absent_days, leave_days, holiday_days,
              late_count, total_late_minutes, grace_used, payable_days,
              gross_salary, late_fine, other_deduction, manual_addition,
              net_salary, calculation_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,$14,$15,$16,0,0,$17,'Calculated')`,
          [m, y, s.emp_id, s.employee_name, s.formal_name, incDay > 0 ? salaryNew : salaryOld,
           presentDays, halfDays, absentDays, leaveDays, holidayCredited,
           lateCount, totalLateMins, payableUnits, grossSalary, lateFine, netSalary]
        );
      });

      results.push({
        emp_id: s.emp_id, employee_name: s.employee_name,
        present_days: presentDays, half_days: halfDays,
        leave_days: leaveDays, absent_days: absentDays,
        holiday_credited: holidayCredited,
        late_count: lateCount, total_late_minutes: totalLateMins,
        payable_units: payableUnits,
        per_day_old: Math.round(perDayOld * 100) / 100,
        per_day_new: incDay > 0 ? Math.round(perDayNew * 100) / 100 : null,
        increment_from_day: incDay || null,
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
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
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
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  try {
    const r = await db.query(
      `SELECT s.emp_id, s.employee_name, s.monthly_salary,
              s.present_days, s.half_days, s.leave_days, s.absent_days, s.holiday_days,
              s.late_count, s.total_late_minutes, s.payable_days,
              s.gross_salary, s.late_fine, s.other_deduction, s.manual_addition, s.net_salary,
              s.calculation_status, s.verified_by, s.remark
       FROM salary s WHERE s.month=$1 AND s.year=$2 ORDER BY s.employee_name`,
      [month, year]
    );
    const wb = XLSX.utils.book_new();
    const headers = ['Emp ID','Employee Name','Basic Salary','Present','Half Day','Leave','Absent','Holiday+','Late Count','Late Mins','Payable Units','Gross','Late Fine','Other Deduction','Bonus','Net Salary','Status','Approved By','Remark'];
    const rows = r.rows.map(row => [
      row.emp_id, row.employee_name, row.monthly_salary,
      row.present_days, row.half_days, row.leave_days, row.absent_days, row.holiday_days,
      row.late_count, row.total_late_minutes, row.payable_days,
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
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  try {
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
    const r = await db.query(
      `SELECT month, year, monthly_salary, present_days, half_days, leave_days, absent_days,
              holiday_days, late_count, payable_days, gross_salary, late_fine,
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
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  try {
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
