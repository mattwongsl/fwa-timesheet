-- Phase 2: reject invalid legacy data before installing stricter guarantees.
-- The runner executes every pending migration in one transaction. Failure here
-- rolls back schema additions too; this migration never repairs/deletes rows.

ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE unlock_requests ADD COLUMN IF NOT EXISTS requested_version INTEGER NOT NULL DEFAULT 0;

CREATE FUNCTION phase2_entry_shape_valid(
  kind TEXT, project INTEGER, work_hours NUMERIC, leave_days NUMERIC,
  unit TEXT, reason TEXT, description TEXT
) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT COALESCE(
    (kind = 'work' AND leave_days = 0 AND unit IS NULL AND description IS NULL AND (
      (project IS NOT NULL AND reason IS NULL) OR
      (project IS NULL AND work_hours = 0 AND reason IS NOT NULL AND reason ~ '[^[:space:]]')
    )) OR
    (kind = 'other' AND project IS NULL AND leave_days = 0 AND unit IS NULL
      AND reason IS NULL AND description IS NOT NULL AND description ~ '[^[:space:]]') OR
    (kind IN ('sick_leave', 'local_leave', 'emergency_leave') AND project IS NULL
      AND work_hours = 0 AND leave_days IN (0.5, 1) AND unit = 'days'
      AND reason IS NULL AND description IS NULL) OR
    (kind = 'public_holiday' AND project IS NULL AND work_hours = 0
      AND leave_days = 1 AND unit = 'days' AND reason IS NULL AND description IS NULL),
    false
  );
$$;

DO $$
DECLARE problems TEXT;
BEGIN
  WITH violations AS (
    SELECT 'employee has missing required fields or invalid account state' AS issue, u.id::TEXT AS record_id
      FROM users u WHERE u.name IS NULL OR u.email IS NULL OR u.password_hash IS NULL
        OR u.role IS NULL OR u.role NOT IN ('admin', 'employee') OR u.active IS NULL
    UNION ALL
    SELECT 'project has missing required fields or invalid archive state', p.id::TEXT
      FROM projects p WHERE p.name IS NULL OR p.archived IS NULL
    UNION ALL
    SELECT 'timesheet has an invalid week, version, or lock state' AS issue, t.id::TEXT AS record_id
      FROM timesheets t
      WHERE t.week_start IS NULL OR EXTRACT(ISODOW FROM t.week_start) <> 1
        OR t.version IS NULL OR t.version < 0 OR t.locked IS NULL OR t.admin_unlocked IS NULL
        OR (t.locked AND t.admin_unlocked)
    UNION ALL
    SELECT 'timesheet references a missing employee', t.id::TEXT
      FROM timesheets t LEFT JOIN users u ON u.id = t.user_id WHERE u.id IS NULL
    UNION ALL
    SELECT 'entry has invalid numeric values, work date, or row shape', e.id::TEXT
      FROM timesheet_entries e
      WHERE e.work_date IS NULL OR EXTRACT(ISODOW FROM e.work_date) NOT BETWEEN 1 AND 5
        OR e.hours IS NULL OR NOT (e.hours >= 0 AND e.hours <= 24 AND e.hours * 2 = trunc(e.hours * 2))
        OR e.days IS NULL OR e.days NOT IN (0, 0.5, 1)
        OR (e.project_id IS NOT NULL AND e.project_id <= 0)
        OR NOT phase2_entry_shape_valid(e.entry_type, e.project_id, e.hours, e.days, e.leave_unit, e.justification, e.other_description)
    UNION ALL
    SELECT 'entry references a missing timesheet or project', e.id::TEXT
      FROM timesheet_entries e LEFT JOIN timesheets t ON t.id = e.timesheet_id
      LEFT JOIN projects p ON p.id = e.project_id
      WHERE t.id IS NULL OR (e.project_id IS NOT NULL AND p.id IS NULL)
    UNION ALL
    SELECT 'entry is outside its parent timesheet Monday-Friday week', e.id::TEXT
      FROM timesheet_entries e JOIN timesheets t ON t.id = e.timesheet_id
      WHERE e.work_date < t.week_start OR e.work_date > t.week_start + 4
    UNION ALL
    SELECT 'duplicate project/date entries', min(e.id)::TEXT
      FROM timesheet_entries e WHERE e.entry_type = 'work' AND e.project_id IS NOT NULL
      GROUP BY e.timesheet_id, e.work_date, e.project_id HAVING count(*) > 1
    UNION ALL
    SELECT 'duplicate justification/date entries', min(e.id)::TEXT
      FROM timesheet_entries e WHERE e.entry_type = 'work' AND e.project_id IS NULL
      GROUP BY e.timesheet_id, e.work_date HAVING count(*) > 1
    UNION ALL
    SELECT 'duplicate leave/date entries', min(e.id)::TEXT
      FROM timesheet_entries e WHERE e.entry_type IN ('sick_leave', 'local_leave', 'emergency_leave', 'public_holiday')
      GROUP BY e.timesheet_id, e.work_date HAVING count(*) > 1
    UNION ALL
    SELECT 'day exceeds 24 worked hours or mixes full-day leave with work', min(e.id)::TEXT
      FROM timesheet_entries e GROUP BY e.timesheet_id, e.work_date
      HAVING sum(e.hours) > 24 OR (
        bool_or(e.entry_type IN ('sick_leave', 'local_leave', 'emergency_leave', 'public_holiday') AND e.days = 1)
        AND bool_or(e.entry_type IN ('work', 'other'))
      )
    UNION ALL
    SELECT 'unlock request has invalid state, version, employee, or timesheet', r.id::TEXT
      FROM unlock_requests r LEFT JOIN timesheets t ON t.id = r.timesheet_id
      LEFT JOIN users u ON u.id = r.requested_by
      WHERE t.id IS NULL OR u.id IS NULL OR r.requested_by <> t.user_id
        OR r.status IS NULL OR r.status NOT IN ('pending', 'approved', 'denied')
        OR r.requested_version IS NULL OR r.requested_version < 0
    UNION ALL
    SELECT 'duplicate pending unlock requests', min(r.id)::TEXT
      FROM unlock_requests r WHERE r.status = 'pending'
      GROUP BY r.timesheet_id HAVING count(*) > 1
  )
  SELECT string_agg(issue || ': id=' || record_id, E'\n') INTO problems
    FROM (SELECT issue, record_id FROM violations ORDER BY issue, record_id LIMIT 50) sample;
  IF problems IS NOT NULL THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Phase 2 migration blocked by legacy data that needs review.',
      DETAIL = problems,
      HINT = 'Review the listed records and agree on explicit corrections or preservation before retrying npm run migrate. No historical rows were automatically changed.';
  END IF;
