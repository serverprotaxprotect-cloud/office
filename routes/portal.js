const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const portalAuth = require('../middleware/portalAuth');
const { verifyPassword, hashPassword, isBcryptHash } = require('../utils/passwords');
const { sendEmail } = require('../utils/email');
const { organizationReadOnly } = require('../services/authService');

const router = express.Router();
const loginAttempts = new Map();

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '');
}

function rateLimit(key, limit = 8, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const bucket = loginAttempts.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  loginAttempts.set(key, bucket);
  return bucket.count <= limit;
}

function decodeJwtPart(part) {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

let firebaseCertCache = { expiresAt: 0, certs: {} };

async function getFirebaseCerts() {
  if (Date.now() < firebaseCertCache.expiresAt && Object.keys(firebaseCertCache.certs).length) {
    return firebaseCertCache.certs;
  }
  const response = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!response.ok) throw new Error('Firebase cert fetch failed');
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 3600);
  firebaseCertCache = { expiresAt: Date.now() + (maxAge * 1000), certs: await response.json() };
  return firebaseCertCache.certs;
}

async function verifyFirebaseIdToken(idToken) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('Firebase project not configured');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid Firebase token');
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  const certs = await getFirebaseCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error('Unknown Firebase token key');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const ok = verifier.verify(cert, parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!ok) throw new Error('Invalid Firebase token signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error('Invalid Firebase audience');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Invalid Firebase issuer');
  if (!payload.sub || payload.exp <= now || payload.iat > now + 60) throw new Error('Expired Firebase token');
  if (!payload.phone_number) throw new Error('Firebase phone number missing');
  return payload;
}

function publicChoice(candidate) {
  return {
    account_key: candidate.account_key,
    account_type: candidate.account_type,
    organization_id: candidate.organization_id,
    organization_code: candidate.organization_code,
    organization_name: candidate.organization_name,
    display_name: candidate.display_name,
    login_id: candidate.login_id,
    read_only: organizationReadOnly(candidate),
  };
}

function portalPayload(candidate) {
  const readOnly = organizationReadOnly(candidate);
  const base = {
    purpose: 'portal_session',
    account_type: candidate.account_type,
    organization_id: candidate.organization_id,
    organization_code: candidate.organization_code,
    organization_name: candidate.organization_name,
    display_name: candidate.display_name,
    login_id: candidate.login_id,
    read_only: readOnly,
  };
  if (candidate.account_type === 'client') {
    base.client_id = candidate.client_id;
  } else {
    base.agent_id = candidate.agent_id;
  }
  return base;
}

function signPortal(candidate) {
  const payload = portalPayload(candidate);
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
  return { token, user: payload };
}

