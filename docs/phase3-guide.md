# Phase 3 operations and learning guide

## What changed and why

| Original file/function | Weakness and practical example | Change and updated flow | Evidence |
|---|---|---|---|
| `routes/auth.js` login; `middleware/auth.js` requireAuth | A copied 14-day cookie survived logout and password changes. | Login verifies bcrypt, locks the account, inserts a hashed random session ID, signs an 8-hour HS256 JWT. Each request verifies signature/expiration, a live database session, and the current active account/role. Logout deletes that session. | `security.test.js`: valid login, malformed/tampered/expired JWT, logout, session expiry. |
| `routes/employees.js` password/reset/create | Administrators received temporary passwords; changing a password did not revoke access. | `password()` requires 12+ characters, at most 72 UTF-8 bytes (bcrypt truncates beyond this). Hash at cost 12. Existing lower-cost hashes upgrade on valid login. New accounts receive an invitation link, administrators only initiate recovery. Password change/reset revokes all sessions and reset tokens. | Password change, bcrypt upgrade, administrator reset and single-use recovery tests. |
| `security/reset.js` issueReset and auth reset routes | No expiring single-use recovery path. A mailed password would remain reusable. | Generate 32 random bytes; store SHA-256 only; email token link; expire after 30 minutes. On redemption lock the user and token, hash the new password, delete all sessions/tokens, commit. Concurrent redemptions serialize. Password remains unchanged until redemption. | Hashed/expiring/single-use token tests; Chromium recovery. |
| `app.js` CORS | Any origin could request credentialed access. | `requestSecurity` compares exact origins. Same-origin requests without Origin continue working. Untrusted Origin and forged writes return 403. | Cross-origin and CSRF tests. |
| `public/js/api.js` request | Cookie writes lacked an explicit CSRF proof. | GET signed CSRF token, keep host-only HttpOnly cookie, send matching custom header on each JSON mutation. HMAC signature prevents forged cookie/header pairs. SameSite=Lax adds defense. | Login/logout forged-write and browser API tests. |
| `middleware/security.js` | Unlimited password guessing and no throttling of recovery. | Ten failed attempts per normalized email/15 min; 150 attempts/IP/15 min allows an office NAT. Recovery max 30/IP/15 min and five-minute per-account DB cooldown; sensitive operations 60/IP. | Account login and recovery throttling tests. |
| `app.js` headers/parser/errors | Missing browser defenses, unrestricted parser defaults, raw/internal errors risk. | Helmet CSP allows only same-origin scripts, no inline event handlers; inline styles retained for existing charts. 64 KB strict JSON, sanitized errors, no-store API responses, production HTTPS/HSTS. | JSON limits/security header tests, Chromium no-CSP-violations assertions. |
| `public/js/admin.js` rendering | Employee/project names and unlock requester names inserted unescaped could execute stored HTML in an administrator's browser. | Escape names, emails, reasons and error strings. Existing DOM textContent and report escaping remain. Externalize inline login script to satisfy CSP. | Chromium malicious-name/project fixtures; existing report escaping tests. |
| `db/pool.js` | `rejectUnauthorized:false` trusted impostor database certificates. | Remote TCP always verifies TLS; remove connection-string SSL overrides. Secure Neon WebSocket uses native verified WSS. No certificate bypass added. | TCP verification and insecure-mode rejection tests. Live Neon connection after these changes is not tested. |
| `db/seed-admin.js` | Placeholder password and re-running seed could overwrite a real account. | Require explicit administrator credentials; enforce password policy; INSERT only, refuse conflicts, no default password. | Provisioning CLI integration test verifies strong bcrypt hash, rejection of defaults and refusal to reset an existing account. |
| `server.js` start; `security/config.js` validateConfig | Presence-only secret check. | Reject missing/short/known placeholder secrets; require production HTTPS origin and environment declaration; validate exact trusted origins and proxy flag. Unexpected startup errors print only safe type/code. | Production configuration tests. Randomness and separation across external deployments require operator verification. |

## Concepts working together

