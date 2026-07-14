// One-time backfill: classify existing tasks into work_category / grouping_name /
// department from the work_names master. Pass order:
//   A. exact name match against master (also links work_name_id)
//   B. period-stripped match — "GSTR-3B March" -> "GSTR-3B" -> master "GSTR-3B Filing"
//   C. keyword rules for free-text names (manually curated, master-consistent values)
//   D. leftovers -> is_custom_work=true, classification left NULL (shows as Unclassified)
// Only rows with department IS NULL are touched, so re-runs and Phase-2 rows are safe.
require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');

const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december',
  'jan','feb','mar','apr','jun','jul','aug','sep','sept','oct','nov','dec'];

function stripPeriod(name) {
  let s = String(name || '').trim();
  let changed = true;
  while (changed) {
    const before = s;
    s = s.replace(/[\s\-–]+(20\d{2}[-\/]\d{2,4})$/i, '');
    s = s.replace(/[\s\-–]+(20\d{2})$/i, '');
    s = s.replace(new RegExp('[\\s\\-–]+(' + MONTHS.join('|') + ')$', 'i'), '');
    s = s.replace(/[\s\-–]+(q[1-4]|qtr\s*[1-4]|quarter\s*[1-4])$/i, '');
    s = s.replace(/[\s\-–]+(ay|fy)$/i, '');
    changed = s !== before;
  }
  return s.trim();
}

