require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// GST question bank — BATCH 2 (top-up). Additive: adds new, distinct MCQs to
// reach 80/80/80/80 per level (from 40/40/35/35). Does NOT delete existing
// GST questions. Format: [q, A, B, C, D, correct].
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'gst';

const INTERN = [
  ["GST is described as a 'concurrent' tax because it is levied by:", "Only the Central Government", "Both the Central and State Governments simultaneously on the same supply", "Only local municipalities", "Only the GST Council", "B"],
  ["CBIC stands for:", "Central Board of Indirect Taxes and Customs", "Central Bureau of Income and Customs", "Central Board of Import Control", "Central Bureau of Indirect Compliance", "A"],
  ["GSTN (Goods and Services Tax Network) mainly provides:", "Legal advisory services", "The shared IT infrastructure/portal backbone for GST compliance", "Banking services to taxpayers", "Auditing services", "B"],
  ["'Aggregate turnover', used for the registration threshold, is generally computed:", "State-wise separately with no PAN-level aggregation", "On a PAN-India basis for a person having the same PAN", "Only for exports", "Only for the current month", "B"],
  ["A 'taxable person' under GST is broadly a person who is registered or:", "Never liable to be registered", "Liable to be registered under the Act", "Only a company", "Only an individual", "B"],
  ["The word 'supply' under GST broadly includes sale, transfer, barter, exchange and:", "Only cash transactions", "Lease, licence, rental or disposal made for a consideration in the course of business", "Only exports", "Only imports", "B"],
  ["A tax invoice under GST must generally mention the supplier's GSTIN, invoice number, date, and:", "The recipient's bank passbook details", "A description of goods/services, taxable value, rate and amount of tax", "The recipient's Aadhaar number", "The transporter's licence number", "B"],
  ["For a supply of goods, the tax invoice is generally required to be issued:", "Within 6 months of supply", "Before or at the time of removal/delivery of goods", "Only at the financial year end", "Only after payment is received", "B"],
  ["For a supply of services, the tax invoice is generally required to be issued within a prescribed period (commonly 30 days) of the:", "Date of registration", "Supply of the service", "Date of the GST Council meeting", "Date of the annual return", "B"],
  ["HSN code digit requirements on invoices are generally linked to the supplier's:", "State of registration", "Aggregate turnover in the preceding financial year", "Number of employees", "Number of GSTINs held", "B"],
  ["Certain special category states have historically had a lower GST registration threshold limit, mainly the states in the:", "Southern region", "North-Eastern region and a few hill states", "Western coastal region", "Central plains", "B"],
  ["A supply of goods/services from an unregistered supplier of specified notified categories to a registered person may attract GST under:", "The composition scheme", "Reverse charge mechanism under Section 9(4) as notified", "Zero-rated supply provisions", "Advance ruling provisions", "B"],
  ["Exports of goods/services can generally be made either on payment of IGST (with refund) or without payment of IGST under a:", "Bill of supply", "Letter of Undertaking (LUT)", "Debit note", "E-way bill only", "B"],
  ["A Letter of Undertaking (LUT) under GST allows an exporter to supply goods/services for export:", "Only after paying IGST first", "Without payment of IGST, subject to conditions", "Only through a composition scheme", "Only with prior AAR approval", "B"],
  ["GST on the import of goods into India is generally levied as:", "CGST plus SGST", "IGST, in addition to applicable customs duty", "Only customs duty, with no GST", "Only cess, with no other tax", "B"],
  ["GST on the import of services is generally payable by the recipient under the:", "Forward charge by the foreign supplier", "Reverse charge mechanism", "Composition scheme", "Advance ruling mechanism", "B"],
  ["A dynamic QR code on an invoice is generally required for large business-to-consumer (B2C) invoices to facilitate:", "GST registration", "Digital/UPI payment by the customer", "E-way bill cancellation", "Refund processing", "B"],
  ["A GST Suvidha Provider (GSP) is generally an entity that helps taxpayers with:", "Physical inspection of factories", "Technology-based access and integration with the GST portal", "Court litigation", "Bank loan approvals", "B"],
  ["An e-way bill, once generated, can generally be cancelled by the generator within a specified short window, commonly:", "24 hours, if the goods have not been verified in transit", "30 days without any restriction", "6 months", "It can never be cancelled", "A"],
  ["Part B of an e-way bill typically captures:", "The buyer's GSTIN only", "Vehicle/transport details for the movement of goods", "The invoice's tax rate only", "The supplier's bank details", "B"],
  ["GST payments made online/offline through banks are generally supported by a challan in form:", "GSTR-1", "PMT-06", "REG-01", "RFD-01", "B"],
  ["The Electronic Liability Register on the GST portal reflects a taxpayer's:", "Stock valuation", "Total tax, interest, and penalty liability", "Trademark applications", "Bank loan sanctioned amount", "B"],
  ["A composition dealer who wants to opt out of the scheme and move to regular GST is required to file form:", "CMP-02", "CMP-04", "REG-01", "GSTR-9", "B"],
  ["A notice issued to a non-filer of GST returns to prompt them to file is generally issued in form:", "GSTR-3A", "GSTR-9", "REG-01", "RFD-01", "A"],
  ["An application for new GST registration is generally filed in form:", "REG-01", "REG-06", "REG-16", "REG-19", "A"],
  ["Once approved, the GST registration certificate is generally issued in form:", "REG-01", "REG-06", "REG-14", "REG-21", "B"],
  ["An application by a taxpayer for cancellation of GST registration is generally filed in form:", "REG-16", "REG-19", "REG-06", "REG-01", "A"],
  ["Cancellation of a taxpayer's GST registration by the proper officer (suo-motu) is generally communicated in form:", "REG-16", "REG-19", "REG-01", "REG-06", "B"],
  ["Transferring an amount between different heads (e.g. CGST to SGST) within the electronic cash ledger can generally be done using form:", "PMT-06", "PMT-09", "REG-14", "RFD-01", "B"],
  ["E-invoicing under GST generally does NOT apply to typical:", "Large B2B tax invoices above the notified turnover threshold", "Business-to-consumer (B2C) invoices", "Credit notes for B2B supplies", "Debit notes for B2B supplies", "B"],
  ["GSTR-2A is best described as a:", "Return filed by the recipient", "Dynamically auto-populated statement reflecting suppliers' GSTR-1 filings", "Return for composition dealers", "Refund application form", "B"],
  ["A registered person amending the core fields of their registration (e.g. principal place of business) generally files form:", "REG-01", "REG-14", "REG-06", "CMP-02", "B"],
  ["An unregistered person who is otherwise liable to register but fails to do so may be registered suo-motu by the proper officer under:", "Section 22", "Section 25(8)", "Section 49", "Section 51", "B"],
  ["The value of inward supplies on which a recipient pays tax under reverse charge is generally __ from the supplier's aggregate turnover computation:", "Included", "Excluded, as it pertains to the recipient's liability, not the supplier's outward turnover in that context", "Doubled", "Irrelevant to any turnover computation", "B"],
  ["Composition scheme dealers are generally restricted from making supplies through an:", "Physical retail store", "E-commerce operator required to collect TCS", "Local wholesale market", "Direct sale to a known customer", "B"],
  ["The GST rate applicable specifically to gold and certain precious metal jewellery is generally a special concessional rate of:", "0.25%", "3%", "12%", "18%", "B"],
  ["GST Compensation Cess is generally levied, over and above GST, on notified goods such as:", "Essential food grains", "Luxury cars, tobacco, and aerated drinks", "Books and stationery", "Basic medicines", "B"],
  ["A GSTIN is considered PAN-based, meaning a taxable person is generally required to obtain a separate GSTIN for:", "Every invoice issued", "Every State/Union Territory from which they make taxable supplies", "Every customer served", "Every bank account held", "B"],
  ["An E-Way Bill is not the same as a tax invoice; rather, it is a document generated mainly to track the:", "Value of the company's shares", "Physical movement of goods above the prescribed value", "Company's annual return", "GST registration status only", "B"],
  ["The GST portal allows taxpayers to check the validity/status of another party's GSTIN (active, cancelled, suspended) mainly to support:", "Filing income tax returns", "Due diligence before dealing with a supplier/customer", "Filing trademark applications", "Company incorporation", "B"],
];

