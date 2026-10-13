import { describe, expect, it } from "vitest";
import {
  classifyConcurrent,
  classifyReuse,
  fireConcurrent,
  fireSequential,
  overlapOf,
  type AttemptTiming,
  type RaceGrading,
  type RecordAttempt,
  type RequestContext,
  type RequestOutcome,
  type RequestPlan,
  type ReuseGrading,
  type Verdict,
} from "../src/index.ts";

// These exercise the host-agnostic concurrency-check template on a synthetic "claim" resource
// that has nothing to do with Umami: a correct build lets exactly one of two concurrent claims
// apply, and a planted build lets both. No RC-1 type is used here; the RC-1 fixture is only one
// caller of this library.

/** A clock that advances one unit per read, so recorded times are distinct and ordered. */
function steppingClock(): () => number {
  let now = 0;
  return () => {
    now += 1;
    return now;
  };
}

interface ClaimState {
  token: number;
}

interface ClaimFailure {
  ok: false;
  failure_code: string;
  reason: string;
}

interface ClaimRecord {
  sent_ms: number;
  settled_ms: number;
  status: number | null;
  applied: boolean;
  failure: string | null;
}

const record: RecordAttempt<ClaimState, ClaimRecord> = (outcome: RequestOutcome, timing: AttemptTiming): ClaimRecord => {
  if (outcome.settled) {
    return { sent_ms: timing.sent_ms, settled_ms: timing.settled_ms, status: outcome.result.status, applied: outcome.result.status === 200, failure: null };
  }
  return { sent_ms: timing.sent_ms, settled_ms: timing.settled_ms, status: null, applied: false, failure: (outcome.error as Error).message };
};

/** A stand-in resource: a single claim, optionally guarded (correct) or unguarded (planted). */
class ClaimApp {
  readonly calls: string[] = [];
  private claimed = false;
  private pending: (() => void) | null = null;
  private readonly guarded: boolean;
  private readonly pairReads: boolean;

  constructor(guarded: boolean, pairReads: boolean) {
    this.guarded = guarded;
    this.pairReads = pairReads;
  }

  context(): RequestContext {
    return {
      fetch: (path: string) => this.handle(path),
    };
  }

  private reply(status: number): Promise<{ status: () => number; body: () => Promise<Buffer> }> {
    return Promise.resolve({ status: () => status, body: () => Promise.resolve(Buffer.from("{}")) });
  }

  private async handle(path: string): Promise<{ status: () => number; body: () => Promise<Buffer> }> {
    this.calls.push(path);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (path !== "/claim") {
      return this.reply(404);
    }
    if (this.pairReads) {
      await this.pairRead();
    }
    const applies = this.guarded ? !this.claimed : true;
    this.claimed = true;
    return this.reply(applies ? 200 : 409);
  }

