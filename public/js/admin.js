// admin.js — logic for the HR admin dashboard
let ADMIN = null;
let EMPLOYEES = [];
let charts = {};
let reqFilter = 'pending';

function toggleSidebar(open){
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('scrim').classList.toggle('show', open);
}

function showView(view, opts={}){
  document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + view).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const titles = {
    overview: ['Overview', 'Company-wide attendance at a glance'],
    today: ["Today's Attendance", fmtDateLong()],
    requests: ['Approvals', "Both the employee's manager and HR must approve each request"],
    directory: ['Staff Directory', 'Manage staff records, shifts and access'],
    log: ['Attendance Log', 'Search and filter historical records'],
    holidays: ['Holidays', 'Define the company holiday calendar'],
    device: ['Biometric Device', 'ZKTeco K40 connection, enrolled users and sync'],
    company: ['Company', 'Company name, logo and work week configuration'],
    account: ['My Account', 'Your HR admin profile photo, password and reset requests']
  };
  document.getElementById('page-title').textContent = titles[view][0];
  document.getElementById('page-sub').textContent = titles[view][1];
  toggleSidebar(false);
  if(opts.skipLoad) return;
  if(view === 'overview') loadOverview();
  if(view === 'today') loadToday();
  if(view === 'requests') loadRequestsView();
  if(view === 'directory') loadDirectory();
  if(view === 'log') loadLogView();
  if(view === 'holidays') loadHolidays();
  if(view === 'device') loadDeviceView();
  if(view === 'company') loadCompanySettings();
  if(view === 'account') loadAccountSettings();
}

async function signOut(){
  await api('/api/auth/admin/logout', { method:'POST' });
  window.location.href = '/adminlogin';
}

function closeModal(id){ document.getElementById(id).classList.add('hidden'); }

// Makes every card marked class="collapsible" data-card-id="..." toggle
// open/closed by clicking its header, and remembers the choice per card
// in localStorage — so a screen full of cards (Biometric Device, Company
// settings, ...) can be collapsed down to just the ones currently in use,
// and stays that way across reloads instead of resetting every time.
const COLLAPSE_STORAGE_KEY = 'admin-collapsed-cards';
function loadCollapsedCardIds(){
  try{ return new Set(JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY) || '[]')); }
  catch(e){ return new Set(); }
}
function saveCollapsedCardIds(ids){
  try{ localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...ids])); }
  catch(e){ /* localStorage unavailable (private browsing, quota) — collapse state just won't persist, not fatal */ }
}
function initCollapsibleCards(){
  const collapsedIds = loadCollapsedCardIds();
  document.querySelectorAll('.card.collapsible').forEach(card => {
    const id = card.dataset.cardId;
    if(!id || card.dataset.collapseInit === '1') return; // already wired up, or not opted in
    card.dataset.collapseInit = '1';

    const head = card.querySelector('.section-head');
    if(!head) return;
    if(!head.querySelector('.card-collapse-toggle')){
      const toggle = document.createElement('span');
      toggle.className = 'card-collapse-toggle';
      toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      head.appendChild(toggle);
    }
    if(collapsedIds.has(id)) card.classList.add('collapsed');

    head.addEventListener('click', (e) => {
      // Ignore clicks on interactive controls that happen to live in a
      // card header (e.g. "+ Add device" buttons) — only the header
      // background/title itself should toggle collapse.
      if(e.target.closest('button, a, input, select, textarea')) return;
      card.classList.toggle('collapsed');
      const ids = loadCollapsedCardIds();
      if(card.classList.contains('collapsed')) ids.add(id); else ids.delete(id);
      saveCollapsedCardIds(ids);
    });
  });
}
document.addEventListener('DOMContentLoaded', initCollapsibleCards);

// Renders a themed pagination bar (Prev/Next, page numbers with … gaps
// for long ranges, and a "Showing X–Y of Z" summary) into `container`.
// Used under any table that can grow long (attendance log, biometric raw
// log, staff directory, ...) so only one page of rows ever hits the DOM
// at once instead of one giant scrolling table. `onPage(newPage)` is
// called when the user picks a page — the caller owns re-fetching or
// re-slicing and re-rendering the table body.
function renderPagination(container, { page, pageSize, total, onPage }){
  if(!container) return;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(Math.max(1, page), totalPages);
  if(total === 0){ container.innerHTML = ''; return; }

  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  // Always show first/last page plus a small window around the current
  // page; collapse everything else behind an ellipsis so this stays
  // readable even with hundreds of pages.
  const keep = new Set([1, totalPages, page - 1, page, page + 1]);
  const pages = [...keep].filter(n => n >= 1 && n <= totalPages).sort((a, b) => a - b);

  let controls = `<button class="btn btn-ghost btn-sm" ${page === 1 ? 'disabled' : ''} data-page="${page - 1}">‹ Prev</button>`;
  let prev = 0;
  for(const n of pages){
    if(prev && n - prev > 1) controls += `<span class="pagination-ellipsis">…</span>`;
    controls += `<button class="btn btn-sm ${n === page ? 'btn-gold' : 'btn-ghost'}" data-page="${n}">${n}</button>`;
    prev = n;
  }
  controls += `<button class="btn btn-ghost btn-sm" ${page === totalPages ? 'disabled' : ''} data-page="${page + 1}">Next ›</button>`;

  container.innerHTML = `
    <div class="pagination">
      <div class="pagination-summary">Showing ${from}–${to} of ${total}</div>
      <div class="pagination-controls">${controls}</div>
    </div>`;
  container.querySelectorAll('button[data-page]').forEach(btn => {
    btn.addEventListener('click', () => onPage(Number(btn.dataset.page)));
  });
}

// Client-side pagination for tables whose full dataset is already fetched
// in one go (e.g. Staff Directory, which is cached and always small
// enough — bounded by headcount — to fetch entirely up front). Slices
// `array` for the given page without any extra network round-trip.
function paginateClientSide(array, page, pageSize){
  const total = array.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(Math.max(1, page), totalPages);
  return { items: array.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages };
}

// ---------------- Overview ----------------
async function loadOverview(){
  const data = await api('/api/admin/overview');
  if(data.todayBs) TODAY_BS = data.todayBs;
  document.getElementById('ov-date-strip').textContent =
    fmtDateLong() + (data.dateMiti ? ` · ${data.dateMiti} BS` : '') + (data.fiscalYear ? ` · FY ${data.fiscalYear.label}` : '');
  document.getElementById('ov-active').textContent = data.activeStaff;
  document.getElementById('ov-present').textContent = data.presentToday;
  document.getElementById('ov-late').textContent = data.lateToday;
  document.getElementById('ov-onleave').textContent = data.onLeaveToday;
  document.getElementById('ov-absent').textContent = data.absentToday;

  const reqBadge = document.getElementById('req-badge');
  if(data.pendingRequests > 0){
    reqBadge.textContent = data.pendingRequests;
    reqBadge.classList.remove('hidden');
  } else {
    reqBadge.classList.add('hidden');
  }

  const trendCtx = document.getElementById('chart-trend');
  if(charts.trend) charts.trend.destroy();
  charts.trend = new Chart(trendCtx, {
    type: 'line',
    data: {
      labels: data.trend.map(t => t.date.slice(5)),
      datasets: [
        { label:'Present', data: data.trend.map(t=>t.present), borderColor:'#2F8F5B', backgroundColor:'rgba(47,143,91,.08)', tension:.35, fill:true, pointRadius:0 },
        { label:'Late', data: data.trend.map(t=>t.late), borderColor:'#C2841F', backgroundColor:'rgba(194,132,31,.06)', tension:.35, fill:true, pointRadius:0 },
        { label:'Absent', data: data.trend.map(t=>t.absent), borderColor:'#C0463A', backgroundColor:'rgba(192,70,58,.05)', tension:.35, fill:true, pointRadius:0 }
      ]
    },
    options: { responsive:true, plugins:{ legend:{ position:'bottom', labels:{boxWidth:10, font:{size:11.5}} } }, scales:{ x:{grid:{display:false}}, y:{grid:{color:'#EAEDF3'}, beginAtZero:true} } }
  });

  const deptCtx = document.getElementById('chart-dept');
  if(charts.dept) charts.dept.destroy();
  charts.dept = new Chart(deptCtx, {
    type: 'bar',
    data: {
      labels: data.departments.map(d => d.department),
      datasets: [
        { label:'Present', data: data.departments.map(d=>d.present), backgroundColor:'#2E4A93', borderRadius:5 },
        { label:'Total staff', data: data.departments.map(d=>d.total), backgroundColor:'#DDE3ED', borderRadius:5 }
      ]
    },
    options: { responsive:true, indexAxis:'y', plugins:{ legend:{ position:'bottom', labels:{boxWidth:10, font:{size:11.5}} } }, scales:{ x:{grid:{color:'#EAEDF3'}, beginAtZero:true}, y:{grid:{display:false}, ticks:{font:{size:11}}} } }
  });

  const [earlyData, leaveData, corrData] = await Promise.all([
    api('/api/admin/requests?status=pending'),
    api('/api/admin/leave-requests?status=pending'),
    api('/api/admin/corrections?status=pending')
  ]);
  const combined = [
    ...earlyData.requests.filter(r => r.adminDecision === 'pending').map(r => ({ ...r, kind: 'early', label: `Early checkout · ${fmtDate(r.date)}`, tab: 'early' })),
    ...leaveData.requests.filter(r => r.adminDecision === 'pending').map(r => ({ ...r, kind: 'leave', label: `${r.leaveType} · ${fmtDate(r.fromDate)}–${fmtDate(r.toDate)}`, tab: 'leave' })),
    ...corrData.corrections.filter(r => r.adminDecision === 'pending').map(r => ({ ...r, kind: 'correction', label: `Attendance fix · ${fmtDate(r.date)}`, tab: 'correction' }))
  ].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const list = combined.slice(0, 6);
  document.getElementById('ov-pending-list').innerHTML = list.length ? list.map(r => {
    const emp = EMPLOYEES.find(e => e.id === r.employeeId);
    return `
    <div class="flex between center" style="padding:11px 0; border-bottom:1px solid var(--line-soft);">
      <div class="flex center gap-12">
        ${avatarHtml(emp || { name: r.employeeName, avatarColor: 'var(--navy-600)' }, '')}
        <div>
          <div style="font-size:13px; font-weight:600;">${r.employeeName}</div>
          <div class="muted" style="font-size:11.5px;">${r.label}</div>
        </div>
      </div>
      <button class="btn btn-gold btn-sm" onclick="reviewRequest('${r.tab}')">Review</button>
    </div>`;
  }).join('') : `<div class="empty-state" style="padding:24px 0;">No pending requests right now.</div>`;
}

