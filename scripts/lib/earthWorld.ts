/**
 * Present-day Earth as a one-plate WorldSnapshot on a sphere mesh, so the real painter can render
 * Earth (satellite / Köppen) with an Earth climate — a visual check of painter + climate together.
 */
import { buildEarthClimateInput } from '../../src/climate/earthInput';
import { gridToMesh } from '../../src/core/grid';
import type { ClimateResult, PaintOptions, PaintResult, SphereMesh, WorldDraft, WorldSnapshot } from '../../src/core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../../src/core/types';
import { snapshotFromDraft } from '../../src/tectonics/draft';

/** Earth relief sampled at the mesh cells (bilinear from a 1440×720 Earth grid). */
export function earthSnapshot(mesh: SphereMesh): WorldSnapshot {
  const g = buildEarthClimateInput(1440, 720);
  const elev = gridToMesh(mesh, g.elev, g.w, g.h);
  const n = mesh.n;
  const crust = new Uint8Array(n);
  const age = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Shelves (> −1000 m) count as continental crust, as on Earth.
    crust[i] = elev[i] > -1000 ? CRUST_CONTINENTAL : CRUST_OCEANIC;
    age[i] = crust[i] === CRUST_CONTINENTAL ? 1000 : 80;
  }
  const draft: WorldDraft = {
    n, plate: new Int16Array(n), crust, elev, age,
    plates: [{ id: 1, name: 'Earth', color: [120, 140, 160], omega: [0, 0, 0] }],
    hotspots: [], time: 0, seed: 1, nextPlateId: 2, stepIndex: 0,
  };
  return snapshotFromDraft(mesh, draft);
}

/** Paint one layer of Earth with the real painter (dynamic import: the painter may be mid-edit). */
export async function paintEarth(
  mesh: SphereMesh, snapshot: WorldSnapshot, climate: ClimateResult | null, layer: 'satellite' | 'koppen' | 'elevation',
  opts: Pick<PaintOptions, 'width' | 'height' | 'month'>,
): Promise<PaintResult> {
  const paint = await import('../../src/render/paint');
  return paint.paintLayer(layer, { mesh, snapshot, climate }, { ...opts, seaLevel: 0, hillshade: true, seed: 1, quality: 'full' });
}
