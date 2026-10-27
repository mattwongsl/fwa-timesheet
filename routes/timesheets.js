const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { currentWeekStart, getMondayOf } = require('../utils');
const {
  getOrCreateTimesheet,
  isEditableByEmployee,
  getDaysForTimesheet,
  replaceEntries,
  summarizeDays
} = require('../timesheetService');

const router = express.Router();

// Get (or create) my timesheet for a given week. Defaults to the current week.
router.get('/mine', requireAuth, async (req, res) => {
  const weekStart = req.query.week ? getMondayOf(req.query.week) : currentWeekStart();
  const timesheet = await getOrCreateTimesheet(req.user.id, weekStart);
  const days = await getDaysForTimesheet(timesheet.id, weekStart);
  res.json({
    timesheet,
    days,
    editable: isEditableByEmployee(timesheet),
    is_current_week: weekStart === currentWeekStart(),
    summary: summarizeDays(days)
  });
});

// List my past timesheets (most recent first) for the history view.
router.get('/mine/history', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM timesheets WHERE user_id = $1 ORDER BY week_start DESC LIMIT 52`,
    [req.user.id]
  );
  const withSummary = [];
  for (const ts of result.rows) {
    const days = await getDaysForTimesheet(ts.id, ts.week_start);
    withSummary.push({ timesheet: ts, summary: summarizeDays(days), editable: isEditableByEmployee(ts) });
  }
  res.json({ timesheets: withSummary });
});

// Save (overwrite) the entries for one of my timesheets. Only allowed while editable.
router.put('/:id/entries', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM timesheets WHERE id = $1',
      [req.params.id]
    );
    const timesheet = result.rows[0];

    if (!timesheet) {
      return res.status(404).json({ error: 'Timesheet not found.' });
    }

    if (timesheet.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your timesheet.' });
    }

    if (!isEditableByEmployee(timesheet)) {
      return res.status(423).json({
        error: 'This timesheet is locked and cannot be edited. Ask an admin to unlock it.'
      });
    }

    await replaceEntries(timesheet.id, req.body.days || []);

    const days = await getDaysForTimesheet(
      timesheet.id,
      timesheet.week_start
    );

    res.json({
      ok: true,
      days,
      summary: summarizeDays(days)
    });
  } catch (err) {
    next(err);
  }
});

// Submit (lock) my timesheet for the week.
router.post('/:id/submit', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM timesheets WHERE id = $1', [req.params.id]);
  const timesheet = result.rows[0];
  if (!timesheet) return res.status(404).json({ error: 'Timesheet not found.' });
  if (timesheet.user_id !== req.user.id) return res.status(403).json({ error: 'Not your timesheet.' });
  if (!isEditableByEmployee(timesheet)) {
    return res.status(423).json({ error: 'This timesheet is already locked.' });
  }

  const updated = await pool.query(
    `UPDATE timesheets
     SET locked = true, admin_unlocked = false, submitted_at = now(), locked_at = now(), locked_by = user_id
     WHERE id = $1 RETURNING *`,
    [timesheet.id]
  );
  res.json({ timesheet: updated.rows[0] });
});

// Ask an admin to unlock a past/locked timesheet so I can fix a mistake.
router.post('/:id/request-unlock', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM timesheets WHERE id = $1', [req.params.id]);
  const timesheet = result.rows[0];
  if (!timesheet) return res.status(404).json({ error: 'Timesheet not found.' });
  if (timesheet.user_id !== req.user.id) return res.status(403).json({ error: 'Not your timesheet.' });

  const existingPending = await pool.query(
    `SELECT * FROM unlock_requests WHERE timesheet_id = $1 AND status = 'pending'`,
    [timesheet.id]
  );
  if (existingPending.rows[0]) {
    return res.status(409).json({ error: 'There is already a pending unlock request for this week.' });
  }

  const inserted = await pool.query(
    `INSERT INTO unlock_requests (timesheet_id, requested_by, reason) VALUES ($1, $2, $3) RETURNING *`,
    [timesheet.id, req.user.id, (req.body && req.body.reason) || null]
  );
  res.status(201).json({ request: inserted.rows[0] });
});

// See the status of my own unlock requests.
router.get('/mine/unlock-requests', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT ur.*, t.week_start FROM unlock_requests ur
     JOIN timesheets t ON t.id = ur.timesheet_id
     WHERE ur.requested_by = $1
     ORDER BY ur.created_at DESC`,
    [req.user.id]
  );
  res.json({ requests: result.rows });
});

module.exports = router;
