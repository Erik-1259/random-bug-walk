"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { assistClient, type AssistClient } from "../../assist/client.ts";
import type { FactoryController } from "../../factory/client.ts";
import { formatUsd } from "../../factory/format.ts";
import { OtfController, otfClient } from "../../otf/client.ts";
import { OTF_CRITERION_IDS, type OtfAvailability, type OtfCriterionId, type OtfJobStatus, type OtfSpecCard } from "../../otf/contract.ts";
import { describeAssistFailure } from "../bug-designer.tsx";
import { CatalogOffer } from "./catalog-offer.tsx";
import { closestCatalogInput, startCatalogRequest } from "./catalog-start.tsx";
import { CertificateView } from "./certificate.tsx";
import { FailureView } from "./failure.tsx";
import { BehaviorPickerView, SpecAcceptView, sentenceProblem, specFromDesigner, specProblem } from "./guided.tsx";
import { LaneBoard } from "./lane-board.tsx";

export interface OtfWorkspaceViewProps {
  availability: OtfAvailability | null;
  status: OtfJobStatus | null;
  pending: boolean;
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
  catalog: ComponentProps<typeof CatalogOffer>;
}

export function OtfWorkspaceView(props: OtfWorkspaceViewProps) {
  const { availability, status, pending, busy, designing, signedIn } = props;
  const enabled = availability?.enabled === true;
  const validationOpen = status?.validation?.state === "queued" || status?.validation?.state === "running";
  return <section aria-labelledby="otf-heading">
    <div className="factory-panel"><h2 id="otf-heading">Build a custom bug</h2>
      {!enabled && <p role="status">{availability === null ? "Custom build availability has not been confirmed. No new work has started." : "Custom builds are offline right now. The catalog is available."}</p>}
      {props.message !== null && <p role="alert">{props.message}</p>}
      <button type="button" disabled={busy || designing} onClick={props.onRefresh}>Refresh custom build</button>
      {enabled && status === null && !pending && <>
        <BehaviorPickerView behaviors={availability.behaviors} criterionId={props.criterionId} sentence={props.sentence} signedIn={signedIn} busy={busy || designing} onBehavior={props.onBehavior} onSentence={props.onSentence} onDesign={props.onDesign} />
        {props.spec !== null && <SpecAcceptView spec={props.spec} signedIn={signedIn} busy={busy || designing} onChange={props.onSpec} onAccept={props.onAccept} />}
      </>}
      {designing && <p role="status">Writing your spec card with Nemotron 3 Super. No custom build has started.</p>}
      {pending && <p>Your accepted custom build is saved in this browser. Reloading or retrying retains the same identity.</p>}
      {props.canRetryCreate && <button type="button" disabled={busy || !signedIn} onClick={props.onRetry}>Retry the same custom build</button>}
      {status === null && props.canNewDraft && <button type="button" disabled={busy} onClick={props.onNew}>Edit custom design</button>}
    </div>
    {status !== null && <>
      <LaneBoard status={status} availability={availability} disabled={busy || !signedIn} onStop={props.onStop} />
      <FailureView status={status} />
      <CertificateView status={status} disabled={busy || !signedIn} onValidate={props.onValidate} />
      {status.state === "finished" && <button type="button" disabled={busy || validationOpen} onClick={props.onNew}>Design another custom bug</button>}
    </>}
    <CatalogOffer {...props.catalog} />
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
    setController(instance);
  }, []);
  if (controller === null) return <p role="status">Checking custom build availability. No new work has started.</p>;
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

  const selected = criterionId ?? view.availability?.behaviors[0]?.criterion_id ?? null;
  const acceptedCriterion = view.status?.criterion_id ?? view.pendingRequest?.criterion_id ?? selected ?? OTF_CRITERION_IDS[0];
  const catalogId = view.catalogRequestId ?? draftCatalogId;
  const input = closestCatalogInput(catalog.capabilities, acceptedCriterion);
  const matchesCatalog = catalogId !== null && catalog.status?.request_id === catalogId;
  const ready = matchesCatalog && catalog.status?.state === "finished" && catalog.status.cases.length > 0;
  const design = async () => {
    const behavior = view.availability?.behaviors.find(option => option.criterion_id === selected);
    if (designLock.current || view.busy || !catalog.signedIn || !view.availability?.enabled || behavior === undefined || sentenceProblem(sentence) !== null) return;
    designLock.current = true;
    setDesigning(true); setDesignError(null); setSpec(null);
    try {
      const result = await designer.bugSpec({ title: behavior.label, summary: sentence.trim(), sources: [] }, "task-report");
      if (result.ok) setSpec(specFromDesigner(result.value.spec));
      else setDesignError(describeAssistFailure(result.failure));
    } catch { setDesignError("The spec designer could not respond. No custom build has started."); }
    finally { designLock.current = false; setDesigning(false); }
  };
  const accept = async () => {
    if (designLock.current || !catalog.signedIn || !view.availability?.enabled || selected === null || spec === null || sentenceProblem(sentence) !== null || specProblem(spec) !== null) return;
    await controller.create({ criterion_id: selected, sentence: sentence.trim(), spec, ...(catalogId === null ? {} : { catalog_request_id: catalogId }) });
  };
  const startCatalog = async () => {
    if (catalogLock.current || catalogId !== null) return;
    catalogLock.current = true; setCatalogStarting(true); setCatalogError(null);
    try {
      const id = await startCatalogRequest(catalogController, acceptedCriterion);
      setDraftCatalogId(id);
      if (controller.snapshot().pendingRequest !== null) await controller.setCatalogRequestId(id);
    } catch (error) { setCatalogError(error instanceof Error ? error.message : "The catalog request could not start. Review its status below."); }
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
    busy={view.busy || view.validationPending} designing={designing} signedIn={catalog.signedIn} criterionId={selected} sentence={sentence} spec={spec}
    message={designError ?? view.message} canRetryCreate={view.canRetryCreate} canNewDraft={view.canNewDraft}
    onBehavior={value => { setCriterion(value); setSpec(null); setDesignError(null); }} onSentence={value => { setSentence(value); setSpec(null); setDesignError(null); }} onSpec={setSpec}
    onDesign={() => { void design(); }} onAccept={() => { void accept(); }} onRetry={() => { void controller.retryCreate(); }} onRefresh={() => { void controller.initialize(); }}
    onStop={() => { void controller.stop(); }} onValidate={() => { void controller.validate(); }} onNew={() => { void newDraft(); }}
    catalog={{ onStart: () => { void startCatalog(); }, requestId: catalogId, ready, disabled: catalogStarting || catalog.busy || !catalog.signedIn || catalog.requestId !== null || input === null || catalog.capabilities?.service.state !== "available",
      message: catalogError ?? (catalog.requestId !== null && catalog.requestId !== catalogId ? "A catalog request is already saved on this page. Resume it below before starting another." : input === null ? "No matching catalog entry is available right now." : `The catalog request can spend up to ${formatUsd(input.budget_microusd, "down")} from the shared judge budget. Custom model spend is separate.`) }} />;
}
