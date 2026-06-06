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

async function ensureSettings(conn, orgId, createIfMissing = true) {
  const existing = await conn.query(`SELECT * FROM billing_settings WHERE organization_id=$1 FOR UPDATE`, [orgId]);
  if (existing.rows.length) return existing.rows[0];
  const org = await conn.query(`SELECT state FROM organizations WHERE id=$1`, [orgId]);
  if (!createIfMissing) {
    return {
      organization_id: orgId,
      invoice_prefix: 'INV',
      proforma_prefix: 'PRO',
      next_invoice_no: 1,
      next_proforma_no: 1,
      gstin: null,
      legal_name: null,
      phone: null,
      email: null,
      address: null,
      state: org.rows[0]?.state || null,
      gst_applicable: true,
      default_tax_rate: 18,
      upi_id: null,
      upi_name: null,
      terms: 'Payment due on receipt unless otherwise agreed.',
      bank_details: null,
    };
  }
  const inserted = await conn.query(
    `INSERT INTO billing_settings (organization_id, state, terms)
     VALUES ($1,$2,'Payment due on receipt unless otherwise agreed.')
     RETURNING *`,
    [orgId, org.rows[0]?.state || null]
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

async function clientForBilling(conn, clientId) {
  const r = await conn.query(
    `SELECT client_id, legal_name, business_name, gst_no, state, address, mobile_number, email_id
       FROM clients
      WHERE client_id=$1`,
    [clientId]
  );
  return r.rows[0] || null;
}

async function audit(conn, req, entityType, entityId, action, oldValue, newValue, remarks) {
  await conn.query(
    `INSERT INTO billing_audit_log
       (entity_type, entity_id, action, old_value, new_value, remarks, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entityType, entityId || null, action, oldValue ? JSON.stringify(oldValue) : null, newValue ? JSON.stringify(newValue) : null, remarks || null, actorId(req.user), actorName(req.user)]
  );
}

function taxSplit({ taxable, taxRate, taxMode, orgState, clientState }) {
  const rate = amount(taxRate);
  if (!rate || taxMode === 'None') return { cgst: 0, sgst: 0, igst: 0 };
  const sameState = clean(orgState).toLowerCase() && clean(orgState).toLowerCase() === clean(clientState).toLowerCase();
  const mode = taxMode === 'Auto' ? (sameState ? 'CGST_SGST' : 'IGST') : taxMode;
  const tax = amount(taxable * rate / 100);
  if (mode === 'CGST_SGST') return { cgst: amount(tax / 2), sgst: amount(tax / 2), igst: 0 };
  if (mode === 'IGST') return { cgst: 0, sgst: 0, igst: tax };
  return { cgst: 0, sgst: 0, igst: 0 };
}

async function createDocument(req, res, type, fromProformaId = null) {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const orgId = req.user.organization_id;
    const settings = await ensureSettings(conn, orgId);
    let payload = req.body || {};
    let sourceProforma = null;
    if (fromProformaId) {
      const p = await conn.query(`SELECT * FROM billing_documents WHERE id=$1 AND document_type='proforma' AND status <> 'Cancelled' FOR UPDATE`, [fromProformaId]);
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
        client_id: sourceProforma.client_id,
        document_date: payload.document_date || new Date().toISOString().slice(0, 10),
        tax_mode: payload.tax_mode || sourceProforma.tax_mode,
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
    const docDate = payload.document_date || new Date().toISOString().slice(0, 10);
    const fy = payload.financial_year || financialYear(docDate);
    const client = await clientForBilling(conn, payload.client_id);
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
          WHERE bdt.task_id = ANY($1) AND bd.document_type='invoice' AND bd.status <> 'Cancelled'
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
      `SELECT id FROM billing_documents WHERE document_type=$1 AND document_no=$2`,
      [type, docNo]
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
    const taxable = amount(normalizedLines.reduce((sum, l) => sum + l.amount, 0));
    const gstApplicable = settings.gst_applicable !== false;
    const taxRate = gstApplicable ? (normalizedLines.length ? normalizedLines[0].tax_rate : settings.default_tax_rate) : 0;
    const effectiveTaxMode = gstApplicable ? (payload.tax_mode || 'Auto') : 'None';
    const tax = taxSplit({
      taxable,
      taxRate,
      taxMode: effectiveTaxMode,
      orgState: settings.state,
      clientState: placeOfSupply || clientState,
    });
    const total = amount(taxable + tax.cgst + tax.sgst + tax.igst);
    const doc = await conn.query(
      `INSERT INTO billing_documents
        (document_type, document_no, financial_year, document_date, client_id, client_name, client_gstin,
         client_contact, client_state, place_of_supply, client_address, tax_mode, taxable_amount, cgst_amount, sgst_amount, igst_amount,
         total_amount, status, notes, terms, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'Final',$18,$19,$20,$21)
       RETURNING *`,
      [
        type, docNo, fy, docDate, client.client_id, client.legal_name || client.business_name || client.client_id,
        clientGstin, clientContact, clientState, placeOfSupply, clientAddress || null, effectiveTaxMode,
        taxable, tax.cgst, tax.sgst, tax.igst, total, payload.notes || null, payload.terms || settings.terms || null,
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
            `INSERT INTO billing_document_tasks (document_id, line_id, task_id, task_work_name, task_amount)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (organization_id, document_id, task_id) DO NOTHING`,
            [doc.rows[0].id, insertedLine.rows[0].id, t.task_id, customTaskName || t.work_name, t.total_amount || 0]
          );
        }
      }
    }
    if (type === 'invoice') {
      await conn.query(
        `INSERT INTO billing_ledger_entries
          (client_id, entry_date, entry_type, document_id, debit, credit, narration)
         VALUES ($1,$2,'Invoice',$3,$4,0,$5)`,
        [client.client_id, docDate, doc.rows[0].id, total, `Invoice ${docNo}`]
      );
      if (allTaskIds.length) {
        await conn.query(`UPDATE tasks SET billing_status='Billed' WHERE task_id = ANY($1)`, [allTaskIds]);
      }
    } else if (allTaskIds.length) {
      await conn.query(
        `UPDATE tasks SET billing_status=CASE WHEN COALESCE(billing_status,'')='Billed' THEN billing_status ELSE 'Proforma' END
          WHERE task_id = ANY($1)`,
        [allTaskIds]
      );
    }
    await audit(conn, req, 'billing_document', doc.rows[0].id, type === 'invoice' ? 'invoice_created' : 'proforma_created', null, doc.rows[0], payload.manual_reason || null);
    if (sourceProforma) {
      await audit(conn, req, 'billing_document', doc.rows[0].id, 'invoice_from_proforma', sourceProforma, doc.rows[0], null);
    }
    await conn.query('COMMIT');
    res.json({ success: true, message: type === 'invoice' ? 'Tax invoice created' : 'Proforma created', document: doc.rows[0] });
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

router.get('/settings', async (req, res) => {
  try {
    const conn = await db.pool.connect();
    try {
      const settings = await ensureSettings(conn, req.user.organization_id, req.billingAccess.can_write);
      res.json({ success: true, settings });
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: 'Settings load failed' });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const current = {
      invoice_prefix: clean(req.body.invoice_prefix) || 'INV',
      proforma_prefix: clean(req.body.proforma_prefix) || 'PRO',
      gstin: clean(req.body.gstin) || null,
      legal_name: clean(req.body.legal_name) || null,
      phone: clean(req.body.phone) || null,
      email: clean(req.body.email) || null,
      address: req.body.address || null,
      state: clean(req.body.state) || null,
      gst_applicable: req.body.gst_applicable === false || req.body.gst_applicable === 'false' ? false : true,
      default_tax_rate: amount(req.body.default_tax_rate || 18),
      upi_id: clean(req.body.upi_id) || null,
      upi_name: clean(req.body.upi_name) || null,
      terms: req.body.terms || null,
      bank_details: req.body.bank_details || null,
    };
    const r = await db.query(
      `INSERT INTO billing_settings
        (organization_id, invoice_prefix, proforma_prefix, gstin, legal_name, phone, email, address, state, gst_applicable, default_tax_rate, upi_id, upi_name, terms, bank_details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (organization_id)
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
    res.json({ success: true, message: 'Billing settings saved', settings: r.rows[0] });
  } catch (err) {
    console.error('[billing settings]', err);
    res.status(500).json({ success: false, message: 'Settings save failed' });
  }
});

router.get('/tasks/unbilled', async (req, res) => {
  const { search = '', client_id = '', status = '', date_from = '', date_to = '', limit = 200 } = req.query;
  const params = [];
  const conds = [
    `t.active_flag=true`,
    `COALESCE(t.fees_applicable,'Yes') <> 'No'`,
    `COALESCE(t.billing_status,'') <> 'Billed'`,
  ];
  if (client_id) { params.push(client_id); conds.push(`t.client_id=$${params.length}`); }
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
      `SELECT t.task_id, t.client_id, COALESCE(t.legal_name,t.business_name,c.legal_name,c.business_name) AS client_name,
              t.work_name, t.status, t.due_date, t.completion_date, t.assigned_to_name,
              COALESCE(t.total_amount, t.professional_fees, 0) AS amount,
              t.professional_fees, t.challan_amount, t.other_expense, t.billing_status
         FROM tasks t
         LEFT JOIN clients c ON c.client_id=t.client_id
        WHERE ${conds.join(' AND ')}
        ORDER BY t.client_id, t.created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, tasks: r.rows });
  } catch (err) {
    console.error('[billing unbilled]', err);
    res.status(500).json({ success: false, message: 'Unbilled work load failed' });
  }
});

router.get('/tasks/unbilled-clients', async (req, res) => {
  const { search = '', status = '', limit = 500 } = req.query;
  const params = [];
  const conds = [
    `t.active_flag=true`,
    `COALESCE(t.fees_applicable,'Yes') <> 'No'`,
    `COALESCE(t.billing_status,'') <> 'Billed'`,
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
      `SELECT t.client_id,
              COALESCE(MAX(NULLIF(c.legal_name,'')), MAX(NULLIF(c.business_name,'')), MAX(NULLIF(t.legal_name,'')), MAX(NULLIF(t.business_name,'')), t.client_id) AS client_name,
              COUNT(*)::int AS task_count,
              COALESCE(SUM(COALESCE(t.total_amount, t.professional_fees, 0)),0) AS amount,
              MIN(COALESCE(t.due_date::date, t.created_at::date)) AS oldest_date
         FROM tasks t
         LEFT JOIN clients c ON c.client_id=t.client_id
        WHERE ${conds.join(' AND ')}
        GROUP BY t.client_id
        ORDER BY amount DESC, client_name
        LIMIT $${params.length}`,
      params
    );
    res.json({ success: true, clients: r.rows });
  } catch (err) {
    console.error('[billing unbilled clients]', err);
    res.status(500).json({ success: false, message: 'Client wise unbilled load failed' });
  }
});

router.post('/proformas', (req, res) => createDocument(req, res, 'proforma'));
router.post('/invoices', (req, res) => createDocument(req, res, 'invoice'));
router.post('/invoices/from-proforma', (req, res) => createDocument(req, res, 'invoice', req.body.proforma_id));

router.get('/documents', async (req, res) => {
  const { type = '', status = '', client_id = '', search = '', limit = 200 } = req.query;
  const params = [];
  const conds = [`1=1`];
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
    const r = await db.query(
      `SELECT bd.*,
              COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS received_amount,
              bd.total_amount - COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS outstanding_amount
         FROM billing_documents bd
        WHERE ${conds.join(' AND ')}
        ORDER BY bd.document_date DESC, bd.id DESC
        LIMIT $${params.length}`,
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
        `SELECT bd.*,
                COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS received_amount,
                bd.total_amount - COALESCE((SELECT SUM(amount) FROM billing_receipt_allocations a WHERE a.document_id=bd.id),0) AS outstanding_amount
           FROM billing_documents bd
          WHERE bd.id=$1`,
        [req.params.id]
      ),
      db.query(`SELECT * FROM billing_document_lines WHERE document_id=$1 ORDER BY line_no`, [req.params.id]),
      db.query(`SELECT * FROM billing_document_tasks WHERE document_id=$1 ORDER BY id`, [req.params.id]),
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
    const settings = await ensureSettings(conn, req.user.organization_id);
    const docRes = await conn.query(`SELECT * FROM billing_documents WHERE id=$1 FOR UPDATE`, [req.params.id]);
    if (!docRes.rows.length) {
      const err = new Error('Document not found');
      err.statusCode = 404;
      throw err;
    }
    const old = docRes.rows[0];
    if (old.status === 'Cancelled') {
      const err = new Error('Cancelled document cannot be edited');
      err.statusCode = 400;
      throw err;
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
        tax_rate: amount(line.tax_rate ?? settings.default_tax_rate),
      };
    });
    if (!normalizedLines.length) {
      const err = new Error('At least one line required');
      err.statusCode = 400;
      throw err;
    }

    const clientState = clean(req.body.client_state) || old.client_state || null;
    const placeOfSupply = clean(req.body.place_of_supply) || clientState || old.place_of_supply || null;
    const gstApplicable = settings.gst_applicable !== false;
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

    const keepIds = normalizedLines.map(line => Number(line.id)).filter(Boolean);
    if (keepIds.length) {
      await conn.query(`DELETE FROM billing_document_lines WHERE document_id=$1 AND id <> ALL($2::int[])`, [old.id, keepIds]);
    } else {
      await conn.query(`DELETE FROM billing_document_lines WHERE document_id=$1`, [old.id]);
    }
    for (const line of normalizedLines) {
      if (line.id) {
        await conn.query(
          `UPDATE billing_document_lines
              SET line_no=$2, description=$3, hsn_sac=$4, quantity=$5, rate=$6, amount=$7, tax_rate=$8
            WHERE id=$1 AND document_id=$9`,
          [line.id, line.line_no, line.description, line.hsn_sac, line.quantity, line.rate, line.amount, line.tax_rate, old.id]
        );
      } else {
        await conn.query(
          `INSERT INTO billing_document_lines (document_id, line_no, description, hsn_sac, quantity, rate, amount, tax_rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [old.id, line.line_no, line.description, line.hsn_sac, line.quantity, line.rate, line.amount, line.tax_rate]
        );
      }
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
    await audit(conn, req, 'billing_document', old.id, 'edited', old, updated.rows[0], req.body.edit_reason || null);
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
    await conn.query(
      `UPDATE billing_documents SET status='Cancelled', cancelled_at=NOW(), cancelled_by_id=$1, cancel_reason=$2, updated_at=NOW() WHERE id=$3`,
      [actorId(req.user), req.body.reason || null, old.id]
    );
    if (old.document_type === 'invoice') {
      await conn.query(
        `INSERT INTO billing_ledger_entries (client_id, entry_date, entry_type, document_id, debit, credit, narration)
         VALUES ($1,CURRENT_DATE,'Invoice Cancelled',$2,0,$3,$4)`,
        [old.client_id, old.id, old.total_amount, `Cancelled invoice ${old.document_no}`]
      );
      const tasks = await conn.query(`SELECT task_id FROM billing_document_tasks WHERE document_id=$1`, [old.id]);
      if (tasks.rows.length) {
        await conn.query(`UPDATE tasks SET billing_status=NULL WHERE task_id = ANY($1) AND billing_status='Billed'`, [tasks.rows.map(t => t.task_id)]);
      }
    }
    await audit(conn, req, 'billing_document', old.id, 'cancelled', old, { reason: req.body.reason || null }, req.body.reason || null);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Document cancelled' });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Cancel failed' });
  } finally {
    conn.release();
  }
});

