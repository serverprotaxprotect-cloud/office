const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const db      = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// DD/MM/YYYY string or Excel serial → 'YYYY-MM-DD' or null
function parseDate(v) {
  if (!v || v === '-' || v === '') return null;
  if (typeof v === 'number') {
    // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().split('T')[0];
  }
  const s = v.toString().trim();
  if (s === '-') return null;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

function cleanStr(v) {
  if (v === undefined || v === null || v === '-') return null;
  const s = v.toString().trim();
  return s === '' || s === '-' ? null : s;
}

function parseAmount(v) {
  if (!v || v === '-') return null;
  const s = v.toString().replace(/,/g, '').trim();
  return s === '' ? null : s;
}

// ── POST /api/import/excel ───────────────────────────────────
router.post('/excel', authMiddleware, upload.single('file'), async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { client_id, agent_id } = req.body;

  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
  if (!client_id) return res.status(400).json({ success: false, message: 'Client ID required' });

  const results = { master: 0, charges: 0, directors: 0, errors: [] };
  let cin = null;
  let companyName = '';

  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });

    // Get agent name
    let agentName = null;
    if (agent_id) {
      const ag = await db.query('SELECT name FROM agents WHERE agent_id=$1', [agent_id]);
      if (ag.rows.length) agentName = ag.rows[0].name;
    }

    // ── Sheet 1: MasterData (key-value rows) ──────────────────
    const mdSheet = wb.Sheets['MasterData'] || wb.Sheets[wb.SheetNames[0]];
    if (mdSheet) {
      const rows = XLSX.utils.sheet_to_json(mdSheet, { header: 1, defval: '' });
      const kv = {};
      rows.forEach(row => {
        const key = row[0]?.toString()?.trim();
        const val = row[1]?.toString()?.trim();
        if (key && key !== 'Company Information') kv[key] = val || '';
      });

      cin = kv['CIN'] || null;
      if (!cin) {
        results.errors.push('CIN not found in MasterData sheet');
      } else {
        cin = cin.toUpperCase();
        companyName = kv['Company Name'] || '';

        // Upsert master_data (delete + insert so no constraint needed)
        await db.query('DELETE FROM master_data WHERE UPPER(cin)=UPPER($1) AND client_id=$2', [cin, client_id]);
        await db.query(
          `INSERT INTO master_data
            (agent_id, client_id, cin, company_name, roc_name, registration_number,
             date_of_incorporation, email_id, registered_address, listed_in_stock_exchange,
             category, subcategory, class_of_company, active_compliance,
             authorised_capital, paid_up_capital, date_of_last_agm, date_of_balance_sheet,
             company_status, roc_office, rd_region)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            agent_id || null, client_id, cin,
            cleanStr(kv['Company Name']),
            cleanStr(kv['ROC Name']),
            cleanStr(kv['Registration Number']),
            parseDate(kv['Date of Incorporation']),
            cleanStr(kv['Email Id']),
            cleanStr(kv['Registered Address']),
            cleanStr(kv['Listed in Stock Exchange(s)']),
            cleanStr(kv['Category of Company']),
            cleanStr(kv['Subcategory']),
            cleanStr(kv['Class of Company']),
            cleanStr(kv['ACTIVE compliance']),
            parseAmount(kv['Authorised Capital (Rs)']),
            parseAmount(kv['Paid up Capital (Rs)']),
            parseDate(kv['Date of last AGM']),
            parseDate(kv['Date of Balance Sheet']),
            cleanStr(kv['Company Status']) || 'Active',
            cleanStr(kv['ROC (name and office)']),
            cleanStr(kv['RD (name and Region)']),
          ]
        );

        // Also sync to companies table (used by compliance tracking)
        await db.query(
          `INSERT INTO companies
            (cin, company_name, client_id, agent_name, company_type, incorporation_date,
             registered_office, email, authorized_capital, paid_up_capital,
             last_agm_date, last_balance_sheet_date, company_status, mca_filing_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           ON CONFLICT (organization_id, upper(cin)) DO UPDATE SET
             company_name=EXCLUDED.company_name, client_id=EXCLUDED.client_id,
             agent_name=COALESCE(EXCLUDED.agent_name, companies.agent_name),
             company_type=EXCLUDED.company_type,
             incorporation_date=COALESCE(EXCLUDED.incorporation_date, companies.incorporation_date),
             registered_office=EXCLUDED.registered_office, email=EXCLUDED.email,
             authorized_capital=EXCLUDED.authorized_capital, paid_up_capital=EXCLUDED.paid_up_capital,
             last_agm_date=EXCLUDED.last_agm_date,
             last_balance_sheet_date=EXCLUDED.last_balance_sheet_date,
             company_status=EXCLUDED.company_status, mca_filing_status=EXCLUDED.mca_filing_status,
             updated_at=NOW()`,
          [
            cin, companyName, client_id, agentName,
            cleanStr(kv['Class of Company']),
            parseDate(kv['Date of Incorporation']),
            cleanStr(kv['Registered Address']),
            cleanStr(kv['Email Id']),
            parseAmount(kv['Authorised Capital (Rs)']),
            parseAmount(kv['Paid up Capital (Rs)']),
            parseDate(kv['Date of last AGM']),
            parseDate(kv['Date of Balance Sheet']),
            cleanStr(kv['Company Status']) || 'Active',
            cleanStr(kv['ACTIVE compliance']),
          ]
        );
        results.master = 1;
      }
    }

    if (!cin) {
      return res.json({ success: false, message: 'CIN not found in file', results });
    }

    // ── Sheet 2: IndexOfCharges ───────────────────────────────
    const icSheet = wb.Sheets['IndexOfCharges'] || wb.Sheets[wb.SheetNames[1]];
    if (icSheet) {
      const rows = XLSX.utils.sheet_to_json(icSheet, { header: 1, defval: '' });
      // Row 0 = section title, Row 1 = column headers, Row 2+ = data
      const dataRows = rows.slice(2).filter(r => r[0]?.toString().trim() !== '');

      await db.query('DELETE FROM index_of_charges WHERE UPPER(cin)=UPPER($1) AND client_id=$2', [cin, client_id]);
      for (const r of dataRows) {
        const srNo = parseInt(r[0]);
        if (!srNo) continue;
        await db.query(
          `INSERT INTO index_of_charges
            (agent_id, client_id, cin, sr_no, srn, charge_id, charge_holder_name,
             date_of_creation, date_of_modification, date_of_satisfaction,
             amount, address, charge_registered_by_other, asset_holder_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            agent_id || null, client_id, cin, srNo,
            cleanStr(r[1]), cleanStr(r[2]), cleanStr(r[3]),
            cleanStr(r[4]) === '-' ? null : cleanStr(r[4]),
            cleanStr(r[5]) === '-' ? null : cleanStr(r[5]),
            cleanStr(r[6]) === '-' ? null : cleanStr(r[6]),
            parseAmount(r[7]), cleanStr(r[8]),
            cleanStr(r[9]), cleanStr(r[10]),
          ]
        );
        results.charges++;
      }
    }

    // ── Sheet 3: Director Details ─────────────────────────────
    const ddSheet = wb.Sheets['Director Details'] || wb.Sheets[wb.SheetNames[2]];
    if (ddSheet) {
      const rows = XLSX.utils.sheet_to_json(ddSheet, { header: 1, defval: '' });
      const dataRows = rows.slice(2).filter(r => r[0]?.toString().trim() !== '');

      await db.query('DELETE FROM director_details WHERE UPPER(cin)=UPPER($1) AND client_id=$2', [cin, client_id]);
      for (const r of dataRows) {
        const srNo = parseInt(r[0]);
        if (!srNo) continue;
        await db.query(
          `INSERT INTO director_details
            (agent_id, client_id, cin, sr_no, din, director_name, designation, category,
             appointment_date, resignation_date, status2)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            agent_id || null, client_id, cin, srNo,
            cleanStr(r[1]), cleanStr(r[2]), cleanStr(r[3]), cleanStr(r[4]),
            cleanStr(r[5]) === '-' ? null : cleanStr(r[5]),
            cleanStr(r[6]) === '-' ? null : cleanStr(r[6]),
            cleanStr(r[7]),
          ]
        );
        results.directors++;

        // Sync clean DINs (8-digit numbers) to directors table for compliance use
        const din = cleanStr(r[1]);
        if (din && /^\d{8}$/.test(din)) {
          await db.query(
            `INSERT INTO directors (cin, company_name, client_id, agent_name, din, director_name,
               designation, date_of_appointment, date_of_cessation, director_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Active')
             ON CONFLICT DO NOTHING`,
            [
              cin, companyName, client_id, agentName,
              din, cleanStr(r[2]), cleanStr(r[3]),
              parseDate(r[5]), parseDate(r[6]),
            ]
          );
        }
      }
    }

    res.json({
      success: true,
      cin,
      company_name: companyName,
      message: `Import successful! MasterData: ${results.master ? 'OK' : 'Skipped'} | Charges: ${results.charges} | Directors: ${results.directors}`,
      results,
    });

  } catch (err) {
    console.error('Excel import error:', err);
    res.status(500).json({ success: false, message: 'Import failed: ' + err.message, results });
  }
});

module.exports = router;
