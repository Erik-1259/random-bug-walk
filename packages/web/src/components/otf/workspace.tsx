"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { assistClient, type AssistClient } from "../../assist/client.ts";
import type { FactoryController } from "../../factory/client.ts";
import { formatUsd } from "../../factory/format.ts";
import { canonicalJson } from "../../otf/canonical.ts";
import { OtfController, otfClient } from "../../otf/client.ts";
import { OTF_CRITERION_IDS, type OtfAvailability, type OtfCreateJob, type OtfCreateRefusal, type OtfCriterionId, type OtfJobStatus, type OtfSpecCard } from "../../otf/contract.ts";
import { describeAssistFailure } from "../bug-designer.tsx";
import { CatalogOffer, type CatalogOfferProps } from "./catalog-offer.tsx";
import { CatalogStartPending, closestCatalogInput, startCatalogRequest } from "./catalog-start.tsx";
import { CertificateView } from "./certificate.tsx";
import { FailureView } from "./failure.tsx";
import { BehaviorPickerView, SpecAcceptView, sentenceProblem, specFromDesigner, specProblem } from "./guided.tsx";
import { hostRefusalLines, validationRefusalLines } from "./host-copy.tsx";
import { LaneBoard } from "./lane-board.tsx";

export interface OtfWorkspaceViewProps {
  availability: OtfAvailability | null;
  status: OtfJobStatus | null;
  pending: boolean;
  /** The saved accepted create body, kept after a refusal. */
  pendingRequest?: OtfCreateJob | null;
  refusal?: OtfCreateRefusal | null;
  stopRequested?: boolean;
  /** A validation request was sent but no answer or new validation has been seen yet. */
  validationPending?: boolean;
  /** The last validation request from this tab was refused host_unavailable. */
  validationRefused?: boolean;
  /** The clock for calendar hints. */
  nowMs?: number;
  busy: boolean;
  designing: boolean;
  signedIn: boolean;
  criterionId: OtfCriterionId | null;
  sentence: string;
  spec: OtfSpecCard | null;
  message: string | null;
  canRetryCreate: boolean;
  canNewDraft: boolean;
  onBehavior: (criterion: OtfCriterionId) => void;
  onSentence: (sentence: string) => void;
  onSpec: (spec: OtfSpecCard) => void;
  onDesign: () => void;
  onAccept: () => void;
  onRetry: () => void;
  onRefresh: () => void;
  onStop: () => void;
  onValidate: () => void;
  onNew: () => void;
  catalog: Omit<CatalogOfferProps, "building" | "fallback">;
}

export function OtfWorkspaceView(props: OtfWorkspaceViewProps) {
  const { availability, status, pending, busy, designing, signedIn } = props;
  const { pendingRequest = null, refusal = null, stopRequested = false, validationPending = false, validationRefused = false, nowMs = Date.now() } = props;
  // OTF is hidden when it is not configured: an unavailable or failed availability read with nothing saved.
  if (availability === null && status === null && !pending) return null;
  const enabled = availability?.enabled === true;
  const validationOpen = status?.validation?.state === "queued" || status?.validation?.state === "running";
  const refused = status === null && pending && props.canNewDraft;
  const hostRefused = refused && refusal === "host_unavailable" && pendingRequest !== null;
  const building = status === null ? pending && !refused : status.state !== "finished";
  const fallback = hostRefused || (status?.state === "finished" && status.outcome !== "delivered");
  const picked = availability?.behaviors.find(behavior => behavior.criterion_id === props.criterionId);
  const pickedHost = availability?.hosts.find(host => host.offered && host.host_id === picked?.host_id) ?? null;
  return <section aria-labelledby="otf-heading">
    <div className="factory-panel"><h2 id="otf-heading">Build a custom bug</h2>
      {!enabled && <p role="status">{availability === null ? "Custom build availability has not been confirmed. No new work has started." : "Custom builds are offline right now. The catalog is available."}</p>}
      {props.message !== null && <p role="alert">{props.message}</p>}
      <button type="button" disabled={busy || designing} onClick={props.onRefresh}>Refresh custom build</button>
      {enabled && status === null && !pending && <>
        <BehaviorPickerView behaviors={availability.behaviors} hosts={availability.hosts} nowMs={nowMs} criterionId={props.criterionId} sentence={props.sentence} signedIn={signedIn} busy={busy || designing} onBehavior={props.onBehavior} onSentence={props.onSentence} onDesign={props.onDesign} />
        {props.spec !== null && pickedHost !== null && <SpecAcceptView spec={props.spec} host={pickedHost} signedIn={signedIn} busy={busy || designing} onChange={props.onSpec} onAccept={props.onAccept} />}
      </>}
      {designing && <p role="status">Writing your spec card with Nemotron 3 Super. No custom build has started.</p>}
      {hostRefused ? <section aria-label="Custom build not started">
        <p role="status">This custom build was not started. {hostRefusalLines(pendingRequest.host_id, availability, nowMs).join(" ")}</p>
        <p>Your accepted spec card and sentence are kept. Card: {pendingRequest.spec.title}. Sentence: {pendingRequest.sentence}</p>
      </section> : pending && <p>Your accepted custom build is saved in this browser. Reloading or retrying retains the same identity.</p>}
      {props.canRetryCreate && <button type="button" disabled={busy || !signedIn} onClick={props.onRetry}>Retry the same custom build</button>}
      {status === null && props.canNewDraft && <button type="button" disabled={busy} onClick={props.onNew}>Edit custom design</button>}
    </div>
    {status !== null && <>
      <LaneBoard status={status} availability={availability} disabled={busy || !signedIn} onStop={props.onStop} stopRequested={stopRequested} />
      <FailureView status={status} availability={availability} nowMs={nowMs} />
      <CertificateView status={status} disabled={busy || !signedIn} onValidate={props.onValidate} unconfirmed={validationPending && !validationOpen} refusalLines={validationRefused ? validationRefusalLines(status.host_id, availability, nowMs) : null} />
      {status.state === "finished" && <button type="button" disabled={busy || validationOpen || validationPending} onClick={props.onNew}>Design another custom bug</button>}
    </>}
    <CatalogOffer {...props.catalog} building={building} fallback={fallback} />
  </section>;
}

