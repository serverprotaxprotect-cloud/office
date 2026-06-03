const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const crypto = require('crypto');
const db = require('../db');
const authMiddleware = require('../middleware/auth');
const {
  PF_ESIC_STATUSES,
  PF_ESIC_TYPES,
  cleanText,
  encryptText,
  decryptText,
  normalizeCode,
  normalizeStatus,
  isPFESICAdmin,
  currentPeriod,
  financialYearForPeriod,
  periodLabel,
  dueDateForPeriod,
  parsePFESICWorkbook,
} = require('../utils/pfEsicUtils');
const {
  findEmployee,
  findClient,
  generateFilingsForPeriod,
  updateFilingStatus,
  assignFiling,
  logPFESIC,
} = require('../services/pfEsicService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const PF_LOGIN_URL = process.env.PF_LOGIN_URL || 'https://unifiedportal-emp.epfindia.gov.in/epfo/';
const ESIC_LOGIN_URL = process.env.ESIC_LOGIN_URL || 'https://www.esic.in/EmployerPortal/ESICInsurancePortal/Portal_Loginnew.aspx';

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function actorName(actor = {}) {
  return actor.formal_name || actor.name || actor.emp_name || 'System';
}

function actorId(actor = {}) {
  return actor.emp_id || actor.id || actor.username || 'SYSTEM';
}

function handleError(res, err) {
  console.error('[pf-esic]', err);
  if (err.code === '42P01') return res.status(500).json({ success: false, message: 'PF/ESIC tables are not migrated yet' });
  if (err.code === '23505') return res.status(409).json({ success: false, message: 'Duplicate PF/ESIC client or monthly record already exists' });
  return res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Server error' });
}

function mapClient(row) {
  return {
    ...row,
    pf_password: decryptText(row.pf_password_enc),
    esic_password: decryptText(row.esic_password_enc),
    pf_password_enc: undefined,
    esic_password_enc: undefined,
    can_autofill_pf: Boolean(row.pf_login_id && row.pf_password_enc),
    can_autofill_esic: Boolean(row.esic_login_id && row.esic_password_enc),
  };
}

function portalUrl(portalType) {
  return portalType === 'ESIC' ? ESIC_LOGIN_URL : PF_LOGIN_URL;
}

function appendAutofillParams(url, token, portalType, origin) {
  const separator = url.includes('?') ? '&' : '?';
  const safeOrigin = origin || 'production';
  return `${url}${separator}gb_pfesic_autofill=${encodeURIComponent(token)}&gb_portal=${portalType}&gb_origin=${encodeURIComponent(safeOrigin)}`;
}

function sendImportTemplate(res) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([
    {
      client_id: 'PTPCL0001',
      firm_name: 'Example Establishment',
      pf_establishment_code: 'BRPAT0000000',
      pf_login_id: 'PFUSER',
      pf_password: 'password',
      esic_code: '00000000000000000',
      esic_login_id: 'ESICUSER',
      esic_password: 'password',
      default_assignee_id: 'PTP-0001',
      status: 'Active',
    },
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'PF ESIC Clients');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="pf_esic_clients_template.xlsx"');
  res.send(buffer);
}

router.get('/import/template', (req, res) => sendImportTemplate(res));

router.get('/autofill/:token', async (req, res) => {
  const token = req.params.token;
  try {
    await db.runWithTenant({ bypassTenant: true }, async () => {
      const conn = await db.pool.connect();
      try {
        await conn.query('BEGIN');
        const r = await conn.query(
          `SELECT t.*, c.firm_name, c.pf_establishment_code, c.pf_login_id, c.pf_password_enc, c.esic_code, c.esic_login_id, c.esic_password_enc
             FROM pf_esic_autofill_tokens t
             JOIN pf_esic_clients c ON c.id=t.pf_esic_client_id AND c.organization_id=t.organization_id
            WHERE t.token_hash=$1
            FOR UPDATE`,
          [tokenHash(token)]
        );
        if (!r.rows.length) {
          await conn.query('ROLLBACK');
          return res.status(404).json({ success: false, message: 'Autofill token not found' });
        }
        const row = r.rows[0];
        if (row.used_at) {
          await conn.query('ROLLBACK');
          return res.status(410).json({ success: false, message: 'Autofill token already used' });
        }
        if (new Date(row.expires_at).getTime() < Date.now()) {
          await conn.query('ROLLBACK');
          return res.status(410).json({ success: false, message: 'Autofill token expired' });
        }
        await conn.query(`UPDATE pf_esic_autofill_tokens SET used_at=NOW() WHERE id=$1`, [row.id]);
        await conn.query('COMMIT');
        const portalType = row.portal_type;
        res.json({
          success: true,
          portal_type: portalType,
          login_id: portalType === 'ESIC' ? row.esic_login_id : row.pf_login_id,
          password: decryptText(portalType === 'ESIC' ? row.esic_password_enc : row.pf_password_enc),
          code: portalType === 'ESIC' ? row.esic_code : row.pf_establishment_code,
          firm_name: row.firm_name,
          login_url: portalUrl(portalType),
        });
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      } finally {
        conn.release();
      }
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.use(authMiddleware);

router.get('/meta', async (req, res) => {
  try {
    const p = currentPeriod();
    const employees = await db.query(
      `SELECT emp_id, formal_name, name, designation, photo_url
         FROM (
           SELECT emp_id, formal_name, name, designation, photo_url FROM emplist WHERE status='Active'
           UNION ALL
           SELECT username AS emp_id, name AS formal_name, name, role AS designation, photo_url FROM admins WHERE status='Active'
         ) x
        ORDER BY formal_name, name, emp_id`
    );
    res.json({
      success: true,
      employees: employees.rows,
      status_options: PF_ESIC_STATUSES,
      compliance_types: PF_ESIC_TYPES,
      current_period: p,
      financial_year: financialYearForPeriod(p.taxYear, p.taxMonth),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/clients', async (req, res) => {
  try {
    const status = cleanText(req.query.status || 'Active');
    const search = cleanText(req.query.search || '');
    const assignee = cleanText(req.query.assignee || '');
    const limit = Math.min(Number(req.query.limit || 500), 1000);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const params = [];
    const where = [];
    if (status !== 'All') {
      params.push(status);
      where.push(`p.status=$${params.length}`);
    }
    if (assignee) {
      params.push(assignee);
      where.push(`p.default_assignee_id=$${params.length}`);
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(p.client_id) LIKE $${params.length} OR LOWER(p.firm_name) LIKE $${params.length} OR LOWER(COALESCE(p.pf_establishment_code,'')) LIKE $${params.length} OR LOWER(COALESCE(p.esic_code,'')) LIKE $${params.length} OR LOWER(COALESCE(p.default_assignee_name,'')) LIKE $${params.length})`);
    }
    params.push(limit, offset);
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await db.query(
      `SELECT p.*
         FROM pf_esic_clients p
         ${sqlWhere}
        ORDER BY p.status, p.firm_name, p.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const count = await db.query(`SELECT COUNT(*)::int AS total FROM pf_esic_clients p ${sqlWhere}`, params.slice(0, -2));
    res.json({ success: true, clients: rows.rows.map(mapClient), total: count.rows[0]?.total || 0 });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/clients', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const clientId = cleanText(req.body.client_id);
    const baseClient = await findClient(conn, clientId);
    if (!baseClient) {
      const err = new Error('Client not found');
      err.statusCode = 404;
      throw err;
    }
    let assignee = null;
    if (req.body.default_assignee_id) assignee = await findEmployee(conn, cleanText(req.body.default_assignee_id));
    const inserted = await conn.query(
      `INSERT INTO pf_esic_clients
        (client_id, firm_name, pf_establishment_code, pf_login_id, pf_password_enc, esic_code, esic_login_id, esic_password_enc,
         agent_id, agent_name, default_assignee_id, default_assignee_name, status, created_by_id, created_by_name, updated_by_id, updated_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Active',$13,$14,$13,$14)
       RETURNING *`,
      [
        clientId,
        cleanText(req.body.firm_name) || baseClient.business_name || baseClient.legal_name || clientId,
        normalizeCode(req.body.pf_establishment_code),
        cleanText(req.body.pf_login_id),
        encryptText(req.body.pf_password),
        normalizeCode(req.body.esic_code),
        cleanText(req.body.esic_login_id),
        encryptText(req.body.esic_password),
        baseClient.agent_id || null,
        baseClient.agent_name || null,
        assignee?.emp_id || null,
        assignee ? (assignee.formal_name || assignee.name || assignee.emp_id) : null,
        actorId(req.user),
        actorName(req.user),
      ]
    );
    await logPFESIC(conn, { pf_esic_client_id: inserted.rows[0].id, action: 'client_created', new_value: inserted.rows[0], actor: req.user });
    await conn.query('COMMIT');
    res.json({ success: true, client: mapClient(inserted.rows[0]) });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/clients/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const oldRes = await conn.query(`SELECT * FROM pf_esic_clients WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!oldRes.rows.length) {
      const err = new Error('PF/ESIC client not found');
      err.statusCode = 404;
      throw err;
    }
    let assignee = null;
    if (req.body.default_assignee_id) assignee = await findEmployee(conn, cleanText(req.body.default_assignee_id));
    const old = oldRes.rows[0];
    const updated = await conn.query(
      `UPDATE pf_esic_clients SET
         firm_name=COALESCE(NULLIF($1,''),firm_name),
         pf_establishment_code=$2,
         pf_login_id=$3,
         pf_password_enc=COALESCE($4,pf_password_enc),
         esic_code=$5,
         esic_login_id=$6,
         esic_password_enc=COALESCE($7,esic_password_enc),
         default_assignee_id=$8,
         default_assignee_name=$9,
         updated_by_id=$10,
         updated_by_name=$11,
         updated_at=NOW()
       WHERE id=$12
       RETURNING *`,
      [
        cleanText(req.body.firm_name),
        normalizeCode(req.body.pf_establishment_code),
        cleanText(req.body.pf_login_id),
        req.body.pf_password ? encryptText(req.body.pf_password) : null,
        normalizeCode(req.body.esic_code),
        cleanText(req.body.esic_login_id),
        req.body.esic_password ? encryptText(req.body.esic_password) : null,
        assignee?.emp_id || null,
        assignee ? (assignee.formal_name || assignee.name || assignee.emp_id) : null,
        actorId(req.user),
        actorName(req.user),
        req.params.id,
      ]
    );
    await logPFESIC(conn, { pf_esic_client_id: old.id, action: 'client_updated', old_value: old, new_value: updated.rows[0], actor: req.user });
    await conn.query('COMMIT');
    res.json({ success: true, client: mapClient(updated.rows[0]) });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/clients/:id/assign', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const employee = await findEmployee(conn, cleanText(req.body.assignee_id));
    if (!employee) {
      const err = new Error('Assignee not found');
      err.statusCode = 404;
      throw err;
    }
    const name = employee.formal_name || employee.name || employee.emp_id;
    const old = await conn.query(`SELECT * FROM pf_esic_clients WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!old.rows.length) {
      const err = new Error('PF/ESIC client not found');
      err.statusCode = 404;
      throw err;
    }
    const updated = await conn.query(
      `UPDATE pf_esic_clients SET default_assignee_id=$1, default_assignee_name=$2, updated_by_id=$3, updated_by_name=$4, updated_at=NOW() WHERE id=$5 RETURNING *`,
      [employee.emp_id, name, actorId(req.user), actorName(req.user), req.params.id]
    );
    await conn.query(
      `UPDATE pf_esic_filing_records
          SET assigned_to_id=$1, assigned_to_name=$2, updated_at=NOW()
        WHERE pf_esic_client_id=$3 AND assigned_to_id IS NULL`,
      [employee.emp_id, name, req.params.id]
    );
    await logPFESIC(conn, { pf_esic_client_id: req.params.id, action: 'client_assigned', old_value: old.rows[0], new_value: { assigned_to_id: employee.emp_id, assigned_to_name: name }, remarks: req.body.remark, actor: req.user });
    await conn.query('COMMIT');
    res.json({ success: true, client: mapClient(updated.rows[0]) });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

router.put('/clients/:id/status', async (req, res) => {
  try {
    const status = cleanText(req.body.status || 'Inactive');
    const updated = await db.query(
      `UPDATE pf_esic_clients
          SET status=$1,
              inactive_reason=CASE WHEN $1='Inactive' THEN $2 ELSE NULL END,
              inactive_from=CASE WHEN $1='Inactive' THEN COALESCE($3::date, CURRENT_DATE) ELSE NULL END,
              updated_by_id=$4,
              updated_by_name=$5,
              updated_at=NOW()
        WHERE id=$6
        RETURNING *`,
      [status, req.body.reason || null, req.body.inactive_from || null, actorId(req.user), actorName(req.user), req.params.id]
    );
    if (!updated.rows.length) return res.status(404).json({ success: false, message: 'PF/ESIC client not found' });
    res.json({ success: true, client: mapClient(updated.rows[0]) });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/filings', async (req, res) => {
  try {
    const taxYear = Number(req.query.tax_year || currentPeriod().taxYear);
    const taxMonth = Number(req.query.tax_month || currentPeriod().taxMonth);
    const search = cleanText(req.query.search || '');
    const status = cleanText(req.query.status || '');
    const type = cleanText(req.query.type || '');
    const assignee = cleanText(req.query.assignee || '');
    const params = [taxYear, taxMonth];
    const where = [`f.tax_year=$1`, `f.tax_month=$2`];
    if (status) { params.push(status); where.push(`f.status=$${params.length}`); }
    if (type) { params.push(type); where.push(`f.compliance_type=$${params.length}`); }
    if (assignee) { params.push(assignee); where.push(`f.assigned_to_id=$${params.length}`); }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where.push(`(LOWER(f.client_id) LIKE $${params.length} OR LOWER(f.firm_name) LIKE $${params.length} OR LOWER(COALESCE(f.pf_establishment_code,'')) LIKE $${params.length} OR LOWER(COALESCE(f.esic_code,'')) LIKE $${params.length})`);
    }
    const rows = await db.query(
      `SELECT f.*, p.status AS client_status
         FROM pf_esic_filing_records f
         JOIN pf_esic_clients p ON p.id=f.pf_esic_client_id
        WHERE ${where.join(' AND ')}
        ORDER BY f.due_date, f.firm_name, f.compliance_type`,
      params
    );
    res.json({ success: true, filings: rows.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/generate', async (req, res) => {
  try {
    const taxYear = Number(req.body.tax_year || currentPeriod().taxYear);
    const taxMonth = Number(req.body.tax_month || currentPeriod().taxMonth);
    const summary = await generateFilingsForPeriod({ taxYear, taxMonth, actor: req.user, source: 'manual' });
    res.json({ success: true, summary });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/filings/:id/status', async (req, res) => {
  try {
    const row = await updateFilingStatus(req.params.id, req.body, req.user);
    res.json({ success: true, filing: row });
  } catch (err) {
    handleError(res, err);
  }
});

router.put('/filings/:id/assign', async (req, res) => {
  try {
    const row = await assignFiling(req.params.id, cleanText(req.body.assignee_id), req.body.remark, req.user);
    res.json({ success: true, filing: row });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/reports/summary', async (req, res) => {
  try {
    const taxYear = Number(req.query.tax_year || currentPeriod().taxYear);
    const taxMonth = Number(req.query.tax_month || currentPeriod().taxMonth);
    const rows = await db.query(
      `SELECT compliance_type, status, COUNT(*)::int AS count, COALESCE(SUM(amount),0)::numeric AS amount
         FROM pf_esic_filing_records
        WHERE tax_year=$1 AND tax_month=$2
        GROUP BY compliance_type, status
        ORDER BY compliance_type, status`,
      [taxYear, taxMonth]
    );
    const flat = await db.query(
      `SELECT f.*, p.default_assignee_name
         FROM pf_esic_filing_records f
         JOIN pf_esic_clients p ON p.id=f.pf_esic_client_id
        WHERE f.tax_year=$1 AND f.tax_month=$2
        ORDER BY f.firm_name, f.compliance_type`,
      [taxYear, taxMonth]
    );
    res.json({ success: true, summary: rows.rows, rows: flat.rows });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/clients/:id/autofill-token', async (req, res) => {
  try {
    const portalType = cleanText(req.body.portal_type || 'PF').toUpperCase() === 'ESIC' ? 'ESIC' : 'PF';
    const clientRes = await db.query(`SELECT * FROM pf_esic_clients WHERE id=$1 AND status='Active'`, [req.params.id]);
    if (!clientRes.rows.length) return res.status(404).json({ success: false, message: 'PF/ESIC client not found' });
    const row = clientRes.rows[0];
    const loginId = portalType === 'ESIC' ? row.esic_login_id : row.pf_login_id;
    const password = decryptText(portalType === 'ESIC' ? row.esic_password_enc : row.pf_password_enc);
    if (!loginId || !password) return res.status(400).json({ success: false, message: `${portalType} login/password not saved` });
    const token = randomToken();
    const expires = new Date(Date.now() + 60 * 1000);
    await db.query(
      `INSERT INTO pf_esic_autofill_tokens (token_hash, pf_esic_client_id, portal_type, created_by_id, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [tokenHash(token), row.id, portalType, actorId(req.user), expires]
    );
    res.json({
      success: true,
      token,
      expires_at: expires.toISOString(),
      extension_url_hint: appendAutofillParams(portalUrl(portalType), token, portalType, req.body.origin),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/autofill/:token', async (req, res) => {
  const token = req.params.token;
  try {
    await db.runWithTenant({ bypassTenant: true }, async () => {
      const conn = await db.pool.connect();
      try {
        await conn.query('BEGIN');
        const r = await conn.query(
          `SELECT t.*, c.firm_name, c.pf_establishment_code, c.pf_login_id, c.pf_password_enc, c.esic_code, c.esic_login_id, c.esic_password_enc
             FROM pf_esic_autofill_tokens t
             JOIN pf_esic_clients c ON c.id=t.pf_esic_client_id AND c.organization_id=t.organization_id
            WHERE t.token_hash=$1
            FOR UPDATE`,
          [tokenHash(token)]
        );
        if (!r.rows.length) {
          await conn.query('ROLLBACK');
          return res.status(404).json({ success: false, message: 'Autofill token not found' });
        }
        const row = r.rows[0];
        if (row.used_at) {
          await conn.query('ROLLBACK');
          return res.status(410).json({ success: false, message: 'Autofill token already used' });
        }
        if (new Date(row.expires_at).getTime() < Date.now()) {
          await conn.query('ROLLBACK');
          return res.status(410).json({ success: false, message: 'Autofill token expired' });
        }
        await conn.query(`UPDATE pf_esic_autofill_tokens SET used_at=NOW() WHERE id=$1`, [row.id]);
        await conn.query('COMMIT');
        const portalType = row.portal_type;
        res.json({
          success: true,
          portal_type: portalType,
          login_id: portalType === 'ESIC' ? row.esic_login_id : row.pf_login_id,
          password: decryptText(portalType === 'ESIC' ? row.esic_password_enc : row.pf_password_enc),
          code: portalType === 'ESIC' ? row.esic_code : row.pf_establishment_code,
          firm_name: row.firm_name,
          login_url: portalUrl(portalType),
        });
      } catch (err) {
        await conn.query('ROLLBACK');
        throw err;
      } finally {
        conn.release();
      }
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get('/import/template', (req, res) => sendImportTemplate(res));

router.post('/import/preview', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'File required' });
    const parsed = parsePFESICWorkbook(req.file.buffer);
    res.json({ success: true, sheet: parsed.sheetName, total: parsed.rows.length, rows: parsed.rows.slice(0, 50) });
  } catch (err) {
    handleError(res, err);
  }
});

router.post('/import', upload.single('file'), async (req, res) => {
  const conn = await db.pool.connect();
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'File required' });
    const parsed = parsePFESICWorkbook(req.file.buffer);
    const summary = { total: parsed.rows.length, inserted: 0, updated: 0, skipped: 0, errors: [] };
    await conn.query('BEGIN');
    for (const row of parsed.rows) {
      try {
        const baseClient = await findClient(conn, row.client_id);
        if (!baseClient) throw new Error(`Client not found: ${row.client_id}`);
        let assignee = null;
        if (row.default_assignee_id) assignee = await findEmployee(conn, row.default_assignee_id);
        const existing = await conn.query(`SELECT * FROM pf_esic_clients WHERE client_id=$1 LIMIT 1`, [row.client_id]);
        const values = [
          row.client_id,
          row.firm_name || baseClient.business_name || baseClient.legal_name || row.client_id,
          row.pf_establishment_code || null,
          row.pf_login_id || null,
          row.pf_password ? encryptText(row.pf_password) : null,
          row.esic_code || null,
          row.esic_login_id || null,
          row.esic_password ? encryptText(row.esic_password) : null,
          baseClient.agent_id || null,
          baseClient.agent_name || null,
          assignee?.emp_id || null,
          assignee ? (assignee.formal_name || assignee.name || assignee.emp_id) : null,
          actorId(req.user),
          actorName(req.user),
          parsed.sheetName,
          row.source_row || null,
        ];
        if (existing.rows.length) {
          await conn.query(
            `UPDATE pf_esic_clients SET firm_name=$2, pf_establishment_code=$3, pf_login_id=$4,
               pf_password_enc=COALESCE($5,pf_password_enc), esic_code=$6, esic_login_id=$7,
               esic_password_enc=COALESCE($8,esic_password_enc), default_assignee_id=$11,
               default_assignee_name=$12, updated_by_id=$13, updated_by_name=$14, updated_at=NOW()
             WHERE id=$17`,
            [...values, existing.rows[0].id]
          );
          summary.updated += 1;
        } else {
          await conn.query(
            `INSERT INTO pf_esic_clients
              (client_id, firm_name, pf_establishment_code, pf_login_id, pf_password_enc, esic_code, esic_login_id, esic_password_enc,
               agent_id, agent_name, default_assignee_id, default_assignee_name, created_by_id, created_by_name, updated_by_id, updated_by_name, source, source_sheet, source_row)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13,$14,'import',$15,$16)`,
            values
          );
          summary.inserted += 1;
        }
      } catch (rowErr) {
        summary.skipped += 1;
        summary.errors.push({ row: row.__row_number, message: rowErr.message });
      }
    }
    await conn.query('COMMIT');
    res.json({ success: true, summary });
  } catch (err) {
    await conn.query('ROLLBACK');
    handleError(res, err);
  } finally {
    conn.release();
  }
});

module.exports = router;
