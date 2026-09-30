import { Rng } from '../core/rng';
import type { SphereMesh, TectonicParams, TectonicStats, Vec3, WorldDraft, WorldSnapshot } from '../core/types';
import { clampSpeeds, plateDynamics } from './simDynamics';
import { computeFields, trenchField } from './simFields';
import { buildWorldFields, detectFronts } from './simFronts';
import { housekeeping } from './simHousekeeping';
import { maybeInitiateSubduction } from './simInitiation';
import { runSubstep, settleTops, substepCount } from './simKinematics';
import { initPolarity, updatePolarity } from './simPolarity';
import { maybeRift } from './simRifting';
import { buildDraft, buildSnapshot, buildStats } from './simSnapshot';
import { createSimState, type SimState } from './simState';
import { computeDiffusion, gatherFields, surfaceProcesses } from './simSurface';

export const DEFAULT_TECTONIC_PARAMS: TectonicParams = {
  dt: 1,
  maxPlates: 24,
  riftRate: 1.5,
  mergePlates: true,
  subductionUplift: 1,
  collisionUplift: 1,
  erosion: 1,
  hotspotActivity: 1,
  speedScale: 1,
  seed: 1,
};

/** Module counter: every sim instance (and every out-of-band state edit) gets a fresh id. */
let instanceCounter = 0;
function nextInstanceId(): number {
  instanceCounter++;
  return instanceCounter;
}

const now = (): number => globalThis.performance?.now?.() ?? Date.now();

/** Drop `undefined` entries of a partial parameter object (so they do not override defaults). */
function definedOnly(p: Partial<TectonicParams> | undefined): Partial<TectonicParams> {
  const out: Partial<TectonicParams> = {};
  if (!p) return out;
  for (const [k, v] of Object.entries(p)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function validateParams(p: TectonicParams): void {
  if (!(Number.isFinite(p.dt) && p.dt > 0)) throw new Error(`TectonicSim: dt must be > 0 (got ${p.dt})`);
  for (const key of ['maxPlates', 'riftRate', 'subductionUplift', 'collisionUplift', 'erosion', 'hotspotActivity', 'speedScale', 'seed'] as const) {
    if (!Number.isFinite(p[key])) throw new Error(`TectonicSim: ${key} must be finite (got ${p[key]})`);
  }
  if (p.riftRate < 0 || p.erosion < 0 || p.hotspotActivity < 0 || p.subductionUplift < 0 || p.collisionUplift < 0) {
    throw new Error('TectonicSim: rates and multipliers must be ≥ 0');
  }
}

/**
 * Plate-tectonics simulation on a SphereMesh (see SPEC.md §4).
 * Pure computation: no DOM, runs in a Web Worker and in Node.
 */
export class TectonicSim {
  readonly mesh: SphereMesh;
  private readonly state: SimState;
  private instanceId: number;
  private memo: WorldSnapshot | null = null;
  private lastStepMs = 0;

  /** Builds per-plate frames from a world-frame draft (all plate rotations start at identity). Does not retain `draft`. */
  constructor(mesh: SphereMesh, draft: WorldDraft, params?: Partial<TectonicParams>) {
    this.mesh = mesh;
    const p: TectonicParams = { ...DEFAULT_TECTONIC_PARAMS, seed: draft.seed, ...definedOnly(params) };
    validateParams(p);
    this.state = createSimState(mesh, draft, p);
    this.instanceId = nextInstanceId();
    buildWorldFields(this.state);
    initPolarity(this.state);
    // Trenches are transient display offsets: derive them for the initial state too.
    trenchField(this.state, detectFronts(this.state));
  }

  /** A copy: edits go through `setParams` / the setter so they are validated. */
  get params(): TectonicParams {
    return { ...this.state.params };
  }

  set params(p: TectonicParams) {
    const next = { ...p };
    validateParams(next);
    this.state.params = next;
  }

  /** Current simulation time, Myr. */
  get time(): number {
    return this.state.time;
  }

  /** Advance `steps` steps of params.dt Myr each. */
  step(steps = 1): void {
    if (!Number.isInteger(steps) || steps < 0) throw new Error(`TectonicSim.step: steps must be a non-negative integer (got ${steps})`);
    for (let s = 0; s < steps; s++) this.stepOnce();
  }

  /**
   * World-frame state. Memoized per step: returns the same object until the state changes. Arrays
   * are owned by the sim's cache — structured-clone (never transfer) them to another thread.
   */
  snapshot(): WorldSnapshot {
    if (!this.memo) this.memo = buildSnapshot(this.state, this.instanceId * 2 ** 20 + (this.state.stepIndex % 2 ** 20));
    return this.memo;
  }

  /** World-frame editable draft of the current state (for the plate editor / save). */
  toDraft(): WorldDraft {
    return buildDraft(this.state);
  }

  /** Merge a partial update (entries that are `undefined` keep their current value). */
  setParams(params: Partial<TectonicParams>): void {
    this.params = { ...this.state.params, ...definedOnly(params) };
  }

  /** Change one plate's angular velocity (world frame, rad/Myr). No-op if the id is unknown. */
  setPlateOmega(plateId: number, omega: Vec3): void {
    if (!omega.every(Number.isFinite)) throw new Error('TectonicSim.setPlateOmega: omega must be finite');
    const p = this.state.slots.find((s) => s !== null && s.spec.id === plateId);
    if (!p) return;
    p.spec.omega = [omega[0], omega[1], omega[2]];
    // Boundaries and plate infos change: new identity for caches keyed on snapshot ids.
    this.instanceId = nextInstanceId();
    this.memo = null;
  }

  stats(): TectonicStats {
    return buildStats(this.state, this.lastStepMs);
  }

  private stepOnce(): void {
    const t0 = now();
    const state = this.state;
    const dt = state.params.dt;
    const rng = new Rng(state.params.seed).fork(state.stepIndex);
    for (let q = 0; q < state.budgetCount; q++) state.collisionBudget[state.budgetCells[q]] = 0;
    state.budgetCount = 0;

    // A–D per substep. Motions set since the last step (draft, setPlateOmega) obey the speed cap
    // before they move anything (H clamps again after this step's dynamics).
    clampSpeeds(state);
    const { count, capped } = substepCount(state, dt);
    if (capped && !state.warnedSubstepCap) {
      state.warnedSubstepCap = true;
      console.warn(`TectonicSim: plates move more than ${count} substeps allow; displacement per substep exceeds one cell`);
    }
    for (let s = 0; s < count; s++) runSubstep(state, dt / count);

    // E–J once per step.
    buildWorldFields(state);
    const sc = detectFronts(state);
    computeFields(state, sc, dt);
    updatePolarity(state, dt);
    computeDiffusion(state, sc, dt);
    gatherFields(state, sc);
    surfaceProcesses(state, dt);
    plateDynamics(state, sc, dt);
    // At most one plate-creating event per step (both read this step's world fields).
    if (!maybeRift(state, rng, dt)) maybeInitiateSubduction(state, rng, dt);
    housekeeping(state);
    settleTops(state);
    state.time += dt;
    state.stepIndex++;
    this.memo = null;
    this.lastStepMs = now() - t0;
  }
}
