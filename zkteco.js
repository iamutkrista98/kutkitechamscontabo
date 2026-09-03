// zkteco.js — thin wrapper around the ZKTeco K40 biometric device.
//
// The K40 speaks ZKTeco's classic UDP/TCP "ZKLib" protocol (the same one
// used by their ZKTime/ZKAttendance software). `node-zklib` implements that
// protocol, so this module just wraps it with:
//   - sane defaults / config coming from the device_config table
//   - a connect/disconnect helper that always cleans up its socket
//   - normalised return shapes so the rest of the app never touches the
//     device library's raw field names directly
//
// Wiring: the K40 is a LAN/USB device — it has no cloud API. It must be on
// the same network as this server (or reachable via port-forward/VPN), with
// its IP address configured under Admin → Biometric Device → Device
// settings. Default port is 4370 (UDP), which is what the K40 uses out of
// the box.
const ZKLib = require('node-zklib');

// node-zklib only wraps read operations (getUsers/getAttendances/etc) plus
// a raw executeCmd() escape hatch — it has no built-in "write user"
// function. CMD_USER_WRQ (8) is the ZK protocol's write-user command; the
// payload below is the same 72-byte record layout every ZK device speaks
// (verified against pyzk, the most battle-tested open reference
// implementation of this protocol), sent as a raw Buffer via executeCmd.
const CMD_USER_WRQ = 8;
const CMD_ACK_OK = 2000;

/**
 * Packs a user record into the 72-byte layout ZK devices expect for
 * CMD_USER_WRQ:
 *   uid(2) privilege(1) password(8) name(24) card(4) pad(1) groupId(7) pad(1) userId(24)
 * Buffer.alloc zero-fills everything first, which is what gives every
 * string field its null-padding — we only ever write the bytes each value
 * actually needs.
 */
function packUserRecord({ uid, privilege = 0, password = '', name = '', card = 0, groupId = '', userId = '' }) {
  const buf = Buffer.alloc(72);
  buf.writeUInt16LE(uid & 0xffff, 0);
  buf.writeUInt8(privilege & 0xff, 2);
  buf.write(String(password), 3, 8, 'latin1');
  // Names outside basic Latin script (multi-byte UTF-8) could get cut mid-
  // character at exactly 24 bytes — acceptable for a first pass, but a
  // known limitation worth revisiting if non-Latin names come up.
  buf.write(String(name), 11, 24, 'utf8');
  buf.writeUInt32LE((Number(card) || 0) >>> 0, 35);
  buf.write(String(groupId), 40, 7, 'latin1');
  buf.write(String(userId), 48, 24, 'latin1');
  return buf;
}

/**
 * Opens a connection to the device, runs `fn(zk)` against it, and always
 * disconnects afterwards (even if `fn` throws). Centralizing this avoids
 * leaking sockets across the many small operations (get users, get logs,
 * get device info) callers need.
 */
async function withDevice(config, fn) {
  if (!config || !config.ip) {
    const err = new Error('No device IP configured. Set it under Admin → Biometric Device.');
    err.code = 'NO_DEVICE_CONFIG';
    throw err;
  }
  const zk = new ZKLib(config.ip, config.port || 4370, config.timeoutMs || 10000, config.inport || 5200);
  try {
    await zk.createSocket();
  } catch (err) {
    const wrapped = new Error(`Could not reach the device at ${config.ip}:${config.port || 4370} — ${err.message}`);
    wrapped.code = 'DEVICE_UNREACHABLE';
    throw wrapped;
  }
  try {
    return await fn(zk);
  } finally {
    try { await zk.disconnect(); } catch (_) { /* socket already gone — fine */ }
  }
}

/** Basic reachability/info check, used by the "Test connection" button. */
async function testConnection(config) {
  return withDevice(config, async (zk) => {
    const info = await zk.getInfo().catch(() => null);
    return { ok: true, info };
  });
}

/**
 * Returns the users enrolled directly on the device (via its own keypad /
 * fingerprint sensor), normalised to a flat shape.
 */
async function fetchUsers(config) {
  return withDevice(config, async (zk) => {
    const res = await zk.getUsers();
    const users = (res && res.data) || [];
    return users.map(u => ({
      uid: String(u.uid),
      deviceUserId: String(u.userId ?? u.uid),
      name: (u.name || '').trim() || `Device User ${u.userId ?? u.uid}`,
      role: u.role ?? 0,
      card: u.cardno ? String(u.cardno) : null,
      passwordSet: !!u.password
    }));
  });
}

