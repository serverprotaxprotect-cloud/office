const db = require('../db');

const ADMIN_ROLES = ['Director', 'Office Manager', 'HR', 'Accountant'];

const PERMISSION_CATALOG = [
  { key: 'overview.view', module: 'Overview', action: 'View' },
  { key: 'attendance.view', module: 'Attendance', action: 'View' },
  { key: 'attendance.edit', module: 'Attendance', action: 'Edit/Import' },
  { key: 'attendance_requests.view', module: 'Attendance Requests', action: 'View' },
  { key: 'attendance_requests.approve', module: 'Attendance Requests', action: 'Approve/Reject' },
  { key: 'employees.view', module: 'Employees', action: 'View' },
  { key: 'employees.edit', module: 'Employees', action: 'Add/Edit' },
  { key: 'admin_users.manage', module: 'Admin Users', action: 'Manage' },
  { key: 'leave.view', module: 'Leave', action: 'View' },
  { key: 'leave.approve', module: 'Leave', action: 'Approve/Reject' },
  { key: 'salary.view', module: 'Salary', action: 'View' },
  { key: 'salary.edit', module: 'Salary', action: 'Structure/Adjust' },
  { key: 'salary.calculate', module: 'Salary', action: 'Calculate' },
  { key: 'salary.approve', module: 'Salary', action: 'Approve' },
  { key: 'salary.export', module: 'Salary', action: 'Export/Slip' },
  { key: 'settings.manage', module: 'Settings', action: 'Manage' },
  { key: 'tasks.view', module: 'Tasks', action: 'View Own/Assigned' },
  { key: 'tasks.view_all', module: 'Tasks', action: 'View All' },
  { key: 'tasks.create', module: 'Tasks', action: 'Create' },
  { key: 'tasks.edit', module: 'Tasks', action: 'Edit/Complete' },
  { key: 'clients.view', module: 'Clients/Agents', action: 'View' },
  { key: 'clients.edit', module: 'Clients/Agents', action: 'Add/Edit/Portal' },
  { key: 'companies.view', module: 'Companies', action: 'View' },
  { key: 'companies.edit', module: 'Companies', action: 'Add/Edit/Import' },
  { key: 'directors.view', module: 'Directors/KYC', action: 'View' },
  { key: 'directors.edit', module: 'Directors/KYC', action: 'Add/Edit' },
  { key: 'compliance.view', module: 'Compliance Tracking', action: 'View' },
  { key: 'compliance.edit', module: 'Compliance Tracking', action: 'Edit' },
  { key: 'gst.view', module: 'GST', action: 'View' },
  { key: 'gst.edit', module: 'GST', action: 'Add/Edit/Assign' },
  { key: 'income_tax.view', module: 'Income Tax', action: 'View' },
  { key: 'income_tax.edit', module: 'Income Tax', action: 'Add/Edit/Assign' },
  { key: 'data_import.manage', module: 'Data Import', action: 'Manage' },
  { key: 'notices.manage', module: 'Notices', action: 'Manage' },
  { key: 'holidays.manage', module: 'Holidays', action: 'Manage' },
  { key: 'organization.manage', module: 'Organisation Profile', action: 'Manage' },
  { key: 'permissions.manage', module: 'Permissions', action: 'Manage' },
];

const ALL_PERMISSIONS = PERMISSION_CATALOG.map(p => p.key);
const OFFICE_BASE = [
  'overview.view', 'tasks.view', 'tasks.create', 'tasks.edit',
  'clients.view', 'clients.edit',
  'companies.view', 'companies.edit',
  'directors.view', 'directors.edit',
  'compliance.view', 'compliance.edit',
  'gst.view', 'gst.edit',
  'income_tax.view', 'income_tax.edit',
];
const EMPLOYEE_DEFAULT = [
  'tasks.view', 'tasks.create', 'tasks.edit',
  'clients.view', 'companies.view', 'directors.view',
  'compliance.view', 'gst.view', 'income_tax.view',
];
const ACCOUNTANT_DEFAULT = [
  ...OFFICE_BASE,
  'tasks.view_all',
  'salary.view', 'salary.edit', 'salary.calculate', 'salary.approve', 'salary.export', 'settings.manage',
];

