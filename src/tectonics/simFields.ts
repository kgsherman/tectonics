import { EARTH_RADIUS_KM } from '../core/constants';
import { cellsWithinRadius } from '../core/sphereMesh';
import { CRUST_CONTINENTAL } from '../core/types';
import {
  ARC_FALL_KM, ARC_OCEANIC_FACTOR, ARC_PEAK_KM, ARC_RISE_KM, COLLISION_MAX_KM, COLLISION_PEAK_KM,
  COLLISION_PEAK_SHARE, COLLISION_PLATEAU_KM, CORDILLERA_FALL_KM, CORDILLERA_PEAK_KM, CORDILLERA_RISE_KM,
  FRONT_SMOOTH_PASSES, HOTSPOT_CONT_TARGET, HOTSPOT_OCEAN_TARGET, HOTSPOT_RATE, HOTSPOT_REACH,
  SUBDUCTION_MAX_KM, SUBDUCTION_UPLIFT_RATE, TRENCH_DEPTH, TRENCH_FULL_SPEED, TRENCH_MAX_KM, TRENCH_WIDTH_KM,
  UPLIFT_SMOOTH_KM, UPLIFT_SOFT_CAP, ARC_CORE_FRACTION,
} from './simConstants';
import { FRONT_COLLISION, FRONT_SUBDUCTION, type StepScratch } from './simScratch';
import type { SimState } from './simState';

/**
 * Great-circle distance (km, chord approximation — < 0.1% error below 1500 km) between world cells a
 * and b. Kernels use it rather than the Dijkstra path length, which is quantized and anisotropic at
 * lattice scale (graph paths zig-zag) and would imprint cell-scale noise on narrow arc kernels.
 */
