import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Random Bug Walk results",
  description: "Evidence page and diagnostic catalog of a hackathon prototype. The planted bugs are synthetic.",
};

// System fonts and no external assets. Status is always written in text; color only repeats it.
// Narrow screens stack the suite matrix's six cells, each with its row and column label.
const STYLES = `
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; margin: 0; color: #1a1a1a; background: #fff; }
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
.matrix .cell-label { display: none; }
.matrix .detail { display: block; font-size: 0.9em; }
@media (max-width: 40rem) {
  .matrix, .matrix tbody, .matrix tr, .matrix td { display: block; }
  .matrix thead, .matrix tbody th { display: none; }
  .matrix td { margin-bottom: 0.5rem; }
  .matrix .cell-label { display: block; font-weight: 600; }
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
