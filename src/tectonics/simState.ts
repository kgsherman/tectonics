import { MAX_PLATES } from '../core/constants';
import { quatIdentity, quatNormalize, quatToMat3 } from '../core/math3';
import type { Hotspot, PlateSpec, Quat, SphereMesh, TectonicParams, WorldDraft } from '../core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import { clonePlateSpec } from './draft';
import { markAllDirty } from './simDirty';
import { simMeshOf, type SimMesh } from './simMesh';

/**
 * One plate: dense per-lattice-cell arrays in the plate's own frame (SPEC §4.1). The shared mesh
 * lattice is every plate's reference lattice; world position of plate cell j = R(q)·s_j.
 */
export interface PlateSlot {
  /** Slot index = bit index in every bitmask (0..31). */
  readonly slot: number;
  /** id / name / color / world-frame omega (rad/Myr); `frame` = material frame at construction. */
  spec: PlateSpec;
  /** Accumulated rotation plate → world (never reset). */
  q: Quat;
  /** Row-major 3×3 matrix of q. */
  readonly m: Float64Array;
  /** 1 where the plate owns lattice cell j (length padded to a multiple of OWNED_BLOCK, zeros beyond n). */
  readonly owned: Uint8Array;
  /** Uint32 view of `owned`: lets hot loops skip four unowned cells per test. */
  readonly owned4: Uint32Array;
  /**
   * Owned cells per block of OWNED_BLOCK lattice cells (kept exact by every writer of `owned`: claimCell,
   * releaseCell, consumption, tectonic erosion, splits, construction). Per-plate loops skip empty blocks.
   */
  readonly blockOwned: Uint8Array;
  readonly crust: Uint8Array;
  readonly elev: Float32Array;
  readonly age: Float32Array;
  readonly orogeny: Float32Array;
  /** Push map: world cell that lattice cell j pushed to in the last plate pass. */
  readonly hint: Int32Array;
  /** Inverse push map: lattice cell that last pushed to world cell i (valid where the presence bit is set). */
  readonly pushInv: Int32Array;
  ownedCount: number;
  /** World cells on top (refreshed after the substeps). */
  visible: number;
  visibleCont: number;
}

export interface SimCounters {
  continentalCreated: number;
  continentalDestroyed: number;
  subductedCells: number;
  ridgeCells: number;
  rifts: number;
  merges: number;
  /** Diagnostics (not in TectonicStats): breakdown of continental creation / destruction. */
  arcConversions: number;
  continentalClones: number;
  collisionConsumed: number;
  subductionInitiations: number;
  /** Overriding-plate front cells removed by tectonic erosion (all / continental). */
  tectonicErosion: number;
  erodedContinental: number;
  /** Continental crust created by closing enclosed oceanic cells / oceanic specks. */
  basinClosures: number;
  speckClosures: number;
  /** Continental margin cells built from eroded sediment. */
  marginAccretions: number;
  /** Docked terranes (small continental fragments transferred to the overriding plate). */
  terranes: number;
}

/** Plate-pair bookkeeping (symmetric, index a*MAX_PLATES+b with a < b). */
export interface PairState {
  /** Accumulated collisional shortening, km. */
  shortening: Float64Array;
  /** Collision-front contacts in the current step. */
  contacts: Int32Array;
  /** Sum of convergence speeds over the contacts of the current step. */
  vconvSum: Float64Array;
  /** Myr since the last collision contact. */
  sinceContact: Float64Array;
  /** Myr the pair has been nearly at rest relative to each other (merge clock). */
  slowTime: Float64Array;
  /** Last known collision contact point (unit vector, 3 per pair index). */
  contactPoint: Float64Array;
}

