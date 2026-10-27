const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getDaysForTimesheet, replaceEntries, summarizeDays } = require('../timesheetService');
const ExcelJS = require('exceljs');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// List timesheets across all employees, with optional filters.
router.get('/timesheets', async (req, res) => {
  const { user_id, week, from, to } = req.query;
  const clauses = [];
  const params = [];

  if (user_id) {
    params.push(user_id);
    clauses.push(`t.user_id = $${params.length}`);
  }
  if (week) {
    params.push(week);
    clauses.push(`t.week_start = $${params.length}`);
  }
  if (from) {
    params.push(from);
    clauses.push(`t.week_start >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    clauses.push(`t.week_start <= $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT t.*, u.name AS employee_name, u.email AS employee_email
     FROM timesheets t
     JOIN users u ON u.id = t.user_id
     ${where}
     ORDER BY t.week_start DESC, u.name`,
    params
  );

  const withSummary = [];
  for (const ts of result.rows) {
    const days = await getDaysForTimesheet(ts.id, ts.week_start);
    withSummary.push({ timesheet: ts, summary: summarizeDays(days) });
  }
  res.json({ timesheets: withSummary });
});

// Full detail (day-by-day) for one timesheet.
router.get('/timesheets/:id', async (req, res) => {
  const result = await pool.query(
    `SELECT t.*, u.name AS employee_name, u.email AS employee_email
     FROM timesheets t JOIN users u ON u.id = t.user_id WHERE t.id = $1`,
    [req.params.id]
  );
  const timesheet = result.rows[0];
  if (!timesheet) return res.status(404).json({ error: 'Timesheet not found.' });
  const days = await getDaysForTimesheet(timesheet.id, timesheet.week_start);
  res.json({ timesheet, days, summary: summarizeDays(days) });
});

// Admin can edit any timesheet, locked or not.
router.put('/timesheets/:id/entries', async (req, res) => {
  const result = await pool.query('SELECT * FROM timesheets WHERE id = $1', [req.params.id]);
  const timesheet = result.rows[0];
  if (!timesheet) return res.status(404).json({ error: 'Timesheet not found.' });

  await replaceEntries(timesheet.id, req.body.days || []);
  const days = await getDaysForTimesheet(timesheet.id, timesheet.week_start);
  res.json({ ok: true, days, summary: summarizeDays(days) });
});

// Explicitly lock a timesheet (blocks the employee from editing it).
router.post('/timesheets/:id/lock', async (req, res) => {
  const result = await pool.query(
    `UPDATE timesheets SET locked = true, admin_unlocked = false, locked_at = now(), locked_by = $2
     WHERE id = $1 RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Timesheet not found.' });
  res.json({ timesheet: result.rows[0] });
});

// Unlock a timesheet so the employee can edit it again, even if it's a past week.
router.post('/timesheets/:id/unlock', async (req, res) => {
  const result = await pool.query(
    `UPDATE timesheets SET locked = false, admin_unlocked = true WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Timesheet not found.' });
  res.json({ timesheet: result.rows[0] });
});

// --- Unlock requests inbox ---

router.get('/unlock-requests', async (req, res) => {
  const status = req.query.status || 'pending';
  const result = await pool.query(
    `SELECT ur.*, t.week_start, u.name AS employee_name, u.email AS employee_email
     FROM unlock_requests ur
     JOIN timesheets t ON t.id = ur.timesheet_id
     JOIN users u ON u.id = ur.requested_by
     WHERE ur.status = $1
     ORDER BY ur.created_at DESC`,
    [status]
  );
  res.json({ requests: result.rows });
});

router.post('/unlock-requests/:id/approve', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRow = (await client.query('SELECT * FROM unlock_requests WHERE id = $1', [req.params.id])).rows[0];
    if (!reqRow) throw Object.assign(new Error('Request not found.'), { status: 404 });

    await client.query(
      `UPDATE timesheets SET locked = false, admin_unlocked = true WHERE id = $1`,
      [reqRow.timesheet_id]
    );
    const updated = await client.query(
      `UPDATE unlock_requests SET status = 'approved', resolved_at = now(), resolved_by = $2
       WHERE id = $1 RETURNING *`,
      [req.params.id, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ request: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally {
    client.release();
  }
});

router.post('/unlock-requests/:id/deny', async (req, res) => {
  const result = await pool.query(
    `UPDATE unlock_requests SET status = 'denied', resolved_at = now(), resolved_by = $2
     WHERE id = $1 RETURNING *`,
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Request not found.' });
  res.json({ request: result.rows[0] });
});

// --- Dashboard stats ---
// Returns totals per employee and per project for a date range, plus company-wide totals.
router.get('/stats', async (req, res) => {
  const from = req.query.from || '1970-01-01';
  const to = req.query.to || '2999-12-31';

  const byProject = await pool.query(
    `SELECT COALESCE(p.id, 0) AS project_id, COALESCE(p.name, 'Other') AS project_name,
            COALESCE(SUM(te.hours), 0) AS hours
     FROM timesheet_entries te
     LEFT JOIN projects p ON p.id = te.project_id
     JOIN timesheets t ON t.id = te.timesheet_id
     WHERE te.entry_type IN ('work', 'other') AND te.work_date BETWEEN $1 AND $2
     GROUP BY p.id, p.name
     ORDER BY hours DESC`,
    [from, to]
  );

  // Per-employee totals: work hours, leave breakdown by category.
  const byEmployee = await pool.query(
    `SELECT u.id AS user_id, u.name AS employee_name,
            COALESCE(SUM(CASE WHEN te.entry_type IN ('work', 'other') THEN te.hours ELSE 0 END), 0) AS work_hours,
            COALESCE(SUM(CASE WHEN te.entry_type = 'sick_leave' THEN te.days ELSE 0 END), 0) AS sick_leave_days,
            COALESCE(SUM(CASE WHEN te.entry_type = 'local_leave' THEN te.days ELSE 0 END), 0) AS local_leave_days,
            COALESCE(SUM(CASE WHEN te.entry_type = 'emergency_leave' THEN te.days ELSE 0 END), 0) AS emergency_leave_days
     FROM users u
     LEFT JOIN timesheets t ON t.user_id = u.id AND t.week_start BETWEEN $1 AND $2
     LEFT JOIN timesheet_entries te ON te.timesheet_id = t.id
     WHERE u.active = true
     GROUP BY u.id, u.name
     ORDER BY u.name`,
    [from, to]
  );

  // Detailed breakdown: hours each employee worked on each specific project,
  // within the same date range.
  const byEmployeeProject = await pool.query(
    `SELECT t.user_id, u.name AS employee_name, COALESCE(te.project_id, 0) AS project_id, COALESCE(p.name, 'Other') AS project_name,
            SUM(te.hours) AS hours
     FROM timesheet_entries te
     JOIN timesheets t ON t.id = te.timesheet_id
     JOIN users u ON u.id = t.user_id
     LEFT JOIN projects p ON p.id = te.project_id
     WHERE te.entry_type IN ('work', 'other')
       AND t.week_start BETWEEN $1 AND $2 AND u.active = true
     GROUP BY t.user_id, u.name, te.project_id, p.name
     ORDER BY u.name, p.name`,
    [from, to]
  );

  // Extra hours: for each employee, for each individual day they worked,
  // any hours beyond the standard 7.5-hour day, summed across the range.
  const extraHoursResult = await pool.query(
    `SELECT user_id, employee_name, COALESCE(SUM(GREATEST(day_hours - 7.5, 0)), 0) AS extra_hours
     FROM (
       SELECT t.user_id, u.name AS employee_name, te.work_date, SUM(te.hours) AS day_hours
       FROM timesheet_entries te
       JOIN timesheets t ON t.id = te.timesheet_id
       JOIN users u ON u.id = t.user_id
       WHERE te.entry_type IN ('work', 'other')
         AND t.week_start BETWEEN $1 AND $2
       GROUP BY t.user_id, u.name, te.work_date
     ) day_totals
     GROUP BY user_id, employee_name`,
    [from, to]
  );
  const extraHoursByUser = {};
  for (const row of extraHoursResult.rows) {
    extraHoursByUser[row.user_id] = Number(row.extra_hours);
  }

  const byEmployeeWithExtra = byEmployee.rows.map((row) => ({
    ...row,
    extra_hours: extraHoursByUser[row.user_id] || 0
  }));

  const totals = byEmployeeWithExtra.reduce(
    (acc, row) => {
      acc.work_hours += Number(row.work_hours);
      acc.extra_hours += Number(row.extra_hours);
      acc.sick_leave_days += Number(row.sick_leave_days);
      acc.local_leave_days += Number(row.local_leave_days);
      acc.emergency_leave_days += Number(row.emergency_leave_days);
      return acc;
    },
    {
      work_hours: 0, extra_hours: 0, sick_leave_days: 0, local_leave_days: 0,
      emergency_leave_days: 0
    }
  );

  res.json({
    by_project: byProject.rows,
    by_employee: byEmployeeWithExtra,
    by_employee_project: byEmployeeProject.rows,
    company_totals: totals
  });
});

// --- Excel export ---
router.get('/export.xlsx', async (req, res) => {
  try {
    const from = req.query.from || '1970-01-01';
    const to = req.query.to || '2999-12-31';

    // ---------------------------------------------------------
    // 1. Get detailed timesheet data
    // ---------------------------------------------------------
    const result = await pool.query(
      `SELECT
          u.name AS employee,
          u.email,
          t.week_start,
          te.work_date,
          te.entry_type,
          p.name AS project,
          te.hours,
          te.days,
          te.leave_unit,
          te.justification,
          te.other_description
       FROM timesheet_entries te
       JOIN timesheets t ON t.id = te.timesheet_id
       JOIN users u ON u.id = t.user_id
       LEFT JOIN projects p ON p.id = te.project_id
       WHERE te.work_date BETWEEN $1 AND $2
       ORDER BY u.name, te.work_date, p.name`,
      [from, to]
    );

    // ---------------------------------------------------------
    // 2. Create Excel workbook
    // ---------------------------------------------------------
    const workbook = new ExcelJS.Workbook();

    workbook.creator = 'Timesheet System';
    workbook.created = new Date();

    // =========================================================
    // SHEET 1 - TIMESHEET DETAILS
    // =========================================================
    const detailsSheet = workbook.addWorksheet('Timesheet Details');

    detailsSheet.columns = [
      { header: 'Employee', key: 'employee', width: 25 },
      { header: 'Email', key: 'email', width: 32 },
      { header: 'Week Start', key: 'week_start', width: 14 },
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'Project', key: 'project', width: 30 },
      { header: 'Hours', key: 'hours', width: 12 },
      { header: 'Days', key: 'days', width: 12 },
      { header: 'Unit', key: 'unit', width: 12 },
      { header: 'Justification', key: 'justification', width: 35 },
      { header: 'Other Work Description', key: 'other_description', width: 45 }
    ];

    // Header formatting
    const detailsHeader = detailsSheet.getRow(1);

    detailsHeader.font = {
      bold: true,
      color: { argb: 'FFFFFFFF' }
    };

    detailsHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1F4E78' }
    };

    detailsHeader.alignment = {
      vertical: 'middle',
      horizontal: 'center'
    };

    detailsHeader.height = 25;

    // ---------------------------------------------------------
    // Employee colours
    // ---------------------------------------------------------
    const employeeColours = [
      'FFE2F0D9',
      'FFDDEBF7',
      'FFFFE699',
      'FFF4CCCC',
      'FFEADCF8',
      'FFFCE4D6',
      'FFD9EAD3',
      'FFCFE2F3',
      'FFF9CB9C',
      'FFD9D2E9',
      'FFE6B8AF',
      'FFC9DAF8',
      'FFD0E0E3',
      'FFFCE5CD',
      'FFE4DFEC'
    ];

    const employeeColourMap = {};
    let nextColourIndex = 0;

    // ---------------------------------------------------------
    // Add detailed rows
    // ---------------------------------------------------------
    for (const r of result.rows) {
      const employee = r.employee || 'Unknown Employee';

      if (!employeeColourMap[employee]) {
        employeeColourMap[employee] =
          employeeColours[nextColourIndex % employeeColours.length];

        nextColourIndex++;
      }

      const row = detailsSheet.addRow({
        employee: r.employee || '',
        email: r.email || '',
        week_start: r.week_start || '',
        date: r.work_date || '',
        type: r.entry_type || '',
        project: r.project || '',
        hours: r.hours !== null ? Number(r.hours) : '',
        days: r.days !== null ? Number(r.days) : '',
        unit: r.leave_unit || '',
        justification: r.justification || '',
        other_description: r.other_description || ''
      });

      // Colour the entire row according to employee
      row.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: {
            argb: employeeColourMap[employee]
          }
        };
      });

      row.alignment = {
        vertical: 'top'
      };
    }

    // Format numeric columns
    detailsSheet.getColumn('hours').numFmt = '0.0';
    detailsSheet.getColumn('days').numFmt = '0.0';

    // Freeze header
    detailsSheet.views = [
      {
        state: 'frozen',
        ySplit: 1
      }
    ];

    // Add filters
    detailsSheet.autoFilter = {
      from: 'A1',
      to: 'K1'
    };

    // =========================================================
    // SHEET 2 - PROJECT SUMMARY
    // =========================================================

    const projectSheet = workbook.addWorksheet('Project Summary');

    projectSheet.columns = [
      { header: 'Project', key: 'project', width: 35 },
      { header: 'Employee', key: 'employee', width: 30 },
      { header: 'Email', key: 'email', width: 35 },
      { header: 'Hours Worked', key: 'hours', width: 18 }
    ];

    // ---------------------------------------------------------
    // Calculate hours per project per employee
    // ---------------------------------------------------------
    const projectData = {};

    for (const r of result.rows) {
      // Ignore leave entries; Other is reported as its own project category.
      if (!['work', 'other'].includes(r.entry_type)) {
        continue;
      }

      const project = r.project || 'Other';
      const employee = r.employee || 'Unknown Employee';
      const email = r.email || '';

      if (!projectData[project]) {
        projectData[project] = {};
      }

      if (!projectData[project][employee]) {
        projectData[project][employee] = {
          email,
          hours: 0
        };
      }

      projectData[project][employee].hours += Number(r.hours) || 0;
    }

    // ---------------------------------------------------------
    // Project Summary header
    // ---------------------------------------------------------
    const projectHeader = projectSheet.getRow(1);

    projectHeader.font = {
      bold: true,
      color: { argb: 'FFFFFFFF' }
    };

    projectHeader.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF548235' }
    };

    projectHeader.alignment = {
      vertical: 'middle',
      horizontal: 'center'
    };

    projectHeader.height = 25;

    // ---------------------------------------------------------
    // Add projects and employees
    // ---------------------------------------------------------
    const sortedProjects = Object.keys(projectData).sort(
      (a, b) => a.localeCompare(b)
    );

    for (const project of sortedProjects) {
      const employees = Object.entries(projectData[project])
        .sort(([employeeA], [employeeB]) =>
          employeeA.localeCompare(employeeB)
        );

      let projectTotal = 0;

      for (const [employee, data] of employees) {
        const hours = Number(data.hours) || 0;

        projectSheet.addRow({
          project,
          employee,
          email: data.email,
          hours
        });

        projectTotal += hours;
      }

      // Project total row
      const totalRow = projectSheet.addRow({
        project: `${project} TOTAL`,
        employee: '',
        email: '',
        hours: projectTotal
      });

      totalRow.font = {
        bold: true
      };

      totalRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD9EAD3' }
      };

      // Blank row between projects
      projectSheet.addRow({});
    }

    projectSheet.getColumn('hours').numFmt = '0.0';

    projectSheet.views = [
      {
        state: 'frozen',
        ySplit: 1
      }
    ];

    projectSheet.autoFilter = {
      from: 'A1',
      to: 'D1'
    };

    // ---------------------------------------------------------
    // Add borders to both sheets
    // ---------------------------------------------------------
    for (const sheet of [detailsSheet, projectSheet]) {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cell.border = {
            top: {
              style: 'thin',
              color: { argb: 'FFD9D9D9' }
            },
            left: {
              style: 'thin',
              color: { argb: 'FFD9D9D9' }
            },
            bottom: {
              style: 'thin',
              color: { argb: 'FFD9D9D9' }
            },
            right: {
              style: 'thin',
              color: { argb: 'FFD9D9D9' }
            }
          };
        });
      });
    }

    // ---------------------------------------------------------
    // Send Excel file to browser
    // ---------------------------------------------------------
    const filename = `timesheets_${from}_to_${to}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`
    );

    await workbook.xlsx.write(res);

    res.end();

  } catch (err) {
    console.error('Excel export failed:', err);
    res.status(500).json({
      error: 'Failed to generate Excel export'
    });
  }
});

module.exports = router;
