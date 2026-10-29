import type { BugSpec } from "../../assist/client.ts";
import { SENTENCE_MAX_CHARS, SENTENCE_MIN_CHARS, type OtfBehaviorOption, type OtfCriterionId, type OtfHostAvailability, type OtfSpecCard } from "../../otf/contract.ts";
import { HostReason, UMAMI_PLACEMENT, hostQueueSentence, orderedHosts, typicalSentence } from "./host-copy.tsx";

const length = (text: string) => Array.from(text).length;
export function sentenceProblem(sentence: string): string | null {
  const size = length(sentence.trim());
  return size < SENTENCE_MIN_CHARS || size > SENTENCE_MAX_CHARS ? "Describe the behavior in 3 to 300 characters." : null;
}

export function specFromDesigner(spec: BugSpec): OtfSpecCard {
  return { title: spec.title, where: spec.where, change: spec.change, why_tests_miss: spec.why_tests_miss, checks_to_add: [...spec.checks_to_add], fix: spec.fix };
}

const FIELDS = [
  ["title", "Title", 160], ["where", "Where", 800], ["change", "What changes", 1500],
  ["why_tests_miss", "Why the existing tests miss it", 1200], ["fix", "The fix", 1200],
] as const;

export function specProblem(spec: OtfSpecCard): string | null {
  for (const [field, label, limit] of FIELDS) {
    if (spec[field].trim() === "" || length(spec[field]) > limit) return `${label} must contain 1 to ${String(limit)} characters.`;
  }
  if (spec.checks_to_add.length < 1 || spec.checks_to_add.length > 6 || spec.checks_to_add.some(check => check.trim() === "" || length(check) > 400)) return "List 1 to 6 checks, each with 1 to 400 characters.";
  return null;
}

export interface BehaviorPickerProps {
  behaviors: OtfBehaviorOption[];
  hosts: OtfHostAvailability[];
  /** The clock for the calendar hint. */
  nowMs: number;
  criterionId: OtfCriterionId | null;
  sentence: string;
  signedIn: boolean;
  busy: boolean;
  onBehavior: (criterion: OtfCriterionId) => void;
  onSentence: (sentence: string) => void;
  onDesign: () => void;
}

/** Example phrases worth showing under a behavior: the ones that do not repeat its label. */
function examplePhrases(behavior: OtfBehaviorOption): string[] {
  const label = behavior.label.trim().toLowerCase();
  return behavior.example_phrases.filter(phrase => phrase.trim().toLowerCase() !== label);
}

export function BehaviorPickerView({ behaviors, hosts, nowMs, criterionId, sentence, signedIn, busy, onBehavior, onSentence, onDesign }: BehaviorPickerProps) {
  const offered = new Set(hosts.filter(host => host.offered).map(host => host.host_id));
  const selected = behaviors.find(behavior => behavior.criterion_id === criterionId && offered.has(behavior.host_id));
  const problem = sentenceProblem(sentence);
  return <form className="factory-form" aria-label="Custom bug behavior" onSubmit={event => { event.preventDefault(); onDesign(); }}>
    <p>Build a custom non-security bug. Choose a behavior from an offered host.</p>
    {!signedIn && <p role="status">Sign in to write a spec card or start a custom build.</p>}
    <fieldset disabled={busy || !signedIn}>
      <legend>Choose a behavior</legend>
      {orderedHosts(hosts).map(host => {
        const queue = host.offered ? hostQueueSentence(host) : null;
        return <fieldset key={host.host_id} disabled={!host.offered} aria-label={`${host.label} behaviors`}>
          <legend>{host.label}</legend>
          {host.offered ? behaviors.filter(behavior => behavior.host_id === host.host_id).map(behavior => <label key={behavior.criterion_id}>
            <input type="radio" name="otf-behavior" checked={criterionId === behavior.criterion_id} onChange={() => { onBehavior(behavior.criterion_id); }} /> {behavior.label}
            {examplePhrases(behavior).length > 0 && <><br /><small>For example: {examplePhrases(behavior).join(" · ")}</small></>}
          </label>) : <HostReason host={host} hosts={hosts} nowMs={nowMs} />}
          {queue !== null && <p className="factory-note">{queue}</p>}
        </fieldset>;
      })}
      <label htmlFor="otf-sentence">Describe it in one sentence</label>
      <textarea id="otf-sentence" value={sentence} onChange={event => { onSentence(event.target.value); }} aria-describedby="otf-sentence-help" />
      <p id="otf-sentence-help" className="factory-note">3 to 300 characters. Nemotron 3 Super will write a spec card for you to edit or accept.</p>
    </fieldset>
    {sentence !== "" && problem !== null && <p role="status">{problem}</p>}
    <button type="submit" disabled={busy || !signedIn || selected === undefined || problem !== null}>Write my spec card</button>
  </form>;
}

export interface SpecAcceptProps {
  spec: OtfSpecCard;
  /** The picked behavior's host, for its time copy and placement note. */
  host: OtfHostAvailability | null;
  busy: boolean;
  signedIn: boolean;
  onChange: (spec: OtfSpecCard) => void;
  onAccept: () => void;
}

export function SpecAcceptView({ spec, host, busy, signedIn, onChange, onAccept }: SpecAcceptProps) {
  const problem = specProblem(spec);
  return <form className="factory-form designer-card" aria-label="Accept custom spec" onSubmit={event => { event.preventDefault(); onAccept(); }}>
    <h3>Edit or accept your spec card</h3>
    <p className="factory-badge">Design, not a built bug</p>
    <p>Spec card by Nemotron 3 Super. Read each field before starting the custom build.</p>
    <fieldset disabled={busy || !signedIn}>
      <legend>Accepted behavior</legend>
      {FIELDS.map(([field, label]) => <label key={field} htmlFor={`otf-spec-${field}`}>{label}
        <textarea id={`otf-spec-${field}`} value={spec[field]} onChange={event => { onChange({ ...spec, [field]: event.target.value }); }} />
      </label>)}
      <label htmlFor="otf-spec-checks_to_add">Checks to add, one per line
        <textarea id="otf-spec-checks_to_add" value={spec.checks_to_add.join("\n")} onChange={event => { onChange({ ...spec, checks_to_add: event.target.value.split("\n") }); }} />
      </label>
    </fieldset>
    {problem !== null && <p role="status">{problem}</p>}
    {host?.host_id === "umami" && <p>{UMAMI_PLACEMENT}</p>}
    {host !== null && <p>{typicalSentence(host)}</p>}
    <button type="submit" disabled={busy || !signedIn || problem !== null}>Accept and build this custom bug</button>
  </form>;
}
