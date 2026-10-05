// The writer's one HTTP path: the provider's injected `fetch`, wrapped so the writer knows the
// exact bytes it sends and what came back. There is no second HTTP client.

export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A request that provably never left this process. The writer records such a call as failed, not lost. */
export class RequestNotSentError extends Error {
  readonly code: "no_recording" | "unexpected_url" | "payload_mismatch" | "provider_busy" | "preview";

  constructor(code: RequestNotSentError["code"], message: string) {
    super(message);
    this.name = "RequestNotSentError";
    this.code = code;
  }
}

/** What happened to the one request of a call. */
export type Exchange =
  | { kind: "none" }
  | { kind: "not_sent"; reason: RequestNotSentError["code"] }
  | { kind: "lost" }
  | { kind: "response"; status: number; body: string };

export function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

export function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new RequestNotSentError("payload_mismatch", "the writer sends string request bodies only");
  }
  return init.body;
}

type Mode = { kind: "idle" } | { kind: "preview" } | { kind: "send"; body: string };

/**
 * Wraps the injected fetch. Outside a call it refuses every request. In preview mode it captures the
 * body and sends nothing. In send mode it sends only the exact body the call reserved, and records
 * the response, or that the response was lost after the request may have been sent.
 */
export class ObservedFetch {
  private mode: Mode = { kind: "idle" };
  private captured: string | null = null;
  private exchange: Exchange = { kind: "none" };
  private readonly inner: FetchFunction;

  constructor(inner: FetchFunction) {
    this.inner = inner;
  }

  readonly fetch: FetchFunction = async (input, init) => {
    const mode = this.mode;
    if (mode.kind === "idle") {
      throw new RequestNotSentError("payload_mismatch", "a request was made outside a writer call");
    }
    const body = requestBody(init);
    if (mode.kind === "preview") {
      this.captured = body;
      throw new RequestNotSentError("preview", "preview only");
    }
    // One request per call: any further request in this call is refused.
    this.mode = { kind: "idle" };
    if (body !== mode.body) {
      this.exchange = { kind: "not_sent", reason: "payload_mismatch" };
      throw new RequestNotSentError("payload_mismatch", "the request body differs from the reserved payload");
    }
    let response: Response;
    try {
      response = await this.inner(input, init);
    } catch (error) {
      this.exchange =
        error instanceof RequestNotSentError ? { kind: "not_sent", reason: error.code } : { kind: "lost" };
      throw error;
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      this.exchange = { kind: "lost" };
      throw error;
    }
    this.exchange = { kind: "response", status: response.status, body: text };
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  /** Runs `action` in preview mode and returns the body it tried to send. */
  async preview(action: () => Promise<unknown>): Promise<string> {
    this.enter({ kind: "preview" });
    this.captured = null;
    let failure: unknown = null;
    try {
      // The capture ends the action with a RequestNotSentError; any other error means no capture.
      await action();
    } catch (error) {
      failure = error;
    } finally {
      this.mode = { kind: "idle" };
    }
    const captured = this.takeCaptured();
    if (captured === null) {
      throw new Error("the request could not be rendered", { cause: failure });
    }
    return captured;
  }

  private takeCaptured(): string | null {
    const captured = this.captured;
    this.captured = null;
    return captured;
  }

  /** Runs `action` allowing exactly `body` to be sent once, and returns what happened. */
  async send(body: string, action: () => Promise<unknown>): Promise<{ exchange: Exchange; error: unknown }> {
    // Reached after the operation is recorded as launching, so a busy provider is reported as a
    // request that was never sent (and then settled), not thrown past the ledger.
    if (this.mode.kind !== "idle") {
      return {
        exchange: { kind: "not_sent", reason: "provider_busy" },
        error: new Error("one writer provider runs one call at a time"),
      };
    }
    this.enter({ kind: "send", body });
    this.exchange = { kind: "none" };
    let error: unknown = null;
    try {
      await action();
    } catch (thrown) {
      error = thrown;
    } finally {
      this.mode = { kind: "idle" };
    }
    return { exchange: this.exchange, error };
  }

  private enter(mode: Mode): void {
    if (this.mode.kind !== "idle") {
      throw new Error("one writer provider runs one call at a time");
    }
    this.mode = mode;
  }
}
