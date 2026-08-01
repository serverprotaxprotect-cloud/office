require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Income Tax question bank — BATCH 2 (top-up). Additive: adds new, distinct
// MCQs to reach 80/80/80/80 per level (from 40/40/35/35). Does NOT delete
// existing Income Tax questions. Format: [q, A, B, C, D, correct].
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'income tax';

const INTERN = [
  ["The fourth character of a PAN generally indicates the holder's status, e.g. 'P' for:", "Company", "Individual", "Firm", "Trust", "B"],
  ["ITR stands for:", "Income Tax Refund", "Income Tax Return", "Indirect Tax Return", "Investment Tax Ratio", "B"],
  ["An 'assessee' under the Income Tax Act is broadly a person by whom:", "No tax is ever payable", "Income tax or any other sum is payable under the Act", "Only GST is payable", "Only TDS is deducted from others", "B"],
  ["Gross Total Income is the aggregate of income computed under all applicable heads, arrived at:", "After all Chapter VI-A deductions", "Before allowing deductions under Chapter VI-A (like 80C, 80D)", "After tax is paid", "Only from salary income", "B"],
  ["Total (taxable) Income is generally computed as:", "Gross Total Income plus deductions", "Gross Total Income minus eligible deductions under Chapter VI-A", "Only exempt income", "Net profit as per the profit and loss account", "B"],
  ["Form 26AS is best described as a taxpayer's:", "Salary slip", "Consolidated annual tax statement showing TDS/TCS and taxes paid", "Company balance sheet", "GST return", "B"],
  ["The Annual Information Statement (AIS) provides a taxpayer with a comprehensive view of:", "Only their salary income", "Various financial transactions reported to the tax department", "Only their GST filings", "Only their bank loan details", "B"],
  ["Verification of an electronically filed ITR can generally be done through Aadhaar OTP, net banking, or:", "A physical stamp only", "A Digital Signature Certificate (DSC) / Electronic Verification Code (EVC)", "A notarised affidavit only", "A bank guarantee", "B"],
  ["If an ITR is not e-verified, the taxpayer is generally required to send a signed ITR-V to the:", "Local police station", "Centralized Processing Centre (CPC), Bengaluru", "State GST office", "Company's registered office", "B"],
  ["TDS on salary under Section 192 is deducted based on the employee's:", "A flat 10% rate always", "Estimated total income and the applicable slab rate for the year", "GST registration status", "Company's turnover", "B"],
  ["The final instalment of advance tax for non-corporate taxpayers is generally due by:", "15 June", "15 September", "15 December", "15 March", "D"],
  ["The presumptive taxation turnover limit under Section 44AD for eligible businesses is generally around:", "50 lakh", "1 crore (higher limit available for mostly digital receipts)", "10 crore always", "No limit at all", "B"],
  ["The presumptive taxation gross receipts limit for professionals under Section 44ADA is generally around:", "10 lakh", "50 lakh (higher limit available for mostly digital receipts)", "5 crore", "No limit at all", "B"],
  ["A standard deduction is available to salaried employees as well as to:", "Only business owners", "Pensioners, on their pension income", "Only company directors", "Only non-residents", "B"],
  ["A Hindu Undivided Family (HUF) is treated under the Income Tax Act as a:", "Branch of the individual member's income", "Distinct, separately assessable person", "Type of company", "Type of trust only", "B"],
  ["The manager who looks after the affairs of a Hindu Undivided Family is called the:", "Trustee", "Karta", "Director", "Proprietor", "B"],
  ["Income arising to a spouse from assets transferred without adequate consideration is generally subject to:", "No clubbing at all", "Clubbing with the transferor's income under the clubbing provisions", "Automatic exemption", "GST, not income tax", "B"],
  ["A minor child's income is generally clubbed with the income of the parent whose total income (before clubbing) is:", "Lower", "Higher", "Exactly equal", "Irrelevant to clubbing", "B"],
  ["Clubbed minor's income is generally eligible for a small exemption per child under:", "Section 10(32)", "Section 80C", "Section 54", "Section 24", "A"],
  ["Income clubbing provisions generally do NOT apply to income earned by a minor from their own:", "Gifts received from relatives", "Manual work, skill, talent, or specialised knowledge/experience", "Bank fixed deposits gifted by parents", "Shares gifted by grandparents", "B"],
  ["Agricultural income, though generally exempt, may still be considered for computing the applicable tax rate on non-agricultural income under a method called:", "Direct taxation", "Partial integration (aggregation for rate purposes)", "Presumptive taxation", "Clubbing of income", "B"],
  ["For a newly set-up business, the 'previous year' generally begins from the date the business is set up and ends on the:", "Same date next year", "Last day of that financial year (31 March)", "Date of the first sale only", "Date of GST registration", "B"],
  ["Banks are generally required to deduct TDS on interest on fixed deposits only if the interest exceeds a prescribed threshold in a year, which is generally higher for:", "Non-resident depositors", "Senior citizens", "Companies", "Partnership firms", "B"],
  ["Form 15G is generally submitted by an eligible person to avoid TDS deduction where their income is below the taxable limit, while Form 15H is meant specifically for:", "Non-resident taxpayers", "Senior citizen taxpayers", "Companies", "Partnership firms", "B"],
  ["The Income Tax Department provides an online/offline utility to help taxpayers prepare and file their:", "GST returns", "Income Tax Return", "Trademark applications", "Company incorporation forms", "B"],
  ["If the tax already paid (TDS/advance tax) is less than the total tax liability, the taxpayer generally needs to pay the shortfall as:", "Refund", "Self-assessment tax, before filing the return", "GST", "Stamp duty", "B"],
  ["Excess tax paid by a taxpayer compared to their actual liability is generally claimed back through:", "A fresh PAN application", "A refund claimed in the Income Tax Return", "A GST refund application", "A separate court petition always", "B"],
  ["Interest on delayed refunds granted by the Income Tax Department to a taxpayer is dealt with under:", "Section 234A", "Section 244A", "Section 271", "Section 132", "B"],
  ["Quoting of PAN is generally mandatory for specified high-value transactions such as:", "Buying groceries", "Large property or specified financial transactions above prescribed limits", "Paying a small electricity bill", "Buying a cinema ticket", "B"],
  ["Linking of Aadhaar with PAN has generally been made a requirement, failing which the PAN may become:", "More valid", "Inoperative, subject to prescribed consequences", "Automatically cancelled by GST", "Transferred to another person", "B"],
  ["Before filing an ITR, taxpayers are generally advised to reconcile their TDS/TCS details with:", "Only their bank passbook", "Form 26AS and the Annual Information Statement (AIS)", "Only their salary slip", "Only their GST returns", "B"],
  ["Income Tax Return forms applicable to an assessee generally depend on factors such as the:", "Colour of their PAN card", "Nature and amount of income, and the category of the assessee", "Number of bank accounts held", "Number of trademarks owned", "B"],
  ["Filing an Income Tax Return within the due date is important, among other reasons, to enable the carry-forward of certain:", "Exempt incomes only", "Losses (as permitted under the Act)", "GST credits", "Trademark rights", "B"],
  ["A 'previous year' immediately followed by an 'assessment year' means income is generally:", "Taxed in the same year it is earned, always without any subsequent process", "Earned in the previous year and assessed/taxed in the following assessment year", "Assessed 5 years after being earned", "Never assessed at all", "B"],
  ["A resident individual is generally required to disclose details of foreign assets/income (if any) in their ITR mainly to ensure compliance related to:", "GST on exports", "Global income taxation and reporting obligations for residents", "Trademark registration abroad", "Company incorporation abroad", "B"],
  ["The 'status' of an assessee (e.g., individual, HUF, company, firm) affects, among other things, the applicable:", "GST rate", "Tax rates, deductions, and compliance requirements", "Trademark class", "Import-export code", "B"],
  ["An income tax refund, once processed, is generally credited directly to the taxpayer's:", "Postal address by cheque only", "Bank account, based on details validated in the return", "GST portal wallet", "Employer's account", "B"],
  ["A 'return of loss' is a return filed by a taxpayer even though their income is a loss, primarily to:", "Avoid ever filing again", "Claim the benefit of carrying forward that loss to future years, subject to conditions", "Get an automatic refund with no scrutiny", "Avoid TDS on future income entirely", "B"],
  ["The basic exemption limit (income up to which no tax is payable) is generally different for individuals under the old regime based on their:", "State of residence", "Age category (below 60, 60–80, above 80 years)", "Number of dependents", "Employer's turnover", "B"],
  ["An individual/HUF is generally free to choose between the old tax regime and a newer concessional regime, subject to conditions, when filing their:", "GST return", "Income Tax Return, exercising the option as prescribed", "Trademark renewal", "Company annual return", "B"],
];