END $$;

ALTER TABLE users ALTER COLUMN name SET NOT NULL, ALTER COLUMN email SET NOT NULL,
  ALTER COLUMN password_hash SET NOT NULL, ALTER COLUMN role SET NOT NULL, ALTER COLUMN active SET NOT NULL;
ALTER TABLE projects ALTER COLUMN name SET NOT NULL, ALTER COLUMN archived SET NOT NULL;
ALTER TABLE timesheets ALTER COLUMN user_id SET NOT NULL, ALTER COLUMN week_start SET NOT NULL,
  ALTER COLUMN locked SET NOT NULL, ALTER COLUMN admin_unlocked SET NOT NULL, ALTER COLUMN version SET NOT NULL;
ALTER TABLE timesheet_entries ALTER COLUMN timesheet_id SET NOT NULL, ALTER COLUMN work_date SET NOT NULL,
  ALTER COLUMN entry_type SET NOT NULL, ALTER COLUMN hours SET NOT NULL, ALTER COLUMN days SET NOT NULL;
ALTER TABLE unlock_requests ALTER COLUMN timesheet_id SET NOT NULL, ALTER COLUMN requested_by SET NOT NULL,
  ALTER COLUMN status SET NOT NULL, ALTER COLUMN requested_version SET NOT NULL;

-- A fixed scale rounds before CHECK constraints run (0.501 becomes 0.50).
-- Remove only the typmod; exact existing decimals remain unchanged, while
-- bounded/increment checks below reject future invalid values without rounding.
ALTER TABLE timesheet_entries ALTER COLUMN hours TYPE NUMERIC,
  ALTER COLUMN days TYPE NUMERIC;

-- Existing cascade rules are replaced without deleting referenced records.
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS timesheets_user_id_fkey;
ALTER TABLE timesheets ADD CONSTRAINT timesheets_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE timesheet_entries DROP CONSTRAINT IF EXISTS timesheet_entries_timesheet_id_fkey;
ALTER TABLE timesheet_entries ADD CONSTRAINT timesheet_entries_timesheet_id_fkey
  FOREIGN KEY (timesheet_id) REFERENCES timesheets(id) ON DELETE RESTRICT;
ALTER TABLE timesheet_entries DROP CONSTRAINT IF EXISTS timesheet_entries_project_id_fkey;
ALTER TABLE timesheet_entries ADD CONSTRAINT timesheet_entries_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;
ALTER TABLE unlock_requests DROP CONSTRAINT IF EXISTS unlock_requests_timesheet_id_fkey;
ALTER TABLE unlock_requests ADD CONSTRAINT unlock_requests_timesheet_id_fkey
  FOREIGN KEY (timesheet_id) REFERENCES timesheets(id) ON DELETE RESTRICT;
ALTER TABLE unlock_requests DROP CONSTRAINT IF EXISTS unlock_requests_requested_by_fkey;
ALTER TABLE unlock_requests ADD CONSTRAINT unlock_requests_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE timesheets ADD CONSTRAINT uq_timesheets_id_owner UNIQUE (id, user_id);
ALTER TABLE unlock_requests ADD CONSTRAINT unlock_requests_timesheet_owner_fkey
  FOREIGN KEY (timesheet_id, requested_by) REFERENCES timesheets(id, user_id) ON DELETE RESTRICT;
