# On-the-fly bug creation (OTF): specification v0

This is the shared spec for the branches that build on-the-fly bug creation in `packages/web`. It is self-contained: everything an implementer needs is here or in [`packages/web/src/otf/contract.ts`](../../packages/web/src/otf/contract.ts).

**Source of truth.** `contract.ts` defines every type, enum, constant and port. `schemas.ts` holds the runtime validators for every body, and `canonical.ts` holds the hashes. Where this text and `contract.ts` differ, `contract.ts` wins. A change to the contract goes through the W0 branch, and the other branches then rebase.

## 1. What the customer sees

OTF is task-report only in v0. The customer describes a bug, and models on Nebius Token Factory race to build it. The RBW harness qualifies the result, and the customer downloads it.

1. **Guided input.**
   - A behavior picker lists the criteria from `GET /availability` (`behaviors`). Each option shows its label and example phrases.
   - The customer adds one sentence in their own words (3 to 300 characters).
2. **Spec card, then accept.**
   - The UI calls the existing bug designer route `POST /api/factory/assist/bug-spec` with `{ shape: { title: <picker label>, summary: <sentence>, sources: [] }, host_id: "task-report" }`. Nemotron 3 Super writes the card.
   - The customer reads the card, may edit it, and accepts it. The UI computes `spec_sha256` with `specSha256` from `canonical.ts` and creates the job.
3. **Catalog bug offered at once.**
   - At accept time, a card offers the closest pre-qualified catalog bug: "While this builds, start the closest pre-qualified catalog bug now (about 5 min, about $0.40 from the shared judge budget)."
   - Its button starts the existing catalog flow. It is one click, never automatic, because it spends the shared judge pool.
   - The OTF job never takes the factory's slot, so both can run at once.
4. **Racing lanes.**
   - Three lanes (`lane-1` to `lane-3`), each one Goose agent with one Token Factory model.
   - A live board shows, for each lane: stage, iteration, files written (change, checks, fix), metered spend, and each round's six-cell grid.
   - The six-cell grid has one row per copy (clean, buggy, fixed) and two columns (original suite, added checks). It is shown against `EXPECTED_CELLS`.
   - When the builder machine is stopped, the board first shows the machine starting (`starting_builder`), with the cold-start estimate when `typical.cold_start_min` is set.
5. **Results.**
   - **Certificate** (`OtfCertificate`): the qualifying six cells, the confirmation round's six cells, the models used, the spend and the timings. It is hash-bound to the bundles.
   - **Agent bundle** (`rbw-otf-agent-<job8>.tar.gz`): the app with the bug, plus a symptom-level incident. It holds no checks, no fix and no spec.
   - **Grader bundle** (`rbw-otf-grader-<job8>.tar.gz`): the added checks, the answer key, the reference fix, the accepted card, and the expected cells. It warns that the checks are model-written code.
   - **Optional validation:** re-runs the six cells on the RBW builder from the stored bundles.
6. **Honest failure path.** The UI shows the outcome, each lane's last round result and feedback, the total model spend, and the catalog card. The card reads "Start the closest catalog bug", or "Your catalog bug is ready" when one already ran.

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

**Errors.** Every error is an `OtfErrorBody`. A response body that fails its own schema is answered `unavailable` instead, so no member outside the contract can leave a route.

### 2.1 Server checks on create

In this order:

1. Validate the body (`validateOtf("OtfCreateJob", …)`). A failure answers `invalid_spec`.
2. Run the existing safety checks:
   - `securityTopic` on the sentence;
   - `designSecurityTopic` and `holdsCode` on every spec field, because the customer may edit the card.
   - Any hit answers `refused_topic`.
3. Recompute `spec_sha256` with `specSha256`. A mismatch answers `invalid_spec`.
4. Check that the criterion is offered and the card is in scope. Otherwise answer `invalid_spec`.
5. Idempotency. The same `client_key` with the same `createSha256` replays the stored job (200). The same key with a different body answers `idempotency_conflict`.
6. Check the caps, in this order: `unavailable` (OTF disabled or unconfigured, operator hold, or the VM-hours day cap), `busy` (active plus queued jobs at the limit), `daily_cap`, `spend_cap`.
7. Insert the job:
   - `queued` when the builder is `running`;
   - `starting_builder` otherwise.
