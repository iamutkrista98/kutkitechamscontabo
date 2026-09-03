# KutkiTech Pvt. Ltd. — Attendance Management System

A modern attendance system built for KutkiTech's team, backed by a real MySQL database — the same
kind of database cPanel hosting provides out of the box.

## What's included

- **Staff portal** — sign in, check in / check out with a single tap on the attendance dial,
  request an early checkout with a reason (auto-routed to HR for approval), and view a personal
  monthly report with charts and progress rings.
- **Per-staff shift times** — every employee has their own `shiftName`, `shiftStart` and
  `shiftEnd` (e.g. General Shift 09:00–18:00, Early Shift 07:00–16:00, Day Shift 10:00–19:00).
  Late-arrival and early-checkout logic is evaluated against *that employee's* shift, not a single
  company-wide time. HR sets the shift when adding a staff member and can change it any time.
- **IP address & location tracking** — every check-in and check-out records the device's IP
  address (`checkInIp` / `checkOutIp`) and, if the staff member allows the browser's location
  prompt, their GPS coordinates (`checkInLocation` / `checkOutLocation`, with accuracy in metres).
  HR can see both in **Today's Attendance** and the **Attendance Log**, with a one-click "View on
  map" link. Declining the location prompt never blocks a check-in/out — it's simply logged as
  "Location not shared".
- **Profile photos & self-service password changes** — from their own **My Profile** (staff) or
  **My Account** (HR admin) screen, everyone can upload a profile photo (PNG/JPG/WEBP/GIF, up to
  3MB — stored under `public/uploads/avatars/`, referenced from the database) and change their own
  password (current password required). Uploaded photos replace the colored-initials avatar
  everywhere it appears — sidebar, directory, today's attendance, approvals.
