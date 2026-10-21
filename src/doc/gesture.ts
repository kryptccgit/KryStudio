// A pointer gesture (step paint, graph-lane drag, reorder) as ONE undo
// entry. Commands run strictly in order; the group closes after the last
// one lands.
//
//   const g = beginGesture('Paint steps');
//   g.exec('notes.toggleStep', {...});   // on pointerdown / pointermove
//   await g.end();                        // on pointerup

import type { ExecResult } from '@shared/doc/DocHost';
import { dispatch, withGroup } from './store';

export interface Gesture {
  exec<T = unknown>(cmd: string, args: unknown): Promise<ExecResult<T>>;
  end(): Promise<void>;
  readonly count: number;
}

export function beginGesture(label: string): Gesture {
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  let resolveGid!: (g: string) => void;
  const gid = new Promise<string>((r) => (resolveGid = r));
  const finished = withGroup(label, async (g) => {
    resolveGid(g);
    await done;
  }).catch((err) => {
    // beginGroup failed: run ungrouped rather than hang.
    resolveGid('');
    console.warn('[gesture] group failed', err);
  });
  let queue: Promise<unknown> = Promise.resolve();
  let count = 0;
  let ended = false;
  return {
    get count() {
      return count;
    },
    exec<T>(cmd: string, args: unknown): Promise<ExecResult<T>> {
      count++;
      const p = queue.then(async () => {
        const g = await gid;
        return dispatch<T>(cmd, args, g ? { groupId: g } : undefined);
      });
      queue = p.catch(() => undefined);
      return p;
    },
    async end() {
      if (ended) return;
      ended = true;
      await queue;
      release();
      await finished;
    },
  };
}
