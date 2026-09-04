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
const pfEsicRoutes     = require('./routes/pfEsic');
const trademarkRoutes  = require('./routes/trademarks');
const leadsRoutes      = require('./routes/leads');
const billingRoutes    = require('./routes/billing');
const mcaRoutes        = require('./routes/mca');
const importRoutes     = require('./routes/import');
const organizationRoutes = require('./routes/organizations');
const superAdminRoutes = require('./routes/superAdmin');
const onboardingImportRoutes = require('./routes/onboardingImport');
const portalRoutes = require('./routes/portal');
const chatRoutes = require('./routes/chat');
const performanceRoutes = require('./routes/performance');
const assessmentRoutes = require('./routes/assessment');
const clientNotesRoutes = require('./routes/clientNotes');
const googleDriveRoutes = require('./routes/googleDrive');
const clientDocumentsRoutes = require('./routes/clientDocuments');
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

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Vary', 'Authorization, Cookie');
  next();
});

app.use((req, res, next) => {
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const rawHost = forwardedHost || req.headers.host || req.hostname || '';
  const host = String(rawHost).split(':')[0].toLowerCase();
  const isLeadHost = host === 'lead.geebharat.com' || host === 'lead.localhost' || host.startsWith('lead.');
  if (isLeadHost && (req.method === 'GET' || req.method === 'HEAD')) {
    const leadProtocol = host === 'lead.localhost' || host.endsWith('.localhost') ? req.protocol : 'https';
    const leadHost = forwardedHost || req.headers.host || host;
    const returnTo = `${leadProtocol}://${leadHost}/lead.html`;
    if (req.path === '/lead-login.html') {
      return res.sendFile(path.join(__dirname, 'public', 'lead-login.html'));
    }
    if (req.path === '/admin-login.html' || req.path === '/office.html') {
      return res.redirect(302, `/lead-login.html?switch_account=1&return_to=${encodeURIComponent(returnTo)}`);
    }
    const leadPages = new Set(['/', '/index.html', '/lead.html']);
    const isPageRequest = !req.path.startsWith('/api/') && (leadPages.has(req.path) || !path.extname(req.path));
    if (isPageRequest) {
      return res.sendFile(path.join(__dirname, 'public', 'lead.html'));
    }
  }
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '7d',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js') || filePath.endsWith(`${path.sep}auth-session.js`)) {
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
app.use('/api/pf-esic',    pfEsicRoutes);
app.use('/api/trademarks', trademarkRoutes);
app.use('/api/leads',      leadsRoutes);
app.use('/api/billing',    billingRoutes);
app.use('/api/mca',        mcaRoutes);
app.use('/api/import',         importRoutes);
app.use('/api/organizations',  organizationRoutes);
app.use('/api/super-admin',    superAdminRoutes);
app.use('/api/onboarding-import', onboardingImportRoutes);
app.use('/api/portal',     portalRoutes);
app.use('/api/chat',       chatRoutes.router);
app.use('/api/portal/chat', chatRoutes.portalRouter);
app.use('/api/notifications',  notifRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/assessment', assessmentRoutes);
app.use('/api/client-notes', clientNotesRoutes);
app.use('/api/google-drive', googleDriveRoutes);
app.use('/api/client-documents', clientDocumentsRoutes);

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
