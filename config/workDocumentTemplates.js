// Master list of works this office handles, plus the document-request
// checklist template for the ~20 highest-volume works. A work without a
// template still appears in the dropdown — the employee just adds documents
// manually below it, same as before this feature existed.
//
// Fixed for all organisations for now (not per-org editable) — extend this
// file directly to add more work templates later; no migration or UI change
// needed to do so.

const ENTITY_TYPES = [
  { value: 'proprietorship', label: 'Proprietorship' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'llp', label: 'LLP' },
  { value: 'company', label: 'Company' },
  { value: 'ngo', label: 'Trust / Society (NGO)' },
];

const WORK_CATEGORIES = [
  'Business Registration & Incorporation',
  'Licenses & Registrations',
  'Intellectual Property',
  'GST',
  'Income Tax',
  'Company / LLP Compliance',
  'Audit & Accounting',
  'Other Registrations',
];

const WORK_LIST = [
  ['Proprietorship', WORK_CATEGORIES[0]],
  ['Partnership Creation', WORK_CATEGORIES[0]],
  ['One Person Company Incorporation', WORK_CATEGORIES[0]],
  ['Limited Liability Partnership Incorporation', WORK_CATEGORIES[0]],
  ['Private Limited Company Incorporation', WORK_CATEGORIES[0]],
  ['Startup India Registration', WORK_CATEGORIES[0]],
  ['Nidhi Company Incorporation', WORK_CATEGORIES[0]],
  ['Section 8 Company Incorporation', WORK_CATEGORIES[0]],
  ['Farmer Producer Company Registration', WORK_CATEGORIES[0]],
  ['Company Compliance', WORK_CATEGORIES[1]],
  ['Digital Signature', WORK_CATEGORIES[1]],
  ['Udyam Registration (MSME)', WORK_CATEGORIES[1]],
  ['Shop and Establishment (Form-3)', WORK_CATEGORIES[1]],
  ['Trade License', WORK_CATEGORIES[1]],
  ['Import Export Code', WORK_CATEGORIES[1]],
  ['FSSAI Registration', WORK_CATEGORIES[1]],
  ['Professional Tax Registration', WORK_CATEGORIES[1]],
  ['Professional Tax Enrollment', WORK_CATEGORIES[1]],
  ['Check Company or LLP Name Availability', WORK_CATEGORIES[1]],
  ['Trademark Registration', WORK_CATEGORIES[2]],
  ['Trademark Objection', WORK_CATEGORIES[2]],
  ['Trademark Opposition', WORK_CATEGORIES[2]],
  ['Trademark Renewal', WORK_CATEGORIES[2]],
  ['Copyright Registration', WORK_CATEGORIES[2]],
  ['Design Registration', WORK_CATEGORIES[2]],
  ['Provisional Patent', WORK_CATEGORIES[2]],
  ['Patent Registration', WORK_CATEGORIES[2]],
  ['Find trademark class for over 8000 goods and services', WORK_CATEGORIES[2]],
  ['GST Registration', WORK_CATEGORIES[3]],
  ['GST Return Filing', WORK_CATEGORIES[3]],
  ['GST LUT Filing', WORK_CATEGORIES[3]],
  ['GST Registration Cancellation', WORK_CATEGORIES[3]],
  ['GST Annual Return', WORK_CATEGORIES[3]],
  ['GST Invoicing', WORK_CATEGORIES[3]],
  ['GST eInvoicing', WORK_CATEGORIES[3]],
  ['eWay Bill', WORK_CATEGORIES[3]],
  ['GST Software for Accountants', WORK_CATEGORIES[3]],
  ['Personal Tax Filing', WORK_CATEGORIES[4]],
  ['Business Tax Filing', WORK_CATEGORIES[4]],
  ['Tax Notice', WORK_CATEGORIES[4]],
  ['TDS Filing', WORK_CATEGORIES[4]],
  ['ITR-1 Return', WORK_CATEGORIES[4]],
  ['ITR-2 Return', WORK_CATEGORIES[4]],
  ['ITR-3 Return', WORK_CATEGORIES[4]],
  ['ITR-4 Return', WORK_CATEGORIES[4]],
  ['ITR-5 Return', WORK_CATEGORIES[4]],
  ['ITR-6 Return', WORK_CATEGORIES[4]],
  ['ITR-7 Return', WORK_CATEGORIES[4]],
  ['Form 16', WORK_CATEGORIES[4]],
  ['Company Registration', WORK_CATEGORIES[5]],
  ['LLP Compliance', WORK_CATEGORIES[5]],
  ['PF Registration', WORK_CATEGORIES[5]],
  ['PF Return Filing', WORK_CATEGORIES[5]],
  ['ESI Registration', WORK_CATEGORIES[5]],
  ['Add Directors', WORK_CATEGORIES[5]],
  ['Remove Directors', WORK_CATEGORIES[5]],
  ['Share Transfer', WORK_CATEGORIES[5]],
  ['DIR-3 KYC', WORK_CATEGORIES[5]],
  ['Registered Office Change', WORK_CATEGORIES[5]],
  ['Increase Authorized Capital', WORK_CATEGORIES[5]],
  ['Winding Up of Company', WORK_CATEGORIES[5]],
  ['Winding Up of LLP', WORK_CATEGORIES[5]],
  ['Importer Exporter Code', WORK_CATEGORIES[5]],
  ['ISO Certification', WORK_CATEGORIES[5]],
  ['AOC-4 Filing', WORK_CATEGORIES[5]],
  ['MGT-7/7A Filing', WORK_CATEGORIES[5]],
  ['TAX Audit', WORK_CATEGORIES[6]],
  ['Audit', WORK_CATEGORIES[6]],
  ['Bookkeeping', WORK_CATEGORIES[6]],
  ['Prepration of Financial Statement', WORK_CATEGORIES[6]],
  ['Gem Registration', WORK_CATEGORIES[7]],
  ['CLRA registration', WORK_CATEGORIES[7]],
  ['CLRA licence', WORK_CATEGORIES[7]],
  ['DPT-3', WORK_CATEGORIES[7]],
  ['TAN Registration', WORK_CATEGORIES[7]],
  ['PAN Registration', WORK_CATEGORIES[7]],
  ['PAN EDITING', WORK_CATEGORIES[7]],
  ['12A Registration', WORK_CATEGORIES[7]],
  ['80G Registration', WORK_CATEGORIES[7]],
].map(([name, category]) => ({ name, category }));

