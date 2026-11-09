const express = require('express');
const multer = require('multer');
const db = require('../db');
const { clean, money, esc, financialYear, logTimeline, advanceAvailable } = require('../services/billingCommon');
const { sendEmail } = require('../utils/email');
const { createNotif } = require('./notifications');

// Payments staff make for clients: request -> approval -> paid with proof.
// Mounted inside routes/billing.js, so billing access (req.bill) is already set.
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });
const APP_URL = process.env.APP_URL || 'https://geebharat.com';

const PURPOSES = ['Government challan / fee', 'ROC / MCA fee', 'Stamp duty', 'Vendor / professional fee', 'Travel / conveyance', 'Refund of advance', 'Office expense', 'Other'];
const OFFICE = 'Office expense';
const REFUND = 'Refund of advance';
const MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const fail = (res, err, fallback) => {
  const status = err.statusCode || (err.code === '23505' ? 409 : 500);
  if (status === 500) console.error('[billing payments]', err);
  res.status(status).json({ success: false, message: status === 500 ? fallback : err.message });
};

const SELECT = `SELECT p.*, to_char(p.needed_by,'YYYY-MM-DD') AS needed_by, to_char(p.paid_on,'YYYY-MM-DD') AS paid_on,
       bf.name AS firm_name, ba.account_name,
       (SELECT COUNT(*)::int FROM bill_attachments a WHERE a.request_id=p.id AND a.kind='request') AS n_request_files,
       (SELECT COUNT(*)::int FROM bill_attachments a WHERE a.request_id=p.id AND a.kind='proof') AS n_proof_files,
       EXTRACT(DAY FROM NOW() - p.requested_at)::int AS age_days
  FROM bill_payment_requests p JOIN bill_firms bf ON bf.id=p.firm_id LEFT JOIN bill_accounts ba ON ba.id=p.account_id`;

function canDecide(access, p, amount) {
  if (!access.manager) return false;
  if (p.requested_by_id === access.id && !access.self_approve) return false;
  if (access.approver) return true;
  return access.om && access.om_limit > 0 && money(amount ?? p.amount) <= access.om_limit;
}
const isRequester = (access, p) => p.requested_by_id === access.id;

function flags(access, p) {
  const open = ['Requested', 'Query'].includes(p.status);
  return {
    approve: p.status === 'Requested' && canDecide(access, p),
    reject: p.status === 'Requested' && canDecide(access, p),
    query: p.status === 'Requested' && canDecide(access, p),
    reply: p.status === 'Query' && isRequester(access, p),
    edit: open && isRequester(access, p),
    pay: p.status === 'Approved' && (isRequester(access, p) || access.manager),
    cancel: ['Requested', 'Query', 'Approved'].includes(p.status) && (isRequester(access, p) || access.approver),
    attach: ['Requested', 'Query', 'Approved', 'Paid'].includes(p.status) && (isRequester(access, p) || access.manager),
  };
}

async function loadVisible(req, id) {
  const p = (await db.query(`${SELECT} WHERE p.id=$1`, [id])).rows[0];
  if (!p || (!req.bill.manager && p.requested_by_id !== req.bill.id)) throw bad('Payment request not found', 404);
  return p;
}

async function emailOf(actorId) {
  const e = await db.query(`SELECT email_id FROM emplist WHERE emp_id=$1 LIMIT 1`, [actorId]);
  if (e.rows[0]?.email_id) return e.rows[0].email_id;
  const a = await db.query(`SELECT email_id FROM admins WHERE username=$1 LIMIT 1`, [actorId]);
  return a.rows[0]?.email_id || null;
}
const mailHtml = (title, lines, linkText = 'Open Billing') => `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;color:#1e293b;line-height:1.55;">
  <div style="background:#13203a;color:#fff;padding:12px 18px;border-radius:10px 10px 0 0;font-weight:700;">${esc(title)}</div>
  <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 10px 10px;padding:18px;font-size:14px;">${lines.map(l => `<p style="margin:0 0 8px;">${l}</p>`).join('')}
  <p><a href="${APP_URL}/billing.html" style="display:inline-block;background:#2155f3;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600;">${linkText}</a></p></div>
  <p style="font-size:12px;color:#94a3b8;text-align:center;">This is an automated message from the Gee Bharat office system.</p></div>`;
const rupees = n => '₹' + Number(n || 0).toLocaleString('en-IN');

