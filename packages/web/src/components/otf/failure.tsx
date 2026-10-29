import type { OtfJobStatus, OtfOutcome } from "../../otf/contract.ts";
const messages: Record<Exclude<OtfOutcome, "delivered">, string> = {
  not_qualified: "No lane produced a bug that passed all six cells in 3 rounds.",
  time_limit: "The custom build reached its time limit.", spend_limit: "The custom build reached its model spend limit.", cancelled: "The custom build was cancelled.",
  builder_start_failed: "Error: the builder machine could not start.", builder_unavailable: "Error: the builder became unavailable.", builder_lost: "Error: contact with the builder was lost.", error: "Error: an infrastructure failure stopped the custom build.",
};
export function FailureView({ status }: { status: OtfJobStatus }) {
  if (status.state !== "finished" || status.outcome === null || status.outcome === "delivered") return null;
  return <section className="factory-panel" aria-label="Custom build outcome"><h2>{messages[status.outcome]}</h2>{status.reason !== null && <p>{status.reason}</p>}<p>The lane board shows the last recorded rounds and feedback. The catalog remains available.</p></section>;
}
