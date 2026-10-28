import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AssistFailure } from "../src/assist/client.ts";
import { currentSpec, designerReducer, INITIAL_DESIGNER, specKey, type DesignerAction, type DesignerState } from "../src/assist/designer-state.ts";
import { planFromShape } from "../src/assist/plan.ts";
import { BugDesignerView, CATALOG_HONESTY, DESIGNER_CREDIT, type BugDesignerViewProps } from "../src/components/bug-designer.tsx";
import { FactoryRequestForm, startingSelection } from "../src/components/factory-request-form.tsx";
import type { Capabilities } from "../src/factory/client.ts";
import { SHAPES, SPEC } from "./support/assist-fixtures.ts";

const capabilities = JSON.parse(readFileSync(new URL("./fixtures/factory-v1/capabilities.json", import.meta.url), "utf8")) as Capabilities;
const shape = SHAPES.shapes[0];
const unfit = SHAPES.shapes[1];
if (shape === undefined || unfit === undefined) throw new Error("fixture");

const run = (...actions: DesignerAction[]) => actions.reduce(designerReducer, INITIAL_DESIGNER);
function render(state: DesignerState, props: Partial<BugDesignerViewProps> = {}) {
  return renderToStaticMarkup(<BugDesignerView signedIn capabilities={capabilities} applyBlocked={null} onUsePlan={() => undefined}
    state={state} dispatch={() => undefined} onSearch={() => undefined} onWrite={() => undefined} {...props} />);
}
const failed = (failure: Partial<AssistFailure> & Pick<AssistFailure, "code">) => run({ type: "query", query: "date/time bugs" }, { type: "failed", failure: { message: null, retryAfterS: null, ...failure } });

describe("bug designer steps", () => {
  it("moves from query to shapes to a spec for the chosen shape and app, and drops a stale spec", () => {
    let state = run({ type: "query", query: "date/time bugs" }, { type: "search" });
    expect(state.busy).toBe("shapes");
    state = designerReducer(state, { type: "shapes", result: SHAPES });
    state = designerReducer(state, { type: "pick_shape", shapeId: shape.id });
    expect(state.hostId).toBe("umami"); // the fit's app is chosen first
    state = designerReducer(designerReducer(state, { type: "write" }), { type: "spec", result: SPEC, specFor: specKey(shape.id, "umami") });
    expect(currentSpec(state)).toEqual(SPEC);
    expect(currentSpec(designerReducer(state, { type: "pick_host", hostId: "task-report" }))).toBeNull();
    expect(designerReducer(state, { type: "search" }).shapes).toBeNull();
  });

  it("renders the query box, example chips, attribution and the catalog honesty line", () => {
    const html = render(INITIAL_DESIGNER);
    expect(html).toContain("Find a bug for your agent evaluation");
    for (const chip of ["date/time bugs", "race conditions", "lost updates"]) expect(html).toContain(`>${chip}</button>`);
    expect(html).toContain(DESIGNER_CREDIT.replace("·", "·"));
    expect(html).toContain(CATALOG_HONESTY);
    expect(html).toMatch(/<button class="factory-button" type="submit" disabled="">Find bug shapes<\/button>/);
    for (const match of html.matchAll(/<label for="([^"]+)"/g)) expect(html).toContain(`id="${match[1] ?? ""}"`);
    expect(render(run({ type: "query", query: "lost updates" }))).toMatch(/type="submit">Find bug shapes/);
  });

  it("asks a signed-out visitor to sign in first and shows no query box", () => {
    for (const html of [render(INITIAL_DESIGNER, { signedIn: false }), render(failed({ code: "signed_out" }))]) {
      expect(html).toContain("Sign in first");
      expect(html).not.toContain("designer-query");
    }
  });

  it("hides the designer behind a short note when it is unavailable", () => {
    const html = render(failed({ code: "unavailable" }));
    expect(html).toContain("The bug designer is unavailable right now. The request form below works exactly as before.");
    expect(html).toContain("Try the designer again");
    expect(html).not.toContain("designer-query");
    expect(designerReducer(failed({ code: "unavailable" }), { type: "retry" }).failure).toBeNull();
  });

  it("explains a refusal and a rate limit and keeps the query box", () => {
    const refused = render(failed({ code: "refused", message: "Security topics are out of scope." }));
    expect(refused).toContain("non-security bugs only");
    expect(refused).toContain("Security topics are out of scope.");
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("designer-query");
    expect(render(failed({ code: "rate_limited", retryAfterS: 20 }))).toContain("Try again in 20 seconds.");
  });

  it("announces loading in a live region and disables the search", () => {
    const html = render(run({ type: "query", query: "date/time bugs" }, { type: "search" }));
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Searching public bug reports");
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/type="submit" disabled="">Find bug shapes/);
  });

  it("lists shapes with sources and their proven fit, then the target app step", () => {
    const listed = run({ type: "query", query: "date/time bugs" }, { type: "search" }, { type: "shapes", result: SHAPES });
    let html = render(listed);
    expect(html).toContain("Found 2 bug shapes from 8 public results.");
    expect(html).toContain(shape.title);
    expect(html).toContain("Closest proven bug: Umami, Date and time — “daily totals use the wrong time zone”.");
    expect(html).toContain("No proven bug in the catalog matches this shape yet.");
    expect(html).toContain('href="https://example.org/issues/101" target="_blank" rel="noopener noreferrer nofollow"');
    expect(html).not.toContain("Step 3");
    html = render(designerReducer(listed, { type: "pick_shape", shapeId: shape.id }));
    expect(html).toContain("Step 3: choose the target application");
    expect(html).toContain('name="designer-host" checked="" value="umami"');
  });

  it("labels the spec as a design and offers the plan, blocked while a request runs", () => {
    const written = run({ type: "query", query: "date/time bugs" }, { type: "search" }, { type: "shapes", result: SHAPES }, { type: "pick_shape", shapeId: shape.id },
      { type: "write" }, { type: "spec", result: SPEC, specFor: specKey(shape.id, "umami") });
    const html = render(written);
    expect(html).toContain("Design, not a built bug");
    expect(html).toContain(SPEC.spec.why_tests_miss);
    expect(html).toContain("Group events near midnight in a non-UTC zone");
    expect(html).toContain("described as “daily totals use the wrong time zone”");
    expect(html).toMatch(/<button type="button" class="factory-button">Use this plan<\/button>/);
    const blocked = render(written, { applyBlocked: "A request is in progress on this page." });
    expect(blocked).toContain("A request is in progress on this page.");
    expect(blocked).toMatch(/disabled="">Use this plan/);
    expect(render(designerReducer(written, { type: "applied", appliedFor: specKey(shape.id, "umami") }))).toContain("The request form below now holds this plan.");
  });
});

