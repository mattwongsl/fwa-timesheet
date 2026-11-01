const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Payload = require('../public/js/timesheet-payload');
const { validateTimesheetPayload } = require('../validation/timesheets');
const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
function browserDays() {
  return dates.map((date) => ({ date, type: 'work', projects: [{ project_id: 1, project_name: 'Design project', hours: '7.5', archived: false }], justification: '', leave_days: 0, leave_hours: 0, leave_unit: 'hours' }));
}

test('browser values become a strict canonical snapshot accepted by backend validation', () => {
  const input = browserDays();
  input[1].projects = [{ entry_type: 'other', project_id: null, hours: '8', other_description: ' Coordination ', project_name: 'Read metadata' }];
  input[2].type = 'sick_leave'; input[2].leave_days = '0.5'; input[2].projects[0].hours = '3.5';
  const days = Payload.serializeDays(input);
  assert.doesNotThrow(() => validateTimesheetPayload({ days, version: 4 }, dates[0]));
  assert.deepEqual(days[0].projects[0], { project_id: 1, hours: 7.5 });
  assert.deepEqual(days[1].projects[0], { entry_type: 'other', hours: 8, other_description: 'Coordination' });
  assert.equal(days[2].leave_days, 0.5);
  assert.equal('leave_hours' in days[0], false);
  assert.equal('archived' in days[0].projects[0], false);
  assert.equal(input[0].projects[0].hours, '7.5');
});

test('full leave and public holidays clear stale hidden work fields without mutating editing state', () => {
  for (const type of ['sick_leave', 'local_leave', 'emergency_leave', 'public_holiday']) {
    const input = browserDays();
    input[0].type = type; input[0].leave_days = 1; input[0].justification = 'Old work explanation'; input[0].projects[0].hours = 'bad hidden input';
    const days = Payload.serializeDays(input);
    assert.deepEqual(days[0].projects, []);
    assert.equal(days[0].justification, '');
    assert.equal(days[0].leave_days, 1);
    assert.equal(input[0].projects[0].hours, 'bad hidden input');
    assert.doesNotThrow(() => validateTimesheetPayload({ days, version: 0 }, dates[0]));
  }
});

test('switching back to work clears stale leave units and quantities', () => {
  const input = browserDays(); input[0].leave_days = 0.5; input[0].leave_hours = 3.5; input[0].leave_unit = 'days';
  assert.equal(Payload.serializeDays(input)[0].leave_days, 0);
});

test('invalid or empty browser hour values are rejected without rounding or mutation', () => {
  for (const value of ['', ' ', '7.25', '-1', '25', 'NaN', Infinity, null, true]) {
    const input = browserDays(); input[0].projects[0].hours = value;
    assert.throws(() => Payload.serializeDays(input), /Hours|hours|half-hour|number/);
    assert.equal(input[0].projects[0].hours, value);
  }
});

test('valid entered hours and zero-hour placeholders are preserved exactly', () => {
  const input = browserDays(); input[0].projects[0].hours = '0'; input[0].justification = 'No client work today';
  assert.equal(Payload.serializeDays(input)[0].projects[0].hours, 0);
  assert.equal(Payload.hourError('7.5'), '');
  assert.match(Payload.hourError('7.25'), /half-hour/);
});

test('both employee and admin saves receive the same justification and daily-total checks', () => {
  const input = browserDays(); input[0].projects[0].hours = '7';
  assert.throws(() => Payload.serializeDays(input), /below 7.5/);
  input[0].type = 'local_leave'; input[0].leave_days = '0.5'; input[0].projects[0].hours = '3';
  assert.throws(() => Payload.serializeDays(input), /below 3.5/);
  input[0].justification = 'Appointment'; assert.doesNotThrow(() => Payload.serializeDays(input));
  input[0].projects = [{ project_id: 1, hours: '20' }, { project_id: 2, hours: '5' }];
  assert.throws(() => Payload.serializeDays(input), /exceed 24/);
});

test('duplicate projects, missing Other descriptions, invalid projects and invalid leave are rejected', () => {
  const input = browserDays(); input[0].projects.push({ project_id: 1, hours: '0' });
  assert.throws(() => Payload.serializeDays(input), /once per day/);
  input[0].projects = [{ entry_type: 'other', hours: '8', other_description: '' }];
  assert.throws(() => Payload.serializeDays(input), /describe every Other/);
  input[0].projects = [{ project_id: null, hours: '8' }];
  assert.throws(() => Payload.serializeDays(input), /project/);
  input[0].type = 'sick_leave'; input[0].leave_days = '0.25';
  assert.throws(() => Payload.serializeDays(input), /0.5 or 1/);
});

