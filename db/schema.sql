-- Timesheet app schema (PostgreSQL)
-- This file is (re)run every time the server starts, so every statement is
-- written to be safe to run repeatedly (IF NOT EXISTS / exception-guarded).

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','employee')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per employee per work week (week_start = Monday of that week).
-- Only Monday-Friday are tracked as working days.
CREATE TABLE IF NOT EXISTS timesheets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT false,
  admin_unlocked BOOLEAN NOT NULL DEFAULT false,
  submitted_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, week_start)
);

-- Individual line items within a timesheet.
--   entry_type = 'work'            -> one row per project worked that day (hours), PLUS
--                                      an optional extra row with project_id NULL holding
--                                      the employee's justification for a sub-7.5-hour day.
--   entry_type = 'sick_leave'      -> one row, days only (0.5 or 1)
--   entry_type = 'local_leave'     -> one row, days only (0.5 or 1)
--   entry_type = 'emergency_leave' -> one row, days only (0.5 or 1)
--   entry_type = 'public_holiday'  -> one row, marks the whole day, no input needed
CREATE TABLE IF NOT EXISTS timesheet_entries (
  id SERIAL PRIMARY KEY,
  timesheet_id INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('work','other','sick_leave','local_leave','emergency_leave','public_holiday')),
  project_id INTEGER REFERENCES projects(id),
  hours NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  days NUMERIC(4,2) NOT NULL DEFAULT 0 CHECK (days >= 0),
  leave_unit TEXT CHECK (leave_unit IN ('hours','days')),
  justification TEXT,
  other_description TEXT
);

CREATE INDEX IF NOT EXISTS idx_entries_timesheet ON timesheet_entries(timesheet_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_user_week ON timesheets(user_id, week_start);

CREATE TABLE IF NOT EXISTS unlock_requests (
  id SERIAL PRIMARY KEY,
  timesheet_id INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- Migration steps for databases created before the overtime/leave-type
-- changes. Safe to run against a fresh database too (everything here is
-- a no-op if the column/constraint doesn't need changing).
-- ---------------------------------------------------------------------

ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS overtime_hours;
ALTER TABLE timesheet_entries DROP COLUMN IF EXISTS notes;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS days NUMERIC(4,2) NOT NULL DEFAULT 0;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS leave_unit TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS justification TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS other_description TEXT;

DO $$
BEGIN
  ALTER TABLE timesheet_entries DROP CONSTRAINT timesheet_entries_entry_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE timesheet_entries ADD CONSTRAINT timesheet_entries_entry_type_check
    CHECK (entry_type IN ('work','other','sick_leave','local_leave','emergency_leave','public_holiday'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE timesheet_entries ADD CONSTRAINT timesheet_entries_leave_unit_check
    CHECK (leave_unit IN ('hours','days'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- Migration: allow admins to permanently delete projects and employees.
--
-- Deleting a project also removes any hours logged against it (there is
-- no meaningful way to keep "hours worked on an unknown project"), so
-- project_id becomes ON DELETE CASCADE.
--
-- Deleting a user must never be blocked just because they locked someone
-- ELSE's timesheet or resolved someone else's unlock request as an admin,
-- so those two admin-action references are set to NULL instead of
-- restricting the delete. The employee's OWN timesheets (and therefore
-- their own unlock requests) are still fully removed via the existing
-- ON DELETE CASCADE on timesheets.user_id.
-- ---------------------------------------------------------------------

DO $$
BEGIN
  ALTER TABLE timesheet_entries DROP CONSTRAINT timesheet_entries_project_id_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE timesheet_entries ADD CONSTRAINT timesheet_entries_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE timesheets DROP CONSTRAINT timesheets_locked_by_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE timesheets ADD CONSTRAINT timesheets_locked_by_fkey
    FOREIGN KEY (locked_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE unlock_requests DROP CONSTRAINT unlock_requests_resolved_by_fkey;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE unlock_requests ADD CONSTRAINT unlock_requests_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
