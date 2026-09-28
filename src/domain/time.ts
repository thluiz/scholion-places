// time.ts — local time, written down the way the records want it.
//
// Both functions work in the machine's timezone rather than UTC, and that is
// the whole point. A sighting recorded at half past midnight in Lisbon belongs
// to that day, not to the one UTC says it is — and "what flowers here in April"
// is a question about local seasons, so the month a record lands in has to be
// the local one.

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Today, locally, as YYYY-MM-DD. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Now, locally, as an ISO 8601 timestamp carrying its offset. */
export function localTimestamp(now = new Date()): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);

  return (
    `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}
