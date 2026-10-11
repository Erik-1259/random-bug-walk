import { afterAll } from "vitest";
import { cleanupTempDirs } from "./world.ts";

afterAll(cleanupTempDirs);
