// exports.js — builds formatted Excel (.xlsx) and PDF attendance reports,
// used by both the staff self-service export and the HR admin export
// (per-employee and company-wide). Branding (name/logo) comes from the
// admin-configurable settings table rather than being hardcoded, so the
// exported documents match whatever organization the app is set up for.
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { toBsShort } = require('./nepaliDate');

const LOGO_PATH = path.join(__dirname, 'public', 'img', 'logo.png');
const DEFAULT_LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
const BRAND_NAVY = '0C1633';
const BRAND_NAVY_2 = '12204A';
const BRAND_GREEN = '5FA82E';
const BRAND_GREEN_LIGHT = 'DCF0C4';

// Company logo is a file on disk under public/uploads/branding/ (see
// server.js's toPublicUploadUrl) — settings.logoImage just stores the
// relative URL, so this reads the actual bytes off disk once per export.
// Every consumer (ExcelJS, PDFKit, nodemailer) accepts a Buffer directly,
// so nothing here needs a temp file. Falls back to the shipped default
// logo if nothing's been uploaded, the file's missing, or settings aren't
// readable yet.
const DEFAULT_COMPANY_NAME = 'Your Company';
async function resolveBranding() {
  try {
    const { load } = require('./db');
    const rows = await load('settings');
    const s = rows[0];
    if (s && s.logoImage) {
      try {
        const logoPath = path.join(__dirname, 'public', s.logoImage.replace(/^\/+/, ''));
        const buf = await fs.promises.readFile(logoPath);
        const ext = path.extname(logoPath).slice(1).toLowerCase() || 'png';
        return { name: s.companyName || DEFAULT_COMPANY_NAME, logoBuffer: buf, logoExt: ext === 'jpeg' ? 'jpg' : ext };
      } catch (readErr) { /* file missing/unreadable — fall through to the default logo below */ }
    }
    if (s) return { name: s.companyName || DEFAULT_COMPANY_NAME, logoBuffer: DEFAULT_LOGO_BUFFER, logoExt: 'png' };
  } catch (e) { /* fall through to default */ }
  return { name: DEFAULT_COMPANY_NAME, logoBuffer: DEFAULT_LOGO_BUFFER, logoExt: 'png' };
}

