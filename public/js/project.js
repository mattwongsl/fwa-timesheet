/* Dedicated project reports and two-project comparison, using read-only APIs. */
let projectCatalog = [];
let primaryProjectId;
let projectLoadVersion = 0;
const detailCache = new Map();
const query = new URLSearchParams(window.location.search);

async function initializeProjectPage() {
  const user = await requireSession();
  if (!user) return;
  if (user.role !== 'admin') { window.location.href = '/employee.html'; return; }
  document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  document.getElementById('applyProjectDates').addEventListener('click', () => {
    detailCache.clear();
    loadProjectReport();
  });
  document.getElementById('compareWith').addEventListener('change', loadProjectReport);
  const today = Reports.localDate();
  document.getElementById('detailFrom').value = query.get('from') ?? `${today.slice(0, 4)}-01-01`;
  document.getElementById('detailTo').value = query.get('to') ?? today;
  try {
    const id = query.get('id');
    if (!/^(0|[1-9]\d*)$/.test(id || '') || !Number.isSafeInteger(Number(id))) throw new Error('Choose a project from the project table to open its report.');
    primaryProjectId = Number(id);
    const response = await Api.get('/api/projects?all=1');
    projectCatalog = [...response.projects, { id: 0, name: 'Other work', archived: false, created_at: null }].map((p) => ({ ...p, id: Number(p.id) }));
    if (!projectCatalog.some((p) => p.id === primaryProjectId)) throw new Error('This project could not be found. It may have been deleted.');
    const select = document.getElementById('compareWith');
    projectCatalog.filter((p) => p.id !== primaryProjectId).sort((a, b) => a.name.localeCompare(b.name)).forEach((p) => {
      const option = document.createElement('option'); option.value = p.id; option.textContent = p.name + (p.archived ? ' (archived)' : ''); select.appendChild(option);
    });
    const comparison = query.get('compare');
    if (comparison !== null && comparison !== String(primaryProjectId)) {
      if (!/^(0|[1-9]\d*)$/.test(comparison) || !projectCatalog.some((p) => p.id === Number(comparison))) throw new Error('The comparison project could not be found. Choose another project above.');
      select.value = comparison;
    }
    await loadProjectReport();
  } catch (e) {
    document.getElementById('projectError').textContent = e.message;
    document.getElementById('projectLoading').hidden = true;
  }
}

async function loadProjectReport() {
  const version = ++projectLoadVersion;
  const from = document.getElementById('detailFrom').value;
  const to = document.getElementById('detailTo').value;
  const secondary = document.getElementById('compareWith').value;
  const error = document.getElementById('projectError');
  const loading = document.getElementById('projectLoading');
  error.textContent = '';
  try { Reports.validateRange(from, to); } catch (e) { error.textContent = e.message; return; }
  if (!projectCatalog.some((p) => p.id === primaryProjectId)) return;
  const ids = [primaryProjectId];
  if (secondary !== '' && Number(secondary) !== primaryProjectId) ids.push(Number(secondary));
  document.getElementById('projectResults').hidden = true;
  document.getElementById('comparisonSection').hidden = true;
  loading.hidden = false;
  loading.textContent = 'Loading project hours…';
  const cacheKey = `${from}/${to}`;
  try {
    if (!detailCache.has(cacheKey)) {
      detailCache.set(cacheKey, Reports.loadDetails(from, to, (done, total) => {
        if (version === projectLoadVersion) loading.textContent = `Loading project hours… ${done} of ${total} timesheets`;
      }).catch((e) => { detailCache.delete(cacheKey); throw e; }));
    }
    const details = await detailCache.get(cacheKey);
    if (version !== projectLoadVersion) return;
    const projects = ids.map((id) => ({ ...projectCatalog.find((p) => p.id === id), ...(details.get(id) || { hours: 0, work_days: 0, employees: [] }) }));
    const colors = Reports.employeeColors(projects);
    document.getElementById('projectHeading').textContent = ids.length === 2 ? 'Projects, side by side.' : projects[0].name;
    document.title = `${ids.length === 2 ? 'Project comparison' : projects[0].name} · FWA`;
    document.getElementById('projectSubtitle').textContent = `${Reports.formatDate(from)} – ${Reports.formatDate(to)} · ${ids.length === 2 ? 'Two projects. One shared view.' : 'Hours and employee contributions for this project.'}`;
    document.getElementById('projectResults').innerHTML = projects.map((p) => projectCard(p, colors)).join('');
    document.getElementById('projectResults').classList.toggle('is-comparing', ids.length === 2);
    document.getElementById('projectResults').hidden = false;
    if (projects.length === 2) renderComparison(projects, colors);
    document.getElementById('backToReports').href = Reports.dashboardUrl(from, to);
    window.history.replaceState(null, '', Reports.projectUrl(primaryProjectId, from, to, ids[1]));
  } catch (e) {
    if (version === projectLoadVersion) error.textContent = `Couldn't load project details: ${e.message} Try Update report again.`;
  } finally {
    if (version === projectLoadVersion) loading.hidden = true;
  }
}

