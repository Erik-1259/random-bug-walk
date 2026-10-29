import { COPY_STATES, EXPECTED_CELLS, type SixCells } from "../../otf/contract.ts";
export function SixCellGrid({ cells, label }: { cells: SixCells | null; label: string }) {
  return <table><caption>{label}</caption><thead><tr><th scope="col">Copy</th><th scope="col">Original suite</th><th scope="col">Added checks</th></tr></thead>
    <tbody>{COPY_STATES.map(copy => <tr key={copy}><th scope="row">{copy}</th>{(["original_suite", "added_checks"] as const).map(check => <td key={check}>
      {cells === null ? "Not run" : `Observed: ${cells[copy][check]}`} <small>(expected {EXPECTED_CELLS[copy][check]})</small>
    </td>)}</tr>)}</tbody></table>;
}