function signSelection(candidates) {
  return jwt.sign({
    purpose: 'portal_select',
    candidates: candidates.map(c => ({
      account_key: c.account_key,
      account_type: c.account_type,
      organization_id: c.organization_id,
      client_id: c.client_id || null,
      agent_id: c.agent_id || null,
    })),
  }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

async function getPortalCandidates(identifier, accountType = 'client', options = {}) {
  const login = normalizeIdentifier(identifier);
  const mobile = normalizeMobile(login);
  const type = accountType === 'agent' ? 'agent' : 'client';
  const requireEnabled = options.requireEnabled !== false;
  return db.runWithTenant({ bypassTenant: true }, async () => {
    if (type === 'agent') {
      const result = await db.query(
        `SELECT
           'agent:' || a.organization_id || ':' || a.agent_id AS account_key,
           'agent' AS account_type,
           a.agent_id,
           a.agent_id AS login_id,
           a.name AS display_name,
           a.mobile_number,
           a.email_id,
           a.portal_password_hash AS password_hash,
           COALESCE(a.portal_enabled,false) AS portal_enabled,
           o.id AS organization_id,
           o.org_code AS organization_code,
           o.office_name AS organization_name,
           o.status AS org_status,
           o.valid_until,
           o.force_read_only
         FROM agents a
         JOIN organizations o ON o.id=a.organization_id
         WHERE lower(a.agent_id)=lower($1)
            OR lower(coalesce(a.email_id,''))=lower($1)
            OR regexp_replace(coalesce(a.mobile_number,''), '[^0-9]', '', 'g')=$2`,
        [login, mobile]
      );
      return result.rows.filter(r => r.org_status === 'Active' && (!requireEnabled || r.portal_enabled));
    }

    const result = await db.query(
      `SELECT
         'client:' || c.organization_id || ':' || c.client_id AS account_key,
         'client' AS account_type,
         c.client_id,
         c.client_id AS login_id,
         COALESCE(c.legal_name,c.business_name,c.client_id) AS display_name,
         c.mobile_number,
         c.email_id,
         c.portal_password_hash AS password_hash,
         COALESCE(c.portal_enabled,false) AS portal_enabled,
         o.id AS organization_id,
         o.org_code AS organization_code,
         o.office_name AS organization_name,
         o.status AS org_status,
         o.valid_until,
         o.force_read_only
       FROM clients c
       JOIN organizations o ON o.id=c.organization_id
       WHERE lower(c.client_id)=lower($1)
          OR lower(coalesce(c.email_id,''))=lower($1)
          OR regexp_replace(coalesce(c.mobile_number,''), '[^0-9]', '', 'g')=$2`,
      [login, mobile]
    );
    return result.rows.filter(r => r.org_status === 'Active' && (!requireEnabled || r.portal_enabled));
  });
}

function portalAccountRef(account) {
  return account.account_type === 'agent' ? account.agent_id : account.client_id;
}

async function updatePortalPassword(account, passwordHash) {
  return db.runWithTenant({ bypassTenant: true }, async () => {
    if (account.account_type === 'agent') {
      await db.query(
        `UPDATE agents
         SET portal_password_hash=$1, portal_enabled=true, portal_password_changed_at=NOW()
         WHERE organization_id=$2 AND agent_id=$3`,
        [passwordHash, account.organization_id, account.agent_id]
      );
      return;
    }
    await db.query(
      `UPDATE clients
       SET portal_password_hash=$1, portal_enabled=true, portal_password_changed_at=NOW()
       WHERE organization_id=$2 AND client_id=$3`,
      [passwordHash, account.organization_id, account.client_id]
    );
  });
}

async function rehashLegacyPortalPassword(account, plainPassword) {
  if (!account.password_hash || isBcryptHash(account.password_hash)) return;
  const passwordHash = await hashPassword(plainPassword);
  await updatePortalPassword(account, passwordHash);
  account.password_hash = passwordHash;
  account.portal_enabled = true;
}

async function getCandidateFromSelection(selectionToken, accountKey) {
  let decoded;
  try {
    decoded = jwt.verify(selectionToken, process.env.JWT_SECRET);
  } catch {
    const err = new Error('Selection expired. Please login again.');
    err.statusCode = 401;
    throw err;
  }
  if (decoded.purpose !== 'portal_select') {
    const err = new Error('Invalid selection token');
    err.statusCode = 400;
    throw err;
  }
  const selected = decoded.candidates.find(c => c.account_key === accountKey);
  if (!selected) {
    const err = new Error('Invalid account selection');
    err.statusCode = 400;
    throw err;
  }
  const id = selected.account_type === 'agent' ? selected.agent_id : selected.client_id;
  const candidates = await getPortalCandidates(id, selected.account_type);
  const candidate = candidates.find(c => c.account_key === accountKey);
  if (!candidate) {
    const err = new Error('Selected account is no longer active');
    err.statusCode = 403;
    throw err;
  }
  return candidate;
}

async function finishLogin(res, matches) {
  if (!matches.length) {
    return res.status(401).json({ success: false, message: 'Incorrect login details' });
  }
  if (matches.length > 1) {
    return res.json({
      success: true,
      requires_selection: true,
      selection_token: signSelection(matches),
      choices: matches.map(publicChoice),
    });
  }
  const signed = signPortal(matches[0]);
  const table = matches[0].account_type === 'agent' ? 'agents' : 'clients';
  const idColumn = matches[0].account_type === 'agent' ? 'agent_id' : 'client_id';
  const idValue = matches[0].account_type === 'agent' ? matches[0].agent_id : matches[0].client_id;
  await db.runWithTenant({ organizationId: matches[0].organization_id }, () => db.query(
    `UPDATE ${table} SET portal_last_login_at=NOW() WHERE ${idColumn}=$1 AND organization_id=$2`,
    [idValue, matches[0].organization_id]
  )).catch(() => {});
  return res.json({ success: true, token: signed.token, user: signed.user });
}

async function sendPortalEmail(to, code, account, subject = 'Gee Bharat portal OTP') {
  const text = `Your Gee Bharat portal OTP is ${code}. This code expires in 10 minutes. Office: ${account.organization_name}`;
  return sendEmail({
    to,
    subject,
    html: `<p>Your Gee Bharat portal OTP is:</p><h2>${code}</h2><p>This code expires in 10 minutes.</p><p>Office: ${account.organization_name}</p>`,
    text,
  });
}

async function sendPortalOtp({ accountType, loginId, purpose, subject }) {
  const candidates = await getPortalCandidates(loginId, accountType, { requireEnabled: purpose === 'login' });
  if (!candidates.length) {
    const err = new Error(purpose === 'login'
      ? 'Portal access is not enabled for this login ID.'
      : 'Client/agent account not found for this login ID.');
    err.statusCode = 404;
    throw err;
  }

  const recipients = candidates.filter(c => c.email_id);
  if (!recipients.length) {
    const err = new Error('Email is not registered for this portal account.');
    err.statusCode = 400;
    throw err;
  }

  const emailErrors = [];
  let sent = 0;
  for (const account of recipients) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await hashPassword(code);
    try {
      await sendPortalEmail(account.email_id, code, account, subject);
      await db.runWithTenant({ bypassTenant: true }, () => db.query(
        `INSERT INTO portal_reset_tokens
          (organization_id, account_type, account_ref_id, login_id, purpose, channel, destination, code_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,'email',$6,$7,NOW()+INTERVAL '10 minutes')`,
        [
          account.organization_id,
          account.account_type,
          portalAccountRef(account),
          account.login_id,
          purpose,
          account.email_id,
          codeHash,
        ]
      ));
      sent += 1;
    } catch (err) {
      console.error('[portal email otp]', err.message);
      emailErrors.push(err.message);
    }
  }

  if (!sent) {
    const err = new Error(emailErrors[0] || 'Email OTP send failed');
    err.statusCode = 502;
    throw err;
  }

  return {
    sent,
    message: purpose === 'login'
      ? 'OTP sent to registered email.'
      : 'Password reset OTP sent to registered email.',
  };
}

function statusBucket(status) {
  const s = String(status || '').toLowerCase();
  if (['completed', 'complete', 'filed', 'done', 'not applicable'].includes(s)) return 'completed';
  if (s.includes('pending by client') || s.includes('client')) return 'client_pending';
  if (s.includes('progress') || s.includes('process') || s.includes('review')) return 'in_progress';
  if (s.includes('cancel')) return 'cancelled';
  return 'pending';
}

function publicTask(row) {
  return {
    task_id: row.task_id,
    client_id: row.client_id,
    client_name: row.client_name,
    work_name: row.work_name,
    work_description: row.client_pending_remark || null,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date,
    start_date: row.start_date,
    completion_date: row.completion_date,
    last_updated_at: row.last_updated_at,
  };
}

function clientScope(req) {
  if (req.portalUser.account_type === 'client') {
    return { sql: 'organization_id=$1 AND client_id=$2', params: [req.portalUser.organization_id, req.portalUser.client_id] };
  }
  return {
    sql: `organization_id=$1 AND client_id IN (SELECT client_id FROM clients WHERE organization_id=$1 AND agent_id=$2)`,
    params: [req.portalUser.organization_id, req.portalUser.agent_id],
  };
}

router.post('/login', async (req, res) => {
  const { account_type = 'client', login_id, password, selection_token, account_key } = req.body;
  if (!rateLimit(`login:${account_type}:${normalizeIdentifier(login_id || account_key)}`)) {
    return res.status(429).json({ success: false, message: 'Too many attempts. Please try later.' });
  }
  try {
    if (selection_token && account_key) {
      const candidate = await getCandidateFromSelection(selection_token, account_key);
      return finishLogin(res, [candidate]);
    }
    if (!login_id || !password) {
      return res.status(400).json({ success: false, message: 'Login ID and password required' });
    }
    const candidates = await getPortalCandidates(login_id, account_type, { requireEnabled: false });
    const loginReadyCandidates = candidates.filter(candidate => candidate.portal_enabled && candidate.password_hash);
    if (candidates.length && !loginReadyCandidates.length) {
      return res.status(403).json({
        success: false,
        message: 'Portal access/password is not set. Use Forgot password to create a portal password first.',
      });
    }
    const matches = [];
    for (const candidate of loginReadyCandidates) {
      if (await verifyPassword(password, candidate.password_hash)) {
        await rehashLegacyPortalPassword(candidate, password);
        matches.push(candidate);
      }
    }
    return finishLogin(res, matches);
  } catch (err) {
    console.error('[portal login]', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.statusCode ? err.message : 'Portal login failed' });
  }
});

