const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const {
  buildLoginResponse,
  selectOrganization,
  hashForStorage,
} = require('../services/authService');
const { verifyPassword } = require('../utils/passwords');
const { sendEmail } = require('../utils/email');
const {
  refreshSession,
  validateSession,
  revokeSession,
  revokeUserSessions,
  parseCookies,
  setRefreshCookie,
  clearRefreshCookie,
} = require('../services/sessionService');

const router = express.Router();

function sendLoginResponse(res, result, mode) {
  if (result.requires_selection) {
    return res.json({
      success: true,
      requires_selection: true,
      selection_token: result.selection_token,
      choices: result.choices,
    });
  }

  setRefreshCookie(res, result.refresh_token);
  if (mode === 'employee') {
    return res.json({
      success: true,
      token: result.token,
      employee: {
        emp_id: result.user.emp_id,
        name: result.user.name,
        formal_name: result.user.formal_name,
        designation: result.user.designation,
        organization_code: result.user.organization_code,
        organization_name: result.user.organization_name,
        read_only: result.user.read_only,
      },
      user: result.user,
    });
  }

  return res.json({ success: true, token: result.token, user: result.user });
}

function handleLoginError(res, err) {
  console.error('Login error:', err.message);
  return res.status(err.statusCode || 500).json({
    success: false,
    message: err.statusCode ? err.message : 'Server error',
  });
}

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '');
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
  firebaseCertCache = {
    expiresAt: Date.now() + (maxAge * 1000),
    certs: await response.json()
  };
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

async function findResetCandidates(identifier) {
  const login = String(identifier || '').trim();
  const mobile = normalizeMobile(login);
  return db.runWithTenant({ bypassTenant: true }, async () => {
    const admins = await db.query(
      `SELECT 'admin' AS user_type, a.id, a.username AS login_id, a.name, a.email_id, a.mobile_no,
              o.id AS organization_id, o.office_name, o.status
       FROM admins a JOIN organizations o ON o.id=a.organization_id
       WHERE COALESCE(a.status,'Active')='Active'
         AND (lower(trim(a.username))=lower(trim($1)) OR lower(trim(coalesce(a.email_id,'')))=lower(trim($1))
              OR ($2 <> '' AND regexp_replace(coalesce(a.mobile_no,''), '[^0-9]', '', 'g')=$2))`,
      [login, mobile]
    );
    const employees = await db.query(
      `SELECT 'employee' AS user_type, e.id, e.emp_id AS login_id, COALESCE(e.formal_name,e.name) AS name,
              e.email_id, e.mobile_no, o.id AS organization_id, o.office_name, o.status
       FROM emplist e JOIN organizations o ON o.id=e.organization_id
       WHERE e.status='Active'
         AND (lower(trim(e.emp_id))=lower(trim($1)) OR lower(trim(coalesce(e.email_id,'')))=lower(trim($1))
              OR ($2 <> '' AND regexp_replace(coalesce(e.mobile_no,''), '[^0-9]', '', 'g')=$2))`,
      [login, mobile]
    );
    return [...admins.rows, ...employees.rows].filter(r => r.status === 'Active');
  });
}

async function sendResetEmail(to, code, account) {
  const html = `<p>Your password reset OTP is:</p><h2>${code}</h2><p>This code expires in 10 minutes.</p><p>Office: ${account.office_name}</p>`;
  return sendEmail({
    to,
    subject: 'Password reset OTP',
    html,
  });
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const loginId = req.body.login_id || req.body.emp_id || req.body.username;
  const { password } = req.body;

  if (!loginId || !password) {
    return res.status(400).json({ success: false, message: 'Login ID and Password required' });
  }

  try {
    const result = await buildLoginResponse(loginId, password, 'employee', req);
    return sendLoginResponse(res, result, 'employee');
  } catch (err) {
    return handleLoginError(res, err);
  }
});

