import {
  ASSERTION_FAILURE_CODE_VALUES,
  CODE_STATE_VALUES,
  EXPECTED_OUTCOME_VALUES,
  JOB_KIND_VALUES,
  OBSERVED_OUTCOME_VALUES,
  TRIAL_REASON_VALUES,
  TRIAL_STATUS_VALUES,
} from "@rbw/schema";

/**
 * The shapes of evidence.json and decision.json. Each shape is data, so the same definition gives
 * the TypeScript type (Infer) and the runtime check (shapeErrors) that the real-records test uses.
 */
type Shape =
  | { readonly t: "string" }
  | { readonly t: "integer" }
  | { readonly t: "boolean" }
  | { readonly t: "enum"; readonly values: readonly string[] }
  | { readonly t: "nullable"; readonly of: Shape }
  | { readonly t: "array"; readonly of: Shape }
  | { readonly t: "object"; readonly fields: Readonly<Record<string, Shape>> };

type Infer<S> = S extends { t: "string" }
  ? string
  : S extends { t: "integer" }
    ? number
    : S extends { t: "boolean" }
      ? boolean
      : S extends { t: "enum"; values: readonly (infer V)[] }
        ? V
        : S extends { t: "nullable"; of: infer O }
          ? Infer<O> | null
          : S extends { t: "array"; of: infer O }
            ? Infer<O>[]
            : S extends { t: "object"; fields: infer F }
              ? { -readonly [K in keyof F]: Infer<F[K]> }
              : never;

const str = { t: "string" } as const;
const int = { t: "integer" } as const;
const bool = { t: "boolean" } as const;
const oneOf = <const V extends readonly string[]>(values: V): { readonly t: "enum"; readonly values: V } => ({ t: "enum", values });
const nullable = <const O extends Shape>(of: O): { readonly t: "nullable"; readonly of: O } => ({ t: "nullable", of });
const arrayOf = <const O extends Shape>(of: O): { readonly t: "array"; readonly of: O } => ({ t: "array", of });
const obj = <const F extends Readonly<Record<string, Shape>>>(fields: F): { readonly t: "object"; readonly fields: F } => ({ t: "object", fields });

export const STAGE_VALUES = ["shape", "identity", "completeness", "provenance", "driver", "outcomes"] as const;
export type Stage = (typeof STAGE_VALUES)[number];

/** Importer error codes; the README lists the stage that produces each. */
export const IMPORT_CODE_VALUES = [
  "import:request_missing",
  "import:request_invalid",
  "import:key_unsafe",
  "import:expected_trials_missing",
  "import:expected_trials_invalid",
  "import:expected_trials_hash",
  "import:shape_result",
  "import:shape_observations",
  "import:shape_artifacts",
  "import:shape_original_suite",
  "import:identity_request",
  "import:identity_trial_id",
  "import:identity_code_state",
  "import:identity_observations",
  "import:identity_artifacts",
  "import:identity_original_suite",
  "import:identity_unexpected_trial",
  "import:driver_status",
  "import:result_missing",
  "import:test_unexpected",
  "import:test_missing",
  "import:test_skipped",
  "import:check_unexpected",
  "import:repeat_unexpected",
  "import:check_missing",
  "import:observations_missing",
  "import:observations_hash_mismatch",
  "import:artifacts_missing",
  "import:artifacts_hash_mismatch",
  "import:artifact_missing",
  "import:artifact_hash_mismatch",
  "import:response_unlisted",
  "import:response_hash_mismatch",
  "import:outcome_setup_fail",
  "import:outcome_unrelated_code",
  "import:outcome_not_run",
] as const;
export type ImportCode = (typeof IMPORT_CODE_VALUES)[number];

export const OBSERVATION_CLASS_VALUES = ["positive", "negative_control", "reject", "invalid", "incomplete"] as const;
export const ADDED_VERDICT_VALUES = ["match", "reject", "invalid", "incomplete"] as const;
export const CELL_STATE_VALUES = ["not_run", "pass", "fail", "invalid", "incomplete"] as const;
export const RULE_DECISION_VALUES = ["pass", "reject", "invalid", "incomplete"] as const;
export const COMPARISON_VALUES = ["invalid", "incomplete", "not_demonstrated", "caught_by_original_suite", "blind_spot_demonstrated"] as const;
export const BASIS_VALUES = ["trial_status", "execution", "added_checks", "original_suite", "unexpected_result"] as const;
export const OUTCOME_FILE_VALUES = ["passed", "failed", "skipped"] as const;

const finding = obj({ code: oneOf(IMPORT_CODE_VALUES), detail: str });

const observation = obj({
  check_id: str,
  repeat_index: int,
  expected: oneOf(EXPECTED_OUTCOME_VALUES),
  expected_failure_code: nullable(oneOf(ASSERTION_FAILURE_CODE_VALUES)),
  observed: oneOf(OBSERVED_OUTCOME_VALUES),
  failure_code: nullable(oneOf([...ASSERTION_FAILURE_CODE_VALUES, ...TRIAL_REASON_VALUES])),
  classification: oneOf(OBSERVATION_CLASS_VALUES),
  reason: nullable(oneOf(TRIAL_REASON_VALUES)),
  response_artifact_key: nullable(str),
});

