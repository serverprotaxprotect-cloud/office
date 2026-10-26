const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { hashPassword, verifyPassword } = require('../utils/passwords');
const { sendEmail } = require('../utils/email');
const { createNotif } = require('./notifications');

const router = express.Router();

const FEATURE_KEY = 'content_studio';
const APP_URL = process.env.APP_URL || 'https://geebharat.com';
const STATUSES = ['Idea', 'Script Ready', 'Ready to Shoot', 'Shot', 'Editing', 'Published', 'Archived'];
const MANAGER_ROLES = ['Owner', 'Director', 'Office Manager', 'HR'];
// Guest tokens are signed with a different secret, so no other part of the system can ever accept one.
const guestSecret = () => `${process.env.JWT_SECRET}:studio-guest`;

const clean = v => String(v ?? '').trim();
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function featureOn(orgId) {
  const r = await db.query(
    `SELECT access_level FROM organization_feature_access WHERE organization_id=$1 AND feature_key=$2`, [orgId, FEATURE_KEY]);
  return (r.rows[0]?.access_level || 'none') !== 'none';
}

// Resolves who is calling: admin, studio-employee or guest. Sets req.studio.
function studioAuth({ requireMember = true } = {}) {
  return async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Login required' });

    // 1) Outside guest
    let guest = null;
    try { guest = jwt.verify(token, guestSecret()); } catch { /* not a guest token */ }
    if (guest && guest.studio_guest && guest.member_id && guest.organization_id) {
      try {
        return await db.runWithTenant({ organizationId: guest.organization_id }, async () => {
          const org = await db.query(`SELECT id, status FROM organizations WHERE id=$1`, [guest.organization_id]);
          if (!org.rows.length || org.rows[0].status !== 'Active')
            return res.status(403).json({ success: false, message: 'Organisation account is not active.' });
          if (!(await featureOn(guest.organization_id)))
            return res.status(403).json({ success: false, code: 'STUDIO_DISABLED', message: 'Gee Bharat Studio is not enabled for this organisation.' });
          const m = await db.query(`SELECT * FROM studio_members WHERE id=$1 AND member_type='guest'`, [guest.member_id]);
          if (!m.rows.length || m.rows[0].status !== 'Active')
            return res.status(403).json({ success: false, message: 'Your Studio access has been disabled. Please contact the office.' });
          req.studio = { kind: 'guest', orgId: guest.organization_id, member: m.rows[0], name: m.rows[0].name };
          req.user = { organization_id: guest.organization_id };
          return next();
        });
      } catch (err) {
        console.error('[studio guest auth]', err);
        return res.status(500).json({ success: false, message: 'Server error' });
      }
    }

    // 2) Admin / employee of the office (normal login)
    return authMiddleware(req, res, async () => {
      try {
        const u = req.user;
        if (!(await featureOn(u.organization_id)))
          return res.status(403).json({ success: false, code: 'STUDIO_DISABLED', message: 'Gee Bharat Studio is not enabled for this organisation.' });
        if (u.user_type === 'admin' || u.is_admin) {
          req.studio = { kind: 'admin', orgId: u.organization_id, name: u.name || u.username, manager: MANAGER_ROLES.includes(u.role) || /owner|director/i.test(u.role || '') };
          return next();
        }
        const m = await db.query(`SELECT * FROM studio_members WHERE emp_id=$1 AND member_type='employee' AND status='Active'`, [u.emp_id]);
        if (!m.rows.length) {
          if (!requireMember) { req.studio = { kind: 'none', orgId: u.organization_id }; return next(); }
          return res.status(403).json({ success: false, code: 'NOT_STUDIO_MEMBER', message: 'You have not been given access to Gee Bharat Studio.' });
        }
        req.studio = { kind: 'employee', orgId: u.organization_id, member: m.rows[0], name: m.rows[0].name };
        return next();
      } catch (err) {
        console.error('[studio auth]', err);
        return res.status(500).json({ success: false, message: 'Server error' });
      }
    });
  };
}

const adminOnly = (req, res, next) =>
  req.studio?.kind === 'admin' ? next() : res.status(403).json({ success: false, message: 'Admin access required' });
const managerOnly = (req, res, next) =>
  req.studio?.kind === 'admin' && req.studio.manager ? next() : res.status(403).json({ success: false, message: 'Only an owner, director, office manager or HR can manage the Studio team' });