test('historical project metadata is stripped while its ID and exact hours survive serialization', () => {
  const input = browserDays(); input[0].projects[0].archived = true;
  assert.deepEqual(Payload.serializeDays(input)[0].projects[0], { project_id: 1, hours: 7.5 });
  assert.equal(Payload.frozenProject(input[0].projects[0], [{ id: 1 }]), true);
  assert.equal(Payload.frozenProject({ project_id: 12 }, [{ id: 1 }]), true);
  assert.equal(Payload.frozenProject({ project_id: 1 }, [{ id: 1 }]), false);
  assert.equal(Payload.frozenProject({ entry_type: 'other', hours: 1 }, []), false);
});

test('versions must come from the API and concurrency conflicts explain how to preserve/reconcile edits', () => {
  assert.equal(Payload.version(5), 5);
  for (const version of [undefined, null, '5', -1, 0.5]) assert.throws(() => Payload.version(version), /server has not supplied/);
  assert.match(Payload.errorMessage({ status: 409, message: 'Version conflict.' }), /Your edits are still here.*Reload this week/);
  assert.equal(Payload.errorMessage({ status: 400, message: 'Invalid hours.' }), 'Invalid hours.');
});

function employeeContext(put) {
  const elements = new Map();
  const context = vm.createContext({
    document: { querySelectorAll() { return []; }, getElementById(id) { if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '', innerHTML: '', style: {} }); return elements.get(id); } },
    Api: { put }, TimesheetPayload: Payload, fmtHours: String,
    setTimeout() { return 1; }, clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync('public/js/employee.js', 'utf8').replace(/\ninit\(\);\s*$/, ''), context);
  context.initialDays = browserDays();
  vm.runInContext('currentDays = initialDays; currentTimesheet = { id: 9, version: 4 }; editable = true;', context);
  return { context, elements };
}

test('employee save sends canonical numeric data and adopts the returned version', async () => {
  let sent;
  const { context } = employeeContext(async (url, body) => { sent = { url, body }; return { timesheet: { id: 9, version: 5 }, summary: {}, days: [] }; });
  assert.equal(await vm.runInContext('saveDraft()', context), true);
  assert.equal(sent.url, '/api/timesheets/9/entries');
  assert.equal(sent.body.version, 4);
  assert.equal(sent.body.days[0].projects[0].hours, 7.5);
  assert.equal(vm.runInContext('currentTimesheet.version', context), 5);
});

test('failed employee save preserves entered values and its original version on HTTP 409', async () => {
  const { context, elements } = employeeContext(async () => { throw Object.assign(new Error('Another employee/admin edit won.'), { status: 409 }); });
  vm.runInContext("currentDays[0].projects[0].hours = '9';", context);
  assert.equal(await vm.runInContext('saveDraft()', context), false);
  assert.equal(vm.runInContext('currentDays[0].projects[0].hours', context), '9');
  assert.equal(vm.runInContext('currentTimesheet.version', context), 4);
  assert.match(elements.get('saveMsg').textContent, /Your edits are still here/);
});

test('employee submission uses the newly returned save version', async () => {
  const calls = [];
  const { context } = employeeContext(async () => ({ timesheet: { id: 9, version: 5 }, summary: {} }));
  context.confirm = () => true;
  context.Api.post = async (url, body) => { calls.push({ url, body }); return { timesheet: { id: 9, version: 6 } }; };
  vm.runInContext('loadWeek = async () => {}; loadHistory = async () => {};', context);
  await vm.runInContext('submitTimesheet()', context);
  assert.equal(calls[0].url, '/api/timesheets/9/submit');
  assert.equal(calls[0].body.version, 5);
});

test('unlock request includes the current version and reason without inventing a new version', async () => {
  let sent;
  const { context, elements } = employeeContext(async () => {});
  context.Api.post = async (url, body) => { sent = { url, body }; return { request: { id: 3 } }; };
  context.document.getElementById('unlockReason').value = 'Correct project allocation';
  await vm.runInContext('requestUnlock()', context);
  assert.equal(sent.body.version, 4);
  assert.equal(sent.body.reason, 'Correct project allocation');
  assert.equal(vm.runInContext('currentTimesheet.version', context), 4);
  assert.match(elements.get('unlockMsg').textContent, /sent to admin/);
});