// Keyword rules — first match wins. Values follow the work_names master
// (department + grouping always from master; category best-fit or null).
const RULES = [
  { label: 'e-way / e-invoice', re: /\be[\s-]?way\b|\be[\s-]?invoic/i, cat: 'E-Way Bill & E-Invoicing', grp: 'GST Department', dept: 'CA Services' },
  { label: 'gst registration/amendment', re: /gst.*(regist|amend|cancel|address|clarif|bank|director|portal)|(regist|amend|clarif|noc|ctc|authori[sz]ation).*gst/i, cat: 'GST Registration & Amendment', grp: 'GST Department', dept: 'CA Services' },
  { label: 'gst notice/refund', re: /gst.*(notice|reply|refund)|notice.*gst/i, cat: 'GST Refund, Notices & Litigation', grp: 'GST Department', dept: 'CA Services' },
  { label: 'gst returns', re: /gstr|gtr\s*3b|\bgst\b|3b file/i, cat: 'GST Returns & Regular Compliance', grp: 'GST Department', dept: 'CA Services' },
  { label: 'tds/tcs', re: /\btds\b|\btcs\b/i, cat: 'TDS & TCS Compliance', grp: 'Income Tax Department', dept: 'CA Services' },
  { label: 'income tax', re: /\bitr\b|income tax/i, cat: 'Income Tax Returns & Computation', grp: 'Income Tax Department', dept: 'CA Services' },
  { label: 'tax audit', re: /tax audit|\btar\b/i, cat: 'Tax Audit & Income-tax Forms', grp: 'Audit & Assurance Department', dept: 'CA Services' },
  { label: 'pf/esic', re: /\bpf\b|esic|\besi\b|epfo|\becr\b/i, cat: 'Payroll, PF, ESIC & Labour Compliance', grp: 'Payroll & Labour Compliance Department', dept: 'Common Services' },
  { label: 'director kyc', re: /dir[-\s]?3|dir kyc|\bkyc\b/i, cat: 'DIN & Director Particulars', grp: 'Secretarial Compliance Department', dept: 'CS Services' },
  { label: 'director changes', re: /dir[-\s]?12|dir[-\s]?11|director (add|remove|chang|appoint|resign|regular)|(appointment|change|resignation).*director|additional dir/i, cat: 'Director Appointment & Changes', grp: 'Secretarial Compliance Department', dept: 'CS Services' },
  { label: 'auditor events (ADT)', re: /\badt\b[-\s]?\d?|auditor/i, cat: 'Auditor-Related Events', grp: 'ROC Compliance Department', dept: 'CS Services' },
  { label: 'charges (CHG)', re: /chg[-\s]?\d|charge/i, cat: 'Charge Compliance', grp: 'ROC Compliance Department', dept: 'CS Services' },
  { label: 'csr', re: /\bcsr\b/i, cat: 'CSR Event Compliance', grp: 'ROC Compliance Department', dept: 'CS Services' },
  { label: 'annual roc (AOC/MGT/board report)', re: /aoc|mgt|dpt[-\s]?3|annual fill|board report|\bbr\b|\bar[_\s\/]?br\b|\bbf draft\b|attachments|form[-\s]?11|form[-\s]?3\b|\bnts\b|excell? upload/i, cat: 'Annual ROC Compliance', grp: 'ROC Compliance Department', dept: 'CS Services' },
  { label: 'inc-20a / incorporation', re: /inc[-\s]?20|incorporation|incoporation|spice|company name|name (application|apply|reserve|search|availability)|\bllp\b|\btan apply\b|co\.? name/i, cat: 'Incorporation & Initial Compliance', grp: 'Company Incorporation Department', dept: 'CS Services' },
  { label: 'moa/aoa', re: /\bmoa\b|\baoa\b/i, cat: 'MOA & AOA Alteration', grp: 'Secretarial Compliance Department', dept: 'CS Services' },
  { label: 'meetings/minutes/resolutions', re: /minutes|\bagm\b|board meeting|resolution|mbp[-\s]?\d|dir[-\s]?8|mgt[-\s]?14|\bctc\b/i, cat: 'Board & General Meetings', grp: 'Secretarial Compliance Department', dept: 'CS Services' },
  { label: 'registered office change', re: /registered office|reg\.? office|address change/i, cat: 'Registered Office Change', grp: 'ROC Compliance Department', dept: 'CS Services' },
  { label: 'strike off / restructuring', re: /strike off|winding up|closure of company/i, cat: null, grp: 'Corporate Restructuring Department', dept: 'CS Services' },
  { label: 'share/securities', re: /share transfer|right issue|share allot|\bsh[-\s]?\d/i, cat: null, grp: 'Share & Securities Department', dept: 'CS Services' },
  { label: 'company inspection / search report', re: /inspection|search report/i, cat: null, grp: 'Secretarial Compliance Department', dept: 'CS Services' },
  { label: 'trademark/copyright', re: /trademark|copyright|coupyright/i, cat: 'Trademark, Copyright & Intellectual Property', grp: 'Trademark & IP Department', dept: 'Common Services' },
  { label: 'fssai/licences', re: /fssai|drug licence|pollution|licen[cs]e/i, cat: 'FSSAI & Other Licences', grp: 'Licence & Regulatory Department', dept: 'Common Services' },
  { label: 'udyam/msme', re: /udyam|msme|\biec\b/i, cat: 'MSME & Business Registrations', grp: 'Business Registration Department', dept: 'Common Services' },
  { label: 'ngo/trust (12A/80G)', re: /12a|80g|darpan|\bngo\b|trust deed|society|section 8|anudhan/i, cat: 'NGO, Trust, Society & Section 8', grp: 'NGO Compliance Department', dept: 'Common Services' },
  { label: 'iso/certificates', re: /\biso\b|turnover certificate|net ?worth certificate/i, cat: 'Professional Certificates', grp: 'Certification Department', dept: 'Common Services' },
  { label: 'dsc', re: /\bdsc\b|digital signature/i, cat: null, grp: 'Certification Department', dept: 'Common Services' },
  { label: 'audit (general)', re: /audit/i, cat: 'Audit & Assurance', grp: 'Audit & Assurance Department', dept: 'CA Services' },
  { label: 'cma', re: /\bcma\b/i, cat: null, grp: 'Costing Department', dept: 'CMA Services' },
  { label: 'accounting/bookkeeping', re: /bank stat|bank entry|\bentry\b|entries|tally|invoic|invoice|bookkeeping|ledger|debit note|credit note|purchase|\bsale\b|sales|bill (make|collection)|\bbills?\b|balance sheet|balace sheet|financial|fin[-\s]?stmt|p\s*&\s*l|accounts?\b|suspense/i, cat: 'Accounting & Bookkeeping', grp: 'Accounts Department', dept: 'CA Services' },
  { label: 'legal drafting (NOC/agreements)', re: /rent agreement|\bnoc\b|agreement|affidavit|trust deed|project report/i, cat: 'Agreements & Legal Drafting', grp: 'Agreement & Legal Drafting Department', dept: 'Common Services' },
  { label: 'client calls / office admin', re: /calling|call for|follow ?up|client follow|print|scan|courier|udin/i, cat: 'Office Administration & Internal Tasks', grp: 'Office Administration Department', dept: 'Internal Office' },
];

