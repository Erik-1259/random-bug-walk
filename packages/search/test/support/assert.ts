import { expect } from "vitest";
import type { CallResult, SearchRecord } from "../../src/index.ts";

export function recorded(result: CallResult): Extract<CallResult, { status: "recorded" }> {
  if (result.status !== "recorded") {
    throw new Error(`expected a record, got refusal ${result.code}`);
  }
  return result;
}

export function recordOf(result: CallResult): SearchRecord {
  return recorded(result).record;
}

export function expectRefused(result: CallResult, code: string): void {
  expect(result.status).toBe("refused");
  if (result.status === "refused") {
    expect(result.code).toBe(code);
  }
}
