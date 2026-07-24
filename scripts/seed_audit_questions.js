require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Audit question bank — original MCQs on auditing concepts, Standards on
// Auditing (SA), internal control, and reporting, answers verified.
// Distinct in focus from Company Law (statutory audit provisions/sections)
// and Accounts (bookkeeping concepts). Format: [q, A, B, C, D, correct].
// Target org GB-001 (id 1), area "Audit".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'audit';

const INTERN = [
  ["An audit is best described as an:", "Estimation of future profits", "Independent examination of financial statements/records", "Internal management report", "Sales forecast", "B"],
  ["The primary objective of a statutory audit is to express an opinion on whether the financial statements:", "Show maximum profit", "Give a true and fair view", "Match the budget exactly", "Are error-free in every detail", "B"],
  ["An audit provides:", "Absolute assurance", "Reasonable assurance, not absolute assurance", "No assurance at all", "A guarantee against all fraud", "B"],
  ["An audit conducted under a legal requirement (e.g. Companies Act) is called a:", "Internal audit", "Statutory audit", "Management audit", "Cost audit", "B"],
  ["An audit conducted by employees of the organisation itself to evaluate controls is called a(n):", "Statutory audit", "Internal audit", "Tax audit", "Stock audit", "B"],
  ["An audit of a company's cost records is called a(n):", "Statutory audit", "Cost audit", "Internal audit", "Secretarial audit", "B"],
  ["An audit examining a company's compliance with corporate laws is called a(n):", "Cost audit", "Secretarial audit", "Tax audit", "Stock audit", "B"],
  ["An audit conducted specifically under the Income Tax Act on turnover-based criteria is called a:", "Statutory audit", "Tax audit", "Cost audit", "Bank audit", "B"],
  ["An examination confirming that assets/liabilities actually exist and are correctly valued is called:", "Vouching", "Verification", "Casting", "Posting", "B"],
  ["An examination of the accuracy of entries by checking them against supporting documents is called:", "Verification", "Vouching", "Ticking", "Footing", "B"],
  ["A document that provides evidence supporting a transaction (e.g. an invoice) is called a:", "Ledger", "Voucher", "Balance sheet", "Trial balance", "B"],
  ["Audit evidence supports the auditor's:", "Salary claim", "Conclusions and opinion", "Personal investments", "Tax return", "B"],
  ["The auditor's overall responses to assessed risks are designed to obtain sufficient appropriate:", "Profit", "Audit evidence", "Salary", "Dividend", "B"],
  ["A test of controls is performed to evaluate the operating effectiveness of:", "Financial statements directly", "Internal controls", "The auditor's own work", "Tax computations", "B"],
  ["A substantive procedure is designed to detect material:", "Weaknesses in salary structure", "Misstatements in financial statements", "Errors in the audit report format", "Delays in filing", "B"],
  ["An audit programme is a detailed plan of the:", "Company's future strategy", "Audit procedures to be performed", "Sales targets", "Bank loan terms", "B"],
  ["Audit working papers are records that document the:", "Company's marketing strategy", "Audit evidence obtained and procedures performed", "Employee attendance", "Product design", "B"],
  ["Working papers are generally considered the property of the:", "Client", "Auditor", "Government", "Bank", "B"],
  ["The person appointed to conduct an audit is called the:", "Director", "Auditor", "Company Secretary", "Registrar", "B"],
  ["Independence of the auditor from the client is essential for:", "Higher audit fees", "Objectivity and credibility of the audit opinion", "Faster completion of the audit", "Reducing paperwork", "B"],
  ["Which of these threatens auditor independence?", "No financial interest in the client", "A significant financial interest in the client", "Rotation of audit partners", "Peer review", "B"],
  ["An audit engagement letter is sent by the auditor to:", "The Government", "The client, confirming the terms of the audit engagement", "The bank only", "Employees only", "B"],
  ["Audit risk is the risk that the auditor expresses an inappropriate opinion when the financial statements are:", "Correct", "Materially misstated", "Audited twice", "Unaudited", "B"],
  ["Audit risk is a function of the risk of material misstatement and:", "Business risk", "Detection risk", "Credit risk", "Interest rate risk", "B"],
  ["Inherent risk refers to the susceptibility of an assertion to misstatement:", "Assuming related controls exist", "Assuming there are no related controls", "Only after the audit", "Only in cash transactions", "B"],
  ["Control risk is the risk that a misstatement will not be prevented or detected by the entity's:", "Auditor", "Internal control", "Bank", "Tax department", "B"],
  ["Detection risk is the risk that the auditor's procedures will not detect a misstatement that:", "Does not exist", "Exists and could be material", "Was already corrected", "Relates to next year", "B"],
  ["Materiality in an audit refers to the significance of an amount/misstatement that could influence the:", "Auditor's salary", "Economic decisions of users of financial statements", "Government's tax collection", "Bank's interest rate", "B"],
  ["Test checking involves examining a:", "Selected sample of transactions rather than all transactions", "Complete 100% of all transactions always", "Only cash transactions", "Only bank transactions", "A"],
  ["Audit sampling involves applying procedures to less than:", "1% of the population", "100% of the items in a population", "50% always", "10% always", "B"],
  ["An internal check system is a system of arranging duties so that no single person handles a transaction from:", "Start to finish alone", "Only the beginning", "Only the end", "No stage at all", "A"],
  ["An audit trail refers to the chain of documents/records that allows a transaction to be:", "Hidden", "Traced from its origin to the final financial statements", "Deleted", "Ignored", "B"],
  ["A qualified audit opinion is expressed when the auditor concludes that misstatements are:", "Material but not pervasive", "Immaterial", "Non-existent", "Only clerical", "A"],
  ["An unmodified (clean) audit opinion indicates that the financial statements:", "Are materially misstated", "Give a true and fair view in accordance with the applicable framework", "Were not examined", "Contain fraud", "B"],
  ["The auditor's report is primarily addressed to the:", "Government", "Members/shareholders of the company", "Employees only", "Competitors", "B"],
  ["An auditor examines vouchers primarily to verify the:", "Genuineness and accuracy of a transaction", "Company's dividend policy", "Employee salary structure", "GST rate", "A"],
  ["A 'window dressing' in accounts refers to manipulating financial statements to:", "Show a true financial position", "Present a more favourable (misleading) picture than reality", "Simplify audit work", "Reduce compliance costs", "B"],
  ["Fraud, as distinguished from error, involves:", "Unintentional mistakes", "An intentional act to deceive", "Only clerical errors", "Only rounding differences", "B"],
  ["An error in accounting records refers to an:", "Intentional act to deceive", "Unintentional mistake", "Act of theft", "Act of bribery", "B"],
  ["Continuous audit refers to an audit conducted:", "Only once a year at year end", "At regular intervals throughout the year", "Only when fraud is suspected", "Only by the Government", "B"],
];

