// db.js — MySQL-backed "database" layer for the KutkiTech attendance
// system, built for cPanel hosting (a standard cPanel MySQL database +
// user, reached over a local socket or 127.0.0.1).
//
// This exposes the same load(name) / save(name, data) shape the rest of
// the app was built around — but every call is now async (MySQL access in
// Node is inherently async, unlike the old better-sqlite3 setup), so every
// caller does `await load(...)` / `await save(...)`.
//
// Configure the connection via environment variables (cPanel: set these
// under the Node.js App's "Environment Variables" panel, or in a .env file
// next to this one — see README.md):
//   DB_HOST      default 127.0.0.1
//   DB_PORT      default 3306
//   DB_USER      required — your cPanel MySQL username (often
//                cpaneluser_dbuser)
//   DB_PASSWORD  required
//   DB_NAME      required — your cPanel MySQL database name (often
//                cpaneluser_dbname)
//
// A connection pool is used (not a single connection) so concurrent
// requests — several staff checking in around the same minute, HR pulling
// a report while someone else checks out — are handled as separate,
// properly-isolated MySQL connections rather than queueing behind one
// socket.
require('dotenv').config();
const mysql = require('mysql2/promise');
const { toBsShort } = require('./nepaliDate');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  // 20 comfortably covers a 200-500 person organization's shift-start
  // rush (queries are short — a handful of ms each — so connections
  // recycle fast; this isn't "20 people max at once", it's 20 in-flight
  // queries at any instant). queueLimit: 0 means requests beyond that
  // queue instead of erroring, so a burst just adds latency, never
  // hard failures. Override via DB_POOL_SIZE if your MySQL server's
  // own max_connections needs a smaller ceiling, or your traffic
  // pattern needs a bigger one.
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 20,
  queueLimit: 0,
  namedPlaceholders: true,
  dateStrings: true
});

if (!process.env.DB_USER || !process.env.DB_PASSWORD || !process.env.DB_NAME) {
  console.error(
    '\n[db] Missing DB_USER / DB_PASSWORD / DB_NAME environment variables.\n' +
    '     Set these to your cPanel MySQL database credentials before starting the app.\n' +
    '     See README.md → "cPanel / MySQL deployment" for the full checklist.\n'
  );
}