// POST /api/auth/office-login
router.post('/office-login', async (req, res) => {
  const loginId = req.body.login_id || req.body.username || req.body.emp_id;
  const { password } = req.body;

  if (!loginId || !password) {
    return res.status(400).json({ success: false, message: 'Login ID and password required' });
  }

  try {
    const result = await buildLoginResponse(loginId, password, 'all', req);
    return sendLoginResponse(res, result, 'all');
  } catch (err) {
    return handleLoginError(res, err);
  }
});

// POST /api/auth/select-organization
router.post('/select-organization', async (req, res) => {
  const { selection_token, account_key } = req.body;
  if (!selection_token || !account_key) {
    return res.status(400).json({ success: false, message: 'Organisation selection required' });
  }

  try {
    const result = await selectOrganization(selection_token, account_key, req);
    setRefreshCookie(res, result.refresh_token);
    return res.json({ success: true, token: result.token, user: result.user });
  } catch (err) {
    return handleLoginError(res, err);
  }
});

router.post('/forgot-password', async (req, res) => {
  const { login_id, channel = 'email' } = req.body;
  if (!login_id) return res.status(400).json({ success: false, message: 'Login ID, email or mobile required' });

  try {
    const candidates = await findResetCandidates(login_id);
    const selected = candidates.filter(c => channel === 'mobile' ? c.mobile_no : c.email_id);
    if (channel === 'mobile') {
      return res.json({ success: true, message: 'Mobile OTP will be sent by Firebase.' });
    }
    if (!selected.length) {
      return res.json({ success: true, message: 'If account exists, password reset OTP has been sent.' });
    }
    const emailErrors = [];
    for (const account of selected) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const codeHash = await hashForStorage(code);
      try {
        await sendResetEmail(account.email_id, code, account);
        await db.runWithTenant({ bypassTenant: true }, () => db.query(
          `INSERT INTO password_reset_tokens
            (organization_id, user_type, user_ref_id, login_id, channel, destination, code_hash, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '10 minutes')`,
          [account.organization_id, account.user_type, account.id, account.login_id, 'email', account.email_id, codeHash]
        ));
      } catch (err) {
        console.error('[forgot-password email]', err.message);
        emailErrors.push(err.message);
      }
    }
    if (emailErrors.length && emailErrors.length === selected.length) {
      return res.status(502).json({ success: false, message: emailErrors[0] || 'Email OTP send failed' });
    }
    res.json({ success: true, message: 'If account exists, password reset OTP has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Password reset request failed' });
  }
});

