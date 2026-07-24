require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Company Law question bank — original MCQs on the substantive/conceptual
// side of the Companies Act 2013 (definitions, capital, meetings, directors'
// duties, winding up, governance) — distinct in focus from the ROC area,
// which covers MCA forms and filing practice. Answers verified.
// Format: [q, A, B, C, D, correct]. Target org GB-001 (id 1), area
// "Company Law".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'company law';

const INTERN = [
  ["A company is defined as an artificial person created by:", "Birth", "Law (registration)", "Contract only", "Custom", "B"],
  ["A company has which of the following characteristics?", "Unlimited liability always", "Perpetual succession", "No separate legal identity", "Cannot own property", "B"],
  ["The concept that a company continues to exist irrespective of changes in its membership is called:", "Limited liability", "Perpetual succession", "Common seal", "Separate property", "B"],
  ["The famous case that established a company as a separate legal entity is:", "Salomon v Salomon & Co Ltd", "Foss v Harbottle", "Royal British Bank v Turquand", "Donoghue v Stevenson", "A"],
  ["A company limited by guarantee is one where members' liability is limited to:", "Their share capital", "A guaranteed amount in the memorandum", "Unlimited amount", "Nil", "B"],
  ["In a company limited by shares, a member's liability is limited to the:", "Company's total debts", "Unpaid amount on his shares", "Guaranteed amount", "Market value of shares", "B"],
  ["An unlimited company is one where the liability of members is:", "Limited to shares", "Limited to a guarantee", "Unlimited", "Nil", "C"],
  ["A holding company is one that controls the composition of the board of a:", "Subsidiary company", "Government company", "Foreign company", "Listed company", "A"],
  ["A subsidiary company is one in which the holding company controls more than:", "25% of shares", "One-half of the total voting power", "10% of shares", "75% of shares", "B"],
  ["A government company is one in which not less than __ of paid-up share capital is held by the Government:", "26%", "49%", "51%", "74%", "C"],
  ["A foreign company is a company incorporated outside India that has a place of business:", "Nowhere in India", "In India", "Only in a Special Economic Zone", "Only through an agent abroad", "B"],
  ["A listed company is one whose securities are listed on a:", "Bank", "Recognised stock exchange", "Government registry", "Private ledger", "B"],
  ["Promoters of a company are persons who:", "Only invest as passive shareholders", "Take the initial steps to form and set up the company", "Are appointed as auditors", "Are always directors", "B"],
  ["A promoter owes a fiduciary duty to the company, meaning they must act:", "In their own interest", "In good faith and for the company's benefit", "Only as instructed by banks", "Without any duty", "B"],
  ["The Memorandum of Association is often called the company's:", "Internal rulebook", "Charter document", "Balance sheet", "Annual report", "B"],
  ["The clause in the Memorandum that states the company's objects is the:", "Name clause", "Objects clause", "Capital clause", "Liability clause", "B"],
  ["The clause in the Memorandum that fixes the authorised share capital is the:", "Objects clause", "Capital clause", "Situation clause", "Subscription clause", "B"],
  ["The clause stating the state in which the registered office is situated is the:", "Objects clause", "Capital clause", "Situation clause", "Liability clause", "C"],
  ["The Articles of Association govern the:", "Company's objects", "Internal management of the company", "Relationship with creditors only", "Government policy", "B"],
  ["In case of a conflict, which prevails between the Memorandum and Articles?", "Articles always", "Memorandum always", "Whichever is filed first", "Neither applies", "B"],
  ["A prospectus is essentially an invitation to the public to:", "Buy the company's products", "Subscribe to the company's securities", "Attend the AGM", "Inspect the registered office", "B"],
  ["A document containing an offer of securities to a select group is a:", "Prospectus", "Private placement offer letter", "Annual return", "Balance sheet", "B"],
  ["A shelf prospectus is used for:", "A one-time single issue", "Multiple issues of securities over a period", "Only debentures", "Only bonus shares", "B"],
  ["Equity share capital carries:", "Fixed dividend always", "Voting rights", "No risk", "Guaranteed redemption", "B"],
  ["Preference shares generally carry a preferential right regarding:", "Voting only", "Payment of dividend and repayment of capital", "Management control", "Board appointment", "B"],
  ["Preference shares generally carry voting rights:", "On all matters like equity shares", "Only on matters directly affecting their rights", "Never", "Only in winding up", "B"],
  ["A company can issue shares at a discount:", "Freely", "Only as sweat equity shares, subject to conditions", "To any employee without conditions", "To promoters only", "B"],
  ["The reserve created when shares are issued at a premium is the:", "General reserve", "Securities premium", "Capital redemption reserve", "Revaluation reserve", "B"],
  ["Bonus shares are issued to shareholders:", "For consideration in cash", "Without any payment, out of free reserves/premium", "Only to directors", "Only to the public", "B"],
  ["A private placement is an offer of securities made to a select group of persons, not exceeding:", "20 persons", "50 persons in a financial year", "200 persons in a financial year", "500 persons", "C"],
  ["Debentures represent:", "Ownership capital", "A form of borrowed/loan capital", "Reserves", "Goodwill", "B"],
  ["A debenture holder is a company's:", "Owner", "Creditor", "Employee", "Auditor", "B"],
  ["Convertible debentures can be converted into:", "Cash only", "Equity shares", "Preference shares only", "Goodwill", "B"],
  ["A company incorporated for charitable or non-profit objects (without adding 'Limited') is a:", "Private company", "Public company", "Section 8 company", "Government company", "C"],
  ["The minimum number of subscribers to the memorandum of a private company is:", "1", "2", "3", "7", "B"],
  ["The minimum number of subscribers to the memorandum of a public company is:", "2", "3", "7", "5", "C"],
  ["A One Person Company can have only:", "One member", "Two members", "One director only, no members", "Unlimited members", "A"],
  ["A company's registered office is the place where its:", "Factory is located", "Statutory records are maintained and official communications are received", "Directors reside", "Bank account is held", "B"],
  ["The common seal of a company, where used, represents its:", "Signature substitute for official documents", "Financial statement", "Trademark", "Logo for marketing", "A"],
  ["A company's separate legal personality means it can sue and be sued in its:", "Directors' names", "Own name", "Shareholders' names", "Auditor's name", "B"],
];

