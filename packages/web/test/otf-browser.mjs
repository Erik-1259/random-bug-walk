/* global document, innerWidth */
// On-the-fly (OTF) bug creation, browser proof over local HTTP in test mode: the fake builder
// (src/otf/test-mode/fake-builder.ts) plays a SYNTHETIC timeline, and a loopback stub answers the
// bug designer's model call. No machine starts, no model is called and nothing is spent.
//
// The OTF UI is built on another branch (W3, otf/ui). Every selector and button name below is written
// against the component names and copy in docs/otf/SPEC.md and is marked TO CONFIRM; adjust them to
// the components once that branch lands. The scenario reset route is a proposal too (TO CONFIRM).
//
// In test mode the world (otfTestWorld()) supplies the store, the power port, the clock (now()) and
// the per-host config (hosts: both hosts enabled, invented lanes, typical null), so no lane or host
// variable is set below (TO CONFIRM against W2's test-mode wiring).
//
// Server (a dedicated, single-process local server; the stub port must match the last argument). The
// builder secret is an invented, test-only value of the required length; no builder calls in:
//   VERCEL_ENV=development RBW_FACTORY_TEST_MODE=1 RBW_JUDGE_PASSCODE=synthetic-factory-passcode \
//   RBW_ASSIST_TOKEN_FACTORY_KEY=synthetic-key RBW_ASSIST_TAVILY_KEY=synthetic-key \
//   RBW_ASSIST_TEST_PROVIDER_ORIGIN=http://127.0.0.1:4010 \
//   RBW_OTF_BUILDER_SECRET=synthetic-otf-test-mode-builder-secret-only \
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
import { specSha256 } from "../src/otf/canonical.ts";
import { validateOtf } from "../src/otf/schemas.ts";
import { OTF_TEST_GRADER_SENTINEL } from "../src/otf/test-mode/fake-builder.ts";
import { REASON_TEXT, UMAMI_CALENDAR_REASON } from "../src/otf/test-mode/timeline.ts";
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

// ---- the loopback stub for the bug designer's provider calls (an invented, in-scope card per host)

const STUB_CARDS = {
  "task-report": {
    in_scope: true,
    title: "Synthetic: a saved value can go missing",
    where: "An invented list component that saves values in the task-and-report service.",
    change: "Two quick saves can drop one value.",
    why_tests_miss: "The invented suite saves one value at a time.",
    checks_to_add: ["Two overlapping saves both appear in the list."],
    fix: "Apply the saves in order.",
  },
  umami: {
    in_scope: true,
    title: "Synthetic: a late visit lands on the next day",
    where: "An invented daily report that groups visits by day.",
    change: "A visit just after midnight in a far time zone is counted on the wrong day.",
    why_tests_miss: "The invented suite only uses visits at noon UTC.",
    checks_to_add: ["A visit at 00:30 in a far time zone appears on its own local day."],
    fix: "Group the visits by the viewer's time zone.",
  },
};
const SENTENCES = { "task-report": "Two quick saves in a row lose one of them.", umami: "A late visit lands on the next day in the daily report." };
/** The card the stub answers with; each journey sets it for its host. */
let STUB_CARD = STUB_CARDS["task-report"];
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
  // TO CONFIRM: the Umami admission strip beside a round's grid, and the certificate's confirmation row.
  admissionStrip: page => page.locator(".otf-admission-strip"),
  confirmationRow: page => page.locator(".otf-certificate .otf-confirmation"),
  // TO CONFIRM: an unavailable host's reason line in the picker.
  hostReason: (page, label) => page.locator(".otf-behavior-picker .otf-host-unavailable").filter({ hasText: label }),
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
  built: "Built for your request by Goose with Synthetic Model A on Nebius Token Factory. Spec card by Nemotron 3.5 Super.",
  certificate: "Qualified by the RBW harness on the RBW builder (Nebius VM): six cells, pinned task-report kit image, 4 vCPU / 8 GB per copy, then confirmed in a second round.",
  umamiCertificate: "Qualified on the RBW builder (Nebius VM) with the local runner's admission sequence (docs/admission-rules.md) on the pinned Umami kit image with this build's checks, 4 vCPU / 8 GB per copy. Development evidence, not an RBW release.",
  umamiPlacement: "The builder places the bug in one of Umami's date-grouped reports that its harness supports, chosen to match your card where it can. It may differ from the report your card describes.",
  umamiCalendar: UMAMI_CALENDAR_REASON,
  // Test mode measures no build time, so every host shows this (SPEC section 6, typical null).
  notMeasured: label => `Build times for ${label} are not measured yet. The board shows each step as it runs.`,
  notQualified: "No lane produced a bug that passed all six cells in 3 rounds.",
  startCatalog: "Start the closest catalog bug",
  // SPEC section 1.1: the admission strip labels.
  admissionLabels: [
    "Every copy ran every test",
    "Fixed copies pass the added checks",
    "Buggy copies fail as declared",
    "Repeated runs agree",
    "Partial and stub fixes are caught",
    "The original suite misses the bug",
    "A second, independent fix also passes",
  ],
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

