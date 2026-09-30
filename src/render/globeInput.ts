/**
 * Globe pointer input: decides per press (capture phase, before OrbitControls) whether the drag
 * navigates or is a paint stroke, and reports WorldPointerEvents through a PointerHub.
 * In paint mode, navigation drags (right button, Space/Alt + left) report only 'hover'.
 */
import type { GeoPoint } from '../core/types';
import type { GlobeControls } from './globeControls';
import { isNavigationPress, type PointerHub, SpaceKey } from './viewPointer';

export interface GlobeInputHost {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly pointers: PointerHub;
  readonly controls: GlobeControls;
  mode(): 'navigate' | 'paint';
  pick(clientX: number, clientY: number): GeoPoint | null;
}

export class GlobeInput {
  private readonly space: SpaceKey;
  private pressNavigates = false;
  private pressReported = false;
  private readonly listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions | boolean]> = [];

  constructor(private readonly host: GlobeInputHost) {
    this.space = new SpaceKey(window);
    this.listen(host.root, 'pointerdown', this.onPressCapture as EventListener, { capture: true });
    this.listen(host.canvas, 'pointerdown', this.onPointerDown as EventListener, false);
    this.listen(host.canvas, 'pointermove', this.onPointerMove as EventListener, false);
    this.listen(host.canvas, 'pointerup', this.onPointerUp as EventListener, false);
    this.listen(host.canvas, 'pointercancel', this.onPointerUp as EventListener, false);
    this.listen(host.canvas, 'pointerleave', this.onPointerLeave as EventListener, false);
    this.listen(host.canvas, 'contextmenu', ((e: Event) => e.preventDefault()) as EventListener, false);
  }

  dispose(): void {
    for (const [t, type, fn, opt] of this.listeners) t.removeEventListener(type, fn, opt);
    this.listeners.length = 0;
    this.space.dispose();
  }

  private listen(t: EventTarget, type: string, fn: EventListener, opt: AddEventListenerOptions | boolean): void {
    t.addEventListener(type, fn, opt);
    this.listeners.push([t, type, fn, opt]);
  }

  /** Capture phase on the root: runs before OrbitControls decides what the press does. */
  private readonly onPressCapture = (e: PointerEvent): void => {
    this.pressNavigates = isNavigationPress(this.host.mode(), e.button, e.altKey, this.space.down);
    this.host.controls.preparePress(this.pressNavigates);
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.pressReported = this.host.mode() === 'navigate' || !this.pressNavigates;
    if (this.pressReported) this.host.pointers.emit('down', e, this.host.pick(e.clientX, e.clientY));
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.host.pointers.active) return;
    const dragging = e.buttons !== 0 && this.pressReported;
    this.host.pointers.emit(dragging ? 'move' : 'hover', e, this.host.pick(e.clientX, e.clientY));
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.pressReported) this.host.pointers.emit('up', e, this.host.pick(e.clientX, e.clientY));
    this.pressReported = false;
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    this.host.pointers.emit('leave', e, null);
  };
}
