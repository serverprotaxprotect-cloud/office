const REQUIRED_FIELDS = [
  { key: 'latitude', label: 'Latitude' },
  { key: 'longitude', label: 'Longitude' },
  { key: 'attendance_radius_meters', label: 'Attendance Radius (meters)' },
  { key: 'employee_id_prefix', label: 'Employee ID Prefix' },
  { key: 'client_id_prefix', label: 'Client ID Prefix' },
  { key: 'agent_id_prefix', label: 'Agent ID Prefix' },
];

function clean(value) {
  return String(value ?? '').trim();
}

function prefixKey(value) {
  return clean(value).toUpperCase();
}

function orgSetupErrors(org = {}) {
  const missing = [];
  for (const field of REQUIRED_FIELDS) {
    if (field.key === 'attendance_radius_meters') {
      if (!Number(org[field.key]) || Number(org[field.key]) <= 0) missing.push(field.label);
    } else if (field.key === 'latitude' || field.key === 'longitude') {
      if (org[field.key] === null || org[field.key] === undefined || org[field.key] === '' || Number.isNaN(Number(org[field.key]))) {
        missing.push(field.label);
      }
    } else if (!clean(org[field.key])) {
      missing.push(field.label);
    }
  }

  const prefixes = [
    { type: 'Employee ID Prefix', value: prefixKey(org.employee_id_prefix) },
    { type: 'Client ID Prefix', value: prefixKey(org.client_id_prefix) },
    { type: 'Agent ID Prefix', value: prefixKey(org.agent_id_prefix) },
  ].filter((p) => p.value);
  const seen = new Map();
  const clashes = [];
  for (const p of prefixes) {
    if (seen.has(p.value)) clashes.push(`${p.type} clashes with ${seen.get(p.value)}`);
    else seen.set(p.value, p.type);
  }

  return { missing, clashes };
}

function ensureOrgSetupComplete(org = {}) {
  const { missing, clashes } = orgSetupErrors(org);
  if (!missing.length && !clashes.length) return true;
  const parts = [];
  if (missing.length) parts.push(`Complete Organisation Profile first: ${missing.join(', ')}`);
  if (clashes.length) parts.push(`ID series prefixes must be different: ${clashes.join('; ')}`);
  const err = new Error(parts.join('. '));
  err.statusCode = 400;
  err.code = 'ORG_PROFILE_INCOMPLETE';
  throw err;
}

async function requireOrgSetup(conn, organizationId) {
  const result = await conn.query(
    `SELECT latitude, longitude, attendance_radius_meters,
            employee_id_prefix, client_id_prefix, agent_id_prefix
     FROM organizations
     WHERE id=$1`,
    [organizationId]
  );
  ensureOrgSetupComplete(result.rows[0] || {});
  return result.rows[0];
}

module.exports = {
  orgSetupErrors,
  ensureOrgSetupComplete,
  requireOrgSetup,
};
