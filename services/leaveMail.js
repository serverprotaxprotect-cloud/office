const db = require('../db');
const { sendEmail } = require('../utils/email');

const APP_URL = process.env.APP_URL || 'https://geebharat.com';
const APPROVER_ROLES = ['Owner', 'Director', 'Office Manager', 'HR'];

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function prettyDate(value) {
  const s = String(value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : value).slice(0, 10);
  const d = new Date(`${s}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function layout(title, bodyHtml) {
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1e293b;line-height:1.55;">
    <div style="background:#1e3a8a;color:#fff;padding:14px 20px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px;">${esc(title)}</div>
    <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 10px 10px;padding:20px;font-size:14px;">${bodyHtml}</div>
    <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:12px;">This is an automated message from the Gee Bharat office system.</p>
  </div>`;
}

function detailTable(rows) {
  return `<table style="border-collapse:collapse;width:100%;margin:12px 0;">${rows.map(([k, v]) =>
    `<tr><td style="padding:6px 10px;background:#f8fafc;border:1px solid #e2e8f0;width:36%;font-weight:600;">${esc(k)}</td><td style="padding:6px 10px;border:1px solid #e2e8f0;">${esc(v)}</td></tr>`).join('')}</table>`;
}

async function approverEmails() {
  const r = await db.query(
    `SELECT DISTINCT LOWER(TRIM(email_id)) AS email FROM admins
      WHERE COALESCE(status,'Active')='Active' AND role = ANY($1::varchar[]) AND email_id IS NOT NULL AND TRIM(email_id) <> ''`,
    [APPROVER_ROLES]);
  return r.rows.map(x => x.email);
}

async function employeeEmail(empId) {
  const r = await db.query(`SELECT email_id FROM emplist WHERE emp_id=$1 LIMIT 1`, [empId]);
  const e = String(r.rows[0]?.email_id || '').trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

async function safeSend(to, subject, html, text) {
  try { await sendEmail({ to, subject, html, text }); return true; }
  catch (e) { console.error('[leave mail]', to, e.message); return false; }
}

// Employee submitted a leave request -> owners/directors/manager/HR + a confirmation to the employee.
async function notifyLeaveApplied(leave) {
  const out = { approvers: 0, employee: false };
  try {
    const rows = [
      ['Employee', `${leave.employee_name} (${leave.emp_id})`],
      ['Leave type', leave.leave_type],
      ['From', prettyDate(leave.from_date)],
      ['To', prettyDate(leave.to_date)],
      ['Days applied', String(leave.days)],
      ['Reason', leave.reason],
    ];
    const to = await approverEmails();
    const html = layout('New leave request', `
      <p>Dear Sir / Madam,</p>
      <p><strong>${esc(leave.employee_name)}</strong> has submitted a leave request through the office system. Kindly review it and approve or reject it in the system so that attendance and salary are recorded correctly.</p>
      ${detailTable(rows)}
      <p><a href="${APP_URL}/admin.html" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Review in the system</a></p>`);
    const text = `New leave request from ${leave.employee_name} (${leave.emp_id}): ${leave.leave_type}, ${leave.from_date} to ${leave.to_date}. Reason: ${leave.reason}. Please review it at ${APP_URL}/admin.html`;
    const sent = await Promise.all(to.map(addr => safeSend(addr, `Leave request: ${leave.employee_name} (${prettyDate(leave.from_date)})`, html, text)));
    out.approvers = sent.filter(Boolean).length;

    const empMail = await employeeEmail(leave.emp_id);
    if (empMail) {
      const ehtml = layout('Leave request received', `
        <p>Dear ${esc(leave.employee_name)},</p>
        <p>We have received your leave request and it has been sent to the management for approval. You will receive another email as soon as a decision is made.</p>
        ${detailTable(rows.slice(1, 5))}
        <p>Thank you for applying through the system; this ensures your leave is correctly reflected in your attendance and salary.</p>`);
      out.employee = await safeSend(empMail, 'Your leave request has been received', ehtml,
        `Dear ${leave.employee_name}, your leave request (${leave.from_date} to ${leave.to_date}) has been received and sent for approval.`);
    }
  } catch (e) { console.error('[leave mail] applied:', e.message); }
  return out;
}

// Leave was approved / rejected -> employee email (+ in-app notification).
async function notifyLeaveDecision(leave, action, { payType = 'Paid', remark = '', skippedOffDays = 0 } = {}) {
  const approved = action === 'Approved';
  const result = { email: false, inApp: false };
  try {
    const pay = payType === 'Unpaid' ? 'Unpaid' : 'Paid';
    const rows = [
      ['Leave type', leave.leave_type],
      ['From', prettyDate(leave.from_date)],
      ['To', prettyDate(leave.to_date)],
      ['Decision', approved ? `Approved (${pay} leave)` : 'Not approved'],
    ];
    if (remark) rows.push(['Remark', remark]);
    const note = approved
      ? `<p>Your attendance has been updated accordingly.${skippedOffDays ? ` Weekly offs and holidays within these dates (${skippedOffDays}) are not counted as leave.` : ''}${pay === 'Unpaid' ? ' Please note that unpaid leave is deducted from salary.' : ''}</p>`
      : '<p>As this leave was not approved, the days concerned will be treated as working days. If you have any questions, please speak to HR or your manager.</p>';
    const html = layout(approved ? 'Leave request approved' : 'Leave request not approved', `
      <p>Dear ${esc(leave.employee_name)},</p>
      <p>${approved ? 'We are pleased to inform you that your leave request has been approved.' : 'We regret to inform you that your leave request could not be approved.'}</p>
      ${detailTable(rows)}${note}`);
    const to = await employeeEmail(leave.emp_id);
    if (to) result.email = await safeSend(to, approved ? 'Your leave request has been approved' : 'Update on your leave request', html,
      `Dear ${leave.employee_name}, your leave request (${leave.from_date} to ${leave.to_date}) was ${approved ? 'approved (' + pay + ')' : 'not approved'}.${remark ? ' Remark: ' + remark : ''}`);

    const { createNotif } = require('../routes/notifications');
    await createNotif(leave.emp_id, 'leave_' + action.toLowerCase(),
      approved ? 'Leave request approved' : 'Leave request not approved',
      approved
        ? `Your leave request for ${prettyDate(leave.from_date)} to ${prettyDate(leave.to_date)} has been approved as ${pay} leave and your attendance has been updated.`
        : `Your leave request for ${prettyDate(leave.from_date)} to ${prettyDate(leave.to_date)} could not be approved.${remark ? ' Remark: ' + remark : ''}`,
      null);
    result.inApp = true;
  } catch (e) { console.error('[leave mail] decision:', e.message); }
  return result;
}

module.exports = { notifyLeaveApplied, notifyLeaveDecision, approverEmails, employeeEmail, prettyDate };
