// Document content generators — format matches BR_AUDIT_NTS_FINAL_FORMAT_2024-25_NEW.xlsm

function fmt(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
}

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(dt.getDate()).padStart(2,"0")}-${months[dt.getMonth()]}-${dt.getFullYear()}`;
}

function fmtShort(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fyStr(c) {
  const from = c.financialYearFrom ? new Date(c.financialYearFrom).getFullYear() : 2024;
  const to = c.financialYearTo ? new Date(c.financialYearTo).getFullYear() : 2025;
  return `${from}-${String(to).slice(-2)}`;
}

function fyEndYear(c) {
  return c.financialYearTo ? new Date(c.financialYearTo).getFullYear() : 2025;
}

function sigBlock(c) {
  const signatories = (c.directors || []).filter((d) => d.isSignatory);
  const lines = [
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  ];
  signatories.forEach((d) => {
    lines.push(d.name || "");
    lines.push(d.designation || "");
  });
  return lines;
}

function auditorSigBlock(c) {
  const a = (c.auditors || []).find((x) => x.isCurrent) || {};
  return [
    `For ${a.firmName || ""}`,
    `${a.firmDesig || "Chartered Accountants"}`,
    `Firm No.: ${a.firmNo || ""}`,
    `${a.caName || ""}`,
    `(${a.caDesig || "Partner"})`,
    `M. No.: ${a.memberNo || ""}`,
    `Date: ${fmtDate(c.boardMeetingDate)}`,
    `Place: ${c.boardMeetingPlace || ""}`,
    `UDIN: ${c.udin || ""}`,
  ];
}

// ============================================================
// 1. INDEPENDENT AUDITOR'S REPORT (1AR sheet)
// ============================================================
function buildAuditorsReport(c) {
  const year = fyEndYear(c);
  return [
    `Independent Auditor's Report`,
    `To the Members of`,
    `${c.companyName || ""}`,
    ``,
    `Report on the Financial Statements`,
    `We have audited the accompanying standalone financial statements of ${c.companyName || ""} ("the Company") which comprise the Balance Sheet as at March 31, ${year}. the Statement of Profit and Loss the year then ended, and notes to the financial statements, including a summary of significant accounting policies and other explanatory information.`,
    `In our opinion and to the best of our information and according to the explanations given to us, the aforesaid financial statements give the information required by the Act in the manner so required and give a true and fair view in conformity with the accounting principles generally accepted in India, of the state of affairs of the Company at March 31, ${year}. and profit, for the year ended on that date.`,
    ``,
    `Basis for Opinion`,
    `We conducted our audit in accordance with the Standards on Auditing (SAs) specified under section 143(10) of the Companies Act, 2013. Our responsibilities under those Standards are further described in the Auditor's Responsibilities for the Audit of the Financial Statements section of our report. We are independent of the Company in accordance with the Code of Ethics issued by the Institute of Chartered Accountants of India together with the ethical requirements that are relevant to our audit of the financial statements under the provisions of the Companies Act, 2013 and the Rules thereunder, and we have fulfilled our other ethical responsibilities in accordance with these requirements and the Code of Ethics. We believe that the audit evidence we have obtained is sufficient and appropriate to provide a basis for our opinion.`,
    ``,
    `Emphasis of Matter`,
    `There are no matters to be emphasized in the financial statements. Accordingly, no Emphasis of Matter paragraph has been reported.`,
    ``,
    `Key Audit Matters`,
    `Key audit matters are those matters that, in our professional judgement, were most significance in our audit of the financial statements of the current period. These matters were addressed in the context of our audit of the financial statement as a whole, and in forming our opinion thereon, and we do not provide a separate opinion on these matters. Reporting of Key audit matters as per SA 701, Key Audit matters are not applicable to the Company since the Company falls under the category of unlisted companies, and as such, the requirement for reporting Key Audit Matters does not apply to it.`,
    ``,
    `Information other than the Financial Statements and Auditor's Report thereon`,
    `The Company's board of directors is responsible for the preparation of the other information. The other information comprises the information included in the Board's Report including Annexures to Board's Report but does not include the financial statements and our auditor's report thereon.`,
    `Our opinion on the financial statements does not cover the other information and we do not express any form of assurance conclusion thereon.`,
    `In connection with our audit of the financial statements, our responsibility is to read the other information and, in doing so, consider whether the other information is materially inconsistent with the financial statements or our knowledge obtained during the course of our audit or otherwise appears to be materially misstated. If, based on the work we have performed, we conclude that there is a material misstatement of this other information, we are required to report that fact. We have nothing to report in this regard.`,
    ``,
    `Auditor's remarks`,
    `There is no any qualifications, reservation or adverse remark or disclaimer`,
    ``,
    `Responsibilities of Management and Those Charged with Governance for the Standalone Financial Statements`,
    `The Company's Board of Directors is responsible for the matters stated in section 134(5) of the Companies Act, 2013 ("the Act") with respect to the preparation of these financial statements that give a true and fair view of the financial position, financial performance and cash flows of the Company in accordance with the accounting principles generally accepted in India, including the accounting Standards specified under section 133 of the Act. This responsibility also includes maintenance of adequate accounting records in accordance with the provisions of the Act for safeguarding of the assets of the Company and for preventing and detecting frauds and other irregularities; selection and application of appropriate accounting policies; making judgments and estimates that are reasonable and prudent; and design, implementation and maintenance of adequate internal financial controls, that were operating effectively for ensuring the accuracy and completeness of the accounting records, relevant to the preparation and presentation of the financial statements that give a true and fair view and are free from material misstatement, whether due to fraud or error.`,
    `In preparing the financial statements, the Board of Directors is responsible for assessing the Company's ability to continue as a going concern, disclosing, as applicable, matters related to going concern and using the going concern basis of accounting unless the Board of Directors either intends to liquidate the Company or to cease operations, or has no realistic alternative but to do so. The Board of Directors are also responsible for overseeing the company's financial reporting process.`,
    ``,
    `Auditor's Responsibility for the Audit of the Financial Statements.`,
    `Our objectives are to obtain reasonable assurance about whether the financial statements as a whole are free from material misstatement, whether due to fraud or error, and to issue an auditor's report that includes our opinion. Reasonable assurance is a high level of assurance, but is not a guarantee that an audit conducted in accordance with SAs will always detect a material misstatement when it exists. Misstatements can arise from fraud or error and are considered material if, individually or in the aggregate, they could reasonably be expected to influence the economic decisions of users taken on the basis of these financial statements.`,
    `As part of an audit in accordance with SAs, we exercise professional judgment and maintain professional skepticism throughout the audit. We also:`,
    `• Identify and assess the risks of material misstatement of the standalone Financial Statements, whether due to fraud or error, design and perform audit procedures responsive to those risks, and obtain audit evidence that is sufficient and appropriate to provide a basis for our opinion. The risk of not detecting a material misstatement resulting from fraud is higher than for one resulting from error, as fraud may involve collusion, forgery, intentional omissions, misrepresentations, or the override of internal control.`,
    `• Obtain an understanding of internal financial control relevant to the audit in order to design audit procedures that are appropriate in the circumstances. Under section 143(3)(i) of the Act, we are also responsible for expressing our opinion on whether the Company has adequate internal financial controls system in place and the operating effectiveness of such controls.`,
    `• Evaluate the appropriateness of accounting policies used and the reasonableness of accounting estimates and related disclosures made by the management and Board of Directors.`,
    `• Conclude on the appropriateness of Management and Board of Director's use of the going concern basis of accounting in preparation of the Standalone Financial Statements and, based on the audit evidence obtained, whether a material uncertainty exists related to events or conditions that may cast significant doubt on the Company's ability to continue as a going concern. If we conclude that a material uncertainty exists, we are required to draw attention in our auditor's report to the related disclosures in the standalone Financial Statements or, if such disclosures are inadequate, to modify our opinion. Our conclusions are based on the audit evidence obtained up to the date of our auditor's report. However, future events or conditions may cause the Company to cease to continue as a going concern.`,
    `• Evaluate the overall presentation, structure and content of the financial statements, including the disclosures, and whether the financial statements represent the underlying transactions and events in a manner that achieves fair presentation.`,
    `Materiality is the magnitude of misstatements in the standalone financial statements that, individually or in aggregate, makes it probable that the economic decisions of a reasonably knowledgeable user of the standalone financial statements may be influenced. We consider quantitative materiality and qualitative factors in (i) planning the scope of our audit work and in evaluating the results of our work; and (ii) to evaluate the effect of any identified misstatements in the standalone financial statements.`,
    `We communicate with those charged with governance regarding, among other matters, the planned scope and timing of the audit and significant audit findings, including any significant deficiencies in internal control that we identify during our audit.`,
    `We also provide those charged with governance with a statement that we have complied with relevant ethical requirements regarding independence, and to communicate with them all relationships and other matters that may reasonably be thought to bear on our independence, and where applicable, related safeguards.`,
    `From the matters communicated with those charged with governance, we determine those matters that were of most significance in the audit of the financial statements of the current period and are therefore the key audit matters. We describe these matters in our auditor's report unless law or regulation precludes public disclosure about the matter or when, in extremely rare circumstances, we determine that a matter should not be communicated in our report because the adverse consequences of doing so would reasonably be expected to outweigh the public interest benefits of such communication.`,
    ``,
    `Report on Other Legal and Regulatory Requirements`,
    `State other matters as per Rule 11 of Companies (Audit and Auditors) Rules, 2014.`,
    `With respect to the other matters to be included in the Auditor's Report in accordance with Rule 11 of the Companies (Audit and Auditors) Rules, 2014, in our opinion and to the best of our information and according to the explanations given to us:`,
    `i. The Company does not have any pending litigations which would impact its financial position.`,
    `ii. The Company did not have any long-term contracts including derivative contracts for which there were any material foreseeable losses.`,
    `iii. There were no amounts which were required to be transferred to the Investor Education and Protection Fund by the Company.`,
    `1. As required by the Companies (Auditor's Report) Order, 2020 ("the Order"), issued by the Central Government of India in terms of sub-section (11) of section 143 of the Companies Act, 2013, is not applicable to the Company since the Company has not exceeded the specified threshold limit and it does not fall into any criteria to be caused application of the Order.`,
    `2. As required by Section 143 (3) of the Act, we report that:`,
    `a) We have sought and obtained all the information and explanations which to the best of our knowledge and belief were necessary for the purposes of our audit.`,
    `b) In our opinion, proper books of account as required by law have been kept by the Company so far as it appears from our examination of those books.`,
    `c) The Balance Sheet, the Statement of Profit and Loss and the Cash Flow Statement dealt with by this Report are in agreement with the books of account.`,
    `d) In our opinion, the aforesaid Standalone Financial Statements comply with the Accounting Standards specified under Section 133 of the Act, read with Rule 7 of the Companies (Accounts) Rules, 2021. and rules made thereunder.`,
    `e) On the basis of the written representations received from the directors at March 31, ${year} taken on record by the Board of Directors, none of the directors is disqualified at March 31, ${year} from being appointed as a director in terms of Section 164 (2) of the Act.`,
    `f) With respect to the adequacy of the internal financial controls over financial reporting of the Company Since the Company's turnover as per last audited financial statements is less than Rs.50 Crores and its borrowings from banks and financial institutions at any time during the year is less than Rs.25 Crores, the Company is exempted from getting an audit opinion with respect to the adequacy of the internal financial controls over financial reporting of the company and the operating effectiveness of such controls vide notification dated June 13, 2017;`,
    `g) With respect to the matter to be included in the Auditor's Report under section 197(16), In our opinion and according to the information and explanations given to us, the remuneration paid by the Company to its directors during the current year is in accordance with the provisions of section 197 of the Act. The remuneration paid to any director is not in excess of the limit laid down under section 197 of the Act. The Ministry of Corporate Affairs has not prescribed other details under section 197(16) which are required to be commented upon by us. (applicable in case of Public Company)`,
    `iv. (a) The management has represented that, to the best of it's knowledge and belief, other than as disclosed in the notes to the accounts, no funds have been advanced or loaned or invested (either from borrowed funds or share premium or any other sources or kind of funds) by the company to or in any other person(s) or entity(ies), including foreign entities ("Intermediaries"), with the understanding, whether recorded in writing or otherwise, that the Intermediary shall, whether, directly or indirectly lend or invest in other persons or entities identified in any manner whatsoever by or on behalf of the company ("Ultimate Beneficiaries") or provide any guarantee, security or the like on behalf of the Ultimate Beneficiaries;`,
    `(b) The management has represented, that, to the best of it's knowledge and belief, other than as disclosed in the notes to the accounts, no funds have been received by the company from any person(s) or entity(ies), including foreign entities ("Funding Parties"), with the understanding, whether recorded in writing or otherwise, that the company shall, whether, directly or indirectly, lend or invest in other persons or entities identified in any manner whatsoever by or on behalf of the Funding Party ("Ultimate Beneficiaries") or provide any guarantee, security or the like on behalf of the Ultimate Beneficiaries; and`,
    `(c) Based on such audit procedures that have been considered reasonable and appropriate in the circumstances, nothing has come to our notice that has caused us to believe that the representations under sub-clause (i) and (ii) of Rule 11(e), as provided under (a) and (b) above, contain any material mis-statement.`,
    `v. No dividend have been declared or paid during the year by the company.`,
    `vi. Pursuant to Rule 11(g) of the Companies (Audit and Auditors) Rules, 2014, we report that, based on our examination, which included test checks and information provided, the Company utilized accounting software for maintaining its books of account. However, the software lacked an audit trail (edit log) feature to record all relevant transactions throughout the year, as required by the Proviso to Rule 3(1) of the Companies (Accounts) Rules, 2014. Consequently, we are unable to give any opinion on this.`,
    ``,
    ...auditorSigBlock(c),
  ];
}

