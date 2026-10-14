// Docker Desktop bind mounts as Node's fs module meets them, for a vi.mock of node:fs. Node 24's
// fs.cpSync copies a recursive directory with no filter in C++, which creates each file write-only
// (mode 0200) before it sets the file's mode, and a Docker Desktop bind mount refuses that create
// with EACCES. A Linux file system accepts it, so these tests stand in for the mount: that one call
// into a directory under `mounts` fails as it does on the mount, and every other fs call is real.
import type * as fs from "node:fs";
import { resolve, sep } from "node:path";

type Fs = typeof fs;

export function bindMountFs(real: Fs, mounts: readonly string[]): Fs & { default: Fs } {
  const cpSync: Fs["cpSync"] = (source, destination, options) => {
    const dest = resolve(destination instanceof URL ? destination.pathname : destination);
    const mounted = mounts.some((mount) => dest === mount || dest.startsWith(`${mount}${sep}`));
    if (mounted && options?.recursive === true && options.filter === undefined && real.statSync(source).isDirectory()) {
      throw Object.assign(new Error(`EACCES, Permission denied '${dest}'`), { code: "EACCES" });
    }
    real.cpSync(source, destination, options);
  };
  return { ...real, default: { ...real, cpSync }, cpSync };
}
