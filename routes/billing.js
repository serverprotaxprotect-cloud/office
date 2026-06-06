const express = require('express');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const FEATURE_KEY = 'billing';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BILLING_ROLES = new Set(['Director', 'Owner', 'Proprietor', 'Accountant']);

function clean(value) {
  return String(value || '').trim();
}

function amount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function actorId(user = {}) {
  return user.emp_id || user.username || String(user.id || 'SYSTEM');
}

function actorName(user = {}) {
  return user.formal_name || user.name || user.username || 'System';
}

function isBillingUser(user = {}) {
  const role = user.role || user.designation || '';
  if (BILLING_ROLES.has(role)) return true;
  return /owner|director|accountant/i.test(role);
}

function financialYear(dateValue = new Date()) {
  const d = new Date(dateValue);
  const y = d.getFullYear();
  const start = d.getMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

async function billingAccess(req) {
  const r = await db.query(
    `SELECT access_level FROM organization_feature_access
      WHERE organization_id=$1 AND feature_key=$2`,
    [req.user.organization_id, FEATURE_KEY]
  );
  const orgAccess = r.rows[0]?.access_level || 'none';
  if (orgAccess === 'none' || !isBillingUser(req.user)) {
    return { allowed: false, access_level: 'none', can_write: false };
  }
  return {
    allowed: true,
    access_level: orgAccess,
    can_write: orgAccess === 'full',
  };
}

async function requireBilling(req, res, next) {
  try {
    const access = await billingAccess(req);
    if (!access.allowed) {
      return res.status(403).json({ success: false, message: 'Billing access not enabled for this user/organisation' });
    }
    if (WRITE_METHODS.has(req.method) && !access.can_write) {
      return res.status(403).json({ success: false, message: 'Billing is view-only for this organisation' });
    }
    req.billingAccess = access;
    next();
  } catch (err) {
    console.error('[billing access]', err);
    res.status(500).json({ success: false, message: 'Billing access check failed' });
  }
}

async function ensurePrimaryProfile(conn, orgId) {
  const existing = await conn.query(
    `WITH ctx AS MATERIALIZED (
       SELECT set_config('app.organization_id',$1::text,false)
     )
     SELECT bp.* FROM ctx CROSS JOIN billing_profiles bp
      WHERE bp.organization_id=$1::int AND bp.profile_type='gst' LIMIT 1`,
    [Number(orgId)]
  );
  if (existing.rows.length) return existing.rows[0];
  const source = await conn.query(
    `SELECT o.office_name, o.state, bs.legal_name, bs.gstin, bs.address, bs.phone, bs.email
       FROM organizations o
       LEFT JOIN billing_settings bs ON bs.organization_id=o.id
      WHERE o.id=$1 LIMIT 1`,
    [orgId]
  );
  const row = source.rows[0] || {};
  const inserted = await conn.query(
    `INSERT INTO billing_profiles
      (organization_id, profile_type, display_name, legal_name, gstin, address, state, phone, email)
     VALUES ($1,'gst',$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      orgId,
      `${row.legal_name || row.office_name || 'Primary'} With GST`,
      row.legal_name || row.office_name || null,
      row.gstin || null,
      row.address || null,
      row.state || null,
      row.phone || null,
      row.email || null,
    ]
  );
  return inserted.rows[0];
}

async function billingProfile(conn, orgId, profileId, { active = true } = {}) {
  if (!profileId) return ensurePrimaryProfile(conn, orgId);
  const r = await conn.query(
    `WITH ctx AS MATERIALIZED (
       SELECT set_config('app.organization_id',$2::text,false)
     )
     SELECT bp.* FROM ctx CROSS JOIN billing_profiles bp
      WHERE bp.id=$1 AND bp.organization_id=$2::int ${active ? `AND bp.status='Active'` : ''}`,
    [profileId, Number(orgId)]
  );
  return r.rows[0] || null;
}

async function ensureSettings(conn, orgId, profileId, createIfMissing = true) {
  const profile = await billingProfile(conn, orgId, profileId);
  if (!profile) throw Object.assign(new Error('Billing profile not found'), { statusCode: 404 });
  const existing = await conn.query(
    `WITH ctx AS MATERIALIZED (
       SELECT set_config('app.organization_id',$1::text,false)
     )
     SELECT bs.* FROM ctx CROSS JOIN billing_settings bs
      WHERE bs.organization_id=$1::int AND bs.profile_id=$2
      FOR UPDATE OF bs`,
    [Number(orgId), profile.id]
  );
  if (existing.rows.length) return existing.rows[0];
  if (!createIfMissing) {
    return {
      organization_id: orgId,
      profile_id: profile.id,
      invoice_prefix: 'INV',
      proforma_prefix: 'PRO',
      next_invoice_no: 1,
      next_proforma_no: 1,
      gstin: profile.gstin,
      legal_name: profile.legal_name,
      phone: profile.phone,
      email: profile.email,
      address: profile.address,
      state: profile.state,
      gst_applicable: profile.profile_type === 'gst',
      default_tax_rate: 18,
      upi_id: null,
      upi_name: null,
      terms: 'Payment due on receipt unless otherwise agreed.',
      bank_details: null,
    };
  }
  const inserted = await conn.query(
    `INSERT INTO billing_settings
      (organization_id, profile_id, state, gstin, legal_name, phone, email, address, gst_applicable, terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Payment due on receipt unless otherwise agreed.')
     RETURNING *`,
    [
      orgId, profile.id, profile.state || null, profile.gstin || null, profile.legal_name || null,
      profile.phone || null, profile.email || null, profile.address || null, profile.profile_type === 'gst',
    ]
  );
  return inserted.rows[0];
}

async function nextDocumentNo(conn, settings, type, fy, manualNo) {
  if (clean(manualNo)) return clean(manualNo);
  const isInvoice = type === 'invoice';
  const prefix = isInvoice ? settings.invoice_prefix : settings.proforma_prefix;
  const next = Number(isInvoice ? settings.next_invoice_no : settings.next_proforma_no) || 1;
  const no = `${prefix}/${fy}/${String(next).padStart(4, '0')}`;
  await conn.query(
    `UPDATE billing_settings
        SET next_invoice_no = CASE WHEN $1='invoice' THEN next_invoice_no + 1 ELSE next_invoice_no END,
            next_proforma_no = CASE WHEN $1='proforma' THEN next_proforma_no + 1 ELSE next_proforma_no END,
            updated_at=NOW()
      WHERE id=$2`,
    [type, settings.id]
  );
  return no;
}

function normalizedName(value) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ');
}

async function clientForBilling(conn, clientId, clientName = '') {
  const orgId = Number(db.getTenantContext().organizationId || 0);
  let r = await conn.query(
    `SELECT client_id, legal_name, business_name, gst_no, state, address, mobile_number, email_id
       FROM clients
      WHERE client_id=$1 AND organization_id=$2`,
    [clientId, orgId]
  );
  if (r.rows.length) return r.rows[0];
  const name = clean(clientName);
  if (name) {
    r = await conn.query(
      `SELECT client_id, legal_name, business_name, gst_no, state, address, mobile_number, email_id
         FROM clients
        WHERE organization_id=$2
          AND (LOWER(TRIM(legal_name))=LOWER(TRIM($1))
           OR LOWER(TRIM(business_name))=LOWER(TRIM($1)))
        ORDER BY CASE WHEN LOWER(TRIM(legal_name))=LOWER(TRIM($1)) THEN 0 ELSE 1 END
        LIMIT 1`,
      [name, orgId]
    );
    if (r.rows.length) return r.rows[0];
    r = await conn.query(
      `SELECT c.client_id, c.legal_name, c.business_name, c.gst_no, c.state, c.address, c.mobile_number, c.email_id
         FROM companies co
         JOIN clients c ON c.client_id=co.client_id
        WHERE co.organization_id=$2 AND c.organization_id=$2
          AND LOWER(TRIM(co.company_name))=LOWER(TRIM($1))
        LIMIT 1`,
      [name, orgId]
    );
  }
  return r.rows[0] || null;
}

async function resolveTaskClients(conn, tasks) {
  if (!tasks.length) return tasks;
  const orgId = Number(db.getTenantContext().organizationId || 0);
  const [clientsResult, companiesResult] = await Promise.all([
    conn.query(`SELECT client_id, legal_name, business_name, gst_no, state, address, mobile_number, email_id FROM clients WHERE organization_id=$1`, [orgId]),
    conn.query(`SELECT client_id, company_name FROM companies WHERE organization_id=$1 AND NULLIF(client_id,'') IS NOT NULL`, [orgId]),
  ]);
  const clientsById = new Map();
  const clientsByName = new Map();
  for (const client of clientsResult.rows) {
    clientsById.set(clean(client.client_id), client);
    for (const name of [client.legal_name, client.business_name]) {
      if (normalizedName(name) && !clientsByName.has(normalizedName(name))) clientsByName.set(normalizedName(name), client);
    }
  }
  const companyClientByName = new Map();
  for (const company of companiesResult.rows) {
    const client = clientsById.get(clean(company.client_id));
    if (client && normalizedName(company.company_name)) companyClientByName.set(normalizedName(company.company_name), client);
  }
  return tasks.map(task => {
    const taskName = task.legal_name || task.business_name || task.client_name;
    const client = clientsById.get(clean(task.source_client_id || task.client_id))
      || clientsByName.get(normalizedName(taskName))
      || companyClientByName.get(normalizedName(taskName));
    return {
      ...task,
      source_client_id: task.source_client_id || task.client_id,
      client_id: client?.client_id || null,
      client_name: client?.legal_name || client?.business_name || taskName || task.client_id,
      client_resolved: Boolean(client),
      client_gstin: client?.gst_no || null,
      client_state: client?.state || null,
      client_address: client?.address || null,
      client_contact: client?.mobile_number || null,
    };
  });
}

function paymentSnapshot(account) {
  if (!account) return null;
  return {
    id: account.id,
    account_name: account.account_name,
    account_type: account.account_type,
    bank_name: account.bank_name,
    account_no: account.account_no,
    ifsc: account.ifsc,
    upi_id: account.upi_id,
    upi_name: account.upi_name,
  };
}

async function audit(conn, req, entityType, entityId, action, oldValue, newValue, remarks, profileId = null) {
  await conn.query(
    `INSERT INTO billing_audit_log
       (entity_type, entity_id, action, old_value, new_value, remarks, updated_by_id, updated_by_name, profile_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entityType, entityId || null, action, oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null, remarks || null, actorId(req.user), actorName(req.user), profileId]
  );
}

function taxSplit({ taxable, taxRate, taxMode, orgState, clientState }) {
  const rate = amount(taxRate);
  if (!rate || taxMode === 'None') return { cgst: 0, sgst: 0, igst: 0 };
  const stateKey = value => clean(value).toLowerCase().replace(/^\d+\s*[-:]\s*/, '').replace(/\s+/g, ' ');
  const sameState = stateKey(orgState) && stateKey(orgState) === stateKey(clientState);
  const mode = taxMode === 'Auto' ? (sameState ? 'CGST_SGST' : 'IGST') : taxMode;
  const tax = amount(taxable * rate / 100);
  if (mode === 'CGST_SGST') return { cgst: amount(tax / 2), sgst: amount(tax / 2), igst: 0 };
  if (mode === 'IGST') return { cgst: 0, sgst: 0, igst: tax };
  return { cgst: 0, sgst: 0, igst: 0 };
}

async function releaseDocumentTasks(conn, documentId, user, taskIds = null) {
  const params = [documentId, actorId(user)];
  let filter = '';
  if (Array.isArray(taskIds)) {
    params.push(taskIds);
    filter = ` AND task_id = ANY($3)`;
  }
  const released = await conn.query(
    `UPDATE billing_document_tasks
        SET is_active_claim=FALSE, released_at=NOW(), released_by_id=$2
      WHERE document_id=$1 AND is_active_claim=TRUE${filter}
      RETURNING task_id`,
    params
  );
  const ids = released.rows.map(row => row.task_id);
  if (ids.length) {
    await conn.query(
      `UPDATE tasks t
          SET billing_status=NULL
        WHERE t.task_id = ANY($1)
          AND NOT EXISTS (
            SELECT 1 FROM billing_document_tasks claim
             WHERE claim.task_id=t.task_id AND claim.is_active_claim=TRUE
          )`,
      [ids]
    );
  }
  return ids;
}

async function createDocument(req, res, type, fromProformaId = null) {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const orgId = req.user.organization_id;
    let payload = req.body || {};
    let sourceProforma = null;
    if (fromProformaId) {
      const p = await conn.query(
        `SELECT * FROM billing_documents
          WHERE id=$1 AND document_type='proforma' AND status NOT IN ('Cancelled','Deleted')
          FOR UPDATE`,
        [fromProformaId]
      );
      if (!p.rows.length) {
        const err = new Error('Proforma not found');
        err.statusCode = 404;
        throw err;
      }
      sourceProforma = p.rows[0];
      const lines = await conn.query(`SELECT * FROM billing_document_lines WHERE document_id=$1 ORDER BY line_no`, [fromProformaId]);
      const tasks = await conn.query(`SELECT * FROM billing_document_tasks WHERE document_id=$1`, [fromProformaId]);
      payload = {
        ...payload,
        profile_id: sourceProforma.profile_id,
        client_id: sourceProforma.client_id,
        document_date: payload.document_date || new Date().toISOString().slice(0, 10),
        tax_mode: payload.tax_mode || sourceProforma.tax_mode,
        payment_account_id: payload.payment_account_id || sourceProforma.payment_account_id,
        notes: payload.notes || sourceProforma.notes,
        terms: payload.terms || sourceProforma.terms,
        lines: lines.rows.map(l => ({
          description: l.description,
          quantity: l.quantity,
          rate: l.rate,
          tax_rate: l.tax_rate,
          task_ids: tasks.rows.filter(t => t.line_id === l.id).map(t => t.task_id),
        })),
      };
    }
    const profile = await billingProfile(conn, orgId, payload.profile_id);
    if (!profile) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    const settings = await ensureSettings(conn, orgId, profile.id);
    const docDate = payload.document_date || new Date().toISOString().slice(0, 10);
    const fy = payload.financial_year || financialYear(docDate);
    const client = await clientForBilling(conn, payload.client_id, payload.client_name);
    if (!client) {
      const err = new Error('Client not found');
      err.statusCode = 404;
      throw err;
    }
    const rawLines = Array.isArray(payload.lines) && payload.lines.length ? payload.lines : [];
    if (!rawLines.length) {
      const err = new Error('At least one billing line required');
      err.statusCode = 400;
      throw err;
    }
    const allTaskIds = rawLines.flatMap(l => Array.isArray(l.task_ids) ? l.task_ids.map(clean).filter(Boolean) : []);
    if (type === 'invoice' && allTaskIds.length) {
      const billed = await conn.query(
        `SELECT bdt.task_id, bd.document_no
           FROM billing_document_tasks bdt
           JOIN billing_documents bd ON bd.id=bdt.document_id AND bd.organization_id=bdt.organization_id
          WHERE bdt.task_id = ANY($1) AND bdt.is_active_claim=TRUE
          LIMIT 1`,
        [allTaskIds]
      );
      if (billed.rows.length) {
        const err = new Error(`Task already billed in ${billed.rows[0].document_no}`);
        err.statusCode = 409;
        throw err;
      }
    }
    const docNo = await nextDocumentNo(conn, settings, type, fy, payload.document_no);
    const duplicate = await conn.query(
      `SELECT id FROM billing_documents WHERE profile_id=$1 AND document_type=$2 AND document_no=$3`,
      [profile.id, type, docNo]
    );
    if (duplicate.rows.length) {
      const err = new Error('Document number already exists');
      err.statusCode = 409;
      throw err;
    }
    const normalizedLines = rawLines.map((line, idx) => {
      const qty = amount(line.quantity || 1) || 1;
      const rate = amount(line.rate || line.amount || 0);
      return {
        line_no: idx + 1,
        description: clean(line.description) || 'Professional Services',
        quantity: qty,
        rate,
        amount: amount(qty * rate),
        tax_rate: amount(line.tax_rate ?? settings.default_tax_rate),
        hsn_sac: clean(line.hsn_sac) || null,
        task_ids: Array.isArray(line.task_ids) ? line.task_ids.map(clean).filter(Boolean) : [],
        task_names: line.task_names && typeof line.task_names === 'object' ? line.task_names : {},
      };
    });
    const clientState = clean(payload.client_state) || client.state || null;
    const clientAddress = payload.client_address !== undefined ? payload.client_address : client.address;
    const clientGstin = clean(payload.client_gstin) || client.gst_no || null;
    const clientContact = clean(payload.client_contact) || client.mobile_number || null;
    const placeOfSupply = clean(payload.place_of_supply) || clientState || null;
    const gstApplicable = profile.profile_type === 'gst' && settings.gst_applicable !== false;
    const effectiveTaxMode = gstApplicable ? (payload.tax_mode || 'Auto') : 'None';
    const taxable = amount(normalizedLines.reduce((sum, l) => sum + l.amount, 0));
    const tax = normalizedLines.reduce((sum, line) => {
      const split = taxSplit({
        taxable: line.amount,
        taxRate: gstApplicable ? line.tax_rate : 0,
        taxMode: effectiveTaxMode,
        orgState: settings.state,
        clientState: placeOfSupply || clientState,
      });
      return {
        cgst: amount(sum.cgst + split.cgst),
        sgst: amount(sum.sgst + split.sgst),
        igst: amount(sum.igst + split.igst),
      };
    }, { cgst: 0, sgst: 0, igst: 0 });
    const total = amount(taxable + tax.cgst + tax.sgst + tax.igst);
    let paymentAccount = null;
    if (payload.payment_account_id) {
      const payment = await conn.query(
        `SELECT * FROM billing_bank_accounts WHERE id=$1 AND profile_id=$2 AND status='Active'`,
        [payload.payment_account_id, profile.id]
      );
      paymentAccount = payment.rows[0] || null;
    }
    if (!paymentAccount) {
      const payment = await conn.query(
        `SELECT * FROM billing_bank_accounts
          WHERE profile_id=$1 AND status='Active'
          ORDER BY is_default DESC, id LIMIT 1`,
        [profile.id]
      );
      paymentAccount = payment.rows[0] || null;
    }
    const paymentDetails = paymentSnapshot(paymentAccount);
    const doc = await conn.query(
      `INSERT INTO billing_documents
        (profile_id, document_type, document_no, financial_year, document_date, client_id, client_name, client_gstin,
         client_contact, client_state, place_of_supply, client_address, tax_mode, taxable_amount, cgst_amount, sgst_amount, igst_amount,
         total_amount, status, notes, terms, payment_account_id, payment_details, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'Final',$19,$20,$21,$22,$23,$24)
       RETURNING *`,
      [
        profile.id, type, docNo, fy, docDate, client.client_id, clean(payload.client_name) || client.legal_name || client.business_name || client.client_id,
        clientGstin, clientContact, clientState, placeOfSupply, clientAddress || null, effectiveTaxMode,
        taxable, tax.cgst, tax.sgst, tax.igst, total, payload.notes || null, payload.terms || settings.terms || null,
        paymentAccount?.id || null, paymentDetails ? JSON.stringify(paymentDetails) : null,
        actorId(req.user), actorName(req.user),
      ]
    );
    for (const line of normalizedLines) {
      const insertedLine = await conn.query(
        `INSERT INTO billing_document_lines
          (document_id, line_no, description, hsn_sac, quantity, rate, amount, tax_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [doc.rows[0].id, line.line_no, line.description, line.hsn_sac, line.quantity, line.rate, line.amount, line.tax_rate]
      );
      if (line.task_ids.length) {
        const taskRows = await conn.query(
          `SELECT task_id, work_name, total_amount FROM tasks WHERE task_id = ANY($1)`,
          [line.task_ids]
        );
        for (const t of taskRows.rows) {
          const customTaskName = clean(line.task_names?.[t.task_id]);
          await conn.query(
            `INSERT INTO billing_document_tasks
              (document_id, line_id, task_id, task_work_name, task_amount, is_active_claim)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (organization_id, document_id, task_id)
             DO UPDATE SET line_id=EXCLUDED.line_id, task_work_name=EXCLUDED.task_work_name,
                           task_amount=EXCLUDED.task_amount, is_active_claim=EXCLUDED.is_active_claim,
                           released_at=NULL, released_by_id=NULL`,
            [doc.rows[0].id, insertedLine.rows[0].id, t.task_id, customTaskName || t.work_name, t.total_amount || 0, type === 'invoice']
          );
        }
      }
    }
    if (payload.update_client_master) {
      await conn.query(
        `UPDATE clients
            SET address=COALESCE($2,address),
                gst_no=COALESCE($3,gst_no),
                state=COALESCE($4,state),
                mobile_number=COALESCE($5,mobile_number)
          WHERE client_id=$1`,
        [client.client_id, clientAddress || null, clientGstin || null, clientState || null, clientContact || null]
      );
    }
    if (type === 'invoice') {
      await conn.query(
        `INSERT INTO billing_ledger_entries
          (profile_id, client_id, entry_date, entry_type, document_id, debit, credit, narration)
         VALUES ($1,$2,$3,'Invoice',$4,$5,0,$6)`,
        [profile.id, client.client_id, docDate, doc.rows[0].id, total, `Invoice ${docNo}`]
      );
      if (allTaskIds.length) {
        await conn.query(`UPDATE tasks SET billing_status='Billed' WHERE task_id = ANY($1)`, [allTaskIds]);
      }
    }
    await audit(conn, req, 'billing_document', doc.rows[0].id, type === 'invoice' ? 'invoice_created' : 'proforma_created', null, doc.rows[0], payload.manual_reason || null, profile.id);
    if (sourceProforma) {
      await audit(conn, req, 'billing_document', doc.rows[0].id, 'invoice_from_proforma', sourceProforma, doc.rows[0], null, profile.id);
    }
    await conn.query('COMMIT');
    res.json({
      success: true,
      message: type === 'invoice' ? (profile.profile_type === 'gst' ? 'Tax invoice created' : 'Invoice created') : 'Proforma created',
      document: doc.rows[0],
    });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing create document]', err);
    res.status(err.statusCode || (err.code === '23505' ? 409 : 500)).json({ success: false, message: err.message || 'Server error' });
  } finally {
    conn.release();
  }
}

router.use(authMiddleware);
router.use(requireBilling);

router.get('/me', async (req, res) => {
  res.json({
    success: true,
    access: req.billingAccess,
    user: {
      emp_id: actorId(req.user),
      name: actorName(req.user),
      role: req.user.role || req.user.designation || '',
      organization_name: req.user.organization_name,
      organization_code: req.user.organization_code,
    },
  });
});

router.get('/profiles', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    if (req.billingAccess.can_write) await ensurePrimaryProfile(conn, req.user.organization_id);
    const result = await conn.query(
      `SELECT bp.*,
              bs.invoice_prefix, bs.proforma_prefix, bs.gst_applicable, bs.default_tax_rate
         FROM billing_profiles bp
         LEFT JOIN billing_settings bs ON bs.profile_id=bp.id
        WHERE bp.organization_id=$1
        ORDER BY CASE bp.profile_type WHEN 'gst' THEN 0 ELSE 1 END`,
      [req.user.organization_id]
    );
    await conn.query('COMMIT');
    res.json({ success: true, profiles: result.rows });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing profiles]', err);
    res.status(500).json({ success: false, message: 'Billing profiles load failed' });
  } finally {
    conn.release();
  }
});

router.post('/profiles', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const profileType = req.body.profile_type === 'non_gst' ? 'non_gst' : 'gst';
    const count = await conn.query(`SELECT COUNT(*)::int AS count FROM billing_profiles WHERE organization_id=$1`, [req.user.organization_id]);
    if (count.rows[0].count >= 2) {
      const err = new Error('Maximum two billing profiles are allowed');
      err.statusCode = 409;
      throw err;
    }
    const inserted = await conn.query(
      `INSERT INTO billing_profiles
        (profile_type, display_name, legal_name, gstin, address, state, phone, email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        profileType,
        clean(req.body.display_name) || (profileType === 'gst' ? 'With GST' : 'Without GST'),
        clean(req.body.legal_name) || null,
        profileType === 'gst' ? clean(req.body.gstin) || null : null,
        req.body.address || null,
        clean(req.body.state) || null,
        clean(req.body.phone) || null,
        clean(req.body.email) || null,
      ]
    );
    await ensureSettings(conn, req.user.organization_id, inserted.rows[0].id);
    await audit(conn, req, 'billing_profile', inserted.rows[0].id, 'created', null, inserted.rows[0], null, inserted.rows[0].id);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Billing profile created', profile: inserted.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || (err.code === '23505' ? 409 : 500)).json({ success: false, message: err.message || 'Profile create failed' });
  } finally {
    conn.release();
  }
});

router.put('/profiles/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const old = await billingProfile(conn, req.user.organization_id, req.params.id, { active: false });
    if (!old) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    const updated = await conn.query(
      `UPDATE billing_profiles
          SET display_name=COALESCE(NULLIF($2,''),display_name),
              legal_name=$3, gstin=$4, address=$5, state=$6, phone=$7, email=$8,
              status=COALESCE(NULLIF($9,''),status), updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [
        old.id, clean(req.body.display_name), clean(req.body.legal_name) || null,
        old.profile_type === 'gst' ? clean(req.body.gstin) || null : null,
        req.body.address || null, clean(req.body.state) || null, clean(req.body.phone) || null,
        clean(req.body.email) || null, req.body.status || null,
      ]
    );
    await audit(conn, req, 'billing_profile', old.id, 'updated', old, updated.rows[0], req.body.remarks || null, old.id);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Billing profile updated', profile: updated.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Profile update failed' });
  } finally {
    conn.release();
  }
});

router.get('/settings', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const profile = await billingProfile(conn, req.user.organization_id, req.query.profile_id);
    if (!profile) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    const settings = await ensureSettings(conn, req.user.organization_id, profile.id, req.billingAccess.can_write);
    await conn.query('COMMIT');
    res.json({ success: true, settings, profile });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing settings load]', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Settings load failed' });
  } finally {
    conn.release();
  }
});

router.put('/settings', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const profile = await billingProfile(conn, req.user.organization_id, req.body.profile_id);
    if (!profile) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    const current = {
      invoice_prefix: clean(req.body.invoice_prefix) || 'INV',
      proforma_prefix: clean(req.body.proforma_prefix) || 'PRO',
      gstin: clean(req.body.gstin) || null,
      legal_name: clean(req.body.legal_name) || null,
      phone: clean(req.body.phone) || null,
      email: clean(req.body.email) || null,
      address: req.body.address || null,
      state: clean(req.body.state) || null,
      gst_applicable: profile.profile_type === 'gst'
        && !(req.body.gst_applicable === false || req.body.gst_applicable === 'false'),
      default_tax_rate: amount(req.body.default_tax_rate || 18),
      upi_id: clean(req.body.upi_id) || null,
      upi_name: clean(req.body.upi_name) || null,
      terms: req.body.terms || null,
      bank_details: req.body.bank_details || null,
    };
    const r = await conn.query(
      `INSERT INTO billing_settings
        (organization_id, profile_id, invoice_prefix, proforma_prefix, gstin, legal_name, phone, email, address, state, gst_applicable, default_tax_rate, upi_id, upi_name, terms, bank_details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (organization_id, profile_id)
       DO UPDATE SET invoice_prefix=EXCLUDED.invoice_prefix,
                     proforma_prefix=EXCLUDED.proforma_prefix,
                     gstin=EXCLUDED.gstin,
                     legal_name=EXCLUDED.legal_name,
                     phone=EXCLUDED.phone,
                     email=EXCLUDED.email,
                     address=EXCLUDED.address,
                     state=EXCLUDED.state,
                     gst_applicable=EXCLUDED.gst_applicable,
                     default_tax_rate=EXCLUDED.default_tax_rate,
                     upi_id=EXCLUDED.upi_id,
                     upi_name=EXCLUDED.upi_name,
                     terms=EXCLUDED.terms,
                     bank_details=EXCLUDED.bank_details,
                     updated_at=NOW()
       RETURNING *`,
      [
        req.user.organization_id,
        profile.id,
        current.invoice_prefix,
        current.proforma_prefix,
        current.gstin,
        current.legal_name,
        current.phone,
        current.email,
        current.address,
        current.state,
        current.gst_applicable,
        current.default_tax_rate,
        current.upi_id,
        current.upi_name,
        current.terms,
        current.bank_details,
      ]
    );
    await conn.query(
      `UPDATE billing_profiles
          SET display_name=COALESCE(NULLIF($2,''),display_name),
              legal_name=$3, gstin=$4, phone=$5, email=$6, address=$7, state=$8, updated_at=NOW()
        WHERE id=$1`,
      [
        profile.id, clean(req.body.display_name), current.legal_name,
        profile.profile_type === 'gst' ? current.gstin : null, current.phone,
        current.email, current.address, current.state,
      ]
    );
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Billing settings saved', settings: r.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing settings]', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Settings save failed' });
  } finally {
    conn.release();
  }
});

router.get('/tasks/unbilled', async (req, res) => {
  const { search = '', client_id = '', status = '', date_from = '', date_to = '', limit = 200 } = req.query;
  const params = [];
  const conds = [
    `t.organization_id=${Number(req.user.organization_id)}`,
    `t.active_flag=true`,
    `COALESCE(t.fees_applicable,'Yes') <> 'No'`,
    `NOT EXISTS (
      SELECT 1 FROM billing_document_tasks claim
       WHERE claim.task_id=t.task_id AND claim.is_active_claim=TRUE
    )`,
  ];
  if (client_id) {
    params.push(client_id);
    const n = params.length;
    conds.push(`(
      t.client_id=$${n}
      OR EXISTS (
        SELECT 1 FROM clients cx
         WHERE cx.client_id=$${n}
           AND (
             LOWER(TRIM(cx.legal_name))=LOWER(TRIM(COALESCE(t.legal_name,t.business_name,'')))
             OR LOWER(TRIM(cx.business_name))=LOWER(TRIM(COALESCE(t.legal_name,t.business_name,'')))
           )
      )
      OR EXISTS (
        SELECT 1 FROM companies co
         WHERE co.client_id=$${n}
           AND LOWER(TRIM(co.company_name))=LOWER(TRIM(COALESCE(t.legal_name,t.business_name,'')))
      )
    )`);
  }
  if (status) { params.push(status); conds.push(`t.status=$${params.length}`); }
  if (date_from) { params.push(date_from); conds.push(`COALESCE(t.completion_date::date,t.due_date::date,t.created_at::date) >= $${params.length}::date`); }
  if (date_to) { params.push(date_to); conds.push(`COALESCE(t.completion_date::date,t.due_date::date,t.created_at::date) <= $${params.length}::date`); }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(t.task_id ILIKE $${n} OR t.client_id ILIKE $${n} OR t.legal_name ILIKE $${n} OR t.business_name ILIKE $${n} OR t.work_name ILIKE $${n})`);
  }
  params.push(Math.min(parseInt(limit, 10) || 200, 500));
  try {
    const r = await db.query(
      `SELECT t.task_id, t.client_id AS source_client_id, t.agent_id, t.legal_name, t.business_name,
              COALESCE(t.legal_name,t.business_name,c.legal_name,c.business_name) AS client_name,
              t.work_name, t.status, t.due_date, t.completion_date, t.assigned_to_name,
              CASE
                WHEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) <> 0
                THEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0)
                ELSE COALESCE(t.total_amount,0)
              END AS amount,
              t.professional_fees, t.challan_amount, t.other_expense, t.billing_status
         FROM tasks t
         LEFT JOIN clients c ON c.client_id=t.client_id
        WHERE ${conds.join(' AND ')}
        ORDER BY t.client_id, t.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    let tasks = await resolveTaskClients(db, r.rows);
    if (client_id) tasks = tasks.filter(task => task.client_id === client_id);
    res.json({ success: true, tasks });
  } catch (err) {
    console.error('[billing unbilled]', err);
    res.status(500).json({ success: false, message: 'Unbilled work load failed' });
  }
});

router.get('/tasks/unbilled-clients', async (req, res) => {
  const { search = '', status = '', limit = 500 } = req.query;
  const params = [];
  const conds = [
    `t.organization_id=${Number(req.user.organization_id)}`,
    `t.active_flag=true`,
    `COALESCE(t.fees_applicable,'Yes') <> 'No'`,
    `NOT EXISTS (
      SELECT 1 FROM billing_document_tasks claim
       WHERE claim.task_id=t.task_id AND claim.is_active_claim=TRUE
    )`,
    `NULLIF(t.client_id,'') IS NOT NULL`,
  ];
  if (status) {
    params.push(status);
    conds.push(`t.status=$${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(t.client_id ILIKE $${n} OR t.legal_name ILIKE $${n} OR t.business_name ILIKE $${n} OR c.legal_name ILIKE $${n} OR c.business_name ILIKE $${n})`);
  }
  params.push(Math.min(parseInt(limit, 10) || 500, 1000));
  try {
    const r = await db.query(
      `SELECT t.task_id, t.client_id AS source_client_id, t.agent_id, t.legal_name, t.business_name,
              COALESCE(t.legal_name,t.business_name,c.legal_name,c.business_name) AS client_name,
              CASE
                WHEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) <> 0
                THEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0)
                ELSE COALESCE(t.total_amount,0)
              END AS amount,
              COALESCE(t.due_date::date, t.created_at::date) AS work_date
         FROM tasks t
         LEFT JOIN clients c ON c.client_id=t.client_id
        WHERE ${conds.join(' AND ')}
        LIMIT $${params.length}`,
      params
    );
    const tasks = await resolveTaskClients(db, r.rows);
    const grouped = new Map();
    for (const task of tasks) {
      if (!task.client_id) continue;
      const current = grouped.get(task.client_id) || {
        client_id: task.client_id,
        client_name: task.client_name,
        task_count: 0,
        amount: 0,
        oldest_date: task.work_date,
      };
      current.task_count += 1;
      current.amount = amount(current.amount + amount(task.amount));
      if (!current.oldest_date || (task.work_date && task.work_date < current.oldest_date)) current.oldest_date = task.work_date;
      grouped.set(task.client_id, current);
    }
    const clients = [...grouped.values()].sort((a, b) => b.amount - a.amount || a.client_name.localeCompare(b.client_name));
    res.json({ success: true, clients });
  } catch (err) {
    console.error('[billing unbilled clients]', err);
    res.status(500).json({ success: false, message: 'Client wise unbilled load failed' });
  }
});

router.get('/clients/:client_id', async (req, res) => {
  try {
    const client = await clientForBilling(db, req.params.client_id, req.query.name);
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });
    res.json({ success: true, client });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Client details load failed' });
  }
});

router.put('/tasks/:task_id/amounts', async (req, res) => {
  const professionalFees = amount(req.body.professional_fees);
  const challanAmount = amount(req.body.challan_amount);
  const otherExpense = amount(req.body.other_expense);
  const total = amount(professionalFees + challanAmount + otherExpense);
  try {
    const current = await db.query(`SELECT * FROM tasks WHERE task_id=$1`, [req.params.task_id]);
    if (!current.rows.length) return res.status(404).json({ success: false, message: 'Task not found' });
    const claimed = await db.query(
      `SELECT 1 FROM billing_document_tasks WHERE task_id=$1 AND is_active_claim=TRUE LIMIT 1`,
      [req.params.task_id]
    );
    if (claimed.rows.length) {
      return res.status(409).json({ success: false, message: 'Billed task amount cannot be changed' });
    }
    const updated = await db.query(
      `UPDATE tasks
          SET professional_fees=$2, challan_amount=$3, other_expense=$4, total_amount=$5,
              last_updated_by_id=$6, last_updated_by_name=$7, last_updated_at=NOW()
        WHERE task_id=$1
        RETURNING task_id, professional_fees, challan_amount, other_expense, total_amount`,
      [req.params.task_id, professionalFees, challanAmount, otherExpense, total, actorId(req.user), actorName(req.user)]
    );
    await audit(db, req, 'task_billing', null, 'amounts_updated', current.rows[0], updated.rows[0], req.body.remarks || req.params.task_id);
    res.json({ success: true, message: 'Task amounts updated', task: updated.rows[0] });
  } catch (err) {
    console.error('[billing task amounts]', err);
    res.status(500).json({ success: false, message: 'Task amount update failed' });
  }
});

router.post('/proformas', (req, res) => createDocument(req, res, 'proforma'));
router.post('/invoices', (req, res) => createDocument(req, res, 'invoice'));
router.post('/invoices/from-proforma', (req, res) => createDocument(req, res, 'invoice', req.body.proforma_id));

router.get('/documents', async (req, res) => {
  const { type = '', status = '', client_id = '', search = '', profile_id = '', include_deleted = '', limit = 200 } = req.query;
  const params = [];
  const conds = [include_deleted === 'true' ? `1=1` : `deleted_at IS NULL`];
  if (type) { params.push(type); conds.push(`document_type=$${params.length}`); }
  if (status) { params.push(status); conds.push(`status=$${params.length}`); }
  if (client_id) { params.push(client_id); conds.push(`client_id=$${params.length}`); }
  if (search) {
    params.push(`%${search}%`);
    const n = params.length;
    conds.push(`(document_no ILIKE $${n} OR client_name ILIKE $${n} OR client_id ILIKE $${n})`);
  }
  params.push(Math.min(parseInt(limit, 10) || 200, 500));
  try {
    const profile = await billingProfile(db, req.user.organization_id, profile_id);
    if (!profile) return res.status(404).json({ success: false, message: 'Billing profile not found' });
    params.splice(params.length - 1, 0, profile.id);
    const limitPosition = params.length;
    conds.push(`profile_id=$${params.length - 1}`);
    const r = await db.query(
      `SELECT bd.*,
              COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS received_amount,
              bd.total_amount - COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS outstanding_amount
         FROM billing_documents bd
        WHERE ${conds.join(' AND ')}
        ORDER BY bd.document_date DESC, bd.id DESC
        LIMIT $${limitPosition}`,
      params
    );
    res.json({ success: true, documents: r.rows });
  } catch (err) {
    console.error('[billing documents]', err);
    res.status(500).json({ success: false, message: 'Documents load failed' });
  }
});

router.get('/documents/:id', async (req, res) => {
  try {
    const [doc, lines, tasks] = await Promise.all([
      db.query(
        `SELECT bd.*, bp.profile_type, bp.display_name AS profile_name,
                COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS received_amount,
                bd.total_amount - COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS outstanding_amount
           FROM billing_documents bd
           JOIN billing_profiles bp ON bp.id=bd.profile_id
          WHERE bd.id=$1 AND bd.organization_id=$2`,
        [req.params.id, req.user.organization_id]
      ),
      db.query(
        `SELECT bl.* FROM billing_document_lines bl
          JOIN billing_documents bd ON bd.id=bl.document_id
         WHERE bl.document_id=$1 AND bd.organization_id=$2 ORDER BY bl.line_no`,
        [req.params.id, req.user.organization_id]
      ),
      db.query(
        `SELECT bt.* FROM billing_document_tasks bt
          JOIN billing_documents bd ON bd.id=bt.document_id
         WHERE bt.document_id=$1 AND bd.organization_id=$2 ORDER BY bt.id`,
        [req.params.id, req.user.organization_id]
      ),
    ]);
    if (!doc.rows.length) return res.status(404).json({ success: false, message: 'Document not found' });
    res.json({ success: true, document: doc.rows[0], lines: lines.rows, tasks: tasks.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Document load failed' });
  }
});

router.put('/documents/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const docRes = await conn.query(`SELECT * FROM billing_documents WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!docRes.rows.length) {
      const err = new Error('Document not found');
      err.statusCode = 404;
      throw err;
    }
    const old = docRes.rows[0];
    if (['Cancelled', 'Deleted'].includes(old.status)) {
      const err = new Error(`${old.status} document cannot be edited`);
      err.statusCode = 400;
      throw err;
    }
    const profile = await billingProfile(conn, req.user.organization_id, old.profile_id, { active: false });
    const settings = await ensureSettings(conn, req.user.organization_id, old.profile_id);
    const allocated = await conn.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS amount FROM billing_receipt_allocations WHERE document_id=$1`,
      [old.id]
    );
    if (amount(allocated.rows[0].amount) > 0 && Array.isArray(req.body.lines)) {
      const err = new Error('Receipt allocated invoice financial details cannot be changed. Reverse allocation first.');
      err.statusCode = 409;
      throw err;
    }
    if (amount(allocated.rows[0].amount) > 0) {
      const financialChanged = [
        ['document_date', new Date(old.document_date).toISOString().slice(0, 10)],
        ['client_state', old.client_state || ''],
        ['place_of_supply', old.place_of_supply || ''],
        ['tax_mode', old.tax_mode || ''],
      ].some(([key, previous]) => req.body[key] !== undefined && clean(req.body[key]) !== clean(previous));
      if (financialChanged) {
        const err = new Error('Receipt allocated invoice financial details cannot be changed. Reverse allocation first.');
        err.statusCode = 409;
        throw err;
      }
    }

    const existingLines = await conn.query(`SELECT * FROM billing_document_lines WHERE document_id=$1 ORDER BY line_no`, [old.id]);
    const rawLines = Array.isArray(req.body.lines) && req.body.lines.length ? req.body.lines : existingLines.rows;
    const normalizedLines = rawLines.map((line, idx) => {
      const qty = amount(line.quantity || 1) || 1;
      const rate = amount(line.rate || line.amount || 0);
      return {
        id: line.id || null,
        line_no: idx + 1,
        description: clean(line.description) || 'Professional Services',
        hsn_sac: clean(line.hsn_sac) || null,
        quantity: qty,
        rate,
        amount: amount(qty * rate),
        tax_rate: profile?.profile_type === 'gst' ? amount(line.tax_rate ?? settings.default_tax_rate) : 0,
        task_ids: Array.isArray(line.task_ids) ? [...new Set(line.task_ids.map(clean).filter(Boolean))] : null,
        task_names: line.task_names && typeof line.task_names === 'object' ? line.task_names : {},
      };
    });
    if (!normalizedLines.length) {
      const err = new Error('At least one line required');
      err.statusCode = 400;
      throw err;
    }

    const clientState = clean(req.body.client_state) || old.client_state || null;
    const placeOfSupply = clean(req.body.place_of_supply) || clientState || old.place_of_supply || null;
    const gstApplicable = profile?.profile_type === 'gst' && settings.gst_applicable !== false;
    const effectiveTaxMode = gstApplicable ? (req.body.tax_mode || old.tax_mode || 'Auto') : 'None';
    const tax = normalizedLines.reduce((sum, line) => {
      const split = taxSplit({
        taxable: line.amount,
        taxRate: gstApplicable ? line.tax_rate : 0,
        taxMode: effectiveTaxMode,
        orgState: settings.state,
        clientState: placeOfSupply || clientState,
      });
      return {
        cgst: amount(sum.cgst + split.cgst),
        sgst: amount(sum.sgst + split.sgst),
        igst: amount(sum.igst + split.igst),
      };
    }, { cgst: 0, sgst: 0, igst: 0 });
    const taxable = amount(normalizedLines.reduce((sum, line) => sum + line.amount, 0));
    const total = amount(taxable + tax.cgst + tax.sgst + tax.igst);

    const savedLines = [];
    for (const line of normalizedLines) {
      if (line.id) {
        const saved = await conn.query(
          `UPDATE billing_document_lines
              SET line_no=$2, description=$3, hsn_sac=$4, quantity=$5, rate=$6, amount=$7, tax_rate=$8
            WHERE id=$1 AND document_id=$9`,
          [line.id, line.line_no, line.description, line.hsn_sac, line.quantity, line.rate, line.amount, line.tax_rate, old.id]
        );
        savedLines.push({ ...line, id: line.id });
      } else {
        const saved = await conn.query(
          `INSERT INTO billing_document_lines (document_id, line_no, description, hsn_sac, quantity, rate, amount, tax_rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [old.id, line.line_no, line.description, line.hsn_sac, line.quantity, line.rate, line.amount, line.tax_rate]
        );
        savedLines.push({ ...line, id: saved.rows[0].id });
      }
    }
    const keepIds = savedLines.map(line => Number(line.id));

    if (Array.isArray(req.body.lines)) {
      const oldMappings = await conn.query(`SELECT * FROM billing_document_tasks WHERE document_id=$1`, [old.id]);
      const requestedTaskIds = [...new Set(savedLines.flatMap(line => line.task_ids || []))];
      const oldActiveIds = oldMappings.rows.filter(row => row.is_active_claim).map(row => row.task_id);
      const removedIds = oldActiveIds.filter(id => !requestedTaskIds.includes(id));
      if (removedIds.length) await releaseDocumentTasks(conn, old.id, req.user, removedIds);
      await conn.query(
        `UPDATE billing_document_tasks
            SET is_active_claim=FALSE, released_at=NOW(), released_by_id=$2
          WHERE document_id=$1
            AND NOT (task_id = ANY($3))`,
        [old.id, actorId(req.user), requestedTaskIds]
      );

      for (const line of savedLines) {
        if (!line.task_ids) continue;
        const taskRows = line.task_ids.length
          ? await conn.query(`SELECT task_id, work_name, total_amount FROM tasks WHERE task_id=ANY($1)`, [line.task_ids])
          : { rows: [] };
        for (const task of taskRows.rows) {
          await conn.query(
            `INSERT INTO billing_document_tasks
              (document_id, line_id, task_id, task_work_name, task_amount, is_active_claim)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (organization_id, document_id, task_id)
             DO UPDATE SET line_id=EXCLUDED.line_id, task_work_name=EXCLUDED.task_work_name,
                           task_amount=EXCLUDED.task_amount, is_active_claim=EXCLUDED.is_active_claim,
                           released_at=NULL, released_by_id=NULL`,
            [
              old.id, line.id, task.task_id, clean(line.task_names[task.task_id]) || task.work_name,
              task.total_amount || 0, old.document_type === 'invoice',
            ]
          );
        }
      }
      if (old.document_type === 'invoice' && requestedTaskIds.length) {
        await conn.query(`UPDATE tasks SET billing_status='Billed' WHERE task_id=ANY($1)`, [requestedTaskIds]);
      }
    }
    if (keepIds.length) {
      await conn.query(`DELETE FROM billing_document_lines WHERE document_id=$1 AND id <> ALL($2::int[])`, [old.id, keepIds]);
    }

    const updated = await conn.query(
      `UPDATE billing_documents
          SET document_date=$2,
              client_name=$3,
              client_gstin=$4,
              client_contact=$5,
              client_state=$6,
              place_of_supply=$7,
              client_address=$8,
              tax_mode=$9,
              taxable_amount=$10,
              cgst_amount=$11,
              sgst_amount=$12,
              igst_amount=$13,
              total_amount=$14,
              terms=$15,
              notes=$16,
              updated_at=NOW()
        WHERE id=$1
        RETURNING *`,
      [
        old.id,
        req.body.document_date || old.document_date,
        clean(req.body.client_name) || old.client_name,
        clean(req.body.client_gstin) || null,
        clean(req.body.client_contact) || null,
        clientState,
        placeOfSupply,
        req.body.client_address || null,
        effectiveTaxMode,
        taxable,
        tax.cgst,
        tax.sgst,
        tax.igst,
        total,
        req.body.terms || old.terms || null,
        req.body.notes || old.notes || null,
      ]
    );

    if (req.body.update_client_master) {
      await conn.query(
        `UPDATE clients
            SET address=COALESCE($2,address),
                gst_no=COALESCE($3,gst_no),
                state=COALESCE($4,state),
                mobile_number=COALESCE($5,mobile_number)
          WHERE client_id=$1`,
        [old.client_id, req.body.client_address || null, clean(req.body.client_gstin) || null, clientState || null, clean(req.body.client_contact) || null]
      );
    }
    if (old.document_type === 'invoice') {
      await conn.query(
        `UPDATE billing_ledger_entries
            SET entry_date=$2, debit=$3, narration=$4
          WHERE document_id=$1 AND entry_type='Invoice'`,
        [old.id, updated.rows[0].document_date, total, `Invoice ${updated.rows[0].document_no}`]
      );
    }
    await audit(conn, req, 'billing_document', old.id, 'edited', old, updated.rows[0], req.body.edit_reason || null, old.profile_id);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Invoice updated', document: updated.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing edit document]', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Invoice update failed' });
  } finally {
    conn.release();
  }
});

