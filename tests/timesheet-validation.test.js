const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTimesheetPayload, validateDays } = require('../validation/timesheets');

const WEEK = '2026-10-26';
const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
function payload() {
  return { version: 0, days: dates.map((date) => ({ date, type: 'work', projects: [{ project_id: 1, hours: 7.5 }], justification: '', leave_days: 0 })) };
}
function invalid(mutator, pattern = /./) {
  const input = payload();
  mutator(input);
  assert.throws(() => validateTimesheetPayload(input, WEEK), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, pattern);
    return true;
  });
}

test('valid complete timesheet is accepted, normalized and not mutated', () => {
  const input = payload();
  input.days[0].projects[0].entry_type = 'work';
  input.days[0].justification = '  Optional context  ';
  input.days.reverse();
  const before = structuredClone(input);
  const normalized = validateTimesheetPayload(input, WEEK);
  assert.deepEqual(input, before);
  assert.deepEqual(normalized.map((day) => day.date), dates);
  assert.deepEqual(normalized[0].projects[0], { project_id: 1, hours: 7.5 });
  assert.equal(normalized[0].justification, 'Optional context');
});

test('optional text and work leave defaults are normalized', () => {
  const input = payload();
  delete input.days[0].justification;
  delete input.days[0].leave_days;
  assert.equal(validateTimesheetPayload(input, WEEK)[0].justification, '');
  assert.equal(validateTimesheetPayload(input, WEEK)[0].leave_days, 0);
});

test('body requires an explicit days snapshot and version and rejects mutable ownership/state metadata', () => {
  for (const field of ['days', 'version']) invalid((body) => delete body[field], new RegExp(field));
  for (const [name, value] of Object.entries({ user_id: 2, locked: false, admin_unlocked: true, timesheet_id: 2 })) {
    invalid((body) => body[name] = value, /not a supported field/);
  }
  for (const value of [null, [], 'bad', 4]) {
    assert.throws(() => validateTimesheetPayload(value, WEEK), (error) => error.status === 400);
  }
});

