// The case page, for one released case (or the case chosen without a release). Its six cells keep
// a fixed order: symptom, counts, suite matrix, replay, provenance and downloads, funnel and
// limitations. With more than one release, a list of every released case comes before the cells.
import type { ReactNode } from "react";
import type { ObservedSymptom, RaceSymptom } from "@rbw/schema";
import {
  admissionCopies,
  caseSummaries,
  COLUMN_LABEL,
  COMPARISON_TEXT,
  countExamples,
  diagnosticArchives,
  factoryRuns,
  funnel,
  MATRIX_COLUMNS,
  MATRIX_ROWS,
  NO_VALIDATED_RESULT,
  NOT_IN_RECORDS,
  originalSuiteSize,
  otherRuns,
  raceAttempts,
  raceCounts,
  releaseHref,
  REPLAY_VERDICT_NOTE,
  replayState,
  ROW_LABEL,
  RUN_KIND_TEXT,
  runStatusText,
  suiteMatrix,
  VALIDATED_RESULT,
  VERDICT_TEXT,
  verificationReplays,
} from "../model.ts";
import { ReplayControl } from "./replay-control.tsx";
import { RunSummary } from "./run-summary.tsx";
import { filesOfRelease, isRaceSymptom, type AdmissionRecords, type CaseSymptom, type PublishedRelease, type Results, type Run } from "../release.ts";

