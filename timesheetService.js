const pool = require('./db/pool');
const { weekDays, currentWeekStart } = require('./utils');

// Leave types that are logged as a whole day/partial day rather than as project work.
const LEAVE_TYPES = ['sick_leave', 'local_leave', 'emergency_leave', 'public_holiday'];

// The standard working day. Used as: (a) the default amount for a full day of
// leave, and (b) the threshold below which a work day needs a justification,
// and above which the extra hours count toward that week's "extra hours".
const STANDARD_WORKDAY_HOURS = 7.5;
const HALF_DAY_WORK_HOURS = 3.5;

// Leave types measured only in days (never hours): local leave, sick leave,
// emergency leave, and public holiday are all logged as whole/half days off.
const DAYS_ONLY_TYPES = ['local_leave', 'public_holiday', 'sick_leave', 'emergency_leave'];

// Get the timesheet for a user/week, creating an empty draft if it doesn't exist yet.
async function getOrCreateTimesheet(userId, weekStart) {
  const existing = await pool.query(
    'SELECT * FROM timesheets WHERE user_id = $1 AND week_start = $2',
    [userId, weekStart]
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO timesheets (user_id, week_start) VALUES ($1, $2)
     ON CONFLICT (user_id, week_start) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId, weekStart]
  );
  return created.rows[0];
}

// A timesheet is editable by its owner only if:
//  - it's a future week: never editable
//  - it's the current week: editable unless locked
//  - it's a past week: editable only if an admin explicitly unlocked it
function isEditableByEmployee(timesheet) {
  const cw = currentWeekStart();
  if (timesheet.week_start > cw) return false;
  if (timesheet.week_start === cw) return !timesheet.locked;
  return !!timesheet.admin_unlocked;
}

// Reshape flat DB rows into a friendly per-day structure for the frontend.
async function getDaysForTimesheet(timesheetId, weekStart) {
  const entriesResult = await pool.query(
    `SELECT te.*, p.name AS project_name
     FROM timesheet_entries te
     LEFT JOIN projects p ON p.id = te.project_id
     WHERE te.timesheet_id = $1
     ORDER BY te.work_date`,
    [timesheetId]
  );

  const byDate = {};
  for (const date of weekDays(weekStart)) {
    byDate[date] = {
      date,
      type: 'work',
      projects: [],
      justification: '',
      leave_hours: 0,
      leave_days: 0,
      leave_unit: 'hours'
    };
  }

  for (const row of entriesResult.rows) {
    const date = row.work_date;
    if (!byDate[date]) continue;

    if (LEAVE_TYPES.includes(row.entry_type)) {
      byDate[date].type = row.entry_type;
      byDate[date].leave_hours = Number(row.hours);
      byDate[date].leave_days = Number(row.days);
      byDate[date].leave_unit = row.leave_unit || (DAYS_ONLY_TYPES.includes(row.entry_type) ? 'days' : 'hours');
    } else if (row.entry_type === 'work' || row.entry_type === 'other') {
      if (row.project_id) {
        byDate[date].projects.push({
          project_id: row.project_id,
          project_name: row.project_name,
          hours: Number(row.hours)
        });
      } else if (row.entry_type === 'other') {
        byDate[date].projects.push({ entry_type: 'other', hours: Number(row.hours), other_description: row.other_description || '' });
      } else if (row.justification) {
        byDate[date].justification = row.justification;
      }
    }
  }

  return Object.values(byDate);
}