/** Test mode's hosts: each appears once with no measured typical time. */
function checkHosts(availability) {
  assert.deepEqual(availability.hosts.map(entry => entry.host_id).sort(), ["task-report", "umami"]);
  for (const entry of availability.hosts) assert.equal(entry.typical, null, `${entry.host_id} has no measured typical time in test mode`);
}

/** Picks the host's behavior, writes the sentence, gets the card and accepts it; answers the create response. */
async function acceptCard(page, hostId = "task-report") {
  const availability = await json(page.context(), "get", "/api/factory/otf/availability");
  assert.equal(availability.enabled, true, "OTF is enabled in local test mode");
  checkHosts(availability);
  const behavior = availability.behaviors.find(option => option.host_id === hostId);
  assert(behavior, `availability offers a ${hostId} behavior`);
  STUB_CARD = STUB_CARDS[hostId];
  await UI.behaviorPicker(page).waitFor();
  const label = availability.hosts.find(entry => entry.host_id === hostId).label;
  await UI.behaviorOption(page, behavior.label).check();
  // TO CONFIRM: where W3 shows the time copy (picker or spec accept); typical is null in test mode.
  await page.getByText(COPY.notMeasured(label), { exact: true }).first().waitFor();
  await UI.sentence(page).fill(SENTENCES[hostId]);
  const [designed] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/assist/bug-spec"),
    UI.writeCard(page).click(),
  ]);
  assert.equal(designed.status(), 200);
  await UI.specAccept(page).getByText(STUB_CARD.title).waitFor();
  if (hostId === "umami") await UI.specAccept(page).getByText(COPY.umamiPlacement, { exact: true }).waitFor();
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
    // A deadline ends the lanes time_limit; cancelled is a customer stop only.
    assert(done.lanes.every(lane => lane.outcome === "time_limit"));
  });

  for (const width of [1440, 390]) await scenario("umami_delivered", width, async ({ context, page }) => {
    // About 30 s at the default test speed: two lanes, an ADM-04 rejection, then a round-2 win.
    const { job_id: id } = await acceptCard(page, "umami");
    await UI.laneBoard(page).waitFor();
    await UI.laneCard(page).nth(1).waitFor();
    await UI.admissionStrip(page).first().waitFor();
    for (const label of COPY.admissionLabels) await UI.admissionStrip(page).first().getByText(label, { exact: true }).waitFor();
    await page.screenshot({ path: join(outputDir, `otf-umami-${width}-racing.png`), fullPage: true });
    await UI.certificate(page).waitFor();
    await page.getByText(COPY.umamiCertificate, { exact: true }).waitFor();
    await page.getByText(COPY.built, { exact: true }).waitFor();
    // No confirmation round ran, so the certificate shows no confirmation row.
    assert.equal(await UI.confirmationRow(page).count(), 0);
    for (const word of ["admitted", "released", "on Vercel Sandbox"]) assert.equal(await UI.certificate(page).getByText(word).count(), 0, `the certificate never says "${word}"`);
    const done = await status(context, id);
    assert.equal(done.host_id, "umami");
    assert.equal(done.outcome, "delivered");
    assert.equal(done.winner?.lane_id, "lane-1");
    assert.deepEqual(done.lanes.map(lane => lane.outcome), ["won", "lost_race"]);
    assert.equal(done.certificate?.harness.tier, "admission");
    assert.equal(done.certificate?.qualification.confirmation_cells, null);
    assert.deepEqual(done.lanes[0].rounds.map(round => round.admission?.decisions.adm_04), ["reject", "pass"]);
    assert.equal(done.artifacts.length, 3);
  });

  await scenario("umami_calendar_blocked", 390, async ({ context, page }) => {
    // The world's clock is on UTC day 3: Umami is not offered and a direct create is refused.
    const availability = await json(context, "get", "/api/factory/otf/availability");
    checkHosts(availability);
    const umami = availability.hosts.find(entry => entry.host_id === "umami");
    assert.equal(umami.offered, false);
    assert.equal(umami.unavailable_reason, "calendar");
    assert(availability.behaviors.every(option => option.host_id !== "umami"), "no Umami behavior is offered");
    assert(availability.behaviors.some(option => option.host_id === "task-report"), "task-report stays offered");
    await UI.behaviorPicker(page).waitFor();
    await UI.hostReason(page, COPY.umamiCalendar).waitFor();
    const spec = { ...STUB_CARDS.umami };
    delete spec.in_scope;
    const body = { client_key: "00000000-0000-4000-8000-000000000008", host_id: "umami", criterion_id: "date_time.time-zone-grouping", sentence: SENTENCES.umami, spec, spec_sha256: await specSha256(spec) };
    const refused = await json(context, "post", "/api/factory/otf/jobs", body, 409);
    assert.deepEqual(validateOtf("OtfErrorBody", refused), []);
    assert.equal(refused.error.code, "host_unavailable");
    assert(refused.error.message.includes(COPY.umamiCalendar), "the refusal names the calendar");
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
