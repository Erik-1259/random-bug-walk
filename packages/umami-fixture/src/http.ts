// The one HTTP client of this package is Playwright's APIRequestContext. These types name the
// part of it the fixture uses, so tests can inject a fake and the driver can pass its own context.

export interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  data?: string;
}

export interface ResponseLike {
  status(): number;
  body(): Promise<Buffer>;
}

/** The subset of Playwright's APIRequestContext that the fixture calls. */
export interface RequestContext {
  fetch(url: string, options: RequestOptions): Promise<ResponseLike>;
}

export interface ApiRequest {
  method: "GET" | "POST";
  /** Path and query string, resolved against the context's base URL. */
  path: string;
  headers: Record<string, string>;
  /** Exact body bytes as a string, or null for no body. */
  body: string | null;
}

export interface HttpResult {
  status: number;
  /** Exact response body bytes. */
  body: Uint8Array;
}

/** Sends one request, without retries, and returns the status and the exact body bytes. */
export async function execute(context: RequestContext, request: ApiRequest): Promise<HttpResult> {
  const options: RequestOptions = { method: request.method, headers: request.headers };
  if (request.body !== null) {
    options.data = request.body;
  }
  const response = await context.fetch(request.path, options);
  return { status: response.status(), body: await response.body() };
}
