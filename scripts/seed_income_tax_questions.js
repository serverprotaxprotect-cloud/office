require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Income Tax question bank — original MCQs authored from the Income Tax Act,
// 1961 and current practice, answers verified. Format: [q, A, B, C, D, correct].
// Target org GB-001 (id 1), area "Income Tax".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'income tax';

const INTERN = [
  ["Income tax in India is governed by the:", "Income Tax Act, 1956", "Income Tax Act, 1961", "Finance Act, 1994", "GST Act, 2017", "B"],
  ["The financial year for income tax purposes runs from:", "1 January to 31 December", "1 April to 31 March", "1 July to 30 June", "1 October to 30 September", "B"],
  ["The Assessment Year is the year in which:", "Income is earned", "Income is assessed and taxed", "The business starts", "Advance tax is paid", "B"],
  ["The Previous Year is the year in which:", "Income is earned", "Income is assessed", "The return is filed", "Refund is received", "A"],
  ["PAN stands for:", "Permanent Account Number", "Personal Account Number", "Primary Assessment Number", "Public Account Number", "A"],
  ["A PAN consists of how many characters?", "8", "10", "12", "15", "B"],
  ["TAN stands for:", "Taxpayer Account Number", "Tax Deduction and Collection Account Number", "Total Assessment Number", "Trade Account Number", "B"],
  ["How many heads of income are there under the Income Tax Act?", "3", "4", "5", "6", "C"],
  ["Which of the following is NOT a head of income?", "Salaries", "Income from House Property", "Capital Gains", "Wealth", "D"],
  ["Rental income from a building is taxed under the head:", "Salaries", "Income from House Property", "Capital Gains", "Other Sources", "B"],
  ["Profit from a business is taxed under the head:", "Salaries", "Capital Gains", "Profits and Gains of Business or Profession", "Other Sources", "C"],
  ["Gain on the sale of a capital asset is taxed under the head:", "Salaries", "House Property", "Capital Gains", "Business", "C"],
  ["Interest on a savings bank account is taxed under the head:", "Salaries", "Capital Gains", "House Property", "Income from Other Sources", "D"],
  ["The apex body administering direct taxes in India is the:", "SEBI", "CBDT", "RBI", "GST Council", "B"],
  ["CBDT stands for:", "Central Board of Direct Taxes", "Central Bureau of Direct Taxation", "Combined Board of Direct Taxes", "Central Body of Domestic Taxes", "A"],
  ["The income tax e-filing portal is:", "www.gst.gov.in", "www.incometax.gov.in", "www.mca.gov.in", "www.epfindia.gov.in", "B"],
  ["A person's residential status is determined under:", "Section 2", "Section 6", "Section 10", "Section 139", "B"],
  ["Besides Resident and Non-Resident, the third residential status is:", "Foreign Resident", "Resident but Not Ordinarily Resident (RNOR)", "Temporary Resident", "Deemed Resident only", "B"],
  ["Agricultural income in India is:", "Fully taxable", "Exempt from income tax", "Taxed at 10%", "Taxed at 30%", "B"],
  ["The document filed to report income to the department is the:", "Tax invoice", "Income Tax Return (ITR)", "Form 16", "Balance sheet", "B"],
  ["ITR-1 (Sahaj) is generally meant for:", "Companies", "Salaried individuals with income up to 50 lakh", "Partnership firms", "Trusts", "B"],
  ["The standard deduction available to salaried employees is:", "10,000", "30,000", "50,000", "1,00,000", "C"],
  ["Section 80C provides a deduction of up to:", "50,000", "1,00,000", "1,50,000", "2,00,000", "C"],
  ["The TDS certificate issued for salary income is:", "Form 16", "Form 16A", "Form 26AS", "Form 15G", "A"],
  ["The consolidated annual tax statement showing TDS/tax credit is:", "Form 16", "Form 26AS", "Form 15H", "ITR-V", "B"],
  ["The due date for filing an ITR for a non-audit individual is generally:", "31 March", "30 June", "31 July", "31 December", "C"],
  ["TDS on salary is deducted under which section?", "Section 192", "Section 194A", "Section 194C", "Section 194J", "A"],
  ["Income tax is a:", "Indirect tax", "Direct tax", "Cess", "Duty", "B"],
  ["The rebate for small taxpayers is provided under:", "Section 80C", "Section 87A", "Section 10", "Section 24", "B"],
  ["The TDS certificate for non-salary payments is:", "Form 16", "Form 16A", "Form 26AS", "Form 15G", "B"],
  ["Deduction for a life insurance premium paid is available under:", "Section 80C", "Section 80D", "Section 80G", "Section 24", "A"],
  ["Deduction for a medical insurance premium is available under:", "Section 80C", "Section 80D", "Section 80E", "Section 80G", "B"],
  ["Gross Total Income minus eligible deductions equals:", "Net profit", "Total (taxable) Income", "Book profit", "Turnover", "B"],
  ["Health and Education Cess on income tax is levied at:", "2%", "3%", "4%", "5%", "C"],
  ["A company files its income tax return in form:", "ITR-4", "ITR-5", "ITR-6", "ITR-7", "C"],
  ["A partnership firm or LLP files its income tax return in form:", "ITR-3", "ITR-4", "ITR-5", "ITR-6", "C"],
  ["Income earned outside India by a resident (and ordinarily resident) is:", "Fully exempt", "Taxable in India", "Taxed at 5% only", "Not required to be reported", "B"],
  ["The basic exemption limit for an individual below 60 years (old regime) is:", "1,50,000", "2,00,000", "2,50,000", "5,00,000", "C"],
  ["The first five characters of a PAN are:", "Digits", "Alphabets", "Special characters", "Blank", "B"],
  ["Salary income is taxable under the head:", "Other Sources", "Salaries", "House Property", "Business", "B"],
];

