const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { object, positiveId, date, version, range, httpError } = require('../validation/common');
const service = require('../timesheetService');
const ExcelJS = require('exceljs');
const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/timesheets', asyncHandler(async (req, res) => {
  object(req.query, ['user_id', 'week', 'from', 'to'], 'query');
  const filters = { actorId: req.user.id, admin: true };
  if (req.query.user_id !== undefined) filters.userId = positiveId(req.query.user_id, 'user_id');
  for (const key of ['week', 'from', 'to']) if (req.query[key] !== undefined) filters[key] = date(req.query[key], key);
  if (filters.from && filters.to && filters.from > filters.to) throw httpError(400, 'from must be on or before to.');
  res.json({ timesheets: await service.listTimesheets(filters) });
}));

router.get('/timesheets/:id', asyncHandler(async (req, res) => {
  res.json(await service.getTimesheet(positiveId(req.params.id, 'Timesheet id'), req.user.id, { admin: true }));
}));
router.put('/timesheets/:id/entries', asyncHandler(async (req, res) => {
  res.json(await service.replaceEntries(positiveId(req.params.id, 'Timesheet id'), req.body, req.user.id, { admin: true }));
}));
for (const [action, locked] of [['lock', true], ['unlock', false]]) {
  router.post(`/timesheets/:id/${action}`, asyncHandler(async (req, res) => {
    object(req.body, ['version']);
    res.json(await service.setTimesheetLock(positiveId(req.params.id, 'Timesheet id'), version(req.body.version), req.user.id, locked));
  }));
}
router.get('/unlock-requests', asyncHandler(async (req, res) => {
  object(req.query, ['status'], 'query');
  const status = req.query.status || 'pending';
  if (!['pending', 'approved', 'denied'].includes(status)) throw httpError(400, 'Invalid unlock request status.');
  const result = await pool.query(`SELECT ur.*,t.week_start,u.name AS employee_name,u.email AS employee_email FROM unlock_requests ur JOIN timesheets t ON t.id=ur.timesheet_id JOIN users u ON u.id=ur.requested_by WHERE ur.status=$1 ORDER BY ur.created_at DESC`, [status]);
  res.json({ requests: result.rows });
}));
for (const [action, approve] of [['approve', true], ['deny', false]]) {
  router.post(`/unlock-requests/:id/${action}`, asyncHandler(async (req, res) => {
    object(req.body ?? {}, []);
    res.json(await service.resolveUnlockRequest(positiveId(req.params.id, 'Request id'), req.user.id, approve));
  }));
}

