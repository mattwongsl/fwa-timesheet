const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { object, text, httpError } = require('../validation/common');
const router = express.Router();
const COOKIE_OPTS = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 14 };
router.post('/login', asyncHandler(async (req, res) => {
  object(req.body, ['email', 'password']);
  const email = text(req.body.email, 'Email', { required: true, max: 254 }).toLowerCase();
  if (typeof req.body.password !== 'string' || !req.body.password || req.body.password.length > 1000) throw httpError(400, 'A password is required.');
  const user = (await pool.query('SELECT * FROM users WHERE email=$1 AND active=true', [email])).rows[0];
  if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) throw httpError(401, 'Invalid email or password.');
  const payload = { id: user.id, name: user.name, email: user.email, role: user.role };
  res.cookie('token', jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '14d' }), COOKIE_OPTS);
  res.json({ user: payload });
}));
router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  res.json({ ok: true });
});
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
module.exports = router;
