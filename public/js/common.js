// common.js — shared helpers across pages
function toast(msg, type='default'){
  const host = document.getElementById('toast-host');
  if(!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateY(8px)'; el.style.transition='all .25s'; setTimeout(()=>el.remove(), 260); }, 3200);
}

async function api(url, opts={}){
  const res = await fetch(url, {
    headers: {'Content-Type':'application/json'},
    ...opts
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok){ throw new Error(data.error || 'Something went wrong.'); }
  return data;
}

function initials(name){
  return (name||'').split(' ').filter(Boolean).slice(0,2).map(p=>p[0]).join('').toUpperCase();
}

// A cache-buster query string (?v=timestamp) makes sense for a real image
// URL (which is what avatars/logo are now — see server.js's
// toPublicUploadUrl) and is needed here, since a replaced avatar keeps
// the same-looking <img> tag and the browser would otherwise keep
// showing the old cached file. The data: URI branch is kept only as a
// defensive fallback for any legacy value that hasn't gone through the
// startup migration yet — appending a query string would corrupt one,
// since everything after the comma in a data: URI IS the image data.
function withCacheBust(src){
  if(!src) return src;
  return src.startsWith('data:') ? src : `${src}?v=${Date.now()}`;
}

// Updates an existing ".avatar" element in place — shows the person's
// uploaded photo if they have one, otherwise falls back to colored initials.
function applyAvatar(el, person){
  if(!el) return;
  if(person && person.avatarImage){
    el.style.background = 'transparent';
    el.style.padding = '0';
    el.innerHTML = `<img src="${withCacheBust(person.avatarImage)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`;
  } else {
    el.style.background = (person && person.avatarColor) || '#2E4A93';
    el.style.padding = '';
    el.innerHTML = '';
    el.textContent = initials(person && person.name);
  }
}

// Renders a person's avatar — their uploaded photo if they have one,
// otherwise the colored-initials circle used throughout the app. Pass an
// extra class (e.g. for sizing) via extraClass.
function avatarHtml(person, extraClass=''){
  if(person && person.avatarImage){
    return `<div class="avatar ${extraClass}" style="padding:0;overflow:hidden;background:#EEF2FA;"><img src="${person.avatarImage}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div>`;
  }
  const bg = (person && person.avatarColor) || '#2E4A93';
  return `<div class="avatar ${extraClass}" style="background:${bg}">${initials(person && person.name)}</div>`;
}

function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}
function fmtDateLong(iso){
  const d = iso ? new Date(iso + 'T00:00:00') : new Date();
  return d.toLocaleDateString('en-US', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}
function fmtTime12(t){
  if(!t) return '—';
  const [h,m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hh = ((h % 12) || 12);
  return `${hh}:${String(m).padStart(2,'0')} ${period}`;
}
function monthLabel(ym){
  const [y,m] = ym.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-US', { month:'long', year:'numeric' });
}
function currentMonthValue(){
  return new Date().toISOString().slice(0,7);
}
function statusBadge(status){
  const map = { present:'Present', late:'Late', absent:'Absent', 'on-leave':'On Leave', inactive:'Inactive', pending:'Pending', early_pending:'Early Checkout', approved:'Approved', rejected:'Rejected', not_required:'Not Required' };
  const cls = { present:'badge-present', late:'badge-late', absent:'badge-absent', 'on-leave':'badge-onleave', inactive:'badge-absent', pending:'badge-pending', early_pending:'badge-pending', approved:'badge-approved', rejected:'badge-rejected', not_required:'badge-neutral' };
  const title = status === 'early_pending' ? ' title="Checked out early — awaiting manager/HR approval"' : '';
  return `<span class="badge ${cls[status]||'badge-pending'}"${title}>${map[status]||status}</span>`;
}
function modalityBadge(modality){
  if(!modality) return '<span class="badge badge-neutral">—</span>';
  const cls = modality === 'Office' ? 'badge-office' : 'badge-remote';
  return `<span class="badge ${cls}">${modality}</span>`;
}

// Shows how an attendance entry was captured — a plain web check-in/out,
// HR's manual adjustment, an approved correction, the always-on-site
// auto-attendance rule, or a punch synced from the ZKTeco biometric device.
function sourceBadge(source){
  const map = {
    biometric: ['Biometric', 'badge-biometric'],
    manual: ['Manual', 'badge-neutral'],
    correction: ['Correction', 'badge-pending'],
    auto: ['Auto', 'badge-neutral']
  };
  const [label, cls] = map[source] || ['Web', 'badge-office'];
  return `<span class="badge ${cls}">${label}</span>`;
}

// Ask the browser for the person's current coordinates (used to record
// where a check-in / check-out happened). Resolves to null — rather than
// rejecting — if permission is denied or the API is unavailable, so a
// declined location prompt never blocks attendance from being marked.
function getGeolocation(timeoutMs = 6000){
  return new Promise((resolve) => {
    if(!('geolocation' in navigator)){ resolve(null); return; }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        });
      },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
    );
  });
}

