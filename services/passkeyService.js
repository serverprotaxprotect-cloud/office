const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const db = require('../db');

const RP_NAME = 'Gee Bharat';
const CHALLENGE_MINUTES = 5;
const MAX_DEVICES = 3;
const POLICIES = ['off', 'optional', 'enforced'];

class PasskeyError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bypass = (fn) => db.runWithTenant({ bypassTenant: true }, fn);
const toB64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

// rpID is the domain a passkey is permanently bound to. Production uses the
// registrable domain so geebharat.com and its subdomains share passkeys.
function rpFromReq(req) {
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  const hostname = rawHost.split(':')[0];
  let rpID = process.env.WEBAUTHN_RP_ID;
  if (!rpID) {
    if (hostname === 'localhost' || hostname === '127.0.0.1') rpID = 'localhost';
    else if (hostname === 'geebharat.com' || hostname.endsWith('.geebharat.com')) rpID = 'geebharat.com';
    else rpID = hostname;
  }
  const proto = hostname === 'localhost' || hostname === '127.0.0.1' ? 'http' : 'https';
  return { rpID, origin: `${proto}://${rawHost}` };
}

async function getPolicy(organizationId) {
  const r = await bypass(() => db.query(
    `SELECT value FROM attendance_settings WHERE organization_id=$1 AND key='PASSKEY_POLICY'`,
    [organizationId]
  ));
  const v = String(r.rows[0]?.value || 'off').toLowerCase();
  return POLICIES.includes(v) ? v : 'off';
}

