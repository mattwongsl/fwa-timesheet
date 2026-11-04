require('dotenv').config();
const pool = require('./pool');
const { migrate } = require('./migrationRunner');

async function main() {
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Migration complete: ${applied.map(({ version, name }) => `${version}_${name}`).join(', ')}.` : 'Database is already up to date.');
  } catch (err) {
    // Only the known legacy validator emits reviewed record IDs. Never print
    // arbitrary SQL/connection errors or details that may contain credentials.
    if (err.message === 'Phase 2 migration blocked by legacy data that needs review.') {
      console.error(err.message);
      if (err.detail) console.error(err.detail);
      if (err.hint) console.error(err.hint);
    } else {
      console.error('Migration failed. Check target, privileges, migration checksums and readiness. Error type:', err.code || err.name);
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();
module.exports = { main };
