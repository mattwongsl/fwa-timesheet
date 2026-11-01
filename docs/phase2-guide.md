# Phase 2 learning guide

This guide describes the actual changes in FWA Timesheets. The completion report lists the exact verification results. Application code remains Node.js, Express and PostgreSQL with a plain JavaScript frontend.

## 1. A dropdown is helpful, but the server must validate the request

**Before:** `public/js/employee.js` checked explanations and offered an active-project dropdown. `timesheetService.replaceEntries()` rounded hours, skipped invalid/negative values, treated unknown day types as work, and ignored missing dates. Routes passed `req.body.days || []`.

**Problem and consequence:** A person can send an HTTP request without using the page. An omitted `days` field could therefore mean “delete every entry,” and changing a project ID in the request could assign an architect’s time to a nonexistent or archived project. Silent rounding could make the saved time disagree with what an employee entered.

**Change:** `validation/timesheets.js` validates a complete five-date snapshot before DELETE. It rejects unknown fields, invalid dates, repeated dates/projects, nonnumeric/nonfinite/negative hours, unsupported fractions, inconsistent leave, excessive daily work and missing explanations. The frontend’s `TimesheetPayload.serializeDays()` turns browser input strings into explicit numbers and removes read-only metadata. The backend independently verifies those numbers; it never trusts the serializer. Descriptions and explanations have a 4, 000-character technical input bound.

```js
const days = validateTimesheetPayload(body, sheet.week_start);
await checkProjects(client, sheet, days);
// Only now may saved entries be replaced.
```

**Example:** An employee enters 1.25 hours. Previously blur rounded it to 1.5; now the page explains the half-hour rule, and a direct API request with 1.25 returns 400. An employee may still record 2 hours rather than 7.5 when they supply the existing required explanation. There is no new requirement to work 7.5 hours.

**Verification:** `tests/timesheet-validation.test.js`, `tests/frontend-payload.test.js`, and the integration malformed-payload tests cover these cases. Frontend validation improves usability; backend validation protects every caller, including a future mobile app.

## 2. A foreign key and a business rule answer different questions

**Before:** `timesheet_entries.project_id` referenced `projects.id`. This prevented a missing project reference, but said nothing about `projects.archived`. The dropdown hid archived projects, which could make a historical selected project appear as Other.

**Problem and consequence:** An employee could submit an archived ID through the API, or accidentally lose its allocation while changing another day. For an architecture practice, project totals and historical resource records would become unreliable.

**Change:** `checkProjects()` batches project IDs and locks their project rows with `FOR SHARE` while checking eligibility. The archival UPDATE must wait for a save using that project, or a save must see that archival has already committed. Previously recorded positive hours for an archived project must survive unchanged by date/project/amount. Deliberate edits require unarchiving. The frontend explicitly displays these historical projects and makes their allocations read-only.

A **primary key** identifies a record: `projects.id=42` identifies one project. A **foreign key** links another record to it: an entry with `project_id=42` must reference that existing project. A **database constraint** enforces a durable relationship or stored shape, such as a unique project/date pair. **Business validation** asks whether that otherwise valid project is currently eligible for new work.

**Verification:** Integration tests reject nonexistent projects and new/changed/removed archived allocations, retain unchanged archived hours through another-day edits, and exercise the archive-versus-save row-lock race. Migration tests verify foreign keys, unique indexes and exact numeric storage directly in PostgreSQL.

## 3. Authentication identifies the person; authorization decides what they may do

**Before:** `middleware/auth.js` verified a 14-day JWT and trusted its account and administrator role. Employee write routes correctly compared the sheet owner to the token ID, but the check happened before the write transaction.

**Problem and consequence:** Deactivating a departed employee blocked their next login but did not invalidate an already-issued token. A stale administrator claim could retain privileges. A request could also pass a check while the account was being deactivated.

**Change:** `requireAuth()` reads the current account after checking the token. Missing/inactive accounts return 401, and current DB roles determine administrator access. Mutations recheck and share-lock actor/owner rows inside their transaction. User IDs and status flags are never accepted from a timesheet body; unknown owner/lock fields return 400.

