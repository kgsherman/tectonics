import { createNoise3, fbm3 } from '../core/noise';
import type { Rng } from '../core/rng';
import type { SphereMesh } from '../core/types';
import { enforceConnectivity } from './genCommon';
import type { ContinentInfo } from './genContinents';
import { edgeCostArray, multiSourceDijkstra } from './genGraph';

// Plate partition: continent-aware seeds grown by a noise-weighted, multiplicatively weighted
// multi-source flood fill whose front speeds are tuned so plate areas follow an Earth-like size
// distribution (a few large, several medium, a few small).
//
// Boundaries avoid continents: continental crust is cheap to traverse (1/4 of the oceanic cost) for
// a front that is already on it, but invading it from the ocean costs an entry penalty. In an
// arrival-time fill, boundaries settle where fronts meet (the cost midpoint between seeds), so
// cheap continents rarely host a boundary, and the penalty stops a fast plate from snatching a
// neighbour's continent and "teleporting" through it. Every large continent gets its own seed(s), and
// finally each continent's plate also takes a 2-ring oceanic margin so boundaries sit offshore.

const CONTINENT_COST = 0.25;
/** Extra cost (radians of ocean-equivalent travel) for a front invading a continent from the ocean. */
const CONTINENT_ENTRY_PENALTY = 0.2;
/** Growth passes used to match plate areas to their targets (1 initial + corrections). */
const GROWTH_PASSES = 4;
/** Oceanic rings around continents that always belong to the continent's plate. */
const MARGIN_RINGS = 2;
/** Plates smaller than this area fraction keep their cells in continental margin buffers. */
const MARGIN_PROTECT_AREA = 0.015;

/** Relative target areas of large / medium / small plates. */
const SIZE_LARGE = 1;
const SIZE_MEDIUM = 0.3;
const SIZE_SMALL = 0.08;

/** Target area share per plate (sum 1), sorted descending. */
export function plateAreaShares(count: number, rng: Rng): number[] {
  const large = Math.min(count, Math.max(2, Math.round(count * 0.4)));
  const medium = Math.min(count - large, Math.round(count * 0.35));
  const w: number[] = [];
  for (let k = 0; k < count; k++) {
    const base = k < large ? SIZE_LARGE : k < large + medium ? SIZE_MEDIUM : SIZE_SMALL;
    w.push(base * Math.exp(rng.normal(0, 0.25)));
  }
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s).sort((a, b) => b - a);
}

