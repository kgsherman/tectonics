import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import { oceanDepthForAge } from './draft';
import {
  ARC_CONVERSION_ELEV, ARC_JUVENILE_UPLIFT, CRATON_AGE, DIFFUSIVITY, ELEVATION_MAX, FREEBOARD_CRATON, FREEBOARD_JUVENILE, FREEBOARD_YOUNG,
  JUVENILE_AGE, OCEAN_FLOOR_MIN, OROGENY_DECAY, OROGEN_THRESHOLD, SHELF_DEPTH, SUBMARINE_DIFFUSIVITY_FACTOR,
  SEDIMENT_ACTIVE_EFFICIENCY, SEDIMENT_EFFICIENCY, TAU_CONTINENT, TAU_ISLAND, TAU_JUVENILE, TAU_OROGEN, TAU_SHELF,
} from './simConstants';
import { saturate } from './simFields';
import { hash01 } from './simHash';
import type { StepScratch } from './simScratch';
import type { SimState } from './simState';

/**
 * Hillslope diffusion in world space (crossing plate boundaries): explicit flux-form sub-cycles on the
 * world graph applied to the world elevation at the start of G; the change is written to sc.diffusion and
 * gathered into plate cells through the push map. The flux across an edge is split into a subaerial
 * part κ·Δmax(h, 0) (land erodes toward base level = sea level, not toward the adjacent ocean floor)
 * and a slow submarine part κ_sea·Δmin(h, 0). Graph Laplacian on a near-hexagonal lattice:
 * ∇²h ≈ 2/(3s²)·Σ_a (h_a − h).
 */
export function computeDiffusion(state: SimState, sc: StepScratch, dt: number): void {
  const { n, wElev } = state;
  const { adjOffset, adj, spacingKm } = state.sm;
  const out = sc.diffusion;
  const kLand = DIFFUSIVITY * state.params.erosion;
  if (!(kLand > 0)) {
    out.fill(0);
    return;
  }
  const kSea = kLand * SUBMARINE_DIFFUSIVITY_FACTOR;
  const c = 2 / (3 * spacingKm * spacingKm);
  // Stable explicit sub-cycling: dt_sub · κ · c · max degree ≤ 0.45.
  const nsub = Math.max(1, Math.ceil((dt * kLand * c * 8) / 0.45));
  const aLand = (dt / nsub) * c * kLand;
  const aSea = (dt / nsub) * c * kSea;
  let cur = sc.tmpA, next = sc.tmpB;
  cur.set(wElev);
  for (let it = 0; it < nsub; it++) {
    for (let i = 0; i < n; i++) {
      const hi = cur[i];
      const li = hi > 0 ? hi : 0;
      const si = hi < 0 ? hi : 0;
      let fl = 0, fs = 0;
      for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
        const ha = cur[adj[q]];
        fl += (ha > 0 ? ha : 0) - li;
        fs += (ha < 0 ? ha : 0) - si;
      }
      next[i] = hi + aLand * fl + aSea * fs;
    }
    const t = cur;
    cur = next;
    next = t;
  }
  for (let i = 0; i < n; i++) out[i] = cur[i] - wElev[i];
}

/** Ocean depth vs age lookup (0.25 Myr steps up to 600 Myr) for the per-cell subsidence increments. */
const DEPTH_STEP = 0.25;
const DEPTH_MAX_AGE = 600;
const depthTable = (() => {
  const t = new Float64Array(Math.ceil(DEPTH_MAX_AGE / DEPTH_STEP) + 2);
  for (let k = 0; k < t.length; k++) t[k] = oceanDepthForAge(k * DEPTH_STEP);
  return t;
})();

/**
 * oceanDepthForAge via linear table interpolation. Only differences depth(a1) − depth(a0) are
 * applied to crust, and those telescope along a cell's life, so the table error never accumulates.
 */
function depthAt(age: number): number {
  if (!(age < DEPTH_MAX_AGE)) return oceanDepthForAge(age);
  const x = (age > 0 ? age : 0) / DEPTH_STEP;
  const k = x | 0;
  return depthTable[k] + (depthTable[k + 1] - depthTable[k]) * (x - k);
}

/** Isostatic freeboard (m) of continental crust of the given age (Myr). */
function freeboard(age: number): number {
  if (age < JUVENILE_AGE) return FREEBOARD_JUVENILE + ((FREEBOARD_YOUNG - FREEBOARD_JUVENILE) * age) / JUVENILE_AGE;
  return FREEBOARD_YOUNG + (FREEBOARD_CRATON - FREEBOARD_YOUNG) * Math.min(1, (age - JUVENILE_AGE) / (CRATON_AGE - JUVENILE_AGE));
}

/**
 * G. One pass over every owned plate cell:
 *  1. Gather the intensive world fields through the push map (each surface plate cell takes exactly
 *     one sample): tectonic uplift saturated at the cell's own height + hotspot uplift + diffusion;
 *     orogeny grows by the uplift. Oceanic arc crust rising above ARC_CONVERSION_ELEV becomes
 *     continental.
 *  2. Surface processes: oceanic aging + thermal subsidence (features subside too), wave planation of
 *     oceanic islands; continental aging + erosion toward an isostatic freeboard (orogenic excess
 *     faster; juvenile crust relaxes faster), submerged continental crust toward shelf depth; orogeny
 *     decay.
 */
