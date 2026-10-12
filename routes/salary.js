const express = require('express');
const db = require('../db');
const adminAuth = require('../middleware/adminAuth');
const authMiddleware = require('../middleware/auth');
const XLSX = require('xlsx');
const {
  istMonth, istYear, istDateStr, MONTHS,
  getSettings, ensureIncrementColumns, ensureSalaryPolicyColumns, calculateSalary,
} = require('../services/salaryService');

const router = express.Router();

// A month can only be approved (locked) once it has ended, so a half-finished month
// is never frozen with future days still unaccounted for.
function monthHasEnded(month, year) {
  const last = new Date(year, month, 0).getDate();
  const lastDay = year + '-' + String(month).padStart(2, '0') + '-' + String(last).padStart(2, '0');
  return istDateStr() >= lastDay;
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
  const attendanceExempt = req.body.attendance_exempt === true || req.body.attendance_exempt === 'true' || req.body.attendance_exempt === 1;
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
          increment_effective_date, new_monthly_salary, attendance_exempt, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,'Half Day = 0.5',$6,$7,$8,$9,$10,$11,'Yes',NOW())
       ON CONFLICT (organization_id, emp_id) DO UPDATE SET
         monthly_salary=$4, per_day_salary=$5,
         late_fine_per_mark=$6, late_fine_per_minute=$7, grace_allowed=$8,
         increment_effective_date=$9, new_monthly_salary=$10, attendance_exempt=$11,
         active='Yes', updated_at=NOW()`,
      [emp_id, name, formal_name || name, monthly_salary, perDay,
       late_fine_per_mark || 0, late_fine_per_minute || 0, grace_allowed || 0,
       increment_effective_date || null, new_monthly_salary || null, attendanceExempt]
    );
    res.json({ success: true, message: 'Salary structure saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/salary/calculate ───────────────────────────────
// The calculation itself lives in services/salaryService.js (also used to refresh a
// salary automatically when attendance is corrected).
router.post('/calculate', adminAuth, async (req, res) => {
  const { month, year, emp_id } = req.body;
  if (!month || !year) return res.status(400).json({ success: false, message: 'month and year required' });
  try {
    const { results, hints, month_in_progress } = await calculateSalary({ month, year, empId: emp_id || null });
    res.json({
      success: true,
      message: `Salary calculated for ${results.filter(r => !r.skipped).length} employees`,
      results, hints, month_in_progress,
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ success: false, message: 'Server error: ' + err.message });
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
              s.not_employed_days, s.holiday_work_days, s.extra_pay_days,
              s.late_count, s.total_late_minutes, s.grace_used, s.chargeable_late_minutes, s.payable_days,
              s.salary_day_basis, s.per_day_salary,
              s.gross_salary, s.late_fine, s.other_deduction, s.manual_addition, s.net_salary,
              s.calculation_status, s.verified_by, s.remark
       FROM salary s WHERE s.month=$1 AND s.year=$2 ORDER BY s.employee_name`,
      [month, year]
    );
    const wb = XLSX.utils.book_new();
    const headers = ['Emp ID','Employee Name','Basic Salary','Present','Half Day','Leave','Paid Leave','Unpaid Leave','Absent','Sandwich','LOP','Not Employed','Holiday Worked','Extra Pay Days','Holiday+','Late Count','Late Mins','Grace Used','Chargeable Late Mins','Payable Units','Salary Basis','Per Day','Gross','Late Fine','Other Deduction','Bonus','Net Salary','Status','Approved By','Remark'];
    const rows = r.rows.map(row => [
      row.emp_id, row.employee_name, row.monthly_salary,
      row.present_days, row.half_days, row.leave_days, row.paid_leave_days, row.unpaid_leave_days,
      row.absent_days, row.sandwich_days, row.lop_days, row.not_employed_days, row.holiday_work_days, row.extra_pay_days, row.holiday_days,
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
  if (!monthHasEnded(parseInt(month, 10), parseInt(year, 10))) {
    return res.status(400).json({ success: false, message: 'This month has not ended yet. Calculate again after the last day of the month, then approve.' });
  }
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
  if (!monthHasEnded(parseInt(month, 10), parseInt(year, 10))) {
    return res.status(400).json({ success: false, message: 'This month has not ended yet. Calculate again after the last day of the month, then approve.' });
  }
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
