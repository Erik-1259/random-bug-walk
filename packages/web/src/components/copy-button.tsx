"use client";

import { useState } from "react";

/** Copies a value the page also shows in full; when the browser refuses, it says to copy the shown text instead. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return <>
    <button type="button" className="factory-copy" onClick={() => { void copy(); }}>{label}</button>
    <span className="factory-note" aria-live="polite">{state === "copied" ? " Copied." : state === "failed" ? " Copying is blocked in this browser; select the ID instead." : ""}</span>
  </>;
}
