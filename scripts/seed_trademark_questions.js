require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const { Pool } = require('pg');

// Trademark / IP question bank — original MCQs from the Trade Marks Act,
// 1999, Rules and current practice, answers verified.
// Format: [q, A, B, C, D, correct]. Target org GB-001 (id 1), area
// "Trademark".
const ORG_ID = parseInt(process.env.SEED_ORG_ID || '1', 10);
const AREA_NAME = 'trademark';

const INTERN = [
  ["A trademark is primarily used to distinguish:", "One financial year from another", "The goods/services of one person from those of others", "Employees of a company", "Government departments", "B"],
  ["Trademarks in India are governed by the:", "Copyright Act, 1957", "Trade Marks Act, 1999", "Patents Act, 1970", "Designs Act, 2000", "B"],
  ["The symbol ® can be used only after a trademark is:", "Merely applied for", "Actually registered", "Used for one day", "Renewed once", "B"],
  ["The symbol ™ is generally used to indicate:", "A registered trademark", "An unregistered/pending trademark claim", "A copyright", "A patent", "B"],
  ["The symbol © represents:", "Trademark rights", "Copyright", "Patent rights", "Design rights", "B"],
  ["The Controller General overseeing trademarks in India is the:", "Registrar of Companies", "Controller General of Patents, Designs and Trade Marks (CGPDTM)", "SEBI Chairman", "RBI Governor", "B"],
  ["Trademark applications and records in India are managed on the portal:", "ipindia.gov.in", "mca.gov.in", "gst.gov.in", "incometax.gov.in", "A"],
  ["The international classification of goods and services for trademarks is called the:", "Harmonized System", "Nice Classification", "HSN Code", "SAC Code", "B"],
  ["The Nice Classification divides goods and services into how many classes?", "25", "34", "45", "50", "C"],
  ["Classes 1 to 34 under the Nice Classification cover:", "Services", "Goods", "Only pharmaceuticals", "Only food items", "B"],
  ["Classes 35 to 45 under the Nice Classification cover:", "Goods", "Services", "Only IT products", "Only clothing", "B"],
  ["A word, symbol, or device capable of distinguishing goods is broadly termed a:", "Patent", "Trademark/mark", "Copyright work", "Geographical Indication", "B"],
  ["A trademark that consists of just a shape, sound, or smell (non-traditional) is called a:", "Word mark", "Non-conventional trademark", "Certification mark", "Collective mark", "B"],
  ["A mark used by an association of persons to certify a particular characteristic is a:", "Collective mark", "Certification mark", "Service mark", "Word mark", "B"],
  ["A mark used by members of an association to distinguish their goods from non-members is a:", "Certification mark", "Collective mark", "Well-known mark", "Trade name", "B"],
  ["A mark used in relation to services (rather than goods) is called a:", "Service mark", "Word mark", "Device mark", "Colour mark", "A"],
  ["A trademark consisting only of a design/logo without words is a:", "Word mark", "Device mark", "Sound mark", "Trade name", "B"],
  ["The application for registration of a trademark is filed in form:", "TM-A", "TM-M", "TM-O", "TM-R", "A"],
  ["A trademark application can be filed by:", "Only companies", "Any person claiming to be the proprietor of the mark", "Only the Government", "Only foreigners", "B"],
  ["An application to register a trademark can be filed on a:", "Used or 'proposed to be used' basis", "Used basis only", "Registered basis only", "Foreign basis only", "A"],
  ["Trademark registration in India is granted for goods/services and is valid initially for:", "5 years", "7 years", "10 years", "15 years", "C"],
  ["A registered trademark can be renewed:", "Only once", "Indefinitely, every 10 years, on payment of fee", "Never", "Only after 50 years", "B"],
  ["A trademark journal is published to:", "Announce Board meetings", "Advertise accepted trademark applications for public opposition", "List defaulting taxpayers", "Publish GST rates", "B"],
  ["A trademark search is conducted before filing to check:", "Company incorporation status", "Availability/conflict with existing marks", "GST registration", "Bank account details", "B"],
  ["A trademark can be represented by:", "Words, logos, shapes, sounds and other distinctive signs (as permitted)", "Only plain text", "Only numbers", "Only colours", "A"],
  ["A geographical indication (GI) identifies goods originating from a specific:", "Company", "Geographical territory with a given quality/reputation", "Individual", "Bank", "B"],
  ["An example of a Geographical Indication is:", "Nike", "Darjeeling Tea", "Coca-Cola", "Adidas", "B"],
  ["A trade name refers to:", "The name under which a business is carried on", "A registered patent", "A tax identification number", "A GST invoice number", "A"],
  ["Trademark rights in India are generally:", "Automatic worldwide on use anywhere", "Territorial (limited to the country of registration/use)", "Perpetual without renewal", "Only for exporters", "B"],
  ["A 'proprietor' of a trademark is the person who:", "Only uses it occasionally", "Owns/claims ownership of the trademark", "Files GST returns", "Audits accounts", "B"],
  ["A trademark can be assigned, meaning its ownership can be:", "Never transferred", "Transferred to another person", "Only inherited", "Cancelled automatically", "B"],
  ["Registered trademark rights give the proprietor the exclusive right to:", "Sell shares", "Use the mark in relation to the goods/services registered", "File tax returns", "Vote in company meetings", "B"],
  ["The first step to obtain trademark protection in India is generally:", "Filing an FIR", "Conducting a search and filing an application", "Registering with the ROC", "Filing GST returns", "B"],
  ["An 'associated trademark' refers to marks registered:", "Independently with no link", "In the name of the same proprietor, resembling each other", "By different proprietors", "Only for services", "B"],
  ["The colour combination of a mark can be:", "Never protected", "Protected as a distinguishing feature in some cases", "Only protected for logos", "Irrelevant to registration", "B"],
  ["A trademark registered without limitation of colour is deemed registered for:", "One colour only", "All colours", "No colour", "Black and white only", "B"],
  ["The Register of Trademarks is maintained at the:", "Trade Marks Registry", "Registrar of Companies office", "Income Tax office", "GST office", "A"],
  ["An applicant claiming 'priority' under an international convention application refers an earlier filing in:", "India only", "A convention country", "A non-convention country", "No country", "B"],
  ["A trademark can be filed as a 'multi-class' application, covering:", "Only one class", "More than one class of goods/services in a single application", "Only services", "Only goods", "B"],
  ["The right to prevent others from using an identical/similar mark arises mainly from:", "Mere intention to use", "Registration and/or prior use of the mark", "Government notification", "GST registration", "B"],
];

