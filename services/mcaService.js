const XLSX = require('xlsx');
const { Document, Packer, Paragraph, TextRun, AlignmentType } = require('docx');
const db = require('../db');
const { DOCS, buildLines } = require('../utils/mcaGenerators');

function actorId(actor = {}) {
  return actor.emp_id || actor.username || actor.id || 'SYSTEM';
}

function actorName(actor = {}) {
  return actor.formal_name || actor.name || actor.emp_name || 'System';
}

function clean(value) {
  return String(value || '').trim();
}

function isoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeBool(value) {
  return value === true || value === 'true' || value === 'yes' || value === 'Yes';
}

function normalizeFY(value) {
  const fy = clean(value);
  return /^\d{4}-\d{2}$/.test(fy) ? fy : '';
}

function fyDates(financialYear) {
  const fy = normalizeFY(financialYear);
  if (!fy) return {};
  const startYear = parseInt(fy.slice(0, 4), 10);
  const endYear = startYear + 1;
  return {
    financialYear: fy,
    financialYearFrom: `${startYear}-04-01`,
    financialYearTo: `${endYear}-03-31`,
  };
}

async function listFormats() {
  await ensureFormatVersions();
  const r = await db.rawPool.query(
    `SELECT financial_year, source_financial_year, is_available, title,
            applicability_note, release_note, replacements,
            to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
       FROM mca_format_versions
      ORDER BY financial_year DESC`
  );
  return r.rows;
}

async function getFormat(financialYear) {
  await ensureFormatVersions();
  const fy = normalizeFY(financialYear) || '2024-25';
  const r = await db.rawPool.query(`SELECT * FROM mca_format_versions WHERE financial_year=$1`, [fy]);
  if (r.rows.length) return r.rows[0];
  return {
    financial_year: fy,
    source_financial_year: '2024-25',
    is_available: false,
    title: 'Annual Filing Report Preparation',
    applicability_note: 'Only for Small Private Limited Company. Not for Public Company and not for Section 8 Company.',
    release_note: `Format for FY ${fy} has not been released yet.`,
    replacements: [],
  };
}

async function requireAvailableFormat(financialYear) {
  const format = await getFormat(financialYear);
  if (!format.is_available) {
    const err = new Error(format.release_note || `Format for FY ${format.financial_year} has not been released yet.`);
    err.statusCode = 400;
    err.format = format;
    throw err;
  }
  return format;
}

