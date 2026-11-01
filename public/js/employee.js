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
let projects = [];
let currentWeekStart = null; // YYYY-MM-DD, set from server response
let currentTimesheet = null;
let currentDays = [];
let editable = true;
let saveInProgress = false;
let saveMessageTimer = null;
let weekLoadVersion = 0;
let savedDaysSnapshot = null;

function hasUnsavedTimesheetChanges() {
  return currentTimesheet !== null && savedDaysSnapshot !== null && JSON.stringify(currentDays) !== savedDaysSnapshot;
}

function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);

  return formatLocalDate(d);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);

  return formatLocalDate(d);
}

function todayStr() {
    return formatLocalDate(new Date());
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function dayWorkTotal(day) {
  return (day.projects || []).reduce((sum, p) => sum + (Number(p.hours) || 0), 0);
}
function isHalfDayLeave(day) {
  return ['sick_leave', 'local_leave', 'emergency_leave'].includes(day.type) && Number(day.leave_days) === 0.5;
}
function requiredHours(day) { return isHalfDayLeave(day) ? 3.5 : STANDARD_WORKDAY_HOURS; }

function dayCardClass(day) {
  switch (day.type) {
    case 'sick_leave':
      return 'day-sick';

    case 'local_leave':
      return 'day-local';

    case 'emergency_leave':
      return 'day-emergency';

    case 'public_holiday':
      return 'day-public-holiday';

    default:
      return 'day-work';
  }
}

function dayTypeClass(type) {
  switch (type) {
    case 'sick_leave':
      return 'sick';

    case 'local_leave':
      return 'local';

    case 'emergency_leave':
      return 'emergency';

    case 'public_holiday':
      return 'public-holiday';

    default:
      return 'work';
  }
}

function renderHoursProgress(day) {
  const total = dayWorkTotal(day);
  const required = requiredHours(day);

  if (day.type !== 'work' && !isHalfDayLeave(day)) {
    return '';
  }

  /*
   * Allow the bar to reach 100% at the required amount.
   * If the employee works more than required, the bar remains full
   * and we display the extra hours separately.
   */
  const percentage = required > 0
    ? Math.min((total / required) * 100, 100)
    : 0;

  let barClass = 'progress-bar';
  let messageClass = 'hours-progress-message';
  let message = '';

  if (total >= required) {
    barClass += ' complete';
    messageClass += ' complete';
    message = '✓ Minimum hours completed';
  } else {
    const remaining = required - total;
    message = `${fmtHours(remaining)} hrs remaining`;
  }

  return `
    <div class="hours-progress">
      <div class="hours-progress-header">
        <span class="hours-progress-value">
                  ${fmtHours(total)} / ${fmtHours(required)} hrs
                </span>
        <span class="hours-progress-required">
          ${Math.round(percentage)}%
        </span>
      </div>

      <div class="progress-track">
        <div
          class="${barClass}"
          style="width:${percentage}%"
        ></div>
      </div>

      <div class="${messageClass}">
        ${message}
      </div>
    </div>
  `;
}

function weekNumber(weekStart) {
  const year = Number(weekStart.slice(0, 4));
  const jan7 = new Date(`${year}-01-07T00:00:00`);
  const firstMonday = new Date(jan7);
  firstMonday.setDate(jan7.getDate() - ((jan7.getDay() + 6) % 7));
  return Math.floor((new Date(`${weekStart}T00:00:00`) - firstMonday) / 604800000) + 1;
}
function firstAvailableProjectId(day) {
  const used = new Set((day.projects || []).map((p) => Number(p.project_id)));
  const project = projects.find((p) => !used.has(p.id));
  return project ? project.id : null;
}
function statusBadgeHtml(weekStart, editableFlag) {
  const thisWeek = mondayOf(todayStr());
  if (weekStart > thisWeek) return '<span class="badge pending">Upcoming</span>';
  if (editableFlag) return '<span class="badge open">Open</span>';
  if (weekStart < thisWeek) return '<span class="badge locked">Closed</span>';
  return '<span class="badge locked">Locked</span>';
}

async function init() {
  currentUser = await requireSession();
  if (!currentUser) return;
  if (currentUser.role === 'admin') {
    document.getElementById('adminLink').style.display = 'inline';
  }
  document.getElementById('adminLink').addEventListener('click', () => window.location.href = '/admin.html');
  document.getElementById('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });
  document.getElementById('prevWeek').addEventListener('click', () => shiftWeek(-7));
  document.getElementById('nextWeek').addEventListener('click', () => shiftWeek(7));
  document.getElementById('weekPicker').addEventListener('change', (e) => {
    if (e.target.value) loadWeek(mondayOf(e.target.value));
  });
  document.getElementById('thisWeekBtn').addEventListener('click', () => loadWeek(mondayOf(todayStr())));
  document.getElementById('saveBtn').addEventListener('click', saveDraft);
  document.getElementById('submitBtn').addEventListener('click', submitTimesheet);
  document.getElementById('requestUnlockBtn').addEventListener('click', requestUnlock);

  const projRes = await Api.get('/api/projects');
  projects = projRes.projects;

  await loadWeek(mondayOf(todayStr()));
  await loadHistory();
}

async function shiftWeek(n) {
  await loadWeek(addDays(currentWeekStart, n));
}

async function loadWeek(weekStart) {
  if (hasUnsavedTimesheetChanges() && !confirm('This timesheet has unsaved edits. Discard them and load the selected week?')) return;
  const loadVersion = ++weekLoadVersion;
  const data = await Api.get(`/api/timesheets/mine?week=${weekStart}`);
  if (loadVersion !== weekLoadVersion) return;
  clearTimeout(saveMessageTimer);
  currentWeekStart = data.timesheet.week_start;
  currentTimesheet = data.timesheet;
  currentDays = data.days;
  editable = data.editable;
  document.getElementById('saveMsg').textContent = '';

  document.getElementById('weekLabel').textContent =
    `Week of ${fmtDate(currentWeekStart)} – ${fmtDate(addDays(currentWeekStart, 4))}`;
  document.getElementById('timesheetHeading').textContent =
    `${currentUser.name}'s Timesheet — Week ${weekNumber(currentWeekStart)}`;
  document.getElementById('weekPicker').value = currentWeekStart;

  const thisWeek = mondayOf(todayStr());
  const isFuture = currentWeekStart > thisWeek;
  const isPast = currentWeekStart < thisWeek;
  const badge = document.getElementById('statusBadge');
  badge.innerHTML = statusBadgeHtml(currentWeekStart, editable);

  const lockedNotice = document.getElementById('lockedNotice');
  const unlockArea = document.getElementById('unlockRequestArea');
  if (isFuture) {
    lockedNotice.style.display = 'block';
    lockedNotice.textContent = "This week hasn't started yet, so it can't be filled in until it does.";
    unlockArea.style.display = 'none';
  } else if (!editable) {
    lockedNotice.style.display = 'block';
    lockedNotice.textContent = isPast
      ? 'This is a past week and is locked. If you need to make a change, request an unlock from your admin below.'
      : 'This timesheet is locked. If you need to make a change, request an unlock from your admin below.';
    unlockArea.style.display = 'block';
  } else {
    lockedNotice.style.display = 'none';
    unlockArea.style.display = 'none';
  }

  document.getElementById('saveBtn').disabled = !editable;
  document.getElementById('submitBtn').disabled = !editable;

  renderDays();
  savedDaysSnapshot = JSON.stringify(currentDays);
  renderSummary(data.summary);
}

function renderDays() {
  const container = document.getElementById('daysContainer');
  container.innerHTML = '';

  currentDays.forEach((day, idx) => {
    const card = document.createElement('div');
    card.className = `day-card ${dayCardClass(day)}`;

    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `
      <div>
        <time class="day-date" datetime="${day.date}">${fmtDate(day.date)}</time>
        <span class="day-name">${DAY_NAMES[idx]}</span>
      </div>
    `;

    const typeSelect = document.createElement('select');
    typeSelect.className = 'day-type-select';
    typeSelect.setAttribute('aria-label', `Day type for ${DAY_NAMES[idx]}, ${fmtDate(day.date)}`);
    ['work', 'sick_leave', 'local_leave', 'emergency_leave', 'public_holiday'].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = LEAVE_LABELS[t];
      if (day.type === t) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    const includesFrozenProject = day.projects.some((project) => TimesheetPayload.frozenProject(project, projects));
    typeSelect.disabled = !editable || includesFrozenProject;
    if (includesFrozenProject) typeSelect.title = 'Unarchive this day’s historical projects before changing its type.';
    typeSelect.addEventListener('change', () => {
      day.type = typeSelect.value;
      if (['sick_leave', 'local_leave', 'emergency_leave'].includes(day.type) && ![0.5, 1].includes(Number(day.leave_days))) day.leave_days = 1;
      renderDays();
    });
    header.appendChild(typeSelect);
    card.appendChild(header);

    if (day.type === 'local_leave' || day.type === 'sick_leave' || day.type === 'emergency_leave') {
          const row = document.createElement('div');
          row.innerHTML = `<label style="font-size:13px;font-weight:600;margin-right:6px">Leave (Day):</label>`;
          const daysInput = document.createElement('input');
          daysInput.type = 'number';
          daysInput.min = '0.5';
          daysInput.max = '1';
          daysInput.step = '0.5';
          daysInput.style.width = '90px';
          daysInput.value = day.leave_days ?? 1;
          daysInput.disabled = !editable;
          daysInput.addEventListener('change', () => { day.leave_days = daysInput.value; renderDays(); });
          row.appendChild(daysInput);
          card.appendChild(row);
        } else if (day.type === 'public_holiday') {
          const note = document.createElement('div');
          note.className = 'muted';
          note.style.fontSize = '13px';
          note.textContent = 'Marked as a public holiday — no hours needed.';
          card.appendChild(note);
        }

    if (day.type === 'work' || isHalfDayLeave(day)) {
      const projectsWrap = document.createElement('div');
      projectsWrap.id = `projects-${idx}`;
      renderProjectRows(projectsWrap, day, idx);
      card.appendChild(projectsWrap);

      if (editable) {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn secondary small';
        addBtn.textContent = '+ Add project';
        addBtn.addEventListener('click', () => {
          const projectId = firstAvailableProjectId(day);
          if (!projectId) { alert('All projects are already listed for this day. You can still use Other.'); return; }
          day.projects.push({ project_id: projectId, hours: 0 });
          renderProjectRows(projectsWrap, day, idx);
        });
        card.appendChild(addBtn);
      }

      const total = dayWorkTotal(day);

      const progressWrap = document.createElement('div');
      progressWrap.innerHTML = renderHoursProgress(day);
      card.appendChild(progressWrap);

      if (total < requiredHours(day)) {
        const justWrap = document.createElement('div');
        justWrap.style.marginTop = '6px';
        justWrap.innerHTML = `<label style="font-size:13px;font-weight:600;display:block;margin-bottom:4px">
          Reason for less than minimum hours <span style="color:var(--danger)">(required)</span>
        </label>`;
        const justInput = document.createElement('textarea');
        justInput.rows = 2;
        justInput.style.width = '100%';
        justInput.disabled = !editable;
        justInput.value = day.justification || '';
        justInput.addEventListener('input', () => { day.justification = justInput.value; });
        justWrap.appendChild(justInput);
        card.appendChild(justWrap);
      }
    }


    container.appendChild(card);
  });
}

function renderProjectRows(wrap, day, dayIdx) {
  wrap.innerHTML = '';
  if (day.projects.length === 0) {
    day.projects.push(projects[0] ? { project_id: projects[0].id, hours: 0 } : { entry_type: 'other', hours: 0, other_description: '' });
  }
  day.projects.forEach((proj, projIdx) => {
    const row = document.createElement('div');
    row.className = 'project-row';
    const frozen = TimesheetPayload.frozenProject(proj, projects);

    const select = document.createElement('select');
    select.id = `employee-project-${dayIdx}-${projIdx}`;
    const otherOption = document.createElement('option');
    otherOption.value = 'other'; otherOption.textContent = 'Other';
    if (proj.entry_type === 'other') otherOption.selected = true;
    select.appendChild(otherOption);
    projects.forEach((p) => {
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
    select.disabled = !editable || frozen;
    select.addEventListener('change', () => {
      if (select.value === 'other') { proj.entry_type = 'other'; proj.project_id = null; }
      else {
        const projectId = parseInt(select.value, 10);
        if (day.projects.some((p, i) => i !== projIdx && Number(p.project_id) === projectId)) {
          alert('This project is already listed for this day.'); renderProjectRows(wrap, day, dayIdx); return;
        }
        proj.entry_type = 'work'; proj.project_id = projectId;
      }
      renderProjectRows(wrap, day, dayIdx);
    });
    row.appendChild(ProjectPicker.enhance(select, `Project for ${DAY_NAMES[dayIdx]}, row ${projIdx + 1}`));

    if (proj.entry_type === 'other') {
      const description = document.createElement('textarea');
      description.rows = 1; description.placeholder = 'Describe what you worked on';
      description.value = proj.other_description || ''; description.disabled = !editable;
      description.addEventListener('input', () => { proj.other_description = description.value; });
      row.appendChild(description);
    }

    const hoursInput = document.createElement('input');
    hoursInput.type = 'number';
    hoursInput.min = '0';
    hoursInput.max = '24';
    hoursInput.step = '0.5';
    hoursInput.value = proj.hours ?? '';
    hoursInput.disabled = !editable || frozen;
    const invalidHours = TimesheetPayload.hourError(proj.hours);
    hoursInput.setCustomValidity(invalidHours);
    hoursInput.setAttribute('aria-invalid', String(!!invalidHours));
    if (invalidHours) hoursInput.title = invalidHours;
    hoursInput.addEventListener('input', () => { proj.hours = hoursInput.value; });
    hoursInput.addEventListener('blur', () => { renderDays(); });
    row.appendChild(hoursInput);

    if (editable && !frozen && day.projects.length > 1) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn danger small';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        day.projects.splice(projIdx, 1);
        renderDays();
      });
      row.appendChild(removeBtn);
    }

    wrap.appendChild(row);
    if (frozen) {
      const note = document.createElement('p'); note.className = 'info-msg';
      note.textContent = 'Historical project hours are read-only. An admin must unarchive the project before these hours can change.';
      wrap.appendChild(note);
    }
  });
}

function renderSummary(summary) {
  const grid = document.getElementById('summaryGrid');
  const items = [
    ['Work Hours', summary.work_hours],
    ['Off Hours (this week)', summary.extra_hours],
    ['Sick Leave (days)', summary.sick_leave_days],
    ['Local Leave (days)', summary.local_leave_days],
    ['Emergency Leave (days)', summary.emergency_leave_days],
    ['Public Holiday (days)', summary.public_holiday_days]
  ];
  grid.innerHTML = items.map(([label, val]) => `
    <div class="stat">
      <div class="value">${fmtHours(val)}</div>
      <div class="label">${label}</div>
    </div>`).join('');
}

async function saveDraft() {
  if (saveInProgress) return false;
  const msg = document.getElementById('saveMsg');
  const savedId = currentTimesheet?.id;
  const loadVersion = weekLoadVersion;
  const submittedSnapshot = JSON.stringify(currentDays);
  clearTimeout(saveMessageTimer);
  try {
    const days = TimesheetPayload.serializeDays(currentDays);
    const version = TimesheetPayload.version(currentTimesheet.version);
    saveInProgress = true;
    document.getElementById('saveBtn').disabled = true;
    document.getElementById('submitBtn').disabled = true;
    msg.textContent = 'Saving...';
    const data = await Api.put(`/api/timesheets/${savedId}/entries`, { days, version });
    if (currentTimesheet.id !== savedId || loadVersion !== weekLoadVersion) return false;
    TimesheetPayload.version(data.timesheet?.version);
    currentTimesheet = data.timesheet;
    savedDaysSnapshot = submittedSnapshot;
    renderSummary(data.summary);
    if (JSON.stringify(currentDays) !== submittedSnapshot) {
      msg.textContent = 'The earlier draft was saved. Newer edits are still on this page and have not been saved. Review and save them before submitting.';
      return false;
    }
    msg.textContent = 'Saved.';
    saveMessageTimer = setTimeout(() => { if (msg.textContent === 'Saved.') msg.textContent = ''; }, 2000);
    return true;
  } catch (error) {
    if (currentTimesheet?.id === savedId && loadVersion === weekLoadVersion) msg.textContent = TimesheetPayload.errorMessage(error);
    return false;
  } finally {
    saveInProgress = false;
    document.getElementById('saveBtn').disabled = !editable;
    document.getElementById('submitBtn').disabled = !editable;
  }
}

async function submitTimesheet() {
  if (!confirm('Submit this timesheet for the week? It will be locked and you will need admin approval to change it after this.')) return;
  const submittedId = currentTimesheet.id;
  const submittedWeek = currentWeekStart;
  const loadVersion = weekLoadVersion;
  const ok = await saveDraft();
  if (!ok || currentTimesheet.id !== submittedId || loadVersion !== weekLoadVersion) return;
  const submittedSnapshot = JSON.stringify(currentDays);
  document.getElementById('saveBtn').disabled = true;
  document.getElementById('submitBtn').disabled = true;
  document.querySelectorAll('#daysContainer input, #daysContainer select, #daysContainer textarea, #daysContainer button').forEach((control) => { control.disabled = true; });
  try {
    const data = await Api.post(`/api/timesheets/${submittedId}/submit`, { version: TimesheetPayload.version(currentTimesheet.version) });
    if (currentTimesheet.id !== submittedId || loadVersion !== weekLoadVersion) return;
    currentTimesheet = data.timesheet;
    if (JSON.stringify(currentDays) !== submittedSnapshot) {
      // Never replace a newer editing model with the earlier submitted snapshot.
      editable = false;
      renderDays();
      document.getElementById('statusBadge').innerHTML = statusBadgeHtml(submittedWeek, false);
      document.getElementById('lockedNotice').style.display = 'block';
      document.getElementById('lockedNotice').textContent = 'The saved draft was submitted. Newer unsaved edits remain shown below; request an unlock before saving those edits.';
      document.getElementById('unlockRequestArea').style.display = 'block';
      document.getElementById('saveMsg').textContent = 'The earlier saved draft was submitted. Newer edits are still here and were not submitted.';
      await loadHistory();
      return;
    }
    await loadWeek(submittedWeek);
    await loadHistory();
  } catch (error) {
    if (currentTimesheet?.id === submittedId && loadVersion === weekLoadVersion) {
      renderDays();
      document.getElementById('saveBtn').disabled = !editable;
      document.getElementById('submitBtn').disabled = !editable;
      document.getElementById('saveMsg').textContent = TimesheetPayload.errorMessage(error);
    }
  }
}

async function requestUnlock() {
  const reason = document.getElementById('unlockReason').value.trim();
  const msgEl = document.getElementById('unlockMsg');
  try {
    const data = await Api.post(`/api/timesheets/${currentTimesheet.id}/request-unlock`, { reason, version: TimesheetPayload.version(currentTimesheet.version) });
    if (data.timesheet) currentTimesheet = data.timesheet;
    msgEl.textContent = 'Unlock request sent to admin.';
    msgEl.className = 'success-msg';
  } catch (e) {
    msgEl.textContent = TimesheetPayload.errorMessage(e);
    msgEl.className = 'error-msg';
  }
}

async function loadHistory() {
  const data = await Api.get('/api/timesheets/mine/history');
  const body = document.getElementById('historyBody');
  body.innerHTML = data.timesheets.map(({ timesheet, summary, editable }) => `
    <tr>
      <td>${fmtDate(timesheet.week_start)}</td>
      <td>${statusBadgeHtml(timesheet.week_start, editable)}</td>
      <td>${fmtHours(summary.work_hours)}</td>
      <td>${fmtHours(summary.extra_hours)}</td>
      <td>${fmtHours(summary.sick_leave_days)}</td>
      <td>${fmtHours(summary.local_leave_days)}</td>
      <td>${fmtHours(summary.emergency_leave_days)}</td>
      <td>${fmtHours(summary.public_holiday_days)}</td>
    </tr>`).join('');
}

init();
