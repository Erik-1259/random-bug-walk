// A synthetic GitHub REST API for the race class (shape RC-1.guarded-write): one commit search, one
// pull request search and a commit per scenario, each changing one synthetic server file. Every
// repository, commit and file is synthetic; no scenario is taken from a real project.
import { searchUrl, type Query } from "../../src/queries.ts";
import { contentBody, encodePath, gitBlob, ORG, patchOf, PERSON, serveRoutes, sha, type Json, type Route, type SyntheticGitHub } from "./synthetic-github.ts";

export const SYNTHETIC_RACE_QUERIES: readonly Query[] = [
  { kind: "commits", api: "updateMany", q: "updateMany race condition fix" },
  { kind: "pulls", api: "check-then-act", q: "is:pr is:merged check-then-act race" },
];

const REDEEM_BEFORE = `export async function redeem(db, code) {
  const coupon = await db.coupon.findFirst({ where: { code } });
  if (!coupon || coupon.redeemed) {
    throw new Error("already redeemed");
  }
  await db.coupon.update({
    where: { id: coupon.id },
    data: { redeemed: true },
  });
}
`;
const REDEEM_AFTER = `export async function redeem(db, code) {
  const coupon = await db.coupon.findFirst({ where: { code } });
  if (!coupon || coupon.redeemed) {
    throw new Error("already redeemed");
  }
  const result = await db.coupon.updateMany({
    where: { id: coupon.id, redeemed: false },
    data: { redeemed: true },
  });
  if (result.count === 0) {
    throw new Error("already redeemed");
  }
}
`;

const STOCK_BEFORE = `export const take = async (orders, id) => {
  const order = await orders.findOne({ _id: id });
  if (order.stock < 1) return null;
  return orders.updateOne({ _id: id }, { $inc: { stock: -1 } });
};
`;

const CLAIM_BEFORE = `export async function claim(Task, id, worker) {
  const task = await Task.findByPk(id);
  if (task.status !== "open") return false;
  await Task.update({ status: "taken", worker }, { where: { id } });
  return true;
}
`;

const CLOSE_BEFORE = `export async function close(db, id) {
  await db.ticket.update({ where: { id }, data: { open: false } });
}
`;

interface RaceScenario {
  readonly name: string;
  readonly license: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** False for a commit reached only through a pull request. */
  readonly searched?: boolean;
}

const SCENARIOS: readonly RaceScenario[] = [
  { name: "redeem", license: "MIT", path: "src/routes/redeem.ts", before: REDEEM_BEFORE, after: REDEEM_AFTER },
  {
    name: "stock",
    license: "Apache-2.0",
    path: "server/take.js",
    before: STOCK_BEFORE,
    after: STOCK_BEFORE.replace("orders.updateOne({ _id: id }", "orders.updateOne({ _id: id, stock: { $gt: 0 } }"),
  },
  {
    name: "claim",
    license: "MIT",
    path: "lib/claim.js",
    before: CLAIM_BEFORE,
    after: CLAIM_BEFORE.replace("{ where: { id } }", '{ where: { id, status: "open" } }'),
    searched: false,
  },
  { name: "copyleft", license: "GPL-3.0", path: "src/a.ts", before: REDEEM_BEFORE, after: REDEEM_AFTER.replace("redeem(", "redeemCode(") },
  { name: "no-write-text", license: "MIT", path: "src/a.ts", before: REDEEM_BEFORE, after: REDEEM_BEFORE.replace('"already redeemed"', '"coupon spent"') },
  {
    name: "comment-only",
    license: "MIT",
    path: "src/a.ts",
    before: REDEEM_BEFORE,
    after: REDEEM_BEFORE.replace("  await db.coupon.update({", "  // The where filter could check redeemed too.\n  await db.coupon.update({"),
  },
  {
    name: "new-function",
    license: "ISC",
    path: "src/a.ts",
    before: "export const LIMIT = 1;\n",
    after: `export const LIMIT = 1;\n${REDEEM_AFTER}`,
  },
  {
    name: "new-write",
    license: "MIT",
    path: "src/a.ts",
    before: REDEEM_BEFORE,
    after: REDEEM_BEFORE.replace("  await db.coupon.update({", "  await db.coupon.updateMany({ where: { id: coupon.id, redeemed: false }, data: { seen: true } });\n  await db.coupon.update({"),
  },
  { name: "renamed-filter", license: "MIT", path: "src/a.ts", before: REDEEM_BEFORE, after: REDEEM_BEFORE.replace("where: { id: coupon.id }", "where: { id: coupon.couponId }") },
  {
    name: "owner-scope",
    license: "BSD-2-Clause",
    path: "src/a.ts",
    before: REDEEM_BEFORE,
    after: REDEEM_BEFORE.replace("where: { id: coupon.id }", "where: { id: coupon.id, userId: session.user.id }"),
  },
  { name: "no-read", license: "MIT", path: "src/close.ts", before: CLOSE_BEFORE, after: CLOSE_BEFORE.replace("where: { id }", "where: { id, open: true }") },
];

