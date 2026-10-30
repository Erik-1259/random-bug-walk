/* global document, innerWidth */
// On-the-fly (OTF) bug creation, browser proof over local HTTP in test mode: the fake builder
// (src/otf/test-mode/fake-builder.ts) plays a SYNTHETIC timeline, and a loopback stub answers the
// bug designer's model call. No machine starts, no model is called and nothing is spent.
//
// Run from the repository root after pnpm install --frozen-lockfile. Use two dedicated local
// Next servers in separate checkouts, because they write separate .next directories. The first has
// open behaviors enabled; the second has RBW_OTF_OPEN_BEHAVIORS absent. Both use only invented keys:
//   VERCEL_ENV=development RBW_FACTORY_TEST_MODE=1 RBW_JUDGE_PASSCODE=synthetic-factory-passcode \
//   RBW_ASSIST_TOKEN_FACTORY_KEY=synthetic-key RBW_ASSIST_TAVILY_KEY=synthetic-key \
//   RBW_ASSIST_TEST_PROVIDER_ORIGIN=http://127.0.0.1:4010 RBW_OTF_OPEN_BEHAVIORS=1 \
//   RBW_OTF_BUILDER_SECRET=synthetic-otf-test-mode-builder-secret-only \
//   pnpm --filter @rbw/web exec next dev --hostname 127.0.0.1 --port 3033
// Repeat in the second checkout on port 3034, omitting RBW_OTF_OPEN_BEHAVIORS entirely. Do not
// configure any live provider or database.
//
// Use Chromium and its system dependencies from mcr.microsoft.com/playwright:v1.63.0-noble,
// a matching Playwright 1.63.0 module, and Node 24.21 or later (this proof imports repository .ts).
// The browser image supplies its own browser path when the Chromium argument is auto. With a
// separately provisioned Playwright 1.63.0 tool directory (no repository dependency changes), run:
//   docker run --rm --network host --ipc=host \
//     --mount type=bind,src="$PWD",dst=/repo,readonly \
//     --mount type=bind,src="$(command -v node)",dst=/usr/local/bin/node,readonly \
//     --mount type=bind,src=<playwright-tool-directory>,dst=/playwright,readonly \
//     --mount type=bind,src=<output-directory>,dst=/proof \
//     mcr.microsoft.com/playwright:v1.63.0-noble \
//     node /repo/packages/web/test/otf-browser.mjs /playwright/node_modules/playwright/index.mjs \
//     auto http://127.0.0.1:3033 /proof 4010 http://127.0.0.1:3034
// Host networking is only for the local servers and stub; no external provider request is needed.
// The script itself starts/stops the stub on port 4010 after both Next servers are ready. The same
// invocation outside a container, when matching browser dependencies are already installed, is:
//   node packages/web/test/otf-browser.mjs <playwright-index.mjs> <chromium> \
//     http://127.0.0.1:3033 <output-dir> 4010 http://127.0.0.1:3034
// The final JSON and printed summary distinguish synthetic browser proof from real builds. Stop
// both owned Next servers after the proof; the finally block closes the browser and loopback stub.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs";
import http from "node:http";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { specSha256, ruleSha256 } from "../src/otf/canonical.ts";
import { OTF_OPEN_CRITERION_ID, OTF_OPEN_LABEL, OTF_OPEN_TIME_COPY } from "../src/otf/contract.ts";
import { validateOtf } from "../src/otf/schemas.ts";
import { OTF_TEST_GRADER_SENTINEL } from "../src/otf/test-mode/fake-builder.ts";
import { REASON_TEXT, UMAMI_CALENDAR_REASON } from "../src/otf/test-mode/timeline.ts";
import { factoryJson, signInToFactory } from "./factory-browser-journey.mjs";

const [modulePath, executablePath, origin, outputDir, stubPortArg = "4010", offOrigin] = process.argv.slice(2);
if (!modulePath || !executablePath || !origin || !outputDir || !offOrigin) {
  throw new Error("Provide Playwright module, Chromium, local test-mode origin, output directory, the stub port and a second local origin with open behaviors unset.");
}
for (const local of [origin, offOrigin]) {
  const address = new URL(local);
  if (address.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(address.hostname) || address.pathname !== "/" || address.username || address.password) {
    throw new Error("The OTF browser proof requires dedicated local HTTP servers in test mode.");
  }
}
assert.notEqual(origin, offOrigin, "feature-on and feature-off servers must be separate processes");
const stubPort = Number(stubPortArg);
assert(Number.isInteger(stubPort) && stubPort > 0 && stubPort < 65536, "the stub port is a TCP port");

