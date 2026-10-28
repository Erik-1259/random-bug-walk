// "Use this plan": which proven catalog pair a designed bug shape fills the request form with.
// A display decision only; the free interpreter still reads whatever the customer then reviews.
import type { Capabilities, RequestInput } from "../factory/client.ts";
import type { AssistHostId, BugShape } from "./client.ts";

type Host = RequestInput["hosts"][number];
type BugType = RequestInput["items"][number]["bug_type_id"];

/** What the request form is filled with. `key` changes on every use so the form starts over from it. */
export interface FactoryPlan {
  key: number;
  host_id: Host;
  bug_type_id: BugType;
  description: string;
  /** True when the shape's own proven fit is used; false for the app's closest proven pair without a phrase. */
  exact: boolean;
}

/**
 * The shape's own fit when it is for the chosen app and the service offers that pair; otherwise the
 * first pair the service supports on the chosen app, with no description. Null when the form cannot
 * hold either (capabilities not loaded, or nothing supported on that app).
 */
export function planFromShape(shape: BugShape, hostId: AssistHostId, capabilities: Capabilities | null, key: number): FactoryPlan | null {
  if (capabilities === null) return null;
  const host = capabilities.hosts.find((option) => option.host_id === hostId);
  if (host === undefined) return null;
  const supported = (bugTypeId: string) => capabilities.combinations.some((combination) =>
    combination.host_id === host.host_id && combination.bug_type_id === bugTypeId && combination.status === "supported");
  const fit = shape.fit;
  if (fit !== null && fit.host_id === hostId) {
    const type = capabilities.bug_types.find((option) => option.bug_type_id === fit.bug_type_id);
    if (type !== undefined && supported(type.bug_type_id)) return { key, host_id: host.host_id, bug_type_id: type.bug_type_id, description: fit.phrase, exact: true };
  }
  const closest = capabilities.bug_types.find((option) => supported(option.bug_type_id));
  return closest === undefined ? null : { key, host_id: host.host_id, bug_type_id: closest.bug_type_id, description: "", exact: false };
}
