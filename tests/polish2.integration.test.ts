/**
 * Polish 2 integration: cross-module wiring added by the integrator.
 *  - the paint worker's idle release (src/worker/paint.worker.ts looks up `releasePaintScratch` on the
 *    painter module by name): the painter exports it, it frees memory, and painting afterwards gives
 *    identical images.
 */
import { describe, expect, it } from 'vitest';
import { buildMeshGridMap, meshToGrid, resampleGrid } from '../src/core/grid';
import { createSphereMesh } from '../src/core/sphereMesh';
import type { LayerId, PaintOptions } from '../src/core/types';
import * as painter from '../src/render/paint';
import { syntheticSnapshot, zonalClimate } from './helpers/fixtures';

describe('painter scratch release (paint worker idle release)', () => {
  it('is exported under the name the paint worker looks up', () => {
    expect(typeof (painter as unknown as Record<string, unknown>)['releasePaintScratch']).toBe('function');
  });

  it('frees scratch memory and later paints are unchanged', () => {
    const mesh = createSphereMesh(8000);
    const snap = syntheticSnapshot(mesh, 3, 8);
    const map = buildMeshGridMap(mesh, 360, 180);
    const climate = zonalClimate(90, 45, resampleGrid(meshToGrid(map, snap.elev), 360, 180, 90, 45));
    const opts: PaintOptions = { width: 256, height: 128, month: 3, seaLevel: 0, hillshade: true, seed: 1, quality: 'preview' };
    const layers: LayerId[] = ['satellite', 'plates', 'koppen', 'currents'];
    for (const layer of layers) {
      const a = painter.paintLayer(layer, { mesh, snapshot: snap, climate }, opts, new painter.PaintCache()).rgba;
      const freed = painter.releasePaintScratch();
      expect(freed).toBeGreaterThan(0);
      const b = painter.paintLayer(layer, { mesh, snapshot: { ...snap, id: snap.id + 1 }, climate }, opts, new painter.PaintCache()).rgba;
      expect(Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength))).toBe(0);
    }
    expect(painter.releasePaintScratch()).toBeGreaterThan(0);
    expect(painter.releasePaintScratch()).toBe(0);
  });
});
