// Loading splash while the first document snapshot arrives (and the error
// state if it never does).

export function Splash({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div className="relative flex h-full items-center justify-center bg-krypt-void">
      <div className="pointer-events-none fixed inset-0 bg-krypt-radial" />
      <div className="app-drag fixed inset-x-0 top-0 h-8" />
      <div className="relative flex flex-col items-center animate-fade-in">
        <img
          src="./krypt.png"
          alt=""
          className="h-16 w-16 drop-shadow-[0_0_12px_rgba(168,85,247,0.6)]"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
        <div className="mt-4 text-2xl font-bold tracking-tight">
          <span className="text-krypt-gradient">Krypt</span> <span className="text-white">Studio</span>
        </div>
        {error ? (
          <div className="mt-5 max-w-sm text-center">
            <div className="text-sm font-semibold text-rose-300">Couldn't load the project</div>
            <div className="mt-1 break-words font-mono text-[11px] text-krypt-muted">{error}</div>
            {onRetry && (
              <button onClick={onRetry} className="mt-4 rounded-xl bg-krypt-gradient px-4 py-2 text-sm font-semibold text-white shadow-krypt-glow hover:brightness-110">
                Try again
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="mt-5 h-1 w-40 overflow-hidden rounded-full bg-white/10">
              <div className="krypt-loading-bar h-full w-1/3 rounded-full bg-krypt-gradient" />
            </div>
            <div className="mt-3 text-[11px] uppercase tracking-[0.2em] text-krypt-muted">Loading project</div>
          </>
        )}
      </div>
    </div>
  );
}
