const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { httpError, positiveId, object, text } = require('../validation/common');

const router = express.Router();

async function withAdminChange(actorId, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = (await client.query('SELECT id, role, active FROM users WHERE id = $1 FOR SHARE', [actorId])).rows[0];
    if (!actor || !actor.active) throw httpError(401, 'This account is inactive or no longer exists.');
    if (actor.role !== 'admin') throw httpError(403, 'Admins only.');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw httpError(409, 'A project with that name already exists.');
    if (err.code === '23503') throw httpError(409, 'This project has recorded entries. Archive it instead.');
    throw err;
  } finally {
    client.release();
  }
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  object(req.query, ['all'], 'query');
  if (req.query.all !== undefined && !['0', '1'].includes(req.query.all)) throw httpError(400, 'The all filter must be 0 or 1.');
  const includeArchived = req.user.role === 'admin' && req.query.all === '1';
  const result = includeArchived
    ? await pool.query('SELECT * FROM projects ORDER BY archived, name')
    : await pool.query('SELECT * FROM projects WHERE archived = false ORDER BY name');
  res.json({ projects: result.rows });
}));

router.post('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  object(req.body, ['name']);
  const name = text(req.body.name, 'Project name', { required: true, max: 300 }).trim();
  const project = await withAdminChange(req.user.id, async (client) => (await client.query(
    'INSERT INTO projects (name) VALUES ($1) RETURNING *', [name]
  )).rows[0]);
  res.status(201).json({ project });
}));

for (const [action, archived] of [['archive', true], ['unarchive', false]]) {
  router.patch(`/:id/${action}`, requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const id = positiveId(req.params.id, 'Project id');
    object(req.body ?? {}, []);
    const project = await withAdminChange(req.user.id, async (client) => {
      // UPDATE conflicts with the save service's project FOR SHARE locks, so a
      // new entry cannot slip in after archival commits.
      const result = await client.query('UPDATE projects SET archived = $2 WHERE id = $1 RETURNING *', [id, archived]);
      if (!result.rows[0]) throw httpError(404, 'Project not found.');
      return result.rows[0];
    });
    res.json({ project });
  }));
}

router.patch('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'Project id');
  object(req.body, ['name']);
  const name = text(req.body.name, 'Project name', { required: true, max: 300 }).trim();
  const project = await withAdminChange(req.user.id, async (client) => {
    const result = await client.query('UPDATE projects SET name = $1 WHERE id = $2 RETURNING *', [name, id]);
    if (!result.rows[0]) throw httpError(404, 'Project not found.');
    return result.rows[0];
  });
  res.json({ project });
}));

// Preserve every referenced project, including zero-hour legacy entries.
router.delete('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const id = positiveId(req.params.id, 'Project id');
  object(req.body ?? {}, []);
  await withAdminChange(req.user.id, async (client) => {
    const project = (await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!project) throw httpError(404, 'Project not found.');
    const history = await client.query('SELECT EXISTS (SELECT 1 FROM timesheet_entries WHERE project_id = $1) AS has_history', [id]);
    if (history.rows[0].has_history) throw httpError(409, 'This project has recorded entries. Archive it instead.');
    await client.query('DELETE FROM projects WHERE id = $1', [id]);
  });
  res.json({ deleted: true, id });
}));

module.exports = router;
