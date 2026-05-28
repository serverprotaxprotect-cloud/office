function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

function fyEndYear(c) {
  return c.financialYearTo ? new Date(c.financialYearTo).getFullYear() : 2025;
}

function fyStr(c) {
  const from = c.financialYearFrom ? new Date(c.financialYearFrom).getFullYear() : fyEndYear(c) - 1;
  const to = c.financialYearTo ? new Date(c.financialYearTo).getFullYear() : from + 1;
  return `${from}-${String(to).slice(-2)}`;
}

function signatories(c) {
  const selected = (c.directors || []).filter((d) => d.isSignatory);
  return selected.length ? selected : (c.directors || []).slice(0, 2);
}

function boardBlock(c) {
  const out = ['For and on the behalf of the Board', ` FOR:- ${c.companyName || ''}`];
  signatories(c).forEach((d) => {
    out.push(`Date: ${fmtDate(c.boardMeetingDate)}    ${d.name || ''}`);
    out.push(`Place: ${c.boardMeetingPlace || ''}    ${d.designation || ''}`);
  });
  return out;
}

function auditorBlock(c) {
  const a = (c.auditors || []).find((x) => x.isCurrent) || {};
  return [
    `For ${a.firmName || ''}`,
    `${a.firmDesig || 'Chartered Accountants'}`,
    `Firm No.: ${a.firmNo || ''}`,
    `${a.caName || ''}`,
    `(${a.caDesig || 'Partner'})`,
    `M. No.: ${a.memberNo || ''}`,
    `Date: ${fmtDate(c.boardMeetingDate)}`,
    `Place: ${c.boardMeetingPlace || ''}`,
    `UDIN: ${c.udin || ''}`,
  ];
}

function companyHeader(c) {
  return [
    `Company Name: ${c.companyName || ''}`,
    `CIN: ${c.cin || ''}`,
    `Registered Address: ${c.registeredAddr || ''}`,
    `Email: ${c.email || ''}`,
    `Financial Year: ${fyStr(c)}`,
    '',
  ];
}

function buildAuditorsReport(c) {
  const year = fyEndYear(c);
  return [
    "Independent Auditor's Report",
    'To the Members of',
    c.companyName || '',
    '',
    'Report on the Financial Statements',
    `We have audited the accompanying standalone financial statements of ${c.companyName || ''} which comprise the Balance Sheet as at March 31, ${year}, the Statement of Profit and Loss for the year then ended, and notes to the financial statements.`,
    `In our opinion and to the best of our information and according to the explanations given to us, the aforesaid financial statements give the information required by the Companies Act, 2013 in the manner so required and give a true and fair view of the state of affairs of the Company as at March 31, ${year}.`,
    '',
    'Basis for Opinion',
    'We conducted our audit in accordance with the Standards on Auditing specified under section 143(10) of the Companies Act, 2013. We are independent of the Company and have fulfilled our ethical responsibilities.',
    '',
    "Management's Responsibility",
    "The Company's Board of Directors is responsible for preparation of these financial statements that give a true and fair view in accordance with accounting principles generally accepted in India.",
    '',
    "Auditor's Responsibility",
    'Our responsibility is to express an opinion on these financial statements based on our audit.',
    '',
    ...auditorBlock(c),
  ];
}

function buildNotesToAccounts(c) {
  const year = fyEndYear(c);
  return [
    'Notes to Accounts',
    ...companyHeader(c),
    `Notes to financial statements for the year ended March 31, ${year}`,
    '',
    'A. Corporate information',
    `${c.companyName || ''} was incorporated in India on ${fmtDate(c.doi)} under the Companies Act, 2013.`,
    '',
    'B. Significant accounting policies',
    'The financial statements have been prepared on accrual basis under the historical cost convention and in accordance with applicable accounting standards.',
    '',
    'C. Share capital',
    `Authorised Share Capital: ${c.authorizedCapital || ''}`,
    `Paid-up Share Capital: ${c.paidUpCapital || ''}`,
    '',
    'D. Other disclosures',
    c.msmeProvision ? 'MSME provision compliance has not been marked as complied.' : 'MSME provision disclosure: Not applicable / complied as per management representation.',
  ];
}

function buildDirectorsReport(c) {
  const year = fyEndYear(c);
  const directors = c.directors || [];
  const boardMeetings = c.boardMeetings || [];
  const lines = [
    "Directors' Report",
    ...companyHeader(c),
    `Your Directors present their report together with the financial statements for the financial year ended March 31, ${year}.`,
    '',
    '1. Financial summary and state of affairs',
    `During the financial year ${fyStr(c)}, the Company continued its business operations. There were no material changes affecting the financial position of the Company after the close of the financial year.`,
    '',
    '2. Dividend',
    'No dividend was declared for the current financial year.',
    '',
    '3. Directors',
    'S. No. | Name of Director | DIN/PAN | Designation | Appointment Date',
  ];
  directors.forEach((d, i) => lines.push(`${i + 1} | ${d.name || ''} | ${d.dinOrPan || ''} | ${d.designation || ''} | ${fmtDate(d.appointmentDate)}`));
  lines.push('', '4. Board meetings', 'S. No. | Date of meeting | Total Directors | Directors Attended');
  boardMeetings.forEach((m, i) => lines.push(`${i + 1} | ${fmtDate(m.meetingDate)} | ${m.totalDirs || 0} | ${m.attended || 0}`));
  lines.push('', '5. Directors Responsibility Statement', 'The Directors state that applicable accounting standards have been followed and adequate accounting records have been maintained.', '', ...boardBlock(c));
  return lines;
}

