require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Accounts question bank — BATCH 2 (top-up). Adds new, distinct MCQs to
// existing counts (40/40/35/35) to reach 80/80/80/80 per level. This is an
// ADDITIVE script — it does NOT delete existing Accounts questions, only
// inserts new ones after checking for duplicate question text against the
// current bank. Format: [q, A, B, C, D, correct].
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'accounts';

const INTERN = [
  ["Bookkeeping mainly involves the:", "Analysis and interpretation of accounts", "Recording of day-to-day transactions", "Preparation of the budget", "Filing of tax returns", "B"],
  ["Accounting, as distinct from bookkeeping, additionally involves:", "Only recording transactions", "Classifying, summarising and interpreting recorded data", "Only posting to the ledger", "Only preparing vouchers", "B"],
  ["The double entry system of accounting means every transaction affects:", "Only one account", "At least two accounts", "Only the cash account", "No account", "B"],
  ["Under the single entry system, records are generally kept for:", "Both personal and impersonal accounts fully", "Personal accounts and cash, without complete impersonal accounts", "Only nominal accounts", "Only real accounts", "B"],
  ["Under cash basis of accounting, income and expenses are recorded when:", "They are earned or incurred", "Cash is actually received or paid", "The financial year ends", "The invoice is raised", "B"],
  ["Under accrual basis of accounting, income and expenses are recorded when:", "Cash is received or paid", "They are earned or incurred, regardless of cash movement", "Only at year end", "Never recorded", "B"],
  ["Companies are generally required to maintain their accounts on the:", "Cash basis", "Accrual basis", "Either basis, freely chosen every year", "No fixed basis", "B"],
  ["A source document that evidences a cash sale is a:", "Cash memo", "Bill of exchange", "Debenture", "Board resolution", "A"],
  ["A cheque is an example of a:", "Nominal account", "Source document for a bank transaction", "Contra voucher only", "Real account balance", "B"],
  ["A pay-in-slip is used to record a:", "Cash payment made by the business", "Deposit of cash/cheque into a bank account", "Sale of goods", "Purchase return", "B"],
  ["The book used to record credit sales only (not cash sales) is the:", "Sales book (subsidiary book)", "Cash book", "Purchases book", "Journal proper", "A"],
  ["The book used to record credit purchases only is the:", "Sales book", "Purchases book (subsidiary book)", "Cash book", "Petty cash book", "B"],
  ["The subsidiary book used to record sales returns is the:", "Sales return (returns inward) book", "Purchase return book", "Bills receivable book", "Journal proper", "A"],
  ["The subsidiary book used to record purchase returns is the:", "Sales return book", "Purchase return (returns outward) book", "Bills payable book", "Cash book", "B"],
  ["Transactions that do not fit into any subsidiary book are recorded in the:", "Sales book", "Journal proper", "Purchases book", "Cash book", "B"],
  ["The imprest system is most commonly associated with the:", "Bank reconciliation", "Petty cash book", "Trial balance", "Balance sheet", "B"],
  ["Under the imprest system, the petty cashier is reimbursed to restore the:", "Profit for the period", "Fixed float/imprest amount", "Bank overdraft limit", "Share capital", "B"],
  ["'b/d' written against an account balance stands for:", "Brought down", "Balance deleted", "Bank deposit", "Bad debt", "A"],
  ["'c/d' written against an account balance stands for:", "Cash deposited", "Carried down", "Credit due", "Company debt", "B"],
  ["The reference column in a journal entry that notes the ledger page is called the:", "Narration", "Folio", "Voucher number", "Footnote", "B"],
  ["A brief explanation given below a journal entry describing the transaction is called the:", "Folio", "Narration", "Ledger heading", "Trial balance note", "B"],
  ["A single journal entry that debits/credits more than two accounts is called a:", "Simple entry", "Compound (combined) journal entry", "Opening entry", "Closing entry", "B"],
  ["The entry passed at the start of a new accounting year to bring forward balances is the:", "Closing entry", "Opening entry", "Adjusting entry", "Rectifying entry", "B"],
  ["Entries passed at the year-end to transfer balances of nominal accounts to the P&L account are called:", "Opening entries", "Closing entries", "Contra entries", "Reversing entries", "B"],
  ["An account showing accumulated depreciation charged over the years on an asset is the:", "Asset disposal account", "Provision for depreciation account", "Suspense account", "Capital account", "B"],
  ["When a fixed asset is sold, the profit or loss on sale is normally recorded through a(n):", "Trading account", "Asset disposal account", "Petty cash book", "Sales book", "B"],
  ["An unpresented cheque in a bank reconciliation refers to a cheque:", "Issued by the business but not yet presented to the bank for payment", "Received but not yet banked", "Dishonoured by the bank", "Cancelled by the drawer", "A"],
  ["An uncredited cheque (cheque deposited but not yet cleared) in a bank reconciliation causes the:", "Cash book balance to be higher than the pass book", "Pass book balance to be lower than the cash book, until cleared", "Trial balance to disagree", "Suspense account to open", "B"],
  ["A bank overdraft arises when a business:", "Deposits more than it withdraws", "Withdraws more than the balance in its account, within a sanctioned limit", "Issues shares", "Declares a dividend", "B"],
  ["A savings bank account is generally meant for:", "Frequent business transactions with cheque facilities", "Individuals to save money, with limited transactions", "Government treasury operations only", "Only foreign remittances", "B"],
  ["GAAP stands for:", "General Accepted Accounting Principles", "Generally Accepted Accounting Principles", "Government Approved Accounting Procedures", "General Audit and Accounting Practices", "B"],
  ["In India, accounting standards/principles are primarily issued by the:", "Reserve Bank of India", "Institute of Chartered Accountants of India (ICAI)", "Ministry of Finance directly", "SEBI", "B"],
  ["The accounting concept that assumes accounts are prepared for a fixed span, usually one year, is the:", "Going concern concept", "Accounting period concept", "Money measurement concept", "Dual aspect concept", "B"],
  ["The concept that requires anticipating no profit but providing for all possible losses is the:", "Consistency concept", "Conservatism (prudence) concept", "Materiality concept", "Realisation concept", "B"],
  ["The concept requiring the same accounting methods to be followed period after period is the:", "Consistency concept", "Conservatism concept", "Accrual concept", "Cost concept", "A"],
  ["The concept that permits ignoring insignificant items while focusing on items that could influence decisions is the:", "Materiality concept", "Going concern concept", "Dual aspect concept", "Money measurement concept", "A"],
  ["The concept that requires assets to be recorded at their original purchase price is the:", "Realisation concept", "Historical cost concept", "Conservatism concept", "Matching concept", "B"],
  ["The concept that only transactions capable of being expressed in monetary terms are recorded is the:", "Money measurement concept", "Business entity concept", "Going concern concept", "Accrual concept", "A"],
  ["A cash book that records only cash transactions (no bank column) is called a:", "Simple (single column) cash book", "Double column cash book", "Triple column cash book", "Petty cash book only", "A"],
  ["A cash book with both cash and bank columns is called a:", "Simple cash book", "Double column cash book", "Analytical petty cash book", "Ledger", "B"],
];

