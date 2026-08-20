/**
 * Structured logger for base runtime modules — JSON lines to stdout, same shape the
 * platform's pino logs settle into, so compiled and interpreted runs look identical
 * to any log ingestion. No pino dependency: base stays lean, and a line is a line.
 */

export interface Logger {
  error: (message: string, data?: any) => void;
  warn: (message: string, data?: any) => void;
  info: (message: string, data?: any) => void;
  debug: (message: string, data?: any) => void;
}

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  return LEVELS[process.env.LOG_LEVEL?.toLowerCase() ?? "info"] ?? LEVELS.info;
}

export function createLogger(context: string): Logger {
  const log = (level: string, message: string, data?: any) => {
    if ((LEVELS[level] ?? LEVELS.info) < threshold()) return;
    const line: Record<string, unknown> = { level, context, msg: message, time: new Date().toISOString() };
    if (data !== undefined) line.data = data;
    console.log(JSON.stringify(line));
  };
  return {
    error: (message, data) => log("error", message, data),
    warn: (message, data) => log("warn", message, data),
    info: (message, data) => log("info", message, data),
    debug: (message, data) => log("debug", message, data),
  };
}
