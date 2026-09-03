// zkSync.js — reconciles data pulled from one or more ZKTeco biometric
// devices with the app's own database.
//
// The sync is split into two explicit stages so HR can review before
// anything touches attendance:
//   1. fetchFromDevice(deviceId)  — connects, pulls users + raw punches,
//      stores them (device_users / device_logs). Doesn't touch
//      `attendance`. Fast: only ever inserts punches it hasn't seen
//      before (deduped by a hash of device+uid+timestamp), in one batched
//      query rather than one round-trip per punch.
//   2. applyPending(...)          — folds every not-yet-applied, mapped
//      punch into `attendance` (source: 'biometric', modality forced to
//      Office since the device has no GPS — see workingModalityFor in
//      server.js). This is the step the admin UI gates behind a confirm
//      dialog showing exactly what's about to change.
//
// getPendingPreview() computes what applyPending() *would* do without
// doing it — that's what powers the confirm dialog.
//
// renameDeviceUser(...) is the one write path back to the device itself
// (everything else here only reads from it) — see zkteco.js's renameUser
// for the raw protocol details.
const crypto = require('crypto');
const { pool, query, load, attendanceRepo } = require('./db');
const zkteco = require('./zkteco');

function minutesBetween(t1, t2) {
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}
function pad(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function timeStr(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

// ---------------------------------------------------------------------------
// Device management (multiple devices, each with its own location)
// ---------------------------------------------------------------------------
function rowToDevice(r) {
  return {
    id: r.id, name: r.name, location: r.location, ip: r.ip, port: r.port,
    timeoutMs: r.timeout_ms, inport: r.inport,
    lastSyncedAt: r.last_synced_at, lastSyncStatus: r.last_sync_status, createdAt: r.created_at
  };
}
async function listDevices() {
  const rows = await query(`SELECT * FROM devices ORDER BY seq ASC`);
  return rows.map(rowToDevice);
}
async function getDevice(id) {
  const rows = await query(`SELECT * FROM devices WHERE id = ?`, [id]);
  return rows[0] ? rowToDevice(rows[0]) : null;
}
async function addDevice({ name, location, ip, port, timeoutMs, inport }) {
  const id = `device_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await query(
    `INSERT INTO devices (id, name, location, ip, port, timeout_ms, inport, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name || 'ZKTeco K40', location || null, ip, port || 4370, timeoutMs || 10000, inport || 5200, new Date().toISOString()]
  );
  return getDevice(id);
}
async function updateDevice(id, { name, location, ip, port, timeoutMs, inport }) {
  await query(
    `UPDATE devices SET name = COALESCE(?, name), location = COALESCE(?, location), ip = COALESCE(?, ip),
     port = COALESCE(?, port), timeout_ms = COALESCE(?, timeout_ms), inport = COALESCE(?, inport) WHERE id = ?`,
    [name || null, location || null, ip || null, port || null, timeoutMs || null, inport || null, id]
  );
  return getDevice(id);
}
async function deleteDevice(id) {
  await query(`DELETE FROM device_logs WHERE device_id = ?`, [id]);
  await query(`DELETE FROM device_users WHERE device_id = ?`, [id]);
  await query(`DELETE FROM devices WHERE id = ?`, [id]);
}
async function testConnection(id) {
  const device = await getDevice(id);
  if (!device) { const e = new Error('Unknown device.'); e.code = 'NO_DEVICE_CONFIG'; throw e; }
  return zkteco.testConnection(device);
}

// ---------------------------------------------------------------------------
// Device users (enrolled fingerprints/cards)
// ---------------------------------------------------------------------------
async function listDeviceUsers(deviceId) {
  const sql = deviceId
    ? `SELECT * FROM device_users WHERE device_id = ? ORDER BY name ASC`
    : `SELECT * FROM device_users ORDER BY name ASC`;
  const rows = await query(sql, deviceId ? [deviceId] : []);
  return rows.map(r => ({
    deviceId: r.device_id, uid: r.uid, deviceUserId: r.device_user_id, name: r.name, role: r.role, card: r.card,
    passwordSet: !!r.password_set, employeeId: r.employee_id, mappedBy: r.mapped_by,
    mappedAt: r.mapped_at, fetchedAt: r.fetched_at
  }));
}
async function mapDeviceUser(deviceId, uid, employeeId, adminName) {
  await query(
    `UPDATE device_users SET employee_id = ?, mapped_by = ?, mapped_at = ? WHERE device_id = ? AND uid = ?`,
    [employeeId || null, employeeId ? (adminName || 'HR Admin') : null, employeeId ? new Date().toISOString() : null, deviceId, uid]
  );
  const users = await listDeviceUsers(deviceId);
  return users.find(u => u.uid === uid);
}

/**
 * Renames an enrolled device user, on the device itself — not just in our
 * own database. Writes to the physical device first (the source of
 * truth for anything biometric-adjacent); only updates our local
 * device_users copy once that succeeds, so the two never drift out of
 * sync with each other.
 */
async function renameDeviceUser(deviceId, uid, newName) {
  const name = String(newName || '').trim();
  if (!name) { const err = new Error('A name is required.'); err.code = 'INVALID_NAME'; throw err; }
  const device = await getDevice(deviceId);
  if (!device) { const err = new Error('Unknown device.'); err.code = 'NO_DEVICE_CONFIG'; throw err; }

  await zkteco.renameUser(device, uid, name);
  await query(`UPDATE device_users SET name = ? WHERE device_id = ? AND uid = ?`, [name, deviceId, uid]);

  const users = await listDeviceUsers(deviceId);
  return users.find(u => u.uid === uid);
}

/**
 * Creates a brand-new user "shell" on the device (name + optional card,
 * no biometric template — see zkteco.js's createUser for why that part
 * can't be remote), then records it locally so it shows up in "Enrolled
 * device users" immediately without waiting for the next fetch/sync.
 * Optionally links it to an employee right away, same as mapDeviceUser.
 */
async function createDeviceUser(deviceId, { name, card, employeeId } = {}) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) { const err = new Error('A name is required.'); err.code = 'INVALID_NAME'; throw err; }
  const device = await getDevice(deviceId);
  if (!device) { const err = new Error('Unknown device.'); err.code = 'NO_DEVICE_CONFIG'; throw err; }

  const created = await zkteco.createUser(device, { name: trimmedName, card });
  await query(
    `INSERT INTO device_users (device_id, uid, device_user_id, name, role, card, password_set, employee_id, fetched_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)`,
    [deviceId, created.uid, created.deviceUserId, created.name, created.card, employeeId || null, new Date().toISOString()]
  );
  const users = await listDeviceUsers(deviceId);
  return users.find(u => u.uid === created.uid);
}

