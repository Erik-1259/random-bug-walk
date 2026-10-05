// Writes the synthetic recordings into recordings/synthetic/. Run: node test/support/generate-recordings.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDINGS_DIR, buildRecordings } from "./fixtures.ts";

mkdirSync(RECORDINGS_DIR, { recursive: true });
for (const [name, recording] of Object.entries(buildRecordings())) {
  writeFileSync(join(RECORDINGS_DIR, `${name}.json`), `${JSON.stringify(recording, null, 2)}\n`);
}
