// The site finder and screen the command line uses. Each is one line: when the real
// implementation lands, replace that line with a re-export, for example
//   export { findSites } from "@rbw/shapes";
// The pipeline and its tests do not import this file; they take the functions as arguments.
import { notWired } from "./not-wired.ts";
import type { FindSites, Screen } from "./types.ts";

export const findSites: FindSites = notWired("findSites", "the class-level site finder in @rbw/shapes");
export const screen: Screen = notWired("screen", "the static-headroom screen");
