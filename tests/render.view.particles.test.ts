import { describe, expect, it } from 'vitest';
import type { VectorFieldSpec } from '../src/core/types';
import { ParticleSystem, particleRamp, PARTICLE_STYLES } from '../src/render/particles';
import { GlobeParticles } from '../src/render/particlesGlobe';

function zonalField(w: number, h: number, kind: VectorFieldSpec['kind'] = 'wind'): VectorFieldSpec {
  const u = new Float32Array(w * h), v = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
    for (let c = 0; c < w; c++) {
      u[r * w + c] = kind === 'wind' ? 8 * Math.cos(3 * lat) + 2 : 0.6 * Math.cos(lat);
      v[r * w + c] = kind === 'wind' ? 2 * Math.sin(2 * lat) : 0.1;
    }
  }
  return { kind, w, h, u, v };
}

function checkFinite(ps: ParticleSystem): void {
  let nonFinite = 0, offSphere = 0;
  for (let i = 0; i < ps.count; i++) {
    const o = 3 * i;
    const x = ps.pos[o], y = ps.pos[o + 1], z = ps.pos[o + 2];
    if (!Number.isFinite(x + y + z)) nonFinite++;
    else if (ps.alive[i] && Math.abs(Math.hypot(x, y, z) - 1) >= 1e-5) offSphere++;
  }
  expect(nonFinite).toBe(0);
  expect(offSphere).toBe(0);
}

