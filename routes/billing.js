const express = require('express');
const db = require('../db');
const {
  clean, money, esc, financialYear, billSettings, billingAuth, requireManager, requireApprover, logTimeline, advanceAvailable,
  PAY_STATE_SQL, payState, ALLOC_SUM, WORK_FROM, workWhere,
} = require('../services/billingCommon');

const router = express.Router();
router.use(billingAuth);

const fail = (res, err, fallback) => {
  const status = err.statusCode || (err.code === '23505' ? 409 : 500);
  if (status === 500) console.error('[billing]', err);
  res.status(status).json({ success: false, message: status === 500 ? fallback : err.message });
};
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// ── Who am I, firms, letterhead ──────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const firms = await db.query(`SELECT id, name, code FROM bill_firms WHERE status='Active' ORDER BY name`);
    const org = (await db.query(`SELECT office_name, logo_data_url, address, city, state, contact_mobile, contact_email FROM organizations WHERE id=$1`, [req.bill.orgId])).rows[0] || {};
    res.json({
      success: true,
      access: { manager: req.bill.manager, approver: req.bill.approver, om: req.bill.om, om_limit: req.bill.om_limit, self_approve: req.bill.self_approve },
      user: { id: req.bill.id, name: req.bill.name, role: req.bill.role },
      firms: firms.rows,
      org,
    });
  } catch (err) { fail(res, err, 'Could not load billing'); }
});

// ── Firms and their bank / cash / UPI accounts ───────────────
router.get('/firms', async (req, res) => {
  try {
    const f = await db.query(`SELECT * FROM bill_firms ORDER BY status, name`);
    const a = await db.query(`SELECT * FROM bill_accounts ORDER BY firm_id, status, account_name`);
    if (!req.bill.manager) {
      // Staff only need names to raise payment requests: no PAN, GSTIN, account numbers or UPI IDs.
      return res.json({
        success: true,
        firms: f.rows.map(x => ({ id: x.id, name: x.name, code: x.code, status: x.status })),
        accounts: a.rows.map(x => ({ id: x.id, firm_id: x.firm_id, account_name: x.account_name, account_type: x.account_type, status: x.status })),
      });
    }
    res.json({ success: true, firms: f.rows, accounts: a.rows });
  } catch (err) { fail(res, err, 'Could not load firms'); }
});

router.post('/firms', requireManager, async (req, res) => {
  try {
    const name = clean(req.body.name);
    const code = clean(req.body.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (!name) throw bad('Please enter the firm name.');
    if (code.length < 2) throw bad('Please enter a short code of 2 to 8 letters or numbers (for example AKA).');
    const r = await db.query(
      `INSERT INTO bill_firms (name, code, legal_type, pan, gstin, address, phone, email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, code, clean(req.body.legal_type) || null, clean(req.body.pan).toUpperCase() || null, clean(req.body.gstin).toUpperCase() || null,
        clean(req.body.address) || null, clean(req.body.phone) || null, clean(req.body.email) || null]);
    await logTimeline(db, 'firm', r.rows[0].id, 'created', name, req.bill.name);
    res.json({ success: true, firm: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, message: 'This firm code is already used. Please choose another.' });
    fail(res, err, 'Could not save the firm');
  }
});

router.put('/firms/:id', requireManager, async (req, res) => {
  try {
    const b = req.body;
    const r = await db.query(
      `UPDATE bill_firms SET name=COALESCE(NULLIF($2,''),name), legal_type=$3, pan=$4, gstin=$5, address=$6, phone=$7, email=$8,
              status=COALESCE(NULLIF($9,''),status), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, clean(b.name), clean(b.legal_type) || null, clean(b.pan).toUpperCase() || null, clean(b.gstin).toUpperCase() || null,
        clean(b.address) || null, clean(b.phone) || null, clean(b.email) || null, ['Active', 'Inactive'].includes(b.status) ? b.status : '']);
    if (!r.rows.length) throw bad('Firm not found', 404);
    await logTimeline(db, 'firm', r.rows[0].id, 'updated', null, req.bill.name);
    res.json({ success: true, firm: r.rows[0] });
  } catch (err) { fail(res, err, 'Could not update the firm'); }
});

