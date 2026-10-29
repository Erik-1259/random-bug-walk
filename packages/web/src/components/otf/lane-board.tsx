import type { OtfAvailability, OtfJobStatus } from "../../otf/contract.ts";
import { formatExactUsd } from "../../factory/format.ts";
import { LaneCard } from "./lane-card.tsx";
export function LaneBoard({ status, availability, onStop, disabled }: { status: OtfJobStatus; availability: OtfAvailability | null; onStop: () => void; disabled: boolean }) {
  const cold = availability?.typical.cold_start_min;
  const ran = status.state === "building" || status.outcome === "delivered";
  return <section className="factory-panel" aria-label="Custom build progress"><h2>Custom build progress</h2>
    <p role="status">{status.state === "starting_builder" ? "Starting the Nebius machine." : `Job: ${status.state}.`} {status.queue_position !== null && <>Queue position: {status.queue_position}.</>}</p>
    {status.state === "starting_builder" && cold !== null && cold !== undefined && <p>Starting the Nebius machine usually takes about {cold} minutes.</p>}
    {ran && <p>Built for your request by Goose with {status.winner?.model ?? status.lanes.map(lane => lane.model_label).join(", ")} on Nebius Token Factory. Spec card by Nemotron 3 Super.</p>}
    <p>Model spend so far: {formatExactUsd(status.spend.model_microusd)} (metered by the builder; an upper bound).</p>
    <p>Model spend cap: {formatExactUsd(status.spend.cap_microusd)}. Elapsed: {Math.floor(status.elapsed_ms / 1000)} seconds.</p>
    {status.state !== "finished" && <button type="button" disabled={disabled} onClick={onStop}>Stop custom build</button>}
    <div>{status.lanes.map(lane => <LaneCard key={lane.lane_id} lane={lane}/>)}</div>
  </section>;
}