async function notifyApprovers(p, byName) {
  try {
    const access = (await db.query(`SELECT value FROM attendance_settings WHERE key='BILL_OM_LIMIT'`)).rows[0];
    const omLimit = Number(access?.value || 0);
    const roles = ['Owner', 'Director', 'Proprietor', ...(omLimit > 0 && Number(p.amount) <= omLimit ? ['Office Manager'] : [])];
    const admins = await db.query(`SELECT username, email_id FROM admins WHERE COALESCE(status,'Active')='Active' AND role = ANY($1::varchar[])`, [roles]);
    const msg = `${byName} has asked for approval to pay ${rupees(p.amount)} (${p.purpose})${p.client_name ? ' for ' + p.client_name : ''}.`;
    const mailed = new Set(); const mails = [];
    for (const a of admins.rows) {
      await createNotif(a.username, 'billing_payment_request', 'Payment request waiting for approval', msg, null);
      const to = String(a.email_id || '').trim().toLowerCase();
      if (to && !mailed.has(to)) {
        mailed.add(to);
        mails.push(sendEmail({ to, subject: `Payment approval needed: ${p.request_no} (${rupees(p.amount)})`, html: mailHtml('Payment waiting for approval', [esc(msg), `Request no: <strong>${esc(p.request_no)}</strong>`, p.payee ? `Payee: ${esc(p.payee)}` : '', p.description ? `Details: ${esc(p.description)}` : ''].filter(Boolean), 'Review and approve'), text: `${msg} Open ${APP_URL}/billing.html` }).catch(e => console.error('[billing mail]', e.message)));
      }
    }
    await Promise.all(mails);
  } catch (e) { console.error('[billing notify approvers]', e.message); }
}

async function notifyRequester(p, title, msg) {
  try {
    await createNotif(p.requested_by_id, 'billing_payment_update', title, msg, null);
    const to = await emailOf(p.requested_by_id);
    if (to) await sendEmail({ to, subject: `${title}: ${p.request_no}`, html: mailHtml(title, [esc(msg)]), text: `${msg} Open ${APP_URL}/billing.html` }).catch(e => console.error('[billing mail]', e.message));
  } catch (e) { console.error('[billing notify requester]', e.message); }
}

// Checks shared by create and edit
async function validateRequest(conn, b, current = null) {
  const purpose = current?.purpose || clean(b.purpose);
  if (!PURPOSES.includes(purpose)) throw bad('Please choose what the payment is for.');
  const amount = money(b.amount);
  if (amount <= 0) throw bad('Please enter the amount.');
  const firmId = Number(b.firm_id ?? current?.firm_id);
  const firm = (await conn.query(`SELECT id FROM bill_firms WHERE id=$1 AND status='Active'`, [firmId])).rows[0];
  if (!firm) throw bad('Please choose the firm that will make the payment.');
  const accountId = Number(b.account_id ?? current?.account_id) || null;
  if (!accountId) throw bad('Please choose the bank, cash or UPI account the payment will be made from.');
  const acc = (await conn.query(`SELECT id FROM bill_accounts WHERE id=$1 AND firm_id=$2 AND status='Active'`, [accountId, firmId])).rows[0];
  if (!acc) throw bad('This account does not belong to the chosen firm.');
  if (!clean(b.payee ?? current?.payee)) throw bad('Please write who will be paid (the payee).');
  const neededBy = clean(b.needed_by ?? current?.needed_by) || null;
  if (neededBy && !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) throw bad('Please choose a valid date.');

  let clientId = null, clientName = null, taskId = null, taskName = null;
  if (purpose !== OFFICE) {
    clientId = clean(b.client_id ?? current?.client_id);
    if (!clientId) throw bad('Please choose the client this payment is for. Every payment must be linked to a client and a work.');
    const cl = (await conn.query(`SELECT COALESCE(NULLIF(legal_name,''), business_name) AS name FROM clients WHERE client_id=$1 AND organization_id=$2`, [clientId, db.getTenantContext().organizationId])).rows[0];
    if (!cl) throw bad('This client was not found.');
    clientName = cl.name;
    taskId = clean(b.task_id ?? current?.task_id);
    if (!taskId) throw bad('Please choose the work this payment is for.');
    const t = (await conn.query(`SELECT task_id, work_name FROM tasks WHERE task_id=$1 AND client_id=$2 AND active_flag=true`, [taskId, clientId])).rows[0];
    if (!t) throw bad('This work does not belong to the chosen client.');
    taskName = t.work_name;
  }
  const funding = purpose === OFFICE ? 'Firm funds' : (purpose === REFUND ? 'Client advance' : (clean(b.funding ?? current?.funding) === 'Client advance' ? 'Client advance' : 'Firm funds'));
  if (funding === 'Client advance') {
    if (!clientId) throw bad('An advance can be used only for a client payment.');
    const adv = await advanceAvailable(conn, clientId, firmId, current?.id || null);
    if (amount - adv.available > 0.004) throw bad(`This client's advance with this firm is ${rupees(adv.available)} only. Choose "Firm funds" or ask the client for an advance.`);
  }
  return { purpose, amount, firmId, accountId, payee: clean(b.payee ?? current?.payee), neededBy, clientId, clientName, taskId, taskName, funding, description: clean(b.description ?? current?.description) || null };
}

