require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Tally (Tally Prime / Tally ERP 9) question bank — original MCQs on
// practical software usage, navigation, and features, answers verified.
// Distinct in focus from the Accounts area (which covers accounting
// concepts): this area tests how Tally implements those concepts.
// Format: [q, A, B, C, D, correct]. Target org GB-001 (id 1), area "Tally".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'tally';

const INTERN = [
  ["Tally is primarily a type of:", "Word processing software", "Accounting/business management software", "Photo editing software", "Web browser", "B"],
  ["The current widely used version of Tally is called:", "Tally 9000", "Tally Prime", "Tally Cloud", "Tally Online", "B"],
  ["The main screen shown after opening Tally is called the:", "Home Screen", "Gateway of Tally", "Dashboard Only", "Control Panel", "B"],
  ["In Tally, before entering any transaction, the user must first create a:", "Voucher", "Company", "Bank account only", "Invoice", "B"],
  ["Company creation in Tally requires details such as name and:", "Employee salary slips", "Financial year start date", "GST return status", "Bank passbook", "B"],
  ["In Tally, all account heads such as Cash, Sales, and Purchases are created as:", "Vouchers", "Ledgers", "Groups only", "Cost centres", "B"],
  ["Ledgers in Tally must be classified under a:", "Voucher type", "Group", "Company", "Report", "B"],
  ["'Cash-in-Hand' is an example of a predefined:", "Voucher type", "Ledger under a group", "Report", "Cost centre", "B"],
  ["The default groups already available when a company is created in Tally are called:", "User groups", "Predefined (primary) groups", "Custom groups", "Ledger groups only", "B"],
  ["A transaction is entered into Tally through a:", "Ledger", "Voucher", "Group", "Report only", "B"],
  ["The voucher used to record cash/bank payments in Tally is the:", "Receipt voucher", "Payment voucher", "Sales voucher", "Journal voucher", "B"],
  ["The voucher used to record cash/bank receipts in Tally is the:", "Payment voucher", "Receipt voucher", "Purchase voucher", "Contra voucher", "B"],
  ["The voucher used for fund transfer between cash and bank accounts is the:", "Payment voucher", "Receipt voucher", "Contra voucher", "Sales voucher", "C"],
  ["The voucher used to record adjustment entries not involving cash/bank is the:", "Contra voucher", "Journal voucher", "Sales voucher", "Purchase voucher", "B"],
  ["The voucher used to record credit sales/cash sales of goods is the:", "Purchase voucher", "Sales voucher", "Payment voucher", "Journal voucher", "B"],
  ["The voucher used to record purchase of goods is the:", "Sales voucher", "Purchase voucher", "Receipt voucher", "Contra voucher", "B"],
  ["The voucher used to record a return of goods by a customer is the:", "Debit note", "Credit note", "Payment voucher", "Journal voucher", "B"],
  ["The voucher used to record a return of goods to a supplier is the:", "Credit note", "Debit note", "Receipt voucher", "Sales voucher", "B"],
  ["Ledgers can be created individually or using the:", "Single ledger creation screen only", "Multiple ledger creation screen", "Voucher screen only", "Report screen", "B"],
  ["The shortcut key generally used to create a company in Tally is:", "Alt+F3", "F11", "F12", "Ctrl+A", "A"],
  ["In Tally, the F11 key is generally used to access:", "Company features", "Configuration settings", "Voucher entry", "Reports", "A"],
  ["In Tally, the F12 key is generally used to access:", "Company features", "Configuration settings", "Ledger creation", "Group creation", "B"],
  ["To save any screen/voucher in Tally, the user generally presses:", "Esc", "Ctrl+A", "Alt+D", "F5", "B"],
  ["To exit or cancel a screen in Tally, the shortcut generally used is:", "Ctrl+A", "Esc", "F2", "F9", "B"],
  ["To change the date of a voucher in Tally, the shortcut key is generally:", "F1", "F2", "F3", "F4", "B"],
  ["To alter/change the current company in Tally, a common shortcut is:", "F1", "F2", "F3", "F4", "C"],
  ["The Trial Balance report can typically be viewed under:", "Gateway of Tally > Display/Reports", "Voucher entry screen only", "Company creation screen", "Payroll menu only", "A"],
  ["The Balance Sheet in Tally can be viewed from the:", "Reports menu", "Voucher entry screen", "Ledger creation screen", "Group alteration only", "A"],
  ["The Profit and Loss Account in Tally is available under the:", "Voucher screen", "Reports/Display menu", "Group creation screen", "Cost centre screen", "B"],
  ["Stock Items in Tally are used to record details of:", "Employees", "Goods/inventory", "Bank accounts", "Loans", "B"],
  ["Stock Items must be classified under a:", "Voucher type", "Stock Group", "Ledger group only", "Cost category", "B"],
  ["The unit of measurement for stock items (e.g. Nos, Kg) is created under:", "Units of Measure", "Ledger groups", "Voucher types", "Cost centres", "A"],
  ["A Day Book in Tally shows:", "Only the trial balance", "All vouchers entered on a particular day/period", "Only ledger balances", "Only stock summary", "B"],
  ["The Stock Summary report shows the:", "List of employees", "Quantity and value of stock items", "List of ledgers only", "List of vouchers only", "B"],
  ["The keyboard shortcut to view the List of Ledger Accounts (Chart of Accounts) is generally:", "Ctrl+A", "Gateway of Tally > Chart of Accounts", "F11", "Alt+F1", "B"],
  ["'Sundry Debtors' and 'Sundry Creditors' are examples of:", "Voucher types", "Predefined ledger groups", "Cost centres", "Stock groups", "B"],
  ["Data in Tally is typically saved:", "Only when the user manually exports", "Automatically after each voucher entry", "Only at day end", "Never automatically", "B"],
  ["Multiple companies can be maintained and worked on in Tally:", "No, only one company is allowed ever", "Yes, and simultaneously in different sessions", "Only with a special add-on always", "Only in the trial version", "B"],
  ["Tally allows creation of a company backup through the:", "Backup option in the company features menu", "Voucher entry screen", "Report menu only", "Group screen", "A"],
  ["The financial year in Tally is set at the time of:", "Every voucher entry", "Company creation", "Report generation only", "Backup only", "B"],
];