function distanceKm(xyz: Float64Array, a: number, b: number): number {
  const dx = xyz[3 * a] - xyz[3 * b], dy = xyz[3 * a + 1] - xyz[3 * b + 1], dz = xyz[3 * a + 2] - xyz[3 * b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * EARTH_RADIUS_KM;
}

/** Asymmetric Gaussian bump peaking at `peak` km (rise width before, fall width after). */
function bump(d: number, peak: number, rise: number, fall: number): number {
  const x = (d - peak) / (d < peak ? rise : fall);
  return Math.exp(-x * x);
}

/** Smooth cosine taper from 1 at `start` to 0 at `end`. */
function taper(d: number, start: number, end: number): number {
  if (d <= start) return 1;
  if (d >= end) return 0;
  return 0.5 + 0.5 * Math.cos((Math.PI * (d - start)) / (end - start));
}

/** Collision kernel: frontal range + broad plateau (Himalaya + Tibet). */
function collisionKernel(d: number): number {
  const x = d / COLLISION_PEAK_KM;
  const peak = Math.exp(-x * x);
  return COLLISION_PEAK_SHARE * peak + (1 - COLLISION_PEAK_SHARE) * taper(d, COLLISION_PLATEAU_KM, COLLISION_MAX_KM);
}

/**
 * Soft saturation of a raw tectonic uplift `raw` (m) at elevation h: Δ = (H − h⁺)(1 − e^(−raw/H)).
 * Equals raw·(1 − h⁺/H) for small increments (the linear soft cap) but can never lift a cell past H,
 * however large one step's collision budget is.
 */
export function saturate(raw: number, h: number): number {
  const room = UPLIFT_SOFT_CAP - (h > 0 ? h : 0);
  return room > 0 ? room * (1 - Math.exp(-raw / UPLIFT_SOFT_CAP)) : 0;
}

/**
 * E (part 2). Intensive world fields for this step: raw tectonic uplift (m over the step) from
 * subduction and collision (saturated per plate cell when gathered), hotspot uplift, the arc mask
 * and the transient trench offset. Requires detectFronts() for this step.
 */
export function computeFields(state: SimState, sc: StepScratch, dt: number): void {
  sc.uplift.fill(0);
  sc.hotspotUp.fill(0);
  sc.arcMask.fill(0);
  overridingPlateFields(state, sc, dt);
  smoothUplift(state, sc);
  hotspotFields(state, sc, dt);
  trenchField(state, sc);
}

/** Subduction arcs / cordilleras and collision belts, spread over the overriding plate. */
function overridingPlateFields(state: SimState, sc: StepScratch, dt: number): void {
  const { top, wCrust, params, collisionBudget, budgetCells } = state;
  const { xyz } = state.sm;
  const { frontV, frontKind, frontList, uplift, arcMask, budgetAt, norm, dijkstra: dj } = sc;
  dj.run(state.sm, top, frontList, sc.frontCount, Math.max(SUBDUCTION_MAX_KM, COLLISION_MAX_KM));
  const { srcOf, reached } = dj;

  // Subduction: uplift ∝ convergence speed, peaking at the arc distance from the front.
  const subK = SUBDUCTION_UPLIFT_RATE * params.subductionUplift * dt;
  for (let r = 0; r < dj.reachedCount; r++) {
    const c = reached[r];
    const s = srcOf[c];
    if (frontKind[s] !== FRONT_SUBDUCTION) continue;
    const d = distanceKm(xyz, c, s);
    if (d > SUBDUCTION_MAX_KM) continue;
    const oceanicFront = wCrust[s] !== CRUST_CONTINENTAL;
    let f = oceanicFront
      ? bump(d, ARC_PEAK_KM, ARC_RISE_KM, ARC_FALL_KM)
      : bump(d, CORDILLERA_PEAK_KM, CORDILLERA_RISE_KM, CORDILLERA_FALL_KM);
    f *= taper(d, 0.7 * SUBDUCTION_MAX_KM, SUBDUCTION_MAX_KM);
    const arcFactor = oceanicFront ? ARC_OCEANIC_FACTOR : 1;
    const du = subK * frontV[s] * f * arcFactor;
    if (!(du > 0)) continue;
    uplift[c] += du;
    if (f >= ARC_CORE_FRACTION) arcMask[c] = 1;
  }

  // Collision: the consumed continental volume budget, gathered to its nearest collision front,
  // smoothed along the front and spread over the collision kernel (≈ volume conserving).
  if (state.budgetCount === 0) return;
  const volScale = params.collisionUplift;
  for (let q = 0; q < state.budgetCount; q++) {
    const b = budgetCells[q];
    const vol = collisionBudget[b] * volScale;
    const s = srcOf[b];
    if (s >= 0 && frontKind[s] === FRONT_COLLISION) budgetAt[s] += vol;
    // Consumed away from any detected collision front (e.g. a buried continental orphan): thicken locally.
    else uplift[b] += vol;
  }
  smoothBudgets(state, sc);
  for (let r = 0; r < dj.reachedCount; r++) {
    const c = reached[r];
    const s = srcOf[c];
    if (frontKind[s] === FRONT_COLLISION && budgetAt[s] > 0) norm[s] += collisionKernel(distanceKm(xyz, c, s));
  }
  for (let r = 0; r < dj.reachedCount; r++) {
    const c = reached[r];
    const s = srcOf[c];
    if (frontKind[s] !== FRONT_COLLISION || !(budgetAt[s] > 0) || !(norm[s] > 0)) continue;
    uplift[c] += (budgetAt[s] * collisionKernel(distanceKm(xyz, c, s))) / norm[s];
  }
  for (let q = 0; q < sc.frontCount; q++) {
    budgetAt[frontList[q]] = 0;
    norm[frontList[q]] = 0;
  }
}

/**
 * Conservative smoothing of the raw tectonic uplift inside each plate (per pass half of a cell's
 * uplift stays, half is shared among its same-plate neighbours; UPLIFT_SMOOTH_KM sets the number of
 * passes for the mesh resolution). Removes the cell-scale noise that jagged fronts imprint on narrow
 * kernels; total uplift is preserved.
 */
function smoothUplift(state: SimState, sc: StepScratch): void {
  const { top } = state;
  const { adjOffset, adj } = state.sm;
  const { uplift, tmpA, dijkstra: dj } = sc;
  const { reached } = dj;
  const count = dj.reachedCount;
  if (count === 0) return;
  const passes = Math.max(1, Math.round(((2 * UPLIFT_SMOOTH_KM) / state.sm.spacingKm) ** 2));
  for (let pass = 0; pass < passes; pass++) {
    for (let r = 0; r < count; r++) tmpA[reached[r]] = 0;
    for (let r = 0; r < count; r++) {
      const c = reached[r];
      const u = uplift[c];
      if (!(u > 0)) continue;
      const t = top[c];
      let same = 0;
      for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) if (top[adj[q]] === t) same++;
      if (same === 0) {
        tmpA[c] += u;
        continue;
      }
      tmpA[c] += 0.5 * u;
      const share = (0.5 * u) / same;
      for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) if (top[adj[q]] === t) tmpA[adj[q]] += share;
    }
    for (let r = 0; r < count; r++) uplift[reached[r]] = tmpA[reached[r]];
  }
}

/** Conservative smoothing of collision budgets along collision fronts (half stays, half is shared). */
function smoothBudgets(state: SimState, sc: StepScratch): void {
  const { adjOffset, adj } = state.sm;
  const { frontKind, frontOver, frontUnder, frontList, budgetAt, tmpA } = sc;
  const sameFront = (i: number, a: number): boolean =>
    frontKind[a] === FRONT_COLLISION && frontOver[a] === frontOver[i] && frontUnder[a] === frontUnder[i];
  for (let pass = 0; pass < FRONT_SMOOTH_PASSES; pass++) {
    for (let q = 0; q < sc.frontCount; q++) tmpA[frontList[q]] = 0;
    for (let q = 0; q < sc.frontCount; q++) {
      const i = frontList[q];
      const b = budgetAt[i];
      if (frontKind[i] !== FRONT_COLLISION || !(b > 0)) continue;
      let cnt = 0;
      for (let r = adjOffset[i], e = adjOffset[i + 1]; r < e; r++) if (sameFront(i, adj[r])) cnt++;
      if (cnt === 0) {
        tmpA[i] += b;
        continue;
      }
      tmpA[i] += 0.5 * b;
      const share = (0.5 * b) / cnt;
      for (let r = adjOffset[i], e = adjOffset[i + 1]; r < e; r++) if (sameFront(i, adj[r])) tmpA[adj[r]] += share;
    }
    for (let q = 0; q < sc.frontCount; q++) budgetAt[frontList[q]] = tmpA[frontList[q]];
  }
}

