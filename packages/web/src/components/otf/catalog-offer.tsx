export function CatalogOffer({ onStart, disabled, requestId, ready, message }: { onStart: () => void; disabled: boolean; requestId: string | null; ready: boolean; message: string | null }) {
  return <section className="factory-panel" aria-label="Catalog alternative"><h2>{ready ? "Your catalog bug is ready" : "Catalog alternative"}</h2>
    <p>While this builds, start the closest pre-qualified catalog bug now (about 5 min, about $0.40 from the shared judge budget).</p>
    <p>This is a pre-qualified catalog bug, re-verified for your request. It starts only when you choose it.</p>
    {requestId === null && !ready && <button type="button" disabled={disabled} onClick={onStart}>Start the closest catalog bug</button>}
    {requestId !== null && !ready && <p>Your catalog request is saved. Check its status in the catalog request panel; a missing response does not prove that it started.</p>}
    {message !== null && <p role="status">{message}</p>}
  </section>;
}
