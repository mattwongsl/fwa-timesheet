const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadMigrations() {
  const directory = path.join(__dirname, 'migrations');
  const sqlFiles = fs.readdirSync(directory).filter((name) => name.endsWith('.sql'));
  if (sqlFiles.some((name) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name) || Number(name.slice(0, 3)) < 2)) {
    throw new Error('Migration SQL filenames must use NNN_lowercase_name.sql with versions starting at 002; 001 is db/schema.sql.');
  }
  const files = sqlFiles.sort();
  const migrations = [{ version: '001', name: 'baseline', file: path.join(__dirname, 'schema.sql') }, ...files.map((name) => ({
    version: name.slice(0, 3), name: name.slice(4, -4), file: path.join(directory, name)
  }))];
  if (new Set(migrations.map((migration) => migration.version)).size !== migrations.length) {
    throw new Error('Database migration versions must be unique; 001 is reserved for db/schema.sql.');
  }
  return migrations.map((migration) => {
    const sql = fs.readFileSync(migration.file, 'utf8');
    return { ...migration, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
  });
}

function verifyApplied(applied, migrations) {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) throw new Error(`Database migration ${row.version} is newer than this application. Use the matching application release.`);
    if (migration.checksum !== row.checksum) throw new Error(`Checksum mismatch for database migration ${row.version}. Restore the original applied migration; add a new migration for changes.`);
  }
  for (let index = 0; index < applied.length; index++) {
    if (applied[index].version !== migrations[index]?.version) throw new Error('Database migration history is not a contiguous sequence. Review schema_migrations before proceeding.');
  }
}

async function migrate(pool) {
  const migrations = loadMigrations();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One database-level lock serializes two operators invoking the CLI together.
    await client.query('SELECT pg_advisory_xact_lock($1)', [73420621]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = (await client.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
    verifyApplied(applied, migrations);
    const pending = migrations.slice(applied.length);
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, migration.checksum]);
    }
    await client.query('COMMIT');
    return pending.map(({ version, name }) => ({ version, name }));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function assertSchemaReady(pool) {
  const migrations = loadMigrations();
  const table = (await pool.query("SELECT to_regclass(format('%I.schema_migrations', current_schema())) AS table_name")).rows[0]?.table_name;
  if (!table) throw new Error('The database has not been migrated. Run npm run migrate before starting the app.');
  const applied = (await pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows;
  verifyApplied(applied, migrations);
  if (applied.length !== migrations.length) throw new Error('The database has pending migrations. Run npm run migrate before starting the app.');
}

module.exports = { migrate, assertSchemaReady, loadMigrations };