const trial = obj({
  trial_id: str,
  code_state: oneOf(CODE_STATE_VALUES),
  status: oneOf(TRIAL_STATUS_VALUES),
  stage: oneOf(STAGE_VALUES),
  reason: nullable(oneOf(TRIAL_REASON_VALUES)),
  code: nullable(oneOf(IMPORT_CODE_VALUES)),
  findings: arrayOf(finding),
  driver_status: nullable(oneOf(TRIAL_STATUS_VALUES)),
  driver_reason: nullable(oneOf(TRIAL_REASON_VALUES)),
  observations_key: nullable(str),
  artifacts_key: nullable(str),
  original_suite_key: nullable(str),
  artifact_keys: arrayOf(str),
  added: nullable(obj({ verdict: oneOf(ADDED_VERDICT_VALUES), observations: arrayOf(observation) })),
  original: nullable(obj({ tests: arrayOf(obj({ test_id: str, outcome: oneOf(["passed", "failed"]) })), failed_test_ids: arrayOf(str) })),
  diagnostics: nullable(
    arrayOf(
      obj({
        check_id: str,
        repeat_index: int,
        observed: oneOf(OBSERVED_OUTCOME_VALUES),
        failure_code: nullable(oneOf([...ASSERTION_FAILURE_CODE_VALUES, ...TRIAL_REASON_VALUES])),
      }),
    ),
  ),
});

const cell = obj({
  trial_id: str,
  suite: oneOf(["original", "added"]),
  state: oneOf(CELL_STATE_VALUES),
  matches_expectation: bool,
  suite_sha256: nullable(str),
  expected_ids: arrayOf(str),
  expected_count: int,
  executed_ids: arrayOf(str),
  executed_count: int,
  failing: arrayOf(obj({ id: str, repeat_index: nullable(int), failure_code: nullable(str) })),
  artifact_keys: arrayOf(str),
});

export const EVIDENCE_SHAPE = obj({
  schema_version: int,
  request: obj({
    kind: oneOf(JOB_KIND_VALUES),
    execution_id: str,
    root_execution_id: str,
    project_policy_sha256: str,
    task_revision: str,
    expected_trials_key: str,
    expected_trials_sha256: str,
  }),
  trials: arrayOf(trial),
  unexpected_results: arrayOf(obj({ name: str, status: oneOf(["invalid"]), stage: oneOf(["identity"]), code: oneOf(["import:identity_unexpected_trial"]) })),
  cells: nullable(arrayOf(cell)),
});

const trialRef = obj({
  trial_id: str,
  basis: oneOf(BASIS_VALUES),
  status: oneOf(TRIAL_STATUS_VALUES),
  reason: nullable(oneOf(TRIAL_REASON_VALUES)),
  code: nullable(oneOf(IMPORT_CODE_VALUES)),
});

const rule = obj({ decision: oneOf(RULE_DECISION_VALUES), trials: arrayOf(trialRef) });

export const DECISION_SHAPE = obj({
  schema_version: int,
  evidence_sha256: str,
  kind: oneOf(JOB_KIND_VALUES),
  execution_id: str,
  decisions: nullable(obj({ "ADM-02": rule, "ADM-03": rule, "ADM-04": rule, "ADM-05": rule, "ADM-06": rule })),
  comparison: nullable(obj({ classification: oneOf(COMPARISON_VALUES), trials: arrayOf(trialRef) })),
  outcome_verdict: nullable(oneOf(RULE_DECISION_VALUES)),
  not_evaluated_here: arrayOf(str),
});

export type Evidence = Infer<typeof EVIDENCE_SHAPE>;
export type TrialEvidence = Infer<typeof trial>;
export type ObservationEvidence = Infer<typeof observation>;
export type Finding = Infer<typeof finding>;
export type Cell = Infer<typeof cell>;
export type CellState = (typeof CELL_STATE_VALUES)[number];
export type AddedVerdict = (typeof ADDED_VERDICT_VALUES)[number];
export type ObservationClass = (typeof OBSERVATION_CLASS_VALUES)[number];
export type Decision = Infer<typeof DECISION_SHAPE>;
export type RuleDecision = Infer<typeof rule>;
export type RuleOutcome = (typeof RULE_DECISION_VALUES)[number];
export type Comparison = (typeof COMPARISON_VALUES)[number];
export type TrialRef = Infer<typeof trialRef>;
export type Basis = (typeof BASIS_VALUES)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function check(shape: Shape, value: unknown, path: string, errors: string[]): void {
  switch (shape.t) {
    case "string":
      if (typeof value !== "string") errors.push(`${path}: string`);
      return;
    case "integer":
      if (!Number.isSafeInteger(value)) errors.push(`${path}: integer`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: boolean`);
      return;
    case "enum":
      if (typeof value !== "string" || !shape.values.includes(value)) errors.push(`${path}: enum`);
      return;
    case "nullable":
      if (value !== null) check(shape.of, value, path, errors);
      return;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path}: array`);
        return;
      }
      value.forEach((item: unknown, index) => {
        check(shape.of, item, `${path}/${String(index)}`, errors);
      });
      return;
    case "object": {
      if (!isPlainObject(value)) {
        errors.push(`${path}: object`);
        return;
      }
      for (const key of Object.keys(value)) if (!(key in shape.fields)) errors.push(`${path}/${key}: unknown`);
      for (const [key, field] of Object.entries(shape.fields)) {
        if (!(key in value)) errors.push(`${path}/${key}: missing`);
        else check(field, value[key], `${path}/${key}`, errors);
      }
    }
  }
}

/** Errors of a value against the evidence.json shape; empty when it conforms. */
export function evidenceErrors(value: unknown): string[] {
  const errors: string[] = [];
  check(EVIDENCE_SHAPE, value, "", errors);
  return errors;
}

/** Errors of a value against the decision.json shape; empty when it conforms. */
export function decisionErrors(value: unknown): string[] {
  const errors: string[] = [];
  check(DECISION_SHAPE, value, "", errors);
  return errors;
}
