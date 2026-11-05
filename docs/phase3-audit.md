# Phase 3 initial audit (latest main cda715b)

| Severity | Location | Finding and practical impact | Plan |
|---|---|---|---|
| High | routes/auth.js, middleware/auth.js | Signed 14-day JWT survives logout/password change; stolen cookie remains usable. Current role and active state are already reloaded. | Database sessions, 8-hour expiry, per-session logout and account-wide password revocation. |
| High | routes/employees.js | Reset replaces password and returns plaintext temporary password to admin; no single-use recovery flow. | Hashed 30-minute reset tokens delivered by configured email, no password disclosure. |
| High | app.js | Reflects arbitrary credentialed origins; no explicit CSRF protection. | Exact configured origins and signed double-submit token plus Origin checks. |
| High | db/pool.js | Disables certificate verification on TCP. | Verify certificates; require TLS for remote databases. |
| High | db/seed-admin.js | Default password, silently resets/reactivates existing account. | Explicit strong credentials; refuse existing account mutation. |
| Medium | app.js, routes/auth.js | No login/reset throttling, headers or explicit request limits. | Bounded rate limits, Helmet, compatible CSP, strict JSON sizes. |
| Medium | routes/employees.js | 8-character policy and bcrypt accepts oversized passwords (72-byte truncation). | 12-character minimum, 72-byte maximum, bcrypt cost 12. |
| Medium | server.js | Only checks JWT secret presence; raw startup error message may reveal details. | Validate config and sanitize unexpected startup failures. |
| Medium | public/js/admin.js | Error message inserted directly into HTML. | Escape error strings, audit all render paths. |
| Low | documentation | Missing security operational/deployment guidance. | Configuration, recovery, migration and educational report. |

Existing safeguards: parameterized SQL, HS256 verification, current account/role checks, inactive account rejection, explicit public employee fields, strict route validators, last-admin preservation, transactional ownership checks, immutable migrations and historical retention. Preserve these and exercise existing Phase 2 tests.

No production migration or configured remote database mutation is authorized by this work. Tests use the existing fresh-local-cluster guard. Existing JWTs will require re-login after an approved rollout because legacy JWTs have no session ID; migration does not delete accounts, passwords or live session rows. Deployment requires explicit approval.
