/* global localStorage, document, innerWidth */
// Real local HTTP/UI integration with deterministic fake providers, ledger, worker and storage.
// Fulfillment, cancellation and validation start through the form; other recovery is API-seeded.
// node test/factory-test-mode-browser.mjs <playwright-index.mjs> <chromium> <local-origin> <output-dir>
import assert from "node:assert/strict";
import console from "node:console";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { gunzipSync } from "node:zlib";
import { formatExactUsd } from "../src/factory/format.ts";
import { factoryJson, signInToFactory, reviewFactoryForm, startReviewedFactoryForm, checkFactoryDownloads } from "./factory-browser-journey.mjs";

const [modulePath, executablePath, origin, outputDir] = process.argv.slice(2);
if (!modulePath || !executablePath || !origin || !outputDir) {
  throw new Error("Provide Playwright module, Chromium, local test-mode origin and output directory.");
}
const address = new URL(origin);
if (address.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(address.hostname) || address.pathname !== "/") {
  throw new Error("Test-mode browser proof requires a dedicated local HTTP server.");
}
const fixture = name => JSON.parse(fs.readFileSync(new URL(`../../../docs/product/fixtures/bug-request-v1/${name}.json`, import.meta.url), "utf8"));
const { chromium } = await import(pathToFileURL(modulePath).href);
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const results = [];

const json = (context, method, path, data, expected = 200) => factoryJson(context, origin, method, path, data, expected);
const signIn = (page, wrongFirst = false) => signInToFactory(page, origin, wrongFirst);

