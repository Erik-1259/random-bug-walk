import { asRecord, describe, isSuccess, parseJson, send } from "./api.ts";
import type { Deps } from "./api.ts";
import type { Config } from "./config.ts";

const MASK_BUDGET_MS = 60_000;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
export const DEFAULT_ROLE = "neondb_owner";

export interface MaskIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** The password as the WHATWG URL `password` setter writes it into a connection string. */
export function encodedPassword(password: string): string {
  const url = new URL("postgresql://user@host/");
  url.password = password;
  return url.password;
}

export function usable(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !CONTROL_CHARACTERS.test(value);
}

/**
 * Registers the branch ID, role password and endpoint host as workflow secrets so that a
 * connection string built from them is hidden in logs. Prints only `::add-mask::` lines.
 */
export async function runMask(deps: Deps, config: Config, branchId: string, io: MaskIo): Promise<0 | 1> {
  io.stdout(`::add-mask::${branchId}`);
  const base = `/projects/${config.projectId}/branches/${branchId}`;

  const reveal = await send(deps, config, "GET", `${base}/roles/${DEFAULT_ROLE}/reveal_password`, MASK_BUDGET_MS);
  if (!isSuccess(reveal)) {
    io.stderr(`mask: reveal_password request failed (${describe(reveal)})`);
    return 1;
  }
  const password = asRecord(parseJson(reveal.text))?.password;
  if (!usable(password)) {
    io.stderr("mask: reveal_password response has no usable password");
    return 1;
  }
  io.stdout(`::add-mask::${password}`);
  const encoded = encodedPassword(password);
  if (encoded !== password && usable(encoded)) io.stdout(`::add-mask::${encoded}`);

  const endpoints = await send(deps, config, "GET", `${base}/endpoints`, MASK_BUDGET_MS);
  if (!isSuccess(endpoints)) {
    io.stderr(`mask: endpoints request failed (${describe(endpoints)})`);
    return 1;
  }
  const list = asRecord(parseJson(endpoints.text))?.endpoints;
  if (!Array.isArray(list)) {
    io.stderr("mask: endpoints response is malformed");
    return 1;
  }
  const writers = (list as unknown[]).filter((entry) => asRecord(entry)?.type === "read_write");
  if (writers.length !== 1) {
    io.stderr(`mask: expected exactly one read_write endpoint, found ${String(writers.length)}`);
    return 1;
  }
  const host = asRecord(writers[0])?.host;
  if (!usable(host)) {
    io.stderr("mask: endpoint has no usable host");
    return 1;
  }
  io.stdout(`::add-mask::${host}`);
  return 0;
}
