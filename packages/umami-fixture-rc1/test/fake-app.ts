import type { Fixture, RequestContext, RequestOptions } from "../src/index.ts";

export type CodeVariant = "clean" | "planted";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  data: string | undefined;
}

function reply(status: number, body: unknown): Promise<{ status: () => number; body: () => Promise<Buffer> }> {
  const bytes = Buffer.from(JSON.stringify(body));
  return Promise.resolve({ status: () => status, body: () => Promise.resolve(bytes) });
}

/** Lets every other pending request run, as an awaited database round trip or bcrypt compare does. */
function yieldToOthers(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * An in-memory stand-in for the pinned app's sign-in and backup-code verify routes, following
 * src/app/api/2fa/verify/route.ts step by step: read the unused codes, await the compare, then
 * mark the matched code used. The clean variant guards the write with used: false and refuses a
 * zero-row update; the planted variant drops that guard, as the RC-1 mutation does.
 */
export class FakeApp {
  readonly calls: RecordedCall[] = [];
  private readonly used = new Set<string>();
  private partialTokens = 0;
  twoFactorEnabled = true;
  private readonly fixture: Fixture;
  private readonly variant: CodeVariant;

  constructor(fixture: Fixture, variant: CodeVariant) {
    this.fixture = fixture;
    this.variant = variant;
  }

  context(): RequestContext {
    return {
      fetch: (url: string, options: RequestOptions) => {
        this.calls.push({ url, method: options.method, headers: { ...options.headers }, data: options.data });
        return this.handle(url, options);
      },
    };
  }

  private async handle(url: string, options: RequestOptions): Promise<{ status: () => number; body: () => Promise<Buffer> }> {
    await yieldToOthers();
    if (url === "/api/auth/login") {
      if (!this.twoFactorEnabled) {
        return reply(200, { token: "synthetic-full-token", user: { id: this.fixture.two_factor.user_id } });
      }
      this.partialTokens += 1;
      return reply(200, { requiresTwoFactor: true, partialToken: `synthetic-partial-${String(this.partialTokens)}` });
    }
    if (url !== "/api/2fa/verify") {
      return reply(404, { error: { code: "not-found" } });
    }
    const input = (JSON.parse(options.data ?? "{}") as { backupCode: string }).backupCode.toUpperCase();
    const unused = this.fixture.two_factor.backup_codes.filter((code) => !this.used.has(code.id));
    await yieldToOthers();
    const match = unused.find((code) => code.plaintext === input);
    await yieldToOthers();
    if (match === undefined) {
      return reply(400, { error: { code: "two-factor-error-invalid-backup-code", message: "Invalid backup code", status: 400 } });
    }
    const count = this.variant === "planted" || !this.used.has(match.id) ? 1 : 0;
    this.used.add(match.id);
    if (count === 0) {
      return reply(400, { error: { code: "two-factor-error-invalid-backup-code", message: "Invalid backup code", status: 400 } });
    }
    return reply(200, { token: "synthetic-full-token", user: { id: this.fixture.two_factor.user_id } });
  }
}

/** A clock that advances one millisecond per read, so every recorded time is distinct and ordered. */
export function steppingClock(): () => number {
  let now = 0;
  return () => {
    now += 1;
    return now;
  };
}