router.post('/accounts', requireManager, async (req, res) => {
  try {
    const b = req.body;
    const type = ['Bank', 'Cash', 'UPI'].includes(b.account_type) ? b.account_type : 'Bank';
    if (!clean(b.account_name)) throw bad('Please enter the account name.');
    const firm = await db.query(`SELECT id FROM bill_firms WHERE id=$1`, [b.firm_id]);
    if (!firm.rows.length) throw bad('Please choose a firm.');
    const dup = await db.query(
      `SELECT id FROM bill_accounts WHERE firm_id=$1 AND status='Active' AND LOWER(account_name)=LOWER($2) AND account_type=$3 AND COALESCE(account_no,'')=COALESCE($4,'') AND COALESCE(bank_name,'')=COALESCE($5,'') LIMIT 1`,
      [b.firm_id, clean(b.account_name), type, clean(b.account_no) || null, clean(b.bank_name) || null]);
    if (dup.rows.length) throw bad('This account is already added for the firm.', 409);
    const r = await db.query(
      `INSERT INTO bill_accounts (firm_id, account_name, account_type, bank_name, account_no, ifsc, upi_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.firm_id, clean(b.account_name), type, clean(b.bank_name) || null, clean(b.account_no) || null, clean(b.ifsc).toUpperCase() || null, clean(b.upi_id) || null]);
    res.json({ success: true, account: r.rows[0] });
  } catch (err) { fail(res, err, 'Could not save the account'); }
});

router.put('/accounts/:id', requireManager, async (req, res) => {
  try {
    const b = req.body;
    const r = await db.query(
      `UPDATE bill_accounts SET account_name=COALESCE(NULLIF($2,''),account_name), account_type=COALESCE(NULLIF($3,''),account_type),
              bank_name=$4, account_no=$5, ifsc=$6, upi_id=$7, status=COALESCE(NULLIF($8,''),status) WHERE id=$1 RETURNING *`,
      [req.params.id, clean(b.account_name), ['Bank', 'Cash', 'UPI'].includes(b.account_type) ? b.account_type : '', clean(b.bank_name) || null,
        clean(b.account_no) || null, clean(b.ifsc).toUpperCase() || null, clean(b.upi_id) || null, ['Active', 'Inactive'].includes(b.status) ? b.status : '']);
    if (!r.rows.length) throw bad('Account not found', 404);
    res.json({ success: true, account: r.rows[0] });
  } catch (err) { fail(res, err, 'Could not update the account'); }
});

router.put('/settings', requireApprover, async (req, res) => {
  try {
    const limit = Math.max(0, money(req.body.om_limit || 0));
    const selfApprove = req.body.self_approve ? 'Yes' : 'No';
    for (const [k, v] of [['BILL_OM_LIMIT', String(limit)], ['BILL_SELF_APPROVE', selfApprove]]) {
      await db.query(`INSERT INTO attendance_settings (key, value) VALUES ($1,$2) ON CONFLICT (organization_id, key) DO UPDATE SET value=$2`, [k, v]);
    }
    res.json({ success: true, settings: await billSettings() });
  } catch (err) { fail(res, err, 'Could not save the settings'); }
});

// ── Client lookup (also used by staff when they raise payment requests) ──
router.get('/clients/all', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT client_id, COALESCE(NULLIF(legal_name,''), business_name) AS name FROM clients WHERE organization_id=$1 ORDER BY COALESCE(NULLIF(legal_name,''), business_name) LIMIT 8000`, [req.bill.orgId]);
    res.json({ success: true, clients: r.rows.map(c => ({ client_id: c.client_id, name: (c.name || '').trim() })) });
  } catch (err) { fail(res, err, 'Could not load clients'); }
});

router.get('/clients', async (req, res) => {
  try {
    const s = `%${clean(req.query.search)}%`;
    const r = await db.query(
      `SELECT client_id, COALESCE(NULLIF(legal_name,''), business_name) AS name, business_name, mobile_number
         FROM clients WHERE organization_id=$1 AND (client_id ILIKE $2 OR legal_name ILIKE $2 OR business_name ILIKE $2)
        ORDER BY COALESCE(NULLIF(legal_name,''), business_name) LIMIT 25`, [req.bill.orgId, s]);
    res.json({ success: true, clients: r.rows });
  } catch (err) { fail(res, err, 'Could not search clients'); }
});

router.get('/advance', async (req, res) => {
  try {
    if (!req.query.client_id || !req.query.firm_id) return res.json({ success: true, available: 0 });
    const a = await advanceAvailable(db, clean(req.query.client_id), Number(req.query.firm_id));
    res.json({ success: true, ...a });
  } catch (err) { fail(res, err, 'Could not read the advance balance'); }
});

// ── Work (tasks) with billing state ──────────────────────────
// Same filters as /work, but grouped by client: how much work each client has in this state
router.get('/work/clients', requireManager, async (req, res) => {
  try {
    const { conds, params } = workWhere(req);
    const taskAmt = `CASE WHEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) <> 0
                          THEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) ELSE COALESCE(t.total_amount,0) END`;
    const r = await db.query(
      `SELECT t.client_id, MAX(COALESCE(NULLIF(c.legal_name,''), NULLIF(c.business_name,''), t.legal_name, t.business_name, t.client_id)) AS client_name,
              COUNT(*)::int AS work_count, COALESCE(SUM(${taskAmt}),0) AS amount,
              to_char(MIN(COALESCE(t.completion_date, t.due_date, t.created_at::date)),'YYYY-MM-DD') AS oldest,
              COUNT(*) FILTER (WHERE be.id IS NULL AND h.id IS NULL AND COALESCE(t.fees_applicable,'Yes')<>'No')::int AS unbilled_count
         ${WORK_FROM} WHERE ${conds.join(' AND ')}
        GROUP BY t.client_id ORDER BY client_name LIMIT 1500`, params);
    res.json({ success: true, clients: r.rows, total_clients: r.rows.length });
  } catch (err) { fail(res, err, 'Could not load the clients'); }
});

