import { describe, expect, it } from "vitest";
import { runMask } from "../src/mask.ts";
import { config, fakeDeps, project } from "./helpers.ts";
import type { Reply } from "./helpers.ts";

const ID = "br-synthetic-1";
const base = `${project}/branches/${ID}`;

async function mask(handler: (path: string) => Reply) {
  const { deps, requests } = fakeDeps(({ path }) => handler(path));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runMask(deps, config, ID, { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
  return { code, stdout, stderr, requests };
}

const endpoints = (list: { type: string; host: string }[]): Reply => ({ status: 200, body: { endpoints: list } });

describe("runMask", () => {
  it("prints the ID, password and host masks in order and requests in order", async () => {
    const result = await mask((path) =>
      path.endsWith("reveal_password") ? { status: 200, body: { password: "synthetic-pw" } } : endpoints([{ type: "read_write", host: "ep.example.invalid" }]),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      `::add-mask::${ID}`,
      "::add-mask::synthetic-pw",
      "::add-mask::ep.example.invalid",
    ]);
    expect(result.stderr).toEqual([]);
    expect(result.requests.map((r) => r.path)).toEqual([`${base}/roles/neondb_owner/reveal_password`, `${base}/endpoints`]);
  });

  it("masks the URL-encoded password form as well", async () => {
    const result = await mask((path) =>
      path.endsWith("reveal_password") ? { status: 200, body: { password: "p@ss/w ord" } } : endpoints([{ type: "read_write", host: "h.example.invalid" }]),
    );
    expect(result.stdout).toEqual([
      `::add-mask::${ID}`,
      "::add-mask::p@ss/w ord",
      "::add-mask::p%40ss%2Fw%20ord",
      "::add-mask::h.example.invalid",
    ]);
  });

  it.each([[[]], [[{ type: "read_write", host: "a.example.invalid" }, { type: "read_write", host: "b.example.invalid" }]]])(
    "fails after the password line unless exactly one read_write endpoint exists",
    async (list) => {
      const result = await mask((path) =>
        path.endsWith("reveal_password") ? { status: 200, body: { password: "synthetic-pw" } } : endpoints(list),
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toEqual([`::add-mask::${ID}`, "::add-mask::synthetic-pw"]);
      expect(result.stderr).toHaveLength(1);
    },
  );

  it("ignores read_only endpoints when counting", async () => {
    const result = await mask((path) =>
      path.endsWith("reveal_password")
        ? { status: 200, body: { password: "synthetic-pw" } }
        : endpoints([{ type: "read_only", host: "ro.example.invalid" }, { type: "read_write", host: "rw.example.invalid" }]),
    );
    expect(result.stdout.at(-1)).toBe("::add-mask::rw.example.invalid");
  });

  it("fails without a password line when reveal returns 404", async () => {
    const result = await mask(() => ({ status: 404 }));
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([`::add-mask::${ID}`]);
    expect(result.stderr).toEqual(["mask: reveal_password request failed (http 404)"]);
    expect(result.requests).toHaveLength(1);
  });

  it("retries 423 and then succeeds", async () => {
    let reveals = 0;
    const result = await mask((path) => {
      if (path.endsWith("reveal_password")) return ++reveals === 1 ? { status: 423 } : { status: 200, body: { password: "synthetic-pw" } };
      return endpoints([{ type: "read_write", host: "h.example.invalid" }]);
    });
    expect(result.code).toBe(0);
    expect(reveals).toBe(2);
  });

  it("rejects values with line breaks and never prints them", async () => {
    const result = await mask(() => ({ status: 200, body: { password: "bad\nvalue" } }));
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([`::add-mask::${ID}`]);
  });

  it("rejects an empty host", async () => {
    const result = await mask((path) =>
      path.endsWith("reveal_password") ? { status: 200, body: { password: "synthetic-pw" } } : endpoints([{ type: "read_write", host: "" }]),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toHaveLength(2);
  });
});
