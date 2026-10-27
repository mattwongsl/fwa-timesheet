const { Pool, types } = require('pg');

// By default pg parses SQL DATE columns (like week_start, work_date) into
// JS Date objects in local time, which caused subtle bugs when comparing
// them against plain 'YYYY-MM-DD' strings elsewhere in the app (e.g. the
// lock/unlock logic). We keep them as the raw 'YYYY-MM-DD' string instead.
types.setTypeParser(1082, (val) => val); // 1082 = the OID for the DATE type

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL environment variable. See .env.example.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=require') || process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

module.exports = pool;
