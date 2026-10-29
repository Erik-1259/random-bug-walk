import type { LaneView } from "../../otf/contract.ts";
import { formatExactUsd } from "../../factory/format.ts";
import { AdmissionStrip } from "./admission-strip.tsx";
import { SixCellGrid } from "./six-cell-grid.tsx";
export function LaneCard({ lane }: { lane: LaneView }) {
  return <article className="designer-card"><h3>{lane.lane_id}: {lane.model_label}</h3><p>Model: <code>{lane.model}</code></p>
    <p>Stage: {lane.stage.replaceAll("_", " ")} · Iteration: {lane.iteration}</p>
    <p>Files written — change: {lane.files.change ? "yes" : "no"}; added checks: {lane.files.checks}; fix: {lane.files.fix ? "yes" : "no"}.</p>
    <p>Tokens in: {lane.meter.tokens_in}; tokens out: {lane.meter.tokens_out}; requests: {lane.meter.requests}; model spend: {formatExactUsd(lane.meter.cost_microusd)}.</p>
    {lane.outcome !== null && <p>Lane outcome: {lane.outcome.replaceAll("_", " ")}</p>}
    {lane.rounds.map((round, index) => <section key={`${String(round.iteration)}-${round.kind}-${String(index)}`}><h4>Iteration {round.iteration}: {round.kind.replaceAll("_", " ")}</h4>
      <p>Result: {round.result.replaceAll("_", " ")}</p><SixCellGrid cells={round.cells} label={`${lane.lane_id} ${round.kind} cells`}/><AdmissionStrip admission={round.admission} label={`${lane.lane_id} ${round.kind} admission`}/>
      <ul>{round.feedback.map((line, i) => <li key={i}>{line}</li>)}</ul>
      <p>Agent time: {round.goose_ms === null ? "not recorded" : `${String(round.goose_ms / 1000)} s`}; harness time: {round.qualify_ms === null ? "not recorded" : `${String(round.qualify_ms / 1000)} s`}.</p>
    </section>)}
  </article>;
}