// ============================================================
// 2. NOTES TO FINANCIAL STATEMENTS (3NTS sheet)
// ============================================================
function buildNotesToAccounts(c) {
  const year = fyEndYear(c);
  const fy = fyStr(c);
  const prevFy = `${year - 1}-${String(year).slice(-2)}`;
  const doi = c.doi ? fmtDate(c.doi) : "";

  const lines = [
    `Registered Address: ${c.registeredAddr || ""}`,
    `CIN: ${c.cin || ""}`,
    `Email : ${c.email || ""}`,
    ``,
    `Notes to financial statements for the year ended March 31, ${year}`,
    ``,
    `A. Corporate information:`,
    ` ${c.companyName || ""} ("the Company"), incorporated in India on ${doi} having a registration no: ${c.regNumber || ""} under Companies Act 2013.`,
    ``,
    `B. Significant accounting policies:`,
    `       a. Basis of Accounting:`,
    `The financial statements of the Company have been prepared in accordance with the Generally Accepted Accounting Principles in India (Indian GAAP) to comply with the Accounting Standards specified under section133 of the Companies Act, 2013 and the relevant provisions of the Companies Act,2013 ("the New Act"). The financial statements have been prepared on accrual basis under the historical cost convention.`,
    `All the assets and liabilities have been classified as current or noncurrent as per the company's normal operating cycle and other criteria set out in schedule III to the Companies Act, 2013.Based on the nature of services rendered by the Company and their realization in cash and cash equivalent, the Company has ascertained its operating cycle to be 12 month for the purpose of current- noncurrent classification of assets and liabilities.`,
    ``,
    `System of Accounting`,
    `The financial statements are prepared on the accrual basis of accounting under the historical cost convention and recognizes income and expenditure on an accrual basis except in case of significant uncertainties.`,
    ``,
    `b. Use of Estimates:`,
    `The preparation of financial statements in conformity with generally accepted accounting principles requires management to make estimates and assumptions that affect the reported amounts of assets and liabilities and disclosure of contingent liabilities at the date of the financial statements and the results of operations during the reporting period end. Although these estimates are based upon management's best knowledge of current events and actions, actual results could differ from these estimates.`,
    ``,
    `c. Property, Plant & Equipment (Including Intangibles):`,
    `Property, Plant & Equipment and Intangible Assets are carried at cost less accumulated depreciation/amortisation and impairment losses, if any. The cost of Property, Plant & Equipment and Intangible Assets comprises their purchase price net of any trade discounts and rebates, other taxes (others than those subsequently recoverable from the tax authorities), any directly attributable expenditure on making the asset ready for its intended use, other incidental expenses and interest on borrowings attributable to acquisition of qualifying Property, Plant & Equipment up to the date asset is ready for its intended use. Subsequent expenditure on Property, Plant & Equipment after its purchase is capitalized only if such expenditure results in an increase in future benefits from such asset beyond its previous assessed standard of performance.`,
    ``,
    `d. Depreciation and amortization`,
    `Depreciation on Property, Plant & Equipment and intangible assets has been provided on Written Down Value Method as per the useful life of the assets, taking into account the nature of the asset, the estimated useful life of assets as estimated by the management, the operating condition of the asset, past history of replacements, anticipated technological changes, manufactured warranties and maintenance support etc. as under;`,
    ``,
    `Depreciation | Useful Life`,
    `Plant & Machinery | 10 years`,
    `Computer and Peripherals | 3 years`,
    `Furniture & Fixtures | 15 years`,
    `Office equipment's | 10 years`,
    `Intangible Assets | 3 years`,
    ``,
    `e. Inventories:`,
    `Inventories are valued at lower of cost or net realizable value. Cost is computed on the basis of cost of purchase inclusive of freight etc., "First-In-First – Out" basis.`,
    ``,
    `f. Revenue Recognition:`,
    `Revenue is recognised to the extent that it is probable that the economic benefits will flow to the Company and the revenue can be reliably measured. Revenue recognized on accrual basis.`,
    ``,
    `g. Employee benefits:`,
    `Employee benefits includes Provident Fund, Gratuity, Leave Encashment and Bonus.`,
    `        a. Defined Contribution Plans:`,
    `The Company's contributions to provident fund is considered as defined contribution plan and are charged to the Statement of Profit and Loss based on the amount of contributions required to be made as and when services are rendered by the employees.`,
    `      b. Defined Benefit Plans:`,
    `Gratuity and Leave Encashment are considered as defined benefit plan. Gratuity and Leave Encashment are provided on actuarial valuation carried out at the balance sheet date. The incremental liability based on an actuarial valuation as per the 'Projected Unit Credit' (PUC) method as at their porting date, is charged to the Statement of Profit and Loss Account. Actuarial gains and losses are recognized in the Statement of Profit and Loss.`,
    `     c. Short-term employee benefits:`,
    `The undiscounted amount of short-term employee benefits expected to be paid in exchange for the services rendered by employees are recognised during the year when the employees render the services. These benefits include salaries, wages, bonus, performance incentives and compensated absences which are expected to occur within twelve months after the end of the period in which the employee renders the related services.`,
    `       d. Long-term employee benefits`,
    `Compensated absences which are not expected to occur within twelve months after the end of the period in which the employee renders the related services are recognised as a liability at the present value of the defined benefit obligation as at the balance sheet date on the basis of actuarial valuation.`,
    ``,
    `h. Taxation:`,
    `Income tax expense comprises current tax (i.e., amount of tax for the period determined in accordance with the Income-tax Act, 1961), and deferred tax charge. The current charge for income tax is based on estimated tax liability as computed after taking credit for allowances and exemptions in accordance with the Income-tax Act, 1961 applicable for the year ended. In accordance with the Accounting Standard-22, Accounting for Taxes on Income, the Company provided for deferred tax liability for all temporary differences that arise in one accounting year and are capable of reversal in subsequent accounting year.`,
    ``,
    `i. Provisions and Contingencies`,
    `Provision is recognized when there is a present obligation as a result of a past event that probably requires an out flow of resources and are liable estimate can be made of the amount of the obligation. Disclosure for contingent liability is made when there is a possible obligation or a present obligation that may, but probably will not, require an outflow of resources. No provision is recognized or disclosure for contingent liability is made when there is a possible obligation or a present obligation and the likelihood of outflow of resources is remote. Contingent Asset is neither recognized nor disclosed in the financial statements.`,
    ``,
    `j. Earnings per share`,
    `Basic earnings per share are calculated by dividing the net profit or loss for the year attributable to equity shareholders (after deducting preference dividend and attributable taxes) by the weighted average number of equities shares outstanding during the year.`,
    `For the purpose of calculating diluted earnings per share, the net profit or loss for the year attributable to equity shareholders and the weighted average number of shares outstanding during the year are adjusted for the effects of all dilutive potential equity shares.`,
    ``,
    `k. Impairment of Asset`,
    `At each balance sheet date, the company reviews the carrying value of its fixed assets to determine whether there is any indication that those assets suffered an impairment loss. If any such indication exists, the recoverable amount of the assets is estimated in order to determine the extent of impairment loss. Recoverable amount is higher of an assets net selling price and value in use. In assessing value in use the estimated future cash flows expected from the continuing use of the asset and from its disposal are discounted to their present value using are discount rate that reflects the current market assessment of time value of money and the risk specified to the asset. Reversal of impairment loss is recognised as income in the statement of profit and loss.`,
    ``,
    `l. Leases`,
    `Lease arrangements where the risks and rewards incident to ownership of an asset substantially vest with the lessor are recognised as operating leases. Lease rent under operating leases are recognised in the statement of profit and loss account on straight line basis.`,
    ``,
    `m. Operating cycle`,
    `Based on the nature of products/activities of the company and the normal time between acquisition of assets and the realisation in cash or cash equivalents, the company has determined its operating cycle as 12 months for the purpose of classification of its assets and liabilities as current and non-current.`,
    ``,
    `n. General`,
    `Except wherever stated accounting policies are consistent with the generally accepted accounting principles and have been consistently applied.`,
    ``,
    `o. Cash and cash equivalents:`,
    `Cash and cash equivalents comprise cash at bank and in hand and short-term fixed deposits/ investments.`,
    ``,
    `p. Directors Remuneration for the year ended: NIL`,
    ``,
    `q. Capital and other commitments`,
    `Estimated number of contracts remaining to be executed on capital account not provided for:`,
    `Rs. Nil (Previous year: Nil`,
    ``,
    `r. Details of payment to auditors`,
    `As Auditor`,
    ` (a) Statutory Audit Fees for F.Y. ${fy} Rs.  and for the F.Y.${prevFy} Rs. `,
    ` (b) Tax Audit Fees for F.Y.${fy} Rs.  and for the F.Y.${prevFy} Rs. `,
    ``,
    `s. Depreciation`,
    `Particulars of depreciation by the Company during the year under review made are provided in the Financial Statement.`,
    ``,
    `t. Functional and presentation currency`,
    `Amounts in the financial statements are presented in Indian Rupees (Thousand) which is also the Company's functional, currency and all amounts have been rounded off to 0.00 as per Companies Act, 2013 unless otherwise indicated except in case of Basic EPS or Diluted EPS`,
    ``,
    `u. Other`,
    `The classification of creditors as micro and small enterprises has been made based on the information available and confirmations received from certain suppliers. However, due to inadequate identification of creditors falling under the category of micro and small enterprises, the total amount outstanding to such parties, and the interest payable, if any, on delayed payments could not be ascertained or determined.`,
    `Based on our review, we confirm that the entity has complied with the provisions of the MSMED Act, 2006. The company has timely identified MSME vendors and facilitated payments in accordance with Section 15 of the Act. We noted that no interest is payable to MSME vendors under Section 16 of the MSMED Act. Additionally, there are no outstanding payments to MSME vendors beyond the time limit specified in Section 15, ensuring compliance with Section 43B(h) of the Income Tax Act, 1960, thereby avoiding any potential disallowance of expenses under the Income Tax Act.`,
    ``,
    ...sigBlock(c),
    ``,
    ...auditorSigBlock(c),
  ];

  return lines;
}

