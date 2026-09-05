const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const googleDrive = require('../services/googleDriveService');
const { decrypt } = require('../utils/encryption');

const router = express.Router();

const FEATURE_KEY = 'client_document_collection';
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
    if (level === 'none') return res.status(403).json({ success: false, message: 'Document Collection is not enabled for this organisation. Ask your admin to request access.' });
    if (WRITE_METHODS.has(req.method) && level !== 'full') {
      return res.status(403).json({ success: false, message: 'Document Collection is view-only for this organisation.' });
    }
    req.docReqAccess = level;
    next();
  } catch (err) {
    console.error('[doc requests feature access]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

router.use(authMiddleware, requireFeature);

// ── GET /api/document-requests/categories ──────────────────────
router.get('/categories', (req, res) => {
  res.json({ success: true, document_types: DOCUMENT_TYPES, access_level: req.docReqAccess, is_admin: isAdminView(req.user) });
});

// ── GET /api/document-requests/attachment/:fileId (staff view/download of a client-submitted file) ──
// NOTE: must be registered BEFORE the generic '/:type/:id' route below —
// same route-ordering trap fixed earlier in clientNotes.js/clientDocuments.js.
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
    console.error('[doc requests attachment]', err);
    res.status(500).json({ success: false, message: err.message || 'Could not load document' });
  }
});

// ── GET /api/document-requests/:type/:id/link (get-or-create the reusable public link) ──
router.get('/:type/:id/link', async (req, res) => {
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  try {
    const existing = await db.query(`SELECT token FROM party_upload_tokens WHERE party_type=$1 AND party_id=$2`, [type, id]);
    let token = existing.rows[0]?.token;
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      await db.query(
        `INSERT INTO party_upload_tokens (organization_id, party_type, party_id, token) VALUES (current_organization_id(),$1,$2,$3)`,
        [type, id, token]
      );
    }
    res.json({ success: true, url: `${req.protocol}://${req.get('host')}/document-upload.html?t=${token}` });
  } catch (err) {
    console.error('[doc requests link]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/document-requests/:type/:id/regenerate-link (admin-only) ──
router.post('/:type/:id/regenerate-link', async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Admin access required' });
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await db.query(
      `INSERT INTO party_upload_tokens (organization_id, party_type, party_id, token)
       VALUES (current_organization_id(),$1,$2,$3)
       ON CONFLICT (organization_id, party_type, party_id) DO UPDATE SET token=EXCLUDED.token, created_at=NOW()`,
      [type, id, token]
    );
    res.json({ success: true, url: `${req.protocol}://${req.get('host')}/document-upload.html?t=${token}`, message: 'Link regenerated — the old link no longer works' });
  } catch (err) {
    console.error('[doc requests regen link]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/document-requests/:type/:id (list all requests for a party) ──
router.get('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  try {
    const r = await db.query(
      `SELECT * FROM document_requests WHERE party_type=$1 AND party_id=$2 ORDER BY requested_at DESC`,
      [type, id]
    );
    res.json({ success: true, requests: r.rows });
  } catch (err) {
    console.error('[doc requests list]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/document-requests (create one or more requests) ──
router.post('/', async (req, res) => {
  const { type, id, documents } = req.body;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  if (!id) return res.status(400).json({ success: false, message: 'Client/Agent ID required' });
  const names = Array.isArray(documents) ? documents.map(clean).filter(Boolean) : [];
  if (!names.length) return res.status(400).json({ success: false, message: 'At least one document is required' });
  try {
    const params = [];
    const values = names.map((name, i) => {
      params.push(type, id, name, actorId(req.user), actorName(req.user));
      const base = i * 5;
      return `(current_organization_id(),$${base + 1},$${base + 2},$${base + 3},'Pending',$${base + 4},$${base + 5},NOW())`;
    });
    const r = await db.query(
      `INSERT INTO document_requests (organization_id, party_type, party_id, document_name, status, requested_by_id, requested_by_name, requested_at)
       VALUES ${values.join(',')} RETURNING *`,
      params
    );
    res.json({ success: true, message: `${r.rows.length} document request(s) sent`, requests: r.rows });
  } catch (err) {
    console.error('[doc requests create]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/document-requests/:id/review (approve or ask-again) ──
router.post('/:id/review', async (req, res) => {
  if (!isAdminView(req.user) && req.docReqAccess !== 'full') {
    return res.status(403).json({ success: false, message: 'Full access required to review documents' });
  }
  const { action, remark } = req.body;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ success: false, message: 'Invalid action' });
  try {
    const existing = await db.query(`SELECT status FROM document_requests WHERE id=$1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ success: false, message: 'Request not found' });
    if (existing.rows[0].status !== 'Submitted') return res.status(400).json({ success: false, message: 'Only a submitted document can be reviewed' });

    if (action === 'approve') {
      const r = await db.query(
        `UPDATE document_requests SET status='Approved', reviewed_by_id=$1, reviewed_by_name=$2, reviewed_at=NOW(), remark=NULL WHERE id=$3 RETURNING *`,
        [actorId(req.user), actorName(req.user), req.params.id]
      );
      return res.json({ success: true, message: 'Document approved', request: r.rows[0] });
    }
    // "Ask Again" — sends it back to Pending with a remark visible on the client's link.
    const remarkText = clean(remark) || 'Please resubmit — the document was not acceptable.';
    const r = await db.query(
      `UPDATE document_requests
          SET status='Pending', remark=$1, drive_file_id=NULL, filename=NULL, mime_type=NULL, size_bytes=NULL, submitted_at=NULL,
              reviewed_by_id=$2, reviewed_by_name=$3, reviewed_at=NOW()
        WHERE id=$4 RETURNING *`,
      [remarkText, actorId(req.user), actorName(req.user), req.params.id]
    );
    res.json({ success: true, message: 'Client asked to resubmit', request: r.rows[0] });
  } catch (err) {
    console.error('[doc requests review]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/document-requests/:id (admin-only) ──────────────
router.delete('/:id', async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Only an admin can delete a document request' });
  try {
    await db.query(`DELETE FROM document_requests WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Document request deleted' });
  } catch (err) {
    console.error('[doc requests delete]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
