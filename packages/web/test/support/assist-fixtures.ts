// Made-up /api/assist responses for the designer and delivery-brief tests. No provider wrote these.
import type { BriefResult, ShapesResult, SpecResult } from "../../src/assist/client.ts";

const MODEL = { provider: "nebius-token-factory", model_id: "nvidia/nemotron-3-super-120b-a12b", at: "2026-10-28T19:00:00.000Z" } as const;

export const SHAPES: ShapesResult = {
  shapes: [
    { id: "shape-1", title: "Daily buckets use the server’s time zone", summary: "Counts grouped by day land on the wrong day for viewers far from the server.",
      sources: [{ title: "Report: totals off by one day", url: "https://example.org/issues/101" }],
      fit: { host_id: "umami", bug_type_id: "date_time", phrase: "daily totals use the wrong time zone" }, fit_reason: "Matches the proven Umami date and time bug." },
    { id: "shape-2", title: "Recurring dates skip a daylight-saving hour", summary: "A schedule repeats at the wrong hour after a clock change.",
      sources: [], fit: null, fit_reason: "No catalog bug covers daylight-saving changes yet." },
  ],
  search: { provider: "tavily", query: "date/time bugs", at: "2026-10-28T18:59:50.000Z", result_count: 8 },
  model: MODEL,
};

export const SPEC: SpecResult = {
  spec: { title: "Group daily totals in the server’s zone", target_app: "Umami", where: "The query layer that buckets events by day.",
    change: "Bucket by the server’s zone instead of the requested one.", why_tests_miss: "The fixtures all use UTC.",
    checks_to_add: ["Group events near midnight in a non-UTC zone"], fix: "Use the requested zone when bucketing." },
  model: MODEL,
};

export const BRIEF: BriefResult = {
  brief: { what_it_is: "Daily totals land on the wrong day.", how_to_run: "Unpack the bug case and run its tests.", how_to_validate: "Give the agent’s fix to the validator package." },
  novelty: { provider: "tavily", checked_at: "2026-10-28T19:05:00.000Z", phrases: ["totals land on the wrong day"], public_matches: [] },
  caveat: "The planted change and its fix come from Random Bug Walk’s public catalog; this check covers only the report’s wording.",
  model: MODEL,
};
