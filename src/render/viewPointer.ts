/**
 * Pointer-event plumbing shared by GlobeView and MapView: handler registry, WorldPointerEvent
 * construction, and the paint-mode rule for which drags navigate (right/middle button, or
 * Space/Alt + left) versus which are delivered to the app as paint strokes.
 */
import type { GeoPoint, WorldPointerEvent } from '../core/types';

export type PointerHandler = (e: WorldPointerEvent) => void;

export class PointerHub {
  private readonly handlers = new Set<PointerHandler>();

  on(handler: PointerHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  get active(): boolean {
    return this.handlers.size > 0;
  }

  emit(type: WorldPointerEvent['type'], ev: MouseEvent, point: GeoPoint | null): void {
    if (this.handlers.size === 0) return;
    const e: WorldPointerEvent = {
      type, point, clientX: ev.clientX, clientY: ev.clientY, buttons: ev.buttons,
      shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey,
    };
    for (const h of [...this.handlers]) h(e);
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Tracks whether Space is held (navigation modifier in paint mode). */
export class SpaceKey {
  down = false;
  private readonly onDown = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.down = true;
  };
  private readonly onUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') this.down = false;
  };
  private readonly onBlur = (): void => {
    this.down = false;
  };

  constructor(private readonly target: Window) {
    target.addEventListener('keydown', this.onDown);
    target.addEventListener('keyup', this.onUp);
    target.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onDown);
    this.target.removeEventListener('keyup', this.onUp);
    this.target.removeEventListener('blur', this.onBlur);
  }
}

/**
 * Whether a pointer-down starts a camera drag that must not be reported as a paint stroke.
 * In 'navigate' mode every drag navigates (events are still reported); in 'paint' mode only
 * non-left buttons or left with Space/Alt navigate.
 */
export function isNavigationPress(mode: 'navigate' | 'paint', button: number, altKey: boolean, spaceDown: boolean): boolean {
  if (mode === 'navigate') return true;
  return button !== 0 || altKey || spaceDown;
}
