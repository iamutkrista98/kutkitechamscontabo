// notifications.js — sends the "each step" approval emails for early
// checkout, leave, and correction requests: a receipt when submitted, a
// heads-up to whoever needs to review it next, and a status update to the
// employee every time a decision is made. Every call is fire-and-forget
// from the route handlers' point of view (see server.js) — these should
// never block or fail an API response.
const { sendMail, APP_URL } = require('./mailer');

const KIND_LABEL = { early: 'Early Checkout Request', leave: 'Leave Request', correction: 'Attendance Correction Request' };
const STAFF_URL = `${APP_URL}/staff.html`;
const ADMIN_URL = `${APP_URL}/admin.html`;

function firstName(name) { return (name || '').split(' ')[0]; }

function detailRows(kind, item) {
  if (kind === 'early') return [['Date', item.date], ['Departed at', item.requestedTime], ['Reason', item.reason]];
  if (kind === 'leave') return [['Leave type', item.leaveType], ['From', item.fromDate], ['To', item.toDate], ['Reason', item.reason]];
  return [['Date', item.date], ['Requested check-in', item.requestedCheckIn], ['Requested check-out', item.requestedCheckOut], ['Reason', item.reason]];
}

function outcomeSentence(status) {
  if (status === 'approved') return "It's now fully approved.";
  if (status === 'rejected') return "It's been declined — no further action is needed.";
  return "It's still awaiting one more approval.";
}

// Called right after a request is created (early checkout / leave /
// correction). Sends the employee a receipt, then — if it isn't already
// fully decided (e.g. an exempted employee) — a heads-up to whoever needs
// to act on it next: their manager if one's assigned, otherwise HR.
function notifyRequestSubmitted(kind, item, emp, employees, admins) {
  const label = KIND_LABEL[kind];
  sendMail({
    to: emp.email,
    subject: `${label} received`,
    heading: `${label} Submitted`,
    intro: `Hi ${firstName(emp.name)}, we've received your ${label.toLowerCase()}. ${
      item.status === 'approved' ? "Since you're exempt from approval, it's already been applied — nothing further to do." : outcomeSentence(item.status)
    }`,
    rows: detailRows(kind, item),
    badgeKey: item.status,
    ctaLabel: 'View in my dashboard',
    ctaUrl: STAFF_URL
  }).catch(() => {});

  if (item.managerDecision === 'pending') {
    const manager = employees.find(e => e.id === emp.managerId);
    if (manager) {
      sendMail({
        to: manager.email,
        subject: `Approval needed — ${label} from ${emp.name}`,
        heading: 'Approval Needed',
        intro: `${emp.name} submitted a ${label.toLowerCase()} that needs your review as their manager.`,
        rows: detailRows(kind, item),
        badgeKey: 'pending',
        ctaLabel: 'Review in my dashboard',
        ctaUrl: STAFF_URL
      }).catch(() => {});
    }
  } else if (item.adminDecision === 'pending') {
    admins.forEach(a => sendMail({
      to: a.email,
      subject: `Approval needed — ${label} from ${emp.name}`,
      heading: 'Approval Needed',
      intro: `${emp.name} submitted a ${label.toLowerCase()} that needs HR's review.`,
      rows: detailRows(kind, item),
      badgeKey: 'pending',
      ctaLabel: 'Review in HR dashboard',
      ctaUrl: ADMIN_URL
    }).catch(() => {}));
  }
}

// Called right after a manager or HR records a decision. Always updates
// the employee; additionally pings HR if the manager just approved and
// HR's review is now the only thing left.
function notifyRequestDecided(kind, item, emp, decidedByRole, employees, admins) {
  const label = KIND_LABEL[kind];
  const decisionJustMade = decidedByRole === 'manager' ? item.managerDecision : item.adminDecision;
  const whoDecided = decidedByRole === 'manager' ? 'Your manager' : 'HR';

  sendMail({
    to: emp.email,
    subject: `${label} update — ${decisionJustMade === 'approved' ? 'Approved' : 'Declined'} by ${decidedByRole === 'manager' ? 'your manager' : 'HR'}`,
    heading: `${label} Update`,
    intro: `${whoDecided} ${decisionJustMade === 'approved' ? 'approved' : 'declined'} your ${label.toLowerCase()}. ${outcomeSentence(item.status)}`,
    rows: detailRows(kind, item),
    badgeKey: item.status,
    ctaLabel: 'View in my dashboard',
    ctaUrl: STAFF_URL
  }).catch(() => {});

  if (decidedByRole === 'manager' && item.managerDecision === 'approved' && item.adminDecision === 'pending') {
    admins.forEach(a => sendMail({
      to: a.email,
      subject: `Approval needed — ${label} from ${emp.name}`,
      heading: 'Approval Needed',
      intro: `${emp.name}'s manager approved their ${label.toLowerCase()} — it now needs your final review.`,
      rows: detailRows(kind, item),
      badgeKey: 'pending',
      ctaLabel: 'Review in HR dashboard',
      ctaUrl: ADMIN_URL
    }).catch(() => {}));
  }
}

module.exports = { notifyRequestSubmitted, notifyRequestDecided };