const EXECUTIVE = [
  ["TDS on interest on securities (other than interest covered under Section 194A) is dealt with under:", "Section 192", "Section 193", "Section 194", "Section 195", "B"],
  ["TDS on winnings from lotteries, crossword puzzles, or card games is dealt with under Section 194B, generally at a flat rate around:", "10%", "20%", "30%", "5%", "C"],
  ["TDS on winnings from online games is dealt with under a dedicated section, generally:", "Section 194B", "Section 194BA", "Section 194C", "Section 194J", "B"],
  ["TDS on insurance commission is dealt with under:", "Section 194D", "Section 194C", "Section 194H", "Section 194J", "A"],
  ["TDS on payments to non-residents (where chargeable to tax in India) is dealt with under:", "Section 192", "Section 194C", "Section 195", "Section 194J", "C"],
  ["A taxpayer expecting a lower or nil TDS deduction can apply to the Assessing Officer for a certificate under:", "Section 195", "Section 197", "Section 206AA", "Section 234C", "B"],
  ["Non-furnishing of PAN to the deductor generally results in TDS being deducted at a rate that is:", "Lower than normal", "Higher than the normal applicable rate, as prescribed under Section 206AA", "Zero", "Refundable immediately without return filing", "B"],
  ["Forms 15CA and 15CB are commonly associated with compliance requirements for:", "Domestic salary payments", "Foreign remittances chargeable to tax", "GST refund applications", "Company incorporation", "B"],
  ["The quarterly TDS return for salary payments (Section 192) is filed in form:", "24Q", "26Q", "27Q", "27EQ", "A"],
  ["The quarterly TDS return for non-salary payments to residents is generally filed in form:", "24Q", "26Q", "27Q", "27EQ", "B"],
  ["The quarterly TDS return for payments to non-residents is generally filed in form:", "24Q", "26Q", "27Q", "27EQ", "C"],
  ["The quarterly TCS return is generally filed in form:", "24Q", "26Q", "27Q", "27EQ", "D"],
  ["TDS deducted in a month is generally required to be deposited with the government by the 7th of the following month, except for March, where the due date is generally:", "7 April", "30 April", "31 May", "30 June", "B"],
  ["Premature withdrawal from a recognised Provident Fund before completing a specified period of continuous service may attract TDS, primarily to discourage:", "Long-term savings", "Early withdrawal, by taxing the accumulated benefit in certain cases", "Filing of returns", "Employer contributions", "B"],
  ["The valuation of perquisites such as rent-free accommodation provided by an employer is generally governed by prescribed:", "GST valuation rules", "Income-tax Rules (e.g., Rule 3)", "Companies Act rules", "SEBI regulations", "B"],
  ["Leave Travel Concession/Allowance (LTA) exemption is generally available for a limited number of journeys within a specified block of:", "1 year", "2 years", "4 years", "10 years", "C"],
  ["Gratuity received by a non-government employee covered under the Payment of Gratuity Act is exempt up to a prescribed monetary ceiling and:", "Actual gratuity received, whichever is lower", "No ceiling limit at all", "Only 10% of gratuity received", "Only if the employee is over 60 years old", "A"],
  ["Leave encashment received on retirement by a non-government employee is exempt up to a prescribed ceiling under:", "Section 10(10AA)", "Section 10(10)", "Section 80C", "Section 24", "A"],
  ["Compensation received under a Voluntary Retirement Scheme (VRS) is eligible for exemption, subject to conditions and a monetary ceiling, under:", "Section 10(10B)", "Section 10(10C)", "Section 80C", "Section 54", "B"],
  ["Section 80TTB provides a higher deduction (compared to Section 80TTA) on interest income specifically for:", "Non-resident taxpayers", "Senior citizens", "Partnership firms", "Companies", "B"],
  ["Employer's contribution to NPS is eligible for a deduction to the employee under Section 80CCD(2), generally capped at a percentage of salary, which can be higher for:", "Private sector employees always", "Central Government employees, as per the applicable notified percentage", "Non-resident employees", "Minor employees", "B"],
  ["House Rent Allowance (HRA) exemption is generally computed as the least of specified components, including actual HRA received, rent paid minus 10% of salary, and:", "A flat 50,000 regardless of city", "A prescribed percentage of salary depending on the city of residence", "The employee's total tax liability", "The employer's turnover", "B"],
  ["Interest deduction on a housing loan for a let-out property is generally allowed:", "Up to a ceiling of 2 lakh only", "Without any monetary ceiling, subject to overall set-off restrictions against other heads", "Only if the property is self-occupied", "Not at all", "B"],
  ["Pre-construction period interest on a housing loan is generally allowed as a deduction in equal instalments spread over:", "1 year only", "5 years, starting from the year of completion", "10 years", "It is never allowed", "B"],
  ["The standard deduction on income from a let-out house property under Section 24(a) is generally:", "10% of net annual value", "30% of net annual value, irrespective of actual expenditure", "50% of net annual value", "100% of net annual value", "B"],
  ["Arrears of rent received by a property owner are generally taxed in the:", "Year to which they relate", "Year of actual receipt, after a standard deduction, under Section 25A", "Year of the tenant's departure", "Never taxed", "B"],
  ["A gift of money exceeding a prescribed threshold received without consideration from a non-relative is generally taxable under:", "Section 54", "Section 56(2)(x)", "Section 80C", "Section 10(10D)", "B"],
  ["The exempted category of 'relatives' for gift taxation purposes generally includes the individual's spouse, siblings, and:", "Any close friend", "Lineal ascendants/descendants such as parents and children", "Any business partner", "Any co-worker", "B"],
  ["Winnings from horse races and specified card games/gambling activities are generally taxed at a special flat rate under:", "Section 111A", "Section 112", "Section 115BB", "Section 115BAC", "C"],
  ["Unexplained cash credits appearing in the books of an assessee, if not satisfactorily explained, may be added to income under:", "Section 68", "Section 24", "Section 54", "Section 80C", "A"],
  ["Unexplained investments not recorded in the books, if unsatisfactorily explained, may be added to income under:", "Section 68", "Section 69", "Section 80C", "Section 10", "B"],
  ["Set-off of a loss from house property against salary income in a year is generally restricted to a ceiling of:", "50,000", "1,00,000", "2,00,000", "No limit at all", "C"],
  ["TDS on payments by an individual/HUF (not liable to tax audit) to a resident for professional/technical services, above a prescribed aggregate threshold in a year, is dealt with under:", "Section 194J", "Section 194M", "Section 194C", "Section 194I", "B"],
  ["Tax collection at source on overseas remittances under the Liberalised Remittance Scheme (LRS), above specified limits, is dealt with under:", "Section 194Q", "Section 206C(1G)", "Section 194-IA", "Section 44AB", "B"],
  ["TCS on the sale of an overseas tour package is also generally covered under the same broad provision as LRS remittances, namely:", "Section 194Q", "Section 206C(1G)", "Section 44AD", "Section 80C", "B"],
  ["A composite payment for a house property that includes both rent for the building and charges for amenities/services may, where separable, have the service portion taxed under the head:", "Salaries", "Income from Other Sources", "Capital Gains", "Exempt Income", "B"],
  ["Unrealised rent that a landlord is unable to recover from a tenant can generally be deducted while computing the property's:", "Cost of acquisition", "Actual rent received/receivable for the year, subject to conditions", "Standard deduction rate", "TDS liability", "B"],
  ["A deemed owner of a house property under Section 27 includes, among others, a person who has transferred the property to their spouse without adequate consideration, subject to certain exceptions such as transfers in connection with:", "Any commercial sale to a third party", "An agreement to live apart", "A gift to an unrelated friend", "A trademark assignment", "B"],
  ["An individual receiving family pension (as opposed to salary) is generally eligible for a distinct, smaller:", "Section 80C deduction", "Standard deduction specific to family pension", "HRA exemption", "Gratuity exemption", "B"],
  ["TDS on payment of rent by an individual/HUF not liable to tax audit, above a prescribed monthly threshold, is dealt with under a dedicated section distinct from the general rent TDS provision, namely:", "Section 194-I", "Section 194-IB", "Section 194C", "Section 194J", "B"],
];

