// Client-facing, unauthenticated document-collection endpoints. A client
// opens a link like /document-upload.html?t=<token> with no login at all —
// every query here is scoped through resolveToken(), which maps the token to
// exactly one organisation/party from our own database. Nothing the client
// submits (party ids, org ids) is ever trusted directly, so a leaked/guessed
// token can only ever act on the one party it was issued for, never reach
// any other client or organisation.
const express = require('express');
const multer = require('multer');
const { PDFDocument } = require('pdf-lib');
const db = require('../db');
const googleDrive = require('../services/googleDriveService');
const { getOrCreateClientFolder } = require('../services/partyDriveFolder');
const { decrypt } = require('../utils/encryption');

const router = express.Router();
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

// A password-protected PDF can't be opened by the office without the
// client's password, so it's rejected at upload time rather than accepted
// and discovered unusable later. PDFDocument.load() throws on an encrypted
// file unless told to ignore encryption — that's the signal we check for.
async function isEncryptedPdf(buffer) {
  try {
    await PDFDocument.load(buffer, { ignoreEncryption: false });
    return false;
  } catch (err) {
    return /encrypt/i.test(err.message || '');
  }
}

async function resolveToken(token) {
  let row = null;
  await db.runWithTenant({ bypassTenant: true }, async () => {
    const r = await db.query(`SELECT organization_id, party_type, party_id FROM party_upload_tokens WHERE token=$1`, [token]);
    row = r.rows[0] || null;
  });
  return row;
}

// ── GET /api/public/document-requests/:token ──────────────────
router.get('/:token', async (req, res) => {
  const party = await resolveToken(req.params.token);
  if (!party) return res.status(404).json({ success: false, message: 'This link is invalid or has expired.' });
  try {
    let partyName = party.party_id;
    let requests = [];
    await db.runWithTenant({ organizationId: party.organization_id }, async () => {
      const nameRes = party.party_type === 'client'
        ? await db.query(`SELECT legal_name, business_name FROM clients WHERE client_id=$1`, [party.party_id])
        : await db.query(`SELECT name FROM agents WHERE agent_id=$1`, [party.party_id]);
      partyName = party.party_type === 'client'
        ? (nameRes.rows[0]?.legal_name || nameRes.rows[0]?.business_name || party.party_id)
        : (nameRes.rows[0]?.name || party.party_id);
      const r = await db.query(
        `SELECT id, document_name, status, remark, filename, submitted_at, work_name, group_heading, input_kind, side, text_value
           FROM document_requests WHERE party_type=$1 AND party_id=$2 ORDER BY requested_at ASC`,
        [party.party_type, party.party_id]
      );
      requests = r.rows;
    });
    res.json({ success: true, party_name: partyName, requests });
  } catch (err) {
    console.error('[public doc requests]', err);
    res.status(500).json({ success: false, message: 'Could not load document requests.' });
  }
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: 'File is too large. Maximum size is 5MB.' });
      return res.status(400).json({ success: false, message: err.message || 'File upload failed' });
    }
    next();
  });
}

