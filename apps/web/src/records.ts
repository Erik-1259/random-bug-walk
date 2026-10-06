// The record packages read their schema files next to their sources when they load, which a
// bundled copy cannot do. These imports are left out of the bundle, so Node loads the packages
// from the workspace while pages are prerendered.
import type * as Admission from "@rbw/admission";
import type * as Schema from "@rbw/schema";

export interface RecordPackages {
  schema: typeof Schema;
  admission: typeof Admission;
}

export async function recordPackages(): Promise<RecordPackages> {
  const [schema, admission] = await Promise.all([
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@rbw/schema"),
    import(/* webpackIgnore: true */ /* turbopackIgnore: true */ "@rbw/admission"),
  ]);
  return { schema, admission };
}
