import type { BugShape } from "../../assist/client.ts";
import type { OtfAvailability, OtfHostId } from "../../otf/contract.ts";
import { SHAPE_BADGE_COPY, isBuildableBadge, orderShapesByBadge, shapeBadgeText, type OtfShapeBadge } from "../../otf/shape-badges-contract.ts";
import { typicalSentence } from "./host-copy.tsx";

export function ShapeBadgeView({ badge, hostId, availability }: { badge: OtfShapeBadge; hostId: OtfHostId; availability: OtfAvailability | null }) {
  const labels = Object.fromEntries((availability?.behaviors ?? []).map(behavior => [behavior.criterion_id, behavior.label]));
  const text = shapeBadgeText(badge, hostId, labels);
  if (text === null) return null;
  const host = availability?.hosts.find(option => option.host_id === hostId);
  return <div>
    <p className="factory-badge">{text.headline}</p>
    {text.detail !== null && <p className="factory-note">{text.detail}</p>}
    {badge.outcome === "proven" && host !== undefined && <p className="factory-note">{typicalSentence(host)}</p>}
  </div>;
}

export interface ShapeAlternativesViewProps {
  shapes: readonly BugShape[];
  badges: readonly OtfShapeBadge[];
  hostId: OtfHostId;
  selectedShapeId: string;
  availability: OtfAvailability | null;
  disabled?: boolean;
  onPick: (shape: BugShape) => void;
}

/** Suggestions stay advisory; picking one writes another card, and accepting that card is separate. */
export function ShapeAlternativesView({ shapes, badges, hostId, selectedShapeId, availability, disabled = false, onPick }: ShapeAlternativesViewProps) {
  const alternatives = orderShapesByBadge(shapes, badges).filter(({ shape, badge }) => shape.id !== selectedShapeId && isBuildableBadge(badge));
  if (alternatives.length === 0) return null;
  return <section>
    <p>{SHAPE_BADGE_COPY.disagreement}</p>
    <ul className="designer-list">{alternatives.map(({ shape, badge }) => <li key={shape.id} className="designer-card">
      <button type="button" disabled={disabled} onClick={() => { onPick(shape); }}>{shape.title}</button>
      {badge !== null && <ShapeBadgeView badge={badge} hostId={hostId} availability={availability} />}
    </li>)}</ul>
  </section>;
}
