require('dotenv').config();
const XLSX = require('xlsx');
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function toMinutes(t) {
  if (!t) return 0;
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function parseDateTime(val) {
  if (!val && val !== 0) return { dateStr: null, timeStr: null };
  if (typeof val === 'number') {
    const intPart  = Math.floor(val);
    const fracPart = val - intPart;
    const totalSec = Math.round(fracPart * 86400);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const d = new Date(Date.UTC(1899, 11, 30 + intPart));
    const dateStr = d.toISOString().split('T')[0];
    const timeStr = (h > 0 || m > 0) ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : null;
    return { dateStr, timeStr };
  }
  const s = val.toString().trim();
  let m2 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}:\d{2}(:\d{2})?)$/);
  if (m2) return { dateStr: `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`, timeStr: m2[4] };
  let m3 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m3) return { dateStr: `${m3[3]}-${m3[2].padStart(2,'0')}-${m3[1].padStart(2,'0')}`, timeStr: null };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { dateStr: s, timeStr: null };
  return { dateStr: null, timeStr: null };
}

function parseTimeOnly(val) {
  if (!val && val !== 0) return null;
  const s = val.toString().trim();
  if (!s || s === '-') return null;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const parts = s.split(':');
    return `${parts[0].padStart(2,'0')}:${parts[1]}:${parts[2] || '00'}`;
  }
  if (typeof val === 'number') {
    const frac = val - Math.floor(val);
    if (frac > 0) {
      const sec = Math.round(frac * 86400);
      return `${String(Math.floor(sec/3600)).padStart(2,'0')}:${String(Math.floor((sec%3600)/60)).padStart(2,'0')}:00`;
    }
    return null;
  }
  return null;
}