8. If the builder is not `running`, start the machine (section 4) under the power row lock, and append `builder_starting`. The answer does not wait for the machine.

**A stopped builder is never a refusal.** It is started, and the job waits.

### 2.2 Winner selection

1. A lane becomes a **candidate winner** when its qualification round returns `qualified`.
2. The builder runs **one confirmation round** on the same candidate bytes, while the other lanes keep running.
   - **Confirmation qualifies:** the lane has `won`. The other lanes are stopped and finish as `lost_race`.
   - **Confirmation fails:** the lane finishes `not_qualified` with the reason "did not repeat", and the race continues.
3. Ties go to the earliest `round_finished`, then to the lowest lane number.

### 2.3 Outcomes

| Outcome | When |
|---|---|
| `delivered` | A confirmed winner's bundles and certificate were stored |
| `not_qualified` | Every lane used its 3 rounds |
| `time_limit` | The job reached its deadline (45 min from claim) |
| `spend_limit` | A lane or job spend cap was reached |
| `cancelled` | The customer stopped it |
| `builder_start_failed` | The machine did not start (`capacity`, `api_error`), or no claim came within `START_TIMEOUT_MS` (8 min, `timeout`). The UI path is the catalog fallback. |
| `builder_unavailable` | OTF was disabled or put on hold while the job waited |
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
- Validations are handed out first, then the oldest queued build, while fewer than `max_active` jobs are building.
- A build claim sets `building`, appends `job_claimed`, sets `deadline_at = claim + 45 min`, and sets `lease_until = now + LEASE_MS` (90 s).

**Events.**
- Posted at least every `HEARTBEAT_MS` (15 s). An empty list is the heartbeat, and every post extends the lease.
- `builder_seq` is the builder's own gap-free counter per job, starting at 1.
- Production assigns the public `seq` on insert. Production's own events (`job_queued`, `builder_starting`, `builder_ready`, `builder_start_failed`, `job_claimed`, `job_finished`) share that one ordered stream.
- A repeated `builder_seq` is ignored when its canonical bytes (`builderEventBytes`) equal the stored ones. It is refused with `event_conflict` when they differ, and so is a gap.
- The builder may post only `BUILDER_EVENT_TYPES`.
- The reply's `control.stop` carries a customer stop, the deadline or the spend cap.

**Result.**
- `delivered` requires the certificate and exactly one of each part (agent, grader, certificate). Any other outcome carries neither.
- Production checks:
  - the gzip magic of the tarballs;
  - that each part is at most `PART_MAX_BYTES` (2 MB);
  - the sha256 and size of the decoded bytes;
  - `SAFE_FILENAME`;
  - that `certificate.bundles` equals the part hashes;
  - that the job's `spec_sha256` equals the certificate's.
- It then stores the parts, sets `certificate.received`, and appends `job_finished`, all in one transaction. The transaction first checks, under the job's row lock, that the job is still `building` and claimed by this builder. A job that a status read has already finished (for example as `time_limit` or `builder_lost`) is answered `job_finished`, and nothing is stored.
- It is idempotent on `(job_id, part sha256s)`.

**Stop intent.** See section 4.

### 3.3 Storage

- **The store port.** Storage is one Postgres schema, `otf`, behind the `OtfStore` port in `contract.ts`.
  - W1 implements the port on Postgres. W2 consumes it, and its tests use an in-memory fake.
  - The two branches meet only through this port.
- **What the port provides:**
  - an idempotent create on `client_key`;
  - compare-and-set job and validation updates;
  - production and builder event appends with gap-free seq and the byte-identical duplicate rule;
  - an atomic claim with a lease;
  - a delivery stored in one transaction;
  - the builder heartbeat;
  - the single power row, under a lock, with a power log.
