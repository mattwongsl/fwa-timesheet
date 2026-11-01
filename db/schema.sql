-- Migration 001: non-destructive baseline for fresh and pre-Phase-2 databases.
-- Applied only by `npm run migrate`, never during ordinary server startup.
-- This file is a versioned migration: append later changes in db/migrations/.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS timesheets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  week_start DATE NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT false,
  admin_unlocked BOOLEAN NOT NULL DEFAULT false,
  submitted_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, week_start)
);

CREATE TABLE IF NOT EXISTS timesheet_entries (
  id SERIAL PRIMARY KEY,
  timesheet_id INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE RESTRICT,
  work_date DATE NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('work', 'other', 'sick_leave', 'local_leave', 'emergency_leave', 'public_holiday')),
  project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT,
  hours NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  days NUMERIC(4,2) NOT NULL DEFAULT 0 CHECK (days >= 0),
  leave_unit TEXT CHECK (leave_unit IN ('hours', 'days')),
  justification TEXT,
  other_description TEXT
);

-- Add fields expected by the current application to older installations.
-- Retain historical notes/overtime columns; no historical rows are rewritten.
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS days NUMERIC(4,2) NOT NULL DEFAULT 0;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS leave_unit TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS justification TEXT;
ALTER TABLE timesheet_entries ADD COLUMN IF NOT EXISTS other_description TEXT;

CREATE INDEX IF NOT EXISTS idx_entries_timesheet ON timesheet_entries(timesheet_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_user_week ON timesheets(user_id, week_start);

CREATE TABLE IF NOT EXISTS unlock_requests (
  id SERIAL PRIMARY KEY,
  timesheet_id INTEGER NOT NULL REFERENCES timesheets(id) ON DELETE RESTRICT,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