const STATUS_COLORS = {
  present: { fg: 'FFFFFF', bg: '2F8F5B' },
  late: { fg: 'FFFFFF', bg: 'C2841F' },
  absent: { fg: 'FFFFFF', bg: 'C0463A' },
  'weekly off': { fg: '4A5568', bg: 'E9EDF7' },
  'on-leave': { fg: 'FFFFFF', bg: '6B4FA0' }
};

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------
function fmtDateLabel(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function weekdayName(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short' });
}
function fmtTime12(t) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = (h % 12) || 12;
  return `${hh}:${String(m).padStart(2, '0')} ${period}`;
}
function fmtLatLng(loc) {
  if (!loc || loc.latitude === undefined || loc.latitude === null) return null;
  return `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
}
function monthLabel(ym) {
  if (!ym) return '—';
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
function titleStatus(s) {
  if (!s) return '—';
  return s.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// How an attendance entry was captured — shown as its own column in every
// export, same wording as the "Source" badge in the admin dashboard.
function sourceLabel(source) {
  const map = { biometric: 'Biometric', manual: 'Manual', correction: 'Correction', auto: 'Auto' };
  return map[source] || 'Web';
}

async function resolveWeeklyOffDays() {
  try {
    const { load } = require('./db');
    const rows = await load('settings');
    const raw = (rows[0] && rows[0].weeklyOffDays || '6').split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 6);
    return new Set(raw.length ? raw : [6]);
  } catch (e) {
    return new Set([6]);
  }
}

// Builds a full calendar of rows for one employee's BS month, filling in
// "Weekly Off" (per the company's configured off days) and "Absent" for
// days without a matching attendance record — so the export reads as a
// complete register, not just a log of the days someone happened to check
// in. Takes the explicit AD start/end of that BS month (from bsMonthRange
// on the server side) — BS months don't line up with AD calendar months,
// so iterating "day 1..N of an AD month" no longer applies once the
// reporting period is a BS month.
async function buildDailyRows(records, monthStartAD, monthEndAD, leaveDates, holidayDates) {
  const weeklyOffDays = await resolveWeeklyOffDays();
  const byDate = {};
  records.forEach(r => { byDate[r.date] = r; });
  const rows = [];
  const endD = new Date(monthEndAD + 'T00:00:00');
  for (let date = new Date(monthStartAD + 'T00:00:00'); date <= endD; date.setDate(date.getDate() + 1)) {
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const isWeeklyOff = weeklyOffDays.has(date.getDay());
    const isHoliday = holidayDates && holidayDates.has(iso);
    const isOnLeave = leaveDates && leaveDates.has(iso);
    const rec = byDate[iso];
    const miti = toBsShort(iso);
    if (rec) {
      const loc = rec.checkOutLocation || rec.checkInLocation;
      rows.push({
        date: iso,
        miti,
        day: weekdayName(iso),
        checkIn: rec.checkIn,
        checkOut: rec.checkOut,
        hours: rec.hoursWorked || 0,
        status: rec.earlyCheckout ? 'present (early out)' : rec.status,
        lateBy: rec.lateBy || 0,
        checkInIp: rec.checkInIp || null,
        checkOutIp: rec.checkOutIp || null,
        location: fmtLatLng(loc),
        area: (loc && loc.area) || null,
        modality: rec.workingModality || null,
        source: sourceLabel(rec.source)
      });
    } else if (isOnLeave) {
      rows.push({ date: iso, miti, day: weekdayName(iso), checkIn: null, checkOut: null, hours: 0, status: 'on-leave', lateBy: 0, checkInIp: null, checkOutIp: null, location: null, area: null, modality: null, source: null });
    } else if (isWeeklyOff || isHoliday) {
      rows.push({ date: iso, miti, day: weekdayName(iso), checkIn: null, checkOut: null, hours: 0, status: 'weekly off', lateBy: 0, checkInIp: null, checkOutIp: null, location: null, area: null, modality: null, source: null });
    } else {
      rows.push({ date: iso, miti, day: weekdayName(iso), checkIn: null, checkOut: null, hours: 0, status: 'absent', lateBy: 0, checkInIp: null, checkOutIp: null, location: null, area: null, modality: null, source: null });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// EXCEL — per-employee monthly report
// ---------------------------------------------------------------------------
async function buildStaffExcel({ employee, report, generatedBy }) {
  const { name: companyName, logoBuffer, logoExt } = await resolveBranding();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${companyName} — Attendance System`;
  wb.created = new Date();

  const ws = wb.addWorksheet('Attendance', { views: [{ state: 'frozen', ySplit: 10 }] });
  ws.properties.defaultRowHeight = 18;

  // Logo
  try {
    const logoId = wb.addImage({ buffer: logoBuffer, extension: logoExt === 'jpg' ? 'jpeg' : logoExt });
    ws.addImage(logoId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 54, height: 54 } });
  } catch (e) { /* logo optional */ }

  ws.mergeCells('C1:H1');
  ws.getCell('C1').value = companyName;
  ws.getCell('C1').font = { size: 16, bold: true, color: { argb: 'FF' + BRAND_NAVY_2 } };

  ws.mergeCells('C2:H2');
  ws.getCell('C2').value = `Attendance Report — ${employee.name} (${employee.employeeId})`;
  ws.getCell('C2').font = { size: 12, bold: true, color: { argb: 'FF666F8C' } };

  ws.mergeCells('C3:H3');
  ws.getCell('C3').value = `${report.bsMonthLabel || monthLabel(report.month)} BS · Generated ${new Date().toLocaleString('en-GB')}${generatedBy ? ' by ' + generatedBy : ''}`;
  ws.getCell('C3').font = { size: 9.5, italic: true, color: { argb: 'FF99A1BC' } };

  // Employee detail block
  const detailRows = [
    ['Department', employee.department, 'Designation', employee.designation],
    ['Shift', `${employee.shiftName || 'General Shift'} (${fmtTime12(employee.shiftStart)} – ${fmtTime12(employee.shiftEnd)})`, 'Status', titleStatus(employee.status)],
    ['Email', employee.email, 'Phone', employee.phone || '—'],
  ];
  let r = 5;
  detailRows.forEach(([k1, v1, k2, v2]) => {
    ws.getCell(`A${r}`).value = k1; ws.getCell(`A${r}`).font = { bold: true, size: 9.5, color: { argb: 'FF666F8C' } };
    ws.mergeCells(`B${r}:C${r}`); ws.getCell(`B${r}`).value = v1; ws.getCell(`B${r}`).font = { size: 10 };
    ws.getCell(`D${r}`).value = k2; ws.getCell(`D${r}`).font = { bold: true, size: 9.5, color: { argb: 'FF666F8C' } };
    ws.mergeCells(`E${r}:H${r}`); ws.getCell(`E${r}`).value = v2; ws.getCell(`E${r}`).font = { size: 10 };
    r++;
  });

  // Summary KPI strip
  r += 1;
  const kpis = [
    ['Working Days', report.workingDays],
    ['Present', report.present],
    ['Late', report.late],
    ['Absent', report.absent],
    ['Early Checkouts', report.earlyOuts],
    ['Total Hours', report.totalHours],
    ['Avg Hours/Day', report.avgHours],
    ['Attendance Rate', report.attendanceRate + '%'],
  ];
  const kpiHeaderRow = r;
  kpis.forEach((k, i) => {
    const cell = ws.getCell(kpiHeaderRow, i + 1);
    cell.value = k[0];
    cell.font = { bold: true, size: 8.5, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + BRAND_NAVY } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  const kpiValueRow = r + 1;
  kpis.forEach((k, i) => {
    const cell = ws.getCell(kpiValueRow, i + 1);
    cell.value = k[1];
    cell.font = { bold: true, size: 12, color: { argb: 'FF' + BRAND_NAVY_2 } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2FA' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ws.getRow(kpiHeaderRow).height = 20;
  ws.getRow(kpiValueRow).height = 24;

  // Daily table
  const tableHeaderRow = kpiValueRow + 2;
  const headers = ['Date', 'Miti', 'Day', 'Check In', 'Check Out', 'Hours', 'Status', 'Late (min)', 'Modality', 'Source', 'Check-in IP', 'Check-out IP', 'Coordinates', 'Area'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(tableHeaderRow, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + BRAND_NAVY_2 } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
  });
  ws.getRow(tableHeaderRow).height = 20;

  let rowIdx = tableHeaderRow + 1;
  report.dailyRows.forEach((row, i) => {
    const excelRow = ws.getRow(rowIdx);
    const values = [
      fmtDateLabel(row.date), row.miti || '—', row.day, fmtTime12(row.checkIn), fmtTime12(row.checkOut),
      row.hours || 0, titleStatus(row.status), row.lateBy || 0, row.modality || '—', row.source || '—',
      row.checkInIp || '—', row.checkOutIp || '—', row.location || 'Not shared', row.area || '—'
    ];
    values.forEach((v, ci) => { excelRow.getCell(ci + 1).value = v; excelRow.getCell(ci + 1).font = { size: 9.5 }; });
    if (i % 2 === 1) {
      excelRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FD' } }; });
    }
    const statusColor = STATUS_COLORS[row.status] || STATUS_COLORS.absent;
    const statusCell = excelRow.getCell(7);
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + statusColor.bg } };
    statusCell.font = { size: 9.5, bold: true, color: { argb: 'FF' + statusColor.fg } };
    statusCell.alignment = { horizontal: 'center' };
    excelRow.eachCell(c => { c.border = { bottom: { style: 'thin', color: { argb: 'FFEAEDF3' } } }; });
    rowIdx++;
  });

  ws.autoFilter = { from: { row: tableHeaderRow, column: 1 }, to: { row: rowIdx - 1, column: headers.length } };
  ws.columns.forEach((col, i) => {
    const widths = [13, 13, 7, 11, 11, 8, 20, 10, 11, 15, 15, 18, 20];
    col.width = widths[i] || 12;
  });

  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// PDF — per-employee monthly report
// ---------------------------------------------------------------------------
async function buildStaffPdf({ employee, report, generatedBy }) {
  const { name: companyName, logoBuffer, logoExt } = await resolveBranding();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, layout: 'landscape' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawReportHeader(doc, {
      title: `Attendance Report — ${employee.name}`,
      subtitle: `${employee.employeeId} · ${employee.designation} · ${employee.department} · ${report.bsMonthLabel || monthLabel(report.month)} BS`,
      generatedBy, companyName, logoBuffer
    });

    const pageWidth = doc.page.width - 80;

    // Employee detail strip
    let y = doc.y + 6;
    const details = [
      ['Shift', `${employee.shiftName || 'General Shift'} (${fmtTime12(employee.shiftStart)} – ${fmtTime12(employee.shiftEnd)})`],
      ['Email', employee.email],
      ['Phone', employee.phone || '—'],
      ['Status', titleStatus(employee.status)]
    ];
    doc.fontSize(8.5).font('Helvetica');
    let dx = 40;
    const dw = pageWidth / details.length;
    details.forEach(([k, v]) => {
      doc.fillColor('#666F8C').text(k.toUpperCase(), dx, y, { width: dw - 10 });
      doc.fillColor('#101526').font('Helvetica-Bold').fontSize(9).text(v, dx, y + 12, { width: dw - 10 });
      doc.font('Helvetica').fontSize(8.5);
      dx += dw;
    });
    y += 38;

    // KPI cards
    const kpis = [
      ['Working Days', report.workingDays],
      ['Present', report.present],
      ['Late', report.late],
      ['Absent', report.absent],
      ['Early Outs', report.earlyOuts],
      ['Total Hrs', report.totalHours],
      ['Avg Hrs/Day', report.avgHours],
      ['Attendance', report.attendanceRate + '%'],
    ];
    const cardW = pageWidth / kpis.length;
    kpis.forEach((k, i) => {
      const cx = 40 + i * cardW;
      doc.roundedRect(cx, y, cardW - 4, 42, 4).fillAndStroke('#EEF2FA', '#DCE2F0');
      doc.fillColor('#12204A').font('Helvetica-Bold').fontSize(12).text(String(k[1]), cx, y + 8, { width: cardW - 4, align: 'center' });
      doc.fillColor('#666F8C').font('Helvetica').fontSize(6.5).text(k[0].toUpperCase(), cx, y + 26, { width: cardW - 4, align: 'center' });
    });
    y += 56;

    // Daily table — generously widened now that the page is landscape, so
    // IP addresses / coordinates / area names no longer get ellipsis-cut.
    const columns = [
      { key: 'date', label: 'Date', width: 58 },
      { key: 'miti', label: 'Miti', width: 58 },
      { key: 'day', label: 'Day', width: 30 },
      { key: 'checkIn', label: 'In', width: 48 },
      { key: 'checkOut', label: 'Out', width: 48 },
      { key: 'hours', label: 'Hrs', width: 30 },
      { key: 'status', label: 'Status', width: 76 },
      { key: 'late', label: 'Late', width: 30 },
      { key: 'modality', label: 'Modality', width: 56 },
      { key: 'source', label: 'Source', width: 54 },
      { key: 'ip', label: 'IP Address', width: 84 },
      { key: 'loc', label: 'Coordinates', width: 88 },
      { key: 'area', label: 'Area', width: 84 },
    ];
    const tableRows = report.dailyRows.map(row => ({
      date: fmtDateLabel(row.date),
      miti: row.miti || '—',
      day: row.day,
      checkIn: fmtTime12(row.checkIn),
      checkOut: fmtTime12(row.checkOut),
      hours: row.hours ? String(row.hours) : '—',
      status: titleStatus(row.status),
      late: row.lateBy ? String(row.lateBy) : '—',
      modality: row.modality || '—',
      source: row.source || '—',
      ip: row.checkOutIp || row.checkInIp || '—',
      loc: row.location || 'Not shared',
      area: row.area || '—',
      _statusRaw: row.status
    }));

    drawTable(doc, { x: 40, y, columns, rows: tableRows, statusColumnKey: 'status' });

    finalizePdf(doc, companyName);
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// EXCEL — company-wide attendance export
// ---------------------------------------------------------------------------
async function buildOverallExcel({ records, filters, summary, departments, generatedBy }) {
  const { name: companyName, logoBuffer, logoExt } = await resolveBranding();
  const wb = new ExcelJS.Workbook();
  wb.creator = `${companyName} — Attendance System`;
  wb.created = new Date();

  // ---- Summary sheet ----
  const sSheet = wb.addWorksheet('Summary');
  try {
    const logoId = wb.addImage({ buffer: logoBuffer, extension: logoExt === 'jpg' ? 'jpeg' : logoExt });
    sSheet.addImage(logoId, { tl: { col: 0.15, row: 0.15 }, ext: { width: 54, height: 54 } });
  } catch (e) { /* logo optional */ }
  sSheet.mergeCells('C1:F1');
  sSheet.getCell('C1').value = companyName;
  sSheet.getCell('C1').font = { size: 16, bold: true, color: { argb: 'FF' + BRAND_NAVY_2 } };
  sSheet.mergeCells('C2:F2');
  sSheet.getCell('C2').value = 'Company-wide Attendance Report';
  sSheet.getCell('C2').font = { size: 12, bold: true, color: { argb: 'FF666F8C' } };
  sSheet.mergeCells('C3:F3');
  const filterLabel = `${filters.from || 'Start'} to ${filters.to || 'Today'}${filters.department ? ' · ' + filters.department : ''}${filters.status ? ' · ' + titleStatus(filters.status) : ''}`;
  sSheet.getCell('C3').value = `${filterLabel} · Generated ${new Date().toLocaleString('en-GB')}${generatedBy ? ' by ' + generatedBy : ''}`;
  sSheet.getCell('C3').font = { size: 9.5, italic: true, color: { argb: 'FF99A1BC' } };

  let r = 6;
  const kpis = [
    ['Total Records', summary.totalRecords],
    ['Present', summary.present],
    ['Late', summary.late],
    ['Early Checkouts', summary.earlyOuts],
    ['Total Hours', summary.totalHours],
    ['Avg Hours/Record', summary.avgHours],
  ];
  kpis.forEach((k, i) => {
    const col = (i % 3) * 3 + 1;
    const row = r + Math.floor(i / 3) * 2;
    sSheet.getCell(row, col).value = k[0];
    sSheet.getCell(row, col).font = { bold: true, size: 9, color: { argb: 'FF666F8C' } };
    sSheet.getCell(row + 1, col).value = k[1];
    sSheet.getCell(row + 1, col).font = { bold: true, size: 14, color: { argb: 'FF' + BRAND_NAVY_2 } };
  });
  r += 8;

  sSheet.getCell(r, 1).value = 'Department Breakdown';
  sSheet.getCell(r, 1).font = { bold: true, size: 11, color: { argb: 'FF' + BRAND_NAVY_2 } };
  r += 1;
  ['Department', 'Total Staff', 'Present Today'].forEach((h, i) => {
    const c = sSheet.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true, size: 9.5, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + BRAND_NAVY_2 } };
  });
  r += 1;
  (departments || []).forEach(d => {
    sSheet.getCell(r, 1).value = d.department;
    sSheet.getCell(r, 2).value = d.total;
    sSheet.getCell(r, 3).value = d.present;
    r += 1;
  });
  sSheet.columns = [{ width: 30 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 16 }];

  // ---- All records sheet ----
  const ws = wb.addWorksheet('All Records', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = ['Date', 'Miti', 'Employee', 'Employee ID', 'Department', 'Designation', 'Shift', 'Check In', 'Check Out', 'Hours', 'Status', 'Late (min)', 'Modality', 'Source', 'IP Address', 'Coordinates', 'Area'];
  headers.forEach((h, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = h;
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + BRAND_NAVY_2 } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ws.getRow(1).height = 20;

  records.forEach((rec, i) => {
    const excelRow = ws.getRow(i + 2);
    const status = rec.earlyCheckout ? 'present (early out)' : rec.status;
    const values = [
      fmtDateLabel(rec.date), toBsShort(rec.date) || '—', rec.employeeName, rec.empCode, rec.department, rec.designation || '—',
      rec.shiftName || '—', fmtTime12(rec.checkIn), fmtTime12(rec.checkOut), rec.hoursWorked || 0,
      titleStatus(status), rec.lateBy || 0, rec.workingModality || '—', sourceLabel(rec.source), rec.ipAddress || '—',
      rec.location ? fmtLatLng(rec.location) : 'Not shared', (rec.location && rec.location.area) || '—'
    ];
    values.forEach((v, ci) => { excelRow.getCell(ci + 1).value = v; excelRow.getCell(ci + 1).font = { size: 9.5 }; });
    if (i % 2 === 1) excelRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F8FD' } }; });
    const statusColor = STATUS_COLORS[status] || STATUS_COLORS.present;
    const statusCell = excelRow.getCell(11);
    statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + statusColor.bg } };
    statusCell.font = { size: 9.5, bold: true, color: { argb: 'FF' + statusColor.fg } };
    statusCell.alignment = { horizontal: 'center' };
    excelRow.eachCell(c => { c.border = { bottom: { style: 'thin', color: { argb: 'FFEAEDF3' } } }; });
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, records.length + 1), column: headers.length } };
  const widths = [13, 13, 20, 12, 20, 20, 14, 11, 11, 8, 16, 10, 12, 15, 18, 20];
  ws.columns.forEach((col, i) => { col.width = widths[i] || 14; });

  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// PDF — company-wide attendance export
// ---------------------------------------------------------------------------
async function buildOverallPdf({ records, filters, summary, generatedBy }) {
  const { name: companyName, logoBuffer, logoExt } = await resolveBranding();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, layout: 'landscape' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const filterLabel = `${filters.from || 'Start'} — ${filters.to || 'Today'}${filters.department ? ' · ' + filters.department : ''}${filters.status ? ' · ' + titleStatus(filters.status) : ''}`;
    drawReportHeader(doc, {
      title: 'Company-wide Attendance Report',
      subtitle: filterLabel,
      generatedBy, companyName, logoBuffer
    });

    let y = doc.y + 6;
    const kpis = [
      ['Total Records', summary.totalRecords],
      ['Present', summary.present],
      ['Late', summary.late],
      ['Early Checkouts', summary.earlyOuts],
      ['Total Hours', summary.totalHours],
      ['Avg Hours/Record', summary.avgHours],
    ];
    const pageWidth = doc.page.width - 80;
    const cardW = pageWidth / kpis.length;
    kpis.forEach((k, i) => {
      const cx = 40 + i * cardW;
      doc.roundedRect(cx, y, cardW - 4, 42, 4).fillAndStroke('#EEF2FA', '#DCE2F0');
      doc.fillColor('#12204A').font('Helvetica-Bold').fontSize(13).text(String(k[1]), cx, y + 8, { width: cardW - 4, align: 'center' });
      doc.fillColor('#666F8C').font('Helvetica').fontSize(7).text(k[0].toUpperCase(), cx, y + 27, { width: cardW - 4, align: 'center' });
    });
    y += 58;

    const columns = [
      { key: 'date', label: 'Date', width: 52 },
      { key: 'miti', label: 'Miti', width: 48 },
      { key: 'employee', label: 'Employee', width: 74 },
      { key: 'empCode', label: 'ID', width: 38 },
      { key: 'department', label: 'Department', width: 66 },
      { key: 'shift', label: 'Shift', width: 48 },
      { key: 'checkIn', label: 'In', width: 38 },
      { key: 'checkOut', label: 'Out', width: 38 },
      { key: 'hours', label: 'Hrs', width: 24 },
      { key: 'status', label: 'Status', width: 58 },
      { key: 'modality', label: 'Modality', width: 46 },
      { key: 'source', label: 'Source', width: 46 },
      { key: 'ip', label: 'IP Address', width: 54 },
      { key: 'loc', label: 'Coordinates', width: 58 },
      { key: 'area', label: 'Area', width: 54 },
    ];
    const tableRows = records.map(rec => {
      const status = rec.earlyCheckout ? 'present (early out)' : rec.status;
      return {
        date: fmtDateLabel(rec.date),
        miti: toBsShort(rec.date) || '—',
        employee: rec.employeeName,
        empCode: rec.empCode,
        department: rec.department,
        shift: rec.shiftName || '—',
        checkIn: fmtTime12(rec.checkIn),
        checkOut: fmtTime12(rec.checkOut),
        hours: rec.hoursWorked ? String(rec.hoursWorked) : '—',
        status: titleStatus(status),
        modality: rec.workingModality || '—',
        ip: rec.ipAddress || '—',
        loc: rec.location ? fmtLatLng(rec.location) : 'Not shared',
        area: (rec.location && rec.location.area) || '—',
        _statusRaw: status
      };
    });

    drawTable(doc, { x: 40, y, columns, rows: tableRows, statusColumnKey: 'status' });

    finalizePdf(doc, companyName);
    doc.end();
  });
}

