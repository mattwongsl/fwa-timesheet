const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const LEAVE_LABELS = {
  work: 'Working',
  sick_leave: 'Sick Leave',
  local_leave: 'Local Leave',
  emergency_leave: 'Emergency Leave',
  public_holiday: 'Public Holiday'
};
const STANDARD_WORKDAY_HOURS = 7.5;

let currentUser = null;
let allEmployees = [];
let allProjects = [];
let editingTimesheetId = null;
let editingTimesheetVersion = null;
let editingDays = [];
let editingSavedSnapshot = null;
let editingSession = 0;

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function dayWorkTotal(day) {
  return (day.projects || []).reduce((sum, p) => sum + (Number(p.hours) || 0), 0);
}
function isHalfDayLeave(day) { return ['sick_leave', 'local_leave', 'emergency_leave'].includes(day.type) && Number(day.leave_days) === 0.5; }
function weekNumber(weekStart) { const y = Number(weekStart.slice(0, 4)); const jan7 = new Date(`${y}-01-07T00:00:00`); const monday = new Date(jan7); monday.setDate(jan7.getDate() - ((jan7.getDay() + 6) % 7)); return Math.floor((new Date(`${weekStart}T00:00:00`) - monday) / 604800000) + 1; }
function firstAvailableProjectId(day) { const used = new Set((day.projects || []).map((p) => Number(p.project_id))); const project = allProjects.find((p) => !used.has(p.id)); return project ? project.id : null; }
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Local (not UTC) "this week's Monday", used to label a timesheet's status.
function currentMondayLocal() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A past week that was simply never submitted still shows as "Closed", not
// "Open" - it's editable-by-employee status is what governs the label, not
// the raw locked flag.
function statusBadgeHtml(timesheet) {
  const thisMonday = currentMondayLocal();
  let label, cls;
  if (timesheet.week_start > thisMonday) {
    label = 'Upcoming'; cls = 'pending';
  } else if (timesheet.admin_unlocked) {
    label = 'Open'; cls = 'open';
  } else if (timesheet.week_start < thisMonday) {
    label = 'Closed'; cls = 'locked';
  } else if (timesheet.locked) {
    label = 'Locked'; cls = 'locked';
  } else {
    label = 'Open'; cls = 'open';
  }
  return `<span class="badge ${cls}">${label}</span>`;
}

function switchTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

async function init() {
  currentUser = await requireSession();
  if (!currentUser) return;
  if (currentUser.role !== 'admin') {
    window.location.href = '/employee.html';
    return;
  }

  document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  document.getElementById('applyFilter').addEventListener('click', loadTimesheets);
  document.getElementById('applyStats').addEventListener('click', loadStats);
  initializeProjectReports();
  document.getElementById('addEmpBtn').addEventListener('click', addEmployee);
  document.getElementById('addProjBtn').addEventListener('click', addProject);
  document.getElementById('editSaveBtn').addEventListener('click', saveEditedTimesheet);
  document.getElementById('editLockBtn').addEventListener('click', () => lockUnlock('lock'));
  document.getElementById('editUnlockBtn').addEventListener('click', () => lockUnlock('unlock'));
  document.getElementById('editCloseBtn').addEventListener('click', closeEditPanel);

  await loadEmployees();
  await loadProjects();

  const today = new Date();
  const jan1 = `${today.getFullYear()}-01-01`;
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const reportParams = new URLSearchParams(window.location.search);
  document.getElementById('statsFrom').value = Reports.validDate(reportParams.get('from')) ? reportParams.get('from') : jan1;
  document.getElementById('statsTo').value = Reports.validDate(reportParams.get('to')) ? reportParams.get('to') : todayStr;
  if (window.location.hash === '#stats') switchTab('stats');

  await loadTimesheets();
  await loadRequests();
  await loadStats();
}

// ---------------- TIMESHEETS ----------------

