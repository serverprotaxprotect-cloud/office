const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

function photoDataUrl(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

// ── Helper: load all settings as a key-value map ─────────────
async function getSettings() {
  const r = await db.query('SELECT key, value FROM attendance_settings');
  const s = {};
  r.rows.forEach(row => { s[row.key] = row.value; });
  return s;
}

// ── IST helpers (UTC+5:30) ────────────────────────────────────
function nowIST() {
  // Always return current time in Asia/Kolkata (IST = UTC+5:30)
  return new Date(Date.now() + (5.5 * 60 * 60 * 1000));
}
function todayIST() {
  return nowIST().toISOString().split('T')[0]; // YYYY-MM-DD
}
function timeStrIST() {
  return nowIST().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
}

function dateKey(value) {
  return String(value || '').split('T')[0];
}

// Helper: "HH:MM:SS" → total minutes
function toMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = String(timeStr).split(':').map(Number);
  return h * 60 + m;
}

// Haversine distance in meters between two lat/lng points
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseCoordinate(value, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) return null;
  return num;
}

function parsePositiveNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function coordinateFallback(lat, lng) {
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

async function reverseGeocodeGoogle(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(`${lat},${lng}`)}&key=${encodeURIComponent(key)}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) {
    console.warn('Google geocode returned:', data.status, data.error_message || '');
    return null;
  }

  const result = data.results[0];
  return {
    address: result.formatted_address || coordinateFallback(lat, lng),
    formatted_address: result.formatted_address || null,
    place_id: result.place_id || null,
    location_type: result.geometry?.location_type || null,
    provider: 'google'
  };
}