// ---- the loopback stub for the bug designer's provider calls (an invented, in-scope card per host)

const STUB_CARDS = {
  "task-report": {
    in_scope: true,
    title: "Synthetic: a saved value can go missing",
    where: "An invented list component that saves values in the task-and-report service.",
    change: "Two overlapping saves both succeed but drop one stored value.",
    why_tests_miss: "The invented suite saves one value at a time.",
    checks_to_add: ["Two overlapping saves both appear in the list."],
    fix: "Apply the saves in order.",
  },
  umami: {
    in_scope: true,
    title: "Synthetic: a late visit lands on the next day",
    where: "An invented daily report that groups visits by day.",
    change: "Visits are grouped in UTC instead of the viewer's requested time zone.",
    why_tests_miss: "The invented suite only uses visits at noon UTC.",
    checks_to_add: ["A visit at 00:30 in a far time zone appears on its own local day."],
    fix: "Group the visits by the viewer's time zone.",
  },
};
const SENTENCES = { "task-report": "Two quick saves in a row lose one of them.", umami: "A late visit lands on the next day in the daily report." };
/** The card the stub answers with; each journey sets it for its host. */
let STUB_CARD = STUB_CARDS["task-report"];
let STUB_CLASSIFICATION = "proven";
let STUB_HOST = "task-report";
const OPEN_RULE = { family: "data_handling", observable_failure: "GET /api/tasks/{id} returns the previous title after a successful PATCH /api/tasks/{id}.", failure_code: "synthetic_title_missing" };
const SECURITY_REASON = "This synthetic card asks for security behavior, which is outside custom builds.";
const OPEN_CARD = { ...STUB_CARDS["task-report"], title: "Synthetic: a task title stays stale", change: "Reading a task after a sequential update returns the earlier title.",
  checks_to_add: ["Read a task after changing its title."], fix: "Return the saved title after an update." };
const SHAPES = ["Synthetic stale task title", "Synthetic omitted completion", "Synthetic report boundary"].map(title => ({
  title, summary: "A sequential task update leaves an earlier value in later reads.", source_numbers: [1], fit_host_id: "none", fit_bug_type_id: "none", fit_phrase: "", fit_reason: "No proven behavior matches this sequential update.",
}));
const stubCalls = [];
const stub = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    response.setHeader("content-type", "application/json");
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const schema = body.response_format?.json_schema?.name;
      stubCalls.push({ path: request.url, schema });
      if (request.url === "/v1/chat/completions") {
        let content;
        if (schema === "bug_spec") content = STUB_CARD;
        else if (schema === "bug_shapes") content = { in_scope: true, shapes: SHAPES };
        else if (schema === "otf_classification") content = STUB_CLASSIFICATION === "open"
          ? { decision: "open", proven_criterion_id: "none", ...OPEN_RULE, reason: "A synthetic sequential update is an open behavior." }
          : STUB_CLASSIFICATION === "security"
            ? { decision: "security", proven_criterion_id: "none", family: "none", observable_failure: "", failure_code: "", reason: SECURITY_REASON }
            : { decision: "proven", proven_criterion_id: STUB_HOST === "umami" ? "date_time.time-zone-grouping" : "concurrency.lost-acknowledged-change",
              family: STUB_HOST === "umami" ? "date_time" : "concurrency", observable_failure: "", failure_code: "", reason: "This synthetic card states the proven mechanism." };
        else throw new Error("Unexpected synthetic model schema.");
        response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }] }));
      } else if (request.url === "/search") response.end(JSON.stringify({ results: [{ title: "Synthetic task update report", url: "https://example.invalid/synthetic-task-report", content: "A task read returns an old title after a saved update." }] }));
      else { response.statusCode = 404; response.end("{}"); }
    } catch { response.statusCode = 400; response.end(JSON.stringify({ error: "Unexpected synthetic stub request." })); }
  });
});
await new Promise((resolve, reject) => { stub.once("error", reject); stub.listen(stubPort, "127.0.0.1", resolve); });
stub.unref();

// ---- accessible names and copy from the merged UI

