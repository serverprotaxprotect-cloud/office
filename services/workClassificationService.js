const db = require('../db');

// Resolves the department/category snapshot for a task's work name from the
// work_names master. Match order: work_name_id, then exact name match, then
// the caller-supplied fallback (for auto-generated tasks whose names never
// appear verbatim in the master). Only unmatched names without a fallback are
// flagged as custom work (employee "Other Work" entries).
async function resolveWorkClassification(conn, { work_name, work_name_id, fallback }) {
  const runner = conn || db;

  if (work_name_id) {
    const r = await runner.query(
      `SELECT id, work_category, grouping_name, department FROM work_names WHERE id=$1`,
      [work_name_id]
    );
    if (r.rows[0]) return fromMaster(r.rows[0]);
  }

  if (work_name) {
    const r = await runner.query(
      `SELECT id, work_category, grouping_name, department
         FROM work_names
        WHERE lower(name)=lower($1)
        ORDER BY organization_id NULLS FIRST, id
        LIMIT 1`,
      [work_name]
    );
    if (r.rows[0]) return fromMaster(r.rows[0]);
  }

  if (fallback) {
    return {
      work_name_id: null,
      work_category: fallback.work_category || null,
      grouping_name: fallback.grouping_name || null,
      department: fallback.department || null,
      is_custom_work: false,
    };
  }

  return { work_name_id: null, work_category: null, grouping_name: null, department: null, is_custom_work: true };
}

function fromMaster(row) {
  return {
    work_name_id: row.id,
    work_category: row.work_category || null,
    grouping_name: row.grouping_name || null,
    department: row.department || null,
    is_custom_work: false,
  };
}

module.exports = { resolveWorkClassification };
