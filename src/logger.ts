/**
 * Minimal structured logger.
 *
 * IMPORTANT: all output goes to stderr. stdout belongs to the stdio MCP
 * transport — writing a single log line there would corrupt the protocol.
 * API keys are never passed to the logger, and the client redacts URLs before
 * they reach it.
 */
import type { LogLevel } from './config.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_WEIGHT[level];
  const emit = (levelName: Exclude<LogLevel, 'silent'>, message: string, meta?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[levelName] < threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: levelName,
      msg: message,
      ...(meta ?? {}),
    };
    try {
      process.stderr.write(`${JSON.stringify(record)}\n`);
    } catch {
      // A broken stderr must never take the server down.
    }
  };

  const make = (prefix?: string): Logger => ({
    debug: (message, meta) => emit('debug', prefix ? `${prefix}: ${message}` : message, meta),
    info: (message, meta) => emit('info', prefix ? `${prefix}: ${message}` : message, meta),
    warn: (message, meta) => emit('warn', prefix ? `${prefix}: ${message}` : message, meta),
    error: (message, meta) => emit('error', prefix ? `${prefix}: ${message}` : message, meta),
    child: (childPrefix: string) => make(prefix ? `${prefix}.${childPrefix}` : childPrefix),
  });

  return make();
}
