import { EARTH_RADIUS_KM } from '../core/constants';
import type { Rng } from '../core/rng';
import type { Vec3 } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';
import {
  INITIATION_AGE, INITIATION_MIN_AREA, INITIATION_MIN_MARGIN, INITIATION_REF, INITIATION_SPEED_MAX,
  INITIATION_SPEED_MIN,
} from './simConstants';
import { stepScratch } from './simScratch';
import { splitPlate } from './simSplit';
import { plateCap, type PlateSlot, type SimState } from './simState';

/**
 * Subduction initiation (closing half of the Wilson cycle). Old oceanic lithosphere at a passive
 * margin (oceanic crust older than INITIATION_AGE next to continental crust of the same plate) is
 * dense enough to founder: with a Poisson rate tied to riftRate and to the amount of old ocean, the
 * connected oceanic region at one such margin detaches as a new plate converging on the continent.
 * The continent overrides it (per-cell continental rule), so a trench and cordillera form and the
 * old sea floor is recycled; the far side of the detached region becomes divergent.
 * Requires fresh world fields. Returns true when a new plate was created.
 */
export function maybeInitiateSubduction(state: SimState, rng: Rng, dt: number): boolean {
  const roll = rng.next();
  const rate = state.params.riftRate;
  if (!(rate > 0)) return false;
  let live = 0;
  for (const p of state.slots) if (p) live++;
  if (live >= plateCap(state)) return false;
  const { n, top, wCrust } = state;
  const wAge = stepScratch(state).wAge;
  let old = 0;
  for (let i = 0; i < n; i++) if (wCrust[i] !== CRUST_CONTINENTAL && wAge[i] > INITIATION_AGE) old++;
  const eventsPer100 = rate * Math.min(2, old / n / INITIATION_REF);
  if (roll >= 1 - Math.exp((-eventsPer100 * dt) / 100)) return false;

  // Old passive-margin cells, counted per plate.
  const { adjOffset, adj } = state.sm;
  const margin: number[] = [];
  const perPlate = new Int32Array(state.slots.length);
  for (let i = 0; i < n; i++) {
    if (wCrust[i] === CRUST_CONTINENTAL || !(wAge[i] > INITIATION_AGE)) continue;
    const k = top[i];
    for (let q = adjOffset[i], e = adjOffset[i + 1]; q < e; q++) {
      const a = adj[q];
      if (top[a] === k && wCrust[a] === CRUST_CONTINENTAL) {
        margin.push(i);
        perPlate[k]++;
        break;
      }
    }
  }
  const minMargin = Math.max(3, INITIATION_MIN_MARGIN * n);
  const candidates = margin.filter((i) => perPlate[top[i]] >= minMargin);
  if (candidates.length === 0) return false;
  const m = candidates[Math.min(candidates.length - 1, Math.floor(rng.next() * candidates.length))];
  return detachOcean(state, top[m], m, rng);
}

/** Split the oceanic region of plate k connected to margin cell m off as a plate converging on the continent. */
function detachOcean(state: SimState, k: number, m: number, rng: Rng): boolean {
  const { n, top, wCrust } = state;
  const { adjOffset, adj, xyz, diskOffset, disk, diskW } = state.sm;
  const P = state.slots[k] as PlateSlot;
  // Connected oceanic world region of plate k containing m.
  const inRegion = new Uint8Array(n);
  const queue = stepScratch(state).sources;
  let tail = 0;
  queue[tail++] = m;
  inRegion[m] = 1;
  for (let head = 0; head < tail; head++) {
    const c = queue[head];
    for (let q = adjOffset[c], e = adjOffset[c + 1]; q < e; q++) {
      const a = adj[q];
      if (inRegion[a] || top[a] !== k || wCrust[a] === CRUST_CONTINENTAL) continue;
      inRegion[a] = 1;
      queue[tail++] = a;
    }
  }
  if (tail < INITIATION_MIN_AREA * n || tail > 0.9 * P.visible) return false;
  // Lattice cells follow the world cell they push to.
  const side = new Uint8Array(n);
  let count = 0;
  for (let j = 0; j < n; j++) {
    if (P.owned[j] && inRegion[P.hint[j]]) {
      side[j] = 1;
      count++;
    }
  }
  if (count === 0 || count === P.ownedCount) return false;
  // Direction from the ocean toward the continent at m (Gaussian-weighted crust contrast).
  const px = xyz[3 * m], py = xyz[3 * m + 1], pz = xyz[3 * m + 2];
  let dx = 0, dy = 0, dz = 0;
  for (let q = diskOffset[m], e = diskOffset[m + 1]; q < e; q++) {
    const a = disk[q];
    if (top[a] !== k) continue;
    const w = wCrust[a] === CRUST_CONTINENTAL ? diskW[q] : -diskW[q];
    dx += w * (xyz[3 * a] - px);
    dy += w * (xyz[3 * a + 1] - py);
    dz += w * (xyz[3 * a + 2] - pz);
  }
  const dp = dx * px + dy * py + dz * pz;
  dx -= dp * px;
  dy -= dp * py;
  dz -= dp * pz;
  const dl = Math.hypot(dx, dy, dz);
  if (!(dl > 0)) return false;
  // Relative velocity child − parent = Δω × s_m = speed · d̂  ⇒  Δω = speed/R · (s_m × d̂), split ∓½.
  const half = (0.5 * rng.float(INITIATION_SPEED_MIN, INITIATION_SPEED_MAX)) / EARTH_RADIUS_KM / dl;
  const dw: Vec3 = [(py * dz - pz * dy) * half, (pz * dx - px * dz) * half, (px * dy - py * dx) * half];
  if (splitPlate(state, k, side, count, [-dw[0], -dw[1], -dw[2]], dw, 'below') < 0) return false;
  state.counters.rifts++;
  state.counters.subductionInitiations++;
  return true;
}