router.get('/stats', asyncHandler(async (req, res) => {
  object(req.query, ['from', 'to'], 'query');
  const { from, to } = range(req.query);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const byProject = await client.query(`SELECT COALESCE(p.id,0) AS project_id,COALESCE(p.name,'Other') AS project_name,SUM(te.hours) AS hours FROM timesheet_entries te LEFT JOIN projects p ON p.id=te.project_id WHERE te.entry_type IN ('work','other') AND te.hours>0 AND te.work_date BETWEEN $1 AND $2 GROUP BY p.id,p.name ORDER BY hours DESC`, [from, to]);
    const byEmployee = await client.query(`SELECT u.id AS user_id,u.name AS employee_name,
      COALESCE(SUM(CASE WHEN te.entry_type IN ('work','other') THEN te.hours ELSE 0 END),0) AS work_hours,
      COALESCE(SUM(CASE WHEN te.entry_type='sick_leave' THEN te.days ELSE 0 END),0) AS sick_leave_days,
      COALESCE(SUM(CASE WHEN te.entry_type='local_leave' THEN te.days ELSE 0 END),0) AS local_leave_days,
      COALESCE(SUM(CASE WHEN te.entry_type='emergency_leave' THEN te.days ELSE 0 END),0) AS emergency_leave_days
      FROM users u LEFT JOIN timesheets t ON t.user_id=u.id
      LEFT JOIN timesheet_entries te ON te.timesheet_id=t.id AND te.work_date BETWEEN $1 AND $2
      GROUP BY u.id,u.name,u.active HAVING u.active OR COUNT(te.id)>0 ORDER BY u.name`, [from, to]);
    const byEmployeeProject = await client.query(`SELECT t.user_id,u.name AS employee_name,COALESCE(te.project_id,0) AS project_id,COALESCE(p.name,'Other') AS project_name,SUM(te.hours) AS hours FROM timesheet_entries te JOIN timesheets t ON t.id=te.timesheet_id JOIN users u ON u.id=t.user_id LEFT JOIN projects p ON p.id=te.project_id WHERE te.entry_type IN ('work','other') AND te.hours>0 AND te.work_date BETWEEN $1 AND $2 GROUP BY t.user_id,u.name,te.project_id,p.name ORDER BY u.name,p.name`, [from, to]);
    const extra = await client.query(`SELECT user_id,SUM(GREATEST(day_hours-7.5,0)) AS extra_hours FROM (SELECT t.user_id,te.work_date,SUM(te.hours) AS day_hours FROM timesheet_entries te JOIN timesheets t ON t.id=te.timesheet_id WHERE te.entry_type IN ('work','other') AND te.work_date BETWEEN $1 AND $2 GROUP BY t.user_id,te.work_date) daily GROUP BY user_id`, [from, to]);
    const extraByUser = new Map(extra.rows.map((r) => [r.user_id, Number(r.extra_hours)]));
    const employees = byEmployee.rows.map((r) => ({ ...r, extra_hours: extraByUser.get(r.user_id) || 0 }));
    const totals = { work_hours: 0, extra_hours: 0, sick_leave_days: 0, local_leave_days: 0, emergency_leave_days: 0 };
    for (const row of employees) for (const key of Object.keys(totals)) totals[key] += Number(row[key]);
    await client.query('COMMIT');
    res.json({ by_project: byProject.rows, by_employee: employees, by_employee_project: byEmployeeProject.rows, company_totals: totals });
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}));
router.get('/export.xlsx', asyncHandler(async (req, res) => {
    object(req.query, ['from', 'to'], 'query');
    const { from, to } = range(req.query);

    // ---------------------------------------------------------
    // 1. Get detailed timesheet data
    // ---------------------------------------------------------
    const result = await pool.query(
      `SELECT
          u.id AS user_id,
          p.id AS project_id,
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

    const employeeColourMap = new Map();
    let nextColourIndex = 0;

    // ---------------------------------------------------------
    // Add detailed rows
    // ---------------------------------------------------------
    for (const r of result.rows) {
      const employeeId = r.user_id;

      if (!employeeColourMap.has(employeeId)) {
        employeeColourMap.set(employeeId, employeeColours[nextColourIndex % employeeColours.length]);

        nextColourIndex++;
      }

      const row = detailsSheet.addRow({
        employee: r.employee || '',
        email: r.email || '',
        week_start: r.week_start || '',
        date: r.work_date || '',
        type: r.entry_type || '',
        project: r.entry_type === 'other' ? 'Other work (unassigned)' : r.project || '',
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
            argb: employeeColourMap.get(employeeId)
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
    const projectData = new Map();
    for (const r of result.rows) {
      // Identity, not display names, separates projects and contributors.
      if (!['work', 'other'].includes(r.entry_type) || (r.entry_type === 'work' && r.project_id === null)) continue;
      const id = r.project_id ?? 0;
      if (!projectData.has(id)) projectData.set(id, { id, name: id === 0 ? 'Other work (unassigned)' : r.project, employees: new Map() });
      const project = projectData.get(id);
      if (!project.employees.has(r.user_id)) project.employees.set(r.user_id, { name: r.employee || 'Unknown Employee', email: r.email || '', hours: 0 });
      project.employees.get(r.user_id).hours += Number(r.hours);
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
    const sortedProjects = [...projectData.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
    for (const project of sortedProjects) {
      const employees = [...project.employees.values()].sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));

      let projectTotal = 0;

      for (const data of employees) {
        const hours = Number(data.hours) || 0;

        projectSheet.addRow({
          project: project.name,
          employee: data.name,
          email: data.email,
          hours
        });

        projectTotal += hours;
      }

      // Project total row
      const totalRow = projectSheet.addRow({
        project: `${project.name} TOTAL`,
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

}));

module.exports = router;
