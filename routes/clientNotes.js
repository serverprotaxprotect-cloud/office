const express = require('express');
const multer = require('multer');
const { put } = require('@vercel/blob');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB cap per attachment
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ATTACHMENT_BYTES } });

const FEATURE_KEY = 'client_conversation_log';
const EDIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes self-correction window
const CATEGORIES = ['Instruction Given', 'Client Unreachable', 'Payment Pending', 'Estimated Data Used', 'Follow-up Required', 'Other'];
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
    if (level === 'none') return res.status(403).json({ success: false, message: 'Client Update Log is not enabled for this organisation. Ask your admin to request access.' });
    if (WRITE_METHODS.has(req.method) && level !== 'full') {
      return res.status(403).json({ success: false, message: 'Client Update Log is view-only for this organisation.' });
    }
    req.notesAccess = level;
    next();
  } catch (err) {
    console.error('[client notes feature access]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

router.use(authMiddleware, requireFeature);

function annotateEditability(row, user) {
  const isCreator = row.created_by_id === actorId(user);
  const admin = isAdminView(user);
  const withinWindow = Date.now() - new Date(row.created_at).getTime() < EDIT_WINDOW_MS;
  const can_edit = admin || (isCreator && withinWindow);
  const edit_window_ends_at = isCreator && !admin
    ? new Date(new Date(row.created_at).getTime() + EDIT_WINDOW_MS).toISOString()
    : null;
  return { ...row, can_edit, edit_window_ends_at, is_locked: !can_edit };
}

// ── GET /api/client-notes/categories ──────────────────────────
router.get('/categories', (req, res) => {
  res.json({ success: true, categories: CATEGORIES, access_level: req.notesAccess, is_admin: isAdminView(req.user) });
});

// ── GET /api/client-notes/search?q= (admin-only audit search) ─
// NOTE: must be registered BEFORE the generic '/:type/:id' route below,
// otherwise Express matches this as type="search", id="all" and 400s.
router.get('/search/all', async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Admin access required' });
  const q = clean(req.query.q);
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const conds = [];
  const params = [];
  if (q) { params.push(`%${q}%`); conds.push(`entry_text ILIKE $${params.length}`); }
  if (category) { params.push(category); conds.push(`category = $${params.length}`); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  try {
    const r = await db.query(
      `SELECT * FROM client_conversation_logs ${where} ORDER BY created_at DESC LIMIT 200`,
      params
    );
    res.json({ success: true, entries: r.rows.map(row => annotateEditability(row, req.user)) });
  } catch (err) {
    console.error('[client notes search]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/client-notes/:type/:id ───────────────────────────
router.get('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  try {
    const r = await db.query(
      `SELECT * FROM client_conversation_logs
        WHERE party_type=$1 AND party_id=$2
        ORDER BY created_at DESC`,
      [type, id]
    );
    res.json({ success: true, entries: r.rows.map(row => annotateEditability(row, req.user)) });
  } catch (err) {
    console.error('[client notes list]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/client-notes ─────────────────────────────────────
router.post('/', async (req, res) => {
  const { type, id, category, entry_text, attachments } = req.body;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  if (!id) return res.status(400).json({ success: false, message: 'Client/Agent ID required' });
  const text = clean(entry_text);
  if (!text) return res.status(400).json({ success: false, message: 'Entry text is required' });
  const cat = CATEGORIES.includes(category) ? category : 'Other';
  const atts = Array.isArray(attachments) ? attachments.slice(0, 10) : [];
  try {
    const r = await db.query(
      `INSERT INTO client_conversation_logs
         (organization_id, party_type, party_id, category, entry_text, attachments, created_by_id, created_by_name)
       VALUES (current_organization_id(), $1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [type, id, cat, text, JSON.stringify(atts), actorId(req.user), actorName(req.user)]
    );
    res.json({ success: true, message: 'Update saved', entry: annotateEditability(r.rows[0], req.user) });
  } catch (err) {
    console.error('[client notes create]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/client-notes/:id ──────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const existing = await db.query(`SELECT * FROM client_conversation_logs WHERE id=$1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ success: false, message: 'Entry not found' });
    const old = existing.rows[0];
    const admin = isAdminView(req.user);
    const isCreator = old.created_by_id === actorId(req.user);
    const withinWindow = Date.now() - new Date(old.created_at).getTime() < EDIT_WINDOW_MS;
    if (!admin && !(isCreator && withinWindow)) {
      return res.status(403).json({
        success: false,
        message: isCreator
          ? 'This entry is locked. Your 10-minute edit window has passed — only an admin can change it now.'
          : 'Only the person who wrote this entry (within 10 minutes) or an admin can edit it.',
      });
    }
    const text = clean(req.body.entry_text) || old.entry_text;
    const cat = CATEGORIES.includes(req.body.category) ? req.body.category : old.category;
    const atts = Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 10) : old.attachments;

    // Preserve the previous version in edit_history for accountability —
    // this matters most when an admin overrides an already-locked entry.
    const historyEntry = {
      previous_text: old.entry_text,
      previous_category: old.category,
      edited_by_id: actorId(req.user),
      edited_by_name: actorName(req.user),
      edited_at: new Date().toISOString(),
      was_locked_override: admin && !(isCreator && withinWindow),
    };
    const newHistory = [...(old.edit_history || []), historyEntry];

    const r = await db.query(
      `UPDATE client_conversation_logs
          SET entry_text=$1, category=$2, attachments=$3,
              edited_by_id=$4, edited_by_name=$5, edited_at=NOW(),
              edit_history=$6
        WHERE id=$7
        RETURNING *`,
      [text, cat, JSON.stringify(atts), actorId(req.user), actorName(req.user), JSON.stringify(newHistory), req.params.id]
    );
    res.json({ success: true, message: 'Entry updated', entry: annotateEditability(r.rows[0], req.user) });
  } catch (err) {
    console.error('[client notes update]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── DELETE /api/client-notes/:id (admin only) ──────────────────
router.delete('/:id', async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Only an admin can delete an entry' });
  try {
    await db.query(`DELETE FROM client_conversation_logs WHERE id=$1`, [req.params.id]);
    res.json({ success: true, message: 'Entry deleted' });
  } catch (err) {
    console.error('[client notes delete]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/client-notes/upload (screenshot/PDF attachment) ──
// Turn multer's file-too-large error into a clean JSON response instead of
// falling through to Express's default (HTML) error handler.
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
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return res.status(500).json({ success: false, message: 'File storage is not configured' });
    }
    const safeName = String(req.file.originalname || 'attachment').replace(/[^a-z0-9._-]/gi, '_');
    const blob = await put(`client-notes/${req.user.organization_id}/${Date.now()}-${safeName}`, req.file.buffer, {
      access: 'public',
      contentType: req.file.mimetype,
    });
    res.json({
      success: true,
      attachment: {
        url: blob.url,
        pathname: blob.pathname,
        filename: req.file.originalname || safeName,
        mime_type: req.file.mimetype,
        size_bytes: req.file.size,
      },
    });
  } catch (err) {
    console.error('[client notes upload]', err);
    res.status(500).json({ success: false, message: err.message || 'Attachment upload failed' });
  }
});

module.exports = router;
