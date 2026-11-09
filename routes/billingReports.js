const express = require('express');
const XLSX = require('xlsx');
const db = require('../db');
const { clean, money, requireManager, advanceAvailable, ALLOC_SUM, WORK_FROM, workWhere } = require('../services/billingCommon');

// Client summary page and reports. Mounted inside routes/billing.js (billing access is already checked).
const router = express.Router();
const bad = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const fail = (res, err, fallback) => {
  const status = err.statusCode || 500;
  if (status === 500) console.error('[billing reports]', err);
  res.status(status).json({ success: false, message: status === 500 ? fallback : err.message });
};

const TASK_AMOUNT = `CASE WHEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) <> 0
                          THEN COALESCE(t.professional_fees,0)+COALESCE(t.challan_amount,0)+COALESCE(t.other_expense,0) ELSE COALESCE(t.total_amount,0) END`;

// ── One-page position of a client ────────────────────────────
router.get('/clients/:id/summary', requireManager, async (req, res) => {
  try {
    const cid = clean(req.params.id);
    const client = (await db.query(
      `SELECT client_id, COALESCE(NULLIF(legal_name,''), business_name) AS name, business_name, mobile_number, email_id, gst_no, pan_no
         FROM clients WHERE client_id=$1 AND organization_id=$2`, [cid, req.bill.orgId])).rows[0];
    if (!client) throw bad('Client not found', 404);
    const [works, firms, bills, receipts, recoverable, payments] = await Promise.all([
      db.query(
        `SELECT COUNT(*) FILTER (WHERE be.id IS NULL AND h.id IS NULL AND COALESCE(t.fees_applicable,'Yes')<>'No')::int AS unbilled_n,
                COALESCE(SUM(${TASK_AMOUNT}) FILTER (WHERE be.id IS NULL AND h.id IS NULL AND COALESCE(t.fees_applicable,'Yes')<>'No'),0) AS unbilled_amount,
                COUNT(*) FILTER (WHERE be.id IS NOT NULL)::int AS billed_n,
                COUNT(*) FILTER (WHERE be.id IS NULL AND (h.id IS NOT NULL OR COALESCE(t.fees_applicable,'Yes')='No'))::int AS hold_n
           ${WORK_FROM} WHERE t.organization_id=$1 AND t.client_id=$2 AND t.active_flag=true`, [req.bill.orgId, cid]),
      db.query(
        `SELECT bf.id, bf.name, COALESCE(SUM(be.total_amount),0) AS billed, COALESCE(SUM(COALESCE(al.alloc,0)),0) AS received,
                COALESCE(SUM(be.total_amount - COALESCE(al.alloc,0)),0) AS outstanding, COUNT(be.id)::int AS bills,
                COALESCE(SUM(be.challan_amount),0) AS challan, COALESCE(SUM(be.gst_amount),0) AS gst
           FROM bill_firms bf LEFT JOIN bill_entries be ON be.firm_id=bf.id AND be.client_id=$1 AND be.status='Active'
           LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id GROUP BY bf.id, bf.name ORDER BY bf.name`, [cid]),
      db.query(
        `SELECT be.id, be.bill_no, to_char(be.bill_date,'YYYY-MM-DD') AS bill_date, bf.name AS firm_name, be.total_amount, be.challan_amount,
                be.total_amount - COALESCE(al.alloc,0) AS outstanding
           FROM bill_entries be JOIN bill_firms bf ON bf.id=be.firm_id LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id
          WHERE be.client_id=$1 AND be.status='Active' ORDER BY be.bill_date DESC, be.id DESC LIMIT 15`, [cid]),
      db.query(
        `SELECT r.id, r.receipt_no, to_char(r.receipt_date,'YYYY-MM-DD') AS receipt_date, bf.name AS firm_name, r.amount,
                r.amount - COALESCE((SELECT SUM(a.amount) FROM bill_receipt_allocations a WHERE a.receipt_id=r.id),0) AS advance
           FROM bill_receipts r JOIN bill_firms bf ON bf.id=r.firm_id WHERE r.client_id=$1 AND r.status='Active' ORDER BY r.receipt_date DESC, r.id DESC LIMIT 10`, [cid]),
      db.query(
        `SELECT request_no, purpose, payee, task_name, COALESCE(paid_amount,amount) AS amount, to_char(paid_on,'YYYY-MM-DD') AS paid_on
           FROM bill_payment_requests WHERE client_id=$1 AND status='Paid' AND funding='Firm funds' AND recovered_bill_id IS NULL ORDER BY paid_on, id`, [cid]),
      db.query(
        `SELECT request_no, purpose, payee, task_name, amount, status, funding, to_char(requested_at,'YYYY-MM-DD') AS requested_on
           FROM bill_payment_requests WHERE client_id=$1 ORDER BY requested_at DESC LIMIT 10`, [cid]),
    ]);
    const advance = {};
    for (const f of firms.rows) advance[f.id] = (await advanceAvailable(db, cid, f.id)).available;
    res.json({
      success: true, client, works: works.rows[0],
      firms: firms.rows.map(f => ({ ...f, advance: advance[f.id] })).filter(f => f.bills || f.advance),
      bills: bills.rows, receipts: receipts.rows, recoverable: recoverable.rows, payments: payments.rows,
    });
  } catch (err) { fail(res, err, 'Could not load the client summary'); }
});

