import type { BugShape, ShapesResult } from "../../assist/client.ts";
import { canonicalJson } from "../../otf/canonical.ts";
import { OtfClientError, type ShapeBadgesClient } from "../../otf/client.ts";
import { OTF_HOST_IDS, type OtfAvailability, type OtfHostId, type ProvenCriterionId } from "../../otf/contract.ts";
import { SHAPE_BADGE_COPY, isBuildableBadge, orderShapesByBadge, shapeBadgeText, type OtfShapeBadge, type OtfShapeBadgesRequest } from "../../otf/shape-badges-contract.ts";
import { validateShapeBadges, validateShapeBadgesRequest } from "../../otf/shape-badges-schemas.ts";
import { classificationAvailable } from "./draft.ts";

/** The displayed search captured with a card handoff, so alternatives keep their badges and the judge's own query. */
export interface ShapeSearchContext {
  /** The trimmed query the judge submitted, without anything the search provider adds. */
  query: string;
  shapes: BugShape[];
  /** Badges with indices in the designer's order; each was checked against its shape's badge host. */
  badges: OtfShapeBadge[];
  selectedShapeId: string;
}

/** The host a shape's badge is checked against: the designer's suggestion, or the task-report service when it has none. */
export function shapeBadgeHost(shape: Pick<BugShape, "fit">): OtfHostId {
  return shape.fit?.host_id ?? "task-report";
}

/** One /classify-shapes request: the shapes that share a badge host, in the designer's order. */
export interface ShapeBadgeGroup {
  hostId: OtfHostId;
  /** Each request shape's index in the designer's order. */
  indices: number[];
  request: OtfShapeBadgesRequest;
}

/** One request per badge host present (at most two per search), sent as soon as the shapes appear, before any pick. */
export function shapeBadgeGroups(search: ShapesResult | null, query: string | null, enabled: boolean, availability: OtfAvailability | null): ShapeBadgeGroup[] | null {
  if (!enabled || !classificationAvailable(availability) || search === null || query === null) return null;
  const groups = OTF_HOST_IDS.flatMap((hostId): ShapeBadgeGroup[] => {
    const indices = search.shapes.flatMap((shape, index) => shapeBadgeHost(shape) === hostId ? [index] : []);
    const shapes = search.shapes.filter(shape => shapeBadgeHost(shape) === hostId).map(({ title, summary }) => ({ title, summary }));
    const request: OtfShapeBadgesRequest = { query, host_id: hostId, shapes };
    return indices.length > 0 && validateShapeBadgesRequest(request).length === 0 ? [{ hostId, indices, request }] : [];
  });
  return groups.length === 0 ? null : groups;
}

function shapeBadgeLabels(availability: OtfAvailability | null): Partial<Record<ProvenCriterionId, string>> {
  return Object.fromEntries((availability?.behaviors ?? []).map(behavior => [behavior.criterion_id, behavior.label]));
}

/** The badges the designer can show: a proven badge whose label availability does not list counts as no badge. */
export function visibleShapeBadges(shapes: readonly Pick<BugShape, "fit">[], badges: readonly OtfShapeBadge[], availability: OtfAvailability | null): OtfShapeBadge[] {
  const labels = shapeBadgeLabels(availability);
  return badges.filter(badge => {
    const shape = shapes[badge.index];
    return shape !== undefined && shapeBadgeText(badge, shapeBadgeHost(shape), labels) !== null;
  });
}

/** The one polite status line for the badges: loading, then a short summary; nothing when no badge came back. */
export function shapeBadgeStatus(pending: boolean, badges: readonly OtfShapeBadge[]): string | null {
  if (pending) return SHAPE_BADGE_COPY.loading;
  if (badges.length === 0) return null;
  const buildable = badges.filter(isBuildableBadge).length;
  return `Checked ${String(badges.length)} ${badges.length === 1 ? "shape" : "shapes"}: ${String(buildable)} can be built.`;
}

