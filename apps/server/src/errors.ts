export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFound(code: string, message = "Resource not found") {
  return new ApiError(404, code, message);
}

export function conflict(code: string, message: string) {
  return new ApiError(409, code, message);
}
