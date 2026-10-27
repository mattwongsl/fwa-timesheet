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

function roundHalfHour(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 2) / 2 : 0;
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
  const data = await Api.get(`/api/timesheets/mine?week=${weekStart}`);
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
        <span class="day-name">${DAY_NAMES[idx]}</span>
        <span class="day-date">${fmtDate(day.date)}</span>
        <span class="day-type-label ${dayTypeClass(day.type)}">
          ${LEAVE_LABELS[day.type]}
        </span>
      </div>
    `;

    const typeSelect = document.createElement('select');
    ['work', 'sick_leave', 'local_leave', 'emergency_leave', 'public_holiday'].forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = LEAVE_LABELS[t];
      if (day.type === t) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.disabled = !editable;
    typeSelect.addEventListener('change', () => {
      day.type = typeSelect.value;
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
          daysInput.value = day.leave_days || 1;
          daysInput.disabled = !editable;
          daysInput.addEventListener('change', () => { day.leave_days = roundHalfHour(daysInput.value); renderDays(); });
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
    day.projects.push({ project_id: projects[0] ? projects[0].id : null, hours: 0 });
  }
  day.projects.forEach((proj, projIdx) => {
    const row = document.createElement('div');
    row.className = 'project-row';

    const select = document.createElement('select');
    const otherOption = document.createElement('option');
    otherOption.value = 'other'; otherOption.textContent = 'Other';
    if (proj.entry_type === 'other') otherOption.selected = true;
    select.appendChild(otherOption);
    projects.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (Number(proj.project_id) === p.id) opt.selected = true;
      select.appendChild(opt);
    });
    select.disabled = !editable;
    select.addEventListener('change', () => {
      if (select.value === 'other') { proj.entry_type = 'other'; proj.project_id = null; }
      else {
        const projectId = parseInt(select.value, 10);
        if (day.projects.some((p, i) => i !== projIdx && Number(p.project_id) === projectId)) {
          alert('This project is already listed for this day.'); renderProjectRows(wrap, day, dayIdx); return;
        }
        proj.entry_type = 'work'; proj.project_id = projectId;
      }
    });
    row.appendChild(select);

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
    hoursInput.value = fmtHours(proj.hours);
    hoursInput.disabled = !editable;
    hoursInput.addEventListener('input', () => { proj.hours = hoursInput.value; });
    hoursInput.addEventListener('blur', () => { proj.hours = roundHalfHour(hoursInput.value); renderDays(); });
    row.appendChild(hoursInput);

    if (editable && day.projects.length > 1) {
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

function validateBeforeSave() {
  for (let i = 0; i < currentDays.length; i++) {
    const day = currentDays[i];
    if (day.type === 'work' || isHalfDayLeave(day)) {
      const total = dayWorkTotal(day);
      if (
        isHalfDayLeave(day) && total < 3.5 && (!day.justification || !day.justification.trim())
      ) {
        return `Please add a reason for ${DAY_NAMES[i]} because ${fmtHours(total)} hrs is below the 3.5-hour half-day minimum.`;
      }
      for (const p of day.projects || []) if (p.entry_type === 'other' && Number(p.hours) > 0 && !(p.other_description || '').trim()) return `Please describe the Other work on ${DAY_NAMES[i]}.`;
      if (!isHalfDayLeave(day) && total < STANDARD_WORKDAY_HOURS && (!day.justification || !day.justification.trim())) {
        return `Please add a reason for ${DAY_NAMES[i]} (${fmtHours(total)} hrs is under the ${STANDARD_WORKDAY_HOURS}-hour minimum).`;
      }
    }
  }
  return null;
}

async function saveDraft() {
  const msg = document.getElementById('saveMsg');
  const validationError = validateBeforeSave();
  if (validationError) {
    msg.textContent = validationError;
    return false;
  }
  msg.textContent = 'Saving...';
  try {
    const data = await Api.put(`/api/timesheets/${currentTimesheet.id}/entries`, { days: currentDays });
    renderSummary(data.summary);
    msg.textContent = 'Saved.';
    setTimeout(() => { msg.textContent = ''; }, 2000);
    return true;
  } catch (e) {
    msg.textContent = e.message;
    return false;
  }
}

async function submitTimesheet() {
  if (!confirm('Submit this timesheet for the week? It will be locked and you will need admin approval to change it after this.')) return;
  const ok = await saveDraft();
  if (!ok) return;
  try {
    await Api.post(`/api/timesheets/${currentTimesheet.id}/submit`);
    await loadWeek(currentWeekStart);
    await loadHistory();
  } catch (e) {
    document.getElementById('saveMsg').textContent = e.message;
  }
}

async function requestUnlock() {
  const reason = document.getElementById('unlockReason').value.trim();
  const msgEl = document.getElementById('unlockMsg');
  try {
    await Api.post(`/api/timesheets/${currentTimesheet.id}/request-unlock`, { reason });
    msgEl.textContent = 'Unlock request sent to admin.';
    msgEl.className = 'success-msg';
  } catch (e) {
    msgEl.textContent = e.message;
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