/** Static hotspot footprints (world cells within reach and Gaussian weights), built once per sim. */
function hotspotFootprints(state: SimState, sc: StepScratch): { cells: Int32Array[]; weights: Float32Array[] } {
  if (sc.hotspotCells && sc.hotspotWeight) return { cells: sc.hotspotCells, weights: sc.hotspotWeight };
  const cells: Int32Array[] = [];
  const weights: Float32Array[] = [];
  const { xyz, mesh } = state.sm;
  for (const h of state.hotspots) {
    // Inert plumes (no width or no strength) get an empty footprint: a negative strength would make the
    // saturating growth run away from its target instead of toward it.
    const inert = !(h.radius > 0) || !(h.strength > 0);
    const list = inert ? new Int32Array(0) : Int32Array.from(cellsWithinRadius(mesh, h.pos, HOTSPOT_REACH * h.radius));
    const len = Math.hypot(h.pos[0], h.pos[1], h.pos[2]) || 1;
    const w = new Float32Array(list.length);
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      const d = (xyz[3 * c] * h.pos[0] + xyz[3 * c + 1] * h.pos[1] + xyz[3 * c + 2] * h.pos[2]) / len;
      const x = Math.acos(Math.max(-1, Math.min(1, d))) / h.radius;
      w[k] = Math.exp(-x * x);
    }
    cells.push(list);
    weights.push(w);
  }
  sc.hotspotCells = cells;
  sc.hotspotWeight = weights;
  return { cells, weights };
}

/** Mantle hotspots (world frame): saturating growth toward a volcanic target height. */
function hotspotFields(state: SimState, sc: StepScratch, dt: number): void {
  const act = state.params.hotspotActivity;
  if (!(act > 0) || state.hotspots.length === 0) return;
  const foot = hotspotFootprints(state, sc);
  const { wElev, wCrust } = state;
  const { hotspotUp } = sc;
  for (let h = 0; h < state.hotspots.length; h++) {
    const s = state.hotspots[h].strength;
    const cells = foot.cells[h], weight = foot.weights[h];
    const targetOcean = HOTSPOT_OCEAN_TARGET * s * s;
    const targetCont = HOTSPOT_CONT_TARGET * s;
    for (let q = 0; q < cells.length; q++) {
      const c = cells[q];
      const target = wCrust[c] === CRUST_CONTINENTAL ? targetCont : targetOcean;
      const h0 = wElev[c] + hotspotUp[c];
      if (h0 >= target) continue;
      const k = HOTSPOT_RATE * s * act * weight[q];
      hotspotUp[c] += (target - h0) * (1 - Math.exp(-k * dt));
    }
  }
}

/**
 * Transient trench (display only): subducting-side cells within TRENCH_MAX_KM of a subduction front
 * are pulled toward TRENCH_DEPTH, scaled by min(1, v_conv / TRENCH_FULL_SPEED). Requires detectFronts().
 */
export function trenchField(state: SimState, sc: StepScratch): void {
  const { top, wElev, trench } = state;
  const { adjOffset, adj } = state.sm;
  const { frontV, frontKind, frontUnder, frontList, sources, trenchV, dijkstra: dj } = sc;
  trench.fill(0);
  let count = 0;
  for (let q = 0; q < sc.frontCount; q++) {
    const i = frontList[q];
    if (frontKind[i] !== FRONT_SUBDUCTION) continue;
    const K = frontUnder[i];
    for (let r = adjOffset[i], e = adjOffset[i + 1]; r < e; r++) {
      const a = adj[r];
      if (top[a] !== K) continue;
      if (trenchV[a] === 0) sources[count++] = a;
      trenchV[a] = Math.max(trenchV[a], frontV[i]);
    }
  }
  if (count === 0) return;
  dj.run(state.sm, top, sources, count, TRENCH_MAX_KM);
  const { dist, srcOf, reached } = dj;
  for (let r = 0; r < dj.reachedCount; r++) {
    const c = reached[r];
    if (!(wElev[c] > TRENCH_DEPTH)) continue;
    const d = dist[c];
    const x = d / TRENCH_WIDTH_KM;
    const w = Math.exp(-x * x) * Math.min(1, trenchV[srcOf[c]] / TRENCH_FULL_SPEED);
    trench[c] = (TRENCH_DEPTH - wElev[c]) * w;
  }
  for (let q = 0; q < count; q++) trenchV[sources[q]] = 0;
}
