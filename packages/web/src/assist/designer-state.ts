// The bug designer's steps as a reducer, so each state can be checked without a browser.
import type { AssistFailure, AssistHostId, ShapesResult, SpecResult } from "./client.ts";

export interface DesignerState {
  query: string;
  busy: "shapes" | "spec" | null;
  shapes: ShapesResult | null;
  shapeId: string | null;
  hostId: AssistHostId | null;
  spec: SpecResult | null;
  /** The shape and app the spec was written for; a spec shows only while both are still chosen. */
  specFor: string | null;
  failure: AssistFailure | null;
  /** The plan key last sent to the request form, for the "the form now holds this plan" note. */
  appliedFor: string | null;
}

export type DesignerAction =
  | { type: "query"; query: string }
  | { type: "search" }
  | { type: "shapes"; result: ShapesResult }
  | { type: "pick_shape"; shapeId: string }
  | { type: "pick_host"; hostId: AssistHostId }
  | { type: "write" }
  | { type: "spec"; result: SpecResult; specFor: string }
  | { type: "failed"; failure: AssistFailure }
  | { type: "applied"; appliedFor: string }
  | { type: "retry" };

export const INITIAL_DESIGNER: DesignerState = { query: "", busy: null, shapes: null, shapeId: null, hostId: null, spec: null, specFor: null, failure: null, appliedFor: null };

export const specKey = (shapeId: string, hostId: AssistHostId): string => `${shapeId}|${hostId}`;

export function designerReducer(state: DesignerState, action: DesignerAction): DesignerState {
  switch (action.type) {
    case "query": return { ...state, query: action.query };
    case "search": return { ...state, busy: "shapes", failure: null, shapes: null, shapeId: null, hostId: null, spec: null, specFor: null, appliedFor: null };
    case "shapes": return { ...state, busy: null, shapes: action.result };
    case "pick_shape": {
      const fit = state.shapes?.shapes.find((shape) => shape.id === action.shapeId)?.fit ?? null;
      return { ...state, shapeId: action.shapeId, hostId: fit?.host_id ?? state.hostId, failure: null, appliedFor: null };
    }
    case "pick_host": return { ...state, hostId: action.hostId, failure: null, appliedFor: null };
    case "write": return { ...state, busy: "spec", failure: null, appliedFor: null };
    case "spec": return { ...state, busy: null, spec: action.result, specFor: action.specFor };
    case "failed": return { ...state, busy: null, failure: action.failure };
    case "applied": return { ...state, appliedFor: action.appliedFor };
    case "retry": return { ...state, failure: null };
  }
}

/** The spec for the shape and app chosen now, or null when the choice has changed since it was written. */
export function currentSpec(state: DesignerState): SpecResult | null {
  if (state.spec === null || state.shapeId === null || state.hostId === null) return null;
  return state.specFor === specKey(state.shapeId, state.hostId) ? state.spec : null;
}
