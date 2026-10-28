// The test-only provider stub origin: honored in local factory test mode for a loopback origin only,
// and it redirects only the two provider URLs. No provider is ever called.
import { describe, expect, it, vi } from "vitest";
import { assistTestProviderOrigin } from "../../src/config.ts";
import { CHAT_COMPLETIONS_URL, TAVILY_SEARCH_URL } from "../../src/assist/providers.ts";
import { providerFetch } from "../../src/assist/server.ts";

const STUB = "http://127.0.0.1:4010";

describe("assistTestProviderOrigin", () => {
  it("is honored only in local factory test mode", () => {
    expect(assistTestProviderOrigin({ RBW_ASSIST_TEST_PROVIDER_ORIGIN: STUB, RBW_FACTORY_TEST_MODE: "1" })).toBe(STUB);
    expect(assistTestProviderOrigin({ RBW_ASSIST_TEST_PROVIDER_ORIGIN: STUB, RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV: "development" })).toBe(STUB);
    expect(assistTestProviderOrigin({ RBW_ASSIST_TEST_PROVIDER_ORIGIN: STUB })).toBeNull();
    for (const VERCEL_ENV of ["preview", "production"]) {
      expect(assistTestProviderOrigin({ RBW_ASSIST_TEST_PROVIDER_ORIGIN: STUB, RBW_FACTORY_TEST_MODE: "1", VERCEL_ENV })).toBeNull();
    }
  });

  it("accepts loopback http origins only", () => {
    const origin = (value: string) => assistTestProviderOrigin({ RBW_ASSIST_TEST_PROVIDER_ORIGIN: value, RBW_FACTORY_TEST_MODE: "1" });
    expect(origin("http://localhost:4010")).toBe("http://localhost:4010");
    expect(origin("http://[::1]:4010")).toBe("http://[::1]:4010");
    for (const value of ["https://127.0.0.1:4010", "http://example.com", "http://127.0.0.1.example.com", "http://127.0.0.1:4010/", "http://127.0.0.1:4010/v1"]) {
      expect(origin(value)).toBeNull();
    }
  });
});

describe("providerFetch", () => {
  it("passes every call through unchanged without an override", () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response("{}")));
    expect(providerFetch(fetchFn, null)).toBe(fetchFn);
  });

  it("sends only the two provider URLs to the stub", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response("{}")));
    const wrapped = providerFetch(fetchFn, STUB);
    const init = { method: "POST" };
    await wrapped(CHAT_COMPLETIONS_URL, init);
    await wrapped(TAVILY_SEARCH_URL, init);
    await wrapped("https://example.org/other", init);
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual([`${STUB}/v1/chat/completions`, `${STUB}/search`, "https://example.org/other"]);
    expect(fetchFn.mock.calls.every((call) => call[1] === init)).toBe(true);
  });
});