router.get('/bank-accounts', async (req, res) => {
  try {
    const existing = await db.query(`SELECT * FROM billing_bank_accounts ORDER BY status, account_name`);
    if (!existing.rows.length && req.billingAccess.can_write) {
      await db.query(`INSERT INTO billing_bank_accounts (account_name, account_type) VALUES ('Cash', 'Cash')`);
      const again = await db.query(`SELECT * FROM billing_bank_accounts ORDER BY status, account_name`);
      return res.json({ success: true, bank_accounts: again.rows });
    }
    res.json({ success: true, bank_accounts: existing.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Bank accounts load failed' });
  }
});

router.post('/bank-accounts', async (req, res) => {
  try {
    const r = await db.query(
      `INSERT INTO billing_bank_accounts (account_name, account_type, bank_name, account_no, ifsc, opening_balance)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [clean(req.body.account_name), req.body.account_type || 'Bank', req.body.bank_name || null, req.body.account_no || null, req.body.ifsc || null, amount(req.body.opening_balance)]
    );
    res.json({ success: true, message: 'Bank account added', bank_account: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Bank account save failed' });
  }
});

router.get('/clients/:client_id/ledger', async (req, res) => {
  try {
    const entries = await db.query(
      `SELECT le.*, bd.document_no, br.receipt_no,
              SUM(le.debit - le.credit) OVER (ORDER BY le.entry_date, le.id) AS running_balance
         FROM billing_ledger_entries le
         LEFT JOIN billing_documents bd ON bd.id=le.document_id
         LEFT JOIN billing_receipts br ON br.id=le.receipt_id
        WHERE le.client_id=$1
        ORDER BY le.entry_date, le.id`,
      [req.params.client_id]
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
        WHERE receipt_no LIKE $1`,
      [`RCP/${fy}/%`]
    );
    const receiptNo = clean(req.body.receipt_no) || `RCP/${fy}/${String(seq.rows[0].next_no).padStart(4, '0')}`;
    const receipt = await conn.query(
      `INSERT INTO billing_receipts
        (receipt_no, receipt_date, client_id, client_name, bank_account_id, amount, reference_no, remarks, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [receiptNo, req.body.receipt_date || new Date().toISOString().slice(0,10), client.client_id, client.legal_name || client.business_name || client.client_id, req.body.bank_account_id || null, amount(req.body.amount), req.body.reference_no || null, req.body.remarks || null, actorId(req.user), actorName(req.user)]
    );
    const allocations = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    for (const a of allocations) {
      if (!a.document_id || !amount(a.amount)) continue;
      await conn.query(
        `INSERT INTO billing_receipt_allocations (receipt_id, document_id, amount)
         VALUES ($1,$2,$3)
         ON CONFLICT (organization_id, receipt_id, document_id) DO UPDATE SET amount=EXCLUDED.amount`,
        [receipt.rows[0].id, a.document_id, amount(a.amount)]
      );
    }
    await conn.query(
      `INSERT INTO billing_ledger_entries (client_id, entry_date, entry_type, receipt_id, debit, credit, narration)
       VALUES ($1,$2,'Receipt',$3,0,$4,$5)`,
      [client.client_id, receipt.rows[0].receipt_date, receipt.rows[0].id, receipt.rows[0].amount, `Receipt ${receiptNo}`]
    );
    await audit(conn, req, 'billing_receipt', receipt.rows[0].id, 'receipt_created', null, receipt.rows[0], req.body.remarks || null);
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
    const debit = amount(req.body.debit);
    const credit = amount(req.body.credit);
    if (!req.body.client_id || (!debit && !credit)) return res.status(400).json({ success: false, message: 'Client and debit/credit amount required' });
    const r = await db.query(
      `INSERT INTO billing_ledger_entries (client_id, entry_date, entry_type, debit, credit, narration)
       VALUES ($1,$2,'Adjustment',$3,$4,$5) RETURNING *`,
      [req.body.client_id, req.body.entry_date || new Date().toISOString().slice(0,10), debit, credit, req.body.narration || 'Manual adjustment']
    );
    res.json({ success: true, message: 'Adjustment saved', entry: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Adjustment failed' });
  }
});

router.get('/reports/outstanding', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT c.client_id, COALESCE(c.legal_name,c.business_name,le.client_id) AS client_name,
              SUM(le.debit) AS billed, SUM(le.credit) AS received,
              SUM(le.debit-le.credit) AS outstanding
         FROM billing_ledger_entries le
         LEFT JOIN clients c ON c.client_id=le.client_id
        GROUP BY c.client_id, c.legal_name, c.business_name, le.client_id
       HAVING SUM(le.debit-le.credit) <> 0
        ORDER BY outstanding DESC`
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
          AND COALESCE(t.fees_applicable,'Yes') <> 'No'
          AND COALESCE(t.billing_status,'') <> 'Billed'
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
    const r = await db.query(
      `SELECT client_id, client_name, COUNT(*)::int AS invoice_count, SUM(total_amount) AS revenue
         FROM billing_documents
        WHERE document_type='invoice' AND status <> 'Cancelled'
        GROUP BY client_id, client_name
        ORDER BY revenue DESC`
    );
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Client revenue report failed' });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const [unbilled, outstanding, received, drafts] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(COALESCE(total_amount, professional_fees, 0)),0) AS amount FROM tasks WHERE active_flag=true AND COALESCE(fees_applicable,'Yes') <> 'No' AND COALESCE(billing_status,'') <> 'Billed'`),
      db.query(`SELECT COALESCE(SUM(debit-credit),0) AS amount FROM billing_ledger_entries`),
      db.query(`SELECT COALESCE(SUM(amount),0) AS amount FROM billing_receipts WHERE receipt_date >= date_trunc('month', CURRENT_DATE)::date AND status='Active'`),
      db.query(`SELECT COUNT(*)::int AS count FROM billing_documents WHERE status='Draft'`),
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