const EXECUTIVE = [
  ["After filing, a trademark application is examined by the Registrar to check for:", "Only spelling errors", "Distinctiveness and conflicts with earlier marks", "Only the applicant's PAN", "GST compliance", "B"],
  ["An examination report issued by the Registrar raising objections is called a(n):", "Opposition notice", "Examination Report", "Renewal notice", "Rectification order", "B"],
  ["A reply to the examination report must generally be filed within:", "1 month", "30 days (extendable in practice)", "6 months", "1 year", "B"],
  ["If the Registrar is not satisfied with the reply, a hearing may be scheduled, which is called a(n):", "Show-cause hearing", "AGM", "Board meeting", "Arbitration", "A"],
  ["After acceptance, a trademark application is published in the:", "Trademark Journal for public opposition", "Official Gazette of India only", "Newspaper only", "Company website", "A"],
  ["The period within which a third party can file an opposition after publication is:", "1 month", "2 months (extendable)", "6 months", "1 year", "B"],
  ["An opposition to a trademark application is filed in form:", "TM-A", "TM-O", "TM-M", "TM-R", "B"],
  ["If no opposition is filed (or opposition fails), the trademark proceeds to:", "Rejection", "Registration", "Cancellation", "Abandonment", "B"],
  ["A Registration Certificate for a trademark is issued after:", "Filing the application", "Successful examination and, where applicable, opposition proceedings", "Payment of GST", "Filing of ITR", "B"],
  ["A trademark renewal application is filed in form:", "TM-A", "TM-R", "TM-O", "TM-M", "B"],
  ["A trademark renewal application should generally be filed:", "Only after expiry", "Within 6 months before the date of expiry (with a grace period after)", "Anytime during the 10-year term", "Only in the first year", "B"],
  ["If a trademark is not renewed even within the grace period, it is liable to be:", "Automatically renewed", "Removed from the register", "Transferred to the Government", "Converted to a patent", "B"],
  ["A removed trademark can generally be restored by filing:", "A fresh application only", "An application for restoration within the prescribed period, with a surcharge", "An FIR", "A GST return", "B"],
  ["An application to record a change in the name/address of the proprietor is filed in form:", "TM-A", "TM-P", "TM-M", "TM-O", "B"],
  ["A Power of Attorney/authorisation for a trademark agent is filed in form:", "TM-A", "TM-M", "TM-48", "TM-O", "C"],
  ["A trademark agent is a person authorised to:", "Only conduct GST audits", "Act on behalf of applicants before the Trade Marks Registry", "Sign company balance sheets", "Only handle patents", "B"],
  ["A trademark application filed online generally attracts:", "A higher fee than physical filing", "A lower (discounted) fee than physical filing", "The same fee always", "No fee", "B"],
  ["A 'Startup' or 'small enterprise' applicant may be eligible for:", "Reduced/discounted trademark fees", "No trademark fees at all", "Automatic registration", "Faster GST refund", "A"],
  ["A trademark can be filed based on 'user affidavit' when the applicant claims:", "No prior use", "Prior use of the mark since a specific date", "Only future use", "Government use", "B"],
  ["A hearing before the Registrar for accepting/refusing a mark is generally conducted:", "Only physically", "Physically or through video conferencing", "By post only", "Never", "B"],
  ["An application can be withdrawn by the applicant at any stage by filing form:", "TM-A", "TM-W", "TM-O", "TM-M", "B"],
  ["An amendment to correct clerical errors in an application is made through form:", "TM-A", "TM-M", "TM-O", "TM-P", "B"],
  ["A well-known trademark enjoys protection:", "Only in the class it is registered for", "Across classes, even for dissimilar goods/services", "Only for one year", "Only in its country of origin", "B"],
  ["An application to have a mark declared 'well-known' can be filed in form:", "TM-M", "TM-A", "TM-O", "TM-R", "A"],
  ["A trademark can be assigned with or without the:", "Renewal fee", "Goodwill of the business", "GST registration", "PAN card", "B"],
  ["An assignment/transmission of a trademark must be recorded with the Registrar in form:", "TM-A", "TM-P", "TM-O", "TM-M", "B"],
  ["A licence permitting another person to use a registered trademark makes that person a:", "Proprietor", "Registered user/permitted user", "Assignee", "Opponent", "B"],
  ["A 'registered user' of a trademark must generally have their use recorded to claim:", "Ownership of the mark", "Benefit of the licensor's use for defending the registration", "Automatic transfer of ownership", "Tax exemption", "B"],
  ["A trademark can be refused registration if it is 'devoid of distinctive character' under the:", "Relative grounds for refusal", "Absolute grounds for refusal", "Opposition proceedings only", "Renewal rules", "B"],
  ["A mark that is identical/similar to an earlier registered mark for similar goods may be refused under the:", "Absolute grounds for refusal", "Relative grounds for refusal", "Renewal provisions", "Assignment rules", "B"],
  ["Descriptive marks (describing the kind, quality, or purpose of goods) are generally:", "Freely registrable", "Not registrable unless they have acquired distinctiveness", "Registrable only for services", "Always registrable", "B"],
  ["Marks that are scandalous or contrary to public morality are refused under:", "Relative grounds", "Absolute grounds", "Class objections only", "Opposition only", "B"],
  ["The emblems and names (prevention of improper use) that cannot be registered include national symbols, under the:", "Trade Marks Act read with the Emblems and Names Act", "Income Tax Act", "GST Act", "Companies Act", "A"],
  ["A generic term for a product (e.g. the common name of the goods itself) is generally:", "Freely registrable as a trademark", "Not registrable as a trademark", "Registrable only in India", "Registrable only abroad", "B"],
  ["The examination of a trademark also checks for conflicts with:", "Only identical marks in the same class", "Similar/identical marks across relevant classes", "Company names only", "GST numbers only", "B"],
  ["A 'convention application' allows claiming priority based on an earlier filing in a Paris Convention country, generally within:", "1 month", "6 months", "1 year", "5 years", "B"],
  ["An objection due to similarity with an earlier trademark can be overcome by, among other things, filing a(n):", "GST return", "No objection/consent letter from the earlier proprietor", "Income tax certificate", "Employee list", "B"],
  ["A trademark registered in one class does not automatically protect the mark in:", "That same class", "Unrelated classes of goods/services (subject to well-known mark protection)", "No classes", "All countries automatically", "B"],
  ["The status of a trademark application (e.g., objected, opposed, registered) can be tracked on the:", "GST portal", "IP India public search/status portal", "MCA portal", "Income tax portal", "B"],
  ["A trademark application filed by a foreign applicant in India must generally provide an address for service:", "In their home country only", "In India", "Nowhere required", "Only via email", "B"],
];