async function buildPlan(conn) {
  const master = await conn.query(`SELECT id, name, work_category, grouping_name, department FROM work_names`);
  const byName = new Map();
  for (const m of master.rows) {
    const k = m.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, m);
  }
  const tasks = await conn.query(
    `SELECT work_name, count(*)::int AS n FROM tasks WHERE department IS NULL GROUP BY work_name`
  );
  const plan = [];
  for (const t of tasks.rows) {
    const raw = String(t.work_name || '');
    const key = raw.toLowerCase().trim();
    let m = byName.get(key);
    let source = 'exact';
    if (!m) {
      const core = stripPeriod(raw).toLowerCase();
      if (core && byName.has(core)) { m = byName.get(core); source = 'stripped'; }
      else if (core && byName.has(core + ' filing')) { m = byName.get(core + ' filing'); source = 'stripped+filing'; }
    }
    if (m) {
      plan.push({ work_name: raw, n: t.n, source, work_name_id: m.id, cat: m.work_category, grp: m.grouping_name, dept: m.department, custom: false });
      continue;
    }
    const rule = RULES.find(r => r.re.test(raw));
    if (rule) {
      plan.push({ work_name: raw, n: t.n, source: `rule: ${rule.label}`, work_name_id: null, cat: rule.cat, grp: rule.grp, dept: rule.dept, custom: false });
    } else {
      plan.push({ work_name: raw, n: t.n, source: 'unmatched', work_name_id: null, cat: null, grp: null, dept: null, custom: true });
    }
  }
  return plan;
}

function summarize(plan) {
  const bySource = {};
  const byDept = {};
  for (const p of plan) {
    const s = p.source.startsWith('rule:') ? p.source : p.source;
    bySource[s] = (bySource[s] || 0) + p.n;
    const d = p.dept || '(unclassified)';
    byDept[d] = (byDept[d] || 0) + p.n;
  }
  return { bySource, byDept };
}

async function run() {
  const apply = process.argv.includes('--apply');
  const conn = await db.rawPool.connect();
  try {
    await conn.query(`SELECT set_config('app.bypass_rls','on', true)`);
    const plan = await buildPlan(conn);
    const { bySource, byDept } = summarize(plan);
    const totalRows = plan.reduce((a, p) => a + p.n, 0);

    console.log(`Distinct names: ${plan.length}, task rows to update: ${totalRows}`);
    console.log('\n=== Rows by match source ===');
    Object.entries(bySource).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${String(v).padStart(6)}  ${k}`));
    console.log('\n=== Rows by resulting department ===');
    Object.entries(byDept).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${String(v).padStart(6)}  ${k}`));

    if (!apply) {
      console.log('\nDry run. Use --apply to write these classifications.');
      console.log('Sample of keyword-rule assignments:');
      plan.filter(p => p.source.startsWith('rule:')).slice(0, 40)
        .forEach(p => console.log(`  [${p.source}] "${p.work_name}" -> ${p.dept} / ${p.grp}`));
      return;
    }

    await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.bypass_rls','on', true)`);
    let updated = 0;
    for (const p of plan) {
      const r = await conn.query(
        `UPDATE tasks
            SET work_name_id=$1, work_category=$2, grouping_name=$3, department=$4, is_custom_work=$5
          WHERE department IS NULL AND work_name IS NOT DISTINCT FROM $6`,
        [p.work_name_id, p.cat, p.grp, p.dept, p.custom, p.work_name]
      );
      updated += r.rowCount;
    }
    await conn.query('COMMIT');
    console.log(`\nBackfill applied. Rows updated: ${updated}`);
  } catch (err) {
    try { await conn.query('ROLLBACK'); } catch {}
    console.error(err);
    process.exitCode = 1;
  } finally {
    conn.release();
    await db.rawPool.end();
  }
}

run();
