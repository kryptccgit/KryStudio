import { useEffect, useState } from 'react';
import { ExternalLink, Globe, MessageCircle, Wrench } from 'lucide-react';
import { report } from '../../app/notify';
import { LINKS } from '../../app/links';
import { VIDEO_CREDIT } from '@shared/guides/videos';

async function open(url: string): Promise<void> {
  try {
    report(await window.krypt.app.openExternal(url));
  } catch {
    window.open(url, '_blank');
  }
}

export function AboutPanel() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    window.krypt.app
      .version()
      .then(setVersion)
      .catch(() => setVersion(''));
  }, []);
  return (
    <div className="relative h-full overflow-y-auto">
      <div className="pointer-events-none absolute inset-0 bg-krypt-radial" />
      <div className="relative flex flex-col items-center px-6 pb-6 pt-8 text-center">
        <img
          src="./krypt.png"
          alt=""
          className="h-16 w-16 drop-shadow-[0_0_10px_rgba(168,85,247,0.6)]"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
        <h1 className="mt-3 text-2xl font-bold tracking-tight">
          <span className="text-krypt-gradient">Krypt</span> <span className="text-white">Studio</span>
        </h1>
        {version && <div className="mt-1 font-mono text-[11px] text-krypt-muted">v{version}</div>}
        <p className="mt-3 max-w-sm text-[13px] text-white/80">
          A pattern-based DAW for Windows with first-class AI agents. Step sequencer, piano roll, playlist, mixer — and every agent edit is one click from undone.
        </p>
        <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">Free & open source · no ads, no telemetry</div>

        <div className="mt-5 grid w-full max-w-sm grid-cols-2 gap-2">
          <button
            onClick={() => void open(LINKS.site)}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[12px] font-semibold text-white/90 transition hover:border-white/20 hover:bg-white/10"
          >
            <Globe className="h-4 w-4 text-krypt-purple" /> krypt.cc
          </button>
          <button
            onClick={() => void open(LINKS.discord)}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-[12px] font-semibold text-white/90 transition hover:border-white/20 hover:bg-white/10"
          >
            <MessageCircle className="h-4 w-4 text-krypt-purple" /> Discord
          </button>
        </div>
        <button
          onClick={() => void open(LINKS.tools)}
          className="mt-2 flex w-full max-w-sm items-center justify-center gap-2 rounded-xl bg-krypt-gradient px-3 py-2.5 text-[12px] font-semibold text-white shadow-krypt-glow transition hover:brightness-110"
        >
          <Wrench className="h-4 w-4" /> More free Krypt tools <ExternalLink className="h-3 w-3 opacity-70" />
        </button>

        <div className="mt-6 w-full max-w-sm rounded-xl border border-white/10 bg-krypt-panel/80 p-3 text-left text-[11px] text-krypt-muted">
          <div className="font-semibold text-white/85">MIT licensed</div>
          <div className="mt-1">Built with Electron, React, Rust and the Model Context Protocol. Third-party licenses ship in THIRD-PARTY-NOTICES.</div>
          <div className="mt-1">Provided as is, without warranty of any kind. Forks must rebrand: see TRADEMARKS.md.</div>
          <div className="mt-1">{VIDEO_CREDIT}</div>
          <div className="mt-2">FL Studio is a trademark of Image-Line Software. Krypt Studio is not affiliated with or endorsed by Image-Line; it shares the workflow, not the code, assets or trade dress.</div>
        </div>
      </div>
    </div>
  );
}
