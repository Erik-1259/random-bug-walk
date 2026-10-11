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
  props: { status?: unknown; onClick?: () => void; children?: unknown };
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
