require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// ROC question bank — BATCH 2 (top-up). Additive script: adds new, distinct
// MCQs to reach 80/80/80/80 per level (from the existing 40/40/35/35).
// Does NOT delete existing ROC questions. Format: [q, A, B, C, D, correct].
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'roc';

const INTERN = [
  ["MCA21 is the:", "Income tax e-filing portal", "Online portal of the Ministry of Corporate Affairs for company e-filings", "GST return filing portal", "EPFO portal", "B"],
  ["A DSC (Digital Signature Certificate) used for MCA filings is generally issued by a:", "Licensed Certifying Authority", "Bank branch", "Stock exchange", "GST office", "A"],
  ["A Class 3 DSC is commonly required for:", "Company/LLP e-filings and e-tendering", "Only email communication", "Only social media login", "Only mobile banking", "A"],
  ["A promoter of a company, as defined under the Companies Act, is a person who has been named as such in the prospectus or is otherwise involved in the:", "Audit of the company", "Formation of the company or control over its affairs", "GST registration only", "Bank account operations only", "B"],
  ["The subscribers to the Memorandum of a company automatically become its first:", "Auditors", "Members/shareholders", "Registrar staff", "Bankers", "B"],
  ["The first directors of a company, in the absence of a specific provision in the Articles, are usually the:", "Auditors", "Subscribers to the memorandum who are individuals", "Registrar's nominees", "Bank managers", "B"],
  ["Authorised share capital refers to the:", "Capital actually received from shareholders", "Maximum capital a company is permitted to raise, as stated in the Memorandum", "Capital borrowed from banks", "Capital shown in the P&L account", "B"],
  ["Issued share capital refers to the part of the authorised capital that has been:", "Offered for subscription to shareholders", "Repaid to creditors", "Written off as goodwill", "Deducted as depreciation", "A"],
  ["Paid-up share capital refers to the:", "Total authorised capital", "Amount actually paid by shareholders on the shares allotted to them", "Amount borrowed as debentures", "Market value of shares", "B"],
  ["A Statutory Register that records the details of shareholders is the:", "Register of Charges", "Register of Members", "Register of Directors", "Minutes Book", "B"],
  ["A Statutory Register that records loans given by the company is required to be maintained under which broad heading?", "Register of Loans and Investments", "Register of Members", "Register of Renewed Share Certificates", "Attendance Register", "A"],
  ["A Statutory Register that records the company's contracts in which directors are interested is the:", "Register of Members", "Register of Contracts/Arrangements in which Directors are interested", "Register of Charges", "Register of Deposits", "B"],
  ["The service used to check the availability of a proposed company name before applying for registration is:", "GSTIN verification", "The name search/reservation facility on the MCA portal", "Trademark renewal", "PAN verification", "B"],
  ["A proposed company name is generally not allowed if it is identical or too similar to an:", "Unrelated dissolved company from 50 years ago in another country", "Existing company/LLP name or a registered trademark", "Employee's personal name", "Auditor's firm name always", "B"],
  ["The fee for filing e-forms with the ROC is generally linked to the company's:", "Number of employees", "Authorised/nominal share capital slab", "Number of customers", "GST turnover", "B"],
  ["An additional fee (over the normal fee) becomes payable to the ROC when an e-form is filed:", "Before the due date", "After the prescribed due date (late filing)", "On a public holiday", "By a foreign company only", "B"],
  ["Basic company information such as CIN, registration date, and status can be checked free of cost through:", "MCA's Company/LLP Master Data search", "A private paid database only", "The Income Tax portal", "The GST portal", "A"],
  ["A DIN can become 'Deactivated' on the MCA record mainly due to:", "Regular attendance at board meetings", "Non-filing of the DIR-3 KYC by the due date", "Filing the annual return on time", "Holding directorship in one company only", "B"],
  ["An Additional Director appointed by the Board generally holds office only until the:", "Next Board meeting", "Next Annual General Meeting", "End of the financial year automatically", "End of their life membership", "B"],
  ["An Alternate Director is appointed to act for a director who is:", "Permanently disqualified", "Absent from India for a specified period", "The Managing Director always", "A shareholder only", "B"],
  ["A Nominee Director is typically appointed to represent the interests of a:", "Random shareholder chosen by lottery", "Financial institution, bank, or the Government, as per an agreement or law", "Competitor company", "Local municipality", "B"],
  ["A private company is generally treated as a 'small company' if it satisfies prescribed limits relating to paid-up capital and:", "Number of directors", "Turnover", "Number of foreign branches", "Number of trademarks held", "B"],
  ["A private company that converts into a One Person Company must satisfy the prescribed eligibility conditions relating to paid-up capital and:", "Number of employees", "Turnover", "Number of trademarks", "GST registration status", "B"],
  ["An OPC exceeding certain prescribed thresholds relating to paid-up capital/turnover may be required to convert into a:", "Government company", "Private or public company", "Foreign company", "LLP compulsorily", "B"],
  ["The Register of Charges of a company is required to be kept at its:", "Bank branch", "Registered office", "Auditor's office", "Trade Marks Registry", "B"],
  ["Statutory registers of a company are primarily meant to be inspected by:", "Only the Central Government", "Members, and in some cases other specified persons, subject to conditions", "Only competitors", "Only foreign investors", "B"],
  ["The Annual Return of a company having a company secretary is required to be signed by a director and the:", "Statutory auditor", "Company Secretary", "Bank manager", "Registrar of Companies", "B"],
  ["A company without a company secretary generally has its Annual Return certified/signed as prescribed, often involving a:", "Cost accountant only", "Company Secretary in Practice (PCS)", "Income tax officer", "GST practitioner", "B"],
  ["The Board's Report of a company is required to be attached to the financial statements and covers matters such as the state of affairs and:", "Only the balance sheet figures", "Material changes, commitments and other prescribed disclosures", "Only the auditor's fee", "Only the GST liability", "B"],
  ["A company's registered office proof document commonly required at incorporation includes a utility bill and a:", "GST certificate", "No-objection certificate (NOC)/rent agreement or ownership proof", "Trademark certificate", "Import-export code", "B"],
  ["A change of registered office within the same city, town, or village generally requires:", "A special resolution and NCLT approval", "A board resolution, with the ROC intimated in the prescribed form", "Central Government approval only", "No filing at all", "B"],
  ["A common seal, if adopted by a company, is generally used to:", "Replace all director signatures on every document", "Authenticate certain documents as decided by the Board, where used", "File GST returns", "Register a trademark", "B"],
  ["Voting rights of equity shareholders are generally proportional to their:", "Attendance at meetings", "Shareholding in the company's equity capital", "Age", "Position as a director", "B"],
  ["A company's Index of Members is maintained mainly to help:", "Auditors compute tax", "Quickly locate a member's details in the Register of Members", "Calculate GST liability", "File trademark applications", "B"],
  ["A private company, on satisfying prescribed conditions, may convert into a public company by passing a special resolution and filing the relevant form with the:", "Trade Marks Registry", "ROC", "Income Tax Department", "GST Department", "B"],
  ["A one-time cost typically associated with incorporating a company (besides ROC fees) is:", "GST registration fee always", "Stamp duty on the Memorandum/Articles as per the state", "Trademark renewal fee", "Import-export code fee", "B"],
  ["A subscriber's signature on the Memorandum of Association indicates their:", "Refusal to join the company", "Agreement to take the shares stated opposite their name", "Resignation from the company", "Removal as a director", "B"],
  ["The 'object clause' of a company can be altered by following the procedure for alteration of the:", "Articles of Association only", "Memorandum of Association", "Annual Return", "Board's Report", "B"],
  ["A company can generally have its name changed only with the approval of the members by special resolution and confirmation from the:", "Trade Marks Registry", "Central Government/Registrar (as applicable)", "Income Tax Department", "Bank", "B"],
  ["The provisions relating to registered valuers, who value assets/shares for company law purposes, are relevant mainly in matters such as mergers and:", "Routine sales invoicing", "Share valuation for allotment, buy-back, or restructuring", "GST return filing", "Trademark renewal", "B"],
];

