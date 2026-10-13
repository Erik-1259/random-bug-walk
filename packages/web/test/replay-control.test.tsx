import { afterEach, describe, expect, it, vi } from "vitest";

// There is no DOM here, so a minimal hook runtime stands in for React: it keeps state and
// effects by call order, runs an effect when its dependencies change, and renders again on a state change.
const hooks = vi.hoisted(() => {
  const state: unknown[] = [];
  const deps: (readonly unknown[] | undefined)[] = [];
  const cleanups: ((() => void) | undefined)[] = [];
  let pending: (() => void)[] = [];
  let index = 0;
  let component: (() => unknown) | null = null;
  const render = () => {
    index = 0;
    component?.();
    const effects = pending;
    pending = [];
    for (const effect of effects) effect();
  };
  return {
    useState: (initial: unknown) => {
      const i = index++;
      if (!(i in state)) state[i] = initial;
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (current: unknown) => unknown)(state[i]) : next;
        if (Object.is(value, state[i])) return;
        state[i] = value;
        queueMicrotask(render);
      };
      return [state[i], set];
    },
    useEffect: (effect: () => (() => void) | undefined, next: readonly unknown[]) => {
      const i = index++;
      const previous = deps[i];
      if (previous !== undefined && next.every((value, k) => Object.is(value, previous[k]))) return;
      deps[i] = next;
      pending.push(() => {
        cleanups[i]?.();
        cleanups[i] = effect();
      });
    },
    mount: (fn: () => unknown) => {
      // Each test mounts a fresh component.
      for (const cleanup of cleanups) cleanup?.();
      state.length = 0;
      deps.length = 0;
      cleanups.length = 0;
      component = fn;
      render();
    },
  };
});

vi.mock("react", () => ({ useState: hooks.useState, useEffect: hooks.useEffect }));

const { ReplayControl } = await import("../src/components/replay-control.tsx");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the replay control's status poll", () => {
  it("polls again 15 s after a status answer that is not JSON", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      localStorage: { getItem: () => "00000000-0000-4000-8000-00000000b101" },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer);
      },
    });
    const answers = [() => Promise.resolve({ state: "running" }), () => Promise.reject(new SyntaxError("synthetic: a 504 page")), () => Promise.resolve({ state: "running" })];
    let calls = 0;
    const fetchSpy = vi.fn(() => Promise.resolve({ json: answers[calls++] }));
    vi.stubGlobal("fetch", fetchSpy);
    hooks.mount(() => ReplayControl({ release: null, initial: { state: "running", reason: "" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

interface Element {
  type: unknown;
  props: {
    status?: unknown;
    state?: string;
    reason?: string;
    id?: string;
    style?: Record<string, unknown>;
    disabled?: boolean;
    onClick?: () => void;
    onSubmit?: (event: { preventDefault: () => void }) => void;
    onChange?: (event: { target: { value: string } }) => void;
    children?: unknown;
  };
}

function find(node: unknown, match: (element: Element) => boolean): Element | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found !== null) return found;
    }
    return null;
  }
  const element = node as Element;
  if (match(element)) return element;
  return find(element.props.children, match);
}

describe("the replay control's start", () => {
  it("drops the previous replay's status when a new start is refused, so the refusal shows", async () => {
    vi.useFakeTimers();
    const stored = new Map<string, string>([["rbw-judge-request-id", "00000000-0000-4000-8000-00000000b201"]]);
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        clearTimeout(timer);
      },
    });
    const finished = { state: "verified", release_id: "00000000-0000-4000-8000-000000000601", message: "Verified.", cells: [] };
    const busy = { state: "unavailable", reason: "busy", message: "Busy: another replay is running. Try again shortly." };
    const answers = [finished, busy];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(answers[calls++]) })));
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    expect((rendered as Element).props.status).toMatchObject({ state: "verified" });
    const button = find(rendered, (element) => element.type === "button" && element.props.onClick !== undefined);
    button?.props.onClick?.();
    await vi.advanceTimersByTimeAsync(0);
    expect((rendered as Element).props.status).toBeNull();
  });
});

interface Call {
  url: string;
  method: string;
}

/** A window with the given stored request ID and fake-timer timers. */
function stubWindow(stored: Map<string, string>): void {
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer);
    },
  });
}