// ── Guest login (public) ─────────────────────────────────────
router.post('/guest-login', async (req, res) => {
  const loginId = clean(req.body.login_id).toLowerCase();
  const password = String(req.body.password || '');
  if (!loginId || !password) return res.status(400).json({ success: false, message: 'Please enter your login ID and password.' });
  try {
    const out = await db.runWithTenant({ bypassTenant: true }, async () => {
      const r = await db.query(`SELECT * FROM studio_members WHERE LOWER(login_id)=$1 AND member_type='guest'`, [loginId]);
      const m = r.rows[0];
      if (!m || m.status !== 'Active' || !(await verifyPassword(password, m.password_hash))) return { status: 401, message: 'Incorrect login ID or password.' };
      const org = await db.query(`SELECT id, status FROM organizations WHERE id=$1`, [m.organization_id]);
      if (!org.rows.length || org.rows[0].status !== 'Active') return { status: 403, message: 'This organisation account is not active.' };
      const f = await db.query(`SELECT access_level FROM organization_feature_access WHERE organization_id=$1 AND feature_key=$2`, [m.organization_id, FEATURE_KEY]);
      if ((f.rows[0]?.access_level || 'none') === 'none') return { status: 403, message: 'Gee Bharat Studio is not enabled for this organisation.' };
      await db.query(`UPDATE studio_members SET last_login_at=NOW() WHERE id=$1`, [m.id]);
      const token = jwt.sign({ studio_guest: true, member_id: m.id, organization_id: m.organization_id }, guestSecret(), { expiresIn: '12h' });
      return { status: 200, token, member: { name: m.name, role: m.role, must_change_password: m.must_change_password } };
    });
    if (out.status !== 200) return res.status(out.status).json({ success: false, message: out.message });
    res.json({ success: true, token: out.token, member: out.member });
  } catch (err) {
    console.error('[studio guest login]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/guest-change-password', studioAuth(), async (req, res) => {
  if (req.studio.kind !== 'guest') return res.status(403).json({ success: false, message: 'Only outside Studio users change their password here.' });
  const pw = String(req.body.new_password || '');
  if (pw.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  try {
    await db.query(`UPDATE studio_members SET password_hash=$1, must_change_password=FALSE WHERE id=$2`, [await hashPassword(pw), req.studio.member.id]);
    res.json({ success: true, message: 'Password updated.' });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Who am I / is the Studio available to me ─────────────────
router.get('/access', studioAuth({ requireMember: false }), (req, res) => {
  const s = req.studio;
  res.json({
    success: true,
    enabled: true,
    allowed: s.kind !== 'none',
    kind: s.kind,
    name: s.name,
    role: s.member?.role || (s.kind === 'admin' ? 'Admin' : null),
    can_manage_team: !!(s.kind === 'admin' && s.manager),
    must_change_password: !!s.member?.must_change_password,
  });
});

// ── Topics ───────────────────────────────────────────────────
const TOPIC_SELECT = `SELECT t.*, to_char(t.shoot_date,'YYYY-MM-DD') AS shoot_date,
       p.name AS presenter_name, w.name AS writer_name
  FROM studio_topics t
  LEFT JOIN studio_members p ON p.id=t.presenter_id
  LEFT JOIN studio_members w ON w.id=t.writer_id`;

router.get('/topics', studioAuth(), async (req, res) => {
  try {
    const s = req.studio;
    const include = req.query.archived === '1';
    const where = [];
    const params = [];
    if (!include) where.push(`t.status <> 'Archived'`);
    if (s.kind !== 'admin') { params.push(s.member.id); where.push(`(t.presenter_id=$1 OR t.writer_id=$1)`); }
    const r = await db.query(`${TOPIC_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.shoot_date NULLS LAST, t.updated_at DESC`, params);
    res.json({ success: true, topics: r.rows, statuses: STATUSES });
  } catch (err) {
    console.error('[studio topics]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

async function notifyAssignment(topic, memberId, roleLabel, byName) {
  if (!memberId) return;
  try {
    const m = (await db.query(`SELECT * FROM studio_members WHERE id=$1`, [memberId])).rows[0];
    if (!m || m.status !== 'Active') return;
    const msg = `A Studio topic has been assigned to you as ${roleLabel}: "${topic.title}"${topic.shoot_date ? ` (shoot date ${topic.shoot_date})` : ''}.`;
    if (m.member_type === 'employee') {
      await createNotif(m.emp_id, 'studio_assigned', 'New Studio topic assigned', msg, null);
    } else if (m.email) {
      await sendEmail({
        to: m.email,
        subject: 'New Gee Bharat Studio topic assigned to you',
        html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:540px;color:#1e293b;line-height:1.55;">
          <p>Dear ${esc(m.name)},</p><p>${esc(msg)}</p>
          <p><a href="${APP_URL}/studio.html" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Open Gee Bharat Studio</a></p>
          <p style="font-size:12px;color:#94a3b8;">This is an automated message.</p></div>`,
        text: `${msg} Open ${APP_URL}/studio.html`,
      });
    }
  } catch (e) { console.error('[studio assign notify]', e.message); }
}

router.post('/topics', studioAuth(), adminOnly, async (req, res) => {
  const b = req.body;
  const title = clean(b.title);
  if (!title) return res.status(400).json({ success: false, message: 'Please enter a topic title.' });
  try {
    const r = await db.query(
      `INSERT INTO studio_topics (title, category, platform, hook, script, key_points, reference_url, duration_label, shoot_date, status, presenter_id, writer_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13) RETURNING id`,
      [title, clean(b.category) || null, clean(b.platform) || null, b.hook || null, b.script || null, b.key_points || null, clean(b.reference_url) || null,
        clean(b.duration_label) || null, clean(b.shoot_date) || null, STATUSES.includes(b.status) ? b.status : 'Idea',
        b.presenter_id || null, b.writer_id || null, req.studio.name]);
    const topic = (await db.query(`${TOPIC_SELECT} WHERE t.id=$1`, [r.rows[0].id])).rows[0];
    await notifyAssignment(topic, topic.presenter_id, 'Presenter', req.studio.name);
    await notifyAssignment(topic, topic.writer_id, 'Writer', req.studio.name);
    res.json({ success: true, topic });
  } catch (err) {
    console.error('[studio create topic]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/topics/:id', studioAuth(), async (req, res) => {
  try {
    const s = req.studio;
    const cur = (await db.query(`SELECT * FROM studio_topics WHERE id=$1`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ success: false, message: 'Topic not found' });
    const b = req.body;
    const set = {}; // column -> value
    if (s.kind === 'admin') {
      for (const k of ['title', 'category', 'platform', 'hook', 'script', 'key_points', 'reference_url', 'duration_label', 'presenter_note', 'video_url'])
        if (k in b) set[k] = b[k] === '' ? null : b[k];
      if ('shoot_date' in b) set.shoot_date = clean(b.shoot_date) || null;
      if ('presenter_id' in b) set.presenter_id = b.presenter_id || null;
      if ('writer_id' in b) set.writer_id = b.writer_id || null;
      if ('status' in b) { if (!STATUSES.includes(b.status)) return res.status(400).json({ success: false, message: 'Invalid status' }); set.status = b.status; }
      if ('title' in set && !clean(set.title)) return res.status(400).json({ success: false, message: 'Title cannot be empty.' });
    } else {
      const isWriter = cur.writer_id === s.member.id, isPresenter = cur.presenter_id === s.member.id;
      if (!isWriter && !isPresenter) return res.status(403).json({ success: false, message: 'This topic is not assigned to you.' });
      if (isWriter && s.member.role === 'Writer') {
        for (const k of ['hook', 'script', 'key_points', 'reference_url', 'duration_label']) if (k in b) set[k] = b[k] === '' ? null : b[k];
        if (b.status === 'Script Ready' && cur.status === 'Idea') set.status = 'Script Ready';
      }
      if (isPresenter) {
        if ('presenter_note' in b) set.presenter_note = b.presenter_note === '' ? null : b.presenter_note;
        if (b.status === 'Shot' && ['Ready to Shoot', 'Script Ready'].includes(cur.status)) set.status = 'Shot';
      }
      if (!Object.keys(set).length) return res.status(403).json({ success: false, message: 'You do not have permission to change this.' });
    }
    const cols = Object.keys(set);
    if (!cols.length) return res.json({ success: true, topic: (await db.query(`${TOPIC_SELECT} WHERE t.id=$1`, [cur.id])).rows[0] });
    const vals = cols.map(c => set[c]);
    await db.query(`UPDATE studio_topics SET ${cols.map((c, i) => `${c}=$${i + 1}${c === 'shoot_date' ? '::date' : ''}`).join(', ')}, updated_at=NOW() WHERE id=$${cols.length + 1}`, [...vals, cur.id]);
    const topic = (await db.query(`${TOPIC_SELECT} WHERE t.id=$1`, [cur.id])).rows[0];
    if (s.kind === 'admin') {
      if ('presenter_id' in set && set.presenter_id !== cur.presenter_id) await notifyAssignment(topic, topic.presenter_id, 'Presenter', s.name);
      if ('writer_id' in set && set.writer_id !== cur.writer_id) await notifyAssignment(topic, topic.writer_id, 'Writer', s.name);
    }
    res.json({ success: true, topic });
  } catch (err) {
    console.error('[studio update topic]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Ideas ────────────────────────────────────────────────────
router.get('/ideas', studioAuth(), async (req, res) => {
  try {
    const s = req.studio;
    const r = s.kind === 'admin'
      ? await db.query(`SELECT * FROM studio_ideas WHERE status='New' ORDER BY created_at DESC`)
      : await db.query(`SELECT * FROM studio_ideas WHERE submitted_by_member=$1 ORDER BY created_at DESC LIMIT 30`, [s.member.id]);
    res.json({ success: true, ideas: r.rows });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/ideas', studioAuth(), async (req, res) => {
  const text = clean(req.body.idea_text);
  if (text.length < 5) return res.status(400).json({ success: false, message: 'Please describe your idea in a few words.' });
  try {
    await db.query(`INSERT INTO studio_ideas (idea_text, submitted_by_member, submitted_by_name) VALUES ($1,$2,$3)`,
      [text.slice(0, 1000), req.studio.member?.id || null, req.studio.name]);
    res.json({ success: true, message: 'Thank you. Your idea has been sent to the team.' });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/ideas/:id/convert', studioAuth(), adminOnly, async (req, res) => {
  try {
    const idea = (await db.query(`SELECT * FROM studio_ideas WHERE id=$1 AND status='New'`, [req.params.id])).rows[0];
    if (!idea) return res.status(404).json({ success: false, message: 'Idea not found' });
    const t = await db.query(`INSERT INTO studio_topics (title, hook, status, created_by) VALUES ($1,$2,'Idea',$3) RETURNING id`,
      [idea.idea_text.slice(0, 240), null, req.studio.name]);
    await db.query(`UPDATE studio_ideas SET status='Converted', topic_id=$1 WHERE id=$2`, [t.rows[0].id, idea.id]);
    res.json({ success: true, topic_id: t.rows[0].id });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/ideas/:id/dismiss', studioAuth(), adminOnly, async (req, res) => {
  try {
    await db.query(`UPDATE studio_ideas SET status='Dismissed' WHERE id=$1 AND status='New'`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

// ── Team (admin) ─────────────────────────────────────────────
router.get('/members', studioAuth(), adminOnly, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, member_type, emp_id, name, mobile, email, login_id, role, status, must_change_password, last_login_at, created_at
         FROM studio_members ORDER BY status, member_type, name`);
    res.json({ success: true, members: r.rows, can_manage: !!req.studio.manager });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.get('/employees', studioAuth(), managerOnly, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT e.emp_id, COALESCE(e.formal_name, e.name) AS name, e.designation
         FROM emplist e WHERE e.status='Active'
          AND NOT EXISTS (SELECT 1 FROM studio_members m WHERE m.emp_id=e.emp_id AND m.status='Active')
        ORDER BY e.name`);
    res.json({ success: true, employees: r.rows });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

router.post('/members/employee', studioAuth(), managerOnly, async (req, res) => {
  const empId = clean(req.body.emp_id);
  const role = ['Presenter', 'Writer'].includes(req.body.role) ? req.body.role : 'Presenter';
  try {
    const e = (await db.query(`SELECT emp_id, COALESCE(formal_name,name) AS name FROM emplist WHERE emp_id=$1 AND status='Active'`, [empId])).rows[0];
    if (!e) return res.status(404).json({ success: false, message: 'Active employee not found' });
    const existing = (await db.query(`SELECT id FROM studio_members WHERE emp_id=$1`, [empId])).rows[0];
    if (existing) {
      await db.query(`UPDATE studio_members SET status='Active', role=$1, name=$2 WHERE id=$3`, [role, e.name, existing.id]);
    } else {
      await db.query(`INSERT INTO studio_members (member_type, emp_id, name, role, created_by) VALUES ('employee',$1,$2,$3,$4)`, [empId, e.name, role, req.studio.name]);
    }
    res.json({ success: true, message: `${e.name} now has access to Gee Bharat Studio.` });
  } catch (err) {
    console.error('[studio add employee]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function tempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), b => chars[b % chars.length]).join('');
}

router.post('/members/guest', studioAuth(), managerOnly, async (req, res) => {
  const name = clean(req.body.name);
  const email = clean(req.body.email).toLowerCase();
  const mobile = clean(req.body.mobile);
  const role = ['Presenter', 'Writer'].includes(req.body.role) ? req.body.role : 'Presenter';
  if (!name || (!email && !mobile)) return res.status(400).json({ success: false, message: 'Please enter the name and an email or mobile number.' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
  const loginId = (email || mobile).toLowerCase();
  try {
    const dup = await db.runWithTenant({ bypassTenant: true }, () => db.query(`SELECT id FROM studio_members WHERE LOWER(login_id)=$1`, [loginId]));
    if (dup.rows.length) return res.status(409).json({ success: false, message: 'This login ID is already in use.' });
    const pw = tempPassword();
    await db.query(
      `INSERT INTO studio_members (member_type, name, mobile, email, login_id, password_hash, must_change_password, role, created_by)
       VALUES ('guest',$1,$2,$3,$4,$5,TRUE,$6,$7)`,
      [name, mobile || null, email || null, loginId, await hashPassword(pw), role, req.studio.name]);
    let emailed = false;
    if (email) {
      try {
        await sendEmail({
          to: email,
          subject: 'You have been given access to Gee Bharat Studio',
          html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:540px;color:#1e293b;line-height:1.55;">
            <p>Dear ${esc(name)},</p>
            <p>You have been given access to <strong>Gee Bharat Studio</strong>, where you will find the topics and scripts assigned to you.</p>
            <table style="border-collapse:collapse;margin:12px 0;"><tr><td style="padding:6px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600;">Login ID</td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${esc(loginId)}</td></tr>
            <tr><td style="padding:6px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:600;">Temporary password</td><td style="padding:6px 12px;border:1px solid #e2e8f0;">${esc(pw)}</td></tr></table>
            <p><a href="${APP_URL}/studio.html" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Open Gee Bharat Studio</a></p>
            <p>You will be asked to choose a new password when you first sign in.</p>
            <p style="font-size:12px;color:#94a3b8;">This is an automated message.</p></div>`,
          text: `Dear ${name}, you now have access to Gee Bharat Studio: ${APP_URL}/studio.html  Login ID: ${loginId}  Temporary password: ${pw}`,
        });
        emailed = true;
      } catch (e) { console.error('[studio guest email]', e.message); }
    }
    res.json({ success: true, message: `${name} has been added.`, login_id: loginId, temp_password: pw, emailed });
  } catch (err) {
    console.error('[studio add guest]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/members/:id', studioAuth(), managerOnly, async (req, res) => {
  try {
    const cur = (await db.query(`SELECT * FROM studio_members WHERE id=$1`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ success: false, message: 'Member not found' });
    const sets = [], vals = [];
    if (['Presenter', 'Writer'].includes(req.body.role)) { vals.push(req.body.role); sets.push(`role=$${vals.length}`); }
    if (['Active', 'Disabled'].includes(req.body.status)) { vals.push(req.body.status); sets.push(`status=$${vals.length}`); }
    let newPw = null;
    if (req.body.reset_password && cur.member_type === 'guest') {
      newPw = tempPassword();
      vals.push(await hashPassword(newPw)); sets.push(`password_hash=$${vals.length}`, `must_change_password=TRUE`);
    }
    if (!sets.length) return res.json({ success: true });
    vals.push(cur.id);
    await db.query(`UPDATE studio_members SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
    res.json({ success: true, message: 'Updated.', temp_password: newPw });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

module.exports = router;
module.exports.FEATURE_KEY = FEATURE_KEY;
