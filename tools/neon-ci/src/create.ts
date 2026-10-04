import { asRecord, describe, isSuccess, listBranches, parseJson, send } from "./api.ts";
import type { Deps } from "./api.ts";
import { isBranchId } from "./config.ts";
import type { Config } from "./config.ts";

const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const DEFAULT_ROLE = "neondb_owner";

/** The password as the WHATWG URL `password` setter writes it into a connection string. */
function encodedPassword(password: string): string {
  const url = new URL("postgresql://user@host/");
  url.password = password;
  return url.password;
}

function usable(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !CONTROL_CHARACTERS.test(value);
}

const READ_BUDGET_MS = 60_000;
const EXPIRY_HOURS = 4;
const PREFERRED_DATABASE = "neondb";

export interface CreateIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Writes `name=value` lines to the step's output file. */
  output: (name: string, value: string) => void;
  summary: (text: string) => void;
}

/** RFC 3339 in UTC with whole seconds, four hours after `nowMs`. */
export function expiryFor(nowMs: number): string {
  return new Date(nowMs + EXPIRY_HOURS * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function mask(io: CreateIo, value: string): void {
  io.stdout(`::add-mask::${value}`);
}

function fail(io: CreateIo, message: string): 1 {
  io.stderr(`create: ${message}`);
  return 1;
}

/**
 * Creates the branch through Neon's REST API. Every secret or provider identifier is registered with
 * `::add-mask::` as soon as it is known and before anything else is printed or written, so no log
 * line, debug line or step output can show it unmasked. Returns 1 when the branch name is taken or
 * any request fails; a branch created before a later failure is removed by the delete step, by name.
 */
export async function runCreate(deps: Deps, config: Config, name: string, io: CreateIo): Promise<0 | 1> {
  const listed = await listBranches(deps, config);
  if ("unreadable" in listed) return fail(io, listed.unreadable);
  if (listed.branches.some((branch) => branch.name === name)) return fail(io, `branch ${name} already exists`);

  const expiresAt = expiryFor(deps.now());
  const projectPath = `/projects/${config.projectId}`;
  const created = await send(
    deps,
    config,
    "POST",
    `${projectPath}/branches`,
    0,
    { branch: { name, expires_at: expiresAt }, endpoints: [{ type: "read_write" }] },
  );
  if (!isSuccess(created)) return fail(io, `create branch request failed (${describe(created)})`);
  const branchId = asRecord(asRecord(parseJson(created.text))?.branch)?.id;
  if (typeof branchId !== "string" || !isBranchId(branchId)) return fail(io, "create branch response has no usable branch id");
  mask(io, branchId);

  const base = `${projectPath}/branches/${branchId}`;
  const reveal = await send(deps, config, "GET", `${base}/roles/${DEFAULT_ROLE}/reveal_password`, READ_BUDGET_MS);
  if (!isSuccess(reveal)) return fail(io, `reveal_password request failed (${describe(reveal)})`);
  const password = asRecord(parseJson(reveal.text))?.password;
  if (!usable(password)) return fail(io, "reveal_password response has no usable password");
  mask(io, password);
  const encoded = encodedPassword(password);
  if (encoded !== password && usable(encoded)) mask(io, encoded);

  const endpoints = await send(deps, config, "GET", `${base}/endpoints`, READ_BUDGET_MS);
  if (!isSuccess(endpoints)) return fail(io, `endpoints request failed (${describe(endpoints)})`);
  const endpointList = asRecord(parseJson(endpoints.text))?.endpoints;
  if (!Array.isArray(endpointList)) return fail(io, "endpoints response is malformed");
  const records = (endpointList as unknown[]).map(asRecord);
  for (const record of records) if (usable(record?.host)) mask(io, record.host);
  const writers = records.filter((record) => record?.type === "read_write");
  const host = asRecord(writers[0])?.host;
  if (writers.length !== 1 || !usable(host)) {
    return fail(io, `expected exactly one read_write endpoint with a host, found ${String(writers.length)}`);
  }

  const databases = await send(deps, config, "GET", `${base}/databases`, READ_BUDGET_MS);
  if (!isSuccess(databases)) return fail(io, `databases request failed (${describe(databases)})`);
  const databaseList = asRecord(parseJson(databases.text))?.databases;
  if (!Array.isArray(databaseList)) return fail(io, "databases response is malformed");
  const owned = (databaseList as unknown[])
    .map(asRecord)
    .filter((record) => record?.owner_name === DEFAULT_ROLE && usable(record.name))
    .map((record) => record?.name as string);
  const database = owned.includes(PREFERRED_DATABASE) ? PREFERRED_DATABASE : owned.length === 1 ? owned[0] : undefined;
  if (database === undefined) return fail(io, `no unambiguous database owned by ${DEFAULT_ROLE}`);

  const url = new URL(`postgresql://${DEFAULT_ROLE}@${host}/${encodeURIComponent(database)}`);
  url.password = password;
  url.searchParams.set("sslmode", "verify-full");
  mask(io, url.href);

  io.output("created", "true");
  io.output("db_url", url.href);
  io.stdout(`Neon branch: ${name} (expires ${expiresAt})`);
  io.summary(`### Neon branch\n- name: \`${name}\`\n- expires: ${expiresAt}`);
  return 0;
}