router.post('/otp/request', async (req, res) => {
  const { account_type = 'client', login_id, channel = 'email' } = req.body;
  if (!login_id) return res.status(400).json({ success: false, message: 'Login ID, email or mobile required' });
  if (!rateLimit(`otp:${account_type}:${normalizeIdentifier(login_id)}`, 5)) {
    return res.status(429).json({ success: false, message: 'Too many OTP attempts. Please try later.' });
  }
  try {
    if (channel === 'mobile') {
      return res.json({ success: true, message: 'Mobile OTP will be sent by Firebase.' });
    }
    const result = await sendPortalOtp({
      accountType: account_type,
      loginId: login_id,
      purpose: 'login',
      subject: 'Gee Bharat portal login OTP',
    });
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('[portal otp request]', err);
    return res.status(err.statusCode || 502).json({ success: false, message: err.statusCode ? err.message : 'OTP send failed' });
  }
});

router.post('/otp/verify', async (req, res) => {
  const { account_type = 'client', login_id, code, channel = 'email', firebase_id_token } = req.body;
  if (!login_id) return res.status(400).json({ success: false, message: 'Login ID, email or mobile required' });
  try {
    const candidates = await getPortalCandidates(login_id, account_type);
    let matches = [];
    if (channel === 'mobile') {
      const firebaseUser = await verifyFirebaseIdToken(firebase_id_token);
      const verifiedMobile = normalizeMobile(firebaseUser.phone_number).slice(-10);
      matches = candidates.filter(c => normalizeMobile(c.mobile_number).endsWith(verifiedMobile));
    } else {
      const rows = await db.runWithTenant({ bypassTenant: true }, () => db.query(
        `SELECT * FROM portal_reset_tokens
         WHERE purpose='login' AND account_type=$1
           AND (lower(trim(login_id))=lower(trim($2)) OR lower(trim(destination))=lower(trim($2)))
           AND channel='email' AND used_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 20`,
        [account_type === 'agent' ? 'agent' : 'client', String(login_id).trim()]
      ));
      for (const row of rows.rows) {
        if (await verifyPassword(code, row.code_hash)) {
          const match = candidates.find(c => c.organization_id === row.organization_id && (c.client_id || c.agent_id) === row.account_ref_id);
          if (match) matches.push(match);
          await db.runWithTenant({ bypassTenant: true }, () => db.query('UPDATE portal_reset_tokens SET used_at=NOW() WHERE id=$1', [row.id]));
          break;
        }
      }
    }
    return finishLogin(res, matches);
  } catch (err) {
    console.error('[portal otp verify]', err);
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }
});