const EXECUTIVE = [
  ["Before commencing an audit, the auditor generally prepares an:", "Advertisement", "Audit plan and programme", "Employee handbook", "Sales brochure", "B"],
  ["An audit programme lists the specific:", "Salary structure of employees", "Procedures to be applied to each area of the financial statements", "Marketing budget", "Government subsidies", "B"],
  ["Internal control is a process designed to provide reasonable assurance regarding reliability of financial reporting and:", "Maximisation of profit only", "Compliance with laws and effectiveness/efficiency of operations", "Guaranteed elimination of all risk", "Reduction of taxes only", "B"],
  ["Segregation of duties is an internal control aimed at preventing one person from having control over a transaction from:", "Initiation to final recording", "Only initiation", "Only recording", "Only reporting", "A"],
  ["A system of internal control is generally evaluated by the auditor through:", "Physical verification of stock only", "Enquiry, observation, inspection and walkthroughs", "Bank confirmation only", "Employee interviews only about salary", "B"],
  ["An Internal Control Questionnaire (ICQ) is used to:", "Record employee grievances", "Assess the adequacy of internal controls in specific areas", "Prepare the balance sheet", "File GST returns", "B"],
  ["A flowchart in an audit context is used to depict the:", "Company's organisation chart only", "Flow of a transaction/document through the internal control system", "Bank reconciliation", "Sales trend", "B"],
  ["Analytical procedures involve evaluating financial information through analysis of plausible relationships among:", "Only cash transactions", "Both financial and non-financial data", "Only bank transactions", "Only stock records", "B"],
  ["Analytical procedures are used at various stages of the audit, including:", "Only at the planning stage", "Planning, as substantive procedures, and overall review stages", "Only after the audit report is signed", "Never during fieldwork", "B"],
  ["Audit sampling methods include statistical and:", "Government-mandated sampling only", "Non-statistical (judgmental) sampling", "No other method exists", "Random guessing only", "B"],
  ["A representation letter is obtained by the auditor from the:", "Bank", "Management, confirming certain matters relevant to the audit", "Government", "Competitors", "B"],
  ["The auditor obtains written representations mainly to:", "Replace the need for audit evidence entirely", "Corroborate other audit evidence and document management's responsibility", "Reduce audit fees", "Avoid preparing working papers", "B"],
  ["Vouching of cash payments includes examining supporting documents such as:", "Sales invoices only", "Receipts, cash memos, and payment vouchers", "Balance sheet only", "Trial balance only", "B"],
  ["Vouching of purchases includes examining the:", "Sales register only", "Purchase invoice, goods received note, and purchase order", "Payroll register only", "Dividend register", "B"],
  ["Verification of fixed assets includes checking:", "Only the purchase invoice", "Existence, ownership, valuation and physical condition of the asset", "Only the depreciation rate", "Only the insurance policy", "B"],
  ["Verification of stock-in-trade generally involves:", "Only checking the ledger balance", "Physical verification and valuation as per accounting standards", "Only bank reconciliation", "Only sales register review", "B"],
  ["Verification of investments includes checking:", "Only their market value", "Existence, ownership, and proper valuation/classification", "Only their purchase date", "Only dividend income", "B"],
  ["Confirmation from debtors (accounts receivable) as an audit procedure is called:", "Vouching", "External confirmation", "Casting", "Footing", "B"],
  ["A 'positive' external confirmation request asks the recipient to reply:", "Only if they disagree with the stated amount", "Whether they agree or disagree with the stated information", "Never", "Only via phone call", "B"],
  ["A 'negative' external confirmation request asks the recipient to reply only if they:", "Agree with the amount", "Disagree with the stated amount", "Have no email address", "Are a related party", "B"],
  ["Observation, as an audit procedure, involves the auditor:", "Reading a document silently", "Watching a process or procedure being performed by others", "Calculating figures independently", "Sending a confirmation letter", "B"],
  ["Inspection, as an audit procedure, involves examining:", "Only oral statements", "Records, documents, or physical assets", "Only future budgets", "Only bank statements online", "B"],
  ["Recalculation, as an audit procedure, involves the auditor:", "Observing a physical count", "Checking the mathematical accuracy of documents/records", "Sending external confirmations", "Interviewing employees only", "B"],
  ["Reperformance involves the auditor independently executing procedures or controls that were originally performed by the:", "Government", "Entity's internal control", "Bank", "Auditor previously", "B"],
  ["Inquiry, as an audit procedure, involves seeking information from knowledgeable persons, both:", "Only financial personnel", "Financial and non-financial, within and outside the entity", "Only external auditors", "Only competitors", "B"],
  ["An audit note book is used by audit staff to record:", "Only the final report", "Points and queries to be discussed/clarified during the audit", "Employee payroll only", "Sales invoices only", "B"],
  ["A 'permanent' audit file typically contains information of continuing importance such as the:", "Current year's vouchers only", "Memorandum/Articles, and continuing engagement information", "Only the current audit programme", "Only this year's bank statements", "B"],
  ["A 'current' audit file typically contains information relevant to the:", "Company's entire history", "Current year's audit only", "Next five years' audit", "Only tax records", "B"],
  ["The purpose of audit documentation (working papers) includes providing evidence of the auditor's basis for a conclusion about achieving the overall:", "Sales target", "Objectives of the audit", "Tax planning", "Dividend policy", "B"],
  ["A subsequent events review examines events occurring between the balance sheet date and the:", "Date the company was incorporated", "Date of the auditor's report", "Date of the next AGM only", "Date of GST filing", "B"],
  ["A letter of weakness (management letter) is issued by the auditor to communicate:", "The audit fee only", "Deficiencies noted in internal control during the audit", "The final signed opinion only", "Bank loan terms", "B"],
  ["Bank audit typically covers verification of:", "Only cash balances", "Advances, deposits, and compliance with RBI guidelines", "Only fixed assets", "Only payroll", "B"],
  ["Stock audit is typically requested by:", "Employees for salary verification", "Banks to verify security/stock offered against loans", "The Government for tax purposes only", "Customers for warranty claims", "B"],
  ["A joint audit involves:", "A single auditor working alone", "Two or more auditors being jointly appointed to conduct the audit", "An audit by only internal staff", "An audit conducted without a report", "B"],
  ["Rotation of auditors (mandatory in certain companies) is intended to enhance:", "Audit fees", "Auditor independence", "Company profits", "Employee morale", "B"],
  ["The scope of an audit refers to the:", "Auditor's personal opinion on management", "Audit procedures considered necessary in the circumstances to achieve the objective", "Company's sales figures", "Bank loan amount", "B"],
  ["An audit assertion regarding whether recorded transactions actually occurred is the assertion of:", "Completeness", "Occurrence", "Valuation", "Presentation", "B"],
  ["An audit assertion regarding whether all transactions that should be recorded have been recorded is the assertion of:", "Occurrence", "Completeness", "Rights and obligations", "Classification", "B"],
  ["An audit assertion regarding whether assets/liabilities are recorded at appropriate amounts is the assertion of:", "Completeness", "Accuracy/Valuation", "Occurrence", "Existence", "B"],
  ["An audit assertion regarding whether the entity holds rights to assets and is obliged for liabilities is:", "Rights and obligations", "Occurrence", "Completeness", "Cut-off", "A"],
];

