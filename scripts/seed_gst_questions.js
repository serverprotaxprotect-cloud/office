require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// GST question bank — original MCQs authored from the CGST/IGST Acts and GST
// practice, answers verified. Format: [q, A, B, C, D, correct].
// Target org GB-001 (id 1), area "GST".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'gst';

const INTERN = [
  ["GST stands for:", "Goods and Sales Tax", "Goods and Services Tax", "General Sales Tax", "Government Service Tax", "B"],
  ["GST was implemented in India with effect from:", "1 April 2016", "1 July 2017", "1 January 2018", "1 April 2017", "B"],
  ["GST is a tax levied on the:", "Manufacture of goods", "Sale within a state only", "Supply of goods and services", "Import of goods only", "C"],
  ["On an intra-state (within the state) supply, the taxes levied are:", "IGST only", "CGST + SGST", "Only CGST", "Only SGST", "B"],
  ["On an inter-state (between states) supply, the tax levied is:", "CGST + SGST", "IGST", "SGST only", "No tax", "B"],
  ["CGST stands for:", "Central Goods and Services Tax", "Combined GST", "Corporate GST", "City GST", "A"],
  ["SGST stands for:", "Standard GST", "State Goods and Services Tax", "Special GST", "Sales GST", "B"],
  ["IGST stands for:", "Indian GST", "Integrated Goods and Services Tax", "Internal GST", "Interim GST", "B"],
  ["A GSTIN (GST Identification Number) has how many characters?", "10", "12", "15", "21", "C"],
  ["A GSTIN is based on which existing number of the taxpayer?", "Aadhaar", "PAN", "TAN", "Voter ID", "B"],
  ["The first two digits of a GSTIN represent the:", "PAN", "State code", "Entity number", "Check digit", "B"],
  ["ITC stands for:", "Input Tax Credit", "Indian Tax Code", "Integrated Tax Credit", "Internal Tax Charge", "A"],
  ["HSN code is used for the classification of:", "Services", "Goods", "Persons", "States", "B"],
  ["SAC (Services Accounting Code) is used for the classification of:", "Goods", "Services", "Assets", "Invoices", "B"],
  ["GST is a __________ based tax.", "Origin", "Destination (consumption)", "Production", "Import", "B"],
  ["The apex body that decides GST rates and policies is the:", "RBI", "GST Council", "SEBI", "CBDT", "B"],
  ["The GST Council is chaired by the:", "Prime Minister", "Union Finance Minister", "RBI Governor", "President", "B"],
  ["The return used to report outward supplies (sales) is:", "GSTR-3B", "GSTR-1", "GSTR-9", "GSTR-2A", "B"],
  ["The monthly summary return of GST is:", "GSTR-1", "GSTR-3B", "GSTR-9C", "GSTR-4", "B"],
  ["The annual return under GST is:", "GSTR-1", "GSTR-3B", "GSTR-9", "GSTR-7", "C"],
  ["GST in India is levied by:", "Only the Central Government", "Only State Governments", "Both Central and State Governments", "Local municipalities", "C"],
  ["Which of the following is NOT a component of GST?", "CGST", "SGST", "IGST", "VAT", "D"],
  ["A tax invoice under GST is issued by a:", "Composition dealer", "Registered regular supplier", "Consumer", "Transporter", "B"],
  ["A bill of supply (instead of a tax invoice) is issued by a:", "Regular taxpayer on taxable goods", "Composition dealer or supplier of exempt goods", "Exporter", "Importer", "B"],
  ["The official GST portal is:", "www.incometax.gov.in", "www.gst.gov.in", "www.mca.gov.in", "www.epfindia.gov.in", "B"],
  ["The GST slab rates in India are:", "0%, 5%, 12%, 18%, 28%", "5%, 10%, 15%, 20%", "1%, 2%, 3%, 4%", "10%, 20%, 30%", "A"],
  ["The highest GST slab rate is:", "18%", "24%", "28%", "40%", "C"],
  ["Exempt/essential goods generally attract GST at:", "5%", "12%", "0% (nil rate)", "18%", "C"],
  ["The threshold turnover for GST registration for goods (normal category states) is:", "10 lakh", "20 lakh", "40 lakh", "1 crore", "C"],
  ["The threshold turnover for GST registration for services (normal category states) is:", "10 lakh", "20 lakh", "40 lakh", "1 crore", "B"],
  ["A person making an inter-state taxable supply of goods must:", "Register only above the threshold", "Register compulsorily", "Never register", "Register after one year", "B"],
  ["The reference number generated when a GST registration application is submitted is the:", "GSTIN", "ARN (Application Reference Number)", "IRN", "TRN only", "B"],
  ["The composition scheme under GST is designed for:", "Large companies", "Small taxpayers", "Exporters", "Non-residents", "B"],
  ["A composition dealer files a quarterly statement in form:", "CMP-08", "GSTR-1", "GSTR-3B", "GSTR-9", "A"],
  ["TCS under GST is collected by:", "Banks", "E-commerce operators", "Transporters", "Auditors", "B"],
  ["TDS under GST is deducted by:", "All buyers", "Notified government/PSU deductors", "Suppliers", "Consumers", "B"],
  ["GST subsumed (replaced) which of the following taxes?", "Income tax", "VAT, Service Tax and Excise duty", "Customs duty on imports", "Stamp duty", "B"],
  ["The GSTIN character 'Z' by default appears at which position?", "First", "13th", "14th", "Last (15th)", "C"],
  ["GST registration provides the taxpayer with a unique:", "PAN", "GSTIN", "TAN", "CIN", "B"],
  ["An unregistered person under GST:", "Can collect GST", "Cannot collect GST from customers", "Must file GSTR-1", "Can claim ITC", "B"],
];

