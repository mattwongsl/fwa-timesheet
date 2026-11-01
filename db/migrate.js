require('dotenv').config();
const pool = require('./pool');
const { migrate } = require('./migrationRunner');

async function main() {
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `Migration complete: ${applied.map(({ version, name }) => `${version}_${name}`).join(', ')}.` : 'Database is already up to date.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    if (err.detail) console.error(err.detail);
    if (err.hint) console.error(err.hint);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) main();
module.exports = { main };
