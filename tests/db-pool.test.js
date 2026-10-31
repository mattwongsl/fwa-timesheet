const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('db/pool.js', 'utf8');
function loadPool(env, WebSocket = function WebSocket() {}) {
  let selectedDriver, dateParser;
  const driver = {
    neonConfig: {},
    types: { setTypeParser(oid, parser) { assert.equal(oid, 1082); dateParser = parser; } },
    Pool: class { constructor(options) { this.options = options; } }
  };
  const context = vm.createContext({
    process: { env, exit(code) { throw new Error(`exit ${code}`); } },
    console: { error() {} },
    module: { exports: {} }, URL, WebSocket,
    require(name) { selectedDriver = name; return driver; }
  });
  vm.runInContext(source, context);
  return { pool: context.module.exports, selectedDriver, config: driver.neonConfig, dateParser };
}

test('standard PostgreSQL remains the default with local SSL behavior preserved', () => {
  const result = loadPool({ DATABASE_URL: 'postgresql://user:example@localhost/app' });
  assert.equal(result.selectedDriver, 'pg');
  assert.equal(result.pool.options.ssl, false);
  assert.equal(result.pool.options.connectionTimeoutMillis, 10000);
  assert.equal(result.dateParser('2026-10-30'), '2026-10-30');
});

test('TCP SSL behavior remains unchanged for hosted databases and production', () => {
  for (const env of [
    { DATABASE_URL: 'postgresql://user:example@host/app?sslmode=require' },
    { DATABASE_URL: 'postgresql://user:example@host/app', NODE_ENV: 'production' }
  ]) {
    assert.equal(loadPool(env).pool.options.ssl.rejectUnauthorized, false);
  }
});

test('explicit Neon WebSocket mode uses encrypted transport and preserves raw date strings', () => {
  const result = loadPool({ DATABASE_URL: 'postgresql://user:example@ep-test.neon.tech/app?sslmode=require', DATABASE_TRANSPORT: 'websocket' });
  assert.equal(result.selectedDriver, '@neondatabase/serverless');
  assert.equal(result.config.useSecureWebSocket, true);
  assert.equal(typeof result.config.webSocketConstructor, 'function');
  assert.equal(result.pool.options.ssl, undefined);
  assert.equal(result.pool.options.connectionTimeoutMillis, 10000);
  assert.equal(result.dateParser('2026-10-30'), '2026-10-30');
});

test('invalid transports, unsupported hosts and missing WebSocket support fail clearly', () => {
  assert.throws(() => loadPool({}), /exit 1/);
  assert.throws(() => loadPool({ DATABASE_URL: 'postgresql://localhost/app', DATABASE_TRANSPORT: 'typo' }), /must be tcp or websocket/);
  assert.throws(() => loadPool({ DATABASE_URL: 'postgresql://localhost/app', DATABASE_TRANSPORT: 'websocket' }), /requires a Neon/);
  assert.throws(() => loadPool({ DATABASE_URL: 'postgresql://ep-test.neon.tech/app', DATABASE_TRANSPORT: 'websocket' }, null), /Node.js 22/);
});