// ============================================================
// 3. DIRECTORS' REPORT — FULL VERSION (4BOARD sheet)
// ============================================================
function buildDirectorsReport(c) {
  const year = fyEndYear(c);
  const fy = fyStr(c);
  const prevYear = year - 1;
  const auditor = (c.auditors || []).find((a) => a.isCurrent) || {};
  const boardMeetings = c.boardMeetings || [];
  const directors = c.directors || [];
  const signatories = directors.filter((d) => d.isSignatory);

  const auditorText = auditor.firmName
    ? `M/s. ${auditor.firmName}, ${auditor.firmDesig || "Chartered Accountants"} (Firm Registration No. ${auditor.firmNo || ""}) are the Statutory Auditors of the Company.`
    : `Statutory Auditors details not available.`;

  const lines = [
    `Registered Address: ${c.registeredAddr || ""}`,
    `CIN: ${c.cin || ""}`,
    `Email : ${c.email || ""}`,
    ``,
    `DIRECTORS' REPORT FOR THE FINANCIAL YEAR ${fy}                                                                                        To The Members of ${c.companyName || ""}`,
    `Dear Members`,
    `The Board of Directors of your company have pleasure in presenting their Annual Report and the Audited Financial Statements for the financial year ended on 31st March, ${year}.`,
    ``,
    `1. The Financial Summary or highlights:`,
    `1.1 The operating financial results for the year are summarized below:`,
    ``,
    `Particulars | Year ended 31st March ${year} (amount in Rupees) | Year ended 31st March ${prevYear} (amount in Rupees)`,
    `Revenue from Operations | 0 | 0`,
    `Other Income | 0 | 0`,
    `Total Income | 0 | 0`,
    `Profit    before    Depreciation    & Tax | 0 | 0`,
    `Less : Depreciation | 0 | 0`,
    `Profit (loss) before Tax | 0 | 0`,
    `Less : Taxation | 0 | 0`,
    `Less Deferred Tax | 0 | 0`,
    `Profit (loss) after Tax | 0 | 0`,
    `Total Reserves & Surplus | 0 | 0`,
    `Transfer  to  Reserve  during  the year |  | `,
    `Earnings per share (In Rupees) | 0 | 0`,
    ``,
    `2. Dividend:`,
    `No dividend was declared for the current financial year due to conservation of profits and continued investment in the business.`,
    ``,
    `3. Details of material changes from the end of the financial year`,
    `There have been no material changes and commitments affecting the financial position of the Company between the end of the financial year to which the financial statement relates and date of this Report.`,
    `During the year under review, there has been no change in the capital structure of the Company.`,
    ``,
    `4. Management's Discussion and Analysis Report`,
    `This clause is not applicable to the company as company being an unlisted company.`,
    ``,
    `5. Results of Operations and the State of Company's Affairs`,
    `During the financial year ${fy} the Company achieved a turnover of ₹0 as compared to ₹0  in the previous financial year, reflecting a growth over the last year. The Net Profit/Loss before Tax stood at ₹0 (after interest and depreciation but before tax) as against ₹0 reported in the previous year, showing an improvement in profitability. After providing for current and deferred taxes, the Net Profit/Loss after Tax amounted to ₹0 as compared to Net Profit/Loss of  0 in the previous year.`,
    `The Company continues to focus on strengthening its business model by securing both long-term and short-term contracts to sustain and improve profitability in the coming years.`,
    ``,
    `6. Internal Financial Controls`,
    `There is an adequate internal financial control. The Company has in place systems of internal control designed to provide reasonable assurance regard to the effectiveness and relativity of financial reporting and compliance with applicable Laws and regulations.`,
    ``,
    `7. Risk Management`,
    `The Management of the Company has framed the risk management policy for the Company including identification of the elements of risk. Further, there is no material risk which in the opinion of the Board might threaten the existence of the Company.`,
    ``,
    `8. Secretarial Standards`,
    `The Company has followed the applicable Secretarial Standards, i.e. SS-1 and SS-2, relating to 'Meetings of the Board of Directors' and 'General Meetings' respectively.`,
    `Secretarial Auditor's Remarks`,
    `The requirement of Secretarial Audit is not applicable to the company as the company does not fall under the threshold provided under the said rules.`,
    ``,
    `9. Subsidiary, Joint Venture and Associate Company`,
    `The company did not have any Subsidiary, Joint Venture and Associate Company during the financial year under review.`,
    ``,
    `10. Directors' Responsibility Statement`,
    `As required u/s 134(5) of the Companies Act 2013, the Directors state that:`,
    `i. in the preparation of the annual accounts for the financial year ended 31 st March ${year} the applicable accounting standards have been followed along with proper explanation relating to material departures;`,
    `ii. the directors had selected such accounting policies and applied them consistently and made judgments and estimates that are reasonable and prudent so as to give a true and fair view of the state of affairs of the company at the end of the financial year covered under this Report and of the profit and loss of the company for that period;`,
    `iii. the directors had taken proper and sufficient care for the maintenance of adequate accounting records in accordance with the provisions of this Act for safeguarding the assets of the company and for preventing and detecting fraud and other irregularities;`,
    `iv. the directors had prepared the annual accounts on a going concern basis and`,
    `v. The directors had devised proper systems to ensure compliance with the provisions of all applicable laws and that such systems were adequate and operating effectively.`,
    ``,
    `11. Business Responsibility and Sustainability Report`,
    `The company being unlisted company, this clause is not applicable.`,
    ``,
    `12. Contracts or Arrangements with Related Parties`,
    `All contracts / arrangements / transactions entered by the Company during the financial year with related parties were in its ordinary course of business and on arms' length basis and do not have potential conflict with interest of the Company at large.`,
    `Details of transactions with related parties during FY ${year}, are provided in the notes to the financial statements. There were no transactions requiring disclosure under section 134 (3)(h) of the Act. Hence, the prescribed Form AOC–2 does not form a part of this Report.`,
    ``,
    `13. Corporate Social Responsibility`,
    `The company has not developed and implemented any Corporate Social Responsibility initiatives as the said provisions are not applicable to the company.`,
    ``,
    `14. Directors and Key Managerial Personnel`,
    `In the Financial Year under review: There is no change in directorship of the Company.`,
    ``,
    `Name | Appoint/Resign | Event Date | DIN`,
  ];

  directors.forEach((d) => {
    lines.push(`${d.name || ""} | ${d.designation || ""} | ${fmtDate(d.appointmentDate)} | ${d.dinOrPan || ""}`);
  });

  lines.push(
    ``,
    `15. Performance Evaluation`,
    `The clause is not applicable to this Company as the paid-up capital of the company is less than 25 Crores.`,
    ``,
    `16. Auditors and Auditors' Report`,
    `(i) Statutory Auditors`,
    auditorText,
    `Auditors' Report contain the following Disclaimers:`,
    `Board's Comment on Auditor's Disclaimers:`,
    `Disclaimer of Opinion on Audit Trail: The Board acknowledges the auditor's concerns regarding the absence of an audit trail feature in the company's accounting software for the financial year ${fy} The management faced challenges in selecting and implementing audit trail-compliant software due to the company's limited size and transaction volume. We recognize the importance of maintaining an audit trail and are committed to upgrading our accounting system to include this feature ASAP. We are actively working to ensure full compliance with statutory requirements and appreciate the auditor's understanding of the constraints faced.`,
    ``,
    `Disclaimer of Opinion on Disallowance Under Section 43B(h):`,
    `The Board notes the auditor's disclaimer of opinion due to limitations in verifying compliance with Section 43B(h) of the Income Tax Act, 1961. We acknowledge the need for clear and sufficient documentation to confirm payments to micro and small enterprises within the specified time limits. The company is reviewing its processes and documentation to enhance compliance and ensure that all payments are made within the required time frame to avoid potential disallowances.`,
    ``,
    `Disclaimer of Opinion Due to Inadequate Identification of Micro and Small Enterprises:`,
    `The Board recognizes the auditor's observation regarding the inadequate identification of micro and small enterprises. We are taking steps to improve our records and systems for better classification and identification of suppliers as defined under the Micro, Small and Medium Enterprises Development Act, 2006. This will help ensure that payments are made within the stipulated time limits and comply with Section 43B(h) of the Income Tax Act, 1961. The management is committed to addressing these issues and will implement necessary measures to align with statutory requirements.`,
    `The Auditors' Report does not contain any other qualification, reservation, adverse remark apart from the observation mentioned above. The Notes on Financial Statement referred to in the Statutory Auditors' Report are self-explanatory and do not call for any further comments.`,
    ``,
    `(ii) Cost Auditors`,
    `The requirement of cost audit is not applicable to the Company for the financial year as the turnover of the Company was below the threshold limit prescribed in the said Rules for cost audit.`,
    ``,
    `(iii) Secretarial Auditor`,
    `The requirement of Secretarial Audit is not applicable to the company as the company does not fall under the threshold provided under the said rules.`,
    `Secretarial Auditor's Remarks`,
    `The requirement of Secretarial Audit is not applicable to the company as the company does not fall under the threshold provided under the said rules.`,
    ``,
    `17. Meetings of the Board`,
    ` During the year under review, the Board met ${boardMeetings.length} times on the following dates: `,
    ``,
    `S. No. | Date of meeting | Total No. of Directors on the Date of Meeting | No. of Directors attended`,
  );

  boardMeetings.forEach((bm, i) => {
    lines.push(`${i + 1} | ${fmtDate(bm.meetingDate)} | ${bm.totalDirs || 0} | ${bm.attended || 0}`);
  });

  lines.push(
    ``,
    `Attendance of directors`,
    `S. No. | Name of the Directors | Number of Meetings which director was entitled to attend | No. of Meetings attended`,
  );

  directors.forEach((d, i) => {
    lines.push(`${i + 1} | ${d.name || ""} | ${boardMeetings.length} | ${boardMeetings.length}`);
  });

  lines.push(
    ``,
    `18. Transfer to any reserves:`,
    `The Company has transferred Rs. Nil to its Reserves in the Balance Sheet during the year under review.`,
    ``,
    `19. Share Capital/Increase in Share Capital/issue of equity shares with differential voting rights:`,
    `During the year under review there is No change recorded in the Capital Structure of the Company.`,
    ``,
    `20. Number of meetings of the shareholder/members:`,
    `S. No. | Date and type of meeting | Total No. of Shareholder on the Date of Meeting | No. of Shareholder attended`,
    ``,
    `21. Receipt of any commission by MD / WTD from a Company or for receipt of commission / remuneration from it Holding or subsidiary`,
    `The Company has no holding company or subsidiary company, hence the provisions of Section 197(14) of the Act relating to receipt of remuneration or commission by the Whole-time Director from holding company or subsidiary company of the Company are not applicable to the Company.`,
    ``,
    `22. Declaration by Independent Director`,
    `The provision regarding appointment of Independent Director is not applicable to this Company.`,
    ``,
    `23. Audit Committee`,
    `The provisions of Section 177of the Companies Act, 2013 read with Rule 7 of the Companies (Meetings of the Board and its Powers) Rules, 2013 are not applicable to the Company.`,
    ``,
    `24. Corporate Social Responsibility Committee`,
    `The provisions of section 135 of the Companies Act, 2013, is not applicable to the company, accordingly company is not required to constitute CSR Committee.`,
    ``,
    `25. Nomination And Remuneration Committee`,
    `The clause is not applicable to this Company as the provisions of Nomination and Remuneration Committee are not applicable to the Company.`,
    ``,
    `26. Stakeholders Relationship Committee`,
    `The clause is not applicable to this Company as the provisions of Stakeholders Relationship Committee are not applicable to the Company.`,
    ``,
    `27. Risk Management Committee`,
    `The clause is not applicable to this Company as the provisions of Risk Management Committee are not applicable to the Company.`,
    ``,
    `28. Vigil Mechanism and Whistle-blower Policy`,
    `The provisions of Section 177(9) & (10) of the Companies Act, 2013 read with Rule 7 of the Companies (Meetings of the Board and its Powers) Rules, 2013 are not applicable to the Company.`,
    ``,
    `29. Particulars of loans given, investments made, guarantees given and securities provided`,
    `Particulars of investments,  loan or guarantee or any security provided by the Company during the year under review made are provided in the Financial Statement. All the trasaction have been made in the oridinary course of business.`,
    ``,
    `30. Conservation of Energy, Technology Absorption and Foreign Exchange Earnings and Outgo.`,
    `(a) Details regarding technology absorption as per Rule 8(3)(B)`,
    `The Company has not imported any technology during the period under review. Continuous efforts are being made to improve the quality of products and processes in order to enhance operational efficiency and customer satisfaction.`,
    `(b) Details regarding energy conservation as per Rule 8(3)(A)`,
    `The Company has taken adequate measures to ensure optimum utilization of all equipment and resources so as to conserve energy. Efforts are continuously made to identify and implement energy-saving opportunities.`,
    `(c) Details regarding foreign exchange earnings and outgo as per Rule 8(3)(C )`,
    `There were no foreign exchange earnings or outgo during the financial year under review.`,
    ``,
    `31. Corporate Governance`,
    `The Company being unlisted company, this clause is not applicable to the company.`,
    ``,
    `32. Annual Return`,
    `Company is not required to provide extract of Annual Return in Form MGT-9.  The company does not have any website, therefore it not required to publish Annual Return.`,
    ``,
    `33. Particulars of Employees and related disclosures`,
    `Regarding Rules 5(2) and 5(3) of the Companies (Appointment and Remuneration of Managerial Personnel) Rules, 2014, a statement showing the names and other particulars of the employees drawing remuneration in excess of the limits set out in the said rules, the Company likes to mention that there are no such employees in the Company.`,
    ``,
    `34. Prevention of sexual harassment at workplace`,
    `In accordance with the requirements of the Sexual Harassment of Women at Workplace (Prevention, Prohibition & Redressal) Act, 2013 ("POSH Act") and Rules made thereunder, the Company has in place a policy which mandates no tolerance against any conduct amounting to sexual harassment of women at workplace. The Company has an Internal Committee to redress and resolve any complaints arising under the POSH Act. Training / Awareness programs are conducted throughout the year to create sensitivity towards ensuring respectable workplace.`,
    ``,
    `35. Statement that the company has complied with Maternity Benefit Act.`,
    `The Board of Directors confirms that the Company has complied with the provisions of the Maternity Benefit Act, 1961. The policy has been adopted and is in force; however, during the financial year ${fy}, no employee has availed of maternity leave, and consequently, no maternity benefit was granted during the year.`,
    ``,
    `36. Deposits`,
    `The company has not accepted deposits from the members of the general public during the Financial Year. There were no unclaimed or unpaid deposits as on 31.03.${year}.`,
    ``,
    `37. Fraud Reporting (Required by Companies Amendment Act, 2015)`,
    `No cases regarding frauds have been filed during the year under the Act.`,
    ``,
    `38. Details of application made or any preceding pending under IBC, 2016 during the FY along with the current status`,
    `No applications are filed or pending under IBC, 2016 against the Company. Hence the said provision is not applicable to the Company.`,
    ``,
    `39. The details of difference between amount of the valuation done at the time of one-time settlement and the valuation done while taking loan from the Banks or Financial Institutions along with the reasons thereof`,
    `There was no instance of one-time settlement with any Bank or Financial Institution.`,
    ``,
    `40. Details of significant & material orders passed by the regulators or courts or tribunal`,
    `There are no orders has been passed by any Regulators or courts or tribunal during the year.`,
    ``,
    `41. Website of the Company`,
    `The Company does not have any functional website.`,
    ``,
    `42. State the details in respect of frauds reported by auditors under sub-section (12) of section 143 other than those which are reportable to the Central Government :`,
    `No cases regarding frauds have been filed during the year under the Act.`,
    ``,
    `43. Disclosure For Companies Covered Under Section 178(1) On Directors Appointment And Remuneration Including Other Matters Provided Under Section 178(3)`,
    `The provisions of Section 178(1) and Section 178(3) relating to the constitution of Nomination and Remuneration Committee and Stakeholders' Relationship Committee are not applicable to the Company. Hence, no such disclosures are required to be made in this Report.`,
    ``,
    `44. Details Of Loan, Guarantee, Investment Or Security Is Given By The Company As Per Section 186`,
    `This clause is Not applicable on this company`,
    ``,
    `45. Number of employees as on the closure of financial year`,
    `  Female-`,
    `  Male-`,
    `  Transgender-`,
    ``,
    `ACKNOWLEDGEMENT:`,
    `Your directors place on records their deep appreciation and gratitude for the cooperation and assistance extended to the company by Banks, Government Agencies, Suppliers, Customers, Consultants and company staff at all levels. Your directors also wish to place on record their appreciation of the wholehearted and continuous support by the shareholders who have always been a source of strength for the company.`,
    ``,
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  );

  signatories.forEach((d) => {
    lines.push(`Date: ${fmtDate(c.boardMeetingDate)}    ${d.name || ""}`);
    lines.push(`Place: ${c.boardMeetingPlace || ""}    ${d.designation || ""}`);
  });

  return lines;
}

