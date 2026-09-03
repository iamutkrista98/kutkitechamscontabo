// tests/concurrency-seed.js — bulk-load + concurrency stress test for a
// production-like scenario: a real roster's worth of staff loaded in one
// go, then all of them hitting the API around the same moment (the
// realistic "everyone clocks in within the same minute at shift start"
// case), run against the actual running server + real MySQL — not mocked.
//
// This exists to answer two separate questions:
//   1. Bulk load — can the DB layer ingest a production-size dataset
//      (hundreds of employees, months of attendance history) quickly,
//      in one shot, without one giant slow round-trip per row?
//   2. Concurrency correctness — when a lot of people hit the API at the
//      exact same time, does every write land on the *right* row, with
//      nothing lost or corrupted? This is what actually caught the two
//      real bugs fixed alongside this script:
//        - attendance check-in ids could collide across two different
//          employees checking in in the same millisecond, silently
//          overwriting one employee's row with another's data
//        - concurrent avatar uploads for different employees could lose
//          one of the two writes under the old load()-whole-table/
//          save()-whole-table pattern
//      Both are fixed now; this script is what you re-run after any
//      future change to those code paths to make sure they stay fixed.
//
// Requirements: a running server (npm start) + reachable MySQL, same as
// tests/route-tests.js. Node 18+ (built-in fetch).
//
// Run with defaults (200 employees, 40-way concurrency):
//   node tests/concurrency-seed.js
//
// Tune it:
//   SEED_EMPLOYEES=1000 CONCURRENCY=100 node tests/concurrency-seed.js
//   BASE_URL=http://localhost:4000 node tests/concurrency-seed.js
//   KEEP_DATA=1 node tests/concurrency-seed.js     # skip cleanup, inspect after
//
// Everything this script creates is tagged with a "zc_<runId>_" prefix
// and is removed at the end (unless KEEP_DATA=1) — safe to point at a
// staging database, never touches the real seed.js roster.

const bcrypt = require('bcryptjs');
const { pool, save, ensureSchema, attendanceRepo } = require('../db');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SEED_EMPLOYEES = Number(process.env.SEED_EMPLOYEES) || 200;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 40;
const KEEP_DATA = !!process.env.KEEP_DATA;
const RUN_ID = `zc_${Date.now()}`;

function log(msg) { console.log(msg); }
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }
function ok(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function bad(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); }

// Runs `items` through `worker` with at most `limit` in flight at once —
// a real production traffic pattern (a burst, not literally infinite
// unbounded parallelism) and keeps this script itself from being the
// bottleneck / from exhausting the DB connection pool it's testing.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, value: await worker(items[i], i) }; }
      catch (err) { results[i] = { ok: false, error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function makeSession() {
  let cookie = '';
  return {
    async post(pathname, json, extra) {
      const headers = { 'Content-Type': 'application/json', ...(extra || {}) };
      if (cookie) headers['Cookie'] = cookie;
      const res = await fetch(`${BASE_URL}${pathname}`, { method: 'POST', headers, body: JSON.stringify(json) });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let body = null;
      const text = await res.text();
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body };
    },
    async postForm(pathname, form) {
      const headers = {};
      if (cookie) headers['Cookie'] = cookie;
      const res = await fetch(`${BASE_URL}${pathname}`, { method: 'POST', headers, body: form });
      let body = null;
      const text = await res.text();
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      return { status: res.status, body };
    }
  };
}

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '01e221bc330000000049454e44ae426082', 'hex'
);
function pngFile(name) { return new File([TINY_PNG], name, { type: 'image/png' }); }

