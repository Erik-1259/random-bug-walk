"use client";

import { useState } from "react";

/** Local presentation fixtures only; this is not a service capability contract. */
export interface FactoryPreviewOption {
  id: string;
  label: string;
  hosts: readonly string[];
}
export interface FactoryDraftRow {
  id: number;
  type: string;
  quantity: string;
  specification: string;
}

export function factoryDraftErrors(rows: readonly FactoryDraftRow[], budget: string): string[] {
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (!/^\d+$/.test(row.quantity) || !Number.isSafeInteger(Number(row.quantity)) || Number(row.quantity) < 1) {
      errors.push(`Item ${String(index + 1)}: enter a positive whole-number quantity.`);
    }
  }
  if (budget !== "" && (!Number.isFinite(Number(budget)) || Number(budget) <= 0)) {
    errors.push("Enter a positive shared budget, or leave it blank until backend limits are available.");
  }
  return errors;
}

export function FactoryRequestForm({ previewOptions = [] }: { previewOptions?: readonly FactoryPreviewOption[] }) {
  const [host, setHost] = useState("umami");
  const [rows, setRows] = useState<FactoryDraftRow[]>([{ id: 1, type: "", quantity: "1", specification: "" }]);
  const [nextId, setNextId] = useState(2);
  const [budget, setBudget] = useState("");
  const errors = factoryDraftErrors(rows, budget);
  const budgetInvalid = factoryDraftErrors([], budget).length > 0;
  const selectedHosts = host === "both" ? ["umami", "custom"] : [host];
  const options = previewOptions.filter((option) => selectedHosts.every((selected) => option.hosts.includes(selected)));
  const update = (id: number, changes: Partial<FactoryDraftRow>) => { setRows((current) => current.map((row) => row.id === id ? { ...row, ...changes } : row)); };

  return <section aria-labelledby="factory-draft-heading" className="factory-panel">
    <h2 id="factory-draft-heading">Draft a bug request</h2>
    <p id="factory-draft-help">Local draft only. Nothing is sent or saved; reloading clears this draft. The live request service is not connected yet.</p>
    {previewOptions.length > 0 && <p role="note">Development fixture options below are for UI testing only. They do not declare supported backend combinations.</p>}
    <form className="factory-form" aria-describedby="factory-draft-help" onSubmit={(event) => { event.preventDefault(); }}>
      <label htmlFor="factory-host">Desired application</label>
      <select id="factory-host" value={host} onChange={(event) => { setHost(event.target.value); }} aria-describedby="factory-host-help">
        <option value="umami">Umami</option>
        <option value="custom">Custom task-and-report host</option>
        <option value="both">Both applications</option>
      </select>
      <p id="factory-host-help">Available applications and non-security bug types have not been confirmed. Choosing an application does not establish support.</p>
      {rows.map((row, index) => <fieldset className="factory-request-row" key={row.id}>
        <legend>Request item {index + 1}</legend>
        <label htmlFor={`factory-type-${String(row.id)}`}>Bug type for item {index + 1}</label>
        <select id={`factory-type-${String(row.id)}`} value={row.type} disabled={options.length === 0}
          onChange={(event) => { update(row.id, { type: event.target.value }); }}>
          <option value="">{options.length === 0 ? "Awaiting supported bug types" : "Choose a fixture bug type"}</option>
          {row.type !== "" && !options.some((option) => option.id === row.type) && <option value={row.type}>Previously selected fixture type — unavailable for this host selection</option>}
          {options.map((option) => <option key={option.id} value={option.id}>{option.label} (fixture)</option>)}
        </select>
        {row.type !== "" && !options.some((option) => option.id === row.type) && <p role="alert">Item {index + 1}: this fixture type is unsupported for the selected application combination. Choose another type; your description and quantity are preserved.</p>}
        <label htmlFor={`factory-quantity-${String(row.id)}`}>Desired quantity for item {index + 1}</label>
        <input id={`factory-quantity-${String(row.id)}`} type="number" min="1" step="1" value={row.quantity}
          aria-invalid={errors.includes(`Item ${String(index + 1)}: enter a positive whole-number quantity.`)} aria-describedby={errors.length > 0 ? "factory-draft-errors" : undefined}
          onChange={(event) => { update(row.id, { quantity: event.target.value }); }} />
        <label htmlFor={`factory-specification-${String(row.id)}`}>Optional plain-language specification for item {index + 1}</label>
        <textarea id={`factory-specification-${String(row.id)}`} value={row.specification}
          onChange={(event) => { update(row.id, { specification: event.target.value }); }} />
        <button className="factory-button" type="button" disabled={rows.length === 1} onClick={(event) => {
          event.currentTarget.form?.querySelector<HTMLButtonElement>("#factory-add-item")?.focus();
          setRows((current) => current.filter((item) => item.id !== row.id));
        }}>Remove item {index + 1}</button>
      </fieldset>)}
      <button id="factory-add-item" className="factory-button" type="button" onClick={() => {
        setRows((current) => [...current, { id: nextId, type: "", quantity: "1", specification: "" }]);
        setNextId((current) => current + 1);
      }}>Add request item</button>
      <label htmlFor="factory-budget">Desired shared budget (USD)</label>
      <input id="factory-budget" type="number" step="any" value={budget} aria-invalid={budgetInvalid}
        aria-describedby={budgetInvalid ? "factory-budget-help factory-draft-errors" : "factory-budget-help"}
        onChange={(event) => { setBudget(event.target.value); }} />
      <p id="factory-budget-help">One budget covers the whole request. Permitted limits and accounting are not available yet; this draft does not authorize spending.</p>
      <p>Source-inferable bugs are allowed by default. The harder per-description option is unavailable; no difficulty assessment is claimed.</p>
      {errors.length > 0 && <ul id="factory-draft-errors" aria-live="polite">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      <h3>Local draft summary</h3>
      <p>This repeats your entries; the request service has not interpreted or accepted your requirements.</p>
      <ul>{rows.map((row, index) => <li key={row.id}>
        Item {index + 1}: {row.quantity || "No quantity entered"} requested; {previewOptions.find((option) => option.id === row.type)?.label ?? "bug type not selected"}.
        {row.specification !== "" && <p>{row.specification}</p>}
      </li>)}</ul>
      <p>Requested application: {host === "both" ? "both applications" : host === "custom" ? "custom task-and-report host" : "Umami"}. Shared budget entry: {budget || "not entered"}.</p>
      <button className="factory-button" type="submit" disabled aria-describedby="factory-start-help">Start live request — unavailable</button>
      <p id="factory-start-help">Live requests are unavailable. Duplicate clicks cannot start a request. There is no active request to resume after reload.</p>
    </form>
  </section>;
}