router.post('/documents/:id/cancel', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const doc = await conn.query(`SELECT * FROM billing_documents WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!doc.rows.length) {
      const err = new Error('Document not found');
      err.statusCode = 404;
      throw err;
    }
    const old = doc.rows[0];
    if (old.status === 'Cancelled') {
      const err = new Error('Document already cancelled');
      err.statusCode = 400;
      throw err;
    }
    const allocated = await conn.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM billing_receipt_allocations WHERE document_id=$1`, [old.id]);
    if (amount(allocated.rows[0].amount) > 0) {
      const err = new Error('Allocated receipt must be reversed before cancelling this invoice');
      err.statusCode = 409;
      throw err;
    }
    await conn.query(
      `UPDATE billing_documents SET status='Cancelled', cancelled_at=NOW(), cancelled_by_id=$1, cancel_reason=$2, updated_at=NOW() WHERE id=$3`,
      [actorId(req.user), req.body.reason || null, old.id]
    );
    if (old.document_type === 'invoice') {
      await conn.query(
        `INSERT INTO billing_ledger_entries (profile_id, client_id, entry_date, entry_type, document_id, debit, credit, narration)
         VALUES ($1,$2,CURRENT_DATE,'Invoice Cancelled',$3,0,$4,$5)`,
        [old.profile_id, old.client_id, old.id, old.total_amount, `Cancelled invoice ${old.document_no}`]
      );
      await releaseDocumentTasks(conn, old.id, req.user);
    }
    await audit(conn, req, 'billing_document', old.id, 'cancelled', old, { reason: req.body.reason || null }, req.body.reason || null, old.profile_id);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Document cancelled' });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Cancel failed' });
  } finally {
    conn.release();
  }
});

