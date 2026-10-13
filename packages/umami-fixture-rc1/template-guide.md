# Defining a race candidate's checks with the concurrency template

`src/template/` is a host-agnostic library for race-class fixtures. It owns the parts that are the
same for every concurrency candidate — setting each request context up in order, firing the
requests together on a single origin, timing each one harness-side, measuring how long they
overlapped in flight, and running the grading decision tree — so a new candidate's checks become
mostly configuration. The RC-1 backup-code fixture is one caller of it (`src/race.ts`,
`src/classify.ts`); a new candidate supplies the same four kinds of configuration.

The library lives inside this package rather than in a separate one on purpose: the driver stages
only this package's own files into the kit's fixture slot, with just `@playwright/test` and `pg`
installed, so a check can import the template through `src/index.ts` but could not resolve a
cross-package dependency at run time.

## What you describe

The template takes a description with four parts:

1. **The setup requests** — how to prepare one request context before the burst, for example a
   sign-in that yields a token. This is a `RequestPlan.setup(context, index)` that returns either
   `{ ok: true, state }` or your own failure object (any object with `ok: false`; the engine only
   reads `ok` and hands it back unchanged, so you keep your own failure codes).
2. **The concurrent requests** — `RequestPlan.request(state)` returns the one request to fire for a
   context, built from that context's setup state.
3. **How to record an answer** — `RequestPlan.record(outcome, timing, state)` turns a settled
   response or a thrown error, plus the harness timing, into your own attempt record. Redact any
   secret here; the template never looks inside the record.
4. **The expected clean and planted outcomes** — a `RaceGrading` (for a concurrent burst) or a
   `ReuseGrading` (for a sequential control) that says how to read one attempt's verdict and what
   the clean and planted apps each produce.

## Firing

- `fireConcurrent(contexts, plan, now)` sets each context up in order; if any setup fails it
  returns that failure and fires nothing. Otherwise it takes one origin from `now()`, fires one
  request per context with `Promise.all`, times each from the origin, and returns the records and
  the burst's `overlap_ms` (`overlapOf` = earliest settle minus latest send, rounded; `<= 0` means
  no overlap). Give each context its own connection pool so the client does not serialize them.
- `fireSequential(context, plan, repeatAfter, now)` fires one request, and only when
  `repeatAfter(firstAttempt)` is true sets the same context up again and fires a second request on
  the same origin. Use it for a control that repeats an operation to confirm the app refuses the
  repeat.
- `now` is any monotonic millisecond clock. The checks pass `performance.now`; the tests pass a
  stepping clock so recorded times are deterministic.

## Grading

- `classifyConcurrent(attempts, overlapMs, grading)` returns `{ observed, failure_code, detail }`:
  1. any attempt whose verdict is `unexpected` → `unrelated` (the round proves nothing);
  2. `overlapMs <= 0` → `unrelated` (the race was not exercised);
  3. applied count above `cleanApplied` and at most `plantedApplied` → `planted`;
  4. applied count equals `cleanApplied` → `clean`;
  5. nothing applied → `seedFailed`;
  6. any other count (more than `plantedApplied`) → `unrelated`.

  `verdictOf(attempt)` returns `"applied"` (the shared operation took effect), `"rejected"` (the
  app correctly refused), or `"unexpected"` (a transport failure or an answer you did not expect).
  `cleanApplied`/`plantedApplied` are counts, so this works for more than two concurrent requests.
  A planted race need not let every request through: with three requests and counts 1 and 3, a
  round where two apply is still graded `planted`. If the two counts are equal, nothing grades
  as `planted`.
  A request whose send throws is still recorded (as unsettled, through your `record`), so the
  other requests' records are kept; have `verdictOf` call it `unexpected`.
  `detail(attempts, overlapMs)` builds the message; `noOverlapDetail` and `seedFailedDetail`
  optionally wrap it for those two cases.

- `classifyReuse(attempts, grading)` grades a sequential control: the first attempt must apply
  (otherwise `seedFailed`), and the follow-up must be refused (`pass`); a follow-up that applies
  again is `reused`, and anything else is `unrelated`. You supply `transportFailed(attempt)` and
  the detail strings for each branch.

## A checklist for a new candidate

1. Decide the attempt record your `record` produces and what counts as `applied`, `rejected` and
   `unexpected`.
2. Write `setup`, `request` and `record` as a `RequestPlan`, redacting secrets in `record`.
3. Choose `cleanApplied` and `plantedApplied` (a lost-update double-apply is 1 and 2).
4. Wire the concurrent check through `fireConcurrent` + `classifyConcurrent`, and any control
   through `fireSequential` + `classifyReuse`.
5. Test the plan and grading against an in-memory stand-in that models the clean and planted
   behaviors, as `test/template.test.ts` does with a synthetic claim resource, so no live app is
   needed to prove the wiring.
