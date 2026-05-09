const express = require('express');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// Helper: working days in a month (Mon-Sat, excluding holidays)
async function getWorkingDays(month, year) {
  const daysInMonth = new Date(year, month, 0).getDate();
  let working = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month - 1, d).getDay();
    if (day !== 0) working++; // exclude Sunday
  }
  const hols = await db.query(
    `SELECT COUNT(*) FROM holidays
     WHERE EXTRACT(MONTH FROM holiday_date)=$1 AND EXTRACT(YEAR FROM holiday_date)=$2`,
    [month, year]
  );
  return Math.max(1, working - parseInt(hols.rows[0].count));
}

// ── GET /api/salary/structure  ───────────────────────────────
router.get('/structure', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.*, e.designation FROM salary_structure s
       JOIN emplist e ON e.emp_id=s.emp_id
       ORDER BY s.employee_name`
    );
    // Employees without structure
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

// ── POST /api/salary/structure  (add/update) ─────────────────
router.post('/structure', adminAuth, async (req, res) => {
  const {
    emp_id, monthly_salary, half_day_rule,
    late_fine_per_mark, late_fine_per_minute, grace_allowed
  } = req.body;

  if (!emp_id || !monthly_salary)
    return res.status(400).json({ success: false, message: 'emp_id and monthly_salary required' });

  try {
    const emp = await db.query(`SELECT name, formal_name FROM emplist WHERE emp_id=$1`, [emp_id]);
    if (!emp.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });

    const { name, formal_name } = emp.rows[0];
    const perDay = (parseFloat(monthly_salary) / 30).toFixed(2);

    await db.query(
      `INSERT INTO salary_structure
         (emp_id, employee_name, formal_name, monthly_salary, per_day_salary,
          half_day_rule, late_fine_per_mark, late_fine_per_minute, grace_allowed, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Yes',NOW())
       ON CONFLICT (emp_id) DO UPDATE SET
         monthly_salary=$4, per_day_salary=$5, half_day_rule=$6,
         late_fine_per_mark=$7, late_fine_per_minute=$8,
         grace_allowed=$9, active='Yes', updated_at=NOW()`,
      [emp_id, name, formal_name || name, monthly_salary, perDay,
       half_day_rule || 'Half Day = 0.5', late_fine_per_mark || 0,
       late_fine_per_minute || 0, grace_allowed || 0]
    );
    res.json({ success: true, message: 'Salary structure saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/calculate  (admin calculates month salary) ─
// Method: Google App Script se liya hua
//   Per Day  = monthly_salary / 30
//   Units    : Present/Pending=1, Half Day/Short Day=0.5, Leave=1, Absent=0
//   Holiday chain credit: consecutive non-worked holidays adjacent to a worked day = 1 unit each
//   Normalization: agar koi absent nahi toh total = 30; otherwise min(rawUnits, 30)
//   Gross    = (monthly_salary / 30) × normalizedUnits   (no deductions)
router.post('/calculate', adminAuth, async (req, res) => {
  const { month, year, emp_id } = req.body;
  if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });

  const m = parseInt(month), y = parseInt(year);
  const daysInMonth = new Date(y, m, 0).getDate();

  try {
    // Holidays for this month (declared + Sundays handled inline)
    const holRes = await db.query(
      `SELECT EXTRACT(DAY FROM holiday_date)::int AS d FROM holidays
       WHERE EXTRACT(MONTH FROM holiday_date)=$1 AND EXTRACT(YEAR FROM holiday_date)=$2`,
      [m, y]
    );
    const declaredHolidays = new Set(holRes.rows.map(r => r.d));

    function isDayHoliday(d) {
      const dow = new Date(y, m - 1, d).getDay();
      return dow === 0 || declaredHolidays.has(d); // 0 = Sunday
    }

    // Employees to calculate
    const empQuery = emp_id
      ? `SELECT s.*, e.status FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id WHERE s.emp_id=$1 AND s.active='Yes'`
      : `SELECT s.*, e.status FROM salary_structure s JOIN emplist e ON e.emp_id=s.emp_id WHERE s.active='Yes' AND e.status='Active'`;
    const structs = await db.query(empQuery, emp_id ? [emp_id] : []);

    const results = [];

    for (const s of structs.rows) {
      // Full month attendance records (date-level)
      const att = await db.query(
        `SELECT date, final_status FROM daily_attendance WHERE emp_id=$1 AND month=$2 AND year=$3`,
        [s.emp_id, m, y]
      );

      // day-of-month → final_status
      const dayMap = {};
      att.rows.forEach(r => {
        const d = new Date(r.date).getDate();
        dayMap[d] = r.final_status;
      });

      // unit value per status
      function statusUnit(status) {
        if (!status) return null;
        if (status === 'Present' || status === 'Pending') return 1;
        if (status === 'Half Day' || status === 'Short Day') return 0.5;
        if (status === 'Leave') return 1;
        return 0; // Absent or unknown
      }

      // presenceFlag: true if employee had attendance/leave (not absent/null) that day
      const presenceFlag = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const st = dayMap[d];
        presenceFlag[d] = st !== undefined && st !== 'Absent';
      }

      let rawUnits = 0;
      let presentDays = 0, halfDays = 0, leaveDays = 0, absentDays = 0, holidayCredited = 0;

      // First pass: worked days (including holiday working = double credit)
      for (let d = 1; d <= daysInMonth; d++) {
        const st = dayMap[d];
        const isHol = isDayHoliday(d);

        if (presenceFlag[d]) {
          const unit = statusUnit(st);
          rawUnits += isHol ? Math.min(2, unit * 2) : unit;
          if (st === 'Present' || st === 'Pending') presentDays++;
          else if (st === 'Half Day' || st === 'Short Day') halfDays++;
          else if (st === 'Leave') leaveDays++;
        } else if (!isHol) {
          // Non-holiday with no presence = absent
          if (st === 'Absent' || st === undefined) absentDays++;
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
            rawUnits += (chainEnd - chainStart + 1);
            holidayCredited += (chainEnd - chainStart + 1);
          }
        } else {
          d++;
        }
      }

      // Normalize to 30-day rule
      const normalizedUnits = absentDays === 0 ? 30 : Math.min(rawUnits, 30);

      const perDay      = parseFloat(s.monthly_salary) / 30;
      const grossSalary = Math.round(perDay * normalizedUnits * 100) / 100;
      const netSalary   = grossSalary; // no deductions per App Script method

      await db.query(
        `INSERT INTO salary
           (month, year, emp_id, employee_name, formal_name, monthly_salary,
            present_days, half_days, absent_days, leave_days, holiday_days,
            late_count, total_late_minutes, grace_used, payable_days,
            gross_salary, late_fine, other_deduction, manual_addition,
            net_salary, calculation_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,0,$12,$13,0,0,0,$14,'Calculated')
         ON CONFLICT (month, year, emp_id) DO UPDATE SET
           present_days=$7, half_days=$8, absent_days=$9, leave_days=$10, holiday_days=$11,
           late_count=0, total_late_minutes=0, grace_used=0,
           payable_days=$12, gross_salary=$13, late_fine=0, net_salary=$14,
           calculation_status='Calculated'`,
        [m, y, s.emp_id, s.employee_name, s.formal_name, s.monthly_salary,
         presentDays, halfDays, absentDays, leaveDays, holidayCredited,
         normalizedUnits, grossSalary, netSalary]
      ).catch(() => {
        db.query(
          `INSERT INTO salary
             (month, year, emp_id, employee_name, formal_name, monthly_salary,
              present_days, half_days, absent_days, leave_days, holiday_days,
              late_count, total_late_minutes, grace_used, payable_days,
              gross_salary, late_fine, other_deduction, manual_addition,
              net_salary, calculation_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,0,0,$12,$13,0,0,0,$14,'Calculated')`,
          [m, y, s.emp_id, s.employee_name, s.formal_name, s.monthly_salary,
           presentDays, halfDays, absentDays, leaveDays, holidayCredited,
           normalizedUnits, grossSalary, netSalary]
        );
      });

      results.push({
        emp_id: s.emp_id, employee_name: s.employee_name,
        present_days: presentDays, half_days: halfDays,
        leave_days: leaveDays, absent_days: absentDays,
        holiday_credited: holidayCredited,
        payable_units: normalizedUnits,
        per_day: Math.round(perDay * 100) / 100,
        gross_salary: grossSalary, net_salary: netSalary
      });
    }

    res.json({ success: true, message: `Salary calculated for ${results.length} employees`, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// ── GET /api/salary/records?month=&year= ─────────────────────
router.get('/records', adminAuth, async (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year  = parseInt(req.query.year)  || new Date().getFullYear();
  try {
    const r = await db.query(
      `SELECT s.*, e.designation FROM salary s
       LEFT JOIN emplist e ON e.emp_id=s.emp_id
       WHERE s.month=$1 AND s.year=$2
       ORDER BY s.employee_name`,
      [month, year]
    );
    const totals = r.rows.reduce((acc, row) => ({
      gross: acc.gross + (parseFloat(row.gross_salary) || 0),
      deductions: acc.deductions + (parseFloat(row.late_fine) || 0),
      net: acc.net + (parseFloat(row.net_salary) || 0)
    }), { gross: 0, deductions: 0, net: 0 });

    res.json({ success: true, month, year, records: r.rows, totals });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/adjust  (manual deduction/addition) ─────
router.post('/adjust', adminAuth, async (req, res) => {
  const { month, year, emp_id, other_deduction, manual_addition, remark } = req.body;
  try {
    await db.query(
      `UPDATE salary SET
         other_deduction=COALESCE($1, other_deduction),
         manual_addition=COALESCE($2, manual_addition),
         net_salary = gross_salary - late_fine - COALESCE($1, other_deduction) + COALESCE($2, manual_addition),
         remark=$3
       WHERE month=$4 AND year=$5 AND emp_id=$6`,
      [other_deduction || null, manual_addition || null, remark || null, month, year, emp_id]
    );
    res.json({ success: true, message: 'Salary adjusted' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/salary/my-salary  (employee) ────────────────────
router.get('/my-salary', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    const r = await db.query(
      `SELECT month, year, monthly_salary, present_days, leave_days,
              payable_days, gross_salary, late_fine, other_deduction,
              manual_addition, net_salary, calculation_status
       FROM salary WHERE emp_id=$1 ORDER BY year DESC, month DESC LIMIT 12`,
      [emp_id]
    );
    res.json({ success: true, salary: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
