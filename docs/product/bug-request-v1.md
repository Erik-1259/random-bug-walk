# Bug request contract, version 1

**Status: draft, revision 2.** This file is the binding interface between the bug-request service, the `/factory` page and the automated acceptance tests. It defines shapes and behavior; it does not claim that any endpoint exists. Every endpoint below is **planned** until the pull request that implements it is merged, and section 15 lists which parts are implemented. Later changes are numbered revisions (section 16). Implementations cite the revision they follow.

Representative fixtures are in [`fixtures/bug-request-v1/`](fixtures/bug-request-v1/). They use synthetic identifiers (`synthetic-` prefixes, hashes made of a repeated short pattern) and invented amounts. They show shapes and states, not measured results.

## 1. What the service does

A user selects one or both supported host applications, asks for a quantity of each predefined bug type, optionally describes the wanted behavior in plain language, and sets one budget for the whole request. The service interprets the request, works through candidate bugs on the selected hosts until every quantity is met or a stop condition applies, and returns each **qualified case** as two separate downloads.

A case is **qualified** only when all of these hold for the same exported content:

| Check set | Clean copy | Buggy copy | Reference-fixed copy |
|---|---|---|---|
| The host's existing original test suite, unchanged | Pass | Pass (the suite misses the bug) | Pass |
| The case's separate verification checks | Pass | Detect the declared failure | Pass |

- The original suite's identity (its test IDs and content hash) is fixed per host baseline. No test is removed, weakened or relabeled to qualify a case.
- The reference-fixed copy is built by applying the case's pinned reference repair to the **exported** buggy source.
- The six cells are observed by running the standalone validation harness on the two exported package parts in fresh workspaces (export verification). A cell observed on the producing checkout alone does not count.
- Valid outcomes, controls and repetition counts are declared per candidate source before any qualifying run (section 10.3).
- Setup failures, unrelated failures, missing output and incomplete runs are never reproduction and never qualification.
- The buggy copy must report, in export verification, the published failure code of every criterion in the case's `criteria_met`, whatever the candidate source declares (section 6.3).

Out of scope for version 1: source-only difficulty assessment (declared unavailable, section 4.4); hosts other than the two listed; publication of live results to the public results repository.

## 2. Terms

| Term | Meaning |
|---|---|
| Host | An application bugs are planted in, at a pinned baseline: `umami` (Umami web analytics) or `task-report` (the custom task-and-report service). |
| Bug type | A predefined category: `concurrency` or `date_time`. |
| Request item | One line of a request: a bug type, a quantity, an optional description and a difficulty setting. Several items may share a bug type; each keeps its own description and quantity. |
| Criterion | A versioned, checkable behavior statement for a bug type, for example "an acknowledged change is lost when requests overlap". |
| Candidate source | A declared supply of candidates for one host and bug type. Version 1 sources are finite recipe catalogs. |
| Candidate | One catalog entry tried within one request, identified by `candidate_id`. Its `defect_id` names the planted change; entries with equal `defect_id` values are one defect. |
| Case | A qualified candidate with its two package parts, identified by `case_id`. |
| Package parts | The **bug case** (for a debugging agent) and the **validator package** (for an evaluator). |
| Validation run | One run of the standalone harness on a case's two package parts, started by a user after delivery. |
| Completed example | A case qualified earlier and published, shown separately from any live request. |

## 3. Conventions

- **Transport.** JSON over HTTPS, UTF-8. Every response body carries `"contract_version": "bug-request/1"`. Field names are `snake_case`. Every field defined for a shape is present; an absent value is `null`, an empty list is `[]`. Request bodies with unknown fields, missing fields, wrong types or values outside the ranges of section 5 are refused with `400 invalid_request`.
- **Identifiers.** `request_id` and `validation_id` are lowercase UUID strings chosen by the client. `candidate_id`, `defect_id`, `case_id` and every `*_sha256` are 64 lowercase hex characters. `item_key` is chosen by the client, matches `^[a-z0-9][a-z0-9-]{0,31}$` and is unique within a request.
- **Time.** UTC, ISO 8601 with milliseconds and `Z` (`2026-10-20T14:03:07.120Z`). Durations are whole seconds (`*_s`) or milliseconds (`*_ms`).
- **Money.** Integer micro-US-dollars (`*_microusd`), the unit of the existing spend ledger. `1500000` is $1.50.
- **Session.** `POST /api/factory/session` exchanges the judges' passcode for an HttpOnly, Secure, `SameSite=Strict` cookie scoped to `Path=/api/factory`. It is separate from the replay page's session. Public endpoints: `GET` and `POST /api/factory/session`, `GET /api/factory/capabilities`, `GET /api/factory/example`, `POST /api/factory/interpretations`, and the completed example's download URLs. Test endpoints (section 15.1) need no session. Every other endpoint answers `401 unauthorized` without a valid session.
- **Errors.** A refused call answers a 4xx or 5xx status and an `ErrorResponse` (section 12). Clients branch on `error.code`, never on message text.
- **Polling.** Status responses carry `poll_after_ms`. Clients wait at least that long between polls and back off (15 s, 30 s, then 60 s) while the service answers `unavailable`. A polling failure never starts new work.

## 4. Capabilities: `GET /api/factory/capabilities`

Public. Describes what a request may contain. Clients build the request form from this response and never hard-code hosts, types, criteria or limits. Fixture: `capabilities.json`.

