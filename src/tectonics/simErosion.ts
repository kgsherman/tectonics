import { CRUST_CONTINENTAL } from '../core/types';
import {
  TECTONIC_EROSION_MIN_CELLS, TECTONIC_EROSION_RATE, TECTONIC_EROSION_REF_SPEED,
} from './simConstants';
import { markReleased } from './simDirty';
import { hash01 } from './simHash';
import { FRONT_SUBDUCTION, type StepScratch } from './simScratch';
import type { PlateSlot, SimState } from './simState';

/** Salt separating the erosion draws from other per-cell random draws of the same step. */
const EROSION_SALT = 0x5eed_e205;

/**
 * Tectonic erosion (subduction erosion + sediment subduction; the recycling half of the crustal
 * budget): the overriding plate's leading edge at every subduction front retreats landward at
 * TECTONIC_EROSION_RATE km/Myr (∝ convergence, capped at 2×). A front cell goes with probability
 * rate·dt / spacing per step: its lattice cell is released, the world cell is refilled by the
 * subducting plate (which already runs beneath it) and the trench steps inward. Eroded continental
 * crust is recycled into the mantle. Arcs therefore migrate with their retreating trench, and the
 * juvenile crust they add is balanced by what the trench removes, instead of accumulating forever.
 * Requires this step's detectFronts(); run after the plate edits of the step and before settleTops,
 * which turns the released cells into gaps and refills them.
 */
export function tectonicErosion(state: SimState, sc: StepScratch, dt: number): void {
  if (!(TECTONIC_EROSION_RATE > 0)) return;
  const { top, src, slots, counters } = state;
  const { adjOffset, adj } = state.sm;
  const { frontList, frontKind, frontOver, frontV } = sc;
  const perStep = (TECTONIC_EROSION_RATE * dt) / state.sm.spacingKm;
  const seed = state.params.seed ^ EROSION_SALT, step = state.stepIndex;
  for (let q = 0; q < sc.frontCount; q++) {
    const i = frontList[q];
    if (frontKind[i] !== FRONT_SUBDUCTION) continue;
    const T = top[i];
    // Plate edits after detectFronts (merges, rifts) may have relabelled the cell.
    if (T < 0 || T !== frontOver[i]) continue;
    const P = slots[T] as PlateSlot;
    const j = src[i];
    if (!P.owned[j] || P.ownedCount < TECTONIC_EROSION_MIN_CELLS) continue;
    const speed = Math.min(2, frontV[i] / TECTONIC_EROSION_REF_SPEED);
    // Protruding front cells (many neighbours on the other side) go first and notches last, so the
    // retreating margin gets smoother instead of serrated: weight (k/2)², k = foreign ring cells
    // (≈ 2 on a straight front, so the mean rate is unchanged).
    let k = 0;
    for (let q2 = adjOffset[i], e = adjOffset[i + 1]; q2 < e; q2++) if (top[adj[q2]] !== T) k++;
    const shape = Math.min(4, 0.25 * k * k);
    if (!(hash01(seed, step, i, 0) < perStep * speed * shape)) continue;
    P.owned[j] = 0;
    P.ownedCount--;
    markReleased(state, i);
    counters.tectonicErosion++;
    if (P.crust[j] === CRUST_CONTINENTAL) {
      counters.continentalDestroyed++;
      counters.erodedContinental++;
    } else {
      counters.subductedCells++;
    }
  }
}