**Hashing and bcrypt:** PostgreSQL stores an irreversible salted bcrypt hash, not an encrypted recoverable password. Login uses `bcrypt.compare`. Cost 12 increases the cost of guesses. SHA-256 is appropriate for reset/session IDs because they are 256-bit random values, unlike human passwords. Administrators cannot recover the original password.

**JWT:** the three encoded parts are header, payload, and signature. Encoding is readable, not encryption; therefore the payload contains only account ID, random session ID and timestamps. HS256 verification rejects altered signatures; the explicit algorithm prevents accepting another signing mode. An unexpired JWT alone is insufficient: its hashed session ID must still exist in PostgreSQL.

**Authentication and RBAC authorization:** authentication identifies the employee through a valid live session. Authorization loads the current role and checks `requireAdmin`, ownership and business rules. An employee can authenticate and still receive 403 from `/api/employees`. Removing an admin role takes effect on the next request. Already-authorized in-flight requests may complete; Phase 2 mutation transactions continue rechecking current account status/role under row locks. No new technology stack was introduced.

**Cookies:** HttpOnly prevents JavaScript reading the JWT. Secure sends it over HTTPS in production. SameSite=Lax limits cross-site cookie attachment. Host-only cookies (no Domain) and Path=/ give predictable scope/clearing. Eight-hour expiry limits exposure. Logout revokes one browser's session; password change/reset revokes every browser. Deactivation's database trigger revokes permanently, so reactivation never revives stolen cookies.

**CORS versus CSRF:** CORS controls which origins can read credentialed browser responses; it is not authentication and not sufficient CSRF protection. A malicious page might submit a write even if it cannot read the response. Signed double-submit CSRF tokens and trusted Origin checks prevent that. The current frontend is served from the backend origin; separate same-site development origins can be explicitly configured. Cross-site embedded frontend use is not supported with these SameSite cookies.

**Rate limiting:** application memory counters prevent quick guessing without locking an employee account forever. Office users share a generous IP ceiling while guessed accounts have a tighter ceiling. These counters are per-process and reset on restart; deploy one application process for this small-team design or use a shared store before scaling. A targeted account/IP can still be temporarily throttled; an external edge/WAF can complement this if abuse occurs.

**SQL injection:** every user value goes through `$1`, `$2`, etc. Parameters are data, not SQL instructions. Positive-ID validators, strict allowed-body keys and transactional ownership checks complement parameterization; hiding IDs in the UI is not a permission check.

**TLS and HTTPS:** HTTPS protects browser traffic. PostgreSQL TLS/WSS protects database traffic. Certificate verification confirms the server identity; encryption without verification can still connect to an impostor. Terminate public HTTPS at the hosting provider. Keep direct backend access blocked, and enable `TRUST_PROXY=1` only for exactly one trusted proxy that overwrites forwarding headers. Otherwise keep 0. Never set `trust proxy=true` indiscriminately.

**Secrets:** environment settings supply private values at runtime, and `.env` stays ignored. No real secrets belong in Git, frontend JavaScript, screenshots, reports or logs. The application cannot prove that a production secret/database is different from development; the operator must use separate random values/roles and review the hosting settings. Heuristic history scans cannot prove the absence of all past leaks or secrets in unreachable/deleted Git history.

**Tests:** tests deliberately forge requests/cookies, manipulate synthetic account state and inspect persisted rows. Real PostgreSQL validates transactions and concurrent Phase 2 writes; Chromium validates the actual browser integration rather than only mocked helpers. Passing tests do not prove live SMTP, hosting HTTPS, database grants or all possible attacks are safe.

## Configuration and approved rollout

