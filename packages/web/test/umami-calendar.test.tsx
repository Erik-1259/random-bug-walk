import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseContract } from "@rbw/factory-contract/validate";
import { calendarAvailability } from "../../host-umami/src/availability.ts";
import { designerReducer, INITIAL_DESIGNER, specKey, type DesignerAction } from "../src/assist/designer-state.ts";
import { BugDesignerView } from "../src/components/bug-designer.tsx";
import { FactoryProgress } from "../src/components/factory-progress.tsx";
import { FactoryRequestForm } from "../src/components/factory-request-form.tsx";
import { CalendarCause } from "../src/components/factory-workspace.tsx";
import type { Capabilities, Interpretation } from "../src/factory/client.ts";
import { CALENDAR_HINT, calendarBlocks, calendarClockDelay, calendarClosedHosts, calendarClosesPair, hostClosedByCalendar, nextCalendarChange, UMAMI_CALENDAR_REASON } from "../src/factory/format.ts";
import { SHAPES, SPEC } from "./support/assist-fixtures.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/factory-v1/${name}.json`, import.meta.url), "utf8");
}
// The production request window is 2,700 s; the fixture's is longer, so the tests set it.
const WINDOW_S = 2700;
const open = (): Capabilities => {
  const capabilities = JSON.parse(fixture("capabilities")) as Capabilities;
  capabilities.limits.max_wall_clock_s = WINDOW_S;
  return capabilities;
};
// What the service reports while the calendar closes Umami: its date and time pair carries the reason.
const closed = (): Capabilities => {
  const capabilities = open();
  for (const combination of capabilities.combinations) {
    if (combination.host_id === "umami" && combination.bug_type_id === "date_time") Object.assign(combination, { status: "unsupported", reason: UMAMI_CALENDAR_REASON });
  }
  return capabilities;
};
const at = (iso: string) => Date.parse(iso);
const CLOCKS = {
  beforeWindow: at("2026-11-01T22:00:00Z"),
  lastEvening: at("2026-11-01T23:30:00Z"),
  second: at("2026-11-02T12:00:00Z"),
  lastMinute: at("2026-11-05T23:59:00Z"),
  sixth: at("2026-11-06T00:00:00Z"),
};
const HINT = "Umami is unavailable on UTC days 2–5.";
const FALLBACK = "The Task and report service is still available.";
const callbacks = { onInterpret: () => undefined, onChange: () => undefined };

describe("the Umami calendar rule in the web package", () => {
  it("uses the required wording and cites no upstream test", () => {
    expect(CALENDAR_HINT).toBe(HINT);
    expect(CALENDAR_HINT).not.toMatch(/test/i);
  });

  it.each([
    ["the evening before, outside the window", CLOCKS.beforeWindow, false],
    ["a window that reaches the 2nd", CLOCKS.lastEvening, true],
    ["the 2nd", CLOCKS.second, true],
    ["the last minute of the 5th", CLOCKS.lastMinute, true],
    ["midnight on the 6th", CLOCKS.sixth, false],
  ])("agrees with the Umami host's own rule on %s", (_label, nowMs, blocked) => {
    const until = nowMs + WINDOW_S * 1000;
    expect(calendarBlocks(nowMs, until)).toBe(blocked);
    expect(calendarAvailability(new Date(nowMs).toISOString(), new Date(until).toISOString()).available).toBe(!blocked);
  });

  it("closes Umami from the capabilities, or from the clock for capabilities read earlier, and never task-report", () => {
    expect(hostClosedByCalendar(closed(), "umami")).toBe(true);
    expect(hostClosedByCalendar(open(), "umami")).toBe(false);
    expect(hostClosedByCalendar(open(), "umami", CLOCKS.lastEvening)).toBe(true);
    expect(hostClosedByCalendar(open(), "umami", CLOCKS.sixth)).toBe(false);
    expect(hostClosedByCalendar(open(), "task-report", CLOCKS.second)).toBe(false);
    expect(calendarClosedHosts(closed())).toEqual(["umami"]);
    expect(calendarClosedHosts(open(), CLOCKS.lastMinute)).toEqual(["umami"]);
    expect(calendarClosedHosts(null, CLOCKS.second)).toEqual([]);
    // A pair Umami does not offer anyway is not closed by the calendar.
    expect(calendarClosesPair(open(), "umami", "concurrency", CLOCKS.second)).toBe(false);
    expect(calendarClosesPair(open(), "umami", "date_time", CLOCKS.second)).toBe(true);
    expect(calendarClosesPair(closed(), "umami", "date_time")).toBe(true);
  });
});

