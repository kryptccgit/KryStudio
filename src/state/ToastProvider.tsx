import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

type Level = 'info' | 'success' | 'warn' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOpts {
  action?: ToastAction;
  durationMs?: number;
}

interface ToastEntry {
  id: number;
  level: Level;
  message: string;
  action?: ToastAction;
}

interface ToastApi {
  info: (msg: string, opts?: ToastOpts) => void;
  success: (msg: string, opts?: ToastOpts) => void;
  warn: (msg: string, opts?: ToastOpts) => void;
  error: (msg: string, opts?: ToastOpts) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const COLORS: Record<Level, { ring: string; icon: typeof CheckCircle2; tint: string }> = {
  info: { ring: 'border-indigo-400/40 bg-indigo-500/10', icon: Info, tint: 'text-indigo-300' },
  success: { ring: 'border-emerald-400/40 bg-emerald-500/10', icon: CheckCircle2, tint: 'text-emerald-300' },
  warn: { ring: 'border-amber-400/40 bg-amber-500/10', icon: AlertTriangle, tint: 'text-amber-300' },
  error: { ring: 'border-rose-400/40 bg-rose-500/10', icon: XCircle, tint: 'text-rose-300' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (level: Level, message: string, opts?: ToastOpts) => {
      const id = ++idRef.current;
      setToasts((cur) => [...cur, { id, level, message, action: opts?.action }]);
      window.setTimeout(() => remove(id), opts?.durationMs ?? (opts?.action ? 9000 : 4500));
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      info: (m, o) => push('info', m, o),
      success: (m, o) => push('success', m, o),
      warn: (m, o) => push('warn', m, o),
      error: (m, o) => push('error', m, o),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-[1000] flex flex-col gap-2 w-[360px]">
        {toasts.map((t) => {
          const c = COLORS[t.level];
          const Icon = c.icon;
          return (
            <div
              key={t.id}
              className={`pointer-events-auto animate-pop-in flex items-start gap-3 rounded-xl border ${c.ring} px-3 py-2.5 backdrop-blur-md shadow-krypt-card`}
            >
              <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${c.tint}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/95 leading-snug break-words">{t.message}</div>
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      remove(t.id);
                      t.action?.run();
                    }}
                    className="mt-2 inline-flex h-7 items-center rounded-lg border border-white/15 bg-white/[0.06] px-2.5 text-[12px] font-semibold text-white transition hover:border-white/25 hover:bg-white/10"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button onClick={() => remove(t.id)} className="text-krypt-muted hover:text-white transition">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
