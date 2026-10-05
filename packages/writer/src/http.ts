// The writer's one HTTP path: the provider's injected `fetch`, wrapped so the writer knows the
// exact bytes it sends and what came back. There is no second HTTP client.
import { AsyncLocalStorage } from "node:async_hooks";

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

interface SendState {
  kind: "send";
  body: string;
  /** Set by the one request this call may make; any further request in the call is refused. */
  used: boolean;
  /** This call's own outcome, so it is never read by or written for another call. */
  exchange: Exchange;
}

type Mode = { kind: "idle" } | SendState;

/** One preview's capture, scoped to the preview's own async context rather than to the provider. */
interface PreviewCapture {
  body: string | null;
}

/**
 * Wraps the injected fetch. Outside a call it refuses every request. Inside a preview it captures the
 * body and sends nothing; a preview never occupies the provider, so it also works while another
 * call is in flight. In send mode it sends only the exact body the call reserved, and records the
 * response, or that the response was lost after the request may have been sent.
 */
export class ObservedFetch {
  private mode: Mode = { kind: "idle" };
  private readonly previews = new AsyncLocalStorage<PreviewCapture>();
  private readonly inner: FetchFunction;

  constructor(inner: FetchFunction) {
    this.inner = inner;
  }

  readonly fetch: FetchFunction = async (input, init) => {
    const preview = this.previews.getStore();
    if (preview !== undefined) {
      preview.body = requestBody(init);
      throw new RequestNotSentError("preview", "preview only");
    }
    const mode = this.mode;
    if (mode.kind === "idle") {
      throw new RequestNotSentError("payload_mismatch", "a request was made outside a writer call");
    }
    const body = requestBody(init);
    // One request per call: any further request in this call is refused. The provider stays busy
    // until the enclosing `send` returns.
    if (mode.used) {
      throw new RequestNotSentError("provider_busy", "one request per call");
    }
    mode.used = true;
    if (body !== mode.body) {
      mode.exchange = { kind: "not_sent", reason: "payload_mismatch" };
      throw new RequestNotSentError("payload_mismatch", "the request body differs from the reserved payload");
    }
    let response: Response;
    try {
      response = await this.inner(input, init);
    } catch (error) {
      mode.exchange =
        error instanceof RequestNotSentError ? { kind: "not_sent", reason: error.code } : { kind: "lost" };
      throw error;
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      mode.exchange = { kind: "lost" };
      throw error;
    }
    mode.exchange = { kind: "response", status: response.status, body: text };
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  /** Runs `action` in preview mode and returns the body it tried to send. */
  async preview(action: () => Promise<unknown>): Promise<string> {
    const capture: PreviewCapture = { body: null };
    let failure: unknown = null;
    try {
      // The capture ends the action with a RequestNotSentError; any other error means no capture.
      await this.previews.run(capture, action);
    } catch (error) {
      failure = error;
    }
    if (capture.body === null) {
      throw new Error("the request could not be rendered", { cause: failure });
    }
    return capture.body;
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
    const state: SendState = { kind: "send", body, used: false, exchange: { kind: "none" } };
    this.mode = state;
    let error: unknown = null;
    try {
      await action();
    } catch (thrown) {
      error = thrown;
    } finally {
      this.mode = { kind: "idle" };
    }
    return { exchange: state.exchange, error };
  }
}