// ---------------------------------------------------------------------------
// PDF drawing helpers
// ---------------------------------------------------------------------------
function drawReportHeader(doc, { title, subtitle, generatedBy, companyName, logoBuffer }) {
  try { doc.image(logoBuffer, 40, 32, { width: 34 }); } catch (e) { /* logo optional */ }
  doc.fillColor('#0C1633').font('Helvetica-Bold').fontSize(16).text(companyName, 84, 34);
  doc.fillColor('#666F8C').font('Helvetica').fontSize(9).text(title, 84, 54);
  doc.moveTo(40, 90).lineTo(doc.page.width - 40, 90).strokeColor('#DCE2F0').lineWidth(1).stroke();
  doc.fillColor('#101526').font('Helvetica-Bold').fontSize(11).text(subtitle, 40, 100);
  doc.fillColor('#99A1BC').font('Helvetica-Oblique').fontSize(8).text(
    `Generated ${new Date().toLocaleString('en-GB')}${generatedBy ? ' by ' + generatedBy : ''}`, 40, 116
  );
  doc.y = 132;
}

// Draws "Page X of Y" on every buffered page. Text placed inside the bottom
// margin area (as this is) trips pdfkit's automatic pagination — it thinks
// there isn't room and silently starts a *new* page mid-loop, which used to
// leave a stray blank page appended even to single-page reports. Temporarily
// zeroing the bottom margin for this one call stops that from happening.
function finalizePdf(doc, companyName) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor('#99A1BC').font('Helvetica').fontSize(7.5).text(
      `${companyName} — Attendance System · Page ${i + 1} of ${range.count}`,
      40, doc.page.height - 30, { width: doc.page.width - 80, align: 'center', lineBreak: false }
    );
    doc.page.margins.bottom = originalBottom;
  }
}