```text
Capabilities {
  contract_version: "bug-request/1"
  service: { state: "available" | "unavailable", code: null | "not_configured" | "halted" | "maintenance", message: string | null }
  hosts: Host[]
  bug_types: BugType[]
  combinations: Combination[]
  difficulty_options: DifficultyOption[]
  limits: Limits
  interpreter: { interpreter_id: "criteria-match", version: string, criteria_catalog_version: string,
                 filler_phrases: string[] }   // versioned with criteria_catalog_version (section 6.1)
  qualification_route: { route_id: "behavioral-qualification", version: string }
  package_formats: { bug_case: "rbw-bug-case/1", validator: "rbw-validator/1" }
}
Host { host_id: "umami" | "task-report", label: string, description: string, baseline_id: string }
BugType { bug_type_id: "concurrency" | "date_time", label: string, description: string, criteria: Criterion[] }
Criterion { criterion_id: string, version: string, label: string, description: string,
            example_phrases: string[],           // matched exactly (section 6.1)
            failure_code: string }               // published per criterion version (section 6.3)
Combination {
  host_id, bug_type_id
  status: "supported" | "unsupported"
  reason: string | null                  // why unsupported, in plain language
  source: null | { source_id: string, kind: "finite_recipe_catalog", catalog_version: string,
                   entries: integer, criteria_ids: string[], description: string }
                                         // entries and criteria_ids: the entries available over the planned window (section 4.2)
}
DifficultyOption {
  option_id: "source_inferable_allowed" | "source_only_difficulty_required"
  label: string, default: boolean, available: boolean, reason: string | null
}
Limits {
  max_items: integer, max_quantity_per_item: integer, max_total_quantity: integer
  max_description_chars: integer               // Unicode code points, counted after trimming (section 5)
  budget_presets_microusd: integer[], default_budget_microusd: integer, min_budget_microusd: integer, max_budget_microusd: integer
  max_wall_clock_s: integer, max_candidates: integer
}
```

### 4.1 Hosts and baselines

`baseline_id` names the pinned application revision (`umami@ec0ff503`, `task-report@ca4a71f`). A case's identity includes its host and baseline, so equal source edits on different baselines are different defects.

### 4.2 Combinations and sources

Every (host, bug type) pair appears once in `combinations`. `supported` means a declared source with at least one entry available over the planned window exists and its verification checks are implemented. The planned window is [now, now + `limits.max_wall_clock_s`], and availability is the host's existing window-based availability. `entries` counts the catalog entries available over the planned window, so a request can deliver at most that many distinct cases of that type from that host, and `criteria_ids` lists the criteria those entries target. A declared pair with no entry available is `unsupported`, and its `reason` is the host's availability reason. Selecting a type never implies every host supports it. Interpretation counts eligible sources the same way (section 6).

### 4.3 Limits

Limits are service configuration and may change without a contract revision; clients read them here. Input outside the limits (section 5) is refused before execution with `400 invalid_request`, by `POST /api/factory/interpretations` and `POST /api/factory/requests` alike. It never yields an interpretation.

### 4.4 Difficulty

`source_inferable_allowed` is the default and is always available: cases may be easy or hard to diagnose from source, and no difficulty assessment runs. `source_only_difficulty_required` is listed with `available: false` until a calibrated assessment is implemented and validated. A request item that asks for it is unsupported (section 6.2); it is never silently downgraded. Delivered cases record `difficulty.status: "not_assessed"`.

## 5. Request input

```text
RequestInput {
  hosts: ("umami" | "task-report")[]        // 1 or 2 entries, no repeats
  items: RequestItemInput[]                  // 1..limits.max_items
  budget_microusd: integer                   // limits.min_budget_microusd..limits.max_budget_microusd
}
RequestItemInput {
  item_key: string
  bug_type_id: "concurrency" | "date_time"
  quantity: integer                          // 1..limits.max_quantity_per_item
  description: string | null                 // normalized by the service (section 6); at most limits.max_description_chars
                                             // Unicode code points after trimming
  difficulty: "source_inferable_allowed" | "source_only_difficulty_required"
}
```

- The budget is shared by every selected host and every item. There are no per-host quotas or per-host budgets.
- Quantities are per item. A type's requested total is the sum over its items. Extra cases of one type never fill another type's shortfall, and a case never counts for two items.
- `type_totals` (sections 6 and 8) lists each requested bug type exactly once, with a total of at least 1. It may also list a type that no item requests, with 0.
- The sum of all quantities is at most `limits.max_total_quantity`.
- A value outside any of these ranges, including the total, answers `400 invalid_request` (section 4.3).

## 6. Interpretation: `POST /api/factory/interpretations`

Public, free and side-effect free: nothing is recorded or charged. The body is a `RequestInput`. The answer shows exactly what the service will try to deliver and which parts it cannot support. The client shows it before the user starts the request; this is a confirmation of meaning, not an approval step. Fixtures: `interpretation-supported.json`, `interpretation-unsupported.json`, `interpretation-budget-below-minimum.json`, `interpretation-budget-below-item.json`; `status-exhausted.json` and `status-duplicate-defect.json` carry type-level `quantity_exceeds_source` warnings.

The service first normalizes the input: it trims each description and maps an empty result to `null`. Untrimmed input is accepted, not refused, and `input` echoes the normalized input.

```text
Interpretation {
  contract_version
  interpretation_sha256: string     // canonical hash of the normalized input, the interpreter, catalog, route and source versions,
                                    // the factory profile and the availability over the planned window (section 6.1)
  interpreter: { interpreter_id, version, criteria_catalog_version }
  qualification_route: { route_id, version }
  input: RequestInput               // the normalized input actually interpreted
  startable: boolean                // true only when no problem has severity "blocking"
  items: InterpretedItem[]
  type_totals: { bug_type_id, quantity }[]   // each requested type once (at least 1); an unrequested type only with 0 (section 5)
  hosts: { host_id, used: boolean, reason: string | null }[]
  budget: { budget_microusd, worker_worst_case_microusd: integer,
            worst_case_per_candidate_microusd: { host_id, microusd }[],
            worst_case_per_validation_microusd: { host_id, microusd }[], estimate_note: string }
  limits: { max_wall_clock_s, max_candidates }
  problems: Problem[]               // request-level problems
}
InterpretedItem {
  item_key, bug_type_id, quantity, description
  difficulty: { requested: "source_inferable_allowed" | "source_only_difficulty_required", status: "not_required" | "unsupported" }
  criteria: { criterion_id, version, label, matched_text: string | null }[]
  unmatched_text: string[]
  eligible_sources: { host_id, source_id, entries: integer }[]  // entries is at least 1 and counts the source's catalog entries
                                                                 // available over the planned window (section 4.2) that satisfy the item's criteria
  status: "supported" | "unsupported"
  problems: Problem[]
}
Problem { code: string, severity: "blocking" | "warning", message: string, item_key: string | null }
```

### 6.1 Interpreting descriptions (`criteria-match`)