router.get('/client-tasks', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT task_id, work_name, status, to_char(due_date,'YYYY-MM-DD') AS due_date FROM tasks
        WHERE organization_id=$1 AND client_id=$2 AND active_flag=true ORDER BY created_at DESC LIMIT 200`, [req.bill.orgId, clean(req.query.client_id)]);
    res.json({ success: true, tasks: r.rows, purposes: PURPOSES });
  } catch (err) { fail(res, err, 'Could not load the work list'); }
});

router.post('/payments', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const v = await validateRequest(conn, req.body);
    const fy = financialYear();
    const prefix = `PAY/${fy}/`;
    let row = null;
    for (let attempt = 0; attempt < 4 && !row; attempt++) {
      const seq = (await conn.query(`SELECT COUNT(*)::int + 1 + $2::int AS n FROM bill_payment_requests WHERE request_no LIKE $1`, [prefix + '%', attempt])).rows[0].n;
      try {
        await conn.query('SAVEPOINT pno');
        row = (await conn.query(
          `INSERT INTO bill_payment_requests (request_no, client_id, client_name, task_id, task_name, purpose, payee, amount, needed_by, firm_id, account_id, funding, description, requested_by_id, requested_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [prefix + String(seq).padStart(4, '0'), v.clientId, v.clientName, v.taskId, v.taskName, v.purpose, v.payee, v.amount, v.neededBy, v.firmId, v.accountId, v.funding, v.description, req.bill.id, req.bill.name])).rows[0];
      } catch (e) { await conn.query('ROLLBACK TO SAVEPOINT pno'); if (e.code !== '23505') throw e; }
    }
    if (!row) throw bad('Could not create a request number. Please try again.', 409);
    await logTimeline(conn, 'payment', row.id, 'requested', `${v.purpose}: ${v.amount} to ${v.payee}`, req.bill.name);
    await conn.query('COMMIT');
    await notifyApprovers(row, req.bill.name);
    res.json({ success: true, message: `Request ${row.request_no} sent for approval.`, payment: row });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not send the request'); }
  finally { conn.release(); }
});

router.get('/payments', async (req, res) => {
  try {
    const a = req.bill; const scope = clean(req.query.scope) || 'mine';
    const params = [a.orgId]; const conds = ['p.organization_id=$1'];
    if (scope === 'mine' || !a.manager) { params.push(a.id); conds.push(`p.requested_by_id=$${params.length}`); }
    else if (scope === 'approve') { conds.push(`p.status='Requested'`); if (!a.approver) { params.push(a.om_limit); conds.push(`p.amount <= $${params.length}`); } }
    else if (scope === 'topay') conds.push(`p.status='Approved'`);
    else if (scope === 'history') conds.push(`p.status IN ('Paid','Rejected','Cancelled')`);
    else if (scope === 'open') conds.push(`p.status IN ('Requested','Query','Approved')`);
    if (clean(req.query.status)) { params.push(clean(req.query.status)); conds.push(`p.status=$${params.length}`); }
    if (clean(req.query.client_id)) { params.push(clean(req.query.client_id)); conds.push(`p.client_id=$${params.length}`); }
    if (clean(req.query.search)) { params.push(`%${clean(req.query.search)}%`); const n = params.length; conds.push(`(p.request_no ILIKE $${n} OR p.client_name ILIKE $${n} OR p.payee ILIKE $${n} OR p.requested_by_name ILIKE $${n})`); }
    const r = await db.query(`${SELECT} WHERE ${conds.join(' AND ')} ORDER BY CASE p.status WHEN 'Requested' THEN 0 WHEN 'Query' THEN 1 WHEN 'Approved' THEN 2 ELSE 3 END, p.requested_at DESC LIMIT 300`, params);
    res.json({ success: true, payments: r.rows.map(p => ({ ...p, can: flags(a, p) })), purposes: PURPOSES });
  } catch (err) { fail(res, err, 'Could not load payment requests'); }
});

