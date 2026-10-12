const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { loginCandidate } = require('../services/authService');
const { setRefreshCookie } = require('../services/sessionService');
const svc = require('../services/passkeyService');

const router = express.Router();

function fail(res, err, tag) {
  if (err instanceof svc.PasskeyError) {
    return res.status(err.status).json({ success: false, message: err.message, code: err.code });
  }
  console.error(`[passkeys ${tag}]`, err);
  return res.status(500).json({ success: false, message: 'Server error' });
}

// Passkeys belong to employees (the people who punch attendance).
function employeeOnly(req, res, next) {
  if (req.user.user_type === 'admin') {
    return res.status(403).json({ success: false, message: 'Fingerprint login is for employee accounts.' });
  }
  req.emp = { organizationId: req.user.organization_id, empId: req.user.emp_id, name: req.user.formal_name || req.user.name };
  next();
}

// ═══ Employee (signed in) ═══════════════════════════════════════════════════

// GET /api/passkeys/status
router.get('/status', authMiddleware, employeeOnly, async (req, res) => {
  try {
    const [policy, keys] = await Promise.all([svc.getPolicy(req.emp.organizationId), svc.activePasskeys(req.emp.organizationId, req.emp.empId)]);
    res.json({
      success: true,
      policy,
      max_devices: svc.MAX_DEVICES,
      passkeys: keys.map(k => ({ id: k.id, label: k.device_label, created_at: k.created_at, last_used_at: k.last_used_at })),
    });
  } catch (err) { fail(res, err, 'status'); }
});

// POST /api/passkeys/register/options
router.post('/register/options', authMiddleware, employeeOnly, async (req, res) => {
  try {
    res.json({ success: true, ...(await svc.registrationOptions(req, req.emp)) });
  } catch (err) { fail(res, err, 'register-options'); }
});

// POST /api/passkeys/register/verify  { token, response, label }
router.post('/register/verify', authMiddleware, employeeOnly, async (req, res) => {
  try {
    const r = await svc.verifyRegistration(req, req.emp, req.body || {});
    res.json({ success: true, message: 'Fingerprint enabled on this device.', label: r.label });
  } catch (err) { fail(res, err, 'register-verify'); }
});

// POST /api/passkeys/punch/options — prefetched by the dashboard so the tap is instant
router.post('/punch/options', authMiddleware, employeeOnly, async (req, res) => {
  try {
    if ((await svc.getPolicy(req.emp.organizationId)) === 'off') return res.status(403).json({ success: false, message: 'Not enabled.' });
    res.json({ success: true, ...(await svc.punchOptions(req, req.emp)) });
  } catch (err) { fail(res, err, 'punch-options'); }
});

// DELETE /api/passkeys/:id — remove one of my own devices
router.delete('/:id', authMiddleware, employeeOnly, async (req, res) => {
  try {
    const n = await svc.revoke({ organizationId: req.emp.organizationId, empId: req.emp.empId, passkeyId: parseInt(req.params.id, 10), by: req.emp.empId });
    if (!n) return res.status(404).json({ success: false, message: 'Device not found.' });
    res.json({ success: true, message: 'Device removed.' });
  } catch (err) { fail(res, err, 'remove'); }
});

// ═══ Public: sign in with fingerprint ═══════════════════════════════════════

// POST /api/passkeys/login/options
router.post('/login/options', async (req, res) => {
  try {
    res.json({ success: true, ...(await svc.loginOptions(req)) });
  } catch (err) { fail(res, err, 'login-options'); }
});

// POST /api/passkeys/login/verify  { token, response }
router.post('/login/verify', async (req, res) => {
  try {
    const { token, response } = req.body || {};
    const cred = await svc.verifyAssertion(req, { token, purpose: 'login', response });
    if ((await svc.getPolicy(cred.organization_id)) === 'off') {
      return res.status(403).json({ success: false, message: 'Fingerprint login is not enabled for your organisation. Please use your password.' });
    }
    const row = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT 'employee:' || e.id AS account_key, 'employee' AS user_type, e.id, e.emp_id,
              e.name, e.formal_name, COALESCE(e.formal_name, e.name) AS display_name,
              e.email_id, e.mobile_no, e.designation AS role, e.status AS employee_status,
              o.id AS organization_id, o.org_code AS organization_code, o.office_name AS organization_name,
              o.status AS org_status, o.valid_until, o.force_read_only
         FROM emplist e JOIN organizations o ON o.id = e.organization_id
        WHERE e.emp_id=$1 AND e.organization_id=$2`,
      [cred.emp_id, cred.organization_id]
    ));
    const candidate = row.rows[0];
    if (!candidate || candidate.employee_status !== 'Active' || candidate.org_status !== 'Active') {
      return res.status(403).json({ success: false, message: 'This account is not active.' });
    }
    const out = await loginCandidate(candidate, req);
    setRefreshCookie(res, out.refresh_token);
    res.json({
      success: true,
      token: out.token,
      user: out.user,
      employee: {
        emp_id: out.user.emp_id, name: out.user.name, formal_name: out.user.formal_name,
        designation: out.user.designation, organization_code: out.user.organization_code,
        organization_name: out.user.organization_name, read_only: out.user.read_only,
      },
    });
  } catch (err) { fail(res, err, 'login-verify'); }
});

// ═══ Admin ══════════════════════════════════════════════════════════════════

// GET /api/passkeys/admin/overview
router.get('/admin/overview', adminAuth, async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const policy = await svc.getPolicy(orgId);
    const r = await db.query(
      `SELECT e.emp_id, e.name, e.formal_name, e.designation,
              COUNT(p.id) FILTER (WHERE p.revoked_at IS NULL)::int AS devices,
              MAX(p.last_used_at) AS last_used_at,
              STRING_AGG(p.device_label, ', ') FILTER (WHERE p.revoked_at IS NULL) AS labels
         FROM emplist e
         LEFT JOIN employee_passkeys p ON p.emp_id = e.emp_id AND p.organization_id = e.organization_id
        WHERE e.status='Active'
        GROUP BY e.emp_id, e.name, e.formal_name, e.designation
        ORDER BY e.emp_id`
    );
    res.json({ success: true, policy, employees: r.rows });
  } catch (err) { fail(res, err, 'admin-overview'); }
});

// POST /api/passkeys/admin/policy  { policy: 'off' | 'optional' | 'enforced' }
router.post('/admin/policy', adminAuth, async (req, res) => {
  const policy = String(req.body.policy || '').toLowerCase();
  if (!svc.POLICIES.includes(policy)) return res.status(400).json({ success: false, message: 'Invalid policy.' });
  try {
    await db.query(
      `INSERT INTO attendance_settings (key, value) VALUES ('PASSKEY_POLICY', $1)
       ON CONFLICT (organization_id, key) DO UPDATE SET value=$1`,
      [policy]
    );
    res.json({ success: true, message: 'Fingerprint setting updated.' });
  } catch (err) { fail(res, err, 'admin-policy'); }
});

// POST /api/passkeys/admin/revoke  { emp_id } — removes all of an employee's devices
router.post('/admin/revoke', adminAuth, async (req, res) => {
  try {
    const empId = String(req.body.emp_id || '').trim();
    if (!empId) return res.status(400).json({ success: false, message: 'Employee required.' });
    const n = await svc.revoke({ organizationId: req.user.organization_id, empId, by: req.user.name || req.user.emp_id || 'Admin' });
    res.json({ success: true, message: n ? `Removed ${n} device(s). The employee can enable fingerprint again after logging in with their password.` : 'No active devices found.' });
  } catch (err) { fail(res, err, 'admin-revoke'); }
});

module.exports = router;
