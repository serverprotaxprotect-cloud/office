const jwt = require('jsonwebtoken');
const db = require('../db');
const { organizationReadOnly } = require('../services/authService');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Login required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'portal_session' || !decoded.organization_id || !decoded.account_type) {
      return res.status(401).json({ success: false, message: 'Invalid portal session' });
    }

    const orgRes = await db.runWithTenant({ bypassTenant: true }, () => db.query(
      `SELECT id, org_code, office_name, status,
              to_char(valid_until::date, 'YYYY-MM-DD') AS valid_until,
              force_read_only
       FROM organizations WHERE id=$1`,
      [decoded.organization_id]
    ));
    const org = orgRes.rows[0];
    if (!org || org.status !== 'Active') {
      return res.status(403).json({ success: false, message: 'Organisation account is not active.' });
    }

    const readOnly = organizationReadOnly(org);
    if (readOnly && WRITE_METHODS.has(req.method)) {
      return res.status(403).json({
        success: false,
        message: 'Organisation subscription is expired/read-only. Please contact office admin.',
        read_only: true,
      });
    }

    req.portalUser = {
      ...decoded,
      organization_id: org.id,
      organization_code: org.org_code,
      organization_name: org.office_name,
      read_only: readOnly,
    };
    req.organization = org;
    return db.runWithTenant({ organizationId: org.id, readOnly }, () => next());
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
};
