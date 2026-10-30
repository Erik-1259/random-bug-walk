# On-the-fly bug creation (OTF): specification v0

This is the shared spec for the branches that build on-the-fly bug creation in `packages/web`. It is self-contained: everything an implementer needs is here or in [`packages/web/src/otf/contract.ts`](../../packages/web/src/otf/contract.ts).

**Source of truth.** `contract.ts` defines every type, enum, constant and port. `schemas.ts` holds the runtime validators for every body, and `canonical.ts` holds the hashes. Where this text and `contract.ts` differ, `contract.ts` wins. A change to the contract goes through the W0 branch, and the other branches then rebase.

## 1. What the customer sees

OTF builds on two hosts in v0. Each host offers its own criteria (`CRITERION_HOST`):

| Host | Criteria | Qualification |
|---|---|---|
| task-report service | `concurrency.lost-acknowledged-change`, `concurrency.stale-success-response` | tier B: one round of 1 clean, 3 buggy and 3 fixed copies, then one confirmation round |
| Umami | `date_time.time-zone-grouping` | the local runner's admission sequence ([docs/admission-rules.md](../admission-rules.md) ADM-02 to ADM-06 and ADM-08), with no separate confirmation round |

- Umami OTF covers the time-zone grouping class only. Its sign-in, identity, permission and race areas are out of scope (`HOST_SCOPE_EXCLUDED`).
- The contract also knows one **open criterion**, `open.task-report-behavior`: any other non-security behavior on the task-report host, graded by a rule the customer submits. Production neither offers nor accepts it until the `RBW_OTF_OPEN_BEHAVIORS` flag exists (section 8).
- The customer describes a bug, and models on Nebius Token Factory race to build it. The RBW harness qualifies the result, and the customer downloads it.

1. **Guided input.**
   - A behavior picker lists the offered criteria from `GET /availability` (`behaviors`), grouped by host. Each option shows its label and example phrases.
   - The customer adds one sentence in their own words (3 to 300 characters).
2. **Spec card, then accept.**
   - The UI calls the existing bug designer route `POST /api/factory/assist/bug-spec` with `{ shape: { title: <picker label>, summary: <sentence>, sources: [] }, host_id: <the behavior's host_id> }`. Nemotron 3 Super writes the card.
   - The customer reads the card, may edit it, and accepts it. The UI computes `spec_sha256` with `specSha256` from `canonical.ts` and creates the job with `host_id` and `criterion_id`.
   - **Umami placement.** The builder places the bug in one of Umami's date-grouped reports that its harness supports. It uses the card to choose among them, and it may choose a different report from the one the card describes. The agent works from the harness's own task description for that report.
3. **Catalog bug offered at once.**
   - At accept time, a card offers the closest pre-qualified catalog bug: "While this builds, start the closest pre-qualified catalog bug now (about 5 min, about $0.40 from the shared judge budget)."
   - Its button starts the existing catalog flow. It is one click, never automatic, because it spends the shared judge pool.
   - The OTF job never takes the factory's slot, so both can run at once.
4. **Racing lanes.**
   - Each host has its own lane count (`OtfHostAvailability.lanes`); each lane is one Goose agent with one Token Factory model.
   - A live board shows, for each lane: stage, iteration, files written (change, checks, fix), metered spend, and each round's six-cell grid against `EXPECTED_CELLS`.
   - On Umami rounds, an admission strip sits beside the grid (`RoundResult.admission`), as in section 1.1.
   - When the builder machine is stopped, the board first shows the machine starting (`starting_builder`), with the cold-start estimate when `cold_start_min` is set.
5. **Results.**
   - **Certificate** (`OtfCertificate`): the qualifying six cells, the confirmation round's six cells (task-report), the admission result (Umami), the models, spend and timings. It is hash-bound to the bundles. It never names the planted file, line or check ids.
   - **Agent bundle** (`rbw-otf-agent-<job8>.tar.gz`, format `rbw-otf-agent/0`):
     - `app/`: the host app with the bug, no `.git`;
     - `INCIDENT.md`: a symptom-level incident;
     - `RBW-AGENT.json`: format, job id, host, criterion, tree hash and, for Umami, the runtime image reference, digest and setup steps.
     - It holds no checks, no fix and no spec. For Umami, `app/` is the whole pinned Umami tree, because any smaller overlay would point at the bug.
   - **Grader bundle** (`rbw-otf-grader-<job8>.tar.gz`, format `rbw-otf-grader/0`):
     - the added checks (task-report: check files; Umami: the check package), the answer key, the reference fix, the accepted card, the expected cells and the qualification record;
     - it warns that the checks are model-written code;
     - for Umami, it also holds the probes and the alternative fix.
   - **Optional validation:** re-runs the host's qualification on the RBW builder from the stored bundles (task-report: one tier-B round; Umami: one admission sequence).
6. **Honest failure path.** The UI shows the outcome, each lane's last round result and feedback, the total model spend, and the catalog card. The card reads "Start the closest catalog bug", or "Your catalog bug is ready" when one already ran.

### 1.1 Six cells and the admission strip

The six-cell grid is shared by both hosts. Its rows are the clean, buggy and fixed copies, and its columns are the original suite and the added checks.
- **Task-report:** the cells come from the tier-B round.
- **Umami:** the cells come from the first clean, planted and fixed admission copies (ADM-08). "Planted" is shown as "buggy".

Umami rounds also carry `admission`. The UI shows it as a strip with these labels:

| Member | Label | Shown as passed when |
|---|---|---|
| `adm_02` | Every copy ran every test | `pass` |
| `adm_03` | Fixed copies pass the added checks | `pass` |
| `adm_04` | Buggy copies fail as declared | `pass` |
| `adm_05` | Repeated runs agree | `pass` |
| `adm_06` | Partial and stub fixes are caught | `pass` |
| `comparison` | The original suite misses the bug | `blind_spot_demonstrated` |
| `alternative_fix` | A second, independent fix also passes | `pass` |

- `not_run` is shown as "not run".
- Copy counts and repetitions are quoted only as docs/admission-rules.md defines them.
- Feedback lines never name files, functions or check ids.

## 2. Customer routes

All customer routes sit under `/api/factory/otf/`. They are session-checked with the existing judge passcode cookie, except `availability`. All judges share one session, so per-session caps are global caps.

