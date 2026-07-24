require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Accounts question bank — original MCQs authored from standard accounting
// knowledge, answers verified. Tagged by level. Format: [q, A, B, C, D, correct]
// Target org: GB-001 (organization_id 1), area "Accounts".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);

const INTERN = [
  ["The book in which transactions are first recorded is called the","Ledger","Journal","Trial Balance","Balance Sheet","B"],
  ["The process of transferring entries from the journal to the ledger is called","Balancing","Casting","Posting","Journalising","C"],
  ["According to the golden rule of real accounts:","Debit the receiver, credit the giver","Debit what comes in, credit what goes out","Debit all expenses, credit all incomes","Debit the giver, credit the receiver","B"],
  ["According to the golden rule of personal accounts:","Debit what comes in, credit what goes out","Debit all expenses and losses","Debit the receiver, credit the giver","Credit what comes in","C"],
  ["According to the golden rule of nominal accounts:","Debit all expenses and losses, credit all incomes and gains","Debit what comes in","Debit the receiver","Credit the giver","A"],
  ["The accounting equation is:","Assets = Liabilities - Capital","Assets = Liabilities + Capital","Capital = Assets + Liabilities","Liabilities = Assets + Capital","B"],
  ["A person who owes money to the business is called a:","Creditor","Debtor","Drawer","Payee","B"],
  ["A person to whom the business owes money is called a:","Debtor","Creditor","Receiver","Proprietor","B"],
  ["A statement prepared to check the arithmetical accuracy of the books is the:","Balance Sheet","Trial Balance","Cash Book","Profit & Loss Account","B"],
  ["Goods returned by a customer are recorded as:","Purchase return","Sales return","Bad debts","Drawings","B"],
  ["Goods returned to a supplier are recorded as:","Sales return","Purchase return","Discount","Rebate","B"],
  ["Cash discount is allowed for:","Buying in bulk","Prompt or early payment","Damaged goods","Old customers","B"],
  ["Trade discount is allowed on the:","Cash paid","List price of goods","Amount outstanding","Net profit","B"],
  ["The concept that treats the business as separate from its owner is the:","Going concern concept","Business entity concept","Cost concept","Dual aspect concept","B"],
  ["The assumption that a business will continue for a long time is the:","Cost concept","Going concern concept","Money measurement concept","Accrual concept","B"],
  ["Every transaction has two aspects - this is the:","Cost concept","Dual aspect concept","Realisation concept","Matching concept","B"],
  ["Drawings by the owner will:","Increase capital","Decrease capital","Increase liabilities","Have no effect on capital","B"],
  ["Which of the following is a current asset?","Building","Machinery","Inventory (Stock)","Goodwill","C"],
  ["Which of the following is a fixed asset?","Debtors","Cash","Building","Bank balance","C"],
  ["Which of the following is an intangible asset?","Furniture","Goodwill","Stock","Cash","B"],
  ["Which of the following is a current liability?","Building","Creditors","Land","Goodwill","B"],
  ["Outstanding salary is a:","Asset","Liability","Income","Expense written off","B"],
  ["Prepaid rent is treated as a(n):","Liability","Asset","Income","Loss","B"],
  ["Bank overdraft is a:","Asset","Current liability","Income","Fixed asset","B"],
  ["Salary paid is which type of account?","Personal account","Real account","Nominal account","Valuation account","C"],
  ["Rent received is treated as:","Expense","Income","Asset","Liability","B"],
  ["The journal entry for cash brought in by the owner as capital is:","Capital A/c Dr, To Cash A/c","Cash A/c Dr, To Capital A/c","Drawings A/c Dr, To Cash A/c","Cash A/c Dr, To Sales A/c","B"],
  ["The journal entry for goods sold for cash is:","Sales A/c Dr, To Cash A/c","Cash A/c Dr, To Sales A/c","Cash A/c Dr, To Purchases A/c","Purchases A/c Dr, To Cash A/c","B"],
  ["The journal entry for furniture purchased for cash is:","Cash A/c Dr, To Furniture A/c","Furniture A/c Dr, To Cash A/c","Purchases A/c Dr, To Cash A/c","Furniture A/c Dr, To Capital A/c","B"],
  ["A contra entry is recorded when a transaction affects:","Only cash","Only bank","Both cash and bank","Neither cash nor bank","C"],
  ["A credit balance in the bank column of the cash book indicates:","Cash in hand","Bank overdraft","Favourable bank balance","Petty cash","B"],
  ["The petty cash book is used to record:","Large payments","Credit sales","Small (petty) expenses","Capital transactions","C"],
  ["The ledger is also known as the:","Book of original entry","Principal book of accounts","Subsidiary book","Memorandum book","B"],
  ["Which document is issued by a seller when goods are sold on credit?","Receipt","Invoice","Pay-in-slip","Voucher","B"],
  ["A capital account is which type of account?","Real","Nominal","Personal","Valuation","C"],
  ["Wages paid for the installation of new machinery should be:","Debited to Wages A/c","Added to the cost of the machinery","Debited to P&L A/c","Treated as a loss","B"],
  ["The purchases account is used to record the purchase of:","Fixed assets","Goods meant for resale","Investments","Stationery","B"],
  ["The total of the debit and credit sides of a trial balance must be:","Different","Equal","Zero","Greater on the debit side","B"],
  ["Cash sales are recorded in the:","Sales book","Cash book","Purchases book","Journal proper","B"],
  ["The amount the owner invests in the business is called:","Drawings","Capital","Reserve","Loan","B"],
];