// ============================================================
// 4. DIRECTORS' REPORT — BOARD MEETINGS VERSION (Sheet1)
// ============================================================
function buildSheet1Report(c) {
  const year = fyEndYear(c);
  const fy = fyStr(c);
  const auditor = (c.auditors || []).find((a) => a.isCurrent) || {};
  const boardMeetings = c.boardMeetings || [];
  const directors = c.directors || [];
  const signatories = directors.filter((d) => d.isSignatory);

  const auditorText = auditor.firmName
    ? `M/s. ${auditor.firmName}, ${auditor.firmDesig || "Chartered Accountants"} (Firm Registration No. ${auditor.firmNo || ""}) are the Statutory Auditors of the Company.`
    : `Statutory Auditors details not available.`;

  const lines = [
    `Registered Address: ${c.registeredAddr || ""}`,
    `CIN: ${c.cin || ""}`,
    `Email : ${c.email || ""}`,
    ``,
    `DIRECTORS' REPORT FOR THE FINANCIAL YEAR ${fy}                                                                                        To The Members of ${c.companyName || ""}`,
    `Dear Members`,
    `The Board of Directors of your company have pleasure in presenting their Annual Report and the Audited Financial Statements for the financial year ended on 31st March, ${year}.`,
    ``,
    `1. Meetings of the Board`,
    ` During the year under review, the Board met ${boardMeetings.length} times on the following dates: `,
    ``,
    `S. No. | Date of meeting | Total No. of Directors on the Date of Meeting | No. of Directors attended`,
  ];

  boardMeetings.forEach((bm, i) => {
    lines.push(`${i + 1} | ${fmtDate(bm.meetingDate)} | ${bm.totalDirs || 0} | ${bm.attended || 0}`);
  });

  lines.push(
    ``,
    `Attendance of directors`,
    `S. No. | Name of the Directors | Number of Meetings which director was entitled to attend | No. of Meetings attended`,
  );

  directors.forEach((d, i) => {
    lines.push(`${i + 1} | ${d.name || ""} | ${boardMeetings.length} | ${boardMeetings.length}`);
  });

  lines.push(
    ``,
    `20. Number of meetings of the shareholder/members:`,
    `S. No. | Date and type of meeting | Total No. of Shareholder on the Date of Meeting | No. of Shareholder attended`,
    ``,
    ` Website of the Company`,
    `The Company does not have any functional website.`,
    ``,
    `3. Directors' Responsibility Statement`,
    `As required u/s 134(5) of the Companies Act 2013, the Directors state that:`,
    `i. in the preparation of the annual accounts for the financial year ended 31 st March ${year} the applicable accounting standards have been followed along with proper explanation relating to material departures;`,
    `ii. the directors had selected such accounting policies and applied them consistently and made judgments and estimates that are reasonable and prudent so as to give a true and fair view of the state of affairs of the company at the end of the financial year covered under this Report and of the profit and loss of the company for that period;`,
    `iii. the directors had taken proper and sufficient care for the maintenance of adequate accounting records in accordance with the provisions of this Act for safeguarding the assets of the company and for preventing and detecting fraud and other irregularities;`,
    `iv. the directors had prepared the annual accounts on a going concern basis and`,
    `v. The directors had devised proper systems to ensure compliance with the provisions of all applicable laws and that such systems were adequate and operating effectively.`,
    ``,
    `4. State the details in respect of frauds reported by auditors under sub-section (12) of section 143 other than those which are reportable to the Central Government :`,
    `No cases regarding frauds have been filed during the year under the Act.`,
    ``,
    `5.  Declaration by Independent Director`,
    `The provision regarding appointment of Independent Director is not applicable to this Company.`,
    ``,
    `6. Disclosure For Companies Covered Under Section 178(1) On Directors Appointment And Remuneration Including Other Matters Provided Under Section 178(3)`,
    `This clause is Not applicable on this company`,
    ``,
    `7. Secretarial Auditor's Remarks`,
    `The requirement of Secretarial Audit is not applicable to the company as the company does not fall under the threshold provided under the said rules.`,
    ``,
    `8. Details Of Loan, Guarantee, Investment Or Security Is Given By The Company As Per Section 186`,
    `This clause is Not applicable on this company`,
    ``,
    `9. Results of Operations and the State of Company's Affairs`,
    `During the financial year ${fy} the Company achieved a turnover of ₹0 as compared to ₹0  in the previous financial year, reflecting a growth over the last year. The Net Profit/Loss before Tax stood at ₹0 (after interest and depreciation but before tax) as against ₹0 reported in the previous year, showing an improvement in profitability. After providing for current and deferred taxes, the Net Profit/Loss after Tax amounted to ₹0 as compared to Net Profit/Loss of  0 in the previous year.`,
    `The Company continues to focus on strengthening its business model by securing both long-term and short-term contracts to sustain and improve profitability in the coming years.`,
    ``,
    `10. Transfer to any reserves`,
    `The Company has transferred Rs. Nil to its Reserves in the Balance Sheet during the year under review.`,
    ``,
    `11. Dividend`,
    `No dividend was declared for the current financial year due to conservation of profits and continued investment in the business.`,
    ``,
    `12. Details of Material Changes From The End Of The Financial Year`,
    `There have been no material changes and commitments affecting the financial position of the Company between the end of the financial year to which the financial statement relates and date of this Report.`,
    `During the year under review, there has been no change in the capital structure of the Company.`,
    ``,
    `13. Risk Management`,
    `The Management of the Company has framed the risk management policy for the Company including identification of the elements of risk. Further, there is no material risk which in the opinion of the Board might threaten the existence of the Company.`,
    ``,
    `14. Corporate Social Responsibility`,
    `The company has not developed and implemented any Corporate Social Responsibility initiatives as the said provisions are not applicable to the company.`,
    ``,
    `15. Disclosures Under Rule 8/8A Of Companies Accounts Rules 2014`,
    `(a)  Details regarding technology absorption as per Rule 8(3)(B)`,
    `The Company has not imported any technology during the period under review. Continuous efforts are being made to improve the quality of products and processes in order to enhance operational efficiency and customer satisfaction.`,
    `(b) Details regarding energy conservation as per Rule 8(3)(A)`,
    `The Company has taken adequate measures to ensure optimum utilization of all equipment and resources so as to conserve energy. Efforts are continuously made to identify and implement energy-saving opportunities.`,
    `(c) Details regarding foreign exchange earnings and outgo as per Rule 8(3)(C )`,
    `There were no foreign exchange earnings or outgo during the financial year under review.`,
    ``,
    `16. Auditors:`,
    `Statutory auditors`,
    auditorText,
    `Auditors' Report contain the following Disclaimers:`,
    `Board's Comment on Auditor's Disclaimers:`,
    `Disclaimer of Opinion on Audit Trail: The Board acknowledges the auditor's concerns regarding the absence of an audit trail feature in the company's accounting software for the financial year ${fy} The management faced challenges in selecting and implementing audit trail-compliant software due to the company's limited size and transaction volume. We recognize the importance of maintaining an audit trail and are committed to upgrading our accounting system to include this feature ASAP. We are actively working to ensure full compliance with statutory requirements and appreciate the auditor's understanding of the constraints faced.`,
    ``,
    `Disclaimer of Opinion on Disallowance Under Section 43B(h):`,
    `The Board notes the auditor's disclaimer of opinion due to limitations in verifying compliance with Section 43B(h) of the Income Tax Act, 1961. We acknowledge the need for clear and sufficient documentation to confirm payments to micro and small enterprises within the specified time limits. The company is reviewing its processes and documentation to enhance compliance and ensure that all payments are made within the required time frame to avoid potential disallowances.`,
    ``,
    `Disclaimer of Opinion Due to Inadequate Identification of Micro and Small Enterprises:`,
    `The Board recognizes the auditor's observation regarding the inadequate identification of micro and small enterprises. We are taking steps to improve our records and systems for better classification and identification of suppliers as defined under the Micro, Small and Medium Enterprises Development Act, 2006. This will help ensure that payments are made within the stipulated time limits and comply with Section 43B(h) of the Income Tax Act, 1961. The management is committed to addressing these issues and will implement necessary measures to align with statutory requirements.`,
    `The Auditors' Report does not contain any other qualification, reservation, adverse remark apart from the observation mentioned above. The Notes on Financial Statement referred to in the Statutory Auditors' Report are self-explanatory and do not call for any further comments.`,
    ``,
    `17. ACKNOWLEDGEMENT:`,
    `Your directors place on records their deep appreciation and gratitude for the cooperation and assistance extended to the company by Banks, Government Agencies, Suppliers, Customers, Consultants and company staff at all levels. Your directors also wish to place on record their appreciation of the wholehearted and continuous support by the shareholders who have always been a source of strength for the company.`,
    ``,
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  );

  signatories.forEach((d) => {
    lines.push(`Date: ${fmtDate(c.boardMeetingDate)}    ${d.name || ""}`);
    lines.push(`Place: ${c.boardMeetingPlace || ""}    ${d.designation || ""}`);
  });

  return lines;
}

