const express = require('express');
const db = require('../db');
const { clean, money, requireManager, logTimeline, financialYear } = require('../services/billingCommon');

// Bank statement lines kept in suspense or under a head until they are moved to a client receipt / payment.
// Mounted inside routes/billing.js (billing access is already checked).
const router = express.Router();
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const fail = (res, err, fallback) => {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[billing bank]', err);
  res.status(status).json({ success: false, message: status === 500 ? fallback : err.message });
};

const HEADS = [
  { name: 'Suspense', dir: 'both', note: 'Not identified yet' },
  { name: 'Client receipt', dir: 'credit', note: 'Money received from a client', client: true },
  { name: 'Client payment', dir: 'debit', note: 'Paid for a client', client: true },
  { name: 'Proprietor - capital introduced', dir: 'credit', note: 'Money the proprietor put into the firm' },
  { name: 'Proprietor - drawings', dir: 'debit', note: 'Money the proprietor took out' },
  { name: 'Transfer between firms', dir: 'both', note: 'To or from another firm of the same owner' },
  { name: 'Salary', dir: 'debit', note: 'Salary, stipend, staff advance' },
  { name: 'Government tax / statutory', dir: 'debit', note: 'GST, TDS, PF, ESIC, income tax' },
  { name: 'ROC / MCA fee', dir: 'debit', note: 'MCA / ROC portal payments (client not identified)' },
  { name: 'Card / loan / EMI', dir: 'debit', note: 'Credit card, loan, EMI, standing instructions' },
  { name: 'Cash withdrawal', dir: 'debit', note: 'ATM / cash withdrawn' },
  { name: 'Office expense', dir: 'debit', note: 'Rent, recharge, supplies, other office cost' },
  { name: 'Bank charges / interest', dir: 'both', note: 'Charges, interest, reversals' },
  { name: 'Other income', dir: 'credit', note: 'Income that is not from a client bill' },
];
const HEAD = Object.fromEntries(HEADS.map(h => [h.name, h]));

router.get('/bank-heads', requireManager, (req, res) => res.json({ success: true, heads: HEADS }));

function whereOf(req) {
  const p = [], c = [];
  const q = req.query;
  if (clean(q.account_id)) { p.push(Number(q.account_id)); c.push(`e.account_id=$${p.length}`); }
  if (clean(q.head)) { p.push(clean(q.head)); c.push(`e.head=$${p.length}`); }
  if (clean(q.direction) === 'in') c.push('e.credit > 0'); else if (clean(q.direction) === 'out') c.push('e.debit > 0');
  if (clean(q.from)) { p.push(clean(q.from)); c.push(`e.entry_date >= $${p.length}::date`); }
  if (clean(q.to)) { p.push(clean(q.to)); c.push(`e.entry_date <= $${p.length}::date`); }
  if (clean(q.search)) { p.push('%' + clean(q.search) + '%'); c.push(`(e.remarks ILIKE $${p.length} OR e.note ILIKE $${p.length} OR e.tran_id ILIKE $${p.length} OR e.client_name ILIKE $${p.length})`); }
  return { where: c.length ? 'WHERE ' + c.join(' AND ') : '', params: p };
}

router.get('/bank-entries', requireManager, async (req, res) => {
  try {
    const { where, params } = whereOf(req);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1), size = Math.min(500, Math.max(10, parseInt(req.query.size, 10) || 100));
    const [rows, tot, byHead] = await Promise.all([
      db.query(`SELECT e.id, e.account_id, e.tran_id, to_char(e.entry_date,'YYYY-MM-DD') AS entry_date, e.remarks, e.credit, e.debit, e.head, e.auto_head, e.note,
                       e.client_id, e.client_name, e.linked_receipt_id, e.linked_payment_id, a.account_name
                  FROM bill_bank_entries e JOIN bill_accounts a ON a.id=e.account_id ${where}
                 ORDER BY e.entry_date DESC, e.id DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params),
      db.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(credit),0) AS credit, COALESCE(SUM(debit),0) AS debit FROM bill_bank_entries e ${where}`, params),
      db.query(`SELECT head, COUNT(*)::int AS n, COALESCE(SUM(credit),0) AS credit, COALESCE(SUM(debit),0) AS debit FROM bill_bank_entries e
                 ${whereOf({ query: { ...req.query, head: '' } }).where} GROUP BY head ORDER BY (head='Suspense') DESC, SUM(credit)+SUM(debit) DESC`, whereOf({ query: { ...req.query, head: '' } }).params),
    ]);
    res.json({ success: true, rows: rows.rows, total: tot.rows[0], by_head: byHead.rows, page, size });
  } catch (err) { fail(res, err, 'Could not load the bank entries'); }
});

