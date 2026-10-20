import type { SqlClient } from "./client.ts";

/** What a factory start lock serializes: the starts of one request ID, or of one validation ID. */
export type FactoryLockScope = "request" | "validation";

// The first key of each advisory lock. The database functions take spend_reserve, spend_budget,
// spend_budget_root, factory_request and factory_validation inside their own transactions, and
// migrate takes spend_migrate. A start lock must not share any of them: a record call on another
// connection would then wait for the caller's own lock, which is released only after that call
// returns.
const NAMESPACES: Readonly<Record<FactoryLockScope, string>> = {
  request: "factory_request_start",
  validation: "factory_validation_start",
};

/**
 * Runs `fn` while holding a lock on one request ID or validation ID, so concurrent starts with
 * that ID run one at a time (contract sections 7 and 11). Another holder of the same scope and ID
 * waits until `fn` settles; other IDs and the other scope do not wait.
 *
 * `lockClient` must be a connection of its own that `fn` does not use: the lock is a
 * transaction-scoped advisory lock in an otherwise empty transaction on it, which holds over a
 * transaction-mode pooler too. `fn` makes its record calls through another client, so each of
 * them commits on its own. The lock ends when `fn` settles, or earlier if the lock connection is
 * lost; ending it then fails, and this call throws after `fn` settles.
 */
export async function withFactoryLock<T>(
  lockClient: SqlClient,
  scope: FactoryLockScope,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  // The transaction writes nothing; COMMIT ends it and the lock (after a failed statement, as a rollback).
  await lockClient.query("BEGIN");
  let result: T;
  try {
    await lockClient.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [NAMESPACES[scope], id]);
    result = await fn();
  } catch (error) {
    await end(lockClient, error);
    throw error;
  }
  await lockClient.query("COMMIT");
  return result;
}

// Ends the lock's transaction after `cause`; if that fails too, both errors are thrown together.
async function end(lockClient: SqlClient, cause: unknown): Promise<void> {
  try {
    await lockClient.query("COMMIT");
  } catch (error) {
    throw new AggregateError([cause, error], "the factory lock's transaction could not be ended", { cause: error });
  }
}