const EXECUTIVE = [
  ["A Bank Reconciliation Statement reconciles the balances of the:","Trial balance and balance sheet","Cash book and pass book","Journal and ledger","Sales book and purchase book","B"],
  ["TDS stands for:","Total Deducted Sum","Tax Deducted at Source","Tax Deferred Statement","Total Debit Summary","B"],
  ["Under GST, tax on an intra-state supply consists of:","IGST only","CGST + SGST","Only CGST","Only SGST","B"],
  ["Under GST, tax on an inter-state supply is:","CGST + SGST","IGST","SGST only","No tax","B"],
  ["Input Tax Credit under GST refers to:","Tax on sales","Credit of GST paid on purchases/inputs","A type of discount","Penalty on late filing","B"],
  ["Depreciation charged at a fixed percentage on the original cost every year is the:","Written Down Value method","Straight Line Method","Annuity method","Sum of years method","B"],
  ["Depreciation charged at a fixed percentage on the reducing book value is the:","Straight Line Method","Written Down Value method","Revaluation method","Sinking fund method","B"],
  ["Under the Straight Line Method, annual depreciation equals:","Cost x rate on book value","(Cost - Scrap value) / Useful life","Cost / Scrap value","Book value x 2","B"],
  ["Gross Profit is equal to:","Sales - Cost of Goods Sold","Sales + Purchases","Net profit - expenses","Sales - Net profit","A"],
  ["Cost of Goods Sold is calculated as:","Opening stock + Purchases + Direct expenses - Closing stock","Purchases - Sales","Closing stock - Opening stock","Sales - Gross profit","A"],
  ["The Trading Account is prepared to find out the:","Net profit","Gross profit or gross loss","Financial position","Cash balance","B"],
  ["The Profit & Loss Account is prepared to find out the:","Gross profit","Net profit or net loss","Total assets","Trial balance","B"],
  ["Carriage inward (freight on purchases) is a:","Indirect expense shown in P&L","Direct expense shown in the Trading A/c","Capital expenditure","Income","B"],
  ["Carriage outward (freight on sales) is a(n):","Direct expense in the Trading A/c","Indirect expense in the P&L A/c","Asset","Liability","B"],
  ["Wages paid in a factory are treated as a:","Indirect expense","Direct expense","Capital expense","Deferred expense","B"],
  ["Closing stock is shown in the balance sheet as a:","Liability","Current asset","Fixed asset","Expense","B"],
  ["The journal entry to record depreciation is:","Asset A/c Dr, To Depreciation A/c","Depreciation A/c Dr, To Asset A/c","Cash A/c Dr, To Depreciation A/c","P&L A/c Dr, To Cash A/c","B"],
  ["A debit note is generally issued when:","Goods are sold on credit","Goods are returned to a supplier","Cash is received","Salary is paid","B"],
  ["A credit note is generally issued when:","Goods are purchased","Goods sold are returned by a customer","A loan is taken","Rent is paid","B"],
  ["In a BRS starting from the cash book balance, bank charges appearing only in the pass book are:","Added","Deducted","Ignored","Doubled","B"],
  ["Accrued income (income earned but not yet received) is a(n):","Liability","Asset","Expense","Loss","B"],
  ["Income received in advance is a(n):","Asset","Liability","Income","Expense","B"],
  ["A suspense account is opened when the:","Cash book does not tally","Trial balance does not agree","Bank sends a statement","Owner introduces capital","B"],
  ["TDS on salary is deducted under which section of the Income Tax Act?","Section 194C","Section 192","Section 80C","Section 44AD","B"],
  ["Provision for doubtful debts is created in respect of:","Creditors","Debtors","Cash","Fixed assets","B"],
  ["Bad debts recovered (previously written off) are treated as:","An expense","An income or gain","A liability","A reduction in capital","B"],
  ["In Tally, cash deposited into the bank is recorded using a:","Sales voucher","Contra voucher","Payment voucher","Journal voucher","B"],
  ["A voucher is:","A summary of the ledger","Documentary evidence of a transaction","A type of asset","A trial balance","B"],
  ["Net Profit is calculated as:","Gross profit + other incomes - indirect expenses","Sales - purchases","Gross profit - sales","Assets - liabilities","A"],
  ["Purchase returns are deducted from:","Sales","Purchases","Closing stock","Capital","B"],
  ["Under the diminishing balance method, the amount of depreciation each year:","Remains the same","Decreases","Increases","Is zero","B"],
  ["An asset costing 1,00,000 with scrap value 10,000 and life 9 years has SLM depreciation of:","11,000","10,000","9,000","1,000","B"],
  ["Depreciation is ultimately charged to the:","Trading Account","Profit & Loss Account","Balance Sheet only","Capital Account","B"],
  ["Days of grace allowed on a bill of exchange are:","5 days","3 days","7 days","No days","B"],
  ["Which of these is a direct expense?","Office salary","Factory wages","Advertising","Audit fees","B"],
  ["Outstanding wages at the year end are shown as a:","Current asset","Current liability","Fixed asset","Income","B"],
  ["Prepaid insurance at the year end is shown as a(n):","Liability","Asset","Expense","Income","B"],
  ["Discount received is treated as:","An expense","An income","An asset","A liability","B"],
  ["Discount allowed is treated as:","An income","An expense","An asset","A liability","B"],
  ["The person who draws (makes) a bill of exchange is the:","Drawee","Drawer","Payee","Endorser","B"],
];