// Replace all entries for a timesheet based on a friendly per-day payload:
// [{ date, type, justification, leave_hours, leave_days, leave_unit, projects: [{project_id, hours}] }]
async function replaceEntries(timesheetId, days) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM timesheet_entries WHERE timesheet_id = $1', [timesheetId]);

    for (const day of days || []) {
      if (!day.date) continue;

      const isHalfDayLeave = ['sick_leave', 'local_leave', 'emergency_leave'].includes(day.type)
        && Number(day.leave_days) === 0.5;
      if (LEAVE_TYPES.includes(day.type) && !isHalfDayLeave) {
        let unit = 'hours';
        let hours = 0;
        let daysAmount = 0;

        if (DAYS_ONLY_TYPES.includes(day.type)) {
          unit = 'days';
          daysAmount = day.type === 'public_holiday' ? 1 : (Number(day.leave_days) > 0 ? Number(day.leave_days) : 1);
        }

        await client.query(
          `INSERT INTO timesheet_entries (timesheet_id, work_date, entry_type, project_id, hours, days, leave_unit)
           VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
          [timesheetId, day.date, day.type, hours, daysAmount, unit]
        );
        continue;
      }

      // type === 'work': one row per project with hours, plus one
      // justification-only row if the day's total came in under the minimum.
      let dayTotal = 0;
      const seenProjectIds = new Set();
      for (const proj of day.projects || []) {
        const hours = roundHalfHour(proj.hours);
        if (hours <= 0) continue;
        if (proj.entry_type === 'other') {
          const description = String(proj.other_description || '').trim();
          if (!description) throw validationError('Every Other entry needs a description.');
          dayTotal += hours;
          await client.query(
            `INSERT INTO timesheet_entries (timesheet_id, work_date, entry_type, project_id, hours, days, other_description)
             VALUES ($1, $2, 'other', NULL, $3, 0, $4)`,
            [timesheetId, day.date, hours, description]
          );
          continue;
        }
        const projectId = Number(proj.project_id);
        if (!projectId) continue;
        if (seenProjectIds.has(projectId)) throw validationError('A project can only be added once per day.');
        seenProjectIds.add(projectId);
        dayTotal += hours;
        await client.query(
          `INSERT INTO timesheet_entries (timesheet_id, work_date, entry_type, project_id, hours, days)
           VALUES ($1, $2, 'work', $3, $4, 0)`,
          [timesheetId, day.date, projectId, hours]
        );
      }

      if (isHalfDayLeave) {
        if (
          dayTotal < HALF_DAY_WORK_HOURS &&
          (!day.justification || !day.justification.trim())
        ) {
          throw validationError(
            `Please add a reason when a half-day leave has less than ${HALF_DAY_WORK_HOURS} worked hours.`
          );
        }

        await client.query(
          `INSERT INTO timesheet_entries (timesheet_id, work_date, entry_type, project_id, hours, days, leave_unit)
           VALUES ($1, $2, $3, NULL, 0, 0.5, 'days')`,
          [timesheetId, day.date, day.type]
        );
      }

      const minimumHours = isHalfDayLeave
        ? HALF_DAY_WORK_HOURS
        : STANDARD_WORKDAY_HOURS;

      if (dayTotal < minimumHours && day.justification && day.justification.trim()) {
        await client.query(
          `INSERT INTO timesheet_entries (timesheet_id, work_date, entry_type, project_id, hours, days, justification)
           VALUES ($1, $2, 'work', NULL, 0, 0, $3)`,
          [timesheetId, day.date, day.justification.trim()]
        );
      }
    }

    await client.query('UPDATE timesheets SET updated_at = now() WHERE id = $1', [timesheetId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function roundHalfHour(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 2) / 2 : 0;
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// Summary totals for a single timesheet (used in list views).
// extra_hours = sum across the week of any day's work hours that exceed the
// standard 7.5-hour workday (i.e. the "worked more than a normal day" amount).
function summarizeDays(days) {
  let workHours = 0;
  let extraHours = 0;
  let sick = 0, local = 0, emergency = 0, publicHoliday = 0;

  for (const d of days) {
    const dayTotal = (d.projects || []).reduce((sum, p) => sum + (Number(p.hours) || 0), 0);
    workHours += dayTotal;
    if (dayTotal > STANDARD_WORKDAY_HOURS) extraHours += dayTotal - STANDARD_WORKDAY_HOURS;
    if (d.type === 'sick_leave') {
      sick += d.leave_days || 1;
    } else if (d.type === 'local_leave') {
      local += d.leave_days || 1;
    } else if (d.type === 'emergency_leave') {
      emergency += d.leave_days || 1;
    } else if (d.type === 'public_holiday') {
      publicHoliday += d.leave_days || 1;
    }
  }

  return {
    work_hours: workHours,
    extra_hours: extraHours,
    sick_leave_days: sick,
    local_leave_days: local,
    emergency_leave_days: emergency,
    public_holiday_days: publicHoliday
  };
}

module.exports = {
  LEAVE_TYPES,
  DAYS_ONLY_TYPES,
  STANDARD_WORKDAY_HOURS,
  HALF_DAY_WORK_HOURS,
  roundHalfHour,
  getOrCreateTimesheet,
  isEditableByEmployee,
  getDaysForTimesheet,
  replaceEntries,
  summarizeDays
};
