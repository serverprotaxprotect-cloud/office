const XLSX = require('xlsx');
const {
  cleanText,
  encryptText,
  decryptText,
  nowIST,
  todayIST,
  toDateString,
} = require('./gstUtils');

const ITR_STATUSES = ['Not Started', 'Pending', 'Pending by Client', 'Filed', 'Not Applicable'];
const ITR_TYPES = ['ITR-1', 'ITR-2', 'ITR-3', 'ITR-4', 'ITR-5', 'ITR-6', 'ITR-7'];

function isIncomeTaxAdmin(user) {
  return Boolean(user && user.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(user.role));
}

function normalizePan(value) {
  return cleanText(value).toUpperCase();
}

function normalizeStatus(value) {
  const raw = cleanText(value).toUpperCase();
  if (!raw) return 'Not Started';
  if (raw === 'F' || raw === 'FILED') return 'Filed';
  if (raw === 'P' || raw === 'PENDING') return 'Pending';
  if (raw === 'P BY C' || raw === 'PENDING BY CLIENT' || raw === 'P BY CLIENT') return 'Pending by Client';
  if (raw === 'N/A' || raw === 'NA' || raw === 'NOT APPLICABLE') return 'Not Applicable';
  return cleanText(value);
}

function currentAssessmentYear(date = nowIST()) {
  const year = date.getUTCFullYear();
  return `${year}-${String(year + 1).slice(-2)}`;
}

function assessmentYearToNumber(assessmentYear) {
  const match = cleanText(assessmentYear).match(/^(\d{4})(?:-\d{2})?$/);
  return match ? Number(match[1]) : null;
}

function financialYearForAssessmentYear(assessmentYear) {
  const ay = assessmentYearToNumber(assessmentYear);
  if (!ay) return '';
  return `${ay - 1}-${String(ay).slice(-2)}`;
}

function dueDateForAssessmentYear(assessmentYear) {
  const ay = assessmentYearToNumber(assessmentYear);
  if (!ay) return '';
  return toDateString(ay, 7, 31);
}

function cellValue(sheet, row, col) {
  const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
  return cell ? cell.v : '';
}

function normalizeHeader(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, '_');
}

function parseIncomeTaxWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
  return {
    sheetName,
    rows: rows.map((raw, idx) => {
      const row = { source_sheet: sheetName, source_row: idx + 2, __row_number: idx + 2 };
      Object.entries(raw).forEach(([key, value]) => {
        row[normalizeHeader(key)] = cleanText(value);
      });
      row.taxpayer_name = cleanText(row.taxpayer_name || row.name_of_taxpayer || row.name || '');
      row.contact_number = cleanText(row.contact_number || row.contect_number || row.mobile_number || row.mobile_no || '');
      row.reference_client_name = cleanText(row.reference_client_name || row.refrance_client_name || row.reference_name || '');
      row.default_assignee_id = cleanText(row.default_assignee_id || row.assignee_id || row.name_of_assignee || '');
      row.pan_number = normalizePan(row.pan_number || row.pan || '');
      row.filing_status = normalizeStatus(row.filing_status || row.status || '');
      return row;
    }).filter(row => row.client_id || row.taxpayer_name || row.pan_number),
  };
}

function summarizeIncomeTaxRows(rows) {
  const clientIds = new Set();
  const pans = new Set();
  const assignees = new Set();
  const status_counts = {};
  rows.forEach(row => {
    if (row.client_id) clientIds.add(row.client_id);
    if (row.pan_number) pans.add(row.pan_number);
    if (row.default_assignee_id) assignees.add(row.default_assignee_id);
    if (row.filing_status) status_counts[row.filing_status] = (status_counts[row.filing_status] || 0) + 1;
  });
  return {
    row_count: rows.length,
    unique_client_ids: clientIds.size,
    unique_pan_numbers: pans.size,
    assignees: [...assignees],
    status_counts,
  };
}

module.exports = {
  ITR_STATUSES,
  ITR_TYPES,
  cleanText,
  encryptText,
  decryptText,
  nowIST,
  todayIST,
  isIncomeTaxAdmin,
  normalizePan,
  normalizeStatus,
  currentAssessmentYear,
  assessmentYearToNumber,
  financialYearForAssessmentYear,
  dueDateForAssessmentYear,
  parseIncomeTaxWorkbook,
  summarizeIncomeTaxRows,
};
