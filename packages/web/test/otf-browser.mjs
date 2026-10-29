/* global document, innerWidth */
// On-the-fly (OTF) bug creation, browser proof over local HTTP in test mode: the fake builder
// (src/otf/test-mode/fake-builder.ts) plays a SYNTHETIC timeline, and a loopback stub answers the
// bug designer's model call. No machine starts, no model is called and nothing is spent.
//
// The OTF UI is built on another branch (W3, otf/ui). Every selector and button name below is written
// against the component names and copy in docs/otf/SPEC.md and is marked TO CONFIRM; adjust them to
// the components once that branch lands. The scenario reset route is a proposal too (TO CONFIRM).
//
// Server (a dedicated, single-process local server; the stub port must match the last argument):
//   VERCEL_ENV=development RBW_FACTORY_TEST_MODE=1 RBW_JUDGE_PASSCODE=synthetic-factory-passcode \
//   RBW_ASSIST_TOKEN_FACTORY_KEY=synthetic-key RBW_ASSIST_TAVILY_KEY=synthetic-key \
//   RBW_ASSIST_TEST_PROVIDER_ORIGIN=http://127.0.0.1:4010 RBW_OTF_BUILDER_SECRET=synthetic-otf-secret \
//   pnpm --filter @rbw/web dev --port 3033
// Proof, from packages/web:
//   node test/otf-browser.mjs <playwright-index.mjs> <chromium> http://localhost:3033 <output-dir> [stub-port]
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import http from "node:http";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { validateOtf } from "../src/otf/schemas.ts";
import { OTF_TEST_GRADER_SENTINEL } from "../src/otf/test-mode/fake-builder.ts";
import { REASON_TEXT } from "../src/otf/test-mode/timeline.ts";
import { factoryJson, signInToFactory } from "./factory-browser-journey.mjs";

const [modulePath, executablePath, origin, outputDir, stubPortArg = "4010"] = process.argv.slice(2);
if (!modulePath || !executablePath || !origin || !outputDir) {
  throw new Error("Provide Playwright module, Chromium, local test-mode origin, output directory and optionally the stub port.");
}
const address = new URL(origin);
if (address.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(address.hostname) || address.pathname !== "/") {
  throw new Error("The OTF browser proof requires a dedicated local HTTP server in test mode.");
}
const stubPort = Number(stubPortArg);
assert(Number.isInteger(stubPort) && stubPort > 0 && stubPort < 65536, "the stub port is a TCP port");

// ---- the loopback stub for the bug designer's provider calls (an invented, in-scope card)

const STUB_CARD = {
  in_scope: true,
  title: "Synthetic: a saved value can go missing",
  where: "An invented list component that saves values in the task-and-report service.",
  change: "Two quick saves can drop one value.",
  why_tests_miss: "The invented suite saves one value at a time.",
  checks_to_add: ["Two overlapping saves both appear in the list."],
  fix: "Apply the saves in order.",
};
const stubCalls = [];
const stub = http.createServer((request, response) => {
  stubCalls.push(request.url);
  request.resume();
  request.on("end", () => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/chat/completions") {
      response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(STUB_CARD) } }] }));
    } else if (request.url === "/search") {
      response.end(JSON.stringify({ results: [] }));
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
});
await new Promise(resolve => stub.listen(stubPort, "127.0.0.1", resolve));
// The stub never keeps the process alive on its own (for example when the browser fails to launch).
stub.unref();

// ---- selectors and copy, TO CONFIRM against W3's components (docs/otf/SPEC.md sections 1 and 6)

const UI = {
  // TO CONFIRM: the behavior picker (one option per availability behavior, with its label).
  behaviorPicker: page => page.locator(".otf-behavior-picker"),
  behaviorOption: (page, label) => page.locator(".otf-behavior-picker").getByRole("radio", { name: label }),
  // TO CONFIRM: the customer's own sentence (3 to 300 characters).
  sentence: page => page.getByLabel("Describe the bug in one sentence", { exact: true }),
  // TO CONFIRM: the button that asks the bug designer for the card.
  writeCard: page => page.getByRole("button", { name: "Write the spec card", exact: true }),
  // TO CONFIRM: the spec accept view and its accept button.
  specAccept: page => page.locator(".otf-spec-accept"),
  accept: page => page.getByRole("button", { name: "Accept and build", exact: true }),
  // TO CONFIRM: the catalog offer card shown at accept time and on failure.
  catalogOffer: page => page.locator(".otf-catalog-offer"),
  // TO CONFIRM: the lane board, its lane cards and each card's six-cell grid.
  laneBoard: page => page.locator(".otf-lane-board"),
  laneCard: page => page.locator(".otf-lane-card"),
  sixCellGrid: page => page.locator(".otf-six-cell-grid"),
  // TO CONFIRM: the certificate and the failure view.
  certificate: page => page.locator(".otf-certificate"),
  failure: page => page.locator(".otf-failure"),
  // TO CONFIRM: the stop button and the two bundle download links.
  stop: page => page.getByRole("button", { name: "Stop the build", exact: true }),
  downloadAgent: page => page.getByRole("link", { name: "Download agent bundle", exact: true }),
  downloadGrader: page => page.getByRole("link", { name: "Download grader bundle", exact: true }),
};

