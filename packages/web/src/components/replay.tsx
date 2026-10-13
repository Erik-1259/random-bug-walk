// The replay cell's content: the frozen release beside the replay, each with its date, the
// replay's state in text with what a terminal or uncertain state means, its measured duration
// apart from the 35-minute hard cap, each copy's progress and the replay's six cells. It holds no
// state, so the page and tests render it as is.
import type { ReactNode } from "react";
import { COLUMN_LABEL, MATRIX_COLUMNS, REPLAY_STATE_HELP, REPLAY_STATE_TEXT, ROW_LABEL, type ReplayStateName, type ReplayStatus } from "../model.ts";

const TRIAL_COLUMN: Record<string, string> = { "clean-01": COLUMN_LABEL.clean, "planted-01": COLUMN_LABEL.planted, "fixed-01": COLUMN_LABEL.fixed };
const COPY_TEXT = { not_started: "not started", running: "running", done: "done" } as const;

function day(time: string | null): string {
  return time === null ? "not started" : time.slice(0, "YYYY-MM-DD".length);
}

function minutes(seconds: number): string {
  return `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}

export interface ReplayPanelProps {
  release: { release_id: string; created_at: string } | null;
  state: ReplayStateName;
  reason: string;
  status: ReplayStatus | null;
  /** The passcode field and the button, from the client control. */
  children?: ReactNode;
}

export function ReplayPanel({ release, state, reason, status, children }: ReplayPanelProps) {
  // An unavailable answer carries its own reason; an earlier replay's status must not hide it.
  const message = state === "unavailable" ? reason : (status?.message ?? reason);
  const help = REPLAY_STATE_HELP[state];
  return (
    <>
      <div className="replay">
        <dl>
          <dt>Frozen release</dt>
          <dd>{release === null ? "None published yet." : `${release.release_id}, created ${day(release.created_at)}`}</dd>
          <dt>Replay</dt>
          <dd>{status?.created_at == null ? "No replay in this browser yet." : `Started ${day(status.created_at)}`}</dd>
        </dl>
      </div>
      {children}
      <p id="replay-status" className={`status status-replay-${state}`} role="status" aria-live="polite">
        Replay status: {REPLAY_STATE_TEXT[state]}. {message}
      </p>
      {help === undefined ? null : <p className="replay-help">{help}</p>}
      {status === null ? null : <ReplayDetail status={status} />}
      <p>The page above is complete without a replay.</p>
    </>
  );
}

function ReplayDetail({ status }: { status: ReplayStatus }) {
  return (
    <>
      {status.elapsed_seconds === null ? null : (
        <p>
          Measured duration: {minutes(status.elapsed_seconds)}. Hard cap: {String(status.hard_cap_seconds / 60)} minutes.
        </p>
      )}
      <ul>
        {status.copies.map((copy) => (
          <li key={copy.trial_id}>
            {TRIAL_COLUMN[copy.trial_id] ?? copy.trial_id}: {COPY_TEXT[copy.status]}
          </li>
        ))}
      </ul>
      {status.cells.length === 0 ? null : (
        <table className="matrix">
          <caption>The replay&apos;s six cells</caption>
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
            {(["original", "added"] as const).map((suite) => (
              <tr key={suite}>
                <th scope="row">{ROW_LABEL[suite]}</th>
                {MATRIX_COLUMNS.map((column) => {
                  const cell = status.cells.find((item) => item.suite === suite && TRIAL_COLUMN[item.trial_id] === COLUMN_LABEL[column]);
                  const label = (
                    <span className="cell-label">
                      {ROW_LABEL[suite]}, {COLUMN_LABEL[column]}
                    </span>
                  );
                  if (cell === undefined)
                    return (
                      <td key={column} data-replay-row={suite} data-replay-column={column}>
                        {label}
                        <span className="status status-no_record">No record</span>
                      </td>
                    );
                  const failing = [...new Set(cell.failing.map((item) => item.id))];
                  return (
                    <td key={column} data-replay-row={suite} data-replay-column={column}>
                      {label}
                      <span className={`status status-${cell.state}`}>
                        {cell.state}, {cell.matches_expectation ? "as expected" : "not as expected"}
                      </span>
                      <span className="detail">
                        {String(cell.executed_count)} of {String(cell.expected_count)} executed
                        {failing.length === 0 ? "" : `; failing: ${failing.join(", ")}`}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