/** Run a raw query against the pool. Returns mysql2's [rows, fields]. */
async function query(sql, params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// ---------------------------------------------------------------------------
// Schema — created on first boot, left alone (IF NOT EXISTS) after that.
//
// Every table gets its own `id VARCHAR(64) PRIMARY KEY` (the app generates
// its own ids, same as before) plus a `seq BIGINT AUTO_INCREMENT UNIQUE`
// column purely for ordering — MySQL has no equivalent of SQLite's implicit
// rowid-as-insertion-order, so this recreates "newest/oldest first" sorting
// explicitly.
//
// Foreign keys are intentionally NOT declared (same reasoning as the old
// SQLite setup): save() below replaces a whole table's contents in one
// transaction, and an FK-enforced cascading delete on the parent table
// would wipe every related child row before the re-insert of the parent
// rows even happened. The app itself keeps employeeId references
// consistent, so the database doesn't need to enforce it.
// ---------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS employees (
    seq                  BIGINT AUTO_INCREMENT UNIQUE,
    id                   VARCHAR(64) PRIMARY KEY,
    employee_id          VARCHAR(64) UNIQUE NOT NULL,
    name                 VARCHAR(255) NOT NULL,
    email                VARCHAR(255) UNIQUE NOT NULL,
    password_hash        VARCHAR(255) NOT NULL,
    department           VARCHAR(255) NOT NULL,
    designation          VARCHAR(255),
    phone                VARCHAR(64),
    join_date            VARCHAR(32),
    status               VARCHAR(32) DEFAULT 'active',
    shift_name           VARCHAR(64),
    shift_start          VARCHAR(16),
    shift_end            VARCHAR(16),
    avatar_color         VARCHAR(32),
    avatar_image         MEDIUMTEXT,
    manager_id           VARCHAR(64),
    auto_attendance      TINYINT DEFAULT 0,
    exempt_from_approval TINYINT DEFAULT 0,
    can_view_all_reports TINYINT DEFAULT 0,
    leave_balances       TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS admins (
    seq           BIGINT AUTO_INCREMENT UNIQUE,
    id            VARCHAR(64) PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(64),
    designation   VARCHAR(255),
    avatar_image  MEDIUMTEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS settings (
    seq                   BIGINT AUTO_INCREMENT UNIQUE,
    id                    VARCHAR(64) PRIMARY KEY,
    company_name          VARCHAR(255),
    logo_image            MEDIUMTEXT,
    weekly_off_days       VARCHAR(32) DEFAULT '6',
    auto_sync_enabled     TINYINT DEFAULT 0,
    auto_sync_time        VARCHAR(8) DEFAULT '08:00',
    office_latitude       DOUBLE,
    office_longitude      DOUBLE,
    office_radius_meters  INT DEFAULT 300
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS attendance (
    seq                 BIGINT AUTO_INCREMENT UNIQUE,
    id                  VARCHAR(64) PRIMARY KEY,
    employee_id         VARCHAR(64) NOT NULL,
    date                VARCHAR(16) NOT NULL,
    miti                VARCHAR(32),
    check_in            VARCHAR(16),
    check_out           VARCHAR(16),
    status              VARCHAR(32),
    late_by             INT DEFAULT 0,
    early_checkout      TINYINT DEFAULT 0,
    hours_worked        DOUBLE DEFAULT 0,
    check_in_ip         VARCHAR(64),
    check_in_lat        DOUBLE,
    check_in_lng        DOUBLE,
    check_in_accuracy   DOUBLE,
    check_in_area       VARCHAR(255),
    check_out_ip        VARCHAR(64),
    check_out_lat       DOUBLE,
    check_out_lng       DOUBLE,
    check_out_accuracy  DOUBLE,
    check_out_area      VARCHAR(255),
    source              VARCHAR(32),
    adjusted_by         VARCHAR(255),
    adjusted_at         VARCHAR(32),
    UNIQUE KEY uniq_emp_date (employee_id, date),
    KEY idx_attendance_date (date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS requests (
    seq                 BIGINT AUTO_INCREMENT UNIQUE,
    id                  VARCHAR(64) PRIMARY KEY,
    employee_id         VARCHAR(64) NOT NULL,
    employee_name       VARCHAR(255),
    emp_code            VARCHAR(64),
    date                VARCHAR(16),
    requested_time      VARCHAR(16),
    reason              TEXT,
    status              VARCHAR(32) DEFAULT 'pending',
    reviewed_by         VARCHAR(255),
    reviewed_at         VARCHAR(32),
    created_at          VARCHAR(32),
    manager_decision    VARCHAR(32) DEFAULT 'not_required',
    manager_reviewed_by VARCHAR(255),
    manager_reviewed_at VARCHAR(32),
    admin_decision      VARCHAR(32) DEFAULT 'pending',
    admin_reviewed_by   VARCHAR(255),
    admin_reviewed_at   VARCHAR(32),
    KEY idx_requests_employee (employee_id),
    KEY idx_requests_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS leave_requests (
    seq                 BIGINT AUTO_INCREMENT UNIQUE,
    id                  VARCHAR(64) PRIMARY KEY,
    employee_id         VARCHAR(64) NOT NULL,
    employee_name       VARCHAR(255),
    emp_code            VARCHAR(64),
    leave_type          VARCHAR(64),
    from_date           VARCHAR(16),
    to_date             VARCHAR(16),
    reason              TEXT,
    status              VARCHAR(32) DEFAULT 'pending',
    created_at          VARCHAR(32),
    manager_decision    VARCHAR(32) DEFAULT 'not_required',
    manager_reviewed_by VARCHAR(255),
    manager_reviewed_at VARCHAR(32),
    admin_decision      VARCHAR(32) DEFAULT 'pending',
    admin_reviewed_by   VARCHAR(255),
    admin_reviewed_at   VARCHAR(32),
    KEY idx_leave_requests_employee (employee_id),
    KEY idx_leave_requests_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS holidays (
    seq   BIGINT AUTO_INCREMENT UNIQUE,
    id    VARCHAR(64) PRIMARY KEY,
    date  VARCHAR(16) UNIQUE NOT NULL,
    name  VARCHAR(255)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS corrections (
    seq                  BIGINT AUTO_INCREMENT UNIQUE,
    id                   VARCHAR(64) PRIMARY KEY,
    employee_id          VARCHAR(64) NOT NULL,
    employee_name        VARCHAR(255),
    emp_code             VARCHAR(64),
    date                 VARCHAR(16) NOT NULL,
    requested_check_in   VARCHAR(16),
    requested_check_out  VARCHAR(16),
    reason               TEXT,
    status               VARCHAR(32) DEFAULT 'pending',
    manager_decision     VARCHAR(32) DEFAULT 'not_required',
    manager_reviewed_by  VARCHAR(255),
    manager_reviewed_at  VARCHAR(32),
    admin_decision       VARCHAR(32) DEFAULT 'pending',
    admin_reviewed_by    VARCHAR(255),
    admin_reviewed_at    VARCHAR(32),
    applied              TINYINT DEFAULT 0,
    created_at           VARCHAR(32),
    KEY idx_corrections_employee (employee_id),
    KEY idx_corrections_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // -- ZKTeco biometric devices — supports multiple, each with its own
  // location (e.g. "Main Gate", "Library Block") -----------------------
  `CREATE TABLE IF NOT EXISTS devices (
    seq               BIGINT AUTO_INCREMENT UNIQUE,
    id                VARCHAR(64) PRIMARY KEY,
    name              VARCHAR(128) DEFAULT 'ZKTeco K40',
    location          VARCHAR(255),
    ip                VARCHAR(64),
    port              INT DEFAULT 4370,
    timeout_ms        INT DEFAULT 10000,
    inport            INT DEFAULT 5200,
    last_synced_at    VARCHAR(32),
    last_sync_status  VARCHAR(32),
    created_at        VARCHAR(32)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS device_users (
    seq             BIGINT AUTO_INCREMENT UNIQUE,
    device_id       VARCHAR(64) NOT NULL,
    uid             VARCHAR(64) NOT NULL,
    device_user_id  VARCHAR(64),
    name            VARCHAR(255),
    role            INT,
    card            VARCHAR(64),
    password_set    TINYINT DEFAULT 0,
    employee_id     VARCHAR(64),
    mapped_by       VARCHAR(255),
    mapped_at       VARCHAR(32),
    fetched_at      VARCHAR(32),
    PRIMARY KEY (device_id, uid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Every raw punch pulled from a device — a permanent, unedited audit
  // trail. `processed` tracks whether it's already been folded into the
  // attendance table, so a later sync (or the "gather" step of the
  // confirm-before-apply flow) never re-fetches or re-processes the same
  // punch twice; that's the core of why repeat syncs are fast.
  `CREATE TABLE IF NOT EXISTS device_logs (
    seq             BIGINT AUTO_INCREMENT UNIQUE,
    id              VARCHAR(64) PRIMARY KEY,
    device_id       VARCHAR(64) NOT NULL,
    uid             VARCHAR(64),
    device_user_id  VARCHAR(64),
    employee_id     VARCHAR(64),
    timestamp       VARCHAR(32) NOT NULL,
    verify_mode     INT,
    in_out_mode     INT,
    processed       TINYINT DEFAULT 0,
    attendance_id   VARCHAR(64),
    synced_at       VARCHAR(32),
    KEY idx_device_logs_device_uid_ts (device_id, uid, timestamp),
    KEY idx_device_logs_employee (employee_id, timestamp),
    KEY idx_device_logs_processed (processed)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS device_sync_logs (
    seq                 BIGINT AUTO_INCREMENT UNIQUE,
    id                  VARCHAR(64) PRIMARY KEY,
    device_id           VARCHAR(64),
    stage               VARCHAR(16) DEFAULT 'apply', -- 'fetch' or 'apply'
    started_at          VARCHAR(32),
    finished_at         VARCHAR(32),
    status              VARCHAR(32),
    fetched_users       INT DEFAULT 0,
    fetched_logs        INT DEFAULT 0,
    new_logs            INT DEFAULT 0,
    attendance_created  INT DEFAULT 0,
    attendance_updated  INT DEFAULT 0,
    unmapped_users      INT DEFAULT 0,
    error_message       TEXT,
    triggered_by        VARCHAR(255)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // -- Forgot-password: HR-assisted resets + self-service email OTP ----
  `CREATE TABLE IF NOT EXISTS password_reset_requests (
    seq           BIGINT AUTO_INCREMENT UNIQUE,
    id            VARCHAR(64) PRIMARY KEY,
    user_type     VARCHAR(16) NOT NULL,
    user_id       VARCHAR(64) NOT NULL,
    email         VARCHAR(255) NOT NULL,
    name          VARCHAR(255),
    status        VARCHAR(32) DEFAULT 'pending',
    requested_at  VARCHAR(32),
    resolved_at   VARCHAR(32),
    resolved_by   VARCHAR(255)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS password_otps (
    seq           BIGINT AUTO_INCREMENT UNIQUE,
    id            VARCHAR(64) PRIMARY KEY,
    user_type     VARCHAR(16) NOT NULL,
    user_id       VARCHAR(64) NOT NULL,
    email         VARCHAR(255) NOT NULL,
    otp_hash      VARCHAR(255) NOT NULL,
    expires_at    VARCHAR(32) NOT NULL,
    used          TINYINT DEFAULT 0,
    created_at    VARCHAR(32),
    KEY idx_password_otps_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function ensureSchema() {
  for (const ddl of SCHEMA) {
    await query(ddl);
  }
  await runMigrations();
}

// ---------------------------------------------------------------------------
// Lightweight migrations — safely add columns introduced after the initial
// release without requiring anyone to drop/recreate an existing database.
// ---------------------------------------------------------------------------
async function ensureColumn(table, column, ddl) {
  const rows = await query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (rows.length === 0) {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

async function runMigrations() {
  // Every column below already exists in a fresh SCHEMA install above —
  // these calls are effectively no-ops on a new database and only do real
  // work when upgrading a database created by an earlier version of this
  // app (kept here so an existing production database upgrades cleanly).
  await ensureColumn('employees', 'avatar_image', 'MEDIUMTEXT');
  await ensureColumn('employees', 'manager_id', 'VARCHAR(64)');
  await ensureColumn('employees', 'auto_attendance', 'TINYINT DEFAULT 0');
  await ensureColumn('employees', 'exempt_from_approval', 'TINYINT DEFAULT 0');
  await ensureColumn('employees', 'can_view_all_reports', 'TINYINT DEFAULT 0');
  await ensureColumn('employees', 'leave_balances', 'TEXT');
  await ensureColumn('admins', 'avatar_image', 'MEDIUMTEXT');
  await ensureColumn('attendance', 'check_in_area', 'VARCHAR(255)');
  await ensureColumn('attendance', 'check_out_area', 'VARCHAR(255)');
  await ensureColumn('attendance', 'source', 'VARCHAR(32)');
  await ensureColumn('attendance', 'adjusted_by', 'VARCHAR(255)');
  await ensureColumn('attendance', 'adjusted_at', 'VARCHAR(32)');
  await ensureColumn('requests', 'manager_decision', "VARCHAR(32) DEFAULT 'not_required'");
  await ensureColumn('requests', 'manager_reviewed_by', 'VARCHAR(255)');
  await ensureColumn('requests', 'manager_reviewed_at', 'VARCHAR(32)');
  await ensureColumn('requests', 'admin_decision', "VARCHAR(32) DEFAULT 'pending'");
  await ensureColumn('requests', 'admin_reviewed_by', 'VARCHAR(255)');
  await ensureColumn('requests', 'admin_reviewed_at', 'VARCHAR(32)');
  await ensureColumn('leave_requests', 'manager_decision', "VARCHAR(32) DEFAULT 'not_required'");
  await ensureColumn('leave_requests', 'manager_reviewed_by', 'VARCHAR(255)');
  await ensureColumn('leave_requests', 'manager_reviewed_at', 'VARCHAR(32)');
  await ensureColumn('leave_requests', 'admin_decision', "VARCHAR(32) DEFAULT 'pending'");
  await ensureColumn('leave_requests', 'admin_reviewed_by', 'VARCHAR(255)');
  await ensureColumn('leave_requests', 'admin_reviewed_at', 'VARCHAR(32)');
  await ensureColumn('settings', 'weekly_off_days', "VARCHAR(32) DEFAULT '6'");
  await ensureColumn('attendance', 'miti', 'VARCHAR(32)');
  const rowsMissingMiti = await query(`SELECT id, date FROM attendance WHERE miti IS NULL LIMIT 5000`);
  if (rowsMissingMiti.length) {
    for (const row of rowsMissingMiti) {
      await query(`UPDATE attendance SET miti = ? WHERE id = ?`, [toBsShort(row.date), row.id]);
    }
  }
  await ensureColumn('settings', 'auto_sync_enabled', 'TINYINT DEFAULT 0');
  await ensureColumn('settings', 'auto_sync_time', "VARCHAR(8) DEFAULT '08:00'");
  // Office location used to be a hardcoded constant in server.js (one
  // fixed lat/lng baked into the code), which meant deploying this app
  // for a different organization required editing source code. It's now
  // admin-configurable (Company tab) and lives here instead — NULL
  // lat/lng (the default for any database created before this column
  // existed) just means "not configured yet", and check-ins fall back to
  // "Remote" until an admin sets a real office location.
  await ensureColumn('settings', 'office_latitude', 'DOUBLE');
  await ensureColumn('settings', 'office_longitude', 'DOUBLE');
  await ensureColumn('settings', 'office_radius_meters', 'INT DEFAULT 300');

  // Upgrade path from the earlier single-device design: if an old
  // `device_config` table exists (pre-multi-device), fold its one row
  // into the new `devices` table as "Main Device" and drop it, so
  // existing installs keep their device IP/settings instead of needing
  // to re-enter them.
  const oldDeviceConfigTable = await query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_config'`
  );
  if (oldDeviceConfigTable.length) {
    const oldRows = await query(`SELECT * FROM device_config LIMIT 1`);
    if (oldRows.length && oldRows[0].ip) {
      const existing = await query(`SELECT id FROM devices LIMIT 1`);
      if (!existing.length) {
        await query(
          `INSERT INTO devices (id, name, location, ip, port, timeout_ms, inport, last_synced_at, last_sync_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ['device_default', oldRows[0].name || 'ZKTeco K40', 'Main Office', oldRows[0].ip, oldRows[0].port, oldRows[0].timeout_ms, oldRows[0].inport, oldRows[0].last_synced_at, oldRows[0].last_sync_status, new Date().toISOString()]
        );
        // Existing device_users/device_logs rows predate the device_id
        // column — they're all from this one migrated device.
        await ensureColumn('device_users', 'device_id', "VARCHAR(64) DEFAULT 'device_default'");
        await ensureColumn('device_logs', 'device_id', "VARCHAR(64) DEFAULT 'device_default'");
        await query(`UPDATE device_users SET device_id = 'device_default' WHERE device_id IS NULL OR device_id = ''`);
        await query(`UPDATE device_logs SET device_id = 'device_default' WHERE device_id IS NULL OR device_id = ''`);
      }
    }
    await query(`DROP TABLE device_config`);
  }

  // Backfill: any early-checkout requests approved/rejected under the old
  // single-approver flow get their admin_decision set to match their
  // existing overall status, so nothing already decided appears to
  // regress to pending.
  await query(`
    UPDATE requests SET admin_decision = status, admin_reviewed_by = reviewed_by, admin_reviewed_at = reviewed_at
    WHERE status IN ('approved','rejected') AND (admin_decision IS NULL OR admin_decision = 'pending')
  `);
}

// ---------------------------------------------------------------------------
// Row <-> app-object mapping
// Keeps every other file in the app working with the same camelCase shapes
// (and nested checkInLocation/checkOutLocation objects) it always has.
// ---------------------------------------------------------------------------
const TABLES = {
  settings: {
    sqlTable: 'settings',
    orderBy: 'seq ASC',
    toRow(s) {
      return {
        id: s.id, company_name: s.companyName || null, logo_image: s.logoImage || null,
        weekly_off_days: s.weeklyOffDays || '6', auto_sync_enabled: s.autoSyncEnabled ? 1 : 0, auto_sync_time: s.autoSyncTime || '08:00',
        office_latitude: s.officeLatitude === undefined || s.officeLatitude === null || s.officeLatitude === '' ? null : Number(s.officeLatitude),
        office_longitude: s.officeLongitude === undefined || s.officeLongitude === null || s.officeLongitude === '' ? null : Number(s.officeLongitude),
        office_radius_meters: s.officeRadiusMeters === undefined || s.officeRadiusMeters === null || s.officeRadiusMeters === '' ? 300 : Number(s.officeRadiusMeters)
      };
    },
    fromRow(r) {
      return {
        id: r.id, companyName: r.company_name, logoImage: r.logo_image, weeklyOffDays: r.weekly_off_days || '6',
        autoSyncEnabled: !!r.auto_sync_enabled, autoSyncTime: r.auto_sync_time || '08:00',
        officeLatitude: r.office_latitude === null || r.office_latitude === undefined ? null : Number(r.office_latitude),
        officeLongitude: r.office_longitude === null || r.office_longitude === undefined ? null : Number(r.office_longitude),
        officeRadiusMeters: r.office_radius_meters === null || r.office_radius_meters === undefined ? 300 : Number(r.office_radius_meters)
      };
    }
  },
  employees: {
    sqlTable: 'employees',
    orderBy: 'seq ASC',
    toRow(e) {
      return {
        id: e.id, employee_id: e.employeeId, name: e.name, email: e.email,
        password_hash: e.passwordHash, department: e.department, designation: e.designation || null,
        phone: e.phone || null, join_date: e.joinDate || null, status: e.status || 'active',
        shift_name: e.shiftName || null, shift_start: e.shiftStart || null, shift_end: e.shiftEnd || null,
        avatar_color: e.avatarColor || null, avatar_image: e.avatarImage || null,
        manager_id: e.managerId || null,
        auto_attendance: e.autoAttendance ? 1 : 0,
        exempt_from_approval: e.exemptFromApproval ? 1 : 0,
        can_view_all_reports: e.canViewAllReports ? 1 : 0,
        leave_balances: JSON.stringify(e.leaveBalances || {})
      };
    },
    fromRow(r) {
      return {
        id: r.id, employeeId: r.employee_id, name: r.name, email: r.email,
        passwordHash: r.password_hash, department: r.department, designation: r.designation,
        phone: r.phone, joinDate: r.join_date, status: r.status,
        shiftName: r.shift_name, shiftStart: r.shift_start, shiftEnd: r.shift_end,
        avatarColor: r.avatar_color, avatarImage: r.avatar_image,
        managerId: r.manager_id || null,
        autoAttendance: !!r.auto_attendance,
        exemptFromApproval: !!r.exempt_from_approval,
        canViewAllReports: !!r.can_view_all_reports,
        leaveBalances: (() => { try { return r.leave_balances ? JSON.parse(r.leave_balances) : {}; } catch { return {}; } })()
      };
    }
  },
  admins: {
    sqlTable: 'admins',
    orderBy: 'seq ASC',
    toRow(a) {
      return { id: a.id, name: a.name, email: a.email, password_hash: a.passwordHash, role: a.role || null, designation: a.designation || null, avatar_image: a.avatarImage || null };
    },
    fromRow(r) {
      return { id: r.id, name: r.name, email: r.email, passwordHash: r.password_hash, role: r.role, designation: r.designation, avatarImage: r.avatar_image };
    }
  },
  attendance: {
    sqlTable: 'attendance',
    orderBy: 'seq ASC',
    toRow(a) {
      const ci = a.checkInLocation || {}, co = a.checkOutLocation || {};
      return {
        id: a.id, employee_id: a.employeeId, date: a.date, miti: a.miti || toBsShort(a.date),
        check_in: a.checkIn || null, check_out: a.checkOut || null,
        status: a.status || null, late_by: a.lateBy || 0, early_checkout: a.earlyCheckout ? 1 : 0,
        hours_worked: a.hoursWorked || 0, check_in_ip: a.checkInIp || null,
        check_in_lat: ci.latitude ?? null, check_in_lng: ci.longitude ?? null, check_in_accuracy: ci.accuracy ?? null,
        check_in_area: ci.area || null,
        check_out_ip: a.checkOutIp || null,
        check_out_lat: co.latitude ?? null, check_out_lng: co.longitude ?? null, check_out_accuracy: co.accuracy ?? null,
        check_out_area: co.area || null,
        source: a.source || null, adjusted_by: a.adjustedBy || null, adjusted_at: a.adjustedAt || null
      };
    },
    fromRow(r) {
      return {
        id: r.id, employeeId: r.employee_id, date: r.date, miti: r.miti || toBsShort(r.date),
        checkIn: r.check_in, checkOut: r.check_out,
        status: r.status, lateBy: r.late_by, earlyCheckout: !!r.early_checkout, hoursWorked: r.hours_worked,
        checkInIp: r.check_in_ip,
        checkInLocation: r.check_in_lat != null ? { latitude: r.check_in_lat, longitude: r.check_in_lng, accuracy: r.check_in_accuracy, area: r.check_in_area } : null,
        checkOutIp: r.check_out_ip,
        checkOutLocation: r.check_out_lat != null ? { latitude: r.check_out_lat, longitude: r.check_out_lng, accuracy: r.check_out_accuracy, area: r.check_out_area } : null,
        source: r.source, adjustedBy: r.adjusted_by, adjustedAt: r.adjusted_at
      };
    }
  },
  requests: {
    sqlTable: 'requests',
    orderBy: 'seq DESC', // requests were originally unshift()'d — newest first
    toRow(req) {
      return {
        id: req.id, employee_id: req.employeeId, employee_name: req.employeeName, emp_code: req.empCode,
        date: req.date, requested_time: req.requestedTime, reason: req.reason, status: req.status || 'pending',
        reviewed_by: req.reviewedBy || null, reviewed_at: req.reviewedAt || null, created_at: req.createdAt || null,
        manager_decision: req.managerDecision || 'not_required', manager_reviewed_by: req.managerReviewedBy || null, manager_reviewed_at: req.managerReviewedAt || null,
        admin_decision: req.adminDecision || 'pending', admin_reviewed_by: req.adminReviewedBy || null, admin_reviewed_at: req.adminReviewedAt || null
      };
    },
    fromRow(r) {
      return {
        id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, empCode: r.emp_code,
        date: r.date, requestedTime: r.requested_time, reason: r.reason, status: r.status,
        reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, createdAt: r.created_at,
        managerDecision: r.manager_decision || 'not_required', managerReviewedBy: r.manager_reviewed_by, managerReviewedAt: r.manager_reviewed_at,
        adminDecision: r.admin_decision || 'pending', adminReviewedBy: r.admin_reviewed_by, adminReviewedAt: r.admin_reviewed_at
      };
    }
  },
  leaveRequests: {
    sqlTable: 'leave_requests',
    orderBy: 'seq DESC',
    toRow(req) {
      return {
        id: req.id, employee_id: req.employeeId, employee_name: req.employeeName, emp_code: req.empCode,
        leave_type: req.leaveType || 'Casual Leave', from_date: req.fromDate, to_date: req.toDate,
        reason: req.reason, status: req.status || 'pending', created_at: req.createdAt || null,
        manager_decision: req.managerDecision || 'not_required', manager_reviewed_by: req.managerReviewedBy || null, manager_reviewed_at: req.managerReviewedAt || null,
        admin_decision: req.adminDecision || 'pending', admin_reviewed_by: req.adminReviewedBy || null, admin_reviewed_at: req.adminReviewedAt || null
      };
    },
    fromRow(r) {
      return {
        id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, empCode: r.emp_code,
        leaveType: r.leave_type, fromDate: r.from_date, toDate: r.to_date,
        reason: r.reason, status: r.status, createdAt: r.created_at,
        managerDecision: r.manager_decision || 'not_required', managerReviewedBy: r.manager_reviewed_by, managerReviewedAt: r.manager_reviewed_at,
        adminDecision: r.admin_decision || 'pending', adminReviewedBy: r.admin_reviewed_by, adminReviewedAt: r.admin_reviewed_at
      };
    }
  },
  holidays: {
    sqlTable: 'holidays',
    orderBy: 'date ASC',
    toRow(h) {
      return { id: h.id, date: h.date, name: h.name || null };
    },
    fromRow(r) {
      return { id: r.id, date: r.date, name: r.name };
    }
  },
  corrections: {
    sqlTable: 'corrections',
    orderBy: 'seq DESC',
    toRow(c) {
      return {
        id: c.id, employee_id: c.employeeId, employee_name: c.employeeName, emp_code: c.empCode,
        date: c.date, requested_check_in: c.requestedCheckIn || null, requested_check_out: c.requestedCheckOut || null,
        reason: c.reason, status: c.status || 'pending',
        manager_decision: c.managerDecision || 'not_required', manager_reviewed_by: c.managerReviewedBy || null, manager_reviewed_at: c.managerReviewedAt || null,
        admin_decision: c.adminDecision || 'pending', admin_reviewed_by: c.adminReviewedBy || null, admin_reviewed_at: c.adminReviewedAt || null,
        applied: c.applied ? 1 : 0, created_at: c.createdAt || null
      };
    },
    fromRow(r) {
      return {
        id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, empCode: r.emp_code,
        date: r.date, requestedCheckIn: r.requested_check_in, requestedCheckOut: r.requested_check_out,
        reason: r.reason, status: r.status,
        managerDecision: r.manager_decision || 'not_required', managerReviewedBy: r.manager_reviewed_by, managerReviewedAt: r.manager_reviewed_at,
        adminDecision: r.admin_decision || 'pending', adminReviewedBy: r.admin_reviewed_by, adminReviewedAt: r.admin_reviewed_at,
        applied: !!r.applied, createdAt: r.created_at
      };
    }
  }
};

/** Read an entire table, returned as an array of camelCase app objects. */
async function load(name) {
  const t = TABLES[name];
  if (!t) throw new Error(`Unknown table: ${name}`);
  const rows = await query(`SELECT * FROM ${t.sqlTable} ORDER BY ${t.orderBy}`);
  return rows.map(t.fromRow);
}

/**
 * Replace an entire table's contents with `data` (an array of camelCase app
 * objects), inside a single transaction. This mirrors the old
 * "load the array, mutate it in JS, save the whole array back" pattern the
 * app was built around, so callers don't need to change beyond awaiting it
 * — at this scale (a handful of staff, a few thousand attendance rows over
 * years) a delete-and-reinsert is milliseconds, and it keeps every write
 * atomic even under concurrent requests.
 */
async function save(name, data) {
  const t = TABLES[name];
  if (!t) throw new Error(`Unknown table: ${name}`);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM ${t.sqlTable}`);
    if (data.length) {
      const columns = Object.keys(t.toRow(data[0]));
      const values = data.map(item => {
        const row = t.toRow(item);
        return columns.map(c => row[c]);
      });
      await conn.query(
        `INSERT INTO ${t.sqlTable} (${columns.join(',')}) VALUES ?`,
        [values]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Single-row helpers for employees/admins/settings — used by hot,
// frequently-concurrent write paths (profile photo upload/removal) where
// load()/save() whole-table replace would race: two people saving around
// the same moment can silently drop one another's change, because save()
// deletes and re-inserts the *entire* table from whichever caller's
// in-memory snapshot happens to commit last (see the comment above
// buildAttendanceRepo for the same problem attendance used to have, before
// it got attendanceRepo). Two staff members uploading a profile photo at
// the same moment is an entirely normal concurrent scenario, not an edge
// case, so that write path gets a real single-row UPDATE instead.
// load()/save() are left in place and still used for the lower-frequency,
// admin-driven bulk edits elsewhere in the app (add/edit employee, etc.).
async function getEmployeeById(id) {
  const rows = await query(`SELECT * FROM employees WHERE id = ?`, [id]);
  return rows[0] ? TABLES.employees.fromRow(rows[0]) : null;
}
async function updateEmployeeAvatar(id, avatarImage) {
  await query(`UPDATE employees SET avatar_image = ? WHERE id = ?`, [avatarImage, id]);
}
async function updateEmployeePassword(id, passwordHash) {
  await query(`UPDATE employees SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
}
// Writes every column of ONE employee row from a full in-memory employee
// object (as opposed to save('employees', wholeArray), which rewrites
// every row in the table). Used by add/edit/reset-password so that, for
// example, editing one person's shift on a 500-employee roster is a
// single-row UPDATE instead of deleting and re-inserting all 500 rows —
// and so two admins editing two different employees at the same moment
// can no longer silently drop one another's change (see the comment
// above this block).
async function updateEmployeeRow(employee) {
  const row = TABLES.employees.toRow(employee);
  const { id, ...cols } = row;
  const columns = Object.keys(cols);
  const setClause = columns.map(c => `${c} = ?`).join(', ');
  await query(`UPDATE employees SET ${setClause} WHERE id = ?`, [...columns.map(c => cols[c]), id]);
}
async function insertEmployeeRow(employee) {
  const row = TABLES.employees.toRow(employee);
  const columns = Object.keys(row);
  await query(`INSERT INTO employees (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(c => row[c]));
}
// Deletes one employee and reassigns anyone who reported to them to no
// manager, as two targeted statements — not a full-table read/rewrite of
// everyone just to remove one row and fix up a handful of manager_id
// references.
async function deleteEmployeeRow(id) {
  await query(`UPDATE employees SET manager_id = NULL WHERE manager_id = ?`, [id]);
  await query(`DELETE FROM employees WHERE id = ?`, [id]);
}
async function getAdminById(id) {
  const rows = await query(`SELECT * FROM admins WHERE id = ?`, [id]);
  return rows[0] ? TABLES.admins.fromRow(rows[0]) : null;
}
async function updateAdminAvatar(id, avatarImage) {
  await query(`UPDATE admins SET avatar_image = ? WHERE id = ?`, [avatarImage, id]);
}
async function updateAdminPassword(id, passwordHash) {
  await query(`UPDATE admins SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
}
async function updateSettingsLogo(id, logoImage) {
  await query(`UPDATE settings SET logo_image = ? WHERE id = ?`, [logoImage, id]);
}
// Generic single-row insert/delete for small simple tables (holidays,
// etc.) — same reasoning as the employee-specific helpers above: adding
// or removing one holiday shouldn't rewrite every other holiday in the
// table. Table name must be a key in TABLES.
async function insertRow(tableName, item) {
  const t = TABLES[tableName];
  const row = t.toRow(item);
  const columns = Object.keys(row);
  await query(`INSERT INTO ${t.sqlTable} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(c => row[c]));
}
async function deleteRow(tableName, id) {
  const t = TABLES[tableName];
  await query(`DELETE FROM ${t.sqlTable} WHERE id = ?`, [id]);
}

module.exports = {
  load, save, query, pool, ensureSchema, TABLES,
  attendanceRepo: buildAttendanceRepo(), requestsRepo: buildSimpleRepo('requests'),
  leaveRequestsRepo: buildSimpleRepo('leaveRequests'), correctionsRepo: buildSimpleRepo('corrections'),
  getEmployeeById, updateEmployeeAvatar, updateEmployeePassword, updateEmployeeRow, insertEmployeeRow, deleteEmployeeRow,
  getAdminById, updateAdminAvatar, updateAdminPassword, updateSettingsLogo, insertRow, deleteRow
};

// ---------------------------------------------------------------------------
// Row-level repos for the high-write-volume tables (attendance, and the
// three approval-request tables). These exist alongside load()/save() —
// load()/save() still work and are still used for the small, rarely-written
// tables (employees, admins, settings, holidays) — but for attendance in
// particular, a whole-table "load everything, mutate one row, delete
// everything, re-insert everything" on every single check-in stops being
// viable well before a school-sized roster (500+ people, years of daily
// records): every check-in would rewrite the *entire* attendance history to
// change one row. These repos do a real single-row INSERT/UPDATE/SELECT
// instead, using MySQL's own row-level locking for correctness under
// concurrent writes rather than the app's in-process queue.
// ---------------------------------------------------------------------------
function buildAttendanceRepo() {
  const t = TABLES.attendance;
  return {
    /** One employee's record for one date, or null. */
    async getByEmpDate(employeeId, date) {
      const rows = await query(`SELECT * FROM attendance WHERE employee_id = ? AND date = ?`, [employeeId, date]);
      return rows[0] ? t.fromRow(rows[0]) : null;
    },
    /**
     * Flexible filtered read — every caller that used to do
     * `(await load('attendance')).filter(...)` on the full table goes
     * through here instead, with the filtering done in SQL.
     *   employeeId / employeeIds — one employee or a list of them
     *   date — a single exact date
     *   fromDate / toDate — inclusive date range
     */
    async getRange({ employeeId, employeeIds, date, fromDate, toDate } = {}) {
      const where = [];
      const params = [];
      if (employeeId) { where.push('employee_id = ?'); params.push(employeeId); }
      if (employeeIds && employeeIds.length) { where.push(`employee_id IN (${employeeIds.map(() => '?').join(',')})`); params.push(...employeeIds); }
      if (date) { where.push('date = ?'); params.push(date); }
      if (fromDate) { where.push('date >= ?'); params.push(fromDate); }
      if (toDate) { where.push('date <= ?'); params.push(toDate); }
      const sql = `SELECT * FROM attendance${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY date ASC`;
      const rows = await query(sql, params);
      return rows.map(t.fromRow);
    },
    /**
     * Insert-or-update a single day's record, keyed on the table's
     * (employee_id, date) unique constraint — this is the operation that
     * replaces the old "rewrite the whole table" pattern for check-in,
     * check-out, early-checkout, manual adjustment, and biometric sync.
     * MySQL's own unique-index handling makes this safe under concurrent
     * writers without any app-level locking.
     */
    async upsert(record) {
      const row = t.toRow(record);
      const columns = Object.keys(row);
      const placeholders = columns.map(() => '?').join(',');
      const updates = columns.filter(c => c !== 'id').map(c => `${c} = VALUES(${c})`).join(', ');
      await query(
        `INSERT INTO attendance (${columns.join(',')}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updates}`,
        columns.map(c => row[c])
      );
      return record;
    },
    async deleteByEmpDate(employeeId, date) {
      const result = await query(`DELETE FROM attendance WHERE employee_id = ? AND date = ?`, [employeeId, date]);
      return result.affectedRows > 0;
    },
    async deleteByEmployee(employeeId) {
      await query(`DELETE FROM attendance WHERE employee_id = ?`, [employeeId]);
    },
    /** Bulk upsert, one transaction — used by the biometric device sync, which can fold in many days at once. */
    async bulkUpsert(records) {
      if (!records.length) return;
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const record of records) {
          const row = t.toRow(record);
          const columns = Object.keys(row);
          const updates = columns.filter(c => c !== 'id').map(c => `${c} = VALUES(${c})`).join(', ');
          await conn.query(
            `INSERT INTO attendance (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})
             ON DUPLICATE KEY UPDATE ${updates}`,
            columns.map(c => row[c])
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }
  };
}

// Same idea, generic, for the three approval-request tables — lower write
// volume than attendance (people don't submit leave requests daily), but
// the same "load everything just to add/edit one row" pattern doesn't scale
// cleanly either once a school's request history spans years, so these get
// the same real single-row treatment.
function buildSimpleRepo(name) {
  const t = TABLES[name];
  return {
    async getById(id) {
      const rows = await query(`SELECT * FROM ${t.sqlTable} WHERE id = ?`, [id]);
      return rows[0] ? t.fromRow(rows[0]) : null;
    },
    async getRange({ employeeId, status, adminDecision, extraWhere, extraParams, limit } = {}) {
      const where = [];
      const params = [];
      if (employeeId) { where.push('employee_id = ?'); params.push(employeeId); }
      if (status) { where.push('status = ?'); params.push(status); }
      if (adminDecision) { where.push('admin_decision = ?'); params.push(adminDecision); }
      if (extraWhere) { where.push(extraWhere); params.push(...(extraParams || [])); }
      let sql = `SELECT * FROM ${t.sqlTable}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY ${t.orderBy}`;
      if (limit) { sql += ' LIMIT ?'; params.push(limit); }
      const rows = await query(sql, params);
      return rows.map(t.fromRow);
    },
    async insert(record) {
      const row = t.toRow(record);
      const columns = Object.keys(row);
      await query(`INSERT INTO ${t.sqlTable} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(c => row[c]));
      return record;
    },
    async update(record) {
      const row = t.toRow(record);
      const columns = Object.keys(row).filter(c => c !== 'id');
      await query(`UPDATE ${t.sqlTable} SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...columns.map(c => row[c]), row.id]);
      return record;
    },
    async deleteByEmployee(employeeId) {
      await query(`DELETE FROM ${t.sqlTable} WHERE employee_id = ?`, [employeeId]);
    }
  };
}
