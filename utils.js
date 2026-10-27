// Helpers for working with "work weeks". A work week runs Monday-Friday;
// Saturday/Sunday are not tracked by the timesheet.
// Dates are handled as plain 'YYYY-MM-DD' strings to avoid timezone bugs.

function toDateOnly(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns the Monday (as YYYY-MM-DD) of the week containing the given date.
// If no date given, uses today. Accepts a YYYY-MM-DD string or a Date.
function getMondayOf(dateInput) {
  const d = dateInput instanceof Date ? new Date(dateInput) : new Date(dateInput + 'T00:00:00');
  const day = d.getDay(); // 0 = Sunday, 1 = Monday, ...
  const diff = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setDate(d.getDate() + diff);
  return toDateOnly(d);
}

function currentWeekStart() {
  return getMondayOf(new Date());
}

// Returns array of 5 YYYY-MM-DD strings, Monday through Friday, starting at weekStart.
function weekDays(weekStart) {
  const start = new Date(weekStart + 'T00:00:00');
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(toDateOnly(d));
  }
  return days;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toDateOnly(d);
}

function weekNumberFromFirstMonday(weekStart) {
  const year = Number(String(weekStart).slice(0, 4));
  const firstMonday = getMondayOf(`${year}-01-07`);
  return Math.floor((new Date(`${weekStart}T00:00:00`) - new Date(`${firstMonday}T00:00:00`)) / 604800000) + 1;
}

module.exports = { toDateOnly, getMondayOf, currentWeekStart, weekDays, addDays, weekNumberFromFirstMonday };
