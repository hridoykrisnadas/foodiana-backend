/** An error that is safe to surface to API clients verbatim. */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Insufficient permissions') =>
  new ApiError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found') =>
  new ApiError(404, 'NOT_FOUND', message);

export const conflict = (message: string, details?: unknown) =>
  new ApiError(409, 'CONFLICT', message, details);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(422, code, message, details);

export const upstream = (message = 'Database request failed', details?: unknown) =>
  new ApiError(502, 'UPSTREAM_ERROR', message, details);
