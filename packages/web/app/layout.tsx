import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CODE_REPOSITORY, RESULTS_REPOSITORY } from "../src/components/case-page.tsx";
import { SiteNav } from "../src/components/site-nav.tsx";

export const metadata: Metadata = {
  title: { default: "Random Bug Walk", template: "%s · Random Bug Walk" },
  description: "Request synthetic bugs that an application's own tests miss, each delivered as a reproducible case with separate checks that prove it, and read a validated example. The planted bugs are synthetic.",
};

// System fonts and no external assets. Status is always written in text; color only repeats it.
// One frame for every page: the header, main and footer share the --frame width and the color tokens
// below (the /factory styles use them too). Narrow screens stack the suite matrix's six cells (and
// the replay's), each with its row and column label. Words wrap only where a line would overflow;
// long identifiers (code, hashes, file paths, run IDs) may also break anywhere, so no page scrolls
// sideways at 375 px and table headers never break mid-word. A wide table scrolls inside its own box.
const STYLES = `
:root { --ink: #142c3b; --muted: #415769; --border: #c8d5dc; --rule: #d7e0e5; --accent: #075e58; --accent-tint: #f1f8f6; --link: #074f77; --surface: #ffffff; --page: #f7f9fa; --focus: #936300; --warn-tint: #fff6d6; --warn: #8a6d00; --frame: 66rem; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; margin: 0; color: var(--ink); background: var(--page); overflow-wrap: break-word; }
a { color: var(--link); text-underline-offset: 0.18em; }
:is(a, button, input, select, textarea, summary):focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
h1 { font-size: clamp(2rem, 4.5vw, 2.75rem); line-height: 1.15; letter-spacing: -0.025em; margin: 1.5rem 0 1rem; }
.table-scroll { overflow-x: auto; }
main, .site-frame { box-sizing: border-box; max-width: var(--frame); margin: 0 auto; padding: 0 1rem; }
main { padding-bottom: 3rem; }
.site-header { background: var(--surface); border-bottom: 1px solid var(--border); }
.site-header .site-frame { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1.5rem; padding-block: 0.75rem; }
.site-brand { font-weight: 750; font-size: 1.1rem; letter-spacing: -0.01em; color: var(--ink); text-decoration: none; }
header nav { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; }
header nav a { color: var(--ink); text-decoration: none; padding: 0.25rem 0; border-bottom: 2px solid transparent; }
header nav a:hover { border-bottom-color: var(--border); }
header nav a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.site-footer { border-top: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 0.9rem; }
.site-footer .site-frame { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0.5rem 1.5rem; padding-block: 1.25rem; }
.site-footer p { margin: 0; }
.site-footer nav { display: flex; flex-wrap: wrap; gap: 0.25rem 1.25rem; }
table { border-collapse: collapse; margin: 0.75rem 0; background: var(--surface); }
th, td { border: 1px solid var(--border); padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
thead th { white-space: nowrap; }
caption { text-align: left; font-weight: 600; }
code, .hash { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.85em; word-break: break-all; overflow-wrap: anywhere; }
.files tbody th, .runs tbody th, .case-list td a { overflow-wrap: anywhere; }
.headline { font-size: 1.25rem; font-weight: 600; }
.model-credit, .built-with { border-left: 3px solid var(--accent); padding: 0.25rem 0 0.25rem 0.75rem; background: var(--accent-tint); }
.label { display: inline-block; padding: 0.1rem 0.5rem; border: 1px solid var(--warn); background: var(--warn-tint); }
.cell { border-top: 2px solid var(--rule); margin-top: 1.5rem; }
.status { font-weight: 600; }
.status-pass { background: #e3f4e3; }
.status-fail { background: #fde4e1; }
.status-invalid, .status-incomplete { background: #fff1d6; }
.status-not_run, .status-no_record { background: #ececec; }
.button-primary { font: inherit; font-weight: 600; margin: 0.25rem 0; padding: 0.5rem 1.1rem; border: 1px solid var(--accent); border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
.button-primary:hover:not(:disabled) { background: #054a45; border-color: #043c38; }
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
        <header className="site-header">
          <div className="site-frame">
            <a className="site-brand" href="/">Random Bug Walk</a>
            <SiteNav />
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="site-frame">
            <p>Random Bug Walk · Planted bugs are synthetic, made for testing.</p>
            <nav aria-label="Project">
              <a href={CODE_REPOSITORY}>Source code</a>
              <a href={RESULTS_REPOSITORY}>Published results</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
