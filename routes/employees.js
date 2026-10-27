const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// List all employees (admin only)
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT id, name, email, role, active, created_at FROM users ORDER BY active DESC, name'
  );
  res.json({ employees: result.rows });
});

// Add a new employee. A temporary password is generated and returned once
// so the admin can share it with the employee (who should change it after
// first login via /api/employees/me/password).
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { name, email, role } = req.body || {};
  if (!name || !name.trim() || !email || !email.trim()) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const finalRole = role === 'admin' ? 'admin' : 'employee';
  const tempPassword = crypto.randomBytes(6).toString('base64url');
  const hash = await bcrypt.hash(tempPassword, 10);

  try {
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, active, created_at`,
      [name.trim(), email.toLowerCase().trim(), hash, finalRole]
    );
    res.status(201).json({ employee: result.rows[0], temporaryPassword: tempPassword });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    throw err;
  }
});

// Deactivate (soft-remove) an employee. Use this instead of deleting when
// you want to preserve their history but block login; use DELETE below to
// permanently remove them and all their timesheets.
router.patch('/:id/deactivate', requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    'UPDATE users SET active = false WHERE id = $1 RETURNING id, name, email, role, active',
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  res.json({ employee: result.rows[0] });
});

router.patch('/:id/reactivate', requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    'UPDATE users SET active = true WHERE id = $1 RETURNING id, name, email, role, active',
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  res.json({ employee: result.rows[0] });
});

// Admin can reset any employee's password (e.g. they forgot it).
router.post('/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const tempPassword = crypto.randomBytes(6).toString('base64url');
  const hash = await bcrypt.hash(tempPassword, 10);
  const result = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, name, email',
    [hash, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
  res.json({ employee: result.rows[0], temporaryPassword: tempPassword });
});

// Edit an employee's name and/or email.
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name, email } = req.body || {};
  if (!name || !name.trim() || !email || !email.trim()) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  try {
    const result = await pool.query(
      `UPDATE users SET name = $1, email = $2 WHERE id = $3
       RETURNING id, name, email, role, active, created_at`,
      [name.trim(), email.toLowerCase().trim(), req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ employee: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    throw err;
  }
});

// Permanently delete an employee. This also deletes all of their timesheets
// (and those timesheets' entries and unlock requests) via cascading foreign
// keys. Guarded against self-deletion and against deleting the last admin.
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account while logged in as it." });
  }

  const targetResult = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
  const target = targetResult.rows[0];
  if (!target) return res.status(404).json({ error: 'Employee not found.' });

  if (target.role === 'admin') {
    const otherAdmins = await pool.query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND id != $1`, [targetId]);
    if (otherAdmins.rows[0].count === 0) {
      return res.status(400).json({ error: "Can't delete the last remaining admin account." });
    }
  }

  await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
  res.json({ deleted: true, id: targetId });
});

// Any logged-in user can change their own password.
router.post('/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = result.rows[0];
  const ok = await bcrypt.compare(currentPassword || '', user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