const EXECUTIVE = [
  ["A member of a company is a person whose name is entered in the:", "Register of Charges", "Register of Members", "Register of Directors", "Minutes book", "B"],
  ["A shareholder becomes a member of the company upon:", "Mere purchase of shares in the open market", "Entry of their name in the Register of Members", "Attending one meeting", "Payment of dividend", "B"],
  ["Transfer of shares occurs through a:", "Voluntary act of the parties (buyer and seller)", "Operation of law only", "Court order only", "Government notification", "A"],
  ["Transmission of shares occurs by:", "Voluntary sale", "Operation of law (e.g. death or insolvency of a member)", "Board resolution only", "AGM notice", "B"],
  ["The instrument used for transfer of shares is the:", "Share certificate", "Securities Transfer Form (SH-4)", "Dividend warrant", "Debenture trust deed", "B"],
  ["A share certificate is prima facie evidence of a member's:", "Liability", "Title to the shares", "Directorship", "Salary", "B"],
  ["A duplicate share certificate is issued when the original is:", "Sold", "Lost, destroyed or defaced", "Transferred normally", "Cancelled by the auditor", "B"],
  ["Dividend can be declared by a company out of its:", "Share capital", "Profits (current or free reserves)", "Secured loans", "Unsecured deposits", "B"],
  ["A dividend, once declared at the AGM, becomes a:", "Discretionary payment", "Debt due to the shareholder", "Gift", "Loan to the company", "B"],
  ["Unpaid or unclaimed dividend is transferred, after the prescribed period, to the:", "Company's general reserve", "Unpaid Dividend Account and later to the IEPF", "Government treasury directly", "Director's account", "B"],
  ["An interim dividend is declared:", "Only at the AGM by shareholders", "By the Board of Directors between two AGMs", "By the auditor", "By the Registrar", "B"],
  ["A general meeting of a company's shareholders is called a(n):", "Board meeting", "General meeting", "Committee meeting", "Departmental meeting", "B"],
  ["The Annual General Meeting is a meeting of the:", "Board of Directors", "Members/shareholders", "Auditors", "Employees", "B"],
  ["A meeting other than the AGM is called a(n):", "Extraordinary General Meeting (EGM)", "Statutory meeting", "Class meeting only", "Board meeting", "A"],
  ["The minimum clear notice period for a general meeting is generally:", "7 days", "14 days", "21 days", "30 days", "C"],
  ["Shorter notice for a general meeting can be given with the consent of members holding at least:", "Simple majority in number", "51% of paid-up capital", "95% of paid-up capital giving a right to vote", "100% always", "C"],
  ["A resolution requiring a simple majority (more than 50%) is called a(n):", "Special resolution", "Ordinary resolution", "Unanimous resolution", "Board resolution", "B"],
  ["A resolution requiring at least three-fourths majority is called a(n):", "Ordinary resolution", "Special resolution", "Circular resolution", "Class resolution", "B"],
  ["The minimum number of members whose presence constitutes a quorum for a general meeting depends on the:", "Total membership of the company", "Weather", "Time of the meeting", "Registered office location", "A"],
  ["The person who conducts and presides over a general meeting is the:", "Company Secretary", "Chairman", "Auditor", "Registrar", "B"],
  ["A proxy is a person appointed by a member to:", "Manage the company permanently", "Attend and vote at a meeting on the member's behalf", "Audit the accounts", "Sign the balance sheet", "B"],
  ["A record of the proceedings of a meeting is called the:", "Notice", "Agenda", "Minutes", "Resolution register", "C"],
  ["A resolution passed without holding a meeting, by circulating the draft, is a resolution by:", "Postal ballot", "Circulation", "Show of hands", "Poll", "B"],
  ["Voting by postal ballot allows members to vote:", "Only by physically attending", "By post or electronic means without attending in person", "Only through the chairman", "Only via proxy", "B"],
  ["Voting by a show of hands allows each member present to cast:", "One vote per share held", "One vote regardless of shareholding", "Votes equal to shares only if a poll is demanded", "No vote", "B"],
  ["On a poll, voting rights of a member are generally proportional to their:", "Attendance record", "Shareholding/paid-up capital", "Seniority as a member", "Age", "B"],
  ["Key Managerial Personnel (KMP) of a company typically includes the:", "Auditor and bankers", "Managing Director/CEO, CS and CFO", "All employees", "All shareholders", "B"],
  ["The Company Secretary is responsible for ensuring the company's:", "Manufacturing operations", "Compliance with law and secretarial standards", "Marketing strategy", "Product design", "B"],
  ["A Whole-time Director is a director who:", "Works part-time for the company", "Devotes his whole time to the management of the company", "Is only a nominee", "Attends board meetings only", "B"],
  ["An Independent Director is a director who has:", "A significant financial relationship with the company", "No material pecuniary relationship with the company, other than remuneration", "Family ties with the promoters", "Been an employee for the last year", "B"],
  ["A Nominee Director is generally appointed by:", "The auditor", "An institution/lender/government under an agreement or law", "The Registrar", "Employees", "B"],
  ["The maximum tenure of an Independent Director in one term is:", "1 year", "3 years", "5 years", "10 years", "C"],
  ["A retiring director (subject to retirement by rotation) is eligible for:", "Permanent tenure without re-election", "Re-appointment at the AGM", "Automatic disqualification", "Only board (not member) approval", "B"],
  ["The remuneration of directors of a public company is subject to limits under:", "Schedule V of the Companies Act", "The Income Tax Act only", "SEBI Regulations only", "No limits at all", "A"],
  ["A company's Board of Directors is primarily responsible for its:", "Day-to-day clerical work only", "Overall management and strategic direction", "Bookkeeping only", "Tax filing only", "B"],
  ["The first directors of a company are usually named in the:", "Prospectus", "Articles of Association", "Balance sheet", "Annual return", "B"],
  ["A director vacates office automatically on:", "Attending all meetings", "Incurring disqualification under the Act", "Receiving remuneration", "Being reappointed", "B"],
  ["A woman director is mandatorily required on the board of certain classes of companies as per:", "Rules under the Companies Act, 2013", "SEBI (LODR) alone", "Income Tax Act", "GST law", "A"],
  ["A share warrant, where issued historically, entitles the bearer to the shares specified in it:", "Only on registration", "Without registration of a name", "Only after a court order", "Never", "B"],
  ["An annual general meeting is generally held during business hours on a day that is not a national holiday, at the:", "Registered office only", "Registered office or such other place as permitted", "Auditor's office", "Any location freely chosen always", "B"],
];

