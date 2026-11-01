# Approved development activation

After explicit user approval, the prepared Phase 2 migrations were applied to the development database configured in `.env`.

## Changes applied

- `001_baseline` and `002_phase2_integrity` completed successfully, including the legacy-data preflight.
- The older local Node server was stopped and the updated server started on http://localhost:3000.
- The database passes the read-only migration/checksum readiness check.
- All five existing timesheets remain present and now return numeric revision numbers.
- Existing work hours, explanations and account credentials were not edited to perform verification.

A read-only check found two existing sheets passing the complete save validator and three incomplete drafts needing hours or short-day explanations. That is distinct from the missing-version failure. The app never fabricates those explanations or fills in hours on the user's behalf. Employees' past/future lock rules still apply.

## Why the error occurred

The new frontend requires a loaded `timesheet.version` before saving, to prevent old tabs overwriting newer work. The older running backend/database did not provide that field. Refreshing could not repair the missing migration or restart the old process; it only discarded unsaved editing state.

The missing-version message now explains the setup problem rather than telling users to reload. Employee dirty-state tracking warns before reload/navigation/week changes, and logout asks before clearing the session. Successful saves clear only the snapshot actually saved; later edits remain dirty.

For a tab opened before this update, copy any still-visible unsaved edits before refreshing to load the matching frontend/backend. Warnings are not automatic saving or recovery of edits already discarded by a reload.

## Verification

- `npm run migrate`: applied001 and002 successfully to the approved development target.
- `npm start`: updated local server listening on port3000.
- Read-only local login and timesheet API checks: HTTP200;all5 sheets have numeric versions.
- `npm test`: **111 passed,0 failed** (79 unit/frontend;32 real PostgreSQL integration).
- Integration regression tests used a fresh disposable local cluster, not the configured development database. That cluster was stopped and removed afterward.
- `git diff --check`: passed.

No commits, pushes or hosted production deployment were performed. Startup will continue to check migrations without running DDL automatically. Future schema changes require another explicit numbered migration and the relevant approval for its target database.