router.get('/work', requireManager, async (req, res) => {
  try {
    const { conds, params } = workWhere(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = conds.join(' AND ');
    const taskAmt = `CASE WHEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) <> 0
                          THEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) ELSE COALESCE(t.total_amount,0) END`;
    const [rows, total] = await Promise.all([
      db.query(
        `SELECT t.task_id, t.client_id, COALESCE(NULLIF(c.legal_name,''), NULLIF(c.business_name,''), t.legal_name, t.business_name, t.client_id) AS client_name,
                t.work_name, t.status, to_char(t.due_date,'YYYY-MM-DD') AS due_date, to_char(t.completion_date,'YYYY-MM-DD') AS completion_date,
                t.assigned_to_name, COALESCE(t.professional_fees,0) AS fees, COALESCE(t.challan_amount,0) AS challan, COALESCE(t.other_expense,0) AS other,
                ${taskAmt} AS task_amount, t.fees_applicable,
                be.id AS bill_id, be.bill_no, to_char(be.bill_date,'YYYY-MM-DD') AS bill_date, bf.name AS firm_name,
                bet.fees_amount AS b_fees, bet.challan_amount AS b_challan, bet.other_amount AS b_other, bet.gst_amount AS b_gst,
                be.total_amount AS bill_total, COALESCE(al.alloc,0) AS bill_received,
                h.flag AS hold_flag, h.reason AS hold_reason,
                (SELECT COALESCE(SUM(COALESCE(p.paid_amount,p.amount)),0) FROM bill_payment_requests p WHERE p.task_id=t.task_id AND p.status='Paid') AS paid_out
           ${WORK_FROM} WHERE ${where}
          ORDER BY COALESCE(NULLIF(c.legal_name,''), NULLIF(c.business_name,''), t.legal_name, t.business_name, t.client_id), t.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`, params),
      db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(${taskAmt}),0) AS amount ${WORK_FROM} WHERE ${where}`, params),
    ]);
    const works = rows.rows.map(r => ({
      ...r,
      bill_state: r.bill_id ? 'billed' : (r.hold_flag || r.fees_applicable === 'No' ? 'hold' : 'unbilled'),
      pay_state: r.bill_id ? payState(r.bill_total, r.bill_received) : null,
    }));
    res.json({ success: true, works, total: total.rows[0].n, amount: total.rows[0].amount, limit, offset });
  } catch (err) { fail(res, err, 'Could not load the work list'); }
});

router.post('/work/hold', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const flag = clean(req.body.flag);
    if (!['Free', 'Internal', 'Write-off'].includes(flag)) throw bad('Please choose Free, Internal or Write-off.');
    const ids = [...new Set((req.body.task_ids || []).map(clean).filter(Boolean))];
    if (!ids.length) throw bad('Please select the work first.');
    if (!clean(req.body.reason)) throw bad('Please write the reason.');
    const tasks = await conn.query(`SELECT task_id FROM tasks WHERE organization_id=$1 AND task_id = ANY($2)`, [req.bill.orgId, ids]);
    const billed = await conn.query(`SELECT task_id FROM bill_entry_tasks WHERE is_active AND task_id = ANY($1)`, [ids]);
    if (billed.rows.length) throw bad('Some of this work is already billed. Cancel the bill first.', 409);
    for (const t of tasks.rows) {
      await conn.query(`UPDATE bill_task_holds SET is_active=FALSE, released_by=$2, released_at=NOW() WHERE task_id=$1 AND is_active`, [t.task_id, req.bill.name]);
      await conn.query(`INSERT INTO bill_task_holds (task_id, flag, reason, set_by) VALUES ($1,$2,$3,$4)`, [t.task_id, flag, clean(req.body.reason), req.bill.name]);
      await logTimeline(conn, 'work', 0, `hold:${t.task_id}`, `${flag}: ${clean(req.body.reason)}`, req.bill.name);
    }
    await conn.query('COMMIT');
    res.json({ success: true, message: `${tasks.rows.length} work item(s) will not be billed (${flag}).` });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not update the work'); }
  finally { conn.release(); }
});

router.post('/work/unhold', requireManager, async (req, res) => {
  try {
    const ids = [...new Set((req.body.task_ids || []).map(clean).filter(Boolean))];
    if (!ids.length) throw bad('Please select the work first.');
    const r = await db.query(`UPDATE bill_task_holds SET is_active=FALSE, released_by=$2, released_at=NOW() WHERE task_id = ANY($1) AND is_active RETURNING task_id`, [ids, req.bill.name]);
    for (const row of r.rows) await logTimeline(db, 'work', 0, `unhold:${row.task_id}`, null, req.bill.name);
    res.json({ success: true, message: `${r.rows.length} work item(s) are back in the unbilled list.` });
  } catch (err) { fail(res, err, 'Could not update the work'); }
});

// Challans / fees staff paid for a client from firm money and not yet charged in a bill
router.get('/recoverable', requireManager, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, request_no, purpose, payee, task_id, task_name, firm_id, COALESCE(paid_amount, amount) AS amount, to_char(paid_on,'YYYY-MM-DD') AS paid_on, paid_reference
         FROM bill_payment_requests
        WHERE client_id=$1 AND status='Paid' AND funding='Firm funds' AND recovered_bill_id IS NULL AND purpose <> 'Office expense'
        ORDER BY paid_on, id`, [clean(req.query.client_id)]);
    res.json({ success: true, payments: r.rows });
  } catch (err) { fail(res, err, 'Could not load payments to recover'); }
});

// ── Bills (recorded against works) ───────────────────────────
router.post('/bills', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const b = req.body;
    const firm = (await conn.query(`SELECT * FROM bill_firms WHERE id=$1 AND status='Active'`, [b.firm_id])).rows[0];
    if (!firm) throw bad('Please choose the firm that issued this bill.');
    const billNo = clean(b.bill_no);
    if (!billNo) throw bad('Please enter the bill number.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(b.bill_date))) throw bad('Please choose the bill date.');
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) throw bad('Please select at least one work item.');
    const ids = items.map(i => clean(i.task_id));
    if (new Set(ids).size !== ids.length) throw bad('The same work was added twice.');
    const tasks = (await conn.query(
      `SELECT task_id, client_id, work_name, legal_name, business_name FROM tasks WHERE organization_id=$1 AND task_id = ANY($2) AND active_flag=true`,
      [req.bill.orgId, ids])).rows;
    if (tasks.length !== ids.length) throw bad('Some work items could not be found.');
    const clientIds = new Set(tasks.map(t => t.client_id));
    if (clientIds.size !== 1) throw bad('One bill can include the work of one client only.');
    const clientId = tasks[0].client_id;
    const held = await conn.query(`SELECT task_id FROM bill_task_holds WHERE is_active AND task_id = ANY($1)`, [ids]);
    if (held.rows.length) throw bad('Some work is marked "will not be billed". Bring it back to the unbilled list first.', 409);
    const cl = (await conn.query(`SELECT COALESCE(NULLIF(legal_name,''), business_name) AS name FROM clients WHERE client_id=$1 AND organization_id=$2`, [clientId, req.bill.orgId])).rows[0];
    const clientName = cl?.name || tasks[0].legal_name || tasks[0].business_name || clientId;

    const lines = items.map(i => ({
      task_id: clean(i.task_id), fees: money(i.fees), challan: money(i.challan), other: money(i.other), gst: money(i.gst),
    }));
    if (lines.some(l => l.fees < 0 || l.challan < 0 || l.other < 0 || l.gst < 0)) throw bad('Amounts cannot be negative.');
    const sum = k => money(lines.reduce((s, l) => s + l[k], 0));
    const fees = sum('fees'), challan = sum('challan'), other = sum('other'), gst = sum('gst');
    const total = money(fees + challan + other + gst);
    if (total <= 0) throw bad('The bill total must be more than zero.');

    const bill = (await conn.query(
      `INSERT INTO bill_entries (firm_id, client_id, client_name, bill_no, bill_date, fees_amount, challan_amount, other_amount, gst_amount, total_amount, notes, created_by_id, created_by_name)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [firm.id, clientId, clientName, billNo, b.bill_date, fees, challan, other, gst, total, clean(b.notes) || null, req.bill.id, req.bill.name])).rows[0];
    for (const l of lines) {
      const t = tasks.find(x => x.task_id === l.task_id);
      await conn.query(
        `INSERT INTO bill_entry_tasks (bill_id, task_id, task_name, fees_amount, challan_amount, other_amount, gst_amount) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [bill.id, l.task_id, t.work_name, l.fees, l.challan, l.other, l.gst]);
    }
    await conn.query(`UPDATE tasks SET billing_status='Billed' WHERE organization_id=$1 AND task_id = ANY($2)`, [req.bill.orgId, ids]);
    const payIds = Array.isArray(b.payment_ids) ? b.payment_ids.map(Number).filter(Boolean) : [];
    if (payIds.length) {
      await conn.query(
        `UPDATE bill_payment_requests SET recovered_bill_id=$1, updated_at=NOW()
          WHERE id = ANY($2) AND client_id=$3 AND status='Paid' AND funding='Firm funds' AND recovered_bill_id IS NULL`, [bill.id, payIds, clientId]);
    }
    await logTimeline(conn, 'bill', bill.id, 'created', `Bill ${billNo} for ${clientName}, total ${total}`, req.bill.name);
    await conn.query('COMMIT');
    res.json({ success: true, message: `Bill ${billNo} recorded for ${ids.length} work item(s).`, bill });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      const msg = /ux_bill_entry_no/.test(err.constraint || '') ? 'This bill number is already recorded for the same firm.' : 'Some of this work is already billed.';
      return res.status(409).json({ success: false, message: msg });
    }
    fail(res, err, 'Could not record the bill');
  } finally { conn.release(); }
});

