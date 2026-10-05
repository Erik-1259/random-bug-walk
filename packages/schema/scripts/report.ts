import { fileURLToPath } from "node:url";
import { fixtureReport } from "../src/fixtures.ts";

const dir = process.argv[2] ?? fileURLToPath(new URL("../fixtures", import.meta.url));
process.stdout.write(fixtureReport(dir).map((line) => `${line}\n`).join(""));