router.delete('/documents/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const result = await conn.query(`SELECT * FROM billing_documents WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!result.rows.length) {
      const err = new Error('Document not found');
      err.statusCode = 404;
      throw err;
    }
    const old = result.rows[0];
    if (old.status === 'Deleted') {
      const err = new Error('Document already deleted');
      err.statusCode = 400;
      throw err;
    }
    if (clean(req.body.confirm_document_no) !== old.document_no) {
      const err = new Error('Enter exact invoice number to confirm deletion');
      err.statusCode = 400;
      throw err;
    }
    if (!clean(req.body.reason)) {
      const err = new Error('Delete reason is required');
      err.statusCode = 400;
      throw err;
    }
    const allocated = await conn.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM billing_receipt_allocations WHERE document_id=$1`, [old.id]);
    if (amount(allocated.rows[0].amount) > 0) {
      const err = new Error('Allocated receipt must be reversed before deleting this invoice');
      err.statusCode = 409;
      throw err;
    }
    await conn.query(
      `UPDATE billing_documents
          SET status='Deleted', deleted_at=NOW(), deleted_by_id=$2, delete_reason=$3, updated_at=NOW()
        WHERE id=$1`,
      [old.id, actorId(req.user), clean(req.body.reason)]
    );
    if (old.document_type === 'invoice') {
      await conn.query(
        `INSERT INTO billing_ledger_entries
          (profile_id, client_id, entry_date, entry_type, document_id, debit, credit, narration)
         VALUES ($1,$2,CURRENT_DATE,'Invoice Deleted',$3,0,$4,$5)`,
        [old.profile_id, old.client_id, old.id, old.total_amount, `Deleted invoice ${old.document_no}`]
      );
      await releaseDocumentTasks(conn, old.id, req.user);
    }
    await audit(conn, req, 'billing_document', old.id, 'deleted', old, { reason: clean(req.body.reason) }, clean(req.body.reason), old.profile_id);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Document deleted and linked work released' });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Delete failed' });
  } finally {
    conn.release();
  }
});

router.get('/bank-accounts', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const profile = await billingProfile(conn, req.user.organization_id, req.query.profile_id);
    if (!profile) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    const existing = await conn.query(
      `SELECT * FROM billing_bank_accounts WHERE profile_id=$1 ORDER BY is_default DESC, status, account_name`,
      [profile.id]
    );
    if (!existing.rows.length && req.billingAccess.can_write) {
      await conn.query(
        `INSERT INTO billing_bank_accounts (profile_id, account_name, account_type, is_default)
         VALUES ($1,'Cash','Cash',TRUE)`,
        [profile.id]
      );
      const again = await conn.query(`SELECT * FROM billing_bank_accounts WHERE profile_id=$1 ORDER BY is_default DESC, status, account_name`, [profile.id]);
      await conn.query('COMMIT');
      return res.json({ success: true, bank_accounts: again.rows });
    }
    await conn.query('COMMIT');
    res.json({ success: true, bank_accounts: existing.rows });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing bank accounts load]', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Bank accounts load failed' });
  } finally {
    conn.release();
  }
});

router.post('/bank-accounts', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const profile = await billingProfile(conn, req.user.organization_id, req.body.profile_id);
    if (!profile) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    if (req.body.is_default) await conn.query(`UPDATE billing_bank_accounts SET is_default=FALSE WHERE profile_id=$1 AND is_default=TRUE`, [profile.id]);
    const r = await conn.query(
      `INSERT INTO billing_bank_accounts
        (profile_id, account_name, account_type, bank_name, account_no, ifsc, upi_id, upi_name, opening_balance, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        profile.id,
        clean(req.body.account_name),
        req.body.account_type || 'Bank',
        req.body.bank_name || null,
        req.body.account_no || null,
        req.body.ifsc || null,
        req.body.upi_id || null,
        req.body.upi_name || null,
        amount(req.body.opening_balance),
        Boolean(req.body.is_default),
      ]
    );
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Bank account added', bank_account: r.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing payment account]', err);
    res.status(500).json({ success: false, message: 'Bank account save failed' });
  } finally {
    conn.release();
  }
});