function angleCells(xyz: Float64Array, a: number, b: number): number {
  const d = xyz[3 * a] * xyz[3 * b] + xyz[3 * a + 1] * xyz[3 * b + 1] + xyz[3 * a + 2] * xyz[3 * b + 2];
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

/** Smallest angle from cell c to any existing seed (π if none). */
function minSeedAngle(xyz: Float64Array, seeds: number[], c: number): number {
  let m = Math.PI;
  for (const s of seeds) m = Math.min(m, angleCells(xyz, c, s));
  return m;
}

/**
 * Seeds: large continents first get round(area / (1.2 × mean plate area)) seeds each (≥ 1, spread
 * over interior cells), while at least ~30% of the plates stay oceanic; the remaining seeds go to the
 * ocean by best-candidate sampling (maximizing the distance to existing seeds, preferring open ocean so
 * no seed starts in a pocket hemmed in by continents). Small continents and islands get no seed and
 * ride on whichever plate reaches them first.
 */
function placeSeeds(mesh: SphereMesh, continents: ContinentInfo, count: number, rng: Rng): number[] {
  const { n, xyz } = mesh;
  const { comps, coastKm, oceanKm, mask } = continents;
  const meanArea = n / count;
  const seeds: number[] = [];
  const oceanCells: number[] = [];
  for (let i = 0; i < n; i++) if (!mask[i]) oceanCells.push(i);
  const oceanReserve = oceanCells.length > n * 0.1 ? Math.max(1, Math.round(count * 0.3)) : 0;
  let budget = count - oceanReserve;
  // Continents by decreasing size (ties by id for determinism).
  const order = comps.size.map((_, c) => c).sort((a, b) => comps.size[b] - comps.size[a] || a - b);
  const cellsOf = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = comps.comp[i];
    if (c < 0) continue;
    let l = cellsOf.get(c);
    if (!l) cellsOf.set(c, (l = []));
    l.push(i);
  }
  for (const c of order) {
    if (budget <= 0 || comps.size[c] < 0.35 * meanArea) break;
    const cells = cellsOf.get(c)!;
    let maxCoast = 0;
    for (const i of cells) maxCoast = Math.max(maxCoast, coastKm[i]);
    const m = Math.min(budget, Math.max(1, Math.round(comps.size[c] / (1.2 * meanArea))));
    for (let q = 0; q < m; q++) {
      // Best candidate: far from other seeds, preferably well inland.
      let best = cells[0], bestScore = -Infinity;
      for (let t = 0; t < 40; t++) {
        const cand = cells[rng.int(0, cells.length)];
        const score = minSeedAngle(xyz, seeds, cand) + 0.5 * (coastKm[cand] / Math.max(1, maxCoast));
        if (score > bestScore && !seeds.includes(cand)) { bestScore = score; best = cand; }
      }
      seeds.push(best);
    }
    budget -= m;
  }
  // Oceanic (or, without enough ocean, any) seeds by best-candidate sampling.
  const pool = oceanCells.length > 0 ? oceanCells : Array.from({ length: n }, (_, i) => i);
  while (seeds.length < count) {
    let best = -1, bestScore = -Infinity;
    for (let t = 0; t < 40; t++) {
      const cand = pool[rng.int(0, pool.length)];
      if (seeds.includes(cand)) continue;
      const score = minSeedAngle(xyz, seeds, cand) + 0.3 * Math.min(1, oceanKm[cand] / 1200);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    if (best < 0) {
      // Degenerate tiny meshes: take the first free cell (any cell once the ocean pool is used up).
      best = pool.find((c) => !seeds.includes(c)) ?? -1;
      if (best < 0) for (let c = 0; c < n && best < 0; c++) if (!seeds.includes(c)) best = c;
      if (best < 0) throw new Error('placeSeeds: fewer cells than plates');
    }
    seeds.push(best);
  }
  return seeds;
}

/** Relabel boundary cells whose neighbours are mostly (> 60%) one other plate (removes 1-cell jaggies). */
function smoothBoundaries(mesh: SphereMesh, plate: Int16Array, seeds: number[], passes: number): void {
  const { n, adjOffset, adj } = mesh;
  const isSeed = new Uint8Array(n);
  for (const s of seeds) isSeed[s] = 1;
  const next = plate.slice();
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      next[i] = plate[i];
      if (isSeed[i]) continue;
      const a0 = adjOffset[i], a1 = adjOffset[i + 1];
      const deg = a1 - a0;
      let bestLab = -1, bestCnt = 0, own = 0;
      for (let a = a0; a < a1; a++) {
        const l = plate[adj[a]];
        if (l === plate[i]) { own++; continue; }
        let c = 0;
        for (let b = a0; b < a1; b++) if (plate[adj[b]] === l) c++;
        if (c > bestCnt) { bestCnt = c; bestLab = l; }
      }
      if (bestLab >= 0 && bestCnt > own && bestCnt > 0.6 * deg) next[i] = bestLab;
    }
    plate.set(next);
  }
}

/**
 * Give every small plate share of a continent to the plates that own the bulk of it: a plate keeps
 * its part of continent C only if it holds ≥ 25% of C, ≥ `minBlock` cells, or its seed lies in C.
 * Removes slivers of continental crust cut off by neighbouring plates.
 */
function absorbContinentalSlivers(mesh: SphereMesh, plate: Int16Array, continents: ContinentInfo, seeds: number[], minBlock: number): void {
  const { n, adjOffset, adj } = mesh;
  const numPlates = seeds.length;
  const { comps } = continents;
  const nc = comps.size.length;
  const owned = new Int32Array(nc * numPlates);
  for (let i = 0; i < n; i++) {
    const c = comps.comp[i];
    if (c >= 0) owned[c * numPlates + plate[i]]++;
  }
  const keep = new Uint8Array(nc * numPlates);
  for (let c = 0; c < nc; c++) {
    let bestK = 0;
    for (let k = 0; k < numPlates; k++) {
      const o = owned[c * numPlates + k];
      if (o > owned[c * numPlates + bestK]) bestK = k;
      if (o >= 0.25 * comps.size[c] || o >= minBlock) keep[c * numPlates + k] = 1;
    }
    keep[c * numPlates + bestK] = 1;
  }
  for (let k = 0; k < numPlates; k++) {
    const c = comps.comp[seeds[k]];
    if (c >= 0) keep[c * numPlates + k] = 1;
  }
  // BFS within each continent from kept cells into dropped ones.
  const queue = new Int32Array(n);
  const pending = new Uint8Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const c = comps.comp[i];
    if (c < 0) continue;
    if (keep[c * numPlates + plate[i]]) queue[tail++] = i;
    else pending[i] = 1;
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    for (let a = adjOffset[i]; a < adjOffset[i + 1]; a++) {
      const j = adj[a];
      if (!pending[j]) continue;
      pending[j] = 0;
      plate[j] = plate[i];
      queue[tail++] = j;
    }
  }
}

