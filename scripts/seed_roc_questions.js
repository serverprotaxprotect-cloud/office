require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// ROC / company secretarial compliance question bank — original MCQs authored
// from the Companies Act 2013 and MCA e-form practice, answers verified.
// Format: [q, A, B, C, D, correct]. Target org GB-001 (id 1), area "ROC".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'roc';

const INTERN = [
  ["ROC stands for:", "Registrar of Companies", "Register of Compliance", "Regulator of Corporates", "Registry of Contracts", "A"],
  ["The Ministry that administers company law in India is the:", "Ministry of Finance", "Ministry of Corporate Affairs", "Ministry of Commerce", "Ministry of Law", "B"],
  ["Companies in India are governed by the:", "Companies Act, 1956", "Companies Act, 2013", "Partnership Act, 1932", "Contract Act, 1872", "B"],
  ["DIN stands for:", "Director Identification Number", "Directors Income Number", "Digital Identity Number", "Document Index Number", "A"],
  ["DSC stands for:", "Digital Signature Certificate", "Director Signing Code", "Document Security Code", "Digital Security Certificate", "A"],
  ["CIN stands for:", "Company Index Number", "Corporate Identity Number", "Central Incorporation Number", "Certified Identity Number", "B"],
  ["The minimum number of directors in a private company is:", "1", "2", "3", "7", "B"],
  ["The minimum number of directors in a public company is:", "2", "3", "5", "7", "B"],
  ["The minimum number of directors in a One Person Company is:", "1", "2", "3", "0", "A"],
  ["The maximum number of directors a company can have without a special resolution is:", "10", "12", "15", "20", "C"],
  ["OPC stands for:", "Open Public Company", "One Person Company", "Ordinary Private Company", "Overseas Parent Company", "B"],
  ["The minimum number of members in a private company is:", "1", "2", "7", "50", "B"],
  ["The maximum number of members in a private company is:", "50", "100", "200", "Unlimited", "C"],
  ["The minimum number of members in a public company is:", "2", "3", "7", "50", "C"],
  ["A company is incorporated by filing which form?", "SPICe+ (INC-32)", "MGT-7", "AOC-4", "DIR-12", "A"],
  ["A DIN (Director Identification Number) consists of how many digits?", "6", "8", "10", "12", "B"],
  ["Which document contains the objects for which a company is formed?", "Articles of Association", "Memorandum of Association", "Prospectus", "Annual Return", "B"],
  ["Which document contains the rules for the internal management of a company?", "Memorandum of Association", "Articles of Association", "Balance Sheet", "Board Report", "B"],
  ["The Certificate of Incorporation of a company is issued by the:", "SEBI", "Registrar of Companies", "Income Tax Department", "RBI", "B"],
  ["A company is best described as a(n):", "Natural person", "Artificial person created by law", "Partnership firm", "Sole proprietorship", "B"],
  ["In a company limited by shares, the liability of a member is limited to:", "The company's total debts", "The unpaid amount on his shares", "His personal assets", "Nil", "B"],
  ["The MCA portal used for company e-filings is:", "www.incometax.gov.in", "www.mca.gov.in (MCA21)", "www.gst.gov.in", "www.epfindia.gov.in", "B"],
  ["The name of a private limited company must end with the words:", "Limited", "Private Limited", "and Company", "Corporation", "B"],
  ["The name of a public limited company must end with the word:", "Private Limited", "Limited", "LLP", "and Sons", "B"],
  ["The minimum paid-up capital prescribed for a private company under current law is:", "1 lakh", "5 lakh", "No minimum prescribed", "10 lakh", "C"],
  ["DIR-3 KYC is filed for the:", "KYC of a company", "KYC of a director", "KYC of an auditor", "KYC of a shareholder", "B"],
  ["The annual last date for filing DIR-3 KYC is:", "31st March", "30th June", "30th September", "31st December", "C"],
  ["A company must have a registered office within how many days of incorporation?", "15 days", "30 days", "60 days", "90 days", "B"],
  ["The e-form used to intimate a change of registered office within the same city is:", "INC-20A", "INC-22", "DIR-12", "MGT-7", "B"],
  ["The first auditor of a company is appointed by the:", "Members at AGM", "Board of Directors", "Central Government", "Registrar", "B"],
  ["The first auditor must be appointed within how many days of incorporation?", "15 days", "30 days", "60 days", "90 days", "B"],
  ["Financial statements are filed with the ROC in which form?", "MGT-7", "AOC-4", "ADT-1", "DIR-12", "B"],
  ["The annual return is filed with the ROC in which form?", "AOC-4", "MGT-7", "PAS-3", "CHG-1", "B"],
  ["A company reserves its proposed name through:", "AOC-4", "SPICe+ Part A (or RUN)", "DIR-3", "ADT-1", "B"],
  ["A Corporate Identity Number (CIN) has how many characters?", "15", "18", "21", "25", "C"],
  ["Which of the following is NOT a type of company under the Companies Act, 2013?", "Private company", "Public company", "One Person Company", "Sole proprietorship", "D"],
  ["The declaration for commencement of business is filed in form:", "INC-20A", "INC-22", "MGT-14", "SH-7", "A"],
  ["The document that invites the public to subscribe to a company's shares is a:", "Prospectus", "Memorandum", "Voucher", "Charge", "A"],
  ["A company having a single member is called a(n):", "Private company", "Public company", "One Person Company", "Section 8 company", "C"],
  ["A not-for-profit company formed for charitable objects is registered under:", "Section 8", "Section 2(68)", "Section 135", "Section 248", "A"],
];

