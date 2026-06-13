const jwt = require('jsonwebtoken');
const db = require('../db');
const { organizationReadOnly } = require('../services/authService');
const { validateSession } = require('../services/sessionService');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

module.exports = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ success: false, message: 'Login required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.organization_id) {
      return res.status(401).json({ success: false, message: 'Organisation context missing. Please login again.' });
    }
    const sessionState = await validateSession(decoded);
    if (!sessionState.valid) {
      return res.status(401).json({ success: false, message: 'Session expired or logged out. Please login again.' });
    }

    const userResult = decoded.user_type === 'admin'
      ? await db.runWithTenant({ organizationId: decoded.organization_id }, () => db.query(
        `SELECT status FROM admins WHERE id=$1 AND organization_id=$2`,
        [decoded.id, decoded.organization_id]
      ))
      : await db.runWithTenant({ organizationId: decoded.organization_id }, () => db.query(
        `SELECT status FROM emplist WHERE id=$1 AND organization_id=$2`,
        [decoded.id, decoded.organization_id]
      ));
    if (!userResult.rows.length || userResult.rows[0].status !== 'Active') {
      return res.status(403).json({ success: false, message: 'User account is not active.' });
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
    if (readOnly && WRITE_METHODS.has(req.method) && req.path !== '/logout') {
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
    req.user = decoded;
    req.organization = org;
    return db.runWithTenant({ organizationId: org.id, readOnly }, () => next());
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
};
