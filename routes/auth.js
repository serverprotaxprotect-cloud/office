const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { emp_id, password } = req.body;

  if (!emp_id || !password)
    return res.status(400).json({ success: false, message: 'Employee ID and Password required' });

  try {
    const result = await db.query(
      `SELECT emp_id, name, formal_name, designation, status, login_password
       FROM emplist WHERE LOWER(emp_id) = LOWER($1)`,
      [emp_id.trim()]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ success: false, message: 'Employee ID not found' });

    const emp = result.rows[0];

    if (emp.status !== 'Active')
      return res.status(403).json({ success: false, message: 'Your account is inactive. Contact admin.' });

    if (emp.login_password !== password)
      return res.status(401).json({ success: false, message: 'Incorrect password' });

    const token = jwt.sign(
      { emp_id: emp.emp_id, name: emp.name, formal_name: emp.formal_name, designation: emp.designation },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    // Log session
    await db.query(
      `INSERT INTO attendance_sessions (session_token, login_type, user_id, user_name, role, login_at, last_seen_at, status)
       VALUES ($1, 'Employee', $2, $3, $4, NOW(), NOW(), 'Active')`,
      [token.slice(-24), emp.emp_id, emp.formal_name || emp.name, emp.designation]
    );

    res.json({
      success: true,
      token,
      employee: {
        emp_id: emp.emp_id,
        name: emp.name,
        formal_name: emp.formal_name,
        designation: emp.designation
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    await db.query(
      `UPDATE attendance_sessions SET status='Inactive' WHERE session_token=$1`,
      [token.slice(-24)]
    ).catch(() => {});
  }
  res.json({ success: true, message: 'Logged out' });
});

module.exports = router;