export interface SimState {
  readonly sm: SimMesh;
  readonly n: number;
  params: TectonicParams;
  /** Plate cap = min(MAX_PLATES, max(params.maxPlates, initial plate count)). */
  initialPlateCount: number;
  readonly slots: (PlateSlot | null)[];
  liveMask: number;
  /* World (mantle-frame) arrays, one entry per mesh cell. */
  readonly top: Int16Array;
  readonly topPrev: Int16Array;
  /** Lattice cell of the top plate that covers world cell i. */
  readonly src: Int32Array;
  /** Plates covering i that lost the overlap (fully rewritten every substep). */
  readonly loser: Uint32Array;
  /** Plates whose lattice cells pushed into i: current / previous substep (double-buffered). */
  presenceCur: Uint32Array;
  presencePrev: Uint32Array;
  readonly gaps: Int32Array;
  gapCount: number;
  /** Consumed continental "volume" per world cell this step (m × cells). */
  readonly collisionBudget: Float32Array;
  readonly budgetCells: Int32Array;
  budgetCount: number;
  /** World elevation / crust (raw lattice values of the top plate), refreshed once per step. */
  readonly wElev: Float32Array;
  readonly wCrust: Uint8Array;
  /** Transient trench display offset (m, ≤ 0), recomputed every step. */
  readonly trench: Float32Array;
  /** Plate slots ordered by polarity rank, lowest (subducts) first. */
  rankOrder: number[];
  /** rankPos[slot] = index in rankOrder (higher overrides). */
  readonly rankPos: Int32Array;
  /** Persistence clock (Myr) of a pending rank swap for adjacent (lower, upper) slots. */
  readonly flipClock: Float64Array;
  readonly pairs: PairState;
  readonly hotspots: Hotspot[];
  time: number;
  stepIndex: number;
  nextPlateId: number;
  readonly counters: SimCounters;
  /** Serial of the current substep (cache stamps). */
  substepSerial: number;
  /** Time of the last slab-pull refit. */
  lastSlabPullTime: number;
  /** Myr since the last polarity-rank update. */
  polarityClock: number;
  /**
   * Continental volume eroded off the land and not yet redeposited as new margin crust, in metres of
   * elevation × cells (see accreteMargins). Not part of drafts: a resumed sim starts with none.
   */
  sediment: number;
  /** Myr since the last margin accretion. */
  marginClock: number;
  warnedSubstepCap: boolean;
}

/** Lattice cells per `blockOwned` entry (16 words of `owned4`). */
export const OWNED_BLOCK = 64;

/** Set owned[j] (keeps the block count exact). */
export function markOwned(P: PlateSlot, j: number): void {
  if (!P.owned[j]) {
    P.owned[j] = 1;
    P.blockOwned[j >> 6]++;
  }
}

/** Clear owned[j] (keeps the block count exact). */
export function markUnowned(P: PlateSlot, j: number): void {
  if (P.owned[j]) {
    P.owned[j] = 0;
    P.blockOwned[j >> 6]--;
  }
}

export function slotBit(slot: number): number {
  return (1 << slot) >>> 0;
}

export function plateCap(state: SimState): number {
  return Math.min(MAX_PLATES, Math.max(state.params.maxPlates, state.initialPlateCount));
}

export function pairIndex(a: number, b: number): number {
  return a < b ? a * MAX_PLATES + b : b * MAX_PLATES + a;
}

export function liveSlotList(state: SimState): number[] {
  const out: number[] = [];
  for (let k = 0; k < MAX_PLATES; k++) if (state.slots[k]) out.push(k);
  return out;
}

export function setPlateRotation(p: PlateSlot, q: Quat): void {
  p.q = quatNormalize(q);
  quatToMat3(p.q, p.m);
}

/** Allocate plate arrays in the given slot. */
export function createPlateSlot(slot: number, n: number, spec: PlateSpec, q: Quat): PlateSlot {
  const owned = new Uint8Array(OWNED_BLOCK * Math.ceil(n / OWNED_BLOCK));
  const p: PlateSlot = {
    slot,
    spec,
    q: quatIdentity(),
    m: new Float64Array(9),
    owned,
    owned4: new Uint32Array(owned.buffer),
    blockOwned: new Uint8Array(owned.length / OWNED_BLOCK),
    crust: new Uint8Array(n),
    elev: new Float32Array(n),
    age: new Float32Array(n),
    orogeny: new Float32Array(n),
    hint: new Int32Array(n),
    pushInv: new Int32Array(n),
    ownedCount: 0,
    visible: 0,
    visibleCont: 0,
  };
  setPlateRotation(p, q);
  return p;
}

/** Lowest free slot index, or -1 when every slot is taken. */
export function freeSlotIndex(state: SimState): number {
  for (let k = 0; k < MAX_PLATES; k++) if (!state.slots[k]) return k;
  return -1;
}

