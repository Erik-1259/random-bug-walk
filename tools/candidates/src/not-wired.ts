import { PipelineError } from "./pipeline.ts";

/** Marks a placeholder so the run record and the command line can say it is not wired. */
export const NOT_WIRED = Symbol("not wired");

export type Placeholder = ((...args: unknown[]) => never) & { [NOT_WIRED]: string };

/** A function that throws when called, naming the implementation that should replace it. */
export function notWired(name: string, replacement: string): Placeholder {
  const placeholder = (): never => {
    throw new PipelineError(`${name} is not wired yet: bind ${replacement} in tools/candidates/src/wiring.ts`);
  };
  return Object.assign(placeholder, { [NOT_WIRED]: name });
}

export function isWired(fn: unknown): boolean {
  return typeof fn === "function" && !(NOT_WIRED in fn);
}

/** The name recorded for an implementation: "not_wired" for a placeholder, otherwise its function name. */
export function implementationName(fn: unknown): string {
  if (!isWired(fn)) return "not_wired";
  const name = (fn as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : "anonymous";
}
