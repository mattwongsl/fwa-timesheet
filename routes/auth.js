const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { object, text, httpError } = require('../validation/common');
const { cookieOptions, password } = require('../security/config');
const { createSession, setSession, revokeAll, digest } = require('../security/sessions');
const { loginIp, loginAccount, resetIp, sensitive } = require('../middleware/security');
const mail = require('../security/email');
const { issueReset } = require('../security/reset');
const router = express.Router();
const dummyHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
router.post('/login', loginIp, loginAccount, asyncHandler(async (req, res) => {
  object(req.body, ['email', 'password']);
  const email = text(req.body.email, 'Email', { required: true, max: 254 }).toLowerCase();
  if (typeof req.body.password !== 'string' || !req.body.password || Buffer.byteLength(req.body.password) > 72) throw httpError(401, 'Invalid email or password.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize login/password changes/deactivation to avoid issuing stale sessions.
    const user = (await client.query('SELECT id,name,email,role,active,password_hash FROM users WHERE email=$1 FOR UPDATE', [email])).rows[0];
    const ok = await bcrypt.compare(req.body.password, user?.password_hash || dummyHash);
    if (!user?.active || !ok) throw httpError(401, 'Invalid email or password.');
    if (bcrypt.getRounds(user.password_hash) < 12) await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(req.body.password, 12), user.id]);
    await client.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
    const token = await createSession(client, user);
    await client.query('COMMIT'); setSession(res, token); res.json({ user: safeUser(user) });
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}));
router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await pool.query('DELETE FROM auth_sessions WHERE id_hash=$1', [req.sessionHash]);
  res.clearCookie('token', cookieOptions()); res.json({ ok: true });
}));
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
const genericReset = { message: 'If an active account matches, password recovery instructions will be sent.' };
router.post('/forgot-password', resetIp, asyncHandler(async (req, res) => {
  object(req.body, ['email']);
  const email = text(req.body.email, 'Email', { required: true, max: 254 }).toLowerCase();
  if (!mail.configured()) throw httpError(503, 'Password recovery email is not configured. Contact your administrator.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = (await client.query('SELECT id,email,active FROM users WHERE email=$1 FOR UPDATE', [email])).rows[0];
    // Database cooldown avoids per-email memory growth and cross-instance abuse.
    const recent = user && (await client.query("SELECT 1 FROM password_reset_tokens WHERE user_id=$1 AND created_at>now()-interval '5 minutes'", [user.id])).rowCount;
    if (user?.active && !recent) await issueReset(client, user);
    await client.query('COMMIT');
  } catch { await client.query('ROLLBACK'); console.error('Recovery delivery failed.'); } finally { client.release(); }
  res.json(genericReset);
}));
router.post('/reset-password', sensitive, asyncHandler(async (req, res) => {
  object(req.body, ['token', 'newPassword']); password(req.body.newPassword);
  if (typeof req.body.token !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.token)) throw httpError(400, 'Reset link is invalid or expired.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = digest(req.body.token);
    const ref = (await client.query('SELECT user_id FROM password_reset_tokens WHERE token_hash=$1', [hash])).rows[0];
    if (!ref) throw httpError(400, 'Reset link is invalid or expired.');
    const user = (await client.query('SELECT id,active FROM users WHERE id=$1 FOR UPDATE', [ref.user_id])).rows[0];
    const token = (await client.query('SELECT user_id FROM password_reset_tokens WHERE token_hash=$1 AND expires_at>now() FOR UPDATE', [hash])).rows[0];
    if (!user?.active || !token) throw httpError(400, 'Reset link is invalid or expired.');
    await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(req.body.newPassword, 12), user.id]);
    await revokeAll(client, user.id); await client.query('COMMIT');
    res.clearCookie('token', cookieOptions()); res.json({ ok: true });
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
}));
module.exports = router;
