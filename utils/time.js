// MR-Bites runs on one campus in India, so the business day is an IST day —
// everywhere, for everyone.
//
// This exists because "today" used to mean the *server's* today. On a UTC host
// that rolls over at 05:30 IST, so a 1am sale counted against the previous day
// and a vendor's takings never matched the finance screen. Pinning the timezone
// to the business rather than the machine makes reports reproducible no matter
// where the server runs, and lets the frontend agree with the backend exactly.
//
// India has never observed DST, so a fixed offset is not an approximation here —
// it is exact, and avoids a timezone database dependency for a single-country
// product. Should MR-Bites ever cross a DST border, this module is the one place
// that has to change (and would need a real tz library).

const IST_OFFSET_MINUTES = 5 * 60 + 30; // UTC+05:30
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

const IST_TIMEZONE = 'Asia/Kolkata';

/**
 * The IST calendar day a moment falls on, as YYYY-MM-DD.
 * Shift the instant into IST, then read the date off the UTC fields.
 */
const dayKeyIST = (date = new Date()) =>
  new Date(new Date(date).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The instant an IST day begins (00:00:00.000 IST), as a UTC Date. */
const startOfDayIST = (dayKey) => {
  const key = typeof dayKey === 'string' ? dayKey.slice(0, 10) : dayKeyIST(dayKey);
  return new Date(new Date(`${key}T00:00:00.000Z`).getTime() - IST_OFFSET_MS);
};

/** The instant an IST day ends (23:59:59.999 IST), as a UTC Date. */
const endOfDayIST = (dayKey) => {
  const key = typeof dayKey === 'string' ? dayKey.slice(0, 10) : dayKeyIST(dayKey);
  return new Date(new Date(`${key}T23:59:59.999Z`).getTime() - IST_OFFSET_MS);
};

/**
 * Reads ?from=&to= as IST calendar days, defaulting to today in IST.
 * Returns the UTC instants that bound them, ready for a Mongo range query.
 */
const istDateRange = (query = {}) => {
  const fromKey = typeof query.from === 'string' && query.from ? query.from.slice(0, 10) : dayKeyIST();
  const toKey = typeof query.to === 'string' && query.to ? query.to.slice(0, 10) : fromKey;
  return {
    from: startOfDayIST(fromKey),
    to: endOfDayIST(toKey),
    fromKey,
    toKey,
  };
};

module.exports = {
  IST_TIMEZONE,
  IST_OFFSET_MINUTES,
  dayKeyIST,
  startOfDayIST,
  endOfDayIST,
  istDateRange,
};