export function installSlot(state: SimState, p: PlateSlot): void {
  if (state.slots[p.slot]) throw new Error(`installSlot: slot ${p.slot} is in use`);
  // Plate creation re-labels world cells wholesale: the next settle scans everything.
  markAllDirty(state);
  state.slots[p.slot] = p;
  state.liveMask = (state.liveMask | slotBit(p.slot)) >>> 0;
}

/** Remove a plate: clears its bits everywhere, frees its arrays and resets pair bookkeeping. */
export function freePlateSlot(state: SimState, k: number): void {
  const bit = slotBit(k);
  const keep = ~bit >>> 0;
  const { loser, presenceCur, presencePrev, top, topPrev, n } = state;
  for (let i = 0; i < n; i++) {
    if (loser[i] & bit) loser[i] &= keep;
    if (presenceCur[i] & bit) presenceCur[i] &= keep;
    if (presencePrev[i] & bit) presencePrev[i] &= keep;
    if (top[i] === k) throw new Error(`freePlateSlot: plate slot ${k} is still on top at cell ${i}`);
    if (topPrev[i] === k) topPrev[i] = -1;
  }
  state.slots[k] = null;
  state.liveMask = (state.liveMask & keep) >>> 0;
  markAllDirty(state);
  const { pairs } = state;
  for (let o = 0; o < MAX_PLATES; o++) {
    if (o === k) continue;
    const pi = pairIndex(k, o);
    pairs.shortening[pi] = 0;
    pairs.contacts[pi] = 0;
    pairs.vconvSum[pi] = 0;
    pairs.sinceContact[pi] = 0;
    pairs.slowTime[pi] = 0;
    state.flipClock[k * MAX_PLATES + o] = 0;
    state.flipClock[o * MAX_PLATES + k] = 0;
  }
  state.rankOrder = state.rankOrder.filter((s) => s !== k);
  refreshRankPositions(state);
}

export function refreshRankPositions(state: SimState): void {
  state.rankPos.fill(-1);
  state.rankOrder.forEach((s, idx) => {
    state.rankPos[s] = idx;
  });
}

function validateDraft(mesh: SphereMesh, draft: WorldDraft): void {
  const n = mesh.n;
  if (draft.n !== n) throw new Error(`TectonicSim: draft.n (${draft.n}) != mesh.n (${n})`);
  const np = draft.plates.length;
  if (np < 1 || np > MAX_PLATES) throw new Error(`TectonicSim: draft must have 1..${MAX_PLATES} plates (got ${np})`);
  for (const [name, arr] of [['plate', draft.plate], ['crust', draft.crust], ['elev', draft.elev], ['age', draft.age]] as const) {
    if (arr.length !== n) throw new Error(`TectonicSim: draft.${name} has length ${arr.length}, expected ${n}`);
  }
  if (draft.orogeny && draft.orogeny.length !== n) throw new Error('TectonicSim: draft.orogeny has the wrong length');
  if (!Number.isFinite(draft.time)) throw new Error(`TectonicSim: draft.time must be finite (got ${draft.time})`);
  const si = draft.stepIndex;
  if (si != null && !(Number.isInteger(si) && si >= 0)) throw new Error(`TectonicSim: draft.stepIndex must be a non-negative integer (got ${si})`);
  for (const h of draft.hotspots) {
    if (![...h.pos, h.strength, h.radius].every(Number.isFinite) || Math.hypot(h.pos[0], h.pos[1], h.pos[2]) === 0) {
      throw new Error('TectonicSim: hotspots need a finite non-zero position, strength and radius');
    }
  }
  const ids = new Set<number>();
  for (const p of draft.plates) {
    if (ids.has(p.id)) throw new Error(`TectonicSim: duplicate plate id ${p.id}`);
    ids.add(p.id);
    if (!p.omega.every(Number.isFinite)) throw new Error(`TectonicSim: plate ${p.id} has a non-finite omega`);
    if (p.frame && !(p.frame.every(Number.isFinite) && Math.hypot(...p.frame) > 0)) {
      throw new Error(`TectonicSim: plate ${p.id} has an invalid frame`);
    }
  }
  for (let i = 0; i < n; i++) {
    const k = draft.plate[i];
    if (!(k >= 0 && k < np)) throw new Error(`TectonicSim: draft.plate[${i}] = ${k} is out of range`);
    const c = draft.crust[i];
    if (c !== CRUST_OCEANIC && c !== CRUST_CONTINENTAL) throw new Error(`TectonicSim: draft.crust[${i}] = ${c} is invalid`);
    if (!Number.isFinite(draft.elev[i]) || !Number.isFinite(draft.age[i])) {
      throw new Error(`TectonicSim: draft has a non-finite elevation/age at cell ${i}`);
    }
    if (draft.orogeny && !Number.isFinite(draft.orogeny[i])) throw new Error(`TectonicSim: non-finite orogeny at cell ${i}`);
  }
}

