/**
 * Map input: drag-pan (paint-mode rules from viewPointer), wheel zoom toward the cursor, double-click
 * zoom, two-finger pinch, and WorldPointerEvent reporting through a PointerHub.
 */
import { mapPan, mapZoomAt, type MapTransform } from './viewMapTransform';
import { isNavigationPress, PointerHub, SpaceKey } from './viewPointer';
import type { GeoPoint } from '../core/types';

const WHEEL_ZOOM = 0.0015;

export interface MapInputHost {
  readonly root: HTMLElement;
  readonly pointers: PointerHub;
  mode(): 'navigate' | 'paint';
  transform(): MapTransform;
  setTransform(t: MapTransform): void;
  pick(clientX: number, clientY: number): GeoPoint | null;
}

interface Drag {
  id: number;
  x: number;
  y: number;
  /** Down/move/up are reported to the app. */
  reported: boolean;
  /** The drag pans the map. */
  pans: boolean;
}

export class MapInput {
  private readonly space: SpaceKey;
  private drag: Drag | null = null;
  private readonly touches = new Map<number, { x: number; y: number }>();
  private readonly listeners: Array<[string, EventListener, AddEventListenerOptions | boolean]> = [];

  constructor(private readonly host: MapInputHost) {
    this.space = new SpaceKey(window);
    this.listen('pointerdown', this.onPointerDown as EventListener);
    this.listen('pointermove', this.onPointerMove as EventListener);
    this.listen('pointerup', this.onPointerUp as EventListener);
    this.listen('pointercancel', this.onPointerUp as EventListener);
    this.listen('pointerleave', this.onPointerLeave as EventListener);
    this.listen('wheel', this.onWheel as EventListener, { passive: false });
    this.listen('dblclick', this.onDoubleClick as EventListener);
    this.listen('contextmenu', ((e: Event) => e.preventDefault()) as EventListener);
  }

  /** Cursor for the current mode (grab / crosshair). */
  idleCursor(): string {
    return this.host.mode() === 'paint' ? 'crosshair' : 'grab';
  }

  dispose(): void {
    for (const [type, fn, opt] of this.listeners) this.host.root.removeEventListener(type, fn, opt);
    this.listeners.length = 0;
    this.space.dispose();
  }

  private listen(type: string, fn: EventListener, opt: AddEventListenerOptions | boolean = false): void {
    this.host.root.addEventListener(type, fn, opt);
    this.listeners.push([type, fn, opt]);
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const rect = this.host.root.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const { host } = this;
    if (e.pointerType === 'touch') this.touches.set(e.pointerId, this.local(e));
    if (this.touches.size >= 2) {
      // Second finger: switch to pinch navigation and end any stroke.
      if (this.drag?.reported) host.pointers.emit('up', e, host.pick(e.clientX, e.clientY));
      this.drag = null;
      return;
    }
    const mode = host.mode();
    const pans = isNavigationPress(mode, e.button, e.altKey, this.space.down);
    const reported = mode === 'navigate' || !pans;
    const p = this.local(e);
    this.drag = { id: e.pointerId, x: p.x, y: p.y, reported, pans };
    if (pans) host.root.style.cursor = 'grabbing';
    if (reported) host.pointers.emit('down', e, host.pick(e.clientX, e.clientY));
    // Keep receiving moves outside the element; only live pointers can be captured.
    if (host.root.isConnected) {
      try {
        host.root.setPointerCapture(e.pointerId);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err;
      }
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const { host } = this;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      if (this.touches.size >= 2) {
        this.pinch(e);
        return;
      }
      this.touches.set(e.pointerId, this.local(e));
    }
    const d = this.drag;
    if (d && d.id === e.pointerId && d.pans) {
      const p = this.local(e);
      host.setTransform(mapPan(host.transform(), p.x - d.x, p.y - d.y));
      d.x = p.x;
      d.y = p.y;
    }
    if (!host.pointers.active) return;
    const dragging = d !== null && d.id === e.pointerId && d.reported && e.buttons !== 0;
    host.pointers.emit(dragging ? 'move' : 'hover', e, host.pick(e.clientX, e.clientY));
  };

  /** Two-finger gesture: pan by the midpoint motion, zoom by the finger-distance ratio. */
  private pinch(e: PointerEvent): void {
    const [a0, b0] = [...this.touches.values()];
    this.touches.set(e.pointerId, this.local(e));
    const [a1, b1] = [...this.touches.values()];
    const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y), d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
    const mx0 = (a0.x + b0.x) / 2, my0 = (a0.y + b0.y) / 2, mx1 = (a1.x + b1.x) / 2, my1 = (a1.y + b1.y) / 2;
    let t = mapPan(this.host.transform(), mx1 - mx0, my1 - my0);
    if (d0 > 1 && d1 > 1) t = mapZoomAt(t, mx1, my1, d1 / d0);
    this.host.setTransform(t);
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    const { host } = this;
    this.touches.delete(e.pointerId);
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (host.root.hasPointerCapture(e.pointerId)) host.root.releasePointerCapture(e.pointerId);
    host.root.style.cursor = this.idleCursor();
    if (d.reported) host.pointers.emit('up', e, host.pick(e.clientX, e.clientY));
  };

  private readonly onPointerLeave = (e: PointerEvent): void => {
    this.host.pointers.emit('leave', e, null);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const t = this.host.transform();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? t.height : 1;
    const p = this.local(e);
    this.host.setTransform(mapZoomAt(t, p.x, p.y, Math.exp(-e.deltaY * unit * WHEEL_ZOOM)));
  };

  private readonly onDoubleClick = (e: MouseEvent): void => {
    if (this.host.mode() !== 'navigate') return;
    const p = this.local(e);
    this.host.setTransform(mapZoomAt(this.host.transform(), p.x, p.y, e.shiftKey ? 0.5 : 2));
  };
}
