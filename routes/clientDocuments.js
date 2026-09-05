const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const googleDrive = require('../services/googleDriveService');
const { getOrCreateClientFolder } = require('../services/partyDriveFolder');
const { decrypt } = require('../utils/encryption');

const router = express.Router();
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB cap per document
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

const FEATURE_KEY = 'client_document_management';
const DOCUMENT_TYPES = [
  'PAN Card', 'Aadhaar Card', 'GST Certificate', 'Certificate of Incorporation', 'MOA', 'AOA',
  'Partnership Deed', 'Bank Statement', 'ITR Acknowledgement', 'Balance Sheet', 'Profit & Loss Statement',
  'Audit Report', 'Board Resolution', 'Rent Agreement', 'Electricity Bill', 'Cancelled Cheque',
  'Digital Signature Certificate (DSC)', 'Trademark Certificate', 'Udyam Registration Certificate',
  'Shop Act License', 'Other',
];
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE']);

function clean(v) {
  const t = v === undefined || v === null ? '' : String(v).trim();
  return t || null;
}
const isAdminView = u => u.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(u.role);
const actorId = u => u.emp_id || u.id || 'SYSTEM';
const actorName = u => u.formal_name || u.name || 'Unknown';

// Indian financial year helpers (Apr-Mar), IST — same convention used
// elsewhere in this app (routes/compliance.js's FY_OPTIONS).
function currentFY() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const y = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${y}-${String(y + 1).slice(-2)}`;
}
function fyOptions() {
  const curYear = parseInt(currentFY().slice(0, 4), 10);
  const out = [];
  for (let y = curYear - 4; y <= curYear + 4; y++) out.push(`${y}-${String(y + 1).slice(-2)}`);
  return out;
}

async function featureAccess(req) {
  const r = await db.query(
    `SELECT access_level FROM organization_feature_access WHERE organization_id=$1 AND feature_key=$2`,
    [req.user.organization_id, FEATURE_KEY]
  );
  return r.rows[0]?.access_level || 'none';
}

async function requireFeature(req, res, next) {
  try {
    const level = await featureAccess(req);
    if (level === 'none') return res.status(403).json({ success: false, message: 'Client Document Management is not enabled for this organisation. Ask your admin to request access.' });
    if (WRITE_METHODS.has(req.method) && level !== 'full') {
      return res.status(403).json({ success: false, message: 'Client Document Management is view-only for this organisation.' });
    }
    req.docsAccess = level;
    next();
  } catch (err) {
    console.error('[client docs feature access]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

router.use(authMiddleware, requireFeature);

// ── GET /api/client-documents/categories ──────────────────────
router.get('/categories', (req, res) => {
  res.json({
    success: true,
    document_types: DOCUMENT_TYPES,
    fy_options: fyOptions(),
    current_fy: currentFY(),
    access_level: req.docsAccess,
    is_admin: isAdminView(req.user),
  });
});

// ── GET /api/client-documents/attachment/:fileId (view/download) ──
// NOTE: must be registered BEFORE the generic '/:type/:id' route below —
// same route-ordering trap as routes/clientNotes.js's '/search/all' and
// '/attachment/:fileId'.
//
// Documents live privately in the organisation's own Google Drive
// (drive.file scope, never shared publicly) — the server fetches the file
// itself using this organisation's own stored access token and streams the
// bytes back, so no employee needs a Google login of their own.
router.get('/attachment/:fileId', async (req, res) => {
  try {
    const orgId = req.user.organization_id;
    const linkRes = await db.runWithTenant({ organizationId: orgId }, () =>
      db.query(`SELECT encrypted_refresh_token FROM organization_drive_links WHERE organization_id=$1`, [orgId])
    );
    if (!linkRes.rows.length) {
      return res.status(404).json({ success: false, message: 'This organisation has no Google Drive connected.' });
    }
    const accessToken = await googleDrive.refreshAccessToken(decrypt(linkRes.rows[0].encrypted_refresh_token));
    const meta = await googleDrive.getFileMetadata(accessToken, req.params.fileId);
    const fileRes = await googleDrive.downloadFile(accessToken, req.params.fileId);
    res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${(meta.name || 'file').replace(/"/g, '')}"`);
    Readable.fromWeb(fileRes.body).pipe(res);
  } catch (err) {
    console.error('[client docs attachment]', err);
    res.status(500).json({ success: false, message: err.message || 'Could not load document' });
  }
});