- **IP address, coordinates & nearest area** — every check-in and check-out records the device's IP
  address, GPS coordinates (if the browser's location prompt is allowed), and — via free reverse
  geocoding (OpenStreetMap Nominatim) — the name of the nearest locality/neighbourhood, stored in
  its own database column and its own "Area" column in every export. Declining the location prompt,
  or the geocoding lookup timing out, never blocks a check-in/out — it's just logged as
  "Location not shared" / area left blank.
- **Sunday–Friday work week** — Saturday is the only non-working day. All attendance-rate,
  working-day and trend calculations across the app use this calendar.
- **Excel & PDF exports** — both formatted with the KutkiTech logo, colour palette and a full
  calendar view (Weekly Off / Absent days filled in, not just the days someone happened to check
  in). Staff PDFs render in landscape so every column (including IP, coordinates, area and
  modality) has room to breathe — nothing gets cut off, and the footer no longer adds a stray
  blank page to short reports:
  - *Staff:* the **Monthly Report** view has "⬇ Excel" / "⬇ PDF" buttons that export the signed-in
    employee's own report for the selected month.
  - *HR Admin:* the employee detail modal (Staff Directory → View Report) exports that individual's
    monthly report the same way. The **Attendance Log** view exports the full, currently-filtered
    company-wide record (by date range / department / status) as a multi-sheet Excel workbook
    (Summary + All Records) or a paginated PDF.
  - Built with `exceljs` and `pdfkit` — see `exports.js`.
- **Working modality (Office / Remote)** — every attendance record is compared against KutkiTech's
  office coordinates (`27.721020938138334, 85.29943605581803`). Within ~300m counts as **Office**;
  anything further away, or no location shared at all, is logged as **Remote**. Shown as its own
  column in Today's Attendance, the Attendance Log, staff reports, and every export.
- **Edit & remove staff (HR Admin → Staff Directory)** — HR can edit any enrolled staff member's
  name, email, department, designation, phone, shift times, status and reporting manager, or remove
  them entirely. Removing someone also deletes their attendance history, early-checkout requests and
  leave requests, and clears them as anyone else's manager.
- **Company holiday calendar (HR Admin → Holidays)** — HR can add or remove specific calendar dates
  as company holidays. Holidays are automatically excluded from working-day counts across the
  overview trend, attendance-rate calculations and monthly reports, in addition to the standing
  Saturday weekly off.
- **Leave requests + two-stage approval** — staff can submit a leave request (type, date range,
  reason) from **Leave Requests**, tracked the same way as early-checkout requests. Each employee
  can optionally be assigned a **manager** (any other employee, set from the Staff Directory). If a
  manager is assigned, *both* the manager (from their own staff portal → **Team Approvals**) and HR
  (Approvals → Leave Requests / Early Checkouts) must approve a request before its status flips to
  **Approved** — either one declining rejects it outright. Employees with no manager assigned skip
  straight to HR-only approval.
- **Approved leave is leave-aware everywhere** — a day covered by an *approved* leave request no
  longer counts as an unexplained absence: it's excluded from the working-day denominator in
  attendance-rate calculations, shown as its own "On Leave" figure on both the staff report and the
  HR overview (today's headcount and the 14-day trend), and rendered as "On Leave" (not "Absent")
  in the full-calendar Excel/PDF exports. Checking in on a day you have approved leave for is
  blocked with an explanatory message instead of silently creating a conflicting record.
- **Attendance correction requests (Staff → Fix Attendance)** — forgot to check in or out on a past
  day? Staff can request a specific check-in/out time for that date with a reason. Nothing changes
  on the record until it clears the same manager + HR approval as everything else — only on final
  approval is the correction actually applied to that day's attendance.
- **Manual attendance adjustment (HR Admin → Attendance Log → "Adjust attendance")** — HR can
  directly create, correct, or clear any staff member's attendance for any date, immediately, no
  approval step (HR overriding *is* the approval). Every manual change is stamped with who made it
  and when for an audit trail.
- **Exempt specific staff from approval** — toggle **"No approval required"** per employee (Staff
  Directory → Add/Edit). Their early-checkout, leave, and correction requests are still logged
  normally but are auto-approved the instant they're submitted — useful for founders/leadership who
  don't need their own sign-off chain.
- **Auto check-in / check-out** — toggle **"Auto check-in / check-out"** per employee to have the
  system check them in at their shift start and out at their shift end automatically, no tap
  required (skipped on days they have approved leave). Runs as an in-process scheduler that ticks
  every minute — no external cron needed, it just requires the server process to stay running
  (which `npm start` already keeps alive).
- **HR Admin portal** — company-wide dashboard with live KPIs and trend charts, today's attendance
  log, an approvals queue for early-checkout requests, a searchable staff directory (add staff with
  shift assignment, view individual performance reports with charts), and a filterable historical
  attendance log.
- **Live headcount on the sign-in screen** — the "Staff on roll" / "Departments" numbers on the
  login page are read straight from the database (`GET /api/public/stats`), not hardcoded, so they
  always match who's actually enrolled.
- **MySQL database** — the standard database cPanel hosting provides, accessed via `mysql2`. See
  `db.js` for the schema (`employees` / `admins` / `attendance` / `requests` / `leaveRequests` /
  `holidays` / `corrections` tables, plus biometric device + password-reset tables) and
  **cPanel / MySQL deployment** below for the full setup checklist.
- KutkiTech-branded UI (desktop, tablet, mobile) built around the KutkiTech mark — deep circuit-blue
  and growth-green, with the logo used throughout the sign-in screen, sidebar and dial.
- **Branded email notifications** — every step of the early-checkout, leave, and correction
  approval flows sends a themed HTML email (KutkiTech logo, navy/green palette, a status pill, and
  a button back into the right dashboard): a receipt when someone submits a request, a "needs your
  approval" note to whoever's turn it is next (their manager, then HR), and an update to the
  employee every time a decision is made. Nobody's expected to reply — every email says so and
  points people back to their dashboard instead. See **Email notifications** below for setup.

## Getting started

This app uses **MySQL** (works with MariaDB too — including cPanel's default database).

1. Create a database + user (locally, or in cPanel → MySQL Databases) and note the host, port,
   database name, username, and password.
2. Copy `.env.example` to `.env` and fill in your database credentials:
   ```bash
   cp .env.example .env
   ```
3. Install and seed:
   ```bash
   npm install
   node seed.js       # creates all tables + seeds the KutkiTech starter team (run once)
   npm start           # starts the server on http://localhost:3000
   ```

Open `http://localhost:3000` in your browser. The first time a staff member checks in or out,
their browser will prompt for location access — allow it to see the location captured in the HR
admin views.

Re-running `node seed.js` at any time resets `employees`/`admins` to the starter roster below and
clears `attendance`/`requests` — handy in development, but **don't run it against a live database
with real attendance history you want to keep.**

### The starter team (edit freely in `seed.js`)

KutkiTech ships seeded with its actual 5-person team across 4 departments (Management, Sales, IT,
Design) — including one reporting relationship already set up (an intern and a designer each report
to a co-founder) so you can try out manager approvals immediately. Add real people through the HR
Admin → "Add Staff Member" form, or edit/remove anyone from **Staff Directory** as the team changes.

### Demo logins

Credentials are intentionally **not** shown on the sign-in screen. For your own reference:

| Role | Email | Password |
|---|---|---|
| HR Admin | `admin@kutkitech.com` | `Admin@123` |
| Staff (any seeded employee) | see `seed.js` for the full list, e.g. `pointertechnepal@gmail.com` (a manager) | `Welcome@123` |

New staff added through the HR Admin → "Add Staff Member" form are issued the temporary password
`Welcome@123` as well. Everyone — staff and HR admin alike — can change their own password from
their profile screen once signed in.

## How early checkout works

1. A staff member taps **Check Out** more than 15 minutes before *their own* shift ends.
2. The system asks for a short reason instead of completing the checkout silently.
3. The reason — along with IP address and location, if shared — is logged immediately under
   **Early Checkouts** (staff side) and **Approvals** (HR side) with a "Pending" status.
4. If the employee has a manager assigned, the manager reviews it too, from their own staff portal
   under **Team Approvals**. Both the manager's decision and HR's decision must be "Approved" for
   the request's overall status to flip to **Approved** — either one declining makes it "Rejected"
   immediately, regardless of what the other reviewer does. Employees with no manager skip straight
   to HR-only approval.

## How leave requests work

Leave requests (**Leave Requests** on the staff side) follow the exact same two-stage approval flow
as early checkouts: submit a leave type, date range and reason; it needs both the employee's manager
(if one is assigned) and HR to approve before it's confirmed. Assign or change someone's manager from
**Staff Directory → Edit**.

## How company holidays work

HR defines specific calendar dates as holidays from **Holidays** in the admin dashboard. Every
working-day calculation in the app — the Overview trend, attendance-rate percentages, and monthly
reports — automatically excludes those dates, in addition to the standing Saturday weekly off.

## How attendance corrections & manual adjustments work

There are two different paths to fixing a wrong or missing attendance record, for two different
situations:

- **Staff forgot to check in/out** → they submit a **correction request** (Fix Attendance) for that
  specific past date with the time(s) it should have been and a reason. This goes through the same
  manager + HR approval as everything else, and the attendance record isn't touched until it's
  fully approved.
- **HR needs to fix something directly** (a mishap, a bulk correction, backfilling before the
  system was in use, etc.) → **Attendance Log → "Adjust attendance"** lets HR create, edit, or clear
  any staff member's record for any date immediately. This is HR's own authority acting directly —
  there's no additional approval step, but every change is stamped with who made it and when.

Staff marked **"No approval required"** skip the review step entirely for both correction and
early-checkout/leave requests — their request is auto-approved (and, for corrections, applied) the
moment it's submitted.

## Email notifications

Out of the box, no email server is configured — the app logs what *would* have been sent to the
console instead, so it runs and can be demoed without any setup. To actually send mail, set these
environment variables (e.g. in a `.env` file, or however your host injects them) before starting
the server:

| Variable | Required | Description |
|---|---|---|
| `SMTP_HOST` | Yes | Your mail provider's SMTP host (e.g. `smtp.gmail.com`, `smtp.sendgrid.net`, your own mail server). Without this set, mail is logged, not sent. |
| `SMTP_PORT` | No | Defaults to `587`. |
| `SMTP_SECURE` | No | Set to `true` for a port that expects TLS from the start (e.g. `465`). Leave unset for STARTTLS on `587`. |
| `SMTP_USER` / `SMTP_PASS` | Usually | Credentials for your SMTP provider — for Gmail/Google Workspace this is an [app password](https://support.google.com/accounts/answer/185833), not your normal login password. |
| `MAIL_FROM_EMAIL` | No | The "administration" address mail is sent from. Defaults to the HR admin account's own email (from the `admins` table) if not set. |
| `MAIL_FROM_NAME` | No | Display name on outgoing mail. Defaults to `KutkiTech Administration`. |
| `APP_URL` | Recommended | Base URL used to build the "open your dashboard" links in every email (e.g. `https://attendance.kutkitech.com`). Defaults to `http://localhost:3000`, which only works for local testing. |

All notification mail is one-way — every email states the mailbox isn't monitored and directs the
person back into the app to act, rather than expecting a reply (`Reply-To` is set, but nothing
reads what arrives there). The KutkiTech logo is embedded directly in each email (not linked), so
it displays correctly even in mail clients that block remote images by default.

Every email send is wrapped so a failure (bad credentials, provider downtime, no `SMTP_HOST` set at
all) never breaks the underlying request — worst case, the in-app notification/badge still works
and the email is silently skipped with a console log.

## Project structure

```
attendance-system/
├── server.js          Express server + all API routes
├── exports.js          Excel (exceljs) + PDF (pdfkit) report builders
├── db.js              MySQL database layer (schema + load/save helpers) — see below
├── mailer.js           SMTP transport + branded HTML email template
├── notifications.js    Wires approval-workflow steps to mailer.js
├── seed.js             Creates the schema + seeds the starter team
├── zkteco.js / zkSync.js  ZKTeco K40 biometric device integration
├── .env                Database + mail + session config (create from .env.example, not committed)
├── data/
│   └── sessions/         File-based session store (created on first run)
├── public/
│   ├── index.html       Sign-in screen (staff), live headcount
│   ├── adminlogin.html   Sign-in screen (HR admin)
│   ├── staff.html        Staff dashboard
│   ├── admin.html        HR admin dashboard
│   ├── css/style.css     KutkiTech design system
│   ├── img/logo.png      KutkiTech logo, used across all screens
│   └── js/                Client-side logic per page
└── package.json
```

### How `db.js` works

`db.js` exposes two async functions (`load(table)` / `save(table, data)`) that the rest of the app
uses for every read/write — `server.js` and `exports.js` never touch SQL directly for the core
tables:

- `await load('employees')` → runs `SELECT * FROM employees`, maps each row back into the same
  camelCase shape (`employeeId`, `shiftStart`, …) the rest of the app expects.
- `await save('employees', employees)` → replaces the table's contents with the given array,
  inside one transaction (delete-all + bulk re-insert). At this company's scale (a handful of
  staff, at most a few thousand attendance rows a year) this is fast, atomic, and keeps
  `server.js`/`exports.js` simple — no per-field UPDATE statements to keep in sync.
- A raw `query(sql, params)` helper is also exported for the handful of places (password reset/OTP,
  the biometric device sync log) that need a specific SQL statement rather than a whole-table
  read/write.

Location (`checkInLocation`/`checkOutLocation`) is stored as separate `lat`/`lng`/`accuracy`
columns rather than a JSON blob, so the data stays queryable with plain SQL.

## cPanel / MySQL deployment

1. **Create the database.** cPanel → MySQL Databases → create a database and a user, add the user
   to the database with **All Privileges**. cPanel usually prefixes both with your account
   username (e.g. `cpaneluser_kutkitech`, `cpaneluser_kutki`) — that's normal and expected.
2. **Set up the Node.js app.** cPanel → Setup Node.js App → create an application, point it at this
   folder, set the Node version (18+), and the startup file to `server.js`.
3. **Set environment variables** in the Node.js App panel (or in a `.env` file in this folder,
   copied from `.env.example`):
   ```
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=cpaneluser_kutki
   DB_PASSWORD=your-db-password
   DB_NAME=cpaneluser_kutkitech
   SESSION_SECRET=some-long-random-string
   APP_URL=https://attendance.yourcompany.com
   ```
   (Add `SMTP_*`/`MAIL_FROM_*` too if you want approval emails to actually send — see "Email
   notifications" below; without them the app runs fine and just logs what it would have sent.)
4. **Install dependencies and seed** from the cPanel terminal (or SSH), inside the app's virtual
   environment (cPanel's Node.js App panel has an "Enter virtual environment" command it shows
   you):
   ```bash
   npm install
   node seed.js
   ```
5. **Start/restart the app** from the Node.js App panel.

### Why MySQL instead of a local file

Unlike a local SQLite file, MySQL is a proper client/server database — every request gets its own
connection from a pool (10 by default, `DB_POOL_SIZE` to change it), so concurrent requests (several
staff checking in around the same minute, HR pulling a report while someone else checks out) are
handled as genuinely separate, isolated connections rather than one request queuing behind
another's file lock. Combined with the app's own write-serialization queue (see "Notes for
production use" below) for the specific case of two people editing the *same* attendance row at the
same moment, this is safe for concurrent use on a single Node process — which is what cPanel's
Node.js App (via Phusion Passenger) runs by default.

### Deploying elsewhere (not cPanel)

Any host that can run Node.js and reach a MySQL server works the same way — set the same `DB_*`
environment variables and run `node seed.js` once. A managed MySQL host (PlanetScale, AWS RDS,
DigitalOcean Managed MySQL, etc.) works identically; just point `DB_HOST` at it.

## Performance & scalability

The database layer is built around two different access patterns, chosen per table by how often
it's written:

- **`employees` / `admins` / `settings` / `holidays`** — small, rarely-written tables (a few
  hundred rows at most). These still use the simple `load(table)` / `save(table, data)` whole-table
  read/replace helpers in `db.js` — simplest possible code, and totally fine at this size.
- **`attendance` / `requests` / `leaveRequests` / `corrections`** — the tables that grow every day
  and get written constantly (every check-in, every check-out, every approval decision). These go
  through dedicated row-level repos (`attendanceRepo`, `requestsRepo`, `leaveRequestsRepo`,
  `correctionsRepo` in `db.js`) that do real single-row `INSERT`/`UPDATE`/`SELECT ... WHERE`
  instead of rewriting the whole table on every write. Reports and dashboards query only the date
  range or employee they actually need, rather than loading years of history to look at today.

Reverse-geocoding a check-in's coordinates (an external network call, up to a few seconds) happens
**before** the app's write-serialization lock, not inside it — so one person's slow network lookup
never blocks anyone else's check-in from completing.

### What this was tested against

Verified against a real MySQL/MariaDB instance seeded with **500 employees, ~25,000 attendance
rows (60 days of history), and 2,000 leave request rows** — roughly a school-sized roster with a
couple months of history:

| Scenario | Result |
|---|---|
| 5 different staff checking in at the exact same moment | All 5 succeeded, no lost writes, no corrupted rows |
| 20–30 concurrent check-ins | Completed in ~1.6 seconds total |
| Staff directory (500 people + live leave balances) | ~0.45s for one request |
| HR dashboard overview | ~0.26s |
| Staff directory under 10 concurrent HR-admin loads at once | ~4.2s each — see caveat below |

**Caveat, stated plainly:** the staff directory endpoint (`/api/admin/employees`) is CPU-bound —
building 500 people's worth of computed leave balances and JSON-serializing/compressing the
response takes real work on Node's single JS thread, and that work doesn't parallelize across
concurrent requests to the *same* process the way database I/O does. In practice this endpoint is
only ever hit by the handful of HR/admin users, not by the whole student body — the actual
high-concurrency path (everyone checking in during a morning rush) is the one verified above at
~1.6s for 30 simultaneous requests.

To smooth out the admin-side case anyway, `/api/admin/overview` and `/api/admin/employees` share a
5-second in-memory cache (`cachedAdminRoute()` in `server.js`) — deliberately time-based rather than
invalidate-on-write, since a dashboard being up to 5 seconds stale is unremarkable (the admin
frontend already polls every 60 seconds) and far safer than an invalidation list that's one missed
call site away from serving stale data indefinitely. Re-running the same 10-concurrent-admin stress
test with this in place: **~1.7s per request (down from ~4.2s), total wall time for 20 concurrent
requests dropped from ~4.6s to ~1.9s.** A cold-cache request still takes ~0.28s; a warm-cache one is
~6ms.

## Notes for production use

- Set a `SESSION_SECRET` environment variable before going live (falls back to a fixed dev secret
  otherwise). Session cookies are named `kutkitech.sid` and set `SameSite=Lax`, and the login
  endpoints are rate-limited (20 attempts / 15 min per IP) against brute-forcing — there's still no
  CSRF token system, so `SameSite=Lax` is the only cross-site protection in place.
- Passwords are hashed with bcrypt. Everyone (staff and HR admin) can change their own password from
  their profile screen once signed in, and there's a self-service "Forgot password" flow on both
  sign-in screens — an HR-assisted reset (shows up as a request on the HR dashboard, HR assigns a
  new password) or a self-service email OTP reset. HR can also assign the company default password
  directly from a staff member's profile as a no-email emergency fallback.
- **The actual attendance write (check-in/out, early-checkout, correction requests) is serialized
  through a single in-process queue** (see `serialize()` in `server.js`), guarding against the rare
  case of the same person double-tapping check-in within milliseconds. This queue only wraps the
  fast, single-row database write — reverse-geocoding the location (an external network call that
  can take a few seconds) happens *before* the lock is acquired, specifically so one person's slow
  network lookup can never block anyone else's check-in from completing. MySQL's own connection
  pool handles concurrent writes to *different* rows in parallel on its own; this queue only exists
  for the narrow same-row-same-moment case. It only protects against races within *one* Node
  process — if you ever run multiple server instances behind a load balancer, the row-level
  `INSERT ... ON DUPLICATE KEY UPDATE` in `attendanceRepo.upsert()` (see `db.js`) is already safe
  across processes via MySQL's own unique-index handling; only the "reject a genuine double
  check-in with a friendly error" behavior specifically would need a database-level lock (e.g.
  `SELECT ... FOR UPDATE`) instead of this in-memory queue. Notification emails are deliberately
  fired *after* the response is sent and outside this queue entirely — same reasoning, they're a
  slower network call too.
- Sessions are stored on disk via `session-file-store` (`data/sessions/`) — this survives a server
  restart, unlike Express's default in-memory store, but is still local-disk-only. If you ever run
  more than one server instance behind a load balancer, swap in a shared store (e.g. Redis) so
  everyone's session is visible to every instance.
- **Location data is client-supplied and not cryptographically verified** — someone who wants to
  can spoof their browser's/API's reported latitude/longitude to make the Office/Remote modality
  say whatever they want. Nothing server-side cross-checks it against, e.g., IP-based geolocation or
  office WiFi. Treat the modality column as a helpful signal, not proof, until/unless that's added.
- Back up the MySQL database regularly — in cPanel, MySQL Databases → Backups, or schedule
  `mysqldump` via cron. This is the entire system's data; there's no local file to fall back on.
- Location data is only captured when the staff member's browser grants permission — this is a
  client-side prompt and cannot be forced server-side. Consider disclosing this tracking in an
  employee handbook / consent form for compliance with local labour and data-protection law.
- IP address is read from `X-Forwarded-For` when present (see `app.set('trust proxy', 1)` in
  `server.js`) so it reports correctly behind a reverse proxy or hosting platform's load balancer.
- Late-arrival grace period (5 minutes) and early-checkout threshold (15 minutes) are currently
  fixed constants in `server.js`, evaluated per-employee against their own shift — easy to expose
  as configurable settings later.
- `GET /healthz` checks both that the process is up and that it can actually reach MySQL — point an
  uptime monitor or cPanel's own health check at it rather than just pinging `/`. Responses are
  gzip-compressed (`compression`) and carry baseline security headers (`helmet` — HSTS,
  `X-Content-Type-Options`, `X-Frame-Options`, etc.). The process also shuts down gracefully on
  `SIGTERM`/`SIGINT` (what cPanel/Passenger sends on every restart or redeploy) — it stops accepting
  new connections, lets in-flight requests finish, then closes the MySQL pool cleanly instead of
  dropping requests mid-flight.
- The auto check-in/out scheduler (`setInterval`, once a minute) only runs while the Node process is
  alive — if the server restarts or is down exactly at someone's shift boundary, that day's auto
  entry is simply skipped (HR can always add it with a manual adjustment).
