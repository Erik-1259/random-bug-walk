/** Presentation boundary only. Replace with the published request contract's client when available. */
export interface FactoryAvailability {
  readonly state: "unavailable";
  readonly message: string;
}

export interface FactoryClient {
  availability(): Promise<FactoryAvailability>;
}

// No guessed endpoints, judge-session reuse, request submission or validation side effects.
export const factoryClient: FactoryClient = {
  availability: () => Promise.resolve({
    state: "unavailable",
    message: "New requests are not available yet. You can explore the completed example and prepare a local draft. No work will be started.",
  }),
};
