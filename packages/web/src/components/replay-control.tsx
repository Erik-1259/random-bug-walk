"use client";
// The replay control: a passcode field, then the button that starts one replay. The browser keeps
// the request ID, so a refresh resumes the same replay, and a refresh while the session cookie is
// valid needs no new sign-in. While a replay starts or runs, the control asks the status route
// again every 15 seconds; a temporary unavailable answer keeps it asking, less often, with the
// start button still disabled. There is no cancel action. On a site with several releases the
// control names its page's release in the start and status requests, and keeps that release's
// request ID under its own key.
import { useEffect, useState, type CSSProperties, type SyntheticEvent } from "react";
import type { ReplayState, ReplayStatus } from "../model.ts";
import { ReplayPanel } from "./replay.tsx";

const REQUEST_KEY = "rbw-judge-request-id";
const POLL_MS = 15_000;
/** After unavailable status answers, the wait doubles from 15 s up to this many polls' worth. */
const BACKOFF_CAP = 4;
const START_UNANSWERED = "Could not reach the site. Your replay may still have started; the status updates below.";
const WRONG_PASSCODE = "That passcode is not right. Try again.";
const SIGN_IN_UNANSWERED = "Could not reach the site. Try signing in again.";
const STILL_CHECKING = "The page checks the replay's status again shortly.";
const PASSCODE_ID = "judge-passcode";
const START_ID = "replay-start";
/** The passcode field matches .button-primary's font, padding and corners (the stylesheet lives in app/layout.tsx). */
const INPUT_STYLE: CSSProperties = { font: "inherit", margin: "0.25rem 0", padding: "0.5rem 0.75rem", border: "1px solid #8a94a3", borderRadius: "6px" };

interface Props {
  release: { release_id: string; created_at: string } | null;
  initial: ReplayState;
  /** The site has several releases: the requests name this page's release. */
  choose?: boolean;
}

type Answer = Omit<Partial<ReplayStatus>, "state"> & { state: string; message?: string };