const EXECUTIVE = [
  ["GSTR-1 contains the details of:", "Inward supplies", "Outward supplies (sales)", "Tax payments", "ITC reversal", "B"],
  ["GSTR-3B is a:", "Detailed sales return", "Monthly summary return", "Annual return", "Refund application", "B"],
  ["The monthly GSTR-1 is generally due by the:", "10th of the next month", "11th of the next month", "20th of the next month", "Last day of the month", "B"],
  ["GSTR-3B is generally due by the:", "11th of the next month", "20th of the next month", "25th of the next month", "31st of the next month", "B"],
  ["The auto-drafted statement showing eligible ITC to a buyer is:", "GSTR-1", "GSTR-2B", "GSTR-3B", "GSTR-9", "B"],
  ["The annual return GSTR-9 is due by:", "31st March", "30th September", "31st December of the next financial year", "30th June", "C"],
  ["An e-way bill is required for the movement of goods exceeding the value of:", "10,000", "25,000", "50,000", "1,00,000", "C"],
  ["E-invoicing is currently mandatory for taxpayers with aggregate turnover exceeding:", "1 crore", "5 crore", "10 crore", "20 crore", "B"],
  ["A composition scheme dealer:", "Can collect GST from customers", "Cannot collect GST from customers", "Can claim full ITC", "Can make inter-state sales freely", "B"],
  ["A composition dealer is:", "Allowed full input tax credit", "Not allowed to claim input tax credit", "Allowed 50% ITC", "Allowed ITC only on capital goods", "B"],
  ["The composition scheme turnover limit for goods (traders/manufacturers) is:", "50 lakh", "75 lakh", "1 crore", "1.5 crore", "D"],
  ["The composition tax rate for a trader or manufacturer is:", "1%", "5%", "6%", "12%", "A"],
  ["The composition tax rate for a restaurant (not serving alcohol) is:", "1%", "5%", "12%", "18%", "B"],
  ["A composition dealer cannot make:", "Local sales", "Inter-state outward supplies", "Purchases", "Cash sales", "B"],
  ["Input Tax Credit is the credit of GST paid on:", "Sales", "Purchases and input services", "Salaries", "Rent received", "B"],
  ["GSTR-9C is a:", "Sales return", "Reconciliation statement", "Refund form", "Registration form", "B"],
  ["Under the reverse charge mechanism (RCM), GST is paid by the:", "Supplier", "Recipient of the supply", "Transporter", "Government", "B"],
  ["Under the QRMP scheme, a taxpayer files returns:", "Monthly with monthly payment", "Quarterly with monthly tax payment", "Only annually", "Half-yearly", "B"],
  ["The return filed by a GST Tax Deductor (TDS) is:", "GSTR-6", "GSTR-7", "GSTR-8", "GSTR-5", "B"],
  ["The return filed by an e-commerce operator (TCS) is:", "GSTR-6", "GSTR-7", "GSTR-8", "GSTR-10", "C"],
  ["The return filed by an Input Service Distributor (ISD) is:", "GSTR-5", "GSTR-6", "GSTR-7", "GSTR-8", "B"],
  ["The final return filed on cancellation of GST registration is:", "GSTR-9", "GSTR-10", "GSTR-3B", "GSTR-4", "B"],
  ["The return filed by a non-resident taxable person is:", "GSTR-5", "GSTR-6", "GSTR-7", "GSTR-9", "A"],
  ["To opt into the composition scheme, a taxpayer files form:", "CMP-02", "CMP-08", "GSTR-4", "REG-01", "A"],
  ["A bill of supply is issued for:", "Taxable supplies by a regular dealer", "Exempt supplies or by a composition dealer", "Exports", "Inter-state sales", "B"],
  ["The e-way bill is generated on the portal:", "gst.gov.in", "ewaybillgst.gov.in", "incometax.gov.in", "mca.gov.in", "B"],
  ["TCS under GST is collected at the rate of (total):", "0.5%", "1%", "2%", "5%", "B"],
  ["TDS under GST is deducted at the rate of (total):", "1%", "2%", "5%", "10%", "B"],
  ["The rate of interest on late payment of GST is:", "12% p.a.", "15% p.a.", "18% p.a.", "24% p.a.", "C"],
  ["Exports of goods or services under GST are treated as:", "Exempt supplies", "Zero-rated supplies", "Nil-rated supplies", "Non-taxable supplies", "B"],
  ["Supplies made to a Special Economic Zone (SEZ) unit are treated as:", "Exempt supplies", "Zero-rated supplies", "Composite supplies", "Local supplies", "B"],
  ["A taxpayer's input tax credit is maintained in the:", "Electronic cash ledger", "Electronic credit ledger", "Electronic liability ledger", "Profit and loss account", "B"],
  ["GST paid in cash is credited to the:", "Electronic credit ledger", "Electronic cash ledger", "Electronic liability ledger", "Bank account", "B"],
  ["A Nil GSTR-3B return can be filed through:", "Email", "SMS", "Post", "Fax", "B"],
  ["Once filed, a GST return:", "Can be freely revised", "Cannot be revised (corrected in a later return)", "Is deleted", "Is auto-cancelled", "B"],
  ["Whether HSN codes must be shown on an invoice depends on the taxpayer's:", "Location", "Aggregate turnover", "Age", "Bank balance", "B"],
  ["The GSTR-1 can be filed:", "Only monthly", "Monthly or quarterly (under QRMP)", "Only annually", "Only once", "B"],
  ["Under GST, a tax invoice is required for:", "Exempt supplies", "Taxable supplies", "Personal use", "Salary payment", "B"],
  ["The statement filed quarterly by a composition dealer to pay tax is:", "GSTR-4", "CMP-08", "GSTR-3B", "GSTR-1", "B"],
  ["The annual return for a composition dealer is:", "GSTR-9", "GSTR-4", "CMP-08", "GSTR-9C", "B"],
];