router.get('/payments/:id', async (req, res) => {
  try {
    const p = await loadVisible(req, req.params.id);
    const [files, timeline] = await Promise.all([
      db.query(`SELECT id, kind, filename, mime, size_bytes, uploaded_by_name, created_at FROM bill_attachments WHERE request_id=$1 ORDER BY id`, [p.id]),
      db.query(`SELECT action, note, actor_name, created_at FROM bill_timeline WHERE entity_type='payment' AND entity_id=$1 ORDER BY created_at, id`, [p.id]),
    ]);
    let position = null;
    if (req.bill.manager && p.client_id) {
      const [work, bills, adv, rec, last] = await Promise.all([
        db.query(`SELECT COUNT(*) FILTER (WHERE be.id IS NULL AND h.id IS NULL AND COALESCE(t.fees_applicable,'Yes')<>'No')::int AS unbilled FROM tasks t
                    LEFT JOIN bill_entry_tasks bet ON bet.task_id=t.task_id AND bet.is_active LEFT JOIN bill_entries be ON be.id=bet.bill_id
                    LEFT JOIN bill_task_holds h ON h.task_id=t.task_id AND h.is_active WHERE t.organization_id=$1 AND t.client_id=$2 AND t.active_flag=true`, [req.bill.orgId, p.client_id]),
        db.query(`SELECT bf.name AS firm_name, COUNT(*)::int AS bills, COALESCE(SUM(be.total_amount - COALESCE((SELECT SUM(a.amount) FROM bill_receipt_allocations a WHERE a.bill_id=be.id),0)),0) AS outstanding
                    FROM bill_entries be JOIN bill_firms bf ON bf.id=be.firm_id WHERE be.client_id=$1 AND be.status='Active' GROUP BY bf.name`, [p.client_id]),
        advanceAvailable(db, p.client_id, p.firm_id, p.id),
        db.query(`SELECT COALESCE(SUM(COALESCE(paid_amount,amount)),0) AS amount, COUNT(*)::int AS n FROM bill_payment_requests WHERE client_id=$1 AND status='Paid' AND funding='Firm funds' AND recovered_bill_id IS NULL AND id <> $2`, [p.client_id, p.id]),
        db.query(`SELECT request_no, purpose, COALESCE(paid_amount,amount) AS amount, to_char(paid_on,'YYYY-MM-DD') AS paid_on FROM bill_payment_requests WHERE client_id=$1 AND status='Paid' AND id <> $2 ORDER BY paid_on DESC NULLS LAST, id DESC LIMIT 5`, [p.client_id, p.id]),
      ]);
      position = { unbilled_works: work.rows[0].unbilled, outstanding_by_firm: bills.rows, advance_available: adv.available, advance_unallocated: adv.unallocated, to_recover: rec.rows[0], last_payments: last.rows };
    }
    res.json({ success: true, payment: { ...p, can: flags(req.bill, p) }, attachments: files.rows, timeline: timeline.rows, position });
  } catch (err) { fail(res, err, 'Could not load the request'); }
});