// Every checklist item carries a `kind`, so the UI (both the employee's Ask
// Documents tab and the client-facing upload page) knows how to collect it:
//   'file'  - a single-side upload (most documents)
//   'file2' - a two-sided upload, front + back (Aadhaar Card)
//   'text'  - not a document at all, just typed information (Mobile Number,
//             DIN, profit-sharing ratio, etc.) — collected as text, not a file
function item(name, kind) { return { name, kind: kind || 'file' }; }

// Reusable item sets, so the ~20 templates below don't repeat the same
// KYC/address-proof line items verbatim.
const PROPRIETOR_KYC = [item('Aadhaar Card', 'file2'), item('PAN Card'), item('Passport-size Photo'), item('Mobile Number', 'text'), item('Email ID', 'text'), item('Latest Bank Statement')];
const DIRECTOR_KYC = [item('Aadhaar Card', 'file2'), item('PAN Card'), item('Passport-size Photo'), item('Mobile Number', 'text'), item('Email ID', 'text'), item('Latest Bank Statement')];
const PARTNER_KYC = [item('Aadhaar Card', 'file2'), item('PAN Card'), item('Passport-size Photo'), item('Mobile Number', 'text'), item('Email ID', 'text'), item('Latest Bank Statement')];
const ADDRESS_PROOF = [item('Rent Agreement'), item('NOC from owner'), item('Electricity Bill (not older than 2 months)')];
const BANK_DETAILS = [item('Cancelled Cheque'), item('Latest Bank Statement')];

function constitutionGroupFor(entityType) {
  switch (entityType) {
    case 'proprietorship': return null;
    case 'partnership': return { heading: 'Partnership documents', items: [item('Partnership Deed')] };
    case 'llp': return { heading: 'LLP documents', items: [item('LLP Agreement'), item('Certificate of Incorporation')] };
    case 'company': return { heading: 'Company documents', items: [item('Certificate of Incorporation'), item('MOA'), item('AOA')] };
    case 'ngo': return { heading: 'Trust / Society documents', items: [item('Trust Deed / Society Registration Certificate'), item('By-laws')] };
    default: return null;
  }
}
function kycGroupFor(entityType) {
  switch (entityType) {
    case 'proprietorship': return { heading: 'Proprietor KYC', repeatRole: null, items: PROPRIETOR_KYC };
    case 'partnership': return { heading: 'Partner KYC', repeatRole: 'partner', items: PARTNER_KYC };
    case 'llp': return { heading: 'Partner KYC', repeatRole: 'partner', items: PARTNER_KYC };
    case 'company': return { heading: 'Director KYC', repeatRole: 'director', items: DIRECTOR_KYC };
    case 'ngo': return { heading: 'Trustee / Member KYC', repeatRole: 'partner', items: PARTNER_KYC };
    default: return null;
  }
}
function crossEntityGroups(extraByEntity) {
  const groupsByEntity = {};
  ENTITY_TYPES.forEach(({ value }) => {
    const groups = [constitutionGroupFor(value), kycGroupFor(value)].filter(Boolean);
    groups.push({ heading: 'Business address proof', repeatRole: null, items: ADDRESS_PROOF });
    if (extraByEntity) groups.push(...(extraByEntity(value) || []));
    groupsByEntity[value] = groups;
  });
  return groupsByEntity;
}