// ============================================================
// 5. FORM AOC-1 (5AOC1 sheet)
// ============================================================
function buildAoc1(c) {
  const signatories = (c.directors || []).filter((d) => d.isSignatory);

  const lines = [
    `Form AOC-1`,
    `(Pursuant to first proviso to sub-section (3) of section 129 read with rule 5 of Companies (Accounts) Rules, 2014)`,
    ``,
    `Statement containing salient features of the financial statement of subsidiaries/associate companies/joint ventures`,
    ``,
    `Part "A": Subsidiaries`,
    `(Information in respect of each subsidiary to be presented with amounts in Rs.)`,
    ``,
    `Sl. No. | Particulars | Details`,
    `1.       | Name of the subsidiary | NA`,
    `2.       | Reporting period for the subsidiary concerned, if different from the holding company's reporting period | NA `,
    `3.       | Reporting currency and Exchange rate as on the last date of the relevant Financial year in the case of foreignsubsidiaries | NA`,
    `4.       | Share capital | NA`,
    `5.       | Reserves & surplus | NA`,
    `6.       | Total assets | NA`,
    `7.       | Total Liabilities | NA`,
    `8.       | Investments | NA`,
    `9.       | Turnover | NA`,
    `10.   | Profit before taxation | NA`,
    `11.   | Provision for taxation | NA`,
    `12.   | Profit after taxation | NA`,
    `13.   | Proposed Dividend | NA`,
    `14.   | % of shareholding | NA`,
    ``,
    `Notes: The following information shall be furnished at the end of the statement:`,
    `1. Names of subsidiaries which are yet to commence operations`,
    `2. Names of subsidiaries which have been liquidated or sold during the year.`,
    ``,
    `Part "B": Associates and Joint Ventures`,
    `Statement pursuant to Section 129 (3) of the Companies Act, 2013 related to Associate Companies and Joint Ventures`,
    ``,
    `Name of associates/Joint Ventures`,
    `1.      Latest audited Balance Sheet Date`,
    `2.      Shares of Associate/Joint Ventures held by the company on the year end`,
    `No.`,
    `Amount of Investment in Associates/Joint Venture`,
    `Extend of Holding%`,
    `3.      Description of how there is significant influence`,
    `4.      Reason why the associate/joint venture is not consolidated`,
    `5.      Net worth attributable to shareholding as per latest audited Balance Sheet`,
    `6.      Profit/Loss for the year`,
    `i.                     Considered in Consolidation`,
    `ii.                   Not Considered in Consolidation`,
    ``,
    `1. Names of associates or joint ventures which are yet to commence operations.`,
    `2. Names of associates or joint ventures which have been liquidated or sold during the year.`,
    ``,
    `Note: This Form is to be certified in the same manner in which the Balance Sheet is to be certified.`,
    ``,
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  ];

  signatories.forEach((d) => {
    lines.push(d.name || "");
    lines.push(d.designation || "");
  });

  lines.push(
    `Date: ${fmtDate(c.boardMeetingDate)}`,
    `Place: ${c.boardMeetingPlace || ""}`,
  );

  return lines;
}