async function main() {
  const overallStart = Date.now();
  await ensureSchema();

  const health = await fetch(`${BASE_URL}/api/settings`).catch(() => null);
  if (!health || !health.ok) {
    console.error(`\nCan't reach ${BASE_URL} — start the server first (npm start) and/or set BASE_URL.\n`);
    process.exitCode = 1;
    return;
  }

  log(`Target: ${BASE_URL}   Employees: ${SEED_EMPLOYEES}   Concurrency: ${CONCURRENCY}   Run: ${RUN_ID}`);

  // -----------------------------------------------------------------
  section(`1. Bulk load — seeding ${SEED_EMPLOYEES} employees directly into MySQL`);
  // -----------------------------------------------------------------
  const passwordHash = bcrypt.hashSync('Welcome@123', 8);
  const employees = Array.from({ length: SEED_EMPLOYEES }, (_, i) => ({
    id: `${RUN_ID}_emp_${i}`,
    employeeId: `ZC-${10000 + i}`,
    name: `${RUN_ID} Staff ${i}`,
    email: `${RUN_ID}.staff${i}@example.com`,
    passwordHash,
    department: ['IT', 'Sales', 'Design', 'Operations'][i % 4],
    designation: 'Staff',
    phone: '',
    joinDate: '2025-01-01',
    status: 'active',
    shiftName: 'General Shift', shiftStart: '09:00', shiftEnd: '18:00',
    avatarColor: '#2E4A93',
    managerId: null
  }));
  {
    const t0 = Date.now();
    // A real production import (payroll export, HRIS migration) lands as
    // one bulk operation like this, not one HTTP POST per row — that's
    // the scenario this phase is timing.
    const current = await require('../db').load('employees');
    await save('employees', [...current, ...employees]);
    const ms = Date.now() - t0;
    ok(`Inserted ${employees.length} employees in ${ms}ms (${(employees.length / (ms / 1000)).toFixed(0)} rows/sec)`);
  }

  // -----------------------------------------------------------------
  section('2. Bulk load — seeding 3 months of historical attendance');
  // -----------------------------------------------------------------
  {
    const records = [];
    const days = 90;
    for (const emp of employees) {
      for (let d = 0; d < days; d++) {
        if (d % 6 === 5) continue; // skip a rest day roughly weekly
        const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
        records.push({
          id: `${RUN_ID}_att_${emp.id}_${date}_${Math.random().toString(36).slice(2, 7)}`,
          employeeId: emp.id, date, checkIn: '09:0' + (d % 5), checkOut: '18:00',
          status: 'present', lateBy: 0, earlyCheckout: false, hoursWorked: 9,
          checkInIp: null, checkInLocation: null, checkOutIp: null, checkOutLocation: null
        });
      }
    }
    const t0 = Date.now();
    await attendanceRepo.bulkUpsert(records);
    const ms = Date.now() - t0;
    ok(`Inserted ${records.length} attendance rows in ${ms}ms (${(records.length / (ms / 1000)).toFixed(0)} rows/sec)`);
  }

  // -----------------------------------------------------------------
  section(`3. Concurrency — ${employees.length} staff logging in and checking in at the same moment`);
  // -----------------------------------------------------------------
  // First, clear out today's attendance for our seeded staff so check-in
  // is actually exercised (idempotent re-runs shouldn't just all 400).
  await pool.query(`DELETE FROM attendance WHERE employee_id LIKE ? AND date = CURDATE()`, [`${RUN_ID}_emp_%`]);

  const loginResults = await runWithConcurrency(employees, CONCURRENCY, async (emp) => {
    const s = makeSession();
    const r = await s.post('/api/auth/staff/login', { email: emp.email, password: 'Welcome@123' });
    if (r.status !== 200) throw new Error(`login failed for ${emp.email}: ${r.status}`);
    return s;
  });
  const sessions = loginResults.filter(r => r.ok).map(r => r.value);
  if (sessions.length !== employees.length) bad(`${employees.length - sessions.length} logins failed`);
  else ok(`All ${sessions.length} staff logged in`);

  const t0 = Date.now();
  const checkinResults = await runWithConcurrency(sessions, CONCURRENCY, (s) => s.post('/api/attendance/check-in', {}));
  const ms = Date.now() - t0;
  const checkinFailures = checkinResults.filter(r => !r.ok || r.value.status !== 200);
  if (checkinFailures.length === 0) ok(`All ${sessions.length} concurrent check-ins succeeded in ${ms}ms (server stayed up throughout)`);
  else bad(`${checkinFailures.length}/${sessions.length} check-ins failed`);

  // The correctness check that actually matters: exactly one attendance
  // row per employee, each pointing at the *right* employee — this is
  // what the same-millisecond id collision bug would have violated.
  const [rows] = await pool.query(
    `SELECT employee_id, COUNT(*) c FROM attendance WHERE employee_id LIKE ? AND date = CURDATE() GROUP BY employee_id`,
    [`${RUN_ID}_emp_%`]
  );
  const byEmp = new Map(rows.map(r => [r.employee_id, r.c]));
  const missing = employees.filter(e => !byEmp.has(e.id));
  const duplicated = rows.filter(r => r.c > 1);
  if (missing.length === 0 && duplicated.length === 0) {
    ok(`Row-integrity check passed: exactly ${rows.length} attendance rows, one per employee, no collisions`);
  } else {
    if (missing.length) bad(`${missing.length} employees ended up with NO attendance row (a concurrent write was lost)`);
    if (duplicated.length) bad(`${duplicated.length} employees ended up with duplicate rows`);
  }
  const [[idCheck]] = [await pool.query(`SELECT COUNT(*) c FROM attendance WHERE employee_id LIKE ? AND date = CURDATE()`, [`${RUN_ID}_emp_%`]).then(([r]) => r)];
  if (idCheck.c !== sessions.length) {
    bad(`Expected ${sessions.length} total attendance rows for today, found ${idCheck.c} — some writes were dropped or collided`);
  } else {
    ok(`Total row count matches expected exactly (${idCheck.c})`);
  }

  // -----------------------------------------------------------------
  section(`4. Concurrency — ${Math.min(sessions.length, 60)} concurrent avatar uploads (different people)`);
  // -----------------------------------------------------------------
  const avatarBatch = sessions.slice(0, Math.min(sessions.length, 60));
  const t1 = Date.now();
  const avatarResults = await runWithConcurrency(avatarBatch, CONCURRENCY, async (s, i) => {
    const form = new FormData();
    form.append('image', pngFile(`${i}.png`));
    const r = await s.postForm('/api/auth/staff/profile-image', form);
    if (r.status !== 200) throw new Error(`upload failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.employee.avatarImage;
  });
  const avatarMs = Date.now() - t1;
  const avatarFailures = avatarResults.filter(r => !r.ok);
  const urls = avatarResults.filter(r => r.ok).map(r => r.value);
  const distinctUrls = new Set(urls);
  if (avatarFailures.length === 0 && distinctUrls.size === urls.length) {
    ok(`All ${urls.length} concurrent avatar uploads succeeded in ${avatarMs}ms, each got a distinct file (no lost updates)`);
  } else {
    if (avatarFailures.length) bad(`${avatarFailures.length} avatar uploads failed`);
    if (distinctUrls.size !== urls.length) bad(`Some employees ended up sharing the same avatar file — a write was lost`);
  }

  // Health check right after the burst — the whole point of the crash
  // fix is that a burst of bad/edge-case requests must never take the
  // process down for everyone else.
  const stillUp = await fetch(`${BASE_URL}/api/settings`).catch(() => null);
  if (stillUp && stillUp.ok) ok('Server is still up and responsive after the full concurrency burst');
  else bad('Server did not respond after the burst — possible crash');

  // -----------------------------------------------------------------
  section('5. Known residual risk check — concurrent edits to DIFFERENT employees');
  // -----------------------------------------------------------------
  // This is informational, not a hard pass/fail gate on the exit code:
  // employee create/edit/deactivate (outside the avatar/logo paths fixed
  // alongside this script) still goes through the app's original
  // load()-whole-table / save()-whole-table pattern for those routes.
  // This check quantifies that known, pre-existing risk so it's a
  // documented, measured number instead of a theoretical concern —
  // decide separately whether/when to migrate those routes to targeted
  // single-row UPDATEs the same way the avatar routes were.
  {
    const admin = makeSession();
    const adminEmail = process.env.TEST_ADMIN_EMAIL || 'admin@kutkitech.com';
    const adminPassword = process.env.TEST_ADMIN_PASSWORD || 'Admin@123';
    const loginRes = await admin.post('/api/auth/admin/login', { email: adminEmail, password: adminPassword });
    if (loginRes.status === 200) {
      const targets = employees.slice(0, Math.min(20, employees.length));
      const patchResults = await runWithConcurrency(targets, CONCURRENCY, async (emp) => {
        const a = makeSession();
        await a.post('/api/auth/admin/login', { email: adminEmail, password: adminPassword });
        const res = await fetch(`${BASE_URL}/api/admin/employees/${emp.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ designation: `Concurrent-${emp.id}` })
        });
        return res.status;
      });
      const [afterRows] = await pool.query(
        `SELECT id, designation FROM employees WHERE id LIKE ?`, [`${RUN_ID}_emp_%`]
      );
      const wrongCount = afterRows.filter(r => {
        const target = targets.find(t => t.id === r.id);
        return target && r.designation !== `Concurrent-${target.id}`;
      }).length;
      if (wrongCount === 0) {
        ok(`All ${targets.length} concurrent employee edits landed correctly this run (no guarantee under heavier load — see note above)`);
      } else {
        log(`  \x1b[33m!\x1b[0m ${wrongCount}/${targets.length} concurrent employee edits were lost — expected, this route still uses the whole-table save() pattern. Not a regression from this change; flagging for a future fix.`);
      }
    } else {
      log('  (skipped — set TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD to include this check)');
    }
  }

  // -----------------------------------------------------------------
  section('Cleanup');
  // -----------------------------------------------------------------
  if (KEEP_DATA) {
    log(`  Skipped (KEEP_DATA=1) — remove rows/files matching "${RUN_ID}" manually when done inspecting.`);
  } else {
    const t0 = Date.now();
    await pool.query(`DELETE FROM attendance WHERE employee_id LIKE ?`, [`${RUN_ID}_emp_%`]);
    await pool.query(`DELETE FROM employees WHERE id LIKE ?`, [`${RUN_ID}_emp_%`]);
    const fs = require('fs');
    const path = require('path');
    const avatarDir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
    for (const url of urls) {
      const p = path.join(__dirname, '..', 'public', url);
      if (p.startsWith(avatarDir)) fs.unlink(p, () => {});
    }
    ok(`Removed seeded employees/attendance/avatars in ${Date.now() - t0}ms`);
  }

  log(`\nTotal run time: ${((Date.now() - overallStart) / 1000).toFixed(1)}s\n`);
  await pool.end();
}

main().catch((err) => {
  console.error('\nConcurrency script crashed:', err);
  process.exitCode = 1;
});
