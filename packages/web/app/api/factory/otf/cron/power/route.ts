// GET /api/factory/otf/cron/power: the builder machine's watchdog pass for Vercel Cron, every 5 min
// (vercel.json). Vercel sends Authorization: Bearer <CRON_SECRET> (docs/otf/SPEC.md section 4).
import "../../../../../../src/otf/compose.ts";
import { loadOtfConfig } from "../../../../../../src/config.ts";
import { powerCron } from "../../../../../../src/otf/power/lifecycle.ts";
import { nebiusPowerFrom } from "../../../../../../src/otf/power/nebius.ts";
import { otfStoreFor } from "../../../../../../src/otf/store.ts";

export const dynamic = "force-dynamic";
// One cloud call (up to 15 s) plus a token exchange when the cached token has expired.
export const maxDuration = 60;

export function GET(request: Request): Promise<Response> {
  const config = loadOtfConfig();
  return powerCron(
    request,
    config.cronSecret,
    async () => {
      const store = await otfStoreFor(config);
      const power = nebiusPowerFrom(config.nebius);
      return store === null || power === null ? null : { store, power, now: () => new Date(), vmHoursPerDay: config.vmHoursPerDay };
    },
    (line) => {
      console.log(line);
    },
  );
}
