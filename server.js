require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes       = require('./routes/auth');
const attendanceRoutes = require('./routes/attendance');
const adminRoutes      = require('./routes/admin');
const leaveRoutes      = require('./routes/leave');
const salaryRoutes     = require('./routes/salary');
const tasksRoutes      = require('./routes/tasks');
const clientsRoutes    = require('./routes/clients');
const complianceRoutes = require('./routes/compliance');
const importRoutes     = require('./routes/import');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth',       authRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/admin',      adminRoutes);
app.use('/api/leave',      leaveRoutes);
app.use('/api/salary',     salaryRoutes);
app.use('/api/tasks',      tasksRoutes);
app.use('/api/clients',    clientsRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/import',    importRoutes);

// Catch-all: serve index (login page)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Local development me listen karo, Vercel pe export karo
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Attendance System running at http://localhost:${PORT}\n`);
  });
}

module.exports = app;