export function OtfWorkspace({ catalogController, onAvailability, designer = assistClient }: { catalogController: FactoryController; onAvailability: (enabled: boolean) => void; designer?: AssistClient }) {
  const [controller, setController] = useState<OtfController | null>(null);
  useEffect(() => {
    const instance = new OtfController(otfClient, {
      getItem: key => window.localStorage.getItem(key),
      setItem: (key, value) => { window.localStorage.setItem(key, value); },
      removeItem: key => { window.localStorage.removeItem(key); },
    }, () => crypto.randomUUID());
    // A signed_out answer re-checks the shared session, which brings back the factory sign-in form.
    instance.onSignedOut = () => { void catalogController.initialize(); };
    setController(instance);
  }, [catalogController]);
  if (controller === null) return null;
  return <ConnectedOtf controller={controller} catalogController={catalogController} onAvailability={onAvailability} designer={designer} />;
}

function ConnectedOtf({ controller, catalogController, onAvailability, designer }: { controller: OtfController; catalogController: FactoryController; onAvailability: (enabled: boolean) => void; designer: AssistClient }) {
  const view = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const catalog = useSyncExternalStore(catalogController.subscribe, catalogController.snapshot, catalogController.snapshot);
  const [criterionId, setCriterion] = useState<OtfCriterionId | null>(null);
  const [sentence, setSentence] = useState("");
  const [spec, setSpec] = useState<OtfSpecCard | null>(null);
  const [designing, setDesigning] = useState(false);
  const [designError, setDesignError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draftCatalogId, setDraftCatalogId] = useState<string | null>(null);
  const [catalogConfirmed, setCatalogConfirmed] = useState(false);
  const [catalogStarting, setCatalogStarting] = useState(false);
  const designLock = useRef(false);
  const catalogLock = useRef(false);
  useEffect(() => { void controller.initialize(); }, [controller, catalog.signedIn]);
  useEffect(() => { onAvailability(view.availability?.enabled === true); }, [onAvailability, view.availability]);
  useEffect(() => {
    if (view.busy || !catalog.signedIn || !controller.needsPoll()) return;
    const timer = setTimeout(() => { void controller.poll(); }, controller.pollAfter());
    return () => { clearTimeout(timer); };
  }, [controller, view, catalog.signedIn]);

  // A pick whose host is no longer offered is cleared; the sentence stays.
  const behavior = view.availability?.behaviors.find(option => option.criterion_id === criterionId);
  const selected = behavior?.criterion_id ?? null;
  const acceptedCriterion = view.status?.criterion_id ?? view.pendingRequest?.criterion_id ?? selected ?? OTF_CRITERION_IDS[0];
  const catalogId = view.catalogRequestId ?? draftCatalogId;
  const input = closestCatalogInput(catalog.capabilities, acceptedCriterion);
  const matchesCatalog = catalogId !== null && catalog.status?.request_id === catalogId && input !== null && canonicalJson(catalog.status.interpretation.input) === canonicalJson(input);
  const ready = matchesCatalog && catalog.status?.state === "finished" && catalog.status.cases.length > 0;
  const design = async () => {
    if (designLock.current || view.busy || !catalog.signedIn || !view.availability?.enabled || behavior === undefined || sentenceProblem(sentence) !== null) return;
    designLock.current = true;
    setDesigning(true); setDesignError(null); setSpec(null);
    try {
      const result = await designer.bugSpec({ title: behavior.label, summary: sentence.trim(), sources: [] }, behavior.host_id);
      if (result.ok) setSpec(specFromDesigner(result.value.spec));
      else setDesignError(describeAssistFailure(result.failure));
    } catch { setDesignError("The spec designer could not respond. No custom build has started."); }
    finally { designLock.current = false; setDesigning(false); }
  };
  const accept = async () => {
    if (designLock.current || !catalog.signedIn || !view.availability?.enabled || behavior === undefined || spec === null || sentenceProblem(sentence) !== null || specProblem(spec) !== null) return;
    // Only a confirmed catalog start goes into the create body; an unconfirmed one stays a local link.
    const sent = catalogConfirmed ? catalogId : null;
    await controller.create({ host_id: behavior.host_id, criterion_id: behavior.criterion_id, sentence: sentence.trim(), spec, ...(sent === null ? {} : { catalog_request_id: sent }) });
    if (sent === null && catalogId !== null && controller.snapshot().pendingRequest !== null) await controller.setCatalogRequestId(catalogId);
  };
  const startCatalog = async () => {
    if (catalogLock.current || catalogId !== null) return;
    catalogLock.current = true; setCatalogStarting(true); setCatalogError(null);
    const link = async (id: string) => { setDraftCatalogId(id); if (controller.snapshot().pendingRequest !== null) await controller.setCatalogRequestId(id); };
    try {
      const id = await startCatalogRequest(catalogController, acceptedCriterion);
      setCatalogConfirmed(true); await link(id);
    } catch (error) {
      // An ambiguous start still saved its request: link it locally so the card follows it.
      if (error instanceof CatalogStartPending) await link(error.requestId);
      setCatalogError(error instanceof Error ? error.message : "The catalog request could not start. Review its status below.");
    }
    finally { catalogLock.current = false; setCatalogStarting(false); }
  };
  const newDraft = async () => {
    const refused = view.status === null ? view.pendingRequest : null;
    await controller.newDraft();
    if (controller.snapshot().pendingRequest !== null) return;
    setCriterion(refused?.criterion_id ?? null); setSentence(refused?.sentence ?? "");
    setSpec(refused?.spec ?? null); setDraftCatalogId(catalogId); setDesignError(null);
  };
  return <OtfWorkspaceView availability={view.availability} status={view.status} pending={view.pendingRequest !== null || view.jobId !== null}
    pendingRequest={view.pendingRequest} refusal={view.refusal} stopRequested={view.stopRequested} validationRefused={view.validationRefused} nowMs={Date.now()}
    busy={view.busy} validationPending={view.validationPending} designing={designing} signedIn={catalog.signedIn} criterionId={selected} sentence={sentence} spec={spec}
    message={designError ?? view.message} canRetryCreate={view.canRetryCreate} canNewDraft={view.canNewDraft}
    onBehavior={value => { setCriterion(value); setSpec(null); setDesignError(null); }} onSentence={value => { setSentence(value); setSpec(null); setDesignError(null); }} onSpec={setSpec}
    onDesign={() => { void design(); }} onAccept={() => { void accept(); }} onRetry={() => { void controller.retryCreate(); }} onRefresh={() => { void controller.initialize(); }}
    onStop={() => { void controller.stop(); }} onValidate={() => { void controller.validate(); }} onNew={() => { void newDraft(); }}
    catalog={{ onStart: () => { void startCatalog(); }, requestId: catalogId, ready, disabled: catalogStarting || catalog.busy || !catalog.signedIn || catalog.requestId !== null || input === null || catalog.capabilities?.service.state !== "available",
      message: catalogError ?? (catalog.requestId !== null && catalog.requestId !== catalogId ? "A catalog request is already saved on this page. Resume it below before starting another." : input === null ? "No matching catalog entry is available right now." : `The catalog request can spend up to ${formatUsd(input.budget_microusd, "down")} from the shared judge budget. Custom model spend is separate.`) }} />;
}
