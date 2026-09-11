import pino, { type Logger, type LoggerOptions } from "pino";

export interface CreateLoggerOptions {
  level?: LoggerOptions["level"];
  stream?: { write: (s: string) => void };
}

const REDACT_PATHS = [
  "pat",
  "*.pat",
  "pgUrl",
  "*.pgUrl",
  "slackToken",
  "*.slackToken",
  "password",
  "*.password",
  "email",
  "*.email",
];

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? "info",
    base: undefined,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
  };
  return opts.stream ? pino(options, opts.stream as any) : pino(options);
}
