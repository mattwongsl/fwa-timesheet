const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Anyone logged in can see the list of projects (needed to fill a timesheet).
// Employees only see active projects; admins can request archived ones too.
router.get('/', requireAuth, async (req, res) => {
  const includeArchived = req.user.role === 'admin' && req.query.all === '1';
  const result = includeArchived
    ? await pool.query('SELECT * FROM projects ORDER BY archived, name')
    : await pool.query('SELECT * FROM projects WHERE archived = false ORDER BY name');
  res.json({ projects: result.rows });
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO projects (name) VALUES ($1) RETURNING *',
      [name.trim()]
    );
    res.status(201).json({ project: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A project with that name already exists.' });
    }
    throw err;
  }
});

router.patch('/:id/archive', requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    'UPDATE projects SET archived = true WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Project not found.' });
  res.json({ project: result.rows[0] });
});

router.patch('/:id/unarchive', requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    'UPDATE projects SET archived = false WHERE id = $1 RETURNING *',
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Project not found.' });
  res.json({ project: result.rows[0] });
});

// Rename a project.
router.patch('/:id', requireAuth, requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Project name is required.' });
  }
  try {
    const result = await pool.query(
      'UPDATE projects SET name = $1 WHERE id = $2 RETURNING *',
      [name.trim(), req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Project not found.' });
    res.json({ project: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A project with that name already exists.' });
    }
    throw err;
  }
});

// Permanently delete a project. Any hours logged against it in existing
// timesheets are removed too, via a cascading foreign key - there's no
// meaningful way to keep "hours worked on an unknown project".
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const result = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Project not found.' });
  res.json({ deleted: true, id: result.rows[0].id });
});

module.exports = router;