const INTERMEDIATE = [
  ["A loss from a speculative business can generally be set off only against:", "Any business income", "Income from another speculative business", "Salary income", "House property income", "B"],
  ["A loss from the activity of owning and maintaining race horses can generally be carried forward for a maximum of:", "2 years", "4 years", "8 years", "Indefinitely", "B"],
  ["Unabsorbed depreciation, once carried forward, can generally be set off against income under almost any head, except:", "House property income", "Business income", "Salary income", "Capital gains", "C"],
  ["Capital gains exemption on the compulsory acquisition of land/building used for an industrial undertaking, upon reinvestment, is available under:", "Section 54", "Section 54D", "Section 54EC", "Section 54F", "B"],
  ["Capital gains exemption available on shifting an industrial undertaking from an urban area to a rural area/SEZ, subject to conditions, is available under:", "Section 54B", "Section 54D", "Section 54G/54GA", "Section 54F", "C"],
  ["Capital gains exemption on transfer of agricultural land, on reinvestment in another agricultural land, is available under:", "Section 54B", "Section 54EC", "Section 54F", "Section 54D", "A"],
  ["The cost of acquisition for computing capital gains on bonus shares is generally taken as:", "The face value of the original shares", "Nil, since no cost was actually incurred for the bonus shares", "The market price on the date of allotment", "The indexed cost of the original shares", "B"],
  ["Under Section 50C, for transfer of land/building held as a capital asset, the full value of consideration is generally taken as the higher of the actual sale consideration or the:", "Book value in the seller's accounts", "Stamp duty value, subject to a prescribed tolerance band", "Insured value", "Market value assessed by a bank", "B"],
  ["A provision similar to Section 50C, but applicable when immovable property is held as stock-in-trade (a business asset), is:", "Section 43CA", "Section 50B", "Section 54F", "Section 45", "A"],
  ["A slump sale (transfer of a business undertaking as a going concern for a lump sum) is taxed as capital gains, computed with reference to the undertaking's:", "Book value of individual assets", "Net worth, as prescribed under Section 50B", "Market value of goodwill alone", "GST turnover", "B"],
  ["A short-term capital loss can generally be set off against:", "Only short-term capital gains", "Both short-term and long-term capital gains", "Only salary income", "Only house property income", "B"],
  ["A long-term capital loss can generally be set off only against:", "Any income", "Long-term capital gains", "Short-term capital gains only", "Business income only", "B"],
  ["Alternate Minimum Tax (AMT), applicable to certain non-corporate assessees claiming specified deductions, is levied at a rate around:", "15%", "18.5% of adjusted total income", "22%", "30%", "B"],
  ["MAT/AMT credit, once generated, is generally allowed to be carried forward and set off against future tax liability for up to:", "5 years", "8 years", "15 years", "Indefinitely with no limit", "C"],
  ["Faceless assessment/appeal schemes under the Income Tax Act primarily aim to eliminate the physical interface between the taxpayer and the tax officer, mainly to promote:", "Faster tax evasion", "Transparency, efficiency, and reduced discretion/corruption risk", "Higher tax rates", "More paperwork", "B"],
  ["An intimation issued under Section 143(1) after processing a return is generally based on:", "A detailed manual scrutiny of all documents", "Arithmetical checks and prima facie adjustments as prescribed", "A physical inspection of the taxpayer's premises", "A random guess by the officer", "B"],
  ["A case selected for detailed scrutiny assessment involves the issuance of a notice under:", "Section 139(1)", "Section 143(2)", "Section 234A", "Section 80C", "B"],
  ["Disallowance of certain business expenses for failure to deduct or deposit applicable TDS is dealt with under:", "Section 40A(3)", "Section 40(a)(ia)", "Section 43B", "Section 54", "B"],
  ["Cash payments exceeding a prescribed daily limit to a single person for an expense are generally disallowed under:", "Section 40(a)(ia)", "Section 40A(3)", "Section 43CA", "Section 50C", "B"],
  ["Additional depreciation (over and above the normal rate) is generally available for new plant and machinery used in:", "Trading business", "Manufacturing or production activity, subject to conditions", "Real estate rental business only", "Agricultural income activities only", "B"],
  ["Depreciation under the Income Tax Act is computed on a 'block of assets' basis rather than:", "A straight-line basis for the whole block", "An asset-by-asset basis", "A market-value basis", "No basis at all", "B"],
  ["When a block of assets ceases to exist or its written down value becomes negative on sale of assets, the resulting gain is generally treated as a:", "Long-term capital loss always", "Short-term capital gain", "Exempt receipt", "Business loss carried forward indefinitely", "B"],
  ["Tax neutrality on amalgamation/demerger (no immediate capital gains on transfer of assets) under the Income Tax Act is available subject to prescribed:", "No conditions at all", "Conditions relating to the scheme and continuity of shareholding/business, as specified", "GST clearance only", "Trademark assignment only", "B"],
  ["Carry forward of accumulated losses and unabsorbed depreciation in an amalgamation of specified companies is dealt with under:", "Section 72A", "Section 80C", "Section 54", "Section 10", "A"],
  ["Where both TDS under Section 194Q (purchase of goods) and TCS under Section 206C(1H) (sale of goods) could apply to the same transaction, the general priority rule is that:", "TCS always overrides TDS", "TDS under Section 194Q generally takes priority over TCS under Section 206C(1H)", "Both are deducted/collected together on the full amount", "Neither applies", "B"],
  ["Form 3CEB, relevant to transfer pricing compliance, is filed in respect of:", "Only domestic retail transactions", "International transactions and specified domestic transactions with associated enterprises", "Only salary payments", "Only GST refund claims", "B"],
  ["The 'arm's length price' concept in transfer pricing requires related-party (associated enterprise) transactions to be priced as if they were between:", "Related, non-independent parties, without adjustment", "Unrelated, independent parties under comparable circumstances", "Government departments", "Only domestic parties", "B"],
  ["An Advance Pricing Agreement (APA) allows a taxpayer to agree in advance with tax authorities on the:", "Amount of GST payable", "Transfer pricing methodology for future international transactions", "Company's dividend policy", "Trademark valuation", "B"],
  ["Safe harbour rules in transfer pricing provide taxpayers with pre-determined, acceptable:", "Tax rates for all businesses", "Profit margins/pricing thresholds for specified transactions, reducing dispute risk", "GST exemption limits", "Trademark classes", "B"],
  ["An equalisation levy, as historically introduced, applied to certain payments to non-residents for specified digital services such as:", "Physical goods import", "Online advertisement services", "Domestic salary payments", "Domestic rent payments", "B"],
  ["TDS on the transfer of Virtual Digital Assets (such as cryptocurrency) is dealt with under a dedicated section:", "Section 194Q", "Section 194S", "Section 194-IA", "Section 194M", "B"],
  ["Income from the transfer of Virtual Digital Assets is generally taxed at a special flat rate under Section 115BBH, with losses from such assets generally:", "Freely set off against any other income", "Not allowed to be set off against any other income/head", "Exempt entirely", "Taxed at nil rate", "B"],
  ["The Black Money (Undisclosed Foreign Income and Assets) Act deals specifically with:", "Domestic cash transactions", "Undisclosed foreign income and assets of residents", "GST evasion", "Trademark infringement", "B"],
  ["The Benami Transactions (Prohibition) Act primarily targets:", "Legitimate joint family property arrangements only", "Property held in the name of one person while the real beneficial ownership rests with another, without a valid exception", "GST invoices", "Import-export licences", "B"],
  ["A partnership firm converting into an LLP (or vice versa, subject to conditions) may be treated as tax-neutral (not a taxable 'transfer') under prescribed conditions relating to shareholding continuity and:", "Turnover/asset value thresholds and other specified conditions", "GST registration status", "Trademark ownership", "Number of employees only", "A"],
  ["Buy-back of shares by an unlisted domestic company generally results in the company itself bearing an additional tax, historically under:", "Section 115JB", "Section 115QA", "Section 44AB", "Section 80C", "B"],
  ["Interest paid by an Indian company/entity to its foreign associated enterprise for a loan may be subject to a cap linked to EBITDA under 'thin capitalisation'-type provisions in:", "Section 92E", "Section 94B", "Section 44AB", "Section 54", "B"],
  ["A resident individual claiming credit for taxes paid in a foreign country under a DTAA is generally required to file:", "Form 67", "Form 15CA", "Form 26AS", "Form 3CD", "A"],
  ["Where no DTAA exists between India and the country where foreign tax was paid, relief may still be available under:", "Section 90", "Section 90A", "Section 91", "Section 80C", "C"],
  ["Where a DTAA exists, relief from double taxation is generally provided under:", "Section 90/90A", "Section 91", "Section 44AB", "Section 80C", "A"],
  ["Indirect transfer provisions under Section 9(1)(i) generally seek to tax the transfer of shares of a foreign company that derives substantial value from:", "Foreign real estate only", "Assets located in India", "Foreign bank deposits only", "GST-registered entities abroad", "B"],
  ["Angel tax provisions under Section 56(2)(viib) generally tax the excess share premium received by a closely held company over the fair market value of shares issued to:", "Foreign venture capital funds only, without exception", "Resident investors, subject to specified exemptions (e.g., recognised startups)", "The Government", "Listed companies only", "B"],
  ["A recognised startup, subject to conditions and DPIIT recognition, may be eligible for an exemption from the angel tax provisions under Section 56(2)(viib), primarily to:", "Discourage new investment", "Encourage funding of genuine startups without excessive tax friction", "Increase GST collection", "Increase import duties", "B"],
  ["GAAR (General Anti-Avoidance Rule) provisions under Chapter X-A may be invoked where an arrangement is found to lack commercial substance and its main purpose is to obtain a:", "Business loan", "Tax benefit", "Trademark", "GST registration", "B"],
  ["Cases involving invocation of GAAR are generally examined with the involvement of a designated Approving Panel before the:", "Assessing Officer proceeds to deny the tax benefit", "Return is even filed", "GST registration is granted", "Trademark is registered", "A"],
];

