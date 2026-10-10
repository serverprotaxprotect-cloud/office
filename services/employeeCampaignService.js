const crypto = require('crypto');
const db = require('../db');

// Only these emplist columns can ever be written by a campaign. 'custom'
// collects an answer into the campaign itself without touching the profile.
// Never add credentials / salary / identity numbers here.
const FIELDS = [
  { key: 'personal_email', label: 'Personal Email ID', column: 'email_id', input_type: 'email' },
  { key: 'mobile_no', label: 'Mobile Number', column: 'mobile_no', input_type: 'tel' },
  { key: 'present_address', label: 'Present Address', column: 'present_address', input_type: 'textarea' },
  { key: 'permanent_address', label: 'Permanent Address', column: 'permanent_address', input_type: 'textarea' },
  { key: 'blood_group', label: 'Blood Group', column: 'blood_group', input_type: 'text' },
  { key: 'father_name', label: "Father's Name", column: 'father_name', input_type: 'text' },
  { key: 'education', label: 'Education', column: 'education', input_type: 'text' },
  { key: 'marital_status', label: 'Marital Status', column: 'marital_status', input_type: 'text' },
  { key: 'custom', label: 'Custom question', column: null, input_type: 'text' },
];
const FIELD_BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));
const INPUT_TYPES = ['email', 'tel', 'text', 'textarea', 'date'];

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

function istDate() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function isMandatory(campaign, target) {
  if (campaign.mandatory_after_days === null || campaign.mandatory_after_days === undefined) return false;
  const due = new Date(target.created_at).getTime() + Number(campaign.mandatory_after_days) * 86400000;
  return Date.now() >= due;
}

function dueAt(campaign, target) {
  if (campaign.mandatory_after_days === null || campaign.mandatory_after_days === undefined) return null;
  return new Date(new Date(target.created_at).getTime() + Number(campaign.mandatory_after_days) * 86400000);
}

// Pending campaigns for one employee, mandatory ones first. RLS scopes to
// the caller's organisation.
async function pendingForEmployee(empId) {
  const r = await db.query(
    `SELECT c.id, c.title, c.instruction, c.field_key, c.field_label, c.input_type, c.require_otp,
            c.mandatory_after_days, t.created_at AS target_created_at,
            to_char(t.snoozed_on, 'YYYY-MM-DD') AS snoozed_on
       FROM employee_campaign_targets t
       JOIN employee_campaigns c ON c.id = t.campaign_id
      WHERE t.emp_id=$1 AND t.status='Pending' AND c.status='Active'
      ORDER BY c.created_at ASC`,
    [empId]
  );
  const today = istDate();
  const list = r.rows.map(row => {
    const mandatory = isMandatory(row, { created_at: row.target_created_at });
    const due = dueAt(row, { created_at: row.target_created_at });
    const snoozedToday = row.snoozed_on === today;
    return {
      id: row.id,
      title: row.title,
      instruction: row.instruction,
      field_key: row.field_key,
      field_label: row.field_label || FIELD_BY_KEY[row.field_key]?.label || row.title,
      input_type: row.input_type,
      require_otp: row.require_otp,
      mandatory,
      due_at: due,
      snoozed_today: !!snoozedToday && !mandatory,
    };
  });
  list.sort((a, b) => Number(b.mandatory) - Number(a.mandatory));
  return list;
}

async function mandatoryBlock(empId) {
  if (!empId) return null;
  const list = await pendingForEmployee(empId);
  return list.find(c => c.mandatory) || null;
}

function validateValue(campaign, raw, context = {}) {
  let value = String(raw ?? '').trim();
  if (!value) return { ok: false, message: 'Please enter a value.' };
  if (value.length > 500) return { ok: false, message: 'That value is too long.' };

  if (campaign.input_type === 'email') {
    value = value.toLowerCase();
    if (!EMAIL_RE.test(value)) return { ok: false, message: 'Please enter a valid email address.' };
    const blocked = String(campaign.blocked_keywords || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (blocked.some(k => value.includes(k))) {
      return { ok: false, message: 'Please enter your personal email ID, not the company one.' };
    }
    const current = String(context.currentValue || '').trim().toLowerCase();
    if (current && current === value) {
      return { ok: false, message: 'This is the same as your current email on file. Please enter your personal email ID.' };
    }
  } else if (campaign.input_type === 'tel') {
    value = value.replace(/[\s\-()]/g, '').replace(/^\+91/, '').replace(/^0(?=\d{10}$)/, '');
    if (!/^\d{10}$/.test(value)) return { ok: false, message: 'Please enter a valid 10-digit mobile number.' };
  } else if (campaign.input_type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, message: 'Please enter a valid date.' };
  }
  return { ok: true, value };
}

function hashOtp(campaignId, empId, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'otp')
    .update(`${campaignId}:${empId}:${code}`).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Writes the value to the employee profile (when the field maps to a
// column) and marks the target Submitted, atomically. The previous value is
// kept on the target row, and for the personal-email campaign the old
// company email is preserved in emplist.official_email — nothing is lost.
async function applySubmission({ campaign, empId, value, via, verified }) {
  const column = FIELD_BY_KEY[campaign.field_key]?.column || null;
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    const tgt = await conn.query(
      `SELECT id, status FROM employee_campaign_targets WHERE campaign_id=$1 AND emp_id=$2 FOR UPDATE`,
      [campaign.id, empId]
    );
    if (!tgt.rows.length) { await conn.query('ROLLBACK'); return { ok: false, status: 404, message: 'You are not part of this request.' }; }
    if (tgt.rows[0].status === 'Submitted' && via === 'employee') {
      await conn.query('ROLLBACK');
      return { ok: false, status: 400, message: 'Already submitted.' };
    }

    let previous = null;
    if (column) {
      const emp = await conn.query(`SELECT id, ${column} AS cur, official_email FROM emplist WHERE emp_id=$1 FOR UPDATE`, [empId]);
      if (!emp.rows.length) { await conn.query('ROLLBACK'); return { ok: false, status: 404, message: 'Employee record not found.' }; }
      previous = emp.rows[0].cur ?? null;
      if (campaign.field_key === 'personal_email') {
        const keepOfficial = String(emp.rows[0].official_email || '').trim() ? emp.rows[0].official_email : (previous || null);
        await conn.query(`UPDATE emplist SET email_id=$1, official_email=$2 WHERE emp_id=$3`, [value, keepOfficial, empId]);
      } else {
        await conn.query(`UPDATE emplist SET ${column}=$1 WHERE emp_id=$2`, [value, empId]);
      }
    }
    await conn.query(
      `UPDATE employee_campaign_targets
          SET status='Submitted', value=$1, previous_value=$2, verified=$3, submitted_via=$4, submitted_at=NOW()
        WHERE campaign_id=$5 AND emp_id=$6`,
      [value, previous, !!verified, via, campaign.id, empId]
    );
    await conn.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  FIELDS, FIELD_BY_KEY, INPUT_TYPES,
  istDate, isMandatory, pendingForEmployee, mandatoryBlock,
  validateValue, hashOtp, safeEqual, applySubmission,
};