const EXECUTIVE = [
  ["Under the QRMP scheme, taxpayers can use the Invoice Furnishing Facility (IFF) to upload B2B invoices for the:", "Entire quarter at once only", "First two months of the quarter, on an optional basis", "Last month of the quarter only", "Previous financial year", "B"],
  ["The aggregate turnover threshold (in the preceding financial year) up to which a taxpayer may opt for the QRMP scheme is generally:", "50 lakh", "1.5 crore", "5 crore", "10 crore", "C"],
  ["GSTR-3B due dates are generally staggered across different states/UTs, commonly falling on the 20th, 22nd or:", "23rd", "24th", "26th", "28th", "B"],
  ["A composition scheme specifically designed for suppliers of services (with a turnover cap and a fixed tax rate) generally applies a rate of about:", "1%", "5%", "6%", "12%", "C"],
  ["Provisional attachment of a taxable person's property to protect government revenue during proceedings is provided under:", "Section 73", "Section 83", "Section 122", "Section 132", "B"],
  ["A delivery challan (instead of a tax invoice) is generally used for movement of goods that does not amount to a supply, such as sending goods for:", "Direct retail sale", "Job work", "Export with payment of IGST", "B2C online sale", "B"],
  ["Anti-profiteering provisions under GST are primarily intended to ensure that the benefit of a tax rate reduction or additional ITC is passed on to the:", "Government", "Consumer, through a commensurate reduction in prices", "Supplier's shareholders", "GST Council members", "B"],
  ["Anti-profiteering measures under GST are governed mainly by:", "Section 49", "Section 171", "Section 51", "Section 52", "B"],
  ["An application seeking an Advance Ruling on a GST matter is generally filed in form:", "ARA-01", "REG-01", "RFD-01", "GSTR-9", "A"],
  ["An Advance Ruling given by the Authority for Advance Ruling is generally binding only on:", "All taxpayers across India", "The applicant and the concerned jurisdictional officer, for that specific matter", "The GST Council alone", "No one, being merely advisory", "B"],
  ["A GST refund application is generally filed by the taxpayer in form:", "RFD-01", "ARA-01", "REG-01", "GSTR-9", "A"],
  ["For zero-rated supplies (like exports), a provisional refund of a significant portion (commonly around 90%) is generally granted within about:", "24 hours", "7 days", "60 days", "1 year", "B"],
  ["A refund of unutilised input tax credit is commonly available in the case of an 'inverted duty structure', where the tax rate on inputs is:", "Lower than the tax rate on output supplies", "Higher than the tax rate on output supplies", "Exactly equal to the output rate", "Not applicable at all", "B"],
  ["An e-way bill is generally not required for the movement of certain specifically exempted goods or below the prescribed:", "GST rate slab", "Threshold consignment value", "Number of invoices", "Number of vehicles", "B"],
  ["The mandatory turnover threshold for e-invoicing has, over successive notifications, generally been:", "Raised progressively to cover fewer taxpayers", "Lowered progressively to cover more taxpayers", "Kept permanently fixed since 2017", "Abolished entirely", "B"],
  ["A credit note or debit note issued under GST is generally required to reference the:", "GST Council's meeting minutes", "Original tax invoice to which it relates", "Company's annual return", "Bank reconciliation statement", "B"],
  ["The late fee for delayed filing of the GST annual return is generally capped based on the taxpayer's:", "Number of employees", "Turnover slab", "State of registration only", "Number of invoices raised", "B"],
  ["A Nil GSTR-1 or Nil GSTR-3B can generally be filed by a taxpayer through:", "Physical visit to the GST office only", "SMS, in addition to the online portal", "Postal application only", "No method at all", "B"],
  ["In an e-way bill, Part A is generally furnished by the consignor/supplier, while Part B (vehicle details) is generally furnished by the:", "Consignee only", "Transporter (or the person generating the e-way bill for transport)", "Bank", "GST officer", "B"],
  ["A 'consolidated e-way bill' allows a transporter carrying multiple consignments in one vehicle to generate:", "A separate e-way bill for each consignment only, with no consolidation", "One consolidated document referencing the individual e-way bills", "No e-way bill at all", "Only a tax invoice", "B"],
  ["A business entity can generally obtain multiple GST registrations within the same state for:", "No reason under any circumstances", "Different business verticals, on an optional basis subject to conditions", "Every single invoice separately", "Every employee separately", "B"],
  ["An Input Service Distributor (ISD) distributes eligible input tax credit to its units using a specific document called an:", "Ordinary tax invoice", "ISD invoice", "Debit note only", "E-way bill", "B"],
  ["An e-commerce operator may be required to collect TCS on supplies made through its platform even where the underlying supplier's turnover is below the normal registration threshold, because:", "TCS provisions completely exempt small suppliers always", "Suppliers making taxable supplies through an e-commerce operator are generally required to register regardless of the threshold (subject to specified exceptions)", "TCS is optional for e-commerce operators", "GST does not apply to online sales", "B"],
  ["Activities a GST Practitioner can generally undertake on behalf of a taxpayer include filing returns and:", "Signing the taxpayer's income tax return", "Filing refund applications and furnishing details, subject to authorisation", "Issuing court judgments", "Approving bank loans", "B"],
  ["A Casual Taxable Person is generally required, at the time of registration, to make an advance deposit of tax equivalent to their:", "Last year's income tax paid", "Estimated tax liability for the period of registration", "Total share capital", "GST rate applicable to competitors", "B"],
  ["A Non-Resident Taxable Person is also generally required to make an advance tax deposit at the time of:", "Filing the annual return", "Registration", "Filing the first GSTR-3B", "Cancellation of registration", "B"],
  ["A 'Bill To Ship To' transaction under GST involves a scenario where the invoice is raised to one party while goods are physically delivered to:", "The same billed party always", "A different party (a third location) as directed", "The transporter permanently", "The GST Department", "B"],
  ["Amendments to previously reported B2B invoice details in GSTR-1 are generally permitted in a subsequent month's/quarter's return, up to a prescribed cut-off, mainly to:", "Prevent any correction ever", "Allow correction of genuine errors within a reasonable window", "Increase tax liability arbitrarily", "Avoid the need for GSTR-3B", "B"],
  ["GST payments can generally be made online (net banking, card, UPI) or through an over-the-counter/NEFT-RTGS mode using a challan generated on the:", "Income tax portal", "GST portal", "MCA portal", "Trademark portal", "B"],
  ["Job work under GST refers to any treatment or process undertaken by a person on goods belonging to:", "Himself only", "Another registered person", "The Government only", "No one in particular", "B"],
  ["Goods sent for job work can generally be moved without payment of tax, subject to the principal manufacturer bringing them back or supplying them further within a prescribed:", "Time limit", "GST rate change", "Bank guarantee cancellation", "Trademark renewal", "A"],
  ["A composition taxpayer is generally required to mention on their invoices/bill of supply that they are a:", "Regular taxpayer eligible for full ITC", "Composition taxable person, not eligible to collect tax on supplies", "Non-resident taxable person", "GST practitioner", "B"],
  ["The requirement to maintain books of account and records under GST generally applies at the:", "National level only, in one central location", "Principal place of business (and additional places, as applicable)", "Auditor's office only", "Bank branch only", "B"],
  ["Records under GST are generally required to be preserved for a minimum period of:", "3 years from the due date of the annual return", "72 months (6 years) from the due date of furnishing the annual return", "10 years unconditionally", "Indefinitely with no limit", "B"],
  ["A 'reverse charge' liability, once discharged by the recipient, generally allows the recipient to claim input tax credit of that tax, subject to:", "No conditions at all", "Normal ITC eligibility conditions being satisfied", "A special exemption available only to exporters", "GST Council's individual approval each time", "B"],
  ["The e-invoicing system generates a unique Invoice Reference Number (IRN) which is used, among other things, to prevent:", "Late payment of GST", "Duplicate reporting/circulation of the same invoice", "Late filing of returns", "Loss of stock", "B"],
  ["A supplier's GSTR-1 filing status directly affects the recipient's ability to claim ITC because ITC eligibility is closely linked to invoice details reflecting in the recipient's:", "Bank statement", "GSTR-2B", "Trademark register", "Income tax return", "B"],
  ["Interest is levied on a taxpayer's net GST liability discharged in cash after the due date, at rates prescribed under GST law, primarily to:", "Encourage early payment/discourage delay", "Increase government revenue arbitrarily without reason", "Penalise honest, timely taxpayers", "Reward late filers", "A"],
  ["A composition dealer's compliance is generally simpler, requiring a quarterly statement of tax payment and an:", "Monthly GSTR-1", "Annual return in form GSTR-4", "Annual e-way bill filing", "Weekly GST payment", "B"],
  ["A GST practitioner, once enrolled, can generally be authorised by multiple taxpayers to act on their behalf, subject to each taxpayer:", "Never being able to withdraw the authorisation", "Granting/withdrawing the authorisation as needed through the portal", "Obtaining Central Government approval for each authorisation", "Paying an annual fee to the practitioner's association", "B"],
];

