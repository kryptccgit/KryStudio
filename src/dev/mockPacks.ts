// Browser-only mock of window.krypt.packs: the catalog's packs (two made-up demo packs while the catalog is empty)
// with downloads simulated over about three seconds (progress events, Cancel, Remove, Update). Devtools:
// __kryptMockPacks.failNext() makes the next download fail with a checksum error; .installAll() / .reset().

import type { KryptApi } from '@shared/types';
import type { PackEntryState, PackStatus, PacksState } from '@shared/packs/types';
import { PACKS } from '@shared/packs/catalog';

const win = (...parts: string[]): string => parts.join(String.fromCharCode(92));
const DIR = win('C:', 'Users', 'you', 'AppData', 'Roaming', 'Krypt Studio', 'packs');
const MB = 1024 * 1024;

type Base = Omit<PackEntryState, 'status' | 'progress' | 'error'>;

/** Stand-ins for the browser mock only (never shipped as data): what a card looks like before the catalog lands. */
const DEMO: Base[] = [
  {
    id: 'demo-grand',
    name: 'Demo Grand Piano',
    description: 'Mock data: a sampled concert grand with several velocity layers, for exposed piano parts.',
    author: 'Mock recordist',
    licence: { spdx: 'CC0-1.0', name: 'CC0 1.0 Universal', url: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: 'Mock credit line (browser mock).' },
    bytes: 286 * MB,
    ramMb: 240,
    contents: ['Grand piano (4 velocity layers)', 'Soft felt variant'],
  },
  {
    id: 'demo-drums',
    name: 'Demo Acoustic Kit',
    description: 'Mock data: a multi-velocity acoustic drum kit, one mic mix.',
    author: 'Mock drummer',
    licence: { spdx: 'LicenseRef-PublicDomain', name: 'Public domain (author’s statement)', url: 'https://example.com/statement', attribution: 'Mock credit line (browser mock).' },
    bytes: 164 * MB,
    ramMb: 180,
    contents: ['Acoustic kit', 'Brushes'],
  },
];

export function createMockPacks(): KryptApi['packs'] {
  const base: Base[] = PACKS.length ? PACKS.map((p) => ({ id: p.id, name: p.name, description: p.description, author: p.author, licence: p.licence, bytes: p.bytes, ramMb: p.ramMb, contents: p.contents })) : DEMO;
  const status = new Map<string, PackStatus>(base.map((b) => [b.id, 'available']));
  const progress = new Map<string, number>();
  const errors = new Map<string, string>();
  const running = new Map<string, { timer: ReturnType<typeof setInterval>; finish: (r: { ok: boolean; message: string }) => void }>();
  const listeners = new Set<(s: PacksState) => void>();
  let failNext = false;

  const state = (): PacksState => ({
    packs: base.map((b) => {
      const st = status.get(b.id) ?? 'available';
      const e: PackEntryState = { ...b, contents: [...b.contents], status: st };
      if (st === 'downloading') e.progress = { bytes: progress.get(b.id) ?? 0, total: b.bytes };
      const err = errors.get(b.id);
      if (err) e.error = err;
      return e;
    }),
    dir: DIR,
  });
  const emit = (): void => {
    const s = state();
    for (const fn of listeners) fn(s);
  };
  const find = (id: string) => base.find((b) => b.id === id);

  const api: KryptApi['packs'] = {
    state: async () => state(),
    onState: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    install: (id) =>
      new Promise((resolve) => {
        const b = find(id);
        if (!b) return resolve({ ok: false, message: `There's no sound pack called "${id}"`, data: state() });
        if (status.get(id) === 'downloading') return resolve({ ok: false, message: `${b.name} is already downloading.`, data: state() });
        if (status.get(id) === 'installed') return resolve({ ok: true, message: `${b.name} is already installed.`, data: state() });
        const fail = failNext;
        failNext = false;
        status.set(id, 'downloading');
        errors.delete(id);
        progress.set(id, 0);
        emit();
        const finish = (r: { ok: boolean; message: string }): void => {
          clearInterval(timer);
          running.delete(id);
          resolve({ ...r, data: state() });
        };
        const timer = setInterval(() => {
          const next = Math.min(b.bytes, (progress.get(id) ?? 0) + b.bytes / 20);
          progress.set(id, next);
          if (fail && next >= b.bytes * 0.6) {
            status.set(id, 'failed');
            errors.set(id, 'samples/C4v3.flac failed verification (SHA-256 mismatch): the download is damaged or the file changed on the server. Nothing was installed; the files that finished are kept for the next try.');
            emit();
            return finish({ ok: false, message: `Couldn't install ${b.name}: ${errors.get(id)}` });
          }
          if (next >= b.bytes) {
            status.set(id, 'installed');
            emit();
            return finish({ ok: true, message: `Installed ${b.name} (${Math.round(b.bytes / MB)} MB). Its presets are ready in the preset browser.` });
          }
          emit();
        }, 150);
        running.set(id, { timer, finish });
      }),
    cancel: async (id) => {
      const r = running.get(id);
      const b = find(id);
      if (!r || !b) return { ok: false, message: `${b?.name ?? 'That pack'} isn't downloading.` };
      status.set(id, 'available');
      emit();
      r.finish({ ok: false, message: `${b.name} download cancelled. Files that finished are kept, so Download continues where it stopped.` });
      return { ok: true, message: `Cancelling the ${b.name} download…` };
    },
    remove: async (id) => {
      const b = find(id);
      if (!b) return { ok: false, message: `There's no sound pack called "${id}".`, data: state() };
      const st = status.get(id);
      if (st === 'downloading') return { ok: false, message: `${b.name} is downloading; cancel it first.`, data: state() };
      if (st !== 'installed' && st !== 'update') return { ok: false, message: `${b.name} isn't installed.`, data: state() };
      status.set(id, 'available');
      emit();
      return { ok: true, message: `Removed ${b.name}. Channels that use it stay silent until you download it again.`, data: state() };
    },
    reveal: async (id) => {
      const b = find(id);
      const st = status.get(id);
      if (!b || (st !== 'installed' && st !== 'update')) return { ok: false, message: `${b?.name ?? 'That pack'} isn't installed yet: download it first.` };
      return { ok: true, message: `(browser mock) Would open ${win(DIR, id)}` };
    },
    samples: async () => {
      const installed = (id: string) => status.get(id) === 'installed' || status.get(id) === 'update';
      const withSamples = PACKS.filter((p) => p.samples?.length);
      return {
        packs: withSamples.map((p) => {
          const byKind: Record<string, number> = {};
          for (const x of p.samples!) byKind[x.kind] = (byKind[x.kind] ?? 0) + 1;
          return { id: p.id, name: p.name, installed: installed(p.id), count: p.samples!.length, byKind };
        }),
        samples: withSamples.filter((p) => installed(p.id)).flatMap((p) => p.samples!),
      };
    },
  };

  (globalThis as unknown as { __kryptMockPacks?: unknown }).__kryptMockPacks = {
    failNext: () => {
      failNext = true;
    },
    installAll: () => {
      for (const b of base) status.set(b.id, 'installed');
      emit();
    },
    offerUpdate: (id: string) => {
      if (status.get(id) === 'installed') status.set(id, 'update');
      emit();
    },
    reset: () => {
      for (const b of base) status.set(b.id, 'available');
      errors.clear();
      emit();
    },
  };
  return api;
}
