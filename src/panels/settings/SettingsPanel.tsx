import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import type { DeviceInfo } from '@shared/engine/protocol';
import type { FileAccessMode } from '@shared/types';
import { NumberInput, Switch } from '../../components/common';
import { Select } from '../../controls/Toggle';
import { refreshMcpStatus, updateSettings, useEngineStatus, useProjectStatus, useSettings } from '../../state/status';
import { report, toast } from '../../app/notify';
import { wm } from '../../workspace/WindowManager';
import { KeymapEditor } from './KeymapEditor';
import { LiveInputSettings } from './LiveInputSettings';
import { MidiOutSettings } from './MidiOutSettings';
import { ControllerSettings } from './ControllerSettings';
import { VoiceSettings } from '../../voice/VoiceSettings';

function Group({ title, description, children, 'data-guide': guide }: { title: string; description?: string; children: ReactNode; 'data-guide'?: string }) {
  return (
    <section className="mb-5" data-guide={guide}>
      <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-krypt-muted">{title}</h2>
      {description && <p className="mt-0.5 text-[11px] text-krypt-muted/80">{description}</p>}
      <div className="mt-2 space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-white">{label}</div>
        {hint && <div className="text-[10px] text-krypt-muted">{hint}</div>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

const FILE_ACCESS: Array<{ value: FileAccessMode; label: string; hint: string; toast: string }> = [
  {
    value: 'anywhere',
    label: 'Anywhere on this PC',
    hint: 'Agents open any audio file or folder you point them at, no questions asked. It is your computer.',
    toast: 'Agents can open audio files anywhere on this PC',
  },
  {
    value: 'ask',
    label: 'Ask me',
    hint: "Browser folders and this project's files open directly; for anything else Krypt Studio asks you first.",
    toast: 'Agents ask before opening files outside your Browser folders',
  },
  {
    value: 'browser',
    label: 'Browser folders only',
    hint: "Only the factory kit, your Browser folders and this project's own files. Never asks.",
    toast: 'Agents only open your Browser folders and project files',
  },
];

function FileAccessChoice({ value, onChange }: { value: FileAccessMode; onChange: (v: FileAccessMode) => void }) {
  return (
    <div role="radiogroup" aria-label="File access" className="space-y-1.5 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
      <div className="text-[12px] font-semibold text-white">File access</div>
      <div className="text-[10px] text-krypt-muted">Which audio files agents may open. Network (\\server) paths, device paths and non-audio files are refused in every mode.</div>
      {FILE_ACCESS.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={
              on
                ? 'flex w-full items-start gap-2 rounded-lg border border-krypt-purple/50 bg-krypt-purple/10 px-2.5 py-1.5 text-left'
                : 'flex w-full items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-2.5 py-1.5 text-left hover:border-white/20'
            }
          >
            <span className={on ? 'mt-[3px] h-2.5 w-2.5 flex-shrink-0 rounded-full bg-krypt-gradient shadow-krypt-glow' : 'mt-[3px] h-2.5 w-2.5 flex-shrink-0 rounded-full border border-white/30'} />
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold text-white">{o.label}</span>
              <span className="block text-[10px] leading-snug text-krypt-muted">{o.hint}</span>
            </span>
          </button>
        );
      })}
      <div className="text-[10px] text-krypt-muted/80">The local HTTP endpoint never gets “Anywhere”: it is treated as “Ask me”.</div>
    </div>
  );
}

const BUFFERS = [64, 128, 256, 512, 1024, 2048];
const RATES = [44100, 48000, 88200, 96000];