router.get('/bills', requireManager, async (req, res) => {
  try {
    const o = req.query; const params = [req.bill.orgId]; const conds = ['be.organization_id=$1'];
    const add = v => { params.push(v); return '$' + params.length; };
    const state = clean(o.state) || 'active';
    if (state === 'cancelled') conds.push(`be.status='Cancelled'`); else conds.push(`be.status='Active'`);
    if (state === 'unpaid') conds.push(`COALESCE(al.alloc,0) <= 0.004`);
    if (state === 'partial') conds.push(`COALESCE(al.alloc,0) > 0.004 AND be.total_amount - COALESCE(al.alloc,0) > 0.004`);
    if (state === 'paid') conds.push(`be.total_amount - COALESCE(al.alloc,0) <= 0.004`);
    if (state === 'due') conds.push(`be.total_amount - COALESCE(al.alloc,0) > 0.004`);
    if (clean(o.firm_id)) conds.push(`be.firm_id=${add(Number(o.firm_id))}`);
    if (clean(o.client_id)) conds.push(`be.client_id=${add(clean(o.client_id))}`);
    if (clean(o.date_from)) conds.push(`be.bill_date >= ${add(clean(o.date_from))}::date`);
    if (clean(o.date_to)) conds.push(`be.bill_date <= ${add(clean(o.date_to))}::date`);
    if (clean(o.search)) { const p = add(`%${clean(o.search)}%`); conds.push(`(be.bill_no ILIKE ${p} OR be.client_name ILIKE ${p} OR be.client_id ILIKE ${p})`); }
    const r = await db.query(
      `SELECT be.*, to_char(be.bill_date,'YYYY-MM-DD') AS bill_date, bf.name AS firm_name, COALESCE(al.alloc,0) AS received,
              be.total_amount - COALESCE(al.alloc,0) AS outstanding,
              (SELECT COUNT(*)::int FROM bill_entry_tasks x WHERE x.bill_id=be.id) AS work_count
         FROM bill_entries be JOIN bill_firms bf ON bf.id=be.firm_id LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id
        WHERE ${conds.join(' AND ')} ORDER BY be.bill_date DESC, be.id DESC LIMIT 400`, params);
    res.json({ success: true, bills: r.rows.map(x => ({ ...x, pay_state: x.status === 'Cancelled' ? 'Cancelled' : payState(x.total_amount, x.received) })) });
  } catch (err) { fail(res, err, 'Could not load bills'); }
});

