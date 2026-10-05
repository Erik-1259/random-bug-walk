import { canonicalDigest } from "@rbw/schema";
import type { Basis, Comparison, Decision, Evidence, ImportCode, RuleDecision, RuleOutcome, TrialEvidence, TrialRef } from "./output.ts";

/** Admission rules decided outside this package; listed in the output and never marked here. */
const NOT_EVALUATED_HERE = ["ADM-01", "ADM-07", "ADM-09", "ADM-10"];

const FIXED = ["fixed-01", "fixed-02", "fixed-03", "fixed-04", "fixed-05"];
const PLANTED = ["planted-01", "planted-02", "planted-03", "planted-04", "planted-05"];
const PROBES = ["partial-01", "stub-01"];

const ref = (trial: TrialEvidence, basis: Basis): TrialRef => ({ trial_id: trial.trial_id, basis, status: trial.status, reason: trial.reason, code: trial.code });

/**
 * The first completeness finding of an incomplete trial whose code is one of codes: an expected
 * original test or added check that did not execute. A missing result has a different code.
 */
function notExecutedFinding(trial: TrialEvidence, codes: readonly ImportCode[]): TrialRef | null {
  if (trial.status !== "incomplete" || trial.stage !== "completeness") return null;
  const found = trial.findings.find((item) => codes.includes(item.code));
  if (found === undefined) return null;
  return { trial_id: trial.trial_id, basis: "execution", status: "invalid", reason: found.code === "import:test_skipped" ? "test_skipped" : "test_missing", code: found.code };
}

/** An added observation that was skipped or not_run, as an invalid execution. */
function notRunObservation(trial: TrialEvidence): TrialRef | null {
  const notRun = (trial.added?.observations ?? []).find((item) => item.observed === "skipped" || item.observed === "not_run");
  return notRun === undefined ? null : { trial_id: trial.trial_id, basis: "execution", status: "invalid", reason: notRun.reason, code: "import:outcome_not_run" };
}

/** A missing added check, or an outcomes-stage incomplete trial's skipped or not_run observation. */
function addedNotExecuted(trial: TrialEvidence): TrialRef | null {
  return notExecutedFinding(trial, ["import:check_missing"]) ?? (trial.status === "incomplete" && trial.stage === "outcomes" ? notRunObservation(trial) : null);
}

const failedOriginal = (trial: TrialEvidence): boolean => (trial.original?.failed_test_ids.length ?? 0) > 0;

/** The trial IDs whose added checks, and those whose original suite, a rule reads. */
interface Scope {
  added: readonly string[];
  original: readonly string[];
  /** ADM-06: a broken required probe leaves the rule incomplete, whatever the trial's status. */
  brokenIsIncomplete?: boolean;
  /** ADM-03: an added check that is missing, skipped or not_run makes the trial invalid for the rule. */
  addedNotExecutedIsInvalid?: boolean;
}

/**
 * One rule over the trials in scope. A valid rejection is conclusive; otherwise a trial that is
 * invalid or incomplete for what the rule reads decides it; otherwise the rule passes. A trial
 * whose added checks failed at the outcomes stage still has valid original-suite evidence.
 */
function decideRule(trials: readonly TrialEvidence[], scope: Scope): RuleDecision {
  const readsAdded = (trial: TrialEvidence): boolean => scope.added.includes(trial.trial_id);
  const inScope = trials.filter((trial) => readsAdded(trial) || scope.original.includes(trial.trial_id));
  const rejects = inScope.flatMap((trial) => [
    ...(readsAdded(trial) && trial.added?.verdict === "reject" ? [ref(trial, "added_checks")] : []),
    ...(scope.original.includes(trial.trial_id) && failedOriginal(trial) ? [ref(trial, "original_suite")] : []),
  ]);
  if (rejects.length > 0) return { decision: "reject", trials: rejects };
  const broken = inScope.filter((trial) => trial.status !== "complete" && (readsAdded(trial) || trial.original === null));
  if (broken.length > 0 && scope.brokenIsIncomplete === true) return { decision: "incomplete", trials: broken.map((trial) => ref(trial, "trial_status")) };
  const brokenRefs = broken.map((trial): TrialRef => {
    const notExecuted = scope.addedNotExecutedIsInvalid === true && readsAdded(trial) ? addedNotExecuted(trial) : null;
    return notExecuted ?? ref(trial, "trial_status");
  });
  for (const status of ["invalid", "incomplete"] as const) {
    const matching = brokenRefs.filter((item) => item.status === status);
    if (matching.length > 0) return { decision: status, trials: matching };
  }
  return { decision: "pass", trials: inScope.map((trial) => ref(trial, "trial_status")) };
}

