// server.js — Attendance Management System (multi-organization capable —
// company name, logo, and office location are all admin-configurable at
// runtime via the settings table; nothing about a specific organization
// is hardcoded here).
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const compression = require('compression');
const helmet = require('helmet');
const {
  load, save, query, ensureSchema, pool, attendanceRepo, requestsRepo, leaveRequestsRepo, correctionsRepo,
  getEmployeeById, updateEmployeeAvatar, updateEmployeePassword, updateEmployeeRow, insertEmployeeRow, deleteEmployeeRow,
  getAdminById, updateAdminAvatar, updateAdminPassword, updateSettingsLogo, insertRow, deleteRow
} = require('./db');
const { buildDailyRows, buildStaffExcel, buildStaffPdf, buildOverallExcel, buildOverallPdf } = require('./exports');
const { notifyRequestSubmitted, notifyRequestDecided } = require('./notifications');
const { sendMail } = require('./mailer');
const { toBsShort, toBsFormatted, fiscalYear, fromBs, todayBs, bsMonthRange, currentFiscalYearAdBounds, BS_MONTHS } = require('./nepaliDate');
const zkSync = require('./zkSync');

const app = express();
const PORT = process.env.PORT || 3000;

// A tiny short-TTL cache for the couple of admin-dashboard endpoints that
// do real CPU work building their response (computing every employee's
// live leave balance, etc.) — see the "Performance & scalability" section
// of the README for why. A handful of HR admins hitting the dashboard
// within the same few seconds (e.g. everyone's browser auto-refreshing at
// once) reuses one computed response instead of everyone separately
// paying that CPU cost. Deliberately time-based only (no invalidate-on-
// write plumbing scattered across every endpoint that could affect these
// two views) — a dashboard being up to 5 seconds stale is a normal,
// unremarkable tradeoff, and it's a much safer choice than an invalidation
// list that's one missed call site away from silently serving stale data
// indefinitely.
const adminCache = new Map(); // key -> { expires, body }
const ADMIN_CACHE_TTL_MS = 5000;
function cachedAdminRoute(key, handler) {
  return async (req, res) => {
    const cached = adminCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return res.json(cached.body);
    }
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      adminCache.set(key, { expires: Date.now() + ADMIN_CACHE_TTL_MS, body });
      return originalJson(body);
    };
    await handler(req, res);
  };
}

// Trust the first proxy hop (needed for accurate req.ip when deployed behind
// a reverse proxy / load balancer such as Nginx, Render, Railway, etc.)
app.set('trust proxy', 1);

// gzip every response — the biggest wins are the JSON payloads for the
// attendance log/directory (many rows) and the exported Excel/PDF files,
// which shrink dramatically over the wire.
app.use(compression());

// Baseline security headers. CSP is relaxed rather than left at helmet's
// strict default — the app serves its own inline <script>/<style> blocks
// throughout public/*.html rather than external bundles, so a strict CSP
// would break the UI; this still adds HSTS, X-Content-Type-Options,
// X-Frame-Options, etc. without touching how the frontend is built.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(bodyParser.json());
// The session cookie name is just an internal technical identifier (never
// shown to users) — configurable via SESSION_COOKIE_NAME for an org that
// wants to keep a specific name across an upgrade (e.g. to avoid
// invalidating everyone's existing session), but works unmodified out of
// the box for a fresh deployment.
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'attendance.sid';
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  // Every deployment of this app that forgets to set SESSION_SECRET would
  // otherwise fall back to the same hardcoded string — fine for one
  // developer's local instance, not fine once this is meant to be
  // deployed for many different organizations, since anyone who knows
  // (or finds, e.g. by reading this file on GitHub) the default secret
  // could forge a valid session cookie against any production instance
  // that didn't override it. Fail loudly at startup instead of silently
  // running insecurely.
  console.error('[startup] SESSION_SECRET is not set. Refusing to start in production without one — set a long random value in your environment.');
  process.exit(1);
}
app.use(session({
  name: SESSION_COOKIE_NAME,
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-default-secret-set-SESSION_SECRET-in-env',
  resave: false,
  saveUninitialized: false,
  // Sessions live on disk (data/sessions/) instead of the default
  // in-memory store — MemoryStore leaks memory over time and loses every
  // signed-in user whenever the Node process restarts (which cPanel's
  // Passenger does routinely). A file store survives restarts and keeps
  // memory flat regardless of how long the process has been up.
  store: new FileStore({
    path: path.join(__dirname, 'data', 'sessions'),
    ttl: 60 * 60 * 12, // matches the cookie's 12h maxAge below
    retries: 1,
    logFn: () => {} // the default store logs every read/write to stdout — too noisy
  }),
  // 'lax' blocks the cookie being sent on cross-site POSTs (the common CSRF
  // vector) while still working for normal same-site navigation/fetch calls.
  cookie: { maxAge: 1000 * 60 * 60 * 12, sameSite: 'lax' }
}));
app.use(express.static(path.join(__dirname, 'public')));

// HR/admin sign-in lives at a separate, non-obvious URL rather than a
// toggle on the main sign-in screen — staff only ever see the staff form.
app.get('/adminlogin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'adminlogin.html')));

// Slows down brute-force password guessing on the two login endpoints.
// Everything else is unaffected.
// Two layers, not one — a single per-IP limiter has a real failure mode at
// this app's actual scale: it's geofenced to physical office(s), so a lot
// of legitimate staff often share one NAT'd office IP, and a single
// targeted attacker can trivially defeat a pure-IP limit by rotating
// source IPs/proxies. Splitting the budget fixes both:
//   - ipLoginLimiter: a coarse per-IP ceiling, generous enough that a
//     shift-start rush of hundreds of genuine staff on one office
//     connection is never throttled — this is just a backstop against
//     one network hammering the server, not the primary defense.
//   - emailLoginLimiter: a tight per-ACCOUNT ceiling, keyed on the email
//     in the request body regardless of source IP — this is what
//     actually stops someone brute-forcing one specific person's
//     password, and doesn't care how many different IPs they attack from.
// Both use skipSuccessfulRequests so only failed attempts burn budget —
// a burst of legitimate successful logins (from the same office IP, or
// someone just logging in a lot) never counts against either limit.
const ipLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // sized for a 500-person organization sharing an office connection, not a single account
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts from this network. Please wait a few minutes and try again.' }
});
const emailLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8, // failed attempts against ONE account — this is the real brute-force defense
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `acct:${String((req.body && req.body.email) || '').trim().toLowerCase() || 'unknown'}`,
  message: { error: 'Too many attempts for this account. Please wait a few minutes and try again, or use "Forgot password".' }
});
const loginLimiter = [ipLoginLimiter, emailLoginLimiter];

// ---------------------------------------------------------------------------
// Office location — admin-configurable per organization (Company tab),
// not a hardcoded constant. See getOfficeLocation() near getSettings().
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Profile photo uploads
// ---------------------------------------------------------------------------
// Avatars and the company logo are written straight to disk under
// public/uploads/ (multer's disk storage engine streams the upload directly
// to its final file — no buffering the whole image in process memory, no
// base64 bloat) and the database only ever stores the resulting relative
// URL (e.g. "/uploads/avatars/emp_123-1699999999999-abc12.png") in the
// existing avatar_image / logo_image columns. That keeps big binary blobs
// out of MySQL rows/replication/backups entirely, and <img src> just works
// against the static file server with no extra endpoint or base64 decode
// cost on every page load.
const AVATAR_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
const LOGO_DIR = path.join(__dirname, 'public', 'uploads', 'branding');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
fs.mkdirSync(LOGO_DIR, { recursive: true });

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
function uniqueFilename(prefix, mimetype) {
  const ext = EXT_BY_MIME[mimetype] || 'jpg';
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
}
/** The web-relative path (as stored in the DB / used as <img src>) for a file living under one of the dirs above. */
function toPublicUploadUrl(dir, filename) { return `/uploads/${path.basename(dir)}/${filename}`; }

// Best-effort delete of a previously-stored avatar/logo file when it's
// replaced or removed. Guarded to only ever touch paths under
// public/uploads/ — never trust a stored string blindly with fs calls, and
// this also safely no-ops on a legacy base64 "data:" value left over from
// an earlier version of this app that stored images in the database.
// Awaited (not fire-and-forget) so the delete has actually happened by the
// time the HTTP response goes out — callers that immediately re-check the
// old URL (or just want disk usage to reflect reality right away) can
// rely on it being done, not "probably done soon".
async function deleteOldUpload(publicUrl) {
  if (!publicUrl || typeof publicUrl !== 'string' || !publicUrl.startsWith('/uploads/')) return;
  const resolved = path.normalize(path.join(__dirname, 'public', publicUrl));
  if (!resolved.startsWith(path.join(__dirname, 'public', 'uploads') + path.sep)) return; // guard against path traversal
  try {
    await fs.promises.unlink(resolved);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not delete old upload', resolved, err.message); // already gone is fine; anything else is worth knowing about
  }
}

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => {
      const ownerId = (req.session && (req.session.employeeId || req.session.adminId)) || 'user';
      cb(null, uniqueFilename(ownerId, file.mimetype));
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Please upload a PNG, JPG, WEBP or GIF image.'));
    }
    cb(null, true);
  }
}).single('image');

const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOGO_DIR),
    filename: (req, file, cb) => cb(null, uniqueFilename('logo', file.mimetype))
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    if (!/^image\/(png|jpe?g)$/.test(file.mimetype)) {
      return cb(new Error('Please upload a PNG or JPG image — this format needs to work in Excel/PDF exports too.'));
    }
    cb(null, true);
  }
}).single('logo');

