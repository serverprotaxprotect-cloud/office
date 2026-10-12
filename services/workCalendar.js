// One place that decides which days are weekly offs / holidays, so salary,
// leave approval and the auto-absent job all agree.
//
// Settings (attendance_settings), all optional:
//   WEEKLY_OFF_DAYS      weekday numbers that are always off, comma separated
//                        (0 = Sunday ... 6 = Saturday). Default "0" (Sunday only).
//   SATURDAY_OFF_WEEKS   which Saturdays of the month are off, e.g. "2,4" for the
//                        2nd and 4th. Default none. Ignored if Saturday is already
//                        a weekly off.
// Declared holidays (holidays table) are always off.

function parseList(value, min, max) {
  return String(value ?? '')
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n) && n >= min && n <= max);
}

function weeklyOffDays(settings) {
  const raw = settings?.WEEKLY_OFF_DAYS;
  const list = raw === undefined || raw === null || String(raw).trim() === '' ? [0] : parseList(raw, 0, 6);
  return new Set(list.length ? list : [0]);
}

function saturdayOffWeeks(settings) {
  return new Set(parseList(settings?.SATURDAY_OFF_WEEKS, 1, 5));
}

// declaredDays: Set of day-of-month numbers that are declared holidays in (year, month).
function buildCalendar({ year, month, settings, declaredDays = new Set() }) {
  const off = weeklyOffDays(settings);
  const satWeeks = saturdayOffWeeks(settings);
  const daysInMonth = new Date(year, month, 0).getDate();

  function reason(day) {
    if (declaredDays.has(day)) return 'holiday';
    const wd = new Date(year, month - 1, day).getDay();
    if (off.has(wd)) return 'weekly_off';
    if (wd === 6 && satWeeks.has(Math.ceil(day / 7))) return 'weekly_off';
    return null;
  }

  return {
    daysInMonth,
    reason,
    isOff: day => reason(day) !== null,
    workingDays: () => Array.from({ length: daysInMonth }, (_, i) => i + 1).filter(d => reason(d) === null).length,
  };
}

// Same decision for a single calendar date (YYYY-MM-DD) given declared holiday date strings.
function isOffDate(dateStr, settings, declaredDateSet = new Set()) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const declaredDays = new Set([...declaredDateSet].filter(s => s.startsWith(`${y}-${String(m).padStart(2, '0')}-`)).map(s => Number(s.slice(8, 10))));
  return buildCalendar({ year: y, month: m, settings, declaredDays }).isOff(d);
}

module.exports = { buildCalendar, isOffDate, weeklyOffDays, saturdayOffWeeks };