  private pairRead(): Promise<void> {
    const waiting = this.pending;
    if (waiting !== null) {
      this.pending = null;
      waiting();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }
}

const setupLog: number[] = [];

function plan(failAt?: number): RequestPlan<ClaimState, ClaimRecord, ClaimFailure> {
  return {
    setup: (_context, index) => {
      setupLog.push(index);
      return Promise.resolve(index === failAt ? { ok: false, failure_code: "setup_broke", reason: `context ${String(index)}` } : { ok: true, state: { token: index } });
    },
    request: (state) => ({ method: "POST", path: "/claim", headers: {}, body: JSON.stringify({ token: state.token }) }),
    record,
  };
}

const recVerdict = (attempt: ClaimRecord): Verdict => (attempt.applied ? "applied" : attempt.status === 409 ? "rejected" : "unexpected");

function raceGrading(cleanApplied: number, plantedApplied: number, overrides: Partial<RaceGrading<ClaimRecord, string, string>> = {}): RaceGrading<ClaimRecord, string, string> {
  return {
    verdictOf: recVerdict,
    cleanApplied,
    plantedApplied,
    planted: { observed: "assertion_fail", failure_code: "double_applied" },
    clean: { observed: "pass", failure_code: null },
    unrelated: { observed: "setup_fail", failure_code: "unrelated" },
    seedFailed: { observed: "setup_fail", failure_code: "seed" },
    detail: (attempts, overlapMs) => `n=${String(attempts.length)} overlap=${String(overlapMs)}`,
    ...overrides,
  };
}

function rec(status: number | null, applied: boolean, failure: string | null = null): ClaimRecord {
  return { sent_ms: 0, settled_ms: 1, status, applied, failure };
}
const didApply = (): ClaimRecord => rec(200, true);
const refused = (): ClaimRecord => rec(409, false);
const strange = (): ClaimRecord => rec(500, false);

describe("overlapOf", () => {
  it("is the earliest settle minus the latest send over all timings", () => {
    expect(overlapOf([{ sent_ms: 0, settled_ms: 40 }, { sent_ms: 2, settled_ms: 55 }])).toBe(38);
    expect(overlapOf([{ sent_ms: 0, settled_ms: 10 }, { sent_ms: 2, settled_ms: 30 }, { sent_ms: 1, settled_ms: 9 }])).toBe(7);
  });

  it("is zero or less when one request settled before the latest was sent, and zero for no timings", () => {
    expect(overlapOf([{ sent_ms: 0, settled_ms: 10 }, { sent_ms: 10, settled_ms: 30 }])).toBe(0);
    expect(overlapOf([{ sent_ms: 0, settled_ms: 10 }, { sent_ms: 15, settled_ms: 30 }])).toBe(-5);
    expect(overlapOf([])).toBe(0);
  });
});

describe("fireConcurrent", () => {
  it("sets each context up in order, then fires the requests together on one origin", async () => {
    setupLog.length = 0;
    const app = new ClaimApp(false, true);
    const burst = await fireConcurrent([app.context(), app.context()], plan(), steppingClock());
    if (!burst.ok) throw new Error(burst.failure.reason);
    expect(setupLog).toEqual([0, 1]);
    expect(app.calls).toEqual(["/claim", "/claim"]);
    const [a, b] = burst.attempts;
    if (a === undefined || b === undefined) throw new Error("two attempts");
    expect(Math.max(a.sent_ms, b.sent_ms)).toBeLessThan(Math.min(a.settled_ms, b.settled_ms));
    expect(burst.overlap_ms).toBeGreaterThan(0);
  });

  it("applies both concurrent claims on a planted resource and one on a guarded resource", async () => {
    const plantedApp = new ClaimApp(false, true);
    const plantedBurst = await fireConcurrent([plantedApp.context(), plantedApp.context()], plan(), steppingClock());
    if (!plantedBurst.ok) throw new Error(plantedBurst.failure.reason);
    expect(plantedBurst.attempts.map((a) => a.applied)).toEqual([true, true]);
    expect(classifyConcurrent(plantedBurst.attempts, plantedBurst.overlap_ms, raceGrading(1, 2))).toMatchObject({ observed: "assertion_fail", failure_code: "double_applied" });

    const cleanApp = new ClaimApp(true, true);
    const cleanBurst = await fireConcurrent([cleanApp.context(), cleanApp.context()], plan(), steppingClock());
    if (!cleanBurst.ok) throw new Error(cleanBurst.failure.reason);
    expect(cleanBurst.attempts.filter((a) => a.applied)).toHaveLength(1);
    expect(classifyConcurrent(cleanBurst.attempts, cleanBurst.overlap_ms, raceGrading(1, 2))).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("returns the first setup failure and fires no request", async () => {
    setupLog.length = 0;
    const app = new ClaimApp(false, true);
    const result = await fireConcurrent([app.context(), app.context()], plan(1), steppingClock());
    expect(result).toEqual({ ok: false, failure: { ok: false, failure_code: "setup_broke", reason: "context 1" }, attempts: [] });
    expect(app.calls).toEqual([]);
    expect(setupLog).toEqual([0, 1]);
  });
});

/** A context whose every send rejects, as a reset connection does. */
function rejecting(): RequestContext {
  return { fetch: () => Promise.reject(new Error("reset by peer")) };
}

describe("fireConcurrent when a request throws", () => {
  it("keeps both records: the thrown one unsettled with its error, the other as answered", async () => {
    const app = new ClaimApp(true, false);
    const burst = await fireConcurrent([app.context(), rejecting()], plan(), steppingClock());
    if (!burst.ok) throw new Error(burst.failure.reason);
    expect(burst.attempts).toHaveLength(2);
    expect(burst.attempts[0]).toMatchObject({ status: 200, applied: true, failure: null });
    expect(burst.attempts[1]).toMatchObject({ status: null, applied: false, failure: "reset by peer" });
    expect(classifyConcurrent(burst.attempts, burst.overlap_ms, raceGrading(1, 2))).toMatchObject({ observed: "setup_fail", failure_code: "unrelated" });
  });
});

describe("fireSequential", () => {
  it("records a thrown first request and fires no follow-up when repeatAfter refuses it", async () => {
    const sequence = await fireSequential(rejecting(), plan(), (first) => first.applied, steppingClock());
    if (!sequence.ok) throw new Error(sequence.failure.reason);
    expect(sequence.attempts).toEqual([{ sent_ms: 1, settled_ms: 2, status: null, applied: false, failure: "reset by peer" }]);
    expect(classifyReuse(sequence.attempts, reuseGrading())).toMatchObject({ failure_code: "unrelated", detail: "first transport: reset by peer" });
  });

  it("records a thrown follow-up after an applied first request", async () => {
    const app = new ClaimApp(true, false);
    const appContext = app.context();
    let sends = 0;
    const context: RequestContext = {
      fetch: (path, options) => {
        sends += 1;
        return sends === 2 ? Promise.reject(new Error("reset by peer")) : appContext.fetch(path, options);
      },
    };
    const sequence = await fireSequential(context, plan(), (first) => first.applied, steppingClock());
    if (!sequence.ok) throw new Error(sequence.failure.reason);
    expect(sequence.attempts).toHaveLength(2);
    expect(sequence.attempts[0]).toMatchObject({ status: 200, applied: true });
    expect(sequence.attempts[1]).toMatchObject({ status: null, applied: false, failure: "reset by peer" });
  });

  it("fires a follow-up on the same origin only when repeatAfter says so", async () => {
    const app = new ClaimApp(true, false);
    const sequence = await fireSequential(app.context(), plan(), (first) => first.applied, steppingClock());
    if (!sequence.ok) throw new Error(sequence.failure.reason);
    expect(app.calls).toEqual(["/claim", "/claim"]);
    const [first, second] = sequence.attempts;
    if (first === undefined || second === undefined) throw new Error("two attempts");
    expect(first.applied).toBe(true);
    expect(second.status).toBe(409);
    expect(second.sent_ms).toBeGreaterThan(first.settled_ms);
    expect(classifyReuse(sequence.attempts, reuseGrading())).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("fires only once when repeatAfter is false", async () => {
    const app = new ClaimApp(true, false);
    const sequence = await fireSequential(app.context(), plan(), () => false, steppingClock());
    if (!sequence.ok) throw new Error(sequence.failure.reason);
    expect(sequence.attempts).toHaveLength(1);
    expect(app.calls).toEqual(["/claim"]);
  });

  it("returns a setup failure with no attempts before firing", async () => {
    const app = new ClaimApp(true, false);
    const result = await fireSequential(app.context(), plan(0), () => true, steppingClock());
    expect(result).toEqual({ ok: false, failure: { ok: false, failure_code: "setup_broke", reason: "context 0" }, attempts: [] });
    expect(app.calls).toEqual([]);
  });

  it("keeps the first attempt when the follow-up setup fails", async () => {
    const app = new ClaimApp(true, false);
    const result = await fireSequential(app.context(), plan(1), (first) => first.applied, steppingClock());
    if (result.ok) throw new Error("expected a setup failure");
    expect(result.failure).toEqual({ ok: false, failure_code: "setup_broke", reason: "context 1" });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ status: 200, applied: true });
    expect(app.calls).toEqual(["/claim"]);
  });
});

describe("classifyConcurrent", () => {
  it("grades by how many requests applied against the clean and planted counts", () => {
    expect(classifyConcurrent([didApply(), didApply()], 5, raceGrading(1, 2))).toMatchObject({ observed: "assertion_fail", failure_code: "double_applied" });
    expect(classifyConcurrent([didApply(), refused()], 5, raceGrading(1, 2))).toMatchObject({ observed: "pass", failure_code: null });
    expect(classifyConcurrent([refused(), refused()], 5, raceGrading(1, 2))).toMatchObject({ observed: "setup_fail", failure_code: "seed" });
  });

  it("is unrelated when a request is unexpected or the requests did not overlap", () => {
    expect(classifyConcurrent([didApply(), strange()], 5, raceGrading(1, 2))).toMatchObject({ observed: "setup_fail", failure_code: "unrelated" });
    expect(classifyConcurrent([didApply(), didApply()], 0, raceGrading(1, 2)).detail).toContain("the requests did not overlap");
  });

  it("generalizes past two requests: any count above clean, up to planted, is planted", () => {
    expect(classifyConcurrent([didApply(), didApply(), didApply()], 5, raceGrading(1, 3))).toMatchObject({ failure_code: "double_applied" });
    expect(classifyConcurrent([didApply(), refused(), refused()], 5, raceGrading(1, 3))).toMatchObject({ observed: "pass" });
    expect(classifyConcurrent([didApply(), didApply(), refused()], 5, raceGrading(1, 3))).toMatchObject({ observed: "assertion_fail", failure_code: "double_applied" });
  });

  it("is unrelated when more requests applied than the planted count allows", () => {
    expect(classifyConcurrent([didApply(), didApply(), didApply()], 5, raceGrading(1, 2))).toMatchObject({ observed: "setup_fail", failure_code: "unrelated" });
  });

  it("never grades planted when the planted count equals the clean count", () => {
    expect(classifyConcurrent([didApply(), refused()], 5, raceGrading(1, 1))).toMatchObject({ observed: "pass", failure_code: null });
    expect(classifyConcurrent([didApply(), didApply()], 5, raceGrading(1, 1))).toMatchObject({ observed: "setup_fail", failure_code: "unrelated" });
  });

  it("uses custom no-overlap and seed-failed detail wrappers when given", () => {
    const grading = raceGrading(1, 2, { noOverlapDetail: (detail) => `no race; ${detail}`, seedFailedDetail: (detail) => `none applied; ${detail}` });
    expect(classifyConcurrent([didApply(), didApply()], -1, grading).detail).toBe("no race; n=2 overlap=-1");
    expect(classifyConcurrent([refused(), refused()], 5, grading).detail).toBe("none applied; n=2 overlap=5");
  });
});

function reuseGrading(overrides: Partial<ReuseGrading<ClaimRecord, string, string>> = {}): ReuseGrading<ClaimRecord, string, string> {
  return {
    verdictOf: recVerdict,
    transportFailed: (attempt) => attempt.failure !== null,
    pass: { observed: "pass", failure_code: null },
    reused: { observed: "assertion_fail", failure_code: "reapplied" },
    unrelated: { observed: "setup_fail", failure_code: "unrelated" },
    seedFailed: { observed: "setup_fail", failure_code: "seed" },
    noFirstDetail: "no request",
    firstTransportDetail: (first) => `first transport: ${String(first.failure)}`,
    firstNotAppliedDetail: (first) => `first not applied: ${String(first.status)}`,
    noSecondDetail: "no follow-up",
    pairDetail: (first, second) => `first ${String(first.status)}; second ${String(second.status)}`,
    ...overrides,
  };
}

describe("classifyReuse", () => {
  it("passes when the first applied and the follow-up was refused", () => {
    expect(classifyReuse([didApply(), refused()], reuseGrading())).toMatchObject({ observed: "pass", failure_code: null });
  });

  it("flags the follow-up being accepted a second time", () => {
    expect(classifyReuse([didApply(), didApply()], reuseGrading())).toMatchObject({ observed: "assertion_fail", failure_code: "reapplied" });
  });

  it("reports seed when the first did not apply", () => {
    expect(classifyReuse([refused()], reuseGrading())).toMatchObject({ observed: "setup_fail", failure_code: "seed" });
  });

  it("is unrelated for a missing first, a transport failure, a missing follow-up, or a strange follow-up", () => {
    expect(classifyReuse([], reuseGrading())).toMatchObject({ failure_code: "unrelated", detail: "no request" });
    expect(classifyReuse([rec(null, false, "boom")], reuseGrading())).toMatchObject({ failure_code: "unrelated", detail: "first transport: boom" });
    expect(classifyReuse([didApply()], reuseGrading())).toMatchObject({ failure_code: "unrelated", detail: "no follow-up" });
    expect(classifyReuse([didApply(), strange()], reuseGrading())).toMatchObject({ failure_code: "unrelated" });
  });
});
