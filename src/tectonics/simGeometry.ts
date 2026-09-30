import { EARTH_RADIUS_KM } from '../core/constants';
import { MIN_NORMAL_FRACTION, NORMAL_MIN_STRENGTH } from './simConstants';
import type { PlateSlot, SimState } from './simState';

/**
 * Scratch outputs of the boundary kinematics helpers (avoids per-call allocation in hot loops):
 * [0..2] unit boundary normal (pointing toward the "toward" plate), [3] normal relative speed,
 * [4] tangential relative speed (both km/Myr).
 */
export const kin = new Float64Array(5);

/**
 * Boundary normal at world cell i: n = Σ w_a σ_a (s_a − s_i) over the 3-ring disk with Gaussian
 * weights w (σ = 1.2 spacings) and σ_a = +1 for cells whose top is `toward`, −1 for `away`, projected
 * onto the tangent plane. Writes the unit normal to kin[0..2]; returns false when the normal is
 * undefined (|n| below NORMAL_MIN_STRENGTH of a straight boundary's value, e.g. deep inside a plate).
 * Hard 1–2-ring sums are biased by 10–20° on the Fibonacci lattice (the lattice's spiral axes leak
 * into the estimate); the smooth kernel brings the median error to ~3° (SPEC §4.2 C, v_conv gate).
 */
export function boundaryNormal(state: SimState, i: number, toward: number, away: number): boolean {
  const { xyz, diskOffset, disk, diskW, diskMoment } = state.sm;
  const top = state.top;
  const px = xyz[3 * i], py = xyz[3 * i + 1], pz = xyz[3 * i + 2];
  let nx = 0, ny = 0, nz = 0;
  for (let k = diskOffset[i], e = diskOffset[i + 1]; k < e; k++) {
    const a = disk[k];
    const t = top[a];
    const w = t === toward ? diskW[k] : t === away ? -diskW[k] : 0;
    if (w === 0) continue;
    nx += w * (xyz[3 * a] - px);
    ny += w * (xyz[3 * a + 1] - py);
    nz += w * (xyz[3 * a + 2] - pz);
  }
  const d = nx * px + ny * py + nz * pz;
  nx -= d * px;
  ny -= d * py;
  nz -= d * pz;
  const len = Math.hypot(nx, ny, nz);
  if (!(len >= NORMAL_MIN_STRENGTH * (2 / Math.PI) * diskMoment[i])) return false;
  kin[0] = nx / len;
  kin[1] = ny / len;
  kin[2] = nz / len;
  return true;
}

/**
 * Relative surface velocity of plate a with respect to plate b at unit point p, decomposed on the
 * normal in kin[0..2]: kin[3] = normal component, kin[4] = tangential magnitude (km/Myr).
 */
function decomposeRelative(a: PlateSlot, b: PlateSlot, px: number, py: number, pz: number, speedScale: number): void {
  const wa = a.spec.omega, wb = b.spec.omega;
  const s = EARTH_RADIUS_KM * speedScale;
  const wx = (wa[0] - wb[0]) * s, wy = (wa[1] - wb[1]) * s, wz = (wa[2] - wb[2]) * s;
  const vx = wy * pz - wz * py;
  const vy = wz * px - wx * pz;
  const vz = wx * py - wy * px;
  const vn = vx * kin[0] + vy * kin[1] + vz * kin[2];
  kin[3] = vn;
  kin[4] = Math.hypot(vx - vn * kin[0], vy - vn * kin[1], vz - vn * kin[2]);
}

/**
 * Speed (km/Myr, ≥ 0) at which plate `loser` converges on plate `over` at world cell i:
 * max(0, −(v_loser − v_over)·n̂) with the boundary normal pointing toward `loser`. Zero when the normal
 * is undefined or the motion is too oblique (normal part < MIN_NORMAL_FRACTION of the relative speed).
 */
export function convergenceAt(state: SimState, i: number, loser: number, over: number): number {
  if (!boundaryNormal(state, i, loser, over)) return 0;
  const { xyz } = state.sm;
  decomposeRelative(
    state.slots[loser] as PlateSlot, state.slots[over] as PlateSlot, xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2],
    state.params.speedScale,
  );
  const vc = -kin[3];
  if (vc <= 0) return 0;
  if (vc < MIN_NORMAL_FRACTION * Math.hypot(vc, kin[4])) return 0;
  return vc;
}

/**
 * Speed (km/Myr, ≥ 0) at which plates a and b separate at world cell i ((v_a − v_b)·n̂ with n̂
 * pointing toward a). Same normal and obliquity rules as convergenceAt.
 */
export function divergenceAt(state: SimState, i: number, a: number, b: number): number {
  if (!boundaryNormal(state, i, a, b)) return 0;
  const { xyz } = state.sm;
  decomposeRelative(
    state.slots[a] as PlateSlot, state.slots[b] as PlateSlot, xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2],
    state.params.speedScale,
  );
  const vd = kin[3];
  if (vd <= 0) return 0;
  if (vd < MIN_NORMAL_FRACTION * Math.hypot(vd, kin[4])) return 0;
  return vd;
}

/** |ω_a − ω_b| × p · R (km/Myr) at unit point (px, py, pz), without speedScale. */
export function relativeSpeed(a: PlateSlot, b: PlateSlot, px: number, py: number, pz: number): number {
  const wa = a.spec.omega, wb = b.spec.omega;
  const wx = wa[0] - wb[0], wy = wa[1] - wb[1], wz = wa[2] - wb[2];
  return Math.hypot(wy * pz - wz * py, wz * px - wx * pz, wx * py - wy * px) * EARTH_RADIUS_KM;
}
