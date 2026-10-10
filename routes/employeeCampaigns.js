const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { sendEmail } = require('../utils/email');
const svc = require('../services/employeeCampaignService');

const router = express.Router();

const OTP_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 45;
const OTP_MAX_PER_HOUR = 5;

function clean(v) {
  const t = v === undefined || v === null ? '' : String(v).trim();
  return t || null;
}

async function loadCampaign(id) {
  const r = await db.query(`SELECT * FROM employee_campaigns WHERE id=$1`, [id]);
  return r.rows[0] || null;
}

async function currentValueFor(campaign, empId) {
  const column = svc.FIELD_BY_KEY[campaign.field_key]?.column;
  if (!column) return null;
  const r = await db.query(`SELECT ${column} AS cur FROM emplist WHERE emp_id=$1`, [empId]);
  return r.rows[0]?.cur ?? null;
}

// An email already used by another employee would make login-by-email
// ambiguous, so it's refused.
async function emailTakenByOther(value, empId) {
  const r = await db.query(
    `SELECT 1 FROM emplist WHERE lower(trim(coalesce(email_id,'')))=$1 AND emp_id <> $2 LIMIT 1`,
    [value, empId]
  );
  return r.rows.length > 0;
}

// ═══ Employee side ══════════════════════════════════════════════════════════