// ── POST /api/client-documents/upload (the file itself) ────────
// Kept self-contained (mirrors routes/clientNotes.js's /upload) rather than
// sharing a generic module, matching this codebase's existing
// per-module-duplication convention.
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'File is too large. Maximum attachment size is 5MB.' });
      }
      return res.status(400).json({ success: false, message: err.message || 'File upload failed' });
    }
    next();
  });
}

router.post('/upload', handleUpload, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'File required' });
    if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(req.file.mimetype)) {
      return res.status(400).json({ success: false, message: 'Only image (PNG/JPG/WEBP) or PDF files are allowed' });
    }
    const { type: partyType, id: partyId } = req.body;
    if (!['client', 'agent'].includes(partyType) || !partyId) {
      return res.status(400).json({ success: false, message: 'Client/Agent type and id are required' });
    }
    // multer's stream-based body parsing breaks AsyncLocalStorage propagation
    // from authMiddleware (confirmed live in routes/clientNotes.js) — always
    // re-anchor the tenant context explicitly from req.user before any
    // RLS-backed query in a multer route.
    const orgId = req.user.organization_id;
    const safeName = String(req.file.originalname || 'document').replace(/[^a-z0-9._-]/gi, '_');
    const { uploaded, notConnected } = await db.runWithTenant({ organizationId: orgId }, async () => {
      const linkRes = await db.query(`SELECT folder_id, encrypted_refresh_token FROM organization_drive_links WHERE organization_id=$1`, [orgId]);
      if (!linkRes.rows.length) return { notConnected: true };
      const { folder_id, encrypted_refresh_token } = linkRes.rows[0];
      const accessToken = await googleDrive.refreshAccessToken(decrypt(encrypted_refresh_token));
      const clientFolderId = await getOrCreateClientFolder({ organizationId: orgId, accessToken, rootFolderId: folder_id, partyType, partyId });
      const uploaded = await googleDrive.uploadFile(accessToken, clientFolderId, req.file.buffer, safeName, req.file.mimetype);
      return { uploaded };
    });
    if (notConnected) {
      return res.status(403).json({
        success: false,
        message: "Documents need this organisation's Google Drive connected first. Ask an admin to connect it from Organisation Profile → Integrations.",
      });
    }
    res.json({
      success: true,
      attachment: {
        drive_file_id: uploaded.id,
        filename: req.file.originalname || safeName,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
      },
    });
  } catch (err) {
    console.error('[client docs upload]', err);
    res.status(500).json({ success: false, message: err.message || 'Document upload failed' });
  }
});

// ── GET /api/client-documents/:type/:id (list all documents for a party) ──
router.get('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  try {
    const r = await db.query(
      `SELECT * FROM client_documents
        WHERE party_type=$1 AND party_id=$2
        ORDER BY financial_year DESC, uploaded_at DESC`,
      [type, id]
    );
    res.json({ success: true, documents: r.rows });
  } catch (err) {
    console.error('[client docs list]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/client-documents (save a document record) ────────
router.post('/', async (req, res) => {
  const { type, id, financial_year, document_name, description, drive_file_id, filename, mime_type, size_bytes } = req.body;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  if (!id) return res.status(400).json({ success: false, message: 'Client/Agent ID required' });
  const fy = clean(financial_year) || currentFY();
  const name = clean(document_name);
  if (!name) return res.status(400).json({ success: false, message: 'Document name is required' });
  if (!drive_file_id) return res.status(400).json({ success: false, message: 'File upload is required' });
  try {
    const r = await db.query(
      `INSERT INTO client_documents
         (organization_id, party_type, party_id, financial_year, document_name, description, drive_file_id, filename, mime_type, size_bytes, uploaded_by_id, uploaded_by_name)
       VALUES (current_organization_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [type, id, fy, name, clean(description), drive_file_id, clean(filename), clean(mime_type), size_bytes || null, actorId(req.user), actorName(req.user)]
    );
    res.json({ success: true, message: 'Document saved', document: r.rows[0] });
  } catch (err) {
    console.error('[client docs create]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/client-documents/:id (admin only) ───────────────
router.delete('/:id', async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Only an admin can delete a document' });
  try {
    await db.query(`DELETE FROM client_documents WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Document deleted' });
  } catch (err) {
    console.error('[client docs delete]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