const EXECUTIVE = [
  ["A capital receipt, unlike a revenue receipt, is one that:", "Recurs regularly from normal operations", "Arises from a non-recurring source, e.g. sale of a fixed asset or issue of shares", "Is always taxable as income", "Is recorded in the Trading account", "B"],
  ["A revenue receipt is generally recorded in the:", "Balance Sheet as a liability", "Profit & Loss Account as income", "Capital account directly", "Trial balance only", "B"],
  ["Deferred revenue expenditure is expenditure whose benefit is:", "Fully consumed within the same year", "Spread over more than one accounting period, though revenue in nature", "Always capitalised permanently", "Never written off", "B"],
  ["Rectification of a one-sided error (affecting only one account) is generally corrected through a:", "Journal entry affecting two accounts", "Suspense account adjustment", "Cash voucher", "Bank reconciliation", "B"],
  ["Rectification of a two-sided error (affecting two accounts) can generally be corrected through a normal:", "Suspense account entry only", "Journal entry", "Cash payment", "Bank transfer", "B"],
  ["When errors are located after the trial balance is prepared and a suspense account was opened, on rectification the suspense account is eventually:", "Increased permanently", "Closed once all errors are corrected", "Converted into a reserve", "Shown as a fixed asset", "B"],
  ["Trade payables is a modern term commonly used interchangeably with:", "Debtors", "Creditors", "Cash", "Stock", "B"],
  ["Trade receivables is a modern term commonly used interchangeably with:", "Creditors", "Debtors", "Bank overdraft", "Reserves", "B"],
  ["Causes of difference between cash book and pass book balances include cheques issued but not presented and:", "Cash sales recorded twice deliberately", "Cheques deposited but not yet collected/credited by the bank", "Purchase of stationery", "Payment of dividend", "B"],
  ["Bank charges debited by the bank but not yet recorded in the cash book will cause the cash book balance (before adjustment) to be:", "Lower than it should be", "Higher than the adjusted balance until recorded", "Exactly equal always", "Irrelevant to reconciliation", "B"],
  ["Direct deposits made by a customer into the business's bank account, unknown to the business, will make the pass book balance:", "Lower than the cash book", "Higher than the cash book until recorded", "Equal to the trial balance", "Equal to the suspense account", "B"],
  ["When goods are given away as free samples, the appropriate treatment is to:", "Ignore the transaction entirely", "Credit purchases and debit advertisement/free samples expense", "Debit sales account", "Credit capital account", "B"],
  ["Goods taken by the proprietor for personal use should be recorded by:", "Crediting purchases and debiting drawings", "Debiting purchases and crediting sales", "Crediting capital only", "No entry required", "A"],
  ["Interest on drawings, when charged, is treated as a(n):", "Expense to the business and income to the proprietor's capital", "Income to the business and reduces drawings' impact on capital", "Loss to be written off", "Liability of the business", "B"],
  ["Interest on capital, when allowed to the proprietor, is treated as a(n):", "Income of the business", "Expense of the business and addition to capital", "Reduction in the bank balance only", "Liability with no effect on capital", "B"],
  ["A bill of exchange is generally used to:", "Record depreciation", "Formalise a credit transaction with a promise to pay on a future date", "Replace the need for a ledger", "Close the books at year end", "B"],
  ["The person who is directed to pay the amount on a bill of exchange is the:", "Drawer", "Drawee", "Payee", "Endorser", "B"],
  ["When a bill of exchange is dishonoured, the amount is generally transferred back to the:", "Suspense account", "Debtor's (drawee's) account as a debt again", "Bank reconciliation statement", "Capital account", "B"],
  ["Endorsement of a bill of exchange means:", "Cancelling the bill", "Transferring the bill's rights to another person by signing on it", "Renewing the due date only", "Writing off the bill as bad debt", "B"],
  ["A promissory note differs from a bill of exchange mainly in that it involves:", "Three parties", "Two parties — the maker (debtor) and payee", "No parties", "Only the bank", "B"],
  ["Amounts written off as irrecoverable from debtors are debited to the:", "Sales account", "Bad debts account", "Purchases account", "Suspense account", "B"],
  ["A provision for doubtful debts is created based on an estimate of:", "Debtors likely to become bad in the future", "Cash likely to be received", "Stock likely to be sold", "Creditors likely to be paid", "A"],
  ["When a provision for doubtful debts already exists and further bad debts occur, the additional amount is generally adjusted against the:", "Sales account directly", "Existing provision, topping it up as needed through the P&L", "Capital account only", "Suspense account permanently", "B"],
  ["A discount allowed to a debtor for prompt payment reduces the amount:", "Payable to a creditor", "Receivable from the debtor", "Of closing stock", "Of fixed assets", "B"],
  ["A discount received from a creditor for prompt payment reduces the amount:", "Receivable from a debtor", "Payable to the creditor", "Of the bank balance immediately", "Of capital", "B"],
  ["Carriage on goods purchased (freight inward) is added to the cost of:", "Sales", "Purchases, in arriving at cost of goods sold", "Fixed assets always", "Capital", "B"],
  ["Wages paid specifically for the erection/installation of machinery are treated as:", "A revenue expense in the P&L account", "Part of the capital cost of the machinery", "A deferred revenue expense", "An abnormal loss", "B"],
  ["Repairs to restore a machine to working condition (not enhancing its capacity) are generally treated as:", "Capital expenditure", "Revenue expenditure", "A capital receipt", "A revenue receipt", "B"],
  ["An addition or extension to an existing asset that increases its capacity is generally treated as:", "Revenue expenditure", "Capital expenditure", "A contingent liability", "A provision", "B"],
  ["A cash discount is recorded in the books, whereas a trade discount is:", "Also always recorded separately in the books", "Deducted directly from the invoice price and not recorded separately", "Never allowed in practice", "Only allowed on cash sales", "B"],
  ["A statement showing the reasons for the difference between the cash book and pass book balances is called a:", "Trial balance", "Bank Reconciliation Statement", "Trading account", "Balance sheet", "B"],
  ["The starting point of a Bank Reconciliation Statement can be either the cash book balance or the:", "Trading account balance", "Pass book (bank statement) balance", "Suspense account balance", "Capital account balance", "B"],
  ["When starting a BRS from the cash book (favourable) balance, a cheque issued but not yet presented is:", "Added", "Deducted", "Ignored", "Multiplied by the interest rate", "A"],
  ["When starting a BRS from the cash book (favourable) balance, a cheque deposited but not yet collected is:", "Added", "Deducted", "Ignored", "Shown as income", "B"],
  ["A dishonoured cheque (previously deposited) that bounces will require the amount to be:", "Added back as a debtor again in the books", "Ignored completely", "Treated as a capital receipt", "Written off automatically as bad debt", "A"],
  ["The three golden rules of accounting apply respectively to real, personal and:", "Capital accounts", "Nominal accounts", "Suspense accounts", "Contra accounts", "B"],
  ["A withdrawal of goods (not cash) by the proprietor for personal use reduces:", "Sales and increases capital", "Purchases/stock and reduces capital (through drawings)", "Only the bank balance", "Only creditors", "B"],
  ["The term 'closing stock' in the current year automatically becomes which figure in the following year?", "Purchases", "Opening stock", "Sales", "Capital", "B"],
  ["An entry passed to correct an error already recorded in the books, without disturbing other correct entries, is called a:", "Closing entry", "Rectifying entry", "Opening entry", "Adjusting entry only for expenses", "B"],
  ["Adjustment entries at the year-end (like outstanding expenses, prepaid expenses) are necessary mainly to ensure the:", "Cash balance matches the bank balance", "Financial statements reflect the correct income and expenses for the period (matching concept)", "Trial balance always tallies without errors", "GST return is filed correctly", "B"],
];