The interpreter is deterministic and versioned. `interpretation_sha256` covers the normalized input; the interpreter, catalog, route and source versions; the factory profile (the limits and worst cases the interpretation prices with); and the effective availability result for the planned window (section 4.2), not the raw time. The same inputs to the hash always give the same `interpretation_sha256`, so a start answers `interpretation_stale` (section 7, step 3) when the profile or that availability changed.

- **No description:** the item accepts a candidate from any selected host's source that demonstrates any criterion of its bug type (section 6.3). `criteria` lists nothing and `unmatched_text` is empty. A description made only of filler phrases is treated as no description.
- **With a description:** the interpreter matches exactly the `example_phrases` of each criterion of the item's bug type, plus the declared filler phrases (`capabilities.interpreter.filler_phrases`), as word sequences. Words are maximal runs of letters and digits, compared case-insensitively; punctuation and spaces only separate words. Every word of the description must be covered by a matched criterion phrase or a filler phrase. Each maximal run of uncovered words is returned as one entry of `unmatched_text` (the normalized description's text from the run's first word to its last), and the item is unsupported (`unrecognized_description`). Text is never dropped silently and never replaced by an easier requirement.
- The normalized description is kept verbatim in the interpretation and in the request record.

### 6.2 Problem codes

| Code | Severity | Meaning |
|---|---|---|
| `unsupported_combination` | blocking | No selected host has a supported source for the item's bug type. |
| `unrecognized_description` | blocking | Part of the description maps to no criterion (see `unmatched_text`). |
| `no_matching_source` | blocking | Criteria were recognized, but no catalog entry available on the selected hosts (section 4.2) satisfies all of them. |
| `unsupported_difficulty` | blocking | The item requires source-only difficulty, which is unavailable. |
| `budget_below_minimum` | blocking | The budget cannot cover the worker's worst case plus one candidate's worst case on any eligible host. Request-level (`item_key` null). |
| `budget_below_item_minimum` | warning | On an item with at least one eligible host: the budget minus the worker's worst case is below the candidate worst case of every host eligible for that item, so no candidate for it can start. The request cannot end `fulfilled`. |
| `quantity_exceeds_source` | warning | Computed per bug type: the distinct `defect_id` values among the type's eligible catalog entries (not the entries), each filling at most one unit of one item, can cover fewer cases than the type's supported items request. Every supported item of that type carries it, and the request cannot end `fulfilled`. |
| `host_unused` | warning | A selected host serves none of the items. |

Out-of-range input is not a problem code; it is `400 invalid_request` (section 4.3).

### 6.3 Matching delivered behavior to criteria

Each criterion version has a published `failure_code` (section 4). A catalog entry only declares which criteria it targets. A candidate demonstrates a criterion only when that criterion's `failure_code` is observed on the buggy copy in export verification; the entry's declaration is not enough. A candidate passes `requested_criteria` when it demonstrates every criterion of an item that has an unfilled unit (an item without criteria accepts a candidate that demonstrates any criterion of its bug type). It is then assigned to one such item (section 10.5). A candidate that fits no such item is `rejected` with `wrong_failure`.

## 7. Starting a request: `POST /api/factory/requests`

Session required. Fixtures: `start-request.json`, `status-queued.json`, `error-busy.json`, `error-busy-needs-reconciliation.json`, `error-idempotency-conflict.json`, `error-interpretation-stale.json`.

```text
StartRequest { request_id: string, input: RequestInput, interpretation_sha256: string }
               // canonical body: request_id + the normalized input (section 6) + interpretation_sha256
```

The service, in order (steps 2 to 7 hold a lock on the `request_id`, so concurrent starts with one ID run one at a time and a duplicate of an accepted start gets its status from step 2, never `busy`):