function Cell({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <section className="cell" data-cell={String(index)} aria-labelledby={`cell-${String(index)}`}>
      <h2 id={`cell-${String(index)}`}>
        {String(index)}. {title}
      </h2>
      {children}
    </section>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function Symptom({ symptom, validated }: { symptom: CaseSymptom | null; validated: boolean }) {
  if (symptom === null) return <p>No published run holds an observed symptom yet.</p>;
  if (isRaceSymptom(symptom)) return <RaceSymptomSummary symptom={symptom} validated={validated} />;
  return <TimeZoneSymptom symptom={symptom} validated={validated} />;
}

function RaceSymptomSummary({ symptom, validated }: { symptom: RaceSymptom; validated: boolean }) {
  const { expected, observed } = symptom;
  return (
    <>
      <p className="label">{validated ? "Validated release, synthetic planted bug" : "Development evidence, not validated"}</p>
      <p>
        Synthetic task: the bug in this case was planted on purpose in a copy of Umami, an open-source web analytics app. It is not a real Umami bug.
      </p>
      <p>{symptom.user_action}</p>
      <p>
        {String(symptom.concurrent_attempts.length)} requests sent at the same time overlapped for {String(symptom.overlap_ms)} ms. Expected{" "}
        {plural(expected.accepted, "acceptance", "acceptances")} and {plural(expected.refused, "refusal", "refusals")}; observed {plural(observed.accepted, "acceptance", "acceptances")}{" "}
        and {plural(observed.refused, "refusal", "refusals")}.
      </p>
    </>
  );
}

function TimeZoneSymptom({ symptom, validated }: { symptom: ObservedSymptom; validated: boolean }) {
  const examples = countExamples(symptom);
  const differing = examples.filter((example) => example.differs).length;
  return (
    <>
      <p className="label">{validated ? "Validated release, synthetic planted bug" : "Development evidence, not validated"}</p>
      <p>
        Synthetic task: the bug in this case was planted on purpose in a copy of Umami, an open-source web analytics app. It is not a real Umami bug.
      </p>
      <p>{symptom.user_action}</p>
      <p>
        Observed counts differ from the expected local-day counts in {String(differing)} of {String(examples.length)} time zones.
      </p>
    </>
  );
}

function AttemptTable({ caption, attempts }: { caption: string; attempts: RaceSymptom["concurrent_attempts"] }) {
  return (
    <table className="attempts">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Request</th>
          <th scope="col">Sent (ms)</th>
          <th scope="col">Answered (ms)</th>
          <th scope="col">HTTP status</th>
          <th scope="col">Outcome</th>
          <th scope="col">Error code</th>
        </tr>
      </thead>
      <tbody>
        {raceAttempts(attempts).map((attempt) => (
          <tr key={attempt.label}>
            <th scope="row">{attempt.label}</th>
            <td>{String(attempt.sentMs)}</td>
            <td>{String(attempt.settledMs)}</td>
            <td>{String(attempt.httpStatus)}</td>
            <td>{attempt.outcome}</td>
            <td>{attempt.errorCode ?? "none"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RaceCounts({ symptom }: { symptom: RaceSymptom }) {
  return (
    <>
      <p>{symptom.fixture_description}</p>
      <p>
        Request: <code>{`${symptom.request.method} ${symptom.request.path}`}</code>
      </p>
      <AttemptTable caption={`Concurrent requests, overlapping for ${String(symptom.overlap_ms)} ms (times from the first request sent)`} attempts={symptom.concurrent_attempts} />
      <table className="counts">
        <caption>Outcomes of the concurrent requests</caption>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col">Expected</th>
            <th scope="col">Observed</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {raceCounts(symptom).map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{String(row.expected)}</td>
              <td>{String(row.observed)}</td>
              <td className={row.matches ? "status status-pass" : "status status-fail"}>{row.matches ? "Matches" : "Differs"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {symptom.sequential_attempts.length === 0 ? null : (
        <details>
          <summary>The same requests one after the other ({String(symptom.sequential_attempts.length)} requests)</summary>
          <AttemptTable caption="Sequential requests, for contrast (times from the first request sent)" attempts={symptom.sequential_attempts} />
        </details>
      )}
    </>
  );
}

function Counts({ symptom }: { symptom: CaseSymptom | null }) {
  if (symptom === null) return <p>No counts to show.</p>;
  if (isRaceSymptom(symptom)) return <RaceCounts symptom={symptom} />;
  return (
    <>
      <p>{symptom.fixture_description}</p>
      <p>
        Request: <code>{`${symptom.request.method} ${symptom.request.path}`}</code> (HTTP {String(symptom.http_status)})
      </p>
      {countExamples(symptom).map((example) => (
        <table key={example.timezone} className="counts">
          <caption>{example.timezone}</caption>
          <thead>
            <tr>
              <th scope="col">Day bucket</th>
              <th scope="col">Expected</th>
              <th scope="col">Observed</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {example.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.expected === null ? "none" : String(row.expected)}</td>
                <td>{row.observed === null ? "none" : String(row.observed)}</td>
                <td className={row.matches ? "status status-pass" : "status status-fail"}>{row.matches ? "Matches" : "Differs"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      <details>
        <summary>Source timestamps ({String(symptom.events.length)} pageviews)</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">UTC instant</th>
              <th scope="col">Unix seconds</th>
            </tr>
          </thead>
          <tbody>
            {symptom.events.map((event) => (
              <tr key={event.label}>
                <th scope="row">{event.label}</th>
                <td>{event.utc_instant}</td>
                <td>{String(event.timestamp_seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

/** The copies the admission rules covered: counted from the run's admission records, or the policy's 13 without them. */
function copiesPhrase(admission: AdmissionRecords | null): string {
  const copies = admissionCopies(admission);
  return copies === null ? "the 13 fresh copies of an admission" : `this run's ${String(copies.total)} fresh copies`;
}

/**
 * How a candidate is admitted. With the case run's admission records, the copies are counted from
 * them; without, the text describes the admission policy's 13 copies.
 */
export function methodText(admission: AdmissionRecords | null): string {
  const copies = admissionCopies(admission);
  if (copies === null) {
    return "A candidate is admitted using 13 fresh app copies: 1 clean, 5 fixed, 5 planted, 1 partial-fix and 1 stub-fix. The original API suite runs once in each copy, and the added checks run in each, 20 times in the first fixed and the first planted copy. The six cells above come from the first clean, planted and fixed copies. A blind spot is shown only when the original suite passes in all 13 copies while the added checks pass on clean and fixed copies and fail as declared on planted and probe copies.";
  }
  const total = String(copies.total);
  const failing = copies.probes ? "planted and probe copies" : "planted copies";
  return `This case's admission used ${total} fresh app copies: ${copies.breakdown}. The original API suite runs once in each copy, and the added checks run in each, 20 times in the first fixed and the first planted copy. The six cells above come from the first clean, planted and fixed copies. A blind spot is shown only when the original suite passes in all ${total} copies while the added checks pass on clean and fixed copies and fail as declared on ${failing}.`;
}

function Matrix({ admission }: { admission: AdmissionRecords | null }) {
  const cells = suiteMatrix(admission);
  const size = originalSuiteSize(admission);
  const decision = admission?.decision ?? null;
  return (
    <>
      <p>
        Original Umami API suite{size === null ? "" : ` (${String(size)} tests measured)`}: the upstream API tests that were run in each copy. Other upstream tests were not evaluated.
      </p>
      <table className="matrix">
        <thead>
          <tr>
            <td />
            {MATRIX_COLUMNS.map((column) => (
              <th key={column} scope="col">
                {COLUMN_LABEL[column]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MATRIX_ROWS.map((row) => (
            <tr key={row}>
              <th scope="row">{ROW_LABEL[row]}</th>
              {cells
                .filter((cell) => cell.row === row)
                .map((cell) => (
                  <td key={cell.column} data-row={cell.row} data-column={cell.column}>
                    <span className="cell-label">
                      {ROW_LABEL[cell.row]}, {COLUMN_LABEL[cell.column]}
                    </span>
                    <span className={`status status-${cell.status}`}>{cell.statusText}</span>
                    {cell.detail === null ? null : <span className="detail">{cell.detail}</span>}
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="matrix-note">
        The added checks run once in the clean copy, and 20 times each in the first planted and the first fixed copy (the stability rule, ADM-05), so those two cells count 20
        times as many executions as the clean copy.
      </p>
      {decision === null ? (
        <p>This run published no admission decision.</p>
      ) : (
        <ul>
          <li>Comparison (ADM-08): {decision.comparison === null ? "none" : COMPARISON_TEXT[decision.comparison.classification]}</li>
          <li>Admission verdict (ADM-02 to ADM-06): {decision.outcome_verdict === null ? "none" : VERDICT_TEXT[decision.outcome_verdict]}</li>
        </ul>
      )}
      <p className="rule-codes">
        Rule codes refer to the <a href={ADMISSION_RULES}>admission rules</a>: ADM-02 to ADM-06 cover {copiesPhrase(admission)}, the fixed copies passing, the planted copies failing
        as declared, stability and the negative probes{admissionCopies(admission)?.probes === false ? " (this run has no negative-probe copies)" : ""}; ADM-07 the card, issue and leak checks with a human check; ADM-08 this original-suite comparison; ADM-09 the release.
      </p>
    </>
  );
}

/**
 * Why a run that passed admission with a blind spot is still not validated, from the records:
 * no release names it, and the one published release names another run. Null for any other run.
 */
export function notValidatedReason(results: Results, run: Run): string | null {
  const decision = run.admission?.decision;
  const release = results.release?.record;
  if (release === undefined || results.releases.some((item) => item.run.rootExecutionId === run.rootExecutionId)) return null;
  if (decision?.outcome_verdict !== "pass" || decision.comparison?.classification !== "blind_spot_demonstrated") return null;
  if (results.releases.length > 1) {
    const roots = results.releases.map((item) => item.run.rootExecutionId).sort();
    return `Its admission also passed with a blind spot demonstrated, but no release names it: the ${String(roots.length)} published releases are for runs ${roots.join(", ")}, whose issues passed the human check (ADM-07).`;
  }
  return `Its admission also passed with a blind spot demonstrated, but no release names it: the one published release is for run ${release.run.root_execution_id}, whose issue passed the human check (ADM-07).`;
}

/**
 * Why the two revisions differ: the release's complete revision is the admission's provisional one
 * with revision_kind "complete" and the frozen issue added (tools/release checks it).
 */
const PROVISIONAL_NOTE = "(admission was graded under this revision, which does not include the issue; the task revision above is the same revision with the release's issue added)";

/** The release's provenance, from its record; the hashes of judge_job and files stay in release.json. */
function ReleaseProvenance({ release, run }: { release: PublishedRelease; run: Run }) {
  const { record } = release;
  const [revision] = record.revisions;
  return (
    <dl>
      <dt>Release</dt>
      <dd>{record.release_id}</dd>
      <dt>Release SHA-256</dt>
      <dd>{release.sha256}</dd>
      <dt>Release created</dt>
      <dd>{record.created_at}</dd>
      <dt>Run</dt>
      <dd>
        {run.rootExecutionId} ({run.kind}, {runStatusText(run).outcome.toLowerCase()})
      </dd>
      <dt>Publication</dt>
      <dd>{record.run.publication_id}</dd>
      <dt>Results repository commit</dt>
      <dd>{record.run.repository_commit}</dd>
      <dt>Project policy SHA-256</dt>
      <dd>{record.project_policy_sha256}</dd>
      <dt>Policy</dt>
      <dd>{record.policy_id}</dd>
      <dt>Task revision</dt>
      <dd>{revision?.sha256 ?? NOT_IN_RECORDS}</dd>
      <dt>Admission's provisional task revision</dt>
      <dd>{run.admission === null ? NOT_IN_RECORDS : `${run.admission.evidence.request.task_revision} ${PROVISIONAL_NOTE}`}</dd>
      <dt>Kit version</dt>
      <dd>{revision?.identity.kit_sha256 ?? NOT_IN_RECORDS}</dd>
      <dt>Kit image</dt>
      <dd>{record.images.kit_image}</dd>
      <dt>Controller image</dt>
      <dd>{record.images.controller_image}</dd>
      <dt>Family</dt>
      <dd>
        {record.family.family_id} ({record.family.split}), source fix {record.family.source_fix.upstream} at {record.family.source_fix.commit}
      </dd>
      <dt>Human check (ADM-07)</dt>
      <dd>Approved on {record.approval.reviewed_at.slice(0, "YYYY-MM-DD".length)}</dd>
      <dt>Calibration</dt>
      <dd>Not requested</dd>
    </dl>
  );
}

function Provenance({ results }: { results: Results }) {
  const run = results.caseRun;
  const { release } = results;
  if (release !== null && run !== null) {
    return (
      <>
        <ReleaseProvenance release={release} run={run} />
        <h3>Release files</h3>
        <ul>
          {filesOfRelease(release.record).map((file) => (
            <li key={file.path}>
              <a href={releaseHref(file.release, file.path)}>{file.path}</a>
            </li>
          ))}
        </ul>
        <h3>The released run&apos;s files</h3>
        <RunSummary run={run} />
        <DiagnosticArchive results={results} archives={diagnosticArchives(results)} empty="No other published factory runs." />
        <Replays replays={verificationReplays(results)} />
      </>
    );
  }
  return (
    <>
      {run === null ? null : (
        <dl>
          <dt>Run</dt>
          <dd>
            {run.rootExecutionId} ({run.kind}, {runStatusText(run).outcome.toLowerCase()})
          </dd>
          <dt>Project policy SHA-256</dt>
          <dd>{run.manifest?.project_policy_sha256 ?? NOT_IN_RECORDS}</dd>
          <dt>Task revision</dt>
          <dd>{run.admission?.evidence.request.task_revision ?? NOT_IN_RECORDS}</dd>
          <dt>Kit version</dt>
          <dd>{NOT_IN_RECORDS}</dd>
          <dt>Release</dt>
          <dd>None published yet.</dd>
          <dt>Calibration</dt>
          <dd>Not requested</dd>
        </dl>
      )}
      <p>Release files: none, because there is no validated release.</p>
      <DiagnosticArchive results={results} archives={run === null ? diagnosticArchives(results) : [run]} empty="No factory run has been published." />
      <Replays replays={verificationReplays(results)} />
    </>
  );
}

/** Published judge replays: verification runs, listed apart so none reads as a failed or unvalidated factory run. */
function Replays({ replays }: { replays: Run[] }) {
  if (replays.length === 0) return null;
  return (
    <>
      <h3>Verification replays (judge)</h3>
      <p>These are judges&apos; replays, not factory runs, so they are not candidates for validation.</p>
      {replays.map((replay) => (
        <div key={replay.rootExecutionId}>
          <p>
            {replay.rootExecutionId} {RUN_KIND_TEXT.judge_replay.toLowerCase()}, {runStatusText(replay).outcome.toLowerCase()}
          </p>
          <RunSummary run={replay} />
        </div>
      ))}
    </>
  );
}

function DiagnosticArchive({ results, archives, empty }: { results: Results; archives: Run[]; empty: string }) {
  return (
    <>
      <h3>Diagnostic archive (not validated)</h3>
      {archives.length === 0 ? <p>{empty}</p> : null}
      {archives.map((archive) => {
        const reason = notValidatedReason(results, archive);
        return (
          <div key={archive.rootExecutionId}>
            <p>
              {archive.rootExecutionId} {runStatusText(archive).outcome.toLowerCase()}, not validated
            </p>
            {reason === null ? null : <p>{reason}</p>}
            <RunSummary run={archive} />
          </div>
        );
      })}
    </>
  );
}

/** What the funnel counts: only the factory runs in this results directory, never every attempt. */
export function funnelScope(results: Results): string {
  const unfinished = factoryRuns(results).some((run) => run.outcome === "failed" || run.outcome === "incomplete");
  const scope = "It counts only the factory runs in this site's results repository and its public store; any judge replays, paired comparisons and kit checks are counted apart below.";
  return unfinished
    ? `${scope} Attempts that were not published here are not counted, so it is not a record of every attempt.`
    : `${scope} Failed and incomplete factory attempts are not published here, so it is not a record of every attempt.`;
}

function CountTable({ caption, steps }: { caption: string; steps: { label: string; count: number }[] }) {
  return (
    <table className="funnel">
      <caption>{caption}</caption>
      <tbody>
        {steps.map((step) => (
          <tr key={step.label}>
            <th scope="row">{step.label}</th>
            <td>{String(step.count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FunnelAndLimitations({ results }: { results: Results }) {
  return (
    <>
      <CountTable caption="Batch funnel, counted from the factory runs published for this site" steps={funnel(results)} />
      <p className="funnel-note">{funnelScope(results)}</p>
      <CountTable caption="Runs counted apart from the factory funnel" steps={otherRuns(results)} />
      {results.runs.some((run) => run.kind === "judge_replay") ? <p className="funnel-note">{REPLAY_VERDICT_NOTE}</p> : null}
      <h3>Limitations</h3>
      <ul>
        <li>The planted bug is synthetic. It was introduced on purpose and is not a real Umami bug.</li>
        <li>Only the original Umami API suite was measured. Other upstream tests were not evaluated.</li>
        <li>Calibration: not requested. No solve counts are reported.</li>
        <li>
          {results.release === null
            ? "No release has been published yet, so no result here is validated."
            : results.releases.length > 1
              ? `A human check (ADM-07) approved this issue, and ${String(results.releases.length)} releases (ADM-09) were published; this page shows one of them.`
              : "A human check (ADM-07) approved this issue, and one release (ADM-09) was published."}
        </li>
        <li>A verified replay is open only to judges with the passcode, one replay at a time, and it can be held for inspection after two replays in a row that do not reproduce the release.</li>
        <li>This is a hackathon prototype.</li>
      </ul>
      <h3>Method</h3>
      <p>{methodText(results.caseRun?.admission ?? null)}</p>
    </>
  );
}

export const CODE_REPOSITORY = "https://github.com/Erik-1259/random-bug-walk";
export const RESULTS_REPOSITORY = "https://github.com/Erik-1259/random-bug-walk-results";
export const UMAMI_REPOSITORY = "https://github.com/umami-software/umami";
export const ADMISSION_RULES = `${CODE_REPOSITORY}/blob/main/docs/admission-rules.md`;

/** What a blind-spot example is, for a reader who arrives cold, and where the code and records are. */
function Intro() {
  return (
    <p className="intro">
      A blind-spot example is a bug planted on purpose in a pinned copy of <a href={UMAMI_REPOSITORY}>Umami</a>, an open-source web analytics app, that Umami&apos;s own original API
      test suite does not catch, while added checks do: the original suite passes on the clean, planted and fixed copies, and the added checks fail on the planted copy and pass on the clean and fixed copies. Every
      result on this page is read from the published records in the <a href={RESULTS_REPOSITORY}>results repository</a>; the code that produced them is in the{" "}
      <a href={CODE_REPOSITORY}>code repository</a>. The copies run on Vercel Sandbox, the spend ledger is a Neon Postgres database, run status and large published files are kept on Vercel Blob,
      the issue writer&apos;s model runs on Nebius Token Factory, and the novelty search uses Tavily.
    </p>
  );
}

/** The released cases, newest first, each with its family and what its release records; shown only with more than one release. */
export function CaseList({ results, home }: { results: Results; home: boolean }) {
  if (results.releases.length <= 1) return null;
  const current = results.release?.record.release_id;
  return (
    <section className="cases" aria-labelledby="cases">
      <h2 id="cases">Released cases</h2>
      <p>
        {`This site has ${String(results.releases.length)} released cases, newest first. Each has its own page, and the replay on that page replays that case.`}
        {home ? " This page shows the first released case, so links shared before the other cases were added still show it." : ""}
      </p>
      <div className="table-scroll">
        <table className="case-list">
          <thead>
            <tr>
              <th scope="col">Released</th>
              <th scope="col">Family</th>
              <th scope="col">Status</th>
              <th scope="col">Verification replays published</th>
              <th scope="col">Case</th>
            </tr>
          </thead>
          <tbody>
            {caseSummaries(results).map((item) => (
              <tr key={item.releaseId}>
                <td>{item.createdAt.slice(0, "YYYY-MM-DD".length)}</td>
                <td>{item.family}</td>
                <td>{item.status}</td>
                <td>{String(item.replays)}</td>
                <td>
                  <a href={item.href} aria-current={item.releaseId === current ? "page" : undefined}>
                    {`Release ${item.releaseId}`}
                  </a>
                  {item.releaseId === current ? " (shown below)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * `judgeEnabled`: the judge routes are configured for this release (src/config.ts, judgeEnabled).
 * `home`: the page at /, which shows the first released case when there are several.
 */
export function CasePage({ results, judgeEnabled = false, home = false }: { results: Results; judgeEnabled?: boolean; home?: boolean }) {
  const run = results.caseRun;
  return (
    <main>
      <h1>Random Bug Walk results</h1>
      <p className="headline">{results.release === null ? NO_VALIDATED_RESULT : VALIDATED_RESULT}</p>
      <Intro />
      <CaseList results={results} home={home} />
      <Cell index={1} title="Symptom">
        <Symptom symptom={run?.symptom ?? null} validated={results.release !== null} />
      </Cell>
      <Cell index={2} title={run?.symptom != null && isRaceSymptom(run.symptom) ? "Concurrent requests and expected and observed acceptances" : "Expected and observed local-day counts"}>
        <Counts symptom={run?.symptom ?? null} />
      </Cell>
      <Cell index={3} title="Original API suite and added checks on clean, planted and fixed copies">
        <Matrix admission={run?.admission ?? null} />
      </Cell>
      <Cell index={4} title="Verified replay">
        <ReplayControl
          release={results.release === null ? null : { release_id: results.release.record.release_id, created_at: results.release.record.created_at }}
          initial={replayState(results, judgeEnabled)}
          choose={results.releases.length > 1}
          firstCreated={results.release !== null && results.releases.at(-1)?.release.record.release_id === results.release.record.release_id}
        />
      </Cell>
      <Cell index={5} title="Provenance and downloads">
        <Provenance results={results} />
      </Cell>
      <Cell index={6} title="Batch funnel and limitations">
        <FunnelAndLimitations results={results} />
      </Cell>
    </main>
  );
}
