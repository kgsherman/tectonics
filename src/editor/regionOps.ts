/** Region tools on an edit state: split along a cut, lasso selection, plates from seeds. */
import type { PlateSpec, SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import { plateColor, plateName, voronoiPlates } from '../tectonics/draft';
import { MIN_FRAGMENT_CELLS } from './editorConstants';
import { randomMotion } from './motion';
import { cellsInsidePolygon, pathCells } from './paths';
import type { Mutator } from './plateOps';
import { appendPlate } from './plateOps';

export interface SplitResult {
  /** Ids of the plates created by the split. */
  created: number[];
  /** A split was cut short by the plate cap. */
  capped: boolean;
}

/** Connected components of plate k's cells, with `blocked` cells acting as walls. */
function componentsOf(mesh: SphereMesh, plate: Int16Array, k: number, blocked: Uint8Array, seen: Uint8Array): number[][] {
  const { n, adjOffset, adj } = mesh;
  const comps: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || blocked[s] || plate[s] !== k) continue;
    const comp = [s];
    seen[s] = 1;
    for (let h = 0; h < comp.length; h++) {
      const i = comp[h];
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (!seen[j] && !blocked[j] && plate[j] === k) {
          seen[j] = 1;
          comp.push(j);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/**
 * Split every plate the cut (a watertight chain of cells) separates into ≥ 2 sides of at least
 * MIN_FRAGMENT_CELLS: the largest side keeps the plate, the others become new plates with the same
 * motion (while under the cap). Cut cells then join the side most of their neighbours are on.
 */
export function splitAlongCut(mut: Mutator, cut: number[]): SplitResult {
  const { mesh, state } = mut;
  const d = state.draft;
  const { n, adjOffset, adj } = mesh;
  const isCut = new Uint8Array(n);
  for (const c of cut) isCut[c] = 1;
  const crossed = [...new Set(cut.map((c) => d.plate[c]))];
  const created: number[] = [];
  let capped = false;
  const seen = new Uint8Array(n);
  for (const k of crossed) {
    const big = componentsOf(mesh, d.plate, k, isCut, seen)
      .filter((c) => c.length >= MIN_FRAGMENT_CELLS)
      .sort((a, b) => b.length - a.length);
    for (let q = 1; q < big.length; q++) {
      if (d.plates.length >= mut.cap) {
        capped = true;
        break;
      }
      const nk = appendPlate(state, d.plates[k]);
      created.push(d.plates[nk].id);
      for (const i of big[q]) mut.setPlate(i, nk);
    }
  }
  if (created.length === 0) return { created, capped };
  // Cut cells join the majority side among their non-cut neighbours (two sweeps reach every cell
  // of a one-cell-wide cut).
  const cand: number[] = [], cnt: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const i of cut) {
      if (!isCut[i]) continue;
      cand.length = cnt.length = 0;
      for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
        const j = adj[e];
        if (isCut[j]) continue;
        const s = cand.indexOf(d.plate[j]);
        if (s < 0) {
          cand.push(d.plate[j]);
          cnt.push(1);
        } else cnt[s]++;
      }
      let best = -1, bestCnt = 0;
      for (let s = 0; s < cand.length; s++) {
        if (cnt[s] > bestCnt) {
          bestCnt = cnt[s];
          best = cand[s];
        }
      }
      if (best >= 0) {
        mut.setPlate(i, best);
        isCut[i] = 0;
      }
    }
  }
  return { created, capped };
}

/** Cells inside a closed lasso loop plus the cells under its outline. */
export function lassoCells(mesh: SphereMesh, poly: ReadonlyArray<Vec3>): number[] {
  const set = new Set<number>(cellsInsidePolygon(mesh, poly));
  for (const c of pathCells(mesh, poly, true)) set.add(c);
  return [...set];
}

/** Continental fraction and normalized centroid of a set of cells. */
export function regionStats(mesh: SphereMesh, crust: Uint8Array, cells: ArrayLike<number>): { centroid: Vec3; continental: number } {
  let sx = 0, sy = 0, sz = 0, cont = 0;
  const { xyz } = mesh;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    sx += xyz[3 * i];
    sy += xyz[3 * i + 1];
    sz += xyz[3 * i + 2];
    if (crust[i] === CRUST_CONTINENTAL) cont++;
  }
  const l = Math.hypot(sx, sy, sz) || 1;
  return { centroid: [sx / l, sy / l, sz / l], continental: cells.length ? cont / cells.length : 0 };
}

/**
 * Replace every plate by noise-warped Voronoi regions around `seeds`: fresh ids from nextPlateId,
 * palette colours in seed order (matching the seed markers) and default random motions.
 */
export function replaceWithSeedPlates(mut: Mutator, seeds: ReadonlyArray<Vec3>, roughness: number, noiseSeed: number): void {
  const { mesh, state } = mut;
  const d = state.draft;
  const labels = voronoiPlates(mesh, seeds.map((s) => [s[0], s[1], s[2]] as Vec3), roughness, noiseSeed);
  mut.flushPlateDirty();
  mut.touchAll();
  const cont = new Float64Array(seeds.length), cnt = new Float64Array(seeds.length);
  for (let i = 0; i < d.n; i++) {
    cnt[labels[i]]++;
    if (d.crust[i] === CRUST_CONTINENTAL) cont[labels[i]]++;
  }
  const firstId = Math.max(d.nextPlateId, ...d.plates.map((p) => p.id + 1), 1);
  const plates: PlateSpec[] = seeds.map((s, k) => {
    const id = firstId + k;
    return {
      id,
      name: plateName(id, d.seed),
      color: plateColor(k),
      omega: randomMotion(mut.rng(id), [s[0], s[1], s[2]], cnt[k] > 0 ? cont[k] / cnt[k] : 0),
    };
  });
  for (const p of plates) state.dirtyPlates.add(p.id);
  d.plates = plates;
  d.nextPlateId = firstId + seeds.length;
  d.plate.set(labels);
}