1. Review this branch and its additive migration; approve deployment separately. No configured Neon database was migrated during implementation.
2. Back up the target and confirm it is the intended deployment. Run `npm ci` from the lockfile, then explicitly run `npm run migrate`. Migration 003 adds `auth_sessions`, `password_reset_tokens`, indexes and a deactivation trigger; it does not reset passwords/delete existing sessions. Baseline 001 and Phase 2 migration 002 are unchanged. New auth tables cascade on account deletion; timesheet/history retention remains unchanged.
3. Deploy server and browser assets together. Old JWTs have no session ID and fail closed; tell employees they must sign in again. This compatibility change is the approved rollout's planned re-login, not a migration deleting live sessions. Rolling back application code alone would re-enable old JWT semantics; plan rollback with credential/session risk in mind.
4. Set `DATABASE_URL`, `JWT_SECRET` (generate 48 random bytes, store privately), `APP_ORIGIN` (exact HTTPS origin), `NODE_ENV=production`, `DEPLOYMENT_ENV=production`, `DATABASE_TRANSPORT`, `PORT`, `TRUST_PROXY` and optional `TRUSTED_ORIGINS`. Use distinct development and production DB roles/URLs and signing secrets. In this cloud runtime, `NODE_USE_ENV_PROXY=1` is needed for Neon WSS; no secret values enter scripts.
5. Configure SMTP_HOST, SMTP_PORT (465 implicit TLS or 587 STARTTLS), SMTP_USER, SMTP_PASSWORD, MAIL_FROM. SMTP certificate verification and TLS are mandatory. Test delivery with synthetic accounts in staging. Network access to the SMTP service may require explicit TCP grants; public HTTP access/Node's fetch proxy does not establish SMTP connectivity. No real delivery has been configured or claimed here. Without mail config, recovery/invitations/admin resets return 503; existing logins and timesheet work continue.
6. Use a dedicated migration role with DDL rights. Runtime role needs CONNECT, schema USAGE, table SELECT/INSERT/UPDATE/DELETE and sequence USAGE/SELECT, not superuser/CREATEDB/CREATEROLE or schema ownership. Revoke PUBLIC schema creation where applicable; exact grants must be reviewed by the database owner for this deployment. Database privileges were not changed or independently verified.
7. First admin only: choose explicit INITIAL_ADMIN_NAME/EMAIL/PASSWORD and run `seed-admin` once. Remove the provisioning password from hosting settings afterward. It never resets an existing user; account recovery is the normal path. No fixed default is accepted.
8. Optional maintenance deletes only expired sessions/tokens: `DELETE FROM auth_sessions WHERE expires_at <= now(); DELETE FROM password_reset_tokens WHERE expires_at <= now();`. Login also cleans expired sessions. Schedule maintenance if needed; no valid session is deleted by this cleanup.

New routes: GET `/api/auth/csrf`; POST `/api/auth/forgot-password` (`email`); POST `/api/auth/reset-password` (`token`, `newPassword`). POST `/api/employees/me/password` returns `loginRequired:true` and revokes all sessions. Reset links use a fragment (not query string); the recovery page clears it and sends the token in a JSON body. Never configure request-body/cookie logging at the provider. Referrer-Policy and no third-party scripts reduce leakage.

## Key code changes to read alongside the table

The following excerpts are from the implementation; the surrounding error handling and transactions are in the referenced files.

`security/sessions.js` makes a signed token revocable without storing the raw session secret:

```js
const sid = crypto.randomBytes(32).toString('hex');
await database.query("INSERT INTO auth_sessions(id_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [digest(sid), user.id]);
return jwt.sign({ id: user.id, sid }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: SESSION_SECONDS });
```

`middleware/auth.js` verifies the signature with `algorithms: ['HS256']`, then selects a current active user only when a matching unexpired `auth_sessions` record exists. It puts the current database role in `req.user`; the token cannot retain a removed administrator role.

`routes/auth.js` reset redemption performs these operations in one transaction after locking and validating the user and token:

```js
await client.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(req.body.newPassword, 12), user.id]);
await revokeAll(client, user.id);
await client.query('COMMIT');
```

`public/js/api.js` and `middleware/security.js` agree on the CSRF contract:

```js
headers['X-CSRF-Token'] = this.csrf;
// Server requires validCsrf(token) && token === req.cookies.csrf,
// plus a trusted Origin when present. The signed cookie is HttpOnly.
```

`db/pool.js` removes URL SSL overrides and uses `{ rejectUnauthorized: true }` for remote TCP connections. This intentionally corrects the old test expectation that certificate verification was disabled.

For a future credential exposure, rotate the affected Neon database password/role credentials, JWT signing secret (which forces re-login), SMTP password, or GitHub token immediately as applicable. Removing a file or rewriting Git history alone does not invalidate copies. No candidate real secrets were found in the limited scan performed here.