describe("the review of an Umami request on a blocked day", () => {
  const interpretation = (hosts: string[]) => {
    const value = parseContract("Interpretation", fixture("interpretation-unsupported"));
    value.hosts = hosts.map((host_id) => ({ host_id, used: false, reason: null })) as Interpretation["hosts"];
    return value;
  };
  const dateTime = (value: Interpretation) => {
    const item = value.items.find((entry) => entry.bug_type_id === "date_time");
    if (item === undefined) throw new Error("fixture");
    return item;
  };
  const cause = (capabilities: Capabilities, hosts: string[], nowMs: number) => {
    const value = interpretation(hosts);
    return renderToStaticMarkup(<CalendarCause capabilities={capabilities} requestedHosts={value.hosts.map((host) => host.host_id)} item={dateTime(value)} nowMs={nowMs} />);
  };

  it("names the calendar and offers the task-and-report service", () => {
    expect(cause(closed(), ["umami"], CLOCKS.second)).toBe(`<p class="factory-badge">${HINT} ${FALLBACK}</p>`);
    expect(cause(open(), ["umami"], CLOCKS.lastEvening)).toContain(HINT);
    expect(cause(closed(), ["umami", "task-report"], CLOCKS.second)).toBe(`<p class="factory-badge">${HINT}</p>`);
  });

  it("adds nothing on an open day, without Umami, or under another item's problems", () => {
    expect(cause(open(), ["umami"], CLOCKS.sixth)).toBe("");
    expect(cause(closed(), ["task-report"], CLOCKS.second)).toBe("");
    const value = interpretation(["umami"]);
    const other = value.items.find((entry) => entry.bug_type_id === "concurrency");
    if (other === undefined) throw new Error("fixture");
    expect(renderToStaticMarkup(<CalendarCause capabilities={closed()} requestedHosts={["umami"]} item={other} nowMs={CLOCKS.second} />)).toBe("");
  });
});

describe("Validate case on a blocked day", () => {
  const status = () => parseContract("RequestStatus", fixture("status-fulfilled"));
  const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>Validate case<\/button>/g)].map((match) => match[1] ?? "");
  const umamiIndex = status().cases.findIndex((item) => item.host_id === "umami");
  const taskIndex = status().cases.findIndex((item) => item.host_id === "task-report");

  it("disables an Umami case's validation with the reason and leaves a task-and-report case alone", () => {
    const html = renderToStaticMarkup(<FactoryProgress status={status()} busy={false} onStop={() => undefined} onValidate={() => undefined} closedHosts={calendarClosedHosts(open(), CLOCKS.lastEvening)} />);
    const umamiCase = status().cases[umamiIndex]?.case_id ?? "";
    expect(buttons(html)[umamiIndex]).toBe(` type="button" disabled="" aria-describedby="factory-calendar-${umamiCase}"`);
    expect(html).toContain(`<p id="factory-calendar-${umamiCase}" class="factory-badge">${HINT}</p>`);
    expect(buttons(html)[taskIndex]).toBe(' type="button"');
  });

  it("keeps both cases' validation on an open day", () => {
    const html = renderToStaticMarkup(<FactoryProgress status={status()} busy={false} onStop={() => undefined} onValidate={() => undefined} closedHosts={calendarClosedHosts(open(), CLOCKS.sixth)} />);
    expect(buttons(html)).toEqual([' type="button"', ' type="button"']);
    expect(html).not.toContain(HINT);
  });
});