test('version rejects coercion, negative, noninteger and nonfinite values', () => {
  for (const version of [-1, 1.5, '1', null, true, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) invalid((body) => body.version = version, /version/);
  assert.doesNotThrow(() => validateTimesheetPayload({ ...payload(), version: 12 }, WEEK));
});

test('exactly five dates are required so an omitted day cannot silently erase entries', () => {
  for (const days of [[], null, {}, 'bad']) invalid((body) => body.days = days, /five/);
  invalid((body) => body.days.pop(), /five/);
  invalid((body) => body.days.push(body.days[0]), /five/);
});

test('invalid calendar dates, normalized dates, wrong formats and nonstrings are rejected', () => {
  for (const date of ['2026-02-30', '2026-02-29', '2026-13-01', '2026-10-32', '2026-1-2', '2026-10-26T00:00:00Z', '0000-01-01', '', null, 20261026]) {
    invalid((body) => body.days[0].date = date, /calendar date/);
  }
});

test('outside-week, weekend and duplicate dates are rejected', () => {
  for (const date of ['2026-10-25', '2026-10-31', '2026-11-02']) invalid((body) => body.days[0].date = date, /Monday–Friday/);
  invalid((body) => body.days[1].date = body.days[0].date, /only be listed once/);
});

test('week start must itself be a real Monday date', () => {
  for (const week of ['2026-02-30', '2026-10-27', null, 'bad']) {
    assert.throws(() => validateDays(payload().days, week), (error) => error.status === 400);
  }
});

test('supported weekday calculations remain correct across DST and year boundaries', () => {
  for (const [week, expected] of [
    ['2026-03-02', ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']],
    ['2025-12-29', ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']]
  ]) {
    const input = payload(); input.days.forEach((day, index) => day.date = expected[index]);
    assert.deepEqual(validateTimesheetPayload(input, week).map((day) => day.date), expected);
  }
});

test('malformed or unknown day/project structures and missing required fields are rejected', () => {
  for (const value of [null, [], 'day', new Date()]) invalid((body) => body.days[0] = value, /must be an object/);
  for (const field of ['date', 'type', 'projects']) invalid((body) => delete body.days[0][field], /required/);
  for (const field of ['project_name', 'leave_hours', 'owner_id']) invalid((body) => body.days[0][field] = 'unexpected', /not a supported field/);
  for (const value of [null, {}, 'projects']) invalid((body) => body.days[0].projects = value, /array/);
  for (const value of [null, [], 'project', 3]) invalid((body) => body.days[0].projects = [value], /object/);
  for (const field of ['project_id', 'hours']) invalid((body) => delete body.days[0].projects[0][field], /required/);
  invalid((body) => body.days[0].projects[0].project_name = 'Read-only metadata', /not a supported field/);
  invalid((body) => body.days[0].projects[0].other_description = 'Wrong entry kind', /not a supported field/);
});

test('unknown day/entry types and nontext justifications are rejected', () => {
  for (const type of ['weekend', 'other', '', null, true]) invalid((body) => body.days[0].type = type, /type/);
  for (const entry_type of ['leave', null, true]) invalid((body) => body.days[0].projects[0].entry_type = entry_type, /entry_type/);
  for (const justification of [null, 12, {}, []]) invalid((body) => body.days[0].justification = justification, /must be text/);
});

test('hours must be numeric and finite rather than silently coerced or dropped', () => {
  for (const hours of ['7.5', '', null, true, {}, [], Infinity, -Infinity, NaN]) invalid((body) => body.days[0].projects[0].hours = hours, /finite number/);
});

test('negative hours, excessive individual hours and unsupported increments are rejected', () => {
  for (const hours of [-0.5, -4, 24.5, 999]) invalid((body) => body.days[0].projects[0].hours = hours, /between 0 and 24/);
  for (const hours of [0.1, 0.25, 7.49, 7.51]) invalid((body) => body.days[0].projects[0].hours = hours, /half-hour increments/);
});

test('valid half-hour work amounts up to 24 hours are accepted without inventing an overtime limit', () => {
  for (const hours of [0, 0.5, 3.5, 7.5, 8, 16, 24]) {
    const input = payload(); input.days[0].projects[0].hours = hours; input.days[0].justification = 'Explanation';
    assert.equal(validateTimesheetPayload(input, WEEK)[0].projects[0].hours, hours);
  }
});

test('combined hours cannot exceed a physical day even when individual project amounts are valid', () => {
  invalid((body) => body.days[0].projects = [{ project_id: 1, hours: 16 }, { project_id: 2, hours: 9 }], /combined work hours/);
  const input = payload(); input.days[0].projects = [{ project_id: 1, hours: 16 }, { project_id: 2, hours: 8 }];
  assert.doesNotThrow(() => validateTimesheetPayload(input, WEEK));
});

test('project IDs must be positive PostgreSQL integer IDs', () => {
  for (const project_id of [0, -1, 0.5, '1', null, true, Infinity, NaN, 2147483648]) invalid((body) => body.days[0].projects[0].project_id = project_id, /project ID/);
});

test('duplicate projects are rejected including zero-hour duplicate rows', () => {
  for (const hours of [0, 0.5]) invalid((body) => body.days[0].projects.push({ project_id: 1, hours }), /only be listed once per day/);
});

test('short working days need a nonblank justification but can validly record zero hours', () => {
  for (const justification of ['', '   ']) invalid((body) => { body.days[0].projects[0].hours = 7; body.days[0].justification = justification; }, /below 7.5/);
  invalid((body) => body.days[0].projects = [], /below 7.5/);
  const input = payload(); input.days[0].projects = []; input.days[0].justification = 'No project work today';
  assert.doesNotThrow(() => validateTimesheetPayload(input, WEEK));
});

test('positive Other entries require descriptions and may repeat by design', () => {
  const other = { entry_type: 'other', hours: 4, other_description: '  Coordination  ' };
  const input = payload(); input.days[0].projects = [other, { entry_type: 'other', hours: 4, other_description: 'Internal review' }];
  const normalized = validateTimesheetPayload(input, WEEK);
  assert.equal(normalized[0].projects.length, 2);
  assert.equal(normalized[0].projects[0].other_description, 'Coordination');
  for (const other_description of ['', '   ', undefined]) invalid((body) => body.days[0].projects = [{ entry_type: 'other', hours: 8, other_description }], /description/);
  for (const other_description of [null, 5, {}]) invalid((body) => body.days[0].projects = [{ entry_type: 'other', hours: 8, other_description }], /must be text/);
  invalid((body) => body.days[0].projects = [{ ...other, project_id: 1 }], /not a supported field/);
});

test('zero-hour Other placeholder can omit its description', () => {
  const input = payload(); input.days[0].projects.push({ entry_type: 'other', hours: 0 });
  assert.equal(validateTimesheetPayload(input, WEEK)[0].projects[1].other_description, '');
});

for (const type of ['sick_leave', 'local_leave', 'emergency_leave']) {
  test(`${type} accepts full and half leave but rejects invalid leave quantities`, () => {
    for (const leave_days of [0.5, 1]) {
      const input = payload(); input.days[0] = { date: dates[0], type, projects: [], leave_days, justification: leave_days === 0.5 ? 'Appointment' : '' };
      assert.equal(validateTimesheetPayload(input, WEEK)[0].leave_days, leave_days);
    }
    for (const leave_days of [0, -0.5, 0.25, 1.5, 2, '0.5', null, Infinity, NaN]) invalid((body) => { body.days[0].type = type; body.days[0].leave_days = leave_days; body.days[0].projects = []; }, /leave_days/);
  });
}

test('half-day leave uses the existing 3.5-hour explanation threshold', () => {
  invalid((body) => { Object.assign(body.days[0], { type: 'sick_leave', leave_days: 0.5 }); body.days[0].projects[0].hours = 3; }, /below 3.5/);
  const input = payload(); Object.assign(input.days[0], { type: 'local_leave', leave_days: 0.5 }); input.days[0].projects[0].hours = 3.5;
  assert.doesNotThrow(() => validateTimesheetPayload(input, WEEK));
  input.days[0].projects[0].hours = 6;
  assert.doesNotThrow(() => validateTimesheetPayload(input, WEEK));
});

test('full-day leave and public holidays cannot contain even zero-hour project placeholders', () => {
  for (const type of ['sick_leave', 'local_leave', 'emergency_leave', 'public_holiday']) {
    invalid((body) => { body.days[0].type = type; body.days[0].leave_days = 1; }, /must be empty/);
    invalid((body) => { body.days[0].type = type; body.days[0].leave_days = 1; body.days[0].projects[0].hours = 0; }, /must be empty/);
  }
});

test('public holiday requires one whole day; work cannot carry leave days', () => {
  const input = payload(); Object.assign(input.days[0], { type: 'public_holiday', projects: [], leave_days: 1 });
  assert.doesNotThrow(() => validateTimesheetPayload(input, WEEK));
  for (const leave_days of [0, 0.5, 2]) invalid((body) => Object.assign(body.days[0], { type: 'public_holiday', projects: [], leave_days }), /must be 1/);
  for (const leave_days of [0.5, 1, -1]) invalid((body) => body.days[0].leave_days = leave_days, /must be 0/);
});

test('submission can validate stored canonical days using the same rules without an API version body', () => {
  assert.equal(validateDays(payload().days, WEEK).length, 5);
  const days = payload().days; days[2].projects[0].hours = 1;
  assert.throws(() => validateDays(days, WEEK), (error) => error.status === 400 && /below 7.5/.test(error.message));
});

test('irrelevant full-leave explanations and excessive text cannot be silently discarded', () => {
  for (const type of ['sick_leave', 'local_leave', 'emergency_leave', 'public_holiday']) {
    invalid((body) => Object.assign(body.days[0], { type, leave_days: 1, projects: [], justification: 'Hidden work explanation' }), /must be empty/);
  }
  invalid((body) => body.days[0].justification = 'x'.repeat(4001), /4000/);
  invalid((body) => body.days[0].projects = [{ entry_type: 'other', hours: 8, other_description: 'x'.repeat(4001) }], /4000/);
});