**Example:** Alex logs in on Monday, then leaves the firm on Tuesday. Deactivation changes the DB account. Alex’s old token still has a valid signature, but the next protected request is rejected. If a save overlaps deactivation, row locks give those actions an order: either an authorized save completes first, or deactivation completes first and the save is rejected.

**Verification:** Authentication unit tests use already-issued synthetic tokens, and API integration tests cover deactivation/deletion, current roles, manipulated owner/status bodies, another employee’s sheet, unauthorized unlock approval and the deterministic deactivation-versus-save race.

## 4. A transaction protects the whole replacement, not just each INSERT

**Before:** `replaceEntries()` already used BEGIN, COMMIT, ROLLBACK and client release. That was a correct feature worth preserving. However, ownership/editability/project checks were outside or absent from the transaction.

**Problem and consequence:** Replacing a sheet means first deleting its previous rows and then inserting the new rows. Without a transaction, a failure halfway through would leave an incomplete week. With a transaction but stale authorization checks, an invalid operation could still be committed atomically.

**Change:** The service now includes all relevant checks, row locks, deletion, insertion, revision update and response snapshot in one transaction. It compares canonical entry values and keeps equivalent existing rows in place, including their IDs and legacy columns. Only changed, unprotected rows are replaced. Text matching trims only for comparison; the original stored row remains unchanged. If changing/removing a row would discard nonblank legacy notes or nonzero overtime, the service returns 409 for explicit data review instead. A described zero-hour Other entry is retained, while blank zero-hour inputs remain placeholders. A validation failure happens before DELETE. A database failure after DELETE still causes ROLLBACK, restoring the old entries and version. `finally` releases the client in both cases.

```js
await client.query('BEGIN');
// Lock account and sheet; check owner, state, version and projects.
// Replace entries and increment the version.
await client.query('COMMIT');
// Any failure follows the ROLLBACK path instead.
```

**Verification:** An isolated integration test deliberately raises a database exception during insertion, after the old rows were deleted. The response fails, but the previous entries and version remain intact. A separate rolled-back transaction is not a mock of PostgreSQL; the tests run against a real disposable PostgreSQL 17 cluster.

## 5. Row locking and optimistic concurrency solve different parts of a race

**Before:** Two tabs could both load a sheet and send a replacement. Each transaction could be individually valid while the last one silently erased the other’s changes. Save also raced with submit or an administrator’s lock.

**Change:** `withSheet()` share-locks account rows, locks the parent timesheet with `SELECT … FOR UPDATE`, and compares its integer `version` with the version submitted by the browser. Every content/state change increments that version. The consistent lock order is accounts by ID, timesheet, unlock request when needed, then projects by ID.

**Row locking** makes simultaneous writes wait their turn. **Optimistic concurrency** remembers what the browser originally saw and detects that it is now stale. Both are needed: waiting alone would simply make the second overwrite happen later.

**Example:** Two tabs load version 3. Tab A saves 4 hours on Project 42 and receives version 4. Tab B waits for the row lock, then sees that its version 3 is stale. It receives 409 instead of overwriting A. Its entered text remains visible so the employee can reload and reconcile. If an admin locks first, the employee’s later save cannot slip through: it sees a newer version or a noneditable state.

For about 15 employees, a single PostgreSQL row lock per changed sheet is simple and sufficient. Independent sheets can still be edited concurrently; no distributed lock server or queue is necessary.

**Verification:** Actual overlapping API calls test save/save, save/submit and save/admin-lock. The tests confirm a winner plus a conflict or locked response, never a silent second overwrite. Frontend workflow tests verify revision propagation through save→submit/lock and preservation of unsaved values on 409.

## 6. Valid state transitions prevent an old approval reopening new work

**Before:** Submit locked the sheet without validating saved content. A past sheet with both lock flags could be treated as editable. An already approved or denied request could be approved again.

**Change:** `isEditableByEmployee()` rejects `locked` first. Submission validates the stored five-day snapshot using the same rules as saving. Unlock requests require a closed current/past sheet, one pending request per sheet, and a `requested_version`. Approval requires pending status, matching owner and unchanged sheet version. Denial can clear a stale pending request; replay cannot reopen anything.

