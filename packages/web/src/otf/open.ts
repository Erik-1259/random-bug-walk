/** SPEC section 8.2: the builder must support open rules before this flag is enabled. */
export function openBehaviorsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.RBW_OTF_OPEN_BEHAVIORS === "1";
}
