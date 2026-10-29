import {
  OBSERVABLE_FAILURE_MAX_CHARS, OBSERVABLE_FAILURE_MIN_CHARS, OPEN_FAILURE_CODE_PATTERN,
  OTF_OPEN_CRITERION_ID, OTF_OPEN_FAMILIES, OTF_RESERVED_FAILURE_CODES, PROVEN_FAILURE_CODES,
  type OtfClassification, type OtfCriterionId, type OtfOpenRule,
} from "../../otf/contract.ts";

// eslint-disable-next-line @typescript-eslint/no-misused-spread -- SPEC 8.3 counts code points, not grapheme clusters.
const codePoints = (text: string) => [...text].length;
const codePattern = new RegExp(OPEN_FAILURE_CODE_PATTERN, "u");
const reservedCodes: readonly string[] = [...PROVEN_FAILURE_CODES, ...OTF_RESERVED_FAILURE_CODES];

export type OpenRuleField = "family" | "observable_failure" | "failure_code";

/** SPEC 8.3: every problem in the edited value, by field, using the schema's Unicode code-point limits. */
export function ruleFieldProblems(rule: OtfOpenRule): Partial<Record<OpenRuleField, string[]>> {
  const problems: Partial<Record<OpenRuleField, string[]>> = {};
  const add = (field: OpenRuleField, problem: string) => { (problems[field] ??= []).push(problem); };
  if (!(OTF_OPEN_FAMILIES as readonly string[]).includes(rule.family)) add("family", "Choose an open behavior family.");
  const size = codePoints(rule.observable_failure);
  if (size < OBSERVABLE_FAILURE_MIN_CHARS || size > OBSERVABLE_FAILURE_MAX_CHARS) add("observable_failure", `The observable failure must contain ${String(OBSERVABLE_FAILURE_MIN_CHARS)} to ${String(OBSERVABLE_FAILURE_MAX_CHARS)} characters.`);
  if (/[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u.test(rule.observable_failure)) add("observable_failure", "Use plain text without control, separator or format characters for the observable failure.");
  if (!codePattern.test(rule.failure_code)) add("failure_code", "Use 3 to 48 lowercase letters, digits or underscores for the failure code, starting with a letter.");
  else if (reservedCodes.includes(rule.failure_code)) add("failure_code", "Choose a failure code that is not a proven or reserved code.");
  return problems;
}

/** The first problem in the edited value, or null when the rule may be accepted. */
export function ruleProblem(rule: OtfOpenRule | null | undefined): string | null {
  if (rule === null || rule === undefined) return "Describe the open behavior's rule before accepting.";
  return Object.values(ruleFieldProblems(rule)).flat()[0] ?? null;
}

/** Enter in a rule field never submits the Accept form; only the Accept button starts a build. */
export function holdEnter(event: { key: string; preventDefault: () => void }): void {
  if (event.key === "Enter") event.preventDefault();
}

export interface ClassificationViewProps {
  classification: OtfClassification | null;
  criterionId: OtfCriterionId | null;
  provenLabel?: string;
  openAvailable?: boolean;
  disabled?: boolean;
  onOpen?: () => void;
}

export function ClassificationView({ classification, criterionId, provenLabel, openAvailable = false, disabled = false, onOpen }: ClassificationViewProps) {
  if (classification === null) return null;
  if (classification.refusal !== null) return <section aria-label="Custom behavior classification"><p role="status">{classification.refusal.reason}</p><p>The closest catalog bug is offered below.</p></section>;
  const matched = classification.proven_criterion_id;
  return <section aria-label="Custom behavior classification">
    {matched !== null && <>
      <p>This matches the proven behavior “{provenLabel ?? matched}”.</p>
      {criterionId === matched && <p>The picker now uses this proven behavior.</p>}
      {criterionId === OTF_OPEN_CRITERION_ID && <p>You are choosing an open behavior instead.</p>}
      {openAvailable && criterionId !== OTF_OPEN_CRITERION_ID && onOpen !== undefined && <button type="button" disabled={disabled} onClick={onOpen}>Use the open behavior instead</button>}
    </>}
  </section>;
}

/** Room for the 48-character maximum failure code, with a little to spare for wide letters. */
const FAILURE_CODE_SIZE = 52;
const BLANK_RULE: OtfOpenRule = { family: "data_handling", observable_failure: "", failure_code: "" };

export function OpenRuleFields({ rule, disabled, onChange }: { rule: OtfOpenRule | null; disabled: boolean; onChange?: (rule: OtfOpenRule) => void }) {
  const value: OtfOpenRule = rule ?? BLANK_RULE;
  const problems = ruleFieldProblems(value);
  const error = (field: OpenRuleField) => problems[field] === undefined ? null : <p id={`otf-rule-${field}-error`}>{problems[field].join(" ")}</p>;
  const invalid = (field: OpenRuleField) => problems[field] === undefined ? undefined : true;
  const described = (field: OpenRuleField, ...ids: string[]) => {
    const all = [...ids, ...(problems[field] === undefined ? [] : [`otf-rule-${field}-error`])];
    return all.length === 0 ? undefined : all.join(" ");
  };
  return <fieldset disabled={disabled || onChange === undefined} onKeyDown={holdEnter}>
    <legend>Open behavior rule</legend>
    <p>Open behaviors are not measured yet. The builder&apos;s checks will look for exactly this failure.</p>
    <label htmlFor="otf-rule-family">Family
      <select id="otf-rule-family" value={value.family} aria-invalid={invalid("family")} aria-describedby={described("family")} onChange={event => { const family = OTF_OPEN_FAMILIES.find(option => option === event.target.value); if (family !== undefined) onChange?.({ ...value, family }); }}>
        {OTF_OPEN_FAMILIES.map(family => <option key={family} value={family}>{family}</option>)}
      </select>
    </label>
    {error("family")}
    <label htmlFor="otf-rule-observable_failure">Observable failure
      <textarea id="otf-rule-observable_failure" value={value.observable_failure} aria-invalid={invalid("observable_failure")} aria-describedby={described("observable_failure", "otf-rule-count")} onChange={event => { onChange?.({ ...value, observable_failure: event.target.value }); }}/>
    </label>
    <p id="otf-rule-count">{codePoints(value.observable_failure)} / {OBSERVABLE_FAILURE_MAX_CHARS} characters; at least {OBSERVABLE_FAILURE_MIN_CHARS}.</p>
    {error("observable_failure")}
    <label htmlFor="otf-rule-failure_code">Failure code
      <input id="otf-rule-failure_code" value={value.failure_code} aria-invalid={invalid("failure_code")} aria-describedby={described("failure_code")} size={FAILURE_CODE_SIZE} onChange={event => { onChange?.({ ...value, failure_code: event.target.value }); }}/>
    </label>
    {error("failure_code")}
  </fieldset>;
}