Historical `submitted_at` and `locked_at` timestamps remain after reopening. They record what happened; the current `locked` and `admin_unlocked` flags determine current editability. The DB forbids those two flags being true together.

**Example:** A request was filed against version 5, then an administrator changed or relocked the sheet to version 6. Approving that stale request returns 409. The administrator can deny it, and the employee can request against the current sheet.

**Verification:** Integration tests cover empty-draft submission rejection, valid submission, past/future behavior, duplicate pending requests, authorized approval, stale approvals, denial and resolved-request replay. The frontend also refuses to close a dirty editor through lock/unlock until its edits have been saved. It checks again after asynchronous responses: typing during a save stops the subsequent submit chain, late responses cannot overwrite another week/editor, and any newer edits remain visible rather than being loaded over.

## 7. Archive and deactivate preserve records; permanent deletion removes identity

**Before:** CASCADE foreign keys and ordinary Delete buttons allowed removing an employee’s entire timesheet history or all hours assigned to a project. Some reports then excluded inactive employees even when their rows still existed.

**Change:** Ordinary UI workflows use project archival and employee deactivation. API deletion is restricted to genuinely unused records; referenced records return 409 with archive/deactivate guidance. Restrictive foreign keys independently stop cascading removal of valuable entries. Historical administrator metadata retains intentional SET NULL behavior at the DB level, while the employee API also refuses deleting accounts referenced by those audit actions. Reports include inactive historical contributors and filter actual work dates consistently. Excel summaries and employee colors use Map entries keyed by project/user IDs, rather than names: two architects sharing a name remain separate, a real project called Other remains separate from unassigned work, and names such as __proto__ cannot collide with JavaScript object properties.

**Soft deletion** here means changing `active` or `archived` while keeping the row and its relationships. **Permanent deletion** removes the row. The former is normally right for a completed building project or a former employee whose work must remain reportable.

**Verification:** Tests deactivate employees/archive projects, read their historical sheets and reports as an admin, and attempt API/direct-SQL deletion. Invalid deletes are rejected and recorded hours remain unchanged.

## 8. Migrations are reviewed changes, not a side effect of starting a server

**Before:** `server.js` ran all of `db/schema.sql` at every startup. That file dropped legacy notes/overtime columns and changed deletion rules. A routine restart could therefore change the database or lose historical information.

**Change:** `server.js` performs only `assertSchemaReady()`. The explicit migration command uses a transaction, an advisory lock and a checksum ledger. Migration 001 is a non-destructive baseline. Migration 002 preflights legacy records, then adds revisions, strict row shapes, restrictive relationships, conditional uniqueness and deferred cross-row consistency checks. Exact NUMERIC values plus half-hour checks avoid silently rounding 0.501 to 0.50 before validation.

If a legacy record is incompatible, the migration stops, reports IDs and rolls back. No historical rows are repaired or deleted automatically. Changing an applied file is detected by its checksum; future changes belong in a new numbered migration.

**Verification:** Unit tests inspect runner transactions/readiness/checksum behavior. Real PostgreSQL migration tests apply and reapply migrations, preserve legacy notes/overtime and time entries, introduce invalid legacy data and verify complete rollback, and exercise new constraints directly. No configured Neon or production migration was run.

## The five most important concepts to remember

1. **Trust boundaries and layered validation:** `TimesheetPayload` helps the user; `validateTimesheetPayload` checks every request; PostgreSQL protects stored relationships. None replaces the others.
2. **Identity and permission:** a signed JWT identifies Alex; the current account and timesheet owner decide whether Alex may save this sheet now.
3. **Atomic transactions:** either the whole five-day replacement and revision commit, or the old week remains intact after rollback.
4. **Concurrency control:** `FOR UPDATE` orders writes; `version` prevents a stale tab from silently replacing a newer result.
5. **Historical data as an asset:** archive/deactivate, restrictive FKs and explicit migrations keep the firm’s project/time record usable after people leave or projects finish.
