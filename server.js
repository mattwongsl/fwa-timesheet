require('dotenv').config();
const pool = require('./db/pool');
const { assertSchemaReady } = require('./db/migrationRunner');
const app = require('./app');

async function start() {
  if (!process.env.JWT_SECRET) throw new Error('Missing JWT_SECRET. Configure it in .env before starting.');
  // Startup only checks readiness. Schema/data changes require an explicit CLI.
  await assertSchemaReady(pool);
  const server = app.listen(process.env.PORT || 3000, () => console.log(`Timesheet app listening on port ${process.env.PORT || 3000}`));
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? 'This port is already in use. Stop the other server or choose another PORT.' : `Server failed: ${err.code || err.name}`);
    pool.end().finally(() => { process.exitCode = 1; });
  });
  return server;
}
if (require.main === module) start().catch(async (err) => {
  console.error('Cannot start timesheet app:', err.message);
  await pool.end(); process.exitCode = 1;
});
module.exports = { start };