function projectCard(project, colors) {
  const escape = Reports.escape;
  const employees = project.employees;
  return `<article class="card project-detail-card" aria-label="${escape(project.name)} report">
    <div class="section-heading"><div><span class="eyebrow">${project.id === 0 ? 'Unassigned work' : project.archived ? 'Archived project' : 'Active project'}</span><h2>${escape(project.name)}</h2></div></div>
    <div class="project-metrics"><div><strong>${Reports.hours(project.hours)}</strong><span>Recorded hours</span></div><div><strong>${employees.length}</strong><span>Contributors</span></div><div><strong>${project.work_days}</strong><span>Days with work</span></div></div>
    <div class="contribution-section"><div class="chart-heading"><h3>Who contributed</h3><p class="muted">Each person's share of recorded hours.</p></div>
      <div class="chart-layout">${Reports.donut(project, colors)}<ul class="chart-legend">${employees.map((e) => `<li><span class="legend-label"><span class="chart-dot" style="background:${colors.get(e.id)}"></span>${escape(e.name)}</span><strong>${Reports.hours(e.hours / project.hours * 100)}%</strong></li>`).join('')}</ul></div>
    </div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="${escape(project.name)} employee hours"><table><thead><tr><th>Employee</th><th class="numeric">Hours</th><th class="numeric">Share</th></tr></thead><tbody>${employees.map((e) => `<tr><td><span class="chart-dot" style="background:${colors.get(e.id)}"></span>${escape(e.name)}</td><td class="numeric">${Reports.hours(e.hours)}</td><td class="numeric">${Reports.hours(e.hours / project.hours * 100)}%</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">No employee hours recorded in this range.</td></tr>'}</tbody></table></div>
    <p class="project-created muted">Date added: ${Reports.formatDate(project.created_at)}</p>
  </article>`;
}

function renderComparison(projects, colors) {
  const [a, b] = projects;
  const people = new Map();
  for (const project of projects) for (const e of project.employees) people.set(e.id, e.name);
  document.getElementById('comparisonTableHead').innerHTML = `<tr><th>Employee</th><th class="numeric">${Reports.escape(a.name)} (hrs)</th><th class="numeric">${Reports.escape(b.name)} (hrs)</th></tr>`;
  document.getElementById('comparisonTableBody').innerHTML = [...people].sort((x, y) => x[1].localeCompare(y[1])).map(([id, name]) => `<tr><td><span class="chart-dot" style="background:${colors.get(id)}"></span>${Reports.escape(name)}</td><td class="numeric">${Reports.hours(a.employees.find((e) => e.id === id)?.hours || 0)}</td><td class="numeric">${Reports.hours(b.employees.find((e) => e.id === id)?.hours || 0)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">No recorded hours for either project in this range.</td></tr>';
  const delta = Math.abs(a.hours - b.hours);
  document.getElementById('comparisonSummary').textContent = delta ? `${a.hours > b.hours ? a.name : b.name} has ${Reports.hours(delta)} more recorded hours in this period.` : 'Both projects have the same recorded hours in this period.';
  const max = Math.max(a.hours, b.hours, 1);
  document.getElementById('comparisonBars').innerHTML = projects.map((p, index) => `<div class="comparison-bar-row"><span>${Reports.escape(p.name)}</span><div class="comparison-bar-track"><span style="width:${p.hours / max * 100}%;background:${index ? '#477ac1' : '#0a3179'}"></span></div><strong>${Reports.hours(p.hours)} hrs</strong></div>`).join('');
  document.getElementById('comparisonSection').hidden = false;
}

initializeProjectPage();