async function nextNo(conn, table, col, prefix, pad) {
  for (let i = 0; i < 6; i++) {
    const n = (await conn.query(`SELECT COUNT(*)::int + 1 + $2::int AS n FROM ${table} WHERE ${col} LIKE $1`, [prefix + '%', i])).rows[0].n;
    const no = prefix + String(n).padStart(pad, '0');
    if (!(await conn.query(`SELECT 1 FROM ${table} WHERE ${col}=$1`, [no])).rows.length) return no;
  }
  throw bad('Could not create a number. Please try again.', 409);
}

// Remove the receipt / payment that was created from this line (it is cancelled, never deleted)
async function unlink(conn, e, who) {
  if (e.linked_receipt_id) {
    await conn.query(`UPDATE bill_receipts SET status='Cancelled', cancel_reason='Bank entry moved to another head', cancelled_by=$2, cancelled_at=NOW() WHERE id=$1 AND status='Active'`, [e.linked_receipt_id, who]);
    await logTimeline(conn, 'receipt', e.linked_receipt_id, 'cancelled', 'Bank entry moved to another head', who);
  }
  if (e.linked_payment_id) {
    await conn.query(`UPDATE bill_payment_requests SET status='Cancelled', updated_at=NOW() WHERE id=$1 AND status='Paid'`, [e.linked_payment_id]);
    await logTimeline(conn, 'payment', e.linked_payment_id, 'cancelled', 'Bank entry moved to another head', who);
  }
}