const INTERMEDIATE = [
  ["The general duties of directors are laid down under:", "Section 149", "Section 166", "Section 173", "Section 96", "B"],
  ["A director is required to act in accordance with the company's:", "Personal wishes", "Articles of Association", "Competitor's policy", "Auditor's instructions only", "B"],
  ["Under Section 166, a director must act in good faith to promote the objects of the company for the benefit of its:", "Only himself", "Members as a whole", "Only creditors", "Only employees", "B"],
  ["A director must avoid a situation of:", "Direct conflict of interest with the company", "Attending board meetings", "Receiving sitting fees", "Filing his DIN", "A"],
  ["A director's duty not to achieve undue gain or advantage is intended to prevent:", "Fair remuneration", "Personal profit at the company's expense", "Payment of dividend", "Filing of returns", "B"],
  ["If a director makes an undue gain in violation of duties, they are liable to:", "No action", "Pay an amount equal to that gain to the company", "Only a warning", "Resign compulsorily", "B"],
  ["A director's liability for breach of duty is generally:", "Only civil", "Civil and, in appropriate cases, penal", "Only criminal", "None at all", "B"],
  ["A related party transaction requires approval as per:", "Section 149", "Section 188", "Section 96", "Section 92", "B"],
  ["An arm's length transaction in the ordinary course of business with a related party generally:", "Always needs shareholder approval", "May not require special approval if conditions are met", "Is prohibited", "Requires NCLT approval", "B"],
  ["Loans to directors are regulated primarily under:", "Section 185", "Section 186", "Section 188", "Section 149", "A"],
  ["Inter-corporate loans and investments by a company are regulated under:", "Section 185", "Section 186", "Section 188", "Section 92", "B"],
  ["Corporate Social Responsibility, as a legal concept, requires certain companies to spend at least __ of average net profits:", "1%", "2%", "5%", "10%", "B"],
  ["The CSR Committee of the Board is responsible for formulating the:", "Dividend policy", "CSR policy and monitoring its implementation", "Audit policy", "Share transfer policy", "B"],
  ["Secretarial Standards are issued by the:", "SEBI", "Institute of Company Secretaries of India (ICSI)", "RBI", "ICAI", "B"],
  ["Secretarial Standard-1 deals with:", "General Meetings", "Meetings of the Board of Directors", "Minutes", "Dividend", "B"],
  ["Secretarial Standard-2 deals with:", "Meetings of the Board", "General Meetings", "Registers", "Financial Statements", "B"],
  ["Oppression and mismanagement provisions protect minority shareholders and are covered under:", "Sections 241-246", "Sections 149-151", "Sections 96-99", "Sections 68-70", "A"],
  ["An application alleging oppression or mismanagement is filed before the:", "High Court", "National Company Law Tribunal (NCLT)", "Registrar of Companies", "Central Government directly", "B"],
  ["A class action suit under company law allows a group of members or depositors to:", "Sue individually only", "Collectively seek relief against the company for wrongful acts", "Only vote at meetings", "Only file complaints with SEBI", "B"],
  ["The rule that generally prevents individual shareholders from suing for a wrong done to the company (proper plaintiff rule) arises from:", "Salomon v Salomon", "Foss v Harbottle", "Royal British Bank v Turquand", "Solomon v Solomon", "B"],
  ["The doctrine of indoor management protects outsiders dealing with a company by presuming that:", "Internal procedures were properly followed", "The company has no liability", "Directors are always honest", "No contract is valid", "A"],
  ["The doctrine of constructive notice means that outsiders are deemed to have knowledge of the company's:", "Internal minutes", "Public documents like the Memorandum and Articles", "Bank statements", "Employee records", "B"],
  ["A company's power to buy back its own shares is subject to conditions and limits under company law, primarily to:", "Increase liabilities", "Protect creditors and maintain solvency", "Avoid paying dividends", "Avoid audits", "B"],
  ["A reduction of share capital typically requires approval of the:", "Registrar only", "Members by special resolution and the NCLT", "Auditor only", "Employees", "B"],
  ["Alteration of the Memorandum's objects clause requires a:", "Board resolution only", "Special resolution of members", "Ordinary resolution only", "Court decree in all cases", "B"],
  ["Alteration of Articles of Association requires a:", "Special resolution", "Ordinary resolution", "Unanimous written consent always", "No resolution", "A"],
  ["A resolution requiring registration with the Registrar (e.g. special resolutions) must generally be filed within:", "15 days", "30 days", "60 days", "90 days", "B"],
  ["The 'lifting of the corporate veil' refers to courts disregarding a company's separate legal personality to:", "Reward shareholders", "Identify persons actually responsible for fraud or improper conduct", "Increase share capital", "Avoid taxation", "B"],
  ["Courts may lift the corporate veil in cases of:", "Genuine legitimate business only", "Fraud or improper conduct", "Payment of dividend", "Normal trading losses", "B"],
  ["A Nidhi company mainly deals in lending and borrowing among its:", "General public at large", "Own members only", "Foreign investors", "Government bodies", "B"],
  ["A Producer Company is primarily formed by:", "IT companies", "Primary producers such as farmers", "Banks", "Foreign investors", "B"],
  ["The concept of 'significant beneficial ownership' aims to identify the:", "Auditor of a company", "Ultimate natural person who controls the company", "Registrar", "Bankers", "B"],
  ["A shareholders' agreement is generally:", "A public document filed with the ROC", "A private contract between shareholders", "Part of the Memorandum", "Compulsory for all companies", "B"],
  ["Preferential allotment of shares is made to a select group of persons other than through a:", "Rights or public issue", "Bonus issue only", "Buy-back", "Debenture redemption", "A"],
  ["Sweat equity shares are issued to employees/directors for providing:", "Cash consideration only", "Know-how or value addition", "Loans to the company", "Guarantee to banks", "B"],
];

