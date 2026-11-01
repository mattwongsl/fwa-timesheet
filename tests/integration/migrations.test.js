const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pool } = require('pg');
const { migrate, assertSchemaReady } = require('../../db/migrationRunner');

let control;
test.before(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL || 'http://missing.invalid');
  assert.equal(process.env.FWA_ISOLATED_TEST, '1', 'Use the disposable PostgreSQL test runner.');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/fwa_phase2_test');
  assert.match(process.env.FWA_TEST_CLUSTER_TOKEN || '', /^[a-f0-9]{16,}$/);
  control = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 5000 });
  const guard = await control.query('SELECT token FROM public.fwa_test_cluster_guard');
  assert.equal(guard.rows[0]?.token, process.env.FWA_TEST_CLUSTER_TOKEN);
  const directory = (await control.query('SHOW data_directory')).rows[0].data_directory;
  assert.equal(fs.realpathSync(directory), fs.realpathSync(process.env.FWA_TEST_CLUSTER_DIR));
});
test.after(async () => { await control?.end(); });

async function isolatedSchema(run) {
  const schema = `phase2_migration_${crypto.randomBytes(8).toString('hex')}`;
  await control.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public`, connectionTimeoutMillis: 5000 });
  try { await run(pool, schema); } finally { await pool.end(); await control.query(`DROP SCHEMA ${schema} CASCADE`); }
}
async function seed(pool) {
  const user = (await pool.query("INSERT INTO users (name,email,password_hash) VALUES ('Synthetic User','migration@example.test','synthetic-hash') RETURNING id")).rows[0].id;
  const project = (await pool.query("INSERT INTO projects (name) VALUES ('Synthetic Project') RETURNING id")).rows[0].id;
  const timesheet = (await pool.query("INSERT INTO timesheets (user_id,week_start) VALUES ($1,'2026-10-26') RETURNING id", [user])).rows[0].id;
  return { user, project, timesheet };
}

test('real PostgreSQL migrations apply once, preserve readiness, and reject changed checksums', async () => isolatedSchema(async (pool) => {
  await assert.rejects(assertSchemaReady(pool), /npm run migrate/);
  assert.deepEqual((await migrate(pool)).map((m) => m.version), ['001', '002']);
  await assertSchemaReady(pool);
  assert.deepEqual(await migrate(pool), []);
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='unlock_requests'")).rows.map((r) => r.column_name);
  assert.ok(columns.includes('requested_version'));
  await pool.query("UPDATE schema_migrations SET checksum='synthetic-tamper' WHERE version='001'");
  await assert.rejects(assertSchemaReady(pool), /Checksum mismatch/);
  await assert.rejects(migrate(pool), /Checksum mismatch/);
}));

test('valid legacy data and notes/overtime columns survive migration unchanged', async () => isolatedSchema(async (pool) => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8'));
  await pool.query('ALTER TABLE timesheet_entries ADD COLUMN notes TEXT, ADD COLUMN overtime_hours NUMERIC(5,2)');
  const { timesheet, project } = await seed(pool);
  const entry = (await pool.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,project_id,hours,notes,overtime_hours) VALUES ($1,'2026-10-26','work',$2,8,'Preserve this legacy note',0.5) RETURNING id", [timesheet, project])).rows[0].id;
  await migrate(pool);
  const saved = (await pool.query('SELECT hours, notes, overtime_hours FROM timesheet_entries WHERE id=$1', [entry])).rows[0];
  assert.equal(Number(saved.hours), 8);
  assert.equal(saved.notes, 'Preserve this legacy note');
  assert.equal(Number(saved.overtime_hours), 0.5);
}));

test('invalid legacy data blocks migration and rolls back metadata additions without losing entries', async () => isolatedSchema(async (pool, schema) => {
  await pool.query(fs.readFileSync(path.join(__dirname, '../../db/schema.sql'), 'utf8'));
  const { timesheet, project } = await seed(pool);
  await pool.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,project_id,hours) VALUES ($1,'2026-10-26','work',$2,1.25)", [timesheet, project]);
  await assert.rejects(migrate(pool), (error) => /blocked by legacy data/.test(error.message) && /id=/.test(error.detail));
  const row = (await pool.query('SELECT hours FROM timesheet_entries')).rows[0];
  assert.equal(Number(row.hours), 1.25);
  const version = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='timesheets' AND column_name='version'", [schema]);
  assert.equal(version.rowCount, 0);
  const ledger = await pool.query("SELECT to_regclass(format('%I.schema_migrations',current_schema())) AS name");
  assert.equal(ledger.rows[0].name, null);
}));

test('database constraints reject precision coercion, duplicate entries, wrong owners, and historical deletion', async () => isolatedSchema(async (pool) => {
  await migrate(pool);
  const { user, timesheet, project } = await seed(pool);
  const insert = (hours) => pool.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,project_id,hours) VALUES ($1,'2026-10-26','work',$2,$3)", [timesheet, project, hours]);
  await assert.rejects(insert(0.501), (e) => e.code === '23514');
  await insert(7.5);
  await assert.rejects(insert(1), (e) => e.code === '23505');
  const otherUser = (await pool.query("INSERT INTO users (name,email,password_hash) VALUES ('Other Synthetic','other-migration@example.test','synthetic-hash') RETURNING id")).rows[0].id;
  await assert.rejects(pool.query('INSERT INTO unlock_requests (timesheet_id,requested_by) VALUES ($1,$2)', [timesheet, otherUser]), (e) => e.code === '23503');
  await assert.rejects(pool.query('DELETE FROM projects WHERE id=$1', [project]), (e) => e.code === '23503');
  await assert.rejects(pool.query('DELETE FROM users WHERE id=$1', [user]), (e) => e.code === '23503');
  await assert.rejects(pool.query('DELETE FROM timesheets WHERE id=$1', [timesheet]), (e) => e.code === '23503');
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM timesheet_entries')).rows[0].count, 1);
}));

test('deferred checks reject outside-week dates, contradictory days, and excessive daily totals', async () => isolatedSchema(async (pool) => {
  await migrate(pool);
  const { timesheet, project } = await seed(pool);
  await assert.rejects(pool.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,project_id,hours) VALUES ($1,'2026-11-02','work',$2,7.5)", [timesheet, project]), (e) => e.code === '23514');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,project_id,hours) VALUES ($1,'2026-10-26','work',$2,7.5)", [timesheet, project]);
    await client.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,hours,days,leave_unit) VALUES ($1,'2026-10-26','public_holiday',0,1,'days')", [timesheet]);
    await assert.rejects(client.query('COMMIT'), (e) => e.code === '23514');
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await client.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,project_id,hours) VALUES ($1,'2026-10-26','work',$2,20)", [timesheet, project]);
    await client.query("INSERT INTO timesheet_entries (timesheet_id,work_date,entry_type,hours,other_description) VALUES ($1,'2026-10-26','other',5,'Synthetic coordination')", [timesheet]);
    await assert.rejects(client.query('COMMIT'), (e) => e.code === '23514');
    await client.query('ROLLBACK');
  } finally { client.release(); }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM timesheet_entries')).rows[0].count, 0);
}));
