"use client";

import { useState } from "react";
import { assistClient, type AssistClient, type AssistFailure, type BriefResult } from "../assist/client.ts";
import type { FactoryCase } from "../factory/client.ts";
import { formatDateTime } from "../factory/format.ts";
import { describeAssistFailure } from "./bug-designer.tsx";

export const BRIEF_CREDIT = "Written by NVIDIA Nemotron 3 Super on Nebius Token Factory from the bug case’s public material · novelty check with Tavily";

export const NOVELTY_CAVEAT = "The planted change and its fix come from Random Bug Walk’s public catalog; this check covers only the report’s wording.";

export type BriefEntry = { state: "loading" } | { state: "done"; result: BriefResult } | { state: "failed"; failure: AssistFailure };

/** "What you received": a plain explanation of each delivered case, written on demand (one call per case). */
export function DeliveryBriefs({ requestId, cases, signedIn, client = assistClient }: { requestId: string; cases: readonly FactoryCase[]; signedIn: boolean; client?: AssistClient }) {
  const [entries, setEntries] = useState<Readonly<Record<string, BriefEntry>>>({});
  const explain = async (caseId: string) => {
    if (entries[caseId] !== undefined && entries[caseId].state !== "failed") return;
    setEntries((current) => ({ ...current, [caseId]: { state: "loading" } }));
    const outcome = await client.deliveryBrief(requestId, caseId);
    setEntries((current) => ({ ...current, [caseId]: outcome.ok ? { state: "done", result: outcome.value } : { state: "failed", failure: outcome.failure } }));
  };
  return <DeliveryBriefsView cases={cases} signedIn={signedIn} entries={entries} onExplain={(caseId) => { void explain(caseId); }} />;
}

export function DeliveryBriefsView({ cases, signedIn, entries, onExplain }: { cases: readonly FactoryCase[]; signedIn: boolean; entries: Readonly<Record<string, BriefEntry>>; onExplain: (caseId: string) => void }) {
  if (cases.length === 0) return null;
  return <section className="factory-panel designer" aria-labelledby="received-heading">
    <h2 id="received-heading">What you received</h2>
    <p>A plain explanation of each delivered case: what the bug is, how to run it, and how to use the validator to prove that your agent or your tests catch it. It is written only from the bug case’s public material, never from the validator package.</p>
    <p className="model-credit">{BRIEF_CREDIT}</p>
    {!signedIn && <p className="designer-notice" role="status">Sign in first to get an explanation.</p>}
    <ul className="designer-list">{cases.map((item) => <li key={item.case_id} className="designer-card">
      <h3>{item.title}</h3>
      <p className="factory-note">{item.host_label}</p>
      <BriefBody entry={entries[item.case_id]} signedIn={signedIn} onExplain={() => { onExplain(item.case_id); }} />
    </li>)}</ul>
  </section>;
}

function BriefBody({ entry, signedIn, onExplain }: { entry: BriefEntry | undefined; signedIn: boolean; onExplain: () => void }) {
  const showButton = entry?.state !== "done" && !(entry?.state === "failed" && entry.failure.code === "signed_out");
  return <>
    <div role="status" aria-live="polite">
      {entry?.state === "loading" && <p>Writing the explanation and checking the report’s wording against the public web. This can take up to a minute.</p>}
      {entry?.state === "failed" && <p className="designer-notice">{entry.failure.code === "unavailable" ? "The explanation is unavailable right now. Your downloads and validation work exactly as before." : describeAssistFailure(entry.failure)}</p>}
      {entry?.state === "done" && <BriefResultView result={entry.result} />}
    </div>
    {showButton && <button type="button" disabled={!signedIn || entry?.state === "loading"} onClick={onExplain}>{entry?.state === "failed" ? "Try the explanation again" : "Explain what I received"}</button>}
  </>;
}

export function BriefResultView({ result }: { result: BriefResult }) {
  const { brief, novelty, caveat, model } = result;
  return <>
    <h4>What the bug is</h4><p>{brief.what_it_is}</p>
    <h4>How to run it</h4><p>{brief.how_to_run}</p>
    <h4>How to use the validator</h4><p>{brief.how_to_validate}</p>
    <h4>Novelty check</h4>
    <p>Checked on <time dateTime={novelty.checked_at}>{formatDateTime(novelty.checked_at)}</time>: {novelty.phrases.length === 0
      ? "no distinctive phrases were taken from the report."
      : <>{novelty.phrases.length} distinctive {novelty.phrases.length === 1 ? "phrase from the report was" : "phrases from the report were"} searched on the public web.</>}</p>
    {novelty.phrases.length > 0 && <ul>{novelty.phrases.map((phrase) => <li key={phrase}>“{phrase}”</li>)}</ul>}
    {novelty.phrases.length > 0 && (novelty.public_matches.length === 0
      ? <p>No public page matched these phrases.</p>
      : <><p>Public pages that matched:</p><ul>{novelty.public_matches.map((match) => <li key={`${match.phrase} ${match.url}`}>“{match.phrase}”: <a href={match.url} target="_blank" rel="noopener noreferrer nofollow">{match.url}</a></li>)}</ul></>)}
    <p className="factory-note"><strong>Caveat:</strong> {NOVELTY_CAVEAT}{caveat.trim() !== NOVELTY_CAVEAT && <> {caveat}</>}</p>
    <p className="factory-note">Written by <code>{model.model_id}</code> on <time dateTime={model.at}>{formatDateTime(model.at)}</time>.</p>
  </>;
}
