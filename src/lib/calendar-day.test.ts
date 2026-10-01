import { describe, expect, it } from "bun:test";
import { calendarDayIn, daysEndingOn, isTimeZone } from "./calendar-day";

describe("isTimeZone", () => {
  it("accepts an IANA zone and refuses anything else", () => {
    expect(isTimeZone("America/Santiago")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("calendarDayIn", () => {
  it("puts a late-evening reading on the reader's own day, not the UTC one", () => {
    // 23:30 in Santiago (UTC-3 in October) is already 02:30 UTC next day.
    const instant = new Date("2026-10-02T02:30:00.000Z");

    expect(calendarDayIn("America/Santiago")(instant)).toBe("2026-10-01");
    expect(calendarDayIn("UTC")(instant)).toBe("2026-10-02");
  });

  it("pads month and day to two digits", () => {
    expect(calendarDayIn("UTC")(new Date("2026-03-04T12:00:00.000Z"))).toBe(
      "2026-03-04",
    );
  });

  it.each([
    "America/Santiago",
    "Asia/Kathmandu",
    "Pacific/Chatham",
    "Australia/Lord_Howe",
    "Asia/Kolkata",
    "Europe/London",
  ])("remembers quarter hours without ever changing an answer (%s)", (zone) => {
    // A year every seven minutes — so each quarter hour is first asked at a
    // different point of it — through every midnight and daylight-saving
    // change, Santiago's midnight fall-back included, against Intl asked
    // directly, which remembers nothing.
    const remembered = calendarDayIn(zone);
    const direct = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const start = Date.UTC(2026, 0, 1);
    for (let minute = 0; minute < 366 * 24 * 60; minute += 7) {
      const instant = new Date(start + minute * 60_000);
      const fresh = direct.format(instant);

      if (remembered(instant) !== fresh) {
        throw new Error(`${zone} at ${instant.toISOString()}: not ${fresh}`);
      }
    }
  });
});

describe("daysEndingOn", () => {
  it("lists consecutive days, oldest first, ending on the given one", () => {
    expect(daysEndingOn("2026-03-02", 4)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("neither skips nor repeats a day across a daylight-saving change", () => {
    // Chile leaves DST on 2026-04-05; Europe enters it on 2026-03-29.
    const days = daysEndingOn("2026-04-07", 14);

    expect(days).toHaveLength(14);
    expect(new Set(days).size).toBe(14);
    expect(days[0]).toBe("2026-03-25");
  });
});
