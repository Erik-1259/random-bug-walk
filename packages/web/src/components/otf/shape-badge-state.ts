import type { BugShape } from "../../assist/client.ts";
import type { DesignerState } from "../../assist/designer-state.ts";
import { canonicalJson } from "../../otf/canonical.ts";
import type { ShapeBadgesClient } from "../../otf/client.ts";
import type { OtfAvailability, OtfHostId } from "../../otf/contract.ts";
import type { OtfShapeBadge, OtfShapeBadgesRequest } from "../../otf/shape-badges-contract.ts";
import { validateShapeBadges, validateShapeBadgesRequest } from "../../otf/shape-badges-schemas.ts";
import { classificationAvailable } from "./draft.ts";

/** The displayed search captured with a card handoff, so alternatives keep their original host and order. */
export interface ShapeSearchContext {
  query: string;
  hostId: OtfHostId;
  shapes: BugShape[];
  badges: OtfShapeBadge[];
  selectedShapeId: string;
}

export interface ShapeBadgesSnapshot {
  request: OtfShapeBadgesRequest | null;
  pending: boolean;
  badges: OtfShapeBadge[] | null;
}
export type ShapeBadgesDisplay = Pick<ShapeBadgesSnapshot, "pending" | "badges">;
const EMPTY: ShapeBadgesDisplay = { pending: false, badges: null };

/** Badge input stays tied to the displayed search, even while a different query is being typed. */
export function shapeBadgeRequest(state: DesignerState, enabled: boolean, availability: OtfAvailability | null): OtfShapeBadgesRequest | null {
  if (!enabled || !classificationAvailable(availability) || state.shapes === null || state.hostId === null) return null;
  const request = { query: state.shapes.search.query, host_id: state.hostId, shapes: state.shapes.shapes.map(({ title, summary }) => ({ title, summary })) };
  return validateShapeBadgesRequest(request).length === 0 ? request : null;
}

/** Hide the previous host/search immediately, before the effect requesting the new badges runs. */
export function badgesForRequest(snapshot: ShapeBadgesSnapshot, request: OtfShapeBadgesRequest | null): ShapeBadgesDisplay {
  return request === null || snapshot.request === null || canonicalJson(snapshot.request) !== canonicalJson(request)
    ? EMPTY : { pending: snapshot.pending, badges: snapshot.badges };
}

interface CachedBadges {
  request: OtfShapeBadgesRequest;
  pending: boolean;
  badges: OtfShapeBadge[] | null;
  work: Promise<void>;
}

/** Optional per-search hints only: no create capability and no repeated budget call from rerendering. */
export class ShapeBadgesController {
  private view: ShapeBadgesSnapshot = { request: null, ...EMPTY };
  private readonly listeners = new Set<() => void>();
  private readonly cache = new Map<string, CachedBadges>();
  private readonly client: ShapeBadgesClient;
  private activeKey: string | null = null;
  constructor(client: ShapeBadgesClient) { this.client = client; }
  snapshot = (): ShapeBadgesSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: ShapeBadgesSnapshot): void {
    if (this.view.request === next.request && this.view.pending === next.pending && this.view.badges === next.badges) return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }
  private async read(request: OtfShapeBadgesRequest): Promise<OtfShapeBadge[] | null> {
    try {
      const answer = await this.client.classifyShapes(request);
      return validateShapeBadges(answer, request).length === 0 ? structuredClone(answer.badges) : null;
    } catch {
      // SPEC 8.12: an unavailable, failed or timed-out hint leaves the designer unchanged and silent.
      return null;
    }
  }
  /** A handed-off card keeps its search's final badges even when the designer moves to another search. */
  async result(request: OtfShapeBadgesRequest): Promise<OtfShapeBadge[] | null> {
    if (validateShapeBadgesRequest(request).length !== 0) return null;
    const key = canonicalJson(request);
    const existing = this.cache.get(key);
    if (existing === undefined) await this.load(request);
    else await existing.work;
    return structuredClone(this.cache.get(key)?.badges ?? null);
  }
  async load(request: OtfShapeBadgesRequest | null): Promise<void> {
    if (request === null || validateShapeBadgesRequest(request).length !== 0) {
      this.activeKey = null; this.update({ request: null, ...EMPTY }); return;
    }
    const key = canonicalJson(request);
    this.activeKey = key;
    let cached = this.cache.get(key);
    if (cached === undefined) {
      const accepted = structuredClone(request);
      const entry: CachedBadges = { request: accepted, pending: true, badges: null, work: Promise.resolve() };
      this.cache.set(key, entry);
      entry.work = this.read(accepted).then(badges => {
        entry.pending = false; entry.badges = badges;
        if (this.activeKey === key) this.update({ request: entry.request, pending: false, badges });
      });
      cached = entry;
    }
    this.update({ request: cached.request, pending: cached.pending, badges: cached.badges });
    await cached.work;
  }
}
