import { ADMISSION_EVIDENCE, OTF_OPEN_CRITERION_ID, type OtfJobStatus } from "../../otf/contract.ts";
import { formatExactUsd } from "../../factory/format.ts";
import { AdmissionStrip } from "./admission-strip.tsx";
import { validationSentence } from "./host-copy.tsx";
import { SixCellGrid } from "./six-cell-grid.tsx";
export function CertificateView({ status, onValidate, disabled, unconfirmed = false, refusalLines = null }: { status: OtfJobStatus; onValidate: () => void; disabled: boolean; unconfirmed?: boolean; refusalLines?: readonly string[] | null }) {
  if (status.state !== "finished" || status.outcome !== "delivered") return null;
  const certificate = status.certificate;
  const validation = status.validation;
  return <section className="factory-panel" aria-label="Custom build certificate"><h2>Certificate and downloads</h2>
    {certificate !== null ? <>
      {certificate.host_id === "umami"
        ? <><p>Qualified on the RBW builder (Nebius VM) with the local runner&apos;s admission sequence (docs/admission-rules.md) on the pinned Umami kit image with this build&apos;s checks, 4 vCPU / 8 GB per copy. Development evidence, not an RBW release.</p><p>{ADMISSION_EVIDENCE}</p></>
        : <p>Qualified by the RBW harness on the RBW builder (Nebius VM): six cells, pinned task-report kit image, 4 vCPU / 8 GB per copy, then confirmed in a second round.</p>}
      {certificate.criterion.criterion_id === OTF_OPEN_CRITERION_ID && certificate.rule !== undefined && <section aria-label="Open behavior rule">
        <h3>Open behavior (not measured yet)</h3>
        <dl><dt>Family</dt><dd>{certificate.rule.family}</dd><dt>Observable failure</dt><dd>{certificate.rule.observable_failure}</dd><dt>Failure code</dt><dd><code>{certificate.rule.failure_code}</code></dd></dl>
      </section>}
      <p>Designer model: {certificate.designer.model}. Implementer: {certificate.implementer.agent}, {certificate.implementer.model} on Nebius Token Factory; {certificate.implementer.lane_id}, {certificate.implementer.rounds_used} {certificate.implementer.rounds_used === 1 ? "round" : "rounds"}.</p>
      <SixCellGrid cells={certificate.qualification.cells} label="Qualification cells"/>
      {certificate.qualification.confirmation_cells !== null && <SixCellGrid cells={certificate.qualification.confirmation_cells} label="Confirmation cells"/>}
      {certificate.host_id === "umami" && <AdmissionStrip admission={certificate.qualification.admission} label="Admission result"/>}
      <p>Model spend: {formatExactUsd(certificate.spend.model_microusd)} (upper bound); tokens in: {certificate.spend.tokens_in}; tokens out: {certificate.spend.tokens_out}; lanes: {certificate.spend.lanes}.</p>
      <p>Started: <time dateTime={certificate.timings.started_at}>{certificate.timings.started_at}</time>. Qualified: <time dateTime={certificate.timings.qualified_at}>{certificate.timings.qualified_at}</time>. Wall time: {certificate.timings.wall_ms / 1000} seconds.</p>
      <dl><dt>Accepted spec SHA-256</dt><dd><code>{certificate.spec_sha256}</code></dd><dt>Agent bundle SHA-256</dt><dd><code>{certificate.bundles.agent_sha256}</code></dd><dt>Grader bundle SHA-256</dt><dd><code>{certificate.bundles.grader_sha256}</code></dd><dt>Kit image</dt><dd><code>{certificate.harness.kit_image_id}</code></dd>
        {certificate.host_id === "umami" && <><dt>Runtime image digest</dt><dd><code>{certificate.harness.runtime_image_digest}</code></dd></>}
        <dt>Harness SHA-256</dt><dd><code>{certificate.harness.harness_sha256}</code></dd></dl>
      <p>{certificate.received?.sha256_verified === true ? "Bundle hashes checked by the server." : "Server hash receipt not available."}</p>
    </> : <p>Certificate details are unavailable.</p>}
    <ul>{status.artifacts.map(part => <li key={part.part}><a href={part.download_path} download={part.filename}>{part.part === "agent" ? "Agent bundle" : part.part === "grader" ? "Grader bundle" : "Certificate"}</a> — {part.size} bytes; SHA-256 <code>{part.sha256}</code></li>)}</ul>
    <p>Agent bundle: the buggy app and a symptom-level incident; no checks, fix or spec.</p>
    <p>Model-written checks: the grader bundle contains evaluator code, the answer key, reference fix and accepted card. Keep it separate from the agent bundle.</p>
    <p>{validationSentence(status.host_id)}</p>
    <button type="button" onClick={onValidate} disabled={disabled || validation?.state === "queued" || validation?.state === "running"}>Validate stored bundles</button>
    {unconfirmed && <p role="status">Your validation request has no answer yet. Refresh to check it, or validate again: a validation already queued is answered, not repeated.</p>}
    {refusalLines !== null && <p role="status">Validation was not started. {refusalLines.join(" ")}</p>}
    {validation !== null && <section aria-label="Bundle validation"><p role="status">Validation: {validation.state}</p><p>{validation.where}</p><SixCellGrid cells={validation.cells} label="Validation cells"/><AdmissionStrip admission={validation.admission} label="Validation admission result"/></section>}
  </section>;
}
