// The one place the runner calls Vercel Sandbox: `@vercel/sandbox` with the credentials bound as
// SDK options. The CLI reads the credentials from the environment and passes them here; they are
// never printed and never become command arguments.
import { APIError, Sandbox } from "@vercel/sandbox";
import type { SandboxSdk } from "./sandbox.ts";

export interface SandboxCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** `fetch` replaces the SDK's transport (the SDK's own `fetch` option); tests use it to answer locally. */
export function createSandboxSdk(credentials: SandboxCredentials, transport: { fetch?: typeof fetch } = {}): SandboxSdk {
  return {
    create: (params, options = {}) => Sandbox.create({ ...params, ...credentials, ...transport, ...options }),
    async get(name, options = {}) {
      try {
        return await Sandbox.get({ name, ...credentials, ...transport, ...options });
      } catch (error) {
        if (error instanceof APIError && error.response.status === 404) return null;
        throw error;
      }
    },
  };
}