const INTERMEDIATE = [
  ["The Return on Investment (ROI) / Return on Capital Employed ratio broadly measures:", "Liquidity of current assets", "Overall profitability in relation to capital employed", "Speed of stock turnover", "Proportion of debt to equity", "B"],
  ["The Proprietary ratio measures the proportion of:", "Current assets financed by current liabilities", "Total assets financed by owners' funds (proprietor's/shareholders' equity)", "Sales to purchases", "Gross profit to net profit", "B"],
  ["The Fixed Assets Turnover ratio indicates how efficiently a business uses its:", "Current assets to generate sales", "Fixed assets to generate sales", "Cash to pay off creditors", "Capital to pay dividends", "B"],
  ["The Operating ratio is calculated as:", "(Operating cost / Net sales) x 100", "(Net profit / Sales) x 100", "(Gross profit / Sales) x 100", "(Sales / Operating cost) x 100", "A"],
  ["The Payables (Creditors) Turnover ratio is calculated using:", "Net credit purchases / Average creditors", "Net sales / Average debtors", "Cost of goods sold / Average stock", "Current assets / Current liabilities", "A"],
  ["A high inventory turnover ratio generally indicates:", "Slow-moving/excess stock", "Efficient stock management and quick sale of goods", "Poor sales performance", "High storage costs with idle stock", "B"],
  ["A very low current ratio may indicate a risk of:", "Excess idle funds", "Difficulty in meeting short-term obligations", "Over-capitalisation", "Excess profitability", "B"],
  ["A very high current ratio (far above 2:1) may indicate:", "Efficient utilisation of funds", "Idle/excess current assets not being used efficiently", "Certain insolvency", "Zero risk always", "B"],
  ["Under the perpetual inventory system, stock records are updated:", "Only once a year through physical counting", "Continuously, after every purchase and sale", "Only at the time of audit", "Only when stock is lost", "B"],
  ["Under the periodic inventory system, the value of closing stock is generally determined by:", "Continuous record updates", "Physical verification/counting at the end of the period", "Bank reconciliation", "Depreciation schedules", "B"],
  ["Under Ind AS 2 / AS-2, the cost of inventories includes purchase cost, conversion costs and:", "General administrative overheads unrelated to production", "Other costs incurred in bringing the inventories to their present location and condition", "Selling and distribution expenses", "Interest on general borrowings (as a rule)", "B"],
  ["Net Realisable Value (NRV), used for inventory valuation, is estimated selling price less:", "Purchase cost", "Estimated costs of completion and costs necessary to make the sale", "GST payable", "Depreciation", "B"],
  ["An asset is capitalised when the expenditure incurred:", "Provides only a short-term benefit", "Provides an enduring/long-term benefit to the business", "Is fully consumed in the same period", "Relates to routine repairs", "B"],
  ["A deferred tax liability generally arises when the tax base of an asset/liability differs from its:", "Market value", "Carrying (book) amount, creating a temporary difference", "Purchase price only", "GST rate", "B"],
  ["A partnership deed, if not made, results in profits/losses being shared:", "In the capital ratio", "Equally among partners, as per the Partnership Act default rule", "As decided unilaterally by one partner", "In the ratio of loans given", "B"],
  ["In the absence of a partnership deed, a partner is not entitled to any:", "Share of profit", "Salary or commission for participating in the business", "Right to inspect accounts", "Right to retire", "B"],
  ["Goodwill valued using the average profits method is generally computed as:", "Average profits x number of years' purchase", "Total assets - total liabilities", "Sales - purchases", "Capital + reserves", "A"],
  ["Super profit, used in goodwill valuation, is the excess of average profit over:", "Total assets", "Normal profit expected on capital employed", "Total liabilities", "Sales revenue", "B"],
  ["A capital reserve is generally created from:", "Trading profits distributed as dividend", "Capital profits, e.g. profit on sale of a fixed asset or securities premium", "Revenue expenses", "Bad debts recovered", "B"],
  ["A general reserve, unlike a specific reserve, is created for:", "A particular identified future purpose only", "General/undefined future contingencies or strengthening the financial position", "Meeting a known legal liability precisely", "Replacing a specific machine only", "B"],
  ["A sinking fund is generally created for the specific purpose of:", "Meeting a known future liability or replacement of an asset systematically", "Paying salaries", "Recording depreciation only", "Adjusting GST", "A"],
  ["Under the Written Down Value (WDV) method, if the rate is fixed, the amount of depreciation over successive years:", "Remains constant in rupee terms", "Decreases every year since it's applied to a reducing balance", "Increases every year", "Is applied only once", "B"],
  ["Under the Straight Line Method, the depreciation amount over the useful life remains:", "Constant every year (equal instalments)", "Different every year", "Nil after the first year", "Doubled every alternate year", "A"],
  ["A change in the method of depreciation, if made, is generally applied:", "Only prospectively without disclosure", "Retrospectively with proper disclosure, as per applicable accounting standards", "Never permitted under any circumstances", "Only for tax purposes, not books", "B"],
  ["An intangible asset with an indefinite useful life is generally:", "Amortised over a fixed period regardless", "Not amortised but tested for impairment", "Written off in the year of purchase fully", "Always capitalised as goodwill", "B"],
  ["Impairment of an asset is recognised when its carrying amount exceeds its:", "Original cost", "Recoverable amount", "Insured value", "Written down value under tax law only", "B"],
  ["A contra entry between cash and bank columns of a cash book requires no posting to the ledger because:", "It is not a real transaction", "Both aspects are already recorded within the cash book itself", "It relates to GST only", "The transaction is illegal", "B"],
  ["When shares are forfeited for non-payment of calls, the amount already received on those shares is transferred to:", "Securities premium", "Forfeited shares account (pending reissue)", "General reserve directly", "Capital reserve immediately without conditions", "B"],
  ["On reissue of forfeited shares at a discount, the discount allowed cannot exceed the amount:", "Of the securities premium", "Already forfeited and standing to the credit of that share", "Of the face value entirely, without limit", "Of the general reserve", "B"],
  ["The provisions for maintaining minimum subscription in a share issue exist to ensure:", "That every applicant gets full allotment always", "The company has sufficient funds to commence the project as stated in the prospectus", "That the company can accept any level of funding", "That shares are issued at a discount", "B"],
  ["A right of set-off (netting) between a debtor and a creditor balance is generally permitted only when:", "The amounts happen to be equal by chance", "There is a legally enforceable right to set off, as per accounting standards", "The auditor personally decides so", "GST registration numbers match", "B"],
  ["Under accounting standards, related party disclosures require reporting entities to disclose transactions with:", "Only government departments", "Parties that can control or significantly influence the reporting entity (or vice versa)", "Only foreign customers", "Only banks providing loans", "B"],
  ["A change in an accounting estimate (e.g. useful life of an asset) is applied:", "Retrospectively by restating prior years", "Prospectively, from the period of change onward", "Never allowed", "Only through a court order", "B"],
  ["Prior period items, once identified, are generally:", "Ignored completely", "Disclosed separately so their impact on the current profit/loss is clear", "Merged silently into current year figures with no disclosure", "Adjusted only against GST liability", "B"],
  ["An Extraordinary item (under older accounting norms) referred to income/expense arising from events that were:", "Regular and recurring", "Distinct from ordinary activities and not expected to recur frequently", "Related to routine sales", "Related to normal purchase transactions", "B"],
  ["The term 'net worth' of a business broadly refers to:", "Total assets only", "Total assets minus total (outside) liabilities", "Total sales for the year", "Total liabilities only", "B"],
  ["A qualifying asset, for the purpose of capitalising borrowing costs, is one that:", "Is ready for use immediately upon purchase", "Necessarily takes a substantial period of time to get ready for its intended use or sale", "Has no cost at all", "Is always a current asset", "B"],
  ["Borrowing costs directly attributable to acquiring/constructing a qualifying asset are generally:", "Always expensed immediately regardless of the asset", "Capitalised as part of the cost of that asset, subject to conditions", "Ignored entirely in accounting", "Treated as a contingent liability", "B"],
  ["A liability is classified as current if it is expected to be settled within:", "Five years", "The normal operating cycle or twelve months, whichever is applicable", "Fifty years", "Only after the company's dissolution", "B"],
  ["An asset is classified as current if it is expected to be realised, sold, or consumed within:", "The normal operating cycle or twelve months, whichever is applicable", "Only five years", "Only ten years", "Never, by definition", "A"],
  ["Events occurring after the balance sheet date that provide evidence of conditions existing at that date are called:", "Contingent events", "Adjusting events (requiring adjustment to the financial statements)", "Non-adjusting events always", "Prior period items only", "B"],
  ["Events after the balance sheet date that indicate conditions arising after that date (not adjusting) are still required to be:", "Ignored completely", "Disclosed if material, even though not adjusted in the figures", "Adjusted directly without disclosure", "Reported only to the bank", "B"],
  ["The going concern assumption is reconsidered by management primarily at the time of:", "Filing GST returns", "Preparing the financial statements for the period", "Filing incorporation documents", "Applying for a trademark", "B"],
  ["A change in the reporting entity (e.g., due to a merger presented as if entities always combined) generally requires:", "No disclosure at all", "Restatement of comparative information with appropriate disclosure", "Deletion of all prior year figures", "Filing a fresh company incorporation", "B"],
  ["A bank reconciliation prepared regularly (e.g. monthly) mainly helps detect:", "GST filing errors", "Errors, omissions, or fraud in either the cash book or the bank's records", "Only depreciation mistakes", "Only payroll mistakes", "B"],
];

