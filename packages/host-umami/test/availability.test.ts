import { describe, expect, it } from "vitest";
import { createUmamiAdapter } from "../src/adapter.ts";
import { CALENDAR_REASON, calendarAvailability } from "../src/availability.ts";
import { UmamiRefusal } from "../src/errors.ts";

const adapter = createUmamiAdapter();
const [entry] = adapter.catalog();
if (entry === undefined) throw new Error("the catalog is empty");

const unavailable = { available: false, reason: CALENDAR_REASON };
const available = { available: true, reason: null };

describe("the calendar window (UTC days 2 to 5 of a month)", () => {
  it("is available when the whole window lies outside those days", () => {
    expect(adapter.availability(entry, "2026-10-19T14:00:00.000Z", "2026-10-19T16:00:00.000Z")).toEqual(available);
    expect(adapter.availability(entry, "2026-10-06T00:00:00.000Z", "2026-10-31T23:59:59.999Z")).toEqual(available);
    expect(adapter.availability(entry, "2026-10-31T23:00:00.000Z", "2026-11-01T23:59:59.999Z")).toEqual(available);
  });

  it("is unavailable when either end, or any instant between them, falls on those days", () => {
    expect(adapter.availability(entry, "2026-11-02T00:00:00.000Z", "2026-11-02T00:00:01.000Z")).toEqual(unavailable);
    expect(adapter.availability(entry, "2026-11-05T23:59:59.999Z", "2026-11-06T01:00:00.000Z")).toEqual(unavailable);
    expect(adapter.availability(entry, "2026-11-01T23:00:00.000Z", "2026-11-02T00:00:00.000Z")).toEqual(unavailable);
    expect(adapter.availability(entry, "2026-10-31T12:00:00.000Z", "2026-11-07T12:00:00.000Z")).toEqual(unavailable);
    expect(adapter.availability(entry, "2026-10-19T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual(unavailable);
  });

  it("is available again from the 6th and up to the end of the 1st", () => {
    expect(calendarAvailability("2026-11-06T00:00:00.000Z", "2026-11-06T00:00:00.000Z")).toEqual(available);
    expect(calendarAvailability("2026-11-01T00:00:00.000Z", "2026-11-01T23:59:59.999Z")).toEqual(available);
    expect(calendarAvailability("2026-11-01T23:59:59.999Z", "2026-11-02T00:00:00.000Z")).toEqual(unavailable);
  });

  it("gives a plain-language reason without check details", () => {
    expect(CALENDAR_REASON).toMatch(/2nd to the 5th of a month \(UTC\)/);
    expect(CALENDAR_REASON).not.toMatch(/tzarg|getPageviewStats|seed|salt/i);
  });

  it("refuses malformed times, impossible dates and a window that ends before it starts", () => {
    const code = (from: string, until: string): string => {
      try {
        calendarAvailability(from, until);
      } catch (error) {
        if (error instanceof UmamiRefusal) return error.code;
        throw error;
      }
      return "no refusal";
    };
    expect(code("2026-10-19", "2026-10-20T00:00:00.000Z")).toBe("time_invalid");
    expect(code("2026-02-30T00:00:00.000Z", "2026-03-01T00:00:00.000Z")).toBe("time_invalid");
    expect(code("2026-10-20T00:00:00.000Z", "2026-10-19T00:00:00.000Z")).toBe("time_invalid");
    expect(code("2026-10-19T00:00:00.000+01:00", "2026-10-20T00:00:00.000Z")).toBe("time_invalid");
  });

  it("refuses an entry that is not in the catalog", () => {
    expect(() => adapter.availability({ ...entry, entry_id: "other" }, "2026-10-19T00:00:00.000Z", "2026-10-19T01:00:00.000Z")).toThrow(UmamiRefusal);
  });
});
