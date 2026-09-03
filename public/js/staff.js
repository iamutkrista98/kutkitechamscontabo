// staff.js — logic for the employee dashboard
let ME = null;
let TODAY_RECORD = null;
let charts = {};

function toggleSidebar(open){
  document.getElementById('sidebar').classList.toggle('open', open);
  document.getElementById('scrim').classList.toggle('show', open);
}

let TEAM_TAB = 'early';

function showView(view, opts={}){
  document.querySelectorAll('[id^="view-"]').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + view).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  const titles = {
    dashboard:['Dashboard','Welcome back — here\'s your day at a glance'],
    report:['Monthly Report','Your evaluated attendance performance'],
    requests:['Early Checkouts','Track your requests and HR decisions'],
    leave:['Leave Requests','Request leave and track approval'],
    corrections:['Fix Attendance','Request a fix for a missed check-in or check-out'],
    team:['Team Approvals','Review requests from people who report to you'],
    profile:['My Profile','Your staff record on file']
  };
  document.getElementById('page-title').textContent = titles[view][0];
  document.getElementById('page-sub').textContent = titles[view][1];
  toggleSidebar(false);
  if(opts.skipLoad) return;
  if(view === 'dashboard'){ loadRecent(); if(ME && ME.isManager) refreshTeamBadge(); }
  if(view === 'report') loadReport();
  if(view === 'requests') loadEarlyView();
  if(view === 'leave') loadLeaveView();
  if(view === 'corrections') loadCorrectionsView();
  if(view === 'team') loadTeam();
}

async function signOut(){
  await api('/api/auth/staff/logout', { method:'POST' });
  window.location.href = '/index.html';
}

function tickClock(){
  const d = new Date();
  document.getElementById('live-clock').textContent = d.toLocaleTimeString('en-GB');
  document.getElementById('live-date').textContent = fmtDateLong();
}

function renderDial(){
  const btnIn = document.getElementById('btn-checkin');
  const btnOut = document.getElementById('btn-checkout');
  const timeEl = document.getElementById('dial-status-time');
  const labelEl = document.getElementById('dial-status-label');

  if(!TODAY_RECORD){
    timeEl.textContent = '--:--';
    labelEl.textContent = 'Not checked in';
    btnIn.disabled = false; btnOut.disabled = true;
  } else if(TODAY_RECORD.checkIn && !TODAY_RECORD.checkOut){
    timeEl.textContent = fmtTime12(TODAY_RECORD.checkIn);
    labelEl.textContent = 'Checked in';
    btnIn.disabled = true; btnOut.disabled = false;
  } else if(TODAY_RECORD.checkOut){
    timeEl.textContent = fmtTime12(TODAY_RECORD.checkOut);
    labelEl.textContent = 'Checked out';
    btnIn.disabled = true; btnOut.disabled = true;
  }
}

async function checkIn(){
  const btn = document.getElementById('btn-checkin');
  btn.disabled = true; btn.textContent = 'Locating…';
  try{
    const loc = await getGeolocation();
    btn.textContent = 'Check In';
    const data = await api('/api/attendance/check-in', { method:'POST', body: JSON.stringify(loc || {}) });
    TODAY_RECORD = data.record;
    renderDial();
    toast(loc ? 'Checked in successfully — have a great day!' : 'Checked in — location wasn\'t shared.', 'success');
    loadRecent();
  }catch(err){ btn.textContent = 'Check In'; btn.disabled = false; toast(err.message, 'error'); }
}

async function checkOut(){
  const btn = document.getElementById('btn-checkout');
  btn.disabled = true;
  try{
    const loc = await getGeolocation();
    const res = await fetch('/api/attendance/check-out', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(loc || {}) });
    const data = await res.json();
    if(res.status === 409 && data.earlyCheckoutRequired){
      btn.disabled = false;
      document.getElementById('early-modal-sub').textContent = data.message;
      document.getElementById('early-modal').classList.remove('hidden');
      return;
    }
    if(!res.ok){ throw new Error(data.error || 'Could not check out.'); }
    TODAY_RECORD = data.record;
    renderDial();
    toast('Checked out — see you tomorrow!', 'success');
    loadRecent();
  }catch(err){ btn.disabled = false; toast(err.message, 'error'); }
}

function closeEarlyModal(){
  document.getElementById('early-modal').classList.add('hidden');
  document.getElementById('early-reason').value = '';
}

