import { ADMISSION_RULES, type AdmissionRule, type OtfAdmissionResult } from "../../otf/contract.ts";

/** SPEC section 1.1: the strip's labels and the value each one shows as passed. */
const RULE_LABELS: Readonly<Record<AdmissionRule, string>> = {
  adm_02: "Every copy ran every test",
  adm_03: "Fixed copies pass the added checks",
  adm_04: "Buggy copies fail as declared",
  adm_05: "Repeated runs agree",
  adm_06: "Partial and stub fixes are caught",
};

function shown(value: string, passed: string): string {
  return value === passed ? "passed" : value.replaceAll("_", " ");
}

export function AdmissionStrip({ admission, label }: { admission: OtfAdmissionResult | null; label: string }) {
  if (admission === null) return null;
  const rows: [string, string][] = [
    ...ADMISSION_RULES.map((rule): [string, string] => [RULE_LABELS[rule], shown(admission.decisions[rule], "pass")]),
    ["The original suite misses the bug", shown(admission.comparison, "blind_spot_demonstrated")],
    ["A second, independent fix also passes", shown(admission.alternative_fix, "pass")],
  ];
  return <ul aria-label={label}>{rows.map(([name, value]) => <li key={name}>{name}: {value}</li>)}</ul>;
}