async function saveChallenge({ purpose, organizationId, empId, challenge }) {
  const token = crypto.randomBytes(24).toString('hex');
  await bypass(async () => {
    await db.query(
      `INSERT INTO passkey_challenges (token, organization_id, emp_id, purpose, challenge, expires_at)
       VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' minutes')::interval)`,
      [token, organizationId || null, empId || null, purpose, challenge, String(CHALLENGE_MINUTES)]
    );
    if (Math.random() < 0.05) {
      await db.query(`DELETE FROM passkey_challenges WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});
    }
  });
  return token;
}

// Atomic one-time use: a challenge can never be replayed.
async function consumeChallenge(token, purpose) {
  const r = await bypass(() => db.query(
    `UPDATE passkey_challenges SET used_at=NOW()
      WHERE token=$1 AND purpose=$2 AND used_at IS NULL AND expires_at > NOW()
      RETURNING challenge, organization_id, emp_id`,
    [String(token || ''), purpose]
  ));
  return r.rows[0] || null;
}

async function activePasskeys(organizationId, empId) {
  const r = await bypass(() => db.query(
    `SELECT id, credential_id, transports, device_label, created_at, last_used_at
       FROM employee_passkeys
      WHERE organization_id=$1 AND emp_id=$2 AND revoked_at IS NULL
      ORDER BY created_at`,
    [organizationId, empId]
  ));
  return r.rows;
}

const transportsOf = (row) => (row.transports ? String(row.transports).split(',').filter(Boolean) : undefined);

// ── Registration (employee is already signed in with their password) ──
async function registrationOptions(req, emp) {
  const policy = await getPolicy(emp.organizationId);
  if (policy === 'off') throw new PasskeyError(403, 'Fingerprint login is not enabled for your organisation.');
  const existing = await activePasskeys(emp.organizationId, emp.empId);
  if (existing.length >= MAX_DEVICES) {
    throw new PasskeyError(400, `You can register up to ${MAX_DEVICES} devices. Remove an old one first.`);
  }
  const { rpID } = rpFromReq(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: emp.empId,
    userDisplayName: emp.name || emp.empId,
    userID: new TextEncoder().encode(`${emp.organizationId}:${emp.empId}`),
    attestationType: 'none',
    excludeCredentials: existing.map(p => ({ id: p.credential_id, transports: transportsOf(p) })),
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
  });
  const token = await saveChallenge({ purpose: 'register', organizationId: emp.organizationId, empId: emp.empId, challenge: options.challenge });
  return { token, options };
}

async function verifyRegistration(req, emp, { token, response, label }) {
  const ch = await consumeChallenge(token, 'register');
  if (!ch || ch.emp_id !== emp.empId || ch.organization_id !== emp.organizationId) {
    throw new PasskeyError(400, 'This request expired. Please try again.');
  }
  const { rpID, origin } = rpFromReq(req);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
  } catch (err) {
    throw new PasskeyError(400, 'Could not verify this device. Please try again.');
  }
  if (!v.verified || !v.registrationInfo) throw new PasskeyError(400, 'Could not verify this device. Please try again.');
  const c = v.registrationInfo.credential;
  const existing = await activePasskeys(emp.organizationId, emp.empId);
  if (existing.length >= MAX_DEVICES) throw new PasskeyError(400, `You can register up to ${MAX_DEVICES} devices.`);
  const cleanLabel = String(label || '').replace(/[<>]/g, '').trim().slice(0, 100) || 'My phone';
  await bypass(() => db.query(
    `INSERT INTO employee_passkeys (organization_id, emp_id, credential_id, public_key, counter, transports, device_label, backed_up)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [emp.organizationId, emp.empId, c.id, toB64u(c.publicKey), c.counter || 0,
     (c.transports || response?.response?.transports || []).join(','), cleanLabel, !!v.registrationInfo.credentialBackedUp]
  ));
  return { label: cleanLabel };
}

// ── Assertions (login + punch confirmation) ──
async function findCredential(credentialId) {
  const r = await bypass(() => db.query(
    `SELECT * FROM employee_passkeys WHERE credential_id=$1 AND revoked_at IS NULL`,
    [String(credentialId || '')]
  ));
  return r.rows[0] || null;
}

async function verifyAssertion(req, { token, purpose, response, expectEmp }) {
  const ch = await consumeChallenge(token, purpose);
  if (!ch) throw new PasskeyError(400, 'This fingerprint request expired. Please try again.', 'PASSKEY_EXPIRED');
  const cred = await findCredential(response?.id);
  if (!cred) throw new PasskeyError(401, 'This fingerprint is not registered or was removed. Please use your password.', 'PASSKEY_UNKNOWN');
  if (expectEmp && (cred.emp_id !== expectEmp.empId || cred.organization_id !== expectEmp.organizationId)) {
    throw new PasskeyError(403, 'This fingerprint belongs to a different account.', 'PASSKEY_MISMATCH');
  }
  if (purpose === 'punch' && (ch.emp_id !== cred.emp_id || ch.organization_id !== cred.organization_id)) {
    throw new PasskeyError(403, 'This fingerprint belongs to a different account.', 'PASSKEY_MISMATCH');
  }
  const { rpID, origin } = rpFromReq(req);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: cred.credential_id, publicKey: fromB64u(cred.public_key), counter: Number(cred.counter) || 0, transports: transportsOf(cred) },
    });
  } catch (err) {
    throw new PasskeyError(401, 'Fingerprint verification failed. Please try again.', 'PASSKEY_FAILED');
  }
  if (!v.verified) throw new PasskeyError(401, 'Fingerprint verification failed. Please try again.', 'PASSKEY_FAILED');
  const newCounter = Number(v.authenticationInfo?.newCounter) || 0;
  await bypass(() => db.query(
    `UPDATE employee_passkeys SET last_used_at=NOW(), counter = GREATEST(counter, $1) WHERE id=$2`,
    [newCounter, cred.id]
  ));
  return cred;
}

async function loginOptions(req) {
  const { rpID } = rpFromReq(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  const token = await saveChallenge({ purpose: 'login', challenge: options.challenge });
  return { token, options };
}

async function punchOptions(req, emp) {
  const creds = await activePasskeys(emp.organizationId, emp.empId);
  if (!creds.length) throw new PasskeyError(404, 'No fingerprint registered.');
  const { rpID } = rpFromReq(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: creds.map(p => ({ id: p.credential_id, transports: transportsOf(p) })),
  });
  const token = await saveChallenge({ purpose: 'punch', organizationId: emp.organizationId, empId: emp.empId, challenge: options.challenge });
  return { token, options };
}

async function revoke({ organizationId, empId, passkeyId, by }) {
  const r = await bypass(() => db.query(
    `UPDATE employee_passkeys SET revoked_at=NOW(), revoked_by=$4
      WHERE organization_id=$1 AND emp_id=$2 AND revoked_at IS NULL AND ($3::int IS NULL OR id=$3::int)`,
    [organizationId, empId, passkeyId || null, by || null]
  ));
  return r.rowCount;
}

module.exports = {
  PasskeyError, POLICIES, MAX_DEVICES,
  rpFromReq, getPolicy, activePasskeys,
  registrationOptions, verifyRegistration,
  loginOptions, punchOptions, verifyAssertion, revoke,
};
