if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable. See .env.example.');
  process.exit(1);
}

let databaseUrl;
try { databaseUrl = new URL(process.env.DATABASE_URL); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
const transport = process.env.DATABASE_TRANSPORT || 'tcp';
if (!['tcp', 'websocket'].includes(transport)) {
  throw new Error('DATABASE_TRANSPORT must be tcp or websocket.');
}

// Neon supports PostgreSQL sessions over secure WebSockets on port 443.
// This preserves pool.query(), pool.connect(), and interactive transactions
// on development networks that cannot reach PostgreSQL's TCP port 5432.
if (transport === 'websocket') {
  if (!databaseUrl.hostname.endsWith('.neon.tech')) {
    throw new Error('The websocket database transport requires a Neon DATABASE_URL.');
  }
  if (typeof WebSocket !== 'function') {
    throw new Error('The websocket database transport requires Node.js 22 or newer.');
  }
}
const driver = require(transport === 'websocket' ? '@neondatabase/serverless' : 'pg');
if (transport === 'websocket') {
  driver.neonConfig.webSocketConstructor = WebSocket;
  driver.neonConfig.useSecureWebSocket = true;
}
const { Pool, types } = driver;

// By default pg parses SQL DATE columns (like week_start, work_date) into
// JS Date objects in local time, which caused subtle bugs when comparing
// them against plain 'YYYY-MM-DD' strings elsewhere in the app (e.g. the
// lock/unlock logic). We keep them as the raw 'YYYY-MM-DD' string instead.
types.setTypeParser(1082, (val) => val); // 1082 = the OID for the DATE type

const options = {
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000
};
if (transport === 'tcp') {
  const url = new URL(databaseUrl.toString());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const mode = url.searchParams.get('sslmode');
  if (!local && ['disable', 'allow', 'prefer', 'no-verify'].includes(mode)) throw new Error('Remote PostgreSQL requires verified TLS.');
  // pg connection-string sslmode can override the explicit SSL object. Remove
  // all SSL query overrides and use Node's trusted CA verification explicitly.
  for (const key of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  options.connectionString = url.toString();
  options.ssl = !local || process.env.NODE_ENV === 'production' || (mode && mode !== 'disable')
    ? { rejectUnauthorized: true } : false;
}

const pool = new Pool(options);

module.exports = pool;