const EXPERT = [
  ["Winding up of a company means the process by which its existence is brought to an:", "Temporary halt", "End, and its assets are realised and liabilities paid off", "Automatic renewal", "Merger only", "B"],
  ["Winding up of a company by the Tribunal is also known as:", "Voluntary winding up", "Compulsory winding up", "Members' winding up", "Creditors' winding up", "B"],
  ["Provisions for winding up of companies are dealt with mainly by the:", "Companies Act, 2013 and Insolvency and Bankruptcy Code, 2016", "Income Tax Act only", "GST Act only", "SEBI Act only", "A"],
  ["IBC stands for:", "Indian Business Code", "Insolvency and Bankruptcy Code", "Investment and Banking Council", "Internal Board Committee", "B"],
  ["Under the IBC, the Corporate Insolvency Resolution Process is generally required to be completed within:", "90 days", "180 days (extendable)", "365 days always", "No time limit", "B"],
  ["A person appointed to manage the affairs of a company during insolvency resolution is the:", "Statutory Auditor", "Resolution Professional", "Registrar", "Company Secretary", "B"],
  ["An arrangement between a company and its creditors/members, sanctioned by the Tribunal, is called a:", "Buy-back", "Compromise or arrangement", "Bonus issue", "Rights issue", "B"],
  ["A merger of two or more companies into one is legally termed:", "Bifurcation", "Amalgamation", "Segregation", "Liquidation", "B"],
  ["A scheme of merger/amalgamation between companies requires sanction of the:", "Registrar", "National Company Law Tribunal (NCLT)", "Income Tax Department", "SEBI only", "B"],
  ["A fast-track merger between small companies/holding-subsidiary is approved by the:", "NCLT", "Central Government (Regional Director)", "High Court", "SEBI", "B"],
  ["Corporate governance broadly refers to the system by which companies are:", "Taxed", "Directed and controlled, balancing stakeholders' interests", "Registered", "Wound up", "B"],
  ["The Audit Committee of the Board primarily oversees the:", "Marketing function", "Financial reporting and audit process", "HR policies", "IT infrastructure", "B"],
  ["The Nomination and Remuneration Committee deals with the appointment and remuneration of:", "Auditors", "Directors and senior management", "Customers", "Suppliers", "B"],
  ["The Stakeholders Relationship Committee primarily addresses grievances of:", "Employees", "Security holders (shareholders/debenture holders)", "Government authorities", "Banks", "B"],
  ["A Vigil Mechanism (whistle-blower policy) allows directors and employees to report:", "Routine expenses", "Genuine concerns about unethical or improper conduct", "Salary revisions", "Leave applications", "B"],
  ["A government company enjoys certain exemptions under the Companies Act, but ultimate control still lies with the:", "Board alone", "Government as the majority shareholder", "Auditor", "Registrar", "B"],
  ["A foreign company operating in India must comply with the provisions relating to foreign companies under:", "Chapter XXII of the Companies Act, 2013", "Chapter I only", "The Income Tax Act only", "FEMA alone", "A"],
  ["A branch office of a foreign company in India is generally approved and regulated with reference to:", "Companies Act only", "RBI/FEMA regulations along with the Companies Act", "SEBI Act only", "GST Act only", "B"],
  ["The doctrine of 'ultra vires' means an act done by a company:", "Within its objects", "Beyond the powers given by its Memorandum", "Approved by the Board", "In the ordinary course of business", "B"],
  ["An ultra vires act of a company is generally considered:", "Valid and binding", "Void and cannot be ratified even by all members", "Valid if ratified by the auditor", "Binding on third parties only", "B"],
  ["A scheme of arrangement involving a merger of a listed and unlisted company also requires compliance with:", "Only the Companies Act", "SEBI regulations in addition to the Companies Act", "Only RBI norms", "Only Competition Act", "B"],
  ["The Competition Act, 2002 becomes relevant in mergers mainly to prevent:", "Tax evasion", "Adverse effect on competition (anti-trust concerns)", "Environmental damage", "Employee layoffs", "B"],
  ["A shareholder activism / class action mechanism under Section 245 can be invoked by requisite members or:", "Only directors", "Depositors, in cases of specified wrongs", "Only auditors", "Only the Registrar", "B"],
  ["The 'business judgment rule' generally protects directors who act:", "Fraudulently", "In good faith, with due care and in the company's interest", "Against the company's interest", "Without any diligence", "B"],
  ["Corporate insolvency resolution under the IBC can be initiated by a:", "Financial creditor, operational creditor or the corporate debtor itself", "Only the Registrar", "Only SEBI", "Only the auditor", "A"],
  ["A liquidator appointed in winding up is responsible for realising assets and:", "Increasing share capital", "Distributing proceeds among creditors/contributories as per priority", "Filing GST returns only", "Declaring dividend", "B"],
  ["A contributory in winding up is a person liable to contribute to the:", "Company's profits", "Assets of the company on winding up", "Auditor's fees", "Government treasury", "B"],
  ["The order of priority of payment of debts in winding up (statutory preferential payments) generally gives priority to:", "Unsecured creditors first", "Workmen's dues and secured creditors as per the waterfall mechanism", "Equity shareholders first", "Promoters first", "B"],
  ["Voluntary winding up (members' or creditors') of a company, prior to reforms, meant the process was initiated by the:", "Tribunal suo motu", "Company itself through a special resolution", "Government directly", "Auditor's report alone", "B"],
  ["The concept of 'group companies' becomes relevant in company law mainly for:", "Independent taxation of each unit only", "Consolidation of accounts and related-party scrutiny", "Avoiding all compliance", "Reducing share capital automatically", "B"],
  ["A scheme for reduction of capital must ensure protection of the interests of the company's:", "Promoters only", "Creditors", "Competitors", "Government only", "B"],
  ["The National Company Law Appellate Tribunal (NCLAT) hears appeals against orders of the:", "High Court", "National Company Law Tribunal (NCLT)", "Supreme Court", "SEBI", "B"],
  ["A company's corporate governance framework typically also draws upon the Listing Regulations issued by the:", "RBI", "SEBI", "ICSI", "MCA alone", "B"],
  ["The principle of 'majority rule' in company law is subject to exceptions to protect the rights of the:", "Auditors", "Minority shareholders", "Government", "Creditors alone", "B"],
  ["Insider trading and fraudulent practices in relation to securities of a listed company are primarily regulated by:", "The Companies Act alone", "SEBI Regulations, in addition to the Companies Act", "The Income Tax Act", "The GST Act", "B"],
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
  console.log('Company Law question bank:', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`Company Law area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
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
    console.log(`Deleted ${del.rowCount} old Company Law questions; inserted ${inserted} new (area_id ${areaId}).`);
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
