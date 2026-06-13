const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const db = require('../db');

const ACCESS_TTL = process.env.AUTH_ACCESS_TTL || '30m';
const REFRESH_DAYS = Math.max(1, Number(process.env.AUTH_REFRESH_DAYS || 7));
const INACTIVITY_HOURS = Math.max(1, Number(process.env.AUTH_INACTIVITY_HOURS || 12));
const COOKIE_NAME = 'gb_refresh_token';

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function accessToken(payload, sessionId) {
  return jwt.sign({ ...payload, sid: sessionId }, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL });
}

function requestIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .split(',')[0]
    .trim()
    .slice(0, 80);
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').reduce((out, item) => {
    const index = item.indexOf('=');
    if (index < 0) return out;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
    return out;
  }, {});
}

function setRefreshCookie(res, refreshToken) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const maxAge = REFRESH_DAYS * 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(refreshToken)}; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

function clearRefreshCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=0${secure}`
  );
}

async function createSession(payload, req) {
  const id = randomUUID();
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `INSERT INTO auth_sessions
       (id, organization_id, user_type, user_ref_id, login_id, refresh_token_hash,
        user_agent, ip_address, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()+($9 || ' days')::interval)`,
    [
      id,
      payload.organization_id,
      payload.user_type,
      payload.id,
      payload.emp_id || payload.username,
      hashToken(refreshToken),
      String(req?.headers?.['user-agent'] || '').slice(0, 1000),
      requestIp(req || { headers: {} }),
      String(REFRESH_DAYS),
    ]
  ));
  return { access_token: accessToken(payload, id), refresh_token: refreshToken, session_id: id };
}

async function currentUserForSession(session) {
  return db.runWithTenant({ bypassTenant: true }, async () => {
    const result = session.user_type === 'admin'
      ? await db.query(
        `SELECT a.id, a.username, a.name, a.email_id, a.role,
                COALESCE(a.status,'Active') AS user_status,
                o.id AS organization_id, o.org_code AS organization_code,
                o.office_name AS organization_name, o.status AS org_status,
                o.valid_until, o.force_read_only
           FROM admins a
           JOIN organizations o ON o.id=a.organization_id
          WHERE a.id=$1 AND a.organization_id=$2`,
        [session.user_ref_id, session.organization_id]
      )
      : await db.query(
        `SELECT e.id, e.emp_id, e.name, e.formal_name, e.email_id,
                e.designation AS role, e.status AS user_status,
                o.id AS organization_id, o.org_code AS organization_code,
                o.office_name AS organization_name, o.status AS org_status,
                o.valid_until, o.force_read_only
           FROM emplist e
           JOIN organizations o ON o.id=e.organization_id
          WHERE e.id=$1 AND e.organization_id=$2`,
        [session.user_ref_id, session.organization_id]
      );
    return result.rows[0] || null;
  });
}

function readOnly(row) {
  if (row.force_read_only) return true;
  if (!row.valid_until) return false;
  return String(row.valid_until).slice(0, 10) < new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

function payloadFromRow(row, userType) {
  if (userType === 'admin') {
    return {
      id: row.id,
      emp_id: row.username,
      username: row.username,
      name: row.name,
      email_id: row.email_id || null,
      role: row.role,
      user_type: 'admin',
      is_admin: true,
      organization_id: row.organization_id,
      organization_code: row.organization_code,
      organization_name: row.organization_name,
      read_only: readOnly(row),
    };
  }
  return {
    id: row.id,
    emp_id: row.emp_id,
    name: row.name,
    formal_name: row.formal_name,
    email_id: row.email_id || null,
    designation: row.role,
    role: row.role,
    user_type: 'employee',
    organization_id: row.organization_id,
    organization_code: row.organization_code,
    organization_name: row.organization_name,
    read_only: readOnly(row),
  };
}

async function refreshSession(req) {
  const rawToken = parseCookies(req)[COOKIE_NAME];
  if (!rawToken) {
    const error = new Error('Refresh session not found');
    error.statusCode = 401;
    throw error;
  }

  return db.runWithTenant({ bypassTenant: true }, async () => {
    const found = await db.query(
      `SELECT *
         FROM auth_sessions
        WHERE refresh_token_hash=$1
          AND revoked_at IS NULL
          AND expires_at > NOW()
          AND last_seen_at > NOW()-($2 || ' hours')::interval
        LIMIT 1`,
      [hashToken(rawToken), String(INACTIVITY_HOURS)]
    );
    const session = found.rows[0];
    if (!session) {
      const error = new Error('Session expired. Please login again.');
      error.statusCode = 401;
      throw error;
    }

    const row = await currentUserForSession(session);
    if (!row || row.user_status !== 'Active' || row.org_status !== 'Active') {
      await db.query(
        `UPDATE auth_sessions SET revoked_at=NOW(), revoke_reason='Account inactive' WHERE id=$1`,
        [session.id]
      );
      const error = new Error('Account is not active. Please contact administrator.');
      error.statusCode = 403;
      throw error;
    }

    const nextRefresh = crypto.randomBytes(48).toString('base64url');
    await db.query(
      `UPDATE auth_sessions
          SET refresh_token_hash=$1, last_seen_at=NOW(), user_agent=$2, ip_address=$3
        WHERE id=$4`,
      [
        hashToken(nextRefresh),
        String(req.headers['user-agent'] || '').slice(0, 1000),
        requestIp(req),
        session.id,
      ]
    );
    const payload = payloadFromRow(row, session.user_type);
    return {
      token: accessToken(payload, session.id),
      refresh_token: nextRefresh,
      user: payload,
    };
  });
}

async function validateSession(decoded) {
  if (!decoded.sid) return { valid: true, legacy: true };
  const result = await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `SELECT id, organization_id, user_type, user_ref_id
       FROM auth_sessions
      WHERE id=$1 AND organization_id=$2 AND revoked_at IS NULL
        AND expires_at > NOW()
        AND last_seen_at > NOW()-($3 || ' hours')::interval`,
    [decoded.sid, decoded.organization_id, String(INACTIVITY_HOURS)]
  ));
  if (!result.rows.length) return { valid: false };
  await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `UPDATE auth_sessions
        SET last_seen_at=NOW()
      WHERE id=$1 AND last_seen_at < NOW()-INTERVAL '5 minutes'`,
    [decoded.sid]
  ));
  return { valid: true, session: result.rows[0] };
}

async function revokeSession({ sessionId, refreshToken, reason = 'Logout' }) {
  if (!sessionId && !refreshToken) return;
  await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `UPDATE auth_sessions
        SET revoked_at=COALESCE(revoked_at,NOW()), revoke_reason=COALESCE(revoke_reason,$1)
      WHERE ($2::uuid IS NOT NULL AND id=$2)
         OR ($3::text IS NOT NULL AND refresh_token_hash=$3)`,
    [reason, sessionId || null, refreshToken ? hashToken(refreshToken) : null]
  ));
}

async function revokeUserSessions(organizationId, userType, userRefId, reason) {
  await db.runWithTenant({ bypassTenant: true }, () => db.query(
    `UPDATE auth_sessions
        SET revoked_at=COALESCE(revoked_at,NOW()), revoke_reason=COALESCE(revoke_reason,$4)
      WHERE organization_id=$1 AND user_type=$2 AND user_ref_id=$3 AND revoked_at IS NULL`,
    [organizationId, userType, userRefId, reason || 'Sessions revoked']
  ));
}

module.exports = {
  createSession,
  refreshSession,
  validateSession,
  revokeSession,
  revokeUserSessions,
  parseCookies,
  setRefreshCookie,
  clearRefreshCookie,
};