router.get('/bills/:id', requireManager, async (req, res) => {
  try {
    const bill = (await db.query(
      `SELECT be.*, to_char(be.bill_date,'YYYY-MM-DD') AS bill_date, bf.name AS firm_name, COALESCE(al.alloc,0) AS received, be.total_amount - COALESCE(al.alloc,0) AS outstanding
         FROM bill_entries be JOIN bill_firms bf ON bf.id=be.firm_id LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id WHERE be.id=$1`, [req.params.id])).rows[0];
    if (!bill) throw bad('Bill not found', 404);
    const [works, allocs, paid, timeline] = await Promise.all([
      db.query(`SELECT * FROM bill_entry_tasks WHERE bill_id=$1 ORDER BY id`, [bill.id]),
      db.query(`SELECT a.amount, r.receipt_no, to_char(r.receipt_date,'YYYY-MM-DD') AS receipt_date, r.id AS receipt_id FROM bill_receipt_allocations a JOIN bill_receipts r ON r.id=a.receipt_id WHERE a.bill_id=$1 ORDER BY r.receipt_date`, [bill.id]),
      db.query(`SELECT id, request_no, purpose, payee, COALESCE(paid_amount,amount) AS amount FROM bill_payment_requests WHERE recovered_bill_id=$1`, [bill.id]),
      db.query(`SELECT action, note, actor_name, created_at FROM bill_timeline WHERE entity_type='bill' AND entity_id=$1 ORDER BY created_at, id`, [bill.id]),
    ]);
    res.json({ success: true, bill: { ...bill, pay_state: bill.status === 'Cancelled' ? 'Cancelled' : payState(bill.total_amount, bill.received) }, works: works.rows, allocations: allocs.rows, recovered: paid.rows, timeline: timeline.rows });
  } catch (err) { fail(res, err, 'Could not load the bill'); }
});