/**
 * Link (or unlink) a device-enrolled user to an app employee, AND make
 * sure their attendance actually reflects it — not just going forward.
 *
 * autoMapUser() only tags a punch with an employee_id at the moment it's
 * *fetched* from the device (see fetchFromDevice above); punches pulled in
 * before a device user was ever linked are permanently stamped
 * employee_id = NULL at insert time. Previously, manually linking a device
 * user later (mapDeviceUser alone) never went back and fixed those older
 * rows — so a staff member who didn't auto-link on day one would silently
 * be missing their attendance history from before someone noticed and
 * linked them, with no obvious way to recover it short of a full device
 * re-fetch (which itself only backfills device_users.employee_id, not the
 * already-stored device_logs rows).
 *
 * This does the full job in one step:
 *   1. Updates the device_users mapping (same as mapDeviceUser).
 *   2. Backfills every historical device_logs punch from that uid that
 *      predates the link (employee_id was NULL) to point at the newly
 *      linked employee.
 *   3. Immediately gathers and folds all of that employee's now-pending
 *      punches into `attendance` — so linking is a one-click "make my
 *      attendance correct" action instead of link-then-remember-to-hit-
 *      apply-separately.
 * On unlink (employeeId falsy), any *unprocessed* punches still sitting
 * under the old employee_id are cleared back to NULL, so a stale mapping
 * can never get silently applied to the wrong person by a later "Apply".
 */