async function loadTimesheets() {
  const params = new URLSearchParams();
  const emp = document.getElementById('filterEmployee').value;
  const from = document.getElementById('filterFrom').value;
  const to = document.getElementById('filterTo').value;
  if (emp) params.set('user_id', emp);
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const body = document.getElementById('timesheetsBody');
  let data;
  try {
    data = await Api.get(`/api/admin/timesheets?${params.toString()}`);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="error-msg">Couldn't load timesheets: ${escapeAttr(e.message)}</td></tr>`;
    return;
  }

  body.innerHTML = data.timesheets.map(({ timesheet, summary }) => `
    <tr>
      <td>${escapeAttr(timesheet.employee_name)}</td>
      <td>${fmtDate(timesheet.week_start)}</td>
      <td>${statusBadgeHtml(timesheet)}</td>
      <td>${fmtHours(summary.work_hours)}</td>
      <td>${fmtHours(summary.extra_hours)}</td>
      <td>${fmtHours(summary.sick_leave_days)}</td>
      <td>${fmtHours(summary.local_leave_days)}</td>
      <td><button class="btn small secondary" data-id="${timesheet.id}">Edit</button></td>
    </tr>`).join('');

  body.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => openEditPanel(btn.dataset.id));
  });
}

async function openEditPanel(timesheetId) {
  if (hasUnsavedTimesheetChanges() && !confirm('Discard the unsaved changes in this editor and open another timesheet?')) return;
  const session = ++editingSession;
  const data = await Api.get(`/api/admin/timesheets/${timesheetId}`);
  if (session !== editingSession) return;
  editingTimesheetId = timesheetId;
  editingTimesheetVersion = data.timesheet.version;
  editingDays = data.days;

  document.getElementById('editTitle').textContent =
    `${data.timesheet.employee_name} — Week of ${fmtDate(data.timesheet.week_start)}`;
  document.getElementById('editWeekHeading').textContent = `${data.timesheet.employee_name}'s Timesheet — Week ${weekNumber(data.timesheet.week_start)}`;
  document.getElementById('editPanel').style.display = 'block';
  document.getElementById('editMsg').textContent = '';
  renderEditDays();
  editingSavedSnapshot = JSON.stringify(editingDays);
  document.getElementById('editPanel').scrollIntoView({ behavior: 'smooth' });
}

function hasUnsavedTimesheetChanges() {
  return editingTimesheetId !== null && JSON.stringify(editingDays) !== editingSavedSnapshot;
}

function closeEditPanel() {
  if (hasUnsavedTimesheetChanges() && !confirm('Discard your unsaved changes and close this timesheet editor?')) return false;
  document.getElementById('editPanel').style.display = 'none';
  editingSession++;
  editingTimesheetId = null;
  editingTimesheetVersion = null;
  editingSavedSnapshot = null;
  return true;
}

function renderEditDays() {
  const container = document.getElementById('editDaysContainer');
  container.innerHTML = '';

  editingDays.forEach((day, idx) => {
    const card = document.createElement('div');
    card.className = 'day-card';

    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `<div><span class="day-name">${DAY_NAMES[idx]}</span> <span class="day-date">${fmtDate(day.date)}</span></div>`;

    const typeSelect = document.createElement('select');
    ['work', 'sick_leave', 'local_leave', 'emergency_leave', 'public_holiday'].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = LEAVE_LABELS[t];
      if (day.type === t) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    const includesFrozenProject = day.projects.some((project) => TimesheetPayload.frozenProject(project, allProjects));
    typeSelect.disabled = includesFrozenProject;
    if (includesFrozenProject) typeSelect.title = 'Unarchive this day’s historical projects before changing its type.';
    typeSelect.addEventListener('change', () => {
      day.type = typeSelect.value;
      if (['sick_leave', 'local_leave', 'emergency_leave'].includes(day.type) && ![0.5, 1].includes(Number(day.leave_days))) day.leave_days = 1;
      renderEditDays();
    });
    header.appendChild(typeSelect);
    card.appendChild(header);

    if (day.type === 'work' || isHalfDayLeave(day)) {
      const projWrap = document.createElement('div');
      renderEditProjectRows(projWrap, day);
      card.appendChild(projWrap);

      const addBtn = document.createElement('button');
      addBtn.className = 'btn secondary small';
      addBtn.textContent = '+ Add project';
      addBtn.addEventListener('click', () => {
        const projectId = firstAvailableProjectId(day);
        if (!projectId) { alert('All projects are already listed for this day. You can still use Other.'); return; }
        day.projects.push({ project_id: projectId, hours: 0 });
        renderEditProjectRows(projWrap, day);
      });
      card.appendChild(addBtn);

      const total = dayWorkTotal(day);
      const totalLine = document.createElement('div');
      totalLine.style.marginTop = '8px';
      totalLine.style.fontSize = '13px';
      totalLine.innerHTML = `Total: <strong>${fmtHours(total)}</strong> hrs (required: ${isHalfDayLeave(day) ? 3.5 : STANDARD_WORKDAY_HOURS} hrs)`;
      card.appendChild(totalLine);

      const justWrap = document.createElement('div');
      justWrap.style.marginTop = '6px';
      const minimumHours = isHalfDayLeave(day) ? 3.5 : STANDARD_WORKDAY_HOURS;
      justWrap.innerHTML = `<label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">
        Reason for less than ${minimumHours} hours ${total < minimumHours ? '<span style="color:var(--danger)">(required)</span>' : '(optional)'}
      </label>`;
      const justInput = document.createElement('textarea');
      justInput.rows = 2;
      justInput.style.width = '100%';
      justInput.value = day.justification || '';
      justInput.addEventListener('input', () => { day.justification = justInput.value; });
      justWrap.appendChild(justInput);
      card.appendChild(justWrap);
    }
    if (day.type === 'local_leave' || day.type === 'sick_leave' || day.type === 'emergency_leave') {
      const row = document.createElement('div');
      row.innerHTML = `<label style="font-size:13px;font-weight:600;margin-right:6px">Days off:</label>`;
      const daysInput = document.createElement('input');
      daysInput.type = 'number';
      daysInput.min = '0.5';
      daysInput.max = '1';
      daysInput.step = '0.5';
      daysInput.style.width = '90px';
      daysInput.value = day.leave_days ?? 1;
      daysInput.addEventListener('change', () => { day.leave_days = daysInput.value; renderEditDays(); });
      row.appendChild(daysInput);
      card.appendChild(row);
    } else if (day.type === 'public_holiday') {
      const note = document.createElement('div');
      note.className = 'muted';
      note.style.fontSize = '13px';
      note.textContent = 'Marked as a public holiday — no hours needed.';
      card.appendChild(note);
    }

    container.appendChild(card);
  });
}