router.post('/bills/:id/cancel', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const bill = (await conn.query(`SELECT * FROM bill_entries WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!bill) throw bad('Bill not found', 404);
    if (bill.status === 'Cancelled') throw bad('This bill is already cancelled.');
    if (!clean(req.body.reason)) throw bad('Please write the reason for cancelling.');
    const alloc = await conn.query(`SELECT COALESCE(SUM(amount),0) AS a FROM bill_receipt_allocations WHERE bill_id=$1`, [bill.id]);
    if (money(alloc.rows[0].a) > 0) throw bad('Receipts are set against this bill. Remove those allocations first (Receipts > Allocate).', 409);
    await conn.query(`UPDATE bill_entries SET status='Cancelled', cancel_reason=$2, cancelled_by=$3, cancelled_at=NOW() WHERE id=$1`, [bill.id, clean(req.body.reason), req.bill.name]);
    const tasks = await conn.query(`UPDATE bill_entry_tasks SET is_active=FALSE, released_at=NOW() WHERE bill_id=$1 AND is_active RETURNING task_id`, [bill.id]);
    const ids = tasks.rows.map(t => t.task_id);
    if (ids.length) {
      await conn.query(
        `UPDATE tasks t SET billing_status=NULL WHERE t.organization_id=$2 AND t.task_id = ANY($1)
            AND NOT EXISTS (SELECT 1 FROM bill_entry_tasks x WHERE x.task_id=t.task_id AND x.is_active)`, [ids, req.bill.orgId]);
    }
    await conn.query(`UPDATE bill_payment_requests SET recovered_bill_id=NULL, updated_at=NOW() WHERE recovered_bill_id=$1`, [bill.id]);
    await logTimeline(conn, 'bill', bill.id, 'cancelled', clean(req.body.reason), req.bill.name);
    await conn.query('COMMIT');
    res.json({ success: true, message: `Bill ${bill.bill_no} cancelled. Its work is back in the unbilled list.` });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not cancel the bill'); }
  finally { conn.release(); }
});

// ── Receipts and advances ────────────────────────────────────
// Bills that can still take money from this client for this firm. With receipt_id, the receipt's own allocations are
// left out of the "received" figure so the same screen can be used to change them.
router.get('/open-bills', requireManager, async (req, res) => {
  try {
    const receiptId = Number(req.query.receipt_id) || null;
    const r = await db.query(
      `SELECT be.id, be.bill_no, to_char(be.bill_date,'YYYY-MM-DD') AS bill_date, be.total_amount,
              COALESCE((SELECT SUM(x.amount) FROM bill_receipt_allocations x WHERE x.bill_id=be.id AND ($3::int IS NULL OR x.receipt_id <> $3)),0) AS received,
              COALESCE((SELECT SUM(x.amount) FROM bill_receipt_allocations x WHERE x.bill_id=be.id AND x.receipt_id = $3),0) AS mine
         FROM bill_entries be
        WHERE be.client_id=$1 AND be.firm_id=$2 AND be.status='Active'
        ORDER BY be.bill_date, be.id`, [clean(req.query.client_id), Number(req.query.firm_id) || 0, receiptId]);
    const bills = r.rows.map(x => ({ ...x, outstanding: money(Number(x.total_amount) - Number(x.received)) })).filter(x => x.outstanding > 0.004);
    res.json({ success: true, bills });
  } catch (err) { fail(res, err, 'Could not load the open bills'); }
});

async function checkAllocations(conn, receipt, allocations, { excludeReceiptId = null } = {}) {
  let total = 0;
  const clean2 = [];
  for (const a of allocations || []) {
    const amt = money(a.amount);
    if (!a.bill_id || amt <= 0) continue;
    const bill = (await conn.query(
      `SELECT be.id, be.bill_no, be.total_amount, be.client_id, be.firm_id, be.status,
              COALESCE((SELECT SUM(x.amount) FROM bill_receipt_allocations x WHERE x.bill_id=be.id AND ($2::int IS NULL OR x.receipt_id <> $2)),0) AS others
         FROM bill_entries be WHERE be.id=$1`, [a.bill_id, excludeReceiptId])).rows[0];
    if (!bill || bill.status !== 'Active') throw bad('One of the bills is not available.');
    if (bill.client_id !== receipt.client_id || Number(bill.firm_id) !== Number(receipt.firm_id)) throw bad(`Bill ${bill.bill_no} belongs to a different client or firm.`);
    if (amt - (money(bill.total_amount) - money(bill.others)) > 0.004) throw bad(`Bill ${bill.bill_no} has only ${money(money(bill.total_amount) - money(bill.others))} left to receive.`);
    total = money(total + amt);
    clean2.push({ bill_id: bill.id, amount: amt });
  }
  if (total - money(receipt.amount) > 0.004) throw bad('The amount set against bills is more than the receipt.');
  return clean2;
}

router.post('/receipts', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const b = req.body;
    const firm = (await conn.query(`SELECT * FROM bill_firms WHERE id=$1 AND status='Active'`, [b.firm_id])).rows[0];
    if (!firm) throw bad('Please choose the firm that received the money.');
    const client = (await conn.query(`SELECT client_id, COALESCE(NULLIF(legal_name,''), business_name) AS name FROM clients WHERE client_id=$1 AND organization_id=$2`, [clean(b.client_id), req.bill.orgId])).rows[0];
    if (!client) throw bad('Please choose the client.');
    const amount = money(b.amount);
    if (amount <= 0) throw bad('Please enter the amount received.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(b.receipt_date))) throw bad('Please choose the receipt date.');
    let account = null;
    if (b.account_id) {
      account = (await conn.query(`SELECT * FROM bill_accounts WHERE id=$1 AND firm_id=$2`, [b.account_id, firm.id])).rows[0];
      if (!account) throw bad('This account does not belong to the chosen firm.');
    }
    const receiptRow = { client_id: client.client_id, firm_id: firm.id, amount };
    const allocs = await checkAllocations(conn, receiptRow, b.allocations || []);
    const fy = financialYear(b.receipt_date);
    const prefix = `${firm.code}/RCP/${fy}/`;
    let receipt = null;
    for (let attempt = 0; attempt < 4 && !receipt; attempt++) {
      const seq = (await conn.query(`SELECT COUNT(*)::int + 1 + $2::int AS n FROM bill_receipts WHERE receipt_no LIKE $1`, [prefix + '%', attempt])).rows[0].n;
      const no = prefix + String(seq).padStart(4, '0');
      try {
        await conn.query('SAVEPOINT rno');
        receipt = (await conn.query(
          `INSERT INTO bill_receipts (receipt_no, receipt_date, firm_id, account_id, client_id, client_name, amount, mode, reference_no, remarks, created_by_id, created_by_name)
           VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [no, b.receipt_date, firm.id, account?.id || null, client.client_id, client.name, amount, clean(b.mode) || account?.account_type || null, clean(b.reference_no) || null, clean(b.remarks) || null, req.bill.id, req.bill.name])).rows[0];
      } catch (e) { await conn.query('ROLLBACK TO SAVEPOINT rno'); if (e.code !== '23505') throw e; }
    }
    if (!receipt) throw bad('Could not create a receipt number. Please try again.', 409);
    for (const a of allocs) await conn.query(`INSERT INTO bill_receipt_allocations (receipt_id, bill_id, amount) VALUES ($1,$2,$3)`, [receipt.id, a.bill_id, a.amount]);
    const allocated = money(allocs.reduce((s, a) => s + a.amount, 0));
    await logTimeline(conn, 'receipt', receipt.id, 'created', `${receipt.receipt_no}: ${amount} from ${client.name}; ${allocated} set against bills, ${money(amount - allocated)} kept as advance`, req.bill.name);
    await conn.query('COMMIT');
    res.json({ success: true, message: `Receipt ${receipt.receipt_no} saved.${amount - allocated > 0.004 ? ` ${money(amount - allocated)} is kept as the client's advance.` : ''}`, receipt, allocated, advance: money(amount - allocated) });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not save the receipt'); }
  finally { conn.release(); }
});

