/** A refusal or misuse that the caller can act on. `code` is a stable snake_case identifier. */
export class SearchError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "SearchError";
    this.code = code;
  }
}
