import type { AssistClient } from "../../assist/client.ts";
import { canonicalJson } from "../../otf/canonical.ts";
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
  /** The host the card was written or handed off for; classify again uses it. */
  hostId: OtfHostId | null;
  /** The card or sentence changed after classification, so the shown classification was cleared. */
  stale: boolean;
  /** Why the last classify call gave no answer, in plain language. */
  classifyError: string | null;
}
const emptyDraft = (): OtfDraftView => ({ criterionId: null, sentence: "", spec: null, classification: null, rule: null, busy: false, classificationRequired: false, message: null, hostId: null, stale: false, classifyError: null });
const offered = (availability: OtfAvailability, criterion: OtfCriterionId | null) => availability.behaviors.find(option => option.criterion_id === criterion && availability.hosts.some(host => host.offered && host.host_id === option.host_id));

export const CLASSIFY_REVIEW_MESSAGE = "Review the card and sentence before classifying this custom design.";
/** SPEC 8.5: the classify route answers refused_topic for a security topic found before any model call. */
export const SECURITY_TOPIC_REASON = "This card or sentence names a security topic or holds code. Custom builds cover non-security bugs described in plain words only.";
const NO_ANSWER = "The classifier did not answer. No custom build has started. Try again in a moment.";

/** A classify failure in plain language; a refused_topic answer is a refusal instead, never a failure. */
export function classifyFailureText(error: unknown): string {
  if (!(error instanceof OtfClientError)) return NO_ANSWER;
  if (error.code === "signed_out") return "Your judge sign-in has ended. Sign in again, then try again. No custom build has started.";
  if (error.code === "invalid_request") return "The classifier could not read this card and sentence. Review them, then try again. No custom build has started.";
  return NO_ANSWER;
}

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
  /** A card that needs classification keeps its card on an edit, but its classification and rule no longer apply. */
  private edited(next: Partial<OtfDraftView>): void {
    const { classificationRequired, spec } = this.view;
    this.update(classificationRequired && spec !== null ? { ...next, classification: null, rule: null, stale: true, classifyError: null, message: null } : next);
  }
  pick(criterionId: OtfCriterionId): void {
    if (this.view.busy) return;
    const { spec, classification, classificationRequired, rule } = this.view;
    if (spec !== null && classification !== null && (criterionId === OTF_OPEN_CRITERION_ID || classification.buildable.some(option => option.criterion_id === criterionId))) {
      // Switching between the classified options keeps the card, the classification and any rule edits.
      this.update({ criterionId, rule: criterionId === OTF_OPEN_CRITERION_ID ? rule ?? { family: classification.family ?? "data_handling", observable_failure: "", failure_code: "" } : rule });
    } else if (spec !== null && classification === null && classificationRequired) this.update({ criterionId });
    else if (criterionId !== this.view.criterionId) this.update({ ...emptyDraft(), criterionId, sentence: this.view.sentence });
  }
  setSentence(sentence: string): void {
    if (this.view.busy) return;
    if (this.view.classificationRequired && this.view.spec !== null) this.edited({ sentence });
    else this.update({ ...emptyDraft(), criterionId: this.view.criterionId, sentence });
  }
  setSpec(spec: OtfSpecCard): void { if (!this.view.busy) this.edited({ spec: structuredClone(spec) }); }
  setRule(rule: OtfOpenRule): void { if (!this.view.busy) this.update({ rule: { ...rule } }); }
  /**
   * "Edit custom design" after a refused create: the accepted card comes back tied to its host and, when
   * classification applies, to the classification it was accepted with. An edit then needs classifying again.
   */
  restore(request: OtfCreateJob | null, availability: OtfAvailability | null): void {
    if (this.view.busy) return;
    if (request === null) { this.update(emptyDraft()); return; }
    const before = this.view;
    const rule = request.rule === undefined ? null : { ...request.rule };
    const classificationRequired = (request.criterion_id === OTF_OPEN_CRITERION_ID && rule !== null) || classificationAvailable(availability);
    // The classification still applies only to the unchanged card and sentence it was given for.
    const unchanged = before.spec !== null && canonicalJson(before.spec) === canonicalJson(request.spec) && before.sentence.trim() === request.sentence;
    const classification = classificationRequired && unchanged && before.classification?.refusal === null ? before.classification : null;
    this.update({ ...emptyDraft(), criterionId: request.criterion_id, sentence: request.sentence, spec: structuredClone(request.spec), rule, classificationRequired,
      hostId: unchanged && before.hostId !== null ? before.hostId : request.host_id, classification, stale: classificationRequired && classification === null });
  }
  private async classify(availability: OtfAvailability, hostId: OtfHostId): Promise<void> {
    const spec = this.view.spec;
    if (spec === null) return;
    let classification: OtfClassification;
    try {
      classification = await this.classifier.classify({ sentence: this.view.sentence.trim(), spec: structuredClone(spec), host_id: hostId });
    } catch (error) {
      if (error instanceof OtfClientError && error.code === "refused_topic") {
        // The same outcome as a model's security refusal: the reason, and the closest catalog bug.
        this.update({ classification: { family: null, proven_criterion_id: null, buildable: [], rule: null, refusal: { kind: "security", reason: SECURITY_TOPIC_REASON }, model: "" }, rule: null });
        return;
      }
      if (error instanceof OtfClientError && error.code === "signed_out") this.onSignedOut();
      this.update({ classifyError: classifyFailureText(error) });
      return;
    }
    if (classification.refusal !== null) { this.update({ classification, rule: null }); return; }
    const buildable = classification.buildable.filter(option => offered(availability, option.criterion_id) !== undefined);
    const criterionId = buildable.find(option => option.criterion_id === classification.proven_criterion_id)?.criterion_id ?? buildable[0]?.criterion_id ?? null;
    this.update({ classification, criterionId, rule: classification.rule === null ? null : { ...classification.rule },
      message: criterionId === null ? "The classified behavior is not offered right now. The catalog remains available." : null });
  }
  /** Classify the current card and sentence; the card stays on screen whatever the answer. */
  private async classifyCard(availability: OtfAvailability, hostId: OtfHostId): Promise<void> {
    const { spec, sentence } = this.view;
    if (spec === null || specProblem(spec) !== null || sentenceProblem(sentence) !== null) { this.update({ classifyError: CLASSIFY_REVIEW_MESSAGE }); return; }
    await this.classify(availability, hostId);
  }
  async design(availability: OtfAvailability | null, signedIn: boolean): Promise<void> {
    if (this.view.busy || !signedIn || !availability?.enabled || sentenceProblem(this.view.sentence) !== null) return;
    const behavior = offered(availability, this.view.criterionId);
    if (behavior === undefined) return;
    // With the open feature off, SPEC 8.2 preserves the existing proven design flow.
    const classificationRequired = classificationAvailable(availability);
    this.update({ busy: true, message: null, spec: null, classification: null, rule: null, classificationRequired, hostId: behavior.host_id, stale: false, classifyError: null });
    try {
      const result = await this.designer.bugSpec({ title: behavior.label, summary: this.view.sentence.trim(), sources: [] }, behavior.host_id);
      if (!result.ok) {
        // The proven-only flow shows the designer's failure only, as before the open behavior.
        if (classificationRequired && result.failure.code === "signed_out") this.onSignedOut();
        this.update({ message: describeAssistFailure(result.failure) }); return;
      }
      this.update({ spec: specFromDesigner(result.value.spec) });
      if (classificationRequired) await this.classify(availability, behavior.host_id);
    } catch { this.update({ message: "The spec designer could not respond. No custom build has started." }); }
    finally { this.update({ busy: false }); }
  }
  async handoff(design: CustomBuildDesign, availability: OtfAvailability | null, signedIn: boolean): Promise<void> {
    if (this.view.busy || !signedIn || !availability?.enabled || !classificationAvailable(availability)) return;
    const spec = specFromDesigner(design.spec);
    this.update({ ...emptyDraft(), busy: true, classificationRequired: true, spec, sentence: designerSentence(design.query, spec.title), hostId: design.hostId });
    try { await this.classifyCard(availability, design.hostId); }
    catch (error) { this.update({ classifyError: classifyFailureText(error) }); }
    finally { this.update({ busy: false }); }
  }
  /** "Try again" or "Classify again": the same card and sentence, as they are now. */
  async reclassify(availability: OtfAvailability | null, signedIn: boolean): Promise<void> {
    const { busy, spec, hostId, classificationRequired } = this.view;
    if (busy || !signedIn || !classificationRequired || spec === null || hostId === null || availability === null || !classificationAvailable(availability)) return;
    this.update({ busy: true, classification: null, rule: null, stale: false, classifyError: null, message: null });
    try { await this.classifyCard(availability, hostId); }
    catch (error) { this.update({ classifyError: classifyFailureText(error) }); }
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
