// seed.js — seeds the MySQL database with KutkiTech's actual small team.
// Run once with: node seed.js  (safe to re-run — it resets employees/admins
// and clears attendance/requests so you start from a clean slate).
const bcrypt = require('bcryptjs');
const { save, ensureSchema, pool } = require('./db');

const defaultPasswordHash = bcrypt.hashSync('Welcome@123', 8);

// A small, real-looking startup roster (5–10 people) — not a generated
// crowd. Shift time is set per person, not company-wide.
const employees = [
  {
    id: 'emp_1', employeeId: 'KT-1001', name: 'Utkrista Acharya',
    email: 'kutkitechutkrista@gmail.com', passwordHash: defaultPasswordHash,
    department: 'Management', designation: 'CoFounder & Full Stack Developer', phone: '9840795032',
    joinDate: '2025-12-01', status: 'active',
    shiftName: 'Variable', shiftStart: '10:00', shiftEnd: '17:00', avatarColor: '#1B2F63',
    managerId: null
  },
  {
    id: 'emp_2', employeeId: 'KT-1002', name: 'Utpal Adhikari',
    email: 'utpal.adhikari@gmail.com', passwordHash: defaultPasswordHash,
    department: 'Sales', designation: 'CSO', phone: '9810000102',
    joinDate: '2026-01-15', status: 'active',
    shiftName: 'Variable', shiftStart: '10:00', shiftEnd: '17:00', avatarColor: '#274E8C',
    managerId: null
  },
  {
    id: 'emp_3', employeeId: 'KT-1003', name: 'Nischal Poudel',
    email: 'pointertechnepal@gmail.com', passwordHash: defaultPasswordHash,
    department: 'Management', designation: 'CoFounder and ERP Software Engineer', phone: '9810000103',
    joinDate: '2025-12-01', status: 'active',
    shiftName: 'Variable', shiftStart: '10:00', shiftEnd: '17:00', avatarColor: '#2E6B9E',
    managerId: null
  },
  {
    id: 'emp_4', employeeId: 'KT-1004', name: 'Sambriddhi Neupane',
    email: 'sambriddhi.neupane@kutkitech.com', passwordHash: defaultPasswordHash,
    department: 'IT', designation: 'Software Engineering Intern', phone: '9810000104',
    joinDate: '2026-06-01', status: 'active',
    shiftName: 'Day Shift', shiftStart: '10:00', shiftEnd: '17:00', avatarColor: '#3F8F6A',
    managerId: 'emp_3'
  },
  {
    id: 'emp_5', employeeId: 'KT-1005', name: 'Raman K.C',
    email: 'kutkitech.administration@gmail.com', passwordHash: defaultPasswordHash,
    department: 'Design', designation: 'UI/UX Designer', phone: '9810000105',
    joinDate: '2023-08-20', status: 'active',
    shiftName: 'Full Shift', shiftStart: '09:00', shiftEnd: '18:00', avatarColor: '#6DAF3C',
    managerId: 'emp_1'
  }
];

const admins = [
  {
    id: 'admin_1',
    name: 'Raman K.C',
    email: 'admin@kutkitech.com',
    passwordHash: bcrypt.hashSync('Admin@123', 8),
    role: 'HR Administrator',
    designation: 'Operations & HR Executive'
  }
];

async function main() {
  await ensureSchema();
  await save('employees', employees);
  await save('admins', admins);
  await save('attendance', []);
  await save('requests', []);
  await save('leaveRequests', []);
  await save('holidays', []);

  console.log(`Seeded ${employees.length} KutkiTech staff, 1 HR admin, into MySQL.`);
  console.log('Work week: Sunday-Friday (Saturday off). Add company holidays from the HR dashboard.');
  console.log('Reporting lines: Sambriddhi -> Nischal, Raman -> Utkrista. Edit anytime from Directory.');
  console.log('Staff password: Welcome@123 - Admin password: Admin@123');
  await pool.end();
}

main().catch(err => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