export interface ShapeBadgesSnapshot {
  /** The search these badges belong to (the designer's shapes result), or null. */
  search: ShapesResult | null;
  /** Per shape in the designer's order: whether its group's request is running. */
  pending: boolean[];
  /** Badges with indices in the designer's order; a shape whose group failed has none. */
  badges: OtfShapeBadge[];
  /** The display order as indices in the designer's order, or null for the designer's own order. */
  order: number[] | null;
}
const EMPTY: ShapeBadgesSnapshot = { search: null, pending: [], badges: [], order: null };

/** The snapshot for the displayed search only; another search's badges never show. */
export function shapeBadgesFor(snapshot: ShapeBadgesSnapshot | undefined, search: ShapesResult | null): ShapeBadgesSnapshot | null {
  return snapshot === undefined || search === null || snapshot.search !== search ? null : snapshot;
}

export interface ShapeBadgesInput {
  search: ShapesResult;
  groups: ShapeBadgeGroup[];
  signedIn: boolean;
  selectedShapeId: string | null;
  availability: OtfAvailability | null;
}

type Failure = "signed_out" | "transient" | "final";

interface GroupEntry {
  readonly group: ShapeBadgeGroup;
  state: "pending" | "done" | "failed";
  badges: OtfShapeBadge[];
  /** signed_out waits for the judge to sign in again; transient (network, timeout, 503) may be retried; final never is. */
  failure: Failure | null;
  /** At most one retry per search and group. */
  retried: boolean;
  signedOutSeen: boolean;
}

interface SearchEntry {
  readonly search: ShapesResult;
  readonly groups: Map<string, GroupEntry>;
  order: number[] | null;
  /** Set once the judge selects a shape: the list never moves under a selection. */
  frozen: boolean;
  waiters: (() => void)[];
}

const retryDue = (group: GroupEntry) => group.state === "failed" && group.failure === "transient" && !group.retried;
const running = (entry: SearchEntry) => [...entry.groups.values()].some(group => group.state === "pending");
const outstanding = (entry: SearchEntry) => [...entry.groups.values()].some(group => group.state === "pending" || retryDue(group));

/** Optional per-search hints only: no create capability, and no repeated budget call from rerendering. */
export class ShapeBadgesController {
  private view: ShapeBadgesSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly searches = new WeakMap<ShapesResult, SearchEntry>();
  private readonly client: ShapeBadgesClient;
  private current: SearchEntry | null = null;
  private availability: OtfAvailability | null = null;
  /** Called when a badge call answers signed_out, so the page re-checks the shared session and shows its sign-in form. */
  onSignedOut: () => void = () => undefined;
  constructor(client: ShapeBadgesClient) { this.client = client; }
  snapshot = (): ShapeBadgesSnapshot => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  /** Called after each designer render; a later pick or Step 3 host change sends nothing new for the same search. */
  sync(input: ShapeBadgesInput | null): void {
    const previous = this.current;
    this.current = null;
    if (input !== null) {
      this.availability = input.availability;
      let entry = this.searches.get(input.search);
      if (entry === undefined) {
        entry = { search: input.search, groups: new Map(), order: null, frozen: false, waiters: [] };
        this.searches.set(input.search, entry);
      }
      this.current = entry;
      if (input.selectedShapeId !== null) entry.frozen = true;
      for (const group of input.groups) this.request(entry, group, input.signedIn);
    }
    // A search the designer has left gets no retry; a card handed off from it takes what has arrived.
    if (previous !== null && previous !== this.current && !running(previous)) this.release(previous);
    if (this.current === null) this.publish();
    else this.settle(this.current);
  }

  /** Freezes the display order before a pick renders, so arriving badges never reorder under the selection. */
  freeze(search: ShapesResult): void {
    const entry = this.searches.get(search);
    if (entry !== undefined) entry.frozen = true;
  }

