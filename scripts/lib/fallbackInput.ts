/**
 * Headless stand-in for climateInputFromSnapshot (used only while the climate module is a stub):
 * the SPEC §3 land-aware supersampling recipe — 4× MeshGridMap, classify sub-samples against sea
 * level, box-aggregate to the climate grid.
 */
import { buildMeshGridMap, meshToGrid } from '../../src/core/grid';
import type { ClimateInput, SphereMesh, WorldSnapshot } from '../../src/core/types';

export function climateInputFallback(mesh: SphereMesh, snap: WorldSnapshot, w: number, h: number, seaLevel: number): ClimateInput {
  const k = 4;
  const W = w * k, H = h * k;
  const fine = meshToGrid(buildMeshGridMap(mesh, W, H), snap.elev);
  const elev = new Float32Array(w * h);
  const landFraction = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let nLand = 0, sLand = 0, sSea = 0;
      for (let rr = r * k; rr < (r + 1) * k; rr++) {
        for (let cc = c * k; cc < (c + 1) * k; cc++) {
          const e = fine[rr * W + cc];
          if (e > seaLevel) {
            nLand++;
            sLand += e;
          } else sSea += e;
        }
      }
      const lf = nLand / (k * k);
      landFraction[r * w + c] = lf;
      elev[r * w + c] = lf >= 0.5 ? sLand / nLand : sSea / (k * k - nLand);
    }
  }
  return { w, h, elev, landFraction, sourceId: snap.id, time: snap.time };
}