/**
 * Give the oceanic cells within `rings` cells of continental crust to the plate of the nearest
 * continental cell (multi-source BFS), so plate boundaries sit offshore: continents keep their shelf,
 * slope and rise, and trenches end up ~100–300 km off active coasts as on Earth. Seed cells and cells
 * of plates smaller than `protectBelow` cells are left alone, so no plate is squeezed out.
 */
function continentalMarginBuffer(mesh: SphereMesh, plate: Int16Array, contMask: Uint8Array, rings: number, seeds: number[], protectBelow: number): void {
  const { n, adjOffset, adj } = mesh;
  const size = new Int32Array(seeds.length);
  for (let i = 0; i < n; i++) size[plate[i]]++;
  const isSeed = new Uint8Array(n);
  for (const s of seeds) isSeed[s] = 1;
  const depth = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (contMask[i]) {
      depth[i] = 0;
      queue[tail++] = i;
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    if (depth[i] >= rings) continue;
    for (let e = adjOffset[i]; e < adjOffset[i + 1]; e++) {
      const j = adj[e];
      if (depth[j] >= 0) continue;
      depth[j] = depth[i] + 1;
      if (!isSeed[j] && size[plate[j]] >= protectBelow) plate[j] = plate[i];
      queue[tail++] = j;
    }
  }
}

export interface PlateGrowth {
  plate: Int16Array;
  seeds: number[];
}

/**
 * Partition the sphere into `count` connected plates. Deterministic in (mesh.n, crust, count,
 * roughness, rng state, noiseSeed).
 *
 * Plate sizes are matched to the target distribution iteratively: after a first (uniform-speed)
 * growth pass the sorted target shares are assigned by the rank of the area each plate naturally
 * reached (so continent-bearing plates get the large targets), then front speeds are scaled by
 * (target / area)^0.5 (≈ Newton step, since area ∝ speed²) and the fill is re-run. Afterwards
 * boundaries are smoothed, continental slivers go back to the continent's main plates, each
 * continent's plate takes its oceanic margin, and connectivity is enforced. Every plate keeps ≥ 1 cell.
 */
export function growPlates(mesh: SphereMesh, continents: ContinentInfo, count: number, roughness: number, rng: Rng, noiseSeed: number): PlateGrowth {
  const { n, xyz } = mesh;
  const contMask = continents.mask;
  const share = plateAreaShares(count, rng);
  const seeds = placeSeeds(mesh, continents, count, rng);
  // Noise-weighted traversal cost → irregular, non-Voronoi boundaries (boundaryRoughness).
  const noise = createNoise3(noiseSeed + 21);
  const detail = createNoise3(noiseSeed + 22);
  const amp = 1.8 * roughness;
  const cost = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    const r = fbm3(noise, x * 2.2, y * 2.2, z * 2.2, 4) + (0.1 + 0.25 * roughness) * fbm3(detail, x * 7, y * 7, z * 7, 2);
    cost[i] = Math.exp(amp * r) * (contMask[i] ? CONTINENT_COST : 1);
  }
  const edgeCost = edgeCostArray(mesh, cost, contMask, CONTINENT_ENTRY_PENALTY);
  const tags = seeds.map((_, k) => k);
  const speed = new Float32Array(count).fill(1);
  const target = share.slice();
  const area = new Float64Array(count);
  let tag: Int32Array = new Int32Array(0);
  for (let pass = 0; pass < GROWTH_PASSES; pass++) {
    tag = multiSourceDijkstra(mesh, seeds, tags, { edgeCost, tagSpeed: speed }).tag;
    area.fill(0);
    for (let i = 0; i < n; i++) area[tag[i]] += 1 / n;
    if (pass === 0) {
      const order = tags.slice().sort((a, b) => area[b] - area[a] || a - b);
      order.forEach((k, rank) => { target[k] = share[rank]; });
    }
    if (pass < GROWTH_PASSES - 1) {
      for (let k = 0; k < count; k++) speed[k] *= Math.pow(target[k] / Math.max(area[k], 0.1 * target[k]), 0.5);
    }
  }
  const plate = new Int16Array(n);
  for (let i = 0; i < n; i++) plate[i] = tag[i] >= 0 ? tag[i] : 0;
  smoothBoundaries(mesh, plate, seeds, 3);
  absorbContinentalSlivers(mesh, plate, continents, seeds, Math.round((0.6 * n) / count));
  continentalMarginBuffer(mesh, plate, contMask, MARGIN_RINGS, seeds, Math.round(MARGIN_PROTECT_AREA * n));
  enforceConnectivity(mesh, plate, count);
  return { plate, seeds };
}