// Generic paginating table renderer used by both PDF reports.
function drawTable(doc, { x, y, columns, rows, statusColumnKey }) {
  const rowHeight = 20;
  const headerHeight = 20;
  const bottomMargin = 46;
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);

  function drawHeaderRow(atY) {
    doc.rect(x, atY, totalWidth, headerHeight).fill('#12204A');
    let cx = x;
    columns.forEach(col => {
      doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.8)
        .text(col.label, cx + 4, atY + 6, { width: col.width - 8, height: headerHeight - 8, ellipsis: true, align: 'left', lineBreak: false });
      cx += col.width;
    });
    return atY + headerHeight;
  }

  let cursorY = drawHeaderRow(y);

  rows.forEach((row, i) => {
    if (cursorY + rowHeight > doc.page.height - bottomMargin) {
      doc.addPage();
      cursorY = drawHeaderRow(40);
    }
    if (i % 2 === 1) {
      doc.rect(x, cursorY, totalWidth, rowHeight).fill('#F6F8FD');
    }
    let cx = x;
    columns.forEach(col => {
      const isStatus = col.key === statusColumnKey;
      if (isStatus) {
        const colorKey = (row._statusRaw || '').toLowerCase();
        const colors = STATUS_COLORS[colorKey] || STATUS_COLORS.present;
        doc.roundedRect(cx + 3, cursorY + 3, col.width - 8, rowHeight - 6, 3).fill('#' + colors.bg);
        doc.fillColor('#' + colors.fg).font('Helvetica-Bold').fontSize(7.2)
          .text(String(row[col.key]), cx + 3, cursorY + rowHeight / 2 - 4, { width: col.width - 8, height: 10, ellipsis: true, align: 'center', lineBreak: false });
      } else {
        doc.fillColor('#101526').font('Helvetica').fontSize(7.6)
          .text(String(row[col.key] ?? '—'), cx + 4, cursorY + rowHeight / 2 - 4.5, { width: col.width - 8, height: 10, align: 'left', ellipsis: true, lineBreak: false });
      }
      cx += col.width;
    });
    doc.moveTo(x, cursorY + rowHeight).lineTo(x + totalWidth, cursorY + rowHeight).strokeColor('#EAEDF3').lineWidth(0.5).stroke();
    cursorY += rowHeight;
  });

  if (!rows.length) {
    doc.fillColor('#99A1BC').font('Helvetica-Oblique').fontSize(9).text('No records match these filters.', x, cursorY + 12);
  }
}

module.exports = {
  buildDailyRows,
  buildStaffExcel,
  buildStaffPdf,
  buildOverallExcel,
  buildOverallPdf
};