function buildSheet1Report(c) {
  return buildDirectorsReport(c);
}

function buildAoc1(c) {
  return [
    'Form AOC-1',
    '(Pursuant to Section 129 read with Companies (Accounts) Rules, 2014)',
    ...companyHeader(c),
    'Part A: Subsidiaries',
    'Sl. No. | Particulars | Details',
    '1 | Name of subsidiary | NA',
    '2 | Reporting period | NA',
    '3 | Share capital | NA',
    '4 | Reserves & surplus | NA',
    '5 | Total assets | NA',
    '',
    'Part B: Associates and Joint Ventures',
    'Name of associates / joint ventures | NA',
    '',
    ...boardBlock(c),
  ];
}

function buildAoc2(c) {
  return [
    'FORM NO. AOC-2',
    '(Pursuant to Section 134 and Companies (Accounts) Rules, 2014)',
    ...companyHeader(c),
    '1. Details of contracts or arrangements or transactions not at arm length basis',
    'Name of related party | Nature | Duration | Value',
    'NONE | NONE | NONE | NONE',
    '',
    '2. Details of material contracts or arrangements or transactions at arm length basis',
    'Name of related party | Nature | Duration | Value',
    'NONE | NONE | NONE | NONE',
    '',
    ...boardBlock(c),
  ];
}

function buildMgt7(c) {
  const dirs = signatories(c);
  return [
    'MGT-7 Resolution',
    ...companyHeader(c),
    `EXTRACT OF RESOLUTION PASSED IN THE BOARD MEETING OF ${c.companyName || ''} HELD ON ${fmtDate(c.boardMeetingDate)} AT ${c.registeredAddr || ''}`,
    '',
    `RESOLVED THAT ${dirs.map((d) => d.name).filter(Boolean).join(' and ') || 'the Directors'} be and are hereby authorised as designated persons for furnishing information to the Registrar of Companies with respect to beneficial interests in the shares of the Company.`,
    '',
    ...boardBlock(c),
  ];
}

function buildDetailsOfSH(c) {
  const shareholders = c.shareholders || [];
  const totalShares = shareholders.reduce((sum, sh) => sum + Number(sh.shares || 0), 0);
  const paidUp = shareholders.reduce((sum, sh) => sum + (Number(sh.shares || 0) * Number(sh.faceValue || 10)), 0);
  const lines = [
    `DETAILS OF MEMBERS, DEBENTURE HOLDERS AND OTHER SECURITIES HOLDERS (As on 31.03.${fyEndYear(c)})`,
    ...companyHeader(c),
    `AUTHORISED SHARE CAPITAL: ${c.authorizedCapital || ''}`,
    `PAID-UP CAPITAL: ${paidUp.toLocaleString('en-IN')}`,
    '',
    'SL.NO. | L.F.NO. | NAME | TYPE OF SECURITY | NO. OF EQUITY SHARE | FACE VALUE',
  ];
  shareholders.forEach((sh, i) => lines.push(`${sh.srNo || i + 1} | ${sh.folioNo || ''} | ${sh.name || ''} | ${sh.securityType || 'Equity'} | ${Number(sh.shares || 0).toLocaleString('en-IN')} | ${sh.faceValue || 10}`));
  lines.push(`TOTAL | | | | ${totalShares.toLocaleString('en-IN')} | `, '', ...boardBlock(c));
  return lines;
}

function buildDetailsOfDirectors(c) {
  const lines = [
    'DETAILS OF DIRECTORS',
    ...companyHeader(c),
    'SN | DIN | NAME | NATIONALITY | FATHER NAME | DOB | DESIGNATION | CATEGORY',
  ];
  (c.directors || []).forEach((d, i) => lines.push(`${i + 1} | ${d.dinOrPan || ''} | ${d.name || ''} | ${d.nationality || 'Indian'} | ${d.fatherName || ''} | ${fmtDate(d.dob)} | ${d.designation || ''} | ${d.occupation || ''}`));
  lines.push('', ...boardBlock(c));
  return lines;
}

const DOCS = {
  auditors_report: { label: "Auditor's Report", build: buildAuditorsReport },
  notes_to_accounts: { label: 'Notes to Accounts', build: buildNotesToAccounts },
  directors_report: { label: "Directors' Report", build: buildDirectorsReport },
  directors_report_board: { label: "Directors' Report Sheet1", build: buildSheet1Report },
  aoc1: { label: 'Form AOC-1', build: buildAoc1 },
  aoc2: { label: 'Form AOC-2', build: buildAoc2 },
  mgt7: { label: 'MGT-7 Resolution', build: buildMgt7 },
  details_sh: { label: 'Details of Shareholders', build: buildDetailsOfSH },
  details_dir: { label: 'Details of Directors', build: buildDetailsOfDirectors },
};

function buildLines(docType, company) {
  const doc = DOCS[docType];
  if (!doc) {
    const err = new Error('Unknown document type');
    err.statusCode = 400;
    throw err;
  }
  return doc.build(company);
}

module.exports = {
  DOCS,
  buildLines,
  fmtDate,
};