async function linkDeviceUser(deviceId, uid, employeeId, adminName) {
  const user = await mapDeviceUser(deviceId, uid, employeeId, adminName);
  if (!user) return null;

  let backfilled = 0;
  let attendanceCreated = 0;
  let attendanceUpdated = 0;

  if (employeeId) {
    const [result] = await pool.query(
      `UPDATE device_logs SET employee_id = ? WHERE device_id = ? AND uid = ? AND employee_id IS NULL`,
      [employeeId, deviceId, uid]
    );
    backfilled = result.affectedRows;

    if (backfilled > 0) {
      const applied = await applyPending({ triggeredBy: adminName || 'HR Admin', employeeId });
      attendanceCreated = applied.attendanceCreated;
      attendanceUpdated = applied.attendanceUpdated;
    }
  } else {
    // Unlinking: don't leave not-yet-applied punches pointing at an
    // employee this device user is no longer mapped to.
    await query(
      `UPDATE device_logs SET employee_id = NULL WHERE device_id = ? AND uid = ? AND processed = 0`,
      [deviceId, uid]
    );
  }

  return { user, backfilled, attendanceCreated, attendanceUpdated };
}

/** Raw device punches, most recent first — for the standalone "Device Records" viewer. */
async function listDeviceLogs({ page = 1, pageSize = 50, employeeId, deviceId, sortBy = 'timestamp', sortDir = 'desc' } = {}) {
  const where = [];
  const params = [];
  if (employeeId) { where.push('dl.employee_id = ?'); params.push(employeeId); }
  if (deviceId) { where.push('dl.device_id = ?'); params.push(deviceId); }
  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const pageSizeClamped = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const pageClamped = Math.max(Number(page) || 1, 1);

  // Whitelisted sort columns only — never interpolate a client-supplied
  // column name directly into SQL. Employee/device name need a JOIN since
  // device_logs itself only stores the foreign-key ids, not the names.
  const SORT_COLUMNS = {
    timestamp: 'dl.timestamp', uid: 'dl.uid', processed: 'dl.processed',
    employeeName: 'e.name', deviceName: 'd.name'
  };
  const sortColumn = SORT_COLUMNS[sortBy] || SORT_COLUMNS.timestamp;
  const sortDirSql = sortDir === 'asc' ? 'ASC' : 'DESC';
  const fromSql = `device_logs dl LEFT JOIN employees e ON e.id = dl.employee_id LEFT JOIN devices d ON d.id = dl.device_id`;

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${fromSql}${whereSql}`, params);
  const rows = await query(
    `SELECT dl.* FROM ${fromSql}${whereSql} ORDER BY ${sortColumn} ${sortDirSql}, dl.timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSizeClamped, (pageClamped - 1) * pageSizeClamped]
  );
  return {
    logs: rows.map(r => ({
      id: r.id, deviceId: r.device_id, uid: r.uid, deviceUserId: r.device_user_id, employeeId: r.employee_id,
      timestamp: r.timestamp, verifyMode: r.verify_mode, inOutMode: r.in_out_mode,
      processed: !!r.processed, attendanceId: r.attendance_id, syncedAt: r.synced_at
    })),
    total, page: pageClamped, pageSize: pageSizeClamped, totalPages: Math.max(1, Math.ceil(total / pageSizeClamped)),
    sortBy: SORT_COLUMNS[sortBy] ? sortBy : 'timestamp', sortDir: sortDirSql === 'ASC' ? 'asc' : 'desc'
  };
}
async function listSyncLogs(limit = 50) {
  return query(`SELECT * FROM device_sync_logs ORDER BY started_at DESC LIMIT ?`, [limit]);
}

// Try to auto-link a freshly-seen device user to an existing employee by
// exact Employee ID match, then by case-insensitive name match.
function autoMapUser(deviceUser, employees) {
  let match = employees.find(e => e.employeeId && String(e.employeeId).toLowerCase() === deviceUser.deviceUserId.toLowerCase());
  if (!match) match = employees.find(e => e.name && e.name.trim().toLowerCase() === deviceUser.name.trim().toLowerCase());
  return match ? match.id : null;
}

