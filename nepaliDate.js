// ---------------------------------------------------------------------------
// Nepali (Bikram Sambat) date support
// ---------------------------------------------------------------------------
// Every date in the database stays in plain Gregorian 'YYYY-MM-DD' — that
// doesn't change. This module only *derives* the Nepali Miti from it for
// display, using `nepali-date-converter` (MIT, no dependencies), which
// converts against the real Nepali calendar's actual month lengths (they
// vary year to year — Baisakh isn't always 31 days, Ashadh isn't always 32,
// etc.) rather than a fixed 30/31-day approximation. That table-driven
// approach is what Hamro Patro / Patro and every other correct BS
// converter use, since there's no fixed arithmetic formula for the BS
// calendar the way there is for Gregorian leap years.
//
// Valid range: BS 2000-01-01 to 2090-12-30, i.e. roughly AD 1943 to 2034 —
// comfortably covers every date this HR system will ever touch (employee
// records, attendance, leave, holidays). Dates outside that range fail
// closed (return null) rather than throwing, so a stray bad date can never
// crash a request — it just shows no Miti.
// ---------------------------------------------------------------------------
const NepaliDate = require('nepali-date-converter').default;

// 1-indexed, matching the BS month order used throughout Nepal's official
// and commercial calendars (Patro, Hamro Patro, government notices, etc.)
const BS_MONTHS = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashwin',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'
];

// The Nepali fiscal/financial year always starts on 1 Shrawan (BS month 4)
// and ends on the last day of Ashadh (BS month 3) the following BS year —
// this is set by Nepal's Financial Procedures Act, not a convention this
// app invented.
const FISCAL_YEAR_START_BS_MONTH = 4; // Shrawan

// AD 'YYYY-MM-DD' -> { bs: 'YYYY-MM-DD', year, month, day, monthName, formatted, weekday } | null
function toBs(adDateStr) {
  if (!adDateStr) return null;
  try {
    const nd = new NepaliDate(new Date(adDateStr + 'T00:00:00'));
    const { year, month, date } = nd.getBS(); // month is 0-indexed here
    const monthNum = month + 1;
    const pad = n => String(n).padStart(2, '0');
    return {
      bs: `${year}-${pad(monthNum)}-${pad(date)}`,
      year, month: monthNum, day: date,
      monthName: BS_MONTHS[month],
      formatted: `${date} ${BS_MONTHS[month]} ${year}`,
      weekday: nd.format('ddd')
    };
  } catch (e) {
    return null; // out of the library's supported BS 2000–2090 range
  }
}

// Just the short "YYYY-MM-DD" Miti string, or null. Handiest for slotting
// into API responses/exports as a sibling field next to the AD date.
function toBsShort(adDateStr) {
  const bs = toBs(adDateStr);
  return bs ? bs.bs : null;
}

// Just the human-readable "6 Shrawan 2083" form, or null.
function toBsFormatted(adDateStr) {
  const bs = toBs(adDateStr);
  return bs ? bs.formatted : null;
}

// AD 'YYYY-MM-DD' -> Nepali fiscal year label, e.g. "2082/83", or null.
// Shrawan through Chaitra (BS months 4–12) belong to the fiscal year
// starting that same BS year; Baisakh through Ashadh (months 1–3) belong
// to the fiscal year that started the *previous* BS year.
function fiscalYear(adDateStr) {
  const bs = toBs(adDateStr);
  if (!bs) return null;
  const startYear = bs.month >= FISCAL_YEAR_START_BS_MONTH ? bs.year : bs.year - 1;
  const endYear = startYear + 1;
  return { label: `${startYear}/${String(endYear).slice(-2)}`, startYear, endYear };
}

// BS (year, month 1-indexed, day) -> AD 'YYYY-MM-DD', or null if invalid /
// out of the library's supported range. This is the reverse of toBs() —
// needed anywhere a person picks a Nepali date (holiday entry, a BS month
// filter, etc.) and it has to be turned into the AD date actually stored.
function fromBs(bsYear, bsMonth, bsDay) {
  try {
    const nd = new NepaliDate(Number(bsYear), Number(bsMonth) - 1, Number(bsDay));
    const d = nd.toJsDate();
    if (isNaN(d.getTime())) return null;
    return isoFromJsDate(d);
  } catch (e) {
    return null;
  }
}

function isoFromJsDate(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Today's BS date as { year, month, day, monthName } — the default a BS
// month/year picker should land on.
function todayBs() {
  return toBs(isoFromJsDate(new Date()));
}

// The AD start/end date-string bounds of one BS month (year, month
// 1-indexed) — e.g. Shrawan 2083 -> { startAD: '2026-07-17', endAD:
// '2026-08-16', days: 31 }. Since BS months don't have a fixed length
// (that's the whole reason a lookup-table converter is needed instead of
// arithmetic), this is worked out by finding the AD date of day 1 of this
// BS month and day 1 of the *next* BS month, then stepping back one day —
// not by assuming 30/31/32.
function bsMonthRange(bsYear, bsMonth) {
  try {
    const start = new NepaliDate(Number(bsYear), Number(bsMonth) - 1, 1).toJsDate();
    const next = bsMonth >= 12 ? { y: Number(bsYear) + 1, m: 1 } : { y: Number(bsYear), m: Number(bsMonth) + 1 };
    const nextStart = new NepaliDate(next.y, next.m - 1, 1).toJsDate();
    const end = new Date(nextStart.getTime() - 86400000);
    return {
      startAD: isoFromJsDate(start),
      endAD: isoFromJsDate(end),
      days: Math.round((end - start) / 86400000) + 1,
      label: `${BS_MONTHS[bsMonth - 1]} ${bsYear}`
    };
  } catch (e) {
    return null;
  }
}

// The AD start/end bounds of a full Nepali fiscal year, given its start
// BS year (e.g. 2082 for FY "2082/83" = 1 Shrawan 2082 to end of Ashadh
// 2083). This is what leave-balance usage is scoped to, so balances
// naturally read as "reset" once a new fiscal year's approved leave
// requests are the only ones counted.
function fiscalYearAdBounds(startYear) {
  const start = bsMonthRange(startYear, FISCAL_YEAR_START_BS_MONTH);
  const end = bsMonthRange(startYear + 1, FISCAL_YEAR_START_BS_MONTH - 1); // Ashadh of the following BS year
  if (!start || !end) return null;
  return { startAD: start.startAD, endAD: end.endAD, label: `${startYear}/${String(startYear + 1).slice(-2)}` };
}

// The AD bounds of the fiscal year "today" falls in — the default scope
// for leave balance usage.
function currentFiscalYearAdBounds() {
  const fy = fiscalYear(isoFromJsDate(new Date()));
  return fy ? fiscalYearAdBounds(fy.startYear) : null;
}


module.exports = {
  toBs, toBsShort, toBsFormatted, fiscalYear, BS_MONTHS,
  fromBs, todayBs, bsMonthRange, fiscalYearAdBounds, currentFiscalYearAdBounds
};
