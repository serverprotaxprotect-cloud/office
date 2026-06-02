const crypto = require('crypto');
const XLSX = require('xlsx');

const RETURN_TYPES = ['GSTR-1', 'GSTR-3B'];
const GST_STATUSES = ['Not Started', 'Pending', 'Pending by Client', 'Filed', 'Not Applicable'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LOOKUP = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeGstNo(value) {
  return cleanText(value).toUpperCase();
}

function normalizeStatus(value) {
  const raw = cleanText(value).toUpperCase();
  if (!raw) return 'Not Started';
  if (raw === 'F' || raw === 'FILED') return 'Filed';
  if (raw === 'P' || raw === 'PENDING') return 'Pending';
  if (raw === 'P BY C' || raw === 'P BY CLIENT' || raw === 'PENDING BY CLIENT') return 'Pending by Client';
  if (raw === 'N/A' || raw === 'NA' || raw === 'NOT APPLICABLE') return 'Not Applicable';
  return cleanText(value);
}

function isValidGstStatus(status) {
  return GST_STATUSES.includes(status);
}

function isGstAdmin(user) {
  return Boolean(user && user.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(user.role));
}

function nowIST() {
  return new Date(Date.now() + (5.5 * 60 * 60 * 1000));
}

function todayIST() {
  return nowIST().toISOString().slice(0, 10);
}

function toDateString(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function periodEndDate(year, month) {
  return toDateString(year, month, daysInMonth(year, month));
}

function nextMonth(year, month) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function periodLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function financialYearForPeriod(year, month) {
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

function getDueDate({ taxYear, taxMonth, returnType, frequency = 'Monthly', qrmpGstr3bDueDay = 22 }) {
  const dueMonth = nextMonth(taxYear, taxMonth);
  if (frequency === 'QRMP') {
    if (returnType === 'GSTR-1') return toDateString(dueMonth.year, dueMonth.month, 13);
    return toDateString(dueMonth.year, dueMonth.month, Number(qrmpGstr3bDueDay) === 24 ? 24 : 22);
  }
  if (returnType === 'GSTR-1') return toDateString(dueMonth.year, dueMonth.month, 11);
  return toDateString(dueMonth.year, dueMonth.month, 20);
}

function isQuarterEndingMonth(month) {
  return [3, 6, 9, 12].includes(Number(month));
}

function isLastDayIST(date = nowIST()) {
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return day === daysInMonth(year, month);
}

function currentISTPeriod(date = nowIST()) {
  return { taxYear: date.getUTCFullYear(), taxMonth: date.getUTCMonth() + 1 };
}

function secretKey() {
  const secret = process.env.GST_CREDENTIAL_SECRET || process.env.JWT_SECRET || 'PTP_Attendance_Secret_Key_2024_XYZ';
  return crypto.createHash('sha256').update(secret).digest();
}

function secretKeyCandidates() {
  const secrets = [
    process.env.GST_CREDENTIAL_SECRET,
    process.env.JWT_SECRET,
    'PTP_Attendance_Secret_Key_2024_XYZ',
    'gst-dev-secret',
  ].filter(Boolean);
  return [...new Set(secrets)].map(secret => crypto.createHash('sha256').update(secret).digest());
}

function encryptText(value) {
  const text = cleanText(value);
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

function decryptText(value) {
  const text = cleanText(value);
  if (!text) return '';
  if (!text.startsWith('v1:')) return text;
  const [, iv64, tag64, enc64] = text.split(':');
  for (const key of secretKeyCandidates()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv64, 'base64'));
      decipher.setAuthTag(Buffer.from(tag64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(enc64, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      // Try the next configured/legacy key.
    }
  }
  return '';
}

function cellValue(sheet, row, col) {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
  return cell ? cell.v : '';
}

function parsePeriodHeader(value) {
  const raw = cleanText(value);
  const match = raw.match(/^([A-Za-z]+)\s+(R1|3B)\s*-\s*(\d{4})$/i);
  if (!match) return null;
  const month = MONTH_LOOKUP[match[1].toLowerCase()];
  if (!month) return null;
  return {
    tax_month: month,
    tax_year: Number(match[3]),
    return_type: match[2].toUpperCase() === 'R1' ? 'GSTR-1' : 'GSTR-3B',
    source_label: raw,
  };
}

function parseGSTWorkbook(input, opts = {}) {
  const workbook = Buffer.isBuffer(input)
    ? XLSX.read(input, { type: 'buffer' })
    : XLSX.readFile(input);
  const sheetName = opts.sheetName || 'GST_2025-26';
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet ${sheetName} not found`);

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const headerRow = 5;
  const dataStartRow = 6;
  const periods = [];
  for (let c = 7; c <= range.e.c; c += 1) {
    const parsed = parsePeriodHeader(cellValue(sheet, headerRow, c));
    if (parsed) periods.push({ ...parsed, col: c });
  }

  const rows = [];
  for (let r = dataStartRow; r <= range.e.r; r += 1) {
    const clientId = cleanText(cellValue(sheet, r, 0));
    const firmName = cleanText(cellValue(sheet, r, 1));
    if (!clientId && !firmName) continue;

    const assignedToId = cleanText(cellValue(sheet, r, 2));
    const gstNo = normalizeGstNo(cellValue(sheet, r, 3));
    const loginId = cleanText(cellValue(sheet, r, 4));
    const password = cleanText(cellValue(sheet, r, 5));
    const filings = periods.map(p => ({
      tax_year: p.tax_year,
      tax_month: p.tax_month,
      return_type: p.return_type,
      source_label: p.source_label,
      status: normalizeStatus(cellValue(sheet, r, p.col)),
      source_status: cleanText(cellValue(sheet, r, p.col)),
    }));

    rows.push({
      source_sheet: sheetName,
      source_row: r + 1,
      client_id: clientId,
      firm_name: firmName,
      assigned_to_id: assignedToId,
      gst_no: gstNo,
      gst_login_id: loginId,
      gst_password: password,
      filings,
    });
  }

  return {
    sheetName,
    rows,
    periods,
    summary: summarizeGSTRows(rows),
  };
}

function summarizeGSTRows(rows) {
  const clientIds = new Set();
  const gstNos = new Set();
  const assignees = new Set();
  const status_counts = {};
  let blank_gst = 0;
  let blank_login = 0;
  let blank_password = 0;
  let filing_count = 0;

  rows.forEach(row => {
    if (row.client_id) clientIds.add(row.client_id);
    if (row.assigned_to_id) assignees.add(row.assigned_to_id);
    if (row.gst_no) gstNos.add(row.gst_no);
    else blank_gst += 1;
    if (!row.gst_login_id) blank_login += 1;
    if (!row.gst_password) blank_password += 1;
    row.filings.forEach(f => {
      filing_count += 1;
      status_counts[f.status] = (status_counts[f.status] || 0) + 1;
    });
  });

  return {
    row_count: rows.length,
    unique_client_ids: clientIds.size,
    unique_gst_numbers: gstNos.size,
    assignees: [...assignees],
    blank_gst,
    blank_login,
    blank_password,
    filing_count,
    status_counts,
  };
}

module.exports = {
  RETURN_TYPES,
  GST_STATUSES,
  cleanText,
  normalizeGstNo,
  normalizeStatus,
  isValidGstStatus,
  isGstAdmin,
  nowIST,
  todayIST,
  toDateString,
  daysInMonth,
  periodEndDate,
  nextMonth,
  periodLabel,
  financialYearForPeriod,
  getDueDate,
  isQuarterEndingMonth,
  isLastDayIST,
  currentISTPeriod,
  encryptText,
  decryptText,
  parseGSTWorkbook,
  summarizeGSTRows,
};
