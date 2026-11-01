/* Convert browser editing state into the explicit, versioned timesheet API contract. */
const TimesheetPayload = (() => {
  const leaveTypes = new Set(['sick_leave', 'local_leave', 'emergency_leave']);
  function number(value, label) {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
      throw new Error(`${label} is required and must be a number.`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number.`);
    return parsed;
  }
  function hourError(value) {
    try {
      const hours = number(value, 'Hours');
      if (hours < 0 || hours > 24) return 'Hours must be between 0 and 24.';
      if (!Number.isInteger(hours * 2)) return 'Use half-hour increments, such as 1, 1.5, or 2 hours.';
      return '';
    } catch (error) { return error.message; }
  }
  function serializeDays(days) {
    if (!Array.isArray(days) || days.length !== 5) throw new Error('The timesheet must include all five weekdays. Reload the week before saving.');
    return days.map((day) => {
      const label = day.date || 'This day';
      if (day.type !== 'work' && !leaveTypes.has(day.type) && day.type !== 'public_holiday') throw new Error(`${label}: choose a supported day type.`);
      const leaveDays = day.type === 'work' ? 0 : day.type === 'public_holiday' ? 1 : number(day.leave_days, `${label}: leave days`);
      if (leaveTypes.has(day.type) && ![0.5, 1].includes(leaveDays)) throw new Error(`${label}: leave must be 0.5 or 1 day.`);
      const permitsWork = day.type === 'work' || leaveDays === 0.5;
      const projects = permitsWork ? (day.projects || []).map((entry, index) => {
        const error = hourError(entry.hours);
        if (error) throw new Error(`${label}, row ${index + 1}: ${error}`);
        const hours = number(entry.hours, 'Hours');
        if (entry.entry_type === 'other') {
          const description = typeof entry.other_description === 'string' ? entry.other_description.trim() : '';
          if (description.length > 4000) throw new Error(`${label}: Other descriptions must be no more than 4000 characters.`);
          if (hours > 0 && !description) throw new Error(`${label}: describe every Other entry with recorded hours.`);
          return { entry_type: 'other', hours, other_description: description };
        }
        const projectId = number(entry.project_id, `${label}: project`);
        if (!Number.isInteger(projectId) || projectId <= 0 || projectId > 2147483647) throw new Error(`${label}: choose a valid project.`);
        return { project_id: projectId, hours };
      }) : [];
      const total = projects.reduce((sum, project) => sum + project.hours, 0);
      if (total > 24) throw new Error(`${label}: combined work hours cannot exceed 24 in one day.`);
      const ids = projects.filter((entry) => entry.project_id).map((entry) => entry.project_id);
      if (new Set(ids).size !== ids.length) throw new Error(`${label}: a project can only be added once per day.`);
      const justification = permitsWork && typeof day.justification === 'string' ? day.justification.trim() : '';
      if (justification.length > 4000) throw new Error(`${label}: justifications must be no more than 4000 characters.`);
      const threshold = leaveDays === 0.5 ? 3.5 : 7.5;
      if (permitsWork && total < threshold && !justification) throw new Error(`${label}: add a reason when worked hours are below ${threshold}.`);
      return { date: day.date, type: day.type, projects, justification, leave_days: leaveDays };
    });
  }
  function version(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('The server has not supplied the required timesheet version. Keep this page open to preserve your edits and contact your administrator to finish updating the app. Reloading alone will not fix this.');
    return value;
  }
  function errorMessage(error) {
    if (error.status !== 409) return error.message;
    const staleRevision = /version conflict|revision conflict|changed in another tab|stale (?:version|revision)/i.test(error.message);
    return staleRevision
      ? `${error.message} Your edits are still here. Reload this week, compare the latest entries, and reapply your changes before trying again.`
      : `${error.message} Your edits are still here.`;
  }
  function frozenProject(project, availableProjects) {
    if (project.entry_type === 'other' || !Number(project.project_id)) return false;
    return project.archived === true || project.project_archived === true || !availableProjects.some((item) => Number(item.id) === Number(project.project_id) && !item.archived);
  }
  return { serializeDays, version, hourError, errorMessage, frozenProject };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TimesheetPayload;