function fmtLatLng(loc){
  if(!loc || loc.latitude === undefined || loc.latitude === null) return null;
  return `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`;
}
function mapLink(loc){
  if(!loc) return null;
  return `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
}

// ---------------- Nepali (BS) month/year pickers ----------------
// The 12 BS month names, in calendar order — purely for labeling a
// dropdown. All the actual date math (which AD dates a BS month spans,
// leap-ish variable month lengths, etc.) happens server-side; the client
// only ever sends the chosen {year, month} pair and displays what comes
// back, per app-wide policy that BS is the source of truth for filtering.
const BS_MONTH_NAMES = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra'];

// Fills a <select> with the 12 BS month names (value = 1-12) and another
// with a range of BS years centered on `centerYear`, then selects
// `selYear`/`selMonth` if given (otherwise leaves the browser default,
// i.e. first option). Safe to call repeatedly — just repopulates.
function populateBsPickers(monthSelect, yearSelect, centerYear, selYear, selMonth){
  if(monthSelect){
    monthSelect.innerHTML = BS_MONTH_NAMES.map((name,i) => `<option value="${i+1}">${name}</option>`).join('');
    if(selMonth) monthSelect.value = String(selMonth);
  }
  if(yearSelect){
    const years = [];
    for(let y = centerYear - 6; y <= centerYear + 3; y++) years.push(y);
    yearSelect.innerHTML = years.map(y => `<option value="${y}">${y} BS</option>`).join('');
    if(selYear) yearSelect.value = String(selYear);
  }
}


// ---------------- Organization branding ----------------
// Turns a set of off-day numbers (0=Sun..6=Sat) into a short label like
// "Sun–Fri" or "Mon–Fri" for contiguous work weeks, or a comma list for
// anything less standard — used on the sign-in screens and staff portal
// so the displayed work week always matches what HR configured, not a
// hardcoded assumption.
function workWeekLabel(weeklyOffDays){
  const DAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const off = new Set(weeklyOffDays || [6]);
  const working = [0,1,2,3,4,5,6].filter(d => !off.has(d));
  if(!working.length) return '—';
  // contiguous run check (handles wrap-around, e.g. off=[0,1] -> Tue-Sun... but
  // typical cases are a single contiguous block within the week)
  let isContiguous = true;
  for(let i=1;i<working.length;i++){ if(working[i] !== working[i-1]+1){ isContiguous = false; break; } }
  if(isContiguous) return working.length === 1 ? DAY[working[0]] : `${DAY[working[0]]}–${DAY[working[working.length-1]]}`;
  return working.map(d => DAY[d]).join(', ');
}

// Pulls company name + logo from /api/settings and applies them to every
// element marked with .js-brand-name / .js-brand-logo on the page, plus
// sets the document title from the page's data-title-template attribute
// (a "{company}" token on the <html> tag — see admin.html/staff.html/etc.)
// so this works for any organization's name out of the box, not just one
// hardcoded default. Safe to call on both the pre-login screens and the
// authenticated dashboards.
async function applyBranding(){
  try{
    const res = await fetch('/api/settings');
    if(!res.ok) return null;
    const data = await res.json();
    document.querySelectorAll('.js-brand-name').forEach(el => el.textContent = data.companyName);
    document.querySelectorAll('.js-brand-logo').forEach(img => img.src = data.logoImage ? withCacheBust(data.logoImage) : '/img/logo.png');
    document.querySelectorAll('.js-workweek-label').forEach(el => el.textContent = workWeekLabel(data.weeklyOffDays));
    const yearEl = document.getElementById('footer-year');
    if(yearEl) yearEl.textContent = new Date().getFullYear();
    const copyrightEl = document.getElementById('footer-copyright');
    if(copyrightEl && data.companyName) copyrightEl.innerHTML = `© <span id="footer-year">${new Date().getFullYear()}</span> ${data.companyName}`;
    const titleTemplate = document.documentElement.getAttribute('data-title-template');
    if(titleTemplate && data.companyName) document.title = titleTemplate.replace('{company}', data.companyName);
    return data;
  }catch(e){ return null; }
}
document.addEventListener('DOMContentLoaded', applyBranding);

// ---------------- Password visibility toggle (login screens) ----------------
function togglePasswordVisibility(inputId, btn){
  const input = document.getElementById(inputId);
  if(!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  input.classList.toggle('pw-field', !showing);
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  const svg = btn.querySelector('svg');
  svg.innerHTML = showing
    ? '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>'
    : '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.6 21.6 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.6 21.6 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>';
}

// ---------------- Generic table sorting ----------------
// Attach onclick="sortTable('table-id', colIndex)" to a <th>. Sorts the
// tbody's rows by that column, toggling asc/desc on repeat clicks, and
// swapping in an ascending/descending indicator arrow.
//
// Rendering code should put a real, comparable value on each <td> via
// data-sort="..." whenever the visible text isn't itself sortable —
// e.g. a Nepali Miti date's data-sort is the underlying ISO date, a
// "Staff" cell showing "Name CODE123" has data-sort="Name", an hours
// cell showing "8h" has data-sort="8". Falls back to the cell's own
// text content when no data-sort is present, which is enough for
// plain text/number columns.
function sortTable(tableId, colIndex){
  const table = document.getElementById(tableId);
  if(!table) return;
  const tbody = table.querySelector('tbody');
  const rows = Array.from(tbody.querySelectorAll('tr')).filter(r => !r.querySelector('td[colspan]'));
  if(!rows.length) return;
  const th = table.querySelectorAll('thead th')[colIndex];
  const currentDir = th.dataset.sortDir === 'asc' ? 'asc' : th.dataset.sortDir === 'desc' ? 'desc' : null;
  const nextDir = currentDir === 'asc' ? 'desc' : 'asc';
  table.querySelectorAll('thead th').forEach(h => { h.dataset.sortDir = ''; const ind = h.querySelector('.sort-ind'); if(ind) ind.textContent = ''; });
  th.dataset.sortDir = nextDir;
  const ind = th.querySelector('.sort-ind');
  if(ind) ind.textContent = nextDir === 'asc' ? '▲' : '▼';

  const sortKey = (row) => {
    const cell = row.children[colIndex];
    if(!cell) return '';
    if(cell.dataset && cell.dataset.sort !== undefined) return cell.dataset.sort;
    return (cell.textContent || '').trim();
  };
  const asNumber = (s) => {
    const trimmed = String(s).trim();
    if(trimmed === '' || trimmed === '—' || trimmed === '-') return null;
    // ISO dates (YYYY-MM-DD, used as the sort key for both the AD date
    // column and the Miti/BS column) must NOT go through parseFloat —
    // parseFloat("2026-08-01") stops at the first "-" and returns just
    // 2026, which made every date in the same year compare equal. Turn
    // the whole date into one comparable integer instead.
    const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(isoMatch) return parseInt(isoMatch[1] + isoMatch[2] + isoMatch[3], 10);
    // HH:MM style times sort correctly as minutes-since-midnight
    const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if(timeMatch) return parseInt(timeMatch[1], 10) * 60 + parseInt(timeMatch[2], 10);
    // Plain numbers (hours worked, counts, etc.) — strip everything except
    // digits and a decimal point so stray text doesn't confuse parseFloat,
    // but don't touch hyphens here since that's only meaningful for dates
    // and times, both already handled above.
    if(!/^-?[\d.]+$/.test(trimmed)) return null;
    const n = parseFloat(trimmed);
    return isNaN(n) ? null : n;
  };
  rows.sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    const na = asNumber(ka), nb = asNumber(kb);
    let cmp;
    if(na !== null && nb !== null) cmp = na - nb;
    else cmp = String(ka).localeCompare(String(kb), undefined, { sensitivity: 'base', numeric: true });
    return nextDir === 'asc' ? cmp : -cmp;
  });
  rows.forEach(r => tbody.appendChild(r));
}
function openForgotModal(){
  const el = document.getElementById('forgot-modal');
  if(!el) return;
  el.classList.remove('hidden');
  showForgotStep('choose');
}
function closeForgotModal(){
  const el = document.getElementById('forgot-modal');
  if(el) el.classList.add('hidden');
}
function showForgotStep(step){
  ['choose','hr','otp-request','otp-verify','done'].forEach(s => {
    const el = document.getElementById('forgot-step-' + s);
    if(el) el.classList.toggle('hidden', s !== step);
  });
  const msg = document.getElementById('forgot-msg');
  if(msg){ msg.textContent = ''; msg.classList.remove('show'); }
}
async function submitForgotHr(){
  const email = document.getElementById('forgot-hr-email').value.trim();
  if(!email) return;
  try{
    const res = await fetch('/api/auth/forgot/request-reset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
    const data = await res.json();
    document.getElementById('forgot-done-text').textContent = data.message || 'If that email is registered, HR has been notified.';
    showForgotStep('done');
  }catch(e){ /* keep user on the same step, nothing to leak on failure */ }
}
async function submitForgotSendOtp(){
  const email = document.getElementById('forgot-otp-email').value.trim();
  if(!email) return;
  document.getElementById('forgot-otp-email-hidden').value = email;
  try{
    await fetch('/api/auth/forgot/send-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) });
  }catch(e){}
  showForgotStep('otp-verify');
}
async function submitForgotVerifyOtp(){
  const email = document.getElementById('forgot-otp-email-hidden').value;
  const otp = document.getElementById('forgot-otp-code').value.trim();
  const newPassword = document.getElementById('forgot-otp-new-password').value;
  const msg = document.getElementById('forgot-msg');
  if(newPassword.length < 8){ msg.textContent = 'New password must be at least 8 characters.'; msg.classList.add('show'); return; }
  try{
    const res = await fetch('/api/auth/forgot/verify-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, otp, newPassword }) });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || 'Could not verify that code.');
    document.getElementById('forgot-done-text').textContent = 'Password updated — you can sign in with your new password now.';
    showForgotStep('done');
  }catch(e){ msg.textContent = e.message; msg.classList.add('show'); }
}

// ---------------- Button loading state ----------------
// Wraps an async action with a spinner + disabled state on the triggering
// button, so "Apply filters" / "Refresh" style actions give visible
// feedback instead of appearing to do nothing until the table updates.
// Safe to call from an inline onclick — pass the button itself.
async function withBtnLoading(btn, fn){
  if(!btn || btn.dataset.loading === '1') return;
  const original = btn.innerHTML;
  btn.dataset.loading = '1';
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner"></span>' + (btn.dataset.loadingText || 'Working…');
  try{
    return await fn(); // callers that read the result (e.g. a toast built from the response) need this — previously discarded, so `res` was always undefined even on success
  } finally {
    btn.disabled = false;
    btn.dataset.loading = '0';
    btn.innerHTML = original;
  }
}

// Shared refresh icon (a circular-arrows glyph) — used for every standalone
// "Refresh" icon-button across both dashboards so they're all identical.
function refreshIconSvg(){
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
}
// Fills in every <button class="refresh-icon-btn"> currently in the DOM
// that doesn't have its icon yet. Called once on page load and again
// after anything that might add a new one dynamically.
function paintRefreshIcons(){
  document.querySelectorAll('.refresh-icon-btn').forEach(b => { if(!b.innerHTML.trim()) b.innerHTML = refreshIconSvg(); });
}
document.addEventListener('DOMContentLoaded', paintRefreshIcons);
// Like withBtnLoading, but for an icon-only button: spins the icon in
// place instead of swapping in "Working…" text, since there's no room
// for a label next to a bare icon.
async function withIconBtnLoading(btn, fn){
  if(!btn || btn.dataset.loading === '1') return;
  btn.dataset.loading = '1';
  btn.disabled = true;
  btn.classList.add('spinning');
  try{
    await fn();
  } finally {
    btn.disabled = false;
    btn.dataset.loading = '0';
    btn.classList.remove('spinning');
  }
}


// ---------------- Confirmation dialog ----------------
// A promise-based, app-styled replacement for window.confirm(). Builds one
// reusable modal (reusing the same .modal-backdrop / .modal / .btn tokens
// as every other dialog in the app, so it looks native rather than a
// browser popup) the first time it's needed, then resolves true/false
// based on which button was clicked, Escape, or a backdrop click.
let _confirmModalEl = null;
function _ensureConfirmModal(){
  if(_confirmModalEl) return _confirmModalEl;
  const el = document.createElement('div');
  el.className = 'modal-backdrop hidden';
  el.id = 'confirm-dialog-backdrop';
  el.innerHTML = `
    <div class="modal" style="max-width:400px;">
      <div id="confirm-dialog-icon" style="width:50px;height:50px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-bottom:16px;"></div>
      <h3 id="confirm-dialog-title">Are you sure?</h3>
      <p class="sub" id="confirm-dialog-message"></p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="confirm-dialog-cancel">Cancel</button>
        <button class="btn btn-gold" id="confirm-dialog-ok">Confirm</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  _confirmModalEl = el;
  return el;
}

