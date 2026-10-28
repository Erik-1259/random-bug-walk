import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseContract } from "@rbw/factory-contract/validate";
import { FactoryProgress } from "../src/components/factory-progress.tsx";
import type { RequestStatus, ValidationRun } from "../src/factory/client.ts";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/factory-v1/${name}.json`, import.meta.url), "utf8");
}
const statusFixture = (name: string) => parseContract("RequestStatus", fixture(name));
const validationFixture = (name: string) => parseContract("ValidationRun", fixture(name));
function render(status: RequestStatus | null, validation: ValidationRun | null = null, busy = false, options: { polling?: boolean; stopPending?: boolean; disabled?: boolean } = {}) {
  return renderToStaticMarkup(<FactoryProgress status={status} busy={busy} onStop={() => undefined} onValidate={() => undefined} validation={validation} {...options} />);
}
function validationButton(html: string) {
  return /<button([^>]*)>Validate case<\/button>/.exec(html)?.[1];
}

describe("factory contract progress", () => {
  it("does not invent progress when status is missing", () => {
    const html = render(null);
    expect(html).toContain("No request status is available");
    expect(html).not.toContain("Delivered cases");
    expect(html).not.toContain("Download");
  });

  it("keeps Stop available during polling without enabling validation or hiding delivered cases", () => {
    const status = statusFixture("status-partial-budget");
    status.state = "running";
    status.outcome = null;
    status.stop_reason = null;
    const html = render(status, null, true, { polling: true });
    const stop = /<button([^>]*)>Stop request<\/button>/.exec(html);
    expect(stop).not.toBeNull();
    expect(stop?.[1]).not.toContain("disabled");
    expect(validationButton(html)).toContain("disabled");
    for (const item of status.cases) {
      expect(html).toContain(item.title);
      expect(html).toContain(`href="${String(item.packages.bug_case.download_path)}"`);
      expect(html).toContain(`href="${String(item.packages.validator.download_path)}"`);
    }
  });

  it.each([
    { label: "pending stop", polling: true, stopPending: true, disabled: false, stopping: false },
    { label: "non-polling operation", polling: false, stopPending: false, disabled: false, stopping: false },
    { label: "signed-out controls", polling: true, stopPending: false, disabled: true, stopping: false },
    { label: "stopping request", polling: true, stopPending: false, disabled: false, stopping: true },
  ])("disables Stop during $label", ({ polling, stopPending, disabled, stopping }) => {
    const status = statusFixture("status-running");
    if (stopping) status.state = "stopping";
    const html = render(status, null, true, { polling, stopPending, disabled });
    expect(/<button([^>]*)>Stop request<\/button>/.exec(html)?.[1]).toContain("disabled");
  });

  it.each([
    ["status-fulfilled", "Fulfilled"],
    ["status-partial-budget", "Stopped at a limit"],
    ["status-exhausted", "Sources exhausted"],
    ["status-cancelled", "Cancelled"],
    ["status-operational-error", "Operational error"],
  ])("renders %s without dropping completed cases", (name, label) => {
    const status = statusFixture(name);
    const html = render(status);
    expect(html).toContain(`<h3>${label}</h3>`);
    for (const item of status.cases) {
      expect(html).toContain(item.title);
      expect(html).toContain(`href="${String(item.packages.bug_case.download_path)}"`);
      expect(html).toContain(`href="${String(item.packages.validator.download_path)}"`);
    }
    if (status.delivery === "partial") expect(html).toContain("Stopped with partial results");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("%");
  });

  it("shows supplied counts, item descriptions, budget and recorded events", () => {
    const status = statusFixture("status-partial-budget");
    const html = render(status);
    expect(html).toContain("Requested: 1; delivered: 1; missing: 0.");
    expect(html).toContain("Requested: 1; delivered: 0; missing: 1.");
    expect(html).toContain("I want a bug where an acknowledged change is lost when requests overlap");
    expect(html).toContain("<dt>Candidates explored</dt><dd>1</dd>");
    expect(html).toContain("<dt>Packages ready</dt><dd>1</dd>");
    expect(html).toContain("<dt>Remaining</dt><dd>$0.59</dd>");
    expect(html).toContain("Request finished: stopped at limit.");
    expect(html).toContain("Retries, rejected candidates and incomplete cases are not delivered bugs.");
    expect(html).toContain("skipped");
  });

  it("shows attention and preserves downloadable cases while disabling validation", () => {
    const status = statusFixture("status-fulfilled");
    status.attention = { code: "needs_reconciliation", message: "Synthetic uncertain operation needs reconciliation." };
    const html = render(status);
    expect(html).toContain("Attention required (needs_reconciliation)");
    expect(html).toContain("Download bug case");
    expect(validationButton(html)).toContain("disabled");
  });
  it("preserves a finished outcome when revision-2 reconciliation reports an overrun", () => {
    const status = statusFixture("status-fulfilled");
    status.budget = { ...status.budget, overrun: true, remaining_microusd: -1 };
    status.attention = { code: "needs_reconciliation", message: "Synthetic post-finish overrun." };
    const html = render(status);
    expect(html).toContain("<h3>Fulfilled</h3>");
    expect(html).toContain("budget overrun");
    expect(html).toContain("Download bug case");
    expect(validationButton(html)).toContain("disabled");
  });
  it("shows the revision-2 wrong-failure rejection without inventing a delivered case", () => {
    const html = render(statusFixture("status-wrong-failure"));
    expect(html).toContain("No qualified cases have been delivered");
    expect(html).toContain("rejected");
    expect(html).not.toContain("Download bug case");
  });

  it("defensively hides downloads and validation for an invalid case with unavailable parts", () => {
    const status = statusFixture("status-fulfilled");
    const item = status.cases[0];
    if (item === undefined) throw new Error("Missing fixture case");
    status.cases = [item];
    item.packages.bug_case.ready = false;
    item.packages.validator.download_path = null;
    const html = render(status);
    expect(html).not.toContain("href=");
    expect(html).toContain("Bug-case download is not ready");
    expect(html).toContain("Validator download is not ready");
    expect(validationButton(html)).toContain("disabled");
  });

  it.each(["bug_case", "validator"] as const)("defensively gates a missing %s path while retaining the other download", part => {
    for (const path of [null, ""]) {
      const status = statusFixture("status-fulfilled");
      const item = status.cases[0];
      if (item === undefined) throw new Error("Missing fixture case");
      status.cases = [item];
      // Mutate a validated fixture to exercise the fallback, not a valid service payload.
      item.packages[part].download_path = path;
      const other = part === "bug_case" ? "validator" : "bug_case";
      const html = render(status);
      expect(html).not.toContain('href=""');
      expect(html).toContain(`href="${String(item.packages[other].download_path)}"`);
      expect(html).toContain(part === "bug_case" ? "Bug-case download is not ready" : "Validator download is not ready");
      expect(validationButton(html)).toContain("disabled");
    }
  });

  it("enables validation only after finished request, with packages ready and sufficient budget", () => {
    const status = statusFixture("status-fulfilled");
    expect(validationButton(render(status))).not.toContain("disabled");
    expect(validationButton(render(status, null, true))).toContain("disabled");
    status.state = "running";
    status.outcome = null;
    expect(validationButton(render(status))).toContain("disabled");
    status.state = "finished";
    status.budget.remaining_microusd = 0;
    expect(validationButton(render(status))).toContain("disabled");
    expect(render(status)).toContain("remaining budget cannot cover validation");
  });

  it("shows actual running validation and disables another start", () => {
    const html = render(statusFixture("status-fulfilled"), validationFixture("validation-running"));
    expect(html).toContain("Validation: running");
    expect(html).not.toContain("<p>All six cells matched their expected outcomes.</p>");
    expect(validationButton(html)).toContain("disabled");
  });

  it.each([
    ["validation-passed", "All six cells matched their expected outcomes"],
    ["validation-failed", "at least one observed outcome differed"],
    ["validation-error", "could not establish a behavioral result"],
  ])("distinguishes %s using the finished service result", (name, message) => {
    const html = render(statusFixture("status-fulfilled"), validationFixture(name));
    expect(html).toContain(message);
  });

  it("leads with a plain budget line and keeps exact amounts, events, reasons and qualification under Details", () => {
    const status = statusFixture("status-partial-budget");
    const html = render(status);
    expect(html).toMatch(/<p class="factory-budget-line">Budget: \$[0-9.]+ spent of \$[0-9.]+, \$0\.59 left/);
    for (const summary of ["Budget and check counts", "Activity log (", "Why some candidate bugs were set aside (", "How cases qualify"]) expect(html).toContain(`<summary>${summary}`);
    expect(html).toMatch(/<details class="factory-details"><summary>Budget and check counts<\/summary><dl class="factory-metrics">/);
    expect(html).toMatch(/<details class="factory-details"><summary>Activity log \(\d+ events\)<\/summary><ol class="factory-events">/);
    const first = status.events[0];
    if (first === undefined) throw new Error("Missing fixture event");
    expect(html).toContain(`<time dateTime="${first.at}" title="${first.at}">`);
    expect(html).not.toContain(`>${first.at}<`);
    expect(html).toContain("Stopped because the rest of this request&#x27;s budget could not cover another attempt.");
    expect(html).toContain(status.stop_reason?.message.replaceAll("'", "&#x27;") ?? "missing");
  });

  it("shows a plain latest update while a request runs, and the run's duration once it finishes", () => {
    const running = render(statusFixture("status-running"));
    expect(running).toMatch(/Latest update \(\+\d+ min \d+ s\): A check finished on task-report\.<\/p>/);
    const finished = render(statusFixture("status-fulfilled"));
    expect(finished).toContain("finished after ");
    expect(finished).not.toContain("Latest update");
  });

  it("names bug types and hosts with the capabilities' labels when they are supplied", () => {
    const status = statusFixture("status-wrong-failure");
    const html = renderToStaticMarkup(<FactoryProgress status={status} busy={false} onStop={() => undefined} onValidate={() => undefined}
      labels={{ hosts: { umami: "Umami", "task-report": "Task and report service" }, bugTypes: { concurrency: "Concurrency", date_time: "Date and time" } }} />);
    const item = status.items[0];
    if (item === undefined) throw new Error("Missing fixture item");
    expect(html).toContain(`<strong>${item.bug_type_id === "concurrency" ? "Concurrency" : "Date and time"}</strong> <small>(${item.item_key})</small>`);
    expect(html).not.toContain(`<strong>${item.item_key}: ${item.bug_type_id}</strong>`);
  });

  it("does not serialize event data or arbitrary evaluator fields", () => {
    const status = statusFixture("status-fulfilled");
    const event = status.events[0];
    if (event === undefined) throw new Error("Missing fixture event");
    Object.assign(event, { data: { reference_fix: "synthetic-private-fix", verification_tests: "synthetic-private-checks" } });
    const html = render(status);
    expect(html).not.toContain("synthetic-private-fix");
    expect(html).not.toContain("synthetic-private-checks");
  });
});