// GET /api/campaigns/my/pending
router.get('/my/pending', authMiddleware, async (req, res) => {
  try {
    if (req.user.user_type === 'admin') return res.json({ success: true, campaigns: [] });
    res.json({ success: true, campaigns: await svc.pendingForEmployee(req.user.emp_id) });
  } catch (err) {
    console.error('[campaigns pending]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

async function myTargetCampaign(req, res) {
  const campaign = await loadCampaign(req.params.id);
  if (!campaign || campaign.status !== 'Active') {
    res.status(404).json({ success: false, message: 'This request is no longer active.' });
    return null;
  }
  const t = await db.query(
    `SELECT status FROM employee_campaign_targets WHERE campaign_id=$1 AND emp_id=$2`,
    [campaign.id, req.user.emp_id]
  );
  if (!t.rows.length) {
    res.status(404).json({ success: false, message: 'You are not part of this request.' });
    return null;
  }
  if (t.rows[0].status === 'Submitted') {
    res.status(400).json({ success: false, message: 'Already submitted.' });
    return null;
  }
  return campaign;
}

// POST /api/campaigns/my/:id/send-otp  { value }
router.post('/my/:id/send-otp', authMiddleware, async (req, res) => {
  try {
    const campaign = await myTargetCampaign(req, res);
    if (!campaign) return;
    if (!campaign.require_otp) return res.status(400).json({ success: false, message: 'Verification is not required for this request.' });

    const empId = req.user.emp_id;
    const v = svc.validateValue(campaign, req.body.value, { currentValue: await currentValueFor(campaign, empId) });
    if (!v.ok) return res.status(400).json({ success: false, message: v.message });
    if (campaign.input_type === 'email' && await emailTakenByOther(v.value, empId)) {
      return res.status(400).json({ success: false, message: 'This email is already registered to another employee.' });
    }

    const recent = await db.query(
      `SELECT created_at FROM employee_campaign_otps
        WHERE campaign_id=$1 AND emp_id=$2 AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at DESC`,
      [campaign.id, empId]
    );
    if (recent.rows.length >= OTP_MAX_PER_HOUR) {
      return res.status(429).json({ success: false, message: 'Too many codes requested. Please try again in an hour.' });
    }
    if (recent.rows[0] && Date.now() - new Date(recent.rows[0].created_at).getTime() < OTP_RESEND_SECONDS * 1000) {
      return res.status(429).json({ success: false, message: `Please wait ${OTP_RESEND_SECONDS} seconds before requesting another code.` });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await sendEmail({
      to: v.value,
      subject: 'Your verification code',
      html: `<p>Your verification code is:</p><h2 style="letter-spacing:4px">${code}</h2><p>It expires in ${OTP_MINUTES} minutes. If you did not request this, you can ignore this email.</p><p>${req.organization?.office_name || ''}</p>`,
      text: `Your verification code is ${code}. It expires in ${OTP_MINUTES} minutes.`,
    });
    await db.query(
      `INSERT INTO employee_campaign_otps (campaign_id, emp_id, new_value, code_hash, expires_at)
       VALUES ($1,$2,$3,$4, NOW() + ($5 || ' minutes')::interval)`,
      [campaign.id, empId, v.value, svc.hashOtp(campaign.id, empId, code), String(OTP_MINUTES)]
    );
    res.json({ success: true, message: `A 6-digit code was sent to ${v.value}. Enter it below to confirm.` });
  } catch (err) {
    console.error('[campaigns send-otp]', err);
    res.status(500).json({ success: false, message: err.message || 'Could not send the code.' });
  }
});

// POST /api/campaigns/my/:id/submit  { value, code? }
router.post('/my/:id/submit', authMiddleware, async (req, res) => {
  try {
    const campaign = await myTargetCampaign(req, res);
    if (!campaign) return;
    const empId = req.user.emp_id;

    const v = svc.validateValue(campaign, req.body.value, { currentValue: await currentValueFor(campaign, empId) });
    if (!v.ok) return res.status(400).json({ success: false, message: v.message });
    if (campaign.input_type === 'email' && await emailTakenByOther(v.value, empId)) {
      return res.status(400).json({ success: false, message: 'This email is already registered to another employee.' });
    }

    let verified = false;
    if (campaign.require_otp) {
      const code = String(req.body.code || '').trim();
      if (!/^\d{6}$/.test(code)) return res.status(400).json({ success: false, message: 'Enter the 6-digit code sent to your email.' });
      const otp = await db.query(
        `SELECT id, code_hash, attempts, expires_at FROM employee_campaign_otps
          WHERE campaign_id=$1 AND emp_id=$2 AND new_value=$3 AND used_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [campaign.id, empId, v.value]
      );
      const row = otp.rows[0];
      if (!row) return res.status(400).json({ success: false, message: 'Request a verification code first.' });
      if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ success: false, message: 'That code has expired. Request a new one.' });
      if (row.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ success: false, message: 'Too many wrong attempts. Request a new code.' });
      if (!svc.safeEqual(row.code_hash, svc.hashOtp(campaign.id, empId, code))) {
        await db.query(`UPDATE employee_campaign_otps SET attempts = attempts + 1 WHERE id=$1`, [row.id]);
        return res.status(400).json({ success: false, message: 'Incorrect code. Please check and try again.' });
      }
      await db.query(`UPDATE employee_campaign_otps SET used_at=NOW() WHERE id=$1`, [row.id]);
      verified = true;
    }

    const result = await svc.applySubmission({ campaign, empId, value: v.value, via: 'employee', verified });
    if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });
    res.json({ success: true, message: 'Thank you. Your details have been updated.' });
  } catch (err) {
    console.error('[campaigns submit]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/campaigns/my/:id/snooze  ("Remind me later" — hides it for today)
router.post('/my/:id/snooze', authMiddleware, async (req, res) => {
  try {
    const campaign = await myTargetCampaign(req, res);
    if (!campaign) return;
    const t = await db.query(`SELECT created_at FROM employee_campaign_targets WHERE campaign_id=$1 AND emp_id=$2`, [campaign.id, req.user.emp_id]);
    if (svc.isMandatory(campaign, t.rows[0])) {
      return res.status(400).json({ success: false, message: 'This request is now mandatory and cannot be postponed.' });
    }
    await db.query(`UPDATE employee_campaign_targets SET snoozed_on=$1 WHERE campaign_id=$2 AND emp_id=$3`, [svc.istDate(), campaign.id, req.user.emp_id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[campaigns snooze]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══ Admin side ═════════════════════════════════════════════════════════════

// GET /api/campaigns/admin/meta
router.get('/admin/meta', adminAuth, async (req, res) => {
  try {
    const emps = await db.query(
      `SELECT emp_id, name, formal_name, designation, email_id
         FROM emplist WHERE status='Active' ORDER BY emp_id`
    );
    const designations = [...new Set(emps.rows.map(e => e.designation).filter(Boolean))].sort();
    res.json({ success: true, fields: svc.FIELDS, input_types: svc.INPUT_TYPES, designations, employees: emps.rows });
  } catch (err) {
    console.error('[campaigns meta]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/campaigns/admin
router.get('/admin', adminAuth, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.*,
              COUNT(t.id)::int AS total,
              COUNT(t.id) FILTER (WHERE t.status='Submitted')::int AS submitted
         FROM employee_campaigns c
         LEFT JOIN employee_campaign_targets t ON t.campaign_id = c.id
        GROUP BY c.id ORDER BY c.created_at DESC`
    );
    res.json({ success: true, campaigns: r.rows });
  } catch (err) {
    console.error('[campaigns list]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/campaigns/admin
router.post('/admin', adminAuth, async (req, res) => {
  const b = req.body || {};
  const title = clean(b.title);
  const field = svc.FIELD_BY_KEY[b.field_key];
  if (!title) return res.status(400).json({ success: false, message: 'Title is required.' });
  if (!field) return res.status(400).json({ success: false, message: 'Choose what to collect.' });
  const fieldLabel = field.key === 'custom' ? clean(b.field_label) : field.label;
  if (!fieldLabel) return res.status(400).json({ success: false, message: 'Describe the question for a custom request.' });
  const inputType = field.key === 'custom'
    ? (svc.INPUT_TYPES.includes(b.input_type) ? b.input_type : 'text')
    : field.input_type;
  const requireOtp = inputType === 'email' && !!b.require_otp;
  const mandatoryDays = b.mandatory_after_days === '' || b.mandatory_after_days === null || b.mandatory_after_days === undefined
    ? null : Math.max(0, Math.min(365, parseInt(b.mandatory_after_days, 10)));
  if (mandatoryDays !== null && !Number.isFinite(mandatoryDays)) return res.status(400).json({ success: false, message: 'Invalid number of days.' });
  const audience = ['all', 'selected', 'designation'].includes(b.audience_type) ? b.audience_type : 'all';
  const empIds = Array.isArray(b.emp_ids) ? b.emp_ids.map(String) : [];
  const designations = Array.isArray(b.designations) ? b.designations.map(String) : [];
  if (audience === 'selected' && !empIds.length) return res.status(400).json({ success: false, message: 'Select at least one employee.' });
  if (audience === 'designation' && !designations.length) return res.status(400).json({ success: false, message: 'Select at least one designation.' });

  try {
    const ins = await db.query(
      `INSERT INTO employee_campaigns
         (organization_id, title, instruction, field_key, field_label, input_type, require_otp,
          mandatory_after_days, blocked_keywords, audience_type, created_by)
       VALUES (current_organization_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [title, clean(b.instruction), field.key, fieldLabel, inputType, requireOtp, mandatoryDays,
       clean(b.blocked_keywords), audience, req.user.name || req.user.emp_id || 'Admin']
    );
    const campaign = ins.rows[0];
    let added;
    if (audience === 'selected') {
      added = await db.query(
        `INSERT INTO employee_campaign_targets (organization_id, campaign_id, emp_id)
         SELECT current_organization_id(), $1, emp_id FROM emplist WHERE status='Active' AND emp_id = ANY($2::text[])
         ON CONFLICT DO NOTHING`, [campaign.id, empIds]);
    } else if (audience === 'designation') {
      added = await db.query(
        `INSERT INTO employee_campaign_targets (organization_id, campaign_id, emp_id)
         SELECT current_organization_id(), $1, emp_id FROM emplist WHERE status='Active' AND designation = ANY($2::text[])
         ON CONFLICT DO NOTHING`, [campaign.id, designations]);
    } else {
      added = await db.query(
        `INSERT INTO employee_campaign_targets (organization_id, campaign_id, emp_id)
         SELECT current_organization_id(), $1, emp_id FROM emplist WHERE status='Active'
         ON CONFLICT DO NOTHING`, [campaign.id]);
    }
    // Let people know right away (they will also see the popup on their dashboard).
    await db.query(
      `INSERT INTO notifications (organization_id, emp_id, type, title, message)
       SELECT current_organization_id(), emp_id, 'campaign', $2, $3
         FROM employee_campaign_targets WHERE campaign_id=$1`,
      [campaign.id, title, clean(b.instruction) || 'Please open your dashboard to respond.']
    ).catch(err => console.warn('[campaign notify skipped]', err.message));
    res.json({ success: true, message: `Request created for ${added.rowCount} employee(s).`, campaign });
  } catch (err) {
    console.error('[campaigns create]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/campaigns/admin/:id
router.get('/admin/:id', adminAuth, async (req, res) => {
  try {
    const campaign = await loadCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    const t = await db.query(
      `SELECT t.id, t.emp_id, t.status, t.value, t.previous_value, t.verified, t.submitted_via, t.submitted_at,
              t.last_reminded_at, t.created_at, e.name, e.formal_name, e.designation, e.email_id, e.official_email
         FROM employee_campaign_targets t
         LEFT JOIN emplist e ON e.emp_id = t.emp_id
        WHERE t.campaign_id=$1 ORDER BY t.status DESC, t.emp_id`,
      [campaign.id]
    );
    const withFlags = t.rows.map(row => ({ ...row, mandatory: row.status === 'Pending' && svc.isMandatory(campaign, row) }));
    res.json({ success: true, campaign, targets: withFlags });
  } catch (err) {
    console.error('[campaigns detail]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/campaigns/admin/:id/remind  { emp_ids? } — defaults to everyone still pending
router.post('/admin/:id/remind', adminAuth, async (req, res) => {
  try {
    const campaign = await loadCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    if (campaign.status !== 'Active') return res.status(400).json({ success: false, message: 'This request is closed.' });
    const ids = Array.isArray(req.body.emp_ids) && req.body.emp_ids.length ? req.body.emp_ids.map(String) : null;
    const pending = await db.query(
      `SELECT emp_id FROM employee_campaign_targets
        WHERE campaign_id=$1 AND status='Pending' AND ($2::text[] IS NULL OR emp_id = ANY($2::text[]))`,
      [campaign.id, ids]
    );
    for (const row of pending.rows) {
      await db.query(
        `INSERT INTO notifications (organization_id, emp_id, type, title, message)
         VALUES (current_organization_id(),$1,'campaign',$2,$3)`,
        [row.emp_id, `Reminder: ${campaign.title}`, campaign.instruction || 'Please open your dashboard to respond.']
      );
    }
    await db.query(
      `UPDATE employee_campaign_targets SET last_reminded_at=NOW()
        WHERE campaign_id=$1 AND status='Pending' AND ($2::text[] IS NULL OR emp_id = ANY($2::text[]))`,
      [campaign.id, ids]
    );
    res.json({ success: true, message: `Reminder sent to ${pending.rowCount} employee(s).` });
  } catch (err) {
    console.error('[campaigns remind]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/campaigns/admin/:id/status  { status: 'Active' | 'Closed' }
router.post('/admin/:id/status', adminAuth, async (req, res) => {
  const status = req.body.status;
  if (!['Active', 'Closed'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status' });
  try {
    const r = await db.query(
      `UPDATE employee_campaigns SET status=$1, closed_at=$2 WHERE id=$3 RETURNING id`,
      [status, status === 'Closed' ? new Date() : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, message: status === 'Closed' ? 'Request closed.' : 'Request reopened.' });
  } catch (err) {
    console.error('[campaigns status]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/campaigns/admin/:id/sync — add active employees who joined after an "all employees" request was created
router.post('/admin/:id/sync', adminAuth, async (req, res) => {
  try {
    const campaign = await loadCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    if (campaign.audience_type !== 'all') return res.status(400).json({ success: false, message: 'Only "all employees" requests can be synced.' });
    const added = await db.query(
      `INSERT INTO employee_campaign_targets (organization_id, campaign_id, emp_id)
       SELECT current_organization_id(), $1, emp_id FROM emplist WHERE status='Active'
       ON CONFLICT DO NOTHING`, [campaign.id]);
    res.json({ success: true, message: `${added.rowCount} new employee(s) added.` });
  } catch (err) {
    console.error('[campaigns sync]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/campaigns/admin/:id/set  { emp_id, value } — admin enters/overrides on an employee's behalf
router.post('/admin/:id/set', adminAuth, async (req, res) => {
  try {
    const campaign = await loadCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Not found' });
    const empId = clean(req.body.emp_id);
    if (!empId) return res.status(400).json({ success: false, message: 'Employee required.' });
    const v = svc.validateValue(campaign, req.body.value, { currentValue: null });
    if (!v.ok) return res.status(400).json({ success: false, message: v.message });
    if (campaign.input_type === 'email' && await emailTakenByOther(v.value, empId)) {
      return res.status(400).json({ success: false, message: 'This email is already registered to another employee.' });
    }
    const result = await svc.applySubmission({ campaign, empId, value: v.value, via: 'admin', verified: false });
    if (!result.ok) return res.status(result.status || 400).json({ success: false, message: result.message });
    res.json({ success: true, message: 'Saved.' });
  } catch (err) {
    console.error('[campaigns admin set]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
