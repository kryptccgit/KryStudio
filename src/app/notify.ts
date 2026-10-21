// ──────────────────────────────────────────────────────────────────────
// Non-React access to toasts and modals, so commands, keymaps and stores
// can give feedback too (house rule: nothing fails silently). The bridge
// component registers the provider APIs once at startup.
// ──────────────────────────────────────────────────────────────────────

import { useEffect } from 'react';
import { useToast, type ToastOpts } from '../state/ToastProvider';
import { useModal } from '../state/ModalProvider';
import type { ActionResult } from '@shared/types';

type ToastFns = ReturnType<typeof useToast>;
type ModalFns = ReturnType<typeof useModal>;

let toastApi: ToastFns | null = null;
let modalApi: ModalFns | null = null;
const recent = new Map<string, number>();

function push(level: keyof ToastFns, message: string, opts?: ToastOpts): void {
  // Coalesce identical messages fired in a burst (e.g. a drag hitting the same error).
  const key = `${level}:${message}`;
  const now = Date.now();
  const last = recent.get(key) ?? 0;
  if (now - last < 1200) return;
  recent.set(key, now);
  if (recent.size > 64) recent.clear();
  if (toastApi) toastApi[level](message, opts);
  else (level === 'error' ? console.error : console.info)(`[toast:${level}] ${message}`);
}

/** Toasts from anywhere. `opts.action` adds a button (e.g. "Open Model Manager"). */
export const toast = {
  info: (m: string, opts?: ToastOpts) => push('info', m, opts),
  success: (m: string, opts?: ToastOpts) => push('success', m, opts),
  warn: (m: string, opts?: ToastOpts) => push('warn', m, opts),
  error: (m: string, opts?: ToastOpts) => push('error', m, opts),
};

export type { ToastOpts };

export const modal = {
  confirm: (opts: Parameters<ModalFns['confirm']>[0]): Promise<boolean> => (modalApi ? modalApi.confirm(opts) : Promise.resolve(false)),
  prompt: (opts: Parameters<ModalFns['prompt']>[0]): Promise<string | null> => (modalApi ? modalApi.prompt(opts) : Promise.resolve(null)),
  /** Several answers (Save / Don't save / Cancel): the chosen id, or null when cancelled. */
  choose: (opts: Parameters<ModalFns['choose']>[0]): Promise<string | null> => (modalApi ? modalApi.choose(opts) : Promise.resolve(null)),
};

/** Toast a failed ActionResult (and optionally a success message). Returns r.ok. */
export function report(r: ActionResult | { ok: boolean; message?: string } | undefined | null, success?: string): boolean {
  if (!r) {
    toast.error('No response');
    return false;
  }
  if (!r.ok) {
    toast.error(r.message || 'Something went wrong');
    return false;
  }
  if (success) toast.success(success);
  return true;
}

/** Wrap any async call: exceptions become an error toast instead of an unhandled rejection. */
export async function attempt<T>(fn: () => Promise<T>, what: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    toast.error(`${what} failed: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

export function NotifyBridge(): null {
  const t = useToast();
  const m = useModal();
  useEffect(() => {
    toastApi = t;
    modalApi = m;
  }, [t, m]);
  return null;
}
