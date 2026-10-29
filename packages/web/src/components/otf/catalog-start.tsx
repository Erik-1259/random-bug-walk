import type { Capabilities, FactoryController, FactoryView, RequestInput } from "../../factory/client.ts";
import type { OtfCriterionId } from "../../otf/contract.ts";
import { canonicalJson } from "../../otf/canonical.ts";
import { calendarClosedHosts } from "../../factory/format.ts";

/**
 * Only the catalog's declared criteria can select a fallback; the custom sentence is not substituted.
 * An exact criterion match on any offered host wins; otherwise the first task-report entry, then any.
 */
export function closestCatalogInput(capabilities: Capabilities | null, criterion: OtfCriterionId): RequestInput | null {
  if (capabilities === null) return null;
  const closed = calendarClosedHosts(capabilities);
  const candidates = capabilities.combinations.filter(option => !closed.includes(option.host_id) && option.status === "supported" && option.source !== null && option.source.entries > 0);
  const match = candidates.find(option => option.source?.criteria_ids.includes(criterion))
    ?? candidates.find(option => option.host_id === "task-report") ?? candidates[0];
  const type = capabilities.bug_types.find(option => option.bug_type_id === match?.bug_type_id);
  const offered = type?.criteria.filter(option => match?.source?.criteria_ids.includes(option.criterion_id)) ?? [];
  const behavior = offered.find(option => option.criterion_id === criterion) ?? offered[0];
  const difficulty = capabilities.difficulty_options.find(option => option.default && option.available);
  if (match === undefined || type === undefined || behavior === undefined || difficulty === undefined) return null;
  return { hosts: [match.host_id], items: [{ item_key: "otf-catalog", bug_type_id: type.bug_type_id, quantity: 1, description: behavior.example_phrases[0] ?? behavior.label, difficulty: difficulty.option_id }], budget_microusd: capabilities.limits.default_budget_microusd };
}

/** The catalog request was saved but its start is not confirmed. requestId is the saved identity to link locally. */
export class CatalogStartPending extends Error {
  readonly requestId: string;
  constructor(requestId: string, message: string) { super(message); this.name = "CatalogStartPending"; this.requestId = requestId; }
}

type CatalogController = Pick<FactoryController, "interpret" | "start"> & {
  snapshot(): Pick<FactoryView, "signedIn" | "busy" | "requestId" | "capabilities" | "message" | "status"> & { interpretation: Pick<NonNullable<FactoryView["interpretation"]>, "input" | "startable"> | null };
};

/** One explicit click uses the existing interpreter, identity lock and start path. */
export async function startCatalogRequest(controller: CatalogController, criterion: OtfCriterionId): Promise<string> {
  const before = controller.snapshot();
  if (before.requestId !== null) throw new Error("A catalog request is already saved on this page. Resume it below.");
  if (before.busy || !before.signedIn || before.capabilities?.service.state !== "available") throw new Error("Sign in and wait for the catalog service to be available.");
  const input = closestCatalogInput(before.capabilities, criterion);
  if (input === null) throw new Error("No supported catalog bug is available.");
  await controller.interpret(input);
  const interpreted = controller.snapshot();
  if (!interpreted.interpretation?.startable || canonicalJson(interpreted.interpretation.input) !== canonicalJson(input)) throw new Error(interpreted.message ?? "The closest catalog bug cannot be started. Review the requirements below.");
  await controller.start();
  const after = controller.snapshot();
  if (after.requestId === null) throw new Error(after.message ?? "The catalog request could not start.");
  if (after.status?.request_id !== after.requestId) throw new CatalogStartPending(after.requestId, "The saved catalog request is not yet confirmed. Check its status below before trying again.");
  if (canonicalJson(after.status.interpretation.input) !== canonicalJson(input)) throw new Error("Another tab started a different catalog request. Resume that request below; it is not linked to this custom build.");
  return after.requestId;
}