const INTERMEDIATE = [
  ["Absolute grounds for refusal of trademark registration are covered under:", "Section 9 of the Trade Marks Act, 1999", "Section 11", "Section 18", "Section 29", "A"],
  ["Relative grounds for refusal (conflict with earlier marks) are covered under:", "Section 9", "Section 11", "Section 18", "Section 25", "B"],
  ["The provision requiring the application for registration is contained in:", "Section 9", "Section 11", "Section 18", "Section 28", "C"],
  ["The rights conferred by registration are described under:", "Section 18", "Section 25", "Section 28", "Section 29", "C"],
  ["Infringement of a registered trademark is dealt with under:", "Section 18", "Section 27", "Section 28", "Section 29", "D"],
  ["An action for passing off protects:", "Only registered trademarks", "Unregistered trademarks based on goodwill and reputation", "Only patents", "Only copyrights", "B"],
  ["Section 27 of the Trade Marks Act clarifies that no infringement action lies for an unregistered mark, but preserves the right to sue for:", "Infringement anyway", "Passing off", "Breach of contract", "Defamation", "B"],
  ["The essential elements to prove passing off are goodwill, misrepresentation and:", "Registration", "Damage to goodwill/business", "GST payment", "Patent filing", "B"],
  ["Trademark infringement occurs when a mark identical/deceptively similar to a registered mark is used:", "Only by the proprietor", "By an unauthorised person in the course of trade for similar goods/services", "Only in advertisements", "Only for exports", "B"],
  ["'Deceptively similar' means a mark so nearly resembling another that it is likely to:", "Increase sales of the earlier mark", "Deceive or cause confusion", "Reduce the price of goods", "Have no legal effect", "B"],
  ["Trademark dilution generally refers to weakening of a famous mark's distinctiveness, even:", "With direct competition and confusion", "Without confusion or direct competition", "Only after expiry", "Only for generic marks", "B"],
  ["A licence to use a trademark can be:", "Only exclusive", "Exclusive or non-exclusive, as agreed", "Never granted", "Only implied", "B"],
  ["An assignment of a trademark 'without goodwill' is also called:", "Assignment in gross", "Full assignment", "Registered user agreement", "Passing off", "A"],
  ["A trademark that has become generic/common in trade for a product may face:", "Automatic renewal for life", "Removal/rectification on the ground of genericness", "Higher protection", "Automatic well-known status", "B"],
  ["Rectification of the Register of Trademarks (correcting or cancelling an entry) can be sought under:", "Section 47", "Section 57", "Section 29", "Section 9", "B"],
  ["Removal of a registered trademark for non-use can be sought under:", "Section 47", "Section 57", "Section 9", "Section 11", "A"],
  ["An application for rectification/removal can be filed before the:", "Only the High Court", "The Registrar or the High Court (post-IPAB abolition)", "GST tribunal", "Income Tax Appellate Tribunal", "B"],
  ["A collective mark helps consumers identify goods/services originating from:", "A single company only", "Members of an association", "The government only", "No specific source", "B"],
  ["A certification mark certifies characteristics such as origin, material or quality, and is typically owned by a body that:", "Uses the mark itself in trade", "Does not itself trade in the certified goods", "Is always a government department", "Is the sole competitor", "B"],
  ["The 'first to file' principle in Indian trademark law generally means that, between rival applicants, priority goes (subject to prior use) to:", "The applicant with more money", "The one who filed earlier", "The one who registered a company first", "The one who is older", "B"],
  ["Prior use of a mark in India can, in certain cases, defeat a:", "Later registered proprietor's claim (in a passing off action)", "Government notification", "GST return", "Company incorporation", "A"],
  ["The 'honest concurrent use' provision may allow registration of similar marks by different proprietors under:", "Absolute grounds", "Discretion of the Registrar under specified conditions", "No circumstances at all", "Automatic right", "B"],
  ["A trademark that has 'acquired distinctiveness' through use may be registered even if it was initially:", "Identical to a well-known mark", "Descriptive or non-distinctive", "Scandalous", "A national emblem", "B"],
  ["Franchising commonly involves licensing of:", "Only patents", "Trademarks along with business systems/know-how", "Only copyrights", "Only designs", "B"],
  ["Counterfeiting refers to the unauthorised use of a mark to make goods appear as:", "Generic products", "Genuine products of the trademark owner", "Government-issued goods", "Unbranded goods", "B"],
  ["A trademark opposition proceeding, once both parties file evidence, generally concludes with a:", "Direct registration", "Hearing and a decision by the Registrar", "Automatic rejection", "Cancellation of the company", "B"],
  ["An appeal against certain orders of the Registrar of Trademarks now lies with the:", "IPAB (Intellectual Property Appellate Board), which still functions", "High Court (after abolition of the IPAB)", "GST Tribunal", "NCLT", "B"],
  ["A domain name dispute involving a trademark is commonly resolved through:", "The GST portal", "UDRP/INDRP or civil court action", "MCA portal", "The Income Tax Department", "B"],
  ["A trademark used as a house mark identifies the:", "Manufacturing unit's address", "Company/manufacturer across its product range", "GST registration number", "Import license", "B"],
  ["Comparative advertising referencing a competitor's trademark may amount to infringement if it:", "Merely mentions the competitor factually", "Disparages or takes unfair advantage of the mark's reputation", "Is always permitted freely", "Is banned under all circumstances", "B"],
  ["Trademark 'squatting' refers to registering a mark in bad faith mainly to:", "Genuinely use it in trade", "Block or extract money from the rightful owner", "Support a charity", "Comply with GST rules", "B"],
  ["The remedy of an injunction in a trademark suit primarily aims to:", "Award damages only", "Restrain further infringing use", "Cancel the company's registration", "Impose GST penalty", "B"],
  ["An account of profits, as a remedy, requires the infringer to:", "Pay a fixed penalty", "Hand over profits earned from the infringing use", "File a fresh trademark", "Surrender the company", "B"],
  ["Criminal remedies for trademark infringement/counterfeiting are available under:", "The Trade Marks Act read with the IPC/BNS provisions", "Only civil law", "Only tax law", "No criminal remedy exists", "A"],
  ["Border measures allow customs authorities to seize goods suspected of:", "Being underpriced", "Infringing registered trademarks/IP rights on import", "Being exported without GST", "Having no HSN code", "B"],
];

