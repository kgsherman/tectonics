/**
 * Keyboard shortcuts (SPEC.md §10): Space play/pause, G/M globe/map, 1–9 layers, [ ] month,
 * plus . (step), S (play seasons). The mapping is pure; `installShortcuts` wires it to the DOM.
 */
import type { LayerId } from '../core/types';
import { LAYER_ORDER } from '../worker/layerInfo';

export type Command =
  | { kind: 'togglePlay' }
  | { kind: 'step' }
  | { kind: 'view'; view: 'globe' | 'map' }
  | { kind: 'layer'; layer: LayerId }
  | { kind: 'month'; delta: number }
  | { kind: 'toggleSeasons' };

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface ShortcutContext {
  /** The plate editor owns Space (navigation) and number keys while active. */
  editorActive: boolean;
}

export function commandForKey(e: KeyLike, ctx: ShortcutContext): Command | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const key = e.key;
  switch (key) {
    case 'g':
    case 'G':
      return { kind: 'view', view: 'globe' };
    case 'm':
    case 'M':
      return { kind: 'view', view: 'map' };
  }
  if (ctx.editorActive) return null;
  if (key === ' ' || e.code === 'Space') return { kind: 'togglePlay' };
  if (key === '[') return { kind: 'month', delta: -1 };
  if (key === ']') return { kind: 'month', delta: 1 };
  if (key === '.') return { kind: 'step' };
  if (key === 's' || key === 'S') return { kind: 'toggleSeasons' };
  if (/^[1-9]$/.test(key)) {
    const layer = LAYER_ORDER[Number(key) - 1];
    return layer ? { kind: 'layer', layer } : null;
  }
  return null;
}

/** Elements where typing must not trigger shortcuts. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== 'string') return false;
  const el = t as HTMLElement;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'color'].includes(type);
}

export function installShortcuts(target: Window, ctx: () => ShortcutContext, run: (c: Command) => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || isTypingTarget(e.target)) return;
    const cmd = commandForKey(e, ctx());
    if (!cmd) return;
    // Auto-repeat only for commands that make sense held down.
    if (e.repeat && cmd.kind !== 'month' && cmd.kind !== 'step') return;
    e.preventDefault();
    run(cmd);
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
