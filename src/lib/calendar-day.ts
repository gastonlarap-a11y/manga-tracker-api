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
 * The width of a stretch of time inside which no zone's calendar day changes.
 * Every zone in use today is offset from UTC by a multiple of fifteen minutes
 * (India's :30, Nepal's :45, Chatham's 12:45), and changes offset at a local
 * wall-clock time, so a local midnight — or a transition — always falls on a
 * quarter hour of UTC. Only the local mean times of the nineteenth century
 * break that, and nobody read a chapter then.
 */
const DAY_CONSTANT_MS = 15 * 60_000;

/**
 * The function that answers which calendar day an instant falls on in
 * `timeZone`. Returned rather than computed in one call, because building the
 * formatter is the expensive part and a caller asks it once per reading.
 *
 * It remembers each quarter hour it has answered: twelve weeks of a heavy
 * reader are tens of thousands of readings, and formatting each one was a
 * large part of what the activity panel cost.
 */
export function calendarDayIn(timeZone: string): (instant: Date) => string {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const answered = new Map<number, string>();
  return (instant) => {
    const quarter = Math.floor(instant.getTime() / DAY_CONSTANT_MS);
    const known = answered.get(quarter);
    if (known !== undefined) {
      return known;
    }
    // Assembled from the parts rather than trusting one locale's layout to
    // stay `YYYY-MM-DD` across ICU versions.
    const parts = new Map(
      format.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    const day = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
    answered.set(quarter, day);
    return day;
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