const COPY = {
  // SPEC section 6. The model label is the test lane's invented one.
  built: "Built for your request by Goose with Synthetic Model A on Nebius Token Factory. Spec card by Nemotron 3 Super.",
  certificate: "Qualified by the RBW harness on the RBW builder (Nebius VM): six cells, pinned task-report kit image, 4 vCPU / 8 GB per copy, then confirmed in a second round.",
  notQualified: "No lane produced a bug that passed all six cells in 3 rounds.",
  startCatalog: "Start the closest catalog bug",
};

// ---- the proof

const { chromium } = await import(pathToFileURL(modulePath).href);
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const results = [];
const json = (context, method, path, data, expected = 200) => factoryJson(context, origin, method, path, data, expected);

/** Every OTF JSON body the page receives: each must match its schema and none may carry grader material. */
function watchOtf(page, bodies) {
  page.on("response", async response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/factory/otf/") || path.includes("/artifacts/")) return;
    const text = await response.text().catch(() => "");
    bodies.push({ path, status: response.status(), text });
  });
}

function checkBodies(bodies) {
  for (const { path, status, text } of bodies) {
    assert(!text.includes(OTF_TEST_GRADER_SENTINEL), `${path} carries grader material`);
    if (text === "") continue;
    const body = JSON.parse(text);
    const name = status >= 400 ? "OtfErrorBody"
      : path === "/api/factory/otf/availability" ? "OtfAvailability"
        : path === "/api/factory/otf/jobs" ? "OtfCreateResponse"
          : /^\/api\/factory\/otf\/jobs\/[^/]+(\/stop)?$/.test(path) ? "OtfJobStatus"
            : null;
    if (name !== null) assert.deepEqual(validateOtf(name, body), [], `${path} matches ${name}`);
  }
}

/** Picks a behavior, writes the sentence, gets the card and accepts it; answers the create response. */
async function acceptCard(page) {
  const availability = await json(page.context(), "get", "/api/factory/otf/availability");
  assert.equal(availability.enabled, true, "OTF is enabled in local test mode");
  const behavior = availability.behaviors[0];
  assert(behavior, "availability offers at least one behavior");
  await UI.behaviorPicker(page).waitFor();
  await UI.behaviorOption(page, behavior.label).check();
  await UI.sentence(page).fill("Two quick saves in a row lose one of them.");
  const [designed] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/assist/bug-spec"),
    UI.writeCard(page).click(),
  ]);
  assert.equal(designed.status(), 200);
  await UI.specAccept(page).getByText(STUB_CARD.title).waitFor();
  const [created] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/otf/jobs"),
    UI.accept(page).click(),
  ]);
  assert.equal(created.status(), 201);
  const body = await created.json();
  assert.deepEqual(validateOtf("OtfCreateResponse", body), []);
  // The catalog bug is offered at once and never started automatically.
  await UI.catalogOffer(page).waitFor();
  return body;
}

async function status(context, id) {
  return json(context, "get", `/api/factory/otf/jobs/${id}?after=0`);
}

async function scenario(name, width, run, label = name) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const errors = [], bodies = [];
  page.on("pageerror", error => errors.push(error.message));
  watchOtf(page, bodies);
  try {
    // TO CONFIRM: a test-mode-only reset route (404 outside test mode), proposed for W2 to mount on
    // OtfTestWorld.reset; never substitute live routes if it is absent.
    const reset = await json(context, "post", "/api/factory/otf/test/reset", { scenario: name });
    assert.equal(reset.scenario, name);
    await signInToFactory(page, origin);
    await run({ context, page });
    assert.deepEqual(errors, []);
    checkBodies(bodies);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal page scroll");
    await page.screenshot({ path: join(outputDir, `otf-${label}-${width}.png`), fullPage: true });
    results.push({ scenario: name, journey: label, width, passed: true });
    console.log(`PASS OTF test-mode HTTP/browser ${width}px: ${label}`);
  } finally {
    await context.close();
  }
}