const INTERMEDIATE = [
  ["The current ratio is calculated as:","Current assets / Current liabilities","Current liabilities / Current assets","Quick assets / Current liabilities","Sales / Current assets","A"],
  ["The generally accepted ideal current ratio is:","1:1","2:1","3:1","1:2","B"],
  ["The quick (acid-test) ratio ideally should be:","2:1","1:1","3:1","0.5:1","B"],
  ["Working capital is equal to:","Current assets - Current liabilities","Fixed assets - Current assets","Current assets + Current liabilities","Capital - Drawings","A"],
  ["Gross profit ratio is calculated as:","(Gross profit / Net sales) x 100","(Net profit / Sales) x 100","(Sales / Gross profit) x 100","(Gross profit / Cost) x 100","A"],
  ["The inventory (stock) turnover ratio is:","Cost of goods sold / Average inventory","Sales / Fixed assets","Average inventory / Sales","Net profit / Inventory","A"],
  ["The debt-equity ratio is calculated as:","Equity / Debt","Debt / Equity","Debt / Total assets","Equity / Total assets","B"],
  ["An error where a whole transaction is not recorded at all is an error of:","Commission","Principle","Complete omission","Compensation","C"],
  ["Treating a capital expenditure as a revenue expenditure is an error of:","Omission","Commission","Principle","Compensation","C"],
  ["Two or more errors that cancel out each other's effect are called:","Errors of principle","Compensating errors","Errors of omission","Casting errors","B"],
  ["A provision is a:","Charge against profit","Appropriation of profit","Reserve","Asset","A"],
  ["A general reserve is a(n):","Charge against profit","Appropriation of profit","Current liability","Fixed asset","B"],
  ["Under AS-2 / Ind AS 2, inventory is valued at:","Cost price only","Market price only","Lower of cost or net realisable value","Higher of cost or NRV","C"],
  ["The FIFO method of inventory valuation assumes that:","Last goods purchased are sold first","First goods purchased are sold first","Goods are issued at average price","Goods are never sold","B"],
  ["Which inventory method is NOT permitted under AS-2 / Ind AS 2?","FIFO","Weighted average","LIFO","Specific identification","C"],
  ["A contingent liability is:","Recorded as a liability in the books","Shown as a note to accounts (not recorded)","Added to capital","Shown as an asset","B"],
  ["Capital expenditure is expenditure whose benefit:","Is exhausted within the year","Extends over more than one year","Is nil","Reduces capital","B"],
  ["Revenue expenditure is expenditure whose benefit is:","Extended over many years","Received within the current year","Used to create a fixed asset","Capitalised","B"],
  ["Heavy advertising expense whose benefit lasts a few years is a:","Capital expenditure","Deferred revenue expenditure","Revenue receipt","Capital receipt","B"],
  ["The adjustment for an outstanding expense requires it to be:","Deducted from the expense and shown as an asset","Added to the expense and shown as a liability","Ignored","Added to capital","B"],
  ["The adjustment for a prepaid expense requires it to be:","Added to the expense","Deducted from the expense and shown as an asset","Shown as a liability","Treated as income","B"],
  ["In the absence of a partnership deed, partners share profits and losses:","In their capital ratio","Equally","In the ratio of their loans","As decided by the senior partner","B"],
  ["In the absence of a partnership deed, interest on a partner's capital is:","Allowed at 6%","Not allowed","Allowed at 12%","Allowed at 10%","B"],
  ["Goodwill is best described as the value of a firm's:","Fixed assets","Reputation and earning capacity","Stock","Owner's drawings","B"],
  ["Fixed assets are generally shown in the balance sheet at:","Market value","Cost less accumulated depreciation","Replacement cost","Scrap value","B"],
  ["Arranging assets and liabilities in a particular order in the balance sheet is called:","Casting","Marshalling","Posting","Netting","B"],
  ["Depreciation is best described as a:","Cash expense","Non-cash expense","Provision for tax","Reserve","B"],
  ["The debtors (receivables) turnover ratio uses:","Net credit sales / Average debtors","Cash sales / Debtors","Purchases / Creditors","Sales / Inventory","A"],
  ["Net profit ratio is:","(Net profit / Net sales) x 100","(Gross profit / Sales) x 100","(Sales / Net profit) x 100","(Net profit / Capital) x 100","A"],
  ["Under the weighted average method, issues are valued at the:","Latest price","Oldest price","Weighted average price of stock","Highest price","C"],
  ["Accrued income adjustment requires it to be:","Added to income and shown as an asset","Deducted from income","Shown as a liability","Ignored","A"],
  ["Income received in advance adjustment requires it to be:","Added to income","Deducted from income and shown as a liability","Shown as an asset","Added to capital","B"],
  ["The matching concept requires that:","Revenues be recorded only when received","Expenses be matched with the revenues they help earn","Assets be valued at market price","Only cash transactions be recorded","B"],
  ["The quick ratio excludes which item from current assets?","Debtors","Cash","Inventory and prepaid expenses","Bank balance","C"],
  ["A reserve is created by:","Compulsorily charging against profit","Appropriating profits","Reducing assets","Increasing liabilities","B"],
];

