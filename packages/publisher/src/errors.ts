/**
 * Invalid input or configuration (exit 4). The code names the problem; it never carries a
 * value from the input, a line of the redaction-values file or a staged path.
 */
export class InvalidInput extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "InvalidInput";
    this.code = code;
  }
}
