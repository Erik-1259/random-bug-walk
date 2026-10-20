import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_PATH, readSchemaSource, renderTypescript, repositoryRoot } from "./render.ts";

writeFileSync(join(repositoryRoot, GENERATED_PATH), renderTypescript(readSchemaSource()));
process.stdout.write(`wrote ${GENERATED_PATH}\n`);