async function formRequest(page, posts, statusFixture) {
  // Enter fixture requirements through the ordinary form; never seed this journey's identity.
  const input = fixture(statusFixture).interpretation.input;
  // The form starts on the task-and-report service alone; the fixture asks for Umami first, then it.
  await page.getByRole("checkbox", { name: /Task and report service/ }).uncheck();
  await page.getByRole("checkbox", { name: /Umami —/ }).check();
  await page.getByRole("checkbox", { name: /Task and report service/ }).check();
  await page.getByLabel("Bug type for item 1", { exact: true }).selectOption("concurrency");
  await page.getByLabel("Optional description for item 1", { exact: true }).fill(input.items[0].description);
  await page.getByRole("button", { name: "Add request item", exact: true }).click();
  await page.getByLabel("Bug type for item 2", { exact: true }).selectOption("date_time");
  await page.getByLabel("Shared budget (USD)", { exact: true }).fill("2");
  const review = () => reviewFactoryForm(page);
  const { sent, interpretation } = await review();
  assert.deepEqual(sent.items.map(item => item.item_key), ["item-1", "item-2"]);
  assert.deepEqual({ ...sent, items: sent.items.map((item, index) => ({ ...item, item_key: input.items[index].item_key })) }, input,
    "the form differs from this default fixture only in its opaque item keys");
  assert.deepEqual(interpretation.input, sent);
  assert.equal(interpretation.startable, true);
  assert.deepEqual(interpretation.items.map(item => item.item_key), ["item-1", "item-2"]);
  assert.match(interpretation.interpretation_sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(interpretation.interpretation_sha256, fixture(statusFixture).interpretation.interpretation_sha256);
  assert.deepEqual(await review(), { sent, interpretation }, "reviewing unchanged form requirements returns the same key-specific interpretation");
  return startReviewedFactoryForm(page, posts, sent, interpretation);
}

async function seededRequest(context, page, statusFixture) {
  const input = fixture(statusFixture).interpretation.input;
  const interpretation = await json(context, "post", "/api/factory/interpretations", input);
  assert.equal(interpretation.startable, true);
  const start = { request_id: randomUUID(), input, interpretation_sha256: interpretation.interpretation_sha256 };
  await json(context, "post", "/api/factory/requests", start, 202);
  await page.evaluate(body => {
    localStorage.setItem("rbw-factory-request-id", body.request_id);
    localStorage.setItem("rbw-factory-start", JSON.stringify(body));
  }, start);
  await page.reload();
  await page.getByText(start.request_id, { exact: true }).waitFor();
  return start.request_id;
}

const evidence = (context, id) => json(context, "get", `/api/factory/test/evidence?request_id=${id}`);
const status = (context, id) => json(context, "get", `/api/factory/requests/${id}`);
// The exact amounts and the activity log sit in closed Details elements, so these waits need the
// elements attached, not visible.
const metric = (page, label) => page.locator(".factory-metrics dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("+ dd");
const eventItem = (page, text) => page.locator(".factory-events li").filter({ hasText: text });

async function waitMetric(page, label, amount) {
  await metric(page, label).getByText(formatExactUsd(amount), { exact: true }).waitFor({ state: "attached" });
}

async function checkDownloads(page, current) {
  await checkFactoryDownloads(page, current, (bytes, part) => {
    const text = gunzipSync(bytes).toString("utf8");
    assert(text.includes("Synthetic test-mode"));
    assert.equal(text.includes("synthetic-test-mode-evaluator-material-5e0b"), part === "validator");
  });
}

async function validate(page, context, id, result, posts) {
  const before = await status(context, id);
  const button = page.getByRole("button", { name: "Validate case", exact: true }).first();
  const [accepted] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/validations")),
    button.click(),
  ]);
  assert.equal(accepted.status(), 202);
  const validationId = await page.evaluate(() => localStorage.getItem("rbw-factory-validation-id"));
  assert(validationId);
  assert.equal((await accepted.json()).validation_id, validationId);
  // The fake run can finish within 600 ms. Reload after acceptance without relying on a transient frame.
  await page.reload();
  await page.getByText(`Validation: ${result}`, { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-validation-id")), validationId);
  const after = await status(context, id);
  assert.equal(after.cases[0].validation.validation_id, validationId);
  assert.equal(after.cases[0].validation.result, result);
  assert.notEqual(after.cases[0].validation.cost_microusd, null, "these test-mode outcomes settle a known fake cost");
  assert.equal(after.budget.spent_microusd, before.budget.spent_microusd + after.cases[0].validation.cost_microusd);
  await waitMetric(page, "Spent", after.budget.spent_microusd);
  await waitMetric(page, "Reserved", 0);
  assert.equal(await page.getByRole("link", { name: "Download bug case", exact: true }).count(), before.cases.length);
  assert.equal(posts.filter(path => path.endsWith("/validations")).length, 1);
  assert.equal((await evidence(context, id)).operations.filter(op => op.kind === "validation").length, 1);
  const explanation = result === "passed" ? "All six cells matched their expected outcomes."
    : result === "failed" ? "The harness completed, but at least one observed outcome differed from its expectation."
      : "Validation could not establish a behavioral result. Setup failures, missing output and incomplete runs are not reproduction.";
  await page.locator(".factory-case-card").first().getByText(explanation, { exact: true }).first().waitFor();
}

async function scenario(name, width, run) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [], posts = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
  });
  try {
    // This control exists only in isolated test mode; never substitute live routes if it is absent.
    const reset = await json(context, "post", "/api/factory/test/reset", { scenario: name });
    assert.equal(reset.scenario, name);
    await signIn(page, name === "two-host-fulfilled");
    await run({ context, page, posts });
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(outputDir, `${name}-${width}.png`), fullPage: true });
    const setup = ["two-host-fulfilled", "cancel-midway", "validation-failed", "validation-error"].includes(name) ? "ordinary form-to-start" : "API-seeded UI resumption";
    results.push({ scenario: name, width, proof: `${setup} with real local HTTP and deterministic test-mode fakes`, passed: true });
    console.log(`PASS test-mode HTTP/browser ${width}px: ${name} (${setup})`);
  } finally {
    await context.close();
  }
}

