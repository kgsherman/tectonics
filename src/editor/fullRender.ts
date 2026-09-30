/**
 * Debounced full-quality preview for the editor: the painter's plates / elevation layer plus the
 * boundary overlay, rendered off the main thread (a module worker) so the UI never stalls.
 * Latest request wins; superseded requests resolve to null.
 */
import type { WorldDraft } from '../core/types';
import type { PreviewStyle } from './preview';

export interface FullRenderRequest {
  draft: WorldDraft;
  style: PreviewStyle;
  width: number;
  height: number;
  seaLevel: number;
}

export interface FullRenderResult {
  width: number;
  height: number;
  /** Opaque base image (row 0 = north). */
  rgba: Uint8ClampedArray;
  /** Transparent overlay (plate boundaries). */
  overlay: Uint8ClampedArray;
}

/** Renders a draft at full quality; null when the request was superseded by a newer one. */
export type FullRenderFn = (req: FullRenderRequest) => Promise<FullRenderResult | null>;

/** Message sent to the worker (draft arrays are structured-cloned; the editor keeps its own). */
export interface FullRenderMessage {
  id: number;
  n: number;
  draft: WorldDraft;
  style: PreviewStyle;
  width: number;
  height: number;
  seaLevel: number;
}

export type FullRenderReply =
  | { id: number; ok: true; width: number; height: number; rgba: Uint8ClampedArray; overlay: Uint8ClampedArray; ms: number }
  | { id: number; ok: false; error: string };

interface Pending {
  req: FullRenderRequest;
  resolve: (r: FullRenderResult | null) => void;
  reject: (e: Error) => void;
}

export class WorkerFullRenderer {
  private readonly worker: Worker;
  private nextId = 1;
  private inFlight: { id: number; p: Pending } | null = null;
  private queued: Pending | null = null;
  private disposed = false;

  constructor() {
    this.worker = new Worker(new URL('./fullRender.worker.ts', import.meta.url), { type: 'module', name: 'plate-editor-render' });
    this.worker.onmessage = (ev: MessageEvent<FullRenderReply>) => this.onReply(ev.data);
    this.worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      this.failAll(new Error(`Preview worker failed: ${ev.message || 'unknown error'}`));
    };
  }

  readonly render: FullRenderFn = (req) =>
    new Promise<FullRenderResult | null>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Preview renderer disposed'));
        return;
      }
      if (this.queued) this.queued.resolve(null);
      this.queued = { req, resolve, reject };
      this.pump();
    });

  private pump(): void {
    if (this.inFlight || !this.queued) return;
    const p = this.queued;
    this.queued = null;
    const id = this.nextId++;
    this.inFlight = { id, p };
    const msg: FullRenderMessage = {
      id,
      n: p.req.draft.n,
      draft: p.req.draft,
      style: p.req.style,
      width: p.req.width,
      height: p.req.height,
      seaLevel: p.req.seaLevel,
    };
    this.worker.postMessage(msg);
  }

  private onReply(r: FullRenderReply): void {
    const cur = this.inFlight;
    if (!cur || cur.id !== r.id) return;
    this.inFlight = null;
    if (r.ok) {
      // A newer request is waiting: this image is already stale.
      if (this.queued) cur.p.resolve(null);
      else cur.p.resolve({ width: r.width, height: r.height, rgba: r.rgba, overlay: r.overlay });
    } else cur.p.reject(new Error(r.error));
    this.pump();
  }

  private failAll(err: Error): void {
    this.inFlight?.p.reject(err);
    this.queued?.reject(err);
    this.inFlight = null;
    this.queued = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inFlight?.p.resolve(null);
    this.queued?.resolve(null);
    this.inFlight = null;
    this.queued = null;
    this.worker.terminate();
  }
}