describe("Use this plan", () => {
  it("uses the shape's proven fit on its own app, else the app's closest proven pair", () => {
    expect(planFromShape(shape, "umami", capabilities, 1)).toEqual({ key: 1, host_id: "umami", bug_type_id: "date_time", description: "daily totals use the wrong time zone", exact: true });
    expect(planFromShape(shape, "task-report", capabilities, 2)).toEqual({ key: 2, host_id: "task-report", bug_type_id: "concurrency", description: "", exact: false });
    expect(planFromShape(unfit, "umami", capabilities, 3)).toMatchObject({ bug_type_id: "date_time", exact: false });
    expect(planFromShape({ ...shape, fit: { host_id: "umami", bug_type_id: "concurrency", phrase: "lost update" } }, "umami", capabilities, 4)).toMatchObject({ bug_type_id: "date_time", description: "", exact: false });
    expect(planFromShape(shape, "umami", null, 5)).toBeNull();
  });

  it("fills the request form's app, bug type and description from the plan", () => {
    const plan = planFromShape(shape, "umami", capabilities, 7);
    expect(startingSelection(capabilities, plan)).toEqual({ hosts: ["umami"], bugTypeId: "date_time", description: "daily totals use the wrong time zone", fromPlan: true });
    const html = renderToStaticMarkup(<FactoryRequestForm capabilities={capabilities} disabled={false} plan={plan} onInterpret={() => undefined} onChange={() => undefined} />);
    expect(html.match(/<input type="checkbox" checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/<input type="checkbox" checked=""\/> Umami —/);
    expect(html).toContain('<option value="date_time" selected="">');
    expect(html).toContain(">daily totals use the wrong time zone</textarea>");
    expect(html).toContain("Filled from your bug design.");
    // Without a plan the form keeps its usual default.
    expect(startingSelection(capabilities, null)).toMatchObject({ hosts: ["task-report"], bugTypeId: "concurrency", fromPlan: false });
  });
});