// ---------------- Today's attendance ----------------
let TODAY_RECORDS = [];
async function loadToday(){
  if(!EMPLOYEES.length){
    const empData = await api('/api/admin/employees');
    EMPLOYEES = empData.employees;
  }
  const data = await api('/api/admin/attendance/today');
  document.getElementById('today-date-label').textContent = fmtDateLong() + (data.todayMiti ? ` · ${data.todayMiti} BS` : '');
  TODAY_RECORDS = data.records;
  renderToday();
}
function renderToday(){
  const q = (document.getElementById('today-search').value || '').toLowerCase();
  const filtered = TODAY_RECORDS.filter(r => r.employeeName.toLowerCase().includes(q) || r.empCode.toLowerCase().includes(q));
  const tbody = document.querySelector('#today-table tbody');
  tbody.innerHTML = filtered.length ? filtered.map(r => {
    const emp = EMPLOYEES.find(e => e.id === r.employeeId);
    return `
    <tr>
      <td>
        <div class="row-person">
          ${avatarHtml({ name: r.employeeName, avatarColor: r.avatarColor, avatarImage: r.avatarImage })}
          <div><div class="nm">${r.employeeName}</div><div class="sub mono">${r.empCode}</div></div>
        </div>
      </td>
      <td>${r.department}</td>
      <td>${emp ? `<span class="shift-pill">${emp.shiftName || 'General Shift'}</span>` : '—'}</td>
      <td class="mono">${fmtTime12(r.checkIn)}</td>
      <td class="mono">${fmtTime12(r.checkOut)}</td>
      <td>${r.hoursWorked ? r.hoursWorked + 'h' : '—'}</td>
      <td>${modalityBadge(r.workingModality)}</td>
      <td>${statusBadge(r.earlyCheckout ? 'early_pending' : r.status)}</td>
      <td>${ipLocationCell(r)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="9" class="muted" style="text-align:center; padding:30px;">No matching records.</td></tr>`;
}

// Renders the IP address + nearest area name + a "View on map" link for a
// location-bearing record.
function ipLocationCell(r){
  const ip = r.ipAddress ? `<div class="ip">${r.ipAddress}</div>` : `<div class="ip muted">IP unavailable</div>`;
  let loc;
  if(r.location){
    const areaLine = r.location.area ? `<div class="loc">${r.location.area}</div>` : `<div class="loc muted">Area unknown</div>`;
    loc = `${areaLine}<div class="loc"><a href="${mapLink(r.location)}" target="_blank" rel="noopener">${fmtLatLng(r.location)} ↗</a></div>`;
  } else {
    loc = `<div class="loc">Location not shared</div>`;
  }
  return `<div class="meta-stack">${ip}${loc}</div>`;
}

// ---------------- Approvals ----------------
let reqType = 'early';
async function setReqType(type){
  reqType = type;
  document.getElementById('req-type-early').classList.toggle('active', type === 'early');
  document.getElementById('req-type-leave').classList.toggle('active', type === 'leave');
  document.getElementById('req-type-correction').classList.toggle('active', type === 'correction');
  document.getElementById('req-table-title').textContent =
    type === 'early' ? 'Early checkout requests' :
    type === 'leave' ? 'Leave requests' :
    'Attendance fix requests';
  const thead = document.getElementById('requests-thead');
  thead.innerHTML =
    type === 'early' ? '<tr><th>Staff</th><th>Miti</th><th>Date (AD)</th><th>Departed</th><th>Reason</th><th>Manager</th><th>HR</th><th>Status</th><th></th></tr>' :
    type === 'leave' ? '<tr><th>Staff</th><th>Type</th><th>Miti (From – To)</th><th>From (AD)</th><th>To (AD)</th><th>Reason</th><th>Manager</th><th>HR</th><th>Status</th><th></th></tr>' :
    '<tr><th>Staff</th><th>Miti</th><th>Date (AD)</th><th>Requested In</th><th>Requested Out</th><th>Reason</th><th>Manager</th><th>HR</th><th>Status</th><th></th></tr>';
  await ensureReqPickersInited();
  await loadRequests();
}
function setReqFilter(status){
  reqFilter = status;
  document.querySelectorAll('#req-status-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.status === status));
  loadRequests();
}
let REQ_PICKERS_INITED = false;
function initReqPickers(centerYear){
  populateBsPickers(document.getElementById('req-from-month'), document.getElementById('req-from-year'), centerYear);
  populateBsPickers(document.getElementById('req-to-month'), document.getElementById('req-to-year'), centerYear);
  ['req-from-month','req-from-year','req-to-month','req-to-year'].forEach(id => {
    const el = document.getElementById(id);
    el.insertAdjacentHTML('afterbegin', '<option value="">Any</option>');
    el.value = '';
  });
}
async function ensureReqPickersInited(){
  if(REQ_PICKERS_INITED) return;
  if(!TODAY_BS){ const ov = await api('/api/admin/overview'); TODAY_BS = ov.todayBs; }
  if(TODAY_BS) initReqPickers(TODAY_BS.year);
  REQ_PICKERS_INITED = true;
}
function clearReqDateFilter(){
  ['req-from-month','req-from-year','req-to-month','req-to-year'].forEach(id => document.getElementById(id).value = '');
  loadRequests();
}
async function loadRequestsView(){
  await ensureReqPickersInited();
  loadRequests();
}
// Deep-links from the "Pending approvals" widget (Overview dashboard) and
// anywhere else that needs to land an admin on one specific request type,
// already filtered to Pending, without the flash of a wrong tab/empty
// table that a fire-and-forget showView()+setReqType() pair used to cause.
async function reviewRequest(tab){
  showView('requests', { skipLoad: true });
  reqFilter = 'pending';
  document.querySelectorAll('#req-status-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.status === 'pending'));
  await setReqType(tab);
}
async function loadRequests(){
  const endpoints = { early: '/api/admin/requests', leave: '/api/admin/leave-requests', correction: '/api/admin/corrections' };
  const listKeys = { early: 'requests', leave: 'requests', correction: 'corrections' };
  const params = new URLSearchParams();
  if(reqFilter) params.set('status', reqFilter);
  const fm = document.getElementById('req-from-month').value, fy = document.getElementById('req-from-year').value;
  const tm = document.getElementById('req-to-month').value, ty = document.getElementById('req-to-year').value;
  if(fm && fy){ params.set('bsFromMonth', fm); params.set('bsFromYear', fy); }
  if(tm && ty){ params.set('bsToMonth', tm); params.set('bsToYear', ty); }
  const qs = params.toString();
  const data = await api(endpoints[reqType] + (qs ? '?' + qs : ''));
  const items = data[listKeys[reqType]];
  const tbody = document.querySelector('#requests-table tbody');
  const colspan = reqType === 'leave' ? 10 : 9;
  tbody.innerHTML = items.length ? items.map(r => {
    const emp = EMPLOYEES.find(e => e.id === r.employeeId);
    const person = `
      <div class="row-person">
        ${avatarHtml(emp || { name: r.employeeName, avatarColor: 'var(--navy-600)' })}
        <div><div class="nm">${r.employeeName}</div><div class="sub mono">${r.empCode}</div></div>
      </div>`;
    const actionCell = r.adminDecision === 'pending' ? `
      <div class="flex gap-8">
        <button class="btn btn-gold btn-sm" onclick="decideRequest('${r.id}','${reqType}','approved')">Approve</button>
        <button class="btn btn-danger-ghost btn-sm" onclick="decideRequest('${r.id}','${reqType}','rejected')">Decline</button>
      </div>` : `<span class="muted" style="font-size:12px;">by ${r.adminReviewedBy || '—'}</span>`;

    if(reqType === 'early'){
      return `
      <tr>
        <td>${person}</td>
        <td class="mono">${r.miti || '—'}</td>
        <td class="muted" style="font-size:12px;">${fmtDate(r.date)}</td>
        <td class="mono">${fmtTime12(r.requestedTime)}</td>
        <td style="white-space:normal; max-width:200px;">${r.reason}</td>
        <td>${statusBadge(r.managerDecision)}</td>
        <td>${statusBadge(r.adminDecision)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${actionCell}</td>
      </tr>`;
    }
    if(reqType === 'leave'){
      return `
      <tr>
        <td>${person}</td>
        <td>${r.leaveType}</td>
        <td class="mono">${r.fromMiti && r.toMiti ? (r.fromMiti === r.toMiti ? r.fromMiti : `${r.fromMiti} – ${r.toMiti}`) : '—'}</td>
        <td class="muted" style="font-size:12px;">${fmtDate(r.fromDate)}</td>
        <td class="muted" style="font-size:12px;">${fmtDate(r.toDate)}</td>
        <td style="white-space:normal; max-width:200px;">${r.reason}</td>
        <td>${statusBadge(r.managerDecision)}</td>
        <td>${statusBadge(r.adminDecision)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${actionCell}</td>
      </tr>`;
    }
    return `
      <tr>
        <td>${person}</td>
        <td class="mono">${r.miti || '—'}</td>
        <td class="muted" style="font-size:12px;">${fmtDate(r.date)}</td>
        <td class="mono">${r.requestedCheckIn ? fmtTime12(r.requestedCheckIn) : '—'}</td>
        <td class="mono">${r.requestedCheckOut ? fmtTime12(r.requestedCheckOut) : '—'}</td>
        <td style="white-space:normal; max-width:200px;">${r.reason}</td>
        <td>${statusBadge(r.managerDecision)}</td>
        <td>${statusBadge(r.adminDecision)}</td>
        <td>${statusBadge(r.status)}</td>
        <td>${actionCell}</td>
      </tr>`;
  }).join('') : `<tr><td colspan="${colspan}" class="muted" style="text-align:center; padding:30px;">No requests in this category.</td></tr>`;
}
async function decideRequest(id, type, decision){
  const endpoints = { early: `/api/admin/requests/${id}/decide`, leave: `/api/admin/leave-requests/${id}/decide`, correction: `/api/admin/corrections/${id}/decide` };
  const verb = decision === 'approved' ? 'approve' : 'reject';
  const ok = await confirmDialog({
    title: `${verb === 'approve' ? 'Approve' : 'Reject'} this request?`,
    message: `Are you sure you want to ${verb} this ${type} request? This action can't be undone.`,
    confirmLabel: verb === 'approve' ? 'Approve' : 'Reject',
    danger: verb === 'reject'
  });
  if(!ok) return;
  try{
    await api(endpoints[type], { method:'POST', body: JSON.stringify({decision}) });
    toast(decision === 'approved' ? 'Request approved.' : 'Request declined.', 'success');
    loadRequests();
    loadOverview();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Directory ----------------
async function loadDirectory(){
  const data = await api('/api/admin/employees');
  EMPLOYEES = data.employees;
  const depts = [...new Set(EMPLOYEES.map(e => e.department))].sort();
  const filterSel = document.getElementById('dir-dept-filter');
  filterSel.innerHTML = '<option value="">All departments</option>' + depts.map(d => `<option value="${d}">${d}</option>`).join('');
  const logSel = document.getElementById('log-dept');
  logSel.innerHTML = '<option value="">All</option>' + depts.map(d => `<option value="${d}">${d}</option>`).join('');
  document.getElementById('dir-count').textContent = `${EMPLOYEES.length} staff members on record`;
  renderDirectory();
}
let DIR_PAGE = 1;
let DIR_SORT = { col: null, field: null, dir: 'asc' };
function directorySortValue(e, field){
  if(field === 'name') return (e.name || '').toLowerCase();
  if(field === 'shiftName') return (e.shiftName || 'General Shift').toLowerCase();
  return String(e[field] ?? '').toLowerCase();
}
// Column headers call this instead of the generic sortTable() — that one
// sorts whatever rows are currently in the DOM, which with real
// pagination in play would silently only sort the visible page. This
// sorts the full underlying EMPLOYEES array first, then paginates — the
// dataset here is always small enough (bounded by headcount) to keep
// entirely in memory, so a real full-list sort costs nothing extra.
function sortDirectory(colIndex, field){
  DIR_SORT = { col: colIndex, field, dir: (DIR_SORT.col === colIndex && DIR_SORT.dir === 'asc') ? 'desc' : 'asc' };
  renderDirectory(1);
}
function renderDirectory(page){
  DIR_PAGE = page || 1;
  const q = (document.getElementById('dir-search').value || '').toLowerCase();
  const dept = document.getElementById('dir-dept-filter').value;
  let filtered = EMPLOYEES.filter(e =>
    (!dept || e.department === dept) &&
    (e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q))
  );
  if(DIR_SORT.field){
    const dir = DIR_SORT.dir === 'asc' ? 1 : -1;
    filtered = filtered.slice().sort((a, b) => {
      const av = directorySortValue(a, DIR_SORT.field), bv = directorySortValue(b, DIR_SORT.field);
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }
  document.querySelectorAll('#directory-table thead th').forEach((th, i) => {
    const ind = th.querySelector('.sort-ind');
    if(ind) ind.textContent = DIR_SORT.col === i ? (DIR_SORT.dir === 'asc' ? '▲' : '▼') : '';
  });

  const { items, page: curPage, pageSize, total } = paginateClientSide(filtered, DIR_PAGE, 25);
  DIR_PAGE = curPage;
  const tbody = document.querySelector('#directory-table tbody');
  tbody.innerHTML = items.length ? items.map(e => `
    <tr>
      <td data-sort="${e.name.toLowerCase()}">
        <div class="row-person">
          ${avatarHtml(e)}
          <div><div class="nm">${e.name}</div><div class="sub mono">${e.employeeId}</div></div>
        </div>
      </td>
      <td>${e.department}</td>
      <td>${e.designation}</td>
      <td>${e.managerName || '<span class="muted">—</span>'}</td>
      <td data-sort="${e.shiftName || 'General Shift'}"><span class="shift-pill">${e.shiftName || 'General Shift'}</span><div class="muted mono" style="font-size:10.5px;margin-top:3px;">${fmtTime12(e.shiftStart)} – ${fmtTime12(e.shiftEnd)}</div></td>
      <td>${statusBadge(e.checkedIn ? (e.checkedOut ? 'present' : 'pending') : (e.onLeaveToday ? 'on-leave' : 'absent'))}</td>
      <td data-sort="${e.status}">${e.status === 'active' ? statusBadge('present') : e.status === 'inactive' ? statusBadge('inactive') : statusBadge('on-leave')}</td>
      <td>${leaveBalanceCellHtml(e.leaveBalanceStatus)}</td>
      <td>
        <div class="flex gap-8">
          <button class="btn btn-ghost btn-sm" onclick="openEmployee('${e.id}')">Report</button>
          <button class="btn btn-ghost btn-sm" onclick="openEditEmployee('${e.id}')">Edit</button>
          <button class="btn btn-danger-ghost btn-sm" onclick="openDeleteEmployee('${e.id}')">Remove</button>
        </div>
      </td>
    </tr>`).join('') : `<tr><td colspan="9" class="muted" style="text-align:center; padding:30px;">No staff match this search.</td></tr>`;
  renderPagination(document.getElementById('directory-pagination'), {
    page: curPage, pageSize, total, onPage: (p) => renderDirectory(p)
  });
}
// Compact "CL 5 · SL 8 · AL 12" remaining-balance readout for the directory
// table, with a hover tooltip spelling out assigned/used/remaining per type.
function leaveBalanceCellHtml(status){
  if(!status) return '<span class="muted">—</span>';
  const abbrev = { 'Casual Leave':'CL', 'Sick Leave':'SL', 'Annual Leave':'AL' };
  const parts = Object.entries(status).map(([type, b]) => `${abbrev[type] || type} ${b.remaining}`);
  const tooltip = Object.entries(status).map(([type, b]) => `${type}: ${b.remaining} remaining (${b.used} used of ${b.assigned})`).join('\n');
  return `<span class="mono" style="font-size:12px;" title="${tooltip.replace(/"/g,'&quot;')}">${parts.join(' · ')}</span>`;
}

let CURRENT_EMPLOYEE = null;
let CURRENT_EMPLOYEE_REPORT_BS = null;
let TODAY_BS = null;
async function openEmployee(id, bsMonth, bsYear){
  const qs = bsMonth && bsYear ? `?bsYear=${bsYear}&bsMonth=${bsMonth}` : '';
  const data = await api(`/api/admin/employees/${id}/report${qs}`);
  CURRENT_EMPLOYEE = data.employee;
  CURRENT_EMPLOYEE_REPORT_BS = { year: data.report.bsYear, month: data.report.bsMonth };
  document.getElementById('em-name').textContent = data.employee.name;
  document.getElementById('em-meta').textContent = `${data.employee.employeeId} · ${data.employee.designation} · ${data.employee.department} · ${data.employee.shiftName || 'General Shift'} (${fmtTime12(data.employee.shiftStart)}–${fmtTime12(data.employee.shiftEnd)}) · Joined ${data.employee.joinDateMiti ? data.employee.joinDateMiti + ' BS' : fmtDate(data.employee.joinDate)}`;
  document.getElementById('em-status-badge').innerHTML = data.employee.status === 'active' ? statusBadge('present') : data.employee.status === 'inactive' ? statusBadge('inactive') : statusBadge('on-leave');
  document.getElementById('em-attendance').textContent = data.report.attendanceRate + '%';
  document.getElementById('em-punct').textContent = data.report.punctualityRate + '%';
  document.getElementById('em-hours').textContent = data.report.avgHours.toFixed(1) + 'h';
  document.getElementById('em-deactivate-btn').textContent = data.employee.status === 'active' ? 'Mark On Leave' : 'Mark Active';
  if(!bsMonth || !bsYear){
    populateBsPickers(document.getElementById('em-bs-month'), document.getElementById('em-bs-year'), data.report.bsYear, data.report.bsYear, data.report.bsMonth);
  }

  const ctx = document.getElementById('em-chart');
  if(charts.em) charts.em.destroy();
  charts.em = new Chart(ctx, {
    type:'bar',
    data:{ labels: data.report.records.map(r=>r.miti ? r.miti.slice(-2) : r.date.slice(8,10)), datasets:[{ label:'Hours', data: data.report.records.map(r=>r.hoursWorked||0), backgroundColor:'#2E4A93', borderRadius:5, maxBarThickness:18 }] },
    options:{ responsive:true, plugins:{legend:{display:false}}, scales:{ x:{grid:{display:false}, ticks:{font:{size:9}}}, y:{grid:{color:'#EAEDF3'}, beginAtZero:true} } }
  });

  document.getElementById('employee-modal').classList.remove('hidden');
}
async function toggleEmployeeStatus(){
  if(!CURRENT_EMPLOYEE) return;
  const newStatus = CURRENT_EMPLOYEE.status === 'active' ? 'on-leave' : 'active';
  try{
    await api(`/api/admin/employees/${CURRENT_EMPLOYEE.id}`, { method:'PATCH', body: JSON.stringify({status:newStatus}) });
    toast(`${CURRENT_EMPLOYEE.name} marked ${newStatus === 'active' ? 'active' : 'on leave'}.`, 'success');
    closeModal('employee-modal');
    loadDirectory();
    loadOverview();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Add staff ----------------
function populateManagerSelect(selectEl, excludeId){
  const options = EMPLOYEES.filter(e => e.id !== excludeId).map(e => `<option value="${e.id}">${e.name} — ${e.designation}</option>`).join('');
  selectEl.innerHTML = '<option value="">No manager</option>' + options;
}
function initBsDayOptions(selectEl){
  selectEl.innerHTML = Array.from({length:32}, (_,i) => `<option value="${i+1}">${i+1}</option>`).join('');
}
async function openAddEmployee(){
  populateManagerSelect(document.getElementById('add-manager'), null);
  if(!TODAY_BS){ const ov = await api('/api/admin/overview'); TODAY_BS = ov.todayBs; }
  if(TODAY_BS){
    populateBsPickers(document.getElementById('add-join-month'), document.getElementById('add-join-year'), TODAY_BS.year, TODAY_BS.year, TODAY_BS.month);
    initBsDayOptions(document.getElementById('add-join-day'));
    document.getElementById('add-join-day').value = TODAY_BS.day;
  }
  document.getElementById('add-modal').classList.remove('hidden');
}
function applyShiftPreset(prefix='add'){
  const sel = document.getElementById(prefix + '-shift-name');
  const opt = sel.options[sel.selectedIndex];
  const startInput = document.getElementById(prefix + '-shift-start');
  const endInput = document.getElementById(prefix + '-shift-end');
  if(opt.value === 'Custom'){
    startInput.disabled = false; endInput.disabled = false;
    return;
  }
  startInput.value = opt.dataset.start;
  endInput.value = opt.dataset.end;
  startInput.disabled = false; endInput.disabled = false;
}
async function submitAddEmployee(){
  const name = document.getElementById('add-name').value.trim();
  const email = document.getElementById('add-email').value.trim();
  const department = document.getElementById('add-dept').value.trim();
  const designation = document.getElementById('add-desig').value.trim();
  const phone = document.getElementById('add-phone').value.trim();
  const managerId = document.getElementById('add-manager').value;
  const autoAttendance = document.getElementById('add-auto-attendance').checked;
  const exemptFromApproval = document.getElementById('add-exempt-approval').checked;
  const canViewAllReports = document.getElementById('add-view-all-reports').checked;
  const leaveBalances = {
    'Casual Leave': Number(document.getElementById('add-lv-casual').value) || 0,
    'Sick Leave': Number(document.getElementById('add-lv-sick').value) || 0,
    'Annual Leave': Number(document.getElementById('add-lv-annual').value) || 0
  };
  const shiftSel = document.getElementById('add-shift-name');
  const shiftName = shiftSel.value === 'Custom' ? 'Custom Shift' : shiftSel.value;
  const shiftStart = document.getElementById('add-shift-start').value || '09:00';
  const shiftEnd = document.getElementById('add-shift-end').value || '18:00';
  const joinBsMonth = document.getElementById('add-join-month').value;
  const joinBsYear = document.getElementById('add-join-year').value;
  const joinBsDay = document.getElementById('add-join-day').value;
  if(!name || !email || !department){ toast('Name, email and department are required.', 'error'); return; }
  try{
    const data = await api('/api/admin/employees', { method:'POST', body: JSON.stringify({name,email,department,designation,phone,managerId,shiftName,shiftStart,shiftEnd,autoAttendance,exemptFromApproval,canViewAllReports,leaveBalances,joinBsYear,joinBsMonth,joinBsDay}) });
    toast(`${name} added — temporary password: ${data.tempPassword}`, 'success');
    closeModal('add-modal');
    ['add-name','add-email','add-dept','add-desig','add-phone'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('add-shift-name').selectedIndex = 0;
    document.getElementById('add-shift-start').value = '09:00';
    document.getElementById('add-shift-end').value = '18:00';
    document.getElementById('add-manager').value = '';
    document.getElementById('add-auto-attendance').checked = false;
    document.getElementById('add-exempt-approval').checked = false;
    document.getElementById('add-view-all-reports').checked = false;
    document.getElementById('add-lv-casual').value = 12;
    document.getElementById('add-lv-sick').value = 8;
    document.getElementById('add-lv-annual').value = 15;
    if(TODAY_BS){
      document.getElementById('add-join-month').value = TODAY_BS.month;
      document.getElementById('add-join-year').value = TODAY_BS.year;
      document.getElementById('add-join-day').value = TODAY_BS.day;
    }
    loadDirectory();
    loadOverview();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Edit staff ----------------
function openEditEmployee(id){
  const e = EMPLOYEES.find(x => x.id === id);
  if(!e) return;
  document.getElementById('edit-id').value = e.id;
  document.getElementById('edit-modal-sub').textContent = `${e.employeeId} · ${e.department}`;
  document.getElementById('edit-name').value = e.name;
  document.getElementById('edit-email').value = e.email;
  document.getElementById('edit-dept').value = e.department;
  document.getElementById('edit-desig').value = e.designation || '';
  document.getElementById('edit-phone').value = e.phone || '';
  document.getElementById('edit-shift-start').value = e.shiftStart || '09:00';
  document.getElementById('edit-shift-end').value = e.shiftEnd || '18:00';
  const shiftNameSel = document.getElementById('edit-shift-name');
  const knownShift = Array.from(shiftNameSel.options).some(o => o.value === e.shiftName);
  shiftNameSel.value = knownShift ? e.shiftName : 'Custom';
  document.getElementById('edit-status').value = ['active', 'on-leave', 'inactive'].includes(e.status) ? e.status : 'active';
  document.getElementById('edit-auto-attendance').checked = !!e.autoAttendance;
  document.getElementById('edit-exempt-approval').checked = !!e.exemptFromApproval;
  document.getElementById('edit-view-all-reports').checked = !!e.canViewAllReports;
  const lbStatus = e.leaveBalanceStatus || {};
  const fallback = { 'Casual Leave': 12, 'Sick Leave': 8, 'Annual Leave': 15 };
  document.getElementById('edit-lv-casual').value = lbStatus['Casual Leave'] ? lbStatus['Casual Leave'].remaining : fallback['Casual Leave'];
  document.getElementById('edit-lv-sick').value = lbStatus['Sick Leave'] ? lbStatus['Sick Leave'].remaining : fallback['Sick Leave'];
  document.getElementById('edit-lv-annual').value = lbStatus['Annual Leave'] ? lbStatus['Annual Leave'].remaining : fallback['Annual Leave'];
  const usedBits = Object.entries(lbStatus).filter(([,b]) => b.used > 0).map(([type,b]) => `${b.used} ${type.split(' ')[0]}`);
  document.getElementById('edit-lv-used-note').textContent = usedBits.length
    ? `Already used this year: ${usedBits.join(', ')}. Editing the fields above changes what's remaining — used days stay recorded.`
    : 'These are the days remaining for the year. Change a number to adjust it — unrelated edits won\'t reset it.';
  populateManagerSelect(document.getElementById('edit-manager'), e.id);
  document.getElementById('edit-manager').value = e.managerId || '';
  if(e.joinDateMiti){
    const [jy, jm, jd] = e.joinDateMiti.split('-').map(Number);
    populateBsPickers(document.getElementById('edit-join-month'), document.getElementById('edit-join-year'), jy, jy, jm);
    initBsDayOptions(document.getElementById('edit-join-day'));
    document.getElementById('edit-join-day').value = jd;
    document.getElementById('edit-join-note').textContent = `Currently on file as ${e.joinDateMiti} BS (${fmtDate(e.joinDate)}).`;
  }
  document.getElementById('edit-modal').classList.remove('hidden');
}
function resetToDefaultPassword(){
  const id = document.getElementById('edit-id').value;
  const name = document.getElementById('edit-name').value || 'this staff member';
  if(!id) return;
  document.getElementById('reset-pw-modal-sub').innerHTML = `This immediately sets <b>${name}</b>'s password back to <span class="mono">Welcome@123</span>. No email is sent — you'll need to tell them directly and have them change it after signing in.`;
  document.getElementById('reset-pw-modal').classList.remove('hidden');
}
async function confirmResetToDefaultPassword(){
  const id = document.getElementById('edit-id').value;
  const name = document.getElementById('edit-name').value || 'this staff member';
  if(!id) return;
  try{
    await withBtnLoading(document.getElementById('reset-pw-confirm-btn'), () => api(`/api/admin/employees/${id}/reset-default-password`, { method:'POST' }));
    closeModal('reset-pw-modal');
    toast(`Password reset to Welcome@123 for ${name}.`, 'success');
  }catch(err){ toast(err.message, 'error'); }
}
async function submitEditEmployee(){
  const id = document.getElementById('edit-id').value;
  const payload = {
    name: document.getElementById('edit-name').value.trim(),
    email: document.getElementById('edit-email').value.trim(),
    department: document.getElementById('edit-dept').value.trim(),
    designation: document.getElementById('edit-desig').value.trim(),
    phone: document.getElementById('edit-phone').value.trim(),
    shiftStart: document.getElementById('edit-shift-start').value,
    shiftEnd: document.getElementById('edit-shift-end').value,
    shiftName: document.getElementById('edit-shift-name').value,
    status: document.getElementById('edit-status').value,
    managerId: document.getElementById('edit-manager').value,
    autoAttendance: document.getElementById('edit-auto-attendance').checked,
    exemptFromApproval: document.getElementById('edit-exempt-approval').checked,
    canViewAllReports: document.getElementById('edit-view-all-reports').checked,
    leaveBalancesRemaining: {
      'Casual Leave': Number(document.getElementById('edit-lv-casual').value) || 0,
      'Sick Leave': Number(document.getElementById('edit-lv-sick').value) || 0,
      'Annual Leave': Number(document.getElementById('edit-lv-annual').value) || 0
    },
    joinBsMonth: document.getElementById('edit-join-month').value,
    joinBsYear: document.getElementById('edit-join-year').value,
    joinBsDay: document.getElementById('edit-join-day').value
  };
  if(!payload.name || !payload.email || !payload.department){ toast('Name, email and department are required.', 'error'); return; }
  try{
    await api(`/api/admin/employees/${id}`, { method:'PATCH', body: JSON.stringify(payload) });
    toast('Staff record updated.', 'success');
    closeModal('edit-modal');
    loadDirectory();
    loadOverview();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Remove staff ----------------
let DELETE_TARGET = null;
function openDeleteEmployee(id){
  const e = EMPLOYEES.find(x => x.id === id);
  if(!e) return;
  DELETE_TARGET = e;
  document.getElementById('delete-modal-sub').textContent = `Removing ${e.name} (${e.employeeId}) also permanently deletes their attendance history and requests. This can't be undone.`;
  document.getElementById('delete-modal').classList.remove('hidden');
}
document.getElementById('delete-confirm-btn').addEventListener('click', async () => {
  if(!DELETE_TARGET) return;
  try{
    await api(`/api/admin/employees/${DELETE_TARGET.id}`, { method:'DELETE' });
    toast(`${DELETE_TARGET.name} removed.`, 'success');
    closeModal('delete-modal');
    DELETE_TARGET = null;
    loadDirectory();
    loadOverview();
  }catch(err){ toast(err.message, 'error'); }
});

// ---------------- Manual attendance adjustment (HR override, no approval) ----------------
function openAdjustModal(){
  const sel = document.getElementById('adj-employee');
  sel.innerHTML = EMPLOYEES.map(e => `<option value="${e.id}">${e.name} — ${e.employeeId}</option>`).join('');
  document.getElementById('adj-date').max = new Date().toISOString().slice(0,10);
  document.getElementById('adj-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('adj-checkin').value = '';
  document.getElementById('adj-checkout').value = '';
  document.getElementById('adj-status').value = '';
  document.getElementById('adjust-modal').classList.remove('hidden');
}
async function submitAdjustment(clear){
  const employeeId = document.getElementById('adj-employee').value;
  const date = document.getElementById('adj-date').value;
  if(!employeeId || !date){ toast('Pick a staff member and date.', 'error'); return; }
  const payload = { employeeId, date };
  if(clear){
    payload.clear = true;
  } else {
    const checkIn = document.getElementById('adj-checkin').value;
    const checkOut = document.getElementById('adj-checkout').value;
    const statusOverride = document.getElementById('adj-status').value;
    if(!checkIn && !checkOut && !statusOverride){ toast('Enter a time or pick a status, or clear the record instead.', 'error'); return; }
    payload.checkIn = checkIn; payload.checkOut = checkOut; payload.statusOverride = statusOverride;
  }
  try{
    await api('/api/admin/attendance/adjust', { method:'POST', body: JSON.stringify(payload) });
    toast(clear ? 'Record cleared.' : 'Attendance updated.', 'success');
    closeModal('adjust-modal');
    loadLog();
    loadToday();
    loadOverview();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Attendance log ----------------
let LOG_PICKERS_INITED = false;
async function loadLogView(){
  if(!LOG_PICKERS_INITED){
    if(!TODAY_BS){ const ov = await api('/api/admin/overview'); TODAY_BS = ov.todayBs; }
    if(TODAY_BS) initLogPickers(TODAY_BS.year);
    LOG_PICKERS_INITED = true;
  }
  loadLog();
}
function logBsParams(){
  const params = new URLSearchParams();
  const fm = document.getElementById('log-from-month').value, fy = document.getElementById('log-from-year').value;
  const tm = document.getElementById('log-to-month').value, ty = document.getElementById('log-to-year').value;
  if(fm && fy){ params.set('bsFromMonth', fm); params.set('bsFromYear', fy); }
  if(tm && ty){ params.set('bsToMonth', tm); params.set('bsToYear', ty); }
  const dept = document.getElementById('log-dept').value;
  const status = document.getElementById('log-status').value;
  if(dept) params.set('department', dept);
  if(status) params.set('status', status);
  return params;
}
function initLogPickers(centerYear){
  populateBsPickers(document.getElementById('log-from-month'), document.getElementById('log-from-year'), centerYear, centerYear, 1);
  populateBsPickers(document.getElementById('log-to-month'), document.getElementById('log-to-year'), centerYear, centerYear, TODAY_BS ? TODAY_BS.month : 12);
}
let LOG_PAGE = 1;
let LOG_SORT = { field: 'date', dir: 'desc' };
function sortLog(field){
  LOG_SORT = { field, dir: (LOG_SORT.field === field && LOG_SORT.dir === 'asc') ? 'desc' : 'asc' };
  loadLog(1);
}
async function loadLog(page){
  LOG_PAGE = page || 1;
  const params = logBsParams();
  params.set('page', LOG_PAGE);
  params.set('pageSize', 50);
  params.set('sortBy', LOG_SORT.field);
  params.set('sortDir', LOG_SORT.dir);
  const data = await api('/api/admin/attendance?' + params.toString());
  document.getElementById('log-count').textContent = `${data.total} record(s)`;
  const tbody = document.querySelector('#log-table tbody');
  tbody.innerHTML = data.records.length ? data.records.map(r => `
    <tr>
      <td class="mono">${r.miti || '—'}</td>
      <td class="muted" style="font-size:12px;">${fmtDate(r.date)}</td>
      <td>${r.employeeName} <span class="muted mono" style="font-size:11px;">${r.empCode}</span></td>
      <td>${r.department}</td>
      <td class="mono">${fmtTime12(r.checkIn)}</td>
      <td class="mono">${fmtTime12(r.checkOut)}</td>
      <td>${r.hoursWorked ? r.hoursWorked + 'h' : '—'}</td>
      <td>${modalityBadge(r.workingModality)}</td>
      <td>${sourceBadge(r.source)}</td>
      <td>${statusBadge(r.earlyCheckout ? 'early_pending' : r.status)}</td>
      <td>${ipLocationCell(r)}</td>
    </tr>`).join('') : `<tr><td colspan="11" class="muted" style="text-align:center; padding:30px;">No records match these filters.</td></tr>`;
  // Sort indicator arrows — matches by which column's sortLog(field) call
  // matches the active LOG_SORT.field, since Miti/Date(AD) share one field.
  const fieldsByCol = ['date', 'date', 'employeeName', 'department', 'checkIn', 'checkOut', 'hoursWorked', null, 'source', 'status', null];
  document.querySelectorAll('#log-table thead th').forEach((th, i) => {
    const ind = th.querySelector('.sort-ind');
    if(ind) ind.textContent = fieldsByCol[i] === LOG_SORT.field ? (LOG_SORT.dir === 'asc' ? '▲' : '▼') : '';
  });
  renderPagination(document.getElementById('log-pagination'), {
    page: data.page, pageSize: data.pageSize, total: data.total, onPage: (p) => loadLog(p)
  });
}

// ---------------- Exports ----------------
function exportOverall(format){
  const params = logBsParams();
  toast(`Preparing company-wide ${format.toUpperCase()} report…`);
  window.location.href = `/api/admin/attendance/export/${format}?` + params.toString();
}

function exportEmployee(format){
  if(!CURRENT_EMPLOYEE || !CURRENT_EMPLOYEE_REPORT_BS) return;
  toast(`Preparing ${format.toUpperCase()} report for ${CURRENT_EMPLOYEE.name}…`);
  window.location.href = `/api/admin/employees/${CURRENT_EMPLOYEE.id}/export/${format}?bsYear=${CURRENT_EMPLOYEE_REPORT_BS.year}&bsMonth=${CURRENT_EMPLOYEE_REPORT_BS.month}`;
}

// ---------------- Holidays ----------------
async function loadHolidays(){
  if(!TODAY_BS){ const ov = await api('/api/admin/overview'); TODAY_BS = ov.todayBs; }
  if(TODAY_BS) initHolidayPickers(TODAY_BS.year);
  const data = await api('/api/admin/holidays');
  document.getElementById('hol-count').textContent = `${data.holidays.length} holiday(s) defined`;
  const tbody = document.querySelector('#holidays-table tbody');
  tbody.innerHTML = data.holidays.length ? data.holidays.map(h => `
    <tr>
      <td class="mono">${h.miti || '—'}</td>
      <td class="mono muted" style="font-size:12px;">${fmtDate(h.date)}</td>
      <td>${new Date(h.date + 'T00:00:00').toLocaleDateString('en-US', { weekday:'long' })}</td>
      <td>${h.name}</td>
      <td><button class="btn btn-danger-ghost btn-sm" onclick="deleteHoliday('${h.id}')">Remove</button></td>
    </tr>`).join('') : `<tr><td colspan="5" class="muted" style="text-align:center; padding:30px;">No holidays defined yet — add one above.</td></tr>`;
}
async function addHoliday(){
  const bsMonth = document.getElementById('hol-bs-month').value;
  const bsYear = document.getElementById('hol-bs-year').value;
  const bsDay = document.getElementById('hol-bs-day').value;
  const name = document.getElementById('hol-name').value.trim();
  if(!bsMonth || !bsYear || !bsDay){ toast('Pick a Miti date.', 'error'); return; }
  try{
    await api('/api/admin/holidays', { method:'POST', body: JSON.stringify({ bsYear, bsMonth, bsDay, name }) });
    document.getElementById('hol-name').value = '';
    toast('Holiday added.', 'success');
    loadHolidays();
  }catch(err){ toast(err.message, 'error'); }
}
function initHolidayPickers(centerYear){
  const monthSel = document.getElementById('hol-bs-month');
  const yearSel = document.getElementById('hol-bs-year');
  const daySel = document.getElementById('hol-bs-day');
  populateBsPickers(monthSel, yearSel, centerYear);
  daySel.innerHTML = Array.from({length:32}, (_,i) => `<option value="${i+1}">${i+1}</option>`).join('');
}
async function deleteHoliday(id){
  try{
    await api(`/api/admin/holidays/${id}`, { method:'DELETE' });
    toast('Holiday removed.', 'success');
    loadHolidays();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Company settings (org-wide branding) ----------------
async function loadCompanySettings(){
  try{
    const data = await api('/api/settings');
    document.getElementById('settings-company-name').value = data.companyName || '';
    document.querySelector('#settings-logo-preview img').src = data.logoImage ? withCacheBust(data.logoImage) : '/img/logo.png';
    document.getElementById('remove-logo-btn').classList.toggle('hidden', !data.logoImage);
    const offDays = new Set(data.weeklyOffDays || [6]);
    document.querySelectorAll('#workweek-days input[type=checkbox]').forEach(cb => cb.checked = offDays.has(Number(cb.value)));
    document.getElementById('auto-sync-enabled').checked = !!data.autoSyncEnabled;
    document.getElementById('auto-sync-time').value = data.autoSyncTime || '08:00';

    const latEl = document.getElementById('settings-office-lat');
    const lngEl = document.getElementById('settings-office-lng');
    const radiusEl = document.getElementById('settings-office-radius');
    if(latEl && lngEl && radiusEl){
      latEl.value = (data.officeLatitude === null || data.officeLatitude === undefined) ? '' : data.officeLatitude;
      lngEl.value = (data.officeLongitude === null || data.officeLongitude === undefined) ? '' : data.officeLongitude;
      radiusEl.value = data.officeRadiusMeters || 300;
      updateOfficeLocationStatus(data.officeLatitude, data.officeLongitude);
    }
  }catch(err){ /* non-fatal */ }
}
function updateOfficeLocationStatus(lat, lng){
  const el = document.getElementById('office-location-status');
  if(!el) return;
  if(lat === null || lat === undefined || lng === null || lng === undefined){
    el.textContent = 'Not set — every check-in will currently be recorded as Remote.';
  } else {
    el.textContent = `Currently set to ${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}.`;
  }
}
function useCurrentLocationForOffice(btn){
  if(!navigator.geolocation){ toast('Your browser does not support location access.', 'error'); return; }
  withBtnLoading(btn, () => new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        document.getElementById('settings-office-lat').value = pos.coords.latitude.toFixed(6);
        document.getElementById('settings-office-lng').value = pos.coords.longitude.toFixed(6);
        toast('Location filled in — review and save below.', 'success');
        resolve();
      },
      (err) => { toast(err.code === 1 ? 'Location access was denied.' : 'Could not get your current location.', 'error'); reject(err); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  })).catch(() => {});
}
async function saveOfficeLocation(){
  const latRaw = document.getElementById('settings-office-lat').value.trim();
  const lngRaw = document.getElementById('settings-office-lng').value.trim();
  const radiusRaw = document.getElementById('settings-office-radius').value.trim();
  if((latRaw === '') !== (lngRaw === '')){
    toast('Set both latitude and longitude, or leave both empty to clear.', 'error');
    return;
  }
  const body = {
    officeLatitude: latRaw === '' ? null : Number(latRaw),
    officeLongitude: lngRaw === '' ? null : Number(lngRaw),
    officeRadiusMeters: radiusRaw === '' ? 300 : Number(radiusRaw)
  };
  try{
    const data = await api('/api/settings', { method:'PATCH', body: JSON.stringify(body) });
    toast(data.officeLatitude === null ? 'Office location cleared — check-ins will be recorded as Remote.' : 'Office location saved.', 'success');
    updateOfficeLocationStatus(data.officeLatitude, data.officeLongitude);
  }catch(err){ toast(err.message, 'error'); }
}
async function clearOfficeLocation(){
  document.getElementById('settings-office-lat').value = '';
  document.getElementById('settings-office-lng').value = '';
  await saveOfficeLocation();
}
async function loadAccountSettings(){
  loadPasswordResetRequests();
}
async function saveWorkWeek(){
  const days = Array.from(document.querySelectorAll('#workweek-days input[type=checkbox]:checked')).map(cb => Number(cb.value));
  if(!days.length){ toast('Pick at least one weekly off day.', 'error'); return; }
  try{
    await api('/api/settings', { method:'PATCH', body: JSON.stringify({ weeklyOffDays: days }) });
    toast('Work week updated.', 'success');
  }catch(err){ toast(err.message, 'error'); }
}
async function loadPasswordResetRequests(){
  try{
    const { requests } = await api('/api/admin/password-reset-requests');
    const tbody = document.querySelector('#pw-reset-requests-table tbody');
    tbody.innerHTML = requests.length ? requests.map(r => `
      <tr>
        <td class="mono" data-sort="${r.requested_at}">${new Date(r.requested_at).toLocaleString()}</td>
        <td data-sort="${(r.name||'').toLowerCase()}">${r.name || '—'}</td>
        <td data-sort="${r.email.toLowerCase()}">${r.email}</td>
        <td data-sort="${r.status}">${r.status === 'completed' ? '<span class="badge badge-approved">Resolved</span>' : '<span class="badge badge-pending">Pending</span>'}</td>
        <td>${r.status === 'pending' ? `<button class="btn btn-ghost btn-sm" onclick="assignNewPassword('${r.id}', this)">Assign new password</button>` : ''}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="muted" style="text-align:center; padding:20px;">No requests yet.</td></tr>`;

    const pendingCount = requests.filter(r => r.status === 'pending').length;
    const badge = document.getElementById('pwreq-badge');
    if(badge){ badge.textContent = pendingCount; badge.classList.toggle('hidden', pendingCount === 0); }
    const alertCard = document.getElementById('pwreq-alert');
    if(alertCard){
      alertCard.classList.toggle('hidden', pendingCount === 0);
      const text = document.getElementById('pwreq-alert-text');
      if(text) text.textContent = `${pendingCount} pending password reset request${pendingCount === 1 ? '' : 's'}`;
    }
  }catch(err){ /* non-fatal */ }
}
async function assignNewPassword(id, btn){
  try{
    await withBtnLoading(btn, () => api(`/api/admin/password-reset-requests/${id}/assign`, { method:'POST' }));
    toast('New password emailed to the staff member.', 'success');
    loadPasswordResetRequests();
  }catch(err){ toast(err.message, 'error'); }
}
async function saveCompanyName(){
  const companyName = document.getElementById('settings-company-name').value.trim();
  if(!companyName){ toast('Company name cannot be empty.', 'error'); return; }
  try{
    await api('/api/settings', { method:'PATCH', body: JSON.stringify({ companyName }) });
    toast('Company name updated.', 'success');
    applyBranding();
  }catch(err){ toast(err.message, 'error'); }
}
async function onLogoFileChosen(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const formData = new FormData();
  formData.append('logo', file);
  try{
    const res = await fetch('/api/settings/logo', { method:'POST', body: formData });
    const data = await res.json();
    if(!res.ok){ throw new Error(data.error || 'Could not upload logo.'); }
    document.querySelector('#settings-logo-preview img').src = withCacheBust(data.logoImage);
    document.getElementById('remove-logo-btn').classList.remove('hidden');
    toast('Company logo updated.', 'success');
    applyBranding();
  }catch(err){ toast(err.message, 'error'); }
  input.value = '';
}
async function removeCompanyLogo(){
  const ok = await confirmDialog({ title: 'Remove the company logo?', message: 'Sign-in screens and sidebars will fall back to the default icon.', confirmLabel: 'Remove' });
  if(!ok) return;
  try{
    await api('/api/settings/logo', { method:'DELETE' });
    document.querySelector('#settings-logo-preview img').src = '/img/logo.png';
    document.getElementById('remove-logo-btn').classList.add('hidden');
    toast('Logo removed.', 'success');
    applyBranding();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Account: profile photo + password (HR admin's own) ----------------
async function onAdminAvatarFileChosen(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const formData = new FormData();
  formData.append('image', file);
  try{
    const res = await fetch('/api/auth/admin/profile-image', { method:'POST', body: formData });
    const data = await res.json();
    if(!res.ok){ throw new Error(data.error || 'Could not upload photo.'); }
    ADMIN = data.admin;
    applyAvatar(document.getElementById('sb-avatar'), ADMIN);
    applyAvatar(document.getElementById('account-avatar'), ADMIN);
    document.getElementById('admin-remove-photo-btn').classList.toggle('hidden', !ADMIN.avatarImage);
    toast('Profile photo updated.', 'success');
  }catch(err){ toast(err.message, 'error'); }
  input.value = '';
}

async function removeAdminAvatar(){
  const ok = await confirmDialog({ title: 'Remove your photo?', message: 'Your avatar will fall back to your initials.', confirmLabel: 'Remove' });
  if(!ok) return;
  try{
    const data = await api('/api/auth/admin/profile-image', { method:'DELETE' });
    ADMIN = data.admin;
    applyAvatar(document.getElementById('sb-avatar'), ADMIN);
    applyAvatar(document.getElementById('account-avatar'), ADMIN);
    document.getElementById('admin-remove-photo-btn').classList.add('hidden');
    toast('Profile photo removed.', 'success');
  }catch(err){ toast(err.message, 'error'); }
}

async function changeAdminPassword(){
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;
  if(!currentPassword || !newPassword){ toast('Fill in both password fields.', 'error'); return; }
  if(newPassword.length < 8){ toast('New password must be at least 8 characters.', 'error'); return; }
  if(newPassword !== confirm){ toast('New password and confirmation don\'t match.', 'error'); return; }
  try{
    await api('/api/auth/admin/change-password', { method:'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    toast('Password updated.', 'success');
  }catch(err){ toast(err.message, 'error'); }
}

async function init(){
  try{
    const data = await api('/api/auth/admin/me');
    ADMIN = data.admin;
  }catch(e){
    window.location.href = '/adminlogin';
    return;
  }
  document.getElementById('sb-name').textContent = ADMIN.name;
  document.getElementById('sb-role').textContent = ADMIN.designation || ADMIN.role;
  applyAvatar(document.getElementById('sb-avatar'), ADMIN);
  applyAvatar(document.getElementById('account-avatar'), ADMIN);
  document.getElementById('account-name').textContent = ADMIN.name;
  document.getElementById('account-role').textContent = ADMIN.designation || ADMIN.role;
  document.getElementById('admin-remove-photo-btn').classList.toggle('hidden', !ADMIN.avatarImage);

  try{
    const empData = await api('/api/admin/employees');
    EMPLOYEES = empData.employees;
  }catch(e){ /* directory tab will retry */ }

  await loadOverview();
  refreshDeviceStatusPill();
  loadPasswordResetRequests();
}

init();

// ---------------- Background auto-refresh ----------------
// Keeps the pending-requests badge/dashboard current without HR needing
// to manually reload — new requests coming in shouldn't sit unnoticed.
// Paused while the tab isn't visible.
setInterval(() => {
  if(document.hidden || !ADMIN) return;
  loadOverview();
  refreshDeviceStatusPill();
  loadPasswordResetRequests();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if(!document.hidden && ADMIN){ loadOverview(); refreshDeviceStatusPill(); loadPasswordResetRequests(); }
});

// ---------------- Biometric Devices (ZKTeco, multiple) ----------------
let DEVICES_CACHE = [];

async function loadDeviceView(){
  await Promise.all([loadDevicesList(), loadPendingBanner(), loadDeviceUsers(), loadDeviceLogs(), loadDeviceSyncLogs()]);
}

async function loadDevicesList(){
  try{
    const { devices } = await api('/api/admin/devices');
    DEVICES_CACHE = devices;
    renderDeviceStatusPill(devices);
    const tbody = document.querySelector('#devices-table tbody');
    tbody.innerHTML = devices.length ? devices.map(d => `
      <tr>
        <td>${d.name}</td>
        <td>${d.location || '<span class="muted">—</span>'}</td>
        <td class="mono">${d.ip}:${d.port}</td>
        <td class="mono" style="font-size:12px;">${d.lastSyncedAt ? new Date(d.lastSyncedAt).toLocaleString() : '<span class="muted">Never</span>'}</td>
        <td>${d.lastSyncStatus === 'error' ? '<span class="badge badge-rejected">Failed</span>' : d.lastSyncedAt ? '<span class="badge badge-approved">OK</span>' : '<span class="badge badge-neutral">—</span>'}</td>
        <td>
          <div class="flex gap-8">
            <button class="btn btn-ghost btn-sm" onclick="withBtnLoading(this, () => fetchFromDevice('${d.id}'))">⟳ Fetch</button>
            <button class="btn btn-ghost btn-sm" onclick="openEditDeviceModal('${d.id}')">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" onclick="openDeleteDeviceModal('${d.id}')">Remove</button>
          </div>
        </td>
      </tr>`).join('') : `<tr><td colspan="6" class="muted" style="text-align:center; padding:20px;">No devices added yet.</td></tr>`;
  }catch(e){ toast(e.message, 'error'); }
}

// Small status pill in the topbar so HR can see biometric device health
// from any screen, without opening the Biometric Device tab.
function renderDeviceStatusPill(devices){
  const pill = document.getElementById('device-status-pill');
  const text = document.getElementById('device-status-pill-text');
  if(!pill || !text) return;
  pill.classList.remove('ok', 'warn', 'err');
  if(!devices || !devices.length){
    text.textContent = 'Biometric: not set up';
  } else if(devices.some(d => d.lastSyncStatus === 'error')){
    pill.classList.add('err');
    text.textContent = 'Biometric: sync failed';
  } else if(devices.every(d => !d.lastSyncedAt)){
    pill.classList.add('warn');
    text.textContent = 'Biometric: not synced';
  } else {
    pill.classList.add('ok');
    const latest = devices.filter(d => d.lastSyncedAt).sort((a,b) => new Date(b.lastSyncedAt) - new Date(a.lastSyncedAt))[0];
    const mins = Math.round((Date.now() - new Date(latest.lastSyncedAt).getTime()) / 60000);
    const when = mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : new Date(latest.lastSyncedAt).toLocaleDateString();
    text.textContent = `Biometric: synced ${when}`;
  }
}
async function refreshDeviceStatusPill(){
  try{
    const { devices } = await api('/api/admin/devices');
    DEVICES_CACHE = devices;
    renderDeviceStatusPill(devices);
  }catch(e){ /* pill just stays at its last known state */ }
}

function openAddDeviceModal(){
  document.getElementById('device-modal-title').textContent = 'Add biometric device';
  document.getElementById('device-modal-id').value = '';
  document.getElementById('device-modal-name').value = '';
  document.getElementById('device-modal-location').value = '';
  document.getElementById('device-modal-ip').value = '';
  document.getElementById('device-modal-port').value = '4370';
  document.getElementById('device-modal').classList.remove('hidden');
}
function openEditDeviceModal(id){
  const d = DEVICES_CACHE.find(x => x.id === id);
  if(!d) return;
  document.getElementById('device-modal-title').textContent = 'Edit biometric device';
  document.getElementById('device-modal-id').value = d.id;
  document.getElementById('device-modal-name').value = d.name || '';
  document.getElementById('device-modal-location').value = d.location || '';
  document.getElementById('device-modal-ip').value = d.ip || '';
  document.getElementById('device-modal-port').value = d.port || 4370;
  document.getElementById('device-modal').classList.remove('hidden');
}
async function saveDeviceModal(){
  const id = document.getElementById('device-modal-id').value;
  const body = {
    name: document.getElementById('device-modal-name').value.trim() || 'ZKTeco device',
    location: document.getElementById('device-modal-location').value.trim(),
    ip: document.getElementById('device-modal-ip').value.trim(),
    port: document.getElementById('device-modal-port').value.trim() || 4370
  };
  if(!body.ip){ toast('Enter the device IP address.', 'error'); return; }
  try{
    if(id) await api(`/api/admin/devices/${id}`, { method:'PATCH', body: JSON.stringify(body) });
    else await api('/api/admin/devices', { method:'POST', body: JSON.stringify(body) });
    closeModal('device-modal');
    toast('Device saved.', 'success');
    await loadDevicesList();
  }catch(e){ toast(e.message, 'error'); }
}
async function testDeviceModalConnection(){
  const id = document.getElementById('device-modal-id').value;
  if(!id){ toast('Save the device first, then test the connection.', 'error'); return; }
  try{
    const res = await api(`/api/admin/devices/${id}/test`, { method:'POST' });
    toast(res.ok ? 'Device reachable ✓' : 'Could not reach device', res.ok ? 'success' : 'error');
  }catch(e){ toast(e.message, 'error'); }
}
function openDeleteDeviceModal(id){
  const d = DEVICES_CACHE.find(x => x.id === id);
  document.getElementById('delete-device-modal-sub').textContent = `Remove "${d ? d.name : 'this device'}"? Its enrolled-user links and raw punch history will be removed too. This can't be undone.`;
  document.getElementById('delete-device-confirm-btn').onclick = () => withBtnLoading(document.getElementById('delete-device-confirm-btn'), async () => {
    await api(`/api/admin/devices/${id}`, { method:'DELETE' });
    closeModal('delete-device-modal');
    toast('Device removed.', 'success');
    await loadDeviceView();
  });
  document.getElementById('delete-device-modal').classList.remove('hidden');
}

// Stage 1 — fetch only. Pulls users + punches from the device and stores
// them; never touches attendance by itself. Always safe/fast to re-run —
// already-seen punches are skipped, so a repeat fetch only pays for what's
// actually new on the device.
async function fetchFromDevice(deviceId){
  try{
    toast('Fetching from device…');
    const res = await api(`/api/admin/device/${deviceId}/fetch`, { method:'POST' });
    if(deviceId === 'all'){
      const total = res.devices.reduce((s,d) => s + (d.newLogs||0), 0);
      toast(`Fetched from ${res.devices.length} device(s) — ${total} new punch(es).`, 'success');
    } else {
      toast(`Fetched — ${res.fetchedUsers} device users, ${res.newLogs} new punch(es).`, 'success');
    }
    await loadDeviceView();
  }catch(e){ toast(e.message, 'error'); }
}

async function loadPendingBanner(){
  try{
    const preview = await api('/api/admin/device/pending-preview');
    const card = document.getElementById('pending-apply-card');
    const text = document.getElementById('pending-apply-text');
    if(preview.totalPunches > 0){
      card.classList.remove('hidden');
      text.textContent = `${preview.totalPunches} pending punch(es) across ${preview.affectedDays.length} day(s), ready to apply`;
    } else {
      card.classList.add('hidden');
    }
  }catch(e){ /* non-fatal */ }
}

// Confirm dialog — shows exactly what applying pending punches would do
// before anything touches attendance.
async function openApplyPreviewModal(){
  try{
    const preview = await api('/api/admin/device/pending-preview');
    document.getElementById('apply-preview-sub').textContent = preview.totalPunches
      ? `${preview.totalPunches} punch(es) across ${preview.affectedDays.length} day(s) will be created or updated, with modality set to Office.`
      : 'Nothing pending right now.';
    const tbody = document.querySelector('#apply-preview-table tbody');
    tbody.innerHTML = preview.affectedDays.length ? preview.affectedDays.map(d => `
      <tr>
        <td class="mono">${fmtDate(d.date)}</td>
        <td>${d.employeeName}</td>
        <td>${d.punchCount}</td>
        <td class="mono">${d.currentCheckIn ? fmtTime12(d.currentCheckIn) : '—'} ${d.currentCheckOut ? '– ' + fmtTime12(d.currentCheckOut) : ''}</td>
        <td class="mono">${fmtTime12(d.newCheckIn)}${d.newCheckOut ? ' – ' + fmtTime12(d.newCheckOut) : ''} ${d.willCreate ? '<span class="badge badge-biometric">New</span>' : ''}</td>
      </tr>`).join('') : `<tr><td colspan="5" class="muted" style="text-align:center; padding:20px;">Nothing pending.</td></tr>`;
    document.getElementById('apply-preview-modal').classList.remove('hidden');
  }catch(e){ toast(e.message, 'error'); }
}
async function confirmApplyPending(){
  try{
    const res = await withBtnLoading(document.getElementById('apply-preview-confirm-btn'), () => api('/api/admin/device/apply', { method:'POST' }));
    closeModal('apply-preview-modal');
    toast(`Attendance updated — ${res.attendanceCreated} day(s) created, ${res.attendanceUpdated} updated.`, 'success');
    await loadDeviceView();
  }catch(e){ toast(e.message, 'error'); }
}

let DEV_USERS_PAGE = 1;
let DEV_USERS_SORT = { col: null, field: null, dir: 'asc' };
function sortDeviceUsers(colIndex, field){
  DEV_USERS_SORT = { col: colIndex, field, dir: (DEV_USERS_SORT.col === colIndex && DEV_USERS_SORT.dir === 'asc') ? 'desc' : 'asc' };
  loadDeviceUsers(1);
}
async function loadDeviceUsers(page){
  DEV_USERS_PAGE = page || 1;
  const { users } = await api('/api/admin/device/users');
  document.getElementById('dev-users-count').textContent = `${users.length} enrolled across all devices`;
  const options = (EMPLOYEES && EMPLOYEES.length ? EMPLOYEES : (await api('/api/admin/employees')).employees)
    .map(e => `<option value="${e.id}">${e.name} (${e.employeeId})</option>`).join('');
  const deviceName = (id) => (DEVICES_CACHE.find(d => d.id === id) || {}).name || id;

  let list = users.map(u => ({ ...u, deviceName: deviceName(u.deviceId) }));
  if(DEV_USERS_SORT.field){
    const dir = DEV_USERS_SORT.dir === 'asc' ? 1 : -1;
    const field = DEV_USERS_SORT.field;
    list = list.slice().sort((a, b) => {
      const av = String(a[field] ?? '').toLowerCase(), bv = String(b[field] ?? '').toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }
  document.querySelectorAll('#dev-users-table thead th').forEach((th, i) => {
    const ind = th.querySelector('.sort-ind');
    if(ind) ind.textContent = DEV_USERS_SORT.col === i ? (DEV_USERS_SORT.dir === 'asc' ? '▲' : '▼') : '';
  });

  const { items, page: curPage, pageSize, total } = paginateClientSide(list, DEV_USERS_PAGE, 25);
  DEV_USERS_PAGE = curPage;
  const tbody = document.querySelector('#dev-users-table tbody');
  tbody.innerHTML = items.length ? items.map(u => `
    <tr>
      <td>${u.deviceName}</td>
      <td class="mono">${u.uid}</td>
      <td>${u.name} <button class="btn btn-ghost btn-sm" style="padding:2px 8px; font-size:12px;" title="Rename on device" onclick="openRenameDeviceUserModal('${u.deviceId}', '${u.uid}', ${JSON.stringify(u.name).replace(/"/g, '&quot;')})">✎</button></td>
      <td class="mono">${u.card || '—'}</td>
      <td>
        <select class="select" style="min-width:180px;" onchange="mapDeviceUser('${u.deviceId}', '${u.uid}', this.value)">
          <option value="">— Unlinked —</option>
          ${options}
        </select>
      </td>
      <td>${u.employeeId ? '<span class="badge badge-biometric">Linked</span>' : '<span class="badge badge-pending">Needs linking</span>'}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="muted" style="text-align:center; padding:20px;">No device users yet — fetch from a device first.</td></tr>`;
  // pre-select currently-linked employee in each dropdown (indexed against
  // this page's slice, not the full list, now that only one page is rendered)
  items.forEach((u, i) => {
    const sel = tbody.querySelectorAll('select')[i];
    if(sel && u.employeeId) sel.value = u.employeeId;
  });
  renderPagination(document.getElementById('dev-users-pagination'), {
    page: curPage, pageSize, total, onPage: (p) => loadDeviceUsers(p)
  });
}

// Opens the shared device-user modal in "add" mode: creates a brand-new
// user shell directly on the device (name + optional card, no biometric
// template — that still has to be captured at the device itself, once,
// using the name/UID this creates).
function openAddDeviceUserModal(){
  if(!DEVICES_CACHE.length){ toast('Add a device first.', 'error'); return; }
  document.getElementById('device-user-modal-title').textContent = 'Add device user';
  document.getElementById('device-user-modal-sub').textContent = "Creates a name and UID on the device — they'll still need to enroll their fingerprint or face at the device itself.";
  document.getElementById('device-user-modal-device-id').value = '';
  document.getElementById('device-user-modal-uid').value = '';
  document.getElementById('device-user-modal-name').value = '';
  document.getElementById('device-user-modal-card').value = '';
  document.getElementById('device-user-modal-device-field').classList.remove('hidden');
  document.getElementById('device-user-modal-card-field').classList.remove('hidden');
  document.getElementById('device-user-modal-device-select').innerHTML =
    DEVICES_CACHE.map(d => `<option value="${d.id}">${d.name}</option>`).join('');
  const btn = document.getElementById('device-user-modal-save-btn');
  btn.textContent = 'Create user';
  btn.onclick = () => withBtnLoading(btn, saveNewDeviceUser);
  document.getElementById('device-user-modal').classList.remove('hidden');
}
async function saveNewDeviceUser(){
  const deviceId = document.getElementById('device-user-modal-device-select').value;
  const name = document.getElementById('device-user-modal-name').value.trim();
  const card = document.getElementById('device-user-modal-card').value.trim();
  if(!name){ toast('A name is required.', 'error'); return; }
  const res = await api(`/api/admin/device/${deviceId}/users`, { method:'POST', body: JSON.stringify({ name, card: card || undefined }) });
  closeModal('device-user-modal');
  toast(`Created — UID ${res.user.uid} on the device. They still need to enroll their fingerprint/face there.`, 'success');
  await loadDeviceUsers();
}

// Opens the same modal in "rename" mode: updates the name stored on the
// device itself (shown on its screen at punch time) — writes over the
// same connection used to fetch punches/users, not just a local label
// change. Biometric templates are untouched.
function openRenameDeviceUserModal(deviceId, uid, currentName){
  document.getElementById('device-user-modal-title').textContent = 'Rename device user';
  document.getElementById('device-user-modal-sub').textContent = 'Updates the name stored on the device itself — shown on its screen at punch time.';
  document.getElementById('device-user-modal-device-id').value = deviceId;
  document.getElementById('device-user-modal-uid').value = uid;
  document.getElementById('device-user-modal-name').value = currentName;
  document.getElementById('device-user-modal-device-field').classList.add('hidden');
  document.getElementById('device-user-modal-card-field').classList.add('hidden');
  const btn = document.getElementById('device-user-modal-save-btn');
  btn.textContent = 'Save name';
  btn.onclick = () => withBtnLoading(btn, saveRenameDeviceUser);
  document.getElementById('device-user-modal').classList.remove('hidden');
}
async function saveRenameDeviceUser(){
  const deviceId = document.getElementById('device-user-modal-device-id').value;
  const uid = document.getElementById('device-user-modal-uid').value;
  const name = document.getElementById('device-user-modal-name').value.trim();
  if(!name){ toast('A name is required.', 'error'); return; }
  await api(`/api/admin/device/${deviceId}/users/${uid}/name`, { method:'PATCH', body: JSON.stringify({ name }) });
  closeModal('device-user-modal');
  toast('Name updated on the device.', 'success');
  await loadDeviceUsers();
}

async function mapDeviceUser(deviceId, uid, employeeId){
  try{
    const res = await api(`/api/admin/device/${deviceId}/users/${uid}/map`, { method:'POST', body: JSON.stringify({ employeeId: employeeId || null }) });
    if (employeeId && res.backfilled > 0) {
      const bits = [];
      if (res.attendanceCreated) bits.push(`${res.attendanceCreated} day${res.attendanceCreated === 1 ? '' : 's'} created`);
      if (res.attendanceUpdated) bits.push(`${res.attendanceUpdated} updated`);
      toast(`Linked. Pulled in ${res.backfilled} earlier punch${res.backfilled === 1 ? '' : 'es'}${bits.length ? ' — ' + bits.join(', ') : ''}.`, 'success');
    } else {
      toast(employeeId ? 'Linked to staff member.' : 'Unlinked.', 'success');
    }
    await loadDeviceUsers();
  }catch(e){ toast(e.message, 'error'); }
}

let DEV_LOGS_PAGE = 1;
let DEV_LOGS_SORT = { field: 'timestamp', dir: 'desc' };
function sortDevLogs(field){
  DEV_LOGS_SORT = { field, dir: (DEV_LOGS_SORT.field === field && DEV_LOGS_SORT.dir === 'asc') ? 'desc' : 'asc' };
  loadDeviceLogs(1);
}
async function loadDeviceLogs(page){
  DEV_LOGS_PAGE = page || 1;
  const data = await api(`/api/admin/device/logs?page=${DEV_LOGS_PAGE}&pageSize=50&sortBy=${DEV_LOGS_SORT.field}&sortDir=${DEV_LOGS_SORT.dir}`);
  document.getElementById('dev-logs-count').textContent = `${data.total} punch(es) on file`;
  const deviceName = (id) => (DEVICES_CACHE.find(d => d.id === id) || {}).name || id;
  const tbody = document.querySelector('#dev-logs-table tbody');
  tbody.innerHTML = data.logs.length ? data.logs.map(l => `
    <tr>
      <td class="mono">${new Date(l.timestamp).toLocaleString()}</td>
      <td>${deviceName(l.deviceId)}</td>
      <td>UID ${l.uid}</td>
      <td>${l.employeeName || '<span class="muted">unlinked</span>'}</td>
      <td>${l.processed ? '<span class="badge badge-biometric">Yes</span>' : '<span class="badge badge-neutral">No</span>'}</td>
      <td>${l.employeeId ? `<button class="btn btn-ghost btn-sm" onclick="reprocessEmployeeDate('${l.employeeId}', '${l.timestamp.slice(0,10)}', this)">Update</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="muted" style="text-align:center; padding:20px;">No punches recorded yet.</td></tr>`;
  const fieldsByCol = ['timestamp', 'deviceName', 'uid', 'employeeName', 'processed', null];
  document.querySelectorAll('#dev-logs-table thead th').forEach((th, i) => {
    const ind = th.querySelector('.sort-ind');
    if(ind) ind.textContent = fieldsByCol[i] === DEV_LOGS_SORT.field ? (DEV_LOGS_SORT.dir === 'asc' ? '▲' : '▼') : '';
  });
  renderPagination(document.getElementById('dev-logs-pagination'), {
    page: data.page, pageSize: data.pageSize, total: data.total, onPage: (p) => loadDeviceLogs(p)
  });
}

// "Update" button — re-reads every biometric punch on file for this
// employee+date (already-applied or not) and recomputes that day's
// check-in/check-out from scratch. For a day that looks wrong, or to pick
// up punches that arrived after the day was first applied.
async function reprocessEmployeeDate(employeeId, date, btn){
  try{
    const res = await withBtnLoading(btn, () => api('/api/admin/device/reprocess', { method:'POST', body: JSON.stringify({ employeeId, date }) }));
    toast(`Updated ${fmtDate(date)} from ${res.punchCount} punch(es).`, 'success');
    await loadDeviceLogs();
  }catch(e){ toast(e.message, 'error'); }
}

async function loadDeviceSyncLogs(){
  const { syncLogs } = await api('/api/admin/device/sync-logs');
  const tbody = document.querySelector('#dev-sync-log-table tbody');
  tbody.innerHTML = syncLogs.length ? syncLogs.map(s => `
    <tr>
      <td class="mono">${new Date(s.started_at).toLocaleString()}</td>
      <td>${s.stage === 'apply' ? '<span class="badge badge-neutral">Apply</span>' : '<span class="badge badge-neutral">Fetch</span>'}</td>
      <td>${s.status === 'success' ? '<span class="badge badge-approved">Success</span>' : `<span class="badge badge-rejected" title="${s.error_message||''}">Failed</span>`}</td>
      <td>${s.fetched_users || '—'}</td>
      <td>${s.new_logs || '—'}</td>
      <td>${s.attendance_created || s.attendance_updated ? `${s.attendance_created} / ${s.attendance_updated}` : '—'}</td>
      <td>${s.triggered_by || '—'}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="muted" style="text-align:center; padding:20px;">No sync runs yet.</td></tr>`;
}

// ---------------- Automatic sync (Company tab) ----------------
async function loadAutoSyncSettings(){
  try{
    const data = await api('/api/settings');
    document.getElementById('auto-sync-enabled').checked = !!data.autoSyncEnabled;
    document.getElementById('auto-sync-time').value = data.autoSyncTime || '08:00';
  }catch(e){ /* non-fatal */ }
}
async function saveAutoSync(){
  const autoSyncEnabled = document.getElementById('auto-sync-enabled').checked;
  const autoSyncTime = document.getElementById('auto-sync-time').value || '08:00';
  try{
    await api('/api/settings', { method:'PATCH', body: JSON.stringify({ autoSyncEnabled, autoSyncTime }) });
    toast(autoSyncEnabled ? `Automatic sync enabled — runs daily at ${autoSyncTime}.` : 'Automatic sync disabled.', 'success');
  }catch(e){ toast(e.message, 'error'); }
}
