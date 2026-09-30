/**
 * Flow particles advected on the unit sphere (pure, DOM-free; shared by the globe and the map).
 *
 * Particles spawn area-uniformly, live for a randomized lifetime and respawn when they die, leave
 * the field (NaN), hit a blocked location (e.g. land for ocean currents) or stall (low speed).
 * Positions are geo unit vectors (z = north). `prev` holds the position before the last step and
 * `respawned[i] = 1` flags particles whose prev→pos segment must not be drawn.
 */
import { Rng } from '../core/rng';
import type { VectorFieldSpec } from '../core/types';
import { advectOnSphere, VectorFieldSampler } from './viewField';

export type ParticleKind = VectorFieldSpec['kind'];

export interface ParticleKindStyle {
  /** Display speed: radians of arc per second per (m/s). */
  displayFactor: number;
  /** Below this speed (m/s) a particle respawns. */
  minSpeed: number;
  /** Speed (m/s) mapped to the top of the color ramp. */
  colorMax: number;
  /** Lifetime range, seconds. */
  lifeMin: number;
  lifeMax: number;
}

/** Per-kind display tuning (wind ~10 m/s, currents ~0.5 m/s travel at similar screen speeds). */
export const PARTICLE_STYLES: Record<ParticleKind, ParticleKindStyle> = {
  wind: { displayFactor: 0.012, minSpeed: 0.4, colorMax: 22, lifeMin: 1.6, lifeMax: 4.5 },
  current: { displayFactor: 0.2, minSpeed: 0.02, colorMax: 1.2, lifeMin: 2.0, lifeMax: 5.5 },
};

export const DEFAULT_PARTICLE_COUNT = 8000;
/** Largest arc (radians) a particle may travel in one step (keeps trails well-formed). */
const MAX_STEP = 0.03;
const SPAWN_TRIES = 24;
/**
 * A particle that found no valid spawn location waits this long (s, randomized) before retrying, so
 * an empty field (all land for currents, dead calm) costs a trickle of samples instead of
 * count × SPAWN_TRIES every frame.
 */
const RETRY_MIN = 0.3;
const RETRY_MAX = 1.2;

/**
 * Private copy of a vector field. Views keep the field across frames, while the contract lets the
 * caller reuse or transfer its buffers after the setter returns.
 */
export function copyVectorField(f: VectorFieldSpec): VectorFieldSpec {
  const n = f.w * f.h;
  if (!(f.w > 0 && f.h > 0) || f.u.length < n || f.v.length < n) throw new Error(`copyVectorField: arrays do not match ${f.w}x${f.h}`);
  return { kind: f.kind, w: f.w, h: f.h, u: f.u.slice(0, n), v: f.v.slice(0, n) };
}

export interface ParticleSystemOptions {
  count?: number;
  seed?: number;
  /** Returns true where particles may not exist (e.g. land for currents); receives a geo unit vector. */
  blocked?: (x: number, y: number, z: number) => boolean;
}

export class ParticleSystem {
  readonly count: number;
  readonly kind: ParticleKind;
  readonly style: ParticleKindStyle;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  /** Speed (m/s) at `pos`. */
  readonly speed: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  /** 1 = (re)spawned during the last step (no segment from prev). */
  readonly respawned: Uint8Array;
  /** 0 = no valid spawn location found yet (not drawn). */
  readonly alive: Uint8Array;
  private sampler: VectorFieldSampler;
  private field: VectorFieldSpec;
  private blocked: ((x: number, y: number, z: number) => boolean) | undefined;
  private readonly rng: Rng;
  private readonly vel = new Float64Array(3);

