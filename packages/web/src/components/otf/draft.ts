import type { AssistClient } from "../../assist/client.ts";
import { OtfClientError, type AcceptedOtfInput, type OtfClient } from "../../otf/client.ts";
import { OTF_OPEN_CRITERION_ID, SENTENCE_MAX_CHARS, SENTENCE_MIN_CHARS, type OtfAvailability, type OtfClassification, type OtfCreateJob, type OtfCriterionId, type OtfHostId, type OtfOpenRule, type OtfSpecCard } from "../../otf/contract.ts";
import { describeAssistFailure, type CustomBuildDesign } from "../bug-designer.tsx";
import { ruleProblem, sentenceProblem, specFromDesigner, specProblem } from "./guided.tsx";

export interface OtfDraftView {
  criterionId: OtfCriterionId | null;
  sentence: string;
  spec: OtfSpecCard | null;
  classification: OtfClassification | null;
  rule: OtfOpenRule | null;
  busy: boolean;
  classificationRequired: boolean;
  message: string | null;
}
const emptyDraft = (): OtfDraftView => ({ criterionId: null, sentence: "", spec: null, classification: null, rule: null, busy: false, classificationRequired: false, message: null });
const offered = (availability: OtfAvailability, criterion: OtfCriterionId | null) => availability.behaviors.find(option => option.criterion_id === criterion && availability.hosts.some(host => host.offered && host.host_id === option.host_id));

/** Availability is the browser's feature signal; an absent open option cannot promise classify. */
export function classificationAvailable(availability: OtfAvailability | null): boolean {
  return availability?.enabled === true && offered(availability, OTF_OPEN_CRITERION_ID) !== undefined;
}

export function designerSentence(query: string, title: string): string {
  const text = Array.from(query.trim()).length < SENTENCE_MIN_CHARS ? title.trim() : query.trim();
  return Array.from(text).slice(0, SENTENCE_MAX_CHARS).join("");
}

/** Editable pre-accept state only. This controller has no create, stop or validation capability. */
export class OtfDraftController {
  private view = emptyDraft();
  private readonly listeners = new Set<() => void>();
  private readonly designer: Pick<AssistClient, "bugSpec">;
  private readonly classifier: Pick<OtfClient, "classify">;
  private readonly onSignedOut: () => void;
  constructor(designer: Pick<AssistClient, "bugSpec">, classifier: Pick<OtfClient, "classify">, onSignedOut: () => void = () => undefined) {
    this.designer = designer; this.classifier = classifier; this.onSignedOut = onSignedOut;
  }
  snapshot = (): OtfDraftView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: Partial<OtfDraftView>): void { this.view = { ...this.view, ...next }; for (const listener of this.listeners) listener(); }
  pick(criterionId: OtfCriterionId): void {
    if (this.view.busy) return;
    if (this.view.spec !== null && this.view.classification !== null && criterionId === OTF_OPEN_CRITERION_ID) {
      this.update({ criterionId, rule: this.view.rule ?? { family: this.view.classification.family ?? "data_handling", observable_failure: "", failure_code: "" } });
    } else if (criterionId !== this.view.criterionId) this.update({ ...emptyDraft(), criterionId, sentence: this.view.sentence });
  }
  setSentence(sentence: string): void { if (!this.view.busy) this.update({ ...emptyDraft(), criterionId: this.view.criterionId, sentence }); }
  setSpec(spec: OtfSpecCard): void { if (!this.view.busy) this.update({ spec: structuredClone(spec) }); }
  setRule(rule: OtfOpenRule): void { if (!this.view.busy) this.update({ rule: { ...rule } }); }
  restore(request: OtfCreateJob | null): void {
    if (this.view.busy) return;
    this.update(request === null ? emptyDraft() : { ...emptyDraft(), criterionId: request.criterion_id, sentence: request.sentence, spec: structuredClone(request.spec), rule: request.rule === undefined ? null : { ...request.rule } });
  }
  private async classify(availability: OtfAvailability, hostId: OtfHostId): Promise<void> {
    const spec = this.view.spec;
    if (spec === null) return;
    const classification = await this.classifier.classify({ sentence: this.view.sentence.trim(), spec: structuredClone(spec), host_id: hostId });
    if (classification.refusal !== null) { this.update({ classification, rule: null }); return; }
    const buildable = classification.buildable.filter(option => offered(availability, option.criterion_id) !== undefined);
    const criterionId = buildable.find(option => option.criterion_id === classification.proven_criterion_id)?.criterion_id ?? buildable[0]?.criterion_id ?? null;
    this.update({ classification, criterionId, rule: classification.rule === null ? null : { ...classification.rule },
      message: criterionId === null ? "The classified behavior is not offered right now. The catalog remains available." : null });
  }
  private failure(error: unknown): void {
    if (error instanceof OtfClientError && error.code === "signed_out") this.onSignedOut();
    this.update({ message: error instanceof OtfClientError ? `${error.code}: ${error.message}` : "The spec designer could not respond. No custom build has started." });
  }
  async design(availability: OtfAvailability | null, signedIn: boolean): Promise<void> {
    if (this.view.busy || !signedIn || !availability?.enabled || sentenceProblem(this.view.sentence) !== null) return;
    const behavior = offered(availability, this.view.criterionId);
    if (behavior === undefined) return;
    // With the open feature off, SPEC 8.2 preserves the existing proven design flow.
    const classificationRequired = classificationAvailable(availability);
    this.update({ busy: true, message: null, spec: null, classification: null, rule: null, classificationRequired });
    try {
      const result = await this.designer.bugSpec({ title: behavior.label, summary: this.view.sentence.trim(), sources: [] }, behavior.host_id);
      if (!result.ok) {
        if (result.failure.code === "signed_out") this.onSignedOut();
        this.update({ message: describeAssistFailure(result.failure) }); return;
      }
      this.update({ spec: specFromDesigner(result.value.spec) });
      if (classificationRequired) await this.classify(availability, behavior.host_id);
    } catch (error) { this.failure(error); }
    finally { this.update({ busy: false }); }
  }
  async handoff(design: CustomBuildDesign, availability: OtfAvailability | null, signedIn: boolean): Promise<void> {
    if (this.view.busy || !signedIn || !availability?.enabled || !classificationAvailable(availability)) return;
    const spec = specFromDesigner(design.spec);
    const sentence = designerSentence(design.query, spec.title);
    this.update({ ...emptyDraft(), busy: true, classificationRequired: true, spec, sentence });
    try {
      if (specProblem(spec) !== null || sentenceProblem(sentence) !== null) {
        this.update({ message: "Review the card and sentence before classifying this custom design." }); return;
      }
      await this.classify(availability, design.hostId);
    } catch (error) { this.failure(error); }
    finally { this.update({ busy: false }); }
  }
  acceptedInput(availability: OtfAvailability | null, signedIn: boolean): AcceptedOtfInput | null {
    const { busy, sentence, spec, classification, classificationRequired, criterionId, rule } = this.view;
    if (busy || !signedIn || !availability?.enabled || spec === null || specProblem(spec) !== null || sentenceProblem(sentence) !== null
      || classification?.refusal != null || (classificationRequired && classification === null)) return null;
    const behavior = offered(availability, criterionId);
    if (behavior === undefined || (criterionId === OTF_OPEN_CRITERION_ID && (rule === null || ruleProblem(rule) !== null))) return null;
    return structuredClone({ host_id: behavior.host_id, criterion_id: behavior.criterion_id, sentence: sentence.trim(), spec,
      ...(criterionId === OTF_OPEN_CRITERION_ID && rule !== null ? { rule } : {}) });
  }
}