  /** A handed-off card gets its search's badges once no request for it is running or due a retry. */
  settled(search: ShapesResult): Promise<OtfShapeBadge[] | null> {
    const entry = this.searches.get(search);
    if (entry === undefined) return Promise.resolve(null);
    if (!outstanding(entry)) return Promise.resolve(this.collect(entry));
    return new Promise(resolve => { entry.waiters.push(() => { resolve(this.collect(entry)); }); });
  }

  private request(entry: SearchEntry, group: ShapeBadgeGroup, signedIn: boolean): void {
    const key = canonicalJson(group.request);
    const known = entry.groups.get(key);
    if (known === undefined) {
      if (!signedIn) return;
      const created: GroupEntry = { group: structuredClone(group), state: "pending", badges: [], failure: null, retried: false, signedOutSeen: false };
      entry.groups.set(key, created);
      this.start(entry, created);
      return;
    }
    if (known.state !== "failed" || known.retried) return;
    if (known.failure === "signed_out" && !signedIn) known.signedOutSeen = true;
    if (signedIn && (known.failure === "transient" || (known.failure === "signed_out" && known.signedOutSeen))) {
      known.retried = true;
      this.start(entry, known);
    }
  }

  private start(entry: SearchEntry, group: GroupEntry): void {
    group.state = "pending"; group.failure = null; group.badges = [];
    void this.read(structuredClone(group.group.request)).then(outcome => {
      if (typeof outcome === "string") {
        group.state = "failed"; group.failure = outcome;
        if (outcome === "signed_out") this.onSignedOut();
      }
      else {
        group.state = "done";
        // Each badge maps back to its shape by its index within this group's request.
        group.badges = outcome.flatMap(badge => {
          const index = group.group.indices[badge.index];
          return index === undefined ? [] : [{ ...badge, index }];
        });
      }
      this.settle(entry);
    });
  }

  private async read(request: OtfShapeBadgesRequest): Promise<OtfShapeBadge[] | Failure> {
    try {
      const answer = await this.client.classifyShapes(request);
      return validateShapeBadges(answer, request).length === 0 ? structuredClone(answer.badges) : "final";
    } catch (error) {
      // SPEC 8.12: an unavailable, failed or timed-out hint leaves the designer unchanged and silent.
      if (error instanceof OtfClientError && error.code === "signed_out") return "signed_out";
      if (error instanceof OtfClientError && error.code === "invalid_request") return "final";
      return "transient";
    }
  }

  private collect(entry: SearchEntry): OtfShapeBadge[] | null {
    const badges = [...entry.groups.values()].flatMap(group => group.state === "done" ? group.badges : []);
    return badges.length === 0 ? null : structuredClone(badges);
  }

  /** The buildable-first order applies once, when the badges arrive, and only while no shape is selected. */
  private settle(entry: SearchEntry): void {
    if (!outstanding(entry)) {
      if (entry.order === null && !entry.frozen) {
        const badges = visibleShapeBadges(entry.search.shapes, this.collect(entry) ?? [], this.availability);
        if (badges.length > 0) entry.order = orderShapesByBadge(entry.search.shapes, badges).map(({ index }) => index);
      }
      this.release(entry);
    } else if (entry !== this.current && !running(entry)) this.release(entry);
    this.publish();
  }

  private release(entry: SearchEntry): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private publish(): void {
    const entry = this.current;
    let next = EMPTY;
    if (entry !== null) {
      const pending = entry.search.shapes.map(() => false);
      for (const group of entry.groups.values()) if (group.state === "pending") for (const index of group.group.indices) pending[index] = true;
      next = { search: entry.search, pending, badges: this.collect(entry) ?? [], order: entry.order === null ? null : [...entry.order] };
    }
    if (next.search === this.view.search && canonicalJson({ ...next, search: null }) === canonicalJson({ ...this.view, search: null })) return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }
}
