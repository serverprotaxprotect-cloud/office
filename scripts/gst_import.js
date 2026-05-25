const path = require('path');
require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}
const db = require('../db');
const { parseGSTWorkbook } = require('../utils/gstUtils');
const { buildPreview, importRows } = require('../services/gstImportService');

function argFile() {
  return process.argv.find(a => a.toLowerCase().endsWith('.xlsx')) || 'C:/Users/HP/Downloads/GST_CLIENTS.xlsx';
}

async function main() {
  const file = path.resolve(argFile());
  const apply = process.argv.includes('--apply');
  const parsed = parseGSTWorkbook(file);
  const preview = await buildPreview(parsed);
  console.log(JSON.stringify({ file, sheet: parsed.sheetName, preview }, null, 2));

  if (!apply) {
    console.log('Dry run only. Re-run with --apply after DB approval.');
    return;
  }

  if (preview.missing_client_ids.length) {
    throw new Error(`Missing client IDs: ${preview.missing_client_ids.join(', ')}`);
  }
  if (preview.missing_assignee_ids.length) {
    throw new Error(`Missing active assignee IDs: ${preview.missing_assignee_ids.join(', ')}`);
  }

  const imported = await importRows(parsed);
  console.log(JSON.stringify({ imported }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try { await db.pool.end(); } catch {}
});