const UI = {
  behaviorPicker: page => page.getByRole("form", { name: "Custom bug behavior", exact: true }),
  behaviorOption: (page, label) => UI.behaviorPicker(page).getByRole("radio", { name: label }),
  sentence: page => page.getByLabel("Describe it in one sentence", { exact: true }),
  writeCard: page => page.getByRole("button", { name: "Write my spec card", exact: true }),
  specAccept: page => page.getByRole("form", { name: "Accept custom spec", exact: true }),
  accept: page => page.getByRole("button", { name: "Accept and build this custom bug", exact: true }),
  catalogOffer: page => page.getByRole("region", { name: "Catalog alternative", exact: true }),
  laneBoard: page => page.getByRole("region", { name: "Custom build progress", exact: true }),
  laneCard: page => UI.laneBoard(page).locator("article.designer-card"),
  sixCellGrid: page => UI.laneBoard(page).getByRole("table"),
  admissionStrip: page => UI.laneBoard(page).getByRole("list", { name: / admission$/ }),
  confirmationRow: page => UI.certificate(page).getByRole("table", { name: "Confirmation cells", exact: true }),
  hostReason: (page, label) => UI.behaviorPicker(page).getByRole("status").filter({ hasText: label }),
  certificate: page => page.getByRole("region", { name: "Custom build certificate", exact: true }),
  failure: page => page.getByRole("region", { name: "Custom build outcome", exact: true }),
  stop: page => page.getByRole("button", { name: "Stop custom build", exact: true }),
  downloadAgent: page => UI.certificate(page).getByRole("link", { name: "Agent bundle", exact: true }),
  downloadGrader: page => UI.certificate(page).getByRole("link", { name: "Grader bundle", exact: true }),
  downloadCertificate: page => UI.certificate(page).getByRole("link", { name: "Certificate", exact: true }),
};

const COPY = {
  // SPEC section 6. The model label is the test lane's invented one.
  built: "Built for your request by Goose with synthetic/lane-model-a on Nebius Token Factory. Spec card by Nemotron 3 Super.",
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
let browser;
const results = [];
const json = (context, method, path, data, expected = 200) => factoryJson(context, origin, method, path, data, expected);

/** Every OTF JSON body the page receives: each must match its schema and none may carry grader material. */
function watchOtf(page, bodies, reads) {
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/api/factory/otf/") || path.includes("/artifacts/")) return;
    reads.push(response.text().then(text => { bodies.push({ path, status: response.status(), text }); }, error => { bodies.push({ path, error: error.message }); }));
  });
}

function checkBodies(bodies) {
  for (const { path, status, text, error } of bodies) {
    assert.equal(error, undefined, `${path} response body was collected`);
    assert(!text.includes(OTF_TEST_GRADER_SENTINEL), `${path} carries grader material`);
    if (text === "") continue;
    const body = JSON.parse(text);
    const name = status >= 400 ? "OtfErrorBody"
      : path === "/api/factory/otf/availability" ? "OtfAvailability"
        : path === "/api/factory/otf/jobs" ? "OtfCreateResponse"
          : path === "/api/factory/otf/classify" ? "OtfClassification"
            : /\/validations$/.test(path) ? "OtfValidation"
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
  STUB_CARD = STUB_CARDS[hostId]; STUB_HOST = hostId; STUB_CLASSIFICATION = "proven";
  await UI.behaviorPicker(page).waitFor();
  const label = availability.hosts.find(entry => entry.host_id === hostId).label;
  await UI.behaviorOption(page, behavior.label).check();
  await UI.sentence(page).fill(SENTENCES[hostId]);
  const [designed, classified] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/assist/bug-spec"),
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/otf/classify"),
    UI.writeCard(page).click(),
  ]);
  assert.equal(designed.status(), 200);
  assert.equal(classified.status(), 200);
  assert.equal((await classified.json()).proven_criterion_id, behavior.criterion_id);
  assert.equal(await UI.specAccept(page).getByLabel("Title", { exact: true }).inputValue(), STUB_CARD.title);
  await UI.specAccept(page).getByText(`This matches the proven behavior “${behavior.label}”.`, { exact: true }).waitFor();
  await UI.specAccept(page).getByText(COPY.notMeasured(label), { exact: true }).waitFor();
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

/** Downloads through the displayed links; the certificate receipt is added only to status. */
async function checkDownloads(page, done) {
  for (const [part, link] of [["agent", UI.downloadAgent(page)], ["grader", UI.downloadGrader(page)], ["certificate", UI.downloadCertificate(page)]]) {
    const artifact = done.artifacts.find(item => item.part === part);
    assert(artifact, `${part} is advertised`);
    assert.equal(await link.getAttribute("href"), `/api/factory/otf/jobs/${done.job_id}/artifacts/${part}`);
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    assert.equal(await download.failure(), null);
    const bytes = fs.readFileSync(await download.path());
    assert.equal(bytes.length, artifact.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
    if (part === "certificate") {
      const certificate = JSON.parse(bytes.toString("utf8"));
      assert.deepEqual(validateOtf("OtfCertificate", certificate), []);
      assert.equal(certificate.job_id, done.job_id);
      assert.deepEqual(certificate.rule, done.rule);
      assert(!bytes.toString("utf8").includes(OTF_TEST_GRADER_SENTINEL));
    } else {
      assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b]);
      assert.equal(gunzipSync(bytes).toString("latin1").includes(OTF_TEST_GRADER_SENTINEL), part === "grader");
    }
  }
}

