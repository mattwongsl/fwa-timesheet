/* Shared, read-only reporting helpers. Uses the existing API and no chart dependencies. */
const Reports = (() => {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hours = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value) || 0);
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  function validateRange(from, to) {
    if (!validDate(from) || !validDate(to)) throw new Error('Choose a valid start and end date.');
    if (from > to) throw new Error('The start date must be on or before the end date.');
  }
  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function monday(date) {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return localDate(d);
  }
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(String(value).length === 10 ? `${value}T12:00:00` : value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function catalog(projects, totals) {
    const sums = new Map(totals.map((p) => [Number(p.project_id), Number(p.hours) || 0]));
    const rows = projects.map((p) => ({ ...p, id: Number(p.id), hours: sums.get(Number(p.id)) || 0 }));
    if ((sums.get(0) || 0) > 0) rows.push({ id: 0, name: 'Other work', archived: false, created_at: null, hours: sums.get(0) });
    return rows;
  }
  function filterProjects(projects, { search = '', status = 'all', sort = 'hours-desc' } = {}) {
    const query = search.trim().toLocaleLowerCase();
    const rows = projects.filter((p) => p.name.toLocaleLowerCase().includes(query) && (status === 'all' || (status === 'archived' ? p.archived : !p.archived)));
    const nameOrder = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id - b.id;
    return rows.sort((a, b) => {
      if (sort === 'name-asc') return nameOrder(a, b);
      if (sort === 'name-desc') return nameOrder(b, a);
      if (sort === 'newest' || sort === 'oldest') {
        const aDate = Date.parse(a.created_at), bDate = Date.parse(b.created_at);
        if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.isNaN(aDate) === Number.isNaN(bDate) ? nameOrder(a, b) : Number.isNaN(aDate) ? 1 : -1;
        return (sort === 'newest' ? bDate - aDate : aDate - bDate) || nameOrder(a, b);
      }
      return (sort === 'hours-asc' ? a.hours - b.hours : b.hours - a.hours) || nameOrder(a, b);
    });
  }
  function projectUrl(id, from, to, compare) {
    const params = new URLSearchParams({ id: String(id), from, to });
    if (compare !== undefined && compare !== null && Number(compare) !== Number(id)) params.set('compare', String(compare));
    return `/project.html?${params}`;
  }
  function dashboardUrl(from, to) {
    return `/admin.html?${new URLSearchParams({ from, to })}#stats`;
  }
  function aggregateDetails(sheets, from, to) {
    const projects = new Map();
    for (const { timesheet, days } of sheets) {
      for (const day of days || []) {
        if (day.date < from || day.date > to) continue;
        for (const entry of day.projects || []) {
          const amount = Number(entry.hours);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          const id = Number(entry.project_id) || 0;
          if (!projects.has(id)) projects.set(id, { id, hours: 0, employees: new Map(), dates: new Set() });
          const project = projects.get(id);
          const userId = timesheet.user_id;
          if (!project.employees.has(userId)) project.employees.set(userId, { id: userId, name: timesheet.employee_name, hours: 0 });
          project.hours += amount;
          project.employees.get(userId).hours += amount;
          project.dates.add(day.date);
        }
      }
    }
    return new Map([...projects].map(([id, p]) => [id, { id, hours: p.hours, work_days: p.dates.size, employees: [...p.employees.values()].sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name)) }]));
  }
  async function loadDetails(from, to, onProgress = () => {}) {
    validateRange(from, to);
    // Request every intersecting week, then filter individual work dates. This
    // includes inactive staff and partial weeks without changing server logic.
    const query = new URLSearchParams({ from: monday(from), to: monday(to) });
    const data = await Api.get(`/api/admin/timesheets?${query}`);
    const ids = [...new Set(data.timesheets.map(({ timesheet }) => timesheet.id))];
    const sheets = new Array(ids.length);
    let cursor = 0, completed = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        const index = cursor++;
        sheets[index] = await Api.get(`/api/admin/timesheets/${ids[index]}`);
        onProgress(++completed, ids.length);
      }
    }));
    return aggregateDetails(sheets, from, to);
  }
  function employeeColors(projects) {
    const ids = [...new Set(projects.flatMap((p) => p.employees.map((e) => e.id)))].sort((a, b) => Number(a) - Number(b));
    const palette = ['#0a3179', '#477ac1', '#87a9db', '#536579', '#c19148', '#7972a4', '#2e7990', '#a66568'];
    return new Map(ids.map((id, i) => [id, palette[i] || `hsl(${(i * 47) % 360} 45% 43%)`]));
  }
  function donut(project, colors) {
    if (!project.hours) return '<div class="chart-empty">No hours recorded<br>in this date range.</div>';
    let offset = 0;
    const segments = project.employees.map((e) => {
      const percent = e.hours / project.hours * 100;
      const circle = `<circle cx="100" cy="100" r="73" fill="none" stroke="${colors.get(e.id)}" stroke-width="25" pathLength="100" stroke-dasharray="${percent} ${100 - percent}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"><title>${escape(e.name)}: ${hours(e.hours)} hours (${hours(percent)}%)</title></circle>`;
      offset += percent;
      return circle;
    }).join('');
    return `<svg class="hours-donut" viewBox="0 0 200 200" role="img" aria-label="Employee share of ${hours(project.hours)} project hours; exact values in the table below.">${segments}<text x="100" y="99" text-anchor="middle" class="donut-total">${hours(project.hours)}</text><text x="100" y="121" text-anchor="middle" class="donut-caption">total hours</text></svg>`;
  }
  return { escape, hours, validDate, validateRange, localDate, formatDate, catalog, filterProjects, projectUrl, dashboardUrl, aggregateDetails, loadDetails, employeeColors, donut };
})();
