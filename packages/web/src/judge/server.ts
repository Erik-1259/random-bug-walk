// The judge routes' real dependencies. The controller's slim judge entry (judge-web.ts: no runner,
// no driver, no PGlite) and the private-store client are imported by name, so the build bundles
// them into the routes' functions; they load on a route's first request. The OIDC token is the one
// Vercel gives this request (`getVercelOidcToken` reads the x-vercel-oidc-token header of the
// request context); the private store and the controller sandbox get that same token. The release
// and the rate sheet were frozen into the bundle by next.config.ts.
import { getVercelOidcToken } from "@vercel/oidc";
import { loadJudgeConfig } from "../config.ts";
import type { FrozenJudge, JudgeServer } from "./handlers.ts";

/** release.json's text and the rate sheet, as next.config.ts froze them at build time; null without a release. */
export function frozenJudge(raw: string | undefined = process.env.RBW_JUDGE_FROZEN): FrozenJudge | null {
  if (raw === undefined || raw === "") return null;
  return JSON.parse(raw) as FrozenJudge;
}

export function judgeServer(): JudgeServer {
  const config = loadJudgeConfig();
  const judge = () => import("@rbw/controller/judge-web");
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = config.credentials;
  return {
    config,
    frozen: frozenJudge(),
    judge,
    ledger: async () => (await judge()).databaseLedger(config.credentials.DATABASE_URL, () => new Date()),
    oidcToken: () => getVercelOidcToken(),
    store: async (oidcToken) => {
      const stores = await import("@rbw/publisher/private-store");
      return stores.privateStoreFromEnv({ ...process.env, VERCEL_OIDC_TOKEN: oidcToken });
    },
    sandbox: () => ({
      create: async (params) => (await judge()).createJudgeSandboxSdk({ token, teamId, projectId }).create(params),
    }),
    now: () => Date.now(),
    log: (line) => {
      console.log(line);
    },
  };
}