// ============================================================
// 6. FORM AOC-2 (6AOC2 sheet)
// ============================================================
function buildAoc2(c) {
  const signatories = (c.directors || []).filter((d) => d.isSignatory);

  const lines = [
    `FORM NO. AOC-2`,
    `(Pursuant to clause (h) of sub-section (3) of section 134 of the Act and Rule 8(2) of the Companies (Accounts) Rules, 2014)`,
    ``,
    `Form for disclosure of particulars of contracts/arrangements entered into by the company with related parties referred to in sub-section (1) of section 188 of the Companies Act, 2013 including certain arm's length transactions under third proviso thereto.`,
    ``,
    `1. Details of contracts or arrangements or transactions not at arm's length basis`,
    `(a) Name(s) of the related party and nature of relationship | NONE`,
    `(b) Nature of contracts/arrangements/transactions | NONE`,
    `© Duration of the contracts / arrangements/transactions | NONE`,
    `(d) Salient terms of the contracts or arrangements or transactions including the value, if any | NONE`,
    `(e) Justification for entering into such contracts or arrangements or transactions | NONE`,
    `(f) Date of approval by the Board | NONE`,
    `(g) Amount paid as advances, if any | NONE`,
    `(h) Date on which the special resolution was passed in general meeting as required under first proviso to section 188 | NONE`,
    ``,
    `2.  Details of material contracts or arrangement or transactions at arm's length basis`,
    `(a) Name(s) of the related party and nature of relationship | NONE`,
    `(b) Nature of contracts/arrangements/transactions | NONE`,
    `(c) Duration of the contracts / arrangements/transactions | NONE`,
    `(d) Salient terms of the contracts or arrangements or transactions including the value, if any | NONE`,
    `(e) Date(s) of approval by the Board, if any | NONE`,
    `(f) Amount paid as advances, if any | NONE`,
    ``,
    `Note: Form shall be signed by the persons who have signed the Board's report.`,
    ``,
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  ];

  signatories.forEach((d) => {
    lines.push(d.name || "");
    lines.push(d.designation || "");
  });

  lines.push(
    `Date: ${fmtDate(c.boardMeetingDate)}`,
    `Place: ${c.boardMeetingPlace || ""}`,
  );

  return lines;
}

