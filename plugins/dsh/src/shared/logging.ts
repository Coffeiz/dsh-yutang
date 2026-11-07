import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import type { LogLevel, LoggerLike, PluginLogEntry } from '../service/runtime.js'

export class YutangLogger implements LoggerLike {
  private nextId = 1
  private readonly entries: PluginLogEntry[] = []
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly base: LoggerLike = console, private readonly maxEntries = 500, private readonly filePath?: string) {}

  async initialize() {
    if (!this.filePath) return
    try {
      const lines = (await readFile(this.filePath, 'utf8')).split('\n').filter(Boolean).slice(-5000)
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as PluginLogEntry
          if (typeof entry.id === 'number' && typeof entry.time === 'number' && ['debug', 'info', 'warn', 'error'].includes(entry.level) && typeof entry.message === 'string') this.entries.push(entry)
        } catch { /* Ignore a truncated or malformed log line. */ }
      }
      this.nextId = Math.max(0, ...this.entries.map(entry => entry.id)) + 1
      if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  debug = (...args: unknown[]) => this.write('debug', args)
  info = (...args: unknown[]) => this.write('info', args)
  warn = (...args: unknown[]) => this.write('warn', args)
  error = (...args: unknown[]) => this.write('error', args)

  list(limit = 200): PluginLogEntry[] {
    const safeLimit = Math.max(1, Math.min(this.maxEntries, Math.trunc(limit || 200)))
    return this.entries.slice(-safeLimit)
  }

  private write(level: LogLevel, args: unknown[]) {
    const message = args.map(value => formatArgument(value)).join(' ').replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, '[REDACTED PRIVATE KEY]')
      .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [REDACTED]')
      .replace(/\b(token|secret|password|registration[_-]?code|signature|api[_-]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/giu, (_match, key: string, separator: string, value: string) => `${key}${separator}${value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : value.endsWith('"') ? '[REDACTED]"' : value.endsWith("'") ? "[REDACTED]'" : '[REDACTED]'}`)
      .replace(/([?&](?:token|secret|password|registration[_-]?code|signature|api[_-]?key)=)[^&\s]+/giu, '$1[REDACTED]')
      .slice(0, 8_000)
    this.entries.push({ id: this.nextId++, time: Date.now(), level, message })
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
    if (this.filePath) {
      const entry = this.entries.at(-1)!
      this.writes = this.writes.then(async () => {
        await appendFile(this.filePath!, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
        const lines = (await readFile(this.filePath!, 'utf8')).split('\n').filter(Boolean)
        if (lines.length > 5000) {
          const temporary = `${this.filePath}.tmp`
          await writeFile(temporary, `${lines.slice(-5000).join('\n')}\n`, { mode: 0o600 })
          await rename(temporary, this.filePath!)
        }
      }).catch(() => { /* Logging must not interrupt plugin operation. */ })
    }
    const sink = this.base[level] ?? this.base.info
    if (sink) sink.call(this.base, message)
    else (console[level] ?? console.log)(message)
  }
}

function formatArgument(value: unknown): string {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, (key, item: unknown) => isSensitiveKey(key) ? '[REDACTED]' : item) ?? String(value) } catch { return String(value) }
}

function isSensitiveKey(key: string): boolean {
  return /(?:authorization|access[_-]?token|refresh[_-]?token|token|secret|password|registration[_-]?code|signature|private[_-]?key|api[_-]?key)/iu.test(key)
}