const EXECUTIVE = [
  ["To create a new ledger while entering a voucher, the shortcut generally used is:", "Alt+C", "Alt+D", "Ctrl+A", "F5", "A"],
  ["To alter a voucher already entered, the user typically:", "Cannot ever change it", "Opens the Day Book and selects the voucher", "Must delete the company", "Must contact support", "B"],
  ["To delete a voucher in Tally, the shortcut generally used is:", "Alt+D", "Alt+A", "Ctrl+D", "F8", "A"],
  ["Payment voucher entry is generally accessed using the function key:", "F4", "F5", "F6", "F7", "B"],
  ["Receipt voucher entry is generally accessed using:", "F4", "F5", "F6", "F7", "C"],
  ["Contra voucher entry is generally accessed using:", "F3", "F4", "F5", "F6", "B"],
  ["Sales voucher entry is generally accessed using:", "F7", "F8", "F9", "F10", "B"],
  ["Purchase voucher entry is generally accessed using:", "F7", "F8", "F9", "F10", "C"],
  ["Journal voucher entry is generally accessed using:", "F5", "F6", "F7", "F8", "C"],
  ["Debit note entry is generally accessed using:", "Ctrl+F7", "Ctrl+F8", "Ctrl+F9", "Ctrl+F5", "C"],
  ["Credit note entry is generally accessed using:", "Ctrl+F5", "Ctrl+F6", "Ctrl+F7", "Ctrl+F8", "D"],
  ["To view or print an invoice after saving, the shortcut generally used is:", "Alt+P", "Alt+D", "Ctrl+P", "F5", "A"],
  ["A cost centre in Tally is used to track income/expense by:", "Only the total company", "A specific department, project, or division", "Bank account only", "Voucher number only", "B"],
  ["Cost centres are enabled through:", "F11 features", "F5 payment voucher", "Stock summary", "Trial balance", "A"],
  ["Bank Reconciliation in Tally allows matching of the company's book balance with the:", "Sales register", "Bank statement/passbook balance", "Purchase register", "Stock summary", "B"],
  ["Bank Reconciliation Statement (BRS) in Tally can typically be accessed under:", "Banking menu in Reports", "Stock summary", "Payroll menu", "Group creation", "A"],
  ["A cheque printing feature in Tally allows the user to:", "Print physical cheques directly with bank formats", "Create GST returns", "Print stock reports only", "Manage payroll only", "A"],
  ["A Purchase Order in Tally is generally used to:", "Record actual purchase of goods", "Record an order placed with a supplier before purchase", "Record sales to a customer", "Record salary payment", "B"],
  ["A Sales Order in Tally is generally used to:", "Record an order received from a customer before sale", "Record actual sale of goods", "Record a purchase", "Record a payment", "A"],
  ["A Delivery Note in Tally records the:", "Sale invoice", "Dispatch/delivery of goods to a customer", "Receipt of goods from a supplier", "Payment received", "B"],
  ["A Receipt Note (Goods Receipt Note) in Tally records the:", "Sale of goods", "Receipt of goods from a supplier", "Dispatch of goods", "Bank receipt only", "B"],
  ["Godown/location management in Tally helps track stock across:", "Only one warehouse", "Multiple godowns/locations", "Only employees", "Only ledgers", "B"],
  ["Batch-wise inventory tracking in Tally is useful for tracking items by:", "Batch number and expiry date", "Voucher number only", "Employee name", "Bank name", "A"],
  ["Price Levels in Tally allow different:", "Selling prices for different customer categories", "Voucher numbering only", "Ledger groups", "Bank details", "A"],
  ["A discount column in an invoice can be enabled through the:", "F12 configuration/F11 features", "Payroll menu", "Group alteration", "Backup screen", "A"],
  ["Reorder levels in Tally help track:", "Employee attendance", "Minimum stock levels to trigger reordering", "GST rates only", "Bank charges", "B"],
  ["Multiple currencies in transactions are enabled through:", "F11 accounting/inventory features", "Voucher class only", "Payroll feature", "Backup menu", "A"],
  ["A 'Voucher Class' in Tally is used to:", "Automate common ledger entries in a voucher", "Create a new company", "Print reports only", "Manage payroll", "A"],
  ["The Ratio Analysis report in Tally shows financial ratios such as:", "Current ratio and quick ratio", "GST rates only", "Employee count", "Voucher numbers", "A"],
  ["Cash Flow and Fund Flow statements in Tally can be accessed under:", "Reports > Statements of Accounts", "Payroll menu", "Group creation screen", "Voucher entry screen", "A"],
  ["Outstanding receivables (bills receivable) reports in Tally help track:", "Amounts owed by customers", "Amounts owed to suppliers only", "Payroll dues", "Stock levels", "A"],
  ["Outstanding payables (bills payable) reports in Tally help track:", "Amounts owed by customers", "Amounts owed to suppliers", "Employee salary", "Stock quantity", "B"],
  ["'Bill-wise details' in Tally allow tracking of:", "Each invoice/bill against a party separately", "Only the total ledger balance", "Only cash balance", "Only stock value", "A"],
  ["Interest can be calculated automatically on outstanding balances in Tally by enabling:", "Interest Calculation feature", "Payroll feature", "GST feature only", "TDS feature only", "A"],
  ["A negative stock/cash balance can be flagged in Tally through:", "Configuration warnings/exception reports", "Payroll settings", "GST return filing", "Company creation only", "A"],
  ["'Scenario' in Tally is generally used for:", "Provisional/what-if reporting without affecting actual books", "Actual voucher entry only", "Payroll processing", "Bank reconciliation only", "A"],
  ["A memorandum voucher in Tally is used to record entries that:", "Affect the books permanently like a normal voucher", "Do not affect the books but are for reference/reminder", "Are mandatory for GST", "Print cheques", "B"],
  ["An Optional voucher in Tally is one that:", "Always updates the actual books", "Does not affect actual figures unless regularised", "Cannot be created", "Is used only for payroll", "B"],
  ["To view the List of Accounts (a complete overview of all masters) in Tally Prime, the user can go to:", "Gateway of Tally > Chart of Accounts", "Payroll menu only", "Backup screen", "GST return screen only", "A"],
  ["A 'Post-Dated' voucher in Tally is a transaction dated:", "In the past relative to today", "In the future, which does not reflect in current balances until that date", "Only for GST purposes", "Only for payroll purposes", "B"],
];