describe("the calendar clock on a page left open", () => {
  afterEach(() => { vi.useRealTimers(); });
  const closure = at("2026-11-01T23:15:00Z");

  it("waits for the next close or open instant, within the setTimeout limit", () => {
    expect(nextCalendarChange(CLOCKS.beforeWindow, WINDOW_S * 1000)).toBe(closure);
    expect(calendarBlocks(closure - 1, closure - 1 + WINDOW_S * 1000)).toBe(false);
    expect(calendarBlocks(closure, closure + WINDOW_S * 1000)).toBe(true);
    expect(nextCalendarChange(CLOCKS.second, WINDOW_S * 1000)).toBe(CLOCKS.sixth);
    expect(nextCalendarChange(CLOCKS.sixth, WINDOW_S * 1000)).toBe(at("2026-12-01T23:15:00Z"));
    expect(calendarClockDelay(open(), CLOCKS.beforeWindow)).toBe(closure - CLOCKS.beforeWindow);
    expect(calendarClockDelay(open(), CLOCKS.sixth)).toBe(2_147_483_647);
    expect(calendarClockDelay(null, CLOCKS.sixth)).toBeNull();
  });

  it("disables Validate case with the reason once the scheduled tick crosses the closure", () => {
    vi.useFakeTimers({ now: at("2026-11-01T23:00:00Z") });
    const render = (nowMs: number) => renderToStaticMarkup(<FactoryProgress status={parseContract("RequestStatus", fixture("status-fulfilled"))} busy={false} onStop={() => undefined} onValidate={() => undefined} closedHosts={calendarClosedHosts(open(), nowMs)} />);
    let clock = Date.now();
    const before = render(clock);
    expect(before).not.toContain(HINT);
    expect(before).not.toMatch(/disabled=""[^>]*>Validate case/);
    const delay = calendarClockDelay(open(), clock);
    if (delay === null) throw new Error("no tick scheduled");
    setTimeout(() => { clock = Date.now(); }, delay);
    vi.advanceTimersByTime(delay);
    expect(clock).toBe(closure);
    const after = render(clock);
    expect(after).toContain(HINT);
    expect(after).toMatch(/<button type="button" disabled="" aria-describedby="factory-calendar-[^"]+">Validate case<\/button>/);
  });
});

describe("the designer and the request form on a blocked day", () => {
  const written = ([{ type: "query", query: "date/time bugs" }, { type: "search" }, { type: "shapes", result: SHAPES }, { type: "pick_shape", shapeId: SHAPES.shapes[0]?.id ?? "" },
    { type: "write" }, { type: "spec", result: SPEC, specFor: specKey(SHAPES.shapes[0]?.id ?? "", "umami") }] as DesignerAction[]).reduce(designerReducer, INITIAL_DESIGNER);
  const designer = (capabilities: Capabilities, closedHosts?: readonly string[]) => renderToStaticMarkup(<BugDesignerView signedIn capabilities={capabilities} closedHosts={closedHosts}
    applyBlocked={null} onUsePlan={() => undefined} state={written} dispatch={() => undefined} onSearch={() => undefined} onWrite={() => undefined} />);

  it("gives the calendar reason instead of a plan for Umami", () => {
    for (const html of [designer(closed()), designer(open(), calendarClosedHosts(open(), CLOCKS.second))]) {
      expect(html).toContain(`<p class="factory-badge">${HINT} ${FALLBACK}</p>`);
      expect(html).not.toContain("can fill the request form yet");
      expect(html).not.toContain("Use this plan</button>");
    }
    expect(designer(open(), calendarClosedHosts(open(), CLOCKS.sixth))).toContain("Use this plan</button>");
  });

  it("disables the Umami checkbox with the reason and keeps its label", () => {
    const html = renderToStaticMarkup(<FactoryRequestForm capabilities={closed()} disabled={false} {...callbacks} />);
    expect(html).toContain('<input type="checkbox" disabled="" aria-describedby="factory-calendar-umami"/> Umami — Umami web analytics at a pinned upstream revision.</label>');
    expect(html).toContain(`<p id="factory-calendar-umami" class="factory-badge">${HINT}</p>`);
    expect(html).toMatch(/<input type="checkbox" checked=""\/> Task and report service —/);
    const fromClock = renderToStaticMarkup(<FactoryRequestForm capabilities={open()} closedHosts={calendarClosedHosts(open(), CLOCKS.lastMinute)} disabled={false} {...callbacks} />);
    expect(fromClock).toContain('<input type="checkbox" disabled="" aria-describedby="factory-calendar-umami"/> Umami —');
  });

  it("lets a visitor remove an Umami pick made before the window and changes nothing on an open day", () => {
    const plan = { key: 1, host_id: "umami" as const, bug_type_id: "date_time" as const, description: "", exact: false };
    const picked = renderToStaticMarkup(<FactoryRequestForm capabilities={open()} plan={plan} closedHosts={["umami"]} disabled={false} {...callbacks} />);
    expect(picked).toContain('<input type="checkbox" aria-describedby="factory-calendar-umami" checked=""/> Umami —');
    const openDay = renderToStaticMarkup(<FactoryRequestForm capabilities={open()} closedHosts={calendarClosedHosts(open(), CLOCKS.sixth)} disabled={false} {...callbacks} />);
    expect(openDay).toContain('<input type="checkbox"/> Umami —');
    expect(openDay).not.toContain(HINT);
  });
});
