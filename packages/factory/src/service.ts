// The three pure functions the web service's ports take from this package (capabilities, the
// interpretation of a request body and the canonical start), bound to one registry, catalog and profile.
import type { Capabilities, Interpretation, ServiceStatus, StartRequest } from "@rbw/factory-contract";
import { buildCapabilities } from "./capabilities.ts";
import type { CriteriaCatalog } from "./criteria.ts";
import { canonicalStart, parseRequestInput } from "./input.ts";
import { interpret } from "./interpret.ts";
import type { FactoryProfileInput } from "./profile.ts";
import type { HostRegistry } from "./sources.ts";

export interface ServiceConfig {
  registry: HostRegistry;
  catalog: CriteriaCatalog;
  profile: FactoryProfileInput;
}

export interface ServiceFunctions {
  capabilities(now: Date, service?: ServiceStatus): Capabilities;
  /** Validates and normalizes the body (400 on `ok: false`), then interprets it. */
  interpret(body: unknown, now: Date): { ok: true; interpretation: Interpretation } | { ok: false; message: string };
  /** Validates a start body (400 on `ok: false`); `sha256` is the canonical body's hash for the idempotency check. */
  canonicalStart(body: unknown): { ok: true; start: StartRequest; sha256: string } | { ok: false; message: string };
}

export function serviceFunctions(config: ServiceConfig): ServiceFunctions {
  return {
    capabilities: (now, service) => buildCapabilities({ ...config, now, ...(service === undefined ? {} : { service }) }),
    interpret: (body, now) => {
      const parsed = parseRequestInput(body, config.profile.limits);
      if (!parsed.ok) return { ok: false, message: parsed.message };
      return { ok: true, interpretation: interpret({ ...config, input: parsed.value, now }) };
    },
    canonicalStart: (body) => {
      const result = canonicalStart(body, config.profile.limits);
      return result.ok ? { ok: true, start: result.start, sha256: result.sha256 } : { ok: false, message: result.message };
    },
  };
}