const INTERMEDIATE = [
  ["The conditions for availing Input Tax Credit under Section 16(2) include possession of a valid tax invoice, receipt of goods/services, and:", "The recipient's turnover exceeding a threshold", "Actual payment of tax by the supplier to the government and furnishing of the return", "The recipient being a composition dealer", "The recipient holding a trademark", "B"],
  ["Under Section 16(2)(aa), a recipient's ITC is available only if the supplier has furnished the relevant invoice details and it is reflected in the recipient's:", "Income tax return", "GSTR-2B", "Trademark certificate", "Board resolution", "B"],
  ["Common credit relating to inputs and input services used partly for taxable and partly for exempt supplies is apportioned under:", "Rule 42", "Rule 43", "Rule 36", "Rule 28", "A"],
  ["Common credit relating to capital goods used partly for taxable and partly for exempt supplies is apportioned under:", "Rule 42", "Rule 43", "Rule 36", "Rule 46", "B"],
  ["Blocked credits under Section 17(5) generally include works contract services for construction of an immovable property, except when used for further supply of:", "Any unrelated goods", "Works contract services (back-to-back)", "Exempt services only", "Composition supplies only", "B"],
  ["Blocked credit on motor vehicles for transportation of persons is generally allowed as an exception when used for further supply of such vehicles, transportation of passengers, or:", "Personal use of the proprietor", "Imparting training on driving such vehicles", "Gifting to employees", "Export without LUT", "B"],
  ["ITC attributable to goods/services used partly for business and partly for non-business purposes is apportioned under:", "Section 17(1)", "Section 17(2)", "Section 17(5)", "Section 16(4)", "A"],
  ["ITC attributable to taxable supplies (including zero-rated) versus exempt supplies is apportioned under:", "Section 17(1)", "Section 17(2)", "Section 9", "Section 22", "B"],
  ["The place of supply of services, as a general default rule for domestic (non-cross-border) supplies, is typically the location of the:", "Supplier always", "Recipient of the service", "GST Council office", "Transporter", "B"],
  ["The place of supply of services directly related to an immovable property is generally the:", "Location of the supplier's head office", "Location where the immovable property is situated", "Location of the recipient always, regardless of the property", "Location of the bank", "B"],
  ["The place of supply of goods, where movement is involved, is generally the location where the movement of goods:", "Begins", "Terminates for delivery to the recipient", "Is planned but not yet started", "Is recorded in the invoice only", "B"],
  ["The time of supply of services under reverse charge is generally the earliest of the date of payment or a specified number of days from the invoice date, commonly:", "15 days", "30 days", "61 days", "180 days", "C"],
  ["Valuation of a supply between 'related persons' (e.g., group companies) where price is not the sole consideration is generally determined using the:", "Market Rent methodology", "Open Market Value or other prescribed valuation rules", "Income Tax Act rules", "Companies Act valuation rules only", "B"],
  ["Deemed supply between distinct persons (e.g., inter-branch stock transfers of an entity with multiple GSTINs) generally requires:", "No GST at all since it's the same legal entity", "Valuation and payment of GST despite being the same PAN entity", "Only a delivery challan with no tax", "Filing of a separate income tax return", "B"],
  ["Certain notified services supplied through an e-commerce operator (e.g., cab aggregator or restaurant services via the platform) make the:", "Individual driver/restaurant liable to collect GST always", "E-commerce operator liable to pay GST as if it were the supplier, under Section 9(5)", "Customer liable to self-assess GST", "Transaction entirely GST-exempt", "B"],
  ["Valuation of second-hand (used) goods under GST is commonly done using a:", "Full transaction value with no adjustment", "Margin scheme, taxing only the margin between purchase and sale price (subject to conditions)", "Zero-rated mechanism", "Composition scheme mandatorily", "B"],
  ["A first appeal against an order of the GST adjudicating authority generally requires a mandatory pre-deposit, commonly around:", "100% of the disputed tax amount", "10% of the disputed tax amount (subject to conditions)", "50% of the disputed tax amount", "No pre-deposit at all", "B"],
  ["A first appeal against a GST adjudication order is generally filed before the:", "Appellate Authority under Section 107", "GST Council directly", "Supreme Court", "Advance Ruling Authority", "A"],
  ["A further appeal against an order of the Appellate Authority generally lies with the:", "High Court directly in every case", "GST Appellate Tribunal (GSTAT)", "Advance Ruling Authority", "State legislature", "B"],
  ["Certain sectors such as banking, insurance, and passenger transport services are generally exempted from the e-invoicing mandate regardless of:", "Their registration status", "Their turnover, due to sector-specific relaxations", "Their state of registration", "Their GSTIN format", "B"],
  ["A composition taxpayer is generally restricted from effecting inter-state outward supplies and from supplying through an:", "Physical showroom", "E-commerce operator required to collect TCS", "Direct wholesale buyer", "Government department", "B"],
  ["Suo-motu registration of a person by the proper officer, where they were liable to register but failed to do so, is provided under:", "Section 22", "Section 25(8)", "Section 9", "Section 49", "B"],
  ["Amendment of 'core fields' of a GST registration (such as the principal place of business) is generally processed by the proper officer following an application in form:", "REG-01", "REG-14", "REG-16", "REG-19", "B"],
  ["The value of inward supplies taxed under reverse charge is generally treated, for computing the recipient's own 'aggregate turnover', in a manner that:", "Always increases the recipient's turnover for registration purposes as an outward supply", "Is distinguished from outward taxable turnover of the recipient, since RCM relates to the recipient's tax payment obligation on purchases, not their own outward supply turnover", "Has no relevance to GST at all", "Only matters for TCS purposes", "B"],
  ["Liquidated damages or cancellation charges recovered by a party for a breach of contract are, under GST, often examined as a supply under the 'agreeing to tolerate an act' entry of:", "Schedule I", "Schedule II", "Schedule III", "Schedule IV", "B"],
  ["Under Schedule III, certain activities such as services by an employee to the employer in the course of employment are treated as:", "Taxable supplies of services", "Neither a supply of goods nor a supply of services", "Exempt supplies requiring an exemption certificate", "Zero-rated supplies", "B"],
  ["Actionable claims are generally outside the scope of 'goods' for GST purposes, except for specifically notified categories such as:", "Books and stationery", "Lottery, betting, and gambling", "Agricultural produce", "Handicrafts", "B"],
  ["A mixed supply, as distinguished from a composite supply, typically involves two or more independent items supplied together for a single price where the items are:", "Naturally bundled and supplied in conjunction with each other", "Not naturally linked, but bundled together only for a combined price (e.g. a gift hamper)", "Always taxed at the lowest rate among them", "Never taxable under GST", "B"],
  ["A works contract, under GST, is deemed to be a supply of:", "Goods only", "Services, as per Schedule II", "Neither goods nor services", "Exempt supply always", "B"],
  ["The composition scheme, if opted for, generally applies uniformly to all GST registrations obtained under the same PAN, meaning a taxpayer cannot selectively opt in for:", "All registrations equally, which is required", "Some registrations while opting for the regular scheme in others under the same PAN", "Only their head office", "Only their largest branch", "B"],
  ["The concept of an 'inverted duty structure' commonly arises in industries where the tax rate on:", "Output supplies is higher than on inputs", "Inputs is higher than on output supplies, leading to accumulated ITC", "Inputs and outputs is always identical", "GST is not applicable at all", "B"],
  ["A refund arising from an inverted duty structure is generally restricted to unutilised ITC on inputs, and is generally not available in respect of unutilised ITC on:", "Input services in most cases, subject to the prescribed formula", "Inputs consumed in taxable supply", "Zero-rated exports", "Deemed exports", "A"],
  ["A GST demand notice issued for reasons other than fraud or wilful misstatement is generally raised under:", "Section 73", "Section 74", "Section 122", "Section 132", "A"],
  ["A GST demand notice issued specifically for reasons involving fraud, wilful misstatement, or suppression of facts is generally raised under:", "Section 73", "Section 74", "Section 129", "Section 130", "B"],
  ["A Unique Identity Number (UIN) under GST is generally allotted to specified persons such as:", "Regular taxpayers with high turnover", "UN bodies, embassies, and other notified persons/organisations for specified purposes", "Composition dealers", "E-commerce operators", "B"],
  ["An 'e-invoice' is essentially a standard invoice that has been additionally reported to and validated by the:", "Income tax portal", "Invoice Registration Portal (IRP), generating a unique IRN", "Trademark Registry", "Ministry of Corporate Affairs portal", "B"],
  ["Where a supplier fails to file GST returns for a specified consecutive number of tax periods, they may face restrictions such as being blocked from generating an:", "Income tax return", "E-way bill", "Trademark application", "PAN card", "B"],
  ["A registered person's GSTIN can be placed under 'suspension' pending cancellation proceedings, during which they are generally:", "Free to carry on business as usual", "Restricted from making a taxable supply or issuing a tax invoice, as prescribed", "Automatically deregistered permanently", "Required to pay double tax", "B"],
  ["Risk-based physical verification of business premises before granting GST registration is generally applied in cases identified as:", "Low-risk applicants only", "High-risk applicants, based on data analytics/risk parameters", "All applicants without exception", "No applicants at all", "B"],
  ["Aadhaar authentication as part of the GST registration process is generally intended to:", "Replace PAN entirely for tax purposes", "Facilitate a faster, more streamlined registration approval process", "Eliminate the need for any registration", "Apply only to composition dealers", "B"],
  ["Amendments to non-core fields of a GST registration (such as details not requiring departmental approval) are generally:", "Never permitted", "Auto-approved/updated without requiring officer approval, as prescribed", "Approved only by the GST Council directly", "Approved only after a physical inspection every time", "B"],
  ["A composite supply comprising a principal supply and a naturally bundled ancillary supply is taxed entirely at the rate applicable to the:", "Ancillary supply", "Principal supply", "Lowest-rated item among them", "Highest-rated item among them regardless of which is principal", "B"],
  ["Where goods are supplied along with an incidental service that is naturally bundled in the ordinary course of business (e.g., transportation as part of a sale), the transaction is generally treated as a:", "Mixed supply, taxed at the highest rate", "Composite supply, taxed at the rate of the principal supply", "Two entirely separate contracts always", "Exempt supply automatically", "B"],
  ["The GST law empowers the Government to exempt specified goods/services from tax wholly or partly, generally through a:", "Board resolution of the supplier", "Notification issued based on GST Council recommendations", "Order of a civil court", "Circular issued by a bank", "B"],
  ["A 'deemed export' under GST refers to specified supplies of goods that are notified as such, even though the goods do not leave India, mainly to extend benefits similar to:", "Regular domestic supplies with no special treatment", "Exports, such as refund of tax paid, subject to conditions", "Composition scheme supplies", "Exempt supplies with no ITC benefit", "B"],
];

