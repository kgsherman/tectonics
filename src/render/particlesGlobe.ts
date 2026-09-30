/**
 * Globe particle trails as LineSegments with a ring buffer of history segments.
 *
 * Layout: SLOTS × count × 2 vertices, slot-major. The current slot holds, for every particle, the
 * segment from its last committed point to its live position (the head vertex is rewritten every
 * frame); every COMMIT_INTERVAL seconds the ring advances and the oldest slot is reused. Each vertex
 * stores the time it was written, so the shader fades trails by age with no per-frame rewrite of
 * old slots: only the current slot's vertex range is uploaded each frame.
 */
import { BufferAttribute, BufferGeometry, LineSegments, ShaderMaterial, Vector3 } from 'three';
import { PARTICLE_RAMP, type ParticleSystem } from './particles';
import { PARTICLE_FRAGMENT, PARTICLE_VERTEX } from './shadersPrimitives';

const SLOTS = 10;
const COMMIT_INTERVAL = 1 / 12;
const NEVER = -1e9;

export class GlobeParticles {
  readonly lines: LineSegments<BufferGeometry, ShaderMaterial>;
  private count = 0;
  private positions = new Float32Array(0);
  private times = new Float32Array(0);
  private speeds = new Float32Array(0);
  private slot = 0;
  private lastCommit = 0;
  /** Next upload must send whole buffers (after reset/allocation). */
  private uploadAll = true;
  /**
   * Next update starts every trail afresh at the particle's current position. The buffers still hold
   * positions from before the reset (another system, another relief), so reusing the current slot's
   * tail vertex would draw a streak from the stale point to the new one.
   */
  private restart = true;

  constructor() {
    const material = new ShaderMaterial({
      uniforms: {
        uNow: { value: 0 },
        uTrail: { value: SLOTS * COMMIT_INTERVAL },
        uSpeedMax: { value: 20 },
        uOpacity: { value: 0.9 },
        uRamp: { value: PARTICLE_RAMP.map((c) => new Vector3(c[0], c[1], c[2])) },
      },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new LineSegments(new BufferGeometry(), material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    this.lines.visible = false;
  }

  /** (Re)allocates buffers for `count` particles; all history is cleared. */
  private allocate(count: number): void {
    const nv = SLOTS * count * 2;
    this.count = count;
    this.positions = new Float32Array(3 * nv);
    this.times = new Float32Array(nv).fill(NEVER);
    this.speeds = new Float32Array(nv);
    const g = this.lines.geometry;
    g.dispose();
    g.setAttribute('position', new BufferAttribute(this.positions, 3));
    g.setAttribute('aTime', new BufferAttribute(this.times, 1));
    g.setAttribute('aSpeed', new BufferAttribute(this.speeds, 1));
    g.setDrawRange(0, nv);
    this.slot = 0;
    this.uploadAll = true;
    this.restart = true;
  }

  /** Clears all trails (e.g. after the system or the relief changed). */
  reset(): void {
    this.times.fill(NEVER);
    this.uploadAll = true;
    this.restart = true;
  }

  setVisible(v: boolean): void {
    this.lines.visible = v;
  }

  /**
   * Writes the particles' new positions. `now` is seconds since start; `toWorld` writes the Three
   * world position (with radius) of geo unit vector (x, y, z) into out[o..o+2].
   */
  update(ps: ParticleSystem, now: number, toWorld: (x: number, y: number, z: number, out: Float32Array, o: number) => void): void {
    if (ps.count !== this.count) this.allocate(ps.count);
    const mat = this.lines.material;
    mat.uniforms.uNow.value = now;
    mat.uniforms.uSpeedMax.value = ps.style.colorMax;
    const n = this.count;
    const P = this.positions, Tm = this.times, S = this.speeds;
    let committed = false;
    const prevSlot = this.slot;
    if (now - this.lastCommit >= COMMIT_INTERVAL) {
      this.slot = (this.slot + 1) % SLOTS;
      this.lastCommit = now;
      committed = true;
    }
    const base = this.slot * n * 2;
    const prevBase = prevSlot * n * 2;
    const restart = this.restart;
    this.restart = false;
    for (let i = 0; i < n; i++) {
      const tail = base + 2 * i;
      const head = tail + 1;
      if (!ps.alive[i]) {
        Tm[tail] = Tm[head] = NEVER;
        continue;
      }
      const o = 3 * i;
      toWorld(ps.pos[o], ps.pos[o + 1], ps.pos[o + 2], P, 3 * head);
      Tm[head] = now;
      S[head] = ps.speed[i];
      if (restart || ps.respawned[i]) {
        // Break the trail: the new segment starts at the new position.
        P[3 * tail] = P[3 * head];
        P[3 * tail + 1] = P[3 * head + 1];
        P[3 * tail + 2] = P[3 * head + 2];
        Tm[tail] = now;
        S[tail] = S[head];
      } else if (committed) {
        // The new slot's segment starts where the previous slot's head ended.
        const ph = prevBase + 2 * i + 1;
        P[3 * tail] = P[3 * ph];
        P[3 * tail + 1] = P[3 * ph + 1];
        P[3 * tail + 2] = P[3 * ph + 2];
        Tm[tail] = Tm[ph];
        S[tail] = S[ph];
      }
    }
    const g = this.lines.geometry;
    const pos = g.getAttribute('position') as BufferAttribute;
    const tim = g.getAttribute('aTime') as BufferAttribute;
    const spd = g.getAttribute('aSpeed') as BufferAttribute;
    for (const [attr, size] of [[pos, 3], [tim, 1], [spd, 1]] as const) {
      attr.clearUpdateRanges();
      if (!this.uploadAll) attr.addUpdateRange(base * size, n * 2 * size);
      attr.needsUpdate = true;
    }
    this.uploadAll = false;
    this.lines.visible = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
  }
}
