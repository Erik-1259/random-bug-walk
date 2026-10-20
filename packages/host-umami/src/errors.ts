/** Why the adapter refused an input. Callers branch on `code`, never on the message. */
export const UMAMI_REFUSAL_CODES = [
  // A catalog entry, protocol or time the adapter does not know or cannot read.
  "unknown_entry",
  "protocol_mismatch",
  "time_invalid",
  // A catalog entry whose planted change touches a file the original suite imports from its pristine copy.
  "closure_target",
  // The prepared store.
  "store_missing",
  "store_invalid",
  "store_object_mismatch",
  "store_tree_mismatch",
  // copyPlans: trees and validator material that do not belong to this host's pinned image.
  "clean_tree_mismatch",
  "state_tree_mismatch",
  "evaluator_mismatch",
  "checks_not_kit",
  // collect: a collected copy that is not the plan's.
  "copy_mismatch",
  // The frozen suite or the fixture's vectors differ from the pins.
  "suite_mismatch",
  "vectors_mismatch",
] as const;

export type UmamiRefusalCode = (typeof UMAMI_REFUSAL_CODES)[number];

export class UmamiRefusal extends Error {
  override name = "UmamiRefusal";
  readonly code: UmamiRefusalCode;

  constructor(code: UmamiRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