function renderEditProjectRows(wrap, day) {
  wrap.innerHTML = '';
  if (day.projects.length === 0) {
    day.projects.push(allProjects[0] ? { project_id: allProjects[0].id, hours: 0 } : { entry_type: 'other', hours: 0, other_description: '' });
  }
  day.projects.forEach((proj, projIdx) => {
    const row = document.createElement('div');
    row.className = 'project-row';
    const frozen = TimesheetPayload.frozenProject(proj, allProjects);

    const select = document.createElement('select');
    select.id = `admin-project-${day.date}-${projIdx}`;
    const otherOption = document.createElement('option');
    otherOption.value = 'other'; otherOption.textContent = 'Other';
    if (proj.entry_type === 'other') otherOption.selected = true;
    select.appendChild(otherOption);
    allProjects.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      opt.disabled = day.projects.some((entry, i) => i !== projIdx && Number(entry.project_id) === p.id);
      if (Number(proj.project_id) === p.id) opt.selected = true;
      select.appendChild(opt);
    });
    if (frozen) {
      const historical = document.createElement('option');
      historical.value = proj.project_id;
      historical.textContent = `${proj.project_name || `Project ${proj.project_id}`} (archived / unavailable)`;
      historical.selected = true;
      select.appendChild(historical);
    }
    select.disabled = frozen;
    select.addEventListener('change', () => {
      if (select.value === 'other') { proj.entry_type = 'other'; proj.project_id = null; }
      else {
        const id = parseInt(select.value, 10);
        if (day.projects.some((p, i) => i !== projIdx && Number(p.project_id) === id)) { alert('This project is already listed for this day.'); renderEditDays(); return; }
        proj.entry_type = 'work'; proj.project_id = id;
      }
      renderEditDays();
    });
    row.appendChild(ProjectPicker.enhance(select, `Project for ${day.date}, row ${projIdx + 1}`));
    if (proj.entry_type === 'other') {
      const description = document.createElement('textarea'); description.rows = 1; description.placeholder = 'Describe what you worked on'; description.value = proj.other_description || '';
      description.addEventListener('input', () => { proj.other_description = description.value; }); row.appendChild(description);
    }

    const hoursInput = document.createElement('input');
    hoursInput.type = 'number';
    hoursInput.min = '0';
    hoursInput.max = '24';
    hoursInput.step = '0.5';
    hoursInput.value = proj.hours ?? '';
    hoursInput.disabled = frozen;
    const invalidHours = TimesheetPayload.hourError(proj.hours);
    hoursInput.setCustomValidity(invalidHours);
    hoursInput.setAttribute('aria-invalid', String(!!invalidHours));
    if (invalidHours) hoursInput.title = invalidHours;
    hoursInput.addEventListener('input', () => { proj.hours = hoursInput.value; });
    hoursInput.addEventListener('blur', () => { renderEditDays(); });
    row.appendChild(hoursInput);

    if (!frozen && day.projects.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn danger small';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => { day.projects.splice(projIdx, 1); renderEditDays(); });
      row.appendChild(removeBtn);
    }

    wrap.appendChild(row);
    if (frozen) {
      const note = document.createElement('p'); note.className = 'info-msg';
      note.textContent = 'Historical project hours are read-only. Unarchive the project before changing or removing these hours.';
      wrap.appendChild(note);
    }
  });
}