router.put('/payments/:id', async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const cur = (await conn.query(`SELECT * FROM bill_payment_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!cur || cur.requested_by_id !== req.bill.id) throw bad('Payment request not found', 404);
    if (!['Requested', 'Query'].includes(cur.status)) throw bad('This request can no longer be edited. Cancel it and raise a new one.');
    const v = await validateRequest(conn, req.body, { ...cur, needed_by: cur.needed_by ? new Date(cur.needed_by).toISOString().slice(0, 10) : null });
    await conn.query(
      `UPDATE bill_payment_requests SET amount=$2, payee=$3, needed_by=$4::date, firm_id=$5, account_id=$6, funding=$7, description=$8, updated_at=NOW() WHERE id=$1`,
      [cur.id, v.amount, v.payee, v.neededBy, v.firmId, v.accountId, v.funding, v.description]);
    await logTimeline(conn, 'payment', cur.id, 'edited', null, req.bill.name);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Request updated.' });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not update the request'); }
  finally { conn.release(); }
});

async function transition(req, res, action) {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const p = (await conn.query(`SELECT * FROM bill_payment_requests WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!p || (!req.bill.manager && p.requested_by_id !== req.bill.id)) throw bad('Payment request not found', 404);
    const note = clean(req.body.note);
    let timelineAction = action, message = '', notify = null;

    if (action === 'approve') {
      if (p.status !== 'Requested') throw bad('Only a request that is waiting can be approved.');
      const amount = req.body.approved_amount === undefined || req.body.approved_amount === '' ? money(p.amount) : money(req.body.approved_amount);
      if (amount <= 0 || amount - money(p.amount) > 0.004) throw bad('The approved amount must be more than zero and not more than the amount asked.');
      if (!canDecide(req.bill, p, amount)) throw bad(p.requested_by_id === req.bill.id && !req.bill.self_approve ? 'You cannot approve your own request.' : 'This amount needs an owner or director to approve it.', 403);
      if (p.funding === 'Client advance') {
        const adv = await advanceAvailable(conn, p.client_id, p.firm_id, p.id);
        if (amount - adv.available > 0.004) throw bad(`The client's advance with this firm is now ${rupees(adv.available)} only.`, 409);
      }
      await conn.query(`UPDATE bill_payment_requests SET status='Approved', approved_by_id=$2, approved_by_name=$3, approved_at=NOW(), approved_amount=$4, decision_note=$5, updated_at=NOW() WHERE id=$1`, [p.id, req.bill.id, req.bill.name, amount, note || null]);
      message = `Approved for ${rupees(amount)}.`; timelineAction = 'approved';
      notify = ['Payment approved', `Your request ${p.request_no} (${rupees(p.amount)}) was approved for ${rupees(amount)} by ${req.bill.name}. You can now make the payment and mark it as paid with proof.${note ? ' Note: ' + note : ''}`];
    } else if (action === 'reject' || action === 'query') {
      if (p.status !== 'Requested') throw bad('Only a request that is waiting can be ' + (action === 'reject' ? 'rejected' : 'questioned') + '.');
      if (!canDecide(req.bill, p)) throw bad(p.requested_by_id === req.bill.id && !req.bill.self_approve ? 'You cannot decide on your own request.' : 'This amount needs an owner or director.', 403);
      if (!note) throw bad(action === 'reject' ? 'Please write the reason for rejecting.' : 'Please write your question.');
      await conn.query(`UPDATE bill_payment_requests SET status=$2, approved_by_id=$3, approved_by_name=$4, approved_at=NOW(), decision_note=$5, updated_at=NOW() WHERE id=$1`, [p.id, action === 'reject' ? 'Rejected' : 'Query', req.bill.id, req.bill.name, note]);
      message = action === 'reject' ? 'Request rejected.' : 'Question sent to the requester.';
      timelineAction = action === 'reject' ? 'rejected' : 'query';
      notify = action === 'reject' ? ['Payment request rejected', `Your request ${p.request_no} was rejected by ${req.bill.name}. Reason: ${note}`] : ['Question on your payment request', `${req.bill.name} has a question on ${p.request_no}: ${note}`];
    } else if (action === 'reply') {
      if (p.status !== 'Query' || p.requested_by_id !== req.bill.id) throw bad('There is no question to answer on this request.');
      if (!note) throw bad('Please write your reply.');
      await conn.query(`UPDATE bill_payment_requests SET status='Requested', updated_at=NOW() WHERE id=$1`, [p.id]);
      message = 'Reply sent. The request is waiting for approval again.'; timelineAction = 'replied';
    } else if (action === 'cancel') {
      if (!['Requested', 'Query', 'Approved'].includes(p.status)) throw bad('This request cannot be cancelled now.');
      if (!(p.requested_by_id === req.bill.id || req.bill.approver)) throw bad('Only the requester or a director can cancel this.', 403);
      if (p.status === 'Approved' && !note) throw bad('Please write why an approved payment is being cancelled.');
      await conn.query(`UPDATE bill_payment_requests SET status='Cancelled', updated_at=NOW() WHERE id=$1`, [p.id]);
      message = 'Request cancelled.'; timelineAction = 'cancelled';
      if (p.requested_by_id !== req.bill.id) notify = ['Payment request cancelled', `Your request ${p.request_no} was cancelled by ${req.bill.name}.${note ? ' ' + note : ''}`];
    } else if (action === 'paid') {
      if (p.status !== 'Approved') throw bad('Only an approved request can be marked as paid.');
      if (!(p.requested_by_id === req.bill.id || req.bill.manager)) throw bad('Request not found', 404);
      const reference = clean(req.body.reference);
      if (!reference) throw bad('Please enter the UTR, challan number or payment reference.');
      const paidAmount = req.body.paid_amount === undefined || req.body.paid_amount === '' ? money(p.approved_amount) : money(req.body.paid_amount);
      if (paidAmount <= 0 || paidAmount - money(p.approved_amount) > 0.004) throw bad(`The paid amount cannot be more than the approved amount (${rupees(p.approved_amount)}). Ask for a fresh approval for a higher amount.`);
      const paidOn = clean(req.body.paid_on) || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw bad('Please choose the payment date.');
      const proof = (await conn.query(`SELECT COUNT(*)::int AS n FROM bill_attachments WHERE request_id=$1 AND kind='proof'`, [p.id])).rows[0].n;
      if (!proof) throw bad('Please attach the proof of payment (screenshot, challan or receipt) first.');
      await conn.query(`UPDATE bill_payment_requests SET status='Paid', paid_amount=$2, paid_on=$3::date, paid_by_name=$4, paid_reference=$5, paid_note=$6, updated_at=NOW() WHERE id=$1`, [p.id, paidAmount, paidOn, req.bill.name, reference, note || null]);
      message = 'Payment recorded.'; timelineAction = 'paid';
    } else throw bad('Unknown action');

    await logTimeline(conn, 'payment', p.id, timelineAction, note || null, req.bill.name);
    await conn.query('COMMIT');
    if (notify && p.requested_by_id !== req.bill.id) await notifyRequester(p, notify[0], notify[1]);
    if (action === 'reply') await notifyApprovers({ ...p, amount: p.amount }, req.bill.name);
    res.json({ success: true, message });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not update the request'); }
  finally { conn.release(); }
}
for (const action of ['approve', 'reject', 'query', 'reply', 'cancel', 'paid']) router.post(`/payments/:id/${action}`, (req, res) => transition(req, res, action));

// ── Attachments (challan copy, proof of payment) ─────────────
router.post('/payments/:id/attachments', (req, res) => {
  upload.single('file')(req, res, async err => {
    try {
      if (err) throw bad(err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large. Please keep it under 4 MB.' : 'Could not read the file.');
      const p = await loadVisible(req, req.params.id);
      if (!flags(req.bill, p).attach) throw bad('Files cannot be added to this request now.', 403);
      if (!req.file) throw bad('Please choose a file.');
      if (!MIMES.has(req.file.mimetype)) throw bad('Please upload a PDF or an image (PNG, JPG, WEBP).');
      const kind = clean(req.body.kind) === 'proof' ? 'proof' : 'request';
      if (kind === 'proof' && !['Approved', 'Paid'].includes(p.status)) throw bad('Proof of payment can be added after the request is approved.');
      const count = (await db.query(`SELECT COUNT(*)::int AS n FROM bill_attachments WHERE request_id=$1`, [p.id])).rows[0].n;
      if (count >= 8) throw bad('A request can have up to 8 files.');
      const a = (await db.query(
        `INSERT INTO bill_attachments (request_id, kind, filename, mime, size_bytes, data, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, kind, filename, mime, size_bytes`,
        [p.id, kind, String(req.file.originalname || 'file').slice(0, 200), req.file.mimetype, req.file.size, req.file.buffer, req.bill.name])).rows[0];
      await logTimeline(db, 'payment', p.id, kind === 'proof' ? 'proof_added' : 'file_added', a.filename, req.bill.name);
      res.json({ success: true, attachment: a });
    } catch (e) { fail(res, e, 'Could not save the file'); }
  });
});

router.get('/attachments/:id', async (req, res) => {
  try {
    const a = (await db.query(`SELECT a.*, p.requested_by_id FROM bill_attachments a JOIN bill_payment_requests p ON p.id=a.request_id WHERE a.id=$1`, [req.params.id])).rows[0];
    if (!a || (!req.bill.manager && a.requested_by_id !== req.bill.id)) throw bad('File not found', 404);
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(a.filename || 'file').replace(/[^\w.\- ]/g, '_')}"`);
    res.send(a.data);
  } catch (err) { fail(res, err, 'Could not open the file'); }
});

module.exports = router;
