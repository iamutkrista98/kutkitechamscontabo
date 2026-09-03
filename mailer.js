// mailer.js — sends branded transactional emails for the attendance
// approval workflow (early checkout / leave / correction requests). Every
// email is sent from a single "administration" address, is one-way
// (recipients aren't expected to reply), and links back into the app so
// the person can see full detail and take action there. Branding (name,
// logo) is pulled from the admin-configurable settings table, not
// hardcoded, so this works unmodified for whichever organization the app
// is deployed for.
//
// Configure via environment variables:
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE ('true'/'false'), SMTP_USER, SMTP_PASS
//   MAIL_FROM_EMAIL   — the administration address mail is sent from
//                       (default: the first admin account's own email)
//   MAIL_FROM_NAME    — display name (default: "<Company Name> Administration")
//   APP_URL           — base URL used to build "open your dashboard" links
//
// If SMTP_HOST isn't set, mail is logged to the console instead of sent —
// so the app runs out of the box in development without crashing or
// hanging on a missing mail server.
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, 'public', 'img', 'logo.png');
const DEFAULT_LOGO_BUFFER = fs.readFileSync(LOGO_PATH);
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

// Company name/logo come from the admin-configurable settings table (see
// server.js's getSettings()) rather than being hardcoded — this is what
// lets the app be reconfigured for a different organization without
// touching code. The logo is a file on disk under public/uploads/branding/
// (see server.js's toPublicUploadUrl) — settings.logoImage just stores the
// relative URL, so this reads the actual bytes off disk. Falls back to the
// shipped default logo if nothing's been uploaded yet, the file went
// missing, or settings aren't readable yet (e.g. very first boot before
// the table is seeded).
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
  } catch (err) { /* db not ready yet — fall through to default */ }
  return { name: DEFAULT_COMPANY_NAME, logoBuffer: DEFAULT_LOGO_BUFFER, logoExt: 'png' };
}

// The "administration email setup" — defaults to whatever email the HR
// admin account itself uses (so mail genuinely comes from HR's own
// address), overridable via MAIL_FROM_EMAIL for a dedicated sending
// address instead. The final fallback only fires if there's no admin
// account yet at all (essentially only ever hit right at first boot,
// before setup) — it's a generic placeholder, not a real domain, since
// this app is meant to be deployed for any organization and hardcoding
// someone else's domain here would be both wrong and a likely SPF/DKIM
// deliverability failure.
async function resolveFromEmail() {
  if (process.env.MAIL_FROM_EMAIL) return process.env.MAIL_FROM_EMAIL;
  try {
    const { load } = require('./db');
    const admins = await load('admins');
    if (admins[0] && admins[0].email) return admins[0].email;
  } catch (err) { /* db not ready yet — fall through to default */ }
  console.warn('[mailer] No MAIL_FROM_EMAIL set and no admin account exists yet — falling back to a placeholder sender address. Set MAIL_FROM_EMAIL or create an admin account.');
  return 'administration@example.com';
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  } else {
    transporter = {
      sendMail: async (opts) => {
        console.log(`[mailer] SMTP not configured — skipping send. Would have emailed "${opts.subject}" to ${opts.to}. Set SMTP_HOST (see README) to actually send mail.`);
        return { accepted: [] };
      }
    };
  }
  return transporter;
}

const BADGES = {
  approved: { bg: '#E4F4EB', fg: '#2F8F5B', label: 'Approved' },
  rejected: { bg: '#FBEAE8', fg: '#C0463A', label: 'Declined' },
  pending: { bg: '#E6F0F8', fg: '#2C6FA8', label: 'Pending Review' },
  not_required: { bg: '#F6F8FD', fg: '#666F8C', label: 'Not Required' }
};

// Builds the branded HTML card — logo header on a navy gradient, an
// optional status pill, a detail table, and a call-to-action button in
// KutkiTech's growth-green. Kept to inline styles/table layout throughout
// since that's what actually renders consistently across email clients.
function renderEmailHtml({ heading, intro, rows, badgeKey, ctaLabel, ctaUrl, companyName }) {
  const badge = badgeKey && BADGES[badgeKey];
  const rowsHtml = (rows || []).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `
    <tr>
      <td style="padding:7px 0; color:#666F8C; font-size:12.5px; width:150px; vertical-align:top;">${escapeHtml(k)}</td>
      <td style="padding:7px 0; color:#101526; font-size:13px; font-weight:600;">${escapeHtml(String(v))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0; padding:0; background:#EEF2FA; font-family:'Segoe UI', Helvetica, Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF2FA; padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#FFFFFF; border-radius:18px; overflow:hidden; box-shadow:0 8px 24px rgba(12,22,51,.10);">
        <tr>
          <td style="background:linear-gradient(135deg,#12204A,#22397A); padding:30px 32px;">
            <img src="cid:org-logo" alt="${escapeHtml(companyName)}" height="32" style="display:block; margin-bottom:16px;" />
            <div style="color:#ffffff; font-size:21px; font-weight:700; font-family:Georgia,'Times New Roman',serif; letter-spacing:.01em;">${escapeHtml(heading)}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:30px 32px 8px;">
            ${badge ? `<span style="display:inline-block; padding:5px 14px; border-radius:999px; font-size:11.5px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; background:${badge.bg}; color:${badge.fg}; margin-bottom:16px;">${badge.label}</span><br/>` : ''}
            <p style="color:#29304A; font-size:14.5px; line-height:1.65; margin:${badge ? '14px' : '0'} 0 20px;">${intro}</p>
            ${rowsHtml ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F8FD; border-radius:12px; margin-bottom:24px;"><tr><td style="padding:6px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowsHtml}</table></td></tr></table>` : ''}
            ${ctaUrl ? `<a href="${ctaUrl}" style="display:inline-block; background:#5FA82E; color:#ffffff; text-decoration:none; padding:13px 28px; border-radius:10px; font-weight:700; font-size:14px;">${escapeHtml(ctaLabel || 'Open Dashboard')} →</a>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:22px 32px; background:#F6F8FD; border-top:1px solid #E9EDF7;">
            <p style="color:#99A1BC; font-size:11.5px; line-height:1.6; margin:0;">
              This is an automated message from ${escapeHtml(companyName)}'s attendance system — this mailbox isn't
              monitored and replies won't be read. Sign in to your dashboard for full details or to
              take action.
            </p>
            <p style="color:#B7BDD1; font-size:10.5px; margin:10px 0 0;">© ${new Date().getFullYear()} ${escapeHtml(companyName)}</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Sends one themed notification email. Never throws — a failed or
// unconfigured mail send should never break the API request that
// triggered it; errors are logged and swallowed.
async function sendMail({ to, subject, heading, intro, rows, badgeKey, ctaLabel, ctaUrl }) {
  if (!to) return;
  try {
    const { name: companyName, logoBuffer, logoExt } = await resolveBranding();
    const html = renderEmailHtml({ heading: heading || subject, intro, rows, badgeKey, ctaLabel, ctaUrl, companyName });
    const attachments = logoBuffer ? [{ filename: `logo.${logoExt}`, content: logoBuffer, cid: 'org-logo' }] : [];
    const fromEmail = await resolveFromEmail();
    const fromName = process.env.MAIL_FROM_NAME || `${companyName} Administration`;
    await getTransporter().sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      replyTo: fromEmail,
      subject,
      html,
      attachments,
      headers: { 'X-Auto-Response-Suppress': 'All', 'Auto-Submitted': 'auto-generated' }
    });
  } catch (err) {
    console.error('[mailer] Failed to send email:', err.message);
  }
}

module.exports = { sendMail, APP_URL };
