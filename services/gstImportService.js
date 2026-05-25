const db = require('../db');
const {
  encryptText,
  normalizeGstNo,
  periodLabel,
  financialYearForPeriod,
  getDueDate,
} = require('../utils/gstUtils');

async function buildPreview(parsed) {
  const clientIds = [...new Set(parsed.rows.map(r => r.client_id).filter(Boolean))];
  const assignees = [...new Set(parsed.rows.map(r => r.assigned_to_id).filter(Boolean))];
  const clients = clientIds.length
    ? await db.query('SELECT client_id FROM clients WHERE client_id = ANY($1)', [clientIds])
    : { rows: [] };
  const employees = assignees.length
    ? await db.query("SELECT emp_id, formal_name, name FROM emplist WHERE emp_id = ANY($1) AND status='Active'", [assignees])
    : { rows: [] };

  const foundClients = new Set(clients.rows.map(r => r.client_id));
  const foundEmployees = new Map(employees.rows.map(r => [r.emp_id, r]));
  const gstCounts = new Map();
  parsed.rows.forEach(r => {
    if (r.gst_no) gstCounts.set(r.gst_no, (gstCounts.get(r.gst_no) || 0) + 1);
  });

  return {
    ...parsed.summary,
    missing_client_ids: clientIds.filter(id => !foundClients.has(id)),
    missing_assignee_ids: assignees.filter(id => !foundEmployees.has(id)),
    duplicate_gst_in_file: [...gstCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([gst_no, count]) => ({ gst_no, count })),
  };
}

async function findGSTClient(conn, row) {
  if (row.gst_no) {
    const byGst = await conn.query(
      `SELECT id FROM gst_clients WHERE UPPER(gst_no)=UPPER($1) LIMIT 1`,
      [row.gst_no]
    );
    if (byGst.rows.length) return byGst.rows[0].id;
  }
  const byClientFirm = await conn.query(
    `SELECT id FROM gst_clients
     WHERE client_id=$1
       AND UPPER(firm_name)=UPPER($2)
       AND (gst_no IS NULL OR BTRIM(gst_no)='')
     ORDER BY id LIMIT 1`,
    [row.client_id, row.firm_name]
  );
  return byClientFirm.rows[0]?.id || null;
}

async function importRows(parsed) {
  const conn = await db.pool.connect();
  const summary = {
    clients_inserted: 0,
    clients_updated: 0,
    filings_upserted: 0,
    skipped_rows: 0,
  };

  try {
    await conn.query('BEGIN');
    for (const row of parsed.rows) {
      if (!row.client_id || !row.firm_name) {
        summary.skipped_rows += 1;
        continue;
      }

      const client = await conn.query(
        `SELECT client_id, agent_id, agent_name, legal_name, business_name FROM clients WHERE client_id=$1`,
        [row.client_id]
      );
      if (!client.rows.length) {
        summary.skipped_rows += 1;
        continue;
      }

      let assigneeName = null;
      if (row.assigned_to_id) {
        const emp = await conn.query(
          "SELECT formal_name, name FROM emplist WHERE emp_id=$1 AND status='Active'",
          [row.assigned_to_id]
        );
        assigneeName = emp.rows[0] ? (emp.rows[0].formal_name || emp.rows[0].name) : null;
      }

      const c = client.rows[0];
      const passwordEnc = row.gst_password ? encryptText(row.gst_password) : null;
      const existingId = await findGSTClient(conn, row);
      let gstClientId;
      if (existingId) {
        const update = await conn.query(
          `UPDATE gst_clients SET
             firm_name=$1,
             gst_no=NULLIF($2,''),
             gst_login_id=COALESCE(NULLIF($3,''), gst_login_id),
             gst_password_enc=COALESCE($4, gst_password_enc),
             agent_id=$5,
             agent_name=$6,
             filing_frequency=COALESCE(filing_frequency, 'Monthly'),
             default_assignee_id=COALESCE(NULLIF($7,''), default_assignee_id),
             default_assignee_name=COALESCE($8, default_assignee_name),
             status=COALESCE(status, 'Active'),
             source_sheet=$9,
             source_row=$10,
             updated_by_id='IMPORT',
             updated_by_name='GST Excel Import',
             updated_at=NOW()
           WHERE id=$11
           RETURNING id`,
          [
            row.firm_name,
            normalizeGstNo(row.gst_no),
            row.gst_login_id,
            passwordEnc,
            c.agent_id || null,
            c.agent_name || null,
            row.assigned_to_id || '',
            assigneeName,
            row.source_sheet,
            row.source_row,
            existingId,
          ]
        );
        gstClientId = update.rows[0].id;
        summary.clients_updated += 1;
      } else {
        const insert = await conn.query(
          `INSERT INTO gst_clients
            (client_id, firm_name, gst_no, gst_login_id, gst_password_enc, agent_id, agent_name,
             filing_frequency, default_assignee_id, default_assignee_name, status,
             source_sheet, source_row, created_by_id, created_by_name, updated_by_id, updated_by_name)
           VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,$7,'Monthly',$8,$9,'Active',$10,$11,'IMPORT','GST Excel Import','IMPORT','GST Excel Import')
           RETURNING id`,
          [
            row.client_id,
            row.firm_name,
            normalizeGstNo(row.gst_no),
            row.gst_login_id,
            passwordEnc,
            c.agent_id || null,
            c.agent_name || null,
            row.assigned_to_id || null,
            assigneeName,
            row.source_sheet,
            row.source_row,
          ]
        );
        gstClientId = insert.rows[0].id;
        summary.clients_inserted += 1;
      }

      for (const filing of row.filings) {
        const dueDate = getDueDate({
          taxYear: filing.tax_year,
          taxMonth: filing.tax_month,
          returnType: filing.return_type,
          frequency: 'Monthly',
        });
        await conn.query(
          `INSERT INTO gst_filing_records
            (gst_client_id, client_id, firm_name, gst_no, return_type, tax_year, tax_month,
             financial_year, period_label, due_date, assigned_to_id, assigned_to_name, status,
             generated_from, source_status, created_by_id, created_by_name)
           VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8,$9,$10,$11,$12,$13,'excel_import',$14,'IMPORT','GST Excel Import')
           ON CONFLICT (gst_client_id, tax_year, tax_month, return_type) DO UPDATE SET
             firm_name=EXCLUDED.firm_name,
             gst_no=EXCLUDED.gst_no,
             due_date=EXCLUDED.due_date,
             assigned_to_id=COALESCE(gst_filing_records.assigned_to_id, EXCLUDED.assigned_to_id),
             assigned_to_name=COALESCE(gst_filing_records.assigned_to_name, EXCLUDED.assigned_to_name),
             status=CASE WHEN gst_filing_records.last_status_at IS NULL THEN EXCLUDED.status ELSE gst_filing_records.status END,
             source_status=EXCLUDED.source_status,
             updated_at=NOW()`,
          [
            gstClientId,
            row.client_id,
            row.firm_name,
            normalizeGstNo(row.gst_no),
            filing.return_type,
            filing.tax_year,
            filing.tax_month,
            financialYearForPeriod(filing.tax_year, filing.tax_month),
            periodLabel(filing.tax_year, filing.tax_month),
            dueDate,
            row.assigned_to_id || null,
            assigneeName,
            filing.status,
            filing.source_status || null,
          ]
        );
        summary.filings_upserted += 1;
      }
    }
    await conn.query('COMMIT');
    return summary;
  } catch (err) {
    await conn.query('ROLLBACK');
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { buildPreview, importRows };