const INTERMEDIATE = [
  ["The eligibility and conditions for taking Input Tax Credit are given in:", "Section 15", "Section 16", "Section 17", "Section 22", "B"],
  ["One of the conditions to claim ITC is that the recipient must:", "Be unregistered", "Possess a valid tax invoice", "Pay in cash only", "Be a composition dealer", "B"],
  ["ITC availed must be reversed if payment to the supplier is not made within:", "45 days", "90 days", "180 days", "365 days", "C"],
  ["Blocked credits (ITC not allowed) are listed under:", "Section 16", "Section 17(5)", "Section 22", "Section 31", "B"],
  ["ITC is generally NOT available on:", "Raw materials", "Motor vehicles (with exceptions) and food/beverages", "Input services for business", "Capital goods used in production", "B"],
  ["The reverse charge mechanism is governed mainly by:", "Section 7", "Sections 9(3) and 9(4)", "Section 16", "Section 44", "B"],
  ["Place of supply rules are used to determine whether a supply is:", "Exempt or taxable", "Inter-state or intra-state", "Composite or mixed", "Goods or services", "B"],
  ["Time of supply is important because it determines:", "The rate of tax", "When the GST liability arises", "The place of supply", "The HSN code", "B"],
  ["For goods, the time of supply is generally the earlier of the:", "Delivery date only", "Invoice date or receipt of payment", "Financial year end", "Return filing date", "B"],
  ["Zero-rated supply is defined under:", "Section 16 of the IGST Act", "Section 9 of the CGST Act", "Section 22 of the CGST Act", "Section 44 of the CGST Act", "A"],
  ["The key difference between exempt and zero-rated supply is that:", "Both allow ITC", "ITC is available on zero-rated but not on exempt supply", "Neither allows ITC", "Exempt supply is taxed higher", "B"],
  ["A casual taxable person must obtain registration at least:", "5 days before commencing business", "30 days before", "1 day after", "1 year before", "A"],
  ["Cases of compulsory GST registration are listed under:", "Section 22", "Section 24", "Section 25", "Section 29", "B"],
  ["Persons liable to register based on the turnover threshold are covered under:", "Section 22", "Section 24", "Section 31", "Section 49", "A"],
  ["The scope of 'supply' under GST is defined in:", "Section 7", "Section 9", "Section 16", "Section 22", "A"],
  ["A tax invoice must be issued under which section?", "Section 16", "Section 31", "Section 44", "Section 49", "B"],
  ["The three electronic ledgers under GST are cash, credit and:", "Refund ledger", "Liability ledger", "Sales ledger", "Purchase ledger", "B"],
  ["The provisions for payment of tax and electronic ledgers are in:", "Section 16", "Section 31", "Section 49", "Section 73", "C"],
  ["TDS under GST is governed by:", "Section 51", "Section 52", "Section 44", "Section 16", "A"],
  ["TCS under GST (e-commerce) is governed by:", "Section 51", "Section 52", "Section 24", "Section 9", "B"],
  ["A refund of unutilised ITC is generally available in the case of:", "Local sales", "Exports or an inverted duty structure", "Exempt sales", "Personal use", "B"],
  ["A GST refund claim must generally be filed within:", "6 months from the relevant date", "1 year from the relevant date", "2 years from the relevant date", "5 years from the relevant date", "C"],
  ["GSTR-2B differs from GSTR-2A in that GSTR-2B is a:", "Dynamic statement", "Static statement", "Manual return", "Refund form", "B"],
  ["An Input Service Distributor (ISD) distributes the credit of:", "Goods only", "Input services", "Capital goods only", "Cash", "B"],
  ["Under RCM, the recipient who pays the tax:", "Can never claim ITC", "Can claim ITC if otherwise eligible", "Must be unregistered", "Pays double tax", "B"],
  ["The value of supply under GST is generally the:", "Maximum retail price", "Transaction value", "Cost plus 10%", "Book value", "B"],
  ["A works contract under GST is treated as a supply of:", "Goods", "Services", "Both equally", "Neither", "B"],
  ["Goods can be sent to a job worker:", "Only after paying full tax", "Without payment of tax, subject to conditions", "Only for exports", "Never", "B"],
  ["The last date to avail ITC of an invoice is generally the earlier of the annual return or:", "31st July", "30th September", "30th November of the next financial year", "31st March", "C"],
  ["A composition dealer, instead of a tax invoice, issues a:", "Bill of supply", "Debit note", "Credit note", "Shipping bill", "A"],
  ["The GST Compensation Cess is levied on:", "All goods", "Certain luxury and sin goods", "Only services", "Exports", "B"],
  ["A supply of two or more goods bundled naturally and sold together is a:", "Mixed supply", "Composite supply", "Exempt supply", "Deemed supply", "B"],
  ["Registration for a non-resident or casual taxable person is valid for:", "1 year", "The period specified, up to 90 days (extendable)", "Permanently", "5 years", "B"],
  ["Related-party supplies are valued as per the:", "MRP", "GST Valuation Rules", "Income Tax Act", "Customs Act", "B"],
  ["The relevant date is important for computing the time limit to file a:", "GSTR-1", "Refund claim", "GSTR-3B", "Registration", "B"],
];