/** Build the simulation state from a world-frame draft: plate k owns exactly its draft cells, q = identity. */
export function createSimState(mesh: SphereMesh, draft: WorldDraft, params: TectonicParams): SimState {
  validateDraft(mesh, draft);
  const sm = simMeshOf(mesh);
  const n = mesh.n;
  const np = draft.plates.length;
  const state: SimState = {
    sm,
    n,
    params,
    initialPlateCount: np,
    slots: new Array<PlateSlot | null>(MAX_PLATES).fill(null),
    liveMask: 0,
    top: new Int16Array(n),
    topPrev: new Int16Array(n),
    src: new Int32Array(n),
    loser: new Uint32Array(n),
    presenceCur: new Uint32Array(n),
    presencePrev: new Uint32Array(n),
    gaps: new Int32Array(n),
    gapCount: 0,
    collisionBudget: new Float32Array(n),
    budgetCells: new Int32Array(n),
    budgetCount: 0,
    wElev: new Float32Array(n),
    wCrust: new Uint8Array(n),
    trench: new Float32Array(n),
    rankOrder: [],
    rankPos: new Int32Array(MAX_PLATES).fill(-1),
    flipClock: new Float64Array(MAX_PLATES * MAX_PLATES),
    pairs: {
      shortening: new Float64Array(MAX_PLATES * MAX_PLATES),
      contacts: new Int32Array(MAX_PLATES * MAX_PLATES),
      vconvSum: new Float64Array(MAX_PLATES * MAX_PLATES),
      sinceContact: new Float64Array(MAX_PLATES * MAX_PLATES),
      slowTime: new Float64Array(MAX_PLATES * MAX_PLATES),
      contactPoint: new Float64Array(3 * MAX_PLATES * MAX_PLATES),
    },
    hotspots: draft.hotspots.map((h) => ({ pos: [h.pos[0], h.pos[1], h.pos[2]], strength: h.strength, radius: h.radius })),
    time: draft.time,
    stepIndex: draft.stepIndex ?? 0,
    nextPlateId: Math.max(draft.nextPlateId ?? 1, ...draft.plates.map((p) => p.id + 1)),
    counters: {
      continentalCreated: 0, continentalDestroyed: 0, subductedCells: 0, ridgeCells: 0, rifts: 0, merges: 0,
      arcConversions: 0, continentalClones: 0, collisionConsumed: 0, subductionInitiations: 0,
      tectonicErosion: 0, erodedContinental: 0, basinClosures: 0, speckClosures: 0, marginAccretions: 0, terranes: 0,
    },
    substepSerial: 0,
    lastSlabPullTime: draft.time,
    polarityClock: 0,
    sediment: 0,
    marginClock: 0,
    warnedSubstepCap: false,
  };
  for (let k = 0; k < np; k++) installSlot(state, createPlateSlot(k, n, clonePlateSpec(draft.plates[k]), quatIdentity()));
  const orogeny = draft.orogeny;
  const toExt = sm.toExt;
  for (let i = 0; i < n; i++) {
    // Sim arrays use the internal (renumbered) cell order; the draft is in the caller's order.
    const e = toExt[i];
    const k = draft.plate[e];
    const p = state.slots[k] as PlateSlot;
    markOwned(p, i);
    p.crust[i] = draft.crust[e];
    p.elev[i] = draft.elev[e];
    p.age[i] = draft.age[e];
    p.orogeny[i] = orogeny ? orogeny[e] : 0;
    p.ownedCount++;
    state.top[i] = k;
    state.topPrev[i] = k;
    state.src[i] = i;
    // Seed the push data as if each plate had just pushed its (identity-mapped) cells.
    state.presenceCur[i] = slotBit(k);
  }
  for (let k = 0; k < np; k++) {
    const p = state.slots[k] as PlateSlot;
    for (let i = 0; i < n; i++) {
      p.hint[i] = i;
      p.pushInv[i] = i;
    }
  }
  return state;
}