async function submitEarlyCheckout(){
  const reason = document.getElementById('early-reason').value.trim();
  if(!reason){ toast('Please enter a reason.', 'error'); return; }
  const ok = await confirmDialog({
    title: 'Check out early?',
    message: 'This will check you out now and submit an early-checkout request for approval. Continue?',
    confirmLabel: 'Check Out'
  });
  if(!ok) return;
  try{
    const loc = await getGeolocation();
    const data = await api('/api/attendance/early-checkout', { method:'POST', body: JSON.stringify({reason, ...(loc||{})}) });
    TODAY_RECORD = data.record;
    renderDial();
    closeEarlyModal();
    toast('Submitted to HR for approval.', 'success');
    loadRecent();
  }catch(err){ toast(err.message, 'error'); }
}

async function loadRecent(){
  const data = await api('/api/attendance/my-report');
  document.getElementById('kpi-present').textContent = data.present;
  document.getElementById('kpi-late').textContent = data.late;
  document.getElementById('kpi-hours').textContent = data.avgHours.toFixed(1) + 'h';
  document.getElementById('kpi-rate').textContent = data.attendanceRate + '%';

  const last10 = data.records.slice(-10);
  const tbody = document.querySelector('#recent-table tbody');
  tbody.innerHTML = last10.length ? last10.map(r => `
    <tr>
      <td class="mono" data-sort="${r.date}">${r.miti || '—'}</td>
      <td class="muted" style="font-size:12px;" data-sort="${r.date}">${fmtDate(r.date)}</td>
      <td class="mono" data-sort="${r.checkIn || ''}">${fmtTime12(r.checkIn)}</td>
      <td class="mono" data-sort="${r.checkOut || ''}">${fmtTime12(r.checkOut)}</td>
      <td data-sort="${r.hoursWorked || 0}">${r.hoursWorked ? r.hoursWorked + 'h' : '—'}</td>
      <td>${modalityBadge(r.workingModality)}</td>
      <td data-sort="${r.earlyCheckout ? 'early_pending' : (r.status||'')}">${statusBadge(r.earlyCheckout ? 'early_pending' : r.status)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="muted" style="text-align:center; padding:30px;">No attendance recorded yet this month.</td></tr>`;
}

// Populates the "My report / [colleague]" dropdown above the monthly
// report. Only shows up (and only lists someone) if the signed-in staff
// member has been granted "view all staff reports" or has direct reports
// as a manager — the API already enforces this, this just hides the
// control when the list comes back empty.
async function loadViewableStaff(){
  const select = document.getElementById('report-staff-select');
  try{
    const data = await api('/api/attendance/viewable-staff');
    const staff = data.staff || [];
    if(!staff.length){ select.classList.add('hidden'); return; }
    select.innerHTML = '<option value="">My report</option>' +
      staff.map(s => `<option value="${s.id}">${s.name} · ${s.employeeId}</option>`).join('');
    select.classList.remove('hidden');
  }catch(e){ select.classList.add('hidden'); }
}

let REPORT_BS_INITED = false;
async function loadReport(){
  const monthSel = document.getElementById('report-bs-month');
  const yearSel = document.getElementById('report-bs-year');
  const staffId = document.getElementById('report-staff-select').value;

  // First load: we don't know "today" in BS on the client (no BS math is
  // duplicated client-side), so ask without a year/month — the server
  // defaults to the current BS month and tells us what that is, and we
  // use that to populate the pickers from then on.
  let data, bsYear, bsMonth;
  if(!REPORT_BS_INITED){
    const first = staffId
      ? (await api('/api/attendance/staff-report/' + staffId)).report
      : await api('/api/attendance/my-report');
    populateBsPickers(monthSel, yearSel, first.bsYear, first.bsYear, first.bsMonth);
    REPORT_BS_INITED = true;
    data = first; bsYear = first.bsYear; bsMonth = first.bsMonth;
  } else {
    bsYear = yearSel.value; bsMonth = monthSel.value;
    const qs = `?bsYear=${bsYear}&bsMonth=${bsMonth}`;
    data = staffId
      ? (await api('/api/attendance/staff-report/' + staffId + qs)).report
      : await api('/api/attendance/my-report' + qs);
  }

  document.getElementById('report-month-label').textContent = (data.bsMonthLabel || `${BS_MONTH_NAMES[bsMonth-1]} ${bsYear}`) + ' BS' + (data.fiscalYear ? ` · FY ${data.fiscalYear.label}` : '');
  const selectedOpt = document.getElementById('report-staff-select').selectedOptions[0];
  document.querySelector('#view-report .sub').textContent = staffId && selectedOpt
    ? `Evaluated performance for ${selectedOpt.textContent.split(' · ')[0]}`
    : 'Your evaluated performance for the Miti (BS) month selected';
  document.getElementById('rep-working').textContent = data.workingDays;
  document.getElementById('rep-onleave').textContent = data.onLeave;
  document.getElementById('rep-absent').textContent = data.absent;
  document.getElementById('rep-hours').textContent = data.totalHours + 'h';
  document.getElementById('rep-early').textContent = data.earlyOuts;

  setRing('ring-attendance', data.attendanceRate);
  setRing('ring-punctuality', data.punctualityRate);

  const tbody = document.querySelector('#report-table tbody');
  tbody.innerHTML = data.records.length ? data.records.map(r => `
    <tr>
      <td class="mono" data-sort="${r.date}">${r.miti || '—'}</td>
      <td class="muted" style="font-size:12px;" data-sort="${r.date}">${fmtDate(r.date)}</td>
      <td class="mono" data-sort="${r.checkIn || ''}">${fmtTime12(r.checkIn)}</td>
      <td class="mono" data-sort="${r.checkOut || ''}">${fmtTime12(r.checkOut)}</td>
      <td data-sort="${r.hoursWorked || 0}">${r.hoursWorked ? r.hoursWorked + 'h' : '—'}</td>
      <td>${modalityBadge(r.workingModality)}</td>
      <td data-sort="${r.status||''}">${statusBadge(r.status)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="muted" style="text-align:center; padding:30px;">No records for this Miti month.</td></tr>`;

  renderHoursChart(data.records);
  renderMixChart(data);
}

function exportMyReport(format){
  const bsYear = document.getElementById('report-bs-year').value;
  const bsMonth = document.getElementById('report-bs-month').value;
  const staffId = document.getElementById('report-staff-select').value;
  toast(`Preparing the ${format.toUpperCase()} report…`);
  window.location.href = `/api/attendance/my-report/export/${format}?bsYear=${bsYear}&bsMonth=${bsMonth}` + (staffId ? `&staffId=${staffId}` : '');
}

function setRing(id, pct){
  const circle = document.getElementById(id);
  const r = 44, circumference = 2 * Math.PI * r;
  circle.style.strokeDasharray = circumference;
  circle.style.strokeDashoffset = circumference - (pct/100) * circumference;
  document.getElementById(id + '-pct').textContent = pct + '%';
}

function renderHoursChart(records){
  const ctx = document.getElementById('chart-hours');
  if(charts.hours) charts.hours.destroy();
  charts.hours = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: records.map(r => r.date.slice(8,10)),
      datasets: [{
        label: 'Hours worked',
        data: records.map(r => r.hoursWorked || 0),
        backgroundColor: '#2E4A93',
        borderRadius: 5,
        maxBarThickness: 22
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display:false } },
      scales: {
        x: { grid: { display:false }, ticks: { font: { size: 10 } } },
        y: { grid: { color:'#EAEDF3' }, beginAtZero:true }
      }
    }
  });
}

