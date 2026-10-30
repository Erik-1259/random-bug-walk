import { OTF_OPEN_CRITERION_ID, OTF_OPEN_TIME_COPY, type OtfAvailability, type OtfJobStatus } from "../../otf/contract.ts";
import { formatExactUsd } from "../../factory/format.ts";
import { UMAMI_PLACEMENT, typicalSentence } from "./host-copy.tsx";
import { LaneCard } from "./lane-card.tsx";
export function LaneBoard({ status, availability, onStop, disabled, stopRequested = false }: { status: OtfJobStatus; availability: OtfAvailability | null; onStop: () => void; disabled: boolean; stopRequested?: boolean }) {
  const open = status.criterion_id === OTF_OPEN_CRITERION_ID;
  const cold = availability?.cold_start_min;
  const host = availability?.hosts.find(option => option.host_id === status.host_id) ?? null;
  const ran = status.state === "building" || status.outcome === "delivered";
  const lanes = status.lanes.length > 0 ? status.lanes.length : host?.lanes.length ?? null;
  return <section className="factory-panel" aria-label="Custom build progress"><h2>Custom build progress</h2>
    <p role="status">{status.state === "starting_builder" ? "Starting the Nebius machine." : `Job: ${status.state}.`} {status.queue_position !== null && <>Queue position: {status.queue_position}.</>}</p>
    {status.state === "queued" && status.queue_position !== null && host !== null && host.active_jobs > 0 && <p>Another build is running. Yours is number {status.queue_position} in line.{!open && host.typical !== null && <> {typicalSentence(host)}</>}</p>}
    {!open && status.state === "starting_builder" && cold !== null && cold !== undefined && <p>Starting the Nebius machine usually takes about {cold} minutes.</p>}
    {open && <p>{OTF_OPEN_TIME_COPY}</p>}
    {lanes !== null && <p>Lanes for {host?.label ?? status.host_id}: {lanes}.</p>}
    {status.host_id === "umami" && <p>{UMAMI_PLACEMENT}</p>}
    {ran && <p>Built for your request by Goose with {status.winner?.model ?? status.lanes.map(lane => lane.model_label).join(", ")} on Nebius Token Factory. Spec card by Nemotron 3.5 Super.</p>}
    {stopRequested && status.outcome === "delivered" && <p role="status">Stopped after a lane won; the bug was delivered.</p>}
    <p>Model spend so far: {formatExactUsd(status.spend.model_microusd)} (metered by the builder; an upper bound).</p>
    <p>Model spend cap: {formatExactUsd(status.spend.cap_microusd)}. Elapsed: {Math.floor(status.elapsed_ms / 1000)} seconds.</p>
    {status.state !== "finished" && <button type="button" disabled={disabled} onClick={onStop}>Stop custom build</button>}
    <div>{status.lanes.map(lane => <LaneCard key={lane.lane_id} lane={lane}/>)}</div>
  </section>;
}