router.put('/bank-accounts/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const profile = await billingProfile(conn, req.user.organization_id, req.body.profile_id);
    if (!profile) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    if (req.body.is_default) await conn.query(`UPDATE billing_bank_accounts SET is_default=FALSE WHERE profile_id=$1 AND is_default=TRUE`, [profile.id]);
    const r = await conn.query(
      `UPDATE billing_bank_accounts
          SET account_name=COALESCE(NULLIF($2,''),account_name),
              account_type=COALESCE(NULLIF($3,''),account_type),
              bank_name=$4, account_no=$5, ifsc=$6, upi_id=$7, upi_name=$8,
              status=COALESCE(NULLIF($9,''),status),
              is_default=COALESCE($10,is_default), updated_at=NOW()
        WHERE id=$1 AND profile_id=$11
        RETURNING *`,
      [
        req.params.id, clean(req.body.account_name), req.body.account_type || null,
        req.body.bank_name || null, req.body.account_no || null, req.body.ifsc || null,
        req.body.upi_id || null, req.body.upi_name || null, req.body.status || null,
        req.body.is_default === undefined ? null : Boolean(req.body.is_default),
        profile.id,
      ]
    );
    if (!r.rows.length) {
      const err = new Error('Payment account not found');
      err.statusCode = 404;
      throw err;
    }
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Payment account updated', bank_account: r.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Payment account update failed' });
  } finally {
    conn.release();
  }
});

