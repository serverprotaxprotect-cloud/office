const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const {
  GST_STATUSES,
  RETURN_TYPES,
  cleanText,
  normalizeGstNo,
  isGstAdmin,
  encryptText,
  decryptText,
  todayIST,
  periodEndDate,
  periodLabel,
  financialYearForPeriod,
  getDueDate,
  isQuarterEndingMonth,
  currentISTPeriod,
  isLastDayIST,
  parseGSTWorkbook,
} = require('../utils/gstUtils');
const { buildPreview, importRows } = require('../services/gstImportService');
const {
  logGST,
  findEmployee,
  findClient,
  generateFilingsForPeriod,
  updateFilingStatus,
  assignFiling,
  assignUnassignedFilingsForClient,
} = require('../services/gstService');
const {
  providerConfigured,
  gstinChecksumValid,
  fetchGSTINProfile,
  fetchGSTReturnStatus,
} = require('../services/gstPortalProvider');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const GST_LOGIN_URL = 'https://services.gst.gov.in/services/login';

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function handleError(res, err) {
  if (err.code === '42P01') {
    return res.status(500).json({ success: false, message: 'GST tables missing. Run GST migration first.' });
  }
  if (err.code === '23505') {
    return res.status(400).json({ success: false, message: 'Duplicate GST number is not allowed' });
  }
  console.error(err);
  return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
}

function requireAdmin(req, res) {
  if (!isGstAdmin(req.user)) {
    res.status(403).json({ success: false, message: 'Admin access required' });
    return false;
  }
  return true;
}

function mapGSTClient(row) {
  const { gst_password_enc, ...rest } = row;
  return { ...rest, gst_password: decryptText(gst_password_enc) };
}

function providerErrorMessage(err) {
  if (err.code === 'GST_PROVIDER_NOT_CONFIGURED') {
    return 'GST API provider configure nahi hai. GST/GSP API endpoint aur token env me set karne ke baad live verification/sync chalega.';
  }
  if (err.code === 'GST_PROVIDER_REJECTED') return err.message;
  return err.message || 'GST API request failed';
}

function canAutofillGSTClient(row, user) {
  return !!(user?.emp_id || user?.username || user?.id);
}

function fyOptions() {
  const now = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const year = now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const out = [];
  for (let y = year - 2; y <= year + 3; y += 1) out.push(`${y}-${String(y + 1).slice(-2)}`);
  return out;
}