// ---------------------------------------------------------------------------
// Stage 1 — fetch: pull from the device, store raw. Never touches
// `attendance`. Safe to run as often as you like; already-seen punches
// (same device+uid+timestamp) are skipped via a unique hash id, and every
// insert happens as one batched multi-row query instead of one round trip
// per punch, which is the main reason a sync of a device with a lot of
// history used to be slow.
// ---------------------------------------------------------------------------
async function fetchFromDevice(deviceId, { triggeredBy = 'HR Admin' } = {}) {
  const device = await getDevice(deviceId);
  const syncId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  const startedAt = new Date().toISOString();
  const summary = { fetchedUsers: 0, fetchedLogs: 0, newLogs: 0, unmappedUsers: 0 };

  try {
    if (!device || !device.ip) {
      const err = new Error('No device IP configured yet. Add it under Admin → Biometric Devices.');
      err.code = 'NO_DEVICE_CONFIG';
      throw err;
    }

    const deviceUsers = await zkteco.fetchUsers(device);
    summary.fetchedUsers = deviceUsers.length;
    const employees = await load('employees');
    const existingRows = await query(`SELECT uid, employee_id FROM device_users WHERE device_id = ?`, [deviceId]);
    const existingDeviceUsers = new Map(existingRows.map(r => [r.uid, r.employee_id]));
    const now = new Date().toISOString();

    if (deviceUsers.length) {
      const userValues = deviceUsers.map(u => {
        const alreadyMapped = existingDeviceUsers.has(u.uid) ? existingDeviceUsers.get(u.uid) : null;
        const employeeId = alreadyMapped || autoMapUser(u, employees);
        return [deviceId, u.uid, u.deviceUserId, u.name, u.role, u.card, u.passwordSet ? 1 : 0, employeeId, now];
      });
      await query(
        `INSERT INTO device_users (device_id, uid, device_user_id, name, role, card, password_set, employee_id, fetched_at)
         VALUES ?
         ON DUPLICATE KEY UPDATE
           device_user_id = VALUES(device_user_id), name = VALUES(name), role = VALUES(role),
           card = VALUES(card), password_set = VALUES(password_set), fetched_at = VALUES(fetched_at),
           employee_id = COALESCE(employee_id, VALUES(employee_id))`,
        [userValues]
      );
    }
    const unmappedRows = await query(`SELECT COUNT(*) c FROM device_users WHERE device_id = ? AND employee_id IS NULL`, [deviceId]);
    summary.unmappedUsers = unmappedRows[0].c;

    const logs = await zkteco.fetchAttendanceLogs(device);
    summary.fetchedLogs = logs.length;
    const userRows = await query(`SELECT uid, employee_id FROM device_users WHERE device_id = ?`, [deviceId]);
    const userMap = new Map(userRows.map(r => [r.uid, r.employee_id]));

    if (logs.length) {
      const logValues = logs.map(l => {
        const id = crypto.createHash('sha1').update(`${deviceId}:${l.uid}:${l.timestamp.toISOString()}`).digest('hex');
        return [id, deviceId, l.uid, l.deviceUserId, userMap.get(l.uid) || null, l.timestamp.toISOString(), l.verifyMode, l.inOutMode, 0, now];
      });
      // One batched INSERT IGNORE for the whole fetch, chunked to keep any
      // single query reasonably sized — this is the fix for "sync is
      // taking long": the old version did one round-trip per punch, so a
      // device with a few thousand stored punches meant a few thousand
      // sequential queries every single sync, even for punches already on
      // file. Batching (plus the id-based dedup already in place) means a
      // repeat sync only ever pays for what's actually new.
      const CHUNK = 500;
      let totalInserted = 0;
      for (let i = 0; i < logValues.length; i += CHUNK) {
        const chunk = logValues.slice(i, i + CHUNK);
        const [result] = await pool.query(
          `INSERT IGNORE INTO device_logs (id, device_id, uid, device_user_id, employee_id, timestamp, verify_mode, in_out_mode, processed, synced_at) VALUES ?`,
          [chunk]
        );
        totalInserted += result.affectedRows;
      }
      summary.newLogs = totalInserted;
    }

    await query(`UPDATE devices SET last_synced_at = ?, last_sync_status = 'success' WHERE id = ?`, [now, deviceId]);
    await query(
      `INSERT INTO device_sync_logs (id, device_id, stage, started_at, finished_at, status, fetched_users, fetched_logs, new_logs, triggered_by)
       VALUES (?, ?, 'fetch', ?, ?, 'success', ?, ?, ?, ?)`,
      [syncId, deviceId, startedAt, new Date().toISOString(), summary.fetchedUsers, summary.fetchedLogs, summary.newLogs, triggeredBy]
    );

    return { ok: true, deviceId, ...summary };
  } catch (err) {
    await query(`UPDATE devices SET last_sync_status = 'error' WHERE id = ?`, [deviceId]).catch(() => {});
    await query(
      `INSERT INTO device_sync_logs (id, device_id, stage, started_at, finished_at, status, fetched_users, fetched_logs, new_logs, unmapped_users, error_message, triggered_by)
       VALUES (?, ?, 'fetch', ?, ?, 'error', ?, ?, ?, ?, ?, ?)`,
      [syncId, deviceId, startedAt, new Date().toISOString(), summary.fetchedUsers, summary.fetchedLogs, summary.newLogs, summary.unmappedUsers, err.message, triggeredBy]
    );
    throw err;
  }
}