// confirmDialog({ title, message, confirmLabel, cancelLabel, danger }) -> Promise<boolean>
function confirmDialog(opts = {}){
  const { title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = opts;
  const el = _ensureConfirmModal();
  const iconHost = el.querySelector('#confirm-dialog-icon');
  const okBtn = el.querySelector('#confirm-dialog-ok');
  const cancelBtn = el.querySelector('#confirm-dialog-cancel');
  el.querySelector('#confirm-dialog-title').textContent = title;
  el.querySelector('#confirm-dialog-message').textContent = message;
  okBtn.textContent = confirmLabel;
  cancelBtn.textContent = cancelLabel;
  okBtn.className = 'btn ' + (danger ? 'btn-danger-ghost' : 'btn-gold');
  iconHost.style.background = danger ? 'var(--danger-tint)' : 'var(--brass-tint)';
  iconHost.innerHTML = danger
    ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>'
    : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--brass)" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';

  el.classList.remove('hidden');
  okBtn.focus();

  return new Promise((resolve) => {
    function cleanup(result){
      el.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      el.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk(){ cleanup(true); }
    function onCancel(){ cleanup(false); }
    function onBackdrop(e){ if(e.target === el) cleanup(false); }
    function onKey(e){ if(e.key === 'Escape') cleanup(false); if(e.key === 'Enter') cleanup(true); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    el.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}
