const jwt = require('jsonwebtoken');
const db = require('../db');

module.exports = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Super admin login required' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.user_type !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Super admin access required' });
    }

    const found = await db.query(
      `SELECT id, username, name, email_id, status FROM super_admins WHERE id=$1`,
      [decoded.id]
    );
    const admin = found.rows[0];
    if (!admin || admin.status !== 'Active') {
      return res.status(403).json({ success: false, message: 'Super admin account inactive' });
    }

    req.superAdmin = admin;
    return db.runWithTenant({ bypassTenant: true }, () => next());
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
};
