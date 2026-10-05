// Observes the SDK's HTTP exchange so the `record` command can save the exact request body and the
// response. It hooks the SDK's own axios instance; it never sends anything and never stores headers.
import axios from "axios";

export interface WireExchange {
  endpoint: string;
  /** The request body as sent, without any header. */
  request_body: unknown;
  /** Absent when no response arrived (a timeout or a reset). */
  response: { status: number; body: unknown } | null;
}

export interface WireTap {
  /** Returns the latest exchange and clears it. */
  take(): WireExchange | null;
  remove(): void;
}

function endpointOf(url: string | undefined): string {
  return (url ?? "").split("?")[0]?.split("/").filter(Boolean).pop() ?? "";
}

export function installWireTap(): WireTap {
  let current: WireExchange | null = null;
  const requestId = axios.interceptors.request.use((config) => {
    // Round-trip through JSON so the copy holds exactly what goes on the wire.
    const body = (config.data === undefined ? {} : JSON.parse(JSON.stringify(config.data))) as Record<string, unknown>;
    // The SDK sends the key only as a header, but a recording must never hold one, whatever the body carries.
    delete body.api_key;
    current = { endpoint: endpointOf(config.url), request_body: body, response: null };
    return config;
  });
  const responseId = axios.interceptors.response.use(
    (response) => {
      if (current !== null) {
        current.response = { status: response.status, body: response.data };
      }
      return response;
    },
    (error: unknown) => {
      if (current !== null && axios.isAxiosError(error) && error.response !== undefined) {
        current.response = { status: error.response.status, body: error.response.data };
      }
      return Promise.reject(error instanceof Error ? error : new Error("request failed"));
    },
  );
  return {
    take() {
      const exchange = current;
      current = null;
      return exchange;
    },
    remove() {
      axios.interceptors.request.eject(requestId);
      axios.interceptors.response.eject(responseId);
    },
  };
}