const INTERMEDIATE = [
  ["GST features in Tally are activated through:", "F11 statutory features", "Payroll settings only", "Voucher printing only", "Backup menu", "A"],
  ["GST rates in Tally can be set at the:", "Company level, stock group/item level, or ledger level", "Only at the voucher level", "Only in payroll", "Nowhere; always manual", "A"],
  ["GSTR-1 and GSTR-3B data can be viewed/exported from Tally under:", "GST reports in Display/Statutory Reports", "Payroll reports", "Stock summary only", "Cost centre reports", "A"],
  ["HSN/SAC codes for goods/services in Tally are generally recorded at the:", "Stock item/ledger level", "Voucher number level", "Company creation screen only", "Bank ledger level", "A"],
  ["E-Way Bill details can be generated/captured from within:", "Tally's sales voucher with relevant features enabled", "Payroll module only", "Cost centre reports", "Ledger alteration only", "A"],
  ["TDS features in Tally are enabled through:", "F11 statutory features", "Voucher printing", "Cost centre reports", "Group summary", "A"],
  ["TDS deduction in Tally is generally linked to a:", "Stock item", "Nature of payment and party ledger configured for TDS", "Bank reconciliation entry", "Cost category only", "B"],
  ["TCS (Tax Collected at Source) can also be configured in Tally similar to:", "TDS", "Payroll", "Cost centres", "Godowns", "A"],
  ["A Reversal of ITC (input tax credit) entry in Tally is generally passed through a:", "Payment voucher", "Journal voucher with GST details", "Sales voucher", "Receipt voucher", "B"],
  ["Multi-currency accounting in Tally requires defining a:", "Base currency and foreign currency with exchange rate", "Only base currency", "Only foreign currency", "No currency setting", "A"],
  ["Budgets in Tally allow comparison of actual figures against:", "Budgeted figures for variance analysis", "GST rates only", "Payroll figures only", "Stock levels only", "A"],
  ["Point of Sale (POS) invoicing in Tally is generally used for:", "B2B credit sales only", "Retail/counter cash sales", "Payroll processing", "Bank reconciliation", "B"],
  ["A Zero-Valued Entry in Tally allows recording a transaction of:", "Nil monetary value for reference (e.g., free samples)", "Only cash transactions", "Only GST entries", "Only payroll entries", "A"],
  ["Job Costing/Job Work features in Tally help track materials sent for:", "Processing by a third party (job worker)", "Direct retail sale only", "Payroll only", "GST filing only", "A"],
  ["Manufacturing Journal in Tally records:", "Conversion of raw materials into finished goods", "Only cash sales", "Only bank transactions", "Only payroll", "A"],
  ["Bill of Materials (BOM) in Tally defines:", "The components/raw materials required to produce a finished item", "Employee salary structure", "GST rate slabs", "Bank charges", "A"],
  ["Payroll in Tally allows processing of:", "Only GST returns", "Employee salaries, attendance, and statutory deductions", "Only stock valuation", "Only bank reconciliation", "B"],
  ["Pay heads in Tally payroll represent components such as:", "Basic pay, HRA, and deductions", "Stock items", "GST rates", "Bank ledgers", "A"],
  ["Attendance/Production types in Tally payroll help track:", "Employee present/absent days or units produced", "GST filing status", "Bank charges", "Stock valuation method", "A"],
  ["PF and ESI configurations in Tally payroll are used to compute:", "Statutory salary deductions/contributions", "GST rates", "Stock reorder levels", "Bank interest", "A"],
  ["The 'Security Control' feature in Tally allows:", "Setting up multiple user IDs with defined access rights", "GST rate configuration", "Only bank reconciliation", "Only payroll processing", "A"],
  ["Tally Vault is a feature used to:", "Encrypt and protect company data with a password", "Print cheques", "Configure GST", "Manage stock reorder", "A"],
  ["Data synchronisation between multiple locations in Tally is achieved through:", "Tally.NET / Data Synchronisation feature", "Payroll module", "Cost centre reports only", "Group alteration", "A"],
  ["Remote access to Tally data (via Tally.NET) allows a user to:", "View reports from a remote location without physical access to the data", "Only print vouchers locally", "Only manage payroll", "Only reconcile banks", "A"],
  ["The 'Split Company Data' feature in Tally is used to:", "Divide company data into multiple financial years/periods", "Merge two unrelated companies", "Delete the company", "Print GST returns only", "A"],
  ["Migrating data from Tally ERP 9 to Tally Prime generally involves:", "Manual re-entry of every voucher", "An in-built migration/upgrade process", "No possibility of migration", "Only exporting to Excel", "B"],
  ["'Godown Transfer' vouchers in Tally are used to record movement of stock:", "Between different godowns/locations of the same company", "To a customer", "From a supplier", "To an employee", "A"],
  ["Rate of GST on a stock item can be overridden at the:", "Company master level only", "Individual stock item/ledger level", "Never; always fixed globally", "Bank ledger level", "B"],
  ["'Percentage-based' TDS deduction rates in Tally are configured under:", "TDS nature of payment master", "Payroll master only", "Stock item master", "Cost centre master", "A"],
  ["A 'Purchase Order Outstanding' report shows orders:", "Fully received", "Placed but not yet fully received", "Cancelled orders only", "Only paid orders", "B"],
  ["An 'Age-wise Analysis' report in Tally shows outstanding bills classified by:", "Product category", "Number of days outstanding", "Employee name", "GST rate", "B"],
  ["'Cost Category' in Tally, distinct from Cost Centre, allows:", "Parallel allocation of costs across different dimensions (e.g. department and project)", "Only single-dimension tracking", "GST rate classification", "Bank ledger grouping", "A"],
  ["'Interest Calculation' on overdue bills in Tally can be based on:", "Simple or compound interest as configured", "Only simple interest always", "Only compound interest always", "No interest option exists", "A"],
  ["The 'Scenario Management' and 'Reversing Journal' features are typically used together for:", "Provisional entries reversed automatically after a set date", "GST return filing", "Payroll disbursement", "Bank reconciliation only", "A"],
  ["'Currency of Additional Info' allows recording of:", "Extra reference details like PAN, GST number on masters", "Multi-currency exchange rates only", "Payroll salary structure", "Bank IFSC details only", "A"],
];