const EXPERT = [
  ["Indian Accounting Standards (Ind AS) are converged with:","US GAAP","IFRS","UK GAAP","Japanese GAAP","B"],
  ["AS-3 / Ind AS 7 deals with:","Inventories","Cash Flow Statements","Depreciation","Revenue","B"],
  ["In a cash flow statement, purchase of a fixed asset is classified under:","Operating activities","Investing activities","Financing activities","It is not shown","B"],
  ["In a cash flow statement, issue of shares is classified under:","Operating activities","Investing activities","Financing activities","Notes","C"],
  ["Under the indirect method, depreciation is:","Deducted from net profit","Added back to net profit","Ignored","Shown as an investing outflow","B"],
  ["Dividend paid by a company is shown under which activity in the cash flow statement?","Operating","Investing","Financing","It is not shown","C"],
  ["Deferred tax arises mainly due to:","Permanent differences","Timing (temporary) differences","Rounding differences","Cash differences","B"],
  ["AS-10 / Ind AS 16 deals with:","Intangible assets","Property, Plant and Equipment","Leases","Inventories","B"],
  ["AS-26 / Ind AS 38 deals with:","Property, Plant and Equipment","Intangible assets","Revenue","Borrowing costs","B"],
  ["Ind AS 115 deals with:","Leases","Revenue from Contracts with Customers","Income Taxes","Financial instruments","B"],
  ["Ind AS 116 deals with:","Leases","Revenue","Inventories","Cash flows","A"],
  ["Consolidated financial statements combine the accounts of:","Two competitors","A parent and its subsidiaries","A firm and its bankers","A company and its auditors","B"],
  ["The share of net assets/profit not held by the parent company is called:","Goodwill","Non-controlling (minority) interest","Reserve capital","Capital reserve","B"],
  ["The format of a company's financial statements is prescribed by which schedule of the Companies Act, 2013?","Schedule I","Schedule II","Schedule III","Schedule V","C"],
  ["Depreciation (useful lives) for companies is given in which schedule of the Companies Act, 2013?","Schedule I","Schedule II","Schedule III","Schedule VI","B"],
  ["An interim dividend is declared by the:","Shareholders in the AGM","Board of Directors between two AGMs","Auditors","Central Government","B"],
  ["A capital reserve is created out of:","Revenue profits","Capital profits","Salaries","Sales","B"],
  ["Securities Premium can be utilised for:","Paying dividends","Issuing fully paid bonus shares","Paying salaries","Meeting revenue losses","B"],
  ["Buy-back of shares by a company is governed by which section of the Companies Act, 2013?","Section 68","Section 185","Section 138","Section 44","A"],
  ["Bonus shares are issued to existing shareholders:","At a premium","Free of cost","At par with payment","Only to directors","B"],
  ["Shares are forfeited by a company when:","Dividend is unpaid","Allotment or call money remains unpaid","Bonus is due","Premium is refunded","B"],
  ["Debentures represent:","Owned capital of the company","Borrowed capital (a loan)","Reserves","Goodwill","B"],
  ["Earnings Per Share (EPS) is calculated as:","Net profit available to equity shareholders / Number of equity shares","Sales / Number of shares","Dividend / Share price","Net profit / Total assets","A"],
  ["Under Ind AS 36 / AS-28, an asset is impaired when its:","Carrying amount exceeds its recoverable amount","Market price rises","Depreciation is high","Useful life is long","A"],
  ["Amortisation is the systematic write-off of:","Fixed tangible assets","Intangible assets","Current assets","Liabilities","B"],
  ["AS-22 / Ind AS 12 deals with accounting for:","Leases","Taxes on income","Inventories","Investments","B"],
  ["A deferred tax asset generally arises when:","Book profit exceeds taxable profit","Taxable profit exceeds book profit (more tax paid now)","There is no difference","Tax rates fall","B"],
  ["Cash flow from operating activities primarily relates to:","Purchase of investments","Principal revenue-generating activities","Issue of debentures","Payment of dividend","B"],
  ["Goodwill arising on consolidation equals:","Cost of investment - parent's share of net assets of the subsidiary","Total assets - total liabilities","Share capital + reserves","Cost of investment + net assets","A"],
  ["Under the revised AS-4, a proposed dividend is:","Provided for as a liability","Disclosed as a note (not provided until declared)","Added to reserves","Shown as an asset","B"],
  ["Right shares are first offered to:","The general public","Existing equity shareholders","Employees only","Debenture holders","B"],
  ["Under Schedule III, a company's Balance Sheet is presented in:","Horizontal (T) form","Vertical form","Account form","Any form chosen","B"],
  ["The Notes to Accounts in financial statements are:","Optional and rarely used","An integral part of the financial statements","Only for the auditors","Prepared after the audit","B"],
  ["Ind AS 2 requires inventories to be measured at the:","Cost only","Lower of cost and net realisable value","Selling price","Replacement cost","B"],
  ["The primary objective of a cash flow statement is to show the:","Profitability","Sources and uses of cash and cash equivalents","Net worth","Tax liability","B"],
];