const EXPERT = [
  ["The Constitutional Amendment that introduced GST in India is the:", "100th Amendment", "101st Amendment", "102nd Amendment", "122nd Amendment", "B"],
  ["The GST Council is a constitutional body established under:", "Article 246A", "Article 279A", "Article 265", "Article 300A", "B"],
  ["The charging section of the CGST Act (levy of tax) is:", "Section 7", "Section 9", "Section 16", "Section 22", "B"],
  ["Activities to be treated as supply even without consideration are listed in:", "Schedule I", "Schedule II", "Schedule III", "Schedule IV", "A"],
  ["Activities treated as neither a supply of goods nor services are in:", "Schedule I", "Schedule II", "Schedule III", "Schedule IV", "C"],
  ["Schedule II of the CGST Act deals with:", "Supply without consideration", "Classification of activities as goods or services", "Non-supplies", "Exemptions", "B"],
  ["The provisions for the annual return are contained in:", "Section 44", "Section 35", "Section 16", "Section 31", "A"],
  ["The reconciliation statement GSTR-9C is now:", "Certified only by a Chartered Accountant", "Self-certified by the taxpayer", "Not required at all", "Certified by the ROC", "B"],
  ["An advance ruling on a GST matter is obtained from the:", "GST Council", "Authority for Advance Ruling (AAR)", "High Court", "CBIC", "B"],
  ["An appeal against an order of the AAR lies with the:", "Supreme Court", "Appellate Authority for Advance Ruling (AAAR)", "GST Council", "Regional Director", "B"],
  ["An e-invoice generates a unique:", "GSTIN", "Invoice Reference Number (IRN)", "ARN", "TRN", "B"],
  ["The IRN for an e-invoice is generated on the:", "GST portal", "Invoice Registration Portal (IRP)", "E-way bill portal", "MCA portal", "B"],
  ["Section 17(5) blocks input tax credit on items such as:", "Raw materials", "Goods for personal consumption and certain motor vehicles", "Input services for output supply", "Capital goods used in manufacture", "B"],
  ["Rules 42 and 43 of the CGST Rules deal with:", "Registration", "Reversal of common ITC (for exempt and taxable supplies)", "Refunds", "E-way bills", "B"],
  ["Deemed exports are notified under which section of the CGST Act?", "Section 16", "Section 147", "Section 54", "Section 44", "B"],
  ["A mixed supply is taxed at the rate applicable to the:", "Lowest-rated item", "Highest-rated item", "Average of rates", "Principal item", "B"],
  ["A composite supply is taxed at the rate applicable to the:", "Highest-rated item", "Principal supply", "Lowest-rated item", "Ancillary supply", "B"],
  ["A composite supply is defined under:", "Section 2(30)", "Section 2(74)", "Section 7", "Section 9", "A"],
  ["A mixed supply is defined under:", "Section 2(30)", "Section 2(74)", "Section 16", "Section 31", "B"],
  ["A GST Practitioner is enrolled under:", "Section 44", "Section 48", "Section 52", "Section 16", "B"],
  ["The validity of an e-way bill for a distance up to 200 km is generally:", "1 day", "3 days", "7 days", "15 days", "A"],
  ["Detention and seizure of goods in transit is dealt with under:", "Section 129", "Section 73", "Section 44", "Section 16", "A"],
  ["Confiscation of goods and conveyances is dealt with under:", "Section 129", "Section 130", "Section 74", "Section 54", "B"],
  ["Interest on input tax credit wrongly availed and utilised is charged at:", "12%", "15%", "18%", "24%", "C"],
  ["Filing of GSTR-9 (annual return) is optional for taxpayers with aggregate turnover up to:", "1 crore", "2 crore", "5 crore", "10 crore", "B"],
  ["A demand of tax NOT involving fraud or suppression is raised under:", "Section 73", "Section 74", "Section 129", "Section 130", "A"],
  ["A demand of tax involving fraud or wilful suppression is raised under:", "Section 73", "Section 74", "Section 122", "Section 132", "B"],
  ["A Unique Identity Number (UIN) under GST is granted to:", "All taxpayers", "UN bodies, embassies and notified persons", "Composition dealers", "E-commerce operators", "B"],
  ["The balance in the electronic credit ledger can be used to pay:", "Output tax liability only", "Interest and penalty", "Late fees", "Income tax", "A"],
  ["The value of a supply where the consideration is not wholly in money is determined under the:", "Composition Rules", "GST Valuation Rules", "Income Tax Rules", "Customs Rules", "B"],
  ["A refund of IGST paid on the export of goods is processed through the:", "GST portal manually", "Customs system (shipping bill treated as the refund application)", "Income Tax Department", "RBI", "B"],
  ["The GST audit / reconciliation (GSTR-9C) requirement earlier applied above a turnover of:", "1 crore", "2 crore", "5 crore", "10 crore", "C"],
  ["Anti-profiteering under GST was monitored by the:", "GST Council", "National Anti-profiteering Authority (NAA)", "CBIC", "SEBI", "B"],
  ["The QR code on a B2B e-invoice is generated by the:", "Supplier manually", "Invoice Registration Portal (IRP)", "Recipient", "Bank", "B"],
  ["Input tax credit cannot be used to pay:", "CGST liability", "IGST liability", "Interest and penalty", "SGST liability", "C"],
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
  console.log('GST question bank:', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`GST area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
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
    console.log(`Deleted ${del.rowCount} old GST questions; inserted ${inserted} new (area_id ${areaId}).`);
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