const INTERMEDIATE = [
  ["The Standards on Auditing (SAs) in India are issued by the:", "SEBI", "Institute of Chartered Accountants of India (ICAI)", "RBI", "MCA directly", "B"],
  ["SA 200 deals with:", "Audit documentation", "Overall objectives of the independent auditor", "Fraud and error", "Analytical procedures", "B"],
  ["SA 230 deals with:", "Audit documentation", "Materiality", "Related parties", "Going concern", "A"],
  ["SA 240 deals with the auditor's responsibilities relating to:", "Fraud in an audit of financial statements", "Analytical procedures", "External confirmations", "Written representations", "A"],
  ["SA 250 deals with consideration of:", "Laws and regulations in an audit", "Materiality", "Sampling", "Subsequent events", "A"],
  ["SA 315 deals with identifying and assessing the risks of material misstatement through understanding the:", "Entity and its environment", "Bank statements only", "Payroll register only", "Sales invoices only", "A"],
  ["SA 320 deals with:", "Materiality in planning and performing an audit", "Fraud", "Written representations", "Analytical procedures", "A"],
  ["SA 330 deals with the auditor's responses to:", "Assessed risks", "Going concern issues", "Related party transactions", "Subsequent events", "A"],
  ["SA 500 deals with:", "Audit evidence", "Audit sampling", "Analytical procedures", "Written representations", "A"],
  ["SA 501 deals with audit evidence regarding specific items, including:", "Inventory, litigation and claims, segment information", "Only cash balances", "Only payroll", "Only GST filings", "A"],
  ["SA 505 deals specifically with:", "External confirmations", "Analytical procedures", "Written representations", "Related parties", "A"],
  ["SA 510 deals with:", "Initial audit engagements - opening balances", "Subsequent events", "Fraud", "Sampling", "A"],
  ["SA 520 deals with:", "Analytical procedures", "Audit sampling", "Written representations", "Materiality", "A"],
  ["SA 530 deals with:", "Audit sampling", "Analytical procedures", "External confirmations", "Fraud", "A"],
  ["SA 550 deals with:", "Related parties", "Going concern", "Subsequent events", "Materiality", "A"],
  ["SA 560 deals with:", "Subsequent events", "Related parties", "Fraud", "Sampling", "A"],
  ["SA 570 deals with the auditor's responsibility regarding:", "Going concern", "Related parties", "Fraud", "Sampling", "A"],
  ["SA 580 deals with:", "Written representations", "External confirmations", "Materiality", "Analytical procedures", "A"],
  ["A going concern assumption implies the entity will continue its operations for the foreseeable future without an intention or necessity to:", "Expand", "Liquidate or cease operations", "Increase dividend", "Change auditors", "B"],
  ["Indicators of going concern doubt include:", "Consistently rising profits", "Recurring operating losses and negative net worth", "Timely payment of all debts", "Strong cash reserves", "B"],
  ["If the auditor concludes there is material uncertainty about going concern that is adequately disclosed, the report generally includes a:", "Qualified opinion always", "Material Uncertainty Related to Going Concern paragraph", "Adverse opinion always", "Disclaimer always", "B"],
  ["Related party transactions require specific audit attention mainly because they:", "Always involve fraud", "May not be conducted on an arm's length basis and require adequate disclosure", "Are always illegal", "Are irrelevant to financial reporting", "B"],
  ["Sufficient appropriate audit evidence relates to the quantity (sufficiency) and quality (appropriateness), which includes:", "Only relevance", "Relevance and reliability", "Only cost of obtaining it", "Only the auditor's opinion", "B"],
  ["Reliability of audit evidence is generally influenced by its source and:", "Colour of the paper", "Nature (e.g. written vs oral, original vs copy)", "Font size", "Length of the document", "B"],
  ["Audit evidence obtained directly by the auditor is generally considered more reliable than evidence obtained:", "From the entity's own records or third parties", "Indirectly or by inference", "From external confirmations", "From bank statements", "B"],
  ["Materiality is assessed in terms of both amount (quantitative) and:", "Colour coding", "Nature of the item (qualitative)", "Number of pages", "Date of transaction only", "B"],
  ["Performance materiality is set at an amount lower than overall materiality to reduce the probability of:", "Aggregate uncorrected/undetected misstatements exceeding materiality", "Audit fees being too low", "The audit taking too long", "The client being unhappy", "A"],
  ["An audit sample should be selected in a manner that provides a reasonable basis for the auditor to draw conclusions about the:", "Auditor's personal opinion", "Entire population from which the sample was drawn", "Government's tax policy", "Bank's lending rate", "B"],
  ["Sampling risk is the risk that the auditor's conclusion, based on a sample, may differ from the conclusion if the:", "Same sample were tested twice", "Entire population were subjected to the same procedure", "Client changed auditors", "Fees were increased", "B"],
  ["Non-sampling risk arises from factors that cause the auditor to reach an erroneous conclusion for reasons unrelated to:", "The audit fee", "Sample size", "The client's location", "Government policy", "B"],
  ["The auditor's responsibility for detecting fraud is to obtain reasonable assurance that the financial statements are free from material misstatement, whether caused by:", "Fraud or error", "Only fraud, never error", "Only error, never fraud", "Neither fraud nor error", "A"],
  ["Management override of controls is considered a significant fraud risk because management is often in a position to:", "Have no influence on financial records", "Manipulate accounting records and override otherwise effective controls", "Only affect payroll", "Only affect GST filings", "B"],
  ["Professional scepticism in an audit means the auditor maintains an attitude that includes a questioning mind and:", "Blind trust in management", "Critical assessment of audit evidence", "Ignoring inconsistent evidence", "Avoiding all documentation", "B"],
  ["Professional judgement in an audit refers to the application of relevant training, knowledge and experience in making informed decisions about the:", "Client's tax planning", "Courses of action appropriate in the audit circumstances", "Company's dividend policy", "Bank's interest rate", "B"],
  ["Compliance with the Code of Ethics for professional accountants is important primarily to maintain:", "Higher billing rates", "Independence, integrity and objectivity", "Faster completion of work", "Reduced documentation", "B"],
];

