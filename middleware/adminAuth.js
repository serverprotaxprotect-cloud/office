const jwt = require('jsonwebtoken');
const db = require('../db');
const { organizationReadOnly } = require('../services/authService');
const { effectivePermissionsForUser } = require('../services/permissions');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

module.exports = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Admin login required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.is_admin) return res.status(403).json({ success: false, message: 'Admin access required' });
    if (!decoded.organization_id) {
      return res.status(401).json({ success: false, message: 'Organisation context missing. Please login again.' });
    }

    if (decoded.id) {
      const adminRes = await db.runWithTenant({ organizationId: decoded.organization_id }, () => db.query(
        `SELECT id, status FROM admins WHERE id=$1 AND organization_id=$2`,
        [decoded.id, decoded.organization_id]
      ));
      if (!adminRes.rows.length || adminRes.rows[0].status !== 'Active') {
        return res.status(403).json({ success: false, message: 'Admin account is not active.' });
      }
    }

    const orgRes = await db.query(
      `SELECT id, org_code, office_name, status,
              to_char(valid_until::date, 'YYYY-MM-DD') AS valid_until,
              force_read_only
       FROM organizations WHERE id=$1`,
      [decoded.organization_id]
    );
    const org = orgRes.rows[0];
    if (!org || org.status !== 'Active') {
      return res.status(403).json({ success: false, message: 'Organisation account is not active.' });
    }

    const readOnly = organizationReadOnly(org);
    if (readOnly && WRITE_METHODS.has(req.method)) {
      return res.status(403).json({
        success: false,
        message: 'Organisation subscription is expired/read-only. Please contact super admin.',
        read_only: true,
      });
    }

    decoded.organization_id = org.id;
    decoded.organization_code = org.org_code;
    decoded.organization_name = org.office_name;
    decoded.read_only = readOnly;
    req.organization = org;
    return db.runWithTenant({ organizationId: org.id, readOnly }, async () => {
      const permissionDetails = await effectivePermissionsForUser(decoded);
      decoded.permissions = permissionDetails.effective_permissions;
      decoded.permission_details = permissionDetails;
      req.admin = decoded;
      req.user = decoded;
      next();
    });
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
};