export function gatherAndErode(state: SimState, sc: StepScratch, dt: number): void {
  const { n, top, slots, counters } = state;
  const { adjOffset, adj } = state.sm;
  const { uplift, hotspotUp, diffusion, arcMask, subMask } = sc;
  const seed = state.params.seed, step = state.stepIndex;
  const er = Math.max(0, state.params.erosion);
  const fSlow = Math.exp((-dt * er) / TAU_CONTINENT);
  const fJuvenile = Math.exp((-dt * er) / TAU_JUVENILE);
  const fFast = Math.exp((-dt * er) / TAU_OROGEN);
  const fShelf = Math.exp((-dt * er) / TAU_SHELF);
  const fIsland = Math.exp((-dt * er) / TAU_ISLAND);
  const fOro = Math.exp(-dt / OROGENY_DECAY);
  let eroded = 0;
  for (let k = 0; k < slots.length; k++) {
    const P = slots[k];
    if (!P) continue;
    const { owned, owned4, hint, elev, orogeny, crust, age } = P;
    for (let j = 0; j < n; j++) {
      if ((j & 3) === 0 && owned4[j >> 2] === 0) {
        j += 3;
        continue;
      }
      if (!owned[j]) continue;
      // 1. Gather.
      let active = false;
      let i = hint[j];
      if (top[i] !== k) {
        // Edge alias (pushed onto the neighbouring plate): sample a ring cell where k is on top, so
        // cells still shown at the plate edge get the same uplift as their neighbours (no pits).
        const h0 = i;
        i = -1;
        for (let q = adjOffset[h0], e = adjOffset[h0 + 1]; q < e; q++) {
          if (top[adj[q]] === k) {
            i = adj[q];
            break;
          }
        }
      }
      if (i >= 0) {
        const raw = uplift[i];
        active = subMask[i] !== 0;
        const tect = raw > 0 ? saturate(raw, elev[j]) : 0;
        // Collisional thickening beyond what the surface can take (the soft cap) spreads sideways
        // (orogenic collapse): that volume returns to the margins like eroded sediment.
        if (!active && raw > tect) eroded += SEDIMENT_EFFICIENCY * (raw - tect);
        const up = tect + hotspotUp[i];
        elev[j] += up + diffusion[i];
        orogeny[j] += up;
        if (arcMask[i] && crust[j] === CRUST_OCEANIC && elev[j] > ARC_CONVERSION_ELEV && raw > 0 &&
            hash01(seed, step, j, k) * ARC_JUVENILE_UPLIFT < raw) {
          // Emergent arc crust matures into juvenile continental crust at a rate set by the arc's
          // magmatic addition (∝ arc uplift, see ARC_JUVENILE_UPLIFT); its age restarts.
          crust[j] = CRUST_CONTINENTAL;
          age[j] = 0;
          counters.continentalCreated++;
          counters.arcConversions++;
        }
      }
      // 2. Surface processes.
      const a0 = age[j];
      const a1 = a0 + dt;
      age[j] = a1;
      let h = elev[j];
      if (crust[j] === CRUST_OCEANIC) {
        h += depthAt(a1) - depthAt(a0);
        if (h > 0) h *= fIsland;
        if (h < OCEAN_FLOOR_MIN) h = OCEAN_FLOOR_MIN;
      } else {
        // Drafts may carry negative ages: extrapolating the maturity blend below age 0 would give
        // factors outside [0, 1] (an unstable, eventually non-finite relaxation).
        const am = a1 > 0 ? a1 : 0;
        const base = freeboard(am);
        if (h >= 0) {
          // Land erodes toward its freeboard; juvenile crust relaxes faster (factors blended by maturity).
          const fBase = am < JUVENILE_AGE ? fJuvenile + ((fSlow - fJuvenile) * am) / JUVENILE_AGE : fSlow;
          const e = h - base;
          const h0 = h;
          h = e > OROGEN_THRESHOLD
            ? base + OROGEN_THRESHOLD * fBase + (e - OROGEN_THRESHOLD) * fFast
            : base + e * fBase;
          // The eroded continental volume goes to the margins (accreteMargins) — except where the
          // cell is being uplifted above a subducting slab: that sediment ends in the trench and is
          // subducted (sediment subduction), the recycling half of the arc budget. Collision belts
          // shed theirs into foreland basins and margins.
          if (h0 > h) eroded += active ? SEDIMENT_ACTIVE_EFFICIENCY * (h0 - h) : SEDIMENT_EFFICIENCY * (h0 - h);
        } else {
          // Submerged continental crust drifts toward shelf depth (deeper for low-standing juvenile crust).
          const target = base < SHELF_DEPTH ? base : SHELF_DEPTH;
          h = target + (h - target) * fShelf;
        }
      }
      elev[j] = h > ELEVATION_MAX ? ELEVATION_MAX : h;
      orogeny[j] *= fOro;
    }
  }
  state.sediment += eroded;
}