router.get('/clients/:client_id/ledger', async (req, res) => {
  try {
    const profile = await billingProfile(db, req.user.organization_id, req.query.profile_id);
    if (!profile) return res.status(404).json({ success: false, message: 'Billing profile not found' });
    const entries = await db.query(
      `SELECT le.*, bd.document_no, br.receipt_no,
              SUM(le.debit - le.credit) OVER (ORDER BY le.entry_date, le.id) AS running_balance
         FROM billing_ledger_entries le
         LEFT JOIN billing_documents bd ON bd.id=le.document_id
         LEFT JOIN billing_receipts br ON br.id=le.receipt_id
        WHERE le.client_id=$1 AND le.profile_id=$2
        ORDER BY le.entry_date, le.id`,
      [req.params.client_id, profile.id]
    );
    const client = await db.query(`SELECT client_id, legal_name, business_name FROM clients WHERE client_id=$1`, [req.params.client_id]);
    res.json({ success: true, client: client.rows[0] || null, ledger: entries.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Ledger load failed' });
  }
});

router.post('/receipts', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const profile = await billingProfile(conn, req.user.organization_id, req.body.profile_id);
    if (!profile) {
      const err = new Error('Billing profile not found');
      err.statusCode = 404;
      throw err;
    }
    const client = await clientForBilling(conn, req.body.client_id);
    if (!client) {
      const err = new Error('Client not found');
      err.statusCode = 404;
      throw err;
    }
    const fy = financialYear(req.body.receipt_date || new Date());
    const seq = await conn.query(
      `SELECT COUNT(*)::int + 1 AS next_no
         FROM billing_receipts
        WHERE profile_id=$1 AND receipt_no LIKE $2`,
      [profile.id, `RCP/${fy}/%`]
    );
    const receiptNo = clean(req.body.receipt_no) || `RCP/${fy}/${String(seq.rows[0].next_no).padStart(4, '0')}`;
    const receipt = await conn.query(
      `INSERT INTO billing_receipts
        (profile_id, receipt_no, receipt_date, client_id, client_name, bank_account_id, amount, reference_no, remarks, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [profile.id, receiptNo, req.body.receipt_date || new Date().toISOString().slice(0,10), client.client_id, client.legal_name || client.business_name || client.client_id, req.body.bank_account_id || null, amount(req.body.amount), req.body.reference_no || null, req.body.remarks || null, actorId(req.user), actorName(req.user)]
    );
    const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    for (const a of allocations) {
      if (!a.document_id || !amount(a.amount)) continue;
      const target = await conn.query(
        `SELECT id FROM billing_documents
          WHERE id=$1 AND profile_id=$2 AND client_id=$3 AND status='Final' AND deleted_at IS NULL`,
        [a.document_id, profile.id, client.client_id]
      );
      if (!target.rows.length) {
        const err = new Error('Receipt allocation invoice does not belong to selected billing profile/client');
        err.statusCode = 400;
        throw err;
      }
      await conn.query(
        `INSERT INTO billing_receipt_allocations (receipt_id, document_id, amount)
         VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, receipt_id, document_id) DO UPDATE SET amount=EXCLUDED.amount`,
        [receipt.rows[0].id, a.document_id, amount(a.amount)]
      );
    }
    await conn.query(
      `INSERT INTO billing_ledger_entries (profile_id, client_id, entry_date, entry_type, receipt_id, debit, credit, narration)
       VALUES ($1,$2,$3,'Receipt',$4,0,$5,$6)`,
      [profile.id, client.client_id, receipt.rows[0].receipt_date, receipt.rows[0].id, receipt.rows[0].amount, `Receipt ${receiptNo}`]
    );
    await audit(conn, req, 'billing_receipt', receipt.rows[0].id, 'receipt_created', null, receipt.rows[0], req.body.remarks || null, profile.id);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Receipt saved', receipt: receipt.rows[0] });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    console.error('[billing receipt]', err);
    res.status(err.statusCode || (err.code === '23505' ? 409 : 500)).json({ success: false, message: err.message || 'Receipt save failed' });
  } finally {
    conn.release();
  }
});

router.post('/adjustments', async (req, res) => {
  try {
    const profile = await billingProfile(db, req.user.organization_id, req.body.profile_id);
    if (!profile) return res.status(404).json({ success: false, message: 'Billing profile not found' });
    const debit = amount(req.body.debit);
    const credit = amount(req.body.credit);
    if (!req.body.client_id || (!debit && !credit)) return res.status(400).json({ success: false, message: 'Client and debit/credit amount required' });
    const r = await db.query(
      `INSERT INTO billing_ledger_entries (profile_id, client_id, entry_date, entry_type, debit, credit, narration)
       VALUES ($1,$2,$3,'Adjustment',$4,$5,$6) RETURNING *`,
      [profile.id, req.body.client_id, req.body.entry_date || new Date().toISOString().slice(0,10), debit, credit, req.body.narration || 'Manual adjustment']
    );
    res.json({ success: true, message: 'Adjustment saved', entry: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Adjustment failed' });
  }
});

router.get('/reports/outstanding', async (req, res) => {
  try {
    const profileId = req.query.scope === 'combined' ? null : (await billingProfile(db, req.user.organization_id, req.query.profile_id))?.id;
    if (req.query.scope !== 'combined' && !profileId) return res.status(404).json({ success: false, message: 'Billing profile not found' });
    const r = await db.query(
      `SELECT c.client_id, COALESCE(c.legal_name,c.business_name,le.client_id) AS client_name,
              SUM(le.debit) AS billed, SUM(le.credit) AS received,
              SUM(le.debit-le.credit) AS outstanding
         FROM billing_ledger_entries le
         LEFT JOIN clients c ON c.client_id=le.client_id
        WHERE ($1::int IS NULL OR le.profile_id=$1)
        GROUP BY c.client_id, c.legal_name, c.business_name, le.client_id
       HAVING SUM(le.debit-le.credit) <> 0
        ORDER BY outstanding DESC`,
      [profileId]
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Outstanding report failed' });
  }
});

router.get('/reports/daybook', async (req, res) => {
  const { date_from = '', date_to = '' } = req.query;
  const params = [];
  const conds = [`1=1`];
  if (date_from) { params.push(date_from); conds.push(`entry_date >= $${params.length}::date`); }
  if (date_to) { params.push(date_to); conds.push(`entry_date <= $${params.length}::date`); }
  try {
    if (req.query.scope !== 'combined') {
      const profile = await billingProfile(db, req.user.organization_id, req.query.profile_id);
      if (!profile) return res.status(404).json({ success: false, message: 'Billing profile not found' });
      params.push(profile.id);
      conds.push(`le.profile_id=$${params.length}`);
    }
    const r = await db.query(
      `SELECT le.*, COALESCE(c.legal_name,c.business_name,le.client_id) AS client_name, bd.document_no, br.receipt_no
         FROM billing_ledger_entries le
         LEFT JOIN clients c ON c.client_id=le.client_id
         LEFT JOIN billing_documents bd ON bd.id=le.document_id
         LEFT JOIN billing_receipts br ON br.id=le.receipt_id
        WHERE ${conds.join(' AND ')}
        ORDER BY le.entry_date DESC, le.id DESC
        LIMIT 500`,
      params
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Daybook report failed' });
  }
});

router.get('/reports/unbilled', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT t.task_id, t.client_id, COALESCE(t.legal_name,t.business_name,c.legal_name,c.business_name) AS client_name,
              t.work_name, t.status, t.due_date, t.completion_date, t.assigned_to_name,
              COALESCE(t.total_amount, t.professional_fees, 0) AS amount,
              t.billing_status
         FROM tasks t
         LEFT JOIN clients c ON c.client_id=t.client_id
        WHERE t.active_flag=true
          AND t.organization_id=${Number(req.user.organization_id)}
          AND COALESCE(t.fees_applicable,'Yes') <> 'No'
          AND NOT EXISTS (
            SELECT 1 FROM billing_document_tasks claim
             WHERE claim.task_id=t.task_id AND claim.is_active_claim=TRUE
          )
        ORDER BY t.client_id, t.created_at DESC
        LIMIT 500`
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Unbilled report failed' });
  }
});