function adminContext(api) {
  const elements = new Map();
  const context = vm.createContext({
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { textContent: '', style: {} }); return elements.get(id); } },
    Api: api, TimesheetPayload: Payload
  });
  vm.runInContext(fs.readFileSync('public/js/admin.js', 'utf8').replace(/\ninit\(\);\s*$/, ''), context);
  context.initialDays = browserDays();
  vm.runInContext('editingDays = initialDays; editingTimesheetId = 7; editingTimesheetVersion = 4; editingSavedSnapshot = JSON.stringify(editingDays); loadTimesheets = async () => {}; loadStats = async () => {};', context);
  return { context, elements };
}

test('admin save and lock carry the latest response version through successive operations', async () => {
  let saved, locked;
  const { context } = adminContext({
    put: async (url, body) => { saved = { url, body }; return { timesheet: { id: 7, version: 5 } }; },
    post: async (url, body) => { locked = { url, body }; return { timesheet: { id: 7, version: 6 } }; }
  });
  await vm.runInContext('saveEditedTimesheet()', context);
  assert.equal(saved.body.version, 4);
  assert.equal(saved.body.days[0].projects[0].hours, 7.5);
  await vm.runInContext("lockUnlock('lock')", context);
  assert.equal(locked.url, '/api/admin/timesheets/7/lock');
  assert.equal(locked.body.version, 5);
});

test('admin save and locking conflicts leave the editor and typed data intact', async () => {
  const reject = async () => { throw Object.assign(new Error('Version conflict.'), { status: 409 }); };
  const { context, elements } = adminContext({ put: reject, post: reject });
  vm.runInContext("editingDays[0].projects[0].hours = '9';", context);
  await vm.runInContext('saveEditedTimesheet()', context);
  assert.match(elements.get('editMsg').textContent, /Your edits are still here/);
  await vm.runInContext("lockUnlock('lock')", context);
  assert.equal(vm.runInContext('editingDays[0].projects[0].hours', context), '9');
  assert.equal(vm.runInContext('editingTimesheetId', context), 7);
  assert.equal(vm.runInContext('editingTimesheetVersion', context), 4);
  assert.match(elements.get('editMsg').textContent, /Save your changes/);
  assert.equal(elements.get('editPanel')?.style.display, undefined);
});

test('admin refuses both lock transitions while typed changes are unsaved and makes no API request', async () => {
  let calls = 0;
  const { context, elements } = adminContext({ post: async () => { calls++; } });
  vm.runInContext("editingDays[0].projects[0].hours = '9';", context);
  for (const action of ['lock', 'unlock']) await vm.runInContext(`lockUnlock('${action}')`, context);
  assert.equal(calls, 0);
  assert.equal(vm.runInContext('editingTimesheetId', context), 7);
  assert.equal(vm.runInContext('editingDays[0].projects[0].hours', context), '9');
  assert.match(elements.get('editMsg').textContent, /Save your changes before locking or unlocking/);
});

test('admin explicit close asks before discarding dirty edits and respects cancellation', () => {
  const { context, elements } = adminContext({});
  vm.runInContext("editingDays[0].projects[0].hours = '9';", context);
  let confirmation;
  context.confirm = (message) => { confirmation = message; return false; };
  assert.equal(vm.runInContext('closeEditPanel()', context), false);
  assert.match(confirmation, /Discard your unsaved changes/);
  assert.equal(vm.runInContext('editingTimesheetId', context), 7);
  assert.equal(vm.runInContext('editingDays[0].projects[0].hours', context), '9');
  context.confirm = () => true;
  assert.equal(vm.runInContext('closeEditPanel()', context), true);
  assert.equal(vm.runInContext('editingTimesheetId', context), null);
  assert.equal(elements.get('editPanel').style.display, 'none');
});

test('edits entered during an admin save remain dirty after that earlier snapshot succeeds', async () => {
  let finish;
  const { context } = adminContext({ put: () => new Promise((resolve) => { finish = resolve; }) });
  const saving = vm.runInContext('saveEditedTimesheet()', context);
  vm.runInContext("editingDays[0].projects[0].hours = '9';", context);
  finish({ timesheet: { id: 7, version: 5 } });
  await saving;
  assert.equal(vm.runInContext('hasUnsavedTimesheetChanges()', context), true);
  assert.equal(vm.runInContext('editingTimesheetVersion', context), 5);
});