router.get('/meta', authMiddleware, async (req, res) => {
  try {
    const emps = await db.query(
      `SELECT emp_id, formal_name, name, designation, photo
       FROM (
         SELECT emp_id, formal_name, name, designation, photo FROM emplist WHERE status='Active'
         UNION ALL
         SELECT username AS emp_id, name AS formal_name, name, role AS designation, NULL::text AS photo FROM admins WHERE status='Active'
       ) x
       ORDER BY name`
    );
    const latest = await db.query(
      `SELECT tax_year, tax_month, financial_year
       FROM gst_filing_records
       ORDER BY tax_year DESC, tax_month DESC
       LIMIT 1`
    ).catch(() => ({ rows: [] }));
    res.json({
      success: true,
      is_admin: isGstAdmin(req.user),
      status_options: GST_STATUSES,
      return_types: RETURN_TYPES,
      fy_options: fyOptions(),
      verification_provider_configured: providerConfigured(),
      employees: emps.rows,
      latest_period: latest.rows[0] ? {
        tax_year: latest.rows[0].tax_year,
        tax_month: latest.rows[0].tax_month,
        financial_year: latest.rows[0].financial_year,
      } : null,
      today_ist: todayIST(),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/clients', authMiddleware, async (req, res) => {
  const { search, status = 'Active', frequency, assignee_id, unassigned, page = 1, limit = 300 } = req.query;
  const params = [];
  const conds = ['1=1'];
  if (status) {
    params.push(status);
    conds.push(`gc.status=$${params.length}`);
  }
  if (frequency) {
    params.push(frequency);
    conds.push(`gc.filing_frequency=$${params.length}`);
  }
  if (assignee_id) {
    params.push(assignee_id);
    conds.push(`gc.default_assignee_id=$${params.length}`);
  }
  if (unassigned === '1' || unassigned === 'true') {
    conds.push(`COALESCE(gc.default_assignee_id,'')=''`);
  }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(gc.client_id ILIKE $${n} OR gc.firm_name ILIKE $${n} OR gc.gst_no ILIKE $${n} OR gc.agent_name ILIKE $${n} OR gc.default_assignee_name ILIKE $${n})`);
  }
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  try {
    params.push(parseInt(limit, 10));
    params.push(offset);
    const current = currentISTPeriod();
    const data = await db.query(
      `SELECT gc.*,
              COALESCE(gc.default_assignee_name, ea.formal_name, ea.name, aa.name) AS default_assignee_name,
              gf_current.assigned_to_id AS current_filing_assignee_id,
              c.legal_name, c.business_name, c.mobile_number, c.email_id
       FROM gst_clients gc
       LEFT JOIN clients c ON c.client_id=gc.client_id
       LEFT JOIN emplist ea ON ea.emp_id=gc.default_assignee_id
       LEFT JOIN admins aa ON aa.username=gc.default_assignee_id
       LEFT JOIN LATERAL (
         SELECT assigned_to_id
         FROM gst_filing_records gf
         WHERE gf.gst_client_id=gc.id AND gf.tax_year=$${params.length + 1} AND gf.tax_month=$${params.length + 2}
           AND COALESCE(gf.assigned_to_id,'') <> ''
         ORDER BY gf.updated_at DESC, gf.id DESC
         LIMIT 1
       ) gf_current ON true
       WHERE ${conds.join(' AND ')}
       ORDER BY gc.status, gc.firm_name, gc.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      [...params, current.taxYear, current.taxMonth]
    );
    const count = await db.query(`SELECT COUNT(*) FROM gst_clients gc WHERE ${conds.join(' AND ')}`, params.slice(0, -2));
    res.json({
      success: true,
      is_admin: isGstAdmin(req.user),
      clients: data.rows.map(row => ({ ...mapGSTClient(row), can_autofill: canAutofillGSTClient(row, req.user) })),
      total: parseInt(count.rows[0].count, 10),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/clients/:id/autofill-token', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: 'Valid GST client required' });
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const current = currentISTPeriod();
    const client = await conn.query(
      `SELECT gc.*,
              EXISTS (
                SELECT 1 FROM gst_filing_records gf
                WHERE gf.gst_client_id=gc.id
                  AND gf.tax_year=$2
                  AND gf.tax_month=$3
                  AND gf.assigned_to_id=$4
              ) AS assigned_current_period
       FROM gst_clients gc
       WHERE gc.id=$1 AND gc.status='Active'
       FOR UPDATE`,
      [id, current.taxYear, current.taxMonth, req.user.emp_id || req.user.username || req.user.id || '']
    );
    const row = client.rows[0];
    if (!row) {
      await conn.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'GST client not found' });
    }
    const allowed = !!(req.user.emp_id || req.user.username || req.user.id);
    if (!allowed) {
      await conn.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'GST credential autofill access denied' });
    }
    if (!row.gst_login_id || !decryptText(row.gst_password_enc)) {
      await conn.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'GST login ID/password missing for this client' });
    }
    const tokenSecret = randomToken();
    const expiresAt = new Date(Date.now() + 60 * 1000);
    const tokenRow = await conn.query(
      `INSERT INTO gst_autofill_tokens
        (token_hash, gst_client_id, created_by_id, created_by_name, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [tokenHash(tokenSecret), row.id, req.user.emp_id || req.user.username || req.user.id || null, req.user.formal_name || req.user.name || null, expiresAt]
    );
    const token = `${tokenRow.rows[0].id}.${tokenSecret}`;
    await logGST(conn, {
      gst_client_id: row.id,
      action: 'CreateGSTAutofillToken',
      new_value: { gst_login_id: row.gst_login_id, expires_at: expiresAt.toISOString() },
      actor: req.user,
    });
    await conn.query('COMMIT');
    const origin = encodeURIComponent(req.body.origin || req.get('origin') || 'https://geebharat.com');
    res.json({
      success: true,
      token,
      expires_at: expiresAt.toISOString(),
      login_url: GST_LOGIN_URL,
      extension_url_hint: `${GST_LOGIN_URL}#gb_autofill=${encodeURIComponent(token)}&gb_origin=${origin}`,
    });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.post('/verify-gstin', authMiddleware, async (req, res) => {
  const gstin = normalizeGstNo(req.body.gst_no || req.body.gstin || '').toUpperCase();
  if (!gstinChecksumValid(gstin)) {
    return res.status(400).json({ success: false, message: 'Invalid GSTIN format/checksum' });
  }
  try {
    const profile = await fetchGSTINProfile(gstin);
    res.json({ success: true, profile });
  } catch (err) {
    res.status(err.statusCode || 503).json({ success: false, message: providerErrorMessage(err), provider_configured: providerConfigured() });
  }
});

