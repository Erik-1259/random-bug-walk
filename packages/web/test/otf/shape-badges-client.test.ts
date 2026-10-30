import { afterEach, describe, expect, it, vi } from "vitest";
import { createOtfClient, OTF_CLASSIFY_TIMEOUT_MS } from "../../src/otf/client.ts";
import { OTF_ERROR_STATUS } from "../../src/otf/contract.ts";
import { OTF_CLASSIFY_SHAPES_PATH, type OtfShapeBadges, type OtfShapeBadgesRequest } from "../../src/otf/shape-badges-contract.ts";

const request: OtfShapeBadgesRequest = {
  query: "Synthetic task update failures", host_id: "task-report",
  shapes: [
    { title: "Synthetic overlapping writes", summary: "Overlapping task writes lose an acknowledged change." },
    { title: "Synthetic missing report", summary: "The daily report omits a completed task." },
    { title: "Synthetic unsupported operation", summary: "An unsupported operation cannot be translated." },
  ],
};
const answer: OtfShapeBadges = {
  model: "synthetic-classifier",
  badges: [
    { index: 0, outcome: "proven", proven_criterion_id: "concurrency.lost-acknowledged-change", family: "concurrency", translated_failure: null, refusal_kind: null, reason: null },
    { index: 1, outcome: "open", proven_criterion_id: null, family: "data_handling", translated_failure: "A daily task report omits a saved completion.", refusal_kind: null, reason: null },
    { index: 2, outcome: "refused", proven_criterion_id: null, family: null, translated_failure: null, refusal_kind: "out_of_scope", reason: "This synthetic behavior is outside the service." },
  ],
};

afterEach(() => { vi.useRealTimers(); });

describe("shape badge HTTP client", () => {
  it("posts one ordered request to the customer route and reads all badge outcomes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    expect(await createOtfClient(fetcher).classifyShapes(request)).toEqual(answer);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(OTF_CLASSIFY_SHAPES_PATH);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  });

  it("accepts the Umami proven criterion only for an Umami request", async () => {
    const umami: OtfShapeBadges = { model: "synthetic-classifier", badges: [{ index: 0, outcome: "proven", proven_criterion_id: "date_time.time-zone-grouping", family: "date_time", translated_failure: null, refusal_kind: null, reason: null }] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(Response.json(umami)));
    const client = createOtfClient(fetcher);
    expect(await client.classifyShapes({ ...request, host_id: "umami", shapes: request.shapes.slice(0, 1) })).toEqual(umami);
    await expect(client.classifyShapes({ ...request, shapes: request.shapes.slice(0, 1) })).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each(["duplicate-index", "missing-index", "outside-index", "wrong-host", "wrong-family", "extra-member", "control-character"] as const)("rejects a %s answer against the exact request", async kind => {
    const changed = structuredClone(answer);
    const first = changed.badges[0]; const second = changed.badges[1];
    if (first === undefined || second === undefined) throw new Error("Missing synthetic badges.");
    if (kind === "duplicate-index") second.index = first.index;
    if (kind === "missing-index") changed.badges.pop();
    if (kind === "outside-index") second.index = request.shapes.length;
    if (kind === "wrong-host" && first.outcome === "proven") { first.proven_criterion_id = "date_time.time-zone-grouping"; first.family = "date_time"; }
    if (kind === "wrong-family" && first.outcome === "proven") first.family = "state_ui";
    if (kind === "control-character" && second.outcome === "open") second.translated_failure = "The daily task report\nomits a saved completion.";
    const data = kind === "extra-member" ? { ...changed, unexpected: true } : changed;
    await expect(createOtfClient(vi.fn<typeof fetch>().mockResolvedValue(Response.json(data))).classifyShapes(request)).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each(["empty-query", "empty-shapes", "long-title"] as const)("refuses %s without sending a request", async kind => {
    const changed = structuredClone(request);
    if (kind === "empty-query") changed.query = "";
    if (kind === "empty-shapes") changed.shapes = [];
    if (kind === "long-title") changed.shapes = [{ title: "x".repeat(201), summary: "Synthetic summary." }];
    const fetcher = vi.fn<typeof fetch>();
    await expect(createOtfClient(fetcher).classifyShapes(changed)).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["signed_out", "invalid_request", "unavailable"] as const)("preserves the validated %s error for silent UI fallback", async code => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ contract_version: "otf/0", error: { code, message: "Synthetic badge failure.", retryable: code === "unavailable" } }, { status: OTF_ERROR_STATUS[code] }));
    await expect(createOtfClient(fetcher).classifyShapes(request)).rejects.toMatchObject({ code, status: OTF_ERROR_STATUS[code] });
  });

  it.each(["wrong-error", "wrong-success-status", "non-json", "network"] as const)("treats %s as unavailable", async kind => {
    const fetcher = vi.fn<typeof fetch>();
    if (kind === "network") fetcher.mockRejectedValue(new Error("Synthetic network failure."));
    else fetcher.mockResolvedValue(kind === "wrong-error"
      ? Response.json({ contract_version: "otf/0", error: { code: "busy", message: "Synthetic wrong error.", retryable: false } }, { status: OTF_ERROR_STATUS.busy })
      : kind === "wrong-success-status" ? Response.json(answer, { status: 201 }) : new Response("Synthetic non-JSON response."));
    await expect(createOtfClient(fetcher).classifyShapes(request)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("waits 65 seconds and aborts a stalled badge call without retrying", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | null = null;
    const fetcher = vi.fn<typeof fetch>((_path, options) => new Promise((_resolve, reject) => {
      signal = options?.signal ?? null;
      signal?.addEventListener("abort", () => { reject(new Error("Synthetic abort.")); });
    }));
    const pending = createOtfClient(fetcher).classifyShapes(request);
    const assertion = expect(pending).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(OTF_CLASSIFY_TIMEOUT_MS - 1);
    expect(signal).toMatchObject({ aborted: false });
    await vi.advanceTimersByTimeAsync(1); await assertion;
    expect(signal).toMatchObject({ aborted: true }); expect(fetcher).toHaveBeenCalledOnce();
  });

  it("validates against the sent host and shape count when the caller edits its request while waiting", async () => {
    let respond!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { respond = resolve; }));
    const editable = structuredClone(request);
    const pending = createOtfClient(fetcher).classifyShapes(editable);
    editable.host_id = "umami"; editable.shapes.pop();
    respond(Response.json(answer));
    expect(await pending).toEqual(answer);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(request));
  });
});
