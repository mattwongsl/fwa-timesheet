const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Refuse even to import application database code without the isolated runner.
const database = new URL(process.env.TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.FWA_ISOLATED_TEST !== '1' || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL
    || database.hostname !== '127.0.0.1' || database.pathname !== '/fwa_phase2_test'
    || !process.env.FWA_TEST_CLUSTER_TOKEN || !process.env.FWA_TEST_CLUSTER_DIR) {
  throw new Error('Integration tests require scripts/test-postgres.js and its fresh, guarded local database. No configured database was used.');
}
const pool = require('../../db/pool');
const { migrate, assertSchemaReady } = require('../../db/migrationRunner');
const { currentWeekStart, weekDays, addDays } = require('../../utils');
let server, origin, users, projects;
const week = currentWeekStart();
const hash = bcrypt.hashSync('Synthetic-password-123!', 4);

async function token(user, claims = {}) {
  const { digest } = require('../../security/sessions');
  const sid = require('crypto').createHash('sha256').update('synthetic-session-' + user.id).digest('hex');
  return jwt.sign({ id: user.id, sid, name: user.name, email: user.email, role: user.role, ...claims }, process.env.JWT_SECRET, { expiresIn: '1h' });
}
async function request(method, route, body, user = users.employee, claims) {
  const csrfResponse = await fetch(origin + '/api/auth/csrf');
  const csrf = (await csrfResponse.json()).csrfToken;
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Cookie: `csrf=${csrf}` };
  if (user) headers.Cookie += `; token=${await token(user, claims)}`;
  const response = await fetch(origin + route, { method, headers, body: body === undefined ? (['GET','HEAD'].includes(method) ? undefined : '{}') : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
}
function expectStatus(response, status) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  if (status >= 400) assert.equal(typeof response.body.error, 'string');
  return response.body;
}
function days(project = projects.first.id, hours = 7.5, start = week) {
  return weekDays(start).map((date) => ({ date, type: 'work', projects: [{ project_id: project, hours }], justification: '', leave_days: 0 }));
}
async function mySheet(user = users.employee, start = week) {
  return expectStatus(await request('GET', `/api/timesheets/mine?week=${start}`, undefined, user), 200).timesheet;
}
async function save(sheet, content = days(), user = users.employee, admin = false) {
  return request('PUT', `${admin ? '/api/admin' : '/api'}/timesheets/${sheet.id}/entries`, { version: sheet.version, days: content }, user);
}
async function savedSheet(content = days(), user = users.employee) {
  const sheet = await mySheet(user);
  return expectStatus(await save(sheet, content, user), 200).timesheet;
}
async function snapshot(id) {
  return (await pool.query('SELECT * FROM timesheet_entries WHERE timesheet_id=$1 ORDER BY id', [id])).rows;
}
async function waitForLockers(fragment, count) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE $1", [`%${fragment}%`]);
    if (result.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} concurrent database operations waiting on ${fragment}.`);
}
async function withBlocker(sql, values, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query(sql, values);
    return await operation(async () => { await client.query('COMMIT'); });
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
}
async function sqlReject(sql, values, code) {
  await assert.rejects(pool.query(sql, values), (err) => { assert.equal(err.code, code, err.message); return true; });
}

test.before(async () => {
  const identity = await pool.query('SHOW data_directory');
  assert.equal(await fs.realpath(identity.rows[0].data_directory), await fs.realpath(process.env.FWA_TEST_CLUSTER_DIR));
  assert.equal((await pool.query('SELECT token FROM public.fwa_test_cluster_guard')).rows[0]?.token, process.env.FWA_TEST_CLUSTER_TOKEN);
  await migrate(pool);
  await assertSchemaReady(pool);
  const app = require('../../app');
  server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await pool.query('TRUNCATE auth_sessions, password_reset_tokens, timesheet_entries, unlock_requests, timesheets, projects, users RESTART IDENTITY');
  const employees = (await pool.query(
    `INSERT INTO users(name,email,password_hash,role) VALUES
     ('Synthetic Admin','admin@example.test',$1,'admin'),('Synthetic Admin Two','admin2@example.test',$1,'admin'),
     ('Synthetic Employee','employee@example.test',$1,'employee'),('Synthetic Other','other@example.test',$1,'employee') RETURNING *`, [hash]
  )).rows;
  for (const user of employees) {
    const sid = require('crypto').createHash('sha256').update('synthetic-session-' + user.id).digest('hex');
    await pool.query("INSERT INTO auth_sessions(id_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [require('../../security/sessions').digest(sid), user.id]);
  }
  users = { admin: employees[0], admin2: employees[1], employee: employees[2], other: employees[3] };
  const rows = (await pool.query("INSERT INTO projects(name) VALUES('Synthetic Architecture'),('Synthetic Restoration') RETURNING *")).rows;
  projects = { first: rows[0], second: rows[1] };
});

test.after(async () => {
  if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  await pool.end();
});

test('valid full-week save persists exact hours, increments version, and submits atomically', async () => {
  const sheet = await savedSheet();
  assert.equal(sheet.version, 1);
  const entries = await snapshot(sheet.id);
  assert.equal(entries.length, 5);
  assert.equal(entries.reduce((sum, e) => sum + Number(e.hours), 0), 37.5);
  const submitted = expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version }), 200).timesheet;
  assert.equal(submitted.locked, true); assert.equal(submitted.admin_unlocked, false); assert.equal(submitted.version, 2);
});

test('backend rejects malformed snapshots and preserves every previously saved entry', async () => {
  const sheet = await savedSheet();
  const previous = await snapshot(sheet.id);
  const cases = [
    ['missing days', (b) => { delete b.days; }],
    ['missing version', (b) => { delete b.version; }],
    ['unknown owner', (b) => { b.user_id = users.other.id; }],
    ['unknown lock flag', (b) => { b.locked = false; }],
    ['missing work date', (b) => { delete b.days[0].date; }],
    ['invalid date', (b) => { b.days[0].date = '2026-02-30'; }],
    ['outside week', (b) => { b.days[0].date = addDays(week, 7); }],
    ['weekend', (b) => { b.days[0].date = addDays(week, 5); }],
    ['duplicate date', (b) => { b.days[1].date = b.days[0].date; }],
    ['incomplete week', (b) => { b.days.pop(); }],
    ['negative hours', (b) => { b.days[0].projects[0].hours = -1; }],
    ['non-finite JSON value', (b) => { b.days[0].projects[0].hours = Infinity; }],
    ['numeric string', (b) => { b.days[0].projects[0].hours = '7.5'; }],
    ['missing hours', (b) => { delete b.days[0].projects[0].hours; }],
    ['unsupported increment', (b) => { b.days[0].projects[0].hours = 7.25; }],
    ['unreasonable hours', (b) => { b.days[0].projects[0].hours = 24.5; }],
    ['unreasonable combined total', (b) => { b.days[0].projects = [{ project_id: projects.first.id, hours: 14 }, { project_id: projects.second.id, hours: 14 }]; }],
    ['duplicate project', (b) => { b.days[0].projects.push({ ...b.days[0].projects[0] }); }],
    ['invalid project id', (b) => { b.days[0].projects[0].project_id = '1'; }],
    ['unknown leave type', (b) => { b.days[0].type = 'made_up_leave'; }],
    ['invalid leave amount', (b) => { Object.assign(b.days[0], { type: 'sick_leave', leave_days: 0.75, projects: [] }); }],
    ['missing work justification', (b) => { b.days[0].projects[0].hours = 3; }],
    ['missing half-day justification', (b) => { Object.assign(b.days[0], { type: 'sick_leave', leave_days: 0.5 }); b.days[0].projects[0].hours = 2; }],
    ['full leave mixed with work', (b) => { Object.assign(b.days[0], { type: 'local_leave', leave_days: 1 }); }],
    ['malformed project structure', (b) => { b.days[0].projects = {}; }],
    ['unknown day field', (b) => { b.days[0].owner = users.other.id; }],
    ['missing Other description', (b) => { b.days[0].projects = [{ entry_type: 'other', hours: 7.5 }]; }]
  ];
  for (const [label, mutate] of cases) {
    const body = { version: sheet.version, days: days() }; mutate(body);
    const result = await request('PUT', `/api/timesheets/${sheet.id}/entries`, body);
    assert.equal(result.status, 400, `${label}: ${JSON.stringify(result.body)}`);
    assert.deepEqual(await snapshot(sheet.id), previous, label);
  }
});

test('valid half-day leave, short-day justification, Other work and public holiday survive round trip', async () => {
  const content = days();
  content[0] = { ...content[0], type: 'sick_leave', leave_days: 0.5, projects: [{ project_id: projects.first.id, hours: 3.5 }] };
  content[1] = { ...content[1], projects: [{ project_id: projects.first.id, hours: 2 }], justification: 'Approved studio appointment.' };
  content[2] = { ...content[2], projects: [{ entry_type: 'other', hours: 7.5, other_description: 'Internal design research' }] };
  content[3] = { ...content[3], type: 'public_holiday', leave_days: 1, projects: [] };
  const sheet = await savedSheet(content);
  const detail = expectStatus(await request('GET', '/api/timesheets/mine'), 200);
  assert.equal(detail.timesheet.id, sheet.id);
  assert.equal(detail.days[0].leave_days, 0.5);
  assert.equal(detail.days[1].justification, 'Approved studio appointment.');
  assert.equal(detail.days[2].projects[0].other_description, 'Internal design research');
  assert.equal(detail.days[3].type, 'public_holiday');
  expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version }), 200);
});

test('nonexistent projects are rejected before replacing entries', async () => {
  const sheet = await savedSheet(); const previous = await snapshot(sheet.id);
  expectStatus(await save(sheet, days(2147483647)), 400);
  assert.deepEqual(await snapshot(sheet.id), previous);
});

test('employees cannot change another owner or impersonate an administrator', async () => {
  const sheet = await mySheet(users.other);
  expectStatus(await save(sheet), 403);
  expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: 0 }), 403);
  expectStatus(await request('PUT', `/api/admin/timesheets/${sheet.id}/entries`, { version: 0, days: days() }, users.employee, { role: 'admin' }), 403);
  expectStatus(await request('POST', '/api/admin/unlock-requests/1/approve', {}, users.employee), 403);
  expectStatus(await request('GET', '/api/timesheets/mine', undefined, null), 401);
});

test('deactivation immediately invalidates an existing token and preserves historical readability for admins', async () => {
  const sheet = await savedSheet(); const previous = await snapshot(sheet.id);
  expectStatus(await request('PATCH', `/api/employees/${users.employee.id}/deactivate`, {}, users.admin), 200);
  expectStatus(await request('PUT', `/api/timesheets/${sheet.id}/entries`, { version: sheet.version, days: days() }), 401);
  expectStatus(await request('GET', '/api/timesheets/mine'), 401);
  expectStatus(await request('GET', `/api/admin/timesheets/${sheet.id}`, undefined, users.admin), 200);
  expectStatus(await request('PUT', `/api/admin/timesheets/${sheet.id}/entries`, { version: sheet.version, days: days() }, users.admin), 409);
  assert.deepEqual(await snapshot(sheet.id), previous);
  const stats = expectStatus(await request('GET', `/api/admin/stats?from=${week}&to=${addDays(week, 4)}`, undefined, users.admin), 200);
  assert.equal(Number(stats.by_employee.find((e) => e.user_id === users.employee.id).work_hours), 37.5);
  expectStatus(await request('PATCH', `/api/employees/${users.employee.id}/reactivate`, {}, users.admin), 200);
  expectStatus(await request('GET', '/api/timesheets/mine/history'), 401);
  // Simulate a fresh successful login after reactivation; old sessions stay revoked.
  const sid = require('crypto').createHash('sha256').update('synthetic-session-' + users.employee.id).digest('hex');
  await pool.query("INSERT INTO auth_sessions(id_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [require('../../security/sessions').digest(sid), users.employee.id]);
  const history = expectStatus(await request('GET', '/api/timesheets/mine/history'), 200);
  assert.equal(history.timesheets[0].timesheet.id, sheet.id);
});

test('submitted sheets reject employee saves until a valid administrator unlock', async () => {
  let sheet = await savedSheet();
  sheet = expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version }), 200).timesheet;
  expectStatus(await save(sheet), 423);
  sheet = expectStatus(await request('POST', `/api/admin/timesheets/${sheet.id}/unlock`, { version: sheet.version }, users.admin), 200).timesheet;
  assert.equal(sheet.locked, false); assert.equal(sheet.admin_unlocked, true);
  expectStatus(await save(sheet), 200);
});

test('submission validates persisted entries instead of trusting a previous browser validation', async () => {
  const sheet = await mySheet();
  expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version }), 400);
  assert.equal((await pool.query('SELECT locked FROM timesheets WHERE id=$1', [sheet.id])).rows[0].locked, false);
});

test('past and future employee weeks remain read-only until an eligible past-week unlock', async () => {
  const past = await mySheet(users.employee, addDays(week, -7));
  expectStatus(await save(past, days(projects.first.id, 7.5, past.week_start)), 423);
  const reopened = expectStatus(await request('POST', `/api/admin/timesheets/${past.id}/unlock`, { version: past.version }, users.admin), 200).timesheet;
  expectStatus(await save(reopened, days(projects.first.id, 7.5, past.week_start)), 200);
  const future = await mySheet(users.employee, addDays(week, 7));
  expectStatus(await save(future, days(projects.first.id, 7.5, future.week_start)), 423);
  expectStatus(await request('POST', `/api/admin/timesheets/${future.id}/unlock`, { version: future.version }, users.admin), 409);
});

test('unlock requests resolve once and an old approval cannot reopen a newly locked timesheet', async () => {
  let sheet = await savedSheet();
  sheet = expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version }), 200).timesheet;
  const unlock = expectStatus(await request('POST', `/api/timesheets/${sheet.id}/request-unlock`, { version: sheet.version, reason: 'Correct project allocation.' }), 201).request;
  expectStatus(await request('POST', `/api/admin/unlock-requests/${unlock.id}/approve`, {}, users.admin), 200);
  sheet = (await pool.query('SELECT * FROM timesheets WHERE id=$1', [sheet.id])).rows[0];
  expectStatus(await request('POST', `/api/admin/timesheets/${sheet.id}/lock`, { version: sheet.version }, users.admin), 200);
  expectStatus(await request('POST', `/api/admin/unlock-requests/${unlock.id}/approve`, {}, users.admin), 409);
  expectStatus(await request('POST', `/api/admin/unlock-requests/${unlock.id}/deny`, {}, users.admin), 409);
  assert.equal((await pool.query('SELECT locked FROM timesheets WHERE id=$1', [sheet.id])).rows[0].locked, true);
});

test('concurrent unlock requests create exactly one pending record', async () => {
  let sheet = await savedSheet();
  sheet = expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version }), 200).timesheet;
  const result = await Promise.all([1, 2].map(() => request('POST', `/api/timesheets/${sheet.id}/request-unlock`, { version: sheet.version, reason: 'Synthetic correction.' })));
  assert.deepEqual(result.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM unlock_requests WHERE timesheet_id=$1 AND status='pending'", [sheet.id])).rows[0].n, 1);
});

test('stale pending approval cannot undo a later administrative change', async () => {
  let sheet = await savedSheet();
  sheet = expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version }), 200).timesheet;
  const unlock = expectStatus(await request('POST', `/api/timesheets/${sheet.id}/request-unlock`, { version: sheet.version, reason: '' }), 201).request;
  expectStatus(await save(sheet, days(projects.second.id), users.admin, true), 200);
  expectStatus(await request('POST', `/api/admin/unlock-requests/${unlock.id}/approve`, {}, users.admin), 409);
  expectStatus(await request('POST', `/api/admin/unlock-requests/${unlock.id}/deny`, {}, users.admin), 200);
});

test('archived project hours remain readable and unchanged snapshots remain savable', async () => {
  let sheet = await savedSheet();
  expectStatus(await request('PATCH', `/api/projects/${projects.first.id}/archive`, {}, users.admin), 200);
  const loaded = expectStatus(await request('GET', '/api/timesheets/mine'), 200);
  assert.equal(loaded.days[0].projects[0].archived, true);
  sheet = expectStatus(await save(sheet), 200).timesheet;
  const before = await snapshot(sheet.id);
  const changed = days(); changed[0].projects[0].hours = 8;
  expectStatus(await save(sheet, changed), 400);
  expectStatus(await save(sheet, days(projects.second.id)), 400);
  assert.deepEqual(await snapshot(sheet.id), before);
  const another = await mySheet(users.other);
  expectStatus(await save(another, days(), users.other), 400);
  expectStatus(await request('PATCH', `/api/projects/${projects.first.id}/unarchive`, {}, users.admin), 200);
  expectStatus(await save(sheet, changed), 200);
});

test('employee and project deletion protect history; unused records can still be removed', async () => {
  const sheet = await savedSheet(); const before = await snapshot(sheet.id);
  expectStatus(await request('DELETE', `/api/projects/${projects.first.id}`, undefined, users.admin), 409);
  expectStatus(await request('DELETE', `/api/employees/${users.employee.id}`, undefined, users.admin), 409);
  await sqlReject('DELETE FROM projects WHERE id=$1', [projects.first.id], '23503');
  await sqlReject('DELETE FROM users WHERE id=$1', [users.employee.id], '23503');
  await sqlReject('DELETE FROM timesheets WHERE id=$1', [sheet.id], '23503');
  assert.deepEqual(await snapshot(sheet.id), before);
  expectStatus(await request('DELETE', `/api/projects/${projects.second.id}`, undefined, users.admin), 200);
  expectStatus(await request('DELETE', `/api/employees/${users.other.id}`, undefined, users.admin), 200);
});

test('administrators cannot deactivate or delete themselves', async () => {
  expectStatus(await request('PATCH', `/api/employees/${users.admin.id}/deactivate`, {}, users.admin), 400);
  expectStatus(await request('DELETE', `/api/employees/${users.admin.id}`, undefined, users.admin), 400);
});

test('a failure after DELETE and partial INSERT rolls back entries and version', async () => {
  const sheet = await savedSheet(); const before = await snapshot(sheet.id);
  await pool.query(`CREATE FUNCTION phase2_test_replacement_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.project_id = ${projects.second.id} THEN RAISE EXCEPTION 'Synthetic insert failure' USING ERRCODE='23514'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER phase2_test_replacement_failure BEFORE INSERT ON timesheet_entries FOR EACH ROW EXECUTE FUNCTION phase2_test_replacement_failure();`);
  try {
    const changed = days(); changed[1].projects = [{ project_id: projects.second.id, hours: 7.5 }];
    const response = await save(sheet, changed);
    assert.ok(response.status >= 400, JSON.stringify(response.body));
    assert.deepEqual(await snapshot(sheet.id), before);
    assert.equal((await pool.query('SELECT version FROM timesheets WHERE id=$1', [sheet.id])).rows[0].version, sheet.version);
  } finally { await pool.query('DROP TRIGGER phase2_test_replacement_failure ON timesheet_entries; DROP FUNCTION phase2_test_replacement_failure()'); }
});

test('overlapping saves serialize and reject the stale writer without mixed entries', async () => {
  const sheet = await savedSheet();
  const responses = await withBlocker('SELECT id FROM timesheets WHERE id=$1 FOR UPDATE', [sheet.id], async (release) => {
    const first = save(sheet, days()); const second = save(sheet, days(projects.second.id));
    await waitForLockers('timesheets', 2); await release();
    return Promise.all([first, second]);
  });
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const entries = await snapshot(sheet.id);
  assert.equal(entries.length, 5); assert.equal(new Set(entries.map((e) => e.project_id)).size, 1);
});

test('overlapping save and submit produce one coherent winner', async () => {
  const sheet = await savedSheet(); const changed = days(); changed[0].projects[0].hours = 8;
  const responses = await withBlocker('SELECT id FROM timesheets WHERE id=$1 FOR UPDATE', [sheet.id], async (release) => {
    const saving = save(sheet, changed);
    const submitting = request('POST', `/api/timesheets/${sheet.id}/submit`, { version: sheet.version });
    await waitForLockers('timesheets', 2); await release();
    return Promise.all([saving, submitting]);
  });
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = (await pool.query('SELECT * FROM timesheets WHERE id=$1', [sheet.id])).rows[0];
  const total = (await snapshot(sheet.id)).reduce((sum, e) => sum + Number(e.hours), 0);
  assert.equal(current.version, sheet.version + 1);
  assert.equal(total, current.locked ? 37.5 : 38);
});

test('overlapping save and administrator lock cannot modify hours after locking', async () => {
  const sheet = await savedSheet();
  const responses = await withBlocker('SELECT id FROM timesheets WHERE id=$1 FOR UPDATE', [sheet.id], async (release) => {
    const saving = save(sheet, days(projects.second.id));
    const locking = request('POST', `/api/admin/timesheets/${sheet.id}/lock`, { version: sheet.version }, users.admin);
    await waitForLockers('timesheets', 2); await release();
    return Promise.all([saving, locking]);
  });
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = (await pool.query('SELECT * FROM timesheets WHERE id=$1', [sheet.id])).rows[0];
  const entries = await snapshot(sheet.id);
  assert.equal(new Set(entries.map((e) => e.project_id)).size, 1);
  if (current.locked) { assert.equal(entries[0].project_id, projects.first.id); expectStatus(await save(current), 423); }
});

test('project archive commits ahead of a waiting save and blocks new hours', async () => {
  const sheet = await mySheet();
  const responses = await withBlocker('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projects.first.id], async (release) => {
    const archival = request('PATCH', `/api/projects/${projects.first.id}/archive`, {}, users.admin);
    await waitForLockers('projects', 1);
    const saving = save(sheet);
    await waitForLockers('projects', 2); await release();
    return Promise.all([archival, saving]);
  });
  assert.equal(responses[0].status, 200); assert.equal(responses[1].status, 400);
  assert.equal((await snapshot(sheet.id)).length, 0);
});

test('deactivation commits ahead of a waiting save and blocks stale authentication', async () => {
  const sheet = await mySheet();
  const responses = await withBlocker('SELECT id FROM users WHERE id=$1 FOR UPDATE', [users.employee.id], async (release) => {
    const deactivation = request('PATCH', `/api/employees/${users.employee.id}/deactivate`, {}, users.admin);
    await waitForLockers('users', 1);
    const saving = save(sheet);
    await waitForLockers('users', 2); await release();
    return Promise.all([deactivation, saving]);
  });
  assert.equal(responses[0].status, 200); assert.equal(responses[1].status, 401);
  assert.equal((await snapshot(sheet.id)).length, 0);
});

test('database constraints independently reject invalid precision, dates, duplicates and relationships', async () => {
  const sheet = await savedSheet();
  const insert = 'INSERT INTO timesheet_entries(timesheet_id,work_date,entry_type,project_id,hours) VALUES($1,$2,\'work\',$3,$4)';
  await sqlReject(insert, [sheet.id, week, projects.second.id, -1], '23514');
  await sqlReject(insert, [sheet.id, week, projects.second.id, 1.25], '23514');
  await sqlReject(insert, [sheet.id, week, projects.second.id, null], '23502');
  await sqlReject(insert, [sheet.id, week, 2147483647, 1], '23503');
  await sqlReject(insert, [2147483647, week, projects.second.id, 1], '23503');
  await sqlReject(insert, [sheet.id, week, projects.first.id, 1], '23505');
  await sqlReject(insert, [sheet.id, addDays(week, 7), projects.second.id, 1], '23514');
  await sqlReject(insert, [sheet.id, addDays(week, 5), projects.second.id, 1], '23514');
  await sqlReject('UPDATE timesheets SET locked=true,admin_unlocked=true WHERE id=$1', [sheet.id], '23514');
  await sqlReject('UPDATE timesheets SET week_start=$2 WHERE id=$1', [sheet.id, addDays(week, 7)], '23514');
  await sqlReject("INSERT INTO unlock_requests(timesheet_id,requested_by) VALUES($1,$2)", [sheet.id, users.other.id], '23503');
});

test('database cross-row constraints reject more than 24 hours and full-day leave mixed with work', async () => {
  const sheet = await savedSheet();
  await sqlReject("INSERT INTO timesheet_entries(timesheet_id,work_date,entry_type,project_id,hours) VALUES($1,$2,'work',$3,20)", [sheet.id, week, projects.second.id], '23514');
  await sqlReject("INSERT INTO timesheet_entries(timesheet_id,work_date,entry_type,hours,days,leave_unit) VALUES($1,$2,'public_holiday',0,1,'days')", [sheet.id, week], '23514');
  assert.equal((await snapshot(sheet.id)).length, 5);
});

test('malformed identifiers, state bodies and query filters return understandable HTTP 400 errors', async () => {
  expectStatus(await request('PUT', '/api/timesheets/1abc/entries', { version: 0, days: days() }), 400);
  expectStatus(await request('GET', '/api/timesheets/mine?week=2026-02-30'), 400);
  expectStatus(await request('GET', '/api/admin/timesheets?user_id=not-a-number', undefined, users.admin), 400);
  expectStatus(await request('GET', '/api/admin/stats?from=2026-12-01&to=2026-01-01', undefined, users.admin), 400);
  expectStatus(await request('POST', '/api/projects', { name: 5 }, users.admin), 400);
  expectStatus(await request('POST', '/api/employees', { name: 'Synthetic', email: 'synthetic@example.test', role: 'superuser' }, users.admin), 400);
  const sheet = await mySheet();
  expectStatus(await request('POST', `/api/timesheets/${sheet.id}/submit`, { version: 0, locked: false }), 400);
});

test('zero-hour Other descriptions survive save and reload without being silently discarded', async () => {
  const content = days();
  content[0].projects = [{ entry_type: 'other', hours: 0, other_description: 'Internal design review pending allocation' }];
  content[0].justification = 'No billable project work today.';
  const sheet = await savedSheet(content);
  const detail = expectStatus(await request('GET', '/api/timesheets/mine'), 200);
  assert.equal(detail.days[0].projects[0].hours, 0);
  assert.equal(detail.days[0].projects[0].other_description, 'Internal design review pending allocation');
  assert.equal((await snapshot(sheet.id)).filter((entry) => entry.entry_type === 'other').length, 1);
});

test('unchanged legacy metadata and row identities survive another-day saves; protected edits fail safely', async () => {
  await pool.query('ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS notes TEXT, ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC');
  const content = days();
  content[0].projects = [{ entry_type: 'other', hours: 7.5, other_description: 'Internal design review' }];
  let sheet = await savedSheet(content);
  const first = (await snapshot(sheet.id)).find((entry) => entry.entry_type === 'other');
  await pool.query("UPDATE timesheet_entries SET notes='Keep imported note', overtime_hours=0.5, other_description='  Internal design review  ' WHERE id=$1", [first.id]);
  const otherDay = days();
  otherDay[0] = content[0]; otherDay[1].projects[0].hours = 8;
  sheet = expectStatus(await save(sheet, otherDay), 200).timesheet;
  const retained = (await snapshot(sheet.id)).find((entry) => entry.id === first.id);
  assert.equal(retained.notes, 'Keep imported note');
  assert.equal(Number(retained.overtime_hours), 0.5);
  assert.equal(retained.other_description, '  Internal design review  ');
  const previous = await snapshot(sheet.id);
  otherDay[0].projects[0].hours = 8;
  expectStatus(await save(sheet, otherDay), 409);
  assert.deepEqual(await snapshot(sheet.id), previous);
  assert.equal((await pool.query('SELECT version FROM timesheets WHERE id=$1', [sheet.id])).rows[0].version, sheet.version);
});

test('Excel export groups by stable IDs and preserves same-name and inactive employees separately', async () => {
  await pool.query("UPDATE users SET name='__proto__' WHERE id=ANY($1::int[])", [[users.employee.id, users.other.id]]);
  await pool.query("UPDATE projects SET name=CASE WHEN id=$1 THEN 'Other' ELSE 'constructor' END", [projects.first.id]);
  const first = days(); first[1].projects = [{ project_id: projects.second.id, hours: 8 }];
  await savedSheet(first);
  const second = days(); second[0].projects = [{ entry_type: 'other', hours: 7.5, other_description: 'Studio coordination' }];
  await savedSheet(second, users.other);
  expectStatus(await request('PATCH', `/api/employees/${users.other.id}/deactivate`, {}, users.admin), 200);
  const response = await fetch(`${origin}/api/admin/export.xlsx?from=${week}&to=${addDays(week, 4)}`, { headers: { Cookie: `token=${await token(users.admin)}` }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const rows = [];
  workbook.getWorksheet('Project Summary').eachRow((row, index) => {
    if (index > 1 && row.getCell(2).value) rows.push({ project: row.getCell(1).value, employee: row.getCell(2).value, email: row.getCell(3).value, hours: row.getCell(4).value });
  });
  const realOther = rows.filter((r) => r.project === 'Other');
  assert.equal(realOther.length, 2);
  assert.equal(new Set(realOther.map((r) => r.email)).size, 2);
  assert.equal(realOther.reduce((sum, r) => sum + r.hours, 0), 60);
  assert.equal(rows.find((r) => r.project === 'constructor').hours, 8);
  assert.equal(rows.find((r) => r.project === 'Other work (unassigned)').hours, 7.5);
});
