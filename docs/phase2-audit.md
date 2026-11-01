# Phase 2 initial audit and implementation plan

This audit was performed against the repository on 1 November 2026 before Phase 2 implementation. The previous UI redesign was not treated as evidence that backend validation existed. No configured Neon database was read or modified during this audit or implementation.

| Requirement | Existing implementation | Missing or incorrect behavior | Proposed fix | Priority |
|---|---|---|---|---|
| Backend snapshot validation | Employee UI validates explanations; service checks positive duplicate project IDs, Other descriptions and half-day explanations | Missing `days` becomes `[]`; invalid values are coerced, rounded or skipped; invalid/outside-week/duplicate dates and unknown structures accepted | Pure strict validator, complete five-day snapshot, shared submit validation | Critical |
| Hours and leave | UI uses 0.5-hour steps, per-entry max 24, leave 0.5/1, full public holiday | Most checks can be bypassed; full-day explanations frontend-only; direct SQL NUMERIC scale silently rounds | Finite numeric backend checks, half-hour increments, total work<=24, explicit leave shapes; exact NUMERIC plus constraints | High |
| Project integrity | FK checks existence; active dropdown hides archived projects | Archived project IDs remain usable through API; historical selected option can display as Other | Transactional existence/status checks; freeze archived allocations; show historical project explicitly | High |
| Ownership/account status | Employee routes compare owner to token ID; login rejects inactive account | Checks occur outside writes; 14-day token remains usable after deactivation/deletion/role change | DB-backed authentication and transaction-time active-account/role recheck | Critical |
| Lock state and submission | Current/past/future logic and admin unlock flags exist | Past-week locked flag can be ignored; submit validates no persisted content; saves race lock/submit | Central transactional state service and content validation before submission | Critical |
| Concurrent edits | DELETE/INSERT has BEGIN/ROLLBACK | No parent lock or revision; two tabs silently overwrite/intermix entries | Users/project share locks, timesheet update lock, integer optimistic revision | Critical |
| Unlock requests | Admin middleware; approval transaction; pending check before insert | Concurrent duplicate requests; replay of resolved request; stale pending request can reopen a changed sheet | Parent/request locks, unique pending index, pending-only resolution, requested revision | Critical |
| Historical deletion | Archive/deactivate available | Project/employee/parent CASCADE deletes erase history; ordinary UI exposes destructive actions | Restrictive FKs, referenced-delete 409, remove ordinary Delete controls | Critical |
| Historical reports | Detail pages aggregate actual work dates | Stats omit inactive employees and mix work-date/week-start ranges | Inclusive historical reports using actual work dates and consistent read snapshot | High |
| Startup/migrations | schema.sql is reapplied on every startup | Startup drops legacy notes/overtime columns and repeatedly changes constraints | Read-only startup readiness check; explicit transactional/checksummed versioned migration | Critical |
| Error responses | One employee save catches async errors | Express 4 async failures elsewhere can escape middleware | Async route wrappers and consistent safe JSON errors | High |
| Verification | Ten original reporting/driver tests | No real PostgreSQL/API/state/rollback/concurrency coverage | Disposable local PostgreSQL cluster, synthetic accounts and guarded integration tests | High |

## Supported policies preserved

- Work weeks are explicitly Monday–Friday in `utils.weekDays`; this is an existing policy, not a new weekend ban.
- Full work days below 7.5 hours need an explanation; half-day leave below 3.5 worked hours needs an explanation. These are explanation thresholds, not a requirement to work a minimum number of hours. Zero hours with a valid explanation is accepted.
- Sick, local and emergency leave use 0.5 or 1 day. Public holidays use 1 full day. Full-day leave cannot also carry project work. Half-day leave can include work.
- Hours use half-hour increments, and the UI already limits an individual input to 24. The backend also limits total worked hours in one calendar day to 24; it introduces no smaller overtime ceiling.
- Multiple positive-hour Other entries remain allowed, each with its own description. A named project can appear once per date.
- The UI already sends all five dates. Full replacement now explicitly requires all five, including unworked dates with explanations; omission is never interpreted as a request to erase history.
- New blank zero-hour placeholders are validated but are not inserted as worked-time entries. A zero-hour Other row with meaningful descriptive text is retained, so a successful save cannot silently discard that text. Existing equivalent zero-hour rows are also retained.

## Decisions and uncertainties

Archived positive-hour allocations are frozen by date/project/hour amount. A full snapshot may retain them unchanged while editing other allocations. Adding, changing or removing archived hours requires an administrator to deliberately unarchive that project. This conservative retention rule avoids accidental loss when inactive options disappear from a dropdown.

There is no employee-to-project assignment table or evidence of a narrower project entitlement policy. Every active employee may therefore use every active project. No billing limits, weekly maximum, overtime-approval policy, holiday calendar, leave entitlement balance, partial-leave conversion to hours, or organization-wide business timezone has been invented. Work-week boundaries continue to use the server's timezone.

## Execution order

1. Strict pure validation and regression tests.
2. Current-account authorization, retained historical relationships and safe administrative actions.
3. Transactional save/state service with row locks and optimistic revisions.
4. Explicit migrations with legacy preflight and read-only startup.
5. Canonical frontend serializer, revision exchange, explanation/archived-option compatibility and retained reporting.
6. Real database/API/rollback/concurrency/migration tests in a disposable local cluster.
7. Final evidence checklist, before/after report, operational instructions and beginner learning guide.

No production repair, migration, push, commit or deployment is authorized by this work. Migration SQL and instructions are prepared for an operator to review and apply separately.