The client polls only: every `POLL_RUNNING_MS` (2 s) while a job runs, and every `POLL_FINISHED_MS` (30 s) once it has finished. Each status carries `poll_after_ms`.

| Method and path | Body | Answer |
|---|---|---|
| `GET /availability` | — | `OtfAvailability`. Needs no session. It **never** starts the machine. |
| `POST /jobs` | `OtfCreateJob` | 201 `OtfCreateResponse` (new); 200 (idempotent replay); otherwise `OtfErrorBody` with an `OtfCreateRefusal` and its status from `OTF_ERROR_STATUS` |
| `GET /jobs/{id}?after=n` | — | `OtfJobStatus` with the events after seq `n` |
| `POST /jobs/{id}/stop` | — | 202 `OtfJobStatus`. The builder sees the stop on its next events post (at most 15 s). |
| `GET /jobs/{id}/artifacts/{part}` | — | The bytes. The server re-checks sha256 and size before sending. `not_delivered` before delivery. |
| `POST /jobs/{id}/validations` | — | 201 `OtfValidation`, or 200 with the open one. Delivered jobs only. |
| `POST /classify` | `OtfClassifyRequest` | 200 `OtfClassification`. Open behaviors only (section 8.5); the server branch adds the route. |

**Errors.** Every error is an `OtfErrorBody`. A response body that fails its own schema is answered `unavailable` instead, so no member outside the contract can leave a route.

### 2.1 Server checks on create

In this order:

1. Validate the body (`validateOtf("OtfCreateJob", …)`). A failure answers `invalid_spec`.
2. Run the existing safety checks:
   - `securityTopic` and `holdsCode` on the sentence;
   - `designSecurityTopic` and `holdsCode` on every spec field, because the customer may edit the card.
   - Any hit answers `refused_topic`.
   - For the open criterion, reject a disabled open-behavior flag with `invalid_spec` next; with the flag on, screen the rule text as described in section 8.3 before proceeding.
3. Recompute `spec_sha256` with `specSha256` and, for an open job, `rule_sha256` with `ruleSha256`. A mismatch answers `invalid_spec`.
4. Check that `host_id` equals `CRITERION_HOST[criterion_id]`, the criterion is configured, and no card field or open rule text matches the host's `HOST_SCOPE_EXCLUDED`. Otherwise answer `invalid_spec`. Whether the host is offered right now is step 6a.
5. Idempotency. The same `client_key` with the same `createSha256` replays the stored job (200). The same key with a different body answers `idempotency_conflict`.
6. Check the caps, in this order: `unavailable` (OTF disabled or unconfigured, operator hold, or the VM-hours day cap), `busy` (active plus queued jobs at the limit), `daily_cap`, `spend_cap`.

   6a. **Host check.** Answer `host_unavailable` when:
   - the host is disabled in config;
   - the builder is `running` and its last fresh heartbeat's `ready_hosts` lacks it; or
   - `hostCalendarOpen(host, now, now + START_TIMEOUT_MS + deadline + CALENDAR_MARGIN_MS)` is false.

   A stopped or starting builder has no fresh heartbeat, so readiness is not checked then: the job is created and starts the machine (steps 7 and 8). A waiting job whose host becomes unavailable (including a host that the first fresh heartbeat after the start leaves out of `ready_hosts`), or whose window `[now, now + deadline + CALENDAR_MARGIN_MS]` is no longer open, finishes `builder_unavailable` on the next status read. The reason names the host and the cause; for Umami's calendar it is "Umami is unavailable on UTC days 2–5."
7. Insert the job, with its `host_id`:
   - `queued` when the builder is `running`;
   - `starting_builder` otherwise.
8. If the builder is not `running`, start the machine (section 4) under the power row lock, and append `builder_starting`. The answer does not wait for the machine.

**A stopped builder is never a refusal.** It is started, and the job waits.

### 2.2 Winner selection

1. A lane becomes a **candidate winner** when its qualification round returns `qualified`.
2. With `confirm_rounds: 1` (task-report), the builder runs one confirmation round on the same candidate bytes while the other lanes keep running.
   - **Confirmation qualifies:** the lane has `won`, and the other lanes finish `lost_race`.
   - **Confirmation fails:** the lane finishes `not_qualified` ("did not repeat"), and the race continues.
3. With `confirm_rounds: 0` (Umami), the candidate has `won` at once (`qualifying -> won`).
4. Ties go to the earliest `round_finished`, then to the lowest lane number.
5. The builder starts a qualification or confirmation round only with at least `round_min_remaining_ms` left before the deadline. A lane that cannot start one finishes `time_limit`.
6. A customer stop after `winner_selected` does not cancel the delivery. The job delivers, and the UI says "Stopped after a lane won; the bug was delivered."

The lane stage moves and the iteration rule are `LANE_STAGE_NEXT` and `nextIteration` in `contract.ts`. A lane outcome of `cancelled` means a customer stop only; the deadline gives `time_limit`.

### 2.3 Outcomes

