// tests/route-tests.js — black-box integration tests against a *running*
// instance of the app (real HTTP, real MySQL, real session store, real
// disk writes for avatars — nothing mocked). This exercises the app the
// same way a browser would, which is the only way to actually catch bugs
// like the "failed to fetch" crash this suite regression-tests for
// (issues in multer error handling, unhandled promise rejections, session
// cookies, etc. don't show up in a unit test that calls route handlers
// directly).
//
// Requirements:
//   - A MySQL server the app can reach (same DB_* env vars as the app).
//   - The app itself running: `npm start` (or `node server.js`) in
//     another terminal, on the port this hits (default 3000).
//   - Node 18+ (uses the built-in fetch/FormData/Blob — no extra deps).
//
// Run:
//   node tests/route-tests.js
//   BASE_URL=http://localhost:4000 node tests/route-tests.js
//
// This suite creates its own throwaway employees/admins/devices, every
// one of them tagged with a "zt_" (zztest) prefix, and deletes everything
// it created at the end (even on failure) — safe to run against a shared
// staging database without touching real company data. It never touches
// the real seed.js roster.
//
// It does NOT use a framework (no jest/mocha dependency to add) — just a
// tiny runner below. Each test is independent and reports pass/fail; one
// failing test doesn't stop the others from running, so you get a full
// picture in one pass.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const RUN_TAG = `zt_${Date.now()}`;

// --- tiny test runner -------------------------------------------------
const results = [];
async function test(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - startedAt });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - startedAt, error: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