/**
 * Renames the enrolled user at `uid` on the device itself — the point of
 * this isn't just cosmetic: it's what shows on the device's own screen at
 * punch time, and some ZKTeco device families print/report attendance
 * using this stored name. Biometric templates (fingerprint/face) are
 * completely untouched by this — those can only be captured at the device.
 *
 * We re-fetch the user first and resend every existing field alongside the
 * new name (not just the name in isolation) because CMD_USER_WRQ writes
 * the *whole* 72-byte record — sending just a name with everything else
 * zeroed would wipe that person's password/card/privilege on the device.
 */
async function renameUser(config, uid, newName) {
  return withDevice(config, async (zk) => {
    const res = await zk.getUsers();
    const users = (res && res.data) || [];
    const existing = users.find(u => String(u.uid) === String(uid));
    if (!existing) {
      const err = new Error(`No user with UID ${uid} found on this device — it may have been removed or the device needs a fresh sync.`);
      err.code = 'DEVICE_USER_NOT_FOUND';
      throw err;
    }
    const payload = packUserRecord({
      uid: Number(uid),
      privilege: existing.role ?? 0,
      password: existing.password || '',
      name: newName,
      card: existing.cardno || 0,
      groupId: '',
      userId: existing.userId ?? uid
    });
    const response = await zk.executeCmd(CMD_USER_WRQ, payload);
    const ackCode = response && response.length >= 2 ? response.readUInt16LE(0) : null;
    if (ackCode !== CMD_ACK_OK) {
      const err = new Error(`Device did not confirm the update (ack code: ${ackCode ?? 'none'}).`);
      err.code = 'DEVICE_WRITE_REJECTED';
      throw err;
    }
    return { uid: String(uid), name: newName.trim() };
  });
}

/**
 * Creates a brand-new user "shell" on the device — a UID with a name (and
 * optionally a card number) but no biometric template attached yet.
 * There's no way to capture a fingerprint/face remotely; the person still
 * has to walk up to the device and enroll once, the normal way, using the
 * name/UID this creates. This just saves HR from typing their name in on
 * the device's own keypad first.
 *
 * Auto-assigns the next free UID (smallest unused positive integer) so
 * the caller never has to guess one — reusing an existing UID would
 * silently overwrite that person's record (CMD_USER_WRQ always writes the
 * *whole* record for a UID, create or rename), so this is the one thing
 * worth getting right rather than leaving to the caller.
 */
async function createUser(config, { name, card } = {}) {
  return withDevice(config, async (zk) => {
    const res = await zk.getUsers();
    const users = (res && res.data) || [];
    const usedUids = new Set(users.map(u => Number(u.uid)));
    let uid = 1;
    while (usedUids.has(uid)) {
      uid++;
      if (uid > 9999) { // far beyond any real K40 deployment's headcount — a stuck loop, not a legitimate case
        const err = new Error('No free UID slots available on this device (checked up to 9999).');
        err.code = 'DEVICE_FULL';
        throw err;
      }
    }
    const payload = packUserRecord({
      uid,
      privilege: 0, // normal user, never admin — admin-on-device is a separate, deliberate device-console action
      password: '',
      name,
      card: card || 0,
      groupId: '',
      userId: uid
    });
    const response = await zk.executeCmd(CMD_USER_WRQ, payload);
    const ackCode = response && response.length >= 2 ? response.readUInt16LE(0) : null;
    if (ackCode !== CMD_ACK_OK) {
      const err = new Error(`Device did not confirm the new user (ack code: ${ackCode ?? 'none'}).`);
      err.code = 'DEVICE_WRITE_REJECTED';
      throw err;
    }
    return { uid: String(uid), deviceUserId: String(uid), name: String(name).trim(), card: card ? String(card) : null };
  });
}

/**
 * Returns raw attendance punches recorded on the device (fingerprint/card/
 * password scans), normalised to a flat shape. The device stores these
 * on its own internal clock — timestamps come back as JS Date objects.
 */
async function fetchAttendanceLogs(config) {
  return withDevice(config, async (zk) => {
    const res = await zk.getAttendances();
    const logs = (res && res.data) || [];
    return logs.map(l => ({
      uid: String(l.deviceUserId ?? l.uid),
      deviceUserId: String(l.deviceUserId ?? l.uid),
      timestamp: new Date(l.recordTime),
      verifyMode: l.verifyMode ?? l.verifyType ?? null, // 1=fingerprint, 2=pin, 3=password, 4=card (model-dependent)
      inOutMode: l.type ?? l.inOutMode ?? null
    })).filter(l => l.timestamp && !isNaN(l.timestamp.getTime()));
  });
}

/** Optional: clears the device's own log buffer after a successful sync. */
async function clearAttendanceLogs(config) {
  return withDevice(config, async (zk) => {
    await zk.clearAttendanceLog();
    return { ok: true };
  });
}

module.exports = { testConnection, fetchUsers, renameUser, createUser, fetchAttendanceLogs, clearAttendanceLogs };
