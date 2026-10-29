import { OTF_HOST_DEFAULTS, hostCalendarOpen, type OtfAvailability, type OtfJobStatus, type OtfOutcome } from "../../otf/contract.ts";
import { calendarWindowMs } from "../../otf/client.ts";
import { calendarSentence, notQualifiedSentence, reopenSentence } from "./host-copy.tsx";
const messages: Record<Exclude<OtfOutcome, "delivered" | "not_qualified">, string> = {
  time_limit: "The custom build reached its time limit.", spend_limit: "The custom build reached its model spend limit.", cancelled: "The custom build was cancelled.",
  builder_start_failed: "Error: the builder machine could not start.", builder_unavailable: "Error: the builder became unavailable.", builder_lost: "Error: contact with the builder was lost.", error: "Error: an infrastructure failure stopped the custom build.",
};
/** A job that was never claimed and finished on its host's calendar. Only what the status shows: it did not start. */
function calendarStop(status: OtfJobStatus): string | null {
  const calendar = calendarSentence(status.host_id);
  return status.outcome === "builder_unavailable" && status.deadline_at === null && calendar !== null && status.reason?.includes(calendar) === true ? calendar : null;
}
export function FailureView({ status, availability = null, nowMs = Date.now() }: { status: OtfJobStatus; availability?: OtfAvailability | null; nowMs?: number }) {
  if (status.state !== "finished" || status.outcome === null || status.outcome === "delivered") return null;
  const calendar = calendarStop(status);
  if (calendar !== null) {
    const deadlineMin = availability?.hosts.find(host => host.host_id === status.host_id)?.deadline_min ?? OTF_HOST_DEFAULTS[status.host_id].deadline_ms / 60_000;
    // The open-again date only while the calendar still blocks a new build; a past failure keeps its reason alone.
    const reopen = hostCalendarOpen(status.host_id, nowMs, nowMs + calendarWindowMs(deadlineMin)) ? null : reopenSentence(status.host_id, deadlineMin, nowMs);
    return <section className="factory-panel" aria-label="Custom build outcome"><h2>This custom build did not start: {calendar}</h2>
      {reopen !== null && <p>{reopen}</p>}<p>The closest catalog bug is offered below.</p></section>;
  }
  const heading = status.outcome === "not_qualified" ? notQualifiedSentence(status.host_id) : messages[status.outcome];
  return <section className="factory-panel" aria-label="Custom build outcome"><h2>{heading}</h2>{status.reason !== null && <p>{status.reason}</p>}<p>The lane board shows the last recorded rounds and feedback. The catalog remains available.</p></section>;
}
