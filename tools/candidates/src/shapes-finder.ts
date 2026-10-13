// The real site finder: @rbw/shapes runs the class rules over the host tree and returns every site
// with its planted diff and a structural confidence. This adapter turns the shapes site report into
// the pipeline's Site shape. It reads source only; it calls no model and no network.
import { findSites as findSitesInTree } from "@rbw/shapes";
import type { FindSites, Site } from "./types.ts";

/** Runs the class rules in `rule.text` over `hostDir` and returns the pipeline's sites. */
export const findClassSites: FindSites = (rule, hostDir): readonly Site[] => {
  const report = findSitesInTree(hostDir, new TextEncoder().encode(rule.text));
  return report.sites.map((site) => ({
    file: site.path,
    line: site.line,
    diff: site.diff,
    confidence: site.confidence.score,
    classId: site.class_id,
  }));
};