router.get('/receipts', requireManager, async (req, res) => {
  try {
    const o = req.query; const params = [req.bill.orgId]; const conds = ['r.organization_id=$1'];
    const add = v => { params.push(v); return '$' + params.length; };
    if (clean(o.firm_id)) conds.push(`r.firm_id=${add(Number(o.firm_id))}`);
    if (clean(o.client_id)) conds.push(`r.client_id=${add(clean(o.client_id))}`);
    if (clean(o.date_from)) conds.push(`r.receipt_date >= ${add(clean(o.date_from))}::date`);
    if (clean(o.date_to)) conds.push(`r.receipt_date <= ${add(clean(o.date_to))}::date`);
    if (clean(o.state) === 'advance') conds.push(`r.status='Active' AND r.amount - COALESCE((SELECT SUM(a.amount) FROM bill_receipt_allocations a WHERE a.receipt_id=r.id),0) > 0.004`);
    if (clean(o.search)) { const p = add(`%${clean(o.search)}%`); conds.push(`(r.receipt_no ILIKE ${p} OR r.client_name ILIKE ${p} OR r.reference_no ILIKE ${p})`); }
    const r = await db.query(
      `SELECT r.*, to_char(r.receipt_date,'YYYY-MM-DD') AS receipt_date, bf.name AS firm_name, bf.code AS firm_code, ba.account_name,
              COALESCE((SELECT SUM(a.amount) FROM bill_receipt_allocations a WHERE a.receipt_id=r.id),0) AS allocated
         FROM bill_receipts r JOIN bill_firms bf ON bf.id=r.firm_id LEFT JOIN bill_accounts ba ON ba.id=r.account_id
        WHERE ${conds.join(' AND ')} ORDER BY r.receipt_date DESC, r.id DESC LIMIT 400`, params);
    res.json({ success: true, receipts: r.rows.map(x => ({ ...x, advance: x.status === 'Active' ? money(Number(x.amount) - Number(x.allocated)) : 0 })) });
  } catch (err) { fail(res, err, 'Could not load receipts'); }
});

router.get('/receipts/:id', requireManager, async (req, res) => {
  try {
    const rc = (await db.query(
      `SELECT r.*, to_char(r.receipt_date,'YYYY-MM-DD') AS receipt_date, bf.name AS firm_name, bf.code AS firm_code, bf.address AS firm_address, bf.phone AS firm_phone, bf.email AS firm_email, bf.gstin AS firm_gstin, bf.pan AS firm_pan, ba.account_name
         FROM bill_receipts r JOIN bill_firms bf ON bf.id=r.firm_id LEFT JOIN bill_accounts ba ON ba.id=r.account_id WHERE r.id=$1`, [req.params.id])).rows[0];
    if (!rc) throw bad('Receipt not found', 404);
    const allocs = await db.query(`SELECT a.bill_id, a.amount, be.bill_no, to_char(be.bill_date,'YYYY-MM-DD') AS bill_date FROM bill_receipt_allocations a JOIN bill_entries be ON be.id=a.bill_id WHERE a.receipt_id=$1`, [rc.id]);
    res.json({ success: true, receipt: rc, allocations: allocs.rows });
  } catch (err) { fail(res, err, 'Could not load the receipt'); }
});

router.put('/receipts/:id/allocations', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const rc = (await conn.query(`SELECT * FROM bill_receipts WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!rc) throw bad('Receipt not found', 404);
    if (rc.status !== 'Active') throw bad('A cancelled receipt cannot be changed.');
    const allocs = await checkAllocations(conn, rc, req.body.allocations || [], { excludeReceiptId: rc.id });
    const before = money((await conn.query(`SELECT COALESCE(SUM(amount),0) AS a FROM bill_receipt_allocations WHERE receipt_id=$1`, [rc.id])).rows[0].a);
    const after = money(allocs.reduce((s, a) => s + a.amount, 0));
    // The advance must stay enough for approved / paid payments that were funded from it
    if (after > before + 0.004) {
      const adv = await advanceAvailable(conn, rc.client_id, rc.firm_id);
      if (adv.available - (after - before) < -0.004) throw bad(`This would use advance that is already set aside for approved payments (only ${adv.available} is free).`, 409);
    }
    await conn.query(`DELETE FROM bill_receipt_allocations WHERE receipt_id=$1`, [rc.id]);
    for (const a of allocs) await conn.query(`INSERT INTO bill_receipt_allocations (receipt_id, bill_id, amount) VALUES ($1,$2,$3)`, [rc.id, a.bill_id, a.amount]);
    await logTimeline(conn, 'receipt', rc.id, 'allocations_changed', `Set against bills: ${before} to ${after}`, req.bill.name);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Receipt allocation saved.', allocated: after, advance: money(Number(rc.amount) - after) });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not save the allocation'); }
  finally { conn.release(); }
});

router.post('/receipts/:id/cancel', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const rc = (await conn.query(`SELECT * FROM bill_receipts WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!rc) throw bad('Receipt not found', 404);
    if (rc.status === 'Cancelled') throw bad('This receipt is already cancelled.');
    if (!clean(req.body.reason)) throw bad('Please write the reason for cancelling.');
    const alloc = money((await conn.query(`SELECT COALESCE(SUM(amount),0) AS a FROM bill_receipt_allocations WHERE receipt_id=$1`, [rc.id])).rows[0].a);
    if (alloc > 0) throw bad('This receipt is set against bills. Remove the allocation first (Allocate).', 409);
    const adv = await advanceAvailable(conn, rc.client_id, rc.firm_id);
    if (adv.available - money(rc.amount) < -0.004) throw bad('Part of this advance is set aside for approved payments. Cancel those payment requests first.', 409);
    await conn.query(`UPDATE bill_receipts SET status='Cancelled', cancel_reason=$2, cancelled_by=$3, cancelled_at=NOW() WHERE id=$1`, [rc.id, clean(req.body.reason), req.bill.name]);
    await logTimeline(conn, 'receipt', rc.id, 'cancelled', clean(req.body.reason), req.bill.name);
    await conn.query('COMMIT');
    res.json({ success: true, message: `Receipt ${rc.receipt_no} cancelled.` });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not cancel the receipt'); }
  finally { conn.release(); }
});