/** Runs fetchFromDevice for every configured device. */
async function fetchFromAllDevices({ triggeredBy = 'HR Admin' } = {}) {
  const devices = await listDevices();
  const results = [];
  for (const d of devices) {
    try {
      results.push(await fetchFromDevice(d.id, { triggeredBy }));
    } catch (err) {
      results.push({ ok: false, deviceId: d.id, error: err.message });
    }
  }
  return results;
}

// Groups every not-yet-applied, employee-mapped punch by employee+date —
// shared by both the preview (read-only) and apply (writes) paths so they
// can never disagree about what "pending" means.
async function groupPendingByEmployeeDate(employeeId) {
  const params = [];
  let sql = `SELECT * FROM device_logs WHERE processed = 0 AND employee_id IS NOT NULL`;
  if (employeeId) { sql += ` AND employee_id = ?`; params.push(employeeId); }
  sql += ` ORDER BY timestamp ASC`;
  const rows = await query(sql, params);
  const byEmpDate = new Map();
  for (const row of rows) {
    const ts = new Date(row.timestamp);
    const key = `${row.employee_id}__${dateStr(ts)}`;
    if (!byEmpDate.has(key)) byEmpDate.set(key, []);
    byEmpDate.get(key).push({ ...row, _ts: ts });
  }
  return byEmpDate;
}

/**
 * Stage 1.5 — preview: what would applyPending() do right now, without
 * doing it. Powers the "Confirm before updating records" dialog.
 */
async function getPendingPreview() {
  const byEmpDate = await groupPendingByEmployeeDate();
  if (!byEmpDate.size) return { totalPunches: 0, affectedDays: [] };

  const employees = await load('employees');
  const employeesById = new Map(employees.map(e => [e.id, e]));
  const empIds = [...new Set([...byEmpDate.keys()].map(k => k.split('__')[0]))];
  const existing = empIds.length
    ? await query(`SELECT employee_id, date, check_in, check_out FROM attendance WHERE employee_id IN (${empIds.map(() => '?').join(',')})`, empIds)
    : [];
  const existingByKey = new Map(existing.map(r => [`${r.employee_id}__${r.date}`, r]));

  const affectedDays = [];
  let totalPunches = 0;
  for (const [key, punches] of byEmpDate) {
    const [employeeId, date] = key.split('__');
    punches.sort((a, b) => a._ts - b._ts);
    const firstTime = timeStr(punches[0]._ts);
    const lastTime = punches.length > 1 ? timeStr(punches[punches.length - 1]._ts) : null;
    const emp = employeesById.get(employeeId);
    const current = existingByKey.get(key);
    totalPunches += punches.length;
    affectedDays.push({
      employeeId, employeeName: emp ? emp.name : '(unknown)', date,
      punchCount: punches.length,
      newCheckIn: firstTime, newCheckOut: lastTime,
      currentCheckIn: current ? current.check_in : null, currentCheckOut: current ? current.check_out : null,
      willCreate: !current
    });
  }
  affectedDays.sort((a, b) => a.date.localeCompare(b.date) || a.employeeName.localeCompare(b.employeeName));
  return { totalPunches, affectedDays };
}

