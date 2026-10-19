// The criteria catalog: bug types, their versioned criteria with example phrases and published
// failure codes, and the interpreter's filler phrases. Version 1 is criteria-catalog/v1.json; every
// function that needs a catalog takes it as an argument, so tests can inject another one.
import { readFileSync } from "node:fs";
import { BUG_TYPE_ID_VALUES } from "@rbw/factory-contract";
import type { BugType, BugTypeId, Criterion } from "@rbw/factory-contract";

export interface CriteriaCatalog {
  criteria_catalog_version: string;
  filler_phrases: string[];
  bug_types: BugType[];
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(`criteria catalog: ${message}`);
    this.name = "CatalogError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) throw new CatalogError(`${where} must be non-empty trimmed text`);
  return value;
}

function textList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new CatalogError(`${where} must be a non-empty list`);
  return value.map((item, index) => text(item, `${where}[${String(index)}]`));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join(",") !== expected.join(",")) throw new CatalogError(`${where} must have exactly the fields ${expected.join(", ")}`);
}

const CRITERION_KEYS = ["criterion_id", "version", "label", "description", "example_phrases", "failure_code"] as const;

/** Checks a parsed catalog: known bug types once each, unique criterion IDs and failure codes, phrases with words. */
export function parseCriteriaCatalog(value: unknown): CriteriaCatalog {
  if (!isRecord(value)) throw new CatalogError("must be an object");
  exactKeys(value, ["criteria_catalog_version", "filler_phrases", "bug_types"], "the catalog");
  const version = text(value.criteria_catalog_version, "criteria_catalog_version");
  const fillers = textList(value.filler_phrases, "filler_phrases");
  if (!Array.isArray(value.bug_types)) throw new CatalogError("bug_types must be a list");
  const seenTypes = new Set<string>();
  const seenCriteria = new Set<string>();
  const seenCodes = new Set<string>();
  const bugTypes: BugType[] = value.bug_types.map((raw, typeIndex) => {
    const where = `bug_types[${String(typeIndex)}]`;
    if (!isRecord(raw)) throw new CatalogError(`${where} must be an object`);
    exactKeys(raw, ["bug_type_id", "label", "description", "criteria"], where);
    const id = raw.bug_type_id;
    if (typeof id !== "string" || !(BUG_TYPE_ID_VALUES as readonly string[]).includes(id)) throw new CatalogError(`${where}.bug_type_id is not a bug type`);
    if (seenTypes.has(id)) throw new CatalogError(`${where}.bug_type_id repeats ${id}`);
    seenTypes.add(id);
    if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) throw new CatalogError(`${where}.criteria must be a non-empty list`);
    const criteria: Criterion[] = raw.criteria.map((rawCriterion, index) => {
      const at = `${where}.criteria[${String(index)}]`;
      if (!isRecord(rawCriterion)) throw new CatalogError(`${at} must be an object`);
      exactKeys(rawCriterion, CRITERION_KEYS, at);
      const criterionId = text(rawCriterion.criterion_id, `${at}.criterion_id`);
      if (seenCriteria.has(criterionId)) throw new CatalogError(`${at}.criterion_id repeats ${criterionId}`);
      seenCriteria.add(criterionId);
      const failureCode = text(rawCriterion.failure_code, `${at}.failure_code`);
      if (seenCodes.has(failureCode)) throw new CatalogError(`${at}.failure_code repeats ${failureCode}`);
      seenCodes.add(failureCode);
      return {
        criterion_id: criterionId,
        version: text(rawCriterion.version, `${at}.version`),
        label: text(rawCriterion.label, `${at}.label`),
        description: text(rawCriterion.description, `${at}.description`),
        example_phrases: textList(rawCriterion.example_phrases, `${at}.example_phrases`),
        failure_code: failureCode,
      };
    });
    return { bug_type_id: id as BugTypeId, label: text(raw.label, `${where}.label`), description: text(raw.description, `${where}.description`), criteria };
  });
  if (seenTypes.size !== BUG_TYPE_ID_VALUES.length) throw new CatalogError("must declare every bug type");
  return { criteria_catalog_version: version, filler_phrases: fillers, bug_types: bugTypes };
}

let catalogV1: CriteriaCatalog | null = null;

/** Criteria catalog version 1, read once from criteria-catalog/v1.json next to this package's source. */
export function criteriaCatalogV1(): CriteriaCatalog {
  catalogV1 ??= parseCriteriaCatalog(JSON.parse(readFileSync(new URL("../criteria-catalog/v1.json", import.meta.url), "utf8")) as unknown);
  return catalogV1;
}

export function bugTypeOf(catalog: CriteriaCatalog, bugTypeId: BugTypeId): BugType {
  const found = catalog.bug_types.find((type) => type.bug_type_id === bugTypeId);
  if (found === undefined) throw new CatalogError(`no bug type ${bugTypeId}`);
  return found;
}

export function criterionOf(catalog: CriteriaCatalog, criterionId: string): { bug_type_id: BugTypeId; criterion: Criterion } | null {
  for (const type of catalog.bug_types) {
    const criterion = type.criteria.find((candidate) => candidate.criterion_id === criterionId);
    if (criterion !== undefined) return { bug_type_id: type.bug_type_id, criterion };
  }
  return null;
}
