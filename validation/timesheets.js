// Validate the complete replacement snapshot before any saved entries are removed.
const DAY_TYPES = new Set(['work', 'sick_leave', 'local_leave', 'emergency_leave', 'public_holiday']);
const MAX_DATABASE_ID = 2147483647;
const FULL_DAY_HOURS = 7.5;
const HALF_DAY_HOURS = 3.5;

function fail(path, message) {
  const error = new Error(`${path}: ${message}`);
  error.status = 400;
  error.code = 'VALIDATION_ERROR';
  throw error;
}

function object(value, path, allowed, required = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, 'must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not a supported field.');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'is required.');
  }
}

function text(value, path, defaultValue = '') {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string') fail(path, 'must be text.');
  if (value.length > 4000) fail(path, 'must be no more than 4000 characters.');
  return value.trim();
}

function validDate(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    fail(path, 'must be a real calendar date in YYYY-MM-DD format.');
  }
  const date = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    fail(path, 'must be a real calendar date in YYYY-MM-DD format.');
  }
  return date;
}

function expectedDates(weekStart) {
  const monday = validDate(weekStart, 'week_start');
  if (monday.getUTCDay() !== 1) fail('week_start', 'must be the Monday of the timesheet week.');
  return Array.from({ length: 5 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

function hours(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number.');
  if (value < 0 || value > 24) fail(path, 'must be between 0 and 24 hours.');
  if (!Number.isInteger(value * 2)) fail(path, 'must use half-hour increments (for example, 1, 1.5, or 2).');
  return value;
}

function validateProjects(projects, path) {
  if (!Array.isArray(projects)) fail(path, 'must be an array.');
  const seen = new Set();
  return projects.map((project, index) => {
    const itemPath = `${path}[${index}]`;
    // Check the basic shape before reading entry_type, including null/array input.
    object(project, itemPath, ['project_id', 'hours', 'entry_type', 'other_description'], ['hours']);
    if (project.entry_type === 'other') {
      object(project, itemPath, ['entry_type', 'hours', 'other_description'], ['entry_type', 'hours']);
      const amount = hours(project.hours, `${itemPath}.hours`);
      const description = text(project.other_description, `${itemPath}.other_description`);
      if (amount > 0 && !description) fail(`${itemPath}.other_description`, 'is required for Other work with recorded hours.');
      return { entry_type: 'other', hours: amount, other_description: description };
    }
    object(project, itemPath, ['project_id', 'hours', 'entry_type'], ['project_id', 'hours']);
    if (project.entry_type !== undefined && project.entry_type !== 'work') {
      fail(`${itemPath}.entry_type`, 'must be work or other.');
    }
    if (!Number.isInteger(project.project_id) || project.project_id <= 0 || project.project_id > MAX_DATABASE_ID) {
      fail(`${itemPath}.project_id`, 'must be a positive PostgreSQL integer project ID.');
    }
    if (seen.has(project.project_id)) fail(`${itemPath}.project_id`, 'a project can only be listed once per day, including zero-hour rows.');
    seen.add(project.project_id);
    return { project_id: project.project_id, hours: hours(project.hours, `${itemPath}.hours`) };
  });
}

function validateDays(days, weekStart) {
  const dates = expectedDates(weekStart);
  if (!Array.isArray(days) || days.length !== 5) {
    fail('days', 'must contain exactly the five Monday–Friday dates for this timesheet week.');
  }
  const seen = new Set();
  const normalized = days.map((day, index) => {
    const path = `days[${index}]`;
    object(day, path, ['date', 'type', 'projects', 'justification', 'leave_days'], ['date', 'type', 'projects']);
    validDate(day.date, `${path}.date`);
    if (!dates.includes(day.date)) fail(`${path}.date`, 'must belong to the Monday–Friday dates of this timesheet week.');
    if (seen.has(day.date)) fail(`${path}.date`, 'a work date can only be listed once.');
    seen.add(day.date);
    if (typeof day.type !== 'string' || !DAY_TYPES.has(day.type)) fail(`${path}.type`, 'must be work, sick_leave, local_leave, emergency_leave, or public_holiday.');
    const projects = validateProjects(day.projects, `${path}.projects`);
    const justification = text(day.justification, `${path}.justification`);
    const leaveDays = day.leave_days === undefined ? 0 : day.leave_days;
    if (typeof leaveDays !== 'number' || !Number.isFinite(leaveDays)) fail(`${path}.leave_days`, 'must be a finite number of days.');
    if (day.type === 'work') {
      if (leaveDays !== 0) fail(`${path}.leave_days`, 'must be 0 for a working day.');
    } else if (day.type === 'public_holiday') {
      if (leaveDays !== 1) fail(`${path}.leave_days`, 'must be 1 for a public holiday.');
    } else if (leaveDays !== 0.5 && leaveDays !== 1) {
      fail(`${path}.leave_days`, 'must be 0.5 or 1 for this leave type.');
    }
    const isHalfDayLeave = day.type !== 'work' && day.type !== 'public_holiday' && leaveDays === 0.5;
    if (day.type !== 'work' && !isHalfDayLeave && projects.length !== 0) {
      fail(`${path}.projects`, 'must be empty for full-day leave or a public holiday.');
    }
    if (day.type !== 'work' && !isHalfDayLeave && justification) {
      fail(`${path}.justification`, 'must be empty for full-day leave or a public holiday.');
    }
    const total = projects.reduce((sum, project) => sum + project.hours, 0);
    if (total > 24) fail(`${path}.projects`, 'combined work hours cannot exceed 24 hours in one calendar day.');
    const threshold = isHalfDayLeave ? HALF_DAY_HOURS : FULL_DAY_HOURS;
    if ((day.type === 'work' || isHalfDayLeave) && total < threshold && !justification) {
      fail(`${path}.justification`, `is required when worked hours are below ${threshold} for this day.`);
    }
    return { date: day.date, type: day.type, projects, justification, leave_days: leaveDays };
  });
  // A canonical order makes equivalent valid snapshots compare consistently.
  return normalized.sort((a, b) => a.date.localeCompare(b.date));
}

function validateTimesheetPayload(body, weekStart) {
  object(body, 'body', ['days', 'version'], ['days', 'version']);
  if (!Number.isSafeInteger(body.version) || body.version < 0) {
    fail('body.version', 'must be a nonnegative safe integer obtained from the latest timesheet response.');
  }
  return validateDays(body.days, weekStart);
}

module.exports = { validateTimesheetPayload, validateDays };