const EXPERT = [
  ["Under Ind AS 105, a non-current asset held for sale is measured at the lower of its carrying amount and:", "Historical cost", "Fair value less costs to sell", "Replacement cost", "Insured value", "B"],
  ["Ind AS 1 primarily deals with the:", "Presentation of Financial Statements", "Cash Flow Statement", "Inventories", "Revenue Recognition", "A"],
  ["Ind AS 8 deals with Accounting Policies, Changes in Accounting Estimates and:", "Revenue", "Errors", "Leases", "Inventories", "B"],
  ["Ind AS 10 deals with:", "Events after the Reporting Period", "Income Taxes", "Employee Benefits", "Related Party Disclosures", "A"],
  ["Ind AS 19 deals with:", "Employee Benefits", "Inventories", "Leases", "Revenue", "A"],
  ["Ind AS 23 deals with:", "Government Grants", "Borrowing Costs", "Related Party Disclosures", "Segment Reporting", "B"],
  ["Ind AS 24 deals with:", "Related Party Disclosures", "Borrowing Costs", "Employee Benefits", "Earnings Per Share", "A"],
  ["Ind AS 33 deals with:", "Earnings Per Share", "Segment Reporting", "Interim Financial Reporting", "Government Grants", "A"],
  ["Ind AS 36 deals with:", "Impairment of Assets", "Inventories", "Leases", "Revenue", "A"],
  ["Ind AS 37 deals with Provisions, Contingent Liabilities and:", "Revenue", "Contingent Assets", "Leases", "Employee Benefits", "B"],
  ["Ind AS 40 deals with:", "Investment Property", "Property, Plant and Equipment", "Inventories", "Leases", "A"],
  ["Ind AS 108 deals with:", "Operating Segments", "Revenue", "Leases", "Income Taxes", "A"],
  ["A provision, under Ind AS 37, is recognised when there is a present obligation, a probable outflow of resources, and:", "The amount can be reliably estimated", "The company has no other liabilities", "The auditor approves it verbally", "It relates to a capital asset", "A"],
  ["A contingent liability, unlike a provision, is generally:", "Recognised in the balance sheet as a liability", "Disclosed by way of a note, as its existence depends on an uncertain future event", "Ignored entirely", "Treated the same as a provision in all respects", "B"],
  ["A contingent asset is generally:", "Recognised as an asset immediately", "Not recognised, but disclosed where an inflow of economic benefits is probable", "Treated the same as a provision", "Written off as a loss", "B"],
  ["Under Ind AS 16, subsequent expenditure on Property, Plant and Equipment is capitalised only if it:", "Merely maintains the asset's originally assessed performance", "Increases the future economic benefits beyond the originally assessed standard", "Is incurred every year regardless of benefit", "Relates to routine cleaning", "B"],
  ["Under Ind AS 16, an entity can subsequently measure PPE using the cost model or the:", "Net realisable value model", "Revaluation model", "Historical model only", "Market speculation model", "B"],
  ["A finance lease, under Ind AS 116 (from the lessee's perspective, historically), was one that transferred substantially all the risks and rewards of:", "Employment", "Ownership of the asset to the lessee", "Only usage rights temporarily", "Only maintenance obligations", "B"],
  ["Under Ind AS 116, lessees are generally required to recognise a right-of-use asset and a corresponding:", "Trade payable", "Lease liability", "Contingent asset", "Deferred tax asset only", "B"],
  ["A finance lease liability is initially measured at the present value of:", "Future maintenance costs only", "Lease payments not yet paid, discounted appropriately", "The asset's insured value", "Zero, since no liability arises", "B"],
  ["Under Ind AS 12, current tax is the amount of income tax:", "Payable/recoverable in respect of the taxable profit/loss for a period", "Payable after ten years", "Recognised only in consolidated accounts", "Never recognised in standalone accounts", "A"],
  ["A deferred tax asset is recognised to the extent it is probable that:", "The company will never earn taxable profit", "Future taxable profit will be available against which it can be utilised", "GST refunds will be received", "The company will be wound up soon", "B"],
  ["Under Ind AS 33, diluted EPS considers the effect of:", "Only equity shares actually issued", "Potential equity shares (e.g. convertible instruments/options) that could dilute EPS", "Preference share redemption only", "Bank loan interest only", "B"],
  ["A qualifying asset's capitalisation of borrowing costs under Ind AS 23 generally ceases when:", "The asset is substantially ready for its intended use or sale", "The company changes its auditor", "The financial year starts", "The loan is renewed", "A"],
  ["Under Ind AS 21, a foreign currency transaction is initially recorded using the exchange rate at the:", "Balance sheet date always", "Date of the transaction", "Date of payment only", "Average rate for the whole year always", "B"],
  ["Under Ind AS 21, monetary items denominated in a foreign currency are translated at the:", "Historical rate permanently", "Closing rate at each balance sheet date", "Average rate of the last five years", "Budgeted rate", "B"],
  ["Under Ind AS 38, internally generated goodwill is:", "Recognised as an intangible asset", "Not recognised as an asset", "Amortised over 10 years", "Capitalised at market value", "B"],
  ["Research costs, under Ind AS 38, are generally:", "Capitalised as an intangible asset", "Expensed as incurred", "Deferred indefinitely", "Treated as a contingent asset", "B"],
  ["Development costs, under Ind AS 38, may be capitalised only if specified recognition criteria (e.g. technical feasibility) are:", "Never required to be met", "Met, demonstrating the asset will generate future economic benefits", "Approved by the Registrar of Companies", "Approved by GST authorities", "B"],
  ["Under Ind AS 115, revenue is recognised when (or as) an entity satisfies a:", "Board resolution", "Performance obligation by transferring control of goods/services to the customer", "Tax audit requirement", "Bank reconciliation", "B"],
  ["The five-step model under Ind AS 115 begins with identifying the:", "Transaction price", "Contract(s) with a customer", "Performance obligations", "Standalone selling price", "B"],
  ["Under Ind AS 105, once classified as held for sale, a non-current asset is generally:", "Depreciated as usual", "Not depreciated further", "Depreciated at double the normal rate", "Immediately written off to zero", "B"],
  ["A business combination, under Ind AS 103, is generally accounted for using the:", "Pooling of interests method exclusively", "Acquisition method", "Equity method only", "Cost method only, with no fair valuation", "B"],
  ["Under the acquisition method, identifiable assets acquired and liabilities assumed are generally measured at their:", "Historical book values of the acquiree", "Acquisition-date fair values", "Original purchase price to the acquiree", "Zero value", "B"],
  ["Under Ind AS 28, an associate is an entity over which the investor has:", "Control", "Significant influence, but not control", "No influence at all", "Joint control only", "B"],
  ["Under Ind AS 28, investments in associates are generally accounted for using the:", "Cost method exclusively", "Equity method", "Consolidation method identical to subsidiaries", "Fair value model only", "B"],
  ["A joint arrangement where parties have rights to the net assets is classified as a:", "Joint operation", "Joint venture", "Subsidiary", "Associate always", "B"],
  ["Segment reporting under Ind AS 108 is primarily intended to help users evaluate the nature and financial effects of the:", "GST paid by the company", "Different business activities/economic environments the entity operates in", "Personal investments of directors", "Trademark portfolio only", "B"],
  ["An operating segment, under Ind AS 108, is identified based on the internal reports reviewed regularly by the entity's:", "External auditor", "Chief Operating Decision Maker (CODM)", "Registrar of Companies", "Tax department", "B"],
  ["Comparability of financial statements across periods and companies is primarily supported by consistent application of:", "Personal judgement of the accountant, varying each year", "Accounting policies and standards", "Random estimation techniques", "Different currencies each year", "B"],
  ["The 'substance over form' principle requires transactions to be accounted for based on their:", "Legal form alone, ignoring economic reality", "Economic substance/reality, even if it differs from legal form", "Tax treatment only", "GST classification only", "B"],
  ["Fair value, as generally defined in accounting standards, is the price that would be received to sell an asset in an:", "Forced liquidation sale", "Orderly transaction between market participants at the measurement date", "Related party transaction only", "Auction under distress", "B"],
  ["A qualifying asset ceasing active development for an extended period generally requires the entity to:", "Continue capitalising borrowing costs regardless", "Suspend capitalisation of borrowing costs during that extended period", "Immediately write off the asset", "Ignore the suspension and capitalise interest anyway", "B"],
  ["Under Ind AS 7, cash flows are classified into operating, investing and:", "Speculative activities", "Financing activities", "Contingent activities", "Deferred activities", "B"],
  ["A change in accounting policy is applied, unless a standard specifies otherwise, by:", "Restating figures only for the current year", "Retrospective application, adjusting the opening balance of the earliest period presented", "Ignoring all prior periods", "Applying it only to future transactions with no restatement", "B"],
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
  console.log('Accounts BATCH 2 (new questions):', JSON.stringify(counts), '=> total', total);

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

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const cli = await pool.connect();
  try {
    await cli.query(`SELECT set_config('app.bypass_rls','on', false)`);
    const area = await cli.query(
      `SELECT id FROM assessment_areas WHERE organization_id = $1 AND lower(name) = $2 LIMIT 1`,
      [ORG_ID, AREA_NAME]
    );
    if (!area.rows.length) throw new Error(`Accounts area not found for org ${ORG_ID}.`);
    const areaId = area.rows[0].id;

    // Duplicate check against the ENTIRE existing question bank (all areas),
    // not just Accounts, so batch-2 content never repeats anything already live.
    const existing = await cli.query(`SELECT lower(trim(question_text)) AS t FROM assessment_questions WHERE organization_id = $1`, [ORG_ID]);
    const existingSet = new Set(existing.rows.map(r => r.t));
    let dupes = 0;
    for (const [level, arr] of Object.entries(SETS)) {
      arr.forEach(([q]) => {
        const key = q.toLowerCase().trim();
        if (existingSet.has(key)) { dupes++; console.log(`  DUPLICATE (${level}): "${q}"`); }
      });
    }
    if (dupes) {
      console.log(`Found ${dupes} duplicate(s) against the existing bank. Fix before applying.`);
      if (apply) { process.exitCode = 1; cli.release(); await pool.end(); return; }
    } else {
      console.log('No duplicates against the existing question bank.');
    }

    if (!apply) {
      console.log('Dry run. Use --apply to insert into the database.');
      cli.release();
      await pool.end();
      return;
    }

    await cli.query('BEGIN');
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
    console.log(`Inserted ${inserted} NEW Accounts questions (existing 150 untouched).`);
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
