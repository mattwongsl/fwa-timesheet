const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { object, positiveId, text, date, version } = require('../validation/common');
const { currentWeekStart, getMondayOf } = require('../utils');
const service = require('../timesheetService');
const router = express.Router();
router.use(requireAuth);

router.get('/mine', asyncHandler(async (req, res) => {
  object(req.query, ['week'], 'query');
  const week = req.query.week === undefined ? currentWeekStart() : getMondayOf(date(req.query.week, 'week'));
  const sheet = await service.getOrCreateTimesheet(req.user.id, week);
  const result = await service.getTimesheet(sheet.id, req.user.id);
  res.json({ ...result, editable: service.isEditableByEmployee(result.timesheet), is_current_week: week === currentWeekStart() });
}));

router.get('/mine/history', asyncHandler(async (req, res) => {
  object(req.query, [], 'query');
  res.json({ timesheets: await service.listTimesheets({ actorId: req.user.id, history: true }) });
}));

router.get('/mine/unlock-requests', asyncHandler(async (req, res) => {
  object(req.query, [], 'query');
  const result = await pool.query('SELECT ur.*,t.week_start FROM unlock_requests ur JOIN timesheets t ON t.id=ur.timesheet_id WHERE ur.requested_by=$1 ORDER BY ur.created_at DESC', [req.user.id]);
  res.json({ requests: result.rows });
}));

router.put('/:id/entries', asyncHandler(async (req, res) => {
  res.json(await service.replaceEntries(positiveId(req.params.id, 'Timesheet id'), req.body, req.user.id));
}));

router.post('/:id/submit', asyncHandler(async (req, res) => {
  object(req.body, ['version']);
  res.json(await service.submitTimesheet(positiveId(req.params.id, 'Timesheet id'), version(req.body.version), req.user.id));
}));

router.post('/:id/request-unlock', asyncHandler(async (req, res) => {
  object(req.body, ['reason', 'version']);
  res.status(201).json(await service.requestUnlock(positiveId(req.params.id, 'Timesheet id'), version(req.body.version), req.user.id, text(req.body.reason, 'reason', { max: 4000 })));
}));
module.exports = router;
