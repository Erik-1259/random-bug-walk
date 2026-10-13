import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Random Bug Walk results",
  description: "Evidence page and diagnostic catalog of a hackathon prototype. The planted bugs are synthetic.",
};

// System fonts and no external assets. Status is always written in text; color only repeats it.
// Narrow screens stack the suite matrix's six cells (and the replay's), each with its row and column
// label. Long identifiers (hashes, UUIDs, image references, paths) wrap anywhere, so no page scrolls
// sideways at 375 px; a wide table scrolls inside its own box.
const STYLES = `
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; margin: 0; color: #1a1a1a; background: #fff; overflow-wrap: anywhere; }
.table-scroll { overflow-x: auto; }
header, main, footer { max-width: 60rem; margin: 0 auto; padding: 0 1rem; }
nav a { margin-right: 1rem; }
table { border-collapse: collapse; margin: 0.75rem 0; }
th, td { border: 1px solid #c8c8c8; padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
caption { text-align: left; font-weight: 600; }
code, .hash { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85em; word-break: break-all; }
.headline { font-size: 1.25rem; font-weight: 600; }
.label { display: inline-block; padding: 0.1rem 0.5rem; border: 1px solid #8a6d00; background: #fff6d6; }
.cell { border-top: 2px solid #d0d0d0; margin-top: 1.5rem; }
.status { font-weight: 600; }
.status-pass { background: #e3f4e3; }
.status-fail { background: #fde4e1; }
.status-invalid, .status-incomplete { background: #fff1d6; }
.status-not_run, .status-no_record { background: #ececec; }
.button-primary { font: inherit; font-weight: 600; margin: 0.25rem 0; padding: 0.5rem 1.1rem; border: 1px solid #0a4a9e; border-radius: 6px; background: #0b5cc4; color: #fff; cursor: pointer; }
.button-primary:hover:not(:disabled) { background: #094a9f; border-color: #073a7c; }
.button-primary:focus-visible { outline: 3px solid #f2b705; outline-offset: 2px; }
.button-primary:disabled { background: #d5dbe3; border-color: #b9c2cd; color: #5b6573; cursor: not-allowed; }
.replay-help { margin-top: 0; }
.matrix .cell-label { display: none; }
.matrix .detail { display: block; font-size: 0.9em; }
@media (max-width: 40rem) {
  .matrix, .matrix tbody, .matrix tr, .matrix td { display: block; }
  .matrix thead, .matrix tbody th { display: none; }
  .matrix td { margin-bottom: 0.5rem; }
  .matrix .cell-label { display: block; font-weight: 600; }
  .files, .files tbody, .files tr, .files th, .files td { display: block; }
  .files thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .files td[data-label]:not(:empty)::before { content: attr(data-label) ": "; font-weight: 600; }
  .files tr { border: 1px solid #c8c8c8; margin-bottom: 0.5rem; padding: 0.25rem 0.5rem; }
  .files th, .files td { border: 0; padding: 0; }
}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{STYLES}</style>
      </head>
      <body>
        <header>
          <nav aria-label="Site">
            <a href="/">Case</a>
            <a href="/catalog">Diagnostic catalog</a>
          </nav>
        </header>
        {children}
        <footer>
          <p>Random Bug Walk is a hackathon prototype. The planted bugs are synthetic.</p>
        </footer>
      </body>
    </html>
  );
}
