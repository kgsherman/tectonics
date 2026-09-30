import type { PlateSpec, Quat, Vec3 } from '../core/types';
import { plateColor, plateName } from './draft';
import { insertRankAbove, insertRankBelow } from './simPolarity';
import {
  createPlateSlot, freeSlotIndex, installSlot, markOwned, markUnowned, slotBit, type PlateSlot, type SimState,
} from './simState';

/**
 * Split plate `parentSlot`: owned lattice cells with side[j] = 1 move to a new plate with the same
 * rotation (q, frame) and crust arrays. Angular velocities: parent ω + dwParent, child ω + dwChild.
 * The child enters the polarity order just above (or below) its parent. Returns the child slot, or
 * −1 when no slot is free.
 */
export function splitPlate(
  state: SimState, parentSlot: number, side: Uint8Array, childCount: number, dwParent: Vec3, dwChild: Vec3,
  childRank: 'above' | 'below',
): number {
  const slot = freeSlotIndex(state);
  if (slot < 0) return -1;
  const { n } = state;
  const P = state.slots[parentSlot] as PlateSlot;
  const w = P.spec.omega;
  const id = state.nextPlateId++;
  const spec: PlateSpec = {
    id,
    name: plateName(id, state.params.seed),
    color: plateColor(id - 1),
    omega: [w[0] + dwChild[0], w[1] + dwChild[1], w[2] + dwChild[2]],
  };
  if (P.spec.frame) spec.frame = [...P.spec.frame] as Quat;
  P.spec.omega = [w[0] + dwParent[0], w[1] + dwParent[1], w[2] + dwParent[2]];

  const C = createPlateSlot(slot, n, spec, P.q);
  C.crust.set(P.crust);
  C.elev.set(P.elev);
  C.age.set(P.age);
  C.orogeny.set(P.orogeny);
  C.hint.set(P.hint);
  C.pushInv.set(P.pushInv);
  for (let j = 0; j < n; j++) {
    if (!side[j]) continue;
    markOwned(C, j);
    markUnowned(P, j);
  }
  C.ownedCount = childCount;
  P.ownedCount -= childCount;
  installSlot(state, C);
  if (childRank === 'above') insertRankAbove(state, C, parentSlot);
  else insertRankBelow(state, C, parentSlot);

  const { top, src } = state;
  const bit = slotBit(slot);
  for (let i = 0; i < n; i++) if (top[i] === parentSlot && C.owned[src[i]]) top[i] = slot;
  for (let j = 0; j < n; j++) if (C.owned[j]) state.presenceCur[C.hint[j]] |= bit;
  return slot;
}
