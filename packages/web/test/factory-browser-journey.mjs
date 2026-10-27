/* global localStorage */
// Ordinary browser actions shared by the synthetic and separately configured local-live proofs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { URL } from "node:url";

export async function factoryJson(context, origin, method, path, data, expected = 200) {
  const response = await context.request[method](origin + path, data === undefined ? {} : { data });
  assert.equal(response.status(), expected, `${method.toUpperCase()} ${path}: ${await response.text()}`);
  return response.json();
}

export async function signInToFactory(page, origin, wrongFirst = false) {
  await page.goto(origin + "/factory");
  await page.getByText("Request service available", { exact: true }).waitFor();
  const passcode = page.getByLabel("Judge passcode", { exact: true });
  if (wrongFirst) {
    await passcode.fill("synthetic-wrong-passcode");
    await page.getByRole("button", { name: "Sign in to the request service", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "passcode_incorrect:" }).waitFor();
    assert.equal(await passcode.inputValue(), "");
  }
  await passcode.fill("synthetic-factory-passcode");
  await page.getByRole("button", { name: "Sign in to the request service", exact: true }).click();
  await passcode.waitFor({ state: "hidden" });
  assert.equal((await factoryJson(page.context(), origin, "get", "/api/factory/session")).signed_in, true);
}

export async function reviewFactoryForm(page) {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/interpretations"),
    page.getByRole("button", { name: "Review requirements", exact: true }).click(),
  ]);
  assert.equal(response.status(), 200);
  return { sent: response.request().postDataJSON(), interpretation: await response.json() };
}

export async function startReviewedFactoryForm(page, posts, sent, interpretation) {
  await page.getByRole("heading", { name: "Service interpretation", exact: true }).waitFor();
  assert.equal(posts.filter(path => path === "/api/factory/requests").length, 0);
  const [accepted] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/factory/requests"),
    page.getByRole("button", { name: "Start request", exact: true }).click(),
  ]);
  assert.equal(accepted.status(), 202);
  const start = accepted.request().postDataJSON();
  assert.deepEqual(start.input, sent);
  assert.equal(start.interpretation_sha256, interpretation.interpretation_sha256);
  assert.equal((await accepted.json()).request_id, start.request_id);
  assert.equal(await page.evaluate(() => localStorage.getItem("rbw-factory-request-id")), start.request_id);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("rbw-factory-start"))), start);
  await page.getByText(start.request_id, { exact: true }).waitFor();
  return start.request_id;
}

export async function checkFactoryDownloads(page, current, inspect) {
  for (const [index, item] of current.cases.entries()) {
    const card = page.locator(".factory-case-card").nth(index);
    for (const [part, label] of [["bug_case", "Download bug case"], ["validator", "Download validator package"]]) {
      const link = card.getByRole("link", { name: label, exact: true });
      assert.equal(await link.getAttribute("href"), item.packages[part].download_path);
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      const bytes = fs.readFileSync(await download.path());
      assert.equal(bytes.length, item.packages[part].size_bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), item.packages[part].sha256);
      if (inspect !== undefined) await inspect(bytes, part);
    }
  }
}
