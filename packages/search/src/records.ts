// Frozen call records, the write-once record stores and the novelty summary.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, sha256OfCanonical } from "./canonical.ts";
import { SearchError } from "./errors.ts";

const utcTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const sourceResultSchema = z.strictObject({
  url: z.string(),
  title: z.string(),
  published_date: z.string().nullable(),
  score: z.number().nullable(),
  excerpt: z.string(),
});

const docsResultSchema = z.strictObject({ url: z.string(), passages: z.array(z.string()) });

export const KINDS = ["source", "docs", "phrase"] as const;
export type RecordKind = (typeof KINDS)[number];

const recordShape = z.strictObject({
  schema_version: z.literal(1),
  candidate: z.string(),
  call_name: z.string(),
  kind: z.enum(KINDS),
  /** The exact request: no key and no headers. */
  request: z.strictObject({
    endpoint: z.enum(["search", "extract"]),
    query: z.string(),
    urls: z.array(z.string()).optional(),
    options: z.record(z.string(), z.unknown()),
  }),
  requested_at: utcTime,
  completed_at: utcTime,
  outcome: z.enum(["complete", "incomplete", "public_match", "no_public_match"]),
  /** Why the call is incomplete; null otherwise. */
  reason: z.string().nullable(),
  results: z.array(z.union([sourceResultSchema, docsResultSchema])),
  /** What Tavily reported as `usage.credits`; null when it reported none. */
  reported_credits: z.number().nullable(),
  operation_id: hex64,
  /** For `no_public_match`: the time the claim holds as of. */
  statement: z.string().nullable(),
});

function checkConsistency(
  record: z.infer<typeof recordShape>,
  ctx: z.RefinementCtx,
): void {
  const allowed = record.kind === "phrase" ? ["public_match", "no_public_match", "incomplete"] : ["complete", "incomplete"];
  if (!allowed.includes(record.outcome)) {
    ctx.addIssue({ code: "custom", message: "outcome does not fit the kind", path: ["outcome"] });
  }
  if ((record.outcome === "incomplete") !== (record.reason !== null)) {
    ctx.addIssue({ code: "custom", message: "a reason is required exactly when incomplete", path: ["reason"] });
  }
  if ((record.outcome === "no_public_match") !== (record.statement !== null)) {
    ctx.addIssue({ code: "custom", message: "a statement is required exactly for no_public_match", path: ["statement"] });
  }
}

const unhashedSchema = recordShape.superRefine(checkConsistency);
export const searchRecordSchema = recordShape.extend({ sha256: hex64 }).superRefine(checkConsistency);

export type SourceResult = z.infer<typeof sourceResultSchema>;
export type DocsResult = z.infer<typeof docsResultSchema>;
export type UnhashedRecord = z.infer<typeof unhashedSchema>;
export type SearchRecord = UnhashedRecord & { sha256: string };

/** Validates a record without its hash and adds the SHA-256 of its canonical bytes. */
export function freezeRecord(record: UnhashedRecord): SearchRecord {
  const parsed = unhashedSchema.safeParse(record);
  if (!parsed.success) {
    throw new SearchError("invalid_record", parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  }
  return { ...parsed.data, sha256: sha256OfCanonical(parsed.data) };
}

export function verifyRecord(record: SearchRecord): boolean {
  const { sha256, ...rest } = record;
  const parsed = unhashedSchema.safeParse(rest);
  return parsed.success && sha256OfCanonical(parsed.data) === sha256;
}

/** Records are written once under a key derived from candidate and call name. */
export interface RecordStore {
  get(key: string): SearchRecord | undefined;
  /** Writes the record. The same bytes again are accepted; different bytes throw `record_conflict`. */
  put(key: string, record: SearchRecord): void;
}

export function recordKey(candidate: string, name: string): string {
  return `${candidate}.${name}`;
}

function sameBytes(a: SearchRecord, b: SearchRecord): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function createMemoryRecordStore(): RecordStore {
  const records = new Map<string, SearchRecord>();
  return {
    get: (key) => records.get(key),
    put(key, record) {
      const existing = records.get(key);
      if (existing !== undefined && !sameBytes(existing, record)) {
        throw new SearchError("record_conflict", key);
      }
      records.set(key, record);
    },
  };
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;

function readRecord(path: string): SearchRecord {
  const parsed = searchRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success || !verifyRecord(parsed.data)) {
    throw new SearchError("invalid_record", "a stored record does not match its hash");
  }
  return parsed.data;
}

/** One `<key>.record.json` file per record in `dir`, created exclusively. */
export function createDirectoryRecordStore(dir: string): RecordStore {
  const pathFor = (key: string): string => {
    if (!KEY_PATTERN.test(key)) {
      throw new SearchError("invalid_record_key", key);
    }
    return join(dir, `${key}.record.json`);
  };
  return {
    get(key) {
      const path = pathFor(key);
      return existsSync(path) ? readRecord(path) : undefined;
    },
    put(key, record) {
      const path = pathFor(key);
      mkdirSync(dir, { recursive: true });
      if (existsSync(path)) {
        if (!sameBytes(readRecord(path), record)) {
          throw new SearchError("record_conflict", key);
        }
        return;
      }
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    },
  };
}

export type NoveltyStatus = "clear" | "blocked" | "incomplete";

export interface NoveltySummary {
  status: NoveltyStatus;
  /** URLs of every public match. */
  matching_urls: string[];
  /** Phrase calls that are incomplete or missing. */
  incomplete_calls: string[];
}

const PHRASE_CALLS = ["phrase-1", "phrase-2", "phrase-3"];

/**
 * A candidate's novelty result from its three phrase records. Any public match blocks release; any
 * incomplete or missing record leaves novelty incomplete; it is clear only when all three are
 * `no_public_match`.
 */
export function summarizeNovelty(records: readonly SearchRecord[]): NoveltySummary {
  const matching = records.filter((r) => r.kind === "phrase" && r.outcome === "public_match");
  const urls = matching.flatMap((r) => r.results.flatMap((item) => ("url" in item ? [item.url] : [])));
  const incomplete_calls = PHRASE_CALLS.filter((name) => {
    const found = records.filter((r) => r.kind === "phrase" && r.call_name === name);
    return found.length !== 1 || found[0]?.outcome === "incomplete";
  });
  if (matching.length > 0) {
    return { status: "blocked", matching_urls: [...new Set(urls)], incomplete_calls };
  }
  const exactlyThree = records.length === 3 && incomplete_calls.length === 0;
  const allClear = exactlyThree && records.every((r) => r.kind === "phrase" && r.outcome === "no_public_match");
  return { status: allClear ? "clear" : "incomplete", matching_urls: [], incomplete_calls };
}