export function ReplayControl({ release, initial, choose = false }: Props) {
  const named = choose && release !== null ? release.release_id : null;
  const requestKey = named === null ? REQUEST_KEY : `${REQUEST_KEY}:${named}`;
  const statusQuery = named === null ? "" : `&release_id=${named}`;
  const [view, setView] = useState<ReplayState>(initial);
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [passcode, setPasscode] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  // Status answers in a row that were unavailable while a replay was starting or running.
  const [misses, setMisses] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const enabled = initial.state !== "disabled";

  const show = (answer: Answer) => {
    if (answer.state === "unauthorized") {
      setSignedIn(false);
      setView({ state: "ready", reason: answer.message ?? "" });
      return;
    }
    // Every answer but unauthorized comes after the route checked the session cookie.
    setSignedIn(true);
    if (answer.state === "unavailable" || answer.state === "bad_request") {
      setView({ state: "unavailable", reason: answer.message ?? "" });
      return;
    }
    if (answer.release_id !== undefined) setStatus(answer as ReplayStatus);
    setView({ state: answer.state as ReplayState["state"], reason: answer.message ?? "" });
  };

  /** `live` is true while the replay is known to be starting or running. */
  const refresh = async (requestId: string, live: boolean) => {
    try {
      const response = await fetch(`/api/judge/status?request_id=${requestId}${statusQuery}`, { cache: "no-store" });
      const answer = (await response.json()) as Answer;
      if (live && answer.state === "unavailable") {
        // A ledger or token outage says nothing about the replay, which may still run.
        setSignedIn(true);
        setMisses((count) => count + 1);
        setView({ state: "unavailable", reason: `${answer.message ?? ""} ${STILL_CHECKING}`.trim() });
        return;
      }
      setMisses(0);
      show(answer);
    } catch {
      // A failed poll keeps the view; a fresh copy of it arms the next poll.
      setView((current) => ({ ...current }));
    }
  };

  const checkSession = async () => {
    try {
      const response = await fetch("/api/judge/session", { cache: "no-store" });
      const answer = (await response.json()) as Answer;
      if (response.ok && answer.state === "ready") setSignedIn(true);
    } catch {
      // Without an answer the passcode form stays; signing in again works.
    }
  };

  // After a reload the HttpOnly session cookie may still be valid: the stored replay's status
  // shows it, or with no stored replay the session check does. The stored replay may still be
  // running, so an outage on this first check is retried like one during a poll.
  useEffect(() => {
    const requestId = enabled ? window.localStorage.getItem(requestKey) : null;
    if (requestId !== null) void refresh(requestId, true);
    else if (enabled) void checkSession();
  }, [enabled]);

  const polling = view.state === "starting" || view.state === "running" || misses > 0;
  useEffect(() => {
    const requestId = window.localStorage.getItem(requestKey);
    if (requestId === null || !polling) return undefined;
    const wait = misses === 0 ? POLL_MS : POLL_MS * Math.min(2 ** (misses - 1), BACKOFF_CAP);
    const timer = window.setTimeout(() => void refresh(requestId, true), wait);
    return () => {
      window.clearTimeout(timer);
    };
  }, [view, status, misses]);

  // Focus moves after the render that enables its target.
  useEffect(() => {
    if (focusId !== null) {
      document.getElementById(focusId)?.focus();
      setFocusId(null);
    }
  }, [focusId]);

  const signIn = async (event: SyntheticEvent) => {
    event.preventDefault();
    let response: Response;
    try {
      response = await fetch("/api/judge/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
    } catch {
      setView({ state: "ready", reason: SIGN_IN_UNANSWERED });
      setFocusId(PASSCODE_ID);
      return;
    }
    setPasscode("");
    if (response.ok) {
      setSignedIn(true);
      setView({ state: "ready", reason: "Signed in. A replay runs three fresh copies of the released case." });
      setFocusId(START_ID);
    } else {
      setSignedIn(false);
      setView({ state: "ready", reason: response.status === 401 ? WRONG_PASSCODE : SIGN_IN_UNANSWERED });
      setFocusId(PASSCODE_ID);
    }
  };

  const start = async () => {
    // The new request ID is kept before the POST, so a refresh during it resumes the replay; a
    // refused POST puts back the earlier replay's ID.
    const previous = window.localStorage.getItem(requestKey);
    const requestId = crypto.randomUUID();
    window.localStorage.setItem(requestKey, requestId);
    // A new start drops the earlier replay's status, so a refusal shows its own reason.
    setStatus(null);
    setMisses(0);
    setView({ state: "starting", reason: "" });
    let answer: Answer;
    try {
      const response = await fetch("/api/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(named === null ? { request_id: requestId } : { request_id: requestId, release_id: named }) });
      answer = (await response.json()) as Answer;
    } catch {
      // No answer, or one that is not JSON (a platform error page): the replay may have started,
      // so the new request ID stays and the status poll shows what happened.
      setView({ state: "starting", reason: START_UNANSWERED });
      return;
    }
    if (["unavailable", "bad_request", "unauthorized"].includes(answer.state)) {
      if (previous === null) window.localStorage.removeItem(requestKey);
      else window.localStorage.setItem(requestKey, previous);
    }
    show(answer);
    if (answer.state === "starting") await refresh(requestId, true);
  };

  return (
    <ReplayPanel release={release} state={view.state} reason={view.reason} status={status}>
      {enabled && !signedIn ? (
        <form onSubmit={(event) => void signIn(event)}>
          <label htmlFor={PASSCODE_ID}>Judge passcode</label>{" "}
          <input id={PASSCODE_ID} type="password" autoComplete="off" style={INPUT_STYLE} value={passcode} onChange={(event) => { setPasscode(event.target.value); }} />{" "}
          <button type="submit" className="button-primary" disabled={passcode === ""}>
            Sign in
          </button>
        </form>
      ) : null}
      <button id={START_ID} type="button" className="button-primary" disabled={!enabled || !signedIn || polling} aria-describedby="replay-status" onClick={() => void start()}>
        Plant and verify this example
      </button>
    </ReplayPanel>
  );
}