const PULLS = [{ repo: "synthetic-claim", number: 3, commit: "claim" }] as const;

/** Every search result. */
export const SYNTHETIC_RACE_MAX = SCENARIOS.filter((scenario) => scenario.searched !== false).length + PULLS.length;

function licenseBody(license: string): Json {
  return { key: license.toLowerCase(), spdx_id: license, name: license };
}

function buildRoutes(): Map<string, Route> {
  const routes = new Map<string, Route>();
  const add = (url: string, status: number, body: unknown): void => {
    routes.set(url, { status, body });
  };
  const commitItems: Json[] = [];
  for (const scenario of SCENARIOS) {
    const full = `${ORG}/synthetic-${scenario.name}`;
    const commit = sha(`race:${scenario.name}`);
    const parent = sha(`race:${scenario.name}:parent`);
    if (scenario.searched !== false) {
      // The search result carries the fork flag and the license, so no repository record is read.
      const repository = { full_name: full, owner: { login: ORG }, fork: false, license: licenseBody(scenario.license) };
      commitItems.push({ sha: commit, repository, commit: { message: "synthetic race fix", author: PERSON } });
    } else {
      add(`/repos/${full}`, 200, { full_name: full, fork: false, owner: { login: ORG }, license: licenseBody(scenario.license) });
    }
    add(`/repos/${full}/contents/${encodePath(scenario.path)}?ref=${parent}`, 200, contentBody(scenario.path, scenario.before));
    add(`/repos/${full}/contents/${encodePath(scenario.path)}?ref=${commit}`, 200, contentBody(scenario.path, scenario.after));
    const file = { filename: scenario.path, status: "modified", sha: gitBlob(scenario.after), additions: 1, deletions: 1, patch: patchOf(scenario.before, scenario.after) };
    add(`/repos/${full}/commits/${commit}`, 200, {
      sha: commit,
      parents: [{ sha: parent }],
      commit: { message: "synthetic race fix", author: PERSON, committer: { ...PERSON, date: "2026-04-01T00:00:00Z" } },
      files: [file],
    });
  }
  const pullItems: Json[] = [];
  for (const pull of PULLS) {
    const full = `${ORG}/${pull.repo}`;
    pullItems.push({ number: pull.number, repository_url: `https://api.github.com/repos/${full}`, pull_request: { url: "synthetic" }, user: PERSON });
    add(`/repos/${full}/pulls/${String(pull.number)}`, 200, { number: pull.number, merged: true, merge_commit_sha: sha(`race:${pull.commit}`), user: PERSON });
  }
  const [commits, pulls] = SYNTHETIC_RACE_QUERIES;
  if (commits === undefined || pulls === undefined) {
    throw new Error("synthetic race queries are missing");
  }
  add(searchUrl(commits), 200, { total_count: commitItems.length, incomplete_results: false, items: commitItems });
  add(searchUrl(pulls), 200, { total_count: pullItems.length, incomplete_results: false, items: pullItems });
  return routes;
}

export function syntheticRaceGitHub(): SyntheticGitHub {
  return serveRoutes(buildRoutes());
}
