'use strict';
/**
 * US Equity / CME Market Holiday Calendar
 *
 * User directive (2026-04-25): "never trade holidays".
 *
 * NYSE / Nasdaq full-close holidays (CME equity index futures also halt).
 * Maintained as a static list — refresh annually via NYSE calendar.
 *
 * Half-day (early-close) sessions are NOT in this list because the user
 * trades 9:30-9:45 ET ORB, which still happens normally on half-days.
 * If the user wants to skip half-days too, add `HALF_DAYS` and a check.
 */

const FULL_CLOSE_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', // New Year's Day
  '2025-01-20', // MLK Day
  '2025-02-17', // Presidents Day
  '2025-04-18', // Good Friday
  '2025-05-26', // Memorial Day
  '2025-06-19', // Juneteenth
  '2025-07-04', // Independence Day
  '2025-09-01', // Labor Day
  '2025-11-27', // Thanksgiving
  '2025-12-25', // Christmas
  // 2026
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed; 7/4 is Sat)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26', // Good Friday
  '2027-05-31',
  '2027-06-18', // Juneteenth observed (6/19 Sat)
  '2027-07-05', // Independence Day observed (7/4 Sun)
  '2027-09-06',
  '2027-11-25',
  '2027-12-24', // Christmas observed (12/25 Sat)
]);

/**
 * Returns true if the given ISO date (YYYY-MM-DD, ET) is a US market holiday.
 * Treats unknown future dates as non-holidays — the calendar must be refreshed
 * yearly. The strategy-layer filter logs a warning when checked against an
 * unknown year so the operator notices.
 */
function isUSMarketHoliday(dateIso) {
  if (typeof dateIso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return false;
  return FULL_CLOSE_HOLIDAYS.has(dateIso);
}

/**
 * Returns the latest year covered by the static calendar, so callers can
 * detect when the calendar needs refreshing.
 */
function calendarLatestYear() {
  let max = 0;
  for (const d of FULL_CLOSE_HOLIDAYS) {
    const y = parseInt(d.slice(0, 4), 10);
    if (y > max) max = y;
  }
  return max;
}

module.exports = {
  isUSMarketHoliday,
  calendarLatestYear,
  FULL_CLOSE_HOLIDAYS,
};