async function saveEditedTimesheet() {
  const msg = document.getElementById('editMsg');
  const savedId = editingTimesheetId;
  const session = editingSession;
  try {
    const submittedSnapshot = JSON.stringify(editingDays);
    const data = await Api.put(`/api/admin/timesheets/${savedId}/entries`, {
      days: TimesheetPayload.serializeDays(editingDays), version: TimesheetPayload.version(editingTimesheetVersion)
    });
    if (editingTimesheetId !== savedId || session !== editingSession) return;
    editingTimesheetVersion = data.timesheet.version;
    // Edits typed while the request was in flight must still count as unsaved.
    editingSavedSnapshot = submittedSnapshot;
    msg.textContent = hasUnsavedTimesheetChanges() ? 'The earlier draft was saved. Newer edits are still here and remain unsaved.' : 'Saved.';
    await loadTimesheets();
    await loadStats();
  } catch (error) {
    if (editingTimesheetId === savedId && session === editingSession) msg.textContent = TimesheetPayload.errorMessage(error);
  }
}

async function lockUnlock(action) {
  if (hasUnsavedTimesheetChanges()) {
    document.getElementById('editMsg').textContent = 'Save your changes before locking or unlocking this timesheet. Your unsaved edits are still here.';
    return;
  }
  const targetId = editingTimesheetId;
  const session = editingSession;
  const submittedSnapshot = JSON.stringify(editingDays);
  try {
    const data = await Api.post(`/api/admin/timesheets/${targetId}/${action}`, { version: TimesheetPayload.version(editingTimesheetVersion) });
    if (editingTimesheetId !== targetId || session !== editingSession) return;
    editingTimesheetVersion = data.timesheet.version;
    await loadTimesheets();
    if (editingTimesheetId !== targetId || session !== editingSession) return;
    if (JSON.stringify(editingDays) !== submittedSnapshot || hasUnsavedTimesheetChanges()) {
      document.getElementById('editMsg').textContent = `The saved timesheet was ${action === 'lock' ? 'locked' : 'unlocked'}. Newer edits are still here and remain unsaved; save them explicitly when ready.`;
      return;
    }
    document.getElementById('editPanel').style.display = 'none';
    editingTimesheetId = null;
    editingSavedSnapshot = null;
    editingSession++;
  } catch (error) {
    if (editingTimesheetId === targetId && session === editingSession) document.getElementById('editMsg').textContent = TimesheetPayload.errorMessage(error);
  }
}

// ---------------- UNLOCK REQUESTS ----------------

