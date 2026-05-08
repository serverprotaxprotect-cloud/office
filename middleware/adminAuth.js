const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Admin login required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.is_admin) return res.status(403).json({ success: false, message: 'Admin access required' });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
};