- **What it never touches:** the spend ledger tables and the factory slot.

## 4. On-demand builder lifecycle

The builder machine is **stopped when idle** and started per request.

**Power from production.**
- Production holds a power-only cloud service-account key for this one machine, in `RBW_NEBIUS_SA_ID`, `RBW_NEBIUS_SA_KEY_ID` and `RBW_NEBIUS_SA_PRIVATE_KEY`. The instance is named by `RBW_NEBIUS_VM_ID`.
- The key can view, start and stop this instance only. It cannot resize it, so there is no smaller fallback size: a capacity failure goes straight to the catalog fallback.
- Production reaches the cloud API through the `VmPower` port. The W2 implementation uses the Nebius JS SDK, the one approved new dependency.

**Builder state** (`BuilderState`, in availability and status):
- It combines the instance state with the builder heartbeat.
- `running` means the heartbeat is fresh (within `BUILDER_FRESH_MS`, 60 s), not just that the instance is up.
- The other states are `starting`, `stopped`, `stopping` and `unknown`.

**Start.**
- A session-checked create starts the machine when the builder is not `running`. Availability and status reads never start it.
- Starting twice is harmless: an instance that is already running or starting is a no-op.
- The job sits in `starting_builder` until the next healthy claim (section 3.2).
- With no claim within 8 min, the job finishes `builder_start_failed` (`timeout`). A start error finishes it with `capacity` or `api_error`.
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

## 5. Caps (defaults, `OTF_DEFAULTS`)

| Cap | Default | Enforced by |
|---|---|---|
| Lanes per job | 3 | job |
| Rounds per lane | 3 | builder harness |
| Per-lane model spend | $3.00 | builder proxy |
| Per-job model spend | $8.00 | builder (stops the job with `spend_limit`) |
| Builder-wide model total | set by the operator | builder proxy |
| Active build jobs | 2 | production (claim) |
| Queued jobs | 4 | production (`busy`) |
| Jobs per UTC day | 30 | production (`daily_cap`) |
| Total OTF model spend | set by the operator | production (`spend_cap`) |
| Job deadline | 45 min from claim | builder (kills lanes) and production (finishes on read) |
| Idle before self-stop | 10 min | builder |
| Max continuous uptime | 3 h | builder timer and production watchdog |
| Machine hours per UTC day | 12 h | production (`unavailable` until 00:00Z) |

Meter spend counts cached input at the full input rate, so it is an upper bound.

## 6. Honesty copy rules

**The rule:** nothing is called live per-request generation unless this job ran it.

| State | Copy |
|---|---|
| Job running or delivered | "Built for your request by Goose with {model} on Nebius Token Factory. Spec card by Nemotron 3 Super." |
| Certificate | "Qualified by the RBW harness on the RBW builder (Nebius VM): six cells, pinned task-report kit image, 4 vCPU / 8 GB per copy, then confirmed in a second round." Never "on Vercel Sandbox", and never "verified by the factory worker". |
| Catalog bug | Today's wording, unchanged: "pre-qualified catalog bug, re-verified for your request". |
| Time estimate | "Usually 5–35 minutes (measured on 13 sample specs, Oct 29). Your bug may take longer or not qualify." |
| Cold start (only when `typical.cold_start_min` is set) | "Starting the Nebius machine usually takes about N minutes." |
| Spend | "Model spend so far: $X (metered by the builder; an upper bound)." Shown apart from the Sandbox budget line. |
| OTF unavailable (`enabled: false`) | "Custom builds are offline right now. The catalog is available." No queueing illusion. |
| Validation | "Re-runs the six cells on the RBW builder." |
| Not qualified | "No lane produced a bug that passed all six cells in 3 rounds." |

- Infrastructure errors (`error`, `builder_start_failed`, `builder_lost`, `builder_unavailable`) are worded as errors, never as "the models could not build it".
- **Copy that becomes conditional:**
  - the designer's "Building this exact design is the next step" note is true only where OTF is enabled;
  - "One runs at a time" now applies to catalog requests only;
  - "A request itself makes no model call" is scoped to catalog requests;
  - the catalog novelty caveat does not apply to OTF bugs.