function renderMixChart(data){
  const ctx = document.getElementById('chart-mix');
  if(charts.mix) charts.mix.destroy();
  charts.mix = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['On time','Late','Absent'],
      datasets: [{
        data: [data.present, data.late, data.absent],
        backgroundColor: ['#2F8F5B', '#C2841F', '#C0463A'],
        borderWidth: 0
      }]
    },
    options: {
      responsive:true,
      cutout: '68%',
      plugins: { legend: { position:'bottom', labels: { boxWidth:10, font:{size:11.5} } } }
    }
  });
}

let TODAY_BS = null;
async function currentBsForPickers(){
  if(TODAY_BS) return TODAY_BS;
  try{
    const data = await api('/api/attendance/today');
    TODAY_BS = data.todayBs;
    return TODAY_BS;
  }catch(e){ return null; }
}

let EARLY_PICKERS_INITED = false;
function earlyFilterParams(){
  const params = new URLSearchParams();
  const fm = document.getElementById('early-from-month').value, fy = document.getElementById('early-from-year').value;
  const tm = document.getElementById('early-to-month').value, ty = document.getElementById('early-to-year').value;
  if(fm && fy){ params.set('bsFromMonth', fm); params.set('bsFromYear', fy); }
  if(tm && ty){ params.set('bsToMonth', tm); params.set('bsToYear', ty); }
  const status = document.getElementById('early-status').value;
  if(status) params.set('status', status);
  return params;
}
function clearEarlyFilter(){
  ['early-from-month','early-from-year','early-to-month','early-to-year','early-status'].forEach(id => document.getElementById(id).value = '');
  loadEarly();
}
async function loadEarlyView(){
  if(!EARLY_PICKERS_INITED){
    const bs = await currentBsForPickers();
    if(bs){
      populateBsPickers(document.getElementById('early-from-month'), document.getElementById('early-from-year'), bs.year);
      populateBsPickers(document.getElementById('early-to-month'), document.getElementById('early-to-year'), bs.year);
      ['early-from-month','early-from-year','early-to-month','early-to-year'].forEach(id => {
        const el = document.getElementById(id);
        el.insertAdjacentHTML('afterbegin', '<option value="">Any</option>');
        el.value = '';
      });
    }
    EARLY_PICKERS_INITED = true;
  }
  loadEarly();
}
async function loadEarly(){
  const data = await api('/api/attendance/my-requests?' + earlyFilterParams().toString());
  const tbody = document.querySelector('#requests-table tbody');
  tbody.innerHTML = data.requests.length ? data.requests.map(r => `
    <tr>
      <td data-sort="${r.date}">${fmtDate(r.date)}</td>
      <td class="mono" data-sort="${r.requestedTime || ''}">${fmtTime12(r.requestedTime)}</td>
      <td>${r.reason}</td>
      <td data-sort="${r.managerDecision||''}">${statusBadge(r.managerDecision)}</td>
      <td data-sort="${r.adminDecision||''}">${statusBadge(r.adminDecision)}</td>
      <td data-sort="${r.status||''}">${statusBadge(r.status)}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="muted" style="text-align:center; padding:30px;">No early checkout requests match these filters.</td></tr>`;
}

document.getElementById('report-bs-month').addEventListener('change', loadReport);
document.getElementById('report-bs-year').addEventListener('change', loadReport);
document.getElementById('report-staff-select').addEventListener('change', loadReport);

// ---------------- Leave requests ----------------
let LEAVE_BALANCES = null;
async function updateLeaveBalanceHint(){
  const hint = document.getElementById('leave-balance-hint');
  const type = document.getElementById('leave-type').value;
  if(!LEAVE_BALANCES){
    try{ LEAVE_BALANCES = (await api('/api/attendance/leave-balances')).balances; }catch(e){ hint.textContent = ''; return; }
  }
  const b = LEAVE_BALANCES[type];
  hint.textContent = b ? `${b.remaining} of ${b.assigned} day(s) remaining this year.` : 'No fixed balance for this leave type — reviewed case by case.';
}
function openLeaveModal(){
  document.getElementById('leave-modal').classList.remove('hidden');
  updateLeaveBalanceHint();
}
function closeLeaveModal(){
  document.getElementById('leave-modal').classList.add('hidden');
  document.getElementById('leave-from').value = '';
  document.getElementById('leave-to').value = '';
  document.getElementById('leave-reason').value = '';
}
async function submitLeaveRequest(){
  const leaveType = document.getElementById('leave-type').value;
  const fromDate = document.getElementById('leave-from').value;
  const toDate = document.getElementById('leave-to').value;
  const reason = document.getElementById('leave-reason').value.trim();
  if(!fromDate || !toDate){ toast('Pick both a from and to date.', 'error'); return; }
  if(!reason){ toast('Please enter a reason.', 'error'); return; }
  const ok = await confirmDialog({
    title: 'Submit leave request?',
    message: `Submit a ${leaveType} request for ${fromDate} to ${toDate}?`,
    confirmLabel: 'Submit Request'
  });
  if(!ok) return;
  try{
    await api('/api/attendance/leave-request', { method:'POST', body: JSON.stringify({ leaveType, fromDate, toDate, reason }) });
    closeLeaveModal();
    toast('Leave request submitted.', 'success');
    LEAVE_BALANCES = null;
    loadLeave();
  }catch(err){ toast(err.message, 'error'); }
}
let LEAVE_PICKERS_INITED = false;
function leaveFilterParams(){
  const params = new URLSearchParams();
  const fm = document.getElementById('leave-from-month').value, fy = document.getElementById('leave-from-year').value;
  const tm = document.getElementById('leave-to-month').value, ty = document.getElementById('leave-to-year').value;
  if(fm && fy){ params.set('bsFromMonth', fm); params.set('bsFromYear', fy); }
  if(tm && ty){ params.set('bsToMonth', tm); params.set('bsToYear', ty); }
  const status = document.getElementById('leave-status').value;
  if(status) params.set('status', status);
  return params;
}
function clearLeaveFilter(){
  ['leave-from-month','leave-from-year','leave-to-month','leave-to-year','leave-status'].forEach(id => document.getElementById(id).value = '');
  loadLeave();
}
async function loadLeaveView(){
  if(!LEAVE_PICKERS_INITED){
    const bs = await currentBsForPickers();
    if(bs){
      populateBsPickers(document.getElementById('leave-from-month'), document.getElementById('leave-from-year'), bs.year);
      populateBsPickers(document.getElementById('leave-to-month'), document.getElementById('leave-to-year'), bs.year);
      ['leave-from-month','leave-from-year','leave-to-month','leave-to-year'].forEach(id => {
        const el = document.getElementById(id);
        el.insertAdjacentHTML('afterbegin', '<option value="">Any</option>');
        el.value = '';
      });
    }
    LEAVE_PICKERS_INITED = true;
  }
  loadLeave();
}
async function loadLeave(){
  const data = await api('/api/attendance/my-leave-requests?' + leaveFilterParams().toString());
  const tbody = document.querySelector('#leave-table tbody');
  tbody.innerHTML = data.requests.length ? data.requests.map(r => `
    <tr>
      <td data-sort="${r.leaveType||''}">${r.leaveType}</td>
      <td class="mono">${r.fromMiti && r.toMiti ? (r.fromMiti === r.toMiti ? r.fromMiti : `${r.fromMiti} – ${r.toMiti}`) : '—'}</td>
      <td class="muted" style="font-size:12px;" data-sort="${r.fromDate||''}">${fmtDate(r.fromDate)}</td>
      <td class="muted" style="font-size:12px;" data-sort="${r.toDate||''}">${fmtDate(r.toDate)}</td>
      <td>${r.reason}</td>
      <td data-sort="${r.managerDecision||''}">${statusBadge(r.managerDecision)}</td>
      <td data-sort="${r.adminDecision||''}">${statusBadge(r.adminDecision)}</td>
      <td data-sort="${r.status||''}">${statusBadge(r.status)}</td>
    </tr>`).join('') : `<tr><td colspan="8" class="muted" style="text-align:center; padding:30px;">No leave requests match these filters.</td></tr>`;
}

// ---------------- Correction requests (fix a missed check-in/out) ----------------
function openCorrectionModal(){
  const today = new Date().toISOString().slice(0,10);
  document.getElementById('cor-date').max = today;
  document.getElementById('correction-modal').classList.remove('hidden');
}
function closeCorrectionModal(){
  document.getElementById('correction-modal').classList.add('hidden');
  document.getElementById('cor-date').value = '';
  document.getElementById('cor-checkin').value = '';
  document.getElementById('cor-checkout').value = '';
  document.getElementById('cor-reason').value = '';
}
async function submitCorrectionRequest(){
  const date = document.getElementById('cor-date').value;
  const requestedCheckIn = document.getElementById('cor-checkin').value;
  const requestedCheckOut = document.getElementById('cor-checkout').value;
  const reason = document.getElementById('cor-reason').value.trim();
  if(!date){ toast('Pick the date you need to fix.', 'error'); return; }
  if(!requestedCheckIn && !requestedCheckOut){ toast('Enter a check-in or check-out time.', 'error'); return; }
  if(!reason){ toast('Please enter a reason.', 'error'); return; }
  const ok = await confirmDialog({
    title: 'Submit correction request?',
    message: 'Submit this attendance correction request?',
    confirmLabel: 'Submit Request'
  });
  if(!ok) return;
  try{
    await api('/api/attendance/correction-request', { method:'POST', body: JSON.stringify({ date, requestedCheckIn, requestedCheckOut, reason }) });
    closeCorrectionModal();
    toast('Correction request submitted.', 'success');
    loadCorrections();
  }catch(err){ toast(err.message, 'error'); }
}
let COR_PICKERS_INITED = false;
function corFilterParams(){
  const params = new URLSearchParams();
  const fm = document.getElementById('cor-from-month').value, fy = document.getElementById('cor-from-year').value;
  const tm = document.getElementById('cor-to-month').value, ty = document.getElementById('cor-to-year').value;
  if(fm && fy){ params.set('bsFromMonth', fm); params.set('bsFromYear', fy); }
  if(tm && ty){ params.set('bsToMonth', tm); params.set('bsToYear', ty); }
  const status = document.getElementById('cor-status').value;
  if(status) params.set('status', status);
  return params;
}
function clearCorrectionsFilter(){
  ['cor-from-month','cor-from-year','cor-to-month','cor-to-year','cor-status'].forEach(id => document.getElementById(id).value = '');
  loadCorrections();
}
async function loadCorrectionsView(){
  if(!COR_PICKERS_INITED){
    const bs = await currentBsForPickers();
    if(bs){
      populateBsPickers(document.getElementById('cor-from-month'), document.getElementById('cor-from-year'), bs.year);
      populateBsPickers(document.getElementById('cor-to-month'), document.getElementById('cor-to-year'), bs.year);
      ['cor-from-month','cor-from-year','cor-to-month','cor-to-year'].forEach(id => {
        const el = document.getElementById(id);
        el.insertAdjacentHTML('afterbegin', '<option value="">Any</option>');
        el.value = '';
      });
    }
    COR_PICKERS_INITED = true;
  }
  loadCorrections();
}
async function loadCorrections(){
  const data = await api('/api/attendance/my-corrections?' + corFilterParams().toString());
  const tbody = document.querySelector('#corrections-table tbody');
  tbody.innerHTML = data.corrections.length ? data.corrections.map(c => `
    <tr>
      <td class="mono" data-sort="${c.date}">${c.miti || '—'}</td>
      <td class="muted" style="font-size:12px;" data-sort="${c.date}">${fmtDate(c.date)}</td>
      <td class="mono">${c.requestedCheckIn ? fmtTime12(c.requestedCheckIn) : '—'}</td>
      <td class="mono">${c.requestedCheckOut ? fmtTime12(c.requestedCheckOut) : '—'}</td>
      <td>${c.reason}</td>
      <td data-sort="${c.managerDecision||''}">${statusBadge(c.managerDecision)}</td>
      <td data-sort="${c.adminDecision||''}">${statusBadge(c.adminDecision)}</td>
      <td data-sort="${c.status||''}">${statusBadge(c.status)}</td>
    </tr>`).join('') : `<tr><td colspan="8" class="muted" style="text-align:center; padding:30px;">No correction requests match these filters.</td></tr>`;
}

// ---------------- Team approvals (managers only) ----------------
function switchTeamTab(type){
  TEAM_TAB = type;
  document.getElementById('team-tab-early').classList.toggle('active', type === 'early');
  document.getElementById('team-tab-leave').classList.toggle('active', type === 'leave');
  document.getElementById('team-tab-correction').classList.toggle('active', type === 'correction');
  document.getElementById('team-title').textContent =
    type === 'early' ? 'Early checkout requests from your team' :
    type === 'leave' ? 'Leave requests from your team' :
    'Attendance fix requests from your team';
  renderTeamTable();
}
let TEAM_DATA = { early: [], leave: [], corrections: [] };
async function loadTeam(){
  TEAM_DATA = await api('/api/manager/requests');
  renderTeamTable();
}
let PENDING_TEAM_TYPE = 'early';
async function refreshTeamBadge(){
  try{
    const data = await api('/api/manager/requests?status=pending');
    const earlyCount = (data.early || []).filter(r => r.managerDecision === 'pending').length;
    const leaveCount = (data.leave || []).filter(r => r.managerDecision === 'pending').length;
    const corrCount = (data.corrections || []).filter(r => r.managerDecision === 'pending').length;
    const count = earlyCount + leaveCount + corrCount;
    PENDING_TEAM_TYPE = earlyCount > 0 ? 'early' : leaveCount > 0 ? 'leave' : corrCount > 0 ? 'correction' : PENDING_TEAM_TYPE;
    const badge = document.getElementById('team-badge');
    if(count > 0){ badge.textContent = count; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }

    const attentionCard = document.getElementById('attention-card');
    if(attentionCard){
      if(ME && ME.isManager && count > 0){
        document.getElementById('attention-text').textContent =
          `${count} request${count === 1 ? '' : 's'} from your team ${count === 1 ? 'is' : 'are'} waiting on your decision.`;
        attentionCard.classList.remove('hidden');
      } else {
        attentionCard.classList.add('hidden');
      }
    }
  }catch(err){ /* non-fatal */ }
}
// Deep-link from the dashboard's "Needs your attention" widget straight to
// whichever request type actually has something pending, with fresh data
// already loaded — avoids landing on an empty "Early Checkouts" tab when
// the real pending item is a Leave or Fix request.
async function reviewTeamRequests(){
  showView('team', { skipLoad: true });
  await loadTeam();
  switchTeamTab(PENDING_TEAM_TYPE);
}
function renderTeamTable(){
  const thead = document.getElementById('team-thead');
  const tbody = document.querySelector('#team-table tbody');
  if(TEAM_TAB === 'early'){
    thead.innerHTML = `<tr>
      <th class="sortable" onclick="sortTable('team-table',0)">Employee <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',1)">Miti <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',2)">Date (AD) <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',3)">Departed <span class="sort-ind"></span></th>
      <th>Reason</th>
      <th class="sortable" onclick="sortTable('team-table',5)">HR decision <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',6)">Your decision <span class="sort-ind"></span></th>
      <th>Action</th>
    </tr>`;
    const rows = TEAM_DATA.early || [];
    tbody.innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td data-sort="${(r.employeeName||'').toLowerCase()}">${r.employeeName}</td>
        <td class="mono" data-sort="${r.date}">${r.miti || '—'}</td>
        <td class="muted" style="font-size:12px;" data-sort="${r.date}">${fmtDate(r.date)}</td>
        <td class="mono" data-sort="${r.requestedTime || ''}">${fmtTime12(r.requestedTime)}</td>
        <td>${r.reason}</td>
        <td data-sort="${r.adminDecision||''}">${statusBadge(r.adminDecision)}</td>
        <td data-sort="${r.managerDecision||''}">${statusBadge(r.managerDecision)}</td>
        <td>${teamActionCell(r, 'early')}</td>
      </tr>`).join('') : `<tr><td colspan="8" class="muted" style="text-align:center; padding:30px;">No early checkout requests from your team.</td></tr>`;
  } else if(TEAM_TAB === 'leave'){
    thead.innerHTML = `<tr>
      <th class="sortable" onclick="sortTable('team-table',0)">Employee <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',1)">Type <span class="sort-ind"></span></th>
      <th>Miti (From – To)</th>
      <th class="sortable" onclick="sortTable('team-table',3)">From (AD) <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',4)">To (AD) <span class="sort-ind"></span></th>
      <th>Reason</th>
      <th class="sortable" onclick="sortTable('team-table',6)">HR decision <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',7)">Your decision <span class="sort-ind"></span></th>
      <th>Action</th>
    </tr>`;
    const rows = TEAM_DATA.leave || [];
    tbody.innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td data-sort="${(r.employeeName||'').toLowerCase()}">${r.employeeName}</td>
        <td data-sort="${r.leaveType||''}">${r.leaveType}</td>
        <td class="mono">${r.fromMiti && r.toMiti ? (r.fromMiti === r.toMiti ? r.fromMiti : `${r.fromMiti} – ${r.toMiti}`) : '—'}</td>
        <td class="muted" style="font-size:12px;" data-sort="${r.fromDate||''}">${fmtDate(r.fromDate)}</td>
        <td class="muted" style="font-size:12px;" data-sort="${r.toDate||''}">${fmtDate(r.toDate)}</td>
        <td>${r.reason}</td>
        <td data-sort="${r.adminDecision||''}">${statusBadge(r.adminDecision)}</td>
        <td data-sort="${r.managerDecision||''}">${statusBadge(r.managerDecision)}</td>
        <td>${teamActionCell(r, 'leave')}</td>
      </tr>`).join('') : `<tr><td colspan="9" class="muted" style="text-align:center; padding:30px;">No leave requests from your team.</td></tr>`;
  } else {
    thead.innerHTML = `<tr>
      <th class="sortable" onclick="sortTable('team-table',0)">Employee <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',1)">Miti <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',2)">Date (AD) <span class="sort-ind"></span></th>
      <th>Requested In</th>
      <th>Requested Out</th>
      <th>Reason</th>
      <th class="sortable" onclick="sortTable('team-table',6)">HR decision <span class="sort-ind"></span></th>
      <th class="sortable" onclick="sortTable('team-table',7)">Your decision <span class="sort-ind"></span></th>
      <th>Action</th>
    </tr>`;
    const rows = TEAM_DATA.corrections || [];
    tbody.innerHTML = rows.length ? rows.map(r => `
      <tr>
        <td data-sort="${(r.employeeName||'').toLowerCase()}">${r.employeeName}</td>
        <td class="mono" data-sort="${r.date}">${r.miti || '—'}</td>
        <td class="muted" style="font-size:12px;" data-sort="${r.date}">${fmtDate(r.date)}</td>
        <td class="mono">${r.requestedCheckIn ? fmtTime12(r.requestedCheckIn) : '—'}</td>
        <td class="mono">${r.requestedCheckOut ? fmtTime12(r.requestedCheckOut) : '—'}</td>
        <td>${r.reason}</td>
        <td data-sort="${r.adminDecision||''}">${statusBadge(r.adminDecision)}</td>
        <td data-sort="${r.managerDecision||''}">${statusBadge(r.managerDecision)}</td>
        <td>${teamActionCell(r, 'correction')}</td>
      </tr>`).join('') : `<tr><td colspan="9" class="muted" style="text-align:center; padding:30px;">No fix requests from your team.</td></tr>`;
  }
}
function teamActionCell(r, type){
  if(r.managerDecision !== 'pending') return '<span class="muted" style="font-size:12px;">Decided</span>';
  return `
    <button class="btn btn-sm btn-primary" onclick="decideTeamRequest('${r.id}','${type}','approved')">Approve</button>
    <button class="btn btn-sm btn-ghost" onclick="decideTeamRequest('${r.id}','${type}','rejected')">Decline</button>`;
}
async function decideTeamRequest(id, type, decision){
  const verb = decision === 'approved' ? 'approve' : 'decline';
  const ok = await confirmDialog({
    title: `${verb === 'approve' ? 'Approve' : 'Decline'} this request?`,
    message: `Are you sure you want to ${verb} this ${type} request?`,
    confirmLabel: verb === 'approve' ? 'Approve' : 'Decline',
    danger: verb === 'decline'
  });
  if(!ok) return;
  try{
    await api(`/api/manager/requests/${id}/decide`, { method:'POST', body: JSON.stringify({ type, decision }) });
    toast(decision === 'approved' ? 'Approved.' : 'Declined.', 'success');
    loadTeam();
    refreshTeamBadge();
  }catch(err){ toast(err.message, 'error'); }
}