try {
  for (const width of [1440, 390]) await scenario("two-host-fulfilled", width, async ({ context, page, posts }) => {
    // Observe the application's own poll; no response interception or fixed-duration sleep.
    const [packagingResponse, id] = await Promise.all([
      page.waitForResponse(async response => {
        if (response.request().method() !== "GET" || !/^\/api\/factory\/requests\/[^/]+$/.test(new URL(response.url()).pathname) || response.status() !== 200) return false;
        const current = await response.json();
        return current.cases.length === 0 && current.candidates.some(candidate => candidate.stage === "packaging")
          && current.events.some(event => event.type === "package_ready");
      }),
      formRequest(page, posts, "status-fulfilled"),
    ]);
    const packaging = await packagingResponse.json();
    assert.equal(packaging.request_id, id);
    const ready = packaging.events.find(event => event.type === "package_ready");
    assert(ready?.case_id);
    assert.equal(packaging.funnel.packages_ready, 0);
    await eventItem(page, ready.message).waitFor({ state: "attached" });
    await page.getByText("No qualified cases have been delivered.", { exact: true }).waitFor();
    assert.equal(await page.locator(".factory-case-card").count(), 0);
    assert.equal(await page.getByRole("link", { name: "Download bug case", exact: true }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Download validator package", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Validate case", exact: true }).count(), 0);
    assert.equal(posts.filter(path => path.endsWith("/validations")).length, 0);
    await page.screenshot({ path: join(outputDir, `two-host-fulfilled-${width}-packaging.png`), fullPage: true });
    await eventItem(page, "Case delivered for item item-1.").waitFor({ state: "attached" });
    await page.getByRole("link", { name: "Download bug case", exact: true }).first().waitFor();
    await page.getByRole("link", { name: "Download validator package", exact: true }).first().waitFor();
    const afterDelivery = await status(context, id);
    const deliveredEvent = afterDelivery.events.find(event => event.type === "case_delivered" && event.case_id === ready.case_id);
    assert(deliveredEvent);
    assert.equal(Date.parse(deliveredEvent.at) - Date.parse(ready.at), 5000, "the recorded delivery follows package_ready by the revision-3 window");
    assert(afterDelivery.cases.some(item => item.case_id === ready.case_id));
    fs.writeFileSync(join(outputDir, `two-host-fulfilled-${width}-packaging.json`), JSON.stringify({
      request_id: id, package_ready: ready, case_delivered: deliveredEvent,
      packaging_cases: packaging.cases, packaging_packages_ready: packaging.funnel.packages_ready,
      delivered_case_ids: afterDelivery.cases.map(item => item.case_id),
      proof: "Observed packaging without case actions, then delivery, over local synthetic HTTP/UI",
    }, null, 2) + "\n");
    await page.getByRole("heading", { name: "Fulfilled", exact: true }).waitFor();
    assert.equal(await page.locator(".factory-case-card").count(), 2);
    const delivered = await status(context, id);
    assert.deepEqual(delivered.items.map(item => item.item_key), ["item-1", "item-2"]);
    assert.deepEqual(delivered.cases.map(item => item.item_key), ["item-1", "item-2"]);
    for (const key of ["item-1", "item-2"]) {
      await eventItem(page, `Case delivered for item ${key}.`).waitFor({ state: "attached" });
    }
    const beforeReload = await evidence(context, id);
    await page.reload();
    await page.getByRole("heading", { name: "Fulfilled", exact: true }).waitFor();
    assert.deepEqual(await evidence(context, id), beforeReload);
    await checkDownloads(page, await status(context, id));
    await validate(page, context, id, "passed", posts);
    const validated = await status(context, id);
    assert.deepEqual(validated.events.filter(event => ["validation_started", "validation_finished"].includes(event.type)).map(event => event.item_key), ["item-1", "item-1"]);
    assert.equal(posts.filter(path => path === "/api/factory/requests").length, 1);
  });

  await scenario("cancel-midway", 390, async ({ context, page, posts }) => {
    const id = await formRequest(page, posts, "status-cancelled");
    await page.getByRole("link", { name: "Download bug case", exact: true }).waitFor();
    const beforeStop = await status(context, id);
    assert.equal(beforeStop.cases.length, 1);
    assert.equal(beforeStop.cases[0].item_key, "item-1");
    await page.getByRole("button", { name: "Stop request", exact: true }).click();
    await page.getByRole("heading", { name: "Cancelled", exact: true }).waitFor();
    await page.getByText("Stopped with partial results. Every delivered case is retained below.", { exact: true }).waitFor();
    assert.equal(await page.locator(".factory-case-card").count(), 1);
    const stopped = await status(context, id);
    assert.deepEqual(stopped.cases, beforeStop.cases, "stopping retains the delivered case and its packages");
    const beforeReload = await evidence(context, id);
    await page.reload();
    await page.getByRole("heading", { name: "Cancelled", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-request-id")), id);
    assert.deepEqual(await evidence(context, id), beforeReload, "reload creates no replacement operations or provider calls");
    assert.deepEqual((await status(context, id)).cases, stopped.cases);
    assert.equal(await page.getByRole("button", { name: "Stop request", exact: true }).count(), 0);
    await checkDownloads(page, await status(context, id));
    assert.equal(posts.filter(path => path.endsWith("/stop")).length, 1);
    assert.equal(posts.filter(path => path === "/api/factory/requests").length, 1);
  });

  await scenario("partial-budget", 390, async ({ context, page }) => {
    const id = await seededRequest(context, page, "status-partial-budget");
    await page.getByRole("heading", { name: "Stopped at a limit", exact: true }).waitFor();
    assert.equal(await page.locator(".factory-case-card").count(), 1);
    const current = await status(context, id);
    await waitMetric(page, "Remaining", current.budget.remaining_microusd);
    assert.equal(current.delivery, "partial");
    await checkDownloads(page, current);
  });

  for (const name of ["worker-lost", "uncertain-provider"]) {
    await scenario(name, 390, async ({ context, page, posts }) => {
      const id = await seededRequest(context, page, "status-operational-error");
      await page.getByRole("heading", { name: "Operational error", exact: true }).waitFor();
      const attention = page.getByRole("alert").filter({ hasText: "needs_reconciliation" });
      await attention.waitFor();
      const prepare = page.getByRole("button", { name: "Prepare another request", exact: true });
      assert(await prepare.isDisabled());
      const before = await evidence(context, id);
      const held = await status(context, id);
      assert(held.budget.reserved_microusd > 0);
      await waitMetric(page, "Reserved", held.budget.reserved_microusd);
      await page.reload();
      await attention.waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-request-id")), id);
      const reconciled = await json(context, "post", "/api/factory/test/reconcile", { request_id: id });
      await attention.waitFor({ state: "hidden" });
      await waitMetric(page, "Reserved", 0);
      await waitMetric(page, "Spent", reconciled.budget.spent_microusd);
      assert.equal(await prepare.isDisabled(), false);
      const after = await evidence(context, id);
      assert.deepEqual(after.provider_calls, before.provider_calls);
      assert.deepEqual(after.operations.map(op => op.operation_id), before.operations.map(op => op.operation_id));
      assert.equal(after.slot.holder_request_id, null);
      assert.equal(posts.filter(path => path === "/api/factory/requests").length, 0);
    });
  }

  for (const result of ["failed", "error"]) {
    await scenario(`validation-${result}`, 1440, async ({ context, page, posts }) => {
      const id = await formRequest(page, posts, "status-fulfilled");
      await page.getByRole("heading", { name: "Fulfilled", exact: true }).waitFor();
      await validate(page, context, id, result, posts);
      assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-request-id")), id);
      const validated = await status(context, id);
      assert.deepEqual(validated.events.filter(event => ["validation_started", "validation_finished"].includes(event.type)).map(event => event.item_key), ["item-1", "item-1"]);
      assert.equal(posts.filter(path => path === "/api/factory/requests").length, 1);
    });
  }
  fs.writeFileSync(join(outputDir, "results.json"), JSON.stringify({ proof: "Local HTTP/UI with deterministic test-mode fakes only; no production or real-worker execution", results }, null, 2) + "\n");
} finally {
  await browser.close();
}
