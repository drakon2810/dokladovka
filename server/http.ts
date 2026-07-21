export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function assertHttp(condition: unknown, statusCode: number, code: string, message: string): asserts condition {
  if (!condition) throw new HttpError(statusCode, code, message);
}
