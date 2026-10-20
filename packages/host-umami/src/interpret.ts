// Combines the copy records of one copy state into its two cells under the declared protocol
// (rule umami.min-valid-runs). An invalid copy makes a cell `error`, too few valid runs make it
// `incomplete`, and neither is ever folded into a pass or a fail. A failure code counts only when
// every valid run of the cell reported it.
import type { CellObservation, CopyRecord, InterpretedCells, Protocol } from "@rbw/factory-contract";
import { UmamiRefusal } from "./errors.ts";
import { isUmamiProtocol } from "./protocol.ts";
import { byCodePoint } from "./tree.ts";

const isValid = (cell: CellObservation): boolean => cell.observed === "pass" || cell.observed === "fail";

/** One cell from the cells of a state's copies; `missingRuns` counts the runs of copies with no record. */
export function combineCells(cells: readonly CellObservation[], minValid: number, missingRuns: number): CellObservation {
  const validCells = cells.filter(isValid);
  const runsValid = validCells.reduce((sum, cell) => sum + cell.runs_valid, 0);
  const runsTotal = cells.reduce((sum, cell) => sum + cell.runs_total, 0) + missingRuns;
  const observed = cells.some((cell) => cell.observed === "error")
    ? "error"
    : runsValid < minValid
      ? "incomplete"
      : validCells.some((cell) => cell.observed === "fail")
        ? "fail"
        : "pass";
  const [first, ...rest] = validCells;
  const codes = observed === "fail" && first !== undefined ? first.failure_codes.filter((code) => rest.every((cell) => cell.failure_codes.includes(code))) : [];
  return {
    observed,
    runs_valid: runsValid,
    runs_total: runsTotal,
    failure_codes: [...new Set(codes)].sort(byCodePoint),
    detail: cells.map((cell) => cell.detail).join(" | "),
  };
}

export function interpret(records: readonly CopyRecord[], protocol: Protocol): InterpretedCells {
  if (!isUmamiProtocol(protocol)) throw new UmamiRefusal("protocol_mismatch", "the protocol is not the Umami catalog's");
  const [first] = records;
  if (first === undefined) {
    const none: CellObservation = { observed: "incomplete", runs_valid: 0, runs_total: 0, failure_codes: [], detail: "no copy record" };
    return { original_suite: { ...none }, verification: { ...none } };
  }
  const { state } = first;
  if (records.some((record) => record.state !== state)) throw new UmamiRefusal("protocol_mismatch", "the records are of more than one copy state");
  if (new Set(records.map((record) => record.copy_id)).size !== records.length) throw new UmamiRefusal("protocol_mismatch", "a copy record repeats");
  const declared = protocol.per_state[state];
  if (records.length > declared.copies) throw new UmamiRefusal("protocol_mismatch", `the protocol declares ${String(declared.copies)} ${state} copies`);
  const missing = declared.copies - records.length;
  const suites: CellObservation[] = records.map((record) => ({
    observed: record.original_suite.observed,
    runs_valid: record.original_suite.runs_valid,
    runs_total: record.original_suite.runs_total,
    failure_codes: record.original_suite.failure_codes,
    detail: record.original_suite.detail,
  }));
  return {
    original_suite: combineCells(suites, declared.copies, missing),
    verification: combineCells(
      records.map((record) => record.verification),
      declared.min_valid_runs,
      missing * declared.rounds_per_copy,
    ),
  };
}
