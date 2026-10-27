# Company Timesheet App

A self-contained timesheet system for a small team (10-15 employees): weekly
hours + project tracking, leave tracking, lock/unlock workflow, and an admin
dashboard with stats and CSV export. Built to run for **$0/month**.

Stack: Node.js + Express (backend + serves the frontend) and PostgreSQL.
Frontend is plain HTML/CSS/JS — no build step required.

---

## 1. How the app works

**Employees**
- Log in, see the current work week (Mon–Sun), and for each day either mark it
  as Sick / Paid / Unpaid leave, or log hours worked per project plus any
  overtime.
- Click **Save Draft** any time; click **Submit Timesheet** by Friday to lock
  it in for the week.
- Once a week is submitted or has ended, it becomes read-only. If they need to
  fix a past week, they click **Request Unlock**, which notifies the admin.
- Can view their full submission history.

**Admins** — everything employees can do, plus:
- View/edit any employee's timesheet, for any week, locked or not.
- Manually lock/unlock any timesheet.
- Approve or deny unlock requests.
- Add/deactivate employees (deactivating keeps their historical data, it just
  blocks login — nothing is hard-deleted).
- Add/archive projects.
- Company-wide dashboard: totals by employee and by project, filterable by
  date range, plus CSV export.

---

## 2. Running it locally (optional, for testing before you deploy)

You'll need [Node.js 18+](https://nodejs.org) and a Postgres database. The
easiest way to get a free Postgres instance is [Neon](https://neon.tech) —
sign up, create a project, and copy the connection string it gives you (it
already includes `?sslmode=require`).

```bash
cd timesheet-app
npm install
cp .env.example .env
# edit .env: paste your DATABASE_URL, set a real JWT_SECRET, and set the
# initial admin email/password you want to log in with
npm start
```

Visit `http://localhost:3000`. The first time it starts, it automatically
creates the database tables and one admin account using the
`INITIAL_ADMIN_*` values from `.env`. **Log in and change that password
immediately** (there's no "change password" button in the UI yet for the
initial account — use the "Reset Password" button for your own account in
the Employees tab, or add a settings page if you want one later).

---

## 3. Deploying for free (Render + Neon)

This combo has no credit card requirement and no time-limited trial — it's
free indefinitely for a small internal tool like this.

### Step A — Create the free database (Neon)
1. Go to https://neon.tech and sign up (free, no card needed).
2. Create a new project. Any region close to your team is fine.
3. Copy the **connection string** shown (starts with `postgresql://...`,
   ends with `?sslmode=require`). Keep this handy.

### Step B — Push this code to GitHub
1. Create a new **private** GitHub repository.
2. Push this `timesheet-app` folder to it:
   ```bash
   cd timesheet-app
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

### Step C — Deploy on Render
1. Go to https://render.com and sign up (free, no card needed).
2. Click **New +** → **Web Service**, connect your GitHub repo.
3. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. Under **Environment Variables**, add:
   - `DATABASE_URL` → the Neon connection string from Step A
   - `JWT_SECRET` → any long random string (see the generator command in `.env.example`)
   - `INITIAL_ADMIN_NAME` → e.g. `Admin`
   - `INITIAL_ADMIN_EMAIL` → the real email you'll log in with
   - `INITIAL_ADMIN_PASSWORD` → a strong temporary password
   - `NODE_ENV` → `production`
5. Click **Create Web Service**. Render will build and deploy it, giving you
   a URL like `https://your-app.onrender.com`.
6. Visit that URL, log in with your admin email/password, and start adding
   employees and projects from the Admin Dashboard.

**Note on the free tier:** Render's free web services "sleep" after 15
minutes with no traffic and take ~30-60 seconds to wake up on the next
visit. For a tool employees check once a day (mainly Fridays), this is a
non-issue — just a brief spinner on the first load of the day.

### Step D — Give employees accounts
Use **Admin Dashboard → Employees → Add Employee**. Each time you add
someone, the app shows you a one-time temporary password — share it with
them securely (Slack DM, in person, etc.) and have them log in at your
Render URL.

---

## 4. Keeping it free long-term

- Neon's free tier easily covers a 10-15 person team's timesheet data (this
  app's data footprint is tiny — a few thousand rows a year).
- Render's free web service tier doesn't expire.
- If your team grows a lot, or you want to remove the sleep/wake delay, the
  cheapest upgrade path is Render's paid "Starter" instance (~$7/month) —
  nothing about the code needs to change.

---

## 5. Project structure

```
timesheet-app/
  server.js              # Express app entry point
  db/schema.sql           # Postgres schema (auto-applied on startup)
  db/pool.js              # Postgres connection pool
  timesheetService.js     # Shared business logic (lock rules, entry storage)
  middleware/auth.js       # JWT auth + admin-role guard
  routes/
    auth.js               # login/logout/me
    timesheets.js          # employee timesheet CRUD, submit, unlock requests
    projects.js             # project list/add/archive
    employees.js            # employee add/deactivate/reset password
    admin.js                 # admin views over all timesheets, stats, CSV export
  public/                  # plain HTML/CSS/JS frontend
    index.html              # login page
    employee.html + js/employee.js   # weekly timesheet UI
    admin.html + js/admin.js          # admin dashboard
```

## 7. Upgrading an existing local/test database

If you've already been testing this app and your database has old test data
in it, the schema for timesheet entries changed (overtime removed, new leave
types added). The app applies a safe, idempotent migration automatically on
startup — just restart the server (`npm start`) and it will update the table
structure in place. Existing rows using the old `paid_leave` type or the old
`overtime_hours` column will need to be re-entered under the new categories,
since there's no way to know which new category old data should map to.

If you'd rather start clean, you can also just wipe the test data instead:
in the Neon SQL editor (or any Postgres client), run:
```sql
DROP TABLE IF EXISTS unlock_requests, timesheet_entries, timesheets, projects, users CASCADE;
```
Then restart the server — it will recreate everything, including a fresh
initial admin account from your `.env` values.

## 8. Security notes

- Passwords are hashed with bcrypt; sessions use signed JWT cookies
  (httpOnly, so JavaScript can't read them).
- Set a real, random `JWT_SECRET` in production — don't leave the example
  value in place.
- All admin-only routes are protected server-side (not just hidden in the
  UI), so an employee can't call admin endpoints directly even if they guess
  the URLs.
- This app is meant for a small trusted internal team on Render's own HTTPS
  domain; if you add a custom domain, Render provisions free SSL for it
  automatically.