/** fetch answering by method and path; a missing answer stays pending, as a request in flight. */
function stubFetch(answers: Record<string, { status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const answer = answers[`${method} ${url.split("?")[0] ?? url}`];
      if (answer === undefined) return new Promise(() => undefined);
      return Promise.resolve({ ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: () => Promise.resolve(answer.body) });
    }),
  );
  return calls;
}


function startButton(rendered: unknown): Element | null {
  return find(rendered, (element) => element.type === "button" && element.props.onClick !== undefined);
}

function passcodeForm(rendered: unknown): Element | null {
  return find(rendered, (element) => element.type === "form");
}

describe("the replay control's session after a reload", () => {
  it("finds a still valid session cookie with no stored replay and enables the start button", async () => {
    vi.useFakeTimers();
    stubWindow(new Map());
    const calls = stubFetch({ "GET /api/judge/session": { status: 200, body: { state: "ready" } } });
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([{ url: "/api/judge/session", method: "GET" }]);
    expect(passcodeForm(rendered)).toBeNull();
    expect(startButton(rendered)?.props.disabled).toBe(false);
  });

  it("keeps the passcode form and the disabled button when the session check answers signed_out", async () => {
    vi.useFakeTimers();
    stubWindow(new Map());
    stubFetch({ "GET /api/judge/session": { status: 200, body: { state: "signed_out" } } });
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(passcodeForm(rendered)).not.toBeNull();
    expect(startButton(rendered)?.props.disabled).toBe(true);
  });

  it("makes no session check when the control is disabled", async () => {
    vi.useFakeTimers();
    stubWindow(new Map());
    const calls = stubFetch({});
    hooks.mount(() => ReplayControl({ release: null, initial: { state: "disabled", reason: "" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
  });

  it("stays signed in, and keeps checking, when the stored replay's status is unavailable after a reload", async () => {
    vi.useFakeTimers();
    stubWindow(new Map([["rbw-judge-request-id", "00000000-0000-4000-8000-00000000b301"]]));
    const calls = stubFetch({ "GET /api/judge/status": { status: 200, body: { state: "unavailable", reason: "ledger", message: "Unavailable: the spend ledger can't be reached right now. Try again shortly." } } });
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    // Only a valid session gets this answer, and the stored replay may still be running.
    expect((rendered as Element).props.state).toBe("unavailable");
    expect(passcodeForm(rendered)).toBeNull();
    expect(startButton(rendered)?.props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls.filter((call) => call.method === "GET" && call.url.startsWith("/api/judge/status"))).toHaveLength(2);
  });
});

describe("the replay control's duplicate clicks", () => {
  it("disables the start button while a start is in flight", async () => {
    vi.useFakeTimers();
    stubWindow(new Map());
    // The POST never answers here, so the start stays in flight.
    const calls = stubFetch({ "GET /api/judge/session": { status: 200, body: { state: "ready" } } });
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    startButton(rendered)?.props.onClick?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(startButton(rendered)?.props.disabled).toBe(true);
  });
});

describe("the replay control's status poll during a temporary outage", () => {
  it("keeps polling, with a back-off, and keeps the start button disabled after an unavailable status while a replay runs", async () => {
    vi.useFakeTimers();
    stubWindow(new Map([["rbw-judge-request-id", "00000000-0000-4000-8000-00000000b501"]]));
    const ledger = { state: "unavailable", reason: "ledger", message: "Unavailable: the spend ledger can't be reached right now. Try again shortly." };
    const verified = { state: "verified", release_id: "00000000-0000-4000-8000-000000000601", message: "Verified.", cells: [] };
    const answers: unknown[] = [{ state: "running" }, ledger, ledger, verified];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answers[calls++]) })));
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(2);
    expect((rendered as Element).props.reason).toContain("the spend ledger can't be reached");
    expect(startButton(rendered)?.props.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(3);
    expect(startButton(rendered)?.props.disabled).toBe(true);
    // The back-off doubles: the next check comes 30 s later, not 15 s.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toBe(4);
    expect((rendered as Element).props.state).toBe("verified");
    expect(startButton(rendered)?.props.disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(4);
  });
});

/** A document whose passcode field and start button record focus calls. */
function stubDocument(): string[] {
  const focused: string[] = [];
  vi.stubGlobal("document", {
    getElementById: (id: string) => ({
      focus: () => {
        focused.push(id);
      },
    }),
  });
  return focused;
}

async function submitPasscode(rendered: () => unknown, passcode: string): Promise<void> {
  const input = find(rendered(), (element) => element.type === "input");
  input?.props.onChange?.({ target: { value: passcode } });
  await vi.advanceTimersByTimeAsync(0);
  passcodeForm(rendered())?.props.onSubmit?.({ preventDefault: () => undefined });
  await vi.advanceTimersByTimeAsync(0);
}

describe("the replay control's sign-in", () => {
  it("says a wrong passcode is not right and puts focus back on the passcode field", async () => {
    vi.useFakeTimers();
    stubWindow(new Map());
    const focused = stubDocument();
    stubFetch({
      "GET /api/judge/session": { status: 200, body: { state: "signed_out" } },
      "POST /api/judge/session": { status: 401, body: { state: "unauthorized", message: "Enter the judge passcode." } },
    });
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    await submitPasscode(() => rendered, "synthetic-wrong");
    expect((rendered as Element).props.reason).toBe("That passcode is not right. Try again.");
    expect(passcodeForm(rendered)).not.toBeNull();
    expect(focused).toEqual(["judge-passcode"]);
  });

  it("moves focus to the start button after a successful sign-in", async () => {
    vi.useFakeTimers();
    stubWindow(new Map());
    const focused = stubDocument();
    stubFetch({
      "GET /api/judge/session": { status: 200, body: { state: "signed_out" } },
      "POST /api/judge/session": { status: 200, body: { state: "ready" } },
    });
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    await vi.advanceTimersByTimeAsync(0);
    await submitPasscode(() => rendered, "synthetic-right");
    expect(startButton(rendered)?.props.disabled).toBe(false);
    expect(startButton(rendered)?.props.id).toBe("replay-start");
    expect(focused).toEqual(["replay-start"]);
  });

  it("styles the passcode field like the buttons", () => {
    stubWindow(new Map());
    stubFetch({});
    let rendered: unknown = null;
    hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
    const input = find(rendered, (element) => element.type === "input");
    expect(input?.props.style).toMatchObject({ font: "inherit", borderRadius: "6px", padding: "0.5rem 0.75rem" });
  });
});

describe("the replay control's start without an answer", () => {
  const failures: [string, () => Promise<unknown>][] = [
    ["a network error", () => Promise.reject(new TypeError("synthetic: the network failed"))],
    ["an answer that is not JSON", () => Promise.resolve({ ok: false, status: 504, json: () => Promise.reject(new SyntaxError("synthetic: a 504 page")) })],
  ];
  for (const [name, failure] of failures) {
    it(`says so after ${name}, keeps the new request ID and polls its status`, async () => {
      vi.useFakeTimers();
      const previous = "00000000-0000-4000-8000-00000000b401";
      const stored = new Map<string, string>([["rbw-judge-request-id", previous]]);
      stubWindow(stored);
      const calls: Call[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: { method?: string }) => {
          const method = init?.method ?? "GET";
          calls.push({ url, method });
          if (method === "POST") return failure();
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ state: "unknown", message: "synthetic" }) });
        }),
      );
      let rendered: unknown = null;
      hooks.mount(() => (rendered = ReplayControl({ release: null, initial: { state: "ready", reason: "" } })));
      await vi.advanceTimersByTimeAsync(0);
      calls.length = 0;
      startButton(rendered)?.props.onClick?.();
      await vi.advanceTimersByTimeAsync(0);
      const requestId = stored.get("rbw-judge-request-id");
      expect(requestId).toBeDefined();
      expect(requestId).not.toBe(previous);
      expect((rendered as Element).props.state).toBe("starting");
      expect((rendered as Element).props.reason).toBe("Could not reach the site. Your replay may still have started; the status updates below.");
      expect(calls).toEqual([{ url: "/api/judge", method: "POST" }]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(calls.at(-1)).toEqual({ url: `/api/judge/status?request_id=${requestId ?? ""}`, method: "GET" });
    });
  }
});