ALTER TABLE timesheets DROP CONSTRAINT IF EXISTS timesheets_locked_by_fkey;
ALTER TABLE timesheets ADD CONSTRAINT timesheets_locked_by_fkey
  FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE unlock_requests DROP CONSTRAINT IF EXISTS unlock_requests_resolved_by_fkey;
ALTER TABLE unlock_requests ADD CONSTRAINT unlock_requests_resolved_by_fkey
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE timesheets ADD CONSTRAINT phase2_timesheet_week_monday CHECK (EXTRACT(ISODOW FROM week_start) = 1);
ALTER TABLE timesheets ADD CONSTRAINT phase2_timesheet_version_nonnegative CHECK (version >= 0);
ALTER TABLE timesheets ADD CONSTRAINT phase2_timesheet_lock_state CHECK (NOT (locked AND admin_unlocked));
ALTER TABLE unlock_requests ADD CONSTRAINT phase2_unlock_version_nonnegative CHECK (requested_version >= 0);

ALTER TABLE timesheet_entries DROP CONSTRAINT IF EXISTS timesheet_entries_entry_type_check;
ALTER TABLE timesheet_entries ADD CONSTRAINT timesheet_entries_entry_type_check
  CHECK (entry_type IN ('work', 'other', 'sick_leave', 'local_leave', 'emergency_leave', 'public_holiday'));
ALTER TABLE timesheet_entries ADD CONSTRAINT phase2_entry_hours CHECK (hours >= 0 AND hours <= 24 AND hours * 2 = trunc(hours * 2));
ALTER TABLE timesheet_entries ADD CONSTRAINT phase2_entry_days CHECK (days IN (0, 0.5, 1));
ALTER TABLE timesheet_entries ADD CONSTRAINT phase2_entry_workday CHECK (EXTRACT(ISODOW FROM work_date) BETWEEN 1 AND 5);
ALTER TABLE timesheet_entries ADD CONSTRAINT phase2_entry_project_positive CHECK (project_id IS NULL OR project_id > 0);
ALTER TABLE timesheet_entries ADD CONSTRAINT phase2_entry_shape CHECK (
  phase2_entry_shape_valid(entry_type, project_id, hours, days, leave_unit, justification, other_description)
);

CREATE UNIQUE INDEX uq_entries_project_per_day ON timesheet_entries(timesheet_id, work_date, project_id)
  WHERE entry_type = 'work' AND project_id IS NOT NULL;
CREATE UNIQUE INDEX uq_entries_justification_per_day ON timesheet_entries(timesheet_id, work_date)
  WHERE entry_type = 'work' AND project_id IS NULL;
CREATE UNIQUE INDEX uq_entries_leave_per_day ON timesheet_entries(timesheet_id, work_date)
  WHERE entry_type IN ('sick_leave', 'local_leave', 'emergency_leave', 'public_holiday');
CREATE UNIQUE INDEX uq_unlock_request_pending ON unlock_requests(timesheet_id) WHERE status = 'pending';

CREATE FUNCTION phase2_assert_timesheet_consistent(sheet_id INTEGER) RETURNS VOID LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE monday DATE;
BEGIN
  -- Serialize cross-row checks even for direct SQL writers. NO KEY UPDATE is
  -- compatible with the key-share lock taken by child foreign-key checks.
  SELECT week_start INTO monday FROM timesheets WHERE id = sheet_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM timesheet_entries WHERE timesheet_id = sheet_id AND (work_date < monday OR work_date > monday + 4)) THEN
    RAISE EXCEPTION 'Entry dates must belong to their timesheet Monday-Friday week.'
      USING ERRCODE = '23514', CONSTRAINT = 'phase2_entries_parent_week';
  END IF;
  IF EXISTS (
    SELECT 1 FROM timesheet_entries WHERE timesheet_id = sheet_id GROUP BY work_date
    HAVING sum(hours) > 24 OR (
      bool_or(entry_type IN ('sick_leave', 'local_leave', 'emergency_leave', 'public_holiday') AND days = 1)
      AND bool_or(entry_type IN ('work', 'other'))
    )
  ) THEN
    RAISE EXCEPTION 'A day cannot exceed 24 worked hours or mix full-day leave with work entries.'
      USING ERRCODE = '23514', CONSTRAINT = 'phase2_entries_day_consistency';
  END IF;
END $$;

CREATE FUNCTION phase2_check_entry_timesheet() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN PERFORM phase2_assert_timesheet_consistent(OLD.timesheet_id); END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN PERFORM phase2_assert_timesheet_consistent(NEW.timesheet_id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phase2_entry_consistency
  AFTER INSERT OR UPDATE OR DELETE ON timesheet_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase2_check_entry_timesheet();

CREATE FUNCTION phase2_check_timesheet_entries() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM phase2_assert_timesheet_consistent(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phase2_timesheet_consistency
  AFTER INSERT OR UPDATE ON timesheets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase2_check_timesheet_entries();
