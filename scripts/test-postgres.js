#!/usr/bin/env node
/* Creates and removes only its own temporary PostgreSQL cluster. Never reads .env. */
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('pg');

const project = path.resolve(__dirname, '..');
let cluster, dataDirectory, postgresBin, started = false, testProcess, cleanupPromise;
const token = crypto.randomBytes(24).toString('hex');

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: project, ...options });
    let output = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${path.basename(file)} failed (${signal || code}): ${output.slice(-4000)}`)));
  });
}

async function findPostgres() {
  const candidates = [process.env.POSTGRES_BIN, '/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin'].filter(Boolean);
  for (const directory of candidates) {
    try { await fs.access(path.join(directory, 'initdb')); await fs.access(path.join(directory, 'pg_ctl')); return directory; } catch {}
  }
  throw new Error('PostgreSQL test binaries not found. Install PostgreSQL 17 and set POSTGRES_BIN to its bin directory. No configured database was used.');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close((err) => err ? reject(err) : resolve(port)); });
  });
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!cluster) return;
    if (started) {
      try { await run(path.join(postgresBin, 'pg_ctl'), ['-D', dataDirectory, '-m', 'fast', '-w', '-t', '15', 'stop']); started = false; }
      catch (err) { console.error(`Temporary PostgreSQL could not be stopped; preserving ${cluster}. ${err.message}`); return; }
    }
    const marker = await fs.readFile(path.join(cluster, '.fwa-test-owner'), 'utf8');
    if (marker !== token || !path.basename(cluster).startsWith('fwa-phase2-') || path.dirname(cluster) !== path.resolve(os.tmpdir())) {
      throw new Error('Refusing to remove a directory not created by this test run.');
    }
    await fs.rm(cluster, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

async function main() {
  postgresBin = await findPostgres();
  cluster = await fs.mkdtemp(path.join(path.resolve(os.tmpdir()), 'fwa-phase2-'));
  await fs.writeFile(path.join(cluster, '.fwa-test-owner'), token, { mode: 0o600 });
  dataDirectory = path.join(cluster, 'data');
  const port = await freePort();
  await run(path.join(postgresBin, 'initdb'), ['-D', dataDirectory, '--username=fwa_test_runner', '--auth-local=trust', '--auth-host=trust', '--no-locale', '--encoding=UTF8']);
  await fs.appendFile(path.join(dataDirectory, 'postgresql.conf'), `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\n`);
  await run(path.join(postgresBin, 'pg_ctl'), ['-D', dataDirectory, '-l', path.join(cluster, 'postgres.log'), '-w', '-t', '30', 'start']);
  started = true;
  const baseUrl = `postgresql://fwa_test_runner@127.0.0.1:${port}`;
  const admin = new Client({ connectionString: `${baseUrl}/postgres`, connectionTimeoutMillis: 5000 });
  await admin.connect();
  try {
    const actual = (await admin.query('SHOW data_directory')).rows[0].data_directory;
    if (path.resolve(actual) !== path.resolve(dataDirectory)) throw new Error('Test PostgreSQL identity mismatch; refusing database setup.');
    await admin.query('CREATE DATABASE fwa_phase2_test');
  } finally { await admin.end(); }
  const databaseUrl = `${baseUrl}/fwa_phase2_test`;
  const guard = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await guard.connect();
  try {
    await guard.query('CREATE TABLE fwa_test_cluster_guard (token TEXT PRIMARY KEY)');
    await guard.query('INSERT INTO fwa_test_cluster_guard (token) VALUES ($1)', [token]);
  } finally { await guard.end(); }
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('PG') || key.startsWith('INITIAL_ADMIN_') || ['DATABASE_URL', 'TEST_DATABASE_URL', 'DATABASE_TRANSPORT', 'NODE_OPTIONS', 'DOTENV_CONFIG_PATH'].includes(key)) delete environment[key];
  }
  Object.assign(environment, {
    DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, DATABASE_TRANSPORT: 'tcp',
    JWT_SECRET: 'synthetic-phase2-integration-secret', NODE_ENV: 'test', FWA_ISOLATED_TEST: '1',
    FWA_TEST_CLUSTER_TOKEN: token, FWA_TEST_CLUSTER_DIR: dataDirectory
  });
  const files = (await fs.readdir(path.join(project, 'tests', 'integration'))).filter((name) => name.endsWith('.test.js')).sort().map((name) => path.join('tests', 'integration', name));
  if (!files.length) throw new Error('No integration tests found.');
  console.log(`Running integration tests against a fresh local PostgreSQL 17 cluster on port ${port}.`);
  const exitCode = await new Promise((resolve, reject) => {
    testProcess = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: project, env: environment, stdio: 'inherit' });
    testProcess.once('error', reject);
    testProcess.once('exit', (code, signal) => resolve(code === null ? (signal === 'SIGINT' ? 130 : 1) : code));
  });
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  testProcess?.kill(signal);
  cleanup().then(() => process.exit(signal === 'SIGINT' ? 130 : 143)).catch((err) => { console.error(err.message); process.exit(1); });
});

main().catch((err) => { console.error(err.message); process.exitCode = 1; }).finally(async () => {
  try { await cleanup(); } catch (err) { console.error(`Test cleanup failed: ${err.message}`); process.exitCode = 1; }
});
