const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encryption');

const router = express.Router();
const FEATURE_KEY = 'client_document_collection';
const CATEGORY_OPTIONS = [
  'Individual', 'Proprietorship', 'Partnership', 'LLP', 'Private Limited Company',
  'Public Limited Company', 'HUF', 'Trust', 'Society', 'Other',
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
    if (level === 'none') return res.status(403).json({ success: false, message: 'Client Details Sheet is not enabled for this organisation. Ask your admin to request access.' });
    if (WRITE_METHODS.has(req.method) && level !== 'full') {
      return res.status(403).json({ success: false, message: 'Client Details Sheet is view-only for this organisation.' });
    }
    req.kycAccess = level;
    next();
  } catch (err) {
    console.error('[client kyc feature access]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
}

router.use(authMiddleware, requireFeature);

// ── GET /api/client-kyc/categories ──────────────────────────────
router.get('/categories', (req, res) => {
  res.json({ success: true, category_options: CATEGORY_OPTIONS, access_level: req.kycAccess, is_admin: isAdminView(req.user) });
});

// ── GET /api/client-kyc/:type/:id ───────────────────────────────
router.get('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  try {
    const r = await db.query(`SELECT * FROM client_kyc_details WHERE party_type=$1 AND party_id=$2`, [type, id]);
    const row = r.rows[0] || null;
    if (row) delete row.aadhaar_encrypted; // the encrypted blob itself never leaves the server
    res.json({ success: true, kyc: row });
  } catch (err) {
    console.error('[client kyc get]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/client-kyc/:type/:id/aadhaar (admin-only reveal) ───
router.get('/:type/:id/aadhaar', async (req, res) => {
  if (!isAdminView(req.user)) return res.status(403).json({ success: false, message: 'Admin access required' });
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  try {
    const r = await db.query(`SELECT aadhaar_encrypted FROM client_kyc_details WHERE party_type=$1 AND party_id=$2`, [type, id]);
    if (!r.rows.length || !r.rows[0].aadhaar_encrypted) return res.json({ success: true, aadhaar: null });
    res.json({ success: true, aadhaar: decrypt(r.rows[0].aadhaar_encrypted) });
  } catch (err) {
    console.error('[client kyc aadhaar reveal]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── PUT /api/client-kyc/:type/:id (create or update) ────────────
router.put('/:type/:id', async (req, res) => {
  const { type, id } = req.params;
  if (!['client', 'agent'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid party type' });
  const {
    aadhaar, date_of_birth, category, bank_account_no, bank_ifsc, bank_name,
    spouse_father_name, nominee_name, nominee_relation, nominee_mobile,
  } = req.body;
  const aadhaarDigits = String(aadhaar || '').replace(/\D/g, '');
  if (aadhaarDigits && aadhaarDigits.length !== 12) {
    return res.status(400).json({ success: false, message: 'Aadhaar number must be 12 digits' });
  }
  try {
    const aadhaarEncrypted = aadhaarDigits ? encrypt(aadhaarDigits) : null;
    const aadhaarLast4 = aadhaarDigits ? aadhaarDigits.slice(-4) : null;
    const aadhaarProvided = !!aadhaarDigits;
    const r = await db.query(
      `INSERT INTO client_kyc_details
         (organization_id, party_type, party_id, aadhaar_encrypted, aadhaar_last4, date_of_birth, category,
          bank_account_no, bank_ifsc, bank_name, spouse_father_name, nominee_name, nominee_relation, nominee_mobile,
          updated_by_id, updated_by_name)
       VALUES (current_organization_id(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (organization_id, party_type, party_id) DO UPDATE SET
         aadhaar_encrypted = CASE WHEN $16 THEN EXCLUDED.aadhaar_encrypted ELSE client_kyc_details.aadhaar_encrypted END,
         aadhaar_last4 = CASE WHEN $16 THEN EXCLUDED.aadhaar_last4 ELSE client_kyc_details.aadhaar_last4 END,
         date_of_birth=EXCLUDED.date_of_birth, category=EXCLUDED.category,
         bank_account_no=EXCLUDED.bank_account_no, bank_ifsc=EXCLUDED.bank_ifsc, bank_name=EXCLUDED.bank_name,
         spouse_father_name=EXCLUDED.spouse_father_name, nominee_name=EXCLUDED.nominee_name,
         nominee_relation=EXCLUDED.nominee_relation, nominee_mobile=EXCLUDED.nominee_mobile,
         updated_by_id=EXCLUDED.updated_by_id, updated_by_name=EXCLUDED.updated_by_name, updated_at=NOW()
       RETURNING *`,
      [
        type, id, aadhaarEncrypted, aadhaarLast4, clean(date_of_birth), clean(category),
        clean(bank_account_no), clean(bank_ifsc), clean(bank_name), clean(spouse_father_name),
        clean(nominee_name), clean(nominee_relation), clean(nominee_mobile),
        actorId(req.user), actorName(req.user), aadhaarProvided,
      ]
    );
    const row = r.rows[0];
    delete row.aadhaar_encrypted;
    res.json({ success: true, message: 'Client details saved', kyc: row });
  } catch (err) {
    console.error('[client kyc save]', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