const EXPERT = [
  ["The GST Appellate Tribunal (GSTAT) is generally structured with a Principal Bench and various:", "Regional offices of the Income Tax Department", "State/area benches, as constituted under the law", "Branches of the RBI", "SEBI regional offices", "B"],
  ["The National Anti-profiteering Authority's (NAA) functions under GST were, over time, proposed to be handled by the:", "Reserve Bank of India", "Competition Commission of India (CCI)", "Ministry of Corporate Affairs directly", "State GST Departments individually", "B"],
  ["When an e-invoice is generated with transport details filled in, the system can often auto-generate a corresponding:", "Income tax return", "E-way bill, reducing duplicate data entry", "Trademark application", "Company incorporation certificate", "B"],
  ["General penalty provisions for various GST offences (where no specific penalty is prescribed) are covered under:", "Section 122", "Section 132", "Section 83", "Section 171", "A"],
  ["Prosecution and arrest provisions for certain serious GST offences (typically involving large-value tax evasion) are dealt with under:", "Section 122", "Section 132", "Section 73", "Section 49", "B"],
  ["A provisional attachment of property under Section 83, to protect government revenue, is generally valid for a period of about:", "30 days only", "One year from the date of the order, unless extended or released earlier", "10 years", "It never expires", "B"],
  ["GST Compensation Cess was originally introduced mainly to compensate States for revenue loss during the initial transition period of:", "1 year", "5 years (with subsequent extensions as notified)", "20 years", "It was never time-bound", "B"],
  ["'Nil-rated', 'exempt', and 'zero-rated' supplies under GST differ mainly in that zero-rated supplies (like exports) generally allow the supplier to:", "Never claim any ITC at all", "Claim/refund ITC on inputs, unlike typical exempt supplies", "Charge the standard 18% rate", "Register only as a composition dealer", "B"],
  ["Reverse charge on the import of services applies regardless of the recipient's registration status when the service is:", "Used for personal, non-business purposes only, which is exempt", "Received for business purposes, making the recipient liable under IGST Act provisions", "Provided free of cost always, with no GST implication", "Provided only by a registered Indian supplier", "B"],
  ["The GST treatment of liquidated damages has been a subject of clarification, generally requiring a case-by-case examination of whether the payment is genuinely for:", "A supply of goods", "Tolerating an act/breach (a service) versus merely being a pure compensatory payment for a wrong", "GST registration purposes only", "TDS deduction purposes only", "B"],
  ["Under Section 9(5), GST on notified services supplied through an e-commerce operator (such as cab aggregation) is payable by the:", "Individual service provider (e.g. driver) directly, always", "E-commerce operator itself, as if it were the supplier", "Customer, under reverse charge", "GST Council", "B"],
  ["A 'Know Your Supplier' initiative on the GST portal is generally intended to help businesses:", "File their own GST returns faster", "Verify basic registration details of their counterparties for informed dealings", "Avoid filing any GST returns", "Bypass e-way bill requirements", "B"],
  ["The GST Council's decisions are generally guided by a weighted voting mechanism where, as provided under Article 279A, the Centre and States together determine outcomes with the Centre having a defined:", "100% vote share", "One-third weightage, with States collectively holding the remaining weightage", "No vote at all", "Veto power over every State", "B"],
  ["The Constitution (101st Amendment) Act, 2016, in addition to enabling GST, inserted Article 246A, empowering:", "Only Parliament to legislate on GST", "Both Parliament and State Legislatures to make laws relating to GST", "Only the President to notify GST rates", "Only the judiciary to frame GST rules", "B"],
  ["The IGST Act primarily governs the levy of tax on:", "Only intra-state supplies", "Inter-state supplies and imports into India", "Only exports", "Only exempt supplies", "B"],
  ["The UTGST Act applies GST provisions to supplies made within:", "Any State having its own legislature", "Union Territories without a legislature (in place of SGST)", "Foreign countries with a trade agreement", "Only Special Economic Zones", "B"],
  ["Registration as an Input Service Distributor is generally mandatory for an entity intending to distribute common input tax credit, irrespective of a specific:", "PAN requirement", "Turnover threshold applicable to ISDs", "State of incorporation", "Number of directors", "B"],
  ["Reverse charge on security services (other than by a body corporate) supplied to a registered person is generally applicable under a notification issued pursuant to:", "Section 9(3)", "Section 49", "Section 22", "Section 171", "A"],
  ["Standalone restaurant services (outside specified hotel premises) have generally been taxed at a concessional GST rate without the benefit of:", "Any tax at all", "Input tax credit", "Composition scheme eligibility", "GST registration requirement", "B"],
  ["Hotel accommodation services under GST are generally taxed based on slabs linked to the:", "Number of rooms only", "Value of supply/declared tariff of the unit of accommodation", "State of incorporation of the hotel company", "Number of GST officers assigned", "B"],
  ["Transitional credit provisions (such as under erstwhile TRAN forms) were introduced primarily to allow taxpayers to:", "Permanently avoid GST registration", "Carry forward eligible credits accumulated under the pre-GST tax regime into the GST framework", "Claim double credit under both regimes indefinitely", "Avoid filing GST returns altogether", "B"],
  ["Under GST, a compliance rating concept (envisaged under the law) was intended to help businesses assess a counterparty's:", "Product quality", "Track record of GST compliance", "Credit score with banks", "Trademark portfolio strength", "B"],
  ["Where GST returns remain unfiled for a specified consecutive period, the system may restrict the taxpayer's ability to generate an e-way bill, primarily as an:", "Incentive for compliance", "Anti-evasion / compliance enforcement measure", "Unrelated technical glitch", "Reward mechanism", "B"],
  ["Blocked credit under Section 17(5) on works contract services generally allows an exception where the recipient uses it for further supply of:", "Any unrelated exempt goods", "Works contract services (i.e., a back-to-back sub-contracting scenario)", "Personal consumption by the proprietor", "Free gifts to customers", "B"],
  ["A registered person availing ITC based on invoice details not yet reflected in their GSTR-2B risks:", "Automatic and permanent loss of the credit with no recourse", "Potential denial/reversal of that credit until conditions under Section 16(2)(aa) are satisfied", "No consequence whatsoever", "A mandatory GST registration cancellation", "B"],
  ["Given the interlinking of GSTR-1, GSTR-2B, and GSTR-3B, a mismatch between a supplier's reported outward supplies and a recipient's claimed ITC is a common trigger for:", "Automatic refund to the recipient", "Departmental scrutiny/notice seeking reconciliation or reversal", "Cancellation of the recipient's PAN", "Automatic waiver of tax", "B"],
  ["The GST Council's constitutional mandate under Article 279A includes recommending matters such as taxes to be subsumed, exemptions, and:", "Only income tax slab rates", "GST rates, threshold limits, and special provisions for certain states", "Only customs duty rates", "Only company law amendments", "B"],
  ["A ruling of the Authority for Advance Ruling (AAR) that is unsatisfactory to the applicant can generally be appealed to the:", "Supreme Court directly", "Appellate Authority for Advance Ruling (AAAR)", "GST Council", "High Court only", "B"],
  ["Where AAAR members differ in opinion on an advance ruling matter, the ruling is often treated as if no advance ruling was given on that point, meaning the applicant may need to:", "Accept a default unfavourable ruling", "Approach the jurisdictional High Court or proceed without a binding ruling on that specific point, as guided by practice", "Automatically win the matter", "Pay double tax as a penalty", "B"],
  ["The concept of 'principal supply' in a composite supply refers to the supply that constitutes the:", "Least significant/ancillary element", "Predominant element, to which any other supply is ancillary", "Only the goods component, never a service", "Only the export component", "B"],
  ["An advance received for a future supply of goods, post certain relief notifications, is generally NOT taxed at the time of receipt for most goods, unlike:", "Composition dealers under a special exception", "Services, where the time of supply rules for advances still commonly apply", "Zero-rated exports", "Deemed exports", "B"],
  ["Cross-charge mechanisms under GST arise when a head office/branch performs common functions for other distinct-person branches, requiring a notional:", "Exemption on the entire cost", "Supply and valuation between the distinct persons under GST", "Waiver of ITC completely", "Refund from the government", "B"],
  ["An entity's 'distinct persons' concept under GST treats establishments in different states (even under one PAN/legal entity) as:", "The same taxable person always, requiring no cross-charge", "Separate persons for GST purposes, requiring valuation of inter-branch supplies", "Exempt from all GST provisions", "Automatically merged into one GSTIN", "B"],
  ["Valuation of related-party transactions and inter-branch supplies frequently relies on the concept of 'open market value' as defined under the:", "Companies Act", "GST Valuation Rules", "Income Tax Act", "Customs Act", "B"],
  ["A works contractor executing a contract for a Government entity is generally subject to standard GST provisions applicable to works contracts, following the withdrawal of many of the earlier:", "Compulsory registration exemptions for such contractors", "Concessional/lower GST rate notifications specific to government works contracts", "Requirements to file any return at all", "Requirements to maintain any records", "B"],
  ["The concept of 'aggregate turnover' explicitly excludes the value of inward supplies on which tax is payable under reverse charge, since it is meant to reflect a person's:", "Total purchases", "Own outward supplies and other specified turnover components, not RCM-taxed purchases", "Bank balance", "Net worth", "B"],
  ["A transaction structured to artificially split a single supply into multiple smaller supplies mainly to remain below the GST registration threshold may be viewed by authorities as:", "A legitimate tax planning strategy with no scrutiny", "An attempt to evade registration/tax, inviting scrutiny", "Automatically GST-exempt", "Required under GST law", "B"],
  ["The concept of 'circular trading' involving fake invoices to fraudulently pass on ITC without actual supply of goods/services is generally treated under GST law as a:", "Minor clerical error", "Serious offence potentially inviting penalty and prosecution", "Legitimate business practice", "Non-issue since ITC is self-assessed", "B"],
  ["The e-invoicing system's validation at the IRP (Invoice Registration Portal) is designed mainly to ensure the invoice data is standardised and to generate the:", "GSTIN of the recipient only", "Invoice Reference Number (IRN) and QR code for that invoice", "Company's PAN card", "Bank account number", "B"],
  ["A recurring mismatch between GSTR-1 (outward supply) and GSTR-3B (summary payment) filed by the same supplier may indicate:", "Perfect compliance always", "A potential short payment of tax requiring departmental follow-up", "An automatic refund entitlement", "No implication whatsoever", "B"],
  ["The 'e-way bill' system and 'e-invoicing' system are integrated so that generating an e-invoice can pre-fill relevant e-way bill fields, primarily to reduce:", "Government revenue", "Duplication of data entry and improve compliance efficiency", "The number of registered taxpayers", "GST rates applicable", "B"],
  ["A notice for scrutiny of returns under GST is typically issued when the department identifies discrepancies between a taxpayer's various filed returns (e.g., GSTR-1 vs GSTR-3B vs GSTR-2B-based ITC), which may lead to:", "Automatic cancellation of PAN", "A requirement for the taxpayer to explain or reconcile the discrepancy", "Immediate arrest without notice", "A mandatory refund", "B"],
  ["Under GST, 'zero-rated supply' status (allowing ITC refund) is generally available for supplies to a Special Economic Zone (SEZ) unit/developer in a manner similar to:", "Domestic taxable supplies with no special treatment", "Physical exports out of India", "Exempt supplies with no ITC benefit", "Composition scheme supplies", "B"],
  ["A supplier making a zero-rated supply to an SEZ unit, if not opting for the LUT route, may charge IGST and the recipient/supplier can then claim the corresponding:", "No refund at all", "Refund of the IGST paid, subject to conditions", "A permanent exemption certificate", "A reduction in company tax rate", "B"],
  ["The overall design connecting registration, invoicing (including e-invoicing), returns (GSTR-1/3B/2B), and payment aims to create an integrated compliance ecosystem intended to reduce tax evasion through improved:", "Manual, paper-based recordkeeping", "Data matching and traceability across the supply chain", "Discretionary assessments with no data support", "Elimination of all documentation requirements", "B"],
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
  console.log('GST BATCH 2 (new questions):', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`GST area not found for org ${ORG_ID}.`);
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
    console.log(`Inserted ${inserted} NEW GST questions (existing 150 untouched).`);
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
