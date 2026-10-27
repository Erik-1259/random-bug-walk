/* global localStorage, document, innerWidth */
// Ordinary UI journey against a separately prepared, disposable local live stack.
// This script records HTTP/browser observations, not independent ledger/worker durability proof.
// node test/factory-live-browser.mjs <playwright-index.mjs> <chromium> <local-origin> <output-dir> <backend-sha> --local-live
import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import { factoryJson, signInToFactory, reviewFactoryForm, startReviewedFactoryForm, checkFactoryDownloads } from "./factory-browser-journey.mjs";

const [modulePath, executablePath, origin, outputDir, backendSha, mode] = process.argv.slice(2);
if (!modulePath || !executablePath || !origin || !outputDir || !/^[a-f0-9]{40}$/.test(backendSha ?? "") || mode !== "--local-live") {
  throw new Error("Provide Playwright, Chromium, local origin, output directory, exact backend SHA and --local-live after verifying the disposable local stack.");
}
const address = new URL(origin);
if (address.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(address.hostname) || address.pathname !== "/" || address.username || address.password || address.search || address.hash) {
  throw new Error("Live browser proof requires a dedicated loopback HTTP server.");
}

const { chromium } = await import(pathToFileURL(modulePath).href);
const { FACTORY_PROFILE } = await import("../../../tools/controller/src/factory-profile.ts");
const finishMarginMs = (FACTORY_PROFILE.shutdown_seconds + FACTORY_PROFILE.heartbeat.lost_after_s) * 1000;
fs.mkdirSync(outputDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const proof = {
  backend_sha_supplied: backendSha,
  profile_sha256: FACTORY_PROFILE.profile_sha256,
  proof: "Ordinary form, local HTTP/UI; server configuration and durable ledger/worker evidence must be verified separately.",
  passed: false, request_id: null, validation_id: null, posts: [], page_errors: [],
};
const save = () => fs.writeFileSync(join(outputDir, "results.json"), JSON.stringify(proof, null, 2) + "\n");
page.on("pageerror", error => proof.page_errors.push(error.message));
page.on("request", request => {
  if (request.method() !== "POST") return;
  const path = new URL(request.url()).pathname;
  proof.posts.push(path);
  if (path === "/api/factory/requests") proof.request_id = request.postDataJSON().request_id;
  if (path.endsWith("/validations")) proof.validation_id = request.postDataJSON().validation_id;
  // Keep accepted or uncertain identities for operator cleanup even if a later assertion fails.
  save();
});
const status = id => factoryJson(context, origin, "get", `/api/factory/requests/${id}`);

try {
  await signInToFactory(page, origin, true);
  for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.uncheck();
  await page.getByRole("checkbox", { name: /Task and report service/ }).check();
  await page.getByLabel("Bug type for item 1", { exact: true }).selectOption("concurrency");
  await page.getByLabel("Shared budget (USD)", { exact: true }).fill("1.5");
  const { sent, interpretation } = await reviewFactoryForm(page);
  assert.deepEqual(sent, {
    hosts: ["task-report"],
    items: [{ item_key: "item-1", bug_type_id: "concurrency", quantity: 1, description: null, difficulty: "source_inferable_allowed" }],
    budget_microusd: 1_500_000,
  });
  assert.deepEqual(interpretation.input, sent);
  assert.equal(interpretation.startable, true);
  const id = await startReviewedFactoryForm(page, proof.posts, sent, interpretation);
  const started = await status(id);
  const requestDeadline = Date.parse(started.limits.deadline_at);
  assert(Number.isFinite(requestDeadline));
  await page.reload();
  await page.getByText(id, { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Fulfilled", exact: true }).waitFor({ timeout: Math.max(1, requestDeadline - Date.now()) + finishMarginMs });
  const delivered = await status(id);
  assert.equal(delivered.state, "finished");
  assert.equal(delivered.outcome, "fulfilled");
  assert.equal(delivered.cases.length, 1);
  assert.equal(delivered.cases[0].host_id, "task-report");
  assert.equal(delivered.cases[0].item_key, "item-1");
  assert.equal(delivered.cases[0].provenance.origin, "live_request");
  proof.delivered = delivered;
  save();
  await checkFactoryDownloads(page, delivered);

  // Clearing only this browser's session simulates session loss; the service and ledger keep running.
  await context.clearCookies();
  await page.reload();
  await page.getByLabel("Judge passcode", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-request-id")), id);
  await signInToFactory(page, origin);
  await page.getByRole("heading", { name: "Fulfilled", exact: true }).waitFor();
  assert.deepEqual((await status(id)).cases, delivered.cases);
  assert.equal(proof.posts.filter(path => path === "/api/factory/requests").length, 1);

  const [accepted] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/validations")),
    page.getByRole("button", { name: "Validate case", exact: true }).click(),
  ]);
  assert.equal(accepted.status(), 202);
  const validationId = (await accepted.json()).validation_id;
  assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-validation-id")), validationId);
  await page.reload();
  // ValidationRun has no deadline field; use the pinned profile's completion limit plus cleanup/poll allowance.
  await page.getByText("Validation: passed", { exact: true }).waitFor({ timeout: FACTORY_PROFILE.validation.max_run_s * 1000 + finishMarginMs });
  const validated = await status(id);
  assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-validation-id")), validationId);
  assert.equal(validated.cases[0].validation.validation_id, validationId);
  assert.equal(validated.cases[0].validation.state, "finished");
  assert.equal(validated.cases[0].validation.result, "passed");
  assert.equal(await page.getByRole("link", { name: "Download bug case", exact: true }).count(), delivered.cases.length);
  assert.equal(await page.getByRole("link", { name: "Download validator package", exact: true }).count(), delivered.cases.length);
  assert.equal(proof.posts.filter(path => path.endsWith("/validations")).length, 1);
  assert.equal(proof.posts.filter(path => path === "/api/factory/requests").length, 1);
  assert.deepEqual(proof.page_errors, []);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(outputDir, "task-report-390.png"), fullPage: true });
  proof.validated = validated;
  proof.passed = true;
  console.log("PASS local HTTP/browser: task-report form/start, reload, downloads, session recovery and validation. Separate ledger/worker evidence required.");
} catch (error) {
  proof.failure = error instanceof Error ? error.message : String(error);
  try { await page.screenshot({ path: join(outputDir, "failure.png"), fullPage: true, timeout: 5000 }); }
  catch (diagnosticError) { proof.screenshot_failure = String(diagnosticError); }
  throw error;
} finally {
  save();
  await context.close();
  await browser.close();
}