test('a clean admin editor still reports a server-side lock conflict without closing', async () => {
  const { context, elements } = adminContext({ post: async () => { throw Object.assign(new Error('Version conflict.'), { status: 409 }); } });
  await vm.runInContext("lockUnlock('lock')", context);
  assert.equal(vm.runInContext('editingTimesheetId', context), 7);
  assert.match(elements.get('editMsg').textContent, /Your edits are still here/);
});

test('submit stops after an earlier draft saves if newer edits were typed during that save', async () => {
  let finish, posts = 0;
  const { context, elements } = employeeContext(() => new Promise((resolve) => { finish = resolve; }));
  context.confirm = () => true;
  context.Api.post = async () => { posts++; };
  const submitting = vm.runInContext('submitTimesheet()', context);
  vm.runInContext("currentDays[0].projects[0].hours = '8';", context);
  finish({ timesheet: { id: 9, version: 5 }, summary: {} });
  await submitting;
  assert.equal(posts, 0);
  assert.equal(vm.runInContext('currentTimesheet.version', context), 5);
  assert.equal(vm.runInContext('currentDays[0].projects[0].hours', context), '8');
  assert.match(elements.get('saveMsg').textContent, /Newer edits.*not been saved/);
});

test('a delayed save response never replaces a newly loaded week or its version', async () => {
  let finish;
  const { context } = employeeContext(() => new Promise((resolve) => { finish = resolve; }));
  const saving = vm.runInContext('saveDraft()', context);
  vm.runInContext("weekLoadVersion++; currentTimesheet={id:10,version:8}; currentDays[0].projects[0].hours='9';", context);
  finish({ timesheet: { id: 9, version: 5 }, summary: {} });
  assert.equal(await saving, false);
  assert.equal(vm.runInContext('currentTimesheet.id', context), 10);
  assert.equal(vm.runInContext('currentTimesheet.version', context), 8);
  assert.equal(vm.runInContext('currentDays[0].projects[0].hours', context), '9');
});

test('submit response preserves any newer model edits rather than loading over them', async () => {
  let finish;
  const { context, elements } = employeeContext(async () => ({ timesheet: { id: 9, version: 5 }, summary: {} }));
  context.confirm = () => true;
  context.Api.post = () => new Promise((resolve) => { finish = resolve; });
  vm.runInContext('renderDays=()=>{}; loadHistory=async()=>{}; loadWeek=async()=>{throw Error("Must not overwrite newer model")};', context);
  const submitting = vm.runInContext('submitTimesheet()', context);
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("currentDays[0].projects[0].hours='8';", context);
  finish({ timesheet: { id: 9, version: 6, locked: true } });
  await submitting;
  assert.equal(vm.runInContext('currentDays[0].projects[0].hours', context), '8');
  assert.equal(vm.runInContext('currentTimesheet.version', context), 6);
  assert.equal(vm.runInContext('editable', context), false);
  assert.match(elements.get('saveMsg').textContent, /Newer edits are still here/);
});

test('admin lock response keeps edits typed while the lock request is in flight', async () => {
  let finish;
  const { context, elements } = adminContext({ post: () => new Promise((resolve) => { finish = resolve; }) });
  const locking = vm.runInContext("lockUnlock('lock')", context);
  vm.runInContext("editingDays[0].projects[0].hours='8';", context);
  finish({ timesheet: { id: 7, version: 5 } });
  await locking;
  assert.equal(vm.runInContext('editingTimesheetId', context), 7);
  assert.equal(vm.runInContext('editingTimesheetVersion', context), 5);
  assert.equal(vm.runInContext('editingDays[0].projects[0].hours', context), '8');
  assert.match(elements.get('editMsg').textContent, /Newer edits are still here/);
});

test('a state response cannot close or overwrite a different admin editor session', async () => {
  let finish;
  const { context } = adminContext({ post: () => new Promise((resolve) => { finish = resolve; }) });
  const locking = vm.runInContext("lockUnlock('lock')", context);
  vm.runInContext('editingSession++; editingTimesheetId=8; editingTimesheetVersion=12;', context);
  finish({ timesheet: { id: 7, version: 5 } });
  await locking;
  assert.equal(vm.runInContext('editingTimesheetId', context), 8);
  assert.equal(vm.runInContext('editingTimesheetVersion', context), 12);
});

