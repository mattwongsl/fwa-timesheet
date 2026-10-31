if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable. See .env.example.');
  process.exit(1);
}

const transport = process.env.DATABASE_TRANSPORT || 'tcp';
if (!['tcp', 'websocket'].includes(transport)) {
  throw new Error('DATABASE_TRANSPORT must be tcp or websocket.');
}

// Neon supports PostgreSQL sessions over secure WebSockets on port 443.
// This preserves pool.query(), pool.connect(), and interactive transactions
// on development networks that cannot reach PostgreSQL's TCP port 5432.
if (transport === 'websocket') {
  if (!new URL(process.env.DATABASE_URL).hostname.endsWith('.neon.tech')) {
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
  options.ssl = process.env.DATABASE_URL.includes('sslmode=require') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false;
}

const pool = new Pool(options);

module.exports = pool;