// ---------------------------------------------------------------------------
// One-time startup migration: an earlier version of this app (briefly)
// stored avatars/logo as base64 "data:" URIs directly in the database.
// If any of those are still on file, decode them back out to real files
// under public/uploads/ and point the DB row at the file instead — so any
// install that already ran that version upgrades cleanly instead of being
// stuck with giant base64 rows (and broken cache-busting/exports) forever.
// ---------------------------------------------------------------------------
function decodeDataUriToFile(dataUri, dir, prefix) {
  const match = /^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/.exec(dataUri);
  if (!match) return null;
  const filename = uniqueFilename(prefix, match[1]);
  fs.writeFileSync(path.join(dir, filename), Buffer.from(match[2], 'base64'));
  return toPublicUploadUrl(dir, filename);
}
async function migrateDbStoredImagesToDisk() {
  const employees = await load('employees');
  for (const e of employees) {
    if (e.avatarImage && e.avatarImage.startsWith('data:')) {
      const url = decodeDataUriToFile(e.avatarImage, AVATAR_DIR, e.id);
      if (url) await updateEmployeeAvatar(e.id, url);
    }
  }
  const admins = await load('admins');
  for (const a of admins) {
    if (a.avatarImage && a.avatarImage.startsWith('data:')) {
      const url = decodeDataUriToFile(a.avatarImage, AVATAR_DIR, a.id);
      if (url) await updateAdminAvatar(a.id, url);
    }
  }
  const settingsRows = await load('settings');
  for (const s of settingsRows) {
    if (s.logoImage && s.logoImage.startsWith('data:')) {
      const url = decodeDataUriToFile(s.logoImage, LOGO_DIR, 'logo');
      if (url) await updateSettingsLogo(s.id, url);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
function minutesBetween(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}
function publicEmployee(e) {
  if (!e) return null;
  const { passwordHash, ...rest } = e;
  return { ...rest, joinDateMiti: toBsShort(e.joinDate) };
}
async function requireEmployee(req, res, next) {
  if (!req.session.employeeId) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const emp = (await load('employees')).find(e => e.id === req.session.employeeId);
    if (!emp) return res.status(401).json({ error: 'Not signed in.' });
    if (emp.status === 'inactive') {
      req.session.destroy(() => {});
      return res.status(403).json({ error: 'This account has been deactivated. Contact HR if you believe this is a mistake.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Not signed in as HR admin.' });
  next();
}

// Thrown by the performX() helpers below to carry a specific HTTP status +
// JSON body back up to the route handler, so business-logic errors (e.g.
// "already checked in") keep their original status codes even though the
// logic now runs inside the write queue.
class ApiError extends Error {
  constructor(status, body) {
    super(body.error || 'Request failed.');
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// Write serialization
// ---------------------------------------------------------------------------
// check-in / check-out / early-checkout all do: load a table, `await` a
// reverse-geocoding network call, then save the table back. Node frees the
// event loop during that await, so a second request (another person
// checking in seconds later) can load-mutate-save the same table in between
// — and whichever await save() runs last silently overwrites the other's change.
// Routing every read-modify-write flow that spans an await through this
// single in-process queue makes them run one at a time, closing that
// window. A single global queue (rather than per-table) is intentionally
// simple — for a company of this size the tiny bit of extra serialization
// is free, and it avoids any risk of a multi-lock deadlock.
let writeQueue = Promise.resolve();
function serialize(fn) {
  const result = writeQueue.then(fn, fn);
  writeQueue = result.then(() => {}, () => {}); // never let one failure jam the queue
  return result;
}

// Returns the employee's approved leave request covering `dateStr` (if
// any). Used to keep attendance status/reports honest about approved leave
// instead of counting those days as unexplained absences, and to stop
// someone from checking in on a day they're approved to be off.
async function approvedLeaveOn(employeeId, dateStr, preloadedLeaveRequests) {
  const leaveRequests = preloadedLeaveRequests || await load('leaveRequests');
  return leaveRequests.find(r => r.employeeId === employeeId && r.status === 'approved' && dateStr >= r.fromDate && dateStr <= r.toDate) || null;
}

// Every 'YYYY-MM-DD' an employee is on approved leave for, within [from, to].
async function approvedLeaveDatesInRange(employeeId, from, to, preloadedLeaveRequests) {
  const leaveRequests = (preloadedLeaveRequests || await load('leaveRequests')).filter(r => r.employeeId === employeeId && r.status === 'approved');
  const dates = new Set();
  leaveRequests.forEach(r => {
    const start = new Date(Math.max(new Date(r.fromDate), new Date(from)));
    const end = new Date(Math.min(new Date(r.toDate), new Date(to)));
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      dates.add(d.toISOString().slice(0, 10));
    }
  });
  return dates;
}

// ---------------------------------------------------------------------------
// Leave balances
// ---------------------------------------------------------------------------
// Leave types HR assigns a fixed number of days for and that get validated
// against on request. "Unpaid Leave" and "Other" are intentionally left out
// — unpaid leave has no cap by definition, and "Other" is a catch-all HR
// reviews manually — so neither blocks a request for lack of a balance.
const BALANCE_TRACKED_LEAVE_TYPES = ['Casual Leave', 'Sick Leave', 'Annual Leave'];
// Starting balances for a newly-created employee, used unless HR overrides
// them on the Add Staff form.
const DEFAULT_LEAVE_BALANCES = { 'Casual Leave': 12, 'Sick Leave': 8, 'Annual Leave': 15 };

// Inclusive day count between two 'YYYY-MM-DD' strings.
function leaveDaysCount(fromDate, toDate) {
  const ms = new Date(toDate) - new Date(fromDate);
  return Math.round(ms / 86400000) + 1;
}

// Days of `leaveType` already used up by this employee's approved requests,
// counting only requests that fall inside the *current Nepali fiscal year*
// (1 Shrawan – end of Ashadh). This is what makes balances "reset" every
// Shrawan 1 automatically — last fiscal year's approved leave simply stops
// being inside the window, with nothing to explicitly zero out. A request
// is counted if it starts within the current FY (a leave spanning the FY
// boundary is attributed to the year it started in, so it's counted once).
// Optionally excludes one request id, e.g. the one currently being
// re-evaluated for approval.
async function leaveUsed(employeeId, leaveType, excludeRequestId, preloadedLeaveRequests) {
  const fy = currentFiscalYearAdBounds();
  const leaveRequests = preloadedLeaveRequests || await load('leaveRequests');
  return leaveRequests
    .filter(r => r.employeeId === employeeId && r.leaveType === leaveType && r.status === 'approved' && r.id !== excludeRequestId)
    .filter(r => !fy || (r.fromDate >= fy.startAD && r.fromDate <= fy.endAD))
    .reduce((sum, r) => sum + leaveDaysCount(r.fromDate, r.toDate), 0);
}

// { assigned, used, remaining } for one employee + leave type. Falls back to
// the standard default for any type HR hasn't explicitly set yet (e.g.
// employees created before this feature existed) so nobody is left with an
// unintended 0-day balance.
async function leaveBalanceFor(emp, leaveType, excludeRequestId, preloadedLeaveRequests) {
  const explicit = emp.leaveBalances && emp.leaveBalances[leaveType];
  const assigned = explicit !== undefined && explicit !== null ? explicit : (DEFAULT_LEAVE_BALANCES[leaveType] || 0);
  const used = await leaveUsed(emp.id, leaveType, excludeRequestId, preloadedLeaveRequests);
  return { assigned, used, remaining: Math.max(0, assigned - used) };
}

// { 'Casual Leave': {assigned, used, remaining}, ... } for every
// balance-tracked type — used by the admin directory/edit UI so it always
// shows live remaining balances instead of just the raw assigned number.
async function leaveBalanceSummary(emp, preloadedLeaveRequests) {
  const summary = {};
  for (const type of BALANCE_TRACKED_LEAVE_TYPES) { summary[type] = await leaveBalanceFor(emp, type, undefined, preloadedLeaveRequests); }
  return summary;
}

// Starting manager/admin decision state for a new early-checkout, leave, or
// correction request. Staff marked exemptFromApproval skip the whole review
// pipeline — their request is auto-approved the instant it's submitted (it
// still shows up in the log, just already decided), while for everyone else
// it starts pending and follows the normal manager+HR flow.
function initialDecisionState(emp) {
  if (emp.exemptFromApproval) {
    const ts = todayStr();
    return {
      managerDecision: 'not_required', managerReviewedBy: null, managerReviewedAt: null,
      adminDecision: 'approved', adminReviewedBy: 'Auto-approved (exempted staff)', adminReviewedAt: ts,
      status: 'approved'
    };
  }
  const managerDecision = emp.managerId ? 'pending' : 'not_required';
  return {
    managerDecision, managerReviewedBy: null, managerReviewedAt: null,
    adminDecision: 'pending', adminReviewedBy: null, adminReviewedAt: null,
    status: computeApprovalStatus(managerDecision, 'pending')
  };
}

// Creates or updates a single day's attendance record for an employee —
// shared by (a) applying an approved correction request and (b) HR's direct
// manual adjustment tool. `statusOverride`, if given, is trusted as-is
// (e.g. HR marking a day "on-leave" outright); otherwise status/lateBy are
// recalculated from the employee's shift the same way a normal check-in is.
async function upsertAttendance({ employeeId, date, checkIn, checkOut, statusOverride, source, adjustedBy }) {
  const employees = await load('employees');
  const emp = employees.find(e => e.id === employeeId);
  let rec = await attendanceRepo.getByEmpDate(employeeId, date);
  if (!rec) {
    rec = {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      employeeId, date, checkIn: null, checkOut: null, status: 'present', lateBy: 0,
      earlyCheckout: false, hoursWorked: 0,
      checkInIp: null, checkInLocation: null, checkOutIp: null, checkOutLocation: null,
      source: null, adjustedBy: null, adjustedAt: null
    };
  }
  if (checkIn) rec.checkIn = checkIn;
  if (checkOut) rec.checkOut = checkOut;
  if (statusOverride) {
    rec.status = statusOverride;
  } else if (emp && rec.checkIn) {
    rec.lateBy = Math.max(0, minutesBetween(emp.shiftStart, rec.checkIn));
    rec.status = rec.lateBy > 5 ? 'late' : 'present';
  }
  if (rec.checkIn && rec.checkOut) {
    rec.hoursWorked = +(minutesBetween(rec.checkIn, rec.checkOut) / 60).toFixed(2);
  }
  rec.source = source || rec.source || 'manual';
  if (adjustedBy) { rec.adjustedBy = adjustedBy; rec.adjustedAt = todayStr(); }
  await attendanceRepo.upsert(rec);
  return rec;
}

// Removes an employee's attendance record for a given date entirely (used
// when HR wants to mark a day as a plain, unrecorded absence).
async function clearAttendance(employeeId, date) {
  return attendanceRepo.deleteByEmpDate(employeeId, date);
}

async function getHolidaySet() {
  return new Set((await load('holidays')).map(h => h.date));
}

// Which weekdays are the standing non-working days (0=Sun..6=Sat), set by
// HR under Company Settings — defaults to Saturday-only (Sun-Fri work
// week) if never configured. Stored as a comma-separated string of day
// numbers so existing exports/reports code and the settings row don't
// need any deeper schema change.
async function getWeeklyOffDays() {
  const s = await getSettings();
  const raw = (s.weeklyOffDays || '6').split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 6);
  return new Set(raw.length ? raw : [6]);
}

// Work week: whichever weekdays HR hasn't marked as a standing weekly off,
// minus any HR-defined holiday.
async function isWorkingDay(date, holidaySet, weeklyOffSet) {
  const offDays = weeklyOffSet || await getWeeklyOffDays();
  if (offDays.has(date.getDay())) return false;
  if (holidaySet) {
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (holidaySet.has(iso)) return false;
  }
  return true;
}

// Resolve the caller's IP address, unwrapping IPv6-mapped IPv4 and
// preferring the left-most entry of X-Forwarded-For when present.
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  let ip = fwd ? fwd.split(',')[0].trim() : req.ip || req.socket.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

// Extract a best-effort geolocation reading sent by the browser (from the
// Geolocation API). Returns null if the client didn't provide one, e.g.
// because the person declined the permission prompt.
function getClientLocation(req) {
  const { latitude, longitude, accuracy } = req.body || {};
  if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
    return null;
  }
  const lat = Number(latitude), lng = Number(longitude);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { latitude: lat, longitude: lng, accuracy: accuracy ? Number(accuracy) : null };
}

// Looks up the name of the nearest locality/neighbourhood for a
// latitude/longitude pair via OpenStreetMap's free Nominatim reverse
// geocoding API, so HR sees a human-readable place name alongside the raw
// coordinates. Times out fast and fails silently (returns null) — a slow or
// unreachable geocoding service should never block someone's check-in.
async function reverseGeocodeArea(lat, lng) {
  if (lat === undefined || lat === null || lng === undefined || lng === null) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`;
    const resp = await fetch(url, {
      signal: controller.signal,
      // Nominatim's usage policy requires a genuinely identifying
      // User-Agent + contact for their free tier — configurable per
      // deployment (each organization running this app is a distinct
      // Nominatim client) rather than hardcoding one org's contact email
      // into every install.
      headers: { 'User-Agent': `${process.env.APP_NAME || 'AttendanceSystem'}/1.0 (${process.env.SUPPORT_EMAIL || 'support@example.com'})` }
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    const addr = data.address || {};
    return addr.suburb || addr.neighbourhood || addr.quarter || addr.village || addr.town
      || addr.city_district || addr.municipality || addr.city || addr.county || null;
  } catch (err) {
    return null; // network hiccup, timeout, or geocoder unavailable — non-fatal
  }
}

// Resolves a location object's area name (mutating a copy), used right
// before saving a check-in/check-out so the attendance record stores a
// place name alongside raw coordinates, in its own column.
async function withArea(location) {
  if (!location) return null;
  const area = await reverseGeocodeArea(location.latitude, location.longitude);
  return { ...location, area };
}

// Great-circle distance between two lat/lng points, in meters (haversine).
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// "Working modality" for an attendance record — compares the check-in (or
// check-out, whichever is available) coordinates against the organization's
// configured office location (Company tab → Office location; see
// getOfficeLocation()). Within office.radiusMeters => "Office", otherwise
// => "Remote". No location captured at all, or no office location
// configured yet, also falls back to "Remote".
function workingModalityFor(record, office) {
  // A biometric punch happens at the physical device — there's no GPS
  // coordinate to check because there's no phone/browser involved, but the
  // location is unambiguous: whichever office the device is installed at.
  if (record && record.source === 'biometric') return 'Office';
  const loc = (record && (record.checkOutLocation || record.checkInLocation)) || null;
  if (!loc || loc.latitude === undefined || loc.latitude === null) return 'Remote';
  if (!office || office.latitude === null || office.latitude === undefined || office.longitude === null || office.longitude === undefined) {
    return 'Remote'; // no office location configured for this organization yet
  }
  const dist = distanceMeters(loc.latitude, loc.longitude, office.latitude, office.longitude);
  return dist <= (office.radiusMeters || 300) ? 'Office' : 'Remote';
}

// Combines a manager's decision and an admin's decision into the single
// overall status the rest of the app displays. Both must approve; either
// rejecting rejects the whole request. An employee with no manager has
// their manager step marked 'not_required', so admin approval alone can
// finalize it.
function computeApprovalStatus(managerDecision, adminDecision) {
  if (managerDecision === 'rejected' || adminDecision === 'rejected') return 'rejected';
  if ((managerDecision === 'approved' || managerDecision === 'not_required') && adminDecision === 'approved') return 'approved';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Organization settings — company name + logo. A single row, seeded with
// a sensible default the first time it's read. This is what lets the app
// be reconfigured for a different organization from the admin UI alone,
// rather than hardcoded branding throughout the codebase.
// ---------------------------------------------------------------------------
async function getSettings() {
  let rows = await load('settings');
  if (!rows.length) {
    // A neutral, obviously-placeholder default — this app is meant to be
    // deployed fresh for any organization, not just the one it was
    // originally built for. First-run setup (Company tab) is where a real
    // admin sets the actual name, logo, and office location.
    rows = [{ id: 'main', companyName: 'Your Company', logoImage: null }];
    await save('settings', rows);
  }
  return rows[0];
}

// Reads the org's configured office location for the "Office vs Remote"
// geofence check. This used to be a hardcoded constant in this file (one
// specific lat/lng baked into the source), which meant every deployment
// of this app was physically pinned to a single organization's office and
// had to be hand-edited in code to run anywhere else. It's now read from
// settings (Company tab → Office location), with radiusMeters falling
// back to a sane default. latitude/longitude are null until an admin
// configures it — callers must treat null as "not configured", not 0,0
// (which is a real place, off the coast of Africa).
async function getOfficeLocation() {
  const s = await getSettings();
  return {
    latitude: s.officeLatitude === null || s.officeLatitude === undefined ? null : Number(s.officeLatitude),
    longitude: s.officeLongitude === null || s.officeLongitude === undefined ? null : Number(s.officeLongitude),
    radiusMeters: s.officeRadiusMeters || 300
  };
}

// Public — needed on the sign-in screens, before anyone is authenticated.
// Office coordinates are deliberately left out of this public payload —
// there's no reason to expose an organization's exact office location to
// an unauthenticated caller; only the admin-configuration screen needs it,
// and that's gated behind requireAdmin below.
app.get('/api/settings', async (req, res) => {
  try {
    const s = await getSettings();
    const payload = { companyName: s.companyName, logoImage: s.logoImage, weeklyOffDays: Array.from(await getWeeklyOffDays()).sort(), autoSyncEnabled: !!s.autoSyncEnabled, autoSyncTime: s.autoSyncTime || '08:00' };
    if (req.session && req.session.adminId) {
      payload.officeLatitude = s.officeLatitude;
      payload.officeLongitude = s.officeLongitude;
      payload.officeRadiusMeters = s.officeRadiusMeters || 300;
    }
    res.json(payload);
  } catch (err) {
    console.error('GET /api/settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.patch('/api/settings', requireAdmin, async (req, res) => {
  try {
    const s = await getSettings();
    if (req.body.companyName !== undefined) {
      const name = String(req.body.companyName).trim();
      if (!name) return res.status(400).json({ error: 'Company name cannot be empty.' });
      s.companyName = name;
    }
    if (req.body.weeklyOffDays !== undefined) {
      const days = Array.isArray(req.body.weeklyOffDays) ? req.body.weeklyOffDays.map(Number).filter(n => n >= 0 && n <= 6) : [];
      if (!days.length) return res.status(400).json({ error: 'At least one weekly off day is required.' });
      s.weeklyOffDays = Array.from(new Set(days)).sort().join(',');
    }
    if (req.body.autoSyncEnabled !== undefined) {
      s.autoSyncEnabled = !!req.body.autoSyncEnabled;
    }
    if (req.body.autoSyncTime !== undefined) {
      if (!/^\d{2}:\d{2}$/.test(req.body.autoSyncTime)) return res.status(400).json({ error: 'Auto-sync time must be in HH:MM format.' });
      s.autoSyncTime = req.body.autoSyncTime;
    }
    if (req.body.officeLatitude !== undefined || req.body.officeLongitude !== undefined) {
      // Both or neither — a lat with no lng (or vice versa) is a broken
      // geofence, so require them to be cleared/set together. Sending both
      // as null/empty clears the office location entirely (falls back to
      // always "Remote", same as a fresh unconfigured install).
      const latRaw = req.body.officeLatitude, lngRaw = req.body.officeLongitude;
      const clearing = (latRaw === null || latRaw === '') && (lngRaw === null || lngRaw === '');
      if (clearing) {
        s.officeLatitude = null;
        s.officeLongitude = null;
      } else {
        const lat = Number(latRaw), lng = Number(lngRaw);
        if (!Number.isFinite(lat) || lat < -90 || lat > 90) return res.status(400).json({ error: 'Office latitude must be a number between -90 and 90.' });
        if (!Number.isFinite(lng) || lng < -180 || lng > 180) return res.status(400).json({ error: 'Office longitude must be a number between -180 and 180.' });
        s.officeLatitude = lat;
        s.officeLongitude = lng;
      }
    }
    if (req.body.officeRadiusMeters !== undefined) {
      const radius = Number(req.body.officeRadiusMeters);
      if (!Number.isFinite(radius) || radius < 10 || radius > 20000) return res.status(400).json({ error: 'Office radius must be between 10 and 20,000 meters.' });
      s.officeRadiusMeters = Math.round(radius);
    }
    await save('settings', [s]);
    res.json({
      companyName: s.companyName, logoImage: s.logoImage, weeklyOffDays: Array.from(await getWeeklyOffDays()).sort(),
      autoSyncEnabled: !!s.autoSyncEnabled, autoSyncTime: s.autoSyncTime || '08:00',
      officeLatitude: s.officeLatitude, officeLongitude: s.officeLongitude, officeRadiusMeters: s.officeRadiusMeters || 300
    });
  } catch (err) {
    console.error('PATCH /api/settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/settings/logo', requireAdmin, async (req, res) => {
  logoUpload(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
      const s = await getSettings();
      const oldLogo = s.logoImage;
      const logoImage = toPublicUploadUrl(LOGO_DIR, req.file.filename);
      await updateSettingsLogo(s.id, logoImage);
      await deleteOldUpload(oldLogo);
      res.json({ companyName: s.companyName, logoImage });
    } catch (e) {
      console.error('Logo upload failed:', e);
      res.status(500).json({ error: 'Something went wrong while uploading the logo.' });
    }
  });
});

app.delete('/api/settings/logo', requireAdmin, async (req, res) => {
  try {
    const s = await getSettings();
    const oldLogo = s.logoImage;
    await updateSettingsLogo(s.id, null);
    await deleteOldUpload(oldLogo);
    res.json({ companyName: s.companyName, logoImage: null });
  } catch (e) {
    console.error('Logo removal failed:', e);
    res.status(500).json({ error: 'Something went wrong while removing the logo.' });
  }
});

// ---------------------------------------------------------------------------
// Public — sign-in screen stats (no auth required; aggregate counts only)
// ---------------------------------------------------------------------------
app.get('/api/public/stats', async (req, res) => {
  try {
    const employees = await load('employees');
    const activeStaff = employees.filter(e => e.status === 'active').length;
    const departments = new Set(employees.map(e => e.department)).size;
    res.json({ totalStaff: employees.length, activeStaff, departments });
  } catch (err) {
    console.error('GET /api/public/stats failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Auth — Staff
// ---------------------------------------------------------------------------
app.post('/api/auth/staff/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const employees = await load('employees');
    const emp = employees.find(e => e.email.toLowerCase() === String(email || '').toLowerCase());
    if (!emp || !bcrypt.compareSync(password || '', emp.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    if (emp.status === 'inactive') {
      return res.status(403).json({ error: 'This account has been deactivated. Contact HR if you believe this is a mistake.' });
    }
    req.session.employeeId = emp.id;
    res.json({ employee: withManagerInfo(publicEmployee(emp), employees) });
  } catch (err) {
    console.error('POST /api/auth/staff/login failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/staff/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });
});

// Attaches managerName + isManager to an employee object for display in the
// staff portal (who they report to, and whether they have direct reports).
function withManagerInfo(emp, employees) {
  if (!emp) return emp;
  const manager = emp.managerId ? employees.find(e => e.id === emp.managerId) : null;
  const isManager = employees.some(e => e.managerId === emp.id);
  return { ...emp, managerName: manager ? manager.name : null, isManager };
}

app.get('/api/auth/staff/me', requireEmployee, async (req, res) => {
  try {
    const employees = await load('employees');
    const emp = employees.find(e => e.id === req.session.employeeId);
    if (!emp) return res.status(404).json({ error: 'Not found.' });
    res.json({ employee: withManagerInfo(publicEmployee(emp), employees) });
  } catch (err) {
    console.error('GET /api/auth/staff/me failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Staff: upload / replace own profile photo
app.post('/api/auth/staff/profile-image', requireEmployee, async (req, res) => {
  avatarUpload(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });

      const emp = await getEmployeeById(req.session.employeeId);
      if (!emp) return res.status(404).json({ error: 'Employee not found.' });

      const oldAvatar = emp.avatarImage;
      const avatarImage = toPublicUploadUrl(AVATAR_DIR, req.file.filename);
      // Single-row UPDATE, not load()+save() on the whole employees table —
      // two staff uploading a photo around the same moment used to be able
      // to silently drop one another's write (see the comment on the
      // helpers in db.js). This only ever touches this one employee's row.
      await updateEmployeeAvatar(emp.id, avatarImage);
      await deleteOldUpload(oldAvatar);

      const employees = await load('employees'); // read-only, for manager name/isManager lookups below
      const updated = employees.find(e => e.id === emp.id) || { ...emp, avatarImage };
      res.json({ employee: withManagerInfo(publicEmployee(updated), employees) });
    } catch (e) {
      console.error('Profile photo upload failed:', e);
      res.status(500).json({ error: 'Something went wrong while uploading your photo.' });
    }
  });
});

// Staff: remove own profile photo — falls back to colored initials
app.delete('/api/auth/staff/profile-image', requireEmployee, async (req, res) => {
  try {
    const emp = await getEmployeeById(req.session.employeeId);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const oldAvatar = emp.avatarImage;
    await updateEmployeeAvatar(emp.id, null);
    await deleteOldUpload(oldAvatar);
    const employees = await load('employees');
    const updated = employees.find(e => e.id === emp.id) || { ...emp, avatarImage: null };
    res.json({ employee: withManagerInfo(publicEmployee(updated), employees) });
  } catch (e) {
    console.error('Profile photo removal failed:', e);
    res.status(500).json({ error: 'Something went wrong while removing your photo.' });
  }
});

// Staff: change own password
app.post('/api/auth/staff/change-password', requireEmployee, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const emp = await getEmployeeById(req.session.employeeId);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    if (!bcrypt.compareSync(currentPassword || '', emp.passwordHash)) {
      return res.status(401).json({ error: 'Your current password is incorrect.' });
    }
    await updateEmployeePassword(emp.id, bcrypt.hashSync(newPassword, 8));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/auth/staff/change-password failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Auth — HR / Admin
// ---------------------------------------------------------------------------
app.post('/api/auth/admin/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const admins = await load('admins');
    const admin = admins.find(a => a.email.toLowerCase() === String(email || '').toLowerCase());
    if (!admin || !bcrypt.compareSync(password || '', admin.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    req.session.adminId = admin.id;
    const { passwordHash, ...rest } = admin;
    res.json({ admin: rest });
  } catch (err) {
    console.error('POST /api/auth/admin/login failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/auth/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });
});

app.get('/api/auth/admin/me', requireAdmin, async (req, res) => {
  try {
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Not found.' });
    const { passwordHash, ...rest } = admin;
    res.json({ admin: rest });
  } catch (err) {
    console.error('GET /api/auth/admin/me failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin: upload / replace own profile photo
app.post('/api/auth/admin/profile-image', requireAdmin, async (req, res) => {
  avatarUpload(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });

      const admin = await getAdminById(req.session.adminId);
      if (!admin) return res.status(404).json({ error: 'Admin not found.' });

      const oldAvatar = admin.avatarImage;
      const avatarImage = toPublicUploadUrl(AVATAR_DIR, req.file.filename);
      await updateAdminAvatar(admin.id, avatarImage);
      await deleteOldUpload(oldAvatar);

      const { passwordHash, ...rest } = { ...admin, avatarImage };
      res.json({ admin: rest });
    } catch (e) {
      console.error('Admin profile photo upload failed:', e);
      res.status(500).json({ error: 'Something went wrong while uploading your photo.' });
    }
  });
});

// Admin: remove own profile photo — falls back to colored initials
app.delete('/api/auth/admin/profile-image', requireAdmin, async (req, res) => {
  try {
    const admin = await getAdminById(req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found.' });
    const oldAvatar = admin.avatarImage;
    await updateAdminAvatar(admin.id, null);
    await deleteOldUpload(oldAvatar);
    const { passwordHash, ...rest } = { ...admin, avatarImage: null };
    res.json({ admin: rest });
  } catch (e) {
    console.error('Admin profile photo removal failed:', e);
    res.status(500).json({ error: 'Something went wrong while removing your photo.' });
  }
});

// Admin: change own password
app.post('/api/auth/admin/change-password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const admin = await getAdminById(req.session.adminId);
    if (!admin) return res.status(404).json({ error: 'Admin not found.' });
    if (!bcrypt.compareSync(currentPassword || '', admin.passwordHash)) {
      return res.status(401).json({ error: 'Your current password is incorrect.' });
    }
    await updateAdminPassword(admin.id, bcrypt.hashSync(newPassword, 8));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/auth/admin/change-password failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Forgot password — two self-service paths, chosen by the person on the
// sign-in screen: (A) ask HR/Admin to assign a fresh password, or
// (B) verify their registered email with a one-time code and set a new
// password themselves. Both look up the email across staff AND admin
// accounts, since either can be signed in from the same "Forgot password"
// link.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
async function findAccountByEmail(email) {
  const lower = String(email || '').trim().toLowerCase();
  if (!lower) return null;
  const employees = await load('employees');
  const emp = employees.find(e => e.email.toLowerCase() === lower);
  if (emp) return { type: 'staff', id: emp.id, email: emp.email, name: emp.name };
  const admins = await load('admins');
  const admin = admins.find(a => a.email.toLowerCase() === lower);
  if (admin) return { type: 'admin', id: admin.id, email: admin.email, name: admin.name };
  return null;
}
async function applyNewPassword(account, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 8);
  if (account.type === 'staff') {
    const emp = await getEmployeeById(account.id);
    if (!emp) return false;
    await updateEmployeePassword(emp.id, hash);
  } else {
    const admin = await getAdminById(account.id);
    if (!admin) return false;
    await updateAdminPassword(admin.id, hash);
  }
  return true;
}
function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Path A — request HR to assign a new password. Always responds with the
// same generic message whether or not the email was found, so this can't
// be used to probe which emails are registered.
app.post('/api/auth/forgot/request-reset', loginLimiter, async (req, res) => {
  try {
    const account = await findAccountByEmail(req.body.email);
    if (account) {
      await query(
        `INSERT INTO password_reset_requests (id, user_type, user_id, email, name, status, requested_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [`prr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, account.type, account.id, account.email, account.name, new Date().toISOString()]
      );
    }
    res.json({ ok: true, message: 'If that email is registered, HR has been notified and will send you a new password.' });
  } catch (err) {
    console.error('POST /api/auth/forgot/request-reset failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Path B, step 1 — email a 6-digit OTP, valid for 10 minutes.
app.post('/api/auth/forgot/send-otp', loginLimiter, async (req, res) => {
  try {
    const account = await findAccountByEmail(req.body.email);
    if (account) {
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      await query(
        `INSERT INTO password_otps (id, user_type, user_id, email, otp_hash, expires_at, used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [`otp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, account.type, account.id, account.email,
         bcrypt.hashSync(otp, 8), new Date(Date.now() + 10 * 60 * 1000).toISOString(), new Date().toISOString()]
      );
      await sendMail({
        to: account.email,
        subject: 'Your password reset code',
        heading: 'Password Reset Code',
        intro: `Hi ${account.name.split(' ')[0]}, use the code below to reset your password. It expires in 10 minutes. If you didn't request this, you can safely ignore this email.`,
        rows: [['One-time code', otp]]
      });
    }
    res.json({ ok: true, message: 'If that email is registered, a one-time code has been sent to it.' });
  } catch (err) {
    console.error('POST /api/auth/forgot/send-otp failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Path B, step 2 — verify the OTP and set the new password.
app.post('/api/auth/forgot/verify-otp', loginLimiter, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const account = await findAccountByEmail(email);
    if (!account) return res.status(400).json({ error: 'Invalid or expired code.' });
    const candidates = await query(
      `SELECT * FROM password_otps WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC`,
      [account.email, new Date().toISOString()]
    );
    const match = candidates.find(c => bcrypt.compareSync(String(otp || ''), c.otp_hash));
    if (!match) return res.status(400).json({ error: 'Invalid or expired code.' });
    await query(`UPDATE password_otps SET used = 1 WHERE id = ?`, [match.id]);
    await applyNewPassword(account, newPassword);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/auth/forgot/verify-otp failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin — view + action HR-assisted reset requests.
app.get('/api/admin/password-reset-requests', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM password_reset_requests ORDER BY requested_at DESC LIMIT 100`);
    res.json({ requests: rows });
  } catch (err) {
    console.error('GET /api/admin/password-reset-requests failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/password-reset-requests/:id/assign', requireAdmin, async (req, res) => {
  try {
    const rows = await query(`SELECT * FROM password_reset_requests WHERE id = ?`, [req.params.id]);
    const reqRow = rows[0];
    if (!reqRow) return res.status(404).json({ error: 'Request not found.' });
    if (reqRow.status === 'completed') return res.status(400).json({ error: 'This request has already been resolved.' });
    const account = { type: reqRow.user_type, id: reqRow.user_id, email: reqRow.email, name: reqRow.name };
    const tempPassword = randomPassword();
    const applied = await applyNewPassword(account, tempPassword);
    if (!applied) return res.status(404).json({ error: 'That account no longer exists.' });

    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    await query(
      `UPDATE password_reset_requests SET status = 'completed', resolved_at = ?, resolved_by = ? WHERE id = ?`,
      [new Date().toISOString(), (admin && admin.name) || 'HR Admin', req.params.id]
    );

    await sendMail({
      to: account.email,
      subject: 'Your new password',
      heading: 'Password Reset',
      intro: `Hi ${account.name.split(' ')[0]}, HR has assigned you a new temporary password. Please sign in with it below and change it right away from your account settings.`,
      rows: [['Temporary password', tempPassword]]
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/admin/password-reset-requests/:id/assign failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Attendance — Staff actions
// ---------------------------------------------------------------------------
app.get('/api/attendance/today', requireEmployee, async (req, res) => {
  try {
    const today = todayStr();
    const rec = await attendanceRepo.getByEmpDate(req.session.employeeId, today);
    res.json({ record: rec || null, today, todayMiti: toBsFormatted(today), fiscalYear: fiscalYear(today), todayBs: todayBs() });
  } catch (err) {
    console.error('GET /api/attendance/today failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/attendance/check-in', requireEmployee, async (req, res) => {
  try {
    // Reverse-geocoding is a slow external network call (up to a few
    // seconds). Doing it here, before the write lock, means one person's
    // slow geocode lookup never blocks anyone else's check-in from
    // proceeding — only the actual (fast, single-row) database write is
    // serialized below.
    const ip = getClientIp(req);
    const location = await withArea(getClientLocation(req));
    const result = await serialize(() => performCheckIn(req, ip, location));
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    console.error('Check-in failed:', err);
    res.status(500).json({ error: 'Something went wrong while checking in.' });
  }
});
async function performCheckIn(req, ip, location) {
  const employees = await load('employees');
  const emp = employees.find(e => e.id === req.session.employeeId);
  const today = todayStr();
  const existing = await attendanceRepo.getByEmpDate(emp.id, today);
  if (existing) throw new ApiError(400, { error: 'You have already checked in today.' });

  const leave = await approvedLeaveOn(emp.id, today);
  if (leave) throw new ApiError(400, { error: `You're on approved ${leave.leaveType.toLowerCase()} today (${fmtRange(leave.fromDate, leave.toDate)}) — no need to check in.` });

  const time = nowTime();
  const lateBy = Math.max(0, minutesBetween(emp.shiftStart, time));
  const record = {
    // Random suffix matters here, not just style: Date.now() alone has
    // millisecond resolution, so two different employees checking in in
    // the same millisecond (entirely realistic at shift start) would
    // generate the *same* id. Since `id` is the PRIMARY KEY and
    // attendanceRepo.upsert() does INSERT ... ON DUPLICATE KEY UPDATE
    // (updating employee_id, date, and every other column) on whichever
    // unique key collides, that collision would silently overwrite one
    // employee's brand-new attendance row with another employee's data —
    // not a crash, just quietly corrupted attendance for both of them.
    // Every other place in the app that mints an attendance id already
    // includes this suffix (see the manual-adjustment and biometric-sync
    // record builders below/in zkSync.js) — this was the one path that
    // didn't.
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    employeeId: emp.id,
    date: today,
    checkIn: time,
    checkOut: null,
    status: lateBy > 5 ? 'late' : 'present',
    lateBy,
    earlyCheckout: false,
    hoursWorked: 0,
    checkInIp: ip,
    checkInLocation: location,
    checkOutIp: null,
    checkOutLocation: null
  };
  await attendanceRepo.upsert(record);
  return { record: { ...record, workingModality: workingModalityFor(record, await getOfficeLocation()) } };
}
function fmtRange(from, to) { return from === to ? from : `${from} – ${to}`; }

// Turns the org's (admin-editable, free-text) company name into a safe
// download filename prefix — export filenames used to hardcode
// "KutkiTech" regardless of what organization the app was actually
// running for. Falls back to a generic label if the name is empty or
// reduces to nothing filename-safe (e.g. a name that's entirely emoji).
function filenameSafeCompanyName(name) {
  const slug = String(name || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'Attendance_Report';
}

// Attaches the Nepali Miti alongside the existing AD date(s), without
// touching the stored record — used wherever a date-bearing list goes to
// the client (attendance log, corrections, leave requests, holidays).
function withDateMiti(record) { return { ...record, miti: toBsShort(record.date) }; }
function withLeaveMiti(request) { return { ...request, fromMiti: toBsShort(request.fromDate), toMiti: toBsShort(request.toDate) }; }

app.post('/api/attendance/check-out', requireEmployee, async (req, res) => {
  try {
    const ip = getClientIp(req);
    const location = await withArea(getClientLocation(req));
    const result = await serialize(() => performCheckOut(req, ip, location));
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    console.error('Check-out failed:', err);
    res.status(500).json({ error: 'Something went wrong while checking out.' });
  }
});
async function performCheckOut(req, ip, location) {
  const employees = await load('employees');
  const emp = employees.find(e => e.id === req.session.employeeId);
  const rec = await attendanceRepo.getByEmpDate(emp.id, todayStr());
  if (!rec) throw new ApiError(400, { error: 'You have not checked in today.' });
  if (rec.checkOut) throw new ApiError(400, { error: 'You have already checked out today.' });

  const time = nowTime();
  const minsEarly = minutesBetween(time, emp.shiftEnd);

  if (minsEarly > 15) {
    // Needs an early-checkout reason + HR (and, if assigned, manager) approval
    throw new ApiError(409, {
      earlyCheckoutRequired: true,
      message: `It's ${minsEarly} minutes before your shift ends (${emp.shiftEnd}). Please provide a reason for early checkout.`
    });
  }

  rec.checkOut = time;
  rec.hoursWorked = +(minutesBetween(rec.checkIn, time) / 60).toFixed(2);
  rec.checkOutIp = ip;
  rec.checkOutLocation = location;
  await attendanceRepo.upsert(rec);
  return { record: { ...rec, workingModality: workingModalityFor(rec, await getOfficeLocation()) } };
}

app.post('/api/attendance/early-checkout', requireEmployee, async (req, res) => {
  try {
    const ip = getClientIp(req);
    const location = await withArea(getClientLocation(req));
    const result = await serialize(() => performEarlyCheckout(req, ip, location));
    res.json(result);
    const employees = await load('employees');
    const emp = employees.find(e => e.id === req.session.employeeId);
    if (emp) notifyRequestSubmitted('early', result.request, emp, employees, await load('admins'));
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    console.error('Early checkout failed:', err);
    res.status(500).json({ error: 'Something went wrong while checking out.' });
  }
});
async function performEarlyCheckout(req, ip, location) {
  const { reason } = req.body;
  if (!reason || !reason.trim()) throw new ApiError(400, { error: 'A reason is required for early checkout.' });

  const employees = await load('employees');
  const emp = employees.find(e => e.id === req.session.employeeId);
  const rec = await attendanceRepo.getByEmpDate(emp.id, todayStr());
  if (!rec) throw new ApiError(400, { error: 'You have not checked in today.' });
  if (rec.checkOut) throw new ApiError(400, { error: 'You have already checked out today.' });

  const time = nowTime();
  rec.checkOut = time;
  rec.hoursWorked = +(minutesBetween(rec.checkIn, time) / 60).toFixed(2);
  rec.earlyCheckout = true;
  rec.checkOutIp = ip;
  rec.checkOutLocation = location;
  await attendanceRepo.upsert(rec);

  const managerDecision = emp.managerId ? 'pending' : 'not_required';
  const request = {
    id: `req_${Date.now()}`,
    employeeId: emp.id,
    employeeName: emp.name,
    empCode: emp.employeeId,
    date: todayStr(),
    requestedTime: time,
    reason: reason.trim(),
    ...initialDecisionState(emp),
    createdAt: todayStr()
  };
  await requestsRepo.insert(request);

  return { record: { ...rec, workingModality: workingModalityFor(rec, await getOfficeLocation()) }, request };
}

// Staff: submit a leave request (needs manager + HR approval, same as early checkouts)
app.post('/api/attendance/leave-request', requireEmployee, async (req, res) => {
  try {
    const result = await serialize(() => performLeaveRequest(req));
    res.json(result);
    const employees = await load('employees');
    const emp = employees.find(e => e.id === req.session.employeeId);
    if (emp) notifyRequestSubmitted('leave', result.request, emp, employees, await load('admins'));
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    console.error('Leave request failed:', err);
    res.status(500).json({ error: 'Something went wrong while submitting your leave request.' });
  }
});
async function performLeaveRequest(req) {
  const { fromDate, toDate, leaveType, reason } = req.body;
  if (!fromDate || !toDate) throw new ApiError(400, { error: 'From date and to date are required.' });
  if (!reason || !reason.trim()) throw new ApiError(400, { error: 'A reason is required for leave.' });
  if (toDate < fromDate) throw new ApiError(400, { error: 'The to-date cannot be before the from-date.' });

  const employees = await load('employees');
  const emp = employees.find(e => e.id === req.session.employeeId);
  const ownLeaveRequests = await leaveRequestsRepo.getRange({ employeeId: emp.id });

  const overlap = ownLeaveRequests.find(r =>
    r.status !== 'rejected' && fromDate <= r.toDate && toDate >= r.fromDate
  );
  if (overlap) throw new ApiError(400, { error: `This overlaps a ${overlap.status} leave request you already have for ${fmtRange(overlap.fromDate, overlap.toDate)}.` });

  const type = leaveType || 'Casual Leave';
  const requestedDays = leaveDaysCount(fromDate, toDate);
  if (BALANCE_TRACKED_LEAVE_TYPES.includes(type)) {
    const { assigned, remaining } = await leaveBalanceFor(emp, type, undefined, ownLeaveRequests);
    if (requestedDays > remaining) {
      throw new ApiError(400, { error: `Insufficient ${type} balance: you have ${remaining} of ${assigned} day(s) remaining, but requested ${requestedDays} day(s).` });
    }
  }

  const managerDecision = emp.managerId ? 'pending' : 'not_required';
  const request = {
    id: `lv_${Date.now()}`,
    employeeId: emp.id,
    employeeName: emp.name,
    empCode: emp.employeeId,
    leaveType: type,
    fromDate, toDate,
    reason: reason.trim(),
    ...initialDecisionState(emp),
    createdAt: todayStr()
  };
  await leaveRequestsRepo.insert(request);
  return { request };
}

// Staff: view own leave requests
app.get('/api/attendance/my-leave-requests', requireEmployee, async (req, res) => {
  try {
    const { from, to } = resolveDateRange(req.query);
    let extraWhere = null, extraParams = [];
    if (from) { extraWhere = 'to_date >= ?'; extraParams = [from]; }
    if (to) { extraWhere = extraWhere ? extraWhere + ' AND from_date <= ?' : 'from_date <= ?'; extraParams.push(to); }
    const requests = await leaveRequestsRepo.getRange({ employeeId: req.session.employeeId, status: req.query.status, extraWhere, extraParams, limit: 200 });
    res.json({ requests: requests.map(withLeaveMiti) });
  } catch (err) {
    console.error('GET /api/attendance/my-leave-requests failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Staff: own leave balances per type — assigned by HR, used (from approved
// requests), and remaining. Powers the balance hint in the leave modal.
app.get('/api/attendance/leave-balances', requireEmployee, async (req, res) => {
  try {
    const emp = (await load('employees')).find(e => e.id === req.session.employeeId);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const balances = {};
    for (const type of BALANCE_TRACKED_LEAVE_TYPES) { balances[type] = await leaveBalanceFor(emp, type); }
    res.json({ balances, fiscalYear: fiscalYear(todayStr()), fiscalYearAd: currentFiscalYearAdBounds() });
  } catch (err) {
    console.error('GET /api/attendance/leave-balances failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Attendance correction requests — for a forgotten check-in/check-out on a
// past date. Needs manager + HR approval (same two-stage flow as everything
// else) unless the employee is exempted, in which case it's applied the
// moment it's submitted. Nothing touches the actual attendance record until
// the request is fully approved.
// ---------------------------------------------------------------------------
app.post('/api/attendance/correction-request', requireEmployee, async (req, res) => {
  try {
    const result = await serialize(() => performCorrectionRequest(req));
    res.json(result);
    const employees = await load('employees');
    const emp = employees.find(e => e.id === req.session.employeeId);
    if (emp) notifyRequestSubmitted('correction', result.correction, emp, employees, await load('admins'));
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    console.error('Correction request failed:', err);
    res.status(500).json({ error: 'Something went wrong while submitting your correction request.' });
  }
});
async function performCorrectionRequest(req) {
  const { date, requestedCheckIn, requestedCheckOut, reason } = req.body;
  if (!date) throw new ApiError(400, { error: 'A date is required.' });
  if (date > todayStr()) throw new ApiError(400, { error: 'You can only request a correction for today or an earlier date.' });
  if (!requestedCheckIn && !requestedCheckOut) throw new ApiError(400, { error: 'Provide at least a check-in or check-out time.' });
  if (!reason || !reason.trim()) throw new ApiError(400, { error: 'A reason is required.' });

  const employees = await load('employees');
  const emp = employees.find(e => e.id === req.session.employeeId);

  const decisions = initialDecisionState(emp);
  const correction = {
    id: `cor_${Date.now()}`,
    employeeId: emp.id,
    employeeName: emp.name,
    empCode: emp.employeeId,
    date,
    requestedCheckIn: requestedCheckIn || null,
    requestedCheckOut: requestedCheckOut || null,
    reason: reason.trim(),
    ...decisions,
    applied: false,
    createdAt: todayStr()
  };

  if (decisions.status === 'approved') {
    await upsertAttendance({
      employeeId: emp.id, date, checkIn: correction.requestedCheckIn, checkOut: correction.requestedCheckOut,
      source: 'correction', adjustedBy: decisions.adminReviewedBy
    });
    correction.applied = true;
  }
  await correctionsRepo.insert(correction);
  return { correction };
}

// Staff: view own correction requests
app.get('/api/attendance/my-corrections', requireEmployee, async (req, res) => {
  try {
    const { from, to } = resolveDateRange(req.query);
    let extraWhere = null, extraParams = [];
    if (from) { extraWhere = 'date >= ?'; extraParams = [from]; }
    if (to) { extraWhere = extraWhere ? extraWhere + ' AND date <= ?' : 'date <= ?'; extraParams.push(to); }
    const corrections = await correctionsRepo.getRange({ employeeId: req.session.employeeId, status: req.query.status, extraWhere, extraParams, limit: 200 });
    res.json({ corrections: corrections.map(withDateMiti) });
  } catch (err) {
    console.error('GET /api/attendance/my-corrections failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Monthly report for the signed-in employee
app.get('/api/attendance/my-report', requireEmployee, async (req, res) => {
  try {
    res.json(await buildMonthlyReport(req.session.employeeId, req.query.bsYear, req.query.bsMonth));
  } catch (err) {
    console.error('GET /api/attendance/my-report failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Staff: export own (or, with permission, another staff member's) monthly
// report as Excel or PDF. Pass ?staffId=... to export someone else's —
// gated by the same canViewStaffReport() check used for viewing on-screen.
app.get('/api/attendance/my-report/export/:format', requireEmployee, async (req, res) => {
  try {
    const format = req.params.format;
    if (!['excel', 'pdf'].includes(format)) return res.status(400).json({ error: 'Invalid export format.' });
    const employees = await load('employees');
    const me = employees.find(e => e.id === req.session.employeeId);
    if (!me) return res.status(404).json({ error: 'Employee not found.' });

    const targetId = req.query.staffId ? String(req.query.staffId) : me.id;
    const emp = targetId === me.id ? me : employees.find(e => e.id === targetId);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    if (!canViewStaffReport(me, emp)) return res.status(403).json({ error: "You don't have permission to export this staff member's report." });

    const report = await buildMonthlyReport(emp.id, req.query.bsYear, req.query.bsMonth);
    report.dailyRows = await buildDailyRows(report.records, report.monthStart, report.monthEnd, report.leaveDates, await getHolidaySet());
    const fileTag = (report.bsMonthLabel || report.month).replace(/\s+/g, '_');
    const filePrefix = filenameSafeCompanyName((await getSettings()).companyName);

    if (format === 'excel') {
      const buffer = await buildStaffExcel({ employee: publicEmployee(emp), report, generatedBy: me.name });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filePrefix}_${emp.employeeId}_${fileTag}.xlsx"`);
      res.send(Buffer.from(buffer));
    } else {
      const buffer = await buildStaffPdf({ employee: publicEmployee(emp), report, generatedBy: me.name });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filePrefix}_${emp.employeeId}_${fileTag}.pdf"`);
      res.send(buffer);
    }
  } catch (err) {
    console.error('Staff export failed:', err);
    res.status(500).json({ error: 'Could not generate export.' });
  }
});

// Can the signed-in employee view `targetId`'s attendance report? Three
// simple boolean checks, in order: it's their own report, HR has flagged
// them with canViewAllReports (see the employee record), or they're the
// direct manager of the target (managerId points back at them). Any one
// of these being true is enough — kept as plain booleans/ORs on purpose so
// this stays easy to read and doesn't need a separate roles/permissions
// table.
function canViewStaffReport(viewer, target) {
  if (!viewer || !target) return false;
  if (viewer.id === target.id) return true;
  if (viewer.canViewAllReports) return true;
  if (target.managerId && target.managerId === viewer.id) return true;
  return false;
}

// Staff: list of colleagues whose report this employee is allowed to open —
// everyone, if HR granted them "view all staff" access; otherwise just
// their direct reports (if they're a manager). Powers the report-view
// staff picker in the portal.
app.get('/api/attendance/viewable-staff', requireEmployee, async (req, res) => {
  try {
    const employees = await load('employees');
    const me = employees.find(e => e.id === req.session.employeeId);
    if (!me) return res.status(404).json({ error: 'Employee not found.' });

    let visible;
    if (me.canViewAllReports) {
      visible = employees.filter(e => e.id !== me.id);
    } else {
      visible = employees.filter(e => e.managerId === me.id);
    }
    res.json({
      staff: visible
        .map(e => ({ id: e.id, name: e.name, employeeId: e.employeeId, department: e.department }))
        .sort((a, b) => a.name.localeCompare(b.name))
    });
  } catch (err) {
    console.error('GET /api/attendance/viewable-staff failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Staff: view another employee's monthly report — only allowed if
// canViewStaffReport() says so (self / granted "view all" / their manager).
app.get('/api/attendance/staff-report/:id', requireEmployee, async (req, res) => {
  try {
    const employees = await load('employees');
    const me = employees.find(e => e.id === req.session.employeeId);
    const target = employees.find(e => e.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Employee not found.' });
    if (!canViewStaffReport(me, target)) return res.status(403).json({ error: "You don't have permission to view this staff member's report." });
    res.json({ employee: withManagerInfo(publicEmployee(target), employees), report: await buildMonthlyReport(target.id, req.query.bsYear, req.query.bsMonth) });
  } catch (err) {
    console.error('GET /api/attendance/staff-report/:id failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

function isoLocal(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// employeeId + a Nepali (BS) year/month (both optional — defaults to the
// current BS month) -> the full monthly report. Everything internally
// still keys off the AD dates stored in the database (that doesn't
// change), but the *period being reported on* is now a BS month, found by
// converting it to its underlying AD date range with bsMonthRange() —
// that's the one conversion this function needs, and every day-by-day
// check (working day, holiday, leave) runs over that AD range exactly as
// it would for an AD month.
async function buildMonthlyReport(employeeId, bsYearParam, bsMonthParam) {
  const holidaySet = await getHolidaySet();
  const todayBsDate = todayBs();
  const bsYear = bsYearParam ? Number(bsYearParam) : todayBsDate.year;
  const bsMonth = bsMonthParam ? Number(bsMonthParam) : todayBsDate.month;
  const range = bsMonthRange(bsYear, bsMonth) || bsMonthRange(todayBsDate.year, todayBsDate.month);
  const monthStart = range.startAD;
  const monthEnd = range.endAD;
  const isCurrentBsMonth = bsYear === todayBsDate.year && bsMonth === todayBsDate.month;
  // Don't count days that haven't happened yet if this is the BS month
  // still in progress — mirrors the old "dayLimit" behavior for the
  // current AD month.
  const effectiveEnd = isCurrentBsMonth && todayStr() < monthEnd ? todayStr() : monthEnd;

  const office = await getOfficeLocation();
  const records = (await attendanceRepo.getRange({ employeeId, fromDate: monthStart, toDate: monthEnd }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => ({ ...r, workingModality: workingModalityFor(r, office), miti: toBsShort(r.date) }));

  const present = records.filter(r => r.status === 'present').length;
  const late = records.filter(r => r.status === 'late').length;
  const earlyOuts = records.filter(r => r.earlyCheckout).length;
  const totalHours = +records.reduce((s, r) => s + (r.hoursWorked || 0), 0).toFixed(1);
  const avgHours = records.length ? +(totalHours / records.length).toFixed(2) : 0;
  const avgLateMins = late ? Math.round(records.filter(r => r.status === 'late').reduce((s, r) => s + r.lateBy, 0) / late) : 0;

  const leaveDates = await approvedLeaveDatesInRange(employeeId, monthStart, effectiveEnd);
  const recordDates = new Set(records.map(r => r.date));

  let workingDays = 0, onLeave = 0;
  const endD = new Date(effectiveEnd + 'T00:00:00');
  for (let d = new Date(monthStart + 'T00:00:00'); d <= endD; d.setDate(d.getDate() + 1)) {
    if (!await isWorkingDay(d, holidaySet)) continue;
    workingDays++;
    const iso = isoLocal(d);
    // Approved leave on a working day the person didn't otherwise check in
    // for counts as leave, not an unexplained absence.
    if (leaveDates.has(iso) && !recordDates.has(iso)) onLeave++;
  }
  const absent = Math.max(0, workingDays - onLeave - records.length);
  const countedDays = Math.max(0, workingDays - onLeave);
  const attendanceRate = countedDays ? Math.round(((countedDays - absent) / countedDays) * 100) : 100;
  const punctualityRate = records.length ? Math.round((present / records.length) * 100) : 0;

  return {
    bsYear, bsMonth, bsMonthLabel: range.label, monthStart, monthEnd,
    month: monthStart.slice(0, 7), // kept for any AD-month-shaped consumer (exports' AD reference)
    records, workingDays, present, late, absent, earlyOuts, onLeave,
    totalHours, avgHours, avgLateMins, attendanceRate, punctualityRate, leaveDates,
    fiscalYear: fiscalYear(monthStart)
  };
}

// Resolves a date-range filter from query params, letting Nepali (BS)
// dates take priority. Two BS shapes are supported: an exact-day range
// (bsFrom/bsTo, 'YYYY-MM-DD' in BS — used by exports that need a precise
// Miti) and a month-level range (bsFromYear/bsFromMonth/bsToYear/bsToMonth
// — used by filter bars, where picking whole BS months is the natural
// unit). Either is converted to its underlying AD date via fromBs() /
// bsMonthRange(); plain AD from/to still works for any caller not using
// BS yet.
function resolveDateRange(query) {
  let { from, to, bsFrom, bsTo, bsFromYear, bsFromMonth, bsToYear, bsToMonth } = query;
  if (bsFromYear && bsFromMonth) {
    const range = bsMonthRange(Number(bsFromYear), Number(bsFromMonth));
    if (range) from = range.startAD;
  }
  if (bsToYear && bsToMonth) {
    const range = bsMonthRange(Number(bsToYear), Number(bsToMonth));
    if (range) to = range.endAD;
  }
  if (bsFrom) {
    const [y, m, d] = String(bsFrom).split('-').map(Number);
    from = fromBs(y, m, d) || from;
  }
  if (bsTo) {
    const [y, m, d] = String(bsTo).split('-').map(Number);
    to = fromBs(y, m, d) || to;
  }
  return { from, to };
}

// Builds the filtered record set + summary + department breakdown used by
// the company-wide (Excel / PDF) export — mirrors the Attendance Log filters
// but without the 500-row cap the on-screen table uses.
async function buildOverallExportData(req) {
  const employees = await load('employees');
  const { from, to } = resolveDateRange(req.query);
  const { department, status } = req.query;
  let attendance = await attendanceRepo.getRange({ fromDate: from || undefined, toDate: to || undefined });
  if (status) attendance = attendance.filter(a => a.status === status);

  const office = await getOfficeLocation();
  let recs = attendance.map(r => {
    const emp = employees.find(e => e.id === r.employeeId);
    return {
      ...r,
      employeeName: emp ? emp.name : 'Unknown',
      empCode: emp ? emp.employeeId : '—',
      department: emp ? emp.department : '—',
      designation: emp ? emp.designation : '—',
      shiftName: emp ? emp.shiftName : '—',
      ipAddress: r.checkOutIp || r.checkInIp || null,
      location: r.checkOutLocation || r.checkInLocation || null,
      workingModality: workingModalityFor(r, office),
      miti: toBsShort(r.date)
    };
  });
  if (department) recs = recs.filter(r => r.department === department);
  recs.sort((a, b) => b.date.localeCompare(a.date) || (a.checkIn || '').localeCompare(b.checkIn || ''));

  const present = recs.filter(r => r.status === 'present').length;
  const late = recs.filter(r => r.status === 'late').length;
  const earlyOuts = recs.filter(r => r.earlyCheckout).length;
  const totalHours = +recs.reduce((s, r) => s + (r.hoursWorked || 0), 0).toFixed(1);
  const avgHours = recs.length ? +(totalHours / recs.length).toFixed(2) : 0;

  const deptMap = {};
  employees.forEach(e => {
    if (!deptMap[e.department]) deptMap[e.department] = { department: e.department, total: 0, present: 0 };
    deptMap[e.department].total++;
  });
  recs.forEach(r => { if (deptMap[r.department]) deptMap[r.department].present++; });

  return {
    records: recs,
    filters: { from, to, fromMiti: toBsShort(from), toMiti: toBsShort(to), department, status },
    summary: { totalRecords: recs.length, present, late, earlyOuts, totalHours, avgHours },
    departments: Object.values(deptMap).sort((a, b) => b.total - a.total)
  };
}

// ---------------------------------------------------------------------------
// Admin — Dashboard / overview
// ---------------------------------------------------------------------------
app.get('/api/admin/overview', requireAdmin, cachedAdminRoute('overview', async (req, res) => {
  try {
    const employees = await load('employees');
    const holidaySet = await getHolidaySet();
    const today = todayStr();

    // Only the last ~3 calendar weeks are ever used below (today's stats +
    // a 14-*working*-day trend, which with weekends/holidays worked in needs
    // a slightly wider calendar window to be sure of covering 14 of them) —
    // querying that window instead of the whole attendance table is the
    // difference between scanning ~21 days and scanning years of history on
    // every single dashboard load.
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - 25);
    const attendance = await attendanceRepo.getRange({ fromDate: isoLocal(windowStart), toDate: today });
    const leaveRequestsForWindow = await leaveRequestsRepo.getRange({
      status: 'approved',
      extraWhere: 'from_date <= ? AND to_date >= ?',
      extraParams: [today, isoLocal(windowStart)]
    });

    const [pendingEarly, pendingLeave, pendingCorrections] = await Promise.all([
      requestsRepo.getRange({ adminDecision: 'pending' }),
      leaveRequestsRepo.getRange({ adminDecision: 'pending' }),
      correctionsRepo.getRange({ adminDecision: 'pending' })
    ]);

    const todays = attendance.filter(a => a.date === today);
    const presentToday = todays.filter(a => a.status === 'present').length;
    const lateToday = todays.filter(a => a.status === 'late').length;
    const checkedInOnly = todays.filter(a => !a.checkOut).length;
    const activeStaff = employees.filter(e => e.status === 'active').length;
    const checkedInIds = new Set(todays.map(a => a.employeeId));
    const onLeaveCandidatesToday = employees.filter(e => e.status === 'active' && !checkedInIds.has(e.id));
    let onLeaveToday = 0;
    for (const e of onLeaveCandidatesToday) { if (await approvedLeaveOn(e.id, today, leaveRequestsForWindow)) onLeaveToday++; }
    const absentToday = Math.max(0, activeStaff - todays.length - onLeaveToday);
    const pendingRequests = pendingEarly.length + pendingLeave.length + pendingCorrections.length;

    // last 14 working days trend (work week: configurable, holidays off)
    const trend = [];
    const cursor = new Date();
    let collected = 0, offset = 0;
    while (collected < 14) {
      const d = new Date(cursor);
      d.setDate(cursor.getDate() - offset);
      offset++;
      if (!await isWorkingDay(d, holidaySet)) continue;
      const dateStr = d.toISOString().slice(0, 10);
      const recs = attendance.filter(a => a.date === dateStr);
      const checkedInIdsForDay = new Set(recs.map(r => r.employeeId));
      const onLeaveCandidatesForDay = employees.filter(e => e.status === 'active' && !checkedInIdsForDay.has(e.id));
      let onLeaveCount = 0;
      for (const e of onLeaveCandidatesForDay) { if (await approvedLeaveOn(e.id, dateStr, leaveRequestsForWindow)) onLeaveCount++; }
      trend.unshift({
        date: dateStr,
        present: recs.filter(r => r.status === 'present').length,
        late: recs.filter(r => r.status === 'late').length,
        absent: Math.max(0, activeStaff - recs.length - onLeaveCount)
      });
      collected++;
    }

    // department breakdown (today)
    const deptMap = {};
    employees.forEach(e => {
      if (!deptMap[e.department]) deptMap[e.department] = { department: e.department, total: 0, present: 0 };
      deptMap[e.department].total++;
    });
    todays.forEach(a => {
      const emp = employees.find(e => e.id === a.employeeId);
      if (emp && deptMap[emp.department]) deptMap[emp.department].present++;
    });

    res.json({
      date: today,
      dateMiti: toBsFormatted(today),
      todayBs: todayBs(),
      fiscalYear: fiscalYear(today),
      activeStaff,
      presentToday,
      lateToday,
      absentToday,
      onLeaveToday,
      checkedInOnly,
      pendingRequests,
      trend,
      departments: Object.values(deptMap).sort((a, b) => b.total - a.total)
    });
  } catch (err) {
    console.error('GET /api/admin/overview failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}));

// All employees (with today's status attached)
app.get('/api/admin/employees', requireAdmin, cachedAdminRoute('employees', async (req, res) => {
  try {
    const employees = await load('employees');
    const today = todayStr();
    // Both queried once, up front — the old version re-ran a full
    // leaveRequests table load *per employee per leave type* inside
    // leaveBalanceSummary(), which turns into thousands of redundant
    // queries once the roster reaches a few hundred people.
    const [todaysAttendance, leaveRequests] = await Promise.all([
      attendanceRepo.getRange({ date: today }),
      load('leaveRequests')
    ]);
    const attByEmp = new Map(todaysAttendance.map(a => [a.employeeId, a]));
    // Index leave requests by employee once (O(n)) rather than handing the
    // full company-wide array to leaveBalanceSummary() for every employee —
    // that function filters it per leave-type internally, so without this
    // index a 500-person roster with a few thousand leave rows on file turns
    // into millions of array comparisons on every single directory load,
    // which is exactly what showed up as requests slowing to a crawl under
    // concurrent load in testing (a CPU/event-loop bottleneck, not a
    // database one — the queries themselves were already fast).
    const leaveRequestsByEmp = new Map();
    for (const r of leaveRequests) {
      if (!leaveRequestsByEmp.has(r.employeeId)) leaveRequestsByEmp.set(r.employeeId, []);
      leaveRequestsByEmp.get(r.employeeId).push(r);
    }
    const list = [];
    for (const e of employees) {
      const rec = attByEmp.get(e.id);
      const ownLeaveRequests = leaveRequestsByEmp.get(e.id) || [];
      const onLeaveToday = !rec && !!(await approvedLeaveOn(e.id, today, ownLeaveRequests));
      list.push({ ...withManagerInfo(publicEmployee(e), employees), todayStatus: rec ? rec.status : (onLeaveToday ? 'on-leave' : 'absent'), checkedIn: !!rec, checkedOut: !!(rec && rec.checkOut), onLeaveToday, leaveBalanceStatus: await leaveBalanceSummary(e, ownLeaveRequests) });
    }
    res.json({ employees: list });
  } catch (err) {
    console.error('GET /api/admin/employees failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}));

app.post('/api/admin/employees', requireAdmin, async (req, res) => {
  try {
    const employees = await load('employees');
    const { name, email, department, designation, phone, shiftName, shiftStart, shiftEnd, managerId, autoAttendance, exemptFromApproval, canViewAllReports, leaveBalances, joinBsYear, joinBsMonth, joinBsDay } = req.body;
    if (!name || !email || !department) return res.status(400).json({ error: 'Name, email and department are required.' });
    if (employees.some(e => e.email.toLowerCase() === email.toLowerCase())) {
      return res.status(400).json({ error: 'An employee with this email already exists.' });
    }
    if (managerId && !employees.some(e => e.id === managerId)) {
      return res.status(400).json({ error: 'Selected manager was not found.' });
    }
    let joinDate = todayStr();
    if (joinBsYear && joinBsMonth && joinBsDay) {
      const converted = fromBs(joinBsYear, joinBsMonth, joinBsDay);
      if (!converted) return res.status(400).json({ error: 'That join Miti date is not valid — check the day exists in that BS month.' });
      joinDate = converted;
    }
    const employeeId = `KT-${1000 + employees.length + 1}`;
    const emp = {
      id: `emp_${Date.now()}`,
      employeeId,
      name,
      email,
      passwordHash: bcrypt.hashSync('Welcome@123', 8),
      department,
      designation: designation || 'Staff',
      phone: phone || '',
      joinDate,
      status: 'active',
      shiftName: shiftName || 'General Shift',
      shiftStart: shiftStart || '09:00',
      shiftEnd: shiftEnd || '18:00',
      avatarColor: ['#1B2F63','#274E8C','#2E6B9E','#3F8F6A','#6DAF3C','#8CC63F','#4A5D8A','#2E4A93'][employees.length % 8],
      managerId: managerId || null,
      autoAttendance: !!autoAttendance,
      exemptFromApproval: !!exemptFromApproval,
      canViewAllReports: !!canViewAllReports,
      leaveBalances: { ...DEFAULT_LEAVE_BALANCES, ...(leaveBalances || {}) }
    };
    employees.push(emp);
    await insertEmployeeRow(emp); // single-row INSERT — not a rewrite of the whole employees table for one new hire
    res.json({ employee: withManagerInfo(publicEmployee(emp), employees), tempPassword: 'Welcome@123' });
  } catch (err) {
    console.error('POST /api/admin/employees failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin: edit an existing staff member's details (including reassigning their manager)
app.patch('/api/admin/employees/:id', requireAdmin, async (req, res) => {
  try {
    const employees = await load('employees');
    const emp = employees.find(e => e.id === req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    if (req.body.email !== undefined) {
      const newEmail = String(req.body.email).trim();
      if (!newEmail) return res.status(400).json({ error: 'Email cannot be empty.' });
      if (employees.some(e => e.id !== emp.id && e.email.toLowerCase() === newEmail.toLowerCase())) {
        return res.status(400).json({ error: 'Another employee already uses this email.' });
      }
    }
    if (req.body.managerId !== undefined && req.body.managerId) {
      if (req.body.managerId === emp.id) return res.status(400).json({ error: 'An employee cannot be their own manager.' });
      if (!employees.some(e => e.id === req.body.managerId)) return res.status(400).json({ error: 'Selected manager was not found.' });
      // prevent simple two-node manager cycles (A manages B, B manages A)
      const proposedManager = employees.find(e => e.id === req.body.managerId);
      if (proposedManager && proposedManager.managerId === emp.id) {
        return res.status(400).json({ error: 'This would create a circular reporting relationship.' });
      }
    }

    // The admin edit form shows/edits *remaining* leave (the number that
    // actually matters to HR), not the raw assigned total. Convert it here,
    // right before saving, using each type's live "used" count — so
    // resubmitting the form after editing an unrelated field (with the same
    // remaining values it was opened with) reproduces the same assigned
    // total rather than resetting it, and a type HR actually changes lands
    // on exactly the remaining figure they typed.
    if (req.body.leaveBalancesRemaining && typeof req.body.leaveBalancesRemaining === 'object') {
      const updatedBalances = { ...(emp.leaveBalances || {}) };
      for (const [type, remaining] of Object.entries(req.body.leaveBalancesRemaining)) {
        if (!BALANCE_TRACKED_LEAVE_TYPES.includes(type)) continue;
        const used = await leaveUsed(emp.id, type);
        updatedBalances[type] = Math.max(0, Number(remaining) || 0) + used;
      }
      emp.leaveBalances = updatedBalances;
    }

    if (req.body.joinBsYear && req.body.joinBsMonth && req.body.joinBsDay) {
      const converted = fromBs(req.body.joinBsYear, req.body.joinBsMonth, req.body.joinBsDay);
      if (!converted) return res.status(400).json({ error: 'That join Miti date is not valid — check the day exists in that BS month.' });
      emp.joinDate = converted;
    }

    const allowed = ['name', 'email', 'department', 'designation', 'phone', 'status', 'shiftName', 'shiftStart', 'shiftEnd', 'managerId', 'autoAttendance', 'exemptFromApproval', 'canViewAllReports'];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) emp[k] = req.body[k] === '' && k === 'managerId' ? null : req.body[k];
    });
    await updateEmployeeRow(emp); // single-row UPDATE — not a rewrite of the whole employees table for one edit
    res.json({ employee: { ...withManagerInfo(publicEmployee(emp), employees), leaveBalanceStatus: await leaveBalanceSummary(emp) } });
  } catch (err) {
    console.error('PATCH /api/admin/employees/:id failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin — emergency password reset: sets a staff member's password
// straight back to the company default (Welcome@123), immediately, with
// no email involved. Meant as a last-resort fallback for when mail isn't
// working or HR needs someone unblocked right now — not the normal path
// (that's the "Password reset requests" flow, which does notify the
// person by email). HR is expected to tell the employee the default
// password out of band and have them change it on first login.
const DEFAULT_PASSWORD = 'Welcome@123';
app.post('/api/admin/employees/:id/reset-default-password', requireAdmin, async (req, res) => {
  try {
    const emp = await getEmployeeById(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    await updateEmployeePassword(emp.id, bcrypt.hashSync(DEFAULT_PASSWORD, 8));
    res.json({ ok: true, defaultPassword: DEFAULT_PASSWORD });
  } catch (err) {
    console.error('POST /api/admin/employees/:id/reset-default-password failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin: remove a staff member — also clears their attendance/request
// history and un-assigns them as anyone else's manager.
app.delete('/api/admin/employees/:id', requireAdmin, async (req, res) => {
  try {
    const emp = await getEmployeeById(req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });

    // Two targeted statements (reassign anyone who reported to them, then
    // delete the row) instead of loading and rewriting every employee just
    // to remove one.
    await deleteEmployeeRow(req.params.id);

    await attendanceRepo.deleteByEmployee(req.params.id);
    await requestsRepo.deleteByEmployee(req.params.id);
    await leaveRequestsRepo.deleteByEmployee(req.params.id);
    await correctionsRepo.deleteByEmployee(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/admin/employees/:id failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Employee monthly report (admin view of any staff member)
app.get('/api/admin/employees/:id/report', requireAdmin, async (req, res) => {
  try {
    const employees = await load('employees');
    const emp = employees.find(e => e.id === req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    res.json({ employee: withManagerInfo(publicEmployee(emp), employees), report: await buildMonthlyReport(req.params.id, req.query.bsYear, req.query.bsMonth) });
  } catch (err) {
    console.error('GET /api/admin/employees/:id/report failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin: export any staff member's monthly report as Excel or PDF
app.get('/api/admin/employees/:id/export/:format', requireAdmin, async (req, res) => {
  try {
    const format = req.params.format;
    if (!['excel', 'pdf'].includes(format)) return res.status(400).json({ error: 'Invalid export format.' });
    const employees = await load('employees');
    const emp = employees.find(e => e.id === req.params.id);
    if (!emp) return res.status(404).json({ error: 'Employee not found.' });
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);

    const report = await buildMonthlyReport(req.params.id, req.query.bsYear, req.query.bsMonth);
    report.dailyRows = await buildDailyRows(report.records, report.monthStart, report.monthEnd, report.leaveDates, await getHolidaySet());
    const fileTag = (report.bsMonthLabel || report.month).replace(/\s+/g, '_');
    const filePrefix = filenameSafeCompanyName((await getSettings()).companyName);

    if (format === 'excel') {
      const buffer = await buildStaffExcel({ employee: publicEmployee(emp), report, generatedBy: admin ? admin.name : 'HR' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filePrefix}_${emp.employeeId}_${fileTag}.xlsx"`);
      res.send(Buffer.from(buffer));
    } else {
      const buffer = await buildStaffPdf({ employee: publicEmployee(emp), report, generatedBy: admin ? admin.name : 'HR' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filePrefix}_${emp.employeeId}_${fileTag}.pdf"`);
      res.send(buffer);
    }
  } catch (err) {
    console.error('Admin staff export failed:', err);
    res.status(500).json({ error: 'Could not generate export.' });
  }
});

// Today's full attendance log (admin) — includes IP address, last known
// location + area, and working modality (Office / Remote)
app.get('/api/admin/attendance/today', requireAdmin, async (req, res) => {
  try {
    const employees = await load('employees');
    const today = todayStr();
    const attendance = await attendanceRepo.getRange({ date: today });
    const office = await getOfficeLocation();
    const recs = attendance.map(r => {
      const emp = employees.find(e => e.id === r.employeeId);
      return {
        ...r,
        employeeName: emp ? emp.name : 'Unknown',
        empCode: emp ? emp.employeeId : '—',
        department: emp ? emp.department : '—',
        avatarColor: emp ? emp.avatarColor : '#999',
        avatarImage: emp ? emp.avatarImage : null,
        ipAddress: r.checkOutIp || r.checkInIp || null,
        location: r.checkOutLocation || r.checkInLocation || null,
        workingModality: workingModalityFor(r, office),
        miti: toBsShort(r.date)
      };
    }).sort((a, b) => a.checkIn.localeCompare(b.checkIn));
    res.json({ records: recs, todayMiti: toBsFormatted(today) });
  } catch (err) {
    console.error('GET /api/admin/attendance/today failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Attendance log with filters (date range / department / employee)
app.get('/api/admin/attendance', requireAdmin, async (req, res) => {
  try {
    const employees = await load('employees');
    const { from, to } = resolveDateRange(req.query);
    const { department, employeeId, status } = req.query;
    let attendance = await attendanceRepo.getRange({ employeeId: employeeId || undefined, fromDate: from || undefined, toDate: to || undefined });
    if (status) attendance = attendance.filter(a => a.status === status);
    const office = await getOfficeLocation();
    let recs = attendance.map(r => {
      const emp = employees.find(e => e.id === r.employeeId);
      return {
        ...r,
        employeeName: emp ? emp.name : 'Unknown',
        empCode: emp ? emp.employeeId : '—',
        department: emp ? emp.department : '—',
        avatarColor: emp ? emp.avatarColor : '#999',
        avatarImage: emp ? emp.avatarImage : null,
        ipAddress: r.checkOutIp || r.checkInIp || null,
        location: r.checkOutLocation || r.checkInLocation || null,
        workingModality: workingModalityFor(r, office),
        miti: toBsShort(r.date)
      };
    });
    if (department) recs = recs.filter(r => r.department === department);

    // Full-dataset sort (before pagination) — with real server-side
    // pagination in play, a DOM-based "sort the rows I can currently see"
    // would silently only reorder the one visible page, which is worse
    // than useless. Whitelisted getters only — never sort by an arbitrary
    // client-supplied column/expression.
    const SORT_FIELDS = {
      date: r => `${r.date} ${r.checkIn || ''}`,
      employeeName: r => (r.employeeName || '').toLowerCase(),
      department: r => (r.department || '').toLowerCase(),
      checkIn: r => r.checkIn || '',
      checkOut: r => r.checkOut || '',
      hoursWorked: r => r.hoursWorked || 0,
      source: r => r.source || '',
      status: r => (r.earlyCheckout ? 'early_pending' : (r.status || ''))
    };
    const sortBy = SORT_FIELDS[req.query.sortBy] ? req.query.sortBy : 'date';
    const sortDir = req.query.sortDir === 'asc' ? 1 : -1;
    const getSortValue = SORT_FIELDS[sortBy];
    recs.sort((a, b) => {
      const av = getSortValue(a), bv = getSortValue(b);
      return av < bv ? -sortDir : av > bv ? sortDir : 0;
    });

    const total = recs.length;
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 500);
    const page = Math.min(Math.max(Number(req.query.page) || 1, 1), Math.max(1, Math.ceil(total / pageSize)));
    const pageRecs = recs.slice((page - 1) * pageSize, page * pageSize);

    res.json({ records: pageRecs, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), sortBy, sortDir: sortDir === 1 ? 'asc' : 'desc' });
  } catch (err) {
    console.error('GET /api/admin/attendance failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Admin: manually create/update/clear an attendance record for any staff
// member on any date — applied immediately, no approval needed (this *is*
// the approval; HR overriding the record directly). Every change is
// stamped with who made it and when, for an audit trail.
app.post('/api/admin/attendance/adjust', requireAdmin, async (req, res) => {
  try {
    const result = await serialize(() => performManualAdjustment(req));
    res.json(result);
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    console.error('Manual attendance adjustment failed:', err);
    res.status(500).json({ error: 'Something went wrong while saving.' });
  }
});
async function performManualAdjustment(req) {
  const { employeeId, date, checkIn, checkOut, statusOverride, clear } = req.body;
  if (!employeeId || !date) throw new ApiError(400, { error: 'Employee and date are required.' });
  const employees = await load('employees');
  const emp = employees.find(e => e.id === employeeId);
  if (!emp) throw new ApiError(404, { error: 'Employee not found.' });
  const admins = await load('admins');
  const admin = admins.find(a => a.id === req.session.adminId);
  const adjustedBy = admin ? admin.name : 'HR';

  if (clear) {
    await clearAttendance(employeeId, date);
    return { ok: true, cleared: true };
  }
  if (!checkIn && !checkOut && !statusOverride) {
    throw new ApiError(400, { error: 'Provide a check-in/check-out time or a status, or clear the record.' });
  }
  const validStatuses = ['present', 'late', 'on-leave'];
  if (statusOverride && !validStatuses.includes(statusOverride)) {
    throw new ApiError(400, { error: 'Invalid status.' });
  }
  const rec = await upsertAttendance({ employeeId, date, checkIn, checkOut, statusOverride, source: 'manual', adjustedBy });
  return { record: { ...rec, workingModality: workingModalityFor(rec, await getOfficeLocation()) } };
}

// Admin: export the company-wide (filtered) attendance record as Excel or PDF
app.get('/api/admin/attendance/export/:format', requireAdmin, async (req, res) => {
  try {
    const format = req.params.format;
    if (!['excel', 'pdf'].includes(format)) return res.status(400).json({ error: 'Invalid export format.' });
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    const data = await buildOverallExportData(req);
    const rangeLabel = `${data.filters.from || 'start'}_to_${data.filters.to || todayStr()}`;
    const filePrefix = filenameSafeCompanyName((await getSettings()).companyName);

    if (format === 'excel') {
      const buffer = await buildOverallExcel({ ...data, generatedBy: admin ? admin.name : 'HR' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filePrefix}_Overall_${rangeLabel}.xlsx"`);
      res.send(Buffer.from(buffer));
    } else {
      const buffer = await buildOverallPdf({ ...data, generatedBy: admin ? admin.name : 'HR' });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filePrefix}_Overall_${rangeLabel}.pdf"`);
      res.send(buffer);
    }
  } catch (err) {
    console.error('Overall export failed:', err);
    res.status(500).json({ error: 'Could not generate export.' });
  }
});

// ---------------------------------------------------------------------------
// Admin — Early checkout requests
// ---------------------------------------------------------------------------
app.get('/api/admin/requests', requireAdmin, async (req, res) => {
  try {
    const { from, to } = resolveDateRange(req.query);
    const status = req.query.status;
    let extraWhere = null, extraParams = [];
    if (from && to) { extraWhere = 'date >= ? AND date <= ?'; extraParams = [from, to]; }
    else if (from) { extraWhere = 'date >= ?'; extraParams = [from]; }
    else if (to) { extraWhere = 'date <= ?'; extraParams = [to]; }
    const list = await requestsRepo.getRange({ status, extraWhere, extraParams, limit: 300 });
    res.json({ requests: list.map(withDateMiti) });
  } catch (err) {
    console.error('GET /api/admin/requests failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/requests/:id/decide', requireAdmin, async (req, res) => {
  try {
    const { decision } = req.body; // 'approved' | 'rejected'
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
    const reqItem = await requestsRepo.getById(req.params.id);
    if (!reqItem) return res.status(404).json({ error: 'Request not found.' });
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    reqItem.adminDecision = decision;
    reqItem.adminReviewedBy = admin ? admin.name : 'HR';
    reqItem.adminReviewedAt = todayStr();
    reqItem.reviewedBy = reqItem.adminReviewedBy;
    reqItem.reviewedAt = reqItem.adminReviewedAt;
    reqItem.status = computeApprovalStatus(reqItem.managerDecision, reqItem.adminDecision);
    await requestsRepo.update(reqItem);
    res.json({ request: reqItem });
    const employees = await load('employees');
    const emp = employees.find(e => e.id === reqItem.employeeId);
    if (emp) notifyRequestDecided('early', reqItem, emp, 'admin', employees, admins);
  } catch (err) {
    console.error('POST /api/admin/requests/:id/decide failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Staff: view own early checkout requests
app.get('/api/attendance/my-requests', requireEmployee, async (req, res) => {
  try {
    const { from, to } = resolveDateRange(req.query);
    let extraWhere = null, extraParams = [];
    if (from && to) { extraWhere = 'date >= ? AND date <= ?'; extraParams = [from, to]; }
    else if (from) { extraWhere = 'date >= ?'; extraParams = [from]; }
    else if (to) { extraWhere = 'date <= ?'; extraParams = [to]; }
    const requests = await requestsRepo.getRange({ employeeId: req.session.employeeId, status: req.query.status, extraWhere, extraParams, limit: 200 });
    res.json({ requests: requests.map(withDateMiti) });
  } catch (err) {
    console.error('GET /api/attendance/my-requests failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Admin — Leave requests
// ---------------------------------------------------------------------------
app.get('/api/admin/leave-requests', requireAdmin, async (req, res) => {
  try {
    const { from, to } = resolveDateRange(req.query);
    const status = req.query.status;
    let extraWhere = null, extraParams = [];
    if (from) { extraWhere = 'to_date >= ?'; extraParams = [from]; }
    if (to) { extraWhere = extraWhere ? extraWhere + ' AND from_date <= ?' : 'from_date <= ?'; extraParams.push(to); }
    const list = await leaveRequestsRepo.getRange({ status, extraWhere, extraParams, limit: 300 });
    res.json({ requests: list.map(withLeaveMiti) });
  } catch (err) {
    console.error('GET /api/admin/leave-requests failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/leave-requests/:id/decide', requireAdmin, async (req, res) => {
  try {
    const { decision } = req.body;
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
    const item = await leaveRequestsRepo.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Leave request not found.' });
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);

    if (decision === 'approved' && BALANCE_TRACKED_LEAVE_TYPES.includes(item.leaveType)) {
      const employees = await load('employees');
      const emp = employees.find(e => e.id === item.employeeId);
      const requestedDays = leaveDaysCount(item.fromDate, item.toDate);
      const { assigned, remaining } = await leaveBalanceFor(emp, item.leaveType, item.id);
      if (emp && requestedDays > remaining) {
        return res.status(400).json({ error: `Cannot approve: ${emp.name} only has ${remaining} of ${assigned} day(s) of ${item.leaveType} remaining, but this request needs ${requestedDays} day(s).` });
      }
    }

    item.adminDecision = decision;
    item.adminReviewedBy = admin ? admin.name : 'HR';
    item.adminReviewedAt = todayStr();
    item.status = computeApprovalStatus(item.managerDecision, item.adminDecision);
    await leaveRequestsRepo.update(item);
    res.json({ request: item });
    const employees = await load('employees');
    const emp = employees.find(e => e.id === item.employeeId);
    if (emp) notifyRequestDecided('leave', item, emp, 'admin', employees, admins);
  } catch (err) {
    console.error('POST /api/admin/leave-requests/:id/decide failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Admin — Attendance correction requests
// ---------------------------------------------------------------------------
app.get('/api/admin/corrections', requireAdmin, async (req, res) => {
  try {
    const { from, to } = resolveDateRange(req.query);
    const status = req.query.status;
    let list = await correctionsRepo.getRange({ status: status || undefined });
    if (from) list = list.filter(r => r.date >= from);
    if (to) list = list.filter(r => r.date <= to);
    res.json({ corrections: list.slice(0, 300).map(withDateMiti) });
  } catch (err) {
    console.error('GET /api/admin/corrections failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/corrections/:id/decide', requireAdmin, async (req, res) => {
  try {
    const result = await serialize(() => performCorrectionDecision(req, 'admin'));
    res.json(result);
    const employees = await load('employees');
    const emp = employees.find(e => e.id === result.correction.employeeId);
    if (emp) notifyRequestDecided('correction', result.correction, emp, 'admin', employees, await load('admins'));
  } catch (err) {
    if (err instanceof ApiError) return res.status(err.status).json(err.body);
    console.error('Correction decision failed:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});
async function performCorrectionDecision(req, role) {
  const { decision } = req.body;
  if (!['approved', 'rejected'].includes(decision)) throw new ApiError(400, { error: 'Invalid decision.' });
  const item = await correctionsRepo.getById(req.params.id);
  if (!item) throw new ApiError(404, { error: 'Correction request not found.' });

  let reviewerName;
  if (role === 'admin') {
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    reviewerName = admin ? admin.name : 'HR';
    item.adminDecision = decision;
    item.adminReviewedBy = reviewerName;
    item.adminReviewedAt = todayStr();
  } else {
    const employees = await load('employees');
    const reportEmp = employees.find(e => e.id === item.employeeId);
    if (!reportEmp || reportEmp.managerId !== req.session.employeeId) {
      throw new ApiError(403, { error: 'You are not the manager for this request.' });
    }
    const me = employees.find(e => e.id === req.session.employeeId);
    reviewerName = me ? me.name : 'Manager';
    item.managerDecision = decision;
    item.managerReviewedBy = reviewerName;
    item.managerReviewedAt = todayStr();
  }
  item.status = computeApprovalStatus(item.managerDecision, item.adminDecision);

  if (item.status === 'approved' && !item.applied) {
    await upsertAttendance({
      employeeId: item.employeeId, date: item.date,
      checkIn: item.requestedCheckIn, checkOut: item.requestedCheckOut,
      source: 'correction', adjustedBy: `${reviewerName} (correction approved)`
    });
    item.applied = true;
  }
  await correctionsRepo.update(item);
  return { correction: item };
}

// ---------------------------------------------------------------------------
// Admin — Holidays (company calendar)
// ---------------------------------------------------------------------------
app.get('/api/admin/holidays', requireAdmin, async (req, res) => {
  try {
    const holidays = (await load('holidays')).sort((a, b) => a.date.localeCompare(b.date)).map(withDateMiti);
    res.json({ holidays });
  } catch (err) {
    console.error('GET /api/admin/holidays failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/holidays', requireAdmin, async (req, res) => {
  try {
    let { date, name, bsYear, bsMonth, bsDay } = req.body;
    if (!date && bsYear && bsMonth && bsDay) {
      date = fromBs(bsYear, bsMonth, bsDay);
      if (!date) return res.status(400).json({ error: 'That Miti date is not valid — check the day exists in that BS month.' });
    }
    if (!date) return res.status(400).json({ error: 'A date is required.' });
    const holidays = await load('holidays');
    if (holidays.some(h => h.date === date)) return res.status(400).json({ error: 'A holiday is already defined for this date.' });
    const holiday = { id: `hol_${Date.now()}`, date, name: (name || '').trim() || 'Company Holiday' };
    await insertRow('holidays', holiday);
    res.json({ holiday: withDateMiti(holiday) });
  } catch (err) {
    console.error('POST /api/admin/holidays failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/admin/holidays/:id', requireAdmin, async (req, res) => {
  try {
    const holidays = await load('holidays');
    const exists = holidays.some(h => h.id === req.params.id);
    if (!exists) return res.status(404).json({ error: 'Holiday not found.' });
    await deleteRow('holidays', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/admin/holidays/:id failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Manager — approvals for direct reports (early checkouts + leave requests)
// A "manager" is simply any employee who appears as another employee's
// managerId — no separate role/login, they approve from their own staff
// portal.
// ---------------------------------------------------------------------------
app.get('/api/manager/requests', requireEmployee, async (req, res) => {
  try {
    const employees = await load('employees');
    const reportIds = employees.filter(e => e.managerId === req.session.employeeId).map(e => e.id);
    const status = req.query.status;

    if (!reportIds.length) return res.json({ early: [], leave: [], corrections: [] });
    const inClause = `employee_id IN (${reportIds.map(() => '?').join(',')})`;
    const [early, leave, corrections] = await Promise.all([
      requestsRepo.getRange({ status, extraWhere: inClause, extraParams: reportIds, limit: 200 }),
      leaveRequestsRepo.getRange({ status, extraWhere: inClause, extraParams: reportIds, limit: 200 }),
      correctionsRepo.getRange({ status, extraWhere: inClause, extraParams: reportIds, limit: 200 })
    ]);
    res.json({ early: early.map(withDateMiti), leave: leave.map(withLeaveMiti), corrections: corrections.map(withDateMiti) });
  } catch (err) {
    console.error('GET /api/manager/requests failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/manager/requests/:id/decide', requireEmployee, async (req, res) => {
  const { type, decision } = req.body; // type: 'early' | 'leave' | 'correction'
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision.' });
  if (!['early', 'leave', 'correction'].includes(type)) return res.status(400).json({ error: 'Invalid request type.' });

  if (type === 'correction') {
    try {
      const result = await serialize(() => performCorrectionDecision(req, 'manager'));
      res.json({ request: result.correction });
      const employees = await load('employees');
      const emp = employees.find(e => e.id === result.correction.employeeId);
      if (emp) notifyRequestDecided('correction', result.correction, emp, 'manager', employees, await load('admins'));
      return;
    } catch (err) {
      if (err instanceof ApiError) return res.status(err.status).json(err.body);
      console.error('Manager correction decision failed:', err);
      return res.status(500).json({ error: 'Something went wrong.' });
    }
  }

  const repo = type === 'leave' ? leaveRequestsRepo : requestsRepo;
  try {
    const employees = await load('employees');
    const item = await repo.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Request not found.' });

    const reportEmp = employees.find(e => e.id === item.employeeId);
    if (!reportEmp || reportEmp.managerId !== req.session.employeeId) {
      return res.status(403).json({ error: 'You are not the manager for this request.' });
    }

    if (type === 'leave' && decision === 'approved' && BALANCE_TRACKED_LEAVE_TYPES.includes(item.leaveType)) {
      const wouldBeApproved = computeApprovalStatus('approved', item.adminDecision) === 'approved';
      if (wouldBeApproved) {
        const requestedDays = leaveDaysCount(item.fromDate, item.toDate);
        const { assigned, remaining } = await leaveBalanceFor(reportEmp, item.leaveType, item.id);
        if (requestedDays > remaining) {
          return res.status(400).json({ error: `Cannot approve: ${reportEmp.name} only has ${remaining} of ${assigned} day(s) of ${item.leaveType} remaining, but this request needs ${requestedDays} day(s).` });
        }
      }
    }

    const me = employees.find(e => e.id === req.session.employeeId);
    item.managerDecision = decision;
    item.managerReviewedBy = me ? me.name : 'Manager';
    item.managerReviewedAt = todayStr();
    item.status = computeApprovalStatus(item.managerDecision, item.adminDecision);
    await repo.update(item);
    res.json({ request: item });
    notifyRequestDecided(type, item, reportEmp, 'manager', employees, await load('admins'));
  } catch (err) {
    console.error('POST /api/manager/requests/:id/decide failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Auto check-in / check-out
// For staff HR has toggled "auto attendance" on, the system checks them in
// at their shift start and out at their shift end automatically — no tap
// required. Runs once a minute; since it only acts exactly at the shift's
// start/end minute, it fires once per boundary per day. Skips anyone on
// approved leave, and skips the whole run on Saturdays/HR-defined holidays
// (isWorkingDay) — automation should never mark someone present on a day
// off. This only gates the automated tick: an employee can still tap
// check-in/check-out themselves on a holiday/Saturday if they actually
// come in (e.g. urgent work), since the manual endpoints don't call
// isWorkingDay. Auto-generated records have no location (nobody's phone
// was involved), so they fall back to "Remote" for working modality — HR
// can always correct that with a manual adjustment if needed.
// ---------------------------------------------------------------------------
async function runAutoAttendanceTick() {
  serialize(async () => {
    if (!await isWorkingDay(new Date(), await getHolidaySet())) return; // Saturday or holiday — no automation today
    const employees = (await load('employees')).filter(e => e.status === 'active' && e.autoAttendance);
    if (!employees.length) return;
    const today = todayStr();
    const time = nowTime();
    const [todaysAttendance, leaveRequests] = await Promise.all([
      attendanceRepo.getRange({ date: today }),
      load('leaveRequests')
    ]);
    const byEmp = new Map(todaysAttendance.map(a => [a.employeeId, a]));
    const toUpsert = [];

    for (const emp of employees) {
      if (await approvedLeaveOn(emp.id, today, leaveRequests)) continue;
      const rec = byEmp.get(emp.id);
      if (!rec && emp.shiftStart === time) {
        toUpsert.push({
          id: `att_auto_${Date.now()}_${emp.id}`,
          employeeId: emp.id, date: today, checkIn: time, checkOut: null,
          status: 'present', lateBy: 0, earlyCheckout: false, hoursWorked: 0,
          checkInIp: null, checkInLocation: null, checkOutIp: null, checkOutLocation: null,
          source: 'auto', adjustedBy: null, adjustedAt: null
        });
      } else if (rec && !rec.checkOut && emp.shiftEnd === time) {
        rec.checkOut = time;
        rec.hoursWorked = +(minutesBetween(rec.checkIn, time) / 60).toFixed(2);
        rec.source = rec.source || 'auto';
        toUpsert.push(rec);
      }
    }

    if (toUpsert.length) await attendanceRepo.bulkUpsert(toUpsert);
  }).catch(err => console.error('Auto-attendance tick failed:', err));
}
setInterval(runAutoAttendanceTick, 60 * 1000);

// ---------------------------------------------------------------------------
// Scheduled biometric sync — if HR has turned on "Automatic sync" under
// Admin → Company, this fetches from every configured device and applies
// the pending punches once a day at the configured time, so nobody has to
// remember to click Sync. Same one-tick-per-minute pattern as the
// auto-attendance tick above; a simple `lastRunDate` guard keeps it from
// firing more than once even though the interval checks every minute.
let lastAutoSyncDate = null;
async function runAutoSyncTick() {
  try {
    const s = await getSettings();
    if (!s.autoSyncEnabled) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = todayStr();
    if (hhmm !== (s.autoSyncTime || '08:00') || lastAutoSyncDate === today) return;
    lastAutoSyncDate = today;
    console.log(`[auto-sync] Running scheduled biometric device sync (${hhmm})...`);
    await zkSync.fetchFromAllDevices({ triggeredBy: 'Automatic sync' });
    const result = await zkSync.applyPending({ triggeredBy: 'Automatic sync' });
    console.log(`[auto-sync] Done — ${result.attendanceCreated} created, ${result.attendanceUpdated} updated.`);
  } catch (err) {
    console.error('[auto-sync] Scheduled sync failed:', err.message);
  }
}
setInterval(runAutoSyncTick, 60 * 1000);

// ---------------------------------------------------------------------------
// Biometric devices (ZKTeco) — Admin only. Supports multiple devices, each
// with its own IP and location label (e.g. "Main Gate", "Library Block").
// Sync is two steps: fetch (pull + store raw punches, never touches
// attendance) then apply (folds pending punches into attendance) — the
// admin UI shows a confirm dialog with getPendingPreview()'s output
// between the two, so nothing lands in attendance without HR seeing it
// first.
// ---------------------------------------------------------------------------

app.get('/api/admin/devices', requireAdmin, async (req, res) => {
  try {
    res.json({ devices: await zkSync.listDevices() });
  } catch (err) {
    console.error('GET /api/admin/devices failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/admin/devices', requireAdmin, async (req, res) => {
  try {
    const { name, location, ip, port, timeoutMs, inport } = req.body || {};
    if (!ip || !String(ip).trim()) return res.status(400).json({ error: 'Device IP address is required.' });
    const device = await zkSync.addDevice({ name, location, ip: String(ip).trim(), port: Number(port) || 4370, timeoutMs: Number(timeoutMs) || 10000, inport: Number(inport) || 5200 });
    res.json({ device });
  } catch (err) {
    console.error('POST /api/admin/devices failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.patch('/api/admin/devices/:id', requireAdmin, async (req, res) => {
  try {
    const { name, location, ip, port, timeoutMs, inport } = req.body || {};
    const device = await zkSync.updateDevice(req.params.id, { name, location, ip, port: port ? Number(port) : null, timeoutMs: timeoutMs ? Number(timeoutMs) : null, inport: inport ? Number(inport) : null });
    if (!device) return res.status(404).json({ error: 'Device not found.' });
    res.json({ device });
  } catch (err) {
    console.error('PATCH /api/admin/devices/:id failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.delete('/api/admin/devices/:id', requireAdmin, async (req, res) => {
  try {
    await zkSync.deleteDevice(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/admin/devices/:id failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Quick "Test connection" button — doesn't pull any data, just confirms
// the device answers on the network.
app.post('/api/admin/devices/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await zkSync.testConnection(req.params.id);
    res.json(result);
  } catch (err) {
    const status = err.code === 'NO_DEVICE_CONFIG' ? 404 : 502;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// Enrolled device users (fingerprints/cards) — pass ?deviceId= to scope to
// one device, or omit for all devices.
app.get('/api/admin/device/users', requireAdmin, async (req, res) => {
  try {
    res.json({ users: await zkSync.listDeviceUsers(req.query.deviceId || undefined) });
  } catch (err) {
    console.error('GET /api/admin/device/users failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Link (or unlink, by passing employeeId: null) a device-enrolled user to
// an app employee. Attendance from that device user only starts flowing
// into the employee's record once mapped.
app.post('/api/admin/device/:deviceId/users/:uid/map', requireAdmin, async (req, res) => {
  try {
    const { employeeId } = req.body || {};
    if (employeeId) {
      const employees = await load('employees');
      if (!employees.find(e => e.id === employeeId)) return res.status(400).json({ error: 'Unknown employee.' });
    }
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    // linkDeviceUser() does more than just point device_users at the
    // employee: it also backfills any historical punches from before this
    // device user was linked (which were stored with employee_id = NULL
    // and would otherwise sit orphaned forever) and immediately folds them
    // into attendance — so linking someone who missed auto-mapping fixes
    // their whole history in one action, not just punches from now on.
    const result = await zkSync.linkDeviceUser(req.params.deviceId, req.params.uid, employeeId || null, admin && admin.name);
    if (!result) return res.status(404).json({ error: 'Unknown device user — try syncing first.' });
    res.json({
      user: result.user,
      backfilled: result.backfilled,
      attendanceCreated: result.attendanceCreated,
      attendanceUpdated: result.attendanceUpdated
    });
  } catch (e) {
    console.error('Device user link failed:', e);
    res.status(500).json({ error: 'Something went wrong while linking this device user.' });
  }
});

// Creates a brand-new user "shell" directly on the device — a UID with a
// name (and optional card), auto-assigned to the next free UID so HR
// never has to pick one manually. This does NOT enroll a fingerprint/face
// (that still has to happen physically at the device, once, using the
// name this creates) — see the code comments in zkteco.js's createUser
// for why. Optionally links the new device user to an employee record in
// the same call.
app.post('/api/admin/device/:deviceId/users', requireAdmin, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const { card, employeeId } = req.body || {};
    if (employeeId) {
      const employees = await load('employees');
      if (!employees.find(e => e.id === employeeId)) return res.status(400).json({ error: 'Unknown employee.' });
    }
    const user = await zkSync.createDeviceUser(req.params.deviceId, { name, card, employeeId: employeeId || null });
    res.json({ user });
  } catch (e) {
    if (e.code === 'NO_DEVICE_CONFIG' || e.code === 'DEVICE_UNREACHABLE') {
      return res.status(503).json({ error: e.message });
    }
    if (e.code === 'DEVICE_FULL' || e.code === 'DEVICE_WRITE_REJECTED' || e.code === 'INVALID_NAME') {
      return res.status(400).json({ error: e.message });
    }
    console.error('Device user creation failed:', e);
    res.status(500).json({ error: 'Something went wrong while creating this device user.' });
  }
});

// Renames an enrolled device user — writes to the physical device itself
// (this is the one place the app writes to the device instead of just
// reading from it), not just our own database. Biometric templates
// (fingerprint/face) are untouched — those can only be (re-)captured at
// the device.
app.patch('/api/admin/device/:deviceId/users/:uid/name', requireAdmin, async (req, res) => {
  try {
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const user = await zkSync.renameDeviceUser(req.params.deviceId, req.params.uid, name);
    if (!user) return res.status(404).json({ error: 'Unknown device user — try syncing first.' });
    res.json({ user });
  } catch (e) {
    if (e.code === 'NO_DEVICE_CONFIG' || e.code === 'DEVICE_UNREACHABLE') {
      return res.status(503).json({ error: e.message });
    }
    if (e.code === 'DEVICE_USER_NOT_FOUND' || e.code === 'DEVICE_WRITE_REJECTED' || e.code === 'INVALID_NAME') {
      return res.status(400).json({ error: e.message });
    }
    console.error('Device user rename failed:', e);
    res.status(500).json({ error: 'Something went wrong while renaming this device user.' });
  }
});

// Raw punches straight from the device(s), independent of what made it
// into the attendance table — lets HR see exactly what the machine
// recorded. Pass ?deviceId= to scope to one device.
app.get('/api/admin/device/logs', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 500);
    const result = await zkSync.listDeviceLogs({
      page, pageSize, employeeId: req.query.employeeId || undefined, deviceId: req.query.deviceId || undefined,
      sortBy: req.query.sortBy || undefined, sortDir: req.query.sortDir || undefined
    });
    const employees = await load('employees');
    const byId = new Map(employees.map(e => [e.id, e]));
    res.json({
      ...result,
      logs: result.logs.map(l => ({ ...l, employeeName: l.employeeId ? (byId.get(l.employeeId)?.name || null) : null }))
    });
  } catch (err) {
    console.error('GET /api/admin/device/logs failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// History of sync runs (for troubleshooting / audit).
app.get('/api/admin/device/sync-logs', requireAdmin, async (req, res) => {
  try {
    res.json({ syncLogs: await zkSync.listSyncLogs(50) });
  } catch (err) {
    console.error('GET /api/admin/device/sync-logs failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Stage 1 — fetch from one device (or every configured device if no
// deviceId is given). Only pulls + stores raw punches; never touches
// attendance, so this is always safe to run without a confirmation step.
app.post('/api/admin/device/:deviceId/fetch', requireAdmin, async (req, res) => {
  try {
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    const triggeredBy = (admin && admin.name) || 'HR Admin';
    const result = req.params.deviceId === 'all'
      ? { ok: true, devices: await zkSync.fetchFromAllDevices({ triggeredBy }) }
      : await zkSync.fetchFromDevice(req.params.deviceId, { triggeredBy });
    res.json(result);
  } catch (err) {
    const status = err.code === 'NO_DEVICE_CONFIG' ? 400 : err.code === 'DEVICE_UNREACHABLE' ? 502 : 500;
    res.status(status).json({ ok: false, error: err.message });
  }
});

// What applying pending punches would do — powers the confirm dialog
// shown after a fetch, before anything touches attendance.
app.get('/api/admin/device/pending-preview', requireAdmin, async (req, res) => {
  try {
    res.json(await zkSync.getPendingPreview());
  } catch (err) {
    console.error('GET /api/admin/device/pending-preview failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Stage 2 — apply: folds every pending, mapped punch into attendance.
// This is the step gated behind the confirm dialog.
app.post('/api/admin/device/apply', requireAdmin, async (req, res) => {
  try {
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    const result = await zkSync.applyPending({ triggeredBy: (admin && admin.name) || 'HR Admin' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// "Update" button — re-reads every biometric punch on file for one
// employee+date (already-applied or not) and recomputes that day's
// check-in/check-out from scratch. For fixing a day that looks wrong or
// picking up punches that arrived after the day was first applied.
app.post('/api/admin/device/reprocess', requireAdmin, async (req, res) => {
  const { employeeId, date } = req.body || {};
  if (!employeeId || !date) return res.status(400).json({ error: 'employeeId and date are required.' });
  try {
    const admins = await load('admins');
    const admin = admins.find(a => a.id === req.session.adminId);
    const result = await zkSync.reprocessEmployeeDate(employeeId, date, { triggeredBy: (admin && admin.name) || 'HR Admin' });
    res.json(result);
  } catch (err) {
    const status = err.code === 'NO_PUNCHES' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Health check — for cPanel/uptime monitors, load balancers, or a simple
// `curl` sanity check after deploy. Confirms the process is up AND the
// database is actually reachable (not just that Node started).
app.get('/healthz', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unreachable.' });
  }
});

// ---------------------------------------------------------------------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let httpServer;
(async () => {
  try {
    await ensureSchema();
  } catch (err) {
    console.error('[db] Failed to set up the database schema:', err.message);
    console.error('     Check DB_HOST/DB_USER/DB_PASSWORD/DB_NAME and that the MySQL server is reachable.');
    process.exit(1);
  }
  try {
    await migrateDbStoredImagesToDisk();
  } catch (err) {
    // Non-fatal — worst case, any leftover base64-in-DB images stay as-is
    // and get picked up on the next restart; never block startup on this.
    console.error('[startup] Avatar/logo disk migration skipped due to an error:', err.message);
  }
  httpServer = app.listen(PORT, () => {
    console.log(`Attendance System running on http://localhost:${PORT}`);
  });
})();

// Belt-and-suspenders on top of the per-route try/catch blocks throughout
// this file: an async Express handler that throws without being awaited
// inside a try/catch (easy to miss in a codebase this size) produces an
// unhandled promise rejection, and Node's default behavior since v15 is to
// crash the whole process on that — taking down every other in-flight
// request with it. Logging and staying up is far safer for a production
// attendance system than one bad request killing the server for everyone.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// Graceful shutdown — stop accepting new connections, let in-flight
// requests finish, then close the MySQL pool cleanly. Matters most on
// cPanel/Passenger, which sends SIGTERM on every restart/redeploy; without
// this, requests mid-flight during a restart get dropped instead of
// completing, and the pool's connections aren't released cleanly.
function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);
  if (!httpServer) return process.exit(0);
  httpServer.close(async () => {
    try { await pool.end(); } catch (err) { /* already closing */ }
    process.exit(0);
  });
  // Don't hang forever waiting for slow in-flight requests.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
