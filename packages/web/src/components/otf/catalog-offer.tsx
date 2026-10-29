export interface CatalogOfferProps {
  onStart: () => void;
  disabled: boolean;
  requestId: string | null;
  ready: boolean;
  message: string | null;
  /** A pending or unfinished custom job exists, so "While this builds" is true. */
  building?: boolean;
  /** The custom build did not deliver or was refused: the card is the fallback. */
  fallback?: boolean;
}
export function CatalogOffer({ onStart, disabled, requestId, ready, message, building = false, fallback = false }: CatalogOfferProps) {
  return <section className="factory-panel" aria-label="Catalog alternative"><h2>{ready ? "Your catalog bug is ready" : fallback ? "Start the closest catalog bug" : "Catalog alternative"}</h2>
    <p>{building ? "While this builds, start the closest pre-qualified catalog bug now (about 5 min, about $0.40 from the shared judge budget)." : "You can start the closest pre-qualified catalog bug now (about 5 min, about $0.40 from the shared judge budget)."}</p>
    <p>This is a pre-qualified catalog bug, re-verified for your request. It starts only when you choose it.</p>
    {requestId === null && !ready && <button type="button" disabled={disabled} onClick={onStart}>Start the closest catalog bug</button>}
    {requestId !== null && !ready && <p>Your catalog request is saved. Check its status in the catalog request panel; a missing response does not prove that it started.</p>}
    {message !== null && <p role="status">{message}</p>}
  </section>;
}
