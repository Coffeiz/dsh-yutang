export type ServerLogLevel = "debug" | "info" | "warn" | "error";

export type ServerLogEntry = {
  source: "server";
  time: string;
  request_id: string | null;
  level: ServerLogLevel;
  method: string | null;
  route: string | null;
  status: number | null;
  duration_ms: number | null;
  message: string;
  error_type: string | null;
};

const maxEntries = 500;
const entries: ServerLogEntry[] = [];

function record(entry: ServerLogEntry) {
  entries.push(entry);
  if (entries.length > maxEntries) entries.shift();
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.length <= 2000 ? value : null;
}

/** Keep a small, sanitized in-memory view of Pino logs for the Admin console. */
export function captureServerLog(line: string) {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object") return;
    const log = value as Record<string, unknown>;
    const rawLevel = typeof log.level === "number" ? log.level : 30;
    const level: ServerLogLevel = rawLevel >= 50 ? "error" : rawLevel >= 40 ? "warn" : rawLevel < 30 ? "debug" : "info";
    const req = log.req && typeof log.req === "object" ? log.req as Record<string, unknown> : {};
    const response = log.res && typeof log.res === "object" ? log.res as Record<string, unknown> : {};
    const time = typeof log.time === "number" ? new Date(log.time).toISOString() : new Date().toISOString();
    const message = safeString(log.msg);
    if (!message) return;
    record({
      source: "server",
      time,
      request_id: safeString(log.requestId) ?? safeString(req.requestId) ?? safeString(log.reqId),
      level,
      method: safeString(req.method),
      route: safeString(req.url),
      status: typeof response.statusCode === "number" ? response.statusCode : null,
      duration_ms: typeof log.responseTime === "number" ? Math.round(log.responseTime) : null,
      message,
      error_type: safeString(log.errName) ?? (log.err && typeof log.err === "object"
        ? safeString((log.err as Record<string, unknown>).type) ?? safeString((log.err as Record<string, unknown>).name)
        : null),
    });
  } catch {
    // Ignore malformed logger lines; normal stdout logging still receives them.
  }
}

export function listServerLogs(): ServerLogEntry[] {
  return entries.slice();
}

export const serverLogStream = {
  write(line: string) {
    process.stdout.write(line);
    captureServerLog(line);
  },
};
