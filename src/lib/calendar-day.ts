/**
 * Calendar days in a named time zone, written `YYYY-MM-DD`.
 *
 * Reading activity is counted per day the reader lived, not per UTC day: a
 * chapter read at 23:30 in Santiago belongs to that evening, not to the next
 * day. The zone is the caller's to name — the backend runs on the reader's own
 * machine, but a launchd job or a scheduled task is not guaranteed to inherit
 * the zone the reader sees on screen.
 */

const DAY_MS = 86_400_000;

/** Whether this runtime knows `timeZone` as an IANA zone it can format in. */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The function that answers which calendar day an instant falls on in
 * `timeZone`. Returned rather than computed in one call, because building the
 * formatter is the expensive part and a caller asks it once per reading.
 */
export function calendarDayIn(timeZone: string): (instant: Date) => string {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (instant) => {
    // Assembled from the parts rather than trusting one locale's layout to
    // stay `YYYY-MM-DD` across ICU versions.
    const parts = new Map(
      format.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
  };
}

/**
 * `count` consecutive calendar days ending on `lastDay`, oldest first.
 *
 * Arithmetic on the date alone: read as a UTC midnight, where no day is ever
 * 23 or 25 hours long, so stepping back never skips or repeats one across a
 * daylight-saving change in the reader's zone.
 */
export function daysEndingOn(lastDay: string, count: number): string[] {
  const end = Date.parse(`${lastDay}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) =>
    new Date(end - (count - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
}
