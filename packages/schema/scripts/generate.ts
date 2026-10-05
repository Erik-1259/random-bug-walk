import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSchemaSource, renderGenerated, repositoryRoot } from "./render.ts";

for (const file of renderGenerated(readSchemaSource())) {
  writeFileSync(join(repositoryRoot, file.path), file.content);
  process.stdout.write(`wrote ${file.path}\n`);
}
