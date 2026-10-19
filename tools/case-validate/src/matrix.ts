// The validation result of contract section 11 from the six observed cells.
import type { CellObservation, CheckSet, CopyState, ExpectedMatrix, InterpretedCells, ValidationResult } from "@rbw/factory-contract";
import { CHECK_SET_VALUES, COPY_STATE_VALUES } from "@rbw/factory-contract";

export type CellMatrix = Record<CheckSet, Record<CopyState, CellObservation>>;

/**
 * `passed`: every cell is a valid pass or fail equal to its expectation. `failed`: every cell is a valid
 * pass or fail and at least one differs. `error`: any cell is error or incomplete, whatever the others show.
 */
export function evaluateMatrix(cells: Record<CopyState, InterpretedCells>, expected: ExpectedMatrix): { result: ValidationResult; matrix: CellMatrix } {
  const row = (check: CheckSet): Record<CopyState, CellObservation> => ({
    clean: cells.clean[check],
    buggy: cells.buggy[check],
    fixed: cells.fixed[check],
  });
  const matrix: CellMatrix = { original_suite: row("original_suite"), verification: row("verification") };
  const all = CHECK_SET_VALUES.flatMap((check) => COPY_STATE_VALUES.map((state) => ({ observed: matrix[check][state].observed, expected: expected[check][state] })));
  if (all.some((cell) => cell.observed === "error" || cell.observed === "incomplete")) return { result: "error", matrix };
  return { result: all.every((cell) => cell.observed === cell.expected) ? "passed" : "failed", matrix };
}