const EXECUTIVE = [
  ["Deduction for interest on an education loan is available under:", "Section 80C", "Section 80D", "Section 80E", "Section 80G", "C"],
  ["Deduction for donations to charitable institutions is available under:", "Section 80C", "Section 80D", "Section 80E", "Section 80G", "D"],
  ["Deduction for interest on a savings account (up to 10,000) is under:", "Section 80TTA", "Section 80C", "Section 80D", "Section 24", "A"],
  ["Interest on a self-occupied house property loan is deductible up to:", "50,000", "1,00,000", "1,50,000", "2,00,000", "D"],
  ["The standard deduction on income from house property is:", "10% of NAV", "30% of net annual value", "50% of NAV", "Nil", "B"],
  ["House Rent Allowance (HRA) exemption is available under:", "Section 10(10)", "Section 10(13A)", "Section 24", "Section 80C", "B"],
  ["Exemption for gratuity received is available under:", "Section 10(10)", "Section 10(13A)", "Section 80C", "Section 17", "A"],
  ["TDS on interest (other than interest on securities) is under:", "Section 192", "Section 194A", "Section 194C", "Section 194J", "B"],
  ["TDS on payment to a contractor is under:", "Section 194A", "Section 194C", "Section 194I", "Section 194J", "B"],
  ["TDS on professional or technical fees is under:", "Section 194C", "Section 194H", "Section 194I", "Section 194J", "D"],
  ["TDS on rent is under:", "Section 194A", "Section 194H", "Section 194I", "Section 194J", "C"],
  ["TDS on commission or brokerage is under:", "Section 194C", "Section 194H", "Section 194I", "Section 194J", "B"],
  ["Advance tax is payable when the total tax liability for the year is:", "1,000 or more", "5,000 or more", "10,000 or more", "50,000 or more", "C"],
  ["The first advance tax instalment (by 15 June) requires payment of:", "15% of tax", "30% of tax", "45% of tax", "100% of tax", "A"],
  ["The provisions for advance tax are contained in:", "Section 139", "Section 208", "Section 234F", "Section 44AB", "B"],
  ["ITR-4 (Sugam) is meant for taxpayers opting for:", "Capital gains", "Presumptive taxation", "Foreign income", "Trust income", "B"],
  ["An individual having income from business or profession files:", "ITR-1", "ITR-2", "ITR-3", "ITR-5", "C"],
  ["An individual having capital gains or more than one house property files:", "ITR-1", "ITR-2", "ITR-4", "ITR-6", "B"],
  ["The due date for filing an ITR in tax-audit cases is generally:", "31 July", "30 September", "31 October", "31 December", "C"],
  ["A belated return of income is filed under:", "Section 139(1)", "Section 139(4)", "Section 139(5)", "Section 148", "B"],
  ["A revised return is filed under:", "Section 139(1)", "Section 139(4)", "Section 139(5)", "Section 143", "C"],
  ["The late filing fee for a return is charged under:", "Section 234A", "Section 234B", "Section 234F", "Section 270A", "C"],
  ["The return of income is filed under:", "Section 139", "Section 143", "Section 148", "Section 208", "A"],
  ["Reassessment of income escaping assessment is done under:", "Section 143(1)", "Section 143(3)", "Section 148", "Section 144", "C"],
  ["An intimation / summary assessment is issued under:", "Section 143(1)", "Section 143(3)", "Section 144", "Section 148", "A"],
  ["A scrutiny assessment is carried out under:", "Section 143(1)", "Section 143(3)", "Section 144", "Section 147", "B"],
  ["Interest for default in filing the return of income is charged under:", "Section 234A", "Section 234B", "Section 234C", "Section 234F", "A"],
  ["Interest for default in payment of advance tax is charged under:", "Section 234A", "Section 234B", "Section 234C", "Section 234F", "B"],
  ["The new (concessional) tax regime for individuals is under:", "Section 115BAA", "Section 115BAC", "Section 115JB", "Section 44AD", "B"],
  ["Deduction for contribution to the National Pension System (NPS) is under:", "Section 80C", "Section 80CCD", "Section 80D", "Section 80E", "B"],
  ["Long-term capital gain on listed equity exceeding 1 lakh is taxed at:", "10%", "15%", "20%", "30%", "A"],
  ["Short-term capital gain on listed equity (STT paid) is taxed at:", "10%", "15%", "20%", "30%", "B"],
  ["The holding period for a long-term capital asset in listed shares is:", "More than 12 months", "More than 24 months", "More than 36 months", "More than 60 months", "A"],
  ["The holding period for long-term capital gain on immovable property is:", "More than 12 months", "More than 24 months", "More than 36 months", "More than 48 months", "B"],
  ["Exemption on reinvesting capital gain from a residential house is under:", "Section 54", "Section 54EC", "Section 80C", "Section 10", "A"],
  ["Exemption by investing capital gain in specified bonds (NHAI/REC) is under:", "Section 54", "Section 54EC", "Section 54F", "Section 80C", "B"],
  ["Deduction for maintenance/treatment of a disabled dependent is under:", "Section 80DD", "Section 80U", "Section 80D", "Section 80E", "A"],
  ["Deduction available to a resident individual who is a person with disability is under:", "Section 80DD", "Section 80U", "Section 80DDB", "Section 80D", "B"],
  ["Forms used to declare that no TDS be deducted on interest (individuals) are:", "Form 16 / 16A", "Form 15G / 15H", "Form 26AS", "Form 3CD", "B"],
  ["The rebate under Section 87A (old regime) is available if total income does not exceed:", "2,50,000", "5,00,000", "7,00,000", "10,00,000", "B"],
];