async function ensureFormatVersions() {
  await db.rawPool.query(`CREATE TABLE IF NOT EXISTS mca_format_versions (
    financial_year VARCHAR(20) PRIMARY KEY,
    source_financial_year VARCHAR(20),
    is_available BOOLEAN NOT NULL DEFAULT FALSE,
    title VARCHAR(255) DEFAULT 'Annual Filing Report Preparation',
    applicability_note TEXT DEFAULT 'Only for Small Private Limited Company. Not for Public Company and not for Section 8 Company.',
    release_note TEXT DEFAULT '',
    replacements JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_by INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.rawPool.query(
    `INSERT INTO mca_format_versions
       (financial_year, source_financial_year, is_available, release_note)
     VALUES
       ('2023-24','2023-24',true,'Format available for Small Private Limited Company annual filing reports.'),
       ('2024-25','2024-25',true,'Format available for Small Private Limited Company annual filing reports.'),
       ('2025-26','2024-25',false,'Format for FY 2025-26 has not been released yet.')
     ON CONFLICT (financial_year) DO NOTHING`
  );
}

async function listCompanies(query = {}) {
  const params = [];
  const conds = [`c.organization_id::text = current_setting('app.organization_id', true)`];
  if (query.status) {
    params.push(query.status);
    conds.push(`COALESCE(c.company_status,'Active')=$${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    const n = params.length;
    conds.push(`(c.company_name ILIKE $${n} OR c.cin ILIKE $${n} OR c.client_id ILIKE $${n} OR c.agent_name ILIKE $${n})`);
  }
  const rows = await db.query(
    `SELECT c.cin, c.company_name, c.client_id, c.agent_name,
            COALESCE(c.company_status,'Active') AS company_status,
            c.incorporation_date, c.email, c.registered_office, c.paid_up_capital,
            COUNT(DISTINCT d.id)::int AS director_count,
            COUNT(DISTINCT sh.id)::int AS shareholder_count
       FROM companies c
       LEFT JOIN director_details d ON UPPER(d.cin)=UPPER(c.cin)
       LEFT JOIN shareholders sh ON UPPER(sh.cin)=UPPER(c.cin)
      WHERE ${conds.join(' AND ')}
      GROUP BY c.cin, c.company_name, c.client_id, c.agent_name, c.company_status,
               c.incorporation_date, c.email, c.registered_office, c.paid_up_capital
      ORDER BY c.company_name
      LIMIT 500`,
    params
  );
  return rows.rows;
}

async function getCompanyRaw(cin) {
  const [company, master, settings, directors, shareholders, meetings, auditors] = await Promise.all([
    db.query(`SELECT * FROM companies WHERE UPPER(cin)=UPPER($1) LIMIT 1`, [cin]),
    db.query(`SELECT * FROM master_data WHERE UPPER(cin)=UPPER($1) ORDER BY id DESC LIMIT 1`, [cin]).catch(() => ({ rows: [] })),
    db.query(`SELECT * FROM mca_report_settings WHERE UPPER(cin)=UPPER($1) LIMIT 1`, [cin]).catch(() => ({ rows: [] })),
    db.query(`SELECT * FROM director_details WHERE UPPER(cin)=UPPER($1) ORDER BY COALESCE(sr_no,9999), director_name`, [cin]),
    db.query(`SELECT * FROM shareholders WHERE UPPER(cin)=UPPER($1) ORDER BY COALESCE(sr_no,9999), holder_name`, [cin]).catch(() => ({ rows: [] })),
    db.query(`SELECT * FROM board_meetings WHERE UPPER(cin)=UPPER($1) ORDER BY date ASC`, [cin]).catch(() => ({ rows: [] })),
    db.query(`SELECT * FROM mca_company_auditors WHERE UPPER(cin)=UPPER($1) ORDER BY is_current DESC, id`, [cin]).catch(() => ({ rows: [] })),
  ]);
  if (!company.rows.length && !master.rows.length) {
    const err = new Error('Company not found');
    err.statusCode = 404;
    throw err;
  }
  return {
    company: company.rows[0] || {},
    master: master.rows[0] || {},
    settings: settings.rows[0] || {},
    directors: directors.rows,
    shareholders: shareholders.rows,
    boardMeetings: meetings.rows,
    auditors: auditors.rows,
  };
}

function mapCompany(data, financialYear) {
  const c = data.company || {};
  const m = data.master || {};
  const s = data.settings || {};
  const cin = c.cin || m.cin;
  const signatory = clean(s.director_signatory);
  const directors = (data.directors || []).map((d, i) => ({
    id: d.id,
    srNo: d.sr_no || i + 1,
    dinOrPan: d.din || '',
    name: d.director_name || '',
    designation: d.designation || '',
    appointmentDate: d.appointment_date || null,
    cessationDate: d.resignation_date || null,
    isSignatory: signatory ? clean(d.director_name).toLowerCase() === signatory.toLowerCase() : i < 2,
    nationality: d.nationality || 'Indian',
    fatherName: d.father_name || '',
    dob: d.dob || null,
    occupation: d.occupation || d.category || '',
    email: d.email_id || '',
    address: d.residential_address || '',
  }));
  const shareholders = (data.shareholders || []).map((sh, i) => ({
    id: sh.id,
    srNo: sh.sr_no || i + 1,
    shareholderType: sh.shareholder_type || '',
    category: sh.shareholder_category || '',
    name: sh.holder_name || sh.holder_details || '',
    securityType: sh.security_type || 'Equity',
    securityClass: sh.security_class || '',
    folioNo: sh.folio_number || '',
    nationality: sh.nationality || 'Indian',
    gender: sh.gender || '',
    shares: Number(sh.securities_held || 0),
    faceValue: Number(sh.nominal_value || 10),
  }));
  const auditors = (data.auditors || []).map((a) => ({
    id: a.id,
    isCurrent: a.is_current,
    firmName: a.firm_name || '',
    firmDesig: a.firm_desig || 'Chartered Accountants',
    firmNo: a.firm_no || '',
    caName: a.ca_name || '',
    caDesig: a.ca_desig || 'Partner',
    memberNo: a.member_no || '',
  }));
  const boardMeetings = (data.boardMeetings || []).map((bm) => ({
    id: bm.id,
    meetingDate: bm.date,
    totalDirs: bm.total_directors || 0,
    attended: bm.attended || 0,
  }));
  return {
    cin,
    companyName: c.company_name || m.company_name || '',
    rocName: m.roc_name || '',
    regNumber: m.registration_number || '',
    doi: c.incorporation_date || m.date_of_incorporation || null,
    email: c.email || m.email_id || '',
    registeredAddr: c.registered_office || m.registered_address || '',
    booksAddr: s.books_address || m.books_address || c.registered_office || m.registered_address || '',
    listedInSE: normalizeBool(m.listed_in_stock_exchange),
    category: c.category || m.category || '',
    subCategory: m.subcategory || c.company_type || '',
    financialYearFrom: fyDates(financialYear).financialYearFrom || s.financial_year_from || null,
    financialYearTo: fyDates(financialYear).financialYearTo || s.financial_year_to || c.last_balance_sheet_date || m.date_of_balance_sheet || null,
    selectedFinancialYear: normalizeFY(financialYear) || '',
    boardMeetingDate: s.board_meeting_date || c.last_agm_date || m.date_of_last_agm || null,
    boardMeetingPlace: s.board_meeting_place || c.city || '',
    website: s.website || '',
    amountUnit: s.amount_unit || 'Thousand',
    msmeProvision: !!s.msme_provision,
    udin: s.udin || '',
    directorSignatory: s.director_signatory || '',
    authorizedCapital: c.authorized_capital || m.authorised_capital || '',
    paidUpCapital: c.paid_up_capital || m.paid_up_capital || '',
    companyStatus: c.company_status || m.company_status || 'Active',
    directors,
    shareholders,
    auditors,
    boardMeetings,
  };
}

async function getCompany(cin, financialYear) {
  return mapCompany(await getCompanyRaw(cin), financialYear);
}

async function saveSettings(cin, body, actor) {
  const company = await db.query(`SELECT cin FROM companies WHERE UPPER(cin)=UPPER($1) LIMIT 1`, [cin]);
  if (!company.rows.length) {
    const err = new Error('Company not found');
    err.statusCode = 404;
    throw err;
  }
  const values = [
    cin.toUpperCase(),
    isoDate(body.financial_year_from),
    isoDate(body.financial_year_to),
    isoDate(body.board_meeting_date),
    clean(body.board_meeting_place),
    clean(body.website),
    clean(body.amount_unit || 'Thousand'),
    !!body.msme_provision,
    clean(body.udin),
    clean(body.director_signatory),
    clean(body.books_address),
    actorId(actor),
    actorName(actor),
  ];
  const update = await db.query(
    `UPDATE mca_report_settings SET
       financial_year_from=$2,
       financial_year_to=$3,
       board_meeting_date=$4,
       board_meeting_place=$5,
       website=$6,
       amount_unit=$7,
       msme_provision=$8,
       udin=$9,
       director_signatory=$10,
       books_address=$11,
       updated_by_id=$12,
       updated_by_name=$13,
       updated_at=NOW()
     WHERE UPPER(cin)=UPPER($1)
     RETURNING *`,
    values
  );
  if (update.rows.length) return update.rows[0];

  const insert = await db.query(
    `INSERT INTO mca_report_settings
       (cin, financial_year_from, financial_year_to, board_meeting_date, board_meeting_place,
        website, amount_unit, msme_provision, udin, director_signatory, books_address,
        created_by_id, created_by_name, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12,$13)
     RETURNING *`,
    values
  );
  return insert.rows[0];
}

async function getAuditors(cin) {
  const r = await db.query(`SELECT * FROM mca_company_auditors WHERE UPPER(cin)=UPPER($1) ORDER BY is_current DESC, id`, [cin]);
  return r.rows;
}

async function saveAuditors(cin, body, actor) {
  const conn = await db.pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`DELETE FROM mca_company_auditors WHERE UPPER(cin)=UPPER($1)`, [cin]);
    const rows = [];
    for (const [isCurrent, item] of [[true, body.current], [false, body.previous]]) {
      if (!item) continue;
      const hasData = ['firm_name', 'firmName', 'ca_name', 'caName', 'firm_no', 'firmNo', 'member_no', 'memberNo'].some((k) => clean(item[k]));
      if (!hasData) continue;
      const r = await conn.query(
        `INSERT INTO mca_company_auditors
          (cin,is_current,firm_name,firm_desig,firm_no,ca_name,ca_desig,member_no,
           created_by_id,created_by_name,updated_by_id,updated_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10) RETURNING *`,
        [
          cin.toUpperCase(), isCurrent,
          clean(item.firm_name || item.firmName),
          clean(item.firm_desig || item.firmDesig || 'Chartered Accountants'),
          clean(item.firm_no || item.firmNo),
          clean(item.ca_name || item.caName),
          clean(item.ca_desig || item.caDesig || 'Partner'),
          clean(item.member_no || item.memberNo),
          actorId(actor), actorName(actor),
        ]
      );
      rows.push(r.rows[0]);
    }
    await conn.query('COMMIT');
    return rows;
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

async function listFirmAuditors() {
  const r = await db.query(`SELECT * FROM mca_firm_auditors ORDER BY firm_name, id`);
  return r.rows;
}

async function createFirmAuditor(body, actor) {
  if (!clean(body.firm_name || body.firmName)) {
    const err = new Error('Firm name required');
    err.statusCode = 400;
    throw err;
  }
  const r = await db.query(
    `INSERT INTO mca_firm_auditors
      (nickname, firm_name, firm_desig, firm_no, ca_name, ca_desig, member_no,
       created_by_id, created_by_name, updated_by_id, updated_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9) RETURNING *`,
    [
      clean(body.nickname),
      clean(body.firm_name || body.firmName),
      clean(body.firm_desig || body.firmDesig || 'Chartered Accountants'),
      clean(body.firm_no || body.firmNo),
      clean(body.ca_name || body.caName),
      clean(body.ca_desig || body.caDesig || 'Partner'),
      clean(body.member_no || body.memberNo),
      actorId(actor),
      actorName(actor),
    ]
  );
  return r.rows[0];
}

async function updateFirmAuditor(id, body, actor) {
  const r = await db.query(
    `UPDATE mca_firm_auditors SET
       nickname=$1, firm_name=$2, firm_desig=$3, firm_no=$4, ca_name=$5, ca_desig=$6, member_no=$7,
       updated_by_id=$8, updated_by_name=$9, updated_at=NOW()
     WHERE id=$10 RETURNING *`,
    [
      clean(body.nickname),
      clean(body.firm_name || body.firmName),
      clean(body.firm_desig || body.firmDesig || 'Chartered Accountants'),
      clean(body.firm_no || body.firmNo),
      clean(body.ca_name || body.caName),
      clean(body.ca_desig || body.caDesig || 'Partner'),
      clean(body.member_no || body.memberNo),
      actorId(actor),
      actorName(actor),
      id,
    ]
  );
  if (!r.rows.length) {
    const err = new Error('Auditor not found');
    err.statusCode = 404;
    throw err;
  }
  return r.rows[0];
}

async function deleteFirmAuditor(id) {
  const r = await db.query(`DELETE FROM mca_firm_auditors WHERE id=$1`, [id]);
  return r.rowCount > 0;
}

function linesToHtml(lines) {
  const segments = [];
  let tableRows = [];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  function flushTable() {
    if (!tableRows.length) return;
    const [head, ...body] = tableRows;
    segments.push(`<table><thead><tr>${head.map((h) => `<th>${esc(h.trim())}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((c) => `<td>${esc(c.trim())}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    tableRows = [];
  }
  lines.forEach((line, i) => {
    if (line.includes(' | ')) {
      tableRows.push(line.split(' | '));
      return;
    }
    flushTable();
    if (i === 0) segments.push(`<h1>${esc(line)}</h1>`);
    else if (!line) segments.push('<p>&nbsp;</p>');
    else if (/^\d+\.\s/.test(line) || /^[A-Z][A-Z\s&'.-]{4,}$/.test(line)) segments.push(`<h2>${esc(line)}</h2>`);
    else segments.push(`<p>${esc(line)}</p>`);
  });
  flushTable();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:"Times New Roman",serif;font-size:12px;line-height:1.55;color:#000;padding:40px 60px}
    h1{text-align:center;font-size:17px;margin:0 0 18px}h2{font-size:13px;margin:10px 0 4px}
    p{margin:4px 0;text-align:justify}table{border-collapse:collapse;width:100%;margin:8px 0;font-size:11px}
    th,td{border:1px solid #000;padding:4px 7px;vertical-align:top}th{background:#f0f0f0}
    @page{margin:20mm 25mm}@media print{body{padding:0}}
  </style></head><body>${segments.join('\n')}</body></html>`;
}

async function generateHtml(cin, docType, financialYear) {
  const format = await requireAvailableFormat(financialYear);
  const company = await getCompany(cin, format.financial_year);
  const lines = buildLines(docType, company, { replacements: format.replacements });
  return { html: linesToHtml(lines), company, doc: DOCS[docType], format };
}

async function generateDocx(cin, docType, financialYear) {
  const format = await requireAvailableFormat(financialYear);
  const company = await getCompany(cin, format.financial_year);
  const lines = buildLines(docType, company, { replacements: format.replacements });
  const paragraphs = lines.map((line, i) => new Paragraph({
    children: [new TextRun({ text: line, bold: i === 0, size: i === 0 ? 28 : 22, font: 'Times New Roman' })],
    alignment: i === 0 ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { after: line ? 80 : 200 },
  }));
  const doc = new Document({ sections: [{ properties: { page: { margin: { top: 720, bottom: 720, left: 1080, right: 720 } } }, children: paragraphs }] });
  return { buffer: await Packer.toBuffer(doc), company, doc: DOCS[docType], format };
}

async function generateExcel(cin, docType, financialYear) {
  const format = await requireAvailableFormat(financialYear);
  const company = await getCompany(cin, format.financial_year);
  const lines = buildLines(docType, company, { replacements: format.replacements });
  const rows = lines.map((line) => line.includes(' | ') ? line.split(' | ') : [line]);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 90 }, { wch: 35 }, { wch: 35 }, { wch: 25 }, { wch: 25 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Document');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), company, doc: DOCS[docType], format };
}

module.exports = {
  DOCS,
  listFormats,
  getFormat,
  listCompanies,
  getCompany,
  saveSettings,
  getAuditors,
  saveAuditors,
  listFirmAuditors,
  createFirmAuditor,
  updateFirmAuditor,
  deleteFirmAuditor,
  generateHtml,
  generateDocx,
  generateExcel,
};