const EXPERT = [
  ["TDL stands for:", "Tally Definition Language", "Tally Development Language", "Tax Data Ledger", "Transaction Data Log", "B"],
  ["TDL is primarily used in Tally to:", "Customise reports and add new features", "Only print vouchers", "Configure GST rates only", "Manage payroll salary only", "A"],
  ["A '.tcp' file in Tally refers to a:", "Tally Compiled Program (add-on)", "Company backup file", "Voucher template", "GST return file", "A"],
  ["ODBC connectivity in Tally allows:", "External applications (e.g. Excel) to fetch live data from Tally", "GST return filing directly", "Payroll disbursement", "Bank reconciliation only", "A"],
  ["Tally's Export feature allows data to be exported in formats such as:", "XML, Excel, and PDF", "Only plain text", "Only image formats", "Only audio formats", "A"],
  ["The 'Tally Audit' feature (Auditors' Edition) allows a Chartered Accountant to:", "Mark vouchers as verified/altered for audit trail purposes", "Only print invoices", "Only manage payroll", "Only configure GST rates", "A"],
  ["An Edit Log in Tally Prime helps track:", "Who altered a voucher/master and when", "Only stock valuation changes", "Only GST rate changes", "Only payroll changes", "A"],
  ["Tally's multi-user (Gold) licence allows:", "Only a single user to access data", "Simultaneous access by multiple users on a network", "Only remote access, no local access", "Only payroll processing", "B"],
  ["A single-user (Silver) edition of Tally allows:", "Multiple simultaneous users", "Only one user/computer to access the data at a time", "Unlimited concurrent access", "Only cloud access", "B"],
  ["Backing up Tally data is important primarily to:", "Increase software speed", "Prevent data loss and enable restoration if needed", "Reduce file size only", "Update GST rates automatically", "B"],
  ["Restoring a Tally backup requires selecting the:", "Backup file/folder and destination company", "Only the company name", "Only the financial year", "Only the GSTIN", "A"],
  ["A company's data can be split across periods primarily to:", "Improve report navigation and manage large data volumes", "Delete old transactions permanently", "Automatically file GST returns", "Change the company's PAN", "A"],
  ["Consolidation of multiple companies' data in Tally is useful for preparing:", "Group/consolidated financial statements", "Only individual payroll", "Only individual GST returns", "Only stock reports of one company", "A"],
  ["'Tally Prime' introduced improvements mainly in:", "Search, navigation (Go To), and multitasking", "Only payroll", "Only GST", "Only backup", "A"],
  ["The 'Go To' feature in Tally Prime allows the user to:", "Directly jump to any report or voucher screen by typing its name", "Only print reports", "Only create ledgers", "Only reconcile banks", "A"],
  ["Auto Bank Reconciliation in Tally Prime can use:", "An e-banking statement (e.g. imported file) to auto-match entries", "Manual matching only, no automation possible", "Only cash vouchers", "Only payroll data", "A"],
  ["Connected GST / e-invoicing features in Tally Prime allow:", "Direct generation of e-invoices/IRN from within Tally", "Only manual GST calculation", "Only payroll processing", "Only stock valuation", "A"],
  ["Data security in Tally can be enhanced through a combination of:", "User-level access rights, Tally Vault, and audit features", "Only setting a Windows password", "Only antivirus software", "No security features exist", "A"],
  ["A licensed Tally installation is generally activated using:", "A serial number/activation key linked to the account", "No activation needed at all", "Only a company PAN", "Only a GST number", "A"],
  ["Tally's 'Auto Column' feature in reports allows comparison across:", "Multiple periods or companies side by side", "Only a single period", "Only stock items", "Only ledgers with zero balance", "A"],
  ["The 'Exception Reports' in Tally help identify issues such as:", "Negative stock, ledgers without GST details, missing PAN", "Only payroll errors", "Only bank charges", "Only cost centre names", "A"],
  ["A 'Group Company' feature in Tally combines data of member companies to show:", "A combined view without altering individual company data", "A single merged company permanently", "Only payroll summary", "Only GST returns", "A"],
  ["Statutory compliance features (GST, TDS, TCS) in Tally are updated periodically through:", "Software updates/releases from Tally Solutions", "Manual recompilation of the software by the user", "Government portals directly modifying Tally", "They are never updated", "A"],
  ["'Cost centre class' automates allocation of amounts to:", "Multiple cost centres based on predefined percentages", "A single ledger only", "GST rates only", "Payroll heads only", "A"],
  ["The 'Bank Statement Import' feature in Tally supports formats such as:", "Excel, CSV or standard bank formats", "Only handwritten entries", "Only PDF scans", "Only images", "A"],
  ["A 'Voucher Type' can be configured to be:", "Numbered automatically or manually", "Only manually numbered", "Only automatically numbered with no override", "Not numbered at all", "A"],
  ["'Print Preview' before finalising a voucher/report helps the user to:", "Check formatting and details before actual printing", "Automatically email the report", "Delete the voucher", "Change the GSTIN permanently", "A"],
  ["A common reason for a 'GST mismatch' error in Tally reports is:", "Missing or incorrect GSTIN/HSN details in masters", "Correct company creation", "Proper backup", "Payroll processing", "A"],
  ["'Rounding Method' configuration in Tally invoices helps to:", "Automatically round off invoice values as per company policy", "Change the tax rate", "Alter the company name", "Modify payroll heads", "A"],
  ["Tally supports connectivity with external payment gateways/e-way bill portals mainly to:", "Streamline invoicing, payments, and compliance directly from the software", "Replace the need for any accounting entries", "Eliminate GST filing requirements", "Avoid the need for backups", "A"],
  ["A 'Change Tally Vault Password' option allows the administrator to:", "Update the encryption password of a vault-protected company", "Delete company data permanently", "Reset the financial year", "Change the company's legal name", "A"],
  ["Auditors' features in Tally, such as marking vouchers 'Verified' or 'Altered', primarily assist in:", "Statutory/internal audit trails", "GST rate updates", "Payroll salary revision", "Bank charge calculation", "A"],
  ["'Column Configuration' in Tally reports (e.g., adding a column for last year) helps in:", "Comparative analysis of figures across periods", "Deleting old vouchers", "Changing GST rates", "Payroll disbursement", "A"],
  ["The ability to work with Tally data over a Wide Area Network (WAN)/remote server chiefly benefits:", "Businesses with multiple branches needing centralised access", "Only single-location small shops", "Only payroll-only businesses", "Only GST filing agencies", "A"],
  ["A 'Purchase/Sales register' with GST filters in Tally helps generate data required for:", "Preparing and reconciling GST returns", "Only payroll processing", "Only stock reorder levels", "Only bank reconciliation", "A"],
];

