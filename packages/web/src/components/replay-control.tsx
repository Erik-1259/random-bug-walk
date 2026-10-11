"use client";
// The replay control: a passcode field, then the button that starts one replay. The browser keeps
// the request ID, so a refresh resumes the same replay; while it starts or runs, the control asks
// the status route again every 15 seconds. There is no cancel action.
import { useEffect, useState, type SyntheticEvent } from "react";
import type { ReplayState, ReplayStatus } from "../model.ts";
import { ReplayPanel } from "./replay.tsx";

const REQUEST_KEY = "rbw-judge-request-id";
const POLL_MS = 15_000;

interface Props {
  release: { release_id: string; created_at: string } | null;
  initial: ReplayState;
}

type Answer = Omit<Partial<ReplayStatus>, "state"> & { state: string; message?: string };

export function ReplayControl({ release, initial }: Props) {
  const [view, setView] = useState<ReplayState>(initial);
  const [status, setStatus] = useState<ReplayStatus | null>(null);
  const [passcode, setPasscode] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const enabled = initial.state !== "disabled";

  const show = (answer: Answer) => {
    if (answer.state === "unauthorized") {
      setSignedIn(false);
      setView({ state: "ready", reason: answer.message ?? "" });
      return;
    }
    if (answer.state === "unavailable" || answer.state === "bad_request") {
      setView({ state: "unavailable", reason: answer.message ?? "" });
      return;
    }
    setSignedIn(true);
    if (answer.release_id !== undefined) setStatus(answer as ReplayStatus);
    setView({ state: answer.state as ReplayState["state"], reason: answer.message ?? "" });
  };

  const refresh = async (requestId: string) => {
    try {
      const response = await fetch(`/api/judge/status?request_id=${requestId}`, { cache: "no-store" });
      show((await response.json()) as Answer);
    } catch {
      // A failed poll keeps the view; a fresh copy of it arms the next poll.
      setView((current) => ({ ...current }));
    }
  };

  useEffect(() => {
    const requestId = enabled ? window.localStorage.getItem(REQUEST_KEY) : null;
    if (requestId !== null) void refresh(requestId);
  }, [enabled]);

  useEffect(() => {
    const requestId = window.localStorage.getItem(REQUEST_KEY);
    if (requestId === null || (view.state !== "starting" && view.state !== "running")) return undefined;
    const timer = window.setTimeout(() => void refresh(requestId), POLL_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [view, status]);

  const signIn = async (event: SyntheticEvent) => {
    event.preventDefault();
    const response = await fetch("/api/judge/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
    setPasscode("");
    if (response.ok) {
      setSignedIn(true);
      setView({ state: "ready", reason: "Signed in. A replay runs three fresh copies of the released case." });
    } else show((await response.json()) as Answer);
  };

  const start = async () => {
    // The new request ID is kept before the POST, so a refresh during it resumes the replay; a
    // refused POST puts back the earlier replay's ID.
    const previous = window.localStorage.getItem(REQUEST_KEY);
    const requestId = crypto.randomUUID();
    window.localStorage.setItem(REQUEST_KEY, requestId);
    // A new start drops the earlier replay's status, so a refusal shows its own reason.
    setStatus(null);
    setView({ state: "starting", reason: "" });
    const response = await fetch("/api/judge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: requestId }) });
    const answer = (await response.json()) as Answer;
    if (["unavailable", "bad_request", "unauthorized"].includes(answer.state)) {
      if (previous === null) window.localStorage.removeItem(REQUEST_KEY);
      else window.localStorage.setItem(REQUEST_KEY, previous);
    }
    show(answer);
    if (answer.state === "starting") await refresh(requestId);
  };

  const busy = view.state === "starting" || view.state === "running";
  return (
    <ReplayPanel release={release} state={view.state} reason={view.reason} status={status}>
      {enabled && !signedIn ? (
        <form onSubmit={(event) => void signIn(event)}>
          <label htmlFor="judge-passcode">Judge passcode</label>{" "}
          <input id="judge-passcode" type="password" autoComplete="off" value={passcode} onChange={(event) => { setPasscode(event.target.value); }} />{" "}
          <button type="submit" disabled={passcode === ""}>
            Sign in
          </button>
        </form>
      ) : null}
      <button type="button" disabled={!enabled || !signedIn || busy} aria-describedby="replay-status" onClick={() => void start()}>
        Plant and verify this example
      </button>
    </ReplayPanel>
  );
}