/**
 * Stage 2 — apply: folds every pending, mapped punch into `attendance`.
 * This is the step gated behind the confirm dialog in the admin UI.
 */
async function applyPending({ triggeredBy = 'HR Admin', employeeId } = {}) {
  const syncId = `sync_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  const startedAt = new Date().toISOString();
  const summary = { attendanceCreated: 0, attendanceUpdated: 0 };

  const byEmpDate = await groupPendingByEmployeeDate(employeeId);
  if (!byEmpDate.size) return { ok: true, ...summary };

  const employeeIds = [...new Set([...byEmpDate.keys()].map(k => k.split('__')[0]))];
  const employees = await load('employees');
  const employeesById = new Map(employees.map(e => [e.id, e]));
  // Scoped to just the employees this run actually touches, and written
  // back with attendanceRepo.bulkUpsert (a real multi-row INSERT ...
  // ON DUPLICATE KEY UPDATE) rather than load('attendance') +
  // save('attendance', ...), which used to rewrite the *entire*
  // attendance table — every employee, every day, ever — on every single
  // sync. Beyond being slow at any real scale, that whole-table
  // delete+reinsert is a read-modify-write race: a staff check-in
  // landing between this function's load() and save() would be silently
  // wiped out by this save()'s stale full-table snapshot.
  const existing = await attendanceRepo.getRange({ employeeIds });
  const attByKey = new Map(existing.map(a => [`${a.employeeId}__${a.date}`, a]));
  const processedLogIds = [];
  const upserts = [];

  for (const [key, punches] of byEmpDate) {
    const [employeeId, date] = key.split('__');
    punches.sort((a, b) => a._ts - b._ts);
    const firstTime = timeStr(punches[0]._ts);
    const lastTime = punches.length > 1 ? timeStr(punches[punches.length - 1]._ts) : null;
    const emp = employeesById.get(employeeId);

    let rec = attByKey.get(key);
    const isNew = !rec;
    if (!rec) {
      rec = {
        id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        employeeId, date, checkIn: null, checkOut: null, status: 'present', lateBy: 0,
        earlyCheckout: false, hoursWorked: 0,
        checkInIp: null, checkInLocation: null, checkOutIp: null, checkOutLocation: null,
        source: null, adjustedBy: null, adjustedAt: null
      };
      attByKey.set(key, rec);
    }

    if (!rec.checkIn || firstTime < rec.checkIn) rec.checkIn = firstTime;
    if (lastTime && (!rec.checkOut || lastTime > rec.checkOut)) rec.checkOut = lastTime;
    else if (!lastTime && !rec.checkOut && punches.length === 1 && rec.checkIn !== firstTime) {
      if (firstTime > rec.checkIn) rec.checkOut = firstTime;
    }

    if (emp && rec.checkIn) {
      rec.lateBy = Math.max(0, minutesBetween(emp.shiftStart, rec.checkIn));
      rec.status = rec.lateBy > 5 ? 'late' : 'present';
    }
    if (rec.checkIn && rec.checkOut) {
      rec.hoursWorked = +(minutesBetween(rec.checkIn, rec.checkOut) / 60).toFixed(2);
    }
    // Biometric source forces the day's modality to Office at read time
    // (see workingModalityFor in server.js) since there's no GPS involved.
    rec.source = 'biometric';
    rec.adjustedBy = 'Biometric device sync';
    rec.adjustedAt = date;

    upserts.push(rec);
    if (isNew) summary.attendanceCreated++; else summary.attendanceUpdated++;
    for (const p of punches) processedLogIds.push({ logId: p.id, attendanceId: rec.id });
  }

  await attendanceRepo.bulkUpsert(upserts);

  // Batched, single-transaction "mark these as processed" instead of one
  // UPDATE per punch.
  if (processedLogIds.length) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const it of processedLogIds) {
        await conn.query(`UPDATE device_logs SET processed = 1, attendance_id = ? WHERE id = ?`, [it.attendanceId, it.logId]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  await query(
    `INSERT INTO device_sync_logs (id, stage, started_at, finished_at, status, attendance_created, attendance_updated, triggered_by)
     VALUES (?, 'apply', ?, ?, 'success', ?, ?, ?)`,
    [syncId, startedAt, new Date().toISOString(), summary.attendanceCreated, summary.attendanceUpdated, triggeredBy]
  );

  return { ok: true, ...summary };
}

/**
 * The "Update" button next to a device log / attendance row — re-reads
 * every device punch on file for one employee+date (regardless of whether
 * it was already applied) and recomputes that day's check-in/check-out
 * from scratch. Use this if punches came in after the day was already
 * folded in, or to force-refresh a day that looks wrong.
 */
async function reprocessEmployeeDate(employeeId, date, { triggeredBy = 'HR Admin' } = {}) {
  const rows = await query(
    `SELECT * FROM device_logs WHERE employee_id = ? AND LEFT(timestamp, 10) = ? ORDER BY timestamp ASC`,
    [employeeId, date]
  );
  if (!rows.length) {
    const err = new Error('No biometric punches on file for this employee on this date.');
    err.code = 'NO_PUNCHES';
    throw err;
  }
  const punches = rows.map(r => ({ ...r, _ts: new Date(r.timestamp) }));
  const firstTime = timeStr(punches[0]._ts);
  const lastTime = punches.length > 1 ? timeStr(punches[punches.length - 1]._ts) : null;

  const employees = await load('employees');
  const emp = employees.find(e => e.id === employeeId);
  // Single-row read/write via attendanceRepo instead of load('attendance')
  // + save('attendance', ...) — see the comment in applyPending() above
  // for why the whole-table version is both slow and unsafe under
  // concurrent writers.
  let rec = await attendanceRepo.getByEmpDate(employeeId, date);
  const isNew = !rec;
  if (!rec) {
    rec = {
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      employeeId, date, checkIn: null, checkOut: null, status: 'present', lateBy: 0,
      earlyCheckout: false, hoursWorked: 0,
      checkInIp: null, checkInLocation: null, checkOutIp: null, checkOutLocation: null,
      source: null, adjustedBy: null, adjustedAt: null
    };
  }
  rec.checkIn = firstTime;
  rec.checkOut = lastTime || rec.checkOut || null;
  if (emp && rec.checkIn) {
    rec.lateBy = Math.max(0, minutesBetween(emp.shiftStart, rec.checkIn));
    rec.status = rec.lateBy > 5 ? 'late' : 'present';
  }
  if (rec.checkIn && rec.checkOut) {
    rec.hoursWorked = +(minutesBetween(rec.checkIn, rec.checkOut) / 60).toFixed(2);
  }
  rec.source = 'biometric';
  rec.adjustedBy = `${triggeredBy} (manual re-sync)`;
  rec.adjustedAt = todayIso();

  await attendanceRepo.upsert(rec);
  await query(
    `UPDATE device_logs SET processed = 1, attendance_id = ? WHERE employee_id = ? AND LEFT(timestamp, 10) = ?`,
    [rec.id, employeeId, date]
  );
  return { record: rec, created: isNew, punchCount: punches.length };
}
function todayIso() { return new Date().toISOString().slice(0, 10); }

module.exports = {
  listDevices, getDevice, addDevice, updateDevice, deleteDevice, testConnection,
  listDeviceUsers, mapDeviceUser, renameDeviceUser, createDeviceUser, linkDeviceUser, listDeviceLogs, listSyncLogs,
  fetchFromDevice, fetchFromAllDevices, getPendingPreview, applyPending, reprocessEmployeeDate
};