let ensured = false;

function normalizeList(list) {
  return Array.from(new Set((Array.isArray(list) ? list : []).filter(k => ALL_PERMISSIONS.includes(k))));
}

function roleDefaults(subjectType, roleName) {
  if (subjectType === 'admin') {
    if (['Director', 'Office Manager', 'HR'].includes(roleName)) return ALL_PERMISSIONS;
    if (roleName === 'Accountant') return ACCOUNTANT_DEFAULT;
    return ALL_PERMISSIONS;
  }
  return EMPLOYEE_DEFAULT;
}

async function ensurePermissionTables() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
      subject_type VARCHAR(20) NOT NULL,
      role_name VARCHAR(120) NOT NULL,
      permissions TEXT[] NOT NULL DEFAULT '{}',
      updated_by VARCHAR(150),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (organization_id, subject_type, role_name)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_permission_overrides (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL DEFAULT current_organization_id(),
      subject_type VARCHAR(20) NOT NULL,
      subject_id VARCHAR(80) NOT NULL,
      allow_permissions TEXT[] NOT NULL DEFAULT '{}',
      deny_permissions TEXT[] NOT NULL DEFAULT '{}',
      updated_by VARCHAR(150),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (organization_id, subject_type, subject_id)
    )
  `);
  ensured = true;
}

async function seedRoleDefaultsForOrg(updatedBy = 'System') {
  await ensurePermissionTables();
  const orgId = db.getTenantContext().organizationId;
  if (!orgId) return;
  const roles = [
    ...ADMIN_ROLES.map(role => ({ subjectType: 'admin', role })),
    { subjectType: 'employee', role: 'employee' },
    { subjectType: 'employee', role: 'Accountant' },
    { subjectType: 'employee', role: 'Staff' },
  ];
  for (const item of roles) {
    await db.query(
      `INSERT INTO role_permissions (organization_id, subject_type, role_name, permissions, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (organization_id, subject_type, role_name) DO NOTHING`,
      [orgId, item.subjectType, item.role, roleDefaults(item.subjectType, item.role), updatedBy]
    );
  }
}

async function getRolePermissions(subjectType, roleName) {
  await seedRoleDefaultsForOrg();
  const r = await db.query(
    `SELECT permissions FROM role_permissions
     WHERE organization_id=$1 AND subject_type=$2 AND lower(role_name)=lower($3)
     LIMIT 1`,
    [db.getTenantContext().organizationId, subjectType, roleName || 'employee']
  );
  if (r.rows.length) return normalizeList(r.rows[0].permissions);
  return roleDefaults(subjectType, roleName);
}

async function getUserOverrides(subjectType, subjectId) {
  await ensurePermissionTables();
  if (!subjectId) return { allow_permissions: [], deny_permissions: [] };
  const r = await db.query(
    `SELECT allow_permissions, deny_permissions FROM user_permission_overrides
     WHERE organization_id=$1 AND subject_type=$2 AND subject_id=$3`,
    [db.getTenantContext().organizationId, subjectType, String(subjectId)]
  );
  return r.rows[0] || { allow_permissions: [], deny_permissions: [] };
}

async function effectivePermissionsForUser(user) {
  const subjectType = user?.user_type === 'admin' || user?.is_admin ? 'admin' : 'employee';
  const subjectId = subjectType === 'admin' ? user?.id : user?.id || user?.emp_id;
  const roleName = user?.role || user?.designation || 'employee';
  const rolePermissions = await getRolePermissions(subjectType, roleName);
  const overrides = await getUserOverrides(subjectType, subjectId);
  const effective = new Set(rolePermissions);
  normalizeList(overrides.allow_permissions).forEach(p => effective.add(p));
  normalizeList(overrides.deny_permissions).forEach(p => effective.delete(p));
  return {
    effective_permissions: Array.from(effective),
    role_permissions: rolePermissions,
    overrides_allow: normalizeList(overrides.allow_permissions),
    overrides_deny: normalizeList(overrides.deny_permissions),
  };
}

function hasPermission(user, permission) {
  if (!permission) return true;
  if (user?.role === 'Director' && permission === 'permissions.manage') return true;
  const perms = user?.permissions || user?.effective_permissions || [];
  return perms.includes(permission);
}

function requirePermission(permission) {
  return (req, res, next) => {
    const user = req.admin || req.user;
    if (!hasPermission(user, permission)) {
      return res.status(403).json({ success: false, message: 'Access denied', required_permission: permission });
    }
    next();
  };
}

async function listRolePermissions() {
  await seedRoleDefaultsForOrg();
  const r = await db.query(
    `SELECT subject_type, role_name, permissions, updated_by, updated_at
     FROM role_permissions
     WHERE organization_id=$1
     ORDER BY subject_type, role_name`,
    [db.getTenantContext().organizationId]
  );
  return r.rows.map(row => ({ ...row, permissions: normalizeList(row.permissions) }));
}

async function upsertRolePermissions(subjectType, roleName, permissions, updatedBy) {
  await ensurePermissionTables();
  const clean = normalizeList(permissions);
  const r = await db.query(
    `INSERT INTO role_permissions (organization_id, subject_type, role_name, permissions, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (organization_id, subject_type, role_name)
     DO UPDATE SET permissions=EXCLUDED.permissions, updated_by=EXCLUDED.updated_by, updated_at=NOW()
     RETURNING subject_type, role_name, permissions, updated_by, updated_at`,
    [db.getTenantContext().organizationId, subjectType, roleName, clean, updatedBy]
  );
  return r.rows[0];
}

async function userPermissionDetails(subjectType, subjectId, roleName) {
  const rolePermissions = await getRolePermissions(subjectType, roleName);
  const overrides = await getUserOverrides(subjectType, subjectId);
  const effective = new Set(rolePermissions);
  normalizeList(overrides.allow_permissions).forEach(p => effective.add(p));
  normalizeList(overrides.deny_permissions).forEach(p => effective.delete(p));
  return {
    effective_permissions: Array.from(effective),
    role_permissions: rolePermissions,
    overrides_allow: normalizeList(overrides.allow_permissions),
    overrides_deny: normalizeList(overrides.deny_permissions),
  };
}

async function upsertUserOverrides(subjectType, subjectId, allow, deny, updatedBy) {
  await ensurePermissionTables();
  const allowClean = normalizeList(allow);
  const denyClean = normalizeList(deny).filter(p => !allowClean.includes(p));
  const r = await db.query(
    `INSERT INTO user_permission_overrides
       (organization_id, subject_type, subject_id, allow_permissions, deny_permissions, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (organization_id, subject_type, subject_id)
     DO UPDATE SET allow_permissions=EXCLUDED.allow_permissions,
                   deny_permissions=EXCLUDED.deny_permissions,
                   updated_by=EXCLUDED.updated_by,
                   updated_at=NOW()
     RETURNING subject_type, subject_id, allow_permissions, deny_permissions, updated_by, updated_at`,
    [db.getTenantContext().organizationId, subjectType, String(subjectId), allowClean, denyClean, updatedBy]
  );
  return r.rows[0];
}

module.exports = {
  PERMISSION_CATALOG,
  ALL_PERMISSIONS,
  ensurePermissionTables,
  seedRoleDefaultsForOrg,
  effectivePermissionsForUser,
  hasPermission,
  requirePermission,
  listRolePermissions,
  upsertRolePermissions,
  userPermissionDetails,
  upsertUserOverrides,
};