router.get('/autofill/:token', async (req, res) => {
  const rawToken = String(req.params.token || '').trim();
  if (!rawToken || rawToken.length > 160) return res.status(400).json({ success: false, message: 'Invalid autofill token' });
  const tokenParts = rawToken.match(/^(\d+)\.([A-Za-z0-9_-]{20,})$/);
  const tokenId = tokenParts ? Number(tokenParts[1]) : null;
  const tokenSecret = tokenParts ? tokenParts[2] : rawToken;
  const conn = await db.pool.connect();
  try {
    await db.runWithTenant({ bypassTenant: true }, () => conn.query('BEGIN'));
    const sql = `SELECT t.*, gc.gst_login_id, gc.gst_password_enc, gc.gst_no, gc.firm_name
       FROM gst_autofill_tokens t
       JOIN gst_clients gc ON gc.id=t.gst_client_id AND gc.organization_id=t.organization_id
       WHERE ${tokenId ? 't.id=$1' : 't.token_hash=$1'}
       FOR UPDATE`;
    const found = await db.runWithTenant({ bypassTenant: true }, () => conn.query(sql, [tokenId || tokenHash(rawToken)]));
    const row = found.rows[0];
    if (!row) {
      await db.runWithTenant({ bypassTenant: true }, () => conn.query('ROLLBACK'));
      return res.status(404).json({ success: false, message: 'Autofill token not found' });
    }
    if (row.token_hash !== tokenHash(tokenSecret)) {
      await db.runWithTenant({ bypassTenant: true }, () => conn.query('ROLLBACK'));
      return res.status(404).json({ success: false, message: 'Autofill token not found' });
    }
    if (row.used_at) {
      await db.runWithTenant({ bypassTenant: true }, () => conn.query('ROLLBACK'));
      return res.status(410).json({ success: false, message: 'Autofill token already used. Click Login again from GeeBharat.' });
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await db.runWithTenant({ bypassTenant: true }, () => conn.query('ROLLBACK'));
      return res.status(410).json({ success: false, message: 'Autofill token expired. Click Login again from GeeBharat.' });
    }
    const password = decryptText(row.gst_password_enc);
    if (!row.gst_login_id || !password) {
      await db.runWithTenant({ bypassTenant: true }, () => conn.query('ROLLBACK'));
      return res.status(400).json({ success: false, message: 'GST login credentials missing' });
    }
    await db.runWithTenant({ organizationId: row.organization_id }, async () => {
      await conn.query(`UPDATE gst_autofill_tokens SET used_at=NOW() WHERE id=$1`, [row.id]);
      await logGST(conn, {
        gst_client_id: row.gst_client_id,
        action: 'FetchGSTAutofillCredential',
        new_value: { gst_login_id: row.gst_login_id, extension_fetch: true },
        actor: { emp_id: row.created_by_id, formal_name: row.created_by_name },
      });
      await conn.query('COMMIT');
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      gst_login_id: row.gst_login_id,
      gst_password: password,
      gst_no: row.gst_no || '',
      firm_name: row.firm_name || '',
      login_url: GST_LOGIN_URL,
    });
  } catch (err) {
    await db.runWithTenant({ bypassTenant: true }, () => conn.query('ROLLBACK')).catch(() => {});
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.get('/unassigned', authMiddleware, async (req, res) => {
  const taxYear = Number(req.query.tax_year);
  const taxMonth = Number(req.query.tax_month);
  const limit = Math.min(Number(req.query.limit || 500), 1000);
  const search = cleanText(req.query.search || '');
  if (!taxYear || !taxMonth || taxMonth < 1 || taxMonth > 12) {
    return res.status(400).json({ success: false, message: 'Valid month and year required' });
  }

  const params = [taxYear, taxMonth, periodEndDate(taxYear, taxMonth)];
  const conds = [
    "gc.status='Active'",
    "(gc.inactive_from IS NULL OR gc.inactive_from::date > $3::date)",
  ];
  if (!isQuarterEndingMonth(taxMonth)) {
    conds.push("COALESCE(gc.filing_frequency,'Monthly') <> 'QRMP'");
  }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(gc.client_id ILIKE $${n} OR gc.firm_name ILIKE $${n} OR gc.gst_no ILIKE $${n} OR gc.agent_name ILIKE $${n})`);
  }

  const unresolved = `(gf.id IS NULL OR (
    gf.status NOT IN ('Filed','Not Applicable')
    AND (COALESCE(gf.assigned_to_id,'')='' OR gf.linked_task_id IS NULL OR t.task_id IS NULL)
  ))`;

  try {
    params.push(limit);
    const result = await db.query(
      `SELECT gc.id, gc.client_id, gc.firm_name, gc.gst_no, gc.gst_login_id, gc.gst_password_enc,
              gc.agent_id, gc.agent_name, gc.filing_frequency, gc.qrmp_gstr3b_due_day,
              gc.default_assignee_id,
              COALESCE(gc.default_assignee_name, ea.formal_name, ea.name, aa.name) AS default_assignee_name,
              c.legal_name, c.business_name, c.mobile_number, c.email_id,
              json_agg(rt.return_type ORDER BY rt.return_type) FILTER (WHERE ${unresolved}) AS missing_returns,
              COUNT(*) FILTER (WHERE ${unresolved}) AS missing_count
       FROM gst_clients gc
       CROSS JOIN (VALUES ('GSTR-1'), ('GSTR-3B')) AS rt(return_type)
       LEFT JOIN gst_filing_records gf
         ON gf.gst_client_id=gc.id AND gf.tax_year=$1 AND gf.tax_month=$2 AND gf.return_type=rt.return_type
       LEFT JOIN tasks t ON t.task_id=gf.linked_task_id AND t.active_flag=true
       LEFT JOIN clients c ON c.client_id=gc.client_id
       LEFT JOIN emplist ea ON ea.emp_id=gc.default_assignee_id
       LEFT JOIN admins aa ON aa.username=gc.default_assignee_id
       WHERE ${conds.join(' AND ')}
       GROUP BY gc.id, c.legal_name, c.business_name, c.mobile_number, c.email_id,
                ea.formal_name, ea.name, aa.name
       HAVING COUNT(*) FILTER (WHERE ${unresolved}) > 0
       ORDER BY gc.firm_name, gc.id
       LIMIT $${params.length}`,
      params
    );

    const clients = result.rows.map((row) => {
      const missingReturns = row.missing_returns || [];
      return mapGSTClient({
        ...row,
        period_label: periodLabel(taxYear, taxMonth),
        financial_year: financialYearForPeriod(taxYear, taxMonth),
        tax_year: taxYear,
        tax_month: taxMonth,
        missing_returns: missingReturns,
        due_dates: Object.fromEntries(missingReturns.map((returnType) => [
          returnType,
          getDueDate({
            taxYear,
            taxMonth,
            returnType,
            frequency: row.filing_frequency || 'Monthly',
            qrmpGstr3bDueDay: row.qrmp_gstr3b_due_day || 22,
          }),
        ])),
      });
    });

    res.json({ success: true, clients, total: clients.length });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/clients/:id/verify', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ success: false, message: 'Valid GST client required' });
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await conn.query('SELECT * FROM gst_clients WHERE id=$1 FOR UPDATE', [id]);
    const row = old.rows[0];
    if (!row) {
      await conn.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'GST client not found' });
    }
    const profile = await fetchGSTINProfile(row.gst_no);
    await conn.query(
      `UPDATE gst_clients SET
         legal_name=$1,
         trade_name=$2,
         taxpayer_type=$3,
         gst_registration_date=$4,
         gst_cancellation_date=$5,
         gst_portal_status=$6,
         gst_constitution=$7,
         gst_last_verified_at=NOW(),
         gst_verification_source=$8,
         gst_verification_raw=$9,
         firm_name=COALESCE(NULLIF($2,''), NULLIF($1,''), firm_name),
         status=CASE WHEN UPPER(COALESCE($6,'')) IN ('CANCELLED','SUSPENDED','INACTIVE') THEN 'Inactive' ELSE status END,
         updated_by_id=$10,
         updated_by_name=$11,
         updated_at=NOW()
       WHERE id=$12`,
      [
        profile.legal_name,
        profile.trade_name,
        profile.taxpayer_type,
        profile.registration_date,
        profile.cancellation_date,
        profile.status,
        profile.constitution,
        profile.source,
        JSON.stringify(profile.raw || {}),
        req.user.emp_id || req.user.username || req.user.id,
        req.user.formal_name || req.user.name,
        id,
      ]
    );
    await logGST(conn, {
      gst_client_id: id,
      action: 'VerifyGSTIN',
      old_value: { gst_no: row.gst_no, firm_name: row.firm_name, gst_portal_status: row.gst_portal_status },
      new_value: profile,
      actor: req.user,
    });
    await conn.query('COMMIT');
    res.json({ success: true, message: 'GSTIN verified and client enriched', profile });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 503).json({ success: false, message: providerErrorMessage(err), provider_configured: providerConfigured() });
  } finally {
    conn.release();
  }
});

async function syncReturnRowsForClient(conn, gstClient, returnRows, actor, filters = {}) {
  const summary = { checked: 0, updated: 0, created_missing: 0, no_match: 0 };
  const rows = returnRows.filter((r) => {
    if (filters.taxYear && Number(r.tax_year) !== Number(filters.taxYear)) return false;
    if (filters.taxMonth && Number(r.tax_month) !== Number(filters.taxMonth)) return false;
    if (filters.returnType && r.return_type !== filters.returnType) return false;
    return true;
  });
  for (const item of rows) {
    summary.checked += 1;
    let filing = await conn.query(
      `SELECT * FROM gst_filing_records
       WHERE gst_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND return_type=$4
       FOR UPDATE`,
      [gstClient.id, item.tax_year, item.tax_month, item.return_type]
    );
    if (!filing.rows.length) {
      await conn.query(
        `INSERT INTO gst_filing_records
          (gst_client_id, client_id, firm_name, gst_no, return_type, tax_year, tax_month,
           financial_year, period_label, due_date, assigned_to_id, assigned_to_name,
           status, generated_from, created_by_id, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Not Started','portal_sync',$13,$14)
         ON CONFLICT (gst_client_id, tax_year, tax_month, return_type) DO NOTHING`,
        [
          gstClient.id,
          gstClient.client_id,
          gstClient.firm_name,
          normalizeGstNo(gstClient.gst_no),
          item.return_type,
          item.tax_year,
          item.tax_month,
          financialYearForPeriod(item.tax_year, item.tax_month),
          periodLabel(item.tax_year, item.tax_month),
          getDueDate({
            taxYear: item.tax_year,
            taxMonth: item.tax_month,
            returnType: item.return_type,
            frequency: gstClient.filing_frequency || 'Monthly',
            qrmpGstr3bDueDay: gstClient.qrmp_gstr3b_due_day || 22,
          }),
          gstClient.default_assignee_id || null,
          gstClient.default_assignee_name || null,
          actor.emp_id || actor.username || actor.id || 'SYSTEM',
          actor.formal_name || actor.name || 'System',
        ]
      );
      summary.created_missing += 1;
      filing = await conn.query(
        `SELECT * FROM gst_filing_records
         WHERE gst_client_id=$1 AND tax_year=$2 AND tax_month=$3 AND return_type=$4
         FOR UPDATE`,
        [gstClient.id, item.tax_year, item.tax_month, item.return_type]
      );
    }
    const old = filing.rows[0];
    if (!old) {
      summary.no_match += 1;
      continue;
    }
    const filed = String(item.status || '').toLowerCase().includes('file') || !!item.filed_date || !!item.arn;
    const nextStatus = filed ? 'Filed' : old.status;
    await conn.query(
      `UPDATE gst_filing_records SET
         status=$1,
         source_status=$2,
         portal_filing_status=$2,
         portal_filed_date=$3,
         portal_arn=$4,
         portal_last_synced_at=NOW(),
         filed_date_ist=CASE WHEN $1='Filed' THEN COALESCE($3, filed_date_ist, CURRENT_DATE) ELSE filed_date_ist END,
         filed_at=CASE WHEN $1='Filed' AND filed_at IS NULL THEN NOW() ELSE filed_at END,
         status_updated_by_id=$5,
         status_updated_by_name=$6,
         last_status_at=NOW(),
         updated_at=NOW()
       WHERE id=$7`,
      [
        nextStatus,
        item.status || null,
        item.filed_date || null,
        item.arn || null,
        actor.emp_id || actor.username || actor.id || 'SYSTEM',
        actor.formal_name || actor.name || 'System',
        old.id,
      ]
    );
    await logGST(conn, {
      gst_client_id: gstClient.id,
      filing_id: old.id,
      action: 'SyncPortalReturnStatus',
      old_value: { status: old.status, source_status: old.source_status },
      new_value: item,
      actor,
    });
    summary.updated += 1;
  }
  return summary;
}

router.post('/clients/:id/sync-returns', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const conn = await db.pool.connect();
  try {
    const client = await conn.query('SELECT * FROM gst_clients WHERE id=$1', [id]);
    const row = client.rows[0];
    if (!row) return res.status(404).json({ success: false, message: 'GST client not found' });
    const portal = await fetchGSTReturnStatus(row.gst_no);
    await conn.query('BEGIN');
    const summary = await syncReturnRowsForClient(conn, row, portal.returns, req.user, {
      taxYear: req.body.tax_year || req.query.tax_year,
      taxMonth: req.body.tax_month || req.query.tax_month,
      returnType: req.body.return_type || req.query.return_type,
    });
    await conn.query('COMMIT');
    res.json({ success: true, message: 'GST filing status synced', summary, source: portal.source });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 503).json({ success: false, message: providerErrorMessage(err), provider_configured: providerConfigured() });
  } finally {
    conn.release();
  }
});

router.post('/filings/sync-status', authMiddleware, async (req, res) => {
  const taxYear = Number(req.body.tax_year || req.query.tax_year);
  const taxMonth = Number(req.body.tax_month || req.query.tax_month);
  const returnType = req.body.return_type || req.query.return_type || '';
  if (!taxYear || !taxMonth || taxMonth < 1 || taxMonth > 12) {
    return res.status(400).json({ success: false, message: 'Valid month and year required' });
  }
  const conn = await db.pool.connect();
  const summary = { clients_seen: 0, clients_synced: 0, filings_checked: 0, filings_updated: 0, errors: [] };
  try {
    const clients = await db.query(
      `SELECT * FROM gst_clients
       WHERE status='Active' AND COALESCE(gst_no,'') <> ''
       ORDER BY firm_name
       LIMIT 500`
    );
    summary.clients_seen = clients.rows.length;
    for (const gstClient of clients.rows) {
      try {
        const portal = await fetchGSTReturnStatus(gstClient.gst_no);
        await conn.query('BEGIN');
        const one = await syncReturnRowsForClient(conn, gstClient, portal.returns, req.user, { taxYear, taxMonth, returnType });
        await conn.query('COMMIT');
        summary.clients_synced += 1;
        summary.filings_checked += one.checked;
        summary.filings_updated += one.updated;
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {});
        summary.errors.push({ gst_no: gstClient.gst_no, firm_name: gstClient.firm_name, message: providerErrorMessage(err) });
        if (err.code === 'GST_PROVIDER_NOT_CONFIGURED' || err.code === 'GST_PROVIDER_REJECTED') break;
      }
    }
    res.json({ success: !summary.errors.length, message: summary.errors.length ? summary.errors[0].message : 'GST monthly tracker synced', summary });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.post('/clients', authMiddleware, async (req, res) => {
  const {
    client_id,
    firm_name,
    gst_no,
    gst_login_id,
    gst_password,
    filing_frequency = 'Monthly',
    qrmp_gstr3b_due_day = 22,
    default_assignee_id,
  } = req.body;

  if (!client_id) return res.status(400).json({ success: false, message: 'Client ID required' });
  if (!firm_name) return res.status(400).json({ success: false, message: 'Firm name required' });
  if (!gst_no) return res.status(400).json({ success: false, message: 'GST number required' });
  if (!gstinChecksumValid(gst_no)) return res.status(400).json({ success: false, message: 'Valid GSTIN required' });

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const client = await findClient(conn, client_id);
    if (!client) {
      const err = new Error('Client ID not found');
      err.statusCode = 404;
      throw err;
    }
    let emp = null;
    if (default_assignee_id) {
      emp = await findEmployee(conn, default_assignee_id);
      if (!emp) {
        const err = new Error('Active employee not found');
        err.statusCode = 400;
        throw err;
      }
    }

    const insert = await conn.query(
      `INSERT INTO gst_clients
        (client_id, firm_name, gst_no, gst_login_id, gst_password_enc, agent_id, agent_name,
         filing_frequency, qrmp_gstr3b_due_day, default_assignee_id, default_assignee_name,
         status, created_by_id, created_by_name, updated_by_id, updated_by_name)
       VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,'Active',$12,$13,$12,$13)
       RETURNING *`,
      [
        client_id,
        cleanText(firm_name),
        normalizeGstNo(gst_no),
        gst_login_id || '',
        encryptText(gst_password || ''),
        client.agent_id || null,
        client.agent_name || null,
        filing_frequency === 'QRMP' ? 'QRMP' : 'Monthly',
        Number(qrmp_gstr3b_due_day) === 24 ? 24 : 22,
        emp?.emp_id || null,
        emp ? (emp.formal_name || emp.name) : null,
        req.user.emp_id,
        req.user.formal_name || req.user.name,
      ]
    );

    await logGST(conn, {
      gst_client_id: insert.rows[0].id,
      action: 'CreateGSTClient',
      new_value: { client_id, firm_name, gst_no: normalizeGstNo(gst_no) },
      actor: req.user,
    });
    await conn.query('COMMIT');
    res.json({ success: true, message: 'GST client added', client: mapGSTClient(insert.rows[0]) });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/clients/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const allowed = ['firm_name', 'gst_no', 'gst_login_id', 'filing_frequency', 'qrmp_gstr3b_due_day'];
  const sets = [];
  const params = [];

  try {
    const old = await db.query('SELECT * FROM gst_clients WHERE id=$1', [id]);
    if (!old.rows.length) return res.status(404).json({ success: false, message: 'GST client not found' });

    allowed.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        let value = req.body[field];
        if (field === 'gst_no') value = normalizeGstNo(value);
        if (field === 'gst_no' && value && !gstinChecksumValid(value)) {
          const err = new Error('Valid GSTIN required');
          err.statusCode = 400;
          throw err;
        }
        if (field === 'filing_frequency') value = value === 'QRMP' ? 'QRMP' : 'Monthly';
        if (field === 'qrmp_gstr3b_due_day') value = Number(value) === 24 ? 24 : 22;
        params.push(value || null);
        sets.push(`${field}=$${params.length}`);
      }
    });
    if (Object.prototype.hasOwnProperty.call(req.body, 'gst_password')) {
      params.push(req.body.gst_password ? encryptText(req.body.gst_password) : null);
      sets.push(`gst_password_enc=$${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ success: false, message: 'No changes supplied' });
    params.push(req.user.emp_id, req.user.formal_name || req.user.name, id);
    const result = await db.query(
      `UPDATE gst_clients SET ${sets.join(', ')}, updated_by_id=$${params.length - 2},
        updated_by_name=$${params.length - 1}, updated_at=NOW()
       WHERE id=$${params.length} RETURNING *`,
      params
    );
    await logGST(db, {
      gst_client_id: id,
      action: 'UpdateGSTClient',
      old_value: old.rows[0],
      new_value: req.body,
      actor: req.user,
    });
    res.json({ success: true, message: 'GST client updated', client: mapGSTClient(result.rows[0]) });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/clients/:id/assign', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { default_assignee_id } = req.body;
  if (!default_assignee_id) return res.status(400).json({ success: false, message: 'Employee required' });

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await conn.query('SELECT * FROM gst_clients WHERE id=$1 FOR UPDATE', [id]);
    if (!old.rows.length) {
      const err = new Error('GST client not found');
      err.statusCode = 404;
      throw err;
    }
    const periodAssign = Boolean(req.body.tax_year && req.body.tax_month);
    const admin = isGstAdmin(req.user);
    if (!admin && old.rows[0].default_assignee_id && !periodAssign) {
      const err = new Error('Only admin can change an already assigned GST client');
      err.statusCode = 403;
      throw err;
    }
    const emp = await findEmployee(conn, default_assignee_id);
    if (!emp) {
      const err = new Error('Active employee not found');
      err.statusCode = 400;
      throw err;
    }
    const name = emp.formal_name || emp.name;
    const updateDefault = admin || !old.rows[0].default_assignee_id;
    if (updateDefault) {
      await conn.query(
        `UPDATE gst_clients SET default_assignee_id=$1, default_assignee_name=$2,
          updated_by_id=$3, updated_by_name=$4, updated_at=NOW() WHERE id=$5`,
        [emp.emp_id, name, req.user.emp_id, req.user.formal_name || req.user.name, id]
      );
      await logGST(conn, {
        gst_client_id: id,
        action: 'AssignDefaultEmployee',
        old_value: { default_assignee_id: old.rows[0].default_assignee_id, default_assignee_name: old.rows[0].default_assignee_name },
        new_value: { default_assignee_id: emp.emp_id, default_assignee_name: name },
        actor: req.user,
      });
    }
    const filingSummary = await assignUnassignedFilingsForClient(conn, id, emp, req.user, {
      taxYear: req.body.tax_year,
      taxMonth: req.body.tax_month,
      remark: req.body.remark || null,
    });
    await conn.query('COMMIT');
    res.json({
      success: true,
      message: updateDefault ? 'Default assignee updated' : 'Filing task assignment updated',
      filing_summary: filingSummary,
    });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/clients/:id/status', authMiddleware, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const status = req.body.status === 'Inactive' ? 'Inactive' : 'Active';
  const inactiveFrom = status === 'Inactive' ? (req.body.inactive_from || todayIST()) : null;
  const inactiveReason = status === 'Inactive' ? (req.body.inactive_reason || '') : null;

  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await conn.query('SELECT * FROM gst_clients WHERE id=$1 FOR UPDATE', [id]);
    if (!old.rows.length) {
      const err = new Error('GST client not found');
      err.statusCode = 404;
      throw err;
    }
    await conn.query(
      `UPDATE gst_clients SET status=$1, inactive_from=$2, inactive_reason=$3,
        updated_by_id=$4, updated_by_name=$5, updated_at=NOW() WHERE id=$6`,
      [status, inactiveFrom, inactiveReason, req.user.emp_id, req.user.formal_name || req.user.name, id]
    );
    await logGST(conn, {
      gst_client_id: id,
      action: status === 'Inactive' ? 'DeactivateGSTClient' : 'ActivateGSTClient',
      old_value: { status: old.rows[0].status, inactive_from: old.rows[0].inactive_from },
      new_value: { status, inactive_from: inactiveFrom, inactive_reason: inactiveReason },
      actor: req.user,
    });
    await conn.query('COMMIT');
    res.json({ success: true, message: `GST client marked ${status}` });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.get('/filings', authMiddleware, async (req, res) => {
  const { tax_year, tax_month, financial_year, client_id, gst_client_id, return_type, status, assigned_to_id, unassigned, search, limit = 500 } = req.query;
  const params = [];
  const conds = ['1=1'];
  if (tax_year) { params.push(Number(tax_year)); conds.push(`gf.tax_year=$${params.length}`); }
  if (tax_month) { params.push(Number(tax_month)); conds.push(`gf.tax_month=$${params.length}`); }
  if (financial_year) { params.push(financial_year); conds.push(`gf.financial_year=$${params.length}`); }
  if (client_id) { params.push(client_id); conds.push(`gf.client_id=$${params.length}`); }
  if (gst_client_id) { params.push(Number(gst_client_id)); conds.push(`gf.gst_client_id=$${params.length}`); }
  if (return_type) { params.push(return_type); conds.push(`gf.return_type=$${params.length}`); }
  if (status) { params.push(status); conds.push(`gf.status=$${params.length}`); }
  if (assigned_to_id) { params.push(assigned_to_id); conds.push(`gf.assigned_to_id=$${params.length}`); }
  if (unassigned === '1' || unassigned === 'true') conds.push(`COALESCE(gf.assigned_to_id,'')=''`);
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(gf.client_id ILIKE $${n} OR gf.firm_name ILIKE $${n} OR gf.gst_no ILIKE $${n} OR gf.assigned_to_name ILIKE $${n})`);
  }
  try {
    params.push(parseInt(limit, 10));
    const result = await db.query(
      `SELECT gf.*, gc.status AS gst_client_status, gc.filing_frequency,
              gc.gst_login_id, gc.gst_password_enc, gc.inactive_from, gc.inactive_reason
       FROM gst_filing_records gf
       JOIN gst_clients gc ON gc.id=gf.gst_client_id
       WHERE ${conds.join(' AND ')}
       ORDER BY gf.tax_year DESC, gf.tax_month DESC, gf.firm_name, gf.return_type
       LIMIT $${params.length}`,
      params
    );
    const admin = isGstAdmin(req.user);
    res.json({
      success: true,
      is_admin: admin,
      filings: result.rows.map(row => ({
        ...row,
        gst_password: decryptText(row.gst_password_enc),
        gst_password_enc: undefined,
        can_edit_status: admin || row.assigned_to_id === req.user.emp_id,
        can_reassign: admin || row.assigned_to_id === req.user.emp_id || !row.assigned_to_id,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/generate', authMiddleware, async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const taxYear = Number(req.body.tax_year);
  const taxMonth = Number(req.body.tax_month);
  if (!taxYear || taxMonth < 1 || taxMonth > 12) {
    return res.status(400).json({ success: false, message: 'Valid month and year required' });
  }
  try {
    const summary = await generateFilingsForPeriod({ taxYear, taxMonth, actor: req.user, source: 'manual' });
    res.json({ success: true, message: 'GST filing generation completed', summary });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/cron/generate', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (process.env.CRON_SECRET) {
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
  } else if (process.env.NODE_ENV === 'production') {
    return res.status(401).json({ success: false, message: 'CRON_SECRET missing' });
  }

  const forced = req.query.force === '1';
  if (!forced && !isLastDayIST()) {
    return res.json({ success: true, skipped: true, message: 'Not last day in IST; no GST tasks generated' });
  }
  const current = currentISTPeriod();
  const taxYear = Number(req.query.tax_year || current.taxYear);
  const taxMonth = Number(req.query.tax_month || current.taxMonth);
  try {
    const orgs = await db.query(
      `SELECT id, org_code, office_name FROM organizations
       WHERE status='Active' AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)`
    );
    const summaries = [];
    for (const org of orgs.rows) {
      const summary = await db.runWithTenant({ organizationId: org.id }, () => generateFilingsForPeriod({
        taxYear,
        taxMonth,
        actor: {
          emp_id: 'SYSTEM',
          formal_name: 'GST Auto Generator',
          user_type: 'admin',
          role: 'Director',
          organization_id: org.id,
          organization_code: org.org_code,
        },
        source: 'cron',
      }));
      summaries.push({ organization_id: org.id, organization_code: org.org_code, ...summary });
    }
    res.json({ success: true, summaries });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/filings/:id/status', authMiddleware, async (req, res) => {
  try {
    await updateFilingStatus(parseInt(req.params.id, 10), req.body.status, req.body.remark || null, req.user);
    res.json({ success: true, message: 'GST filing status updated' });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/filings/:id/assign', authMiddleware, async (req, res) => {
  try {
    const result = await assignFiling(parseInt(req.params.id, 10), req.body.assigned_to_id, req.body.remark || null, req.user);
    res.json({ success: true, message: 'GST filing reassigned', ...result });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/reports/summary', authMiddleware, async (req, res) => {
  const { tax_year, tax_month, financial_year, client_id, assigned_to_id, return_type } = req.query;
  const params = [];
  const conds = ['1=1'];
  if (tax_year) { params.push(Number(tax_year)); conds.push(`tax_year=$${params.length}`); }
  if (tax_month) { params.push(Number(tax_month)); conds.push(`tax_month=$${params.length}`); }
  if (financial_year) { params.push(financial_year); conds.push(`financial_year=$${params.length}`); }
  if (client_id) { params.push(client_id); conds.push(`client_id=$${params.length}`); }
  if (assigned_to_id) { params.push(assigned_to_id); conds.push(`assigned_to_id=$${params.length}`); }
  if (return_type) { params.push(return_type); conds.push(`return_type=$${params.length}`); }
  try {
    const [byStatus, byReturn, totals] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count FROM gst_filing_records WHERE ${conds.join(' AND ')} GROUP BY status ORDER BY status`, params),
      db.query(`SELECT return_type, COUNT(*)::int AS count FROM gst_filing_records WHERE ${conds.join(' AND ')} GROUP BY return_type ORDER BY return_type`, params),
      db.query(`SELECT COUNT(*)::int AS total FROM gst_filing_records WHERE ${conds.join(' AND ')}`, params),
    ]);
    res.json({ success: true, total: totals.rows[0].total, by_status: byStatus.rows, by_return: byReturn.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/history', authMiddleware, async (req, res) => {
  const { gst_client_id, filing_id } = req.query;
  const params = [];
  const conds = ['1=1'];
  if (gst_client_id) { params.push(Number(gst_client_id)); conds.push(`gst_client_id=$${params.length}`); }
  if (filing_id) { params.push(Number(filing_id)); conds.push(`filing_id=$${params.length}`); }
  try {
    const logs = await db.query(
      `SELECT * FROM gst_history_log WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`,
      params
    );
    res.json({ success: true, logs: logs.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/import/preview', authMiddleware, upload.single('file'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
    const parsed = parseGSTWorkbook(req.file.buffer);
    const preview = await buildPreview(parsed);
    res.json({ success: true, sheet: parsed.sheetName, preview });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/import', authMiddleware, upload.single('file'), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Excel file required' });
    const parsed = parseGSTWorkbook(req.file.buffer);
    const preview = await buildPreview(parsed);
    if (preview.missing_client_ids.length) {
      return res.status(400).json({ success: false, message: 'Some client IDs are missing in DB', preview });
    }
    if (preview.missing_assignee_ids.length) {
      return res.status(400).json({ success: false, message: 'Some assignee IDs are missing or inactive', preview });
    }
    const imported = await importRows(parsed);
    res.json({ success: true, message: 'GST Excel import completed', preview, imported });
  } catch (err) {
    handleError(res, err);
  }
});

module.exports = router;