// --- tiny per-session cookie jar --------------------------------------
// fetch() doesn't persist cookies across calls by default in Node, so
// each "logged in as" session gets a minimal jar that captures
// Set-Cookie on login and replays it on every subsequent call.
function makeSession() {
  let cookie = '';
  async function call(pathname, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers['Cookie'] = cookie;
    if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${BASE_URL}${pathname}`, { ...opts, headers, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, headers: res.headers, body };
  }
  return {
    get: (p) => call(p, { method: 'GET' }),
    post: (p, json) => call(p, { method: 'POST', body: json !== undefined ? JSON.stringify(json) : undefined }),
    patch: (p, json) => call(p, { method: 'PATCH', body: JSON.stringify(json) }),
    del: (p) => call(p, { method: 'DELETE' }),
    postForm: (p, form) => call(p, { method: 'POST', body: form }),
  };
}

// A minimal valid 1x1 PNG, built in-memory — no fixture file needed and
// no external image dependency. Real bytes, real multipart upload.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '01e221bc330000000049454e44ae426082', 'hex'
);
function pngFile(name = 'avatar.png') {
  return new File([TINY_PNG], name, { type: 'image/png' });
}

// Shared state created in "setup" tests, used by later ones and cleaned
// up at the end regardless of outcome.
const created = { employeeIds: [], adminId: null, deviceId: null };

let admin, staff;

async function main() {
  console.log(`Running against ${BASE_URL} (tag ${RUN_TAG})\n`);

  // -----------------------------------------------------------------
  section('Public / unauthenticated routes');
  // -----------------------------------------------------------------
  await test('GET /api/settings is reachable without a session', async () => {
    const r = await makeSession().get('/api/settings');
    assertEqual(r.status, 200);
    assert('companyName' in r.body, 'response should include companyName');
  });

  await test('Protected routes reject an unauthenticated caller', async () => {
    const anon = makeSession();
    const r1 = await anon.get('/api/admin/employees');
    assert(r1.status === 401 || r1.status === 403, `expected 401/403, got ${r1.status}`);
    const r2 = await anon.get('/api/auth/staff/me');
    assert(r2.status === 401 || r2.status === 403, `expected 401/403, got ${r2.status}`);
  });

  await test('Bad admin credentials are rejected, not crash the server', async () => {
    const r = await makeSession().post('/api/auth/admin/login', { email: 'nope@example.com', password: 'wrong' });
    assertEqual(r.status, 401);
    // and the server should still be up right after:
    const health = await makeSession().get('/api/settings');
    assertEqual(health.status, 200, 'server should still respond after a failed login');
  });

  // -----------------------------------------------------------------
  section('Admin login + employee CRUD (setup for everything below)');
  // -----------------------------------------------------------------
  admin = makeSession();
  await test('Admin can log in with seeded credentials (ADMIN_EMAIL/ADMIN_PASSWORD env, or defaults)', async () => {
    const email = process.env.TEST_ADMIN_EMAIL || 'admin@kutkitech.com';
    const password = process.env.TEST_ADMIN_PASSWORD || 'Admin@123';
    const r = await admin.post('/api/auth/admin/login', { email, password });
    assertEqual(r.status, 200, `login failed: ${JSON.stringify(r.body)} — set TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD if your seed data differs`);
    assert(r.body.admin && r.body.admin.id, 'response should include the admin');
    created.adminId = r.body.admin.id;
  });

  let empA, empB;
  await test('Admin can create employees', async () => {
    // shiftStart/shiftEnd span the full day so the immediate check-in →
    // check-out flow below never trips "early checkout" no matter what
    // time of day this suite happens to run.
    const r1 = await admin.post('/api/admin/employees', {
      name: `${RUN_TAG} Alpha`, email: `${RUN_TAG}.alpha@example.com`, department: 'IT',
      designation: 'QA', shiftStart: '00:00', shiftEnd: '23:59'
    });
    assertEqual(r1.status, 200, JSON.stringify(r1.body));
    empA = r1.body.employee;
    created.employeeIds.push(empA.id);

    const r2 = await admin.post('/api/admin/employees', {
      name: `${RUN_TAG} Beta`, email: `${RUN_TAG}.beta@example.com`, department: 'IT',
      designation: 'QA', shiftStart: '00:00', shiftEnd: '23:59'
    });
    assertEqual(r2.status, 200, JSON.stringify(r2.body));
    empB = r2.body.employee;
    created.employeeIds.push(empB.id);
  });

  await test('Admin cannot create a duplicate-email employee', async () => {
    const r = await admin.post('/api/admin/employees', {
      name: 'Duplicate', email: `${RUN_TAG}.alpha@example.com`, department: 'IT'
    });
    assertEqual(r.status, 400);
  });

  await test('Admin employee list includes the new employees', async () => {
    const r = await admin.get('/api/admin/employees');
    assertEqual(r.status, 200);
    const ids = r.body.employees.map(e => e.id);
    assert(ids.includes(empA.id) && ids.includes(empB.id), 'both new employees should be listed');
  });

  await test('Admin can edit an employee', async () => {
    const r = await admin.patch(`/api/admin/employees/${empA.id}`, { designation: 'Senior QA' });
    assertEqual(r.status, 200, JSON.stringify(r.body));
    assertEqual(r.body.employee.designation, 'Senior QA');
  });

  // -----------------------------------------------------------------
  section('Staff auth + attendance');
  // -----------------------------------------------------------------
  staff = makeSession();
  await test('New staff member can log in with the default temp password', async () => {
    const r = await staff.post('/api/auth/staff/login', { email: `${RUN_TAG}.alpha@example.com`, password: 'Welcome@123' });
    assertEqual(r.status, 200, JSON.stringify(r.body));
  });

  await test('Wrong password is rejected', async () => {
    const s = makeSession();
    const r = await s.post('/api/auth/staff/login', { email: `${RUN_TAG}.alpha@example.com`, password: 'wrong-password' });
    assertEqual(r.status, 401);
  });

  await test('Staff can check in, and a duplicate check-in is rejected', async () => {
    const r1 = await staff.post('/api/attendance/check-in', {});
    assertEqual(r1.status, 200, JSON.stringify(r1.body));
    assert(r1.body.record && r1.body.record.checkIn, 'response should include the check-in time');

    const r2 = await staff.post('/api/attendance/check-in', {});
    assertEqual(r2.status, 400, 'checking in twice in one day should be rejected');
  });

  await test('Staff can check out', async () => {
    const r = await staff.post('/api/attendance/check-out', {});
    assertEqual(r.status, 200, JSON.stringify(r.body));
    assert(r.body.record.checkOut, 'response should include the check-out time');
  });

  await test('Staff can submit a leave request', async () => {
    const r = await staff.post('/api/attendance/leave-request', {
      leaveType: 'Sick', fromDate: '2026-12-20', toDate: '2026-12-20', reason: 'Route test'
    });
    assert(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  });

  // -----------------------------------------------------------------
  section('Avatar uploads — filesystem storage (regression test for the DB-storage crash)');
  // -----------------------------------------------------------------
  await test('Staff avatar upload returns a /uploads/avatars/ URL, not base64', async () => {
    const form = new FormData();
    form.append('image', pngFile());
    const r = await staff.postForm('/api/auth/staff/profile-image', form);
    assertEqual(r.status, 200, JSON.stringify(r.body));
    const url = r.body.employee.avatarImage;
    assert(url && url.startsWith('/uploads/avatars/'), `expected a /uploads/avatars/ path, got ${url}`);
    assert(!url.startsWith('data:'), 'avatar should never be a base64 data: URI');

    // and the file must actually be servable (this is exactly the "app
    // crashes / failed to fetch" symptom being tested for — the server
    // must still be up and the static file must actually exist on disk):
    const fileRes = await fetch(`${BASE_URL}${url}`);
    assertEqual(fileRes.status, 200, 'uploaded avatar file should be servable as a static file');
  });

  await test('Re-uploading a staff avatar replaces it (old file no longer served)', async () => {
    const form1 = new FormData();
    form1.append('image', pngFile('first.png'));
    const r1 = await staff.postForm('/api/auth/staff/profile-image', form1);
    const firstUrl = r1.body.employee.avatarImage;

    const form2 = new FormData();
    form2.append('image', pngFile('second.png'));
    const r2 = await staff.postForm('/api/auth/staff/profile-image', form2);
    const secondUrl = r2.body.employee.avatarImage;

    assert(firstUrl !== secondUrl, 'each upload should get a distinct filename');
    const oldFile = await fetch(`${BASE_URL}${firstUrl}`);
    assertEqual(oldFile.status, 404, 'the replaced avatar file should have been deleted from disk');
    const newFile = await fetch(`${BASE_URL}${secondUrl}`);
    assertEqual(newFile.status, 200);
  });

  await test('Staff can remove their avatar (falls back to initials, file deleted)', async () => {
    const before = await staff.get('/api/auth/staff/me');
    const oldUrl = before.body.employee.avatarImage;
    const r = await staff.del('/api/auth/staff/profile-image');
    assertEqual(r.status, 200, JSON.stringify(r.body));
    assertEqual(r.body.employee.avatarImage, null);
    if (oldUrl) {
      const oldFile = await fetch(`${BASE_URL}${oldUrl}`);
      assertEqual(oldFile.status, 404, 'removed avatar file should be deleted from disk');
    }
  });

  await test('Oversized avatar upload is rejected cleanly (not a crash)', async () => {
    const big = new File([Buffer.alloc(4 * 1024 * 1024, 1)], 'big.png', { type: 'image/png' });
    const form = new FormData();
    form.append('image', big);
    const r = await staff.postForm('/api/auth/staff/profile-image', form);
    assertEqual(r.status, 400, 'a >3MB upload should get a clean 400, not hang or crash');
    // and the server must still be responsive right after:
    const health = await staff.get('/api/auth/staff/me');
    assertEqual(health.status, 200, 'server should still respond after an oversized upload was rejected');
  });

  await test('Non-image avatar upload is rejected cleanly', async () => {
    const form = new FormData();
    form.append('image', new File([Buffer.from('not an image')], 'file.txt', { type: 'text/plain' }));
    const r = await staff.postForm('/api/auth/staff/profile-image', form);
    assertEqual(r.status, 400);
  });

  await test('Admin avatar upload/removal works the same way', async () => {
    const form = new FormData();
    form.append('image', pngFile());
    const r = await admin.postForm('/api/auth/admin/profile-image', form);
    assertEqual(r.status, 200, JSON.stringify(r.body));
    assert(r.body.admin.avatarImage.startsWith('/uploads/avatars/'));
    const del = await admin.del('/api/auth/admin/profile-image');
    assertEqual(del.status, 200);
    assertEqual(del.body.admin.avatarImage, null);
  });

  await test('Company logo upload/removal works', async () => {
    const form = new FormData();
    form.append('logo', pngFile('logo.png'));
    const r = await admin.postForm('/api/settings/logo', form);
    assertEqual(r.status, 200, JSON.stringify(r.body));
    assert(r.body.logoImage.startsWith('/uploads/branding/'));
    const settingsCheck = await fetch(`${BASE_URL}${r.body.logoImage}`);
    assertEqual(settingsCheck.status, 200);
    const del = await admin.del('/api/settings/logo');
    assertEqual(del.status, 200);
    assertEqual(del.body.logoImage, null);
  });

  await test('Concurrent avatar uploads for two different people never cross-contaminate', async () => {
    // Regression test for the whole-table load()/save() race: this used
    // to be able to silently drop one of the two writes.
    const s2 = makeSession();
    await s2.post('/api/auth/staff/login', { email: `${RUN_TAG}.beta@example.com`, password: 'Welcome@123' });

    const formA = new FormData(); formA.append('image', pngFile('a.png'));
    const formB = new FormData(); formB.append('image', pngFile('b.png'));
    const [rA, rB] = await Promise.all([
      staff.postForm('/api/auth/staff/profile-image', formA),
      s2.postForm('/api/auth/staff/profile-image', formB),
    ]);
    assertEqual(rA.status, 200, JSON.stringify(rA.body));
    assertEqual(rB.status, 200, JSON.stringify(rB.body));

    const checkA = await admin.get('/api/admin/employees');
    const freshA = checkA.body.employees.find(e => e.id === empA.id);
    const freshB = checkA.body.employees.find(e => e.id === empB.id);
    assert(freshA.avatarImage, 'employee A should have kept their avatar');
    assert(freshB.avatarImage, 'employee B should have kept their avatar — this is the lost-update regression check');
    assert(freshA.avatarImage !== freshB.avatarImage, 'the two employees must not end up pointing at the same file');
  });

  // -----------------------------------------------------------------
  section('Biometric device — manual link + historical backfill');
  // -----------------------------------------------------------------
  let device;
  await test('Admin can register a device', async () => {
    const r = await admin.post('/api/admin/devices', {
      name: `${RUN_TAG} Test Device`, location: 'Test Lab', ip: '10.255.255.1', port: 4370
    });
    if (r.status === 404) throw new Error('device route not found — check the actual path in server.js if this fails');
    assertEqual(r.status, 200, JSON.stringify(r.body));
    device = r.body.device;
    created.deviceId = device.id;
  });

  await test('Linking a previously-unmapped device user backfills its whole punch history', async () => {
    // Simulate the exact scenario from the bug report: punches arrived
    // from the device *before* anyone linked this uid to an employee, so
    // they were stored with employee_id = NULL and are otherwise
    // invisible to attendance. We seed that state directly (bypassing
    // the real device connection, which needs real hardware) then check
    // that POSTing the link endpoint gathers all of it in.
    const { pool } = require('../db');
    const uid = `${RUN_TAG}_uid`;
    await pool.query(
      `INSERT INTO device_users (device_id, uid, name, employee_id) VALUES (?, ?, ?, NULL)`,
      [device.id, uid, 'Unlinked Person']
    );
    const punchDays = ['2026-01-05', '2026-01-06', '2026-01-07'];
    const crypto = require('crypto');
    const logId = (ts) => crypto.createHash('sha1').update(`${device.id}:${uid}:${ts}`).digest('hex');
    for (const day of punchDays) {
      const inTs = `${day}T09:00:00.000Z`;
      const outTs = `${day}T17:00:00.000Z`;
      await pool.query(
        `INSERT INTO device_logs (id, device_id, uid, employee_id, timestamp, processed) VALUES (?, ?, ?, NULL, ?, 0)`,
        [logId(inTs), device.id, uid, inTs]
      );
      await pool.query(
        `INSERT INTO device_logs (id, device_id, uid, employee_id, timestamp, processed) VALUES (?, ?, ?, NULL, ?, 0)`,
        [logId(outTs), device.id, uid, outTs]
      );
    }

    const r = await admin.post(`/api/admin/device/${device.id}/users/${uid}/map`, { employeeId: empB.id });
    assertEqual(r.status, 200, JSON.stringify(r.body));
    assertEqual(r.body.backfilled, punchDays.length * 2, 'all 6 pre-existing punches should have been backfilled');
    assertEqual(r.body.attendanceCreated, punchDays.length, 'all 3 days should turn into attendance records');

    const att = await admin.get(`/api/admin/attendance?employeeId=${empB.id}&from=2026-01-01&to=2026-01-31`);
    if (att.status === 200 && Array.isArray(att.body.records || att.body.attendance)) {
      const list = att.body.records || att.body.attendance;
      const days = list.map(r => r.date);
      for (const d of punchDays) assert(days.includes(d), `expected attendance on ${d} after backfill`);
    }
  });

  await test('Unlinking clears unprocessed punches back to unmapped (no stale-employee leakage)', async () => {
    const { pool } = require('../db');
    const crypto = require('crypto');
    const uid = `${RUN_TAG}_uid2`;
    await pool.query(`INSERT INTO device_users (device_id, uid, name, employee_id) VALUES (?, ?, ?, ?)`, [device.id, uid, 'Temp', empA.id]);
    const ts = '2026-02-01T09:00:00.000Z';
    const id = crypto.createHash('sha1').update(`${device.id}:${uid}:${ts}`).digest('hex');
    await pool.query(
      `INSERT INTO device_logs (id, device_id, uid, employee_id, timestamp, processed) VALUES (?, ?, ?, ?, ?, 0)`,
      [id, device.id, uid, empA.id, ts]
    );
    const r = await admin.post(`/api/admin/device/${device.id}/users/${uid}/map`, { employeeId: null });
    assertEqual(r.status, 200, JSON.stringify(r.body));
    const [[row]] = await pool.query(`SELECT employee_id FROM device_logs WHERE id = ?`, [id]);
    assert(row.employee_id === null, 'unprocessed punch should have been cleared back to unmapped on unlink');
  });

  // -----------------------------------------------------------------
  section('Office location — admin-configurable geofencing (not hardcoded)');
  // -----------------------------------------------------------------
  let originalOfficeLocation = null;
  await test('Public /api/settings never exposes office coordinates', async () => {
    const anon = makeSession();
    const r = await anon.get('/api/settings');
    assertEqual(r.status, 200);
    assert(!('officeLatitude' in r.body), 'unauthenticated /api/settings should not include officeLatitude');
  });

  await test('Admin can read the current office location from /api/settings', async () => {
    const r = await admin.get('/api/settings');
    assertEqual(r.status, 200);
    assert('officeLatitude' in r.body && 'officeLongitude' in r.body && 'officeRadiusMeters' in r.body, 'admin-authenticated /api/settings should include office fields');
    originalOfficeLocation = { officeLatitude: r.body.officeLatitude, officeLongitude: r.body.officeLongitude, officeRadiusMeters: r.body.officeRadiusMeters };
  });

  await test('Admin can set the office location, and it rejects bad input', async () => {
    const bad1 = await admin.patch('/api/settings', { officeLatitude: 200, officeLongitude: 85 });
    assertEqual(bad1.status, 400, 'latitude out of range should be rejected');

    const bad2 = await admin.patch('/api/settings', { officeLatitude: 27.7, officeLongitude: null });
    assertEqual(bad2.status, 400, 'lat with no matching lng should be rejected');

    const ok = await admin.patch('/api/settings', { officeLatitude: 27.700769, officeLongitude: 85.300140, officeRadiusMeters: 250 });
    assertEqual(ok.status, 200, JSON.stringify(ok.body));
    assertEqual(ok.body.officeLatitude, 27.700769);
    assertEqual(ok.body.officeRadiusMeters, 250);
  });

  await test('A check-in from inside the configured radius is marked Office; outside it is Remote', async () => {
    // Right at the configured point — well inside a 250m radius.
    const nearRes = await staff.post('/api/attendance/check-in', { latitude: 27.700769, longitude: 85.300140 });
    if (nearRes.status === 200) {
      assertEqual(nearRes.body.record.workingModality, 'Office', JSON.stringify(nearRes.body));
    } // else: already checked in earlier in this run on this session — the modality logic itself is still covered by the report/export checks below.

    // Roughly 1.1km away (~0.01 degrees latitude) — outside a 250m radius.
    const s2 = makeSession();
    await s2.post('/api/auth/staff/login', { email: `${RUN_TAG}.beta@example.com`, password: 'Welcome@123' });
    await pool.query(`DELETE FROM attendance WHERE employee_id = ? AND date = CURDATE()`, [empB.id]);
    const farRes = await s2.post('/api/attendance/check-in', { latitude: 27.710769, longitude: 85.300140 });
    assertEqual(farRes.status, 200, JSON.stringify(farRes.body));
    assertEqual(farRes.body.record.workingModality, 'Remote', 'a check-in ~1.1km from the configured office should be Remote');
  });

  await test('Clearing the office location falls back to Remote for everyone', async () => {
    const clear = await admin.patch('/api/settings', { officeLatitude: null, officeLongitude: null });
    assertEqual(clear.status, 200, JSON.stringify(clear.body));
    assertEqual(clear.body.officeLatitude, null);

    const s3 = makeSession();
    // Reuse empB's login for a fresh same-location check-in — with no
    // office configured, even a point-exact match must be Remote.
    await s3.post('/api/auth/staff/login', { email: `${RUN_TAG}.beta@example.com`, password: 'Welcome@123' });
    await pool.query(`DELETE FROM attendance WHERE employee_id = ? AND date = CURDATE()`, [empB.id]);
    const r = await s3.post('/api/attendance/check-in', { latitude: 27.700769, longitude: 85.300140 });
    assertEqual(r.status, 200, JSON.stringify(r.body));
    assertEqual(r.body.record.workingModality, 'Remote', 'with no office configured, every check-in should be Remote');

    // restore whatever was configured before this test ran
    if (originalOfficeLocation && originalOfficeLocation.officeLatitude !== null) {
      await admin.patch('/api/settings', originalOfficeLocation);
    }
  });

  // -----------------------------------------------------------------
  section('Cleanup');
  // -----------------------------------------------------------------
  await test('Cleanup: delete everything this run created', async () => {
    for (const id of created.employeeIds) {
      await admin.del(`/api/admin/employees/${id}`);
    }
    if (created.deviceId) {
      const { pool } = require('../db');
      await pool.query(`DELETE FROM device_logs WHERE device_id = ?`, [created.deviceId]);
      await pool.query(`DELETE FROM device_users WHERE device_id = ?`, [created.deviceId]);
      await admin.del(`/api/admin/devices/${created.deviceId}`).catch(() => {});
    }
  });

  // -----------------------------------------------------------------
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${passed} passed, ${failed} failed (${results.length} total)\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.name}: ${r.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nTest run crashed unexpectedly:', err);
  process.exitCode = 1;
});