const INTERMEDIATE = [
  ["Presumptive taxation for small businesses is available under:", "Section 44AD", "Section 44ADA", "Section 44AE", "Section 44AB", "A"],
  ["Presumptive taxation for specified professionals is under:", "Section 44AD", "Section 44ADA", "Section 44AE", "Section 44AB", "B"],
  ["Presumptive taxation for a business of plying goods carriages is under:", "Section 44AD", "Section 44ADA", "Section 44AE", "Section 44AB", "C"],
  ["Under Section 44AD, income is presumed at 8% of turnover, or at __ for digital/bank receipts:", "4%", "6%", "10%", "12%", "B"],
  ["Under Section 44ADA, the presumed income of a professional is:", "8% of receipts", "50% of gross receipts", "30% of receipts", "6% of receipts", "B"],
  ["The annual value of one self-occupied house property is taken as:", "Market rent", "Nil", "Municipal value", "30% of cost", "B"],
  ["A loss from house property can be set off against other heads up to:", "50,000", "1,00,000", "2,00,000", "No limit", "C"],
  ["A non-speculative business loss can be carried forward for:", "4 years", "8 years", "10 years", "Indefinitely", "B"],
  ["A capital loss can be carried forward for:", "4 years", "8 years", "Indefinitely", "No carry forward", "B"],
  ["A speculation business loss can be carried forward for:", "4 years", "8 years", "10 years", "Indefinitely", "A"],
  ["A long-term capital loss can be set off only against:", "Any income", "Long-term capital gain", "Salary", "Business income", "B"],
  ["Unabsorbed depreciation can be carried forward for:", "4 years", "8 years", "10 years", "An indefinite period", "D"],
  ["Depreciation under the Income Tax Act is computed on the:", "Original cost of each asset (SLM)", "Block of assets on WDV basis", "Market value", "Insured value", "B"],
  ["The Section 80D deduction limit for self and family (non-senior citizens) is:", "10,000", "25,000", "50,000", "1,00,000", "B"],
  ["Section 80DDB provides a deduction for:", "Rent paid", "Treatment of specified diseases", "Education loan interest", "Donations", "B"],
  ["Section 80GG allows a deduction for:", "Medical insurance", "Rent paid when no HRA is received", "Education loan", "Savings interest", "B"],
  ["The overall ceiling of Sections 80C, 80CCC and 80CCD(1) together is:", "1,00,000", "1,50,000", "2,00,000", "2,50,000", "B"],
  ["An additional NPS deduction of 50,000 is available under:", "Section 80CCD(1)", "Section 80CCD(1B)", "Section 80CCD(2)", "Section 80C", "B"],
  ["Long-term capital gain on immovable property is generally taxed at:", "10% without indexation", "15%", "20% with indexation", "30%", "C"],
  ["Indexation adjusts the cost of an asset using the:", "Bank rate", "Cost Inflation Index", "Repo rate", "Wholesale price index", "B"],
  ["The income of a minor child is generally:", "Fully exempt", "Clubbed with the parent's income", "Taxed separately", "Taxed at 30%", "B"],
  ["The provisions for clubbing of income are contained in:", "Sections 10 to 13", "Sections 60 to 64", "Sections 80 to 87", "Sections 139 to 145", "B"],
  ["A deemed owner of house property is covered under:", "Section 22", "Section 24", "Section 27", "Section 28", "C"],
  ["An individual is a resident if he stays in India for:", "60 days or more", "90 days or more", "182 days or more in the previous year", "365 days", "C"],
  ["Perquisites provided by an employer are taxed under the head:", "Other Sources", "Salaries", "Business", "Capital Gains", "B"],
  ["A gift of money exceeding 50,000 from a non-relative is taxable under:", "Salaries", "Capital Gains", "Income from Other Sources", "House Property", "C"],
  ["Dividend income is now taxable in the hands of the shareholder under:", "Capital Gains", "Income from Other Sources", "Business", "Salaries", "B"],
  ["Interest for deferment of advance tax instalments is charged under:", "Section 234A", "Section 234B", "Section 234C", "Section 234F", "C"],
  ["Setting off a loss against income of the same head is called:", "Inter-head set-off", "Intra-head set-off", "Carry forward", "Clubbing", "B"],
  ["The tax audit under the Income Tax Act is prescribed under:", "Section 44AA", "Section 44AB", "Section 44AD", "Section 139", "B"],
  ["The tax audit report under Section 44AB is furnished in form:", "Form 16", "Form 26AS", "Form 3CD", "ITR-3", "C"],
  ["Remuneration and interest paid to partners of a firm are governed by:", "Section 40(b)", "Section 44AD", "Section 80C", "Section 28", "A"],
  ["A business loss can be set off against:", "Salary income", "Income under other heads except salary", "Only agricultural income", "Nothing", "B"],
  ["Carry forward of business losses requires the return to be filed:", "Anytime", "Within the due date under Section 139(1)", "Only after audit", "Within 2 years", "B"],
  ["Income which does not form part of total income (exempt income) is listed in:", "Section 10", "Section 80C", "Section 24", "Section 44AD", "A"],
];