// ============================================================
// 7. MGT-7 RESOLUTION EXTRACT (MGT7ACTC sheet)
// ============================================================
function buildMgt7(c) {
  const signatories = (c.directors || []).filter((d) => d.isSignatory);
  const dir1 = signatories[0]?.name || "";
  const dir2 = signatories[1]?.name || signatories[0]?.name || "";

  const lines = [
    `Registered Address: ${c.registeredAddr || ""}`,
    `CIN: ${c.cin || ""}`,
    `Email : ${c.email || ""}`,
    ``,
    `EXTRACT OF RESOLUTION PASSED IN THE BOARD MEETING OF ${c.companyName || ""} HELD ON ${fmtDate(c.boardMeetingDate)} AT 11.00 A.M. AT THE REGISTERED OFFICE OF THE COMPANY AT ${c.registeredAddr || ""}`,
    ``,
    `Appointment of Designated person to furnish information to Registrar of Companies with respect to Beneficial Interests in the Shares of the Company pursuant to Rule 9 of the Companies (Management and Administration) Rules, 2013.`,
    ``,
    `"RESOLVED THAT pursuant to Rule 9 of the Companies (Management and Administration) Rules, 2013 read with the provisions of Section 89 and 90 of the Companies Act, 2013; the Companies (Management and Administration) Rules, 2014 and such other applicable provisions of the Companies Act, 2013 and Rules made thereunder;`,
    ``,
    `The Board of Directors does hereby appoint ${dir1} AND ${dir2} as Director of the Company as the Designated Person for furnishing information to the Registrar of Companies or any such other Authority with respect to beneficial interests in the shares of the Company.`,
    ``,
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  ];

  signatories.forEach((d) => {
    lines.push(`Date: ${fmtDate(c.boardMeetingDate)}    ${d.name || ""}`);
    lines.push(`Place: ${c.boardMeetingPlace || ""}    ${d.designation || ""}`);
  });

  return lines;
}

