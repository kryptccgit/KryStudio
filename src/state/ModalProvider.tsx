import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PromptOpts {
  title: string;
  message?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  validate?: (value: string) => string | null;
}

export interface ChooseOpts {
  title: string;
  message: string;
  choices: Array<{ id: string; label: string; tone?: 'primary' | 'danger' | 'neutral' }>;
  cancelLabel?: string;
}

interface ModalApi {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
  choose: (opts: ChooseOpts) => Promise<string | null>;
}

type Pending =
  | { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void }
  | { kind: 'choose'; opts: ChooseOpts; resolve: (v: string | null) => void };

const Ctx = createContext<ModalApi | null>(null);

export function useModal(): ModalApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useModal must be used inside <ModalProvider>');
  return ctx;
}

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<Pending[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const top = stack[stack.length - 1] ?? null;

  const open = useCallback((p: Pending) => {
    setStack((s) => [...s, p]);
    if (p.kind === 'prompt') {
      setText(p.opts.initialValue ?? '');
      setError(null);
    }
  }, []);

  const close = useCallback(() => {
    setStack((s) => s.slice(0, -1));
    setText('');
    setError(null);
  }, []);

  const api = useMemo<ModalApi>(
    () => ({
      confirm: (opts) => new Promise<boolean>((resolve) => open({ kind: 'confirm', opts, resolve })),
      prompt: (opts) => new Promise<string | null>((resolve) => open({ kind: 'prompt', opts, resolve })),
      choose: (opts) => new Promise<string | null>((resolve) => open({ kind: 'choose', opts, resolve })),
    }),
    [open],
  );

  const onConfirmYes = (): void => {
    if (!top || top.kind === 'choose') return;
    if (top.kind === 'confirm') {
      top.resolve(true);
      close();
    } else {
      const value = text.trim();
      if (top.opts.validate) {
        const v = top.opts.validate(value);
        if (v) {
          setError(v);
          return;
        }
      }
      top.resolve(value);
      close();
    }
  };
  const onConfirmNo = (): void => {
    if (!top) return;
    if (top.kind === 'confirm') top.resolve(false);
    else top.resolve(null);
    close();
  };
  const onChoose = (id: string): void => {
    if (!top || top.kind !== 'choose') return;
    top.resolve(id);
    close();
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      {top && (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in"
          data-krypt-modal=""
          role="dialog"
          aria-modal="true"
          onClick={onConfirmNo}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onConfirmNo();
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-white/10 bg-krypt-panel p-6 shadow-krypt-card animate-pop-in"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              className={
                top.kind === 'confirm' && top.opts.destructive
                  ? 'text-lg font-semibold text-rose-300'
                  : 'text-lg font-semibold text-white'
              }
            >
              {top.opts.title}
            </h3>
            {(top.kind === 'confirm' || top.kind === 'choose') && (
              <p className="mt-3 text-sm text-krypt-muted leading-relaxed whitespace-pre-line">{top.opts.message}</p>
            )}
            {top.kind === 'prompt' && (
              <>
                {top.opts.message && <p className="mt-3 text-sm text-krypt-muted">{top.opts.message}</p>}
                <input
                  autoFocus
                  ref={inputRef}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onConfirmYes();
                    if (e.key === 'Escape') onConfirmNo();
                  }}
                  placeholder={top.opts.placeholder}
                  className="mt-4 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder-krypt-muted/60 outline-none focus:border-krypt-purple/60"
                />
                {error && <div className="mt-2 text-xs text-rose-300">{error}</div>}
              </>
            )}
            {top.kind === 'choose' ? (
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  onClick={onConfirmNo}
                  className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-krypt-muted hover:bg-white/10 hover:text-white transition"
                >
                  {top.opts.cancelLabel ?? 'Cancel'}
                </button>
                {top.opts.choices.map((c, i) => (
                  <button
                    key={c.id}
                    autoFocus={c.tone === 'primary' || (i === top.opts.choices.length - 1 && !top.opts.choices.some((x) => x.tone === 'primary'))}
                    onClick={() => onChoose(c.id)}
                    className={
                      c.tone === 'danger'
                        ? 'rounded-lg border border-rose-500/60 bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/30 transition'
                        : c.tone === 'primary'
                          ? 'rounded-lg bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white shadow-krypt-glow hover:brightness-110 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-krypt-purple/70'
                          : 'rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10 transition'
                    }
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            ) : (
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onConfirmNo}
                className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-semibold text-krypt-muted hover:bg-white/10 hover:text-white transition"
              >
                {top.opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                onClick={onConfirmYes}
                className={
                  top.kind === 'confirm' && top.opts.destructive
                    ? 'rounded-lg border border-rose-500/60 bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 hover:bg-rose-500/30 transition'
                    : 'rounded-lg bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white shadow-krypt-glow hover:brightness-110 transition'
                }
              >
                {top.kind === 'confirm' ? top.opts.confirmLabel ?? 'Continue' : top.opts.confirmLabel ?? 'OK'}
              </button>
            </div>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