const EXPERT = [
  ["SA 700 deals with:", "Forming an opinion and reporting on financial statements", "Modified opinions", "Emphasis of matter paragraphs", "Comparative information", "A"],
  ["SA 701 deals with:", "Communicating key audit matters in the auditor's report", "Modified opinions", "Comparative information", "Group audits", "A"],
  ["SA 705 deals with:", "Modifications to the opinion in the independent auditor's report", "Key audit matters", "Related parties", "Subsequent events", "A"],
  ["SA 706 deals with:", "Emphasis of Matter and Other Matter paragraphs", "Key audit matters", "Modified opinions", "Group audits", "A"],
  ["SA 710 deals with:", "Comparative information - corresponding figures and comparative financial statements", "Key audit matters", "Fraud", "Going concern", "A"],
  ["SA 720 deals with the auditor's responsibilities relating to:", "Other information in documents containing audited financial statements", "Key audit matters", "Group audits", "Related parties", "A"],
  ["A qualified opinion is expressed when misstatements are material but not:", "Immaterial", "Pervasive", "Related to related parties", "Related to going concern", "B"],
  ["An adverse opinion is expressed when misstatements are both material and:", "Immaterial", "Pervasive", "Minor", "Unrelated to the financial statements", "B"],
  ["A disclaimer of opinion is expressed when the auditor is unable to obtain sufficient appropriate audit evidence and the possible effects are material and:", "Immaterial", "Pervasive", "Nil", "Only clerical", "B"],
  ["Key Audit Matters (KAM) are those matters that, in the auditor's professional judgement, were of most significance in the audit of the:", "Prior year only", "Current period financial statements", "Auditor's personal accounts", "Bank's records", "B"],
  ["KAM reporting under SA 701 is mandatory primarily for audits of:", "All entities without exception", "Listed entities (and voluntarily/as required for others)", "Only private companies", "Only sole proprietorships", "B"],
  ["An Emphasis of Matter paragraph is used to draw users' attention to a matter that is:", "Materially misstated", "Appropriately presented/disclosed but fundamental to users' understanding", "A modification of opinion", "A key audit matter always", "B"],
  ["An Other Matter paragraph refers to a matter, other than those in the financial statements, that is relevant to users' understanding of the:", "Company's tax return", "Audit, the auditor's responsibilities, or the auditor's report", "Bank loan agreement", "Payroll structure", "B"],
  ["Group audits, where the group engagement team uses the work of component auditors, are dealt with under:", "SA 600", "SA 610", "SA 620", "SA 720", "A"],
  ["Using the work of internal auditors is dealt with under:", "SA 600", "SA 610", "SA 620", "SA 700", "B"],
  ["Using the work of an auditor's expert is dealt with under:", "SA 600", "SA 610", "SA 620", "SA 710", "C"],
  ["CARO (Companies Auditor's Report Order) requires auditors to report on specified additional matters for certain classes of:", "Individuals", "Companies", "Partnership firms only", "Trusts only", "B"],
  ["Internal Financial Controls over Financial Reporting (ICFR) reporting by auditors of certain companies is required under the:", "Income Tax Act", "Companies Act, 2013", "GST Act", "SEBI Act only", "B"],
  ["ICFR primarily evaluates whether a company's internal controls provide reasonable assurance regarding the reliability of:", "Sales targets", "Financial reporting", "Employee attendance", "Marketing plans", "B"],
  ["A peer review of a practising Chartered Accountant's audit work is conducted under guidelines issued by the:", "SEBI", "ICAI", "RBI", "MCA", "B"],
  ["The primary objective of peer review is to ensure that members comply with:", "Government tax policy", "Technical, professional and ethical standards in their practice", "Bank lending norms", "Only GST rules", "B"],
  ["Forensic audit is generally conducted to investigate:", "Routine annual compliance", "Suspected fraud or financial irregularities in detail", "Only GST returns", "Only payroll processing", "B"],
  ["A forensic auditor's report is often used as evidence in:", "Routine board meetings only", "Legal proceedings or investigations", "Marketing presentations", "Employee appraisals", "B"],
  ["Cut-off procedures in an audit ensure transactions are recorded in the:", "Wrong accounting period intentionally", "Correct accounting period", "General ledger only, ignoring dates", "Bank statement only", "B"],
  ["Auditing in a Computerised Information System (CIS) environment often uses techniques such as:", "Manual vouching only", "Computer Assisted Audit Techniques (CAATs)", "Physical stock count only", "Bank confirmation only", "B"],
  ["Data analytics in modern audits is increasingly used to analyse:", "Only a small manual sample", "Large volumes of data to identify patterns, trends and anomalies", "Only handwritten vouchers", "Only cash vouchers", "B"],
  ["An auditor's report that is 'modified' includes qualified, adverse, or:", "Unmodified opinions", "Disclaimer of opinion", "Clean report only", "No report at all", "B"],
  ["Corporate governance audits/reviews often assess compliance with:", "Only tax laws", "Board composition, committees, and disclosure requirements", "Only sales targets", "Only payroll structures", "B"],
  ["An audit committee, distinct from the auditor, is a board-level committee primarily responsible for oversight of:", "Marketing strategy", "Financial reporting and the audit process", "HR recruitment", "IT infrastructure only", "B"],
  ["The concept of 'true and fair view' in an audit opinion means the financial statements are:", "Literally exact to the last rupee with no estimates", "Free from material misstatement and present information fairly", "Approved by the Government", "Prepared only in cash basis", "B"],
  ["An audit conducted where the auditor examines the propriety, efficiency, and economy of management decisions is a(n):", "Statutory audit", "Management/operational audit", "Tax audit", "Stock audit", "B"],
  ["Environmental and social audits (increasingly relevant with ESG reporting) examine an entity's compliance and performance regarding:", "Only financial statements", "Environmental, social and governance matters", "Only payroll", "Only GST", "B"],
  ["Continuous improvement of audit quality is often supported within a firm through a:", "Marketing department", "System of Quality Control / Quality Management as per applicable standards", "Sales department", "HR department alone", "B"],
  ["An audit firm's engagement quality review (for certain engagements) is intended to provide an objective evaluation of significant judgements made by the:", "Client's management", "Engagement team, before the report is issued", "Government", "Bank", "B"],
  ["The concept of 'professional scepticism' combined with 'professional judgement' together support the auditor in reaching:", "Predetermined conclusions favouring the client", "Reasonable, well-founded conclusions based on evidence", "Conclusions without any evidence", "Conclusions dictated by management", "B"],
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
  console.log('Audit question bank:', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`Audit area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
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
    console.log(`Deleted ${del.rowCount} old Audit questions; inserted ${inserted} new (area_id ${areaId}).`);
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
