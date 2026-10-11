// The pinned rate sheet's path, apart from envelope.ts: the web app bundles envelope.ts for its
// judge routes, and the bundler's import.meta has no resolve.
import { fileURLToPath } from "node:url";

export const RATE_SHEET_PATH = fileURLToPath(new URL("../rate-sheets/v1.json", import.meta.resolve("@rbw/envelope")));
