// Synthetic subprocesses test owned-process cleanup, never API acceptance.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { LocalHttpClient, ownLocalProcess } from "../../src/local-backend.ts";

const mode = process.argv[2];
const phase = process.argv[3];
const pause = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const announce = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === "descendant") {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Synthetic listener has no port");
  announce({ descendant: process.pid, port: address.port });
  process.on("SIGTERM", () => {
    if (phase !== "resistant-descendant") setTimeout(() => { server.close(); }, 150);
  });
} else if (mode === "service") {
  if (phase === "resistant") {
    process.on("SIGTERM", () => undefined);
    announce({ child: process.pid });
    setInterval(() => undefined, 1000);
  } else {
    const descendant = spawn(process.execPath, [import.meta.filename, "descendant", phase ?? ""], { stdio: ["ignore", "pipe", "inherit"] });
    descendant.stdout.pipe(process.stdout);
    process.on("SIGTERM", () => { if (phase === "resistant-descendant") process.exit(0); });
    descendant.once("exit", (exitCode, signal) => {
      if (exitCode !== 0 || signal !== null) process.exitCode = 1;
    });
  }
} else {
  const previous = { int: process.listenerCount("SIGINT"), term: process.listenerCount("SIGTERM") };
  const child = spawn(process.execPath, [import.meta.filename, "service", phase ?? ""], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let releases = 0;
  let client: LocalHttpClient | undefined;
  const owned = ownLocalProcess(child, () => { releases++; client?.close(); });
  let pending = "";
  let port = 0;
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      if (!pending.includes("\n")) return;
      const first: unknown = JSON.parse(pending.split("\n")[0] ?? "");
      if (first !== null && typeof first === "object" && "port" in first && typeof first.port === "number") port = first.port;
      announce({ phase, child: child.pid, ...first as object });
      resolve();
    });
  });
  if (phase === "normal" || phase === "closing" || phase === "resistant" || phase === "resistant-descendant") {
    const first = owned.close();
    if (phase === "closing") announce({ closing: true });
    await Promise.all([first, owned.close()]);
    announce({ closed: true, releases, samePromise: first === owned.close(),
      listenersRestored: previous.int === process.listenerCount("SIGINT") && previous.term === process.listenerCount("SIGTERM") });
    if (!owned.interrupted()) announce({ success: true });
  } else if (phase === "request") {
    client = new LocalHttpClient(port);
    announce({ requesting: true });
    try { await client.request("GET", "/api/factory/wait"); }
    catch (error) { if (!owned.interrupted()) throw error; }
    finally { await owned.close(); }
    if (!owned.interrupted()) announce({ success: true });
  } else {
    // Neither startup readiness nor a later polling backoff has returned yet.
    await pause(60_000);
    await owned.close();
    if (!owned.interrupted()) announce({ success: true });
  }
}