async function classify(conn, req, e, b) {
  const head = clean(b.head);
  const h = HEAD[head];
  if (!h) throw bad('Please choose a head.');
  if (h.dir === 'credit' && !(Number(e.credit) > 0)) throw bad(`"${head}" is for money received. This line is a payment.`);
  if (h.dir === 'debit' && !(Number(e.debit) > 0)) throw bad(`"${head}" is for money paid. This line is money received.`);
  const note = clean(b.note) || null;
  await unlink(conn, e, req.bill.name);
  let clientId = null, clientName = null, rid = null, pid = null;
  if (h.client) {
    const c = (await conn.query(`SELECT client_id, COALESCE(NULLIF(legal_name,''), business_name) AS name FROM clients WHERE client_id=$1`, [clean(b.client_id)])).rows[0];
    if (!c) throw bad('Please choose the client.');
    clientId = c.client_id; clientName = c.name;
    const acc = (await conn.query(`SELECT a.firm_id, a.account_type, f.code FROM bill_accounts a JOIN bill_firms f ON f.id=a.firm_id WHERE a.id=$1`, [e.account_id])).rows[0];
    const date = e.entry_date;
    if (head === 'Client receipt') {
      const no = await nextNo(conn, 'bill_receipts', 'receipt_no', `${acc.code}/RCP/${financialYear(date)}/`, 4);
      rid = (await conn.query(
        `INSERT INTO bill_receipts (receipt_no, receipt_date, firm_id, account_id, client_id, client_name, amount, mode, reference_no, remarks, created_by_id, created_by_name)
         VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [no, date, acc.firm_id, e.account_id, clientId, clientName, e.credit, acc.account_type, e.tran_id, 'From bank statement. ' + clean(e.remarks).slice(0, 200) + (note ? ' · ' + note : ''), req.bill.id, req.bill.name])).rows[0].id;
      await logTimeline(conn, 'receipt', rid, 'created', 'From bank statement line ' + (e.tran_id || e.id), req.bill.name);
    } else {
      const purpose = ['Government challan / fee', 'ROC / MCA fee', 'Stamp duty', 'Vendor / professional fee', 'Travel / conveyance', 'Refund of advance', 'Office expense', 'Other'].includes(clean(b.purpose)) ? clean(b.purpose) : 'Other';
      const no = await nextNo(conn, 'bill_payment_requests', 'request_no', `PAY/${financialYear(date)}/`, 4);
      pid = (await conn.query(
        `INSERT INTO bill_payment_requests (request_no, client_id, client_name, purpose, payee, amount, firm_id, account_id, funding, description, status, requested_by_id, requested_by_name, requested_at,
            approved_by_name, approved_at, approved_amount, paid_amount, paid_on, paid_by_name, paid_reference, paid_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Firm funds',$9,'Paid',$10,$11,$12::date,'From bank statement',$12::date,$6,$6,$12::date,$11,$13,'Created from a bank statement line (no proof attached)') RETURNING id`,
        [no, clientId, clientName, purpose, clean(b.payee) || clean(e.remarks).slice(0, 80), e.debit, acc.firm_id, e.account_id, 'From bank statement. ' + clean(e.remarks).slice(0, 200) + (note ? ' · ' + note : ''), req.bill.id, req.bill.name, date, e.tran_id || 'Bank'])).rows[0].id;
      await logTimeline(conn, 'payment', pid, 'paid', 'From bank statement line ' + (e.tran_id || e.id), req.bill.name);
    }
  }
  await conn.query(`UPDATE bill_bank_entries SET head=$2, auto_head=FALSE, note=COALESCE($3, note), client_id=$4, client_name=$5, linked_receipt_id=$6, linked_payment_id=$7, updated_by=$8, updated_at=NOW() WHERE id=$1`,
    [e.id, head, note, clientId, clientName, rid, pid, req.bill.name]);
}

router.put('/bank-entries/:id', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const e = (await conn.query(`SELECT *, to_char(entry_date,'YYYY-MM-DD') AS entry_date FROM bill_bank_entries WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
    if (!e) throw bad('Entry not found', 404);
    if (req.body.head === undefined) { await conn.query(`UPDATE bill_bank_entries SET note=$2, updated_by=$3, updated_at=NOW() WHERE id=$1`, [e.id, clean(req.body.note) || null, req.bill.name]); }
    else await classify(conn, req, e, req.body);
    await conn.query('COMMIT');
    res.json({ success: true, message: 'Saved.' });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not save the entry'); }
  finally { conn.release(); }
});

// Add a line that is on the bank statement but missing here
router.post('/bank-entries', requireManager, async (req, res) => {
  try {
    const b = req.body;
    const acc = (await db.query(`SELECT id FROM bill_accounts WHERE id=$1`, [b.account_id])).rows[0];
    if (!acc) throw bad('Please choose the account.');
    if (!/^d{4}-d{2}-d{2}$/.test(clean(b.entry_date))) throw bad('Please choose the date.');
    const credit = money(b.credit), debit = money(b.debit);
    if ((credit > 0) === (debit > 0)) throw bad('Please enter either the amount received or the amount paid.');
    const head = HEAD[clean(b.head)] && !HEAD[clean(b.head)].client ? clean(b.head) : 'Suspense';
    if (HEAD[head].dir === 'credit' && !(credit > 0)) throw bad(`"${head}" is for money received.`);
    if (HEAD[head].dir === 'debit' && !(debit > 0)) throw bad(`"${head}" is for money paid.`);
    const r = await db.query(
      `INSERT INTO bill_bank_entries (account_id, tran_id, entry_date, remarks, credit, debit, head, note, updated_by, updated_at) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id`,
      [acc.id, clean(b.tran_id) || null, clean(b.entry_date), clean(b.remarks) || null, credit, debit, head, clean(b.note) || null, req.bill.name]);
    res.json({ success: true, id: r.rows[0].id, message: 'Entry added.' });
  } catch (err) { fail(res, err, 'Could not add the entry'); }
});

// Move many lines to one head (heads that need no client)
router.post('/bank-entries/bulk', requireManager, async (req, res) => {
  const conn = await db.pool.connect();
  try {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean);
    if (!ids.length) throw bad('Please select the entries first.');
    if (ids.length > 500) throw bad('Please move at most 500 entries at a time.');
    const head = clean(req.body.head);
    if (!HEAD[head] || HEAD[head].client) throw bad('For a client receipt or payment, move the entries one by one so each gets its client.');
    await conn.query('BEGIN');
    const rows = (await conn.query(`SELECT *, to_char(entry_date,'YYYY-MM-DD') AS entry_date FROM bill_bank_entries WHERE id = ANY($1) FOR UPDATE`, [ids])).rows;
    for (const e of rows) await classify(conn, req, e, { head, note: req.body.note });
    await conn.query('COMMIT');
    res.json({ success: true, message: `${rows.length} entries moved to ${head}.` });
  } catch (err) { await conn.query('ROLLBACK').catch(() => {}); fail(res, err, 'Could not move the entries'); }
  finally { conn.release(); }
});

module.exports = router;