// ── POST /api/public/document-requests/:token/:requestId/submit ──
router.post('/:token/:requestId/submit', handleUpload, async (req, res) => {
  const party = await resolveToken(req.params.token);
  if (!party) return res.status(404).json({ success: false, message: 'This link is invalid or has expired.' });
  if (!req.file) return res.status(400).json({ success: false, message: 'File required' });
  if (!['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(req.file.mimetype)) {
    return res.status(400).json({ success: false, message: 'Only image (PNG/JPG/WEBP) or PDF files are allowed' });
  }
  if (req.file.mimetype === 'application/pdf' && await isEncryptedPdf(req.file.buffer)) {
    return res.status(400).json({ success: false, message: 'This PDF is password-protected. Please remove the password and upload again.' });
  }
  try {
    let result = null;
    await db.runWithTenant({ organizationId: party.organization_id }, async () => {
      const reqRow = await db.query(
        `SELECT id, status, input_kind FROM document_requests WHERE id=$1 AND party_type=$2 AND party_id=$3`,
        [req.params.requestId, party.party_type, party.party_id]
      );
      if (!reqRow.rows.length) { result = { status: 404, body: { success: false, message: 'Document request not found.' } }; return; }
      if (reqRow.rows[0].status !== 'Pending') { result = { status: 400, body: { success: false, message: 'This document has already been submitted.' } }; return; }
      if (reqRow.rows[0].input_kind === 'text') { result = { status: 400, body: { success: false, message: 'This item needs a typed answer, not a file.' } }; return; }

      const linkRes = await db.query(`SELECT folder_id, encrypted_refresh_token FROM organization_drive_links WHERE organization_id=$1`, [party.organization_id]);
      if (!linkRes.rows.length) { result = { status: 503, body: { success: false, message: 'This office is not able to accept uploads right now. Please contact them directly.' } }; return; }

      const accessToken = await googleDrive.refreshAccessToken(decrypt(linkRes.rows[0].encrypted_refresh_token));
      const clientFolderId = await getOrCreateClientFolder({
        organizationId: party.organization_id, accessToken, rootFolderId: linkRes.rows[0].folder_id,
        partyType: party.party_type, partyId: party.party_id,
      });
      const safeName = String(req.file.originalname || 'document').replace(/[^a-z0-9._-]/gi, '_');
      const uploaded = await googleDrive.uploadFile(accessToken, clientFolderId, req.file.buffer, safeName, req.file.mimetype);

      const upd = await db.query(
        `UPDATE document_requests
            SET status='Submitted', drive_file_id=$1, filename=$2, mime_type=$3, size_bytes=$4, submitted_at=NOW(), remark=NULL
          WHERE id=$5 RETURNING id, document_name, status`,
        [uploaded.id, req.file.originalname || safeName, req.file.mimetype, req.file.size, req.params.requestId]
      );
      result = { status: 200, body: { success: true, message: 'Document submitted', request: upd.rows[0] } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[public doc requests submit]', err);
    res.status(500).json({ success: false, message: err.message || 'Upload failed' });
  }
});

// ── POST /api/public/document-requests/:token/:requestId/submit-text ──
// For checklist items that are just information (Mobile Number, DIN, etc.)
// rather than a document — no file, just a typed answer.
router.post('/:token/:requestId/submit-text', express.json(), async (req, res) => {
  const party = await resolveToken(req.params.token);
  if (!party) return res.status(404).json({ success: false, message: 'This link is invalid or has expired.' });
  const text = String(req.body.text_value || '').trim();
  if (!text) return res.status(400).json({ success: false, message: 'Please enter a value.' });
  try {
    let result = null;
    await db.runWithTenant({ organizationId: party.organization_id }, async () => {
      const reqRow = await db.query(
        `SELECT id, status, input_kind FROM document_requests WHERE id=$1 AND party_type=$2 AND party_id=$3`,
        [req.params.requestId, party.party_type, party.party_id]
      );
      if (!reqRow.rows.length) { result = { status: 404, body: { success: false, message: 'Document request not found.' } }; return; }
      if (reqRow.rows[0].status !== 'Pending') { result = { status: 400, body: { success: false, message: 'This has already been submitted.' } }; return; }
      if (reqRow.rows[0].input_kind !== 'text') { result = { status: 400, body: { success: false, message: 'This item needs a file, not a typed answer.' } }; return; }
      const upd = await db.query(
        `UPDATE document_requests SET status='Submitted', text_value=$1, submitted_at=NOW(), remark=NULL WHERE id=$2 RETURNING id, document_name, status`,
        [text, req.params.requestId]
      );
      result = { status: 200, body: { success: true, message: 'Submitted', request: upd.rows[0] } };
    });
    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[public doc requests submit-text]', err);
    res.status(500).json({ success: false, message: err.message || 'Submit failed' });
  }
});

module.exports = router;
