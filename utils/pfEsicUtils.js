const XLSX = require('xlsx');
const {
  cleanText,
  encryptText,
  decryptText,
  nowIST,
  todayIST,
  toDateString,
} = require('./gstUtils');

const PF_ESIC_STATUSES = ['Not Started', 'Pending', 'Pending by Client', 'Filed', 'Paid', 'Not Applicable'];
const PF_ESIC_TYPES = ['PF ECR', 'PF Challan Payment', 'ESIC Contribution', 'ESIC Challan Payment'];

function isPFESICAdmin(user) {
  return Boolean(user && user.user_type === 'admin' && ['Director', 'Office Manager', 'HR'].includes(user.role));
}

function normalizeCode(value) {
  return cleanText(value).toUpperCase();
}

function financialYearForPeriod(taxYear, taxMonth) {
  const y = Number(taxYear);
  const m = Number(taxMonth);
  if (!y || !m) return '';
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String(start + 1).slice(-2)}`;
}

function periodLabel(taxYear, taxMonth) {
  const date = new Date(Date.UTC(Number(taxYear), Number(taxMonth) - 1, 1));
  return date.toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function dueDateForPeriod(taxYear, taxMonth) {
  const y = Number(taxYear);
  const m = Number(taxMonth);
  const nextMonthIndex = m;
  const dueYear = nextMonthIndex >= 12 ? y + 1 : y;
  const dueMonth = (nextMonthIndex % 12) + 1;
  return toDateString(dueYear, dueMonth, 15);
}

function currentPeriod(date = nowIST()) {
  return { taxYear: date.getUTCFullYear(), taxMonth: date.getUTCMonth() + 1 };
}

function normalizeStatus(value) {
  const raw = cleanText(value).toUpperCase();
  if (!raw) return 'Not Started';
  if (raw === 'F' || raw === 'FILED') return 'Filed';
  if (raw === 'PAID' || raw === 'P') return raw === 'P' ? 'Pending' : 'Paid';
  if (raw === 'PENDING') return 'Pending';
  if (raw === 'PENDING BY CLIENT' || raw === 'P BY CLIENT') return 'Pending by Client';
  if (raw === 'N/A' || raw === 'NA' || raw === 'NOT APPLICABLE') return 'Not Applicable';
  return cleanText(value);
}

function normalizeHeader(value) {
  return cleanText(value).toLowerCase().replace(/\s+/g, '_');
}

function parsePFESICWorkbook(buffer) {
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
      row.client_id = cleanText(row.client_id || row.client || '');
      row.firm_name = cleanText(row.firm_name || row.company_name || row.name || '');
      row.pf_establishment_code = normalizeCode(row.pf_establishment_code || row.pf_code || row.establishment_code || '');
      row.pf_login_id = cleanText(row.pf_login_id || row.pf_user_id || row.pf_username || '');
      row.pf_password = cleanText(row.pf_password || '');
      row.esic_code = normalizeCode(row.esic_code || row.esic_no || row.esic_number || '');
      row.esic_login_id = cleanText(row.esic_login_id || row.esic_user_id || row.esic_username || '');
      row.esic_password = cleanText(row.esic_password || '');
      row.default_assignee_id = cleanText(row.default_assignee_id || row.assignee_id || row.assigned_to || '');
      row.filing_status = normalizeStatus(row.filing_status || row.status || '');
      return row;
    }).filter(row => row.client_id || row.firm_name || row.pf_establishment_code || row.esic_code),
  };
}

module.exports = {
  PF_ESIC_STATUSES,
  PF_ESIC_TYPES,
  cleanText,
  encryptText,
  decryptText,
  nowIST,
  todayIST,
  isPFESICAdmin,
  normalizeCode,
  normalizeStatus,
  financialYearForPeriod,
  periodLabel,
  dueDateForPeriod,
  currentPeriod,
  parsePFESICWorkbook,
};