router.post('/forgot-password', async (req, res) => {
  const { account_type = 'client', login_id, channel = 'email' } = req.body;
  if (!login_id) return res.status(400).json({ success: false, message: 'Login ID, email or mobile required' });
  try {
    if (channel === 'mobile') return res.json({ success: true, message: 'Mobile OTP will be sent by Firebase.' });
    const result = await sendPortalOtp({
      accountType: account_type,
      loginId: login_id,
      purpose: 'reset',
      subject: 'Gee Bharat password reset OTP',
    });
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('[portal forgot password]', err);
    return res.status(err.statusCode || 502).json({ success: false, message: err.statusCode ? err.message : 'OTP send failed' });
  }
});

router.post('/reset/request', async (req, res) => {
  const { account_type = 'client', login_id, channel = 'email' } = req.body;
  if (!login_id) return res.status(400).json({ success: false, message: 'Login ID, email or mobile required' });
  try {
    if (channel === 'mobile') return res.json({ success: true, message: 'Mobile OTP will be sent by Firebase.' });
    const result = await sendPortalOtp({
      accountType: account_type,
      loginId: login_id,
      purpose: 'reset',
      subject: 'Gee Bharat password reset OTP',
    });
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('[portal reset request]', err);
    return res.status(err.statusCode || 502).json({ success: false, message: err.statusCode ? err.message : 'OTP send failed' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { account_type = 'client', login_id, code, new_password, channel = 'email', firebase_id_token } = req.body;
  if (!login_id || !new_password || (channel === 'email' && !code) || (channel === 'mobile' && !firebase_id_token)) {
    return res.status(400).json({ success: false, message: 'Login ID, verification and new password required' });
  }
  try {
    const candidates = await getPortalCandidates(login_id, account_type, { requireEnabled: false });
    let matches = [];
    if (channel === 'mobile') {
      const firebaseUser = await verifyFirebaseIdToken(firebase_id_token);
      const verifiedMobile = normalizeMobile(firebaseUser.phone_number).slice(-10);
      matches = candidates.filter(c => normalizeMobile(c.mobile_number).endsWith(verifiedMobile));
    } else {
      const rows = await db.runWithTenant({ bypassTenant: true }, () => db.query(
        `SELECT * FROM portal_reset_tokens
         WHERE purpose='reset' AND account_type=$1
           AND (lower(trim(login_id))=lower(trim($2)) OR lower(trim(destination))=lower(trim($2)))
           AND channel='email' AND used_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 20`,
        [account_type === 'agent' ? 'agent' : 'client', String(login_id).trim()]
      ));
      for (const row of rows.rows) {
        if (await verifyPassword(code, row.code_hash)) {
          const match = candidates.find(c => c.organization_id === row.organization_id && (c.client_id || c.agent_id) === row.account_ref_id);
          if (match) matches.push(match);
          await db.runWithTenant({ bypassTenant: true }, () => db.query('UPDATE portal_reset_tokens SET used_at=NOW() WHERE id=$1', [row.id]));
          break;
        }
      }
    }
    if (!matches.length) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    const passwordHash = await hashPassword(new_password);
    for (const match of matches) await updatePortalPassword(match, passwordHash);
    return res.json({ success: true, message: 'Password reset successful. Please login again.' });
  } catch (err) {
    console.error('[portal reset password]', err);
    return res.status(500).json({ success: false, message: 'Password reset failed' });
  }
});

router.post('/select-account', async (req, res) => {
  try {
    const candidate = await getCandidateFromSelection(req.body.selection_token, req.body.account_key);
    return finishLogin(res, [candidate]);
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Account selection failed' });
  }
});

router.get('/me', portalAuth, async (req, res) => {
  res.json({ success: true, user: req.portalUser });
});

router.get('/dashboard', portalAuth, async (req, res) => {
  try {
    const scope = clientScope(req);
    const taskRows = await db.query(
      `SELECT status, due_date FROM tasks WHERE active_flag=true AND ${scope.sql}`,
      scope.params
    );
    const gstRows = await db.query(
      `SELECT status FROM gst_filing_records WHERE ${scope.sql}`,
      scope.params
    ).catch(() => ({ rows: [] }));
    const itrRows = await db.query(
      `SELECT status FROM income_tax_filing_records WHERE ${scope.sql}`,
      scope.params
    ).catch(() => ({ rows: [] }));
    const today = new Date().toISOString().slice(0, 10);
    const dueSoonLimit = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const summary = {
      tasks_total: taskRows.rows.length,
      pending: taskRows.rows.filter(r => !['completed', 'cancelled'].includes(statusBucket(r.status))).length,
      completed: taskRows.rows.filter(r => statusBucket(r.status) === 'completed').length,
      due_soon: taskRows.rows.filter(r => r.due_date && String(r.due_date).slice(0, 10) >= today && String(r.due_date).slice(0, 10) <= dueSoonLimit && statusBucket(r.status) !== 'completed').length,
      overdue: taskRows.rows.filter(r => r.due_date && String(r.due_date).slice(0, 10) < today && statusBucket(r.status) !== 'completed').length,
      gst_pending: gstRows.rows.filter(r => statusBucket(r.status) !== 'completed').length,
      itr_pending: itrRows.rows.filter(r => statusBucket(r.status) !== 'completed').length,
    };
    res.json({ success: true, summary });
  } catch (err) {
    console.error('[portal dashboard]', err);
    res.status(500).json({ success: false, message: 'Dashboard load failed' });
  }
});

router.get('/profile', portalAuth, async (req, res) => {
  try {
    if (req.portalUser.account_type === 'agent') {
      const result = await db.query(
        `SELECT agent_id, name, mobile_number, email_id, portal_enabled, portal_last_login_at
         FROM agents WHERE organization_id=$1 AND agent_id=$2`,
        [req.portalUser.organization_id, req.portalUser.agent_id]
      );
      return res.json({ success: true, profile: result.rows[0] || null });
    }
    const result = await db.query(
      `SELECT c.client_id, c.agent_id, c.agent_name, c.legal_name, c.business_name,
              c.mobile_number, c.email_id, c.status, c.city, c.state, c.gst_no, c.pan_no,
              c.address, c.portal_enabled, c.portal_last_login_at
       FROM clients c WHERE c.organization_id=$1 AND c.client_id=$2`,
      [req.portalUser.organization_id, req.portalUser.client_id]
    );
    return res.json({ success: true, profile: result.rows[0] || null });
  } catch (err) {
    console.error('[portal profile]', err);
    res.status(500).json({ success: false, message: 'Profile load failed' });
  }
});

router.get('/clients', portalAuth, async (req, res) => {
  if (req.portalUser.account_type !== 'agent') return res.status(403).json({ success: false, message: 'Agent access required' });
  const q = String(req.query.search || '').trim();
    const params = [req.portalUser.organization_id, req.portalUser.agent_id];
    let searchSql = '';
    if (q) {
      params.push(`%${q}%`);
      searchSql = `AND (client_id ILIKE $3 OR legal_name ILIKE $3 OR business_name ILIKE $3 OR mobile_number ILIKE $3)`;
    }
  try {
    const result = await db.query(
      `SELECT client_id, legal_name, business_name, mobile_number, email_id, status, city, state, gst_no, pan_no
       FROM clients WHERE organization_id=$1 AND agent_id=$2 ${searchSql}
       ORDER BY COALESCE(legal_name,business_name,client_id) LIMIT 200`,
      params
    );
    res.json({ success: true, clients: result.rows });
  } catch (err) {
    console.error('[portal clients]', err);
    res.status(500).json({ success: false, message: 'Client list failed' });
  }
});

router.get('/tasks', portalAuth, async (req, res) => {
  const scope = clientScope(req);
  const status = String(req.query.status || '').trim();
  const params = [...scope.params];
  let statusSql = '';
  if (status) {
    params.push(status);
    statusSql = `AND status=$${params.length}`;
  }
  try {
    const result = await db.query(
      `SELECT task_id, client_id, COALESCE(legal_name,business_name,client_id) AS client_name,
              work_name, client_pending_remark, priority, status, due_date, start_date,
              completion_date, last_updated_at
       FROM tasks
       WHERE active_flag=true AND ${scope.sql} ${statusSql}
       ORDER BY COALESCE(due_date, created_at::date) DESC, created_at DESC
       LIMIT 500`,
      params
    );
    res.json({ success: true, tasks: result.rows.map(publicTask) });
  } catch (err) {
    console.error('[portal tasks]', err);
    res.status(500).json({ success: false, message: 'Tasks load failed' });
  }
});

router.get('/gst-filings', portalAuth, async (req, res) => {
  const scope = clientScope(req);
  try {
    const result = await db.query(
      `SELECT client_id, firm_name, gst_no, return_type, tax_year, tax_month,
              financial_year, period_label, due_date, status, filed_date_ist, last_status_at
       FROM gst_filing_records
       WHERE ${scope.sql}
       ORDER BY tax_year DESC, tax_month DESC, return_type
       LIMIT 500`,
      scope.params
    );
    res.json({ success: true, filings: result.rows });
  } catch (err) {
    console.error('[portal gst]', err);
    res.status(500).json({ success: false, message: 'GST filings load failed' });
  }
});

router.get('/income-tax-filings', portalAuth, async (req, res) => {
  const scope = clientScope(req);
  try {
    const result = await db.query(
      `SELECT client_id, taxpayer_name, pan_number, financial_year, assessment_year,
              due_date, itr_type, status, filed_date_ist, last_status_at
       FROM income_tax_filing_records
       WHERE ${scope.sql}
       ORDER BY assessment_year DESC, taxpayer_name
       LIMIT 500`,
      scope.params
    );
    res.json({ success: true, filings: result.rows });
  } catch (err) {
    console.error('[portal itr]', err);
    res.status(500).json({ success: false, message: 'Income Tax filings load failed' });
  }
});

router.get('/requests', portalAuth, async (req, res) => {
  try {
    const params = [req.portalUser.account_type, req.portalUser.organization_id];
    let where = 'account_type=$1 AND organization_id=$2';
    if (req.portalUser.account_type === 'agent') {
      params.push(req.portalUser.agent_id);
      where += ` AND agent_id=$${params.length}`;
    } else {
      params.push(req.portalUser.client_id);
      where += ` AND client_id=$${params.length}`;
    }
    const result = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT id, request_type, subject, message, status, created_at, updated_at
       FROM portal_requests WHERE ${where} ORDER BY created_at DESC LIMIT 100`,
      params
    ));
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('[portal requests]', err);
    res.status(500).json({ success: false, message: 'Requests load failed' });
  }
});

router.post('/requests', portalAuth, async (req, res) => {
  const { request_type = 'General Query', subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ success: false, message: 'Subject and message required' });
  try {
    await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `INSERT INTO portal_requests
        (organization_id, account_type, client_id, agent_id, request_type, subject, message, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Open')`,
      [
        req.portalUser.organization_id,
        req.portalUser.account_type,
        req.portalUser.client_id || null,
        req.portalUser.agent_id || null,
        request_type,
        subject,
        message,
      ]
    ));
    res.json({ success: true, message: 'Request submitted' });
  } catch (err) {
    console.error('[portal request create]', err);
    res.status(500).json({ success: false, message: 'Request submit failed' });
  }
});

module.exports = router;