// ---------------- Account: profile photo + password ----------------
async function onAvatarFileChosen(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const formData = new FormData();
  formData.append('image', file);
  try{
    const res = await fetch('/api/auth/staff/profile-image', { method:'POST', body: formData });
    const data = await res.json();
    if(!res.ok){ throw new Error(data.error || 'Could not upload photo.'); }
    ME = data.employee;
    applyAvatar(document.getElementById('sb-avatar'), ME);
    applyAvatar(document.getElementById('profile-avatar'), ME);
    document.getElementById('remove-photo-btn').classList.toggle('hidden', !ME.avatarImage);
    toast('Profile photo updated.', 'success');
  }catch(err){ toast(err.message, 'error'); }
  input.value = '';
}

async function removeMyAvatar(){
  const ok = await confirmDialog({ title: 'Remove your photo?', message: 'Your avatar will fall back to your initials.', confirmLabel: 'Remove' });
  if(!ok) return;
  try{
    const data = await api('/api/auth/staff/profile-image', { method:'DELETE' });
    ME = data.employee;
    applyAvatar(document.getElementById('sb-avatar'), ME);
    applyAvatar(document.getElementById('profile-avatar'), ME);
    document.getElementById('remove-photo-btn').classList.add('hidden');
    toast('Profile photo removed.', 'success');
  }catch(err){ toast(err.message, 'error'); }
}