1. Validates the body (`400 invalid_request`).
2. If a request with this `request_id` exists: the same canonical body answers `200` with the current `RequestStatus`. Nothing new is recorded, reserved or launched. A different body answers `409 idempotency_conflict`.
3. Re-interprets `input`. A different hash answers `409 interpretation_stale`, with the current interpretation in `error.details.interpretation`. An interpretation that is not startable answers `422 unsupported_request`.
4. Checks the service: a halted spend ledger or missing configuration answers `503 unavailable`.
5. Checks, without recording anything, that the factory pool's available amount covers the full requested budget (section 8.5). If it does not, the answer is `409 budget_unavailable`.
6. Takes the single factory slot (section 8.5). If it is held, the answer is `409 busy`. Nothing is recorded under this `request_id`, so the same ID can be sent again later. The answer never reveals another user's request.
7. Creates the request budget on the factory pool, which needs the pool's available amount to cover the worker's worst case, then records the request, its frozen interpretation and the event `request_accepted`, reserves the worker's worst case from the request budget (event `budget_updated`), and launches the worker. It answers `202` with the current `RequestStatus`, normally in state `queued` or `starting`. It is `finished` with a failure outcome only when the worker's reservation or launch failed after the request was recorded. If this step fails before the request is recorded (for example, the pool can no longer cover the worker's worst case), the slot is released and the start is refused (`409 budget_unavailable` or `503 unavailable`), with nothing recorded or reserved. Once the request is recorded, a later failure is reported through the request's own outcome (section 8.1), never as a refused start.

**Client rules.**

- Generate `request_id` once per drafted request and store it in `localStorage` under `rbw-factory-request-id` **before** sending the POST.
- Disable the start control while a start is in flight or the request is active.
- On a timeout, network error or 5xx, never generate a new ID. Read the status of the stored ID instead.
- On `busy`, read the stored ID's status first. A `200` means the request was accepted; only a `404` allows a new ID.
- Generate a new ID only after `budget_unavailable`, `unsupported_request`, `interpretation_stale` or `invalid_request`, after `busy` once the stored ID answers `404`, or after the request has finished.

**Money.** A start never consumes the replay page's protected allocation. Factory requests and validation runs draw on their own pool and slot, so factory work and a replay can run side by side.

## 8. Request status: `GET /api/factory/requests/{request_id}?after={seq}`

Session required. `after` is optional (default 0). The response includes up to 200 events with `seq > after`. `next_after` is the `seq` of the last event returned, or `after` when none is returned; use it for the next poll. An unknown ID, including one refused as `busy`, answers `404 not_found`. Fixtures: `status-running.json`, `status-fulfilled.json`, `status-validated.json`, `status-partial-budget.json`, `status-exhausted.json`, `status-duplicate-defect.json`, `status-cancelled.json`, `status-operational-error.json`, `status-zero-result.json`, `status-wrong-failure.json`.

```text
RequestStatus {
  contract_version
  request_id, created_at, updated_at
  state: "queued" | "starting" | "running" | "stopping" | "finished"
  outcome: null | "fulfilled" | "stopped_at_limit" | "sources_exhausted" | "cancelled" | "operational_error"
  stop_reason: null | { code: StopCode, message: string }
  delivery: "none" | "partial" | "complete"     // from the counts; "none" until a case is delivered
  attention: null | { code: "needs_reconciliation" | "worker_unresponsive", message: string }
  interpretation: Interpretation                 // frozen at start
  budget: { budget_microusd, reserved_microusd, spent_microusd, committed_microusd, remaining_microusd, overrun: boolean }  // section 8.5
  limits: { max_wall_clock_s, deadline_at, max_candidates, candidates_started }
  funnel: { candidates_explored, behavior_checks_passed, requested_criteria_passed, packages_ready }
  items: { item_key, bug_type_id, description, requested, delivered, missing, case_ids: string[] }[]  // case_ids: the delivered cases that fill the item
  type_totals: { bug_type_id, requested, delivered, missing }[]  // each requested type once (requested at least 1); an unrequested type only with requested 0 (section 5)
  candidates: Candidate[]
  cases: Case[]
  events: Event[]
  next_after: integer
  last_heartbeat_at: string | null
  poll_after_ms: integer
}
StopCode = "fulfilled" | "budget_exhausted" | "time_limit" | "candidate_limit" | "sources_exhausted"
         | "cancelled_by_user" | "worker_lost" | "needs_reconciliation" | "operational_error"
Candidate {
  candidate_id: string             // canonical hash of source_id, catalog_version and entry_id; unique within a request
  defect_id: string                // the planted change (section 10.4)
  host_id, bug_type_id, source_id, entry_id
  stage: "selected" | "preparing" | "checking" | "behavior_checks_passed" | "requested_criteria_passed"
       | "packaging" | "qualified" | "rejected" | "invalid" | "incomplete" | "skipped"
  reason: null | { code: CandidateReason, message: string }
  item_key: string | null          // set at requested_criteria_passed, when it is assigned to an item (section 10.5)
  case_id: string | null
  started_at: string | null, finished_at: string | null
}
```

### 8.1 States and outcomes

`queued → starting → running → (stopping →) finished`. `outcome` and `stop_reason` are set only in `finished`.

| Outcome | Stop codes | Meaning |
|---|---|---|
| `fulfilled` | `fulfilled` | Every item's quantity was delivered. |
| `stopped_at_limit` | `budget_exhausted`, `time_limit`, `candidate_limit` | A declared limit stopped the search before every quantity was met. |
| `sources_exhausted` | `sources_exhausted` | Every eligible catalog entry for every item still short was tried. |
| `cancelled` | `cancelled_by_user` | The user stopped the request. |
| `operational_error` | `worker_lost`, `needs_reconciliation`, `operational_error` | An execution or accounting problem stopped the request. |

`delivery` is derived from the counts: `complete` when nothing is missing, `partial` when some but not all cases were delivered, `none` when no case was delivered. Every outcome keeps every case already delivered. A `fulfilled` outcome always has `delivery: "complete"`; any other outcome may have any delivery value. "Stopped with partial results" is any finished request with `delivery: "partial"`.

Stop codes under `operational_error`:

- `worker_lost`: the worker sent no heartbeat for 180 s, or it exited before finishing. While a request is active the worker updates `last_heartbeat_at` at least every 30 s; after 60 s without a heartbeat, `attention` becomes `worker_unresponsive` until one arrives. A worker lost after missed heartbeats is an uncertain outcome: the worker's and any in-flight candidate's reservations stay held, `attention` becomes `needs_reconciliation` (replacing `worker_unresponsive`), and the slot stays held until reconciliation (section 8.5).
- `needs_reconciliation`: a provider outcome became uncertain while the worker was running, so the request stopped instead of retrying.
- `operational_error`: any other execution or accounting failure, including an overrun (section 8.5).

`attention` is set when a person must act, for example when a provider outcome is uncertain and its spend needs reconciliation (section 8.5). Each change appends an `attention` or `attention_cleared` event. The service never launches replacement paid work for an uncertain operation.

### 8.2 Funnel and counts

The funnel counts distinct candidates in this request, so retries never add to it:

- `candidates_explored`: candidates that started checks.
- `behavior_checks_passed`: candidates whose six cells all matched expectations in export verification.
- `requested_criteria_passed`: those assigned to an item at that stage (sections 6.3 and 10.5).
- `packages_ready`: qualified cases with both package parts ready for download.

`delivered` counts only qualified cases assigned to the item. A retry, a rejected, invalid or incomplete candidate, or a second qualification of the same defect never adds to `delivered`. A discovery request has no completion percentage, and clients must not show one.

### 8.3 Candidate reasons

| `CandidateReason` | Stage | Meaning |
|---|---|---|
| `original_suite_failed_clean` | rejected | The original suite failed on the clean copy. |
| `original_suite_caught_bug` | rejected | The original suite failed on the buggy copy: no blind spot. |
| `original_suite_failed_fixed` | rejected | The original suite failed on the reference-fixed copy. |
| `checks_failed_clean` | rejected | Verification checks failed on the clean copy. |
| `checks_failed_fixed` | rejected | Verification checks failed on the reference-fixed copy. |
| `bug_not_detected` | rejected | Verification checks passed on the buggy copy. |
| `wrong_failure` | rejected | No item has an unfilled unit whose criteria it demonstrates (sections 6.3 and 10.5). |
| `export_mismatch` | rejected | The exported package parts did not reproduce the matrix or failed integrity checks. |
| `setup_failed` | invalid | A copy could not be prepared or run. Not reproduction. |
| `incomplete_run` | incomplete | A run ended early or too many trials were invalid. Not reproduction. |
| `stopped` | incomplete | The request stopped while the candidate was in progress. |
| `duplicate_defect` | skipped | The defect was already tried in this request. |
| `no_budget_for_candidate` | skipped | The remaining budget or the factory pool's available amount could not cover the candidate's worst case (section 8.5). |

### 8.4 Events

Events are append-only and numbered from 1 with no gaps. An event never changes once returned, so an earlier response's events are a prefix of a later one's. They are the only source of progress; clients show them as they arrive and never invent intermediate states. After `request_finished`, only `budget_updated`, `attention`, `attention_cleared`, `validation_started` and `validation_finished` events follow.

```text
Event { seq: integer, at: string, type: EventType, host_id: string | null, candidate_id: string | null,
        item_key: string | null, case_id: string | null, message: string, data: object }
```

| `type` | `data` |
|---|---|
| `request_accepted` | `{}` |
| `worker_started` | `{}` |
| `host_preparing` / `host_ready` | `{ baseline_id }` |
| `candidate_selected` | `{ source_id, entry_id }` |
| `check_finished` | `{ check_set: "original_suite" \| "verification", copy: "clean" \| "buggy" \| "fixed", outcome: "pass" \| "fail" \| "error" \| "incomplete", runs_valid, runs_total }` |
| `behavior_checks_passed` | `{}` |
| `requested_criteria_passed` | `{ criterion_ids }`: the criteria the candidate demonstrated (section 6.3), at least one, each once; they become its case's `criteria_met` |
| `candidate_rejected` / `candidate_invalid` / `candidate_incomplete` / `candidate_skipped` | `{ reason }` |
| `package_ready` | `{ bug_case_sha256, validator_sha256 }` |
| `case_delivered` | `{}` |
| `source_exhausted` | `{ bug_type_id, source_id }` |
| `budget_updated` | `{ reserved_microusd, spent_microusd, remaining_microusd }` |
| `stop_requested` | `{}` |
| `attention` / `attention_cleared` | `{ code }` |
| `request_finished` | `{ outcome, stop_code }` |
| `validation_started` | `{ validation_id }` |
| `validation_finished` | `{ validation_id, result }` |

### 8.5 Budget, slot and reconciliation

- `reserved_microusd` is the open worst case of work in progress: the worker from start until it settles, each candidate from selection until it settles, and each validation run from its accepted POST until it settles. `spent_microusd` is settled cost. `committed_microusd` = `reserved_microusd` + `spent_microusd`, and `remaining_microusd` = `budget_microusd` − `committed_microusd`. Every change appends a `budget_updated` event.
- The factory pool counts each request's committed amount (reservations plus spend), not its whole budget; a request budget only caps that request's commitments, validation runs included. A start needs the pool's available amount to cover the full requested budget (section 7, step 5). Every later reservation (worker, candidate, validation run) also needs pool availability: a candidate the pool cannot cover is `skipped` (`no_budget_for_candidate`), and the request stops `budget_exhausted` when nothing fits; a validation run it cannot cover answers `409 budget_unavailable` (section 11). Nothing is held for a finished request beyond its open reservations.
- A worker confirmed stopped settles when the request finishes, at its full worst case when its use cannot be measured. A worker lost after missed heartbeats is an uncertain outcome and stays held until reconciliation (section 8.1). Validation runs draw on the same budget after the request finishes (section 11).
- `overrun` is true when `committed_microusd` exceeds `budget_microusd`, which happens only when a provider reports more than the reserved worst case; `remaining_microusd` is then negative. While the request runs, no new candidate starts and the request finishes `operational_error`. After the request finished (an overrun from a validation run or a reconciliation), `outcome` and `stop_reason` stay unchanged, `overrun` becomes true, `attention` is set to `needs_reconciliation`, and later validation POSTs answer `409 budget_unavailable`.
- The single factory slot is held from step 6 of a start until the request finishes, and by each validation run from its accepted POST (a queued run holds it) until it finishes. A start refused at step 7 releases it at once (section 7).
- An uncertain provider outcome keeps its reservation held and sets `attention` to `needs_reconciliation`. Until an operator reconciles it, the slot stays held even after the request finishes: starts and validation runs answer `409 busy` with `details.reason: "needs_reconciliation"` and `retryable: false`. Reconciliation settles the held amount (`budget_updated`), clears `attention` (`attention_cleared`) unless the settlement overruns (above), and releases the slot. It never changes `outcome`, `stop_reason`, `delivery` or the counts.

## 9. Stopping: `POST /api/factory/requests/{request_id}/stop`

Session required. Body `{}`. Idempotent: repeating it changes nothing. It answers the current `RequestStatus`, normally in state `stopping`, or `finished` if the request had already ended. Fixture: `status-cancelled.json`.

- No new candidate or check starts after the stop is recorded.
- Work in progress ends at the next check boundary. A candidate interrupted before qualification becomes `incomplete` (reason `stopped`) and is never delivered.
- Every case already delivered stays delivered and downloadable.
- Spend settles for what ran. The outcome is `cancelled` unless the request finished first.

## 10. Cases and package parts

```text
Case {
  case_id, defect_id
  title: string                         // short plain-language name of the observed failure
  host_id, host_label, baseline_id, bug_type_id
  item_key: string | null               // the request item it fills (every live case fills one); null for the completed example
  criteria_met: { criterion_id, version, label }[]  // at least one (section 6.3)
  summary: { observed_failure: string, how_checked: string }
  matrix: {
    original_suite: { suite_id, suite_sha256, test_count, clean: Cell, buggy: Cell, fixed: Cell }
    verification:   { check_set_id, clean: Cell, buggy: Cell, fixed: Cell }
  }
  repetition: { protocol_id, version, summary: string }
  difficulty: { status: "not_assessed", note: string }
  qualification: { route_id, version, verdict: "accepted", record_sha256, qualified_at }
  packages: { package_version: integer, pair_sha256, bug_case: PackagePart, validator: PackagePart }
  validation: ValidationRun | null       // the latest user-started validation run, if any
  provenance: { origin: "live_request" | "published_example", request_id: string | null, source_id, entry_id }
}
Cell { expected: "pass" | "fail", observed: "pass" | "fail" | "error" | "incomplete",
       runs_valid: integer, runs_total: integer, matches_expectation: boolean }
PackagePart { kind: "bug_case" | "validator", format: "rbw-bug-case/1" | "rbw-validator/1",
              filename: string, media_type: "application/gzip", size_bytes: integer, sha256: string,
              ready: boolean, download_path: string | null }
```

A cell's `observed` is `error` when its copy could not be prepared or run, and `incomplete` when fewer runs were valid than the repetition protocol requires; `matches_expectation` is then false.

A case appears in `RequestStatus.cases` only once it is qualified and both its parts are `ready`. Its two parts become `ready` together, after export verification and storage. The client offers a download only when `ready` is true and `download_path` is not null.

### 10.1 What a client may show

Case metadata contains only what the bug case already gives a debugging agent (the title, the observed failure in plain language, the host and baseline), plus outcome summaries. It never contains verification test code, fixtures, expected values, the reference repair, the planted change, the changed file or line, or generation history. The service never sends that material in any client payload. `source_id`, `entry_id` and `check_set_id` are opaque identifiers that describe neither the planted change nor its location. Clients keep the two downloads visibly separate: the bug case is the debugging agent's input, and the validator package is evaluator material.

### 10.2 Downloads: `GET {download_path}`

Live cases: `download_path` is `/api/factory/requests/{request_id}/cases/{case_id}/packages/{bug-case|validator}`. Session required. The response is the archive, with `Content-Disposition: attachment` and the part's `filename`. Its SHA-256 equals `PackagePart.sha256`. A `case_id` that is not a delivered case of this request answers `404 not_found`. For the completed example, `download_path` is a public URL to the published archive, which needs no session.

### 10.3 Package parts (summary)

The full archive layout is defined in `docs/product/bug-package-v1.md` (planned, owned by the package tooling lane). This contract fixes only what the service and clients rely on:

- Both parts name the same `case_id`, `defect_id` and `package_version`. `pair_sha256` is the canonical hash of the two parts' SHA-256 values and the case ID. A validator package from another case or version is refused by the harness.
- **Bug case:** the buggy application source without version-control history, the unchanged original test suite, the permitted incident description, runtime and setup information, and neutral provenance (host, baseline, license, tool versions).
- **Validator package:** the verification checks and their fixtures, the expected outcome of every cell, clean-state reconstruction, the pinned reference repair, the declared repetition protocol with valid-trial rules, and the qualification evidence.
- Neither part contains credentials, private operational identifiers, the request's user or other requests' data.

### 10.4 Identity and deduplication

- `defect_id` is the canonical hash of the host, the baseline (application commit and original-suite hash) and the planted change. It does not depend on run IDs, package bytes or issue wording.
- `case_id` is the canonical hash of the `defect_id`, the bug type, the criteria catalog version, the verification check set, the expected outcomes, the reference repair and the runtime environment.
- Within one request, each `defect_id` is tried at most once; another catalog entry with the same defect is `skipped` (`duplicate_defect`) under its own `candidate_id`. Retrying after an infrastructure failure keeps the same candidate and never counts twice.
- Each request runs its own checks. A later request may qualify the same case again, and its `case_id` is then the same. Equal `case_id` values mean the same case, not new supply.

### 10.5 Assigning cases to items

Version 1 runs one candidate at a time per request, so at most one unit is held, and only by the candidate being evaluated. Assignment happens at `requested_criteria_passed`. An item's unfilled units are its quantity minus its delivered cases. The candidate is assigned to an item with an unfilled unit whose every criterion it demonstrates (section 6.3): items with more criteria first, then request order. It holds that unit until it is qualified, when it fills it, or until it ends otherwise, when the unit opens again. A case fills one unit of one item and never counts for two. A candidate that fits no item with an unfilled unit is `rejected` with `wrong_failure`: it never becomes a case, never appears in `cases` and never counts in `packages_ready`.

## 11. Validation runs

`POST /api/factory/requests/{request_id}/cases/{case_id}/validations`, body `{ "validation_id": "<uuid>" }`. Session required. It starts one run of the standalone harness on the case's two downloadable parts, in fresh workspaces, and answers `202` with a `ValidationRun`.

- `validation_id` is scoped to (`request_id`, `case_id`). The same ID on the same path answers `200` with the existing run; an ID already used on another request or case answers `409 idempotency_conflict`. Concurrent POSTs with one ID run one at a time. The ID check runs before the slot and budget checks. A refused run records nothing, so a later GET of its ID answers `404 not_found`.
- The run takes the single factory slot when its POST is accepted (a queued run holds it) and releases it when it finishes, so a POST answers `409 busy` while a factory request (including this case's own request) or another validation run holds the slot (section 8.5).
- When the POST is accepted, the worst case for the case's host (`interpretation.budget.worst_case_per_validation_microusd`) is reserved from the request budget. If `remaining_microusd` or the factory pool's available amount is below it, the answer is `409 budget_unavailable` (section 8.5).
- A run sends heartbeats like the worker (at least every 30 s, section 8.1) and runs for at most 1800 s. A run with no heartbeat for 180 s, or still running after 1800 s, finishes with result `error`.
- When it finishes, `cost_microusd` settles into the request's `spent_microusd` and the rest is released. The request's events record `validation_started`, `validation_finished` and each `budget_updated`.
- A run whose spend is uncertain (after an uncertain provider outcome, or a timeout whose sandbox use cannot be confirmed) finishes `error`, keeps its reservation held and sets the request's `attention` to `needs_reconciliation`; the slot stays held until reconciliation (section 8.5). Its `cost_microusd` may stay `null`: a later reconciliation updates the request's budget (`budget_updated`), not the run. `null` is never read as `0`.

**Client rules.** Generate a `validation_id` once per button press and store it in `localStorage` under `rbw-factory-validation-id` **before** sending the POST. After a timeout, network error or 5xx, send the same ID again; never generate a new one for that press.

`GET /api/factory/requests/{request_id}/cases/{case_id}/validations/{validation_id}` answers the current `ValidationRun`. Fixtures: `validation-running.json`, `validation-passed.json`, `validation-failed.json`, `validation-error.json`.

```text
ValidationRun {
  contract_version
  validation_id, case_id
  state: "queued" | "running" | "finished"
  result: null | "passed" | "failed" | "error"
  matrix: null | { original_suite: { clean: Cell, buggy: Cell, fixed: Cell }, verification: { clean: Cell, buggy: Cell, fixed: Cell } }
                                        // null until the run finishes, and when the harness could run no cell
  package_sha256: { bug_case, validator }
  harness: { name: "rbw-validate", version: string }
  message: string | null
  started_at: string | null, finished_at: string | null
  cost_microusd: integer | null         // the run's cost recorded when it completed; null before then,
                                        // and it may stay null after uncertain spend (above)
  poll_after_ms: integer
}
```

- `passed`: every cell observed a valid `pass` or `fail` equal to its expectation.
- `failed`: every cell observed a valid `pass` or `fail`, and at least one differs from its expectation. That is a behavioral result.
- `error`: the matrix is null, or at least one cell observed `error` or `incomplete` (setup failure, missing output, too few valid runs, infrastructure problem). That is not a behavioral result, and the client says so.

A button press is not a validation; the client shows a result only from a finished `ValidationRun`.

## 12. Errors

```text
ErrorResponse { contract_version, error: { code: ErrorCode, message: string, retryable: boolean, details: object | null } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The body or query does not match this contract, including a value outside the limits (section 4.3). |
| 401 | `unauthorized` | No valid factory session. |
| 401 | `passcode_incorrect` | `POST /api/factory/session` with a wrong passcode. |
| 404 | `not_found` | Unknown request or validation run, a `case_id` that is not a delivered case of the request, a request refused as `busy`, or a test endpoint outside test mode (section 15.1). |
| 409 | `idempotency_conflict` | The `request_id` exists with a different body, or the `validation_id` was already used on another request or case (section 11). |
| 409 | `interpretation_stale` | The interpretation changed; `details.interpretation` holds the current one. |
| 409 | `busy` | The factory slot is held (section 8.5). `details.reason` is `"active"` while a factory request or validation run is active (`retryable: true`), or `"needs_reconciliation"` while uncertain spend awaits an operator (`retryable: false`). |
| 409 | `budget_unavailable` | The factory pool's available amount or the request budget cannot cover a start (section 7) or a validation run (section 11), including after an overrun (section 8.5). |
| 422 | `unsupported_request` | The interpretation has a blocking problem; `details.interpretation` holds it. |
| 503 | `unavailable` | The service is not configured, the ledger is halted, or a dependency did not answer. `retryable: true`. |

## 13. Session: `POST /api/factory/session`, `GET /api/factory/session`

Both are public (section 3). `POST` takes `{ "passcode": string }` and answers `204` with the cookie, or `401 passcode_incorrect`. `GET` answers `200` with `{ contract_version, signed_in: boolean }`; `signed_in` is false without a valid session. Fixtures: `session.json`, `session-signed-out.json`, `error-passcode-incorrect.json`.

## 14. Completed example: `GET /api/factory/example`

Public. Answers `{ contract_version, label, note, case: Case }`, with `case.provenance.origin` set to `"published_example"`, or `404 not_found` while no example is published. The example is a case qualified and published earlier under this contract. Clients label it as a completed example and never present it as the output of a live request. Fixture: `example.json`.

## 15. Implementation status and ownership

| Part | Status | Owner |
|---|---|---|
| This document and its fixtures | draft, revision 2 | contract owner |
| Shared types (`packages/factory-contract/`) | draft, revision 2 | contract owner |
| `/factory` page, components, client adapter, browser tests (`packages/web/app/factory/**`, `packages/web/src/components/factory-*.tsx`, `packages/web/src/factory/client.ts`, their tests) | in progress | UI lane |
| Service routes (`packages/web/app/api/factory/**`) and server modules (`packages/web/src/factory-server/**`) | planned | backend lane |
| Request loop, interpreter, identity, budget use, events, hosted worker (`packages/factory/**`, `tools/controller/src/factory-*.ts`, spend migration and budget functions in `packages/spend/`) | planned | backend lane |
| Custom host adapter, recipe catalog and checks (`packages/host-task-report/**`) | planned | custom host lane |
| Umami adapter and recipe catalog (`packages/host-umami/**`) | implemented: the adapter, its catalog entry, protocol, bug-case and validator inputs, copy plans and collect; a bug-case runtime image without the evaluator material is still required before any Umami case is delivered | Umami lane |
| Exporter, standalone harness `rbw-validate`, package format and host-extension guide (`tools/case-package/**`, `tools/case-validate/**`, `docs/product/bug-package-v1.md`, `docs/product/adding-a-host.md`) | planned | package lane |
| API acceptance tests (`tools/product-acceptance/**`) | in progress | acceptance lane |
| Completed example (section 14): its two archives, their publication and the example record | planned | package lane prepares the archives; they are published through the existing release route (`tools/release/`); the backend lane's service serves the example record from that release (`GET /api/factory/example`). No new publication path is added. |

No lane edits another lane's files. A change to a shape in this document is made only by a new revision of this document and its fixtures.

The machine-readable definition of every shape in this document is the JSON Schema `packages/factory-contract/schema/bug-request-v1.schema.json`. The TypeScript types in `packages/factory-contract/` are generated from it, and its tests validate every fixture against it.

### 15.1 Test controls (planned)

For automated acceptance, the service can start in a test mode that is refused when the deployment is production. In test mode:

- The hosted worker, sandbox provider and package storage are replaced by deterministic fakes, and the spend ledger runs on a disposable database. The test factory pool is `40000000` ($40.00). Every fake operation costs exactly its worst case, and the worst cases equal the fixtures' (worker $0.20; a candidate $0.60 on Umami and $0.30 on task-report; a validation run $0.30 on Umami and $0.20 on task-report). Settled amounts can therefore differ from the end-state fixtures; outcomes, stop codes, delivery, attention, stages and counts match them.
- A named scenario fixes every check outcome. Catalog order puts task-report first. The client sends the `interpretation.input` of the named fixture:

| Scenario | The fakes | Input from | Outcome | Stop code | Delivery | Attention | End state |
|---|---|---|---|---|---|---|---|
| `two-host-fulfilled` | Both entries qualify; validation runs pass. | `status-fulfilled.json` | `fulfilled` | `fulfilled` | `complete` | null | `status-fulfilled.json`, `validation-passed.json` |
| `partial-budget` | As `two-host-fulfilled`; after the task-report candidate settles, the Umami candidate no longer fits. | `status-partial-budget.json` | `stopped_at_limit` | `budget_exhausted` | `partial` | null | `status-partial-budget.json` |
| `sources-exhausted` | The task-report entry qualifies. | `status-exhausted.json` | `sources_exhausted` | `sources_exhausted` | `partial` | null | `status-exhausted.json` |
| `duplicate-defect` | The task-report catalog gains a second entry with the first entry's defect. | `status-duplicate-defect.json` | `sources_exhausted` | `sources_exhausted` | `partial` | null | `status-duplicate-defect.json` |
| `zero-result` | The original suite fails on the Umami buggy copy. | `status-zero-result.json` | `sources_exhausted` | `sources_exhausted` | `none` | null | `status-zero-result.json` |
| `wrong-failure` | The buggy copy reports a failure code that belongs to no criterion of the item. | `status-wrong-failure.json` | `sources_exhausted` | `sources_exhausted` | `none` | null | `status-wrong-failure.json` |
| `cancel-midway` | Pauses as described below; the test sends `POST …/stop`. | `status-cancelled.json` | `cancelled` | `cancelled_by_user` | `partial` | null | `status-cancelled.json` |
| `worker-lost` | The worker stops sending heartbeats during the first candidate's checks. | `status-operational-error.json` | `operational_error` | `worker_lost` | `none` | `needs_reconciliation` | `status-operational-error.json`, `test-evidence.json` |
| `uncertain-provider` | The first candidate's sandbox create returns an uncertain outcome. | `status-operational-error.json` | `operational_error` | `needs_reconciliation` | `none` | `needs_reconciliation` | none |
| `validation-failed` | As `two-host-fulfilled`; validation runs finish `failed`. | `status-fulfilled.json` | `fulfilled` | `fulfilled` | `complete` | null | `validation-failed.json` |
| `validation-error` | As `two-host-fulfilled`; validation runs finish `error`. | `status-fulfilled.json` | `fulfilled` | `fulfilled` | `complete` | null | `validation-error.json` |

- In `cancel-midway` the fake run pauses after the second candidate's first `check_finished`, with its next check in flight, until `POST …/stop` arrives or 60 s pass; then it continues as `status-cancelled.json` shows.
- Every start (section 7) and every validation start (section 11) is held for 2 s inside its ID lock, so concurrent duplicates overlap deterministically.
- Test endpoints need no session and exist only in test mode; otherwise they answer `404 not_found`.
- `GET /api/factory/test/evidence?request_id=` answers a read-only `TestEvidence` (fixture: `test-evidence.json`). An operation's `reserved_microusd` is its original reservation in every state. Only the operations not yet settled or reconciled still hold theirs, so the request's `reserved_microusd` is the sum over those operations alone; `settled_microusd` values add up to its `spent_microusd`.
- `POST /api/factory/test/reconcile` with `{ "request_id": string }` reconciles every held operation of that request at its worst case, as an operator would (section 8.5), and answers the `RequestStatus` after reconciliation.
- `POST /api/factory/test/reset` with `{ "scenario": string }` discards every test-mode record, ledger row and fake, releases the slot, selects the scenario for the next starts, and answers `{ contract_version, scenario }`.

```text
TestEvidence {
  contract_version, request_id
  operations: { operation_id: string,     // the spend ledger's operation ID: 64 lowercase hex characters
                kind: "worker" | "candidate_copy" | "validation" | "validation_copy", call_name: string,
                state: "prepared" | "launching" | "running" | "terminal" | "uncertain" | "reconciled",  // settled = terminal with settled_microusd set
                reserved_microusd: integer, settled_microusd: integer | null, attempt_ordinal: integer }[]  // reserved_microusd: the original reservation in every state;
                                          // settled_microusd is null unless the state is terminal or reconciled, and set when reconciled
  slot: { slot_key: "factory", holder_request_id: string | null,     // the request whose start or validation run holds the slot
          holder_validation_id: string | null }                       // set while a validation run holds it
  provider_calls: { call_name: string, provider: "sandbox", action: "create" | "stop", at: string }[]
}
```

Startup instructions and the exact revision are published with the backend pull request.

## 16. Revisions

| Revision | Change |
|---|---|
| 1 | First draft. |
| 2 | Revision 2: validation runs send heartbeats, last at most 1800 s and hold the slot from the accepted POST; a worker lost after missed heartbeats needs reconciliation; the factory pool counts committed amounts; validation IDs are scoped to a case and checked first; new warning `budget_below_item_minimum`; an overrun after finish keeps the outcome; `quantity_exceeds_source` counts distinct defects; one candidate runs at a time; criteria publish failure codes; input normalization and exact phrase matching; `not_ready` removed and identifiers opaque; scenario table, `wrong-failure` scenario, `cancel-midway` pause and test-control shapes. |

**Revision 2 clarifications.** These settle open wording points of revision 2 without a new revision; one of them adds a list rule to the schema:

1. Capabilities and interpretation count the catalog entries available over the planned window, [now, now + `max_wall_clock_s`], by the host's existing window-based availability (`supported`, a source's `entries` and `criteria_ids`, eligible sources), and a declared pair with no entry available is unsupported with the host's availability reason (sections 4.2 and 6).
2. `interpretation_sha256` covers the normalized input, the versions, the factory profile and the availability result for the planned window, not the raw time, so a changed profile or availability answers `interpretation_stale` (sections 6 and 6.1).
3. `max_description_chars` counts Unicode code points after trimming (sections 4 and 5).
4. A `202` start answers the current status, normally `queued` or `starting`, and `finished` with a failure only when the worker's reservation or launch failed after the request was recorded (section 7, step 7).
5. A `requested_criteria_passed` event's `criterion_ids` are the criteria the candidate demonstrated, which become its case's `criteria_met`: at least one, each once (section 8.4). The schema refuses an empty or repeated list.
6. `type_totals` lists each requested bug type exactly once, at least 1, and may list an unrequested type only with 0 (sections 5, 6 and 8). The schema already checks this.
7. A validation run's `cost_microusd` is its cost recorded when it completed; a run that finished `error` with uncertain spend may keep `null`, reconciliation updates the request's budget, not the run, and `null` stays distinct from `0` (section 11).
8. A test operation's `reserved_microusd` is its original reservation in every state; the request's `reserved_microusd` sums only the operations still holding theirs (section 15.1).
9. The completed example's archives are prepared by the package lane, published through the existing release route and served by the service at `GET /api/factory/example` (section 15).
