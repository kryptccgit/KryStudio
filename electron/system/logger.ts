import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * In-process logger: stdout (dev), a size-capped file under userData
 * (packaged builds have no console), and listeners — ipc.ts forwards every
 * entry to the renderer as `log:append` so errors can surface as toasts.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  time: number;
}

const listeners = new Set<(e: LogEntry) => void>();
let logFile: string | null = null;
let fileFailed = false;

function sink(): string | null {
  if (logFile || fileFailed) return logFile;
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    try {
      if (fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, path.join(dir, 'main.old.log'));
    } catch {
      /* no existing log */
    }
  } catch {
    fileFailed = true;
  }
  return logFile;
}

function emit(level: LogLevel, message: string): void {
  const entry: LogEntry = { level, message, time: Date.now() };
  const stamp = new Date(entry.time).toISOString();
  const color = level === 'error' ? '\x1b[31m' : level === 'warn' ? '\x1b[33m' : '\x1b[36m';
  // eslint-disable-next-line no-console
  console.log(`${color}[${stamp}] ${level.toUpperCase()} ${message}\x1b[0m`);
  try {
    const p = sink();
    if (p) fs.appendFileSync(p, `[${stamp}] ${level.toUpperCase()} ${message}\n`);
  } catch {
    /* best effort */
  }
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* never let a sink break logging */
    }
  }
}

export const logger = {
  info: (m: string): void => emit('info', m),
  warn: (m: string): void => emit('warn', m),
  error: (m: string): void => emit('error', m),
  log: (level: LogLevel, m: string): void => emit(level, m),
  /** Console + file only (no renderer fan-out): chatty diagnostics. */
  debug(m: string): void {
    // eslint-disable-next-line no-console
    if (!app.isPackaged) console.log(`\x1b[90m${m}\x1b[0m`);
  },
  subscribe(fn: (e: LogEntry) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