function executionRefs(evidence: Evidence): TrialRef[] {
  const refs = evidence.trials.flatMap((trial): TrialRef[] => {
    const notExecuted = notExecutedFinding(trial, ["import:test_missing", "import:test_skipped", "import:check_missing"]);
    if (notExecuted !== null) return [notExecuted];
    if (trial.status !== "complete" && trial.stage !== "outcomes") return [ref(trial, "trial_status")];
    const setup = (trial.added?.observations ?? []).find((item) => item.observed === "setup_fail");
    if (setup !== undefined) return [{ trial_id: trial.trial_id, basis: "execution", status: "invalid", reason: setup.reason, code: "import:outcome_setup_fail" }];
    const notRun = notRunObservation(trial);
    return notRun === null ? [] : [notRun];
  });
  const unexpected = evidence.unexpected_results.map((item): TrialRef => ({ trial_id: item.name, basis: "unexpected_result", status: item.status, reason: null, code: item.code }));
  return [...refs, ...unexpected];
}

function decideExecutions(evidence: Evidence): RuleDecision {
  // ADM-02: every expected trial has a result, and every original test and added-check repetition
  // executed once in it. An expected test or check that did not execute (absent, skipped or
  // not_run) and a setup failure make the rule invalid; any other trial that fails stages 1-4 or
  // the driver step decides it with that trial's status.
  const refs = executionRefs(evidence);
  for (const status of ["invalid", "incomplete"] as const) {
    const matching = refs.filter((item) => item.status === status);
    if (matching.length > 0) return { decision: status, trials: matching };
  }
  return { decision: "pass", trials: evidence.trials.map((trial) => ref(trial, "trial_status")) };
}

function comparison(trials: readonly TrialEvidence[]): { classification: Comparison; trials: TrialRef[] } {
  // ADM-08: the original-suite comparison, first match wins. Missing checks or infrastructure
  // failures never establish a blind spot.
  for (const status of ["invalid", "incomplete"] as const) {
    const matching = trials.filter((trial) => trial.status === status);
    if (matching.length > 0) return { classification: status, trials: matching.map((trial) => ref(trial, "trial_status")) };
  }
  const unproven = trials
    .filter((trial) => trial.code_state === "clean" || trial.code_state === "fixed")
    .flatMap((trial) => [...(failedOriginal(trial) ? [ref(trial, "original_suite")] : []), ...(trial.added?.verdict !== "match" ? [ref(trial, "added_checks")] : [])]);
  if (unproven.length > 0) return { classification: "not_demonstrated", trials: unproven };
  const caught = trials.filter((trial) => PLANTED.includes(trial.trial_id) && failedOriginal(trial));
  if (caught.length > 0) return { classification: "caught_by_original_suite", trials: caught.map((trial) => ref(trial, "original_suite")) };
  const negative = trials
    .filter((trial) => PLANTED.includes(trial.trial_id) || PROBES.includes(trial.trial_id))
    .flatMap((trial) => [
      ...(trial.added?.verdict !== "match" ? [ref(trial, "added_checks")] : []),
      ...(PROBES.includes(trial.trial_id) && failedOriginal(trial) ? [ref(trial, "original_suite")] : []),
    ]);
  if (negative.length > 0) return { classification: "not_demonstrated", trials: negative };
  return { classification: "blind_spot_demonstrated", trials: trials.map((trial) => ref(trial, "trial_status")) };
}

/** A valid rejection is conclusive; otherwise invalid, then incomplete, then pass. */
function outcomeVerdict(decisions: readonly RuleDecision[]): RuleOutcome {
  for (const outcome of ["reject", "invalid", "incomplete"] as const) if (decisions.some((item) => item.decision === outcome)) return outcome;
  return "pass";
}

/**
 * The decisions of one record set, as a pure function of its evidence. ADM decisions, the
 * comparison and outcome_verdict exist only for admission jobs; outcome_verdict is the outcome of
 * ADM-02 to ADM-06 and is not an admission.
 */
export function decide(evidence: Evidence): Decision {
  const base = { schema_version: 1, evidence_sha256: canonicalDigest(evidence).sha256, kind: evidence.request.kind, execution_id: evidence.request.execution_id };
  if (evidence.request.kind !== "admission") return { ...base, decisions: null, comparison: null, outcome_verdict: null, not_evaluated_here: [] };
  const { trials } = evidence;
  const decisions = {
    "ADM-02": decideExecutions(evidence),
    // ADM-03: all five fixed copies pass every added check, and clean and fixed copies pass every
    // original test; a missing, skipped or not_run added check on a fixed copy is invalid.
    "ADM-03": decideRule(trials, { added: FIXED, original: ["clean-01", ...FIXED], addedNotExecutedIsInvalid: true }),
    // ADM-04: all five planted copies match the declared vector; a valid unexpected pass rejects.
    "ADM-04": decideRule(trials, { added: PLANTED, original: [] }),
    // ADM-05: fixed-01 and planted-01 hold in all 20 repetitions; one inconsistent repetition rejects.
    "ADM-05": decideRule(trials, { added: ["fixed-01", "planted-01"], original: [] }),
    // ADM-06: each negative probe matches its own vector; a broken required probe leaves the rule incomplete.
    "ADM-06": decideRule(trials, { added: PROBES, original: [], brokenIsIncomplete: true }),
  };
  return {
    ...base,
    decisions,
    comparison: comparison(trials),
    outcome_verdict: outcomeVerdict(Object.values(decisions)),
    not_evaluated_here: [...NOT_EVALUATED_HERE],
  };
}