async function loadRequests() {
  const data = await Api.get('/api/admin/unlock-requests?status=pending');
  document.getElementById('pendingCount').textContent = data.requests.length ? `(${data.requests.length})` : '';
  const body = document.getElementById('requestsBody');
  body.innerHTML = data.requests.map((r) => `
    <tr>
      <td>${escapeAttr(r.employee_name)}</td>
      <td>${fmtDate(r.week_start)}</td>
      <td>${r.reason ? escapeAttr(r.reason) : '<span class="muted">—</span>'}</td>
      <td>${new Date(r.created_at).toLocaleString()}</td>
      <td>
        <button class="btn small secondary" data-approve="${r.id}">Approve</button>
        <button class="btn small danger" data-deny="${r.id}">Deny</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No pending requests.</td></tr>';

  body.querySelectorAll('button[data-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await Api.post(`/api/admin/unlock-requests/${btn.dataset.approve}/approve`);
      await loadRequests();
      await loadTimesheets();
    });
  });
  body.querySelectorAll('button[data-deny]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await Api.post(`/api/admin/unlock-requests/${btn.dataset.deny}/deny`);
      await loadRequests();
    });
  });
}

// ---------------- STATS ----------------

let reportCatalog = [];
let reportRange = null;
let statsLoadVersion = 0;
const comparedProjects = new Set();

function initializeProjectReports() {
  for (const id of ['projectSearch', 'projectStatus', 'projectSort']) {
    document.getElementById(id).addEventListener(id === 'projectSearch' ? 'input' : 'change', renderProjectDirectory);
  }
  document.getElementById('clearComparison').addEventListener('click', () => { comparedProjects.clear(); renderProjectDirectory(); });
  document.getElementById('compareProjects').addEventListener('click', () => {
    if (comparedProjects.size !== 2 || !reportRange) return;
    const [first, second] = [...comparedProjects];
    window.location.href = Reports.projectUrl(first, reportRange.from, reportRange.to, second);
  });
}

async function loadStats() {
  const from = document.getElementById('statsFrom').value;
  const to = document.getElementById('statsTo').value;
  const error = document.getElementById('statsError');
  const version = ++statsLoadVersion;
  try { Reports.validateRange(from, to); } catch (e) { error.textContent = e.message; return; }
  error.textContent = '';
  const params = new URLSearchParams({ from, to });
  let data, projects;
  try {
    [data, projects] = await Promise.all([
      Api.get(`/api/admin/stats?${params}`),
      Api.get('/api/projects?all=1')
    ]);
  } catch (e) {
    if (version === statsLoadVersion) error.textContent = `Couldn't update reports: ${e.message} Previous results, if any, remain visible.`;
    return;
  }
  if (version !== statsLoadVersion) return;
  reportRange = { from, to };
  reportCatalog = Reports.catalog(projects.projects, data.by_project);
  for (const id of comparedProjects) if (!reportCatalog.some((p) => p.id === id)) comparedProjects.delete(id);
  renderProjectDirectory();
  document.getElementById('reportRangeLabel').textContent = `${Reports.formatDate(from)} – ${Reports.formatDate(to)}`;
  const c = data.company_totals;
  document.getElementById('companyStats').innerHTML = [
    ['Work hours', c.work_hours], ['Extra hours', c.extra_hours], ['Sick leave (days)', c.sick_leave_days],
    ['Local leave (days)', c.local_leave_days], ['Emergency leave (days)', c.emergency_leave_days]
  ].map(([label, value]) => `<div class="stat"><div class="value">${fmtHours(value)}</div><div class="label">${label}</div></div>`).join('');
  document.getElementById('statsByEmployee').innerHTML = data.by_employee.map((r) => `
    <tr><td><strong>${Reports.escape(r.employee_name)}</strong></td><td>${fmtHours(r.work_hours)}</td>
      <td>${fmtHours(r.extra_hours)}</td><td>${fmtHours(r.sick_leave_days)}</td><td>${fmtHours(r.local_leave_days)}</td><td>${fmtHours(r.emergency_leave_days)}</td></tr>
  `).join('') || '<tr><td colspan="6" class="muted">No employee hours in this range.</td></tr>';
  document.getElementById('exportBtn').href = `/api/admin/export.xlsx?${params}`;
}