| Outcome | When |
|---|---|
| `delivered` | A confirmed winner's bundles and certificate were stored |
| `not_qualified` | Every lane used its 3 rounds |
| `time_limit` | The job reached its deadline (the host's `deadline_ms` from claim: 45 min for task-report, 60 min for Umami) |
| `spend_limit` | A lane or job spend cap was reached |
| `cancelled` | The customer stopped it |
| `builder_start_failed` | The machine did not start (`capacity`, `api_error`), or no claim came within `START_TIMEOUT_MS` (8 min, `timeout`). The UI path is the catalog fallback. |
| `builder_unavailable` | OTF was disabled or put on hold while the job waited, or the job's host became unavailable (disabled, not ready, or its calendar window) |
| `builder_lost` | No builder post for `BUILDER_LOST_MS` (180 s) on a claimed job |
| `error` | An infrastructure failure, which is distinct from not qualified |

**Finishing on read.** The server finishes a lost or timed-out job itself, when a status is read. A late builder post to a finished job answers `job_finished` (409), and the builder then stops its lanes.

## 3. Builder routes and auth

The builder runs on a cloud machine, and it pulls work from production over HTTPS. Production never calls the builder, and the machine opens no inbound port for job transport. Machine power (section 4) is a separate channel.

### 3.1 HMAC auth

- **The secret.** One shared secret per environment, in `RBW_OTF_BUILDER_SECRET`. Preview and Production use different values.
  - If it is unset, every OTF route answers `unavailable`, and the UI hides OTF (fail closed).
- **Headers.** Every builder request carries the headers in `BUILDER_HEADERS`:
  - `x-rbw-builder-id`;
  - `x-rbw-builder-ts`: Unix ms;
  - `x-rbw-builder-sig`: hex HMAC-SHA256(secret, `builderSigningString(ts, METHOD, path, sha256hex(body))`), which is `${ts}\n${METHOD}\n${path}\n${sha256hex(body)}`. The path has no query, and an empty body hashes `""`.
- **Acceptance.**
  - The timestamp must be within ±`SIGNATURE_WINDOW_MS` (120 s).
  - The signature is compared in constant time.
  - The header builder id must equal the body's `builder_id`.
  - A failure answers `unauthorized`.
  - A replay inside the window is harmless, because every write is idempotent.
- **Preview deployments.** If deployment protection is on, the builder also sends a protection-bypass header, which is set only on the builder for preview runs.
- **One environment at a time.** The builder polls exactly one base URL. While it points at a preview, production's OTF stays disabled.

### 3.2 Routes

All builder routes sit under `/api/factory/otf/builder/`.

| Method and path | Body | Answer |
|---|---|---|
| `POST /claim` | `ClaimRequest` | 200 `ClaimReply`, or 204. A long poll, held up to `CLAIM_HOLD_MS` (20 s). It is also the idle heartbeat. |
| `POST /jobs/{id}/events` | `EventsPost` | 200 `EventsReply` |
| `POST /jobs/{id}/result` | `ResultPost` | 200 `ResultReply` |
| `GET /jobs/{id}/artifacts/{part}` | — | The stored bytes, for validate jobs, so validation survives the loss of the machine's storage |
| `POST /validations/{vid}/result` | `ValidationResultPost` | 200 `OtfValidation` |
| `POST /stop-intent` | `StopIntent` | 200 `StopIntentReply` |

**Claim.**
- A claim with `images_ok: true` marks the builder `running`. It moves every `starting_builder` job to `queued` and appends `builder_ready { cold_start_ms }` to each. `cold_start_ms` runs from the later of the last start request and the job's creation to this claim.
  - This holds for a claim from a new boot and from the same boot, so a builder that recovers from a stale heartbeat without a reboot still picks up the jobs that waited.
- `images_ok: false` (a pinned-image mismatch after boot) hands out no job and promotes none.
- The claim carries free capacity per host (`free.build[host]`, `free.validate[host]`) and `ready_hosts`, the hosts whose lane profile is installed and checked on this boot. Production stores `ready_hosts` with the heartbeat. While the builder is `running`, it offers a host only when the last fresh heartbeat lists it (`unavailable_reason: builder_not_ready` otherwise); while it is stopped or starting, readiness does not block a create (section 2.1, step 6a).
- Validations are handed out first, then the oldest queued build whose host has free build capacity in `free.build[host]` and fewer than that host's `max_active` building. A saturated host never blocks another host's jobs.
- A build claim sets `building`, appends `job_claimed`, sets `deadline_at = claim + the host's deadline`, and sets `lease_until = now + LEASE_MS` (90 s). The build job's `limits` come from the host profile.

**Events.**
- Posted at least every `HEARTBEAT_MS` (15 s). An empty list is the heartbeat, and every post extends the lease.
- `builder_seq` is the builder's own gap-free counter per job, starting at 1.
- Production assigns the public `seq` on insert. Production's own events (`job_queued`, `builder_starting`, `builder_ready`, `builder_start_failed`, `job_claimed`, `job_finished`) share that one ordered stream.
- A repeated `builder_seq` is ignored when its canonical bytes (`builderEventBytes`) equal the stored ones. It is refused with `event_conflict` when they differ, and so is a gap.
- The builder may post only `BUILDER_EVENT_TYPES`.
- The reply's `control.stop` carries a customer stop, the deadline or the spend cap.

**Result.**
- `delivered` requires the certificate and exactly one of each part (agent, grader, certificate). Any other outcome carries neither.
- Production reads at most `RESULT_BODY_MAX_BYTES` (4,400,000 bytes) of body (section 3.4), then checks:
  - the gzip magic of the tarballs;
  - that each part is at most `PART_MAX_BYTES_BY_PART[part]` (agent 2 MiB, grader 512 KiB, certificate 64 KiB);
  - the sha256 and size of the decoded bytes;
  - `SAFE_FILENAME`;
  - that `certificate.bundles` equals the part hashes;
  - that the certificate's `host_id` equals the job's;
  - that the job's `spec_sha256` equals the certificate's.
- It then stores the parts, sets `certificate.received`, and appends `job_finished`, all in one transaction. The transaction first checks, under the job's row lock, that the job is still `building` and claimed by this builder. A job that a status read has already finished (for example as `time_limit` or `builder_lost`) is answered `job_finished`, and nothing is stored.
- It is idempotent on `(job_id, part sha256s)`, and answers 200 `ResultReply`.

**Validation result.** It carries `admission` for Umami jobs (null for task-report).

**Stop intent.** See section 4.

### 3.3 Storage

- **The store port.** Storage is one Postgres schema, `otf`, behind the `OtfStore` port in `contract.ts`.
  - W1 implements the port on Postgres. W2 consumes it, and its tests use W1's in-memory `createMemoryOtfStore` as the one fake.
  - The two branches meet only through this port.
- **What the port provides:**
  - an idempotent create on `client_key`;
  - compare-and-set job and validation updates;
  - production and builder event appends with gap-free seq and the byte-identical duplicate rule;
  - an atomic claim with a lease, per host;
  - a delivery stored in one transaction, with its `job_finished` event;
  - the builder heartbeat;
  - the single power row, under a lock, with a power log.
- **What it never touches:** the spend ledger tables and the factory slot.

### 3.4 Result transport

The result stays one JSON `POST` with base64 parts. The hosting platform refuses any function request or response body over 4.5 MB with its own 413, before the route runs, so the contract keeps every body under that limit:
- **Per-part caps:** agent 2 MiB, grader 512 KiB, certificate 64 KiB. In base64 that is at most 3,582,640 characters, plus the certificate object and the envelope, under `RESULT_BODY_MAX_BYTES`.
- **Builder side:** the builder serializes the body, checks it against `RESULT_BODY_MAX_BYTES`, and finishes the job `error` ("result too large") instead of posting a body that cannot arrive.
- **Downloads:** downloads and the builder's validate-job reads are single responses of at most one part (2 MiB), well under the response limit.
- **Fallback (not needed now):** raw-bytes part uploads. They would be a W0 change.

## 4. On-demand builder lifecycle

The builder machine is **stopped when idle** and started per request.

**Power from production.**
- Production holds a power-only cloud service-account key for this one machine, in `RBW_NEBIUS_SA_ID`, `RBW_NEBIUS_SA_KEY_ID` and `RBW_NEBIUS_SA_PRIVATE_KEY`. The instance is named by `RBW_NEBIUS_VM_ID`.
- The key can view, start and stop this instance only. It cannot resize it, so there is no smaller fallback size: a capacity failure goes straight to the catalog fallback.
- Production reaches the cloud API through the `VmPower` port. The W5 implementation uses the Nebius JS SDK, an approved new dependency.

**Builder state** (`BuilderState`, in availability and status):
- It combines the instance state with the builder heartbeat.
- `running` means the heartbeat is fresh (within `BUILDER_FRESH_MS`, 60 s), not just that the instance is up.
- The other states are `starting`, `stopped`, `stopping` and `unknown`.

**Start.**
- A session-checked create starts the machine when the builder is not `running`. Availability and status reads never start it.
- Starting twice is harmless: an instance that is already running or starting is a no-op.
- The job sits in `starting_builder` until the next healthy claim (section 3.2).
- With no claim within 8 min, the job finishes `builder_start_failed` (`timeout`). A start error finishes it with `capacity` or `api_error`.
- `builder_starting` is appended before any `builder_start_failed`, even when the start call itself throws.
- A job created while the state is `stopping` waits, and the machine is started again once the instance reports stopped.

**Boot.** A system service starts at boot, loads the pinned container images, checks them, and then claims.

**Self-stop.**
- After `IDLE_STOP_MS` (10 min) with no job queued or active, the builder posts a stop intent.
- Under the power row lock, production allows it only when no job is queued, starting or building. `max_uptime` and `builder_fault` are always allowed, and their claimed jobs finish `builder_lost`.
- On allow, the state becomes `stopping`, and the builder stops its own instance through the cloud API with its own power-only key. An in-guest shutdown does not stop billing.
- The heartbeat continues while idle, so production's state stays accurate.

**Watchdog.**
- It runs in production on status reads and on the availability route, with at most one cloud API call per `WATCHDOG_MIN_INTERVAL_MS` (30 s).
- It stops the instance when:
  - the instance is running, there has been no heartbeat for 10 min, and no job is active;
  - the instance has been running for more than 90 min past the last job's finish;
  - the instance has been running for more than `MAX_UPTIME_MS` (3 h).
- It never calls stop while a job is `building` with a fresh heartbeat, not even for the uptime limit. The builder's own timer enforces that limit through a `max_uptime` stop intent.
- Every power action is written to the power log.

## 5. Caps (defaults, `OTF_HOST_DEFAULTS` and `OTF_DEFAULTS`)

Per-host defaults are in `OTF_HOST_DEFAULTS` and global caps are in `OTF_DEFAULTS`:

| Cap | task-report | Umami | Enforced by |
|---|---|---|---|
| Lanes per job | 3 | 2 | job |
| Rounds per lane | 3 | 3 | builder harness |
| Confirmation rounds | 1 | 0 | builder |
| Per-lane model spend | $3.00 | $3.00 | builder proxy |
| Per-job model spend | $8.00 | $6.00 | builder (`spend_limit`) |
| Active build jobs | 2 | 1 | production (claim, per host) |
| Job deadline from claim | 45 min | 60 min | builder and production |
| Last round start before the deadline | — | 11 min | builder |
| Calendar | — | not on UTC days 2–5 | production (`host_unavailable`) |

Global caps: queued jobs 4, jobs per UTC day 30, total OTF model spend set by the operator (shared by both hosts), builder-wide model total set by the operator, idle before self-stop 10 min, max continuous uptime 3 h, machine hours per UTC day 12 h. Meter spend counts cached input at the full input rate, so it is an upper bound.

## 6. Honesty copy rules

**The rule:** nothing is called live per-request generation unless this job ran it.

| State | Copy |
|---|---|
| Job running or delivered | "Built for your request by Goose with {model} on Nebius Token Factory. Spec card by Nemotron 3 Super." |
| Certificate (task-report) | "Qualified by the RBW harness on the RBW builder (Nebius VM): six cells, pinned task-report kit image, 4 vCPU / 8 GB per copy, then confirmed in a second round." Never "on Vercel Sandbox", and never "verified by the factory worker". |
| Certificate (Umami) | "Qualified on the RBW builder (Nebius VM) with the local runner's admission sequence (docs/admission-rules.md) on the pinned Umami kit image with this build's checks, 4 vCPU / 8 GB per copy. Development evidence, not an RBW release." Never "admitted", "released" or "on Vercel Sandbox". |
| Umami placement (spec accept and lane board) | "The builder places the bug in one of Umami's date-grouped reports that its harness supports, chosen to match your card where it can. It may differ from the report your card describes." |
| Umami calendar | "Umami is unavailable on UTC days 2–5." |
| Catalog bug | Today's wording, unchanged: "pre-qualified catalog bug, re-verified for your request". |
| Time estimate | Only when the host's `typical` is present. With `source: "otf_jobs"`: "Usually about {median_min} minutes; 9 in 10 finished within {p90_min} minutes ({samples} builds measured, last on {measured_on}). Your bug may take longer or not qualify." With `source: "development_attempts"`: "In development runs, a qualifying build attempt took about {median_min} minutes, and 9 in 10 took at most {p90_min} minutes ({samples} attempts, measured {measured_on}). Waiting, machine start-up and packaging add to that. Your bug may take longer or not qualify." When `typical` is null: "Build times for {host label} are not measured yet. The board shows each step as it runs." An open behavior always shows the section 8.7 copy instead. |
| Queued | "Another build is running. Yours is number {n} in line." The typical-time clause is added only when `typical` is present. |
| Cold start (only when `cold_start_min` is set) | "Starting the Nebius machine usually takes about N minutes." |
| Spend | "Model spend so far: $X (metered by the builder; an upper bound)." Shown apart from the Sandbox budget line. |
| OTF unavailable (`enabled: false`) | "Custom builds are offline right now. The catalog is available." No queueing illusion. |
| Validation | task-report: "Re-runs the six cells on the RBW builder." Umami: "Re-runs the admission sequence on the RBW builder from the stored bundles." |
| Not qualified | task-report: "No lane produced a bug that passed all six cells in 3 rounds." Umami: "No lane produced a bug that passed the admission sequence in 3 rounds." |
| Stopped after a win | "Stopped after a lane won; the bug was delivered." |

**Where time figures come from.** Each host's `typical` is set by the operator from config, or is null, and copy shows a time only from it. The UI hard-codes no minutes. Every value set there points to a committed results file:
- [`evidence/build-time-2026-10-29.json`](evidence/build-time-2026-10-29.json) holds the development measurements per host: the wall time of each qualified experiment attempt (one lane, one model, one spec), at 4 vCPU / 8 GB per copy, with its sample counts, per-model counts and method.
- Those attempts are not OTF jobs: the times leave out the queue, the cold start, the confirmation round and packaging. A `typical` taken from that file has `source: "development_attempts"` and uses its `qualified_wall_min.median` and `p90`, `samples` = its `qualified`, and `measured_on` = its `measured_on`.
- Once finished OTF jobs are measured (claim to finish), they replace it, in a new committed file, with `source: "otf_jobs"`.

- Infrastructure errors (`error`, `builder_start_failed`, `builder_lost`, `builder_unavailable`) are worded as errors, never as "the models could not build it".
- **Copy that becomes conditional:**
  - the designer's catalog note ("Today Random Bug Walk delivers the closest proven bug from its catalog…") shows only where OTF is not enabled; where it is, the note says the design is not built as written and points to "Build a custom bug", which writes its own card;
  - "One runs at a time" now applies to catalog requests only;
  - "A request itself makes no model call" is scoped to catalog requests;
  - the catalog novelty caveat does not apply to OTF bugs.
- **Never claim:**
  - novelty of an OTF bug;
  - on-the-fly creation on a host or criterion that availability does not offer;
  - that Umami OTF covers sign-in, identity, permission or race behavior;
  - that an Umami OTF bug is an admitted or released RBW case;
  - that a person checked the generated checks;
  - that custom builds are always available.
- **No number without its basis:** a time, count or rate in OTF copy is either a contract constant, a figure from docs/admission-rules.md, or a runtime value shown with its sample count and date.

## 7. Branches and ownership

**Rules for every branch:**
- Base on current `main`.
- Touch only the files your row owns.
- Never touch the factory paths: `tools/controller`, `packages/factory*`, `packages/envelope`, `packages/host-*`, `tools/case-*`.
- No new npm dependency, except the two in W5's row (the cloud SDK and `pg`).
- Do not remove or rename existing tests. Raise the `packages/web` floor in `scripts/checks/test-floors.json` by the number of tests you add.
- Keep existing UI labels byte-identical.

| Branch | Owns (only these files) | Depends on |
|---|---|---|
| **W0 `otf/contract`** | `packages/web/src/otf/{contract,schemas,canonical}.ts`, `test/otf/contract.test.ts`, `docs/otf/SPEC.md` | — |
| **W1 `otf/server-store`** | `packages/web/otf-migrations/0001_otf.sql`, `src/otf/store.ts` (`OtfStore` on Postgres), `src/otf/builder-auth.ts`, `src/otf/builder-handlers.ts`, `app/api/factory/otf/builder/**/route.ts`, the OTF section of `src/config.ts` (the only branch that edits `config.ts`), `test/otf/{store,builder-auth,builder-routes}.test.ts` | W0 |
| **W2 `otf/server-customer`** | `src/otf/handlers.ts` (create with queue and start-on-create, status projection, stop, artifacts, validations, availability, caps, finish on read), `src/otf/projection.ts`, `app/api/factory/otf/{availability,jobs}/**/route.ts`, `app/api/factory/otf/test/reset/route.ts` (test mode only; 404 otherwise), `test/otf/{customer-routes,projection}.test.ts` | W0. It codes against `OtfStore` and `VmPower` with in-memory fakes (W1's `createMemoryOtfStore` for the store), loads `otfTestWorld()` in test mode, and calls W5's lifecycle module through its exported functions. |
| **W3 `otf/ui`** | `src/otf/client.ts` (its own localStorage key `rbw.otf.job` and its own lock name), `src/components/otf/*.tsx` (behavior picker, spec accept, lane board, lane card, six-cell grid, certificate, failure, catalog offer; each a pure view plus a stateful wrapper), the insertion points in `src/components/factory-workspace.tsx` and `src/components/bug-designer.tsx`, the copy changes of section 6, `test/otf/*.test.tsx` | W0 |
| **W4 `otf/test-mode`** | `src/otf/test-mode/{fake-builder,timeline}.ts` (scripted **synthetic** lanes with invented check names and cells), `test/otf-browser.mjs` (Playwright, outside vitest; its server command sets an invented, test-only `RBW_OTF_BUILDER_SECRET`), `test/otf/test-mode.test.ts` | W0, and W2's handler signatures through the contract |
| **W5 `otf/vm-power`** | `src/otf/power/nebius.ts` (`VmPower` over `@nebius/js-sdk`: get, start and stop of the one configured instance; nothing else exported), `src/otf/power/lifecycle.ts` (the section 4 state machine, watchdog rules, the VM-hours day cap and the operator hold), `app/api/factory/otf/cron/power/route.ts`, the cron entry in `vercel.json`, `packages/web/package.json` and `pnpm-lock.yaml` (the SDK only, and `pg`, pinned), `next.config.ts` (only if the SDK must be listed as a server external package), `test/otf/{lifecycle,power-nebius}.test.ts` | W0. Its first task is proving that the SDK loads in a Vercel function with a read-only `get()`. |

**Coordination.**
- Only W1 edits `config.ts`. Only W3 edits existing components and page copy.
- Route directories are disjoint.
- If an interface must change, it changes in W0 first.

The open-behavior branches are listed in section 8.11.

**Merge order:** W0, then W1, W2, W4 and W5 (in any order), then W3. Only W5 edits `package.json`, `pnpm-lock.yaml`, `next.config.ts` and `vercel.json`. Integration follows on a preview deployment, with the builder pointed at that preview.

## 8. Open behaviors

Open behaviors let a customer build a non-security behavior on the task-report host that none of the three proven criteria covers. A classifier model reads the customer's spec card and names the bug family, any proven match, and a grading rule. This section is the contract the server branch and the UI branch code against; neither edits `contract.ts`, `schemas.ts` or `canonical.ts`.

### 8.1 The open criterion

- `OTF_OPEN_CRITERION_ID` is `open.task-report-behavior`. It is the last entry of `OTF_CRITERION_IDS`, and `CRITERION_HOST` puts it on `task-report`. Umami has no open criterion.
- `PROVEN_CRITERION_IDS` lists the three proven criteria, and `isProvenCriterion` tells them apart. `PROVEN_FAILURE_CODE` gives each its failure code, and `PROVEN_FAILURE_CODES` lists them:

| Criterion | Host | Failure code |
|---|---|---|
| `concurrency.lost-acknowledged-change` | task-report | `acknowledged_completion_not_counted` |
| `concurrency.stale-success-response` | task-report | `stale_success_response` |
| `date_time.time-zone-grouping` | Umami | `local_day_counts_mismatch` |

- The open behavior's picker label is `OTF_OPEN_LABEL`: "Another non-security behavior (not measured yet)".
- `OTF_CONTRACT_VERSION` stays `otf/0`. Not every addition is optional: `OtfBehaviorOption.measured` is a new required member of availability (section 8.4). Every other addition is optional or applies to the open criterion only, and the builder-facing bodies of a proven job (claim, events, result, validation and certificate) validate exactly as before.
- A browser tab still open on the bundle before this change does not know `measured`; its strict availability check refuses the new answer, so that tab shows OTF as unavailable until it is reloaded.

### 8.2 The flag

- `RBW_OTF_OPEN_BEHAVIORS=1` turns open behaviors on. Unset (or any other value) means off.
- While it is off, the deployment behaves as before open behaviors existed, apart from the `measured` member in availability (section 8.1):
  - availability lists only the proven behaviors;
  - a create naming the open criterion answers `invalid_spec`, after the usual safety checks on the sentence and card;
  - no new open job can be admitted; previously admitted open jobs may still be claimed and completed, since the flag does not cancel or drain them;
  - the classify route answers `unavailable` to a signed-in judge;
  - the bug designer's card shows no "Build this as a custom bug" button, and the picker has no open option.
- With the flag on, availability adds the open behavior on task-report (when that host is offered), with `label: OTF_OPEN_LABEL` and `measured: false`.
- Set `RBW_OTF_OPEN_BEHAVIORS=1` in an environment only after the builder that reads `BuildJob.rule` is installed and pointed at that environment. A claim does not tell production whether the builder supports open jobs, so an earlier builder would claim an open job and build it without its rule.

### 8.3 The rule and the create body

**`OtfOpenRule`** `{ family, observable_failure, failure_code }`:
- `family`: one of `OTF_OPEN_FAMILIES` (`concurrency`, `date_time`, `data_handling`, `state_ui`);
- `observable_failure`: 40 to 600 characters of plain text: what a check observes through the app's routes.
  - The limits (`OBSERVABLE_FAILURE_MIN_CHARS`, `OBSERVABLE_FAILURE_MAX_CHARS`) count Unicode code points, as Ajv does. A UI must count the same way (`[...text].length`), not in UTF-16 code units (`text.length` or an input's `maxlength`), where an emoji counts twice.
  - Plain text refuses control characters (`\p{Cc}`: C0, DEL and C1, so tab, line feed, carriage return and U+0085), line and paragraph separators (`\p{Zl}` U+2028, `\p{Zp}` U+2029) and format characters (`\p{Cf}`: bidi controls such as U+202E, zero-width characters such as U+200B, U+200D and U+FEFF). Everything else is accepted.
- `failure_code`: matches `OPEN_FAILURE_CODE_PATTERN` (`^[a-z][a-z0-9_]{2,47}$`) and is none of `PROVEN_FAILURE_CODES` or `OTF_RESERVED_FAILURE_CODES` (`control_failed`, `detection_inconsistent`: the builder's harness uses these as its own markers, so a rule reporting one could never qualify).
- The schema refuses unknown members, as every OTF schema does.

**Create.** `OtfCreateJob` gains `rule` and `rule_sha256`. Both are required when `criterion_id` is the open criterion and forbidden otherwise (the `OtfCreateJob` schema enforces this).
- `rule_sha256` is `ruleSha256(rule)`: sha256 of `ruleCanonical(rule)`, the canonical JSON of the three rule fields only.
- `spec_sha256` stays over the spec only.
- `createSha256` (the idempotency hash) includes `rule` (as `ruleCanonical`) and `rule_sha256` when set. A body without a rule hashes byte-identically to the hash before open behaviors existed, so stored `create_sha256` values and replays are unchanged.

**Server checks for an open create**, in order (see section 2.1):
1. Validate the body, including the rule's shape and presence. A failure answers `invalid_spec`.
2. Screen the sentence and card fields for security topics and code. A hit answers `refused_topic`.
3. If the open-behavior flag is off, answer `invalid_spec` without screening the rule text.
4. Screen `rule.observable_failure` for security topics and code. A hit answers `refused_topic`.
5. Recompute `spec_sha256`, then `rule_sha256` with `ruleSha256`. A mismatch answers `invalid_spec`.
6. Check the host/criterion pairing, configured criterion and host scope over the card fields and rule text. A failure answers `invalid_spec`.
7. Compute the create hash, then check idempotency under the power lock before caps and host admission. The admitted job stores the rule (section 8.8).

The classifier's answer is advisory. The customer may edit the rule before submitting, and production validates what is submitted, never the classifier's answer.

### 8.4 Behaviors, claims, status and the certificate

- **`OtfBehaviorOption.measured`** (required): `true` for the proven behaviors, `false` for the open one. The availability schema ties it to the criterion.
- **Build claim.** A `BuildJob` gains `rule`, present only for open-criterion jobs and copied from the stored job. A proven `BuildJob` has no `rule`, so a builder deployed at the earlier contract keeps validating every claim, event post and result of a proven job.
- **Status.** `OtfJobStatus` gains `rule`, present exactly when `criterion_id` is the open criterion (the server branch passes the stored rule through).
- **Certificate.** `criterion` is `{ criterion_id, version: "1" | "open-1", failure_code }`, and the certificate gains `rule`.
  - Proven criterion: `version: "1"` and no `rule`, which is today's exact shape.
  - Open criterion: `version: "open-1"`, `rule` present, and `criterion.failure_code` equal to `rule.failure_code`.
  - Only the task-report variant has an open form. The server branch also checks that the certificate's rule equals the job's stored rule before it stores a delivery, and passes the certificate through unchanged.

### 8.5 The classify route

`POST /api/factory/otf/classify` (`OTF_CLASSIFY_PATH`). Signed-in judges only, with the same session as `/api/factory/assist/bug-spec`.

- **Request** `OtfClassifyRequest`: `{ sentence, spec: OtfSpecCard, host_id? }`. The sentence has the create limits (3 to 300 characters).
- **Answer** `OtfClassification`:
  - `family`: an `OTF_OPEN_FAMILIES` value, or null only on a refusal;
  - `proven_criterion_id`: one of the proven criteria, or null;
  - `buildable`: a list of `{ host_id, criterion_id }` pairs whose host matches `CRITERION_HOST`, each at most once;
  - `rule`: an `OtfOpenRule`, or null;
  - `refusal`: null, or `{ kind: "security" | "out_of_scope", reason }` with a reason of 1 to 300 characters;
  - `model`: the classifier model.
- **Invariants**, enforced by `validateOtf("OtfClassification", …)`:
  - a refusal means `buildable` is empty and `rule` and `proven_criterion_id` are null;
  - no refusal means `family` is set and `buildable` has at least one entry, so the UI always has a next step;
  - the open criterion in `buildable` means `rule` is non-null;
  - a non-null `proven_criterion_id` means `buildable` includes it.
- **Errors** use the shared `OtfErrorBody` and the codes in `OTF_CLASSIFY_ERRORS`: `signed_out` (no session), `invalid_request` (a malformed body), `refused_topic` (a security topic or code in the sentence or card, found before any model call) and `unavailable`. Only `unavailable` is retryable.

**What the server does** (`packages/web/src/otf/classify.ts`), in order:

1. No judge session answers `signed_out`.
2. `RBW_OTF_OPEN_BEHAVIORS` off answers `unavailable`. Outside local factory test mode, OTF must also be configured. Local test mode supplies its own hosts and store, so it does not need live OTF configuration; it still requires the open flag, judge session and designer key. A Vercel deployment refuses factory test mode and cannot sign in through it.
3. A body that fails `OtfClassifyRequest` answers `invalid_request`.
4. The existing safety checks run before any model call: the input security check on the sentence, the design security check on every card field (title, where, change, why the tests miss it, fix and each added check), and the code check on the sentence and every field. Any hit answers `refused_topic`.
5. No Token Factory key answers `unavailable`.
6. The classifier model is `CLASSIFIER_MODEL`, fixed to the bug designer's default model (NVIDIA Nemotron 3 Super, `nvidia/nemotron-3-super-120b-a12b`). The designer's `RBW_ASSIST_MODEL` override does not change the classifier model. One structured call with the strict wire schema (`CLASSIFY_WIRE_SCHEMA`) gets the card as untrusted data, with `host_id` as the app (`unspecified` when absent). Each call, the repair included, takes one unit of the session's `bug-spec` budget, the bug designer's budget; an exhausted budget answers `unavailable`. A call that fails, runs past 20 seconds or returns no message content answers `unavailable`, with no repair.

**The wire answer** is `{ decision, proven_criterion_id, family, observable_failure, failure_code, reason }`, with `decision` one of `proven`, `open`, `security` or `out_of_scope`, and `proven_criterion_id` and `family` each allowing `none`. The server maps it as follows; anything listed as a problem goes to the repair:

- A truncated answer, an answer that is not one JSON object, or one that fails the wire schema is a problem.
- `security` or `out_of_scope`: `family` and `proven_criterion_id` must be `none` and both rule fields empty. The answer is a refusal of that kind with the trimmed `reason`.
- `proven`: `family` must be the criterion's family and both rule fields empty. On an Umami card, only `date_time.time-zone-grouping` is accepted. The answer lists that criterion alone in `buildable`, on its host, with `rule` null; the server does not add the open criterion beside it.
- `open`: `family` must be set and `proven_criterion_id` must be `none`. An `observable_failure` that the design security check flags is a security refusal at once, with no repair. One that holds code is a problem, and so is every route problem below. The answer is `family`, `rule` `{ family, observable_failure, failure_code }` and `buildable: [{ host_id: "task-report", criterion_id: "open.task-report-behavior" }]`.
- The mapped answer must then pass the `OtfClassification` schema, including the rule limits of section 8.3; a failure is a problem. `model` is `CLASSIFIER_MODEL`.

**Route rules for `observable_failure`** (`ruleRouteProblems`). The task-report service has six routes: `GET /api/heartbeat`, `POST /api/tasks`, `GET /api/tasks/{id}`, `PATCH /api/tasks/{id}`, `POST /api/tasks/{id}/completions` and `GET /api/reports/completions/daily`.

- Every token holding `/api/`, including a full URL, must name one of those paths once its query string and trailing punctuation are removed. Paths compare literally, so a task path is written `/api/tasks/{id}`. A rule must name at least one route.
- A method attached to a path must be allowed for that route. A method is attached when it is written directly before the path (`"METHOD /path"`, or a group such as `GET|PATCH`, `GET or PATCH` or `GET, PATCH`), or when one to three filler words come between them, such as "a PATCH request to /path" (the filler words are a, an, the, request, requests, call, calls, to, on and against).
- Quoted data is not checked: text inside double quotes (straight or curly) and inside single quotes that are not apostrophes is masked before every other rule, so a quoted title or note can neither hide nor fake a method, a path or a sentence break. Text in backticks stays visible, since routes are often written as code.
- A path with no attached method passes when the route exists.
- A `GET`, `POST` or `PATCH` that is not attached to a path must be allowed for at least one route named in the same sentence (sentences end at ". ", "; ", "! ", "? " or the end of the text); a sentence that names no route is not checked.
- `PUT`, `DELETE`, `HEAD` and `OPTIONS` are allowed on no route, so each is a problem anywhere outside quoted data.
- These rules check the classifier's answer only. A submitted rule goes through the create checks of section 8.3.

**Repair.** At most one repair follows the first answer. The server sends back the model's answer and every problem, asks for JSON that matches the schema with only the six routes and their allowed methods, and says `out_of_scope` is acceptable when there is no route-level equivalent. If the repaired answer is still unusable, the route answers an `out_of_scope` refusal saying the card could not be translated into a usable check through the task-report routes; when both unusable answers had the decision `security`, it answers a `security` refusal instead.

**Timing.** Each model call is abandoned after 20 seconds, and the route's `maxDuration` is 60 seconds. The classify client waits up to 65 seconds (`OTF_CLASSIFY_TIMEOUT_MS`), longer than the other OTF calls.

### 8.6 Scope rules (the server branch implements them)

- A security topic or code found by the pre-call sentence/card checks answers the `refused_topic` error. A model security decision, or a security topic found in its proposed rule, answers `refusal.kind = "security"` with `buildable` empty.
- Umami stays time-zone grouping only. An Umami card about anything else answers `buildable: [{ host_id: "task-report", criterion_id: "open.task-report-behavior" }]` only when the behavior could plausibly exist in a task-and-report service; otherwise `refusal.kind = "out_of_scope"`.
- A card that matches a proven criterion names it in `proven_criterion_id` and lists that criterion alone in `buildable`. The UI can separately offer the open-behavior override when availability permits it.
- The answer is advisory: the customer may edit the rule, and production validates what is submitted, including the existing scope check over the rule text (section 8.3).

### 8.7 Copy

- **Time.** An open behavior always shows: "Build times for this kind of behavior are not measured yet. The board shows each step as it runs." (`OTF_OPEN_TIME_COPY`). It never shows a host's `typical`, development figures or any other time estimate, because none was measured for open behaviors.
- **No success rate.** No copy claims a success rate, a qualification rate or a typical outcome for open behaviors.
- The certificate copy of section 6 applies unchanged (an open job runs the task-report tier-B qualification); it adds the rule's family and failure code, and it does not call the rule a catalog criterion.
- Every rule of section 6 still applies, including "never claim novelty".

### 8.8 Storage

`packages/web/otf-migrations/0002_otf_open.sql` adds a nullable `rule jsonb` column to `otf.jobs` (`ADD COLUMN IF NOT EXISTS`). It is additive and idempotent, and apply it after `0001_otf.sql`. Proven jobs keep `rule` null. `OtfNewJob` and `OtfJobRecord` carry an optional `rule`; the Postgres store reads and writes it, and the in-memory store preserves it too.

### 8.9 What stays the same

- The proven criteria, their create checks, idempotency hashes, claims, events, results, validations and certificates: every builder-facing body of a proven job validates exactly as before.
- Their availability, except the new required `measured` member (section 8.1): a browser tab open on the earlier bundle shows OTF as unavailable until it is reloaded.
- The builder routes, their auth and `OTF_CONTRACT_VERSION`.
- Every existing UI label.

### 8.10 Why open behaviors are built only on the task-report service

The two apps offer different scope:
- **Task-report service:** the two proven concurrency behaviors, plus open behaviors. An open behavior is any other non-security behavior. The classifier routes it there (section 8.5), and a rule the customer can edit grades it (section 8.3). Open behaviors are labeled "not measured yet" (section 8.7).
- **Umami:** the proven time-zone grouping behavior only. Umami has no open criterion (section 8.1).

**An Umami card about anything else.** Such a card is never built on Umami.
- When the behavior could plausibly exist in a task-and-report service, the classifier translates the card into the closest equivalent failure there. It offers that failure as a task-report open behavior with a rule, and the build runs and qualifies in the task-report service.
- Otherwise the card is refused as out of scope (section 8.6).
- The translated rule names task-report routes, and the custom-build panel says "Builds in the task-report service, not Umami", so before accepting, the customer can see where the build runs.

**Why Umami stays time-zone only.**
- **The builder's Umami path is purpose-built.** Its lane instructions, its admission sequence and its qualification run are all designed around Umami's date-grouped reports and the time-zone behavior. They assume the bug lands in one of those reports and that the added checks detect it there. That path has no place for an arbitrary rule.
- **The task-report qualification is generic.** Its six cells check two things. The original suite must pass on the clean, buggy and fixed copies. The added checks must fail only on the buggy copy, with the expected failure code. A confirmation round then repeats the whole check. No step depends on which behavior was planted, so the failure code can come from a customer's rule as easily as from a proven criterion.
- **Umami qualification is heavier and specific.** Umami's original suite is much larger and slower than the task-report suite. In development, a qualified attempt took a median of 21.0 minutes on Umami and 15.5 minutes on the task-report service ([development timing evidence](evidence/build-time-2026-10-29.json)). Umami's qualification is also tied to the admission steps for the date-grouped reports.
- **Umami's excluded areas must stay excluded.** Sign-in, identity, permission and race behavior are out of scope on Umami (`HOST_SCOPE_EXCLUDED`). A general Umami path would have to keep them out.

Building open behaviors on Umami is planned work for after the hackathon. It needs a general Umami lane runner, a qualification sequence for any Umami behavior, and paid measurement runs. See [Open behaviors on Umami](../ROADMAP.md#open-behaviors-on-umami) in the roadmap.

### 8.11 Branches

The contract, server and UI implementations are merged on main. This table records their branch ownership; the server and UI branches did not edit `contract.ts`, `schemas.ts` or `canonical.ts`. The builder remains in a separate repository.

| Branch | Owns |
|---|---|
| `otf/open-server` | the classify route (section 8.5) and its scope rules (8.6); open create validation (8.3) and storage (8.8); the `rule` in the claim payload (8.4); the `RBW_OTF_OPEN_BEHAVIORS` availability flag (8.2); status projection and certificate pass-through of the rule (8.4) |
| `otf/open-ui` | the picker's open option; the classify call and its outcomes (proven match, open rule, refusal); the bug designer's "Build this as a custom bug" handoff; the time copy (8.7); the open certificate view |
| builder (separate repository) | reads `BuildJob.rule` on open jobs, grades the added checks by `rule.failure_code`, and issues the `open-1` certificate |
