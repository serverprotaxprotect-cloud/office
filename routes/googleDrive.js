const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const drive = require('../services/googleDriveService');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();
const isAdminView = u => u.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(u.role);

// A plain <a href> navigation to /connect can't carry a custom Authorization
// header, so this route accepts the token as a query param too (same
// established pattern as routes/chat.js's SSE endpoint). No tenant-scoped
// query happens under this check — it only decides whether to redirect to
// Google — so a full session/tenant-context check isn't needed here.
function tokenAuth(req, res, next) {
  const header = req.headers['authorization'];
  const raw = (header && header.split(' ')[1]) || req.query.token;
  if (!raw) return res.status(401).json({ success: false, message: 'Login required' });
  try {
    const decoded = jwt.verify(raw, process.env.JWT_SECRET);
    if (!decoded.organization_id) return res.status(401).json({ success: false, message: 'Organisation context missing' });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Session expired, please login again' });
  }
}

function redirectUriFor(req) {
  // Must byte-for-byte match one of the "Authorized redirect URIs" configured
  // in Google Cloud Console for this OAuth client.
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${host}/api/google-drive/callback`;
}

// ── GET /api/google-drive/status ───────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT connected_email, connected_at FROM organization_drive_links WHERE organization_id=$1`,
      [req.user.organization_id]
    );
    if (!r.rows.length) return res.json({ success: true, connected: false });
    res.json({ success: true, connected: true, email: r.rows[0].connected_email, connected_at: r.rows[0].connected_at });
  } catch (err) {
    console.error('[google-drive status]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/google-drive/connect (admin-only, redirects to Google) ──
router.get('/connect', tokenAuth, async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Admin access required' });
  try {
    // Short-lived, signed state — carries which organisation/admin is
    // connecting through Google's redirect round-trip (which has no
    // Authorization header of its own) and can't be tampered with or reused
    // for a different organisation.
    const state = jwt.sign(
      { organization_id: req.user.organization_id, admin_id: req.user.id, purpose: 'google_drive_connect' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );
    const url = drive.getAuthUrl(state, redirectUriFor(req));
    res.redirect(url);
  } catch (err) {
    console.error('[google-drive connect]', err);
    res.status(500).json({ success: false, message: err.message || 'Could not start Google Drive connection' });
  }
});

// ── GET /api/google-drive/callback (Google redirects here) ───────
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const failRedirect = (message) => res.redirect(`/organization-profile.html?drive=error&message=${encodeURIComponent(message)}`);
  if (error) return failRedirect(error === 'access_denied' ? 'Connection cancelled.' : String(error));
  if (!code || !state) return failRedirect('Invalid response from Google.');

  let payload;
  try {
    payload = jwt.verify(state, process.env.JWT_SECRET);
    if (payload.purpose !== 'google_drive_connect') throw new Error('bad state');
  } catch {
    return failRedirect('This connection link expired or is invalid. Please try connecting again.');
  }

  try {
    const tokens = await drive.exchangeCodeForTokens(code, redirectUriFor(req));
    if (!tokens.refresh_token) {
      // Happens if the same Google account had already granted access before
      // without `prompt=consent` sticking — ask them to remove the app's
      // access at https://myaccount.google.com/permissions and reconnect.
      return failRedirect('Google did not return a long-lived connection. Please remove GeeBharat from your Google account\'s connected apps and try connecting again.');
    }
    const email = await drive.getConnectedEmail(tokens.access_token);
    const folderId = await drive.ensureAppFolder(tokens.access_token);
    const encryptedRefreshToken = encrypt(tokens.refresh_token);

    // This request carries no Authorization header (it's Google's own
    // redirect, not an authenticated API call), so authMiddleware never ran
    // and no tenant context is set — establish it explicitly here, scoped to
    // exactly the organisation named in the signed `state` we verified above.
    await db.runWithTenant({ organizationId: payload.organization_id }, async () => {
      const admin = await db.query(`SELECT name FROM admins WHERE id=$1 AND organization_id=$2`, [payload.admin_id, payload.organization_id]);
      await db.query(
        `INSERT INTO organization_drive_links
           (organization_id, connected_email, folder_id, encrypted_refresh_token, connected_by_id, connected_by_name)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (organization_id) DO UPDATE SET
           connected_email=EXCLUDED.connected_email,
           folder_id=EXCLUDED.folder_id,
           encrypted_refresh_token=EXCLUDED.encrypted_refresh_token,
           connected_by_id=EXCLUDED.connected_by_id,
           connected_by_name=EXCLUDED.connected_by_name,
           connected_at=NOW(),
           updated_at=NOW()`,
        [payload.organization_id, email, folderId, encryptedRefreshToken, payload.admin_id, admin.rows[0]?.name || null]
      );
    });
    res.redirect('/organization-profile.html?drive=connected');
  } catch (err) {
    console.error('[google-drive callback]', err);
    failRedirect(err.message || 'Could not connect Google Drive.');
  }
});

// ── POST /api/google-drive/disconnect (admin-only) ────────────────
router.post('/disconnect', authMiddleware, async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Admin access required' });
  try {
    const existing = await db.query(
      `SELECT encrypted_refresh_token FROM organization_drive_links WHERE organization_id=$1`,
      [req.user.organization_id]
    );
    if (existing.rows.length) {
      try { await drive.revokeToken(decrypt(existing.rows[0].encrypted_refresh_token)); } catch { /* best-effort */ }
    }
    await db.query(`DELETE FROM organization_drive_links WHERE organization_id=$1`, [req.user.organization_id]);
    res.json({ success: true, message: 'Google Drive disconnected' });
  } catch (err) {
    console.error('[google-drive disconnect]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
