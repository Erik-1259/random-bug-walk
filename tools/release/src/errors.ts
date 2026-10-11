/** An input that cannot be used: a missing or malformed file or flag. Nothing was written or stored. */
export class ReleaseInputError extends Error {
  readonly code: string;

  constructor(code: string, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "ReleaseInputError";
    this.code = code;
  }
}
