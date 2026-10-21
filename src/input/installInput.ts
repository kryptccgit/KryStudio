import { areBareKeysBlocked, bindingFor, eventToKeys, isBareCombo, isKeymapSuspended } from './keymap';
import { runCommand } from './commands';
import { pianoAllOff, pianoKeyDown, pianoKeyUp } from './typingPiano';
import { controllerKeyDown, controllerKeyUp, controllersBlur } from './controllers';

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'VIDEO' || tag === 'AUDIO') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(type);
  }
  return false;
}

const installed = new WeakSet<Window>();

export function installInput(win: Window): void {
  if (installed.has(win)) return;
  installed.add(win);
  const doc = win.document;

  doc.addEventListener(
    'keydown',
    (e) => {
      if (e.defaultPrevented || isKeymapSuspended()) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-krypt-dialog]')) return;
      const typing = isTyping(e.target);
      const covered = win === window && areBareKeysBlocked();
      if (!typing && !covered && controllerKeyDown(e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const keys = eventToKeys(e);
      if (keys) {
        const context = target?.closest?.('[data-editor]')?.getAttribute('data-editor') ?? null;
        const b = bindingFor(keys, context);
        if (b && (!typing || b.allowInInputs) && !(covered && isBareCombo(keys))) {
          if (e.repeat && !b.repeat) {
            e.preventDefault();
            return;
          }
          if (runCommand(b.command)) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
      }
      if (typing || covered) return;
      pianoKeyDown(e);
    },
    true,
  );

  doc.addEventListener(
    'keyup',
    (e) => {
      if (controllerKeyUp(e) || pianoKeyUp(e)) e.preventDefault();
    },
    true,
  );

  const guard = (e: DragEvent): void => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
  };
  doc.addEventListener('dragover', guard);
  doc.addEventListener('drop', guard);

  win.addEventListener('blur', () => {
    pianoAllOff();
    controllersBlur();
  });
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') pianoAllOff();
  });
}
