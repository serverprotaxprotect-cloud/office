require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
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
const slowRequests = [];

app.use(cors());
app.use(compression({ threshold: 1024 }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (!req.originalUrl.startsWith('/api/')) return;
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    if (durationMs < 500) return;
    const entry = {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Math.round(durationMs),
      at: new Date().toISOString()
    };
    slowRequests.push(entry);
    if (slowRequests.length > 100) slowRequests.shift();
    console.warn(`[slow-api] ${entry.method} ${entry.path} ${entry.status} ${entry.duration_ms}ms`);
  });
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
  }
}));

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

app.get('/api/health/performance', (req, res) => {
  res.json({
    success: true,
    uptime_seconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    slow_requests: slowRequests.slice(-50)
  });
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