async function changeMyPassword(){
  const currentPassword = document.getElementById('pw-current').value;
  const newPassword = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;
  if(!currentPassword || !newPassword){ toast('Fill in both password fields.', 'error'); return; }
  if(newPassword.length < 8){ toast('New password must be at least 8 characters.', 'error'); return; }
  if(newPassword !== confirm){ toast('New password and confirmation don\'t match.', 'error'); return; }
  try{
    await api('/api/auth/staff/change-password', { method:'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
    document.getElementById('pw-confirm').value = '';
    toast('Password updated.', 'success');
  }catch(err){ toast(err.message, 'error'); }
}

async function init(){
  try{
    const data = await api('/api/auth/staff/me');
    ME = data.employee;
  }catch(e){
    window.location.href = '/index.html';
    return;
  }

  document.getElementById('sb-name').textContent = ME.name;
  document.getElementById('sb-role').textContent = ME.designation;
  applyAvatar(document.getElementById('sb-avatar'), ME);

  document.getElementById('profile-name').textContent = ME.name;
  document.getElementById('profile-role').textContent = ME.designation + ' · ' + ME.department;
  applyAvatar(document.getElementById('profile-avatar'), ME);
  document.getElementById('remove-photo-btn').classList.toggle('hidden', !ME.avatarImage);
  document.getElementById('p-empid').textContent = ME.employeeId;
  document.getElementById('p-dept').textContent = ME.department;
  document.getElementById('p-email').textContent = ME.email;
  document.getElementById('p-phone').textContent = ME.phone;
  document.getElementById('p-join').textContent = (ME.joinDateMiti ? ME.joinDateMiti + ' BS' : '—') + (ME.joinDate ? ` (${fmtDate(ME.joinDate)})` : '');
  document.getElementById('p-shift').textContent = `${ME.shiftName || 'General Shift'} · ${fmtTime12(ME.shiftStart)} – ${fmtTime12(ME.shiftEnd)}`;
  document.getElementById('p-manager').textContent = ME.managerName || 'No manager assigned';
  document.getElementById('p-status').textContent = ME.status === 'active' ? 'Active' : 'On Leave';
  document.getElementById('p-shift-end').textContent = fmtTime12(ME.shiftEnd);
  document.getElementById('shift-note').textContent = `${ME.shiftName || 'General Shift'} · ${fmtTime12(ME.shiftStart)} — ${fmtTime12(ME.shiftEnd)}`;
  document.getElementById('nav-team').classList.toggle('hidden', !ME.isManager);
  if(ME.isManager) refreshTeamBadge();
  loadViewableStaff();

  const t = await api('/api/attendance/today');
  TODAY_RECORD = t.record;
  renderDial();
  loadRecent();

  tickClock();
  setInterval(tickClock, 1000);
}

init();

// ---------------- Background auto-refresh ----------------
// Keeps the "needs your attention" badge/widget current even if a manager
// just leaves the dashboard open — approvals piling up shouldn't require
// a manual page reload to notice. Paused while the tab isn't visible so
// it isn't polling in the background for no reason.
setInterval(() => {
  if(document.hidden || !ME) return;
  if(ME.isManager) refreshTeamBadge();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if(!document.hidden && ME && ME.isManager) refreshTeamBadge();
});
