const test = require('node:test');
const assert = require('node:assert/strict');
const { migrate, assertSchemaReady, loadMigrations } = require('../db/migrationRunner');

function fakeDatabase({ applied = [], ready = true, failSql = false } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT version, checksum')) return { rows: applied };
      if (sql.startsWith('SELECT to_regclass')) return { rows: [{ table_name: ready ? 'schema_migrations' : null }] };
      if (failSql && sql.includes('CREATE TABLE IF NOT EXISTS users')) throw new Error('synthetic migration failure');
      return { rows: [] };
    },
    release() { released = true; }
  };
  return { pool: { connect: async () => client, query: client.query }, calls, get released() { return released; } };
}
const appliedMigrations = () => loadMigrations().map(({ version, checksum }) => ({ version, checksum }));

test('runner serializes migrations, applies SQL and ledger in one transaction', async () => {
  const database = fakeDatabase();
  const applied = await migrate(database.pool);
  assert.deepEqual(applied.map((migration) => migration.version), ['001', '002']);
  assert.equal(database.calls[0].sql, 'BEGIN');
  assert.equal(database.calls[1].sql, 'SELECT pg_advisory_xact_lock($1)');
  assert.equal(database.calls.at(-1).sql, 'COMMIT');
  assert.equal(database.calls.filter(({ sql }) => sql.startsWith('INSERT INTO schema_migrations')).length, 2);
  assert.equal(database.released, true);
});

test('reapplying the same migrations runs no schema SQL', async () => {
  const database = fakeDatabase({ applied: appliedMigrations() });
  assert.deepEqual(await migrate(database.pool), []);
  assert.equal(database.calls.some(({ sql }) => sql.includes('CREATE TABLE IF NOT EXISTS users')), false);
  assert.equal(database.calls.some(({ sql }) => sql.startsWith('INSERT INTO schema_migrations')), false);
});

test('migration failure rolls back and releases the connection without recording a version', async () => {
  const database = fakeDatabase({ failSql: true });
  await assert.rejects(migrate(database.pool), /synthetic migration failure/);
  assert.equal(database.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(database.calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(database.calls.some(({ sql }) => sql.startsWith('INSERT INTO schema_migrations')), false);
  assert.equal(database.released, true);
});

test('changed, unknown, and non-contiguous migration history are rejected', async () => {
  const wrongChecksum = appliedMigrations(); wrongChecksum[0].checksum = 'modified';
  await assert.rejects(migrate(fakeDatabase({ applied: wrongChecksum }).pool), /Checksum mismatch/);
  await assert.rejects(migrate(fakeDatabase({ applied: [{ version: '999', checksum: 'unknown' }] }).pool), /newer than this application/);
  await assert.rejects(migrate(fakeDatabase({ applied: appliedMigrations().slice(1) }).pool), /not a contiguous sequence/);
});

test('startup readiness check is read-only and explains missing/pending migrations', async () => {
  await assert.rejects(assertSchemaReady(fakeDatabase({ ready: false }).pool), /Run npm run migrate/);
  await assert.rejects(assertSchemaReady(fakeDatabase({ applied: appliedMigrations().slice(0, 1) }).pool), /pending migrations/);
  const database = fakeDatabase({ applied: appliedMigrations() });
  await assertSchemaReady(database.pool);
  assert.equal(database.calls.every(({ sql }) => sql.startsWith('SELECT ')), true);
});
