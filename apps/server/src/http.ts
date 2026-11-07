import { z } from "zod";
import { ApiError } from "./errors.js";

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

export function pageLimit(value: unknown, fallback = 50, max = 100): number {
  const parsed = z.coerce.number().int().min(1).max(max).safeParse(value ?? fallback);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", `limit must be between 1 and ${max}`);
  return parsed.data;
}

export function success<T>(data: T) {
  return { data };
}

export function encodeCursor(parts: string[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(value: unknown, count: number): string[] | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 512) {
    throw new ApiError(400, "VALIDATION_ERROR", "cursor is invalid");
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(decoded) && decoded.length === count && decoded.every((part) => typeof part === "string")) {
      return decoded;
    }
  } catch {
    // Fall through to the stable validation response.
  }
  throw new ApiError(400, "VALIDATION_ERROR", "cursor is invalid");
}

export function idempotencyKey(request: import("fastify").FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.length < 8 || key.length > 128) {
    throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  }
  return key;
}