describe('ParticleSystem', () => {
  it('is deterministic for a seed and stays finite on the unit sphere', () => {
    const f = zonalField(90, 45);
    const a = new ParticleSystem(f, { count: 2000, seed: 7 });
    const b = new ParticleSystem(f, { count: 2000, seed: 7 });
    for (let k = 0; k < 300; k++) {
      a.step(1 / 60);
      b.step(1 / 60);
    }
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    checkFinite(a);
    let alive = 0;
    for (let i = 0; i < a.count; i++) alive += a.alive[i];
    expect(alive).toBe(a.count);
  });

  it('spawns area-uniformly', () => {
    const f = zonalField(90, 45);
    const ps = new ParticleSystem({ ...f, u: new Float32Array(90 * 45).fill(5), v: new Float32Array(90 * 45) }, { count: 20000, seed: 3 });
    let band = 0, meanZ = 0;
    for (let i = 0; i < ps.count; i++) {
      const z = ps.pos[3 * i + 2];
      meanZ += z / ps.count;
      if (Math.abs(z) < 0.5) band++;
    }
    // |z| < 0.5 (|lat| < 30°) covers exactly half of the sphere's area.
    expect(band / ps.count).toBeGreaterThan(0.48);
    expect(band / ps.count).toBeLessThan(0.52);
    expect(Math.abs(meanZ)).toBeLessThan(0.02);
  });

  it('never lives on NaN (land) cells or blocked locations for currents', () => {
    const w = 120, h = 60;
    const f = zonalField(w, h, 'current');
    // Land: a continent between lon −60°..+20° and every cell north of 50°N.
    const isLand = (lat: number, lon: number): boolean => (lon > -Math.PI / 3 && lon < Math.PI / 9) || lat > (50 * Math.PI) / 180;
    for (let r = 0; r < h; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
      for (let c = 0; c < w; c++) {
        const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / w;
        if (isLand(lat, lon)) {
          f.u[r * w + c] = NaN;
          f.v[r * w + c] = NaN;
        }
      }
    }
    const blocked = (x: number, y: number, z: number): boolean => isLand(Math.asin(z), Math.atan2(y, x));
    const ps = new ParticleSystem(f, { count: 3000, seed: 11, blocked });
    let onLand = 0, checked = 0;
    for (let k = 0; k < 400; k++) {
      ps.step(1 / 30);
      for (let i = 0; i < ps.count; i++) {
        if (!ps.alive[i]) continue;
        const o = 3 * i;
        checked++;
        if (blocked(ps.pos[o], ps.pos[o + 1], ps.pos[o + 2])) onLand++;
      }
    }
    expect(onLand).toBe(0);
    expect(checked).toBeGreaterThan(0.9 * 400 * 3000);
    checkFinite(ps);
  });

  it('flags respawns so no segment is drawn from the old location', () => {
    const f = zonalField(60, 30);
    const ps = new ParticleSystem(f, { count: 500, seed: 5 });
    let respawns = 0, joined = 0, maxMove = 0;
    for (let k = 0; k < 600; k++) {
      ps.step(1 / 60);
      for (let i = 0; i < ps.count; i++) {
        const o = 3 * i;
        if (ps.respawned[i]) {
          respawns++;
          if (ps.prev[o] !== ps.pos[o] || ps.prev[o + 1] !== ps.pos[o + 1] || ps.prev[o + 2] !== ps.pos[o + 2]) joined++;
        } else {
          // Normal steps move less than the clamp.
          maxMove = Math.max(maxMove, Math.hypot(ps.pos[o] - ps.prev[o], ps.pos[o + 1] - ps.prev[o + 1], ps.pos[o + 2] - ps.prev[o + 2]));
        }
      }
    }
    expect(joined).toBe(0);
    expect(maxMove).toBeLessThan(0.031);
    // Lifetimes of 1.6–4.5 s over 10 s: every particle respawned at least once on average.
    expect(respawns).toBeGreaterThan(ps.count);
  });

  it('survives an all-calm field (nothing to show) without NaN', () => {
    const f = zonalField(36, 18);
    f.u.fill(0);
    f.v.fill(0);
    const ps = new ParticleSystem(f, { count: 100, seed: 1 });
    for (let k = 0; k < 10; k++) ps.step(1 / 60);
    for (let i = 0; i < ps.count; i++) expect(ps.alive[i]).toBe(0);
    checkFinite(ps);
  });

  it('an empty field (all land / calm) costs a trickle of spawn attempts, and recovers on setField', () => {
    const w = 72, h = 36;
    const empty: VectorFieldSpec = { kind: 'current', w, h, u: new Float32Array(w * h).fill(NaN), v: new Float32Array(w * h).fill(NaN) };
    let calls = 0;
    const ps = new ParticleSystem(empty, { count: 2000, seed: 4, blocked: () => (calls++, false) });
    calls = 0;
    for (let k = 0; k < 30; k++) ps.step(1 / 60);
    // Without a back-off every hidden particle would retry 24 locations per step (1.44M calls).
    expect(calls).toBeLessThan(0.1 * 2000 * 24 * 30);
    for (let i = 0; i < ps.count; i++) expect(ps.alive[i]).toBe(0);
    // A usable field brings every particle back on the next step.
    ps.setField(zonalField(w, h, 'current'));
    ps.step(1 / 60);
    let alive = 0;
    for (let i = 0; i < ps.count; i++) alive += ps.alive[i];
    expect(alive).toBe(ps.count);
    checkFinite(ps);
  });

  it('non-finite field values never poison positions', () => {
    const f = zonalField(60, 30);
    for (let i = 0; i < f.u.length; i += 7) f.u[i] = Infinity;
    for (let i = 3; i < f.v.length; i += 11) f.v[i] = -Infinity;
    const ps = new ParticleSystem(f, { count: 1000, seed: 8 });
    let bad = 0;
    for (let k = 0; k < 120; k++) {
      ps.step(1 / 60);
      for (let i = 0; i < ps.count; i++) if (!Number.isFinite(ps.speed[i])) bad++;
    }
    expect(bad).toBe(0);
    checkFinite(ps);
  });

  it('keeps latitude in a solid-body zonal rotation', () => {
    const w = 90, h = 45;
    const u = new Float32Array(w * h), v = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
      for (let c = 0; c < w; c++) u[r * w + c] = 15 * Math.cos(lat);
    }
    const ps = new ParticleSystem({ kind: 'wind', w, h, u, v }, { count: 400, seed: 9 });
    const z0 = Float32Array.from({ length: ps.count }, (_, i) => ps.pos[3 * i + 2]);
    const born = new Uint8Array(ps.count);
    for (let k = 0; k < 60; k++) {
      ps.step(1 / 60);
      for (let i = 0; i < ps.count; i++) if (ps.respawned[i]) born[i] = 1;
    }
    let checked = 0;
    for (let i = 0; i < ps.count; i++) {
      if (born[i]) continue;
      expect(Math.abs(ps.pos[3 * i + 2] - z0[i])).toBeLessThan(2e-3);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('color ramp is clamped and monotone in brightness at the low end', () => {
    expect(particleRamp(-1)).toEqual(particleRamp(0));
    expect(particleRamp(2)).toEqual(particleRamp(1));
    const a = particleRamp(0), b = particleRamp(0.5);
    expect(b[0] + b[1] + b[2]).toBeGreaterThan(a[0] + a[1] + a[2]);
    expect(PARTICLE_STYLES.current.displayFactor).toBeGreaterThan(PARTICLE_STYLES.wind.displayFactor);
  });
});

describe('GlobeParticles trails', () => {
  const toWorld = (x: number, y: number, z: number, out: Float32Array, o: number): void => {
    out[o] = x;
    out[o + 1] = z;
    out[o + 2] = -y;
  };

  /** Longest chord among segments that are at least partly visible (alpha > 0 at either end). */
  function longestVisible(gp: GlobeParticles, now: number): number {
    const g = gp.lines.geometry;
    const P = g.getAttribute('position').array as Float32Array;
    const T = g.getAttribute('aTime').array as Float32Array;
    const trail = gp.lines.material.uniforms.uTrail.value as number;
    let longest = 0;
    for (let v = 0; v < T.length; v += 2) {
      if (now - T[v] >= trail && now - T[v + 1] >= trail) continue;
      longest = Math.max(longest, Math.hypot(P[3 * v] - P[3 * v + 3], P[3 * v + 1] - P[3 * v + 4], P[3 * v + 2] - P[3 * v + 5]));
    }
    return longest;
  }

  it('segments stay short, including right after a reset to another particle system', () => {
    const gp = new GlobeParticles();
    let now = 0;
    let ps = new ParticleSystem(zonalField(90, 45), { count: 600, seed: 1 });
    for (let k = 0; k < 60; k++) {
      now += 1 / 60;
      ps.step(1 / 60);
      gp.update(ps, now, toWorld);
      expect(longestVisible(gp, now)).toBeLessThan(0.1);
    }
    // Kind switch: the view builds a new system and resets the trails. Stale buffer positions must
    // not be joined to the new ones (that drew streaks across the planet).
    ps = new ParticleSystem(zonalField(90, 45, 'current'), { count: 600, seed: 2 });
    gp.reset();
    for (let k = 0; k < 30; k++) {
      now += 1 / 60;
      ps.step(1 / 60);
      gp.update(ps, now, toWorld);
      expect(longestVisible(gp, now)).toBeLessThan(0.1);
    }
    gp.dispose();
  });
});