const EXPERT = [
  ["India is a member of which international treaty facilitating international trademark registration?", "PCT (Patent Cooperation Treaty)", "Madrid Protocol", "Berne Convention", "Budapest Treaty", "B"],
  ["An international application under the Madrid Protocol is based on a corresponding:", "Foreign registration only", "Basic (home) application or registration", "GST registration", "Company incorporation", "B"],
  ["Under the Madrid System, a single international application can seek protection in:", "Only one country", "Multiple designated member countries", "Only India", "No country", "B"],
  ["The Paris Convention primarily provides for:", "GST harmonisation", "National treatment and a right of priority among member countries", "Uniform tax rates", "Common company law", "B"],
  ["TRIPS stands for:", "Trade-Related Intellectual Property Standards", "Trade-Related Aspects of Intellectual Property Rights", "Trade Regulation on Intellectual Property Systems", "Trademark Registration and Intellectual Property Scheme", "B"],
  ["TRIPS is administered under the framework of the:", "United Nations", "World Trade Organization (WTO)", "World Bank", "IMF", "B"],
  ["WIPO stands for:", "World Intellectual Property Organization", "World Industrial Patent Office", "World Investment Protection Organization", "World Import Property Office", "A"],
  ["The dilution doctrine primarily protects:", "Any registered mark, regardless of reputation", "Famous/well-known marks from blurring or tarnishment", "Generic terms", "Unregistered descriptive marks", "B"],
  ["'Tarnishment' in dilution law refers to harming a famous mark's reputation through:", "Positive association", "Unsavoury or unflattering association", "Increased sales", "Higher pricing", "B"],
  ["'Blurring' in dilution law refers to weakening a famous mark's distinctiveness through:", "Association with dissimilar goods diluting its uniqueness", "Direct competition only", "Increased advertising by the owner", "Renewal delays", "A"],
  ["The Delhi High Court and other courts have recognised protection for well-known trademarks even against:", "Only identical goods", "Dissimilar goods/services, to prevent dilution/unfair advantage", "No circumstances", "Only local businesses", "B"],
  ["Under Section 11(6) of the Trade Marks Act, factors to determine a 'well-known mark' include, among others:", "GST turnover only", "The extent of knowledge/recognition of the mark among the public", "Number of employees", "Number of directors", "B"],
  ["The abolition of the IPAB transferred pending trademark appeals to the:", "Supreme Court only", "Concerned High Courts", "GST Appellate Tribunal", "NCLT", "B"],
  ["A civil suit for trademark infringement is generally filed in a court having jurisdiction based on, among other things, where the:", "Defendant's factory is located only", "Plaintiff/defendant resides or the cause of action arose", "Registrar's office is located only", "GST office is located", "B"],
  ["Section 134 of the Trade Marks Act allows a registered proprietor to sue for infringement in a court within whose jurisdiction the:", "Defendant alone resides", "Plaintiff (registered proprietor) actually or voluntarily resides/carries on business (in addition to usual grounds)", "Registrar is located only", "Government office is located", "B"],
  ["An ex-parte (interim) injunction may be granted by a court when there is:", "No urgency", "Urgency and a strong prima facie case of infringement", "Only after full trial", "Only with the defendant's consent", "B"],
  ["An Anton Piller order in IP litigation allows for:", "Tax assessment", "Search and seizure of infringing material/evidence", "Cancellation of GST registration", "Company winding up", "B"],
  ["A 'John Doe' (Ashok Kumar) order is used in IP cases to restrain:", "Named defendants only", "Unknown/unidentified infringers as well", "Only the Government", "Only competitors abroad", "B"],
  ["Parallel imports (grey market goods) raise trademark issues primarily around:", "Exhaustion of rights", "GST classification", "Company incorporation", "Income tax exemption", "A"],
  ["Under the principle of 'international exhaustion', once genuine goods are sold anywhere globally, the trademark owner's rights over further resale are:", "Unlimited everywhere", "Generally exhausted, subject to exceptions", "Increased", "Automatically renewed", "B"],
  ["A trademark license agreement typically also addresses quality control to prevent the mark from becoming:", "More distinctive", "Deceptive or misleading to the public", "More valuable only", "Exempt from tax", "B"],
  ["The 'anti-dissection rule' in comparing marks for confusion means courts generally consider the mark:", "Only its individual letters", "As a whole rather than dissecting it into parts", "Only its colour", "Only its size", "B"],
  ["The 'dominant feature' test is used alongside the anti-dissection rule to assess:", "Which part of a mark is most likely to be remembered/create impression", "The tax liability of the applicant", "The company's turnover", "The number of employees", "A"],
  ["A composite mark dispute (word + device) is generally analysed based on:", "The word portion alone always", "The overall commercial impression created by the mark", "The device portion alone always", "Colour alone", "B"],
  ["Trans-border reputation allows protection of a foreign trademark in India even without local use, based on:", "GST registration in India", "Evidence of reputation/goodwill spilling over into India", "Filing a patent in India", "Registering a company in India", "B"],
  ["The concept of 'initial interest confusion' addresses confusion that occurs:", "Only at the point of final sale", "Before the actual sale, e.g. attracting a customer's attention", "Only after the goods are used", "Only in criminal cases", "B"],
  ["Cybersquatting involving a trademark typically involves registering a domain name:", "Genuinely for business use", "In bad faith to profit from another's trademark", "With Government approval", "Under a court order", "B"],
  ["A well-known trademark determination made by the Registrar is published to give it:", "Temporary protection for a year", "Recognised status and broader protection across classes", "No additional benefit", "Only local protection", "B"],
  ["The remedy of 'Anton Piller' order along with a Mareva injunction (freezing assets) is typically sought to prevent:", "Payment of taxes", "Dissipation of assets/evidence by the infringer before trial", "Renewal of the mark", "Filing of a fresh application", "B"],
  ["A 'trademark bullying' concern arises when a proprietor:", "Genuinely enforces valid rights", "Aggressively threatens infringement claims beyond the reasonable scope of its rights", "Files for renewal", "Applies for a new class", "B"],
  ["Under the Madrid Protocol, if the basic (home) application is refused/withdrawn within 5 years, the international registration is subject to:", "No effect at all", "The 'central attack' principle, which can affect the international registration", "Automatic renewal", "Immediate cancellation of all trademarks", "B"],
  ["A 'certification trademark' relating to standards (e.g. quality marks) is typically administered to ensure the certifying body remains:", "A direct trader in the certified goods", "Independent/not itself trading in those goods", "The Government only", "A registered company only", "B"],
  ["A dispute over similar marks in different, unrelated classes with no likelihood of confusion generally:", "Always amounts to infringement", "May not amount to infringement, absent well-known mark protection", "Is automatically resolved in favour of the senior mark", "Requires GST clearance", "B"],
  ["The doctrine of 'genericide' describes a trademark becoming the common name for a product, risking:", "Increased protection", "Loss of trademark protection due to genericness", "Automatic renewal for life", "Conversion into a patent", "B"],
  ["Under Section 124 of the Trade Marks Act, a civil infringement suit is generally stayed if the defendant raises a plea questioning the validity of the registration, pending disposal by the:", "GST Tribunal", "High Court (rectification proceedings)", "Registrar of Companies", "Income Tax Appellate Tribunal", "B"],
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
  console.log('Trademark question bank:', JSON.stringify(counts), '=> total', total);

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
    if (!area.rows.length) throw new Error(`Trademark area not found for org ${ORG_ID}. Open the admin Areas tab once to seed defaults.`);
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
    console.log(`Deleted ${del.rowCount} old Trademark questions; inserted ${inserted} new (area_id ${areaId}).`);
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