// ── Reports: shown on screen or downloaded as Excel ──────────
function dateConds(req, column, conds, params) {
  if (clean(req.query.date_from)) { params.push(clean(req.query.date_from)); conds.push(`${column} >= $${params.length}::date`); }
  if (clean(req.query.date_to)) { params.push(clean(req.query.date_to)); conds.push(`${column} <= $${params.length}::date`); }
}
function eqConds(req, map, conds, params) {
  for (const [key, column] of Object.entries(map)) {
    if (clean(req.query[key])) { params.push(key === 'firm_id' ? Number(req.query[key]) : clean(req.query[key])); conds.push(`${column}=$${params.length}`); }
  }
}

const REPORTS = {
  unbilled: {
    title: 'Unbilled work',
    run: async req => {
      const { conds, params } = workWhere({ bill: req.bill, query: { ...req.query, state: 'unbilled' } });
      const r = await db.query(
        `SELECT COALESCE(NULLIF(c.legal_name,''), NULLIF(c.business_name,''), t.legal_name, t.business_name, t.client_id) AS client, t.work_name, t.task_id, t.status, t.assigned_to_name,
                to_char(t.completion_date,'YYYY-MM-DD') AS completed, to_char(t.due_date,'YYYY-MM-DD') AS due, ${TASK_AMOUNT} AS amount,
                (CURRENT_DATE - COALESCE(t.completion_date, t.due_date, t.created_at::date)) AS days
           ${WORK_FROM} WHERE ${conds.join(' AND ')} ORDER BY client, days DESC LIMIT 5000`, params);
      return { columns: ['Client', 'Work', 'Task ID', 'Status', 'Assigned to', 'Completed on', 'Due on', 'Amount', 'Days since'],
        rows: r.rows.map(x => [x.client, x.work_name, x.task_id, x.status, x.assigned_to_name, x.completed, x.due, Number(x.amount), x.days]) };
    },
  },
  bills: {
    title: 'Bills',
    run: async req => {
      const params = [req.bill.orgId]; const conds = ['be.organization_id=$1', `be.status='Active'`];
      eqConds(req, { firm_id: 'be.firm_id', client_id: 'be.client_id' }, conds, params);
      dateConds(req, 'be.bill_date', conds, params);
      const r = await db.query(
        `SELECT bf.name AS firm, be.bill_no, to_char(be.bill_date,'YYYY-MM-DD') AS bdate, be.client_name, be.fees_amount, be.challan_amount, be.other_amount, be.gst_amount, be.total_amount,
                COALESCE(al.alloc,0) AS received, be.total_amount - COALESCE(al.alloc,0) AS outstanding
           FROM bill_entries be JOIN bill_firms bf ON bf.id=be.firm_id LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id
          WHERE ${conds.join(' AND ')} ORDER BY be.bill_date, be.id LIMIT 5000`, params);
      return { columns: ['Firm', 'Bill no', 'Date', 'Client', 'Professional fees', 'Challan', 'Other', 'GST', 'Total', 'Received', 'Outstanding'],
        rows: r.rows.map(x => [x.firm, x.bill_no, x.bdate, x.client_name, ...['fees_amount', 'challan_amount', 'other_amount', 'gst_amount', 'total_amount', 'received', 'outstanding'].map(k => Number(x[k]))]) };
    },
  },
  outstanding: {
    title: 'Outstanding bills',
    run: async req => {
      const params = [req.bill.orgId]; const conds = ['be.organization_id=$1', `be.status='Active'`, `be.total_amount - COALESCE(al.alloc,0) > 0.004`];
      eqConds(req, { firm_id: 'be.firm_id', client_id: 'be.client_id' }, conds, params);
      const r = await db.query(
        `SELECT be.client_name, bf.name AS firm, be.bill_no, to_char(be.bill_date,'YYYY-MM-DD') AS bdate, be.total_amount, COALESCE(al.alloc,0) AS received,
                be.total_amount - COALESCE(al.alloc,0) AS outstanding, (CURRENT_DATE - be.bill_date) AS age
           FROM bill_entries be JOIN bill_firms bf ON bf.id=be.firm_id LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id
          WHERE ${conds.join(' AND ')} ORDER BY be.client_name, be.bill_date LIMIT 5000`, params);
      return { columns: ['Client', 'Firm', 'Bill no', 'Bill date', 'Total', 'Received', 'Outstanding', 'Days old'],
        rows: r.rows.map(x => [x.client_name, x.firm, x.bill_no, x.bdate, Number(x.total_amount), Number(x.received), Number(x.outstanding), x.age]) };
    },
  },
  receipts: {
    title: 'Receipts',
    run: async req => {
      const params = [req.bill.orgId]; const conds = ['r.organization_id=$1', `r.status='Active'`];
      eqConds(req, { firm_id: 'r.firm_id', client_id: 'r.client_id' }, conds, params);
      dateConds(req, 'r.receipt_date', conds, params);
      const r = await db.query(
        `SELECT r.receipt_no, to_char(r.receipt_date,'YYYY-MM-DD') AS rdate, bf.name AS firm, r.client_name, r.amount, r.mode, r.reference_no,
                COALESCE((SELECT SUM(a.amount) FROM bill_receipt_allocations a WHERE a.receipt_id=r.id),0) AS allocated
           FROM bill_receipts r JOIN bill_firms bf ON bf.id=r.firm_id WHERE ${conds.join(' AND ')} ORDER BY r.receipt_date, r.id LIMIT 5000`, params);
      return { columns: ['Receipt no', 'Date', 'Firm', 'Client', 'Amount', 'Mode', 'Reference', 'Set against bills', 'Kept as advance'],
        rows: r.rows.map(x => [x.receipt_no, x.rdate, x.firm, x.client_name, Number(x.amount), x.mode, x.reference_no, Number(x.allocated), money(Number(x.amount) - Number(x.allocated))]) };
    },
  },
  advances: {
    title: 'Client advances',
    run: async () => {
      const pairs = await db.query(`SELECT DISTINCT r.client_id, r.client_name, r.firm_id, bf.name AS firm FROM bill_receipts r JOIN bill_firms bf ON bf.id=r.firm_id WHERE r.status='Active'`);
      const rows = [];
      for (const p of pairs.rows) {
        const a = await advanceAvailable(db, p.client_id, p.firm_id);
        if (a.available > 0.004 || a.unallocated > 0.004) rows.push([p.client_name, p.firm, a.unallocated, a.used, a.available]);
      }
      return { columns: ['Client', 'Firm', 'Received, not set against bills', 'Set aside for payments', 'Advance available'], rows };
    },
  },
  recoverable: {
    title: 'Paid for clients, not yet charged in a bill',
    run: async () => {
      const r = await db.query(
        `SELECT p.client_name, p.task_name, p.purpose, p.payee, COALESCE(p.paid_amount,p.amount) AS amount, to_char(p.paid_on,'YYYY-MM-DD') AS pdate, bf.name AS firm, p.paid_reference
           FROM bill_payment_requests p JOIN bill_firms bf ON bf.id=p.firm_id
          WHERE p.status='Paid' AND p.funding='Firm funds' AND p.recovered_bill_id IS NULL AND p.client_id IS NOT NULL ORDER BY p.client_name, p.paid_on`);
      return { columns: ['Client', 'Work', 'Purpose', 'Payee', 'Amount', 'Paid on', 'Firm', 'Reference'],
        rows: r.rows.map(x => [x.client_name, x.task_name, x.purpose, x.payee, Number(x.amount), x.pdate, x.firm, x.paid_reference]) };
    },
  },
  payments: {
    title: 'Payment requests',
    run: async req => {
      const params = [req.bill.orgId]; const conds = ['p.organization_id=$1'];
      eqConds(req, { firm_id: 'p.firm_id', client_id: 'p.client_id' }, conds, params);
      dateConds(req, 'p.requested_at::date', conds, params);
      const r = await db.query(
        `SELECT p.request_no, p.requested_by_name, to_char(p.requested_at,'YYYY-MM-DD') AS rdate, p.client_name, p.task_name, p.purpose, p.payee, p.amount, p.status, p.funding,
                p.approved_by_name, to_char(p.paid_on,'YYYY-MM-DD') AS pdate, p.paid_amount, p.paid_reference, bf.name AS firm
           FROM bill_payment_requests p JOIN bill_firms bf ON bf.id=p.firm_id WHERE ${conds.join(' AND ')} ORDER BY p.requested_at DESC LIMIT 5000`, params);
      return { columns: ['Request no', 'Requested by', 'Date', 'Client', 'Work', 'Purpose', 'Payee', 'Amount', 'Status', 'Funding', 'Approved by', 'Paid on', 'Paid amount', 'Reference', 'Firm'],
        rows: r.rows.map(x => [x.request_no, x.requested_by_name, x.rdate, x.client_name, x.task_name, x.purpose, x.payee, Number(x.amount), x.status, x.funding, x.approved_by_name, x.pdate, x.paid_amount == null ? null : Number(x.paid_amount), x.paid_reference, x.firm]) };
    },
  },
};

router.get('/reports/:name', requireManager, async (req, res) => {
  try {
    const def = REPORTS[req.params.name];
    if (!def) throw bad('Unknown report', 404);
    const out = await def.run(req);
    if (clean(req.query.format) === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([out.columns, ...out.rows]);
      ws['!cols'] = out.columns.map(c => ({ wch: Math.max(12, Math.min(34, String(c).length + 4)) }));
      XLSX.utils.book_append_sheet(wb, ws, def.title.slice(0, 28));
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="billing_${req.params.name}.xlsx"`);
      return res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    }
    res.json({ success: true, title: def.title, columns: out.columns, rows: out.rows });
  } catch (err) { fail(res, err, 'Could not build the report'); }
});

module.exports = router;