const EXECUTIVE = [
  ["MGT-8, the certification of the annual return, is required for companies meeting a prescribed threshold of paid-up capital or:", "Number of employees", "Turnover", "Number of trademarks", "Number of directors", "B"],
  ["MGT-8 is certified by a:", "Statutory auditor", "Company Secretary in Practice", "Cost accountant", "Bank manager", "B"],
  ["Secretarial Audit under Section 204 is applicable to listed companies and other prescribed classes of public companies based on paid-up capital or:", "Number of shareholders only", "Turnover thresholds", "Number of trademarks", "Number of branches abroad only", "B"],
  ["The Secretarial Audit Report is furnished in form:", "MGT-8", "MR-3", "ADT-1", "CHG-1", "B"],
  ["An application for removal of an auditor before the expiry of their term requires a special resolution and approval of the:", "Registrar only", "Central Government", "Income Tax Department", "Trade Marks Registry", "B"],
  ["An auditor's report on removal before term is intimated to the ROC in form:", "ADT-1", "ADT-2", "ADT-3", "ADT-4", "B"],
  ["Where an auditor believes an offence involving fraud has been committed by officers/employees and it is above the prescribed materiality threshold, it must be reported to the:", "Audit Committee only", "Central Government", "Local police station directly by the auditor", "Trade Marks Registry", "B"],
  ["An auditor's report on a fraud below the prescribed materiality threshold is generally reported to the:", "Central Government", "Audit Committee or Board, and disclosed in the Board's Report", "Registrar directly with no other disclosure", "Income Tax Department", "B"],
  ["The auditor's report on fraud to the Central Government is filed in form:", "ADT-1", "ADT-4", "MGT-14", "CHG-1", "B"],
  ["A charge created specifically to secure debentures is generally filed with the ROC in form:", "CHG-1", "CHG-9", "CHG-4", "PAS-3", "B"],
  ["An application for condonation of delay in filing charge-related documents beyond the permissible period is made in form:", "CHG-1", "CHG-4", "CHG-8", "CHG-9", "C"],
  ["A declaration by a person holding shares as a registered owner but not the beneficial owner is filed by them in form:", "MGT-4", "MGT-5", "MGT-6", "MGT-8", "A"],
  ["A declaration by the beneficial owner of shares (as opposed to the registered holder) is filed in form:", "MGT-4", "MGT-5", "MGT-6", "MGT-7", "B"],
  ["When a company receives declarations under Section 89, it is required to file a return with the ROC in form:", "MGT-4", "MGT-5", "MGT-6", "MGT-14", "C"],
  ["A nomination facility for a shareholder in respect of their shares is recorded through form:", "SH-13", "SH-7", "PAS-3", "MGT-6", "A"],
  ["A company generally cannot undertake another buy-back of its shares within a period of __ from the date of closure of the preceding buy-back:", "3 months", "6 months", "1 year", "2 years", "C"],
  ["A company's buy-back of equity shares in a financial year is generally restricted to a specified percentage of its paid-up equity capital and free reserves, subject to conditions and shareholder approval routes, being higher for a:", "Board resolution route", "Special resolution route", "Ordinary resolution route", "No approval route", "B"],
  ["Certain companies issuing debentures are required to create a Debenture Redemption Reserve, primarily to:", "Reduce share capital", "Provide security for timely redemption of debentures", "Pay dividend", "Avoid GST", "B"],
  ["The return of allotment (PAS-3) is required to be filed for allotment of shares made through which route(s)?", "Only private placement", "Any allotment of shares by the company, as applicable", "Only bonus issue", "Only ESOP", "B"],
  ["An increase in a company's authorised share capital, followed by a corresponding alteration of the capital clause of the Memorandum, is filed in form:", "PAS-3", "SH-7", "CHG-1", "MGT-14", "B"],
  ["Consolidation or sub-division of a company's share capital is also intimated to the ROC through form:", "PAS-3", "SH-7", "CHG-4", "ADT-1", "B"],
  ["Shifting a company's registered office from one state to another generally requires confirmation from the:", "Registrar alone", "Regional Director / Central Government", "Income Tax Department", "GST Department", "B"],
  ["A change in a company's name, once approved by special resolution and the competent authority, results in a fresh:", "PAN card", "Certificate of Incorporation reflecting the new name", "GST registration only", "Trademark registration", "B"],
  ["Conversion of a private company into a public company (or vice versa, where permitted) is generally intimated to the ROC in form:", "INC-20A", "INC-27", "INC-22", "INC-9", "B"],
  ["Section 8 (non-profit) companies are generally required to file their annual financial statements and annual return with the ROC:", "Never, as they are fully exempt", "Just like other companies, without exemption from filing", "Only once every five years", "Only if profitable", "B"],
  ["A company maintaining a foreign register of members outside India is required to notify its location to the ROC in form:", "MGT-3", "MGT-6", "MGT-8", "PAS-3", "A"],
  ["Where the Registrar requires additional documents/clarification on a filed e-form (marked for resubmission), the company generally responds using form:", "GNL-1", "GNL-4", "CHG-9", "ADT-1", "B"],
  ["Form GNL-1 is generally used by a company to make an application to the Registrar for matters not covered by a specific e-form, such as:", "Regular annual return filing", "Compounding of offences or other miscellaneous applications", "Filing financial statements", "DIN application", "B"],
  ["Books of account of a company must ordinarily be kept at its registered office unless the Board decides otherwise and intimates the ROC within:", "24 hours", "7 days", "30 days", "90 days", "B"],
  ["Books of account and supporting vouchers of a company must generally be preserved for a minimum of:", "3 financial years", "5 financial years", "8 financial years", "20 financial years", "C"],
  ["A company's Register of Deposits is maintained mainly to record particulars of deposits accepted under the:", "Companies (Acceptance of Deposits) Rules", "GST Rules", "Income Tax Rules", "SEBI (LODR) Regulations", "A"],
  ["A Register of Renewed and Duplicate Share Certificates is maintained to record:", "New allotments only", "Instances where share certificates were renewed or reissued as duplicates", "Charges created on assets", "Board meeting minutes", "B"],
  ["Board resolutions passed for certain specified matters (e.g., borrowing beyond specified limits) must, despite being board decisions, be filed with the ROC using form:", "DIR-12", "MGT-14", "ADT-1", "CHG-1", "B"],
  ["A resolution appointing/re-appointing a Managing Director or Whole-time Director of certain companies is also generally required to be filed with the ROC in form:", "DIR-12 only", "MGT-14, along with other applicable filings", "CHG-1", "AOC-4", "B"],
  ["Under CSR provisions, any unspent amount relating to an ongoing project must be transferred to a special 'Unspent CSR Account' within a prescribed period from the:", "Date of the AGM", "End of the relevant financial year", "Date of incorporation", "Date of the last board meeting", "B"],
  ["Amounts remaining unspent in the 'Unspent CSR Account' for an ongoing project, if not spent within the prescribed period, must be transferred to a fund specified in:", "Schedule VII of the Companies Act", "Schedule I of the Companies Act", "The Income Tax Act", "The GST Act", "A"],
  ["The provisions for maintaining and inspecting statutory registers aim primarily to ensure transparency for:", "Competitors", "Members, creditors and other specified stakeholders", "Only foreign governments", "Only the media", "B"],
  ["The concept of 'deemed public company' historically applied to certain private companies that were subsidiaries of:", "Other private companies only", "Public companies, subject to conditions", "Foreign governments", "LLPs only", "B"],
  ["A registered valuer is generally required to be engaged by a company for matters such as valuation of shares in a merger, subject to rules framed under the:", "Income Tax Act", "Companies Act, 2013", "GST Act", "SEBI Act only", "B"],
  ["An application relating to conversion of a One Person Company into a private/public company, or vice versa where permitted, is generally filed in form:", "INC-6", "PAS-3", "CHG-1", "MGT-14", "A"],
];