const EXECUTIVE = [
  ["The e-form AOC-4 is used for filing the:", "Annual return", "Financial statements", "Charge details", "Auditor appointment", "B"],
  ["The e-form MGT-7 is used for filing the:", "Financial statements", "Annual return", "Return of allotment", "Board resolution", "B"],
  ["AOC-4 must be filed within how many days of the AGM?", "15 days", "30 days", "60 days", "90 days", "B"],
  ["MGT-7 must be filed within how many days of the AGM?", "30 days", "45 days", "60 days", "90 days", "C"],
  ["Appointment, resignation or change of directors is filed in form:", "DIR-3", "DIR-11", "DIR-12", "ADT-1", "C"],
  ["DIR-12 must be filed within how many days of the change?", "15 days", "30 days", "45 days", "60 days", "B"],
  ["The appointment of an auditor by the company is intimated to the ROC in form:", "ADT-1", "ADT-3", "AOC-4", "MGT-14", "A"],
  ["ADT-1 must be filed within how many days of the auditor's appointment?", "15 days", "30 days", "45 days", "60 days", "A"],
  ["The minimum number of board meetings a company must hold in a year is:", "2", "3", "4", "6", "C"],
  ["The maximum gap allowed between two consecutive board meetings is:", "90 days", "120 days", "180 days", "365 days", "B"],
  ["One Person Companies and small companies file their annual return in form:", "MGT-7", "MGT-7A", "MGT-9", "MGT-14", "B"],
  ["Which section of the Companies Act, 2013 governs the annual return?", "Section 92", "Section 96", "Section 137", "Section 173", "A"],
  ["Which section governs the filing of financial statements with the ROC?", "Section 92", "Section 96", "Section 137", "Section 149", "C"],
  ["Which section governs the Annual General Meeting (AGM)?", "Section 92", "Section 96", "Section 137", "Section 173", "B"],
  ["Which section governs board meetings?", "Section 96", "Section 137", "Section 149", "Section 173", "D"],
  ["Certain resolutions are filed with the ROC in form:", "MGT-7", "MGT-14", "AOC-4", "PAS-3", "B"],
  ["MGT-14 is generally filed within how many days of passing the resolution?", "15 days", "30 days", "45 days", "60 days", "B"],
  ["The declaration of commencement of business (INC-20A) must be filed within:", "30 days of incorporation", "90 days of incorporation", "180 days of incorporation", "1 year of incorporation", "C"],
  ["A director filing the notice of his own resignation with the ROC uses form:", "DIR-12", "DIR-11", "DIR-3", "DIR-6", "B"],
  ["E-forms filed on the MCA portal must be signed using a:", "PAN", "Digital Signature Certificate (DSC)", "Aadhaar OTP only", "Bank token", "B"],
  ["A subsequent auditor is generally appointed for a term of:", "1 year", "3 years", "5 years", "10 years", "C"],
  ["A subsequent auditor is appointed by the:", "Board of Directors", "Members at the AGM", "Central Government", "Registrar", "B"],
  ["The first AGM of a company must be held within how many months of the end of its first financial year?", "6 months", "9 months", "12 months", "15 months", "B"],
  ["A subsequent AGM must be held within how many months of the end of the financial year?", "3 months", "6 months", "9 months", "12 months", "B"],
  ["The gap between two AGMs must not exceed:", "12 months", "15 months", "18 months", "24 months", "B"],
  ["The return of deposits is filed with the ROC in form:", "DPT-3", "PAS-3", "MSME-1", "CHG-1", "A"],
  ["DPT-3 (return of deposits) is filed annually by:", "31st March", "30th June", "30th September", "31st December", "B"],
  ["The half-yearly return for outstanding dues to MSME suppliers is filed in form:", "MSME-1", "DPT-3", "MGT-7", "AOC-4", "A"],
  ["The return of allotment of shares is filed in form:", "SH-7", "PAS-3", "CHG-1", "MGT-14", "B"],
  ["KMP stands for:", "Key Managerial Personnel", "Known Managing Partner", "Key Money Provision", "Kept Money Payment", "A"],
  ["Which section governs the appointment of Key Managerial Personnel?", "Section 149", "Section 173", "Section 203", "Section 92", "C"],
  ["A whole-time company secretary of a company is classified as a:", "Auditor", "Key Managerial Personnel (KMP)", "Independent director", "Promoter", "B"],
  ["Financial statements in XBRL format are filed in form:", "AOC-4", "AOC-4 XBRL", "AOC-4 CFS", "MGT-7", "B"],
  ["Consolidated financial statements are filed with the ROC in form:", "AOC-4", "AOC-4 XBRL", "AOC-4 CFS", "MGT-7", "C"],
  ["The Directors' Report is attached to which annual filing?", "MGT-7", "AOC-4 (financial statements)", "ADT-1", "DIR-12", "B"],
  ["The Board's Report of a company is approved by the:", "Auditors", "Board of Directors", "Registrar", "Shareholders directly", "B"],
  ["The Register of Members is required to be maintained under:", "Section 88", "Section 92", "Section 137", "Section 173", "A"],
  ["The web-based KYC of a director who already holds a DIN (no change in details) is done through:", "DIR-3", "DIR-3 KYC (Web)", "DIR-12", "INC-22", "B"],
  ["A company must file its financial statements with the ROC:", "Only if it made a profit", "Only if it is listed", "Even if it had no business during the year", "Only once in five years", "C"],
  ["The resignation of an auditor is filed with the ROC (by the auditor) in form:", "ADT-1", "ADT-3", "MGT-14", "DIR-11", "B"],
];