test('legacy/inactive conflicts preserve edits without misleading stale-revision instructions', () => {
  for (const message of ['Legacy notes require explicit review.', 'This employee is inactive.']) {
    const result = Payload.errorMessage({ status: 409, message });
    assert.match(result, /Your edits are still here/);
    assert.doesNotMatch(result, /Reload this week/);
  }
});

test('missing server revision blocks saving while preserving edits and explaining the update requirement', async () => {
  let calls = 0;
  const { context, elements } = employeeContext(async () => { calls++; });
  vm.runInContext("currentTimesheet={id:9};savedDaysSnapshot=JSON.stringify(currentDays);currentDays[0].projects[0].hours='8';", context);
  assert.equal(await vm.runInContext('saveDraft()', context), false);
  assert.equal(calls, 0);
  assert.equal(vm.runInContext('currentDays[0].projects[0].hours', context), '8');
  assert.equal(vm.runInContext('hasUnsavedTimesheetChanges()', context), true);
  assert.match(elements.get('saveMsg').textContent, /finish updating the app/);
  assert.match(elements.get('saveMsg').textContent, /Reloading alone will not fix/);
});

test('successful saves clear dirty state only for the snapshot that was actually saved', async () => {
  let finish;
  const { context } = employeeContext(() => new Promise((resolve) => { finish = resolve; }));
  vm.runInContext("savedDaysSnapshot=JSON.stringify(currentDays);currentDays[0].projects[0].hours='8';", context);
  assert.equal(vm.runInContext('hasUnsavedTimesheetChanges()', context), true);
  const saving = vm.runInContext('saveDraft()', context);
  vm.runInContext("currentDays[0].projects[0].hours='9';", context);
  finish({ timesheet: { id: 9, version: 5 }, summary: {} });
  await saving;
  assert.equal(vm.runInContext('hasUnsavedTimesheetChanges()', context), true);
  context.Api.put = async () => ({ timesheet: { id: 9, version: 6 }, summary: {} });
  await vm.runInContext('saveDraft()', context);
  assert.equal(vm.runInContext('hasUnsavedTimesheetChanges()', context), false);
});

test('declining a week change preserves unsaved entries and makes no API request', async () => {
  const { context } = employeeContext(async () => {});
  context.confirm = () => false;
  context.Api.get = async () => { throw Error('Week must not load'); };
  vm.runInContext("savedDaysSnapshot=JSON.stringify(currentDays);currentDays[0].projects[0].hours='8';", context);
  await vm.runInContext("loadWeek('2026-11-02')", context);
  assert.equal(vm.runInContext('currentTimesheet.id', context), 9);
  assert.equal(vm.runInContext('currentDays[0].projects[0].hours', context), '8');
});

test('reload/leave warning is requested only when the current page has unsaved changes', () => {
  let handler, dirty = true, prevented = 0;
  const context = vm.createContext({ window: { addEventListener(name, fn) { assert.equal(name, 'beforeunload'); handler = fn; } }, hasUnsavedTimesheetChanges: () => dirty });
  vm.runInContext(fs.readFileSync('public/js/api.js', 'utf8'), context);
  const event = { preventDefault() { prevented++; } };
  handler(event);
  assert.equal(prevented, 1);
  assert.equal(event.returnValue, '');
  dirty = false;
  handler({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
});

test('canceling a dirty logout preserves the login session before any logout API request', async () => {
  let calls = 0;
  const context = vm.createContext({ window: { addEventListener() {}, location: { href: '' } }, hasUnsavedTimesheetChanges: () => true, confirm: () => false });
  vm.runInContext(fs.readFileSync('public/js/api.js', 'utf8'), context);
  context.logoutRequest = async () => { calls++; };
  vm.runInContext('Api.post=logoutRequest;', context);
  await vm.runInContext('logout()', context);
  assert.equal(calls, 0);
  assert.equal(context.window.location.href, '');
});

test('confirmed dirty logout leaves once without a second unload warning', async () => {
  let handler, calls = 0;
  const context = vm.createContext({ window: { addEventListener(name, fn) { handler = fn; }, location: { href: '' } }, hasUnsavedTimesheetChanges: () => true, confirm: () => true });
  vm.runInContext(fs.readFileSync('public/js/api.js', 'utf8'), context);
  context.logoutRequest = async () => { calls++; };
  vm.runInContext('Api.post=logoutRequest;', context);
  await vm.runInContext('logout()', context);
  assert.equal(calls, 1);
  assert.equal(context.window.location.href, '/index.html');
  handler({ preventDefault() { throw Error('Already confirmed'); } });
});