const INTERMEDIATE = [
  ["The National Financial Reporting Authority (NFRA) primarily oversees:", "GST compliance", "Auditing and accounting standards compliance for certain classes of companies", "Trademark registrations", "Import-export licensing", "B"],
  ["NFRA has powers to investigate matters of professional misconduct in relation to auditors of certain prescribed classes of:", "Partnership firms only", "Companies and bodies corporate", "Government departments", "Individuals only", "B"],
  ["A company's Corporate Social Responsibility Committee is generally required to consist of:", "Only the Managing Director alone", "At least three directors, including one independent director (subject to conditions)", "Only the auditor", "Only external consultants", "B"],
  ["Where a company is not required to appoint an independent director, its CSR Committee may be constituted with:", "No directors at all", "Two or more directors, without the independent director condition", "Only shareholders", "Only auditors", "B"],
  ["The threshold criteria for applicability of CSR provisions include net worth, turnover, or:", "Number of employees", "Net profit of the company", "Number of trademarks owned", "Number of branches abroad", "B"],
  ["A company's related party transactions requiring shareholder approval (ordinary resolution) generally apply above prescribed:", "Only for foreign companies", "Materiality thresholds prescribed under the rules", "Any single-rupee transaction without exception", "Only for listed companies exclusively", "B"],
  ["An 'omnibus approval' by the Audit Committee for related party transactions is generally granted for:", "Transactions that are individually and cumulatively unlimited without conditions", "Repetitive transactions of a similar nature, subject to prescribed conditions and limits", "Only one-time large transactions", "Only foreign transactions", "B"],
  ["A company is required to maintain a Register of Significant Beneficial Owners (SBOs) at its:", "Bank branch", "Registered office", "Auditor's office", "Trade Marks Registry", "B"],
  ["A Significant Beneficial Owner is generally an individual holding, directly or indirectly, a specified minimum percentage of shares or significant control/influence over the:", "Auditor", "Reporting company", "Registrar", "Government", "B"],
  ["A company is required to file a return of Significant Beneficial Owners with the ROC in form:", "BEN-1", "BEN-2", "MGT-7", "PAS-3", "B"],
  ["Non-compliance with the requirement to identify and report SBOs can lead to the reporting company applying to the Tribunal for restrictions on the:", "Auditor's licence", "Rights attached to the relevant shares", "GST registration", "Trademark rights", "B"],
  ["An oppression and mismanagement petition, if the Tribunal finds merit, may result in orders such as regulation of the company's affairs or:", "Automatic winding up in every case", "Purchase of shares of oppressed members by other members/the company", "Cancellation of GST registration", "Cancellation of the company's trademark", "B"],
  ["Class action suits under Section 245 can be filed by requisite members against, among others, the company and its:", "Customers", "Directors, auditors, or advisors, in respect of specified wrongful acts", "Competitors only", "Government departments", "B"],
  ["A scheme of merger between a holding company and its wholly owned subsidiary can, subject to conditions, use the 'fast track' route which requires approval from the:", "NCLT compulsorily", "Central Government (Regional Director) instead of the NCLT", "Trade Marks Registry", "Income Tax Department", "B"],
  ["A cross-border merger involving an Indian company and a foreign company is permitted under the Companies Act read with rules, subject to:", "No RBI involvement at all", "Compliance with rules and, where applicable, RBI regulations", "GST clearance only", "Trademark clearance only", "B"],
  ["A scheme of compromise or arrangement generally requires approval of the requisite majority of members/creditors and sanction of the:", "Registrar only", "Tribunal (NCLT)", "Trade Marks Registry", "Income Tax Department", "B"],
  ["An objection to a scheme of arrangement can be raised before the Tribunal by persons holding a specified minimum shareholding or:", "Any member of the public without any threshold", "The prescribed minimum threshold of shares or debt as per rules", "Only the Government", "Only foreign investors", "B"],
  ["A demerger involves the transfer of one or more undertakings of a company to another company, typically implemented through a:", "Simple board resolution only", "Scheme of arrangement sanctioned by the Tribunal", "GST registration amendment", "Trademark assignment", "B"],
  ["A slump sale, as distinguished from a demerger, usually refers to the transfer of a business undertaking as a going concern for a:", "Scheme requiring NCLT approval always", "Lump sum consideration, generally through a business transfer agreement", "Nil consideration only", "Government order only", "B"],
  ["A private placement offer letter for issue of securities must be accompanied by an application form, and funds are required to be received through the:", "Cash directly", "Bank account of the subscriber, not through cash", "Barter of goods", "Trademark transfer", "B"],
  ["Securities allotted through private placement, if the requirements of Section 42 are not complied with, may render the company liable to a penalty and the amount received may need to be:", "Retained permanently by the company", "Refunded to the subscribers", "Transferred to the CSR fund", "Transferred to the Government", "B"],
  ["Rights issue of shares requires the offer to be made first to the company's:", "General public directly", "Existing shareholders in proportion to their holding", "Employees only", "Directors only", "B"],
  ["An ESOP (Employee Stock Option Plan) generally requires shareholder approval by way of a(n):", "Ordinary resolution in most cases for private/unlisted public companies as prescribed", "No resolution at all", "Only Board approval with no shareholder role", "NCLT approval always", "A"],
  ["A private company issuing sweat equity shares must comply with prescribed conditions including a cap on the percentage of paid-up capital that can be issued as sweat equity in a year, subject to overall limits over the company's life, as per:", "GST law", "The Companies (Share Capital and Debentures) Rules", "The Income Tax Act", "The Trade Marks Act", "B"],
  ["A private company can accept deposits from members subject to conditions without treating them as 'deposits' under specified exemptions, such as amounts received as:", "A loan from any random person", "Unsecured loans from directors, subject to conditions", "Public deposits without limit", "Deposits from the general public freely", "B"],
  ["A company's related party transaction disclosures also require reporting in the Board's Report using details prescribed in the applicable form (historically AOC-2), which covers:", "Contracts/arrangements with related parties", "GST returns", "Trademark applications", "Import-export codes", "A"],
  ["A scheme for reduction of share capital is generally not permitted if the company is in arrears in the repayment of:", "Trade payables only", "Deposits accepted from the public, or interest thereon", "Salaries alone", "GST dues alone", "B"],
  ["Filing of resolutions and agreements under Section 117 is mandatory for matters such as alteration of Articles and:", "Routine day-to-day purchase orders", "Borrowing powers exercised under Section 180(1)(c) by the Board", "GST invoices", "Trademark renewals", "B"],
  ["Non-filing of statutory forms with the ROC within the prescribed time generally attracts an additional fee, and continued default may lead to the company or its officers being liable to:", "No consequence at all", "Penalties/prosecution as prescribed under the Act", "Automatic winding up only", "Only a verbal warning", "B"],
  ["The 'Condonation of Delay Scheme', where notified in the past, allowed defaulting companies to file overdue documents and have their directors' DINs:", "Permanently cancelled", "Reactivated, subject to compliance with the scheme's conditions", "Converted into DSCs", "Transferred to another company", "B"],
  ["A struck-off company's name can, subject to conditions and within a prescribed period, be restored by an application to the:", "Registrar directly with no oversight", "NCLT (National Company Law Tribunal)", "Income Tax Department", "GST Department", "B"],
  ["An application for restoration of a struck-off company's name may be made by the company, a member, creditor, or workman within a prescribed period of:", "6 months from strike-off", "20 years from the notification of strike-off", "1 month only", "No limitation period at all", "B"],
  ["A private company's Articles may contain restrictions on the right to transfer shares, which is one of the distinguishing features compared to a:", "Public company", "One Person Company only", "Government company only", "Section 8 company only", "A"],
  ["A public company's shares are generally freely transferable, subject to:", "No restrictions whatsoever, always", "Any restrictions/lien permitted under the Articles and law", "Compulsory Government approval for every transfer", "GST clearance for every transfer", "B"],
  ["A company's Annual Return filed under Section 92 provides, among other things, details of its:", "GST invoices only", "Shareholding pattern, indebtedness, and management personnel as prescribed", "Only bank account numbers", "Only trademark applications", "B"],
  ["A listed company's small shareholders may, subject to conditions, requisition the election of a director representing their interests under:", "Section 149", "Section 151", "Section 173", "Section 92", "B"],
  ["Investments not held by a company in its own name (e.g., held in a nominee's name for specified reasons) must be entered in a register along with the reasons, under:", "Section 186", "Section 187", "Section 188", "Section 92", "B"],
  ["Layering restrictions under the Companies (Restriction on number of Layers) Rules generally limit a company from having more than a specified number of layers of:", "Directors", "Subsidiary companies (subject to prescribed exceptions)", "Auditors", "Bank accounts", "B"],
  ["Certain board resolutions relating to matters like borrowing or investing funds (Section 179(3)) are, per exemption notifications, not required to be filed with the ROC for:", "Public companies generally", "Private companies, subject to conditions in the exemption notification", "Listed companies", "Government companies only", "B"],
  ["A One Person Company cannot generally be incorporated or converted into by a person who is a:", "Adult Indian citizen resident in India", "Minor", "Chartered Accountant", "Company Secretary", "B"],
  ["A resolution approving a buy-back of shares by special resolution is also required to be filed with the ROC using form:", "CHG-1", "MGT-14", "ADT-1", "DIR-12", "B"],
  ["Section 185 restrictions on loans to directors generally provide certain exceptions, such as loans to a wholly owned subsidiary company or loans under a scheme approved for:", "Any unrelated third party freely", "Managing Director or Whole-time Director as part of the conditions of service", "Competitors", "Foreign governments", "B"],
  ["A company's Corporate Insolvency Resolution Process, once admitted by the Tribunal, requires the appointment of an Interim Resolution Professional to take over management from the:", "Registrar", "Board of Directors of the corporate debtor", "Auditor", "Shareholders directly", "B"],
  ["A resolution plan under the IBC must be approved by the Committee of Creditors with a voting share of not less than:", "51%", "66%", "75%", "90%", "B"],
  ["Under Section 29A of the IBC, certain persons such as wilful defaulters or promoters of the defaulting company (subject to conditions) are generally:", "Automatically eligible to submit a resolution plan", "Ineligible to submit a resolution plan", "Required to submit a resolution plan", "Exempted from all IBC provisions", "B"],
];