const INTERMEDIATE = [
  ["The creation or modification of a charge on a company's assets is filed in form:", "CHG-1", "CHG-4", "PAS-3", "SH-7", "A"],
  ["CHG-1 must be filed within how many days of creation of the charge?", "15 days", "30 days", "60 days", "90 days", "B"],
  ["The satisfaction of a charge is filed with the ROC in form:", "CHG-1", "CHG-4", "CHG-8", "PAS-3", "B"],
  ["A charge in company law refers to:", "A penalty imposed by ROC", "A security or mortgage on the company's assets for a loan", "A director's remuneration", "A type of share", "B"],
  ["The return of allotment (PAS-3) is filed within how many days of the allotment of shares?", "15 days", "30 days", "45 days", "60 days", "B"],
  ["An increase in the authorised share capital of a company is filed in form:", "SH-7", "PAS-3", "CHG-1", "INC-22", "A"],
  ["Shifting the registered office from one state to another requires approval of the:", "Registrar only", "Regional Director / Central Government", "Auditor", "Bank", "B"],
  ["Changing the name of a company requires:", "Only a board resolution", "A special resolution and Central Government approval", "Only ROC intimation", "No approval", "B"],
  ["A private company is defined under which section of the Companies Act, 2013?", "Section 2(68)", "Section 2(71)", "Section 2(85)", "Section 2(62)", "A"],
  ["A public company is defined under which section?", "Section 2(68)", "Section 2(71)", "Section 2(85)", "Section 2(62)", "B"],
  ["A One Person Company is defined under which section?", "Section 2(68)", "Section 2(71)", "Section 2(62)", "Section 2(85)", "C"],
  ["A small company is defined under which section?", "Section 2(68)", "Section 2(71)", "Section 2(85)", "Section 2(62)", "C"],
  ["The provisions regarding the registered office of a company are contained in:", "Section 10A", "Section 12", "Section 92", "Section 137", "B"],
  ["The requirement to file a declaration of commencement of business is in:", "Section 10A", "Section 12", "Section 96", "Section 149", "A"],
  ["The appointment of auditors is governed by which section?", "Section 139", "Section 140", "Section 149", "Section 177", "A"],
  ["The removal of an auditor before term is governed by which section?", "Section 139", "Section 140", "Section 149", "Section 173", "B"],
  ["An alteration of the Memorandum of Association requires a(n):", "Ordinary resolution", "Special resolution", "Board resolution only", "Circular resolution", "B"],
  ["An alteration of the Articles of Association requires a(n):", "Ordinary resolution", "Special resolution", "Board resolution only", "No resolution", "B"],
  ["A special resolution is passed by a majority of at least:", "51%", "66%", "75%", "90%", "C"],
  ["An ordinary resolution requires a majority of:", "More than 50% (simple majority)", "At least 75%", "At least 90%", "100% (unanimous)", "A"],
  ["The return of deposits in DPT-3 also covers:", "Only secured deposits", "Outstanding money/loans not treated as deposits", "Only director loans", "Share capital", "B"],
  ["The return of Significant Beneficial Owners is filed in form:", "BEN-1", "BEN-2", "MGT-6", "PAS-3", "B"],
  ["The provisions relating to Significant Beneficial Owners are in which section?", "Section 88", "Section 89", "Section 90", "Section 92", "C"],
  ["The Register of Charges is maintained under which section?", "Section 85", "Section 88", "Section 92", "Section 128", "A"],
  ["Board meetings of a company may be held:", "Only physically", "Only by video conferencing", "Physically or through video conferencing", "Only by circulation", "C"],
  ["A disclosure of interest by a director is required under which section?", "Section 184", "Section 188", "Section 203", "Section 90", "A"],
  ["A director gives his disclosure of interest to the Board in form:", "MBP-1", "DIR-8", "DIR-2", "INC-9", "A"],
  ["The e-form for verification of the registered office after incorporation is:", "INC-20A", "INC-22", "INC-9", "SPICe+", "B"],
  ["The KYC e-form for tagging a company as active (with its registered office) is:", "INC-22A (ACTIVE)", "INC-20A", "DIR-3 KYC", "AOC-4", "A"],
  ["If a company does not hold its AGM, the annual return is filed within 60 days from the:", "End of the financial year", "Date on which the AGM should have been held", "Date of incorporation", "Date of the last board meeting", "B"],
  ["The responsibility to file ADT-1 (auditor appointment) lies with the:", "Auditor", "Company", "Central Government", "Shareholders", "B"],
  ["A company can accept deposits from its members subject to the:", "SEBI Regulations", "Companies (Acceptance of Deposits) Rules", "Income Tax Act", "FEMA", "B"],
  ["A resolution passed by circulation is valid for:", "All matters without exception", "Matters not specifically required to be decided at a meeting", "Only the AGM", "Only charge creation", "B"],
  ["The e-form to intimate the appointment of a cost auditor is:", "CRA-2", "CRA-4", "ADT-1", "MGT-14", "A"],
  ["The Register of Members is closed (book closure) by giving notice under:", "Section 88", "Section 91", "Section 96", "Section 137", "B"],
];

