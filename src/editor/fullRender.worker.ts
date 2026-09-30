/// <reference lib="webworker" />
/**
 * Plate-editor full-quality preview worker: builds the mesh once per resolution and paints the
 * draft with the shared painter (plates or elevation layer + boundary overlay).
 */
import { createSphereMesh } from '../core/sphereMesh';
import type { PaintOptions, SphereMesh } from '../core/types';
import { PaintCache, paintLayer, paintOverlay } from '../render/paint';
import { snapshotFromDraft } from '../tectonics/draft';
import type { FullRenderMessage, FullRenderReply } from './fullRender';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let mesh: SphereMesh | null = null;
const cache = new PaintCache();

scope.onmessage = (ev: MessageEvent<FullRenderMessage>) => {
  const m = ev.data;
  const t0 = performance.now();
  try {
    if (!mesh || mesh.n !== m.n) mesh = createSphereMesh(m.n);
    const snapshot = snapshotFromDraft(mesh, m.draft);
    const src = { mesh, snapshot, climate: null };
    const opts: PaintOptions = {
      width: m.width,
      height: m.height,
      month: 0,
      seaLevel: m.seaLevel,
      hillshade: true,
      seed: m.draft.seed,
      quality: 'full',
      rivers: false,
    };
    const base = paintLayer(m.style === 'plates' ? 'plates' : 'elevation', src, opts, cache);
    const overlay = paintOverlay({ boundaries: true, graticule: false, coastlines: false }, src, opts, cache);
    const reply: FullRenderReply = {
      id: m.id,
      ok: true,
      width: m.width,
      height: m.height,
      rgba: base.rgba,
      overlay,
      ms: performance.now() - t0,
    };
    scope.postMessage(reply, [base.rgba.buffer, overlay.buffer]);
  } catch (err) {
    const reply: FullRenderReply = { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    scope.postMessage(reply);
  }
};
