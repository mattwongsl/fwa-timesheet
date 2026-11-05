const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { httpError, positiveId, object, text } = require('../validation/common');

const { password, cookieOptions } = require('../security/config');
const { revokeAll } = require('../security/sessions');
const { issueReset } = require('../security/reset');
const mail = require('../security/email');
const { sensitive } = require('../middleware/security');
const router = express.Router();
const PUBLIC_FIELDS = 'id, name, email, role, active, created_at';

function profile(body, includeRole = false) {
  object(body, includeRole ? ['name', 'email', 'role'] : ['name', 'email']);
  const name = text(body.name, 'Name', { required: true, max: 200 }).trim();
  const email = text(body.email, 'Email', { required: true, max: 254 }).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Enter a valid email address.');
  if (includeRole && body.role !== undefined && !['admin', 'employee'].includes(body.role)) {
    throw httpError(400, 'Role must be admin or employee.');
  }
  return { name, email, role: body.role || 'employee' };
}

async function withAdminChange(actorId, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize account administration so two admins cannot remove each other
    // or both pass a stale "another active admin exists" check.
    await client.query('SELECT pg_advisory_xact_lock($1)', [42817202]);
    const actor = (await client.query('SELECT id, role, active FROM users WHERE id = $1 FOR SHARE', [actorId])).rows[0];
    if (!actor || !actor.active) throw httpError(401, 'This account is inactive or no longer exists.');
    if (actor.role !== 'admin') throw httpError(403, 'Admins only.');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw httpError(409, 'An account with that email already exists.');
    if (err.code === '23503') throw httpError(409, 'This employee has historical records. Deactivate the account instead.');
    throw err;
  } finally {
    client.release();
  }
}

async function targetUser(client, id) {
  const target = (await client.query(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!target) throw httpError(404, 'Employee not found.');
  return target;
}

async function preserveActiveAdmin(client, target) {
  if (target.role !== 'admin' || !target.active) return;
  const others = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = true AND id <> $1", [target.id]);
  if (others.rows[0].count === 0) throw httpError(409, 'The last active administrator cannot be removed or deactivated.');
}

router.get('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const result = await pool.query(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY active DESC, name`);
  res.json({ employees: result.rows });
}));

router.post('/', requireAuth, requireAdmin, sensitive, asyncHandler(async (req, res) => {
  const { name, email, role } = profile(req.body, true);
  if (!mail.configured()) throw httpError(503, 'Configure recovery email before creating accounts or requesting resets.');
  const hash = await bcrypt.hash(crypto.randomBytes(48).toString('base64url'), 12);
  const employee = await withAdminChange(req.user.id, async (client) => {
    const created = (await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${PUBLIC_FIELDS}`,
      [name, email, hash, role]
    )).rows[0];
    await issueReset(client, created);
    return created;
  });
  res.status(201).json({ employee, message: 'Password setup instructions sent.' });
}));

router.patch('/:id/deactivate', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'Employee id');
  object(req.body ?? {}, []);
  if (id === req.user.id) throw httpError(400, 'You cannot deactivate your own account while logged in.');
  const employee = await withAdminChange(req.user.id, async (client) => {
    const target = await targetUser(client, id);
    await preserveActiveAdmin(client, target);
    return (await client.query(`UPDATE users SET active = false WHERE id = $1 RETURNING ${PUBLIC_FIELDS}`, [id])).rows[0];
  });
  res.json({ employee });
}));

router.patch('/:id/reactivate', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'Employee id');
  object(req.body ?? {}, []);
  const employee = await withAdminChange(req.user.id, async (client) => {
    await targetUser(client, id);
    return (await client.query(`UPDATE users SET active = true WHERE id = $1 RETURNING ${PUBLIC_FIELDS}`, [id])).rows[0];
  });
  res.json({ employee });
}));

router.post('/:id/reset-password', requireAuth, requireAdmin, sensitive, asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'Employee id');
  object(req.body ?? {}, []);
  if (!mail.configured()) throw httpError(503, 'Configure recovery email before requesting resets.');
  await withAdminChange(req.user.id, async (client) => {
    const user = await targetUser(client, id);
    if (!user.active) throw httpError(409, 'Reactivate the employee before initiating recovery.');
    await issueReset(client, user);
  });
  res.json({ message: 'Password recovery instructions sent. The password has not changed.' });
}));

router.patch('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'Employee id');
  const { name, email } = profile(req.body);
  const employee = await withAdminChange(req.user.id, async (client) => {
    const target = await targetUser(client, id);
    if (target.email !== email) await revokeAll(client, id);
    return (await client.query(`UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING ${PUBLIC_FIELDS}`, [name, email, id])).rows[0];
  });
  res.json({ employee });
}));

// Only accounts with no historical timesheets or administrative activity may
// be permanently removed. Deactivation is the normal retention-safe workflow.
router.delete('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'Employee id');
  object(req.body ?? {}, []);
  if (id === req.user.id) throw httpError(400, 'You cannot delete your own account while logged in.');
  await withAdminChange(req.user.id, async (client) => {
    const target = await targetUser(client, id);
    await preserveActiveAdmin(client, target);
    const history = await client.query(
      `SELECT EXISTS (SELECT 1 FROM timesheets WHERE user_id = $1 OR locked_by = $1)
          OR EXISTS (SELECT 1 FROM unlock_requests WHERE requested_by = $1 OR resolved_by = $1) AS has_history`, [id]
    );
    if (history.rows[0].has_history) throw httpError(409, 'This employee has historical records. Deactivate the account instead.');
    await client.query('DELETE FROM users WHERE id = $1', [id]);
  });
  res.json({ deleted: true, id });
}));

router.post('/me/password', requireAuth, sensitive, asyncHandler(async (req, res) => {
  object(req.body, ['currentPassword', 'newPassword']);
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') throw httpError(400, 'Current and new passwords must be text.');
  password(newPassword);
  if (Buffer.byteLength(currentPassword) > 72) throw httpError(400, 'Current password is too long.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = (await client.query('SELECT id, active, password_hash FROM users WHERE id = $1 FOR UPDATE', [req.user.id])).rows[0];
    if (!user || !user.active) throw httpError(401, 'This account is inactive or no longer exists.');
    if (!await bcrypt.compare(currentPassword, user.password_hash)) throw httpError(401, 'Current password is incorrect.');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 12), user.id]);
    await revokeAll(client, user.id);
    await client.query('COMMIT');
    res.clearCookie('token', cookieOptions());
    res.json({ ok: true, loginRequired: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