async function checkValidation(page, id) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/factory/otf/jobs/${id}/validations`),
    UI.certificate(page).getByRole("button", { name: "Validate stored bundles", exact: true }).click(),
  ]);
  assert.equal(response.status(), 201);
  assert.deepEqual(validateOtf("OtfValidation", await response.json()), []);
  const validation = UI.certificate(page).getByRole("region", { name: "Bundle validation", exact: true });
  await validation.waitFor();
  for (let attempt = 0; attempt < 30 && await validation.getByText("Validation: passed", { exact: true }).count() === 0; attempt++) {
    await page.waitForTimeout(1000);
    const [read] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/factory/otf/jobs/${id}`),
      page.getByRole("button", { name: "Refresh custom build", exact: true }).click(),
    ]);
    assert.equal(read.status(), 200);
  }
  await validation.getByText("Validation: passed", { exact: true }).waitFor();
  const done = await status(page.context(), id);
  assert.equal(done.validation?.state, "passed");
  assert.deepEqual(validateOtf("OtfJobStatus", done), []);
}

async function writeDesignerCard(page) {
  STUB_CARD = OPEN_CARD; STUB_HOST = "task-report";
  const designer = page.getByRole("region", { name: "Find a bug for your agent evaluation", exact: true });
  await designer.getByLabel("Step 1: the kind of bug you want", { exact: true }).fill("Synthetic sequential task updates");
  const [searched] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/assist/bug-shapes"),
    designer.getByRole("button", { name: "Find bug shapes", exact: true }).click(),
  ]);
  assert.equal(searched.status(), 200);
  await designer.getByRole("radio", { name: SHAPES[0].title, exact: true }).check();
  await designer.locator('input[name="designer-host"][value="task-report"]').check();
  const [written] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/assist/bug-spec"),
    designer.getByRole("button", { name: "Write the bug specification", exact: true }).click(),
  ]);
  assert.equal(written.status(), 200);
  await designer.getByRole("heading", { name: OPEN_CARD.title, exact: true }).waitFor();
  return designer;
}

async function handoff(page, posts, outcome) {
  STUB_CLASSIFICATION = outcome;
  const designer = await writeDesignerCard(page);
  assert.deepEqual(posts.filter(path => path === "/api/factory/otf/jobs"), []);
  const [classified] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/otf/classify"),
    designer.getByRole("button", { name: "Build this as a custom bug", exact: true }).click(),
  ]);
  assert.equal(classified.status(), 200);
  assert.deepEqual(validateOtf("OtfClassification", await classified.json()), []);
  await UI.specAccept(page).waitFor();
  assert.deepEqual(posts.filter(path => path === "/api/factory/otf/jobs"), [], "handoff and classification do not create a job");
  return classified;
}

