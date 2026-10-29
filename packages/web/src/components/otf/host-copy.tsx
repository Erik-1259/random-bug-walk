import { HOST_CALENDAR_BLOCKS, OTF_HOST_IDS, type OtfAvailability, type OtfHostAvailability, type OtfHostId } from "../../otf/contract.ts";
import { calendarWindowMs, formatUtcDate, nextCalendarOpen } from "../../otf/client.ts";

/** Sentence-initial host names for host copy. */
const HOST_NAMES: Readonly<Record<OtfHostId, string>> = { "task-report": "Task-report", umami: "Umami" };

export const UMAMI_PLACEMENT = "The builder places the bug in one of Umami's date-grouped reports that its harness supports, chosen to match your card where it can. It may differ from the report your card describes.";

/** Every host once, in contract order. */
export function orderedHosts(hosts: readonly OtfHostAvailability[]): OtfHostAvailability[] {
  return [...hosts].sort((a, b) => OTF_HOST_IDS.indexOf(a.host_id) - OTF_HOST_IDS.indexOf(b.host_id));
}

/** "Umami is unavailable on UTC days 2–5.", or null for a host without a calendar. */
export function calendarSentence(host: OtfHostId): string | null {
  const block = HOST_CALENDAR_BLOCKS[host];
  return block === undefined ? null : `${HOST_NAMES[host]} is unavailable on UTC days ${String(block.first_utc_day)}–${String(block.last_utc_day)}.`;
}

/** The open-again hint for a calendar-blocked host, or null when none is found. */
export function reopenSentence(host: OtfHostId, deadlineMin: number, nowMs: number): string | null {
  const open = nextCalendarOpen(host, nowMs, calendarWindowMs(deadlineMin));
  return open === null ? null : `They open again on ${formatUtcDate(open)} (UTC).`;
}

/** The reason line of a host that is not offered. It never explains the calendar. */
export function hostReasonLines(host: OtfHostAvailability, hosts: readonly OtfHostAvailability[], nowMs: number): string[] {
  const calendar = calendarSentence(host.host_id);
  if (host.unavailable_reason !== "calendar" || calendar === null) return [`${HOST_NAMES[host.host_id]} builds are offline right now.`];
  const others = orderedHosts(hosts).filter(other => other.offered && other.host_id !== host.host_id).map(other => HOST_NAMES[other.host_id]);
  const reopen = reopenSentence(host.host_id, host.deadline_min, nowMs);
  return [calendar, ...(reopen === null ? [] : [reopen]), others.length === 0 ? "The catalog is still available." : `${others.join(" and ")} builds and the catalog are still available.`];
}

/** Time copy from the host's measured typical only; the UI holds no minutes of its own. */
export function typicalSentence(host: OtfHostAvailability): string {
  const typical = host.typical;
  if (typical === null) return `Build times for ${host.label} are not measured yet. The board shows each step as it runs.`;
  const { median_min: median, p90_min: p90, samples, measured_on: on } = typical;
  return typical.source === "otf_jobs"
    ? `Usually about ${String(median)} minutes; 9 in 10 finished within ${String(p90)} minutes (${String(samples)} builds measured, last on ${on}). Your bug may take longer or not qualify.`
    : `In development runs, a qualifying build attempt took about ${String(median)} minutes, and 9 in 10 took at most ${String(p90)} minutes (${String(samples)} attempts, measured ${on}). Waiting, machine start-up and packaging add to that. Your bug may take longer or not qualify.`;
}

/** The host's own queue, or null when it is idle. */
export function hostQueueSentence(host: OtfHostAvailability): string | null {
  if (host.active_jobs === 0 && host.queued_jobs === 0) return null;
  return `${HOST_NAMES[host.host_id]} builds now: ${String(host.active_jobs)} running, ${String(host.queued_jobs)} waiting.`;
}

export function validationSentence(host: OtfHostId): string {
  return host === "umami" ? "Optional validation re-runs the admission sequence on the RBW builder from the stored bundles." : "Optional validation re-runs the six cells on the RBW builder.";
}

export function notQualifiedSentence(host: OtfHostId): string {
  return host === "umami" ? "No lane produced a bug that passed the admission sequence in 3 rounds." : "No lane produced a bug that passed all six cells in 3 rounds.";
}

export function HostReason({ host, hosts, nowMs }: { host: OtfHostAvailability; hosts: readonly OtfHostAvailability[]; nowMs: number }) {
  return <p role="status">{hostReasonLines(host, hosts, nowMs).join(" ")}</p>;
}

/** Why a create was refused host_unavailable, from the refreshed availability. Never worded as an error. */
export function hostRefusalLines(hostId: OtfHostId, availability: OtfAvailability | null, nowMs: number): string[] {
  const host = availability?.hosts.find(option => option.host_id === hostId);
  if (availability === null || host === undefined) return [`${HOST_NAMES[hostId]} builds are offline right now.`];
  return host.offered ? [`${HOST_NAMES[hostId]} builds were not available when you accepted.`] : hostReasonLines(host, availability.hosts, nowMs);
}