router.get('/firebase-config', (req, res) => {
  if (!process.env.FIREBASE_WEB_API_KEY || !process.env.FIREBASE_PROJECT_ID) {
    return res.status(404).json({ success: false, message: 'Firebase OTP is not configured' });
  }
  res.json({
    success: true,
    config: {
      apiKey: process.env.FIREBASE_WEB_API_KEY,
      authDomain: `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
      projectId: process.env.FIREBASE_PROJECT_ID,
    }
  });
});

router.post('/reset-password', async (req, res) => {
  const { login_id, code, new_password, channel = 'email', firebase_id_token } = req.body;
  if (!login_id || !new_password || (channel === 'email' && !code) || (channel === 'mobile' && !firebase_id_token)) {
    return res.status(400).json({ success: false, message: 'Login ID, verification and new password required' });
  }
  try {
    if (channel === 'mobile') {
      const firebaseUser = await verifyFirebaseIdToken(firebase_id_token);
      const verifiedMobile = normalizeMobile(firebaseUser.phone_number);
      const candidates = await findResetCandidates(login_id);
      const matches = candidates.filter(account => normalizeMobile(account.mobile_no).endsWith(verifiedMobile.slice(-10)));
      if (!matches.length) return res.status(400).json({ success: false, message: 'Verified mobile does not match this account' });
      const passwordHash = await hashForStorage(new_password);
      await db.runWithTenant({ bypassTenant: true }, async () => {
        for (const account of matches) {
          if (account.user_type === 'admin') {
            await db.query(`UPDATE admins SET password=$1, updated_at=NOW() WHERE id=$2 AND organization_id=$3`, [passwordHash, account.id, account.organization_id]);
          } else {
            await db.query(`UPDATE emplist SET login_password=$1 WHERE id=$2 AND organization_id=$3`, [passwordHash, account.id, account.organization_id]);
          }
          await revokeUserSessions(account.organization_id, account.user_type, account.id, 'Password reset');
        }
      });
      return res.json({ success: true, message: 'Password reset successful. Please login again.' });
    }

    const rows = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT * FROM password_reset_tokens
       WHERE (lower(trim(login_id))=lower(trim($1)) OR lower(trim(destination))=lower(trim($1)))
         AND channel=$2 AND used_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 10`,
      [String(login_id).trim(), channel]
    ));
    let tokenRow = null;
    for (const row of rows.rows) {
      if (await verifyPassword(code, row.code_hash)) { tokenRow = row; break; }
    }
    if (!tokenRow) return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    const passwordHash = await hashForStorage(new_password);
    await db.runWithTenant({ bypassTenant: true }, async () => {
      if (tokenRow.user_type === 'admin') {
        await db.query(`UPDATE admins SET password=$1, updated_at=NOW() WHERE id=$2 AND organization_id=$3`, [passwordHash, tokenRow.user_ref_id, tokenRow.organization_id]);
      } else {
        await db.query(`UPDATE emplist SET login_password=$1 WHERE id=$2 AND organization_id=$3`, [passwordHash, tokenRow.user_ref_id, tokenRow.organization_id]);
      }
      await revokeUserSessions(tokenRow.organization_id, tokenRow.user_type, tokenRow.user_ref_id, 'Password reset');
      await db.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE id=$1`, [tokenRow.id]);
    });
    res.json({ success: true, message: 'Password reset successful. Please login again.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Password reset failed' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const result = await refreshSession(req);
    setRefreshCookie(res, result.refresh_token);
    return res.json({ success: true, token: result.token, user: result.user });
  } catch (err) {
    clearRefreshCookie(res);
    return res.status(err.statusCode || 401).json({
      success: false,
      message: err.message || 'Session expired. Please login again.',
    });
  }
});

router.get('/sessions', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: 'Login required' });
  }
  if (!decoded.organization_id || !decoded.id || !decoded.user_type) {
    return res.status(401).json({ success: false, message: 'Invalid session' });
  }
  if (!(await validateSession(decoded)).valid) {
    return res.status(401).json({ success: false, message: 'Session expired or logged out' });
  }
  const sessions = await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `SELECT id, user_agent, ip_address, created_at, last_seen_at, expires_at,
            CASE WHEN id=$4 THEN TRUE ELSE FALSE END AS current_session
       FROM auth_sessions
      WHERE organization_id=$1 AND user_type=$2 AND user_ref_id=$3 AND revoked_at IS NULL
        AND expires_at > NOW()
      ORDER BY last_seen_at DESC`,
    [decoded.organization_id, decoded.user_type, decoded.id, decoded.sid || null]
  ));
  return res.json({ success: true, sessions: sessions.rows });
});

router.post('/logout-all', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    clearRefreshCookie(res);
    return res.status(401).json({ success: false, message: 'Login required' });
  }
  if (!(await validateSession(decoded)).valid) {
    clearRefreshCookie(res);
    return res.status(401).json({ success: false, message: 'Session expired or logged out' });
  }
  await revokeUserSessions(
    decoded.organization_id,
    decoded.user_type,
    decoded.id,
    'Logout from all devices'
  );
  clearRefreshCookie(res);
  return res.json({ success: true, message: 'Logged out from all devices' });
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const refreshToken = parseCookies(req).gb_refresh_token;
  let decoded = {};
  if (token) {
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch {}
    const runner = decoded.organization_id
      ? db.runWithTenant({ organizationId: decoded.organization_id }, () => db.query(
          `UPDATE attendance_sessions SET status='Inactive' WHERE session_token=$1`,
          [token.slice(-24)]
        ))
      : Promise.resolve();
    await runner.catch(() => {});
  }
  await revokeSession({
    sessionId: decoded.sid || null,
    refreshToken,
    reason: 'User logout',
  }).catch(() => {});
  clearRefreshCookie(res);
  res.json({ success: true, message: 'Logged out' });
});

module.exports = router;