async function reverseGeocodeFallback(lat, lng) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lng)}&localityLanguage=en`;
  const response = await fetch(url);
  const d = await response.json();

  const parts = [
    d.locality || d.city,
    d.localityInfo?.administrative?.find(a => a.adminLevel === 8)?.name,
    d.principalSubdivisionCode ? null : d.principalSubdivision,
    d.postcode,
    d.countryName
  ].filter(Boolean);

  return {
    address: parts.length >= 2
      ? parts.join(', ')
      : (d.display_name || coordinateFallback(lat, lng)),
    formatted_address: d.display_name || null,
    place_id: null,
    location_type: null,
    provider: 'bigdatacloud'
  };
}

async function reverseGeocode(lat, lng) {
  try {
    const google = await reverseGeocodeGoogle(lat, lng);
    if (google) return google;
  } catch (err) {
    console.error('Google geocode error:', err.message);
  }

  try {
    return await reverseGeocodeFallback(lat, lng);
  } catch (err) {
    console.error('Fallback geocode error:', err.message);
    return {
      address: coordinateFallback(lat, lng),
      formatted_address: null,
      place_id: null,
      location_type: null,
      provider: 'coordinates'
    };
  }
}

// ── GET /api/attendance/today ────────────────────────────────
router.get('/today', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  const today = todayIST();

  try {
    const [punches, summary, cfg] = await Promise.all([
      db.query(
        `SELECT action, time, latitude, longitude, accuracy_meters, address,
                formatted_address, place_id, location_type, geocode_provider,
                distance_from_office_meters, geofence_radius_meters, within_geofence,
                created_at
         FROM attendance_log WHERE emp_id=$1 AND date::date=$2 ORDER BY created_at ASC`,
        [emp_id, today]
      ),
      db.query(
        `SELECT first_in, last_out, working_hours, late_minutes, final_status, grace_minutes_granted
         FROM daily_attendance WHERE emp_id=$1 AND date::date=$2`,
        [emp_id, today]
      ),
      getSettings()
    ]);

    const firstIn  = punches.rows.find(p => p.action === 'IN');
    const lastOut  = punches.rows.find(p => p.action === 'OUT');
    const isIn     = !!firstIn && !lastOut;

    res.json({
      success: true,
      today,
      office_start: cfg.OFFICE_START_TIME || '10:00:00',
      office_end:   cfg.OFFICE_END_TIME   || '18:30:00',
      is_currently_in: isIn,
      first_in:  firstIn?.time  || null,
      last_out:  lastOut?.time  || null,
      punches:   punches.rows,
      summary:   summary.rows[0] || null,
      settings:  cfg
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/attendance/mark ─────────────────────────────────
router.post('/mark', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { action, latitude, longitude, address, device_info } = req.body;
  const accuracyMeters = parsePositiveNumber(req.body.accuracy_meters ?? req.body.accuracy);

  if (!action || !['IN', 'OUT'].includes(action.toUpperCase()))
    return res.status(400).json({ success: false, message: 'Action must be IN or OUT' });

  const upperAction = action.toUpperCase();
  const today   = todayIST();
  const timeStr = timeStrIST(); // HH:MM:SS in IST

  try {
    // ── One IN + One OUT per day rule ────────────────────────
    const existing = await db.query(
      `SELECT action FROM attendance_log WHERE emp_id=$1 AND date::date=$2 ORDER BY created_at ASC`,
      [emp_id, today]
    );
    const hasIN  = existing.rows.some(p => p.action === 'IN');
    const hasOUT = existing.rows.some(p => p.action === 'OUT');

    if (upperAction === 'IN') {
      if (hasIN) return res.status(400).json({ success: false, message: 'Aaj aap IN pehle se mark kar chuke hain. Ek din mein sirf ek baar IN allowed hai.' });
    } else {
      if (!hasIN)  return res.status(400).json({ success: false, message: 'Pehle IN punch karo, tab OUT kar sakte hain.' });
      if (hasOUT)  return res.status(400).json({ success: false, message: 'Aaj aap OUT pehle se mark kar chuke hain. Ek din mein sirf ek baar OUT allowed hai.' });
    }

    // ── Load settings ────────────────────────────────────────
    const cfg = await getSettings();
    const latNum = parseCoordinate(latitude, -90, 90);
    const lngNum = parseCoordinate(longitude, -180, 180);

    // ── Geofence check ───────────────────────────────────────
    const officeLat = parseFloat(req.organization?.latitude || cfg.OFFICE_LAT || '0');
    const officeLng = parseFloat(req.organization?.longitude || cfg.OFFICE_LNG || '0');
    const geofenceRadius = parseFloat(req.organization?.attendance_radius_meters || cfg.GEOFENCE_RADIUS_METERS || '400');
    let distanceMeters = null;
    let withinGeofence = null;
    if (officeLat && officeLng) {
      if (latNum === null || lngNum === null)
        return res.status(400).json({ success: false, message: 'Location permission required. Please enable GPS and try again.' });
      distanceMeters = haversineMeters(latNum, lngNum, officeLat, officeLng);
      withinGeofence = distanceMeters <= geofenceRadius;
      if (!withinGeofence)
        return res.status(400).json({
          success: false,
          message: `Aap office se bahut door hain (${Math.round(distanceMeters)} meters). Attendance sirf ${geofenceRadius} meter ke andar mark ho sakti hai.`,
          distance_meters: Math.round(distanceMeters),
          allowed_radius: geofenceRadius
        });
    }
    const resolvedLocation = latNum !== null && lngNum !== null
      ? await reverseGeocode(latNum, lngNum)
      : { address: address || null, formatted_address: null, place_id: null, location_type: null, provider: null };

    const officeStartMins = toMinutes(cfg.OFFICE_START_TIME || '10:00:00');
    const lateThreshold   = parseInt(cfg.LATE_THRESHOLD_MINUTES || '0');
    const fullDayMins     = parseInt(cfg.FULL_DAY_MINUTES  || '480');
    const halfDayMins     = parseInt(cfg.HALF_DAY_MINUTES  || '240');

    const logId = 'ATD-' + uuidv4().toUpperCase().replace(/-/g, '').slice(0, 8);

    await db.query(
      `INSERT INTO attendance_log
         (log_id, date, emp_id, employee_name, formal_name, action, time,
          latitude, longitude, accuracy_meters, address, formatted_address,
          place_id, location_type, geocode_provider, distance_from_office_meters,
          geofence_radius_meters, within_geofence, device_info, marked_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'Self',NOW())`,
      [logId, today, emp_id, name, formal_name || name, upperAction, timeStr,
       latNum, lngNum, accuracyMeters, resolvedLocation.address || address || null,
       resolvedLocation.formatted_address || null, resolvedLocation.place_id || null,
       resolvedLocation.location_type || null, resolvedLocation.provider || null,
       distanceMeters === null ? null : Math.round(distanceMeters),
       Number.isFinite(geofenceRadius) ? Math.round(geofenceRadius) : null,
       withinGeofence, device_info || null]
    );

    const istNow = nowIST();
    const month  = istNow.getUTCMonth() + 1;
    const year   = istNow.getUTCFullYear();

    if (upperAction === 'IN') {
      // ── Calculate late minutes ─────────────────────────────
      const checkInMins = toMinutes(timeStr);
      const rawLate     = checkInMins - officeStartMins - lateThreshold;
      const lateMinutes = Math.max(0, rawLate);

      await db.query(
        `INSERT INTO daily_attendance
           (date, emp_id, employee_name, formal_name, first_in,
            late_minutes, early_leave_minutes, grace_minutes_granted,
            final_status, month, year)
         VALUES ($1,$2,$3,$4,$5,$6,0,0,'Pending',$7,$8)
         ON CONFLICT DO NOTHING`,
        [today, emp_id, name, formal_name || name, timeStr, lateMinutes, month, year]
      );

    } else {
      // ── OUT: calculate working hours and final status ──────
      const inRow = await db.query(
        `SELECT time FROM attendance_log
         WHERE emp_id=$1 AND date::date=$2 AND action='IN'
         ORDER BY created_at ASC LIMIT 1`,
        [emp_id, today]
      );

      if (inRow.rows.length > 0) {
        const inMins  = toMinutes(inRow.rows[0].time);
        const outMins = toMinutes(timeStr);
        const worked  = Math.max(0, outMins - inMins);
        const wh      = Math.floor(worked / 60);
        const wm      = worked % 60;
        const workingHours = `${wh}h ${wm}m`;

        // Determine status from settings
        let finalStatus = 'Absent';
        if (worked >= fullDayMins)     finalStatus = 'Present';
        else if (worked >= halfDayMins) finalStatus = 'Half Day';
        else                            finalStatus = 'Short Day';

        await db.query(
          `UPDATE daily_attendance
           SET last_out=$1, working_hours=$2, final_status=$3
           WHERE emp_id=$4 AND date::date=$5`,
          [timeStr, workingHours, finalStatus, emp_id, today]
        );
      }
    }

    const statusMsg = upperAction === 'IN'
      ? 'Attendance IN marked!'
      : 'Attendance OUT marked!';

    res.json({
      success: true,
      message: statusMsg,
      action: upperAction,
      time: timeStr,
      date: today,
      location: {
        latitude: latNum,
        longitude: lngNum,
        accuracy_meters: accuracyMeters,
        address: resolvedLocation.address || null,
        provider: resolvedLocation.provider || null,
        distance_from_office_meters: distanceMeters === null ? null : Math.round(distanceMeters),
        within_geofence: withinGeofence
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/history ───────────────────────────────
router.get('/history', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  const month = parseInt(req.query.month) || (nowIST().getUTCMonth() + 1);
  const year  = parseInt(req.query.year)  || nowIST().getUTCFullYear();

  try {
    const result = await db.query(
      `SELECT to_char(date::date, 'YYYY-MM-DD') AS date,
              first_in, last_out, working_hours, late_minutes,
              early_leave_minutes, final_status, remark
       FROM daily_attendance WHERE emp_id=$1 AND month=$2 AND year=$3
       ORDER BY date ASC`,
      [emp_id, month, year]
    );
    const rows    = result.rows;
    const present = rows.filter(r => r.final_status === 'Present').length;
    const late    = rows.filter(r => r.late_minutes > 0).length;
    const pending = rows.filter(r => r.final_status === 'Pending').length;
    const halfDay = rows.filter(r => r.final_status === 'Half Day').length;

    res.json({
      success: true, month, year,
      records: rows,
      summary: { total: rows.length, present, late, pending, half_day: halfDay }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/profile ───────────────────────────────
router.get('/profile', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    const r = await db.query(
      `SELECT emp_id, name, formal_name, designation, email_id,
              mobile_no, blood_group, date_of_joining, status, photo
       FROM emplist WHERE emp_id=$1`,
      [emp_id]
    );
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, employee: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/profile/photo', authMiddleware, upload.single('photo'), async (req, res) => {
  const empId = req.user.emp_id || req.user.username || '';
  const userId = Number(req.user.id) || null;
  const displayName = req.user.formal_name || req.user.name || '';
  const email = req.user.email_id || '';
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'Photo required' });
    if (!String(req.file.mimetype || '').startsWith('image/')) {
      return res.status(400).json({ success: false, message: 'Only image files allowed' });
    }
    const photo = photoDataUrl(req.file);
    let r = await db.query(
      `UPDATE emplist
       SET photo=$1
       WHERE (
         lower(emp_id)=lower($2)
         OR id=$3
         OR lower(coalesce(formal_name,''))=lower($4)
         OR lower(coalesce(name,''))=lower($4)
         OR lower(coalesce(email_id,''))=lower($5)
       )
       RETURNING emp_id`,
      [photo, empId, userId, displayName, email]
    );
    if (!r.rows.length && req.user.organization_id) {
      r = await db.runWithTenant({ bypassTenant: true }, () => db.query(
        `UPDATE emplist
         SET photo=$1
         WHERE organization_id=$2
           AND (
             lower(emp_id)=lower($3)
             OR id=$4
             OR lower(coalesce(formal_name,''))=lower($5)
             OR lower(coalesce(name,''))=lower($5)
             OR lower(coalesce(email_id,''))=lower($6)
           )
         RETURNING emp_id`,
        [photo, req.user.organization_id, empId, userId, displayName, email]
      ));
    }
    if (!r.rows.length) return res.status(404).json({ success: false, message: 'Employee not found' });
    res.json({ success: true, message: 'Profile photo updated', photo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/settings (public for display) ─────────
router.get('/settings', authMiddleware, async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ success: true, settings: s });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Helper: ensure holidays table ────────────────────────────
async function ensureHolidaysTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS holidays (id SERIAL PRIMARY KEY, organization_id INTEGER DEFAULT current_organization_id(), holiday_date DATE NOT NULL, holiday_name VARCHAR(100) NOT NULL, created_by VARCHAR(100), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS holidays_org_date_unique ON holidays(organization_id, holiday_date)`);
}