const EXPERT = [
  ["The provisions relating to Producer Companies were originally inserted through:", "A special Producer Companies Act", "Part IXA (now largely reflected in Chapter XXIA) of the Companies Act framework", "The LLP Act, 2008", "The Partnership Act, 1932", "B"],
  ["A Producer Company is primarily meant to be owned and managed by:", "Foreign investors", "Primary producers such as farmers or their collectives", "Banks and NBFCs", "The Central Government exclusively", "B"],
  ["A Nidhi Company is regulated under Section 406 of the Companies Act along with the:", "GST Rules", "Nidhi Rules", "SEBI (LODR) Regulations", "FEMA Regulations", "B"],
  ["A Nidhi Company primarily undertakes the business of lending and borrowing among its:", "General public without restriction", "Own members only", "Foreign subsidiaries", "Government departments", "B"],
  ["The National Company Law Tribunal (NCLT) derives its powers relating to insolvency primarily from the Companies Act and the:", "Income Tax Act", "Insolvency and Bankruptcy Code, 2016", "GST Act", "Trade Marks Act", "B"],
  ["Appeals against orders of the NCLT lie with the:", "Supreme Court directly", "National Company Law Appellate Tribunal (NCLAT)", "High Court directly in all cases", "Registrar of Companies", "B"],
  ["Further appeal against an order of the NCLAT, on a question of law, generally lies with the:", "High Court", "Supreme Court", "Regional Director", "Registrar", "B"],
  ["A scheme of Corporate Debt Restructuring outside formal insolvency proceedings may involve creditors agreeing to modify:", "GST rates applicable to the company", "The terms of the company's debt to improve its financial position", "The company's trademark portfolio", "The company's registered office alone", "B"],
  ["The concept of 'related party' under the Companies Act is broader than under accounting standards in some respects and includes, among others, a director, key managerial personnel and their:", "Unrelated business partners", "Relatives, as defined under the Act", "Competitors", "Auditors always", "B"],
  ["A 'promoter group' concept is more elaborately defined and used mainly in the context of:", "GST classification", "Securities regulations for public issues and takeovers", "Trademark classification", "Import licensing", "B"],
  ["The Takeover Code (SEBI SAST Regulations) becomes relevant when a person's shareholding/voting rights in a listed company crosses prescribed:", "GST turnover limits", "Threshold percentages, triggering an open offer obligation", "Trademark classes", "Import-export codes", "B"],
  ["A creeping acquisition limit under the Takeover Code allows an acquirer holding shares within a specified range to acquire additional shares up to a specified percentage per year without triggering a mandatory:", "Board resolution", "Open offer", "Annual return filing", "GST registration", "B"],
  ["Delisting of a company's shares from a stock exchange is governed primarily by SEBI's Delisting Regulations, in addition to provisions of the:", "GST Act", "Companies Act, where applicable (e.g., reduction of capital route)", "Income Tax Act only", "Trade Marks Act only", "B"],
  ["A Special Purpose Acquisition Company (SPAC) structure, though more common overseas, generally involves raising funds first and identifying a target business:", "Before any funds are raised", "After the funds are raised, for a subsequent merger/acquisition", "Only after winding up", "Only for Government companies", "B"],
  ["The concept of 'shadow director' or a person in accordance with whose directions the Board is accustomed to act may attract director-like liabilities under:", "GST law only", "The Companies Act's definition of 'officer who is in default', in certain contexts", "The Trade Marks Act only", "The Income Tax Act only", "B"],
  ["Corporate governance norms for listed entities are largely codified through SEBI's:", "Nidhi Rules", "Listing Obligations and Disclosure Requirements (LODR) Regulations", "Deposit Rules", "CSR Rules", "B"],
  ["The concept of a 'material subsidiary' under SEBI LODR is relevant mainly for enhanced:", "GST compliance", "Governance oversight and disclosure obligations of the listed holding company", "Trademark protection", "Import-export benefits", "B"],
  ["Whistle-blower/vigil mechanisms mandated for certain companies aim to allow directors and employees to report concerns about:", "Routine leave applications", "Unethical behaviour, fraud, or violation of the company's code of conduct", "Salary revisions only", "GST filings only", "B"],
  ["The Serious Fraud Investigation Office (SFIO) is empowered to investigate frauds relating to companies under a reference typically made by the:", "Trade Marks Registry", "Central Government", "State Police alone", "Income Tax Department alone", "B"],
  ["Once an investigation is assigned to the SFIO, other investigating agencies are generally required to:", "Continue investigating in parallel without restriction", "Transfer related documents/materials and not proceed further, as prescribed", "Ignore the SFIO's mandate", "Close the case permanently with no transfer", "B"],
  ["A company's registered valuer, empanelled under the Companies (Registered Valuers) Rules, may be required to value assets in matters such as:", "Routine bookkeeping only", "Mergers, corporate insolvency resolution, or squeeze-out of minority shareholders", "GST rate fixation", "Trademark examination", "B"],
  ["Squeeze-out of minority shareholders (majority shareholder acquiring minority stake) under the Companies Act typically follows a process involving:", "No valuation at all", "A registered valuer's report and specified procedural safeguards for minority shareholders", "Immediate forfeiture of minority shares without compensation", "GST clearance only", "B"],
  ["The doctrine of 'piercing the corporate veil' in group company structures is most often invoked by courts/tribunals in cases of:", "Genuine, legitimate group restructuring", "Fraud or improper use of the corporate structure to evade obligations", "Ordinary dividend distribution", "Routine related party transactions properly disclosed", "B"],
  ["A resolution plan approved by the Committee of Creditors under the IBC, once sanctioned by the Adjudicating Authority (NCLT), is generally binding on:", "Only the successful resolution applicant", "The corporate debtor, its employees, creditors, and other stakeholders as specified", "Only secured creditors", "Only the Government", "B"],
  ["The moratorium under Section 14 of the IBC, once a Corporate Insolvency Resolution Process is admitted, generally prohibits actions such as:", "Filing suits or continuing legal proceedings against the corporate debtor", "Continuing the day-to-day sales of the business", "Payment of statutory dues in all circumstances", "Board meetings of the corporate debtor entirely", "A"],
  ["Under the IBC's liquidation waterfall, insolvency resolution process costs and workmen's dues (for a specified period) generally rank:", "Last, after equity shareholders", "Very high in priority, ahead of most other unsecured claims", "Equal to Government dues always", "Irrelevant to distribution", "B"],
  ["A pre-packaged insolvency resolution process (introduced for MSMEs) is distinguished mainly by:", "Complete exclusion of the corporate debtor from the process", "A base resolution plan being arranged before formal admission, with a shorter timeline", "No involvement of creditors at all", "Automatic liquidation without resolution attempts", "B"],
  ["The Competition Commission of India's approval (if a 'combination' as defined) is generally required before completion of mergers/acquisitions exceeding prescribed:", "GST turnover slabs", "Asset/turnover thresholds specified under the Competition Act", "Trademark portfolio value", "Number of directors", "B"],
  ["A 'green channel' route under competition law allows automatic approval of combinations meeting specified criteria indicating:", "High likelihood of harming competition", "No overlap or minimal likelihood of an adverse effect on competition", "Mandatory government ownership", "Only foreign parties involved", "B"],
  ["The concept of 'independent director's liability' is generally more limited than that of executive directors and is typically restricted to matters that occurred with their:", "Knowledge, consent, connivance, or where they did not act diligently", "Any act of the company regardless of their role", "Only financial matters, never governance matters", "Only matters after their resignation", "A"],
  ["Voluntary liquidation of a solvent corporate person under Section 59 of the IBC is initiated by the corporate person itself, unlike a creditor-driven:", "Scheme of arrangement", "Corporate Insolvency Resolution Process (CIRP)", "Annual return filing", "Charge registration", "B"],
  ["The Insolvency and Bankruptcy Board of India (IBBI) primarily functions as the:", "Tax authority for insolvent companies", "Regulator for insolvency professionals, agencies, and the insolvency process", "Stock exchange regulator", "Company registrar", "B"],
  ["Insolvency Professional Agencies (IPAs) are responsible for the enrolment and oversight of:", "Registered valuers only", "Insolvency Professionals, under IBBI's regulatory framework", "Company Secretaries in Practice", "Statutory auditors", "B"],
  ["An Information Utility under the IBC framework primarily stores and provides access to:", "Trademark records", "Financial information that can serve as evidence of debt and default", "GST returns", "Company incorporation certificates", "B"],
  ["Preferential transactions that can be avoided/reversed under Section 43 of the IBC generally have a 'look back' period of about two years for related parties and about:", "Six months for unrelated parties", "One year for unrelated parties", "Five years for unrelated parties", "No look-back for unrelated parties", "B"],
  ["Undervalued transactions that can be examined and potentially avoided under the IBC are dealt with primarily under:", "Section 43", "Section 45", "Section 66", "Section 14", "B"],
  ["Fraudulent trading or wrongful trading by persons responsible for the conduct of business of the corporate debtor is dealt with under which IBC section?", "Section 43", "Section 45", "Section 66", "Section 12", "C"],
  ["A fast-track Corporate Insolvency Resolution Process under the IBC, applicable to specified categories such as small companies or startups, is generally intended to be completed within:", "30 days", "90 days", "180 days", "365 days", "B"],
  ["The concept of cross-border insolvency, allowing cooperation between courts/authorities of different countries, has been discussed for adoption in India based on the:", "Paris Convention", "UNCITRAL Model Law on Cross-Border Insolvency", "Madrid Protocol", "Berne Convention", "B"],
  ["Insolvency provisions extending to personal guarantors of corporate debtors are dealt with under a distinct part of the IBC, generally referred to as:", "Part I", "Part III", "Part IV only for companies", "Part V for cross-border matters", "B"],
  ["A 'no adverse observation' report or similar confirmation from stock exchanges is generally relevant before NCLT approves a scheme of arrangement involving a:", "Private unlisted company only", "Listed company", "One Person Company only", "Section 8 company only", "B"],
  ["A scheme of arrangement that involves a reduction of share capital, in addition to member/creditor approval, generally requires sanction from the:", "Registrar alone", "Tribunal (NCLT)", "Trade Marks Registry", "Income Tax Department", "B"],
  ["Group insolvency (insolvency proceedings of multiple companies within the same corporate group) is an evolving area where courts have, in practice, allowed:", "Complete disregard of each company's separate legal status", "Procedural coordination/consolidation of proceedings in appropriate cases, while respecting separate legal entities", "Automatic merger of all group companies", "No coordination under any circumstances", "B"],
  ["The concept of 'deemed director' or 'de facto director' may apply to a person who, without formal appointment, effectively:", "Has no involvement in company affairs", "Acts as and carries out the functions of a director", "Is only a shareholder", "Is only an auditor", "B"],
  ["Corporate governance failures involving related party transactions and diversion of funds are typically examined by regulators/investigators with reference to related sections of the Companies Act and, where listed, the:", "GST Act", "SEBI Act and LODR Regulations", "Trade Marks Act", "Consumer Protection Act", "B"],
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
  console.log('ROC BATCH 2 (new questions):', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`ROC area not found for org ${ORG_ID}.`);
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
    console.log(`Inserted ${inserted} NEW ROC questions (existing 150 untouched).`);
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
