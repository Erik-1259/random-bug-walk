import { runIntegration } from "./runner.ts";
const url = process.env.DATABASE_URL;
if (!url) {
  process.stdout.write("test:integration skipped: DATABASE_URL is not set\n");
  process.exit(0);
}
process.exit(runIntegration(url));
