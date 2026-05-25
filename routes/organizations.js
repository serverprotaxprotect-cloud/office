const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { orgSetupErrors } = require('../services/organizationSetupGuard');

const router = express.Router();

function cleanText(value) {
  return String(value || '').trim();
}

function adminCanEdit(user) {
  return user?.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(user.role);
}

router.post('/signup', async (req, res) => {
  const {
    organization_name,
    contact_person,
    contact_email,
    contact_mobile,
    address,
    city,
    state,
    notes,
  } = req.body;

  if (!cleanText(organization_name) || !cleanText(contact_person) || !cleanText(contact_email) || !cleanText(contact_mobile)) {
    return res.status(400).json({ success: false, message: 'Organisation name, contact person, email and mobile are required' });
  }

  try {
    const inserted = await db.query(
      `INSERT INTO organization_signup_requests
        (organization_name, contact_person, contact_email, contact_mobile, address, city, state, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        cleanText(organization_name),
        cleanText(contact_person),
        cleanText(contact_email).toLowerCase(),
        cleanText(contact_mobile),
        cleanText(address) || null,
        cleanText(city) || null,
        cleanText(state) || null,
        cleanText(notes) || null,
      ]
    );

    await db.query(
      `INSERT INTO super_admin_notifications (type, title, message, signup_request_id)
       VALUES ('signup_request', 'New organisation signup', $1, $2)`,
      [`${cleanText(organization_name)} requested office access`, inserted.rows[0].id]
    ).catch(() => {});

    res.json({ success: true, message: 'Signup request submitted. Super admin will verify it.', request_id: inserted.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const org = await db.query(
      `SELECT id, org_code, office_name, contact_person, contact_email, contact_mobile,
              logo_data_url, address, city, state, latitude, longitude,
              attendance_radius_meters, status, valid_from, valid_until, force_read_only,
              employee_id_prefix, employee_id_next, employee_id_series_locked,
              client_id_prefix, client_id_next, client_id_series_locked,
              agent_id_prefix, agent_id_next, agent_id_series_locked
       FROM organizations WHERE id=$1`,
      [req.user.organization_id]
    );
    res.json({ success: true, organization: org.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/profile', authMiddleware, async (req, res) => {
  if (!adminCanEdit(req.user)) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }

  const {
    office_name,
    contact_person,
    contact_email,
    contact_mobile,
    logo_data_url,
    address,
    city,
    state,
    latitude,
    longitude,
    attendance_radius_meters,
    employee_id_prefix,
    employee_id_next,
    client_id_prefix,
    client_id_next,
    agent_id_prefix,
    agent_id_next,
  } = req.body;

  try {
    const existing = await db.query(
      `SELECT latitude, longitude, attendance_radius_meters,
              employee_id_prefix, employee_id_next, employee_id_series_locked,
              client_id_prefix, client_id_next, client_id_series_locked,
              agent_id_prefix, agent_id_next, agent_id_series_locked
       FROM organizations WHERE id=$1`,
      [req.user.organization_id]
    );
    const lock = existing.rows[0] || {};
    const nextProfile = {
      latitude: latitude === undefined || latitude === '' ? lock.latitude : Number(latitude),
      longitude: longitude === undefined || longitude === '' ? lock.longitude : Number(longitude),
      attendance_radius_meters: attendance_radius_meters === undefined || attendance_radius_meters === '' ? lock.attendance_radius_meters : Number(attendance_radius_meters),
      employee_id_prefix: lock.employee_id_series_locked ? lock.employee_id_prefix : (cleanText(employee_id_prefix) || lock.employee_id_prefix),
      client_id_prefix: lock.client_id_series_locked ? lock.client_id_prefix : (cleanText(client_id_prefix) || lock.client_id_prefix),
      agent_id_prefix: lock.agent_id_series_locked ? lock.agent_id_prefix : (cleanText(agent_id_prefix) || lock.agent_id_prefix),
    };
    const setup = orgSetupErrors(nextProfile);
    if (setup.clashes.length) {
      return res.status(400).json({
        success: false,
        message: `ID series prefixes must be different: ${setup.clashes.join('; ')}`,
      });
    }
    const updated = await db.query(
      `UPDATE organizations SET
         office_name=COALESCE($1, office_name),
         contact_person=COALESCE($2, contact_person),
         contact_email=COALESCE($3, contact_email),
         contact_mobile=COALESCE($4, contact_mobile),
         logo_data_url=COALESCE($5, logo_data_url),
         address=COALESCE($6, address),
         city=COALESCE($7, city),
         state=COALESCE($8, state),
         latitude=COALESCE($9, latitude),
         longitude=COALESCE($10, longitude),
         attendance_radius_meters=COALESCE($11, attendance_radius_meters),
         employee_id_prefix=COALESCE($12, employee_id_prefix),
         employee_id_next=COALESCE($13, employee_id_next),
         employee_id_series_locked=CASE WHEN $12 IS NOT NULL OR $13 IS NOT NULL THEN true ELSE employee_id_series_locked END,
         client_id_prefix=COALESCE($14, client_id_prefix),
         client_id_next=COALESCE($15, client_id_next),
         client_id_series_locked=CASE WHEN $14 IS NOT NULL OR $15 IS NOT NULL THEN true ELSE client_id_series_locked END,
         agent_id_prefix=COALESCE($16, agent_id_prefix),
         agent_id_next=COALESCE($17, agent_id_next),
         agent_id_series_locked=CASE WHEN $16 IS NOT NULL OR $17 IS NOT NULL THEN true ELSE agent_id_series_locked END,
         updated_at=NOW()
       WHERE id=$18
       RETURNING id, org_code, office_name, contact_person, contact_email, contact_mobile,
                 logo_data_url, address, city, state, latitude, longitude,
                 attendance_radius_meters, status, valid_from, valid_until, force_read_only,
                 employee_id_prefix, employee_id_next, employee_id_series_locked,
                 client_id_prefix, client_id_next, client_id_series_locked,
                 agent_id_prefix, agent_id_next, agent_id_series_locked`,
      [
        cleanText(office_name) || null,
        cleanText(contact_person) || null,
        cleanText(contact_email) || null,
        cleanText(contact_mobile) || null,
        cleanText(logo_data_url) || null,
        cleanText(address) || null,
        cleanText(city) || null,
        cleanText(state) || null,
        latitude === undefined || latitude === '' ? null : Number(latitude),
        longitude === undefined || longitude === '' ? null : Number(longitude),
        attendance_radius_meters === undefined || attendance_radius_meters === '' ? null : Number(attendance_radius_meters),
        lock.employee_id_series_locked ? null : (cleanText(employee_id_prefix) || null),
        lock.employee_id_series_locked || employee_id_next === undefined || employee_id_next === '' ? null : Number(employee_id_next),
        lock.client_id_series_locked ? null : (cleanText(client_id_prefix) || null),
        lock.client_id_series_locked || client_id_next === undefined || client_id_next === '' ? null : Number(client_id_next),
        lock.agent_id_series_locked ? null : (cleanText(agent_id_prefix) || null),
        lock.agent_id_series_locked || agent_id_next === undefined || agent_id_next === '' ? null : Number(agent_id_next),
        req.user.organization_id,
      ]
    );
    res.json({ success: true, message: 'Organisation profile updated', organization: updated.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
