# FWA Timesheets

A small Node.js 22+, Express 4 and PostgreSQL application with plain HTML/CSS/JavaScript. PostgreSQL stores accounts, projects, weekly timesheets, entries and unlock requests. The web server also serves `public/`; there is no frontend build step.

## Local setup

```sh
npm ci
cp .env.example .env
```

Set an existing database URL, a long random JWT secret and your initial administrator settings in `.env`. Keep `.env` private; it is ignored by Git. For Neon on a network that blocks PostgreSQL port 5432, use `DATABASE_TRANSPORT=websocket` to connect over encrypted port 443. Other PostgreSQL connections use the default `tcp` mode.

Review the target database before running these explicit commands:

```sh
npm run migrate
npm run seed-admin
npm start
```

Open http://localhost:3000. `seed-admin` creates the configured administrator or deliberately resets/reactivates the configured existing account; use a chosen private password. Existing installations normally need only migration and restart, not another seed.

Startup now checks migration readiness without modifying schema or creating accounts. A missing/pending migration or changed migration checksum stops startup with an actionable message.

## Phase 2 rollout and legacy data

The migration ledger records `001` (non-destructive baseline) and `002` (integrity/concurrency/retention). Run pending migrations only after reviewing the database target and taking an appropriate backup. The original implementation left existing databases untouched. The configured development database was subsequently migrated after explicit approval; see [the activation record](docs/phase2-rollout.md). Other targets still require explicit review and migration.

The baseline preserves old `notes` and `overtime_hours` columns. Phase 2 checks historical data before adding constraints. Invalid legacy rows produce IDs and remediation guidance and roll back the migration, including newly added columns. It never silently repairs, removes or rounds historical data. Review each reported record and agree on an explicit correction or archival plan before retrying. Applied migration files are immutable: add another numbered migration for future changes. Saves retain equivalent existing entry rows and their legacy columns. An edit that would change/remove a row with legacy notes or overtime is rejected for explicit review rather than silently discarding those unmodeled fields.

The new frontend and backend must be released together because writes now require a `version` from the loaded timesheet. Unknown fields and incomplete snapshots are rejected. On 409, keep your entered data and reload/reconcile with the newer saved version rather than retrying an overwrite.

## Tests

```sh
npm run test:unit
npm run test:integration
# or both:
npm test
```

Integration tests require PostgreSQL 17 binaries (`initdb`, `pg_ctl`) and permissions to start local processes/listen on loopback. Install them locally, for example `brew install postgresql@17`, or set `POSTGRES_BIN` to their bin directory. The runner locates common macOS/Linux paths.

`test:integration` never reads `.env` and never uses an inherited `DATABASE_URL` or `TEST_DATABASE_URL`. It creates a fresh temporary local cluster on a random port, verifies its data directory and random ownership token, creates only synthetic data, runs tests, stops the cluster, and removes only its marked temporary directory. A configured remote database is never a fallback. Directly invoking guarded integration files without this runner fails before mutation.

## Architecture and Phase 2 documentation

- `app.js`: Express application and safe error responses; importable without starting a server or reading `.env`.
- `server.js`: configuration, read-only migration readiness check and HTTP listener.
- `timesheetService.js`: transactional writes, ownership/state checks, revisions, project eligibility and read snapshots.
- `validation/`: strict canonical timesheet input and common route validators.
- `db/`: connection transport, migration runner, baseline/schema changes and explicit administrator seed.
- `routes/`, `middleware/`: JSON endpoints, current-account authentication and administrator authorization.
- `public/`: existing branded browser interface; `timesheet-payload.js` serializes canonical write payloads.

Read the [initial audit](docs/phase2-audit.md), [engineering learning guide](docs/phase2-guide.md), and [completion report](docs/phase2-report.md) for policies, API changes, migration compatibility, evidence and remaining risks.