const SETS = { Intern: INTERN, Executive: EXECUTIVE, Intermediate: INTERMEDIATE, Expert: EXPERT };
const LETTERS = ['A', 'B', 'C', 'D'];

function buildBalancedTargets(n) {
  const targets = [];
  for (let i = 0; i < n; i++) targets.push(i % 4);
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  return targets;
}
function reposition(row, targetPos) {
  const [q, a, b, c, d, correct] = row;
  const opts = [a, b, c, d];
  const correctText = opts[LETTERS.indexOf(correct)];
  const others = opts.filter((_, i) => i !== LETTERS.indexOf(correct));
  const out = [];
  let oi = 0;
  for (let pos = 0; pos < 4; pos++) out.push(pos === targetPos ? correctText : others[oi++]);
  return [q, out[0], out[1], out[2], out[3], LETTERS[targetPos]];
}

async function run() {
  const apply = process.argv.includes('--apply');
  const counts = Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, v.length]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log('Tally question bank:', JSON.stringify(counts), '=> total', total);

  let bad = 0;
  for (const [level, arr] of Object.entries(SETS)) {
    arr.forEach((row, i) => {
      const [q, a, b, , , correct] = row;
      if (!q || !a || !b) { bad++; console.log(`  ${level}#${i + 1}: missing question/options`); }
      if (!LETTERS.includes(correct)) { bad++; console.log(`  ${level}#${i + 1}: bad correct '${correct}'`); }
    });
  }
  if (bad) { console.log(`Validation failed: ${bad} issues.`); process.exit(1); }
  console.log('Validation OK.');

  if (!apply) { console.log('Dry run. Use --apply to insert into the database.'); return; }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  try {
    await cli.query(`SELECT set_config('app.bypass_rls','on', false)`);
    const area = await cli.query(
      `SELECT id FROM assessment_areas WHERE organization_id = $1 AND lower(name) = $2 LIMIT 1`,
      [ORG_ID, AREA_NAME]
    );
    if (!area.rows.length) throw new Error(`Tally area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
    const areaId = area.rows[0].id;

    await cli.query('BEGIN');
    const del = await cli.query(`DELETE FROM assessment_questions WHERE organization_id = $1 AND area_id = $2`, [ORG_ID, areaId]);
    const targets = buildBalancedTargets(total);
    let inserted = 0;
    for (const [level, arr] of Object.entries(SETS)) {
      for (const row of arr) {
        const [q, a, b, c, d, correct] = reposition(row, targets[inserted]);
        await cli.query(
          `INSERT INTO assessment_questions
             (organization_id, area_id, level, question_text, option_a, option_b, option_c, option_d, correct_option, marks, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,true)`,
          [ORG_ID, areaId, level, q, a, b, c, d, correct]
        );
        inserted++;
      }
    }
    await cli.query('COMMIT');
    console.log(`Deleted ${del.rowCount} old Tally questions; inserted ${inserted} new (area_id ${areaId}).`);
  } catch (err) {
    await cli.query('ROLLBACK');
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    cli.release();
    await pool.end();
  }
}

run();