// ── Helper: ensure attendance_requests table ─────────────────
async function ensureRequestsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS attendance_requests (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER DEFAULT current_organization_id(),
      emp_id VARCHAR(50) NOT NULL,
      employee_name VARCHAR(100),
      request_date DATE NOT NULL,
      check_in_time TIME,
      check_out_time TIME,
      reason TEXT,
      status VARCHAR(20) DEFAULT 'Pending',
      reviewed_by VARCHAR(100),
      reviewed_at TIMESTAMPTZ,
      admin_remark TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── GET /api/attendance/holidays ──────────────────────────────
router.get('/holidays', authMiddleware, async (req, res) => {
  const month = parseInt(req.query.month) || (nowIST().getUTCMonth() + 1);
  const year  = parseInt(req.query.year)  || nowIST().getUTCFullYear();
  try {
    await ensureHolidaysTable();
    const result = await db.query(
      `SELECT id, to_char(holiday_date::date, 'YYYY-MM-DD') AS holiday_date, holiday_name FROM holidays
       WHERE EXTRACT(MONTH FROM holiday_date) = $1 AND EXTRACT(YEAR FROM holiday_date) = $2
       ORDER BY holiday_date`,
      [month, year]
    );
    res.json({ success: true, holidays: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── POST /api/attendance/request (backdated attendance) ───────
router.post('/request', authMiddleware, async (req, res) => {
  const { emp_id, name, formal_name } = req.user;
  const { check_in_time, check_out_time, reason } = req.body;
  const request_date = dateKey(req.body.request_date);
  if (!request_date) return res.status(400).json({ success: false, message: 'Date required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(request_date))
    return res.status(400).json({ success: false, message: 'Invalid date' });
  if (!reason) return res.status(400).json({ success: false, message: 'Reason required' });
  const today = todayIST();
  if (request_date > today)
    return res.status(400).json({ success: false, message: 'Future date ke liye request allowed nahi hai' });
  try {
    await ensureRequestsTable();
    const existing = await db.query(
      `SELECT id FROM attendance_requests WHERE emp_id=$1 AND request_date=$2 AND status='Pending'`,
      [emp_id, request_date]
    );
    if (existing.rows.length > 0)
      return res.status(400).json({ success: false, message: 'Is date ke liye pehle se ek request pending hai' });
    await db.query(
      `INSERT INTO attendance_requests (emp_id, employee_name, request_date, check_in_time, check_out_time, reason)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [emp_id, formal_name || name, request_date, check_in_time || null, check_out_time || null, reason]
    );
    res.json({ success: true, message: 'Request submit ho gayi! HR/Manager se approval ka wait karo.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/my-requests ───────────────────────────
router.get('/my-requests', authMiddleware, async (req, res) => {
  const { emp_id } = req.user;
  try {
    await ensureRequestsTable();
    const result = await db.query(
      `SELECT id, emp_id, employee_name, TO_CHAR(request_date, 'YYYY-MM-DD') AS request_date,
              check_in_time, check_out_time, reason, status, admin_remark,
              reviewed_by, reviewed_at, created_at
       FROM attendance_requests
       WHERE emp_id=$1
       ORDER BY created_at DESC
       LIMIT 30`,
      [emp_id]
    );
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── GET /api/attendance/geocode?lat=&lng= ──
router.get('/geocode', authMiddleware, async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ success: false, message: 'lat and lng required' });

  const latNum = parseCoordinate(lat, -90, 90);
  const lngNum = parseCoordinate(lng, -180, 180);
  if (latNum === null || lngNum === null) {
    return res.status(400).json({ success: false, message: 'Invalid lat/lng' });
  }

  try {
    const location = await reverseGeocode(latNum, lngNum);
    res.json({ success: true, ...location });
  } catch (err) {
    console.error('Geocode error:', err);
    res.json({ success: true, address: coordinateFallback(latNum, lngNum), provider: 'coordinates' });
  }
});

// ── GET /api/attendance/notices (active notices for employees) ─
router.get('/notices', authMiddleware, async (req, res) => {
  try {
    const now = nowIST().toISOString();
    const result = await db.query(
      `SELECT id, title, message, start_at, end_at
       FROM notices WHERE start_at <= $1 AND end_at >= $1 ORDER BY created_at DESC`,
      [now]
    );
    res.json({ success: true, notices: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, notices: [] });
  }
});

module.exports = router;
