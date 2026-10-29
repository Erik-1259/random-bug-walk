import {
  OBSERVABLE_FAILURE_MAX_CHARS, OBSERVABLE_FAILURE_MIN_CHARS, OPEN_FAILURE_CODE_PATTERN,
  OTF_OPEN_CRITERION_ID, OTF_OPEN_FAMILIES, OTF_RESERVED_FAILURE_CODES, PROVEN_FAILURE_CODES,
  type OtfClassification, type OtfCriterionId, type OtfOpenRule,
} from "../../otf/contract.ts";

// eslint-disable-next-line @typescript-eslint/no-misused-spread -- SPEC 8.3 counts code points, not grapheme clusters.
const codePoints = (text: string) => [...text].length;
const codePattern = new RegExp(OPEN_FAILURE_CODE_PATTERN, "u");
const reservedCodes: readonly string[] = [...PROVEN_FAILURE_CODES, ...OTF_RESERVED_FAILURE_CODES];

/** SPEC 8.3: validate the edited value, using the schema's Unicode code-point limits. */
export function ruleProblem(rule: OtfOpenRule | null | undefined): string | null {
  if (rule === null || rule === undefined) return "Describe the open behavior's rule before accepting.";
  if (!(OTF_OPEN_FAMILIES as readonly string[]).includes(rule.family)) return "Choose an open behavior family.";
  const size = codePoints(rule.observable_failure);
  if (size < OBSERVABLE_FAILURE_MIN_CHARS || size > OBSERVABLE_FAILURE_MAX_CHARS) return `The observable failure must contain ${String(OBSERVABLE_FAILURE_MIN_CHARS)} to ${String(OBSERVABLE_FAILURE_MAX_CHARS)} characters.`;
  if (/[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]/u.test(rule.observable_failure)) return "Use plain text without control, separator or format characters for the observable failure.";
  if (!codePattern.test(rule.failure_code)) return "Use 3 to 48 lowercase letters, digits or underscores for the failure code, starting with a letter.";
  if (reservedCodes.includes(rule.failure_code)) return "Choose a failure code that is not a proven or reserved code.";
  return null;
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

export function OpenRuleFields({ rule, disabled, onChange }: { rule: OtfOpenRule | null; disabled: boolean; onChange?: (rule: OtfOpenRule) => void }) {
  const value: OtfOpenRule = rule ?? { family: "data_handling", observable_failure: "", failure_code: "" };
  return <fieldset disabled={disabled || onChange === undefined}>
    <legend>Open behavior rule</legend>
    <p>Open behaviors are not measured yet. The builder&apos;s checks will look for exactly this failure.</p>
    <label htmlFor="otf-rule-family">Family
      <select id="otf-rule-family" value={value.family} onChange={event => { const family = OTF_OPEN_FAMILIES.find(option => option === event.target.value); if (family !== undefined) onChange?.({ ...value, family }); }}>
        {OTF_OPEN_FAMILIES.map(family => <option key={family} value={family}>{family}</option>)}
      </select>
    </label>
    <label htmlFor="otf-rule-observable_failure">Observable failure
      <textarea id="otf-rule-observable_failure" value={value.observable_failure} aria-describedby="otf-rule-count" onChange={event => { onChange?.({ ...value, observable_failure: event.target.value }); }}/>
    </label>
    <p id="otf-rule-count">{codePoints(value.observable_failure)} / {OBSERVABLE_FAILURE_MAX_CHARS} characters; at least {OBSERVABLE_FAILURE_MIN_CHARS}.</p>
    <label htmlFor="otf-rule-failure_code">Failure code
      <input id="otf-rule-failure_code" value={value.failure_code} onChange={event => { onChange?.({ ...value, failure_code: event.target.value }); }}/>
    </label>
  </fieldset>;
}
