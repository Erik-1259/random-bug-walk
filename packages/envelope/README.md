# @rbw/envelope

Versioned provider rates and conservative priced envelopes for `@rbw/spend`. This package makes no provider calls, holds no credentials and reads no environment variables. Only the integration test runner reads `DATABASE_URL`.

`rate-sheets/v1.json` contains the six dispatched prices for Vercel Sandbox in `iad1`, Nemotron 3.5 Lightning on Nebius Token Factory and Tavily. The source pages were checked on 2026-10-05 and matched all six prices. `account_confirmed` remains false: the rates must be confirmed against the actual account before any paid use. The package refuses a true value.

`loadRateSheet(path)` and `parseRateSheet(bytes)` return `{ sheet, rate_sheet_sha256 }`. Their strict schema refuses unknown fields, duplicate service/subject/unit triples, invalid units and invalid prices. Canonical JSON uses `canonicalize` with ASCII keys and safe integer tokens only; fractions and exponent notation are refused before parsing. Sorted keys, UTF-8 and no whitespace or trailing newline determine the SHA-256. `test/vector.json` pins both the canonical bytes and hash. Entry order and string contents remain significant. `priceFor(sheet, service, subject, unit)` returns a price or null.

`FIXED_LIMITS` is frozen, including its nested objects. Its canonical digest is `runtime_profile_sha256`. Each app copy has 4 vCPU, 8 GB and a 600-second deadline. The observation, admission and judge controllers each have 2 vCPU and 4 GB, with deadlines of 900, 9,000 and 2,100 seconds and 1, 13 and 3 app copies respectively. Full-resource billing includes a 60-second shutdown allowance for every resource, including the controller. Generation allows 12 model calls at 32,768 input and 8,192 output tokens each, plus 6 Tavily calls at 2 credits each.

The builders accept the loaded rates:

- `observeEnvelope(rates)`
- `admissionEnvelope(rates, { includeGeneration })`
- `judgeEnvelope(rates)`
- `modelCallEnvelope(rates)`
- `tavilyCallEnvelope(rates)`

Each successful result has one line per service/unit pair, with summed limits and the required enforcement method. Compute uses `provider_timeout`; creations and input tokens use `client_counter`; output tokens and Tavily credits use `request_parameter`. Admission includes generation only when requested. Use `includeGeneration: false` when model and search calls were already reserved individually, to avoid reserving the same calls twice.

`components` holds exact rational micro-USD subtotals for compute, shutdown allowance and creations, plus model and Tavily when included. Single-call builders expose their model or Tavily component. Every fraction has bigint `numerator` and `denominator` in lowest terms and `decimal_usd` when its USD decimal terminates.

`exact_microusd` sums the components. `bound_microusd` rounds that exact total up once. `reserved_microusd` sums each line's rounded-up price, matching the database reservation. It can exceed the bound by at most the number of lines minus one. Arithmetic uses bigint integers and fractions; totals are derived from the sheet and limits.

| Envelope | Exact USD | Bound micro-USD | Reserved micro-USD |
| --- | --- | --- | --- |
| Observation | 0.2158412 | 215842 | 215843 |
| Admission without generation | 2.4821684 | 2482169 | 2482170 |
| Admission with generation | 2.62535432 | 2625355 | 2625356 |
| Judge | 0.5793624 | 579363 | 579363 |
| Model call | 0.00393216 | 3933 | 3934 |
| Tavily call | 0.016 | 16000 | 16000 |

The admission subtotal before Tavily is exactly 2.52935432 USD, with bound 2529355 micro-USD. Tavily adds exactly 0.096 USD. The tests pin these figures and the component subtotals.

A missing price returns `unknown_price` with every missing triple and no lines. If the reserved total exceeds the operation ceiling (observation 1000000, admission 8000000, judge 2000000 micro-USD), the builder returns `ceiling_exceeded`. Single-call envelopes have null ceilings. Candidate generation's profile ceiling is 8000000 micro-USD; generation is included in the admission ceiling when requested.

`toReserveRequest(envelope, identity)` throws for a refused envelope or invalid identity. Every identity field is required, nullable fields require explicit null, unknown fields are refused, and format/attempt checks match the spend contract. Hashes, UUIDs, `attempt_ordinal`, `kind` (an `OperationKind`) and `call_name` (a `CallName`) are checked with the validators of `@rbw/schema`, with the ledger's length limits of 64 and 128 characters for `kind` and `call_name`. It takes the line array and both digests from the successful envelope; callers supply operation IDs and payload hashes.

Unit tests run with `pnpm --filter @rbw/envelope run test`, including PGlite migrations and real spend functions. `pnpm --filter @rbw/envelope run test:integration` skips with a message naming `DATABASE_URL` when unset. When set, it applies migrations to a fresh randomly named schema, runs I1 observe reservation and I2 insufficient-pool refusal, and drops the schema even on failure. Driver errors expose only the variable name and a driver error code.

Dependencies are pinned: `canonicalize` 5.1.0 (Apache-2.0), `zod` 4.6.5 (MIT), `pg` 8.23.1 (MIT), `@types/pg` 8.23.1 (MIT) and `@electric-sql/pglite` 0.5.8 (Apache-2.0), plus the workspace `@rbw/spend` package (MIT). The npm latest stable versions of canonicalize and zod matched the dispatch when checked. Native crypto and bigint provide hashing and arithmetic. New code is needed because spend supplies reservation enforcement, while no existing package supplies these fixed resource profiles, rate-sheet validation or component fractions.

PUB-01: this implementation uses the accessible dispatch and public price pages. PUB-02: publication remains the checked host helper's responsibility. Pricing publication, hosting, storage, workflow steps and database traffic is planned for a later sheet version; this package does not reserve against a long-lived database.
