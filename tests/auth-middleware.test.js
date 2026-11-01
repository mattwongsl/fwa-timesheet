const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('middleware/auth.js', 'utf8');
function scenario({ token = 'synthetic-token', payload = { id: 7, role: 'admin' }, user = { id: 7, name: 'Test Employee', email: 'employee@example.test', role: 'employee', active: true }, tokenError, databaseError } = {}) {
  let queries = 0, nextError, nextCount = 0;
  const req = { cookies: token ? { token } : {} };
  const res = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(body) { this.body = body; return this; }
  };
  const context = vm.createContext({
    process: { env: { JWT_SECRET: 'synthetic-secret-for-tests' } },
    module: { exports: {} },
    require(name) {
      if (name === 'jsonwebtoken') return { verify(value, secret, options) { assert.equal(options.algorithms[0], 'HS256'); if (tokenError) throw tokenError; return payload; } };
      if (name === '../db/pool') return { async query(sql, values) { queries++; assert.match(sql, /FROM users WHERE id = \$1/); assert.equal(values[0], payload.id); if (databaseError) throw databaseError; return { rows: user ? [user] : [] }; } };
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  vm.runInContext(source, context);
  return { req, res, auth: context.module.exports, next(err) { nextCount++; nextError = err; }, stats: () => ({ queries, nextCount, nextError }) };
}

test('missing, expired or malformed identities cannot reach database-protected routes', async () => {
  for (const options of [{ token: null }, { tokenError: new Error('expired') }, { payload: { id: '7' } }, { payload: { id: -1 } }, { payload: { id: 2147483648 } }]) {
    const s = scenario(options);
    await s.auth.requireAuth(s.req, s.res, s.next);
    assert.equal(s.res.statusCode, 401);
    assert.equal(s.stats().queries, 0);
    assert.equal(s.stats().nextCount, 0);
  }
});

test('an already-issued JWT stops authorizing a deactivated or deleted user', async () => {
  for (const user of [null, { id: 7, name: 'Inactive', role: 'employee', active: false }]) {
    const s = scenario({ user });
    await s.auth.requireAuth(s.req, s.res, s.next);
    assert.equal(s.res.statusCode, 401);
    assert.equal(s.stats().queries, 1);
    assert.equal(s.stats().nextCount, 0);
  }
});

test('current database role replaces a stale administrator claim', async () => {
  const s = scenario();
  await s.auth.requireAuth(s.req, s.res, s.next);
  assert.equal(s.req.user.role, 'employee');
  assert.equal(s.req.user.name, 'Test Employee');
  assert.equal(s.stats().nextCount, 1);
  s.auth.requireAdmin(s.req, s.res, s.next);
  assert.equal(s.res.statusCode, 403);
  assert.equal(s.stats().nextCount, 1);
});

test('current active administrator remains authorized', async () => {
  const s = scenario({ user: { id: 7, name: 'Test Admin', email: 'admin@example.test', role: 'admin', active: true } });
  await s.auth.requireAuth(s.req, s.res, s.next);
  s.auth.requireAdmin(s.req, s.res, s.next);
  assert.equal(s.stats().nextCount, 2);
  assert.equal(s.res.statusCode, 200);
});

test('database failures are forwarded to Express rather than reported as invalid sessions', async () => {
  const error = new Error('synthetic database outage');
  const s = scenario({ databaseError: error });
  await s.auth.requireAuth(s.req, s.res, s.next);
  assert.equal(s.stats().nextError, error);
  assert.equal(s.stats().nextCount, 1);
  assert.equal(s.res.body, undefined);
});
