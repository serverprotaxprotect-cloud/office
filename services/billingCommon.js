const db = require('../db');
const authMiddleware = require('../middleware/auth');

const FEATURE_KEY = 'billing';

const clean = v => String(v ?? '').trim();
const money = v => { const n = Number(v || 0); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const actorId = (u = {}) => u.emp_id || u.username || String(u.id || 'SYSTEM');
const actorName = (u = {}) => u.formal_name || u.name || u.username || 'User';
const roleOf = (u = {}) => String(u.role || u.designation || '');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function financialYear(dateValue = new Date()) {
  const d = new Date(dateValue);
  const y = d.getFullYear();
  const start = d.getMonth() + 1 >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

async function featureOn(orgId) {
  const r = await db.query(`SELECT access_level FROM organization_feature_access WHERE organization_id=$1 AND feature_key=$2`, [orgId, FEATURE_KEY]);
  return (r.rows[0]?.access_level || 'none') !== 'none';
}

const parseSettings = rows => {
  const s = {}; rows.forEach(x => { s[x.key] = x.value; });
  return {
    om_limit: Math.max(0, money(s.BILL_OM_LIMIT || 0)),
    self_approve: String(s.BILL_SELF_APPROVE || 'No').toLowerCase() === 'yes',
  };
};
async function billSettings() {
  const r = await db.query(`SELECT key, value FROM attendance_settings WHERE key IN ('BILL_OM_LIMIT','BILL_SELF_APPROVE')`);
  return parseSettings(r.rows);
}

function accessOf(user, settings) {
  const role = roleOf(user);
  const approver = /owner|director|proprietor/i.test(role);
  const om = /office\s*manager/i.test(role);
  const manager = approver || om || /accountant/i.test(role);
  return { manager, approver, om, om_limit: settings.om_limit, self_approve: settings.self_approve, role };
}

// Every billing route: logged-in user (admin or employee) + billing switched on for the organisation.
function billingAuth(req, res, next) {
  return authMiddleware(req, res, async () => {
    try {
      const gate = await db.query(
        `SELECT 'flag' AS key, (SELECT access_level FROM organization_feature_access WHERE organization_id=$1 AND feature_key='billing') AS value
         UNION ALL SELECT key, value FROM attendance_settings WHERE key IN ('BILL_OM_LIMIT','BILL_SELF_APPROVE')`, [req.user.organization_id]);
      const flag = gate.rows.find(x => x.key === 'flag')?.value || 'none';
      if (flag === 'none') {
        return res.status(403).json({ success: false, code: 'BILLING_DISABLED', message: 'Billing is not enabled for this organisation.' });
      }
      const settings = parseSettings(gate.rows.filter(x => x.key !== 'flag'));
      req.bill = { ...accessOf(req.user, settings), id: actorId(req.user), name: actorName(req.user), orgId: req.user.organization_id };
      return next();
    } catch (err) {
      console.error('[billing auth]', err);
      return res.status(500).json({ success: false, message: 'Billing access check failed' });
    }
  });
}
const requireManager = (req, res, next) => req.bill?.manager ? next() : res.status(403).json({ success: false, message: 'This is available to the accounts team and directors only.' });
const requireApprover = (req, res, next) => req.bill?.approver ? next() : res.status(403).json({ success: false, message: 'Only an owner or director can do this.' });

async function logTimeline(q, entityType, entityId, action, note, actor) {
  await q.query(`INSERT INTO bill_timeline (entity_type, entity_id, action, note, actor_name) VALUES ($1,$2,$3,$4,$5)`,
    [entityType, entityId, action, note ? String(note).slice(0, 2000) : null, actor || null]);
}

// Money a client has paid in advance for one firm and that is still free to use:
// receipts not yet set against bills, minus approved/paid payments funded from that advance.
async function advanceAvailable(q, clientId, firmId, excludeRequestId = null) {
  const r = await q.query(
    `SELECT
       COALESCE((SELECT SUM(r.amount - COALESCE((SELECT SUM(a.amount) FROM bill_receipt_allocations a WHERE a.receipt_id=r.id),0))
                   FROM bill_receipts r WHERE r.client_id=$1 AND r.firm_id=$2 AND r.status='Active'),0) AS unalloc,
       COALESCE((SELECT SUM(COALESCE(p.paid_amount, p.approved_amount, p.amount))
                   FROM bill_payment_requests p
                  WHERE p.client_id=$1 AND p.firm_id=$2 AND p.funding='Client advance' AND p.status IN ('Approved','Paid')
                    AND ($3::int IS NULL OR p.id <> $3)),0) AS used`,
    [clientId, firmId, excludeRequestId]);
  const row = r.rows[0];
  return { unallocated: money(row.unalloc), used: money(row.used), available: money(Number(row.unalloc) - Number(row.used)) };
}

const PAY_STATE_SQL = {
  unpaid: `be.id IS NOT NULL AND COALESCE(al.alloc,0) <= 0.004`,
  partial: `be.id IS NOT NULL AND COALESCE(al.alloc,0) > 0.004 AND be.total_amount - COALESCE(al.alloc,0) > 0.004`,
  paid: `be.id IS NOT NULL AND be.total_amount - COALESCE(al.alloc,0) <= 0.004`,
};
const payState = (total, received) => {
  const t = money(total), r = money(received);
  if (r <= 0.004) return 'Unpaid';
  return t - r > 0.004 ? 'Partly paid' : 'Paid';
};
const ALLOC_SUM = `(SELECT bill_id, SUM(amount) AS alloc FROM bill_receipt_allocations GROUP BY bill_id)`;
// Tasks that were created only to carry out an approved payment are not client work, so they never appear for billing.
const WORK_FROM = `
  FROM (SELECT tk.* FROM tasks tk WHERE NOT EXISTS (SELECT 1 FROM bill_payment_requests pr WHERE pr.pay_task_id = tk.task_id)) t
  LEFT JOIN clients c ON c.client_id=t.client_id AND c.organization_id=t.organization_id
  LEFT JOIN bill_entry_tasks bet ON bet.task_id=t.task_id AND bet.is_active
  LEFT JOIN bill_entries be ON be.id=bet.bill_id
  LEFT JOIN bill_firms bf ON bf.id=be.firm_id
  LEFT JOIN ${ALLOC_SUM} al ON al.bill_id=be.id
  LEFT JOIN bill_task_holds h ON h.task_id=t.task_id AND h.is_active`;

function workWhere(req) {
  const o = req.query;
  const params = [req.bill.orgId];
  const conds = ['t.organization_id=$1', 't.active_flag=true'];
  const add = v => { params.push(v); return '$' + params.length; };
  const state = clean(o.state) || 'unbilled';
  if (state === 'unbilled') conds.push(`be.id IS NULL AND h.id IS NULL AND COALESCE(t.fees_applicable,'Yes')<>'No'`);
  else if (state === 'billed') conds.push('be.id IS NOT NULL');
  else if (state === 'hold') conds.push(`be.id IS NULL AND (h.id IS NOT NULL OR COALESCE(t.fees_applicable,'Yes')='No')`);
  else if (PAY_STATE_SQL[state]) conds.push(PAY_STATE_SQL[state]);
  if (clean(o.client_id)) conds.push(`t.client_id=${add(clean(o.client_id))}`);
  if (clean(o.firm_id)) conds.push(`be.firm_id=${add(Number(o.firm_id))}`);
  if (clean(o.status)) conds.push(`t.status=${add(clean(o.status))}`);
  if (clean(o.assigned)) conds.push(`t.assigned_to_name ILIKE ${add('%' + clean(o.assigned) + '%')}`);
  if (clean(o.search)) {
    const p = add(`%${clean(o.search)}%`);
    conds.push(`(t.task_id ILIKE ${p} OR t.client_id ILIKE ${p} OR t.legal_name ILIKE ${p} OR t.business_name ILIKE ${p} OR c.legal_name ILIKE ${p} OR c.business_name ILIKE ${p} OR t.work_name ILIKE ${p})`);
  }
  if (clean(o.date_from)) conds.push(`COALESCE(t.completion_date, t.due_date, t.created_at::date) >= ${add(clean(o.date_from))}::date`);
  if (clean(o.date_to)) conds.push(`COALESCE(t.completion_date, t.due_date, t.created_at::date) <= ${add(clean(o.date_to))}::date`);
  return { conds, params };
}

// Money in an account on a date: opening balance + receipts - payments, counting only movements on or after the opening date.
async function accountBalance(q, accountId, asOn = null) {
  const r = await q.query(
    `SELECT a.opening_balance, to_char(a.opening_date,'YYYY-MM-DD') AS opening_date,
            COALESCE((SELECT SUM(x.amount) FROM bill_receipts x WHERE x.account_id=a.id AND x.status='Active'
                        AND (a.opening_date IS NULL OR x.receipt_date >= a.opening_date) AND ($2::date IS NULL OR x.receipt_date <= $2::date)),0) AS inflow,
            COALESCE((SELECT SUM(COALESCE(p.paid_amount, p.amount)) FROM bill_payment_requests p WHERE p.account_id=a.id AND p.status='Paid'
                        AND (a.opening_date IS NULL OR p.paid_on >= a.opening_date) AND ($2::date IS NULL OR p.paid_on <= $2::date)),0) AS outflow
       FROM bill_accounts a WHERE a.id=$1`, [accountId, asOn]);
  const row = r.rows[0];
  if (!row) return null;
  const opening = money(row.opening_balance), inflow = money(row.inflow), outflow = money(row.outflow);
  return { opening, opening_date: row.opening_date, inflow, outflow, balance: money(opening + inflow - outflow) };
}

module.exports = {
  accountBalance,
  PAY_STATE_SQL, payState, ALLOC_SUM, WORK_FROM, workWhere,
  FEATURE_KEY, clean, money, actorId, actorName, roleOf, esc, financialYear, featureOn, billSettings, accessOf,
  billingAuth, requireManager, requireApprover, logTimeline, advanceAvailable,
};
