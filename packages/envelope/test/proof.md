# W1-12 local proof

The tests were committed before the implementation. `pnpm --filter @rbw/envelope run test` exited 1: `test/unit/envelope.test.ts` and `test/unit/database.test.ts` failed to import the absent `src/index.ts`; no individual tests executed. An additional identity-format test failed before its validation checks were added.

After implementation, the package unit command passes 36 tests, including PGlite migrations, reservations for observation, judge and admission without generation, and refusal of a null-price line with no operation inserted. The Vitest floor is 36 for `packages/envelope`.

`env -u DATABASE_URL pnpm --filter @rbw/envelope run test:integration` exits 0 and prints `test:integration skipped: DATABASE_URL is not set`. Live Postgres I1 and I2 are pending the host's throwaway branch.

The guard-removal proof replaces only `const bound_microusd = ceil(exact_microusd);` with `const bound_microusd = exact_microusd.numerator / exact_microusd.denominator;`. The patch is never committed. Running the package unit command with it applied exits 1. These three figure tests fail:

- `observe figure rounds up to 215842`: received `215841n`, expected `215842n`.
- `admission pre-Tavily figure rounds up to 2529355`: received `2529354n`, expected `2529355n`.
- `judge figure rounds up to 579363`: received `579362n`, expected `579363n`.

Other bounds and rounding-gap assertions also fail. `git apply -R` removes the patch, and the package unit command passes again.

The root commands `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` pass. Root tests include only unit tests. All root checks use the package through the existing workspace conventions.

## Split generation ceiling regression

The candidate-generation ceiling now checks the configured model calls and Tavily credits at the supplied rates before split reservations proceed. Per-call envelopes also carry that ceiling.

Before implementation, `pnpm --filter @rbw/envelope test` exited 1 with 5 failures and 35 passes: aggregate model and Tavily rate increases, oversized individual calls, and the previous null per-call ceiling. After adding the PGlite proof, restoring the original implementation temporarily made the same command exit 1 with 6 failures and 35 passes. The implementation was restored afterwards.

The PGlite proof runs the real spend migrations and reservation API. Inflated generation rates refuse before any operation is inserted; current rates reserve model, Tavily and split admission envelopes and insert three operations. The package test floor is 41. This proof uses no paid calls or network services.
