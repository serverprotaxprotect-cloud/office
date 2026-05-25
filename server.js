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
const gstRoutes        = require('./routes/gst');
const incomeTaxRoutes  = require('./routes/incomeTax');
const importRoutes     = require('./routes/import');
const organizationRoutes = require('./routes/organizations');
const superAdminRoutes = require('./routes/superAdmin');
const onboardingImportRoutes = require('./routes/onboardingImport');
const portalRoutes = require('./routes/portal');
const { router: notifRoutes } = require('./routes/notifications');

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
app.use('/api/gst',        gstRoutes);
app.use('/api/income-tax', incomeTaxRoutes);
app.use('/api/import',         importRoutes);
app.use('/api/organizations',  organizationRoutes);
app.use('/api/super-admin',    superAdminRoutes);
app.use('/api/onboarding-import', onboardingImportRoutes);
app.use('/api/portal',     portalRoutes);
app.use('/api/notifications',  notifRoutes);

app.get('/api/maps/config', (req, res) => {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(404).json({ success: false, message: 'Google Maps API key is not configured' });
  }
  res.json({ success: true, apiKey: process.env.GOOGLE_MAPS_API_KEY });
});

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