router.get('/reports/client-revenue', async (req, res) => {
  try {
    const profileId = req.query.scope === 'combined' ? null : (await billingProfile(db, req.user.organization_id, req.query.profile_id))?.id;
    if (req.query.scope !== 'combined' && !profileId) return res.status(404).json({ success: false, message: 'Billing profile not found' });
    const r = await db.query(
      `SELECT client_id, client_name, COUNT(*)::int AS invoice_count, SUM(total_amount) AS revenue
         FROM billing_documents
        WHERE document_type='invoice' AND status='Final' AND deleted_at IS NULL
          AND ($1::int IS NULL OR profile_id=$1)
        GROUP BY client_id, client_name
        ORDER BY revenue DESC`,
      [profileId]
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Client revenue report failed' });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const profile = await billingProfile(db, req.user.organization_id, req.query.profile_id);
    if (!profile) return res.status(404).json({ success: false, message: 'Billing profile not found' });
    const [unbilled, outstanding, received, drafts] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(COALESCE(total_amount, professional_fees, 0)),0) AS amount
                  FROM tasks t
                 WHERE t.organization_id=${Number(req.user.organization_id)}
                   AND active_flag=true AND COALESCE(fees_applicable,'Yes') <> 'No'
                   AND NOT EXISTS (SELECT 1 FROM billing_document_tasks claim WHERE claim.task_id=t.task_id AND claim.is_active_claim=TRUE)`),
      db.query(`SELECT COALESCE(SUM(debit-credit),0) AS amount FROM billing_ledger_entries WHERE profile_id=$1`, [profile.id]),
      db.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM billing_receipts WHERE profile_id=$1 AND receipt_date >= date_trunc('month', CURRENT_DATE)::date AND status='Active'`, [profile.id]),
      db.query(`SELECT COUNT(*)::int AS count FROM billing_documents WHERE profile_id=$1 AND status='Draft' AND deleted_at IS NULL`, [profile.id]),
    ]);
    res.json({
      success: true,
      unbilled: unbilled.rows[0],
      outstanding: outstanding.rows[0].amount,
      received_this_month: received.rows[0].amount,
      drafts: drafts.rows[0].count,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Billing dashboard failed' });
  }
});

module.exports = router;