async function main() {
  const db = pool;
  const filePath = 'C:\\Users\\HP\\Downloads\\ATD.xlsx';

  console.log('Reading:', filePath);
  const wb = XLSX.read(require('fs').readFileSync(filePath), { type: 'buffer', cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const headers = rows[0].map(h => h.toString().toLowerCase().trim());

  const col = {
    date:     headers.findIndex(h => h.includes('date')),
    emp_id:   headers.findIndex(h => (h.includes('emp') && h.includes('id')) || h === 'employee id'),
    name:     headers.findIndex(h => h === 'name' || h === 'employee name'),
    action:   headers.findIndex(h => h === 'action' || h === 'type' || h === 'punch'),
    in:       headers.findIndex(h => (h.includes('in') || h.includes('login')) && !h.includes('emp') && !h.includes('lati') && !h.includes('name') && !h.includes('out')),
    out:      headers.findIndex(h => h.includes('out') || h.includes('logout')),
    time:     headers.findIndex(h => h.includes('time') && !h.includes('date') && !h.includes('over')),
    location: headers.findIndex(h => h.includes('location') || h.includes('address') || h.includes('place')),
    remark:   headers.findIndex(h => h.includes('remark') || h.includes('note')),
  };

  console.log('Format headers:', rows[0]);
  console.log('Columns:', col);

  const cfgRes = await db.query('SELECT key, value FROM attendance_settings');
  const cfg = {};
  cfgRes.rows.forEach(r => { cfg[r.key] = r.value; });
  const fullDayMins     = parseInt(cfg.FULL_DAY_MINUTES    || '480');
  const halfDayMins     = parseInt(cfg.HALF_DAY_MINUTES    || '240');
  const officeStartMins = toMinutes(cfg.OFFICE_START_TIME  || '10:00:00');
  const lateThreshold   = parseInt(cfg.LATE_THRESHOLD_MINUTES || '0');

  const empRes = await db.query('SELECT emp_id, name, formal_name FROM emplist');
  const empCache = {};
  empRes.rows.forEach(e => { if (e.emp_id) empCache[e.emp_id.toLowerCase()] = e; });

  const dataRows = rows.slice(1).filter(r => r.some(c => c !== ''));

  const hasActionCol = col.action >= 0 &&
    dataRows.some(r => /^(login|logout|in|out)$/i.test((r[col.action] || '').toString().trim()));

  console.log(`Format: ${hasActionCol ? 'PUNCH LOG' : 'SUMMARY'}, Rows: ${dataRows.length}`);

  async function upsert(empId, empName, dateStr, inTime, outTime, lateMinutes, workingHours, finalStatus, remark, location) {
    const d = new Date(dateStr);
    const month = d.getMonth() + 1;
    const year  = d.getFullYear();

    const ex = await db.query('SELECT emp_id FROM daily_attendance WHERE emp_id=$1 AND date::date=$2', [empId, dateStr]);
    if (ex.rows.length > 0) {
      await db.query(
        `UPDATE daily_attendance SET
           first_in=COALESCE($1,first_in), last_out=COALESCE($2,last_out),
           working_hours=COALESCE($3,working_hours), final_status=$4,
           late_minutes=$5, remark=COALESCE($6,remark), approved_by='Excel Import', approved_at=NOW()
         WHERE emp_id=$7 AND date::date=$8`,
        [inTime, outTime, workingHours, finalStatus, lateMinutes, remark, empId, dateStr]
      );
    } else {
      await db.query(
        `INSERT INTO daily_attendance
           (date, emp_id, employee_name, formal_name, first_in, last_out,
            working_hours, final_status, late_minutes, month, year, remark, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Excel Import',NOW())`,
        [dateStr, empId, empName, empName, inTime, outTime, workingHours, finalStatus, lateMinutes, month, year, remark]
      );
    }

    if (inTime) {
      await db.query(
        `INSERT INTO attendance_log (log_id, date, emp_id, employee_name, formal_name, action, time, address, marked_by, created_at)
         VALUES ($1,$2,$3,$4,$5,'IN',$6,$7,'Excel-Import',NOW()) ON CONFLICT DO NOTHING`,
        ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(), dateStr, empId, empName, empName, inTime, location || null]
      ).catch(() => {});
    }
    if (outTime) {
      await db.query(
        `INSERT INTO attendance_log (log_id, date, emp_id, employee_name, formal_name, action, time, address, marked_by, created_at)
         VALUES ($1,$2,$3,$4,$5,'OUT',$6,$7,'Excel-Import',NOW()) ON CONFLICT DO NOTHING`,
        ['ATD-' + crypto.randomBytes(4).toString('hex').toUpperCase(), dateStr, empId, empName, empName, outTime, location || null]
      ).catch(() => {});
    }
  }

  let imported = 0, skipped = 0;

  if (hasActionCol) {
    const groups = new Map();
    for (const row of dataRows) {
      const { dateStr, timeStr: dtTime } = parseDateTime(row[col.date]);
      if (!dateStr) continue;
      const empId = row[col.emp_id]?.toString().trim();
      if (!empId) continue;
      const action = (row[col.action] || '').toString().trim().toLowerCase();
      let timeStr = dtTime;
      if (!timeStr && col.time >= 0) timeStr = parseTimeOnly(row[col.time]);
      const loc = col.location >= 0 ? (row[col.location]?.toString().trim() || null) : null;
      const key = `${dateStr}|${empId}`;
      if (!groups.has(key)) groups.set(key, { dateStr, empId, empName: '', logins: [], logouts: [], location: null });
      const g = groups.get(key);
      if (!g.empName && col.name >= 0 && row[col.name]) g.empName = row[col.name].toString().trim();
      if (loc && !g.location) g.location = loc;
      if (timeStr) {
        if (action === 'login' || action === 'in') g.logins.push(timeStr);
        else if (action === 'logout' || action === 'out') g.logouts.push(timeStr);
      } else {
        if (action === 'login' || action === 'in') g.logins.push(null);
        else g.logouts.push(null);
      }
    }
    for (const [key, g] of groups) {
      const emp = empCache[g.empId.toLowerCase()];
      if (!emp) { skipped++; continue; }
      const empName = emp.formal_name || emp.name;
      const inTime  = g.logins[0]  || null;
      const outTime = g.logouts[g.logouts.length - 1] || null;
      let wh = null, fs = inTime ? 'Pending' : 'Absent', late = 0;
      if (inTime) late = Math.max(0, toMinutes(inTime) - officeStartMins - lateThreshold);
      if (inTime && outTime) {
        const w = Math.max(0, toMinutes(outTime) - toMinutes(inTime));
        wh = `${Math.floor(w/60)}h ${w%60}m`;
        fs = w >= fullDayMins ? 'Present' : w >= halfDayMins ? 'Half Day' : 'Short Day';
      }
      try { await upsert(emp.emp_id, empName, g.dateStr, inTime, outTime, late, wh, fs, null, g.location); imported++; process.stdout.write(`\r  Imported: ${imported}`); }
      catch(e) { console.log(`\n  ERROR ${key}: ${e.message}`); skipped++; }
    }
  } else {
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const { dateStr } = parseDateTime(row[col.date]);
      if (!dateStr) { skipped++; continue; }
      const empId = row[col.emp_id]?.toString().trim();
      if (!empId) { skipped++; continue; }
      const emp = empCache[empId.toLowerCase()];
      if (!emp) { skipped++; continue; }
      const empName = emp.formal_name || emp.name;
      const inTime   = col.in       >= 0 ? parseTimeOnly(row[col.in])              : null;
      const outTime  = col.out      >= 0 ? parseTimeOnly(row[col.out])             : null;
      const location = col.location >= 0 ? (row[col.location]?.toString().trim() || null) : null;
      const remark   = col.remark   >= 0 ? (row[col.remark]?.toString().trim()  || null) : null;
      let wh = null, fs = inTime ? 'Pending' : 'Absent', late = 0;
      if (inTime) late = Math.max(0, toMinutes(inTime) - officeStartMins - lateThreshold);
      if (inTime && outTime) {
        const w = Math.max(0, toMinutes(outTime) - toMinutes(inTime));
        wh = `${Math.floor(w/60)}h ${w%60}m`;
        fs = w >= fullDayMins ? 'Present' : w >= halfDayMins ? 'Half Day' : 'Short Day';
      }
      try { await upsert(emp.emp_id, empName, dateStr, inTime, outTime, late, wh, fs, remark, location); imported++; process.stdout.write(`\r  Imported: ${imported}`); }
      catch(e) { console.log(`\n  ERROR row ${i+2}: ${e.message}`); skipped++; }
    }
  }

  console.log(`\n\n✅ DONE! Imported: ${imported}, Skipped: ${skipped}`);
  await pool.end();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