const SETS = { Intern: INTERN, Executive: EXECUTIVE, Intermediate: INTERMEDIATE, Expert: EXPERT };
const LETTERS = ['A', 'B', 'C', 'D'];

// Rebalance the correct-answer position: place each question's correct option at
// a target slot drawn from a balanced, shuffled pool so A/B/C/D are ~evenly the
// answer across the whole bank (otherwise a candidate could just guess one letter).
function buildBalancedTargets(n) {
  const targets = [];
  for (let i = 0; i < n; i++) targets.push(i % 4);
  for (let i = targets.length - 1; i > 0; i--) { // Fisher-Yates
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  return targets;
}

// Reorder a question's options so the correct one lands at `targetPos`.
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
  console.log('Accounts question bank:', JSON.stringify(counts), '=> total', total);

  // sanity: validate correct option + option presence
  let bad = 0;
  for (const [level, arr] of Object.entries(SETS)) {
    arr.forEach((row, i) => {
      const [q, a, b, c, d, correct] = row;
      if (!q || !a || !b) { bad++; console.log(`  ${level}#${i + 1}: missing question/options`); }
      if (!['A', 'B', 'C', 'D'].includes(correct)) { bad++; console.log(`  ${level}#${i + 1}: bad correct '${correct}'`); }
    });
  }
  if (bad) { console.log(`Validation failed: ${bad} issues.`); process.exit(1); }
  console.log('Validation OK.');

  if (!apply) {
    console.log('Dry run. Use --apply to insert into the database.');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  try {
    await cli.query(`SELECT set_config('app.bypass_rls','on', false)`); // session-level bypass
    const area = await cli.query(
      `SELECT id FROM assessment_areas WHERE organization_id = $1 AND lower(name) = 'accounts' LIMIT 1`,
      [ORG_ID]
    );
    if (!area.rows.length) throw new Error(`Accounts area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
    const areaId = area.rows[0].id;

    await cli.query('BEGIN');
    // replace any existing Accounts questions for a clean, idempotent seed
    const del = await cli.query(`DELETE FROM assessment_questions WHERE organization_id = $1 AND area_id = $2`, [ORG_ID, areaId]);
    // balance correct-answer positions across the whole bank
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
    console.log(`Deleted ${del.rowCount} old Accounts questions; inserted ${inserted} new (area_id ${areaId}).`);
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