const EXPERT = [
  ["Minimum Alternate Tax (MAT) on companies is levied under:", "Section 115JB", "Section 115JC", "Section 115BAC", "Section 44AB", "A"],
  ["The MAT rate on book profit is:", "10%", "15%", "18.5%", "22%", "B"],
  ["Alternate Minimum Tax (AMT) applies to:", "Only companies", "Non-corporate assessees (Section 115JC)", "Only individuals with salary", "Non-residents only", "B"],
  ["An updated return (ITR-U) can be filed under:", "Section 139(1)", "Section 139(4)", "Section 139(5)", "Section 139(8A)", "D"],
  ["A concessional tax rate of 22% for domestic companies is provided under:", "Section 115BAA", "Section 115BAB", "Section 115JB", "Section 115BAC", "A"],
  ["A concessional 15% rate for new manufacturing domestic companies is under:", "Section 115BAA", "Section 115BAB", "Section 115JB", "Section 44AD", "B"],
  ["TDS on purchase of immovable property (consideration of 50 lakh or more) is under:", "Section 194-IA", "Section 194-IB", "Section 194N", "Section 194Q", "A"],
  ["TDS on cash withdrawal above a threshold from a bank is under:", "Section 194-IA", "Section 194N", "Section 194O", "Section 194Q", "B"],
  ["TCS on the sale of goods above the threshold is under:", "Section 206C(1H)", "Section 194Q", "Section 194O", "Section 194C", "A"],
  ["TDS on payments to e-commerce participants is under:", "Section 194C", "Section 194O", "Section 194Q", "Section 194J", "B"],
  ["TDS on the purchase of goods above the threshold is under:", "Section 194Q", "Section 206C(1H)", "Section 194O", "Section 194C", "A"],
  ["The Annual Information Statement is commonly abbreviated as:", "AIS", "TIS", "AS", "26Q", "A"],
  ["The first appeal against an assessment order lies with the:", "ITAT", "Commissioner (Appeals) / CIT(A)", "High Court", "Supreme Court", "B"],
  ["The second appeal (after CIT(A)) lies with the:", "High Court", "Income Tax Appellate Tribunal (ITAT)", "Supreme Court", "AAR", "B"],
  ["After the abolition of Dividend Distribution Tax, dividend is taxed:", "In the company's hands only", "In the hands of the shareholder", "At a flat 15% by the company", "Exempt fully", "B"],
  ["Deduction for the employment of new employees is available under:", "Section 80JJAA", "Section 80IA", "Section 10AA", "Section 80G", "A"],
  ["A deduction for units located in a Special Economic Zone (SEZ) is under:", "Section 10AA", "Section 80JJAA", "Section 35AD", "Section 80C", "A"],
  ["The term 'previous year' is defined in:", "Section 2", "Section 3", "Section 4", "Section 5", "B"],
  ["Faceless assessment of income is conducted under:", "Section 143(3)", "Section 144", "Section 144B", "Section 147", "C"],
  ["A best judgement assessment is made under:", "Section 143(1)", "Section 143(3)", "Section 144", "Section 148", "C"],
  ["Penalty for under-reporting of income is levied under:", "Section 234F", "Section 270A", "Section 271", "Section 276", "B"],
  ["Interest under Section 234B is charged at the rate of:", "1% per month", "1.5% per month", "2% per month", "12% per annum", "A"],
  ["A business loss cannot be set off against income under the head:", "House property", "Salaries", "Other sources", "Capital gains", "B"],
  ["Income deemed to accrue or arise in India is covered under:", "Section 5", "Section 9", "Section 10", "Section 15", "B"],
  ["The block assessment for search cases is governed by:", "Section 143", "Section 147", "Sections 153A / 153C", "Section 144B", "C"],
  ["The Cost Inflation Index (CII) used for indexation is notified by the:", "RBI", "CBDT", "Finance Ministry directly", "SEBI", "B"],
  ["Surcharge on an individual becomes applicable when total income exceeds:", "10 lakh", "50 lakh", "1 crore", "2 crore", "B"],
  ["Section 194J prescribes a TDS rate on professional fees of (generally):", "1%", "2%", "5%", "10%", "D"],
  ["Deduction for a donation to a political party by an individual is under:", "Section 80G", "Section 80GGC", "Section 80GGB", "Section 80C", "B"],
  ["The Dispute Resolution Panel (DRP) is constituted under:", "Section 144B", "Section 144C", "Section 147", "Section 245", "B"],
  ["A domestic company opting for Section 115BAA generally cannot claim:", "Depreciation", "Specified deductions and incentives", "Any expense", "Salary expense", "B"],
  ["A person under the Income Tax Act includes an individual, HUF, company, firm and:", "Only trusts", "AOP/BOI, local authority and artificial juridical person", "Only foreign entities", "Only proprietors", "B"],
  ["Section 44AB tax audit is generally required for a business when turnover exceeds:", "50 lakh", "1 crore (10 crore with digital conditions)", "5 crore always", "10 lakh", "B"],
  ["The deduction for an employer's contribution to an employee's NPS account is under:", "Section 80CCD(1)", "Section 80CCD(1B)", "Section 80CCD(2)", "Section 80C", "C"],
  ["Income tax is charged for an assessment year at the rates fixed by the:", "CBDT circular", "Annual Finance Act", "Income Tax Rules", "State Government", "B"],
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
  console.log('Income Tax question bank:', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`Income Tax area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
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
    console.log(`Deleted ${del.rowCount} old Income Tax questions; inserted ${inserted} new (area_id ${areaId}).`);
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
