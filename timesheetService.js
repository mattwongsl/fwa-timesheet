const pool = require('./db/pool');
const { weekDays, currentWeekStart } = require('./utils');
const { validateTimesheetPayload, validateDays } = require('./validation/timesheets');
const { httpError, positiveId, version: validVersion, date: validDate } = require('./validation/common');

const LEAVE_TYPES = ['sick_leave', 'local_leave', 'emergency_leave', 'public_holiday'];
const DAYS_ONLY_TYPES = [...LEAVE_TYPES];
const STANDARD_WORKDAY_HOURS = 7.5;
const HALF_DAY_WORK_HOURS = 3.5;

function isEditableByEmployee(timesheet) {
  if (timesheet.locked) return false;
  const current = currentWeekStart();
  return timesheet.week_start <= current && (timesheet.week_start === current || timesheet.admin_unlocked === true);
}

async function transaction(operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function lockUsers(client, actorId, ownerId = actorId, admin = false) {
  const ids = [...new Set([actorId, ownerId])].sort((a, b) => a - b);
  const result = await client.query('SELECT id, role, active FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE', [ids]);
  const actor = result.rows.find((user) => user.id === actorId);
  if (!actor || !actor.active) throw httpError(401, 'This account is inactive or no longer exists.');
  if (admin && actor.role !== 'admin') throw httpError(403, 'Admins only.');
  const owner = result.rows.find((user) => user.id === ownerId);
  if (!owner) throw httpError(404, 'Employee not found.');
  return { actor, owner };
}

// All mutations share a lock order: users -> timesheet -> request -> projects.
// The row lock prevents races; the version prevents an older tab overwriting
// the winner after waiting for that lock.
async function withSheet(id, actorId, expectedVersion, admin, operation) {
  positiveId(id, 'Timesheet id');
  if (expectedVersion !== undefined) validVersion(expectedVersion);
  return transaction(async (client) => {
    const reference = (await client.query('SELECT user_id FROM timesheets WHERE id = $1', [id])).rows[0];
    if (!reference) throw httpError(404, 'Timesheet not found.');
    const users = await lockUsers(client, actorId, reference.user_id, admin);
    const sheet = (await client.query('SELECT * FROM timesheets WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!sheet) throw httpError(404, 'Timesheet not found.');
    if (!admin && sheet.user_id !== actorId) throw httpError(403, 'Not your timesheet.');
    if (expectedVersion !== undefined && sheet.version !== expectedVersion) {
      throw httpError(409, 'This timesheet changed in another tab or session. Your edits have not been saved. Reload the latest version and reconcile your changes.');
    }
    return operation(client, sheet, users);
  });
}

async function getOrCreateTimesheet(userId, weekStart) {
  positiveId(userId, 'Employee id'); validDate(weekStart, 'week');
  return transaction(async (client) => {
    await lockUsers(client, userId);
    await client.query('INSERT INTO timesheets (user_id, week_start) VALUES ($1, $2) ON CONFLICT (user_id, week_start) DO NOTHING', [userId, weekStart]);
    return (await client.query('SELECT * FROM timesheets WHERE user_id = $1 AND week_start = $2', [userId, weekStart])).rows[0];
  });
}

async function getDaysForTimesheet(timesheetId, weekStart, database = pool) {
  const result = await database.query(
    `SELECT te.*, p.name AS project_name, p.archived AS project_archived
     FROM timesheet_entries te LEFT JOIN projects p ON p.id = te.project_id
     WHERE te.timesheet_id = $1 ORDER BY te.work_date, te.id`, [timesheetId]
  );
  return shapeDays(result.rows, weekStart);
}

function shapeDays(entries, weekStart) {
  const byDate = Object.fromEntries(weekDays(weekStart).map((date) => [date, {
    date, type: 'work', projects: [], justification: '', leave_hours: 0, leave_days: 0, leave_unit: 'hours'
  }]));
  for (const row of entries) {
    const day = byDate[row.work_date];
    if (!day) continue;
    if (LEAVE_TYPES.includes(row.entry_type)) {
      day.type = row.entry_type; day.leave_hours = Number(row.hours); day.leave_days = Number(row.days); day.leave_unit = row.leave_unit || 'days';
    } else if (row.project_id) {
      day.projects.push({ project_id: row.project_id, project_name: row.project_name, archived: row.project_archived, hours: Number(row.hours) });
    } else if (row.entry_type === 'other') {
      day.projects.push({ entry_type: 'other', hours: Number(row.hours), other_description: row.other_description || '' });
    } else if (row.justification) day.justification = row.justification;
  }
  return Object.values(byDate);
}

async function snapshot(client, timesheet) {
  const days = await getDaysForTimesheet(timesheet.id, timesheet.week_start, client);
  return { timesheet, days, summary: summarizeDays(days) };
}

async function checkProjects(client, sheet, days) {
  const oldEntries = (await client.query('SELECT * FROM timesheet_entries WHERE timesheet_id=$1 ORDER BY id', [sheet.id])).rows;
  const old = oldEntries.filter((entry) => entry.project_id !== null);
  const requested = days.flatMap((day) => day.projects.filter((p) => p.project_id).map((p) => ({ date: day.date, ...p })));
  const ids = [...new Set([...old.map((entry) => entry.project_id), ...requested.map((entry) => entry.project_id)])].sort((a, b) => a - b);
  if (!ids.length) return oldEntries;
  const projects = (await client.query('SELECT id, archived FROM projects WHERE id = ANY($1::int[]) ORDER BY id FOR SHARE', [ids])).rows;
  const byId = new Map(projects.map((p) => [p.id, p]));
  for (const entry of requested) {
    const project = byId.get(entry.project_id);
    if (!project) throw httpError(400, `Project ${entry.project_id} does not exist.`);
    if (project.archived && !old.some((previous) => previous.work_date === entry.date && previous.project_id === entry.project_id && Number(previous.hours) === entry.hours)) {
      throw httpError(400, 'Archived projects cannot receive new or changed entries. Ask an administrator to unarchive the project first.');
    }
  }
  for (const entry of old) {
    if (byId.get(entry.project_id)?.archived && Number(entry.hours) > 0 && !requested.some((p) => p.date === entry.work_date && p.project_id === entry.project_id && p.hours === Number(entry.hours))) {
      throw httpError(400, 'Preserve recorded hours for archived projects. Unarchive the project before changing or removing those hours.');
    }
  }
  return oldEntries;
}

function entryKey(entry) {
  const text = (value) => typeof value === 'string' ? value.trim() : null;
  return JSON.stringify([entry.work_date, entry.entry_type, entry.project_id ?? null, Number(entry.hours), Number(entry.days), entry.leave_unit ?? null, text(entry.justification), text(entry.other_description)]);
}

function flattenEntries(days) {
  return days.flatMap((day) => {
    const entries = day.projects.map((p) => ({
      work_date: day.date, entry_type: p.entry_type === 'other' ? 'other' : 'work', project_id: p.project_id || null, hours: p.hours, days: 0, leave_unit: null, justification: null, other_description: p.entry_type === 'other' ? p.other_description : null
    }));
    if (day.type !== 'work') entries.push({ work_date: day.date, entry_type: day.type, project_id: null, hours: 0, days: day.leave_days, leave_unit: 'days', justification: null, other_description: null });
    if (day.justification && (day.type === 'work' || day.leave_days === 0.5)) entries.push({ work_date: day.date, entry_type: 'work', project_id: null, hours: 0, days: 0, leave_unit: null, justification: day.justification, other_description: null });
    return entries;
  });
}

async function replaceEntries(id, body, actorId, { admin = false } = {}) {
  // Check the envelope before a missing days field can become a destructive save.
  const expected = validVersion(body?.version);
  return withSheet(id, actorId, expected, admin, async (client, sheet, { owner }) => {
    if (!owner.active) throw httpError(409, 'This employee is inactive. Historical timesheets are read-only.');
    if (!admin && !isEditableByEmployee(sheet)) throw httpError(423, 'This timesheet is locked. Ask an administrator to unlock it.');
    const days = validateTimesheetPayload(body, sheet.week_start);
    const oldEntries = await checkProjects(client, sheet, days);
    const byKey = new Map();
    for (const entry of oldEntries) {
      const key = entryKey(entry);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(entry);
    }
    const keep = new Set(), insert = [];
    for (const entry of flattenEntries(days)) {
      const previous = byKey.get(entryKey(entry))?.shift();
      if (previous) keep.add(previous.id);
      else if (entry.hours > 0 || (entry.entry_type !== 'other' && entry.project_id === null)
          || (entry.entry_type === 'other' && entry.other_description)) insert.push(entry);
    }
    // Preserve row identity and any columns that older releases used but the
    // current editing model cannot safely interpret or recalculate.
    for (const entry of oldEntries) {
      const hasLegacy = (typeof entry.notes === 'string' && entry.notes.trim())
        || (entry.overtime_hours !== undefined && entry.overtime_hours !== null && Number(entry.overtime_hours) !== 0);
      if (hasLegacy && !keep.has(entry.id)) throw httpError(409, 'This edit would change or remove a row containing legacy notes or overtime. Preserve that row and arrange an explicit data review before changing it.');
    }
    await client.query('DELETE FROM timesheet_entries WHERE timesheet_id=$1 AND NOT (id=ANY($2::int[]))', [id, [...keep]]);
    for (const entry of insert) {
      await client.query(`INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,project_id,hours,days,leave_unit,justification,other_description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, entry.work_date, entry.entry_type, entry.project_id, entry.hours, entry.days, entry.leave_unit, entry.justification, entry.other_description]);
    }
    const updated = (await client.query('UPDATE timesheets SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING *', [id])).rows[0];
    return { ok: true, ...await snapshot(client, updated) };
  });
}

function canonicalDays(days) {
  return days.map((day) => ({ date: day.date, type: day.type, justification: day.justification, leave_days: day.leave_days,
    projects: day.projects.map((entry) => entry.entry_type === 'other'
      ? { entry_type: 'other', hours: entry.hours, other_description: entry.other_description }
      : { project_id: entry.project_id, hours: entry.hours }) }));
}

async function submitTimesheet(id, expectedVersion, actorId) {
  return withSheet(id, actorId, validVersion(expectedVersion), false, async (client, sheet) => {
    if (!isEditableByEmployee(sheet)) throw httpError(423, 'This timesheet is locked or not yet editable.');
    const stored = await getDaysForTimesheet(id, sheet.week_start, client);
    validateDays(canonicalDays(stored), sheet.week_start);
    const updated = (await client.query(
      'UPDATE timesheets SET locked=true, admin_unlocked=false, submitted_at=now(), locked_at=now(), locked_by=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING *', [id, actorId]
    )).rows[0];
    return { timesheet: updated };
  });
}

async function setTimesheetLock(id, expectedVersion, actorId, locked) {
  return withSheet(id, actorId, validVersion(expectedVersion), true, async (client, sheet, { owner }) => {
    if (locked && sheet.locked) throw httpError(409, 'This timesheet is already locked.');
    if (!locked && (!owner.active || sheet.week_start > currentWeekStart())) throw httpError(409, 'Only an active employee’s current or past timesheet can be reopened.');
    if (!locked && isEditableByEmployee(sheet)) throw httpError(409, 'This timesheet is already editable.');
    const updated = (await client.query(
      `UPDATE timesheets SET locked=$2, admin_unlocked=$3, locked_at=CASE WHEN $2 THEN now() ELSE locked_at END,
       locked_by=CASE WHEN $2 THEN $4 ELSE locked_by END, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`, [id, locked, !locked, actorId]
    )).rows[0];
    return { timesheet: updated };
  });
}

async function requestUnlock(id, expectedVersion, actorId, reason) {
  return withSheet(id, actorId, validVersion(expectedVersion), false, async (client, sheet) => {
    if (sheet.week_start > currentWeekStart() || isEditableByEmployee(sheet)) throw httpError(409, 'An unlock request is only valid for a closed current or past timesheet.');
    const pending = await client.query("SELECT id FROM unlock_requests WHERE timesheet_id=$1 AND status='pending'", [id]);
    if (pending.rows.length) throw httpError(409, 'There is already a pending unlock request for this week.');
    const request = (await client.query('INSERT INTO unlock_requests (timesheet_id,requested_by,reason,requested_version) VALUES ($1,$2,$3,$4) RETURNING *', [id, actorId, reason || null, sheet.version])).rows[0];
    return { request };
  });
}

async function resolveUnlockRequest(requestId, actorId, approve) {
  positiveId(requestId, 'Request id');
  const ref = (await pool.query('SELECT timesheet_id FROM unlock_requests WHERE id=$1', [requestId])).rows[0];
  if (!ref) throw httpError(404, 'Request not found.');
  return withSheet(ref.timesheet_id, actorId, undefined, true, async (client, sheet, { owner }) => {
    const request = (await client.query('SELECT * FROM unlock_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
    if (!request || request.timesheet_id !== sheet.id) throw httpError(404, 'Request not found.');
    if (request.status !== 'pending') throw httpError(409, 'This request has already been resolved.');
    if (request.requested_by !== sheet.user_id) throw httpError(409, 'The request does not belong to this timesheet’s owner.');
    if (approve) {
      if (request.requested_version !== sheet.version) throw httpError(409, 'This timesheet changed after the unlock request. Deny the stale request and ask the employee to request again.');
      if (!owner.active || sheet.week_start > currentWeekStart() || isEditableByEmployee(sheet)) throw httpError(409, 'This timesheet cannot be reopened from this request.');
      await client.query('UPDATE timesheets SET locked=false,admin_unlocked=true,version=version+1,updated_at=now() WHERE id=$1', [sheet.id]);
    }
    const updated = (await client.query('UPDATE unlock_requests SET status=$2,resolved_at=now(),resolved_by=$3 WHERE id=$1 RETURNING *', [requestId, approve ? 'approved' : 'denied', actorId])).rows[0];
    return { request: updated };
  });
}
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

module.exports = { LEAVE_TYPES, DAYS_ONLY_TYPES, STANDARD_WORKDAY_HOURS, HALF_DAY_WORK_HOURS,
  getOrCreateTimesheet, isEditableByEmployee, getDaysForTimesheet, replaceEntries, summarizeDays,
  submitTimesheet, setTimesheetLock, requestUnlock, resolveUnlockRequest };

async function getTimesheet(id, actorId, { admin = false } = {}) {
  positiveId(id, 'Timesheet id');
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const sheet = (await client.query('SELECT t.*, u.name AS employee_name, u.email AS employee_email FROM timesheets t JOIN users u ON u.id=t.user_id WHERE t.id=$1', [id])).rows[0];
    if (!sheet) throw httpError(404, 'Timesheet not found.');
    if (!admin && sheet.user_id !== actorId) throw httpError(403, 'Not your timesheet.');
    return snapshot(client, sheet);
  });
}
module.exports.getTimesheet = getTimesheet;


async function listTimesheets({ actorId, admin = false, userId, week, from, to, history = false }) {
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const params = [], clauses = [];
    for (const [column, operator, value] of [
      ['t.user_id', '=', admin ? userId : actorId], ['t.week_start', '=', week],
      ['t.week_start', '>=', from], ['t.week_start', '<=', to]
    ]) {
      if (value === undefined) continue;
      params.push(value); clauses.push(`${column} ${operator} $${params.length}`);
    }
    const sheets = (await client.query(`SELECT t.*,u.name AS employee_name,u.email AS employee_email FROM timesheets t JOIN users u ON u.id=t.user_id ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY t.week_start DESC,u.name ${history ? 'LIMIT 52' : ''}`, params)).rows;
    if (!sheets.length) return [];
    const entries = (await client.query('SELECT te.*,p.name AS project_name,p.archived AS project_archived FROM timesheet_entries te LEFT JOIN projects p ON p.id=te.project_id WHERE te.timesheet_id=ANY($1::int[]) ORDER BY te.work_date,te.id', [sheets.map((sheet) => sheet.id)])).rows;
    const grouped = new Map();
    for (const entry of entries) {
      if (!grouped.has(entry.timesheet_id)) grouped.set(entry.timesheet_id, []);
      grouped.get(entry.timesheet_id).push(entry);
    }
    return sheets.map((timesheet) => ({ timesheet, summary: summarizeDays(shapeDays(grouped.get(timesheet.id) || [], timesheet.week_start)), editable: isEditableByEmployee(timesheet) }));
  });
}
module.exports.listTimesheets = listTimesheets;