// ── Dashboard ────────────────────────────────────────────────
router.get('/dashboard', requireManager, async (req, res) => {
  try {
    const org = req.bill.orgId;
    const taskAmt = `CASE WHEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) <> 0
                          THEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) ELSE COALESCE(t.total_amount,0) END`;
    const [unbilled, billedMonth, outstanding, advance, recover, pay, firms] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(${taskAmt}),0) AS amount ${WORK_FROM} WHERE t.organization_id=$1 AND t.active_flag=true AND be.id IS NULL AND h.id IS NULL AND COALESCE(t.fees_applicable,'Yes')<>'No'`, [org]),
      db.query(`SELECT bf.name AS firm_name, COUNT(*)::int AS bills, COALESCE(SUM(be.total_amount),0) AS total FROM bill_entries be JOIN bill_firms bf ON bf.id=be.firm_id
                 WHERE be.status='Active' AND date_trunc('month', be.bill_date) = date_trunc('month', CURRENT_DATE) GROUP BY bf.name ORDER BY bf.name`),
      db.query(`SELECT COALESCE(SUM(be.total_amount - COALESCE(al.alloc,0)),0) AS amount, COUNT(*) FILTER (WHERE be.total_amount - COALESCE(al.alloc,0) > 0.004)::int AS bills
                  FROM bill_entries be LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id WHERE be.status='Active'`),
      db.query(`SELECT COALESCE((SELECT SUM(r.amount - COALESCE((SELECT SUM(a.amount) FROM bill_receipt_allocations a WHERE a.receipt_id=r.id),0)) FROM bill_receipts r WHERE r.status='Active'),0)
                     - COALESCE((SELECT SUM(COALESCE(p.paid_amount,p.approved_amount,p.amount)) FROM bill_payment_requests p WHERE p.funding='Client advance' AND p.status IN ('Approved','Paid')),0) AS amount`),
      db.query(`SELECT COALESCE(SUM(COALESCE(paid_amount,amount)),0) AS amount, COUNT(*)::int AS n FROM bill_payment_requests WHERE status='Paid' AND funding='Firm funds' AND recovered_bill_id IS NULL AND purpose <> 'Office expense' AND client_id IS NOT NULL`),
      db.query(`SELECT COUNT(*) FILTER (WHERE status IN ('Requested','Query'))::int AS waiting, COALESCE(SUM(amount) FILTER (WHERE status IN ('Requested','Query')),0) AS waiting_amount,
                       COUNT(*) FILTER (WHERE status='Approved')::int AS to_pay, COALESCE(SUM(COALESCE(approved_amount,amount)) FILTER (WHERE status='Approved'),0) AS to_pay_amount FROM bill_payment_requests`),
      db.query(`SELECT bf.id, bf.name, COALESCE(SUM(be.total_amount),0) AS billed,
                       COALESCE(SUM(COALESCE(al.alloc,0)),0) AS received, COALESCE(SUM(be.total_amount - COALESCE(al.alloc,0)),0) AS outstanding
                  FROM bill_firms bf LEFT JOIN bill_entries be ON be.firm_id=bf.id AND be.status='Active'
                       AND be.bill_date >= make_date(CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE) >= 4 THEN EXTRACT(YEAR FROM CURRENT_DATE)::int ELSE EXTRACT(YEAR FROM CURRENT_DATE)::int - 1 END, 4, 1)
                  LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id
                 WHERE bf.status='Active' GROUP BY bf.id, bf.name ORDER BY bf.name`),
    ]);
    res.json({
      success: true, unbilled: unbilled.rows[0], billed_this_month: billedMonth.rows, outstanding: outstanding.rows[0],
      advance_held: advance.rows[0].amount, to_recover: recover.rows[0], payments: pay.rows[0], firms: firms.rows,
    });
  } catch (err) { fail(res, err, 'Could not load the dashboard'); }
});

router.use(require('./billingReports'));
router.use(require('./billingPayments'));

module.exports = router;