// ============================================================
// 8. DETAILS OF SHAREHOLDERS (DetailsofSH sheet)
// ============================================================
function buildDetailsOfSH(c) {
  const shareholders = c.shareholders || [];
  const totalShares = shareholders.reduce((s, sh) => s + (sh.shares || 0), 0);
  const paidUp = shareholders.reduce((s, sh) => s + ((sh.shares || 0) * (sh.faceValue || 10)), 0);
  const signatories = (c.directors || []).filter((d) => d.isSignatory);

  const lines = [
    `DETAILS OF MEMBERS, DEBENTURE HOLDERS AND OTHER SECURITIES HOLDERS (As on 31.03. ${fyEndYear(c)})`,
    ``,
    `AUTHORISED SHARE CAPITAL : `,
    `PAID-UP CAPITAL : ${paidUp.toLocaleString("en-IN")}`,
    ``,
    `SL.NO. | L.F.NO. | NAME | TYPE OF SECURITY | NO. OF EQUITY SHARE | FACE VALUE`,
  ];

  shareholders.forEach((sh) => {
    lines.push(`${sh.srNo || ""} | ${sh.folioNo || ""} | ${sh.name || ""} | ${sh.securityType || "Equity"} | ${(sh.shares || 0).toLocaleString("en-IN")} | ${sh.faceValue || 10}`);
  });

  lines.push(
    `TOTAL | | | | ${totalShares.toLocaleString("en-IN")} | `,
    ``,
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  );

  signatories.forEach((d) => {
    lines.push(`Date: ${fmtDate(c.boardMeetingDate)}    ${d.name || ""}`);
    lines.push(`Place: ${c.boardMeetingPlace || ""}    ${d.designation || ""}`);
  });

  return lines;
}

// ============================================================
// 9. DETAILS OF DIRECTORS (DetailsofDirectors sheet)
// ============================================================
function buildDetailsOfDirectors(c) {
  const directors = c.directors || [];
  const paidUp = (c.shareholders || []).reduce((s, sh) => s + ((sh.shares || 0) * (sh.faceValue || 10)), 0);
  const signatories = directors.filter((d) => d.isSignatory);

  const lines = [
    `DETAILS OF  DIRECTORS`,
    ``,
    `AUTHORISED SHARE CAPITAL : `,
    `PAID-UP CAPITAL : ${paidUp.toLocaleString("en-IN")}`,
    ``,
    `SN | DIN | NAME | NATIONALITY | FATHER'S NAME | DOB | DESIGNATION | CATEGORY`,
  ];

  directors.forEach((d, i) => {
    lines.push(`${i + 1} | ${d.dinOrPan || ""} | ${d.name || ""} | ${d.nationality || "Indian"} | ${d.fatherName || ""} | ${fmtDate(d.dob)} | ${d.designation || ""} | ${d.occupation || ""}`);
  });

  lines.push(
    ``,
    `TOTAL`,
    ``,
    `For and on the behalf of the Board`,
    ` FOR:- ${c.companyName || ""}`,
  );

  signatories.forEach((d) => {
    lines.push(`Date: ${fmtDate(c.boardMeetingDate)}    ${d.name || ""}`);
    lines.push(`Place: ${c.boardMeetingPlace || ""}    ${d.designation || ""}`);
  });

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

function applyReplacements(lines, replacements) {
  if (!Array.isArray(replacements) || !replacements.length) return lines;
  return lines.map((line) => replacements.reduce((text, rule) => {
    const find = String(rule?.find || '');
    if (!find) return text;
    return text.split(find).join(String(rule?.replace || ''));
  }, line));
}

function buildLines(docType, company, options = {}) {
  const doc = DOCS[docType];
  if (!doc) {
    const err = new Error('Unknown document type');
    err.statusCode = 400;
    throw err;
  }
  return applyReplacements(doc.build(company), options.replacements);
}

module.exports = {
  DOCS,
  buildLines,
  fmt,
  fmtDate,
  fmtShort,
  fyStr,
  fyEndYear,
  buildAuditorsReport,
  buildNotesToAccounts,
  buildDirectorsReport,
  buildSheet1Report,
  buildAoc1,
  buildAoc2,
  buildMgt7,
  buildDetailsOfSH,
  buildDetailsOfDirectors,
};