try {
  for (const width of [1440, 390]) await scenario("delivered", width, async ({ context, page }) => {
    const { job_id: id } = await acceptCard(page);
    // The machine starts first, then three lanes race.
    await UI.laneBoard(page).waitFor();
    await page.screenshot({ path: join(outputDir, `otf-delivered-${width}-starting.png`), fullPage: true });
    await UI.laneCard(page).nth(2).waitFor();
    assert.equal(await UI.laneCard(page).count(), 3);
    await UI.sixCellGrid(page).first().waitFor();
    await page.screenshot({ path: join(outputDir, `otf-delivered-${width}-racing.png`), fullPage: true });
    await UI.certificate(page).waitFor();
    await page.getByText(COPY.certificate, { exact: true }).waitFor();
    await page.getByText(COPY.built, { exact: true }).waitFor();
    const done = await status(context, id);
    assert.equal(done.outcome, "delivered");
    assert.equal(done.winner?.lane_id, "lane-1");
    assert.deepEqual(done.lanes.map(lane => lane.outcome), ["won", "lost_race", "lost_race"]);
    assert.equal(done.artifacts.length, 3);
    // The two bundles download as gzip; only the grader bundle holds grader material.
    for (const [part, link] of [["agent", UI.downloadAgent(page)], ["grader", UI.downloadGrader(page)]]) {
      const href = await link.getAttribute("href");
      assert.equal(href, `/api/factory/otf/jobs/${id}/artifacts/${part}`);
      const response = await context.request.get(origin + href);
      assert.equal(response.status(), 200);
      const bytes = Buffer.from(await response.body());
      assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b]);
      assert.equal(gunzipSync(bytes).toString("latin1").includes(OTF_TEST_GRADER_SENTINEL), part === "grader");
    }
    // A reload resumes the same job from the client's own saved key.
    await page.reload();
    await UI.certificate(page).waitFor();
  });

  await scenario("not_qualified", 390, async ({ context, page }) => {
    const { job_id: id } = await acceptCard(page);
    await UI.failure(page).waitFor();
    await page.getByText(COPY.notQualified, { exact: true }).waitFor();
    await UI.catalogOffer(page).getByRole("button", { name: COPY.startCatalog, exact: true }).waitFor();
    const done = await status(context, id);
    assert.equal(done.outcome, "not_qualified");
    assert.equal(done.reason, REASON_TEXT.not_qualified);
    assert(done.lanes.every(lane => lane.rounds.length === 3 && lane.outcome === "not_qualified"));
    assert.equal(done.artifacts.length, 0);
  });

  await scenario("builder_start_failed", 390, async ({ context, page }) => {
    const { job_id: id } = await acceptCard(page);
    await UI.failure(page).waitFor();
    // An infrastructure error, never worded as the models failing (SPEC section 6).
    assert.equal(await UI.failure(page).getByText(COPY.notQualified, { exact: true }).count(), 0);
    await UI.catalogOffer(page).getByRole("button", { name: COPY.startCatalog, exact: true }).waitFor();
    const done = await status(context, id);
    assert.equal(done.outcome, "builder_start_failed");
    assert.equal(done.lanes.length, 0);
  });

  await scenario("time_limit", 1440, async ({ context, page }) => {
    // About 47 s at the default test speed (a 45-minute deadline at 60x).
    const { job_id: id } = await acceptCard(page);
    await UI.laneBoard(page).waitFor();
    await UI.failure(page).waitFor();
    const done = await status(context, id);
    assert.equal(done.outcome, "time_limit");
    assert(done.lanes.every(lane => lane.outcome === "cancelled"));
  });

  await scenario("delivered", 390, async ({ context, page }) => {
    // A customer stop while the lanes race ends the job cancelled.
    const { job_id: id } = await acceptCard(page);
    await UI.laneCard(page).first().waitFor();
    const [stopped] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/factory/otf/jobs/${id}/stop`),
      UI.stop(page).click(),
    ]);
    assert.equal(stopped.status(), 202);
    await UI.failure(page).waitFor();
    const done = await status(context, id);
    assert.equal(done.outcome, "cancelled");
    assert(done.lanes.every(lane => lane.outcome === "cancelled"));
  }, "delivered-stopped");

  assert(stubCalls.includes("/v1/chat/completions"), "the designer called the loopback stub, not a provider");
  fs.writeFileSync(join(outputDir, "otf-results.json"), JSON.stringify({ proof: "Local HTTP/UI with the synthetic OTF test-mode builder only; no machine, model or production call", results }, null, 2) + "\n");
} finally {
  await browser.close();
  stub.close();
}
