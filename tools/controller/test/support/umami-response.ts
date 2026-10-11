// An Umami-shaped pageviews body for the simulated kit's fixture rounds. The driver's canned
// response bodies are not shaped like Umami's, so the attempt tests put this one in their place,
// and an observation then records counts that a symptom can be built from. As the planted bug
// does, every zone gets the UTC control's day counts. Nothing here imports the kit, so a test's
// module mock can load it.
import { loadFixture } from "@rbw/umami-fixture";

export function umamiResponse(): Buffer {
  const fixture = loadFixture();
  const utc = fixture.checks.find((check) => check.timezone === "UTC");
  if (utc === undefined) throw new Error("synthetic: the fixture has no UTC control");
  const pageviews = fixture.bucket_labels.map((x, index) => ({ x, y: utc.expected[index] ?? 0 }));
  return Buffer.from(JSON.stringify({ pageviews, sessions: pageviews }));
}
