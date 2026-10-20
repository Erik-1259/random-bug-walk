type ErrorCode =
  | 'invalid_json'
  | 'validation_failed'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'internal_error'
  | 'database_unavailable';

const STATUS: Record<ErrorCode, number> = {
  invalid_json: 400,
  validation_failed: 400,
  not_found: 404,
  method_not_allowed: 405,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
  database_unavailable: 503,
};

const MESSAGE: Record<ErrorCode, string> = {
  invalid_json: 'The request body must be a JSON object.',
  validation_failed: 'A field or query parameter is invalid.',
  not_found: 'The resource was not found.',
  method_not_allowed: 'The method is not allowed for this resource.',
  payload_too_large: 'The request body exceeds 64 KiB.',
  unsupported_media_type: 'The content type must be application/json.',
  internal_error: 'An internal error occurred.',
  database_unavailable: 'The database is unavailable.',
};

type Options = { field?: string; allow?: string; cause?: unknown };

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly field: string | undefined;
  readonly allow: string | undefined;

  constructor(code: ErrorCode, options: Options = {}) {
    super(MESSAGE[code], { cause: options.cause });
    this.name = 'HttpError';
    this.code = code;
    this.status = STATUS[code];
    this.field = options.field;
    this.allow = options.allow;
  }

  body(): { error: { code: ErrorCode; field?: string; message: string } } {
    return this.field === undefined
      ? { error: { code: this.code, message: this.message } }
      : { error: { code: this.code, field: this.field, message: this.message } };
  }
}
