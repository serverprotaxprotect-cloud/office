const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifyPassword, hashPassword } = require('../utils/passwords');

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function normalizeMobile(value) {
  return String(value || '').replace(/\D/g, '');
}

function todayDateOnly() {
  return new Date(Date.now() + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function organizationReadOnly(org) {
  if (!org) return true;
  if (org.force_read_only) return true;
  if (org.valid_until && dateOnly(org.valid_until) < todayDateOnly()) return true;
  return false;
}

function organizationCanLogin(org) {
  return org && org.status === 'Active';
}

function publicChoice(candidate) {
  return {
    account_key: candidate.account_key,
    organization_id: candidate.organization_id,
    organization_code: candidate.organization_code,
    organization_name: candidate.organization_name,
    display_name: candidate.display_name,
    role: candidate.role,
    user_type: candidate.user_type,
    read_only: organizationReadOnly(candidate),
  };
}

function userPayload(candidate) {
  const readOnly = organizationReadOnly(candidate);
  if (candidate.user_type === 'admin') {
    return {
      id: candidate.id,
      emp_id: candidate.username,
      username: candidate.username,
      name: candidate.display_name,
      email_id: candidate.email_id || null,
      role: candidate.role,
      user_type: 'admin',
      is_admin: true,
      organization_id: candidate.organization_id,
      organization_code: candidate.organization_code,
      organization_name: candidate.organization_name,
      read_only: readOnly,
    };
  }

  return {
    id: candidate.id,
    emp_id: candidate.emp_id,
    name: candidate.name,
    formal_name: candidate.formal_name,
    designation: candidate.role,
    role: candidate.role,
    user_type: 'employee',
    organization_id: candidate.organization_id,
    organization_code: candidate.organization_code,
    organization_name: candidate.organization_name,
    read_only: readOnly,
  };
}

function signUser(candidate) {
  const payload = userPayload(candidate);
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
  return { token, payload };
}

function signSelection(candidates, mode) {
  return jwt.sign(
    {
      purpose: 'org_select',
      mode,
      candidates: candidates.map((candidate) => ({
        account_key: candidate.account_key,
        user_type: candidate.user_type,
        id: candidate.id,
        organization_id: candidate.organization_id,
      })),
    },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
}

async function getCandidates(identifier, mode = 'all') {
  return db.runWithTenant({ bypassTenant: true }, async () => {
    const login = normalizeIdentifier(identifier);
    const mobile = normalizeMobile(identifier);
    const params = [login, mobile];
    const candidates = [];

    if (mode === 'all' || mode === 'admin') {
      const admins = await db.query(
        `SELECT
           'admin:' || a.id AS account_key,
           'admin' AS user_type,
           a.id,
           a.username,
           a.password AS password_hash,
           a.name AS display_name,
           a.email_id,
           a.mobile_no,
           a.role,
           COALESCE(a.status, 'Active') AS admin_status,
           o.id AS organization_id,
           o.org_code AS organization_code,
           o.office_name AS organization_name,
           o.status AS org_status,
           o.valid_until,
           o.force_read_only
         FROM admins a
         JOIN organizations o ON o.id=a.organization_id
         WHERE lower(a.username)=lower($1)
            OR lower(coalesce(a.email_id,''))=lower($1)
            OR regexp_replace(coalesce(a.mobile_no,''), '[^0-9]', '', 'g')=$2`,
        params
      );
      candidates.push(...admins.rows);
    }

    if (mode === 'all' || mode === 'employee') {
      const employees = await db.query(
        `SELECT
           'employee:' || e.id AS account_key,
           'employee' AS user_type,
           e.id,
           e.emp_id,
           e.login_password AS password_hash,
           e.name,
           e.formal_name,
           COALESCE(e.formal_name, e.name) AS display_name,
           e.email_id,
           e.mobile_no,
           e.designation AS role,
           e.status AS employee_status,
           o.id AS organization_id,
           o.org_code AS organization_code,
           o.office_name AS organization_name,
           o.status AS org_status,
           o.valid_until,
           o.force_read_only
         FROM emplist e
         JOIN organizations o ON o.id=e.organization_id
         WHERE lower(e.emp_id)=lower($1)
            OR lower(coalesce(e.email_id,''))=lower($1)
            OR regexp_replace(coalesce(e.mobile_no,''), '[^0-9]', '', 'g')=$2`,
        params
      );
      candidates.push(...employees.rows);
    }

    return candidates.filter((candidate) => {
      if (!organizationCanLogin({ status: candidate.org_status })) return false;
      if (candidate.user_type === 'admin' && candidate.admin_status !== 'Active') return false;
      if (candidate.user_type === 'employee' && candidate.employee_status !== 'Active') return false;
      return true;
    });
  });
}

async function matchingCandidates(identifier, password, mode = 'all') {
  const candidates = await getCandidates(identifier, mode);
  const matches = [];
  for (const candidate of candidates) {
    if (await verifyPassword(password, candidate.password_hash)) {
      matches.push(candidate);
    }
  }
  return matches;
}

async function buildLoginResponse(identifier, password, mode = 'all') {
  const matches = await matchingCandidates(identifier, password, mode);
  if (!matches.length) {
    const err = new Error('Incorrect login ID or password');
    err.statusCode = 401;
    throw err;
  }

  if (matches.length > 1) {
    return {
      requires_selection: true,
      selection_token: signSelection(matches, mode),
      choices: matches.map(publicChoice),
    };
  }

  const { token, payload } = signUser(matches[0]);
  await recordSession(token, payload);
  return { requires_selection: false, token, user: payload };
}

async function selectOrganization(selectionToken, accountKey) {
  let decoded;
  try {
    decoded = jwt.verify(selectionToken, process.env.JWT_SECRET);
  } catch {
    const err = new Error('Selection expired. Please login again.');
    err.statusCode = 401;
    throw err;
  }
  if (decoded.purpose !== 'org_select') {
    const err = new Error('Invalid selection token');
    err.statusCode = 400;
    throw err;
  }

  const selected = decoded.candidates.find((candidate) => candidate.account_key === accountKey);
  if (!selected) {
    const err = new Error('Invalid organisation selection');
    err.statusCode = 400;
    throw err;
  }

  const table = selected.user_type === 'admin' ? 'admins' : 'emplist';
  const row = await db.runWithTenant({ bypassTenant: true }, () => db.query(
    selected.user_type === 'admin'
      ? `SELECT
           'admin:' || a.id AS account_key, 'admin' AS user_type, a.id, a.username,
           a.name AS display_name, a.email_id, a.mobile_no, a.role,
           COALESCE(a.status, 'Active') AS admin_status,
           o.id AS organization_id, o.org_code AS organization_code, o.office_name AS organization_name,
           o.status AS org_status, o.valid_until, o.force_read_only
         FROM admins a JOIN organizations o ON o.id=a.organization_id
         WHERE a.id=$1 AND a.organization_id=$2`
      : `SELECT
           'employee:' || e.id AS account_key, 'employee' AS user_type, e.id, e.emp_id,
           e.name, e.formal_name, COALESCE(e.formal_name, e.name) AS display_name,
           e.email_id, e.mobile_no, e.designation AS role, e.status AS employee_status,
           o.id AS organization_id, o.org_code AS organization_code, o.office_name AS organization_name,
           o.status AS org_status, o.valid_until, o.force_read_only
         FROM emplist e JOIN organizations o ON o.id=e.organization_id
         WHERE e.id=$1 AND e.organization_id=$2`,
    [selected.id, selected.organization_id]
  ));

  const candidate = row.rows[0];
  if (
    !candidate ||
    !organizationCanLogin({ status: candidate.org_status }) ||
    (candidate.user_type === 'admin' && candidate.admin_status !== 'Active') ||
    (candidate.user_type === 'employee' && candidate.employee_status !== 'Active')
  ) {
    const err = new Error('Selected account is no longer active');
    err.statusCode = 403;
    throw err;
  }

  const { token, payload } = signUser(candidate);
  await recordSession(token, payload);
  return { token, user: payload };
}

async function recordSession(token, payload) {
  if (!payload.organization_id) return;
  await db.runWithTenant({ organizationId: payload.organization_id }, async () => {
    await db.query(
      `INSERT INTO attendance_sessions
         (session_token, login_type, user_id, user_name, role, login_at, last_seen_at, status)
       VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),'Active')`,
      [
        token.slice(-24),
        payload.user_type === 'admin' ? 'Admin' : 'Employee',
        payload.emp_id || payload.username,
        payload.formal_name || payload.name,
        payload.role || payload.designation || payload.user_type,
      ]
    ).catch(() => {});
  });
}

async function hashForStorage(password) {
  return hashPassword(password);
}

module.exports = {
  buildLoginResponse,
  selectOrganization,
  hashForStorage,
  organizationReadOnly,
};
