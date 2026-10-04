import { describe, expect, it } from "vitest";
import { deleteAndConfirm, exitCodeFor, formatResult } from "../src/delete.ts";
import { config, fakeDeps, project } from "./helpers.ts";
import type { BranchFixture } from "./helpers.ts";

const NAME = "ci-pr-12-9876543210-1";
const ID = "br-synthetic-1";
const listing = (branches: BranchFixture[]) => ({ status: 200, body: { branches } });

describe("deleteAndConfirm", () => {
  it("deletes by ID when one is given, without listing", async () => {
    const { deps, requests } = fakeDeps(() => ({ status: 200, body: {} }));
    const result = await deleteAndConfirm(deps, config, NAME, ID);
    expect(result).toEqual({ outcome: "deleted", name: NAME, id: ID });
    expect(requests).toEqual([{ method: "DELETE", path: `${project}/branches/${ID}` }]);
  });

  it("falls back to the name: finds the branch and deletes it by the looked-up ID", async () => {
    const { deps, requests } = fakeDeps(({ method }) =>
      method === "GET" ? listing([{ id: "br-found-9", name: NAME }]) : { status: 200 },
    );
    const result = await deleteAndConfirm(deps, config, NAME, undefined);
    expect(result).toEqual({ outcome: "deleted", name: NAME, id: "br-found-9" });
    expect(requests[1]).toEqual({ method: "DELETE", path: `${project}/branches/br-found-9` });
  });

  it("reports absent when the name is not listed", async () => {
    const { deps, requests } = fakeDeps(() => listing([{ id: "br-other-1", name: "main" }]));
    expect((await deleteAndConfirm(deps, config, NAME, undefined)).outcome).toBe("absent");
    expect(requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("treats a 404 as absent", async () => {
    const { deps } = fakeDeps(() => ({ status: 404 }));
    expect((await deleteAndConfirm(deps, config, NAME, ID)).outcome).toBe("absent");
  });

  it("retries 423 and succeeds on the next 2xx", async () => {
    const statuses = [423, 423, 204];
    const { deps, requests } = fakeDeps(() => ({ status: statuses.shift() ?? 500 }));
    expect((await deleteAndConfirm(deps, config, NAME, ID)).outcome).toBe("deleted");
    expect(requests).toHaveLength(3);
  });

  it("reports leaked when deletion keeps failing and the branch is still listed", async () => {
    const { deps } = fakeDeps(({ method }) => (method === "GET" ? listing([{ id: ID, name: NAME }]) : { status: 500 }));
    const result = await deleteAndConfirm(deps, config, NAME, ID);
    expect(result.outcome).toBe("leaked");
    expect(exitCodeFor(result.outcome)).toBe(1);
  });

  it("does not retry other 4xx responses and confirms through the list", async () => {
    const { deps, requests } = fakeDeps(({ method }) => (method === "GET" ? listing([]) : { status: 403 }));
    expect((await deleteAndConfirm(deps, config, NAME, ID)).outcome).toBe("absent");
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("reports unknown when the confirming list returns 500", async () => {
    const { deps } = fakeDeps(({ method }) => (method === "GET" ? { status: 500 } : { status: 500 }));
    const result = await deleteAndConfirm(deps, config, NAME, ID);
    expect(result.outcome).toBe("unknown");
    expect(exitCodeFor(result.outcome)).toBe(2);
  });

  it("reports unknown, never absent, for a malformed list", async () => {
    for (const raw of ["not json", '{"branches": "x"}', '{"branches":[{"id":1}]}', "[]"]) {
      const { deps } = fakeDeps(() => ({ status: 200, raw }));
      expect((await deleteAndConfirm(deps, config, NAME, undefined)).outcome).toBe("unknown");
    }
  });

  it("finds the match on page 2 following pagination.next", async () => {
    const { deps, requests } = fakeDeps(({ method, path }) => {
      if (method === "DELETE") return { status: 200 };
      return path.includes("cursor=c2")
        ? listing([{ id: "br-p2-1", name: NAME }])
        : { status: 200, body: { branches: [{ id: "br-p1-1", name: "main" }], pagination: { next: "c2" } } };
    });
    const result = await deleteAndConfirm(deps, config, NAME, undefined);
    expect(result).toEqual({ outcome: "deleted", name: NAME, id: "br-p2-1" });
    expect(requests[0]?.path).toContain("limit=100");
  });

  it("reports unknown when pagination never ends", async () => {
    let page = 0;
    const { deps } = fakeDeps(() => ({
      status: 200,
      body: { branches: [], pagination: { next: `c${String(page++)}` } },
    }));
    expect((await deleteAndConfirm(deps, config, NAME, undefined)).outcome).toBe("unknown");
  });

  it("retries network errors", async () => {
    let calls = 0;
    const { deps } = fakeDeps(() => (++calls < 3 ? { status: 0, networkError: true } : { status: 200 }));
    expect((await deleteAndConfirm(deps, config, NAME, ID)).outcome).toBe("deleted");
  });
});

describe("formatResult", () => {
  it("never prints the ID", () => {
    expect(formatResult({ outcome: "deleted", name: NAME, id: ID })).toBe(`outcome=deleted name=${NAME} id=masked`);
    expect(formatResult({ outcome: "absent", name: NAME, id: undefined })).toBe(`outcome=absent name=${NAME} id=-`);
  });
});
