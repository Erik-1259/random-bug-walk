import pg from "pg";
export function sanitized(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "UNKNOWN";
  return new Error(`DATABASE_URL failed (driver error code ${code})`);
}
export async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { throw sanitized(error); }
}
export function createTestClient(url: string | undefined): pg.Client {
  try { return new pg.Client({ connectionString: url }); }
  catch (error) { throw sanitized(error); }
}