function renderProjectDirectory() {
  if (!reportRange) return;
  const rows = Reports.filterProjects(reportCatalog, {
    search: document.getElementById('projectSearch').value,
    status: document.getElementById('projectStatus').value,
    sort: document.getElementById('projectSort').value
  });
  const body = document.getElementById('statsByProject');
  body.innerHTML = rows.map((p) => {
    const url = Reports.escape(Reports.projectUrl(p.id, reportRange.from, reportRange.to));
    return `<tr>
      <td><input type="checkbox" data-compare-id="${p.id}" aria-label="Compare ${Reports.escape(p.name)}" ${comparedProjects.has(p.id) ? 'checked' : ''} ${comparedProjects.size === 2 && !comparedProjects.has(p.id) ? 'disabled' : ''}></td>
      <td><a class="project-name-link" href="${url}">${Reports.escape(p.name)}</a></td>
      <td><span class="badge ${p.archived ? 'locked' : 'open'}">${p.id === 0 ? 'Other work' : p.archived ? 'Archived' : 'Active'}</span></td>
      <td class="date-cell">${Reports.formatDate(p.created_at)}</td><td class="numeric project-hours">${Reports.hours(p.hours)} <span>hrs</span></td>
      <td><a class="btn secondary small" href="${url}" aria-label="View ${Reports.escape(p.name)}">View project &rarr;</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-state">No projects match these filters. Try a different name or status.</td></tr>';
  body.querySelectorAll('[data-compare-id]').forEach((input) => input.addEventListener('change', () => {
    const id = Number(input.dataset.compareId);
    if (input.checked && comparedProjects.size < 2) comparedProjects.add(id);
    else comparedProjects.delete(id);
    const names = [...comparedProjects].map((value) => reportCatalog.find((p) => p.id === value)?.name).filter(Boolean);
    document.getElementById('compareSelection').textContent = names.length ? `${names.length}/2 selected: ${names.join(' + ')}` : 'Select two projects to compare.';
    document.getElementById('compareProjects').disabled = comparedProjects.size !== 2;
    document.getElementById('clearComparison').disabled = comparedProjects.size === 0;
    body.querySelectorAll('[data-compare-id]').forEach((checkbox) => { checkbox.disabled = comparedProjects.size === 2 && !comparedProjects.has(Number(checkbox.dataset.compareId)); });
  }));
  document.getElementById('projectCount').textContent = `${rows.length} of ${reportCatalog.length} projects`;
  const selected = [...comparedProjects].map((id) => reportCatalog.find((p) => p.id === id)?.name).filter(Boolean);
  document.getElementById('compareSelection').textContent = selected.length ? `${selected.length}/2 selected: ${selected.join(' + ')}` : 'Select two projects to compare.';
  document.getElementById('compareProjects').disabled = comparedProjects.size !== 2;
  document.getElementById('clearComparison').disabled = comparedProjects.size === 0;
}

// ---------------- EMPLOYEES ----------------

let editingEmployeeId = null;

function renderEmployeesTable() {
  const body = document.getElementById('employeesBody');
  body.innerHTML = allEmployees.map((e) => {
    if (editingEmployeeId === e.id) {
      return `
        <tr>
          <td><input type="text" id="editEmpName" value="${escapeAttr(e.name)}" style="width:100%"></td>
          <td><input type="email" id="editEmpEmail" value="${escapeAttr(e.email)}" style="width:100%"></td>
          <td>${e.role}</td>
          <td>${e.active ? '<span class="badge open">Active</span>' : '<span class="badge locked">Inactive</span>'}</td>
          <td>
            <button class="btn small" data-save-emp="${e.id}">Save</button>
            <button class="btn small secondary" data-cancel-emp="${e.id}">Cancel</button>
          </td>
        </tr>`;
    }
    return `
      <tr>
        <td>${escapeAttr(e.name)}</td>
        <td>${escapeAttr(e.email)}</td>
        <td>${e.role}</td>
        <td>${e.active ? '<span class="badge open">Active</span>' : '<span class="badge locked">Inactive</span>'}</td>
        <td>
          <button class="btn small secondary" data-edit-emp="${e.id}">Edit</button>
          <button class="btn small secondary" data-reset="${e.id}">Reset Password</button>
          ${e.active
            ? `<button class="btn small danger" data-deactivate="${e.id}">Deactivate</button>`
            : `<button class="btn small secondary" data-reactivate="${e.id}">Reactivate</button>`}
        </td>
      </tr>`;
  }).join('');

  body.querySelectorAll('button[data-edit-emp]').forEach((btn) => {
    btn.addEventListener('click', () => { editingEmployeeId = parseInt(btn.dataset.editEmp, 10); renderEmployeesTable(); });
  });
  body.querySelectorAll('button[data-cancel-emp]').forEach((btn) => {
    btn.addEventListener('click', () => { editingEmployeeId = null; renderEmployeesTable(); });
  });
  body.querySelectorAll('button[data-save-emp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = document.getElementById('editEmpName').value.trim();
      const email = document.getElementById('editEmpEmail').value.trim();
      if (!name || !email) { alert('Name and email are required.'); return; }
      try {
        await Api.patch(`/api/employees/${btn.dataset.saveEmp}`, { name, email });
        editingEmployeeId = null;
        await loadEmployees();
      } catch (e) {
        alert(e.message);
      }
    });
  });
  body.querySelectorAll('button[data-deactivate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Deactivate this employee? They will no longer be able to log in.')) return;
      await Api.patch(`/api/employees/${btn.dataset.deactivate}/deactivate`);
      await loadEmployees();
    });
  });
  body.querySelectorAll('button[data-reactivate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await Api.patch(`/api/employees/${btn.dataset.reactivate}/reactivate`);
      await loadEmployees();
    });
  });
  body.querySelectorAll('button[data-reset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const data = await Api.post(`/api/employees/${btn.dataset.reset}/reset-password`);
      alert(data.message);
    });
  });

}

async function loadEmployees() {
  const data = await Api.get('/api/employees');
  allEmployees = data.employees;

  const select = document.getElementById('filterEmployee');
  select.innerHTML = '<option value="">All employees</option>' +
    allEmployees.map((e) => `<option value="${e.id}">${escapeAttr(e.name)}</option>`).join('');

  renderEmployeesTable();
}

async function addEmployee() {
  const name = document.getElementById('newEmpName').value.trim();
  const email = document.getElementById('newEmpEmail').value.trim();
  const role = document.getElementById('newEmpRole').value;
  const msg = document.getElementById('newEmpMsg');
  if (!name || !email) { msg.textContent = 'Name and email are required.'; return; }
  try {
    const data = await Api.post('/api/employees', { name, email, role });
    msg.textContent = data.message;
    document.getElementById('newEmpName').value = '';
    document.getElementById('newEmpEmail').value = '';
    await loadEmployees();
  } catch (e) {
    msg.textContent = e.message;
  }
}

// ---------------- PROJECTS ----------------

let editingProjectId = null;

function renderProjectsTable(allProjectsIncludingArchived) {
  const body = document.getElementById('projectsBody');
  body.innerHTML = allProjectsIncludingArchived.map((p) => {
    if (editingProjectId === p.id) {
      return `
        <tr>
          <td><input type="text" id="editProjName" value="${escapeAttr(p.name)}" style="width:100%"></td>
          <td>${p.archived ? '<span class="badge locked">Archived</span>' : '<span class="badge open">Active</span>'}</td>
          <td>
            <button class="btn small" data-save-proj="${p.id}">Save</button>
            <button class="btn small secondary" data-cancel-proj="${p.id}">Cancel</button>
          </td>
        </tr>`;
    }
    return `
      <tr>
        <td>${escapeAttr(p.name)}</td>
        <td>${p.archived ? '<span class="badge locked">Archived</span>' : '<span class="badge open">Active</span>'}</td>
        <td>
          <button class="btn small secondary" data-edit-proj="${p.id}">Edit</button>
          ${p.archived
            ? `<button class="btn small secondary" data-unarchive="${p.id}">Unarchive</button>`
            : `<button class="btn small danger" data-archive="${p.id}">Archive</button>`}
        </td>
      </tr>`;
  }).join('');

  body.querySelectorAll('button[data-edit-proj]').forEach((btn) => {
    btn.addEventListener('click', () => { editingProjectId = parseInt(btn.dataset.editProj, 10); loadProjects(); });
  });
  body.querySelectorAll('button[data-cancel-proj]').forEach((btn) => {
    btn.addEventListener('click', () => { editingProjectId = null; loadProjects(); });
  });
  body.querySelectorAll('button[data-save-proj]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = document.getElementById('editProjName').value.trim();
      if (!name) { alert('Project name is required.'); return; }
      try {
        await Api.patch(`/api/projects/${btn.dataset.saveProj}`, { name });
        editingProjectId = null;
        await loadProjects();
      } catch (e) {
        alert(e.message);
      }
    });
  });
  body.querySelectorAll('button[data-archive]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await Api.patch(`/api/projects/${btn.dataset.archive}/archive`);
      await loadProjects();
    });
  });
  body.querySelectorAll('button[data-unarchive]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await Api.patch(`/api/projects/${btn.dataset.unarchive}/unarchive`);
      await loadProjects();
    });
  });

}

async function loadProjects() {
  const data = await Api.get('/api/projects?all=1');
  allProjects = data.projects.filter((p) => !p.archived);
  renderProjectsTable(data.projects);
}

async function addProject() {
  const name = document.getElementById('newProjName').value.trim();
  const msg = document.getElementById('newProjMsg');
  if (!name) { msg.textContent = 'Project name is required.'; return; }
  try {
    await Api.post('/api/projects', { name });
    document.getElementById('newProjName').value = '';
    msg.textContent = 'Added.';
    await loadProjects();
  } catch (e) {
    msg.textContent = e.message;
  }
}

init();
