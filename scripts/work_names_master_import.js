require('dotenv').config();
if (process.env.OWNER_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.OWNER_DATABASE_URL;
}

const path = require('path');
const XLSX = require('xlsx');
const db = require('../db');

const DEFAULT_FILE = 'C:/Users/HP/Downloads/Completed_CA_CS_CMA_Work_Master.xlsx';

function clean(value) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || null;
}

function loadRows(file) {
  const workbook = XLSX.readFile(file);
  const sheet = workbook.Sheets.Sheet1 || workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows
    .map((row, index) => ({
      row_no: index + 2,
      name: clean(row['Name of Work']),
      work_category: clean(row['Work Category']),
      grouping_name: clean(row.Grouping),
      department: clean(row.Department),
      sac_code: clean(row['SAC Code']),
      sac_description: clean(row['SAC Description']),
      source: 'Completed_CA_CS_CMA_Work_Master.xlsx',
    }))
    .filter(row => row.name);
}

function summarize(rows) {
  const keyCounts = new Map();
  const nameCounts = new Map();
  for (const row of rows) {
    const key = [row.name, row.work_category, row.department]
      .map(value => String(value || '').toLowerCase())
      .join('|');
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    const nameKey = row.name.toLowerCase();
    nameCounts.set(nameKey, (nameCounts.get(nameKey) || 0) + 1);
  }
  return {
    valid_rows: rows.length,
    unique_name_category_department: keyCounts.size,
    duplicate_import_keys: [...keyCounts.values()].filter(count => count > 1).length,
    duplicate_work_names: [...nameCounts.values()].filter(count => count > 1).length,
  };
}

async function ensureSchema(conn) {
  const statements = [
    `ALTER TABLE work_names ALTER COLUMN organization_id DROP NOT NULL`,
    `ALTER TABLE work_names ALTER COLUMN organization_id DROP DEFAULT`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS work_category VARCHAR(255)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS grouping_name VARCHAR(255)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS department VARCHAR(150)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS sac_code VARCHAR(30)`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS sac_description TEXT`,
    `ALTER TABLE work_names ADD COLUMN IF NOT EXISTS source VARCHAR(150)`,
    `DROP INDEX IF EXISTS ux_work_names_org_name_lower`,
    `DROP INDEX IF EXISTS ux_work_names_org_name_category_department`,
    `DROP INDEX IF EXISTS ux_work_names_central_name_category_department`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_work_names_org_name_category_department
       ON work_names (
         organization_id,
         lower(name),
         lower(coalesce(work_category,'')),
         lower(coalesce(department,''))
       )
       WHERE organization_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_work_names_central_name_category_department
       ON work_names (
         lower(name),
         lower(coalesce(work_category,'')),
         lower(coalesce(department,''))
       )
       WHERE organization_id IS NULL`,
    `ALTER TABLE work_names NO FORCE ROW LEVEL SECURITY`,
    `ALTER TABLE work_names DISABLE ROW LEVEL SECURITY`,
  ];
  for (const statement of statements) await conn.query(statement);
}

async function insertCentralRows(conn, rows) {
  const values = [];
  const placeholders = rows.map((row, index) => {
    const base = index * 7;
    values.push(
      row.name,
      row.work_category,
      row.grouping_name,
      row.department,
      row.sac_code,
      row.sac_description,
      row.source
    );
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
  });

  await conn.query(
    `INSERT INTO work_names
       (name, work_category, grouping_name, department, sac_code, sac_description, source)
     VALUES ${placeholders.join(',')}`,
    values
  );
}

async function run() {
  const apply = process.argv.includes('--apply');
  const fileArg = process.argv.find(arg => arg.toLowerCase().endsWith('.xlsx'));
  const file = path.resolve(fileArg || DEFAULT_FILE);
  const rows = loadRows(file);
  const summary = summarize(rows);

  console.log(JSON.stringify({ file, ...summary }, null, 2));
  if (summary.duplicate_import_keys) {
    throw new Error('Import contains duplicate name/category/department rows.');
  }
  if (!apply) {
    console.log('Dry run only. Use --apply to replace the central work suggestion master.');
    await db.rawPool.end();
    return;
  }

  const conn = await db.rawPool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(`SELECT set_config('app.bypass_rls','on', true)`);
    await ensureSchema(conn);

    await conn.query(`DELETE FROM work_names`);
    await insertCentralRows(conn, rows);
    console.log(`Central master: inserted ${rows.length} work names.`);

    await conn.query('COMMIT');
    console.log('Work suggestion master import completed.');
  } catch (error) {
    await conn.query('ROLLBACK');
    console.error(error);
    process.exitCode = 1;
  } finally {
    conn.release();
    await db.rawPool.end();
  }
}

run();
