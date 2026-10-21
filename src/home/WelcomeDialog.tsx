import { Globe, MessageCircle, Sparkles } from 'lucide-react';
import { QUICKSTART_VIDEO, guideVideoById, isVideoReady } from '@shared/guides/videos';
import { openDialog } from '../components/Dialog';
import { report } from '../app/notify';
import { LINKS } from '../app/links';
import { VideoPlayer } from '../guides/VideoPlayer';
import { cls } from '../utils/format';
import { quickstartCardVisible } from './logic';
import { dismissQuickstart, homeFlags, quickstartDismissed } from './store';
import { FOCUS_RING } from './ui';

let shownThisSession = false;

export function maybeShowWelcome(): void {
  if (shownThisSession) return;
  const video = guideVideoById(QUICKSTART_VIDEO);
  if (!isVideoReady(video) || !quickstartCardVisible({ ready: true, dismissed: quickstartDismissed(), welcomeSeen: homeFlags().welcomeSeen })) return;
  shownThisSession = true;
  openDialog({
    key: 'welcome',
    title: 'Welcome to Krypt Studio',
    subtitle: 'The basics in 3 minutes: the keys, connecting your AI, and the tools.',
    icon: Sparkles,
    width: 880,
    render: (close) => <WelcomeView close={close} />,
    onClose: () => dismissQuickstart(),
  });
}

function WelcomeView({ close }: { close: () => void }) {
  const video = guideVideoById(QUICKSTART_VIDEO);
  if (!isVideoReady(video)) return null;
  const ext = (url: string) => () => void window.krypt.app.openExternal(url).then((r) => report(r));
  const link = 'inline-flex h-10 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold text-white transition hover:brightness-110 active:scale-[0.98]';
  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3">
        <VideoPlayer video={video} onEnded={() => dismissQuickstart()} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-white/[0.06] px-4 py-3">
        <button type="button" onClick={ext(LINKS.discord)} className={cls(link, 'bg-[#5865F2]', FOCUS_RING)} title="The Krypt Discord: help, feedback and what's new">
          <MessageCircle className="h-4 w-4" /> Join the Discord
        </button>
        <button type="button" onClick={ext(LINKS.tools)} className={cls(link, 'bg-krypt-gradient', FOCUS_RING)} title="More free Krypt tools at krypt.cc/tools">
          <Globe className="h-4 w-4" /> More free tools
        </button>
        <span className="min-w-0 flex-1 text-right text-[11px] text-krypt-muted">Watch it again any time: Help ▸ Video tutorials.</span>
        <button type="button" onClick={close} className={cls('inline-flex h-10 items-center rounded-xl border border-white/10 bg-white/5 px-4 text-[13px] font-semibold text-white/90 transition hover:bg-white/10', FOCUS_RING)}>
          Start making music
        </button>
      </div>
    </div>
  );
}