  constructor(field: VectorFieldSpec, opts: ParticleSystemOptions = {}) {
    const n = Math.max(1, Math.floor(opts.count ?? DEFAULT_PARTICLE_COUNT));
    this.count = n;
    this.kind = field.kind;
    this.style = PARTICLE_STYLES[field.kind];
    this.sampler = new VectorFieldSampler(field);
    this.field = field;
    this.blocked = opts.blocked;
    this.rng = new Rng(opts.seed ?? 12345);
    this.pos = new Float32Array(3 * n);
    this.prev = new Float32Array(3 * n);
    this.speed = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n);
    this.respawned = new Uint8Array(n);
    this.alive = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.spawn(i);
      // Stagger initial ages so respawns do not happen in waves.
      this.age[i] = this.rng.next() * this.life[i];
    }
  }

  /** Swaps the field (e.g. month change) keeping particles; invalid ones respawn on the next step. */
  setField(field: VectorFieldSpec): void {
    if (field.kind !== this.kind) throw new Error('ParticleSystem.setField: kind changed; create a new system');
    this.sampler = new VectorFieldSampler(field);
    this.field = field;
    // Particles waiting out a failed spawn retry on the next step (the new field may have room).
    for (let i = 0; i < this.count; i++) if (this.alive[i] === 0) this.age[i] = this.life[i];
  }

  /** The field currently advecting the particles. */
  get fieldSpec(): VectorFieldSpec {
    return this.field;
  }

  setBlocked(blocked: ((x: number, y: number, z: number) => boolean) | undefined): void {
    this.blocked = blocked;
  }

  /**
   * Advances every particle by dt seconds. `speedScale` multiplies the display speed (views use it
   * to keep on-screen speed roughly constant across zoom levels).
   */
  step(dt: number, speedScale = 1): void {
    const { pos, prev, speed, age, life, respawned, alive, vel } = this;
    const kDt = this.style.displayFactor * speedScale * Math.max(0, dt);
    const minSpeed = this.style.minSpeed;
    for (let i = 0; i < this.count; i++) {
      const o = 3 * i;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      respawned[i] = 0;
      age[i] += dt;
      if (alive[i] === 0) {
        // Hidden after a failed spawn: retry once the back-off (stored in life) has elapsed.
        if (age[i] >= life[i]) this.spawn(i);
        continue;
      }
      if (age[i] > life[i]) {
        this.spawn(i);
        continue;
      }
      if (!this.sampler.sample(pos[o], pos[o + 1], pos[o + 2], vel)) {
        this.spawn(i);
        continue;
      }
      const s = Math.hypot(vel[0], vel[1], vel[2]);
      // Also rejects NaN / Infinity (a non-finite field value would otherwise poison the position).
      if (!(s >= minSpeed && s < Infinity)) {
        this.spawn(i);
        continue;
      }
      advectOnSphere(pos, o, vel, kDt, MAX_STEP);
      if (this.blocked && this.blocked(pos[o], pos[o + 1], pos[o + 2])) {
        this.spawn(i);
        continue;
      }
      speed[i] = s;
    }
  }

  /** Places particle i at a random valid location (area-uniform rejection sampling). */
  private spawn(i: number): void {
    const o = 3 * i;
    const { rng, vel } = this;
    this.respawned[i] = 1;
    this.age[i] = 0;
    this.life[i] = this.style.lifeMin + rng.next() * (this.style.lifeMax - this.style.lifeMin);
    for (let tries = 0; tries < SPAWN_TRIES; tries++) {
      const z = 2 * rng.next() - 1;
      const phi = 2 * Math.PI * rng.next();
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const x = r * Math.cos(phi), y = r * Math.sin(phi);
      if (this.blocked && this.blocked(x, y, z)) continue;
      if (!this.sampler.sample(x, y, z, vel)) continue;
      const s = Math.hypot(vel[0], vel[1], vel[2]);
      if (!(s >= this.style.minSpeed && s < Infinity)) continue;
      this.pos[o] = x;
      this.pos[o + 1] = y;
      this.pos[o + 2] = z;
      this.prev[o] = x;
      this.prev[o + 1] = y;
      this.prev[o + 2] = z;
      this.speed[i] = s;
      this.alive[i] = 1;
      return;
    }
    // No valid spot found (e.g. a nearly empty field): stay hidden and retry after a short back-off.
    this.alive[i] = 0;
    this.speed[i] = 0;
    this.life[i] = RETRY_MIN + rng.next() * (RETRY_MAX - RETRY_MIN);
  }
}

/**
 * Particle color ramp over normalized speed t ∈ [0, 1] (sRGB 0..1): slate blue → cyan → white →
 * warm yellow → orange. The globe uploads the same stops to its line shader.
 */
export function particleRamp(t: number, out: number[] = [0, 0, 0]): number[] {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const stops = PARTICLE_RAMP;
  const f = x * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(f));
  const a = stops[k], b = stops[k + 1], u = f - k;
  out[0] = a[0] + (b[0] - a[0]) * u;
  out[1] = a[1] + (b[1] - a[1]) * u;
  out[2] = a[2] + (b[2] - a[2]) * u;
  return out;
}

/** Ramp stops (sRGB 0..1). */
export const PARTICLE_RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [0.55, 0.68, 0.85],
  [0.62, 0.88, 0.95],
  [0.97, 0.98, 1.0],
  [1.0, 0.9, 0.55],
  [1.0, 0.62, 0.35],
];