const TEMPLATES = {
  'Proprietorship': {
    entityTypes: null,
    groups: [
      { heading: 'Proprietor KYC', repeatRole: null, items: PROPRIETOR_KYC },
      { heading: 'Business address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Bank details', repeatRole: null, items: BANK_DETAILS },
    ],
  },
  'Partnership Creation': {
    entityTypes: null,
    groups: [
      { heading: 'Partner KYC', repeatRole: 'partner', items: PARTNER_KYC },
      { heading: 'Business address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Partnership details', repeatRole: null, items: [item('Proposed firm name', 'text'), item('Profit sharing ratio', 'text'), item('Capital contribution details', 'text')] },
    ],
  },
  'One Person Company Incorporation': {
    entityTypes: null,
    groups: [
      { heading: 'Registered office address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Director KYC', repeatRole: null, items: DIRECTOR_KYC },
      { heading: 'Nominee KYC', repeatRole: null, items: DIRECTOR_KYC },
      { heading: 'Digital Signature', repeatRole: null, items: [item('DSC of the director (if not already available)')] },
    ],
  },
  'Limited Liability Partnership Incorporation': {
    entityTypes: null,
    groups: [
      { heading: 'Registered office address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Designated Partner KYC', repeatRole: 'partner', items: PARTNER_KYC },
      { heading: 'Digital Signature', repeatRole: null, items: [item('DSC of each designated partner (if not already available)')] },
    ],
  },
  'Private Limited Company Incorporation': {
    entityTypes: null,
    groups: [
      { heading: 'Registered office address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Director KYC', repeatRole: 'director', items: DIRECTOR_KYC },
      { heading: 'Digital Signature', repeatRole: null, items: [item('DSC of each proposed director (if not already available)')] },
    ],
  },
  'Nidhi Company Incorporation': {
    entityTypes: null,
    groups: [
      { heading: 'Registered office address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Director KYC', repeatRole: 'director', items: DIRECTOR_KYC },
      { heading: 'Digital Signature', repeatRole: null, items: [item('DSC of each proposed director (if not already available)')] },
      { heading: 'Members', repeatRole: null, items: [item('List of proposed members (minimum 7)')] },
    ],
  },
  'Section 8 Company Incorporation': {
    entityTypes: null,
    groups: [
      { heading: 'Registered office address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Director KYC', repeatRole: 'director', items: DIRECTOR_KYC },
      { heading: 'Digital Signature', repeatRole: null, items: [item('DSC of each proposed director (if not already available)')] },
      { heading: 'NGO objects & declaration', repeatRole: null, items: [item('Draft MOA stating charitable objects'), item('Declaration by director (Form INC-14/15)')] },
    ],
  },
  'Farmer Producer Company Registration': {
    entityTypes: null,
    groups: [
      { heading: 'Registered office address proof', repeatRole: null, items: ADDRESS_PROOF },
      { heading: 'Director KYC', repeatRole: 'director', items: DIRECTOR_KYC },
      { heading: 'Digital Signature', repeatRole: null, items: [item('DSC of each proposed director (if not already available)')] },
      { heading: 'Farmer members', repeatRole: null, items: [item('List of farmer members with land ownership / khasra proof')] },
    ],
  },
  'Company Compliance': {
    entityTypes: null,
    groups: [
      { heading: 'Existing company documents', repeatRole: null, items: [item('Certificate of Incorporation'), item('PAN Card of Company'), item('MOA'), item('AOA'), item('Last filed Balance Sheet / Financial Statements'), item("Auditor's Report"), item('Board Resolution approving financials')] },
      { heading: 'Director details', repeatRole: 'director', items: [item('DIN', 'text'), item('DSC')] },
    ],
  },
  'Digital Signature': {
    entityTypes: null,
    groups: [
      { heading: 'Applicant KYC', repeatRole: null, items: [item('Aadhaar Card', 'file2'), item('PAN Card'), item('Passport-size Photo'), item('Mobile Number', 'text'), item('Email ID', 'text'), item('Video verification')] },
      { heading: 'Organisation authorisation (if applicable)', repeatRole: null, items: [item('Board Resolution / Authorisation Letter'), item('Organisation PAN')] },
    ],
  },
  'GST Registration': {
    entityTypes: ENTITY_TYPES,
    groupsByEntity: crossEntityGroups(() => [{ heading: 'Bank details', repeatRole: null, items: BANK_DETAILS }]),
  },
  'PF Registration': {
    entityTypes: ENTITY_TYPES,
    groupsByEntity: crossEntityGroups(() => [{ heading: 'Employee details', repeatRole: null, items: [item('List of employees with salary'), item('Date of establishment', 'text')] }]),
  },
  'ESI Registration': {
    entityTypes: ENTITY_TYPES,
    groupsByEntity: crossEntityGroups(() => [{ heading: 'Employee details', repeatRole: null, items: [item('List of employees with salary'), item('Date of establishment', 'text')] }]),
  },
  'Udyam Registration (MSME)': {
    entityTypes: ENTITY_TYPES.filter(e => e.value !== 'ngo'),
    groupsByEntity: (() => {
      const all = crossEntityGroups(() => [{ heading: 'Business details', repeatRole: null, items: [item('PAN of business'), item('GST Certificate (if registered)'), item('Investment & turnover details', 'text')] }]);
      delete all.ngo;
      return all;
    })(),
  },
  'Trademark Registration': {
    entityTypes: ENTITY_TYPES,
    groupsByEntity: crossEntityGroups(() => [{ heading: 'Trademark details', repeatRole: null, items: [item('Logo / brand name (image)'), item('Class of goods or services', 'text'), item('Power of Attorney (Form TM-48)'), item('Proof of prior use (if claiming since a date)')] }]),
  },
  'TAX Audit': {
    entityTypes: ENTITY_TYPES,
    groupsByEntity: crossEntityGroups(() => [{ heading: 'Financial documents', repeatRole: null, items: [item('Bank Statements (full year)'), item('Sales & Purchase invoices / register'), item('Stock register'), item("Previous year's Audit Report / ITR"), item('Form 26AS')] }]),
  },
  'Audit': {
    entityTypes: ENTITY_TYPES,
    groupsByEntity: crossEntityGroups(() => [{ heading: 'Financial documents', repeatRole: null, items: [item('Bank Statements (full year)'), item('Ledgers & Trial Balance'), item('Fixed Asset Register'), item("Previous year's Audit Report")] }]),
  },
  'Bookkeeping': {
    entityTypes: ENTITY_TYPES,
    groupsByEntity: crossEntityGroups(() => [{ heading: 'Financial documents', repeatRole: null, items: [item('Bank Statements (monthly)'), item('Sales & Purchase invoices'), item('Expense receipts'), item('Previous bookkeeping records (if any)')] }]),
  },
  'DIR-3 KYC': {
    entityTypes: null,
    groups: [
      { heading: 'Director KYC', repeatRole: 'director', items: [item('Aadhaar Card', 'file2'), item('PAN Card'), item('Passport-size Photo'), item('Mobile Number', 'text'), item('Email ID', 'text'), item('DSC')] },
    ],
  },
  'Add Directors': {
    entityTypes: null,
    groups: [
      { heading: 'Existing company documents', repeatRole: null, items: [item('Certificate of Incorporation'), item('PAN Card of Company'), item('Board Resolution')] },
      { heading: 'New Director KYC', repeatRole: 'director', items: [item('Aadhaar Card', 'file2'), item('PAN Card'), item('Passport-size Photo'), item('Mobile Number', 'text'), item('Email ID', 'text'), item('DIN (if already allotted)', 'text'), item('Consent to act as Director (Form DIR-2)')] },
    ],
  },
  'Remove Directors': {
    entityTypes: null,
    groups: [
      { heading: 'Existing company documents', repeatRole: null, items: [item('Certificate of Incorporation'), item('PAN Card of Company'), item('Board Resolution')] },
      { heading: 'Resigning Director details', repeatRole: 'director', items: [item('Resignation Letter'), item('DIN', 'text'), item('DSC (for filing, if applicable)')] },
    ],
  },
};

module.exports = { ENTITY_TYPES, WORK_CATEGORIES, WORK_LIST, TEMPLATES };