export function SettingsPanel() {
  const settings = useSettings((s) => s.settings);
  const engine = useEngineStatus((s) => s.status);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [exportDir, setExportDir] = useState('');
  const exportFolder = settings?.export?.folder;
  const projectPath = useProjectStatus((s) => s.status?.path ?? null);

  useEffect(() => {
    let live = true;
    window.krypt.project
      .exportCapabilities()
      .then((c) => live && setExportDir(c.agentFolder))
      .catch(() => live && setExportDir(''));
    return () => {
      live = false;
    };
  }, [exportFolder, projectPath]);

  const loadDevices = async (): Promise<void> => {
    setDevices(null);
    try {
      const r = await window.krypt.engine.listDevices();
      if (r.ok) setDevices(r.data ?? []);
      else {
        setDevices([]);
        toast.error(`Couldn't list audio devices: ${r.message ?? 'engine unavailable'}`);
      }
    } catch (err) {
      setDevices([]);
      toast.error((err as Error).message);
    }
  };

  useEffect(() => {
    void loadDevices();
  }, []);

  if (!settings)
    return (
      <div className="flex h-full items-center justify-center text-krypt-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );

  const applyAudio = async (patch: Partial<typeof settings.audio>): Promise<void> => {
    const audio = { ...settings.audio, ...patch };
    setApplying(true);
    try {
      const r = await window.krypt.engine.openDevice({ deviceId: audio.deviceId, bufferFrames: audio.bufferFrames, sampleRate: audio.sampleRate });
      if (report(r)) {
        const d = r.data;
        toast.success(d ? `Audio: ${d.name ?? 'device'} · ${d.sampleRate} Hz · ${d.bufferFrames} samples · ${d.outputLatencyMs.toFixed(1)} ms` : 'Audio device updated');
      }
      await updateSettings({ audio });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const dev = engine?.device;
  const deviceOptions = [
    { value: '', label: 'System default' },
    ...(devices ?? []).map((d) => ({ value: d.id, label: `${d.name}${d.isDefault ? ' (default)' : ''}`, detail: d.backend.toUpperCase() })),
  ];

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      <Group data-guide="settings.audio" title="Audio" description="Lower buffers = lower latency, higher CPU. 256 at 48 kHz is a good start.">
        <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[11px]">
          <div className="flex items-center gap-2">
            <span className={engine?.state === 'running' ? 'h-2 w-2 rounded-full bg-emerald-400' : 'h-2 w-2 rounded-full bg-amber-400'} />
            <span className="font-semibold text-white">Engine {engine?.state ?? 'unknown'}</span>
            {engine?.engineVersion && <span className="font-mono text-[9px] text-krypt-muted">v{engine.engineVersion}</span>}
            <button
              onClick={async () => {
                try {
                  report(await window.krypt.engine.restart(), 'Engine restarting');
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
              className="ml-auto flex items-center gap-1 text-[10px] text-krypt-muted hover:text-white"
            >
              <RotateCcw className="h-3 w-3" /> Restart engine
            </button>
          </div>
          <div className="mt-1 text-krypt-muted">
            {dev?.open
              ? `${dev.name} · ${dev.backend} · ${dev.sampleRate} Hz · ${dev.bufferFrames} samples · ${dev.outputLatencyMs.toFixed(1)} ms output latency`
              : engine?.message ?? dev?.message ?? 'No audio device open'}
          </div>
        </div>
        <Row label="Output device" hint="Windows audio (WASAPI shared mode)">
          <div className="flex items-center gap-1">
            <Select<string>
              value={settings.audio.deviceId ?? ''}
              options={deviceOptions}
              onChange={(v) => void applyAudio({ deviceId: v || null })}
              width={210}
              disabled={applying}
            />
            <button onClick={() => void loadDevices()} className="flex h-5 w-5 items-center justify-center rounded text-krypt-muted hover:text-white" data-hint="Rescan devices">
              {devices === null ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            </button>
          </div>
        </Row>
        <Row label="Buffer size" hint={`${((settings.audio.bufferFrames / settings.audio.sampleRate) * 1000).toFixed(1)} ms per buffer`}>
          <Select<number>
            value={settings.audio.bufferFrames}
            options={BUFFERS.map((b) => ({ value: b, label: `${b} samples` }))}
            onChange={(bufferFrames) => void applyAudio({ bufferFrames })}
            width={120}
            disabled={applying}
          />
        </Row>
        <Row label="Sample rate">
          <Select<number>
            value={settings.audio.sampleRate}
            options={RATES.map((r) => ({ value: r, label: `${r / 1000} kHz` }))}
            onChange={(sampleRate) => void applyAudio({ sampleRate })}
            width={120}
            disabled={applying}
          />
        </Row>
      </Group>

      <LiveInputSettings />
      <MidiOutSettings />
      <ControllerSettings />

      <Group title="Project">
        <Row label="Autosave every" hint="Crash-safe journal + backups. 0 turns timed autosave off.">
          <NumberInput value={settings.autosaveSec} min={0} max={3600} step={10} suffix="sec" onChange={(autosaveSec) => void updateSettings({ autosaveSec }, `Autosave every ${autosaveSec}s`)} />
        </Row>
        <Row label="Agent exports go to" hint={`Where export_audio saves${exportDir ? `: ${exportDir}` : ''}. Agents never pick the folder or overwrite a file.`}>
          <Select<'music' | 'project'>
            value={settings.export?.folder ?? 'music'}
            options={[
              { value: 'music', label: 'Music ▸ Krypt Studio' },
              { value: 'project', label: "The project's folder" },
            ]}
            onChange={(folder) =>
              void updateSettings({ export: { folder } }, folder === 'music' ? 'Agent exports go to Music ▸ Krypt Studio' : "Agent exports go next to the project file (Music ▸ Krypt Studio until it's saved)")
            }
            width={190}
          />
        </Row>
      </Group>

      <Group title="Agents (MCP)" description="Let Claude, Cursor and other MCP clients control the studio. Every agent edit is tagged and revertable.">
        <Switch
          checked={settings.mcp.enabled}
          onChange={async (enabled) => {
            try {
              const r = await window.krypt.mcp.setEnabled(enabled);
              if (report(r, enabled ? 'Agents can connect' : 'Agents disconnected')) {
                await updateSettings({ mcp: { ...settings.mcp, enabled } });
                void refreshMcpStatus();
              }
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
          label="Allow agents"
          description="The MCP server over a local named pipe (used by the bundled shim)."
        />
        <Switch
          checked={settings.mcp.httpEnabled}
          onChange={(httpEnabled) => void updateSettings({ mcp: { ...settings.mcp, httpEnabled } }, httpEnabled ? 'HTTP endpoint on' : 'HTTP endpoint off')}
          label="Local HTTP endpoint"
          description={`Streamable HTTP on 127.0.0.1:${settings.mcp.httpPort} with a token, for clients that can't spawn a process.`}
        />
        <Row label="HTTP port">
          <NumberInput value={settings.mcp.httpPort} min={1024} max={65535} onChange={(httpPort) => void updateSettings({ mcp: { ...settings.mcp, httpPort } })} />
        </Row>
        <FileAccessChoice
          value={settings.mcp.fileAccess ?? 'anywhere'}
          onChange={(fileAccess) => {
            if (fileAccess === (settings.mcp.fileAccess ?? 'anywhere')) return;
            void updateSettings({ mcp: { ...settings.mcp, fileAccess } }, FILE_ACCESS.find((o) => o.value === fileAccess)?.toast);
          }}
        />
        <Switch
          checked={settings.mcp.requireConsentForDestructive}
          onChange={(v) => void updateSettings({ mcp: { ...settings.mcp, requireConsentForDestructive: v } }, v ? 'Destructive agent actions need your OK' : 'Agents may delete without asking')}
          label="Ask before destructive agent actions"
          description="Deleting channels, patterns or inserts, and opening other projects."
        />
      </Group>

      <Group data-guide="settings.voice" title="Voice" description="Krypt Voice: local voices on your PC, or Fish Audio cloud voices with your own key.">
        <VoiceSettings />
      </Group>

      <Group title="Interface">
        <Switch
          checked={settings.ui.startWithWindows ?? true}
          onChange={(startWithWindows) =>
            void updateSettings({ ui: { ...settings.ui, startWithWindows } }, startWithWindows ? 'Krypt Studio starts quietly in the tray with Windows' : 'Krypt Studio no longer starts with Windows')
          }
          label="Start with Windows"
          description="Opens quietly in the tray when you sign in, so AI agents can reach it right away. Closing the window keeps it in the tray; File ▸ Exit quits."
        />
        <Switch
          checked={settings.ui.openToHome ?? true}
          onChange={(openToHome) => void updateSettings({ ui: { ...settings.ui, openToHome } }, openToHome ? 'Krypt Studio opens to Home' : 'Krypt Studio opens straight to the Studio')}
          label="Open to Home on launch"
          description="Start on the Home hub. Opening a project file always goes straight to the Studio."
        />
        <Switch
          checked={settings.ui.homeLite ?? false}
          onChange={(homeLite) => void updateSettings({ ui: { ...settings.ui, homeLite } }, homeLite ? 'Lite mode on: a still Home background' : 'Lite mode off')}
          label="Home lite mode"
          description="A still background on Home instead of the slow animated one. Use it if Home feels laggy."
        />
        <Switch
          checked={settings.ui.showHints}
          onChange={(showHints) => void updateSettings({ ui: { ...settings.ui, showHints } })}
          label="Hint bar"
          description="Describe whatever is under the mouse in the status bar."
        />
        <Row label="Window layout" hint="Put every window back where it starts.">
          <button onClick={() => wm.resetLayout()} className="h-6 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[11px] font-semibold text-white/90 hover:border-white/20">
            Reset layout
          </button>
        </Row>
      </Group>

      <Group title="Shortcuts" description="Rebind any command. Changes apply at once and are saved with your settings.">
        <KeymapEditor />
      </Group>
    </div>
  );
}
