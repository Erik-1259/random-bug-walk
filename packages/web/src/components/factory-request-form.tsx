"use client";

import { useState } from "react";
import type { FactoryPlan } from "../assist/plan.ts";
import type { Capabilities, RequestInput } from "../factory/client.ts";
import { CALENDAR_HINT, calendarClosedHosts, describeSupport, formatBudgetInput, formatUsd } from "../factory/format.ts";

type Item = RequestInput["items"][number];
export interface FactoryDraftRow {
  item_key: string;
  bug_type_id: Item["bug_type_id"] | "";
  quantity: string;
  description: string;
  difficulty: Item["difficulty"] | "";
}

export function usdToMicrousd(value: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole = "", fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

/** Plain names for the difficulty options; an option the service adds later keeps its own label. */
const DIFFICULTY_LABELS: Record<string, string> = {
  source_inferable_allowed: "Any difficulty",
  source_only_difficulty_required: "Hard to spot by reading the code",
};

export function prepareFactoryInput(capabilities: Capabilities, hosts: RequestInput["hosts"], rows: readonly FactoryDraftRow[], budget: string): { input: RequestInput | null; errors: string[]; fieldErrors: Record<string, string> } {
  const errors: string[] = [];
  const fieldErrors: Record<string, string> = {};
  const limits = capabilities.limits;
  if (hosts.length === 0 || new Set(hosts).size !== hosts.length || hosts.some((host) => !capabilities.hosts.some((option) => option.host_id === host))) errors.push("Select at least one available application.");
  if (rows.length === 0 || rows.length > limits.max_items) errors.push(`Choose between 1 and ${String(limits.max_items)} request items.`);
  const items: Item[] = [];
  for (const [index, row] of rows.entries()) {
    const label = `Item ${String(index + 1)}`;
    const quantity = Number(row.quantity);
    if (!/^\d+$/.test(row.quantity) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > limits.max_quantity_per_item) {
      const message = `${label}: quantity must be between 1 and ${String(limits.max_quantity_per_item)}.`;
      errors.push(message); fieldErrors[`factory-quantity-${row.item_key}-error`] = message;
    }
    if (Array.from(row.description.trim()).length > limits.max_description_chars) {
      const message = `${label}: description exceeds ${String(limits.max_description_chars)} Unicode code points after trimming surrounding whitespace.`;
      errors.push(message); fieldErrors[`factory-description-${row.item_key}-error`] = message;
    }
    if (row.bug_type_id === "" || !capabilities.bug_types.some((type) => type.bug_type_id === row.bug_type_id)) errors.push(`${label}: choose an available bug type.`);
    if (row.difficulty === "" || !capabilities.difficulty_options.some((option) => option.option_id === row.difficulty && option.available)) errors.push(`${label}: the selected difficulty option is unavailable.`);
    if (row.bug_type_id !== "" && row.difficulty !== "") items.push({ item_key: row.item_key, bug_type_id: row.bug_type_id, quantity, description: row.description.trim() || null, difficulty: row.difficulty });
  }
  if (rows.reduce((total, row) => total + Number(row.quantity), 0) > limits.max_total_quantity) errors.push(`The total quantity must not exceed ${String(limits.max_total_quantity)}.`);
  const amount = usdToMicrousd(budget);
  if (amount === null || amount < limits.min_budget_microusd || amount > limits.max_budget_microusd) {
    const message = `Enter a shared budget between ${formatUsd(limits.min_budget_microusd, "up")} and ${formatUsd(limits.max_budget_microusd, "down")}, for example ${formatBudgetInput(limits.default_budget_microusd)}.`;
    errors.push(message); fieldErrors["factory-budget-error"] = message;
  }
  return { input: errors.length === 0 && amount !== null ? { hosts, items, budget_microusd: amount } : null, errors, fieldErrors };
}

/** Hosts tried first for the form's starting selection: the task-and-report service is the quicker first request. */
const PREFERRED_HOSTS: readonly string[] = ["task-report"];

/**
 * The form's starting selection: one host and a bug type the service reports as supported on it, so
 * a first review is not refused for its defaults. A UI default only; the service still interprets
 * whatever the visitor sends. Without any supported pair it falls back to the first host and type.
 */
export function defaultSelection(capabilities: Capabilities): { hosts: RequestInput["hosts"]; bugTypeId: FactoryDraftRow["bug_type_id"] } {
  const order = [...capabilities.hosts].sort((a, b) => Number(!PREFERRED_HOSTS.includes(a.host_id)) - Number(!PREFERRED_HOSTS.includes(b.host_id)));
  for (const host of order) {
    const type = capabilities.bug_types.find((option) => capabilities.combinations.some((combination) =>
      combination.host_id === host.host_id && combination.bug_type_id === option.bug_type_id && combination.status === "supported"));
    if (type !== undefined) return { hosts: [host.host_id], bugTypeId: type.bug_type_id };
  }
  return { hosts: capabilities.hosts.slice(0, 1).map((host) => host.host_id), bugTypeId: capabilities.bug_types[0]?.bug_type_id ?? "" };
}

interface Props {
  capabilities: Capabilities | null;
  disabled: boolean;
  onInterpret: (input: RequestInput) => void;
  onChange: () => void;
  /** A plan from the bug designer: the form starts from it. Pass a new `key` to the form with each plan. */
  plan?: FactoryPlan | null;
  /** Hosts the calendar closes now (a UI hint); without it, the ones the capabilities report closed. */
  closedHosts?: readonly string[];
}

export function FactoryRequestForm(props: Props) {
  return <section aria-labelledby="factory-draft-heading" className="factory-panel">
    <h2 id="factory-draft-heading" tabIndex={-1}>Request synthetic bugs</h2>
    {props.capabilities === null
      ? <><p>Available applications, bug types, and budget limits could not be loaded. Requests are disabled.</p><button type="button" disabled>Review requirements</button></>
      : <RequestFields {...props} capabilities={props.capabilities} />}
  </section>;
}

/** The plan's host and bug type when the service offers both; otherwise the form's usual default. */
export function startingSelection(capabilities: Capabilities, plan: FactoryPlan | null | undefined): { hosts: RequestInput["hosts"]; bugTypeId: FactoryDraftRow["bug_type_id"]; description: string; fromPlan: boolean } {
  if (plan != null && capabilities.hosts.some((host) => host.host_id === plan.host_id) && capabilities.bug_types.some((type) => type.bug_type_id === plan.bug_type_id)) {
    return { hosts: [plan.host_id], bugTypeId: plan.bug_type_id, description: plan.description, fromPlan: true };
  }
  return { ...defaultSelection(capabilities), description: "", fromPlan: false };
}

function RequestFields({ capabilities, disabled, onInterpret, onChange, plan, closedHosts = calendarClosedHosts(capabilities) }: Props & { capabilities: Capabilities }) {
  const [initial] = useState(() => startingSelection(capabilities, plan));
  const newRow = (key: number): FactoryDraftRow => ({ item_key: `item-${String(key)}`, bug_type_id: initial.bugTypeId, quantity: "1", description: "", difficulty: capabilities.difficulty_options.find((option) => option.default && option.available)?.option_id ?? "" });
  const [hosts, setHosts] = useState<RequestInput["hosts"]>(initial.hosts);
  const [rows, setRows] = useState<FactoryDraftRow[]>(() => [{ ...newRow(1), description: initial.description }]);
  const [nextKey, setNextKey] = useState(2);
  const [budget, setBudget] = useState(() => formatBudgetInput(capabilities.limits.default_budget_microusd));
  const prepared = prepareFactoryInput(capabilities, hosts, rows, budget);
  const update = (key: string, changes: Partial<FactoryDraftRow>) => { onChange(); setRows((current) => current.map((row) => row.item_key === key ? { ...row, ...changes } : row)); };
  return <form className="factory-form" onSubmit={(event) => {
    event.preventDefault();
    if (!disabled && prepared.input !== null) onInterpret(prepared.input);
  }}>
    {plan != null && initial.fromPlan && <p className="factory-note" role="status">Filled from your bug design{plan.exact ? "" : ": the closest proven bug on this application, with no description"}. Check it, change anything, then review.</p>}
    <p>Pick an application and the kind of bug you want, then review. Reviewing is free and starts no work. Each item keeps its own description and quantity.</p>
    <fieldset disabled={disabled}>
      <legend>Applications and request items</legend>
      <fieldset><legend>Choose one or both applications</legend>
        {capabilities.hosts.map((host) => <label key={host.host_id}>
          {/* A closed host cannot be added, but one already selected (from a plan or before a refresh) can be removed. */}
          <input type="checkbox" checked={hosts.includes(host.host_id)} disabled={closedHosts.includes(host.host_id) && !hosts.includes(host.host_id)}
            aria-describedby={closedHosts.includes(host.host_id) ? `factory-calendar-${host.host_id}` : undefined} onChange={(event) => {
            onChange(); setHosts((current) => event.target.checked ? [...current, host.host_id] : current.filter((id) => id !== host.host_id));
          }} /> {host.label} — {host.description}
        </label>)}
        {capabilities.hosts.some((host) => host.host_id === "umami") && <p className="factory-note">Umami cases include the bug report that NVIDIA Nemotron 3.5 Lightning wrote on Nebius Token Factory for the completed example. A request itself makes no model call.</p>}
        {capabilities.hosts.filter((host) => closedHosts.includes(host.host_id)).map((host) => <p key={host.host_id} id={`factory-calendar-${host.host_id}`} className="factory-badge">{CALENDAR_HINT}</p>)}
      </fieldset>
      {rows.map((row, index) => <fieldset className="factory-request-row" key={row.item_key}>
        <legend>Request item {index + 1}</legend>
        <label htmlFor={`factory-type-${row.item_key}`}>Bug type for item {index + 1}</label>
        <select id={`factory-type-${row.item_key}`} value={row.bug_type_id} onChange={(event) => {
          const type = capabilities.bug_types.find((option) => option.bug_type_id === event.target.value);
          update(row.item_key, { bug_type_id: type?.bug_type_id ?? "" });
        }}>
          <option value="">Choose a bug type</option>
          {capabilities.bug_types.map((type) => <option key={type.bug_type_id} value={type.bug_type_id}>{type.label}</option>)}
        </select>
        <ul>{capabilities.combinations.filter((combination) => hosts.includes(combination.host_id) && combination.bug_type_id === row.bug_type_id).map((combination) => <li key={combination.host_id}>
          {capabilities.hosts.find((host) => host.host_id === combination.host_id)?.label}: {describeSupport(combination.status, combination.reason)}. {combination.reason}
          {combination.source !== null && <> {combination.source.entries} prepared {combination.source.entries === 1 ? "bug" : "bugs"} of this type to choose from.</>}
        </li>)}</ul>
        <label htmlFor={`factory-quantity-${row.item_key}`}>Quantity for item {index + 1}</label>
        <input id={`factory-quantity-${row.item_key}`} type="number" min={1} max={capabilities.limits.max_quantity_per_item} step={1} value={row.quantity}
          aria-invalid={Boolean(prepared.fieldErrors[`factory-quantity-${row.item_key}-error`])}
          aria-describedby={prepared.fieldErrors[`factory-quantity-${row.item_key}-error`] ? `factory-quantity-${row.item_key}-error` : undefined} onChange={(event) => { update(row.item_key, { quantity: event.target.value }); }} />
        <label htmlFor={`factory-description-${row.item_key}`}>Optional description for item {index + 1}</label>
        <textarea id={`factory-description-${row.item_key}`} value={row.description}
          aria-invalid={Boolean(prepared.fieldErrors[`factory-description-${row.item_key}-error`])}
          aria-describedby={`factory-description-${row.item_key}-help${prepared.fieldErrors[`factory-description-${row.item_key}-error`] ? ` factory-description-${row.item_key}-error` : ""}`} onChange={(event) => { update(row.item_key, { description: event.target.value }); }} />
        <p id={`factory-description-${row.item_key}-help`}>Optional. Up to {capabilities.limits.max_description_chars} characters, in your own words.</p>
        <details><summary>How characters are counted</summary><p>Limit: {capabilities.limits.max_description_chars} Unicode code points after trimming surrounding whitespace. Combining marks count separately.</p></details>
        <details><summary>Recognized behaviors</summary><ul>{capabilities.bug_types.find((type) => type.bug_type_id === row.bug_type_id)?.criteria.map((criterion) => <li key={criterion.criterion_id}>{criterion.label}: {criterion.example_phrases.join("; ")}</li>)}</ul></details>
        <label htmlFor={`factory-difficulty-${row.item_key}`}>Difficulty for item {index + 1}</label>
        <select id={`factory-difficulty-${row.item_key}`} value={row.difficulty} onChange={(event) => {
          const option = capabilities.difficulty_options.find((option) => option.option_id === event.target.value);
          update(row.item_key, { difficulty: option?.option_id ?? "" });
        }}>
          {capabilities.difficulty_options.map((option) => <option key={option.option_id} value={option.option_id} disabled={!option.available}>{DIFFICULTY_LABELS[option.option_id] ?? option.label}{option.available ? "" : " (not available yet)"}</option>)}
        </select>
        {capabilities.difficulty_options.filter((option) => !option.available).map((option) => <p key={option.option_id}>{option.reason}</p>)}
        <button type="button" disabled={rows.length === 1} onClick={(event) => {
          const remaining = rows.find((item) => item.item_key !== row.item_key);
          if (remaining !== undefined) event.currentTarget.form?.querySelector<HTMLInputElement>(`#factory-quantity-${remaining.item_key}`)?.focus();
          onChange(); setRows((current) => current.filter((item) => item.item_key !== row.item_key));
        }}>Remove item {index + 1}</button>
      </fieldset>)}
      <button id="factory-add-item" type="button" disabled={rows.length >= capabilities.limits.max_items} onClick={() => {
        onChange(); setRows((current) => [...current, newRow(nextKey)]); setNextKey((current) => current + 1);
      }}>Add request item</button>
      <label htmlFor="factory-budget">Shared budget (USD)</label>
      <input id="factory-budget" inputMode="decimal" value={budget} aria-invalid={Boolean(prepared.fieldErrors["factory-budget-error"])}
        aria-describedby={prepared.fieldErrors["factory-budget-error"] ? "factory-budget-help factory-budget-error" : "factory-budget-help"} onChange={(event) => { onChange(); setBudget(event.target.value); }} />
      <p id="factory-budget-help">One budget in US dollars covers every application and item in this request, paid from the shared judging budget. Allowed: {formatUsd(capabilities.limits.min_budget_microusd, "up")} to {formatUsd(capabilities.limits.max_budget_microusd, "down")}. Up to {capabilities.limits.max_total_quantity} cases in all.</p>
      <p>Cases are not graded for difficulty: a delivered bug may be easy or hard to spot by reading the code.</p>
      {prepared.errors.length > 0 && <ul aria-live="polite">{prepared.errors.map((error) => <li key={error} id={Object.entries(prepared.fieldErrors).find(([, message]) => message === error)?.[0]}>{error}</li>)}</ul>}
      <button className="factory-button" type="submit" disabled={prepared.input === null}>Review requirements</button>
    </fieldset>
  </form>;
}
