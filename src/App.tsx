import { useEffect, useState } from 'react';
import { ToastProvider, useToast } from './state/ToastProvider';
import { ModalProvider } from './state/ModalProvider';
import { setDispatchErrorHandler, startDocSync, useDocStore } from './doc/store';
import { connectTelemetry } from './live/telemetry';
import { installLiveInput } from './live/liveInput';
import { installPluginSync } from './panels/pluginManager/store';
import { installAnalyzerSync } from './panels/modelManager/store';
import { installLibrarySync } from './library/store';
import { NotifyBridge } from './app/notify';
import { installHintTracking } from './app/hints';
import { registerAppCommands, openProject, importMidi } from './app/actions';
import { installInput } from './input/installInput';
import { installStatusFeeds } from './state/status';
import { installSelectionGuard } from './state/ui';
import { installAgentChat } from './panels/agent/chatStore';
import { onPopoutWindow, wm } from './workspace/WindowManager';
import { PANELS, type SingletonKind } from './workspace/panels';
import { Workspace } from './workspace/Workspace';
import { MenuHost } from './components/Menu';
import { DialogHost } from './components/Dialog';
import { TitleBar } from './app/TitleBar';
import { TransportBar } from './app/TransportBar';
import { StatusBar } from './app/StatusBar';
import { Splash } from './app/Splash';
import { handleOsDrop, hasFiles } from './app/fileDrop';
import { addSampleChannel } from './panels/channelRack/rackActions';
import { registerPianoRollCommands } from './panels/pianoRoll/commands';
import { HomeLayer, StudioArea } from './home/HomeView';
import { installHome, noteOpenFileRequest } from './home/store';
import { installCoverResponder } from './app/coverArt';
import { installTabs } from './app/tabs/commands';
import { TourHost } from './tours/TourOverlay';
import { BoothHost } from './booth/VocalBooth';
import { installControllers } from './input/controllers';

let booted = false;

function boot(): void {
  if (booted) return;
  booted = true;
  registerAppCommands();
  registerPianoRollCommands();
  installTabs();
  installInput(window);
  installHintTracking(document);
  onPopoutWindow((w) => installInput(w));
  installStatusFeeds();
  installAgentChat();
  installSelectionGuard();
  installLiveInput();
  installControllers();
  installPluginSync();
  installAnalyzerSync();
  installLibrarySync();
  installCoverResponder();
  void connectTelemetry();
  window.addEventListener('krypt:open-panel', (e) => {
    const id = String((e as CustomEvent).detail ?? '');
    if (id in PANELS && id !== 'plugin') wm.open(id as SingletonKind);
  });
  window.krypt.app.onOpenFile((path) => {
    noteOpenFileRequest();
    if (/\.mid(i)?$/i.test(path)) void importMidi(path);
    else void openProject(path);
  });
  installHome();
}

function Shell() {
  return (
    <div
      className="relative flex h-full flex-col overflow-hidden bg-krypt-void"
      onDragOver={(e) => {
        if (hasFiles(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        if (!hasFiles(e) || e.defaultPrevented) return;
        e.preventDefault();
        void handleOsDrop(e.dataTransfer, async (paths) => {
          for (const p of paths) await addSampleChannel(p);
        });
      }}
    >
      <div className="pointer-events-none fixed inset-0 bg-krypt-radial" />
      <TitleBar />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <StudioArea>
          <TransportBar />
          <main className="relative isolate min-h-0 flex-1">
            <Workspace />
          </main>
          <StatusBar />
        </StudioArea>
        <HomeLayer />
      </div>
      <MenuHost />
      <DialogHost />
      <TourHost />
      <BoothHost />
    </div>
  );
}

function Boot() {
  const ready = useDocStore((s) => s.ready);
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDispatchErrorHandler((_cmd, message) => toast.error(message));
  }, [toast]);

  useEffect(() => {
    let alive = true;
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The app did not answer within 20 seconds.')), 20000));
    Promise.race([startDocSync(), timeout])
      .then(() => {
        if (alive) boot();
      })
      .catch((err: Error) => {
        if (alive) setError(err?.message ?? String(err));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error && !ready) return <Splash error={error} onRetry={() => window.location.reload()} />;
  if (!ready) return <Splash />;
  return <Shell />;
}

export function App() {
  return (
    <ToastProvider>
      <ModalProvider>
        <NotifyBridge />
        <Boot />
      </ModalProvider>
    </ToastProvider>
  );
}