- **Never claim:**
  - novelty of an OTF bug;
  - on-the-fly creation on a host other than the task-report service;
  - that a person checked the generated checks;
  - that custom builds are always available.

## 7. Branches and ownership

**Rules for every branch:**
- Base on current `main`.
- Touch only the files your row owns.
- Never touch the factory paths: `tools/controller`, `packages/factory*`, `packages/envelope`, `packages/host-*`, `tools/case-*`.
- No new npm dependency, except the one approved for W2.
- Do not remove or rename existing tests. Raise the `packages/web` floor in `scripts/checks/test-floors.json` by the number of tests you add.
- Keep existing UI labels byte-identical.

| Branch | Owns (only these files) | Depends on |
|---|---|---|
| **W0 `otf/contract`** | `packages/web/src/otf/{contract,schemas,canonical}.ts`, `test/otf/contract.test.ts`, `docs/otf/SPEC.md` | — |
| **W1 `otf/server-store`** | `packages/web/otf-migrations/0001_otf.sql`, `src/otf/store.ts` (`OtfStore` on Postgres), `src/otf/builder-auth.ts`, `src/otf/builder-handlers.ts`, `app/api/factory/otf/builder/**/route.ts`, the OTF section of `src/config.ts` (the only branch that edits `config.ts`), `test/otf/{store,builder-auth,builder-routes}.test.ts` | W0 |
| **W2 `otf/server-customer`** | `src/otf/handlers.ts` (create with queue and start-on-create, status projection, stop, artifacts, validations, availability, caps, finish on read), `src/otf/projection.ts`, `app/api/factory/otf/{availability,jobs}/**/route.ts`, `test/otf/{customer-routes,projection}.test.ts` | W0. It codes against `OtfStore` and `VmPower` with in-memory fakes, and calls W5's lifecycle module through its exported functions. |
| **W3 `otf/ui`** | `src/otf/client.ts` (its own localStorage key `rbw.otf.job` and its own lock name), `src/components/otf/*.tsx` (behavior picker, spec accept, lane board, lane card, six-cell grid, certificate, failure, catalog offer; each a pure view plus a stateful wrapper), the insertion points in `src/components/factory-workspace.tsx` and `src/components/bug-designer.tsx`, the copy changes of section 6, `test/otf/*.test.tsx` | W0 |
| **W4 `otf/test-mode`** | `src/otf/test-mode/{fake-builder,timeline}.ts` (scripted **synthetic** lanes with invented check names and cells), `test/otf-browser.mjs` (Playwright, outside vitest), `test/otf/test-mode.test.ts` | W0, and W2's handler signatures through the contract |
| **W5 `otf/vm-power`** | `src/otf/power/nebius.ts` (`VmPower` over `@nebius/js-sdk`: get, start and stop of the one configured instance; nothing else exported), `src/otf/power/lifecycle.ts` (the section 4 state machine, watchdog rules, the VM-hours day cap and the operator hold), `app/api/factory/otf/cron/power/route.ts`, the cron entry in `vercel.json`, `packages/web/package.json` and `pnpm-lock.yaml` (the SDK only, pinned), `next.config.ts` (only if the SDK must be listed as a server external package), `test/otf/{lifecycle,power-nebius}.test.ts` | W0. Its first task is proving that the SDK loads in a Vercel function with a read-only `get()`. |

**Coordination.**
- Only W1 edits `config.ts`. Only W3 edits existing components and page copy.
- Route directories are disjoint.
- If an interface must change, it changes in W0 first.

**Merge order:** W0, then W1, W2, W4 and W5 (in any order), then W3. Only W5 edits `package.json`, `pnpm-lock.yaml`, `next.config.ts` and `vercel.json`. Integration follows on a preview deployment, with the builder pointed at that preview.