const EXPERT = [
  ["The application by a company for striking off (removal of its name) is filed in form:", "STK-1", "STK-2", "INC-22", "MGT-7", "B"],
  ["The ROC's power to remove the name of a company from the register is under which section?", "Section 230", "Section 248", "Section 252", "Section 271", "B"],
  ["LLP stands for:", "Local Limited Partnership", "Limited Liability Partnership", "Large Listed Partnership", "Long-term Loan Provider", "B"],
  ["An LLP is governed by the:", "Companies Act, 2013", "Partnership Act, 1932", "Limited Liability Partnership Act, 2008", "Contract Act, 1872", "C"],
  ["The annual return of an LLP is filed in:", "Form 8", "Form 11", "MGT-7", "AOC-4", "B"],
  ["The LLP annual return (Form 11) is due by:", "30th May", "30th June", "30th September", "30th October", "A"],
  ["The Statement of Account and Solvency of an LLP is filed in:", "Form 8", "Form 11", "FiLLiP", "Form 3", "A"],
  ["The LLP Statement of Account and Solvency (Form 8) is due by:", "30th May", "30th June", "30th September", "30th October", "D"],
  ["An LLP is incorporated by filing form:", "SPICe+", "FiLLiP", "INC-32", "Form 11", "B"],
  ["CSR stands for:", "Corporate Statutory Return", "Corporate Social Responsibility", "Company Share Register", "Central Statutory Rule", "B"],
  ["CSR obligations of a company are governed by which section?", "Section 135", "Section 149", "Section 177", "Section 188", "A"],
  ["The report on Corporate Social Responsibility is filed with the ROC in form:", "CSR-1", "CSR-2", "MGT-7", "AOC-4", "B"],
  ["An entity wishing to undertake CSR activities on behalf of companies registers in form:", "CSR-1", "CSR-2", "BEN-2", "MSC-1", "A"],
  ["A company that is not carrying on any business may apply to be classified as a:", "Dormant company", "Nidhi company", "Producer company", "Section 8 company", "A"],
  ["The application to obtain the status of a dormant company is filed in form:", "MSC-1", "MSC-3", "STK-2", "INC-22", "A"],
  ["NCLT stands for:", "National Corporate Law Tribunal", "National Company Law Tribunal", "National Court of Legal Trials", "New Companies Legal Tribunal", "B"],
  ["The buy-back of shares by a company is governed by which section?", "Section 62", "Section 63", "Section 68", "Section 71", "C"],
  ["The issue of bonus shares is governed by which section?", "Section 62", "Section 63", "Section 68", "Section 42", "B"],
  ["A reduction of share capital by a company requires the approval of the:", "Registrar", "Regional Director", "NCLT (Tribunal)", "SEBI", "C"],
  ["Loans to directors are regulated by which section?", "Section 185", "Section 186", "Section 188", "Section 180", "A"],
  ["Loans and investments by a company are regulated by which section?", "Section 185", "Section 186", "Section 188", "Section 179", "B"],
  ["XBRL stands for:", "eXtensible Business Reporting Language", "eXtended Balance Review Ledger", "eXternal Business Record List", "eXtensible Balance Reporting Layout", "A"],
  ["A private company must appoint a whole-time company secretary if its paid-up capital is at least:", "2 crore", "5 crore", "10 crore", "50 crore", "C"],
  ["An Audit Committee of the Board is required to be constituted under which section?", "Section 149", "Section 177", "Section 178", "Section 203", "B"],
  ["The Nomination and Remuneration Committee is required under which section?", "Section 177", "Section 178", "Section 135", "Section 149", "B"],
  ["The maximum number of companies in which a person can be a director is:", "10", "15", "20", "25", "C"],
  ["Out of the total directorships allowed, the maximum number of public companies is:", "5", "10", "15", "20", "B"],
  ["A person can hold how many DINs (Director Identification Numbers) at a time?", "Only one", "Two", "One per company", "Unlimited", "A"],
  ["Related party transactions are governed by which section?", "Section 184", "Section 188", "Section 186", "Section 177", "B"],
  ["The CSR thresholds (any one) are net worth 500 crore, or turnover 1000 crore, or net profit of at least:", "1 crore", "2 crore", "5 crore", "10 crore", "C"],
  ["Producer companies are governed by which part/chapter of the Companies Act?", "Chapter III", "Part IXA / Chapter XXIA", "Chapter VII", "Part I", "B"],
  ["A Nidhi company is regulated under Section 406 and the:", "Nidhi Rules", "Deposit Rules", "SEBI Regulations", "FEMA Rules", "A"],
  ["The compounding of certain offences (based on the amount) is done by the:", "ROC only", "NCLT or Regional Director", "High Court", "SEBI", "B"],
  ["Companies required to file financial statements in XBRL include:", "All private companies", "Listed companies and certain prescribed companies", "Only OPCs", "Only LLPs", "B"],
  ["The scheme of merger or amalgamation of companies is approved by the:", "Registrar", "NCLT (Tribunal)", "SEBI", "Central Government only", "B"],
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
  console.log('ROC question bank:', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`ROC area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
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
    console.log(`Deleted ${del.rowCount} old ROC questions; inserted ${inserted} new (area_id ${areaId}).`);
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
