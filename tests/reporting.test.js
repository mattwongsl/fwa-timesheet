const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function helpers(Api = {}) {
  const context = vm.createContext({ Intl, Date, URLSearchParams, Api });
  return vm.runInContext(fs.readFileSync('public/js/reports.js', 'utf8') + '\nReports;', context);
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const projects = [
  { id: 1, name: 'Zulu', created_at: '2026-04-02T00:00:00Z', archived: false },
  { id: 2, name: 'alpha', created_at: '2026-02-01T00:00:00Z', archived: true },
  { id: 3, name: 'Beta', created_at: '2026-03-01T00:00:00Z', archived: false }
];
test('catalog preserves zero-hour and archived projects and represents Other only when hours exist', () => {
  const report = helpers();
  const rows = report.catalog(projects, [{ project_id: 1, hours: '7.5' }, { project_id: 0, hours: '2' }]);
  assert.equal(rows.length, 4);
  assert.equal(rows.find((r) => r.id === 2).hours, 0);
  assert.equal(rows.find((r) => r.id === 2).archived, true);
  assert.equal(rows.find((r) => r.id === 0).hours, 2);
  assert.equal(report.catalog(projects, [{ project_id: 0, hours: '0' }]).length, 3);
});
test('all six sorting modes, case-insensitive search and status filtering', () => {
  const report = helpers();
  const rows = report.catalog(projects, [{ project_id: 1, hours: 15 }, { project_id: 2, hours: 5 }]);
  const ids = (sort) => plain(report.filterProjects(rows, { sort }).map((p) => p.id));
  assert.deepEqual(ids('name-asc'), [2, 3, 1]);
  assert.deepEqual(ids('name-desc'), [1, 3, 2]);
  assert.deepEqual(ids('newest'), [1, 3, 2]);
  assert.deepEqual(ids('oldest'), [2, 3, 1]);
  assert.deepEqual(ids('hours-desc'), [1, 2, 3]);
  assert.deepEqual(ids('hours-asc'), [3, 2, 1]);
  assert.equal(report.filterProjects(rows, { search: ' ALP ', status: 'archived' })[0].id, 2);
  assert.equal(report.filterProjects(rows, { status: 'active' }).length, 2);
  assert.equal(report.filterProjects(rows, { search: 'does not exist' }).length, 0);
  const other = report.catalog(projects, [{ project_id: 0, hours: 2 }]);
  assert.equal(report.filterProjects(other, { sort: 'oldest' }).at(-1).id, 0);
});
test('validates actual calendar dates, leap years and reversed ranges', () => {
  const report = helpers();
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '', 'foo']) assert.equal(report.validDate(date), false, date);
  assert.equal(report.validDate('2024-02-29'), true);
  assert.throws(() => report.validateRange('2026-11-01', '2026-10-01'), /start date/);
});
test('project totals use exact work dates and include inactive staff, duplicate names and Other entries', () => {
  const report = helpers();
  const sheets = [
    { timesheet: { user_id: 1, employee_name: 'Same Name' }, days: [
      { date: '2026-10-26', projects: [{ project_id: 1, hours: 99 }] },
      { date: '2026-10-28', projects: [{ project_id: 1, hours: '3.5' }, { project_id: null, entry_type: 'other', hours: 2 }] },
      { date: '2026-10-29', projects: [{ project_id: 1, hours: 1 }, { project_id: 2, hours: 2 }] }
    ] },
    { timesheet: { user_id: 2, employee_name: 'Same Name', active: false }, days: [
      { date: '2026-10-28', projects: [{ project_id: 1, hours: 4.5 }, { project_id: 2, hours: 0 }, { project_id: 2, hours: 'NaN' }] },
      { date: '2026-10-30', projects: [{ project_id: 1, hours: 99 }] }
    ] }
  ];
  const results = report.aggregateDetails(sheets, '2026-10-28', '2026-10-29');
  assert.equal(results.get(1).hours, 9);
  assert.equal(results.get(1).work_days, 2);
  assert.equal(results.get(1).employees.length, 2);
  assert.equal(results.get(2).hours, 2);
  assert.equal(results.get(0).hours, 2);
  assert.equal(results.get(1).employees.reduce((sum, e) => sum + e.hours, 0), results.get(1).hours);
});
test('detail loading queries intersecting Mondays, deduplicates sheets and limits concurrent requests', async () => {
  let calls = [], concurrent = 0, maxConcurrent = 0;
  const report = helpers({ get: async (url) => {
    calls.push(url);
    if (url.includes('?')) return { timesheets: [...Array.from({ length: 7 }, (_, i) => ({ timesheet: { id: i + 1 } })), { timesheet: { id: 1 } }] };
    maxConcurrent = Math.max(maxConcurrent, ++concurrent);
    await new Promise((resolve) => setTimeout(resolve, 2)); concurrent--;
    return { timesheet: { user_id: Number(url.split('/').at(-1)), employee_name: 'Employee' }, days: [{ date: '2026-10-28', projects: [{ project_id: 1, hours: 1 }] }] };
  } });
  const totals = await report.loadDetails('2026-10-28', '2026-11-01');
  assert.equal(calls[0], '/api/admin/timesheets?from=2026-10-26&to=2026-10-26');
  assert.equal(calls.length, 8);
  assert.equal(maxConcurrent, 4);
  assert.equal(totals.get(1).hours, 7);
});
test('links preserve dates, prevent self-comparison and safely escape project or employee names', () => {
  const report = helpers();
  const url = report.projectUrl(1, '2026-10-01', '2026-10-29', 2);
  assert.match(url, /id=1&from=2026-10-01&to=2026-10-29&compare=2/);
  assert.doesNotMatch(report.projectUrl(1, '2026-10-01', '2026-10-29', 1), /compare/);
  assert.equal(report.escape('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
  const project = { hours: 10, employees: [{ id: 1, name: '<b>Person</b>', hours: 10 }] };
  const chart = report.donut(project, report.employeeColors([project]));
  assert.match(chart, /&lt;b&gt;Person&lt;\/b&gt;/);
  assert.doesNotMatch(chart, /NaN/);
  assert.match(report.donut({ hours: 0, employees: [] }, new Map()), /No hours recorded/);
});