async function scenario(name, width, run, label = name, target = origin) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const errors = [], bodies = [], reads = [], posts = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  page.on("pageerror", error => errors.push(error.message));
  watchOtf(page, bodies, reads);
  try {
    const reset = await factoryJson(context, target, "post", "/api/factory/otf/test/reset", { scenario: name });
    assert.equal(reset.scenario, name);
    await signInToFactory(page, target);
    await run({ context, page, posts });
    await Promise.all(reads);
    assert.deepEqual(posts.filter(path => path === "/api/factory/requests"), [], "the catalog never starts automatically");
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
  browser = await chromium.launch({ ...(executablePath === "auto" ? {} : { executablePath }), headless: true, args: ["--no-sandbox"] });
  for (const width of [1440, 390]) await scenario("delivered", width, async ({ context, page }) => {
    const accepted = await acceptCard(page);
    const id = accepted.job_id;
    assert.equal(accepted.status.state, "starting_builder");
    assert.equal(accepted.status.queue_position, 1);
    assert(accepted.status.events.some(event => event.type === "job_queued"));
    // The machine starts first, then three lanes race.
    await UI.laneBoard(page).getByText("Starting the Nebius machine.", { exact: false }).waitFor();
    assert.match(await UI.laneBoard(page).innerText(), /Queue position: 1\./);
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
    await checkDownloads(page, done);
    await checkValidation(page, id);
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
    for (const label of COPY.admissionLabels) await UI.admissionStrip(page).first().getByRole("listitem").filter({ hasText: label }).waitFor();
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

  await scenario("delivered", 390, async ({ context, page, posts }) => {
    const classified = await handoff(page, posts, "open");
    assert.deepEqual((await classified.json()).rule, OPEN_RULE);
    const form = UI.specAccept(page);
    const edited = { family: "state_ui", observable_failure: "GET /api/tasks/{id} returns the old title after PATCH /api/tasks/{id} saves a replacement title.", failure_code: "synthetic_edited_title" };
    await form.getByLabel("Observable failure", { exact: true }).waitFor();
    assert.equal(await form.getByLabel("Observable failure", { exact: true }).inputValue(), OPEN_RULE.observable_failure);
    await form.getByLabel("Family", { exact: true }).selectOption(edited.family);
    await form.getByLabel("Observable failure", { exact: true }).fill(edited.observable_failure);
    await form.getByLabel("Failure code", { exact: true }).fill(edited.failure_code);
    await form.getByText(OTF_OPEN_TIME_COPY, { exact: true }).waitFor();
    await form.getByLabel("Failure code", { exact: true }).press("Enter");
    assert.deepEqual(posts.filter(path => path === "/api/factory/otf/jobs"), [], "editing or Enter never accepts");
    const [created] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/otf/jobs"), UI.accept(page).click(),
    ]);
    assert.equal(created.status(), 201);
    const sent = created.request().postDataJSON();
    assert.equal(sent.criterion_id, OTF_OPEN_CRITERION_ID);
    assert.deepEqual(sent.rule, edited); assert.equal(sent.rule_sha256, await ruleSha256(edited));
    const expectedSpec = { ...OPEN_CARD }; delete expectedSpec.in_scope;
    assert.deepEqual(sent.spec, expectedSpec); assert.equal(sent.spec_sha256, await specSha256(expectedSpec));
    const { job_id: id } = await created.json();
    await UI.certificate(page).waitFor();
    const rule = UI.certificate(page).getByRole("region", { name: "Open behavior rule", exact: true });
    await rule.getByRole("heading", { name: "Open behavior (not measured yet)", exact: true }).waitFor();
    for (const value of Object.values(edited)) await rule.getByText(value, { exact: true }).waitFor();
    const done = await status(context, id);
    assert.equal(done.outcome, "delivered"); assert.deepEqual(done.rule, edited); assert.deepEqual(done.certificate.rule, edited);
    await checkDownloads(page, done);
  }, "open-designer-rule-edit");

  await scenario("delivered", 390, async ({ page, posts }) => {
    const classified = await handoff(page, posts, "security");
    assert.deepEqual((await classified.json()).refusal, { kind: "security", reason: SECURITY_REASON });
    await UI.specAccept(page).getByText(SECURITY_REASON, { exact: true }).waitFor();
    assert.equal(await UI.accept(page).isDisabled(), true);
    await UI.catalogOffer(page).getByRole("button", { name: COPY.startCatalog, exact: true }).waitFor();
    assert.deepEqual(posts.filter(path => path === "/api/factory/otf/jobs" || path === "/api/factory/requests"), []);
  }, "security-refusal");

  await scenario("delivered", 390, async ({ context, page, posts }) => {
    const availability = await factoryJson(context, offOrigin, "get", "/api/factory/otf/availability");
    assert.equal(availability.enabled, true);
    assert(availability.behaviors.every(behavior => behavior.criterion_id !== OTF_OPEN_CRITERION_ID));
    await UI.behaviorPicker(page).waitFor();
    assert.equal(await UI.behaviorOption(page, OTF_OPEN_LABEL).count(), 0);
    await writeDesignerCard(page);
    assert.equal(await page.getByRole("button", { name: "Build this as a custom bug", exact: true }).count(), 0);
    assert.deepEqual(posts.filter(path => path === "/api/factory/otf/classify" || path === "/api/factory/otf/jobs"), []);
  }, "open-behaviors-unset", offOrigin);

  for (const schema of ["bug_shapes", "bug_spec", "otf_classification"]) assert(stubCalls.some(call => call.schema === schema), `${schema} used the loopback stub`);
  console.log(`SUMMARY: ${results.length} passed; 0 failed; synthetic OTF HTTP/browser only.`);
  fs.writeFileSync(join(outputDir, "otf-results.json"), JSON.stringify({ proof: "Local HTTP/UI with the synthetic OTF test-mode builder only; no machine, model or production call", results }, null, 2) + "\n");
} finally {
  try { await browser?.close(); }
  finally { await new Promise(resolve => stub.close(resolve)); }
}