const EXPERT = [
  ["The Place of Effective Management (POEM) test is primarily used to determine the residential status of a:", "Resident individual", "Foreign company, for determining if it is treated as resident in India", "Partnership firm", "HUF", "B"],
  ["The Base Erosion and Profit Shifting (BEPS) project, influencing several Indian tax law changes, was undertaken under the aegis of:", "The World Trade Organization", "The OECD/G20", "The United Nations Security Council", "SEBI", "B"],
  ["The Multilateral Instrument (MLI) is primarily used to modify existing bilateral tax treaties to implement:", "GST harmonisation", "BEPS-related measures without renegotiating each treaty individually", "Trademark protection standards", "Customs duty rates", "B"],
  ["Significant Economic Presence (SEP), which expands the scope of 'business connection' for non-residents, is primarily relevant to non-residents having a:", "Physical office in India only", "Digital/economic presence in India through transactions or user interaction, even without physical presence", "Bank account in India only", "GST registration in India only", "B"],
  ["The concessional corporate tax rate of 22% for domestic companies foregoing specified exemptions/incentives (and generally not subject to MAT) is provided under:", "Section 115BAA", "Section 115BAB", "Section 115JB", "Section 44AB", "A"],
  ["The concessional 15% corporate tax rate for new manufacturing domestic companies (incorporated after a specified cut-off date, subject to conditions) is provided under:", "Section 115BAA", "Section 115BAB", "Section 115JB", "Section 92E", "B"],
  ["The concessional personal tax regime under Section 115BAC generally requires individuals to forgo most:", "Tax rebates only", "Exemptions and deductions otherwise available under the old regime", "PAN requirements", "Filing obligations entirely", "B"],
  ["Faceless assessment under the Income Tax Act derives its legal framework primarily from:", "Section 132", "Section 144B", "Section 54", "Section 10AA", "B"],
  ["A Dispute Resolution Committee (DRC), introduced to help small and specified taxpayers, is primarily intended to:", "Increase litigation", "Resolve certain disputes without lengthy litigation, subject to eligibility conditions", "Replace the Supreme Court", "Eliminate the need for filing returns", "B"],
  ["A one-time scheme historically introduced to allow taxpayers to settle pending direct tax disputes by paying a specified amount was known as:", "GST Amnesty Scheme", "Vivad Se Vishwas Scheme", "Startup India Scheme", "PMAY Scheme", "B"],
  ["Complex tax disputes, historically handled by the Settlement Commission, are now largely routed through a restructured mechanism known as the:", "Interim Board for Settlement", "GST Council", "SEBI Tribunal", "Company Law Board", "A"],
  ["Advance rulings on prospective transactions of non-residents/specified persons under the Income Tax Act are now provided through a restructured mechanism known as the:", "Authority for Advance Rulings only, unchanged", "Board for Advance Rulings (BAR)", "Settlement Commission", "GST Council", "B"],
  ["Prosecution for wilful attempt to evade tax under the Income Tax Act is dealt with under:", "Section 132", "Section 276C", "Section 54", "Section 10AA", "B"],
  ["Search and seizure operations under the Income Tax Act are conducted under the powers granted by:", "Section 132", "Section 133A", "Section 234A", "Section 80C", "A"],
  ["A survey under the Income Tax Act, as distinguished from a search, is generally limited to business premises during business hours and does NOT ordinarily involve:", "Verification of stock/cash", "Seizure of assets", "Impounding of books of account, in specified circumstances", "Examination on oath", "B"],
  ["Amounts deemed as unexplained (cash credits, investments, money, or expenditure) under Sections 68 to 69D are generally taxed at a special, higher flat rate under:", "Section 115BAC", "Section 115BBE", "Section 115JB", "Section 44AB", "B"],
  ["The special rate under Section 115BBE for unexplained income generally does NOT permit the assessee to claim any:", "GST refund", "Deduction, allowance, or set-off of any loss against such income", "PAN card", "Bank account", "B"],
  ["TDS/TCS at a higher rate for 'specified persons' who have not filed their income tax returns for a specified period is dealt with under provisions such as Section 206AB/206CCA, primarily to:", "Reward return filers with lower rates comparatively", "Encourage timely return filing by imposing a higher deduction/collection burden on non-filers", "Eliminate the need for TDS altogether", "Benefit only non-residents", "B"],
  ["Dividend Distribution Tax (DDT), earlier paid by companies on dividends distributed, was abolished with dividends now taxed:", "Never, being fully exempt permanently", "In the hands of the shareholder, at their applicable rate", "Only in the hands of foreign shareholders", "At a flat 1% rate on the company", "B"],
  ["Section 94B restricts the deduction of interest paid to an associated enterprise abroad by capping it with reference to a company's:", "Total turnover", "EBITDA (a specified percentage thereof)", "Net worth only", "Share capital only", "B"],
  ["Rectification of a mistake apparent from the record in an income tax order can generally be sought under:", "Section 154", "Section 263", "Section 264", "Section 132", "A"],
  ["Revision of an order that is considered erroneous and prejudicial to the interest of revenue can generally be undertaken by the Principal Commissioner/Commissioner under:", "Section 154", "Section 263", "Section 148", "Section 132", "B"],
  ["Revision of an order at the instance of the assessee (where it is not prejudicial to revenue) can generally be sought under:", "Section 154", "Section 263", "Section 264", "Section 148A", "C"],
  ["Section 245 permits the tax department to adjust a refund due to a taxpayer against an outstanding:", "Trademark fee", "Tax demand of any other assessment year, subject to prescribed procedure", "GST liability directly", "Bank loan", "B"],
  ["A show-cause notice/procedural safeguard introduced before issuing a reassessment notice under Section 148 is generally provided under:", "Section 147", "Section 148A", "Section 143(1)", "Section 44AB", "B"],
  ["Reassessment time limits under the Income Tax Act were substantially shortened by recent reforms, generally restricting reopening beyond a few years except in cases involving larger escaped income, which allow a longer look-back period, broadly reflecting a policy shift towards:", "Unlimited reopening in all cases", "More time-bound, evidence-based reassessment with a longer window reserved for significant escapement", "No reassessment being permitted at all", "Reassessment being merged entirely with GST audit", "B"],
  ["A Controlled Foreign Company (CFC)-type concept, widely discussed in international tax policy (including BEPS Action Plans), generally seeks to tax passive income of foreign subsidiaries in the hands of the:", "Foreign government", "Resident parent/shareholder, even before actual distribution, under specific regimes where adopted", "Foreign subsidiary alone, with no home-country implication", "Local tax authority of the subsidiary only", "B"],
  ["Thin capitalisation and related BEPS-inspired measures, together with transfer pricing rules, primarily aim to prevent:", "Legitimate cross-border trade", "Erosion of the domestic tax base through excessive related-party interest/pricing arrangements", "Foreign direct investment entirely", "GST collection", "B"],
  ["A conversion of a private company into an LLP may qualify for capital gains tax neutrality subject to specified conditions relating to turnover/asset value and continuity of:", "Shareholding/partners' capital and profit-sharing for a specified period", "GST registration", "Trademark ownership", "Auditor appointment", "A"],
  ["The equalisation levy (2.0), distinct from the earlier levy on online advertisements, was introduced to tax e-commerce operators on:", "Domestic B2B services only", "Consideration received for e-commerce supply/services to specified persons, subject to conditions", "GST refunds", "Import of physical goods", "B"],
  ["Book profit under Section 115JB (MAT) is computed by making specified additions/deductions to the company's net profit as per its accounts prepared under the:", "Income Tax Act's own separate books", "Companies Act (Schedule III) framework", "GST Act", "SEBI Regulations only", "B"],
  ["An Authority/Board handling advance rulings and a Dispute Resolution Committee together reflect a broader policy direction towards:", "Increasing litigation", "Reducing tax uncertainty and providing alternate, faster dispute resolution avenues", "Abolishing all appellate forums", "Removing PAN requirements", "B"],
  ["The faceless penalty scheme mirrors the structure of faceless assessment, primarily to ensure penalty proceedings are conducted:", "With direct in-person meetings only", "Without physical interface, through team-based, technology-driven processing", "Only by the Finance Minister personally", "Only after a search operation", "B"],
  ["A search assessment under Section 153A generally applies to income of the searched person for a specified block of preceding assessment years, aiming to consolidate assessment of:", "Only the year of search", "Undisclosed income across multiple preceding years found through the search", "Only GST liability", "Only TDS defaults", "B"],
  ["Assessment/reassessment of a person other than the one searched, but whose undisclosed income is found from seized material, is generally dealt with under:", "Section 153A", "Section 153C", "Section 148A", "Section 44AB", "B"],
  ["An 'international transaction' for transfer pricing purposes generally requires the involvement of at least two:", "Unrelated resident entities", "Associated enterprises, at least one of which is a non-resident", "Government departments", "Trademark registries", "B"],
  ["The concept of 'associated enterprise' under transfer pricing law is generally determined based on criteria such as shareholding, control, or:", "Physical proximity of offices", "Management/capital linkages as specified under the law", "Same auditor being appointed", "Same bank being used", "B"],
  ["A 'specified domestic transaction', though between resident related parties, may still attract transfer pricing scrutiny if it exceeds a prescribed aggregate value and falls within:", "Any transaction whatsoever without threshold", "Categories specifically notified under the transfer pricing provisions (e.g., certain related-party payments)", "Only export transactions", "Only import transactions", "B"],
  ["A Mutual Agreement Procedure (MAP) under a DTAA allows competent authorities of two countries to resolve disputes relating to:", "GST refunds", "Double taxation or treaty interpretation issues faced by a taxpayer", "Trademark conflicts", "Company incorporation disputes", "B"],
  ["A taxpayer's residency certificate (TRC) is generally required to be obtained to claim benefits under a:", "GST notification", "Double Taxation Avoidance Agreement (DTAA)", "Trademark registration", "Company incorporation certificate", "B"],
  ["Treaty shopping, a concern addressed partly through instruments like the MLI, refers to structuring investments through a third country primarily to:", "Improve genuine business operations only", "Inappropriately access more favourable tax treaty benefits", "Increase GST compliance", "Avoid company incorporation requirements", "B"],
  ["The Principal Purpose Test (PPT), introduced through instruments like the MLI, denies treaty benefits where obtaining the benefit was one of the principal purposes of an arrangement, unless it is established that granting the benefit is in accordance with the:", "Company's marketing policy", "Object and purpose of the relevant treaty provisions", "GST Council's recommendation", "Bank's internal policy", "B"],
  ["A Permanent Establishment (PE) of a foreign enterprise in India, if constituted, generally results in the business profits attributable to that PE being taxable in:", "Only the foreign enterprise's home country", "India, to the extent attributable to the PE", "Neither country", "Both countries at double the rate with no relief", "B"],
  ["A 'dependent agent PE' may be constituted where an agent in India habitually concludes contracts or plays the principal role in concluding contracts on behalf of a foreign enterprise, even without a:", "Formal written agency agreement in every case", "Fixed physical place of business of the foreign enterprise in India", "PAN card", "GST registration", "B"],
  ["Attribution of profits to a Permanent Establishment in India is generally based on the functions performed, assets used, and risks assumed, broadly following principles consistent with the:", "GST valuation rules", "Arm's length principle used in transfer pricing", "Companies Act depreciation schedule", "Trademark valuation norms", "B"],
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
  console.log('Income Tax BATCH 2 (new questions):', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`Income Tax area not found for org ${ORG_ID}.`);
    const areaId = area.rows[0].id;

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
    console.log(`Inserted ${inserted} NEW Income Tax questions (existing 150 untouched).`);
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
