const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const superAdminAuth = require('../middleware/superAdminAuth');
const { hashForStorage } = require('../services/authService');
const { verifyPassword } = require('../utils/passwords');
const { sendEmail } = require('../utils/email');

const router = express.Router();

function setupToken() {
  return process.env.SUPER_ADMIN_SETUP_TOKEN || (process.env.NODE_ENV === 'production' ? '' : 'local-super-admin-setup');
}

function clean(value) {
  return String(value || '').trim();
}

function orgCodeFromName(name, id) {
  const base = clean(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'ORG';
  return `${base}-${String(id).padStart(3, '0')}`;
}

function addDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function sendApprovalEmail({ to, organizationName, orgCode, adminUsername, adminPassword, validUntil }) {
  if (!clean(to)) return { sent: false, reason: 'Admin email missing' };
  const loginUrl = 'https://geebharat.com/office.html';
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
      <h2>Gee Bharat Office Approved</h2>
      <p>Your organisation account has been approved.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:6px 12px;font-weight:700">Organisation</td><td style="padding:6px 12px">${organizationName}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:700">Organisation Code</td><td style="padding:6px 12px">${orgCode}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:700">Login ID</td><td style="padding:6px 12px">${adminUsername}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:700">Password</td><td style="padding:6px 12px">${adminPassword}</td></tr>
        <tr><td style="padding:6px 12px;font-weight:700">Valid Until</td><td style="padding:6px 12px">${validUntil || 'No expiry set'}</td></tr>
      </table>
      <p><a href="${loginUrl}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Login to Office Management</a></p>
      <p style="font-size:12px;color:#64748b">Website: ${loginUrl}</p>
    </div>`;
  await sendEmail({
    to,
    subject: 'Gee Bharat Office Account Approved',
    html,
    text: `Your Gee Bharat office account is approved.\nOrganisation: ${organizationName}\nOrganisation Code: ${orgCode}\nLogin ID: ${adminUsername}\nPassword: ${adminPassword}\nValid Until: ${validUntil || 'No expiry set'}\nLogin: ${loginUrl}`,
  });
  return { sent: true };
}

router.get('/setup-info', async (req, res) => {
  const token = req.query.token;
  const existing = await db.query(`SELECT COUNT(*)::int AS count FROM super_admins`);
  res.json({
    success: true,
    setup_available: existing.rows[0].count === 0 && token && token === setupToken(),
    has_super_admin: existing.rows[0].count > 0,
  });
});

router.post('/setup', async (req, res) => {
  const { token, username, password, name, email_id } = req.body;
  if (!token || token !== setupToken()) {
    return res.status(403).json({ success: false, message: 'Invalid setup token' });
  }
  if (!clean(username) || !clean(password) || !clean(name)) {
    return res.status(400).json({ success: false, message: 'Username, name and password required' });
  }

  try {
    const existing = await db.query(`SELECT COUNT(*)::int AS count FROM super_admins`);
    if (existing.rows[0].count > 0) {
      return res.status(400).json({ success: false, message: 'Super admin is already configured' });
    }
    await db.query(
      `INSERT INTO super_admins (username, password_hash, name, email_id)
       VALUES ($1,$2,$3,$4)`,
      [clean(username), await hashForStorage(password), clean(name), clean(email_id) || null]
    );
    res.json({ success: true, message: 'Super admin created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!clean(username) || !clean(password)) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }
  try {
    const found = await db.query(
      `SELECT id, username, password_hash, name, email_id, status FROM super_admins WHERE lower(username)=lower($1)`,
      [clean(username)]
    );
    const admin = found.rows[0];
    if (!admin || admin.status !== 'Active' || !(await verifyPassword(password, admin.password_hash))) {
      return res.status(401).json({ success: false, message: 'Incorrect username or password' });
    }
    await db.query(`UPDATE super_admins SET last_login_at=NOW() WHERE id=$1`, [admin.id]);
    const token = jwt.sign(
      { id: admin.id, username: admin.username, name: admin.name, user_type: 'super_admin' },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );
    res.json({ success: true, token, super_admin: { id: admin.id, username: admin.username, name: admin.name } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/overview', superAdminAuth, async (req, res) => {
  try {
    const [orgs, pending, readOnly, expiring7, expiring30, active] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count FROM organizations`),
      db.query(`SELECT COUNT(*)::int AS count FROM organization_signup_requests WHERE status='Pending'`),
      db.query(`SELECT COUNT(*)::int AS count FROM organizations WHERE force_read_only=true OR valid_until < CURRENT_DATE`),
      db.query(`SELECT COUNT(*)::int AS count FROM organizations WHERE status='Active' AND force_read_only=false AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`),
      db.query(`SELECT COUNT(*)::int AS count FROM organizations WHERE status='Active' AND force_read_only=false AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`),
      db.query(`SELECT COUNT(*)::int AS count FROM organizations WHERE status='Active'`),
    ]);
    res.json({
      success: true,
      stats: {
        organizations: orgs.rows[0].count,
        pending_requests: pending.rows[0].count,
        read_only_organizations: readOnly.rows[0].count,
        expiring_7_days: expiring7.rows[0].count,
        expiring_30_days: expiring30.rows[0].count,
        active_organizations: active.rows[0].count,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/organizations', superAdminAuth, async (req, res) => {
  try {
    const orgs = await db.query(
      `SELECT o.*,
              to_char(o.valid_from::date, 'YYYY-MM-DD') AS valid_from,
              to_char(o.valid_until::date, 'YYYY-MM-DD') AS valid_until,
              CASE
                WHEN o.force_read_only=true THEN 'Read Only'
                WHEN o.valid_until < CURRENT_DATE THEN 'Expired'
                WHEN o.valid_until <= CURRENT_DATE + INTERVAL '7 days' THEN 'Expiring Soon'
                WHEN o.valid_until <= CURRENT_DATE + INTERVAL '30 days' THEN 'Expiring This Month'
                ELSE 'Active'
              END AS subscription_state,
              GREATEST(0, (o.valid_until::date - CURRENT_DATE))::int AS days_left,
              COALESCE((SELECT access_level FROM organization_feature_access fa WHERE fa.organization_id=o.id AND fa.feature_key='billing'), 'none') AS billing_access,
              COALESCE((SELECT access_level FROM organization_feature_access fa WHERE fa.organization_id=o.id AND fa.feature_key='lead_management'), 'none') AS lead_management_access,
              COALESCE((SELECT access_level FROM organization_feature_access fa WHERE fa.organization_id=o.id AND fa.feature_key='client_conversation_log'), 'none') AS client_conversation_log_access,
              (SELECT COUNT(*)::int FROM emplist e WHERE e.organization_id=o.id) AS employees,
              (SELECT COUNT(*)::int FROM clients c WHERE c.organization_id=o.id) AS clients,
              (SELECT COUNT(*)::int FROM tasks t WHERE t.organization_id=o.id) AS tasks
       FROM organizations o
       ORDER BY o.created_at DESC, o.id DESC`
    );
    res.json({ success: true, organizations: orgs.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/organizations/:id/features', superAdminAuth, async (req, res) => {
  try {
    const org = await db.query(`SELECT id, org_code, office_name FROM organizations WHERE id=$1`, [req.params.id]);
    if (!org.rows.length) return res.status(404).json({ success: false, message: 'Organisation not found' });
    const features = await db.query(
      `SELECT feature_key, access_level, updated_at
         FROM organization_feature_access
        WHERE organization_id=$1
        ORDER BY feature_key`,
      [req.params.id]
    );
    res.json({ success: true, organization: org.rows[0], features: features.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Feature access load failed' });
  }
});

router.put('/organizations/:id/features/billing', superAdminAuth, async (req, res) => {
  const accessLevel = clean(req.body.access_level).toLowerCase();
  if (!['none', 'view', 'full'].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: 'Billing access must be none, view or full' });
  }
  try {
    const org = await db.query(`SELECT id FROM organizations WHERE id=$1`, [req.params.id]);
    if (!org.rows.length) return res.status(404).json({ success: false, message: 'Organisation not found' });
    const feature = await db.query(
      `INSERT INTO organization_feature_access
        (organization_id, feature_key, access_level, updated_by)
       VALUES ($1,'billing',$2,$3)
       ON CONFLICT (organization_id, feature_key)
       DO UPDATE SET access_level=EXCLUDED.access_level, updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING *`,
      [req.params.id, accessLevel, req.superAdmin.id]
    );
    res.json({ success: true, message: 'Billing access updated', feature: feature.rows[0] });
  } catch (err) {
    console.error('[super-admin billing access]', err);
    res.status(500).json({ success: false, message: 'Billing access update failed' });
  }
});

router.put('/organizations/:id/features/lead-management', superAdminAuth, async (req, res) => {
  const accessLevel = clean(req.body.access_level).toLowerCase();
  if (!['none', 'view', 'full'].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: 'Lead Management access must be none, view or full' });
  }
  try {
    const org = await db.query(`SELECT id FROM organizations WHERE id=$1`, [req.params.id]);
    if (!org.rows.length) return res.status(404).json({ success: false, message: 'Organisation not found' });
    const feature = await db.query(
      `INSERT INTO organization_feature_access
        (organization_id, feature_key, access_level, updated_by)
       VALUES ($1,'lead_management',$2,$3)
       ON CONFLICT (organization_id, feature_key)
       DO UPDATE SET access_level=EXCLUDED.access_level, updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING *`,
      [req.params.id, accessLevel, req.superAdmin.id]
    );
    res.json({ success: true, message: 'Lead Management access updated', feature: feature.rows[0] });
  } catch (err) {
    console.error('[super-admin lead management access]', err);
    res.status(500).json({ success: false, message: 'Lead Management access update failed' });
  }
});

router.put('/organizations/:id/features/client-conversation-log', superAdminAuth, async (req, res) => {
  const accessLevel = clean(req.body.access_level).toLowerCase();
  if (!['none', 'view', 'full'].includes(accessLevel)) {
    return res.status(400).json({ success: false, message: 'Client Update Log access must be none, view or full' });
  }
  try {
    const org = await db.query(`SELECT id FROM organizations WHERE id=$1`, [req.params.id]);
    if (!org.rows.length) return res.status(404).json({ success: false, message: 'Organisation not found' });
    const feature = await db.query(
      `INSERT INTO organization_feature_access
        (organization_id, feature_key, access_level, updated_by)
       VALUES ($1,'client_conversation_log',$2,$3)
       ON CONFLICT (organization_id, feature_key)
       DO UPDATE SET access_level=EXCLUDED.access_level, updated_by=EXCLUDED.updated_by, updated_at=NOW()
       RETURNING *`,
      [req.params.id, accessLevel, req.superAdmin.id]
    );
    res.json({ success: true, message: 'Client Update Log access updated', feature: feature.rows[0] });
  } catch (err) {
    console.error('[super-admin client conversation log access]', err);
    res.status(500).json({ success: false, message: 'Client Update Log access update failed' });
  }
});

router.get('/signup-requests', superAdminAuth, async (req, res) => {
  const status = req.query.status || '';
  try {
    const params = [];
    const where = status ? 'WHERE status=$1' : '';
    if (status) params.push(status);
    const requests = await db.query(
      `SELECT * FROM organization_signup_requests ${where} ORDER BY created_at DESC`,
      params
    );
    res.json({ success: true, requests: requests.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/expiring-organizations', superAdminAuth, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '30', 10), 1), 365);
  try {
    const result = await db.query(
      `SELECT id, org_code, office_name, contact_person, contact_email, contact_mobile,
              to_char(valid_until::date, 'YYYY-MM-DD') AS valid_until,
              (valid_until::date - CURRENT_DATE)::int AS days_left,
              force_read_only, status
       FROM organizations
       WHERE status='Active'
         AND valid_until IS NOT NULL
         AND valid_until BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1::int * INTERVAL '1 day')
       ORDER BY valid_until ASC`,
      [days]
    );
    res.json({ success: true, organizations: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/signup-requests/:id/reject', superAdminAuth, async (req, res) => {
  try {
    const updated = await db.query(
      `UPDATE organization_signup_requests
       SET status='Rejected', reviewed_by=$1, reviewed_at=NOW(), admin_remark=$2, updated_at=NOW()
       WHERE id=$3 AND status='Pending'
       RETURNING *`,
      [req.superAdmin.id, clean(req.body.remark) || null, req.params.id]
    );
    if (!updated.rows.length) return res.status(404).json({ success: false, message: 'Pending request not found' });
    res.json({ success: true, message: 'Signup request rejected', request: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/signup-requests/:id/approve', superAdminAuth, async (req, res) => {
  const {
    org_code,
    valid_until,
    admin_username,
    admin_password,
    admin_name,
    admin_email,
    admin_mobile,
    remark,
  } = req.body;

  if (!clean(admin_username) || !clean(admin_password) || !clean(admin_name)) {
    return res.status(400).json({ success: false, message: 'Admin username, name and password required' });
  }

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const request = await conn.query(`SELECT * FROM organization_signup_requests WHERE id=$1 AND status='Pending' FOR UPDATE`, [req.params.id]);
    if (!request.rows.length) {
      const err = new Error('Pending request not found');
      err.statusCode = 404;
      throw err;
    }
    const r = request.rows[0];
    const requestedCode = clean(org_code) || orgCodeFromName(r.organization_name, r.id);
    const finalAdminEmail = clean(admin_email) || r.contact_email;
    const finalAdminMobile = clean(admin_mobile) || r.contact_mobile;
    const finalAddress = [
      clean(r.address),
      clean(r.city),
      clean(r.district),
      clean(r.state),
      clean(r.pincode) ? `PIN ${clean(r.pincode)}` : '',
    ].filter(Boolean).join(', ');
    const org = await conn.query(
      `INSERT INTO organizations
        (org_code, office_name, contact_person, contact_email, contact_mobile, address, city, state,
         status, valid_from, valid_until, force_read_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Active',CURRENT_DATE,$9,false)
       RETURNING *`,
      [
        requestedCode,
        r.organization_name,
        r.contact_person,
        r.contact_email,
        r.contact_mobile,
        finalAddress || r.address,
        r.city,
        r.state,
        valid_until || null,
      ]
    );

    await conn.query(
      `INSERT INTO admins (organization_id, username, password, name, email_id, mobile_no, role)
       VALUES ($1,$2,$3,$4,$5,$6,'Director')`,
      [
        org.rows[0].id,
        clean(admin_username),
        await hashForStorage(admin_password),
        clean(admin_name),
        finalAdminEmail,
        finalAdminMobile,
      ]
    );

    await conn.query(
      `UPDATE organization_signup_requests
       SET status='Approved', reviewed_by=$1, reviewed_at=NOW(), admin_remark=$2,
           created_organization_id=$3, created_admin_username=$4, updated_at=NOW()
       WHERE id=$5`,
      [req.superAdmin.id, clean(remark) || null, org.rows[0].id, clean(admin_username), r.id]
    );

    await conn.query(
      `INSERT INTO organization_subscription_history
         (organization_id, new_valid_until, new_force_read_only, new_status, remarks, updated_by)
       VALUES ($1,$2,false,'Active',$3,$4)`,
      [org.rows[0].id, valid_until || null, 'Organisation approved', req.superAdmin.id]
    );

    await conn.query('COMMIT');
    let emailSent = false;
    let emailError = null;
    try {
      const emailResult = await sendApprovalEmail({
        to: finalAdminEmail,
        organizationName: r.organization_name,
        orgCode: org.rows[0].org_code,
        adminUsername: clean(admin_username),
        adminPassword: clean(admin_password),
        validUntil: valid_until || null,
      });
      emailSent = !!emailResult.sent;
    } catch (err) {
      emailError = err.message;
      console.error('[approval email]', err.message);
    }
    res.json({
      success: true,
      message: emailSent
        ? 'Organisation approved and credentials email sent.'
        : `Organisation approved. Email not sent${emailError ? ': ' + emailError : '.'}`,
      organization: org.rows[0],
      admin_username: clean(admin_username),
      email_sent: emailSent,
      email_error: emailError,
      sms_message: finalAdminMobile
        ? `SMS provider not configured. Manual SMS: Gee Bharat approved. Login: ${clean(admin_username)} Password: ${clean(admin_password)} Website: https://geebharat.com/office.html`
        : null,
    });
  } catch (err) {
    await conn.query('ROLLBACK');
    console.error(err);
    res.status(err.statusCode || (err.code === '23505' ? 400 : 500)).json({
      success: false,
      message: err.code === '23505' ? 'Organisation code or admin username already exists' : (err.message || 'Server error'),
    });
  } finally {
    conn.release();
  }
});

router.put('/organizations/:id/subscription', superAdminAuth, async (req, res) => {
  const { valid_until, force_read_only, status, remarks } = req.body;
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await conn.query(`SELECT * FROM organizations WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!old.rows.length) {
      const err = new Error('Organisation not found');
      err.statusCode = 404;
      throw err;
    }
    const updated = await conn.query(
      `UPDATE organizations SET
         valid_until=COALESCE($1::date, valid_until),
         force_read_only=COALESCE($2::boolean, force_read_only),
         status=COALESCE($3, status),
         updated_at=NOW()
       WHERE id=$4
       RETURNING *, to_char(valid_from::date, 'YYYY-MM-DD') AS valid_from, to_char(valid_until::date, 'YYYY-MM-DD') AS valid_until`,
      [
        valid_until || null,
        typeof force_read_only === 'boolean' ? force_read_only : null,
        clean(status) || null,
        req.params.id,
      ]
    );
    await conn.query(
      `INSERT INTO organization_subscription_history
        (organization_id, old_valid_until, new_valid_until, old_force_read_only, new_force_read_only,
         old_status, new_status, remarks, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        req.params.id,
        old.rows[0].valid_until,
        updated.rows[0].valid_until,
        old.rows[0].force_read_only,
        updated.rows[0].force_read_only,
        old.rows[0].status,
        updated.rows[0].status,
        clean(remarks) || null,
        req.superAdmin.id,
      ]
    );
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Organisation subscription updated', organization: updated.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK');
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
  } finally {
    conn.release();
  }
});

async function ensureMcaFormatTable() {
  await db.rawPool.query(`CREATE TABLE IF NOT EXISTS mca_format_versions (
    financial_year VARCHAR(20) PRIMARY KEY,
    source_financial_year VARCHAR(20),
    is_available BOOLEAN NOT NULL DEFAULT FALSE,
    title VARCHAR(255) DEFAULT 'Annual Filing Report Preparation',
    applicability_note TEXT DEFAULT 'Only for Small Private Limited Company. Not for Public Company and not for Section 8 Company.',
    release_note TEXT DEFAULT '',
    replacements JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.rawPool.query(
    `INSERT INTO mca_format_versions
       (financial_year, source_financial_year, is_available, release_note)
     VALUES
       ('2023-24','2023-24',true,'Format available for Small Private Limited Company annual filing reports.'),
       ('2024-25','2024-25',true,'Format available for Small Private Limited Company annual filing reports.'),
       ('2025-26','2024-25',false,'Format for FY 2025-26 has not been released yet.')
     ON CONFLICT (financial_year) DO NOTHING`
  );
}

router.get('/mca-formats', superAdminAuth, async (req, res) => {
  try {
    await ensureMcaFormatTable();
    const r = await db.rawPool.query(
      `SELECT financial_year, source_financial_year, is_available, title,
              applicability_note, release_note, replacements,
              to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
         FROM mca_format_versions
        ORDER BY financial_year DESC`
    );
    res.json({ success: true, formats: r.rows });
  } catch (err) {
    console.error('[super mca formats]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/mca-formats/:fy', superAdminAuth, async (req, res) => {
  const fy = clean(req.params.fy);
  if (!/^\d{4}-\d{2}$/.test(fy)) return res.status(400).json({ success: false, message: 'Invalid financial year' });
  let replacements = req.body.replacements || [];
  if (typeof replacements === 'string') {
    try { replacements = JSON.parse(replacements || '[]'); } catch { return res.status(400).json({ success: false, message: 'Replacement rules JSON invalid' }); }
  }
  if (!Array.isArray(replacements)) return res.status(400).json({ success: false, message: 'Replacement rules must be an array' });
  replacements = replacements
    .map(r => ({ find: clean(r.find), replace: String(r.replace || '') }))
    .filter(r => r.find);
  try {
    await ensureMcaFormatTable();
    const r = await db.rawPool.query(
      `INSERT INTO mca_format_versions
         (financial_year, source_financial_year, is_available, title, applicability_note, release_note, replacements, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW())
       ON CONFLICT (financial_year) DO UPDATE SET
         source_financial_year=EXCLUDED.source_financial_year,
         is_available=EXCLUDED.is_available,
         title=EXCLUDED.title,
         applicability_note=EXCLUDED.applicability_note,
         release_note=EXCLUDED.release_note,
         replacements=EXCLUDED.replacements,
         updated_by=EXCLUDED.updated_by,
         updated_at=NOW()
       RETURNING *`,
      [
        fy,
        clean(req.body.source_financial_year) || '2024-25',
        !!req.body.is_available,
        clean(req.body.title) || 'Annual Filing Report Preparation',
        clean(req.body.applicability_note) || 'Only for Small Private Limited Company. Not for Public Company and not for Section 8 Company.',
        clean(req.body.release_note),
        JSON.stringify(replacements),
        req.superAdmin.id,
      ]
    );
    res.json({ success: true, message: 'MCA format version saved', format: r.rows[0] });
  } catch (err) {
    console.error('[super mca format save]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
