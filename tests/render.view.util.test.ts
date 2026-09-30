import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, SphereGeometry, Vector3 } from 'three';
import { DEG } from '../src/core/constants';
import { Rng } from '../src/core/rng';
import type { Vec3 } from '../src/core/types';
import {
  advectOnSphere, arrowCenterline, arrowDims, arrowFrame, arrowPoint, clientToNdc, facesCamera, geoDistance, geoToPixel,
  geoToSphereUv, geoToTex, geoToThree, lonDelta, ndcToClient, pickDisplacedSphere, projectWorld, raySphere,
  rayFromNdc, reliefDisplacement, smallCircle, sphereUvToGeo, texToGeo, threeToGeo, threeToVec, unwrapLonNear,
  vecToThree, VectorFieldSampler, wrapLon, PLANET_RADIUS_M,
} from '../src/render/viewUtil';

/** Seeded randomness keeps the sampled cases identical on every run. */
const rng = new Rng(20260930);
const random = (): number => rng.next();

const close = (a: number, b: number, eps = 1e-9): void => {
  expect(Math.abs(a - b)).toBeLessThan(eps);
};

/** Camera at geo (lat, lon) and distance `dist`, looking at the planet center, north up. */
function cameraAt(lat: number, lon: number, dist: number, aspect = 1.5): PerspectiveCamera {
  const cam = new PerspectiveCamera(35, aspect, 0.01, 100);
  const p = geoToThree(lat, lon, dist);
  cam.position.set(p[0], p[1], p[2]);
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return cam;
}

function viewProj(cam: PerspectiveCamera): { vp: Float64Array; inv: Float64Array } {
  const m = new Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const inv = m.clone().invert();
  return { vp: Float64Array.from(m.elements), inv: Float64Array.from(inv.elements) };
}

describe('longitude wrap', () => {
  it('wrapLon maps into (−π, π]', () => {
    close(wrapLon(Math.PI), Math.PI);
    close(wrapLon(-Math.PI), Math.PI);
    close(wrapLon(3 * Math.PI + 0.1), -Math.PI + 0.1, 1e-12);
    close(wrapLon(-0.3 - 4 * Math.PI), -0.3, 1e-12);
    for (let i = 0; i < 200; i++) {
      const l = (i - 100) * 0.37;
      const w = wrapLon(l);
      expect(w).toBeGreaterThan(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      close(Math.cos(w), Math.cos(l), 1e-9);
      close(Math.sin(w), Math.sin(l), 1e-9);
    }
  });

  it('unwrapLonNear / lonDelta pick the short way across the antimeridian', () => {
    close(unwrapLonNear(-170 * DEG, 175 * DEG), 190 * DEG, 1e-12);
    close(unwrapLonNear(170 * DEG, -175 * DEG), -190 * DEG, 1e-12);
    close(lonDelta(170 * DEG, -170 * DEG), 20 * DEG, 1e-12);
    close(lonDelta(-170 * DEG, 170 * DEG), -20 * DEG, 1e-12);
  });
});

describe('geo ↔ texture ↔ sphere UV ↔ Three', () => {
  it('north pole is Three +Y and lon +90° on the equator is Three −Z', () => {
    const np = geoToThree(Math.PI / 2, 1.234);
    close(np[0], 0, 1e-12);
    close(np[1], 1, 1e-12);
    close(np[2], 0, 1e-12);
    const e90 = geoToThree(0, Math.PI / 2);
    close(e90[0], 0, 1e-12);
    close(e90[1], 0, 1e-12);
    close(e90[2], -1, 1e-12);
    // Texture: north edge is t = 0 (row 0), lon +90° is 3/4 of the way across.
    const tex = geoToTex(0, Math.PI / 2);
    close(tex.s, 0.75, 1e-12);
    close(tex.t, 0.5, 1e-12);
    close(geoToTex(Math.PI / 2, 0).t, 0, 1e-12);
  });

  it('round trips random points', () => {
    for (let i = 0; i < 500; i++) {
      const lat = (random() - 0.5) * Math.PI * 0.999;
      const lon = wrapLon((random() - 0.5) * 2 * Math.PI);
      const p = geoToThree(lat, lon);
      const g = threeToGeo(p[0], p[1], p[2]);
      close(g.lat, lat, 1e-9);
      close(lonDelta(g.lon, lon), 0, 1e-9);
      const { s, t } = geoToTex(lat, lon);
      const g2 = texToGeo(s, t);
      close(g2.lat, lat, 1e-9);
      close(lonDelta(g2.lon, lon), 0, 1e-9);
      const uv = geoToSphereUv(lat, lon);
      const g3 = sphereUvToGeo(uv.u, uv.v);
      close(g3.lat, lat, 1e-9);
      close(lonDelta(g3.lon, lon), 0, 1e-9);
      // geo vector ↔ Three axes is a proper rotation.
      const v: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      const T = vecToThree(v[0], v[1], v[2]);
      close(T[0], p[0], 1e-12);
      close(T[1], p[1], 1e-12);
      close(T[2], p[2], 1e-12);
      const back = threeToVec(T[0], T[1], T[2]);
      close(back[0], v[0], 1e-12);
      close(back[1], v[1], 1e-12);
      close(back[2], v[2], 1e-12);
    }
  });

  it('matches Three.js SphereGeometry vertex positions and uvs', () => {
    const g = new SphereGeometry(1, 64, 32);
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      const geo = sphereUvToGeo(uv.getX(i), uv.getY(i));
      const expected = geoToThree(geo.lat, geo.lon);
      close(pos.getY(i), expected[1], 1e-6);
      if (Math.abs(pos.getY(i)) < 0.9999) {
        close(pos.getX(i), expected[0], 1e-6);
        close(pos.getZ(i), expected[2], 1e-6);
      }
    }
    g.dispose();
  });

  it('pixel mapping puts row 0 at the north and col 0 at lon −π', () => {
    const w = 360, h = 180;
    const a = geoToPixel(w, h, Math.PI / 2 - (0.5 * Math.PI) / h, -Math.PI + (0.5 * 2 * Math.PI) / w);
    close(a.row, 0, 1e-9);
    close(a.col, 0, 1e-9);
    const b = geoToPixel(w, h, 0, Math.PI / 2);
    close(b.col, 0.75 * w - 0.5, 1e-9);
  });
});

describe('screen projection and picking', () => {
  const rect = { left: 10, top: 20, width: 900, height: 600 };

  it('client ↔ NDC round trip', () => {
    for (const [x, y] of [[10, 20], [910, 620], [400, 333]]) {
      const [nx, ny] = clientToNdc(x, y, rect);
      const [cx, cy] = ndcToClient(nx, ny, rect);
      close(cx, x, 1e-9);
      close(cy, y, 1e-9);
    }
    const [nx, ny] = clientToNdc(10, 20, rect);
    close(nx, -1, 1e-12);
    close(ny, 1, 1e-12);
  });

  it('projects with north up and east to the right (not mirrored)', () => {
    const cam = cameraAt(0, Math.PI / 2, 3, rect.width / rect.height);
    const { vp } = viewProj(cam);
    const c = geoToThree(0, Math.PI / 2);
    const center = projectWorld(vp, c[0], c[1], c[2]);
    close(center[0], 0, 1e-9);
    close(center[1], 0, 1e-9);
    const n = geoToThree(20 * DEG, Math.PI / 2);
    expect(projectWorld(vp, n[0], n[1], n[2])[1]).toBeGreaterThan(0.1);
    const e = geoToThree(0, 110 * DEG);
    expect(projectWorld(vp, e[0], e[1], e[2])[0]).toBeGreaterThan(0.1);
    // Three's own Vector3.project agrees.
    const v = new Vector3(e[0], e[1], e[2]).project(cam);
    close(v.x, projectWorld(vp, e[0], e[1], e[2])[0], 1e-6);
  });

  it('north-pole and lon +90° markers land on screen where the globe shows them (SPEC §2)', () => {
    // Default-style view: camera over 20°N, 0°E, north up.
    const cam = cameraAt(20 * DEG, 0, 4, rect.width / rect.height);
    const { vp } = viewProj(cam);
    const camPos: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
    const np = geoToThree(Math.PI / 2, 0);
    const pn = projectWorld(vp, np[0], np[1], np[2]);
    close(pn[0], 0, 1e-9); // on the central meridian
    expect(pn[1]).toBeGreaterThan(0.3); // above the center
    expect(facesCamera(np, 1, camPos)).toBe(true);
    // lon +90° on the equator sits on the right limb side, lon −90° on the left.
    const e = geoToThree(0, 80 * DEG), w = geoToThree(0, -80 * DEG);
    expect(projectWorld(vp, e[0], e[1], e[2])[0]).toBeGreaterThan(0.2);
    expect(projectWorld(vp, w[0], w[1], w[2])[0]).toBeLessThan(-0.2);
    // Camera over 0°, 90°E: that marker is dead center and the south pole below it.
    const cam90 = cameraAt(0, 90 * DEG, 4, rect.width / rect.height);
    const vp90 = viewProj(cam90).vp;
    const m = geoToThree(0, 90 * DEG);
    const pm = projectWorld(vp90, m[0], m[1], m[2]);
    close(pm[0], 0, 1e-9);
    close(pm[1], 0, 1e-9);
    const sp = geoToThree(-80 * DEG, 90 * DEG);
    expect(projectWorld(vp90, sp[0], sp[1], sp[2])[1]).toBeLessThan(-0.2);
  });

  it('pick(project(p)) = p on the visible hemisphere, flat and displaced', () => {
    const cam = cameraAt(25 * DEG, -60 * DEG, 2.6, rect.width / rect.height);
    const { vp, inv } = viewProj(cam);
    const camPos: Vec3 = [cam.position.x, cam.position.y, cam.position.z];
    const bump = (x: number, y: number, z: number): number => 0.01 * (1 + Math.sin(7 * x) * Math.cos(5 * z) * 0.5 + 0 * y);
    for (const disp of [(): number => 0, bump]) {
      const maxDisp = disp === bump ? 0.015 : 0;
      let tested = 0;
      for (let i = 0; i < 200; i++) {
        const lat = (25 + (random() - 0.5) * 80) * DEG;
        const lon = (-60 + (random() - 0.5) * 80) * DEG;
        const n = geoToThree(lat, lon);
        const r = 1 + disp(n[0], n[1], n[2]);
        if (!facesCamera(n, r, camPos)) continue;
        const p = projectWorld(vp, n[0] * r, n[1] * r, n[2] * r);
        const [cx, cy] = ndcToClient(p[0], p[1], rect);
        const [nx, ny] = clientToNdc(cx, cy, rect);
        const ray = rayFromNdc(inv, nx, ny);
        const hit = pickDisplacedSphere(ray.origin, ray.dir, disp, maxDisp, 12);
        expect(hit).not.toBeNull();
        const g = threeToGeo(hit![0], hit![1], hit![2]);
        expect(geoDistance(g, { lat, lon })).toBeLessThan(disp === bump ? 2e-4 : 1e-7);
        tested++;
      }
      expect(tested).toBeGreaterThan(100);
    }
  });

  it('displaced pick: constant displacement hits the larger sphere; misses return null', () => {
    const o: Vec3 = [0, 0, 5];
    const d: Vec3 = [0, 0, -1];
    const hit = pickDisplacedSphere(o, d, () => 0.05, 0.05, 3);
    expect(hit).not.toBeNull();
    close(hit![2], 1, 1e-12);
    close(raySphere(o, d, 1.05), 5 - 1.05, 1e-12);
    // A ray passing between the unit sphere and the relief envelope, over flat terrain: no hit.
    const graze: Vec3 = [0, 1.01, 5];
    expect(pickDisplacedSphere(graze, d, () => 0, 0.05, 3)).toBeNull();
    // ...but over a high plateau it hits the relief.
    const onRelief = pickDisplacedSphere(graze, d, () => 0.04, 0.05, 6);
    expect(onRelief).not.toBeNull();
    expect(pickDisplacedSphere([0, 3, 5], d, () => 0, 0.05, 3)).toBeNull();
  });

  it('few iterations converge on realistic relief (≤ 1/10 of a 2048-px texel)', () => {
    const cam = cameraAt(10 * DEG, 30 * DEG, 1.6);
    const { inv } = viewProj(cam);
    const exag = 12;
    const hField = (x: number, y: number, z: number): number => 3000 + 2500 * Math.sin(20 * x) * Math.cos(17 * y + z);
    const disp = (x: number, y: number, z: number): number => reliefDisplacement(hField(x, y, z), 0, exag);
    const maxDisp = reliefDisplacement(5500, 0, exag);
    for (const [nx, ny] of [[0, 0], [0.3, -0.2], [-0.5, 0.4]]) {
      const ray = rayFromNdc(inv, nx, ny);
      const p3 = pickDisplacedSphere(ray.origin, ray.dir, disp, maxDisp, 3)!;
      const p30 = pickDisplacedSphere(ray.origin, ray.dir, disp, maxDisp, 30)!;
      const ang = Math.acos(Math.min(1, p3[0] * p30[0] + p3[1] * p30[1] + p3[2] * p30[2]));
      expect(ang).toBeLessThan((2 * Math.PI) / 2048 / 10);
    }
    close(reliefDisplacement(-500, 0, exag), 0);
    close(reliefDisplacement(1000, 0, 1), 1000 / PLANET_RADIUS_M, 1e-15);
  });
});

describe('arrow geometry', () => {
  it('eastward arrow crossing the antimeridian ends at the right longitude', () => {
    const f = arrowFrame({ lat: 0, lon: 170 * DEG, east: 1, north: 0, length: 20 * DEG, color: [255, 0, 0] })!;
    const tip = arrowPoint(f, f.length, 0);
    const g = threeToGeo(...vecToThree(tip[0], tip[1], tip[2]));
    close(g.lat, 0, 1e-9);
    close(g.lon, -170 * DEG, 1e-9);
    // Left of an eastward arrow is north.
    const left = arrowPoint(f, 0.5 * f.length, 0.01);
    expect(left[2]).toBeGreaterThan(0);
    close(Math.hypot(left[0], left[1], left[2]), 1, 1e-12);
  });

  it('northward arrow over the pole continues down the opposite meridian', () => {
    const f = arrowFrame({ lat: 80 * DEG, lon: 30 * DEG, east: 0, north: 2, length: 20 * DEG, color: [0, 0, 0] })!;
    const tip = arrowPoint(f, f.length, 0);
    const lat = Math.asin(tip[2]);
    const lon = Math.atan2(tip[1], tip[0]);
    close(lat, 80 * DEG, 1e-9);
    close(Math.abs(lonDelta(lon, 30 * DEG)), Math.PI, 1e-9);
  });

  it('centerline samples are on the sphere at uniform arc spacing, lateral offsets are exact', () => {
    const f = arrowFrame({ lat: -35 * DEG, lon: -100 * DEG, east: 0.6, north: -0.8, length: 0.4, color: [0, 0, 0] })!;
    const n = 16;
    const pts = arrowCenterline(f, n);
    for (let i = 0; i <= n; i++) {
      close(Math.hypot(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]), 1, 1e-12);
      const d = Math.acos(Math.min(1, pts[3 * i] * f.tail[0] + pts[3 * i + 1] * f.tail[1] + pts[3 * i + 2] * f.tail[2]));
      close(d, (i / n) * 0.4, 1e-7);
    }
    const c = arrowPoint(f, 0.2, 0);
    const l = arrowPoint(f, 0.2, 0.03);
    close(Math.acos(c[0] * l[0] + c[1] * l[1] + c[2] * l[2]), 0.03, 1e-7);
  });

  it('dims: head never exceeds 45% of the length and min width applies', () => {
    for (const L of [0.01, 0.05, 0.2, 1]) {
      const d = arrowDims(L);
      expect(d.headLength).toBeLessThanOrEqual(0.45 * L + 1e-15);
      expect(d.headHalfWidth).toBeGreaterThan(d.shaftHalfWidth);
    }
    expect(arrowDims(0.01, 0.004).shaftHalfWidth).toBe(0.004);
    expect(arrowFrame({ lat: 0, lon: 0, east: 0, north: 0, length: 1, color: [0, 0, 0] })).toBeNull();
    expect(arrowFrame({ lat: 0, lon: 0, east: 1, north: 0, length: 0, color: [0, 0, 0] })).toBeNull();
  });
});

describe('vector field sampling & advection', () => {
  const w = 72, h = 36;
  const uniform = (u0: number, v0: number) => ({ w, h, u: new Float32Array(w * h).fill(u0), v: new Float32Array(w * h).fill(v0) });

  it('uniform eastward flow samples as ~u·east away from the poles', () => {
    const s = new VectorFieldSampler(uniform(10, 0));
    const out = new Float64Array(3);
    for (let i = 0; i < 200; i++) {
      const lat = (random() - 0.5) * 140 * DEG;
      const lon = (random() - 0.5) * 2 * Math.PI;
      const p: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      expect(s.sample(p[0], p[1], p[2], out)).toBe(true);
      const east: Vec3 = [-Math.sin(lon), Math.cos(lon), 0];
      const along = out[0] * east[0] + out[1] * east[1] + out[2] * east[2];
      expect(along).toBeGreaterThan(9.9);
      expect(along).toBeLessThanOrEqual(10 + 1e-9);
      close(out[0] * p[0] + out[1] * p[1] + out[2] * p[2], 0, 1e-9);
    }
  });

  it('is continuous across the pole and the antimeridian', () => {
    // Solid-body rotation about the x axis: the flow crosses both poles.
    const u = new Float32Array(w * h), v = new Float32Array(w * h);
    for (let r = 0; r < h; r++) {
      const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / h;
      for (let c = 0; c < w; c++) {
        const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / w;
        const p: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
        const vel: Vec3 = [0, -p[2], p[1]]; // x̂ × p
        u[r * w + c] = 10 * (vel[0] * -Math.sin(lon) + vel[1] * Math.cos(lon));
        v[r * w + c] = 10 * (vel[0] * -Math.sin(lat) * Math.cos(lon) + vel[1] * -Math.sin(lat) * Math.sin(lon) + vel[2] * Math.cos(lat));
      }
    }
    const s = new VectorFieldSampler({ w, h, u, v });
    const a = new Float64Array(3), b = new Float64Array(3);
    const walk = (fn: (t: number) => Vec3): number => {
      let maxJump = 0;
      let p = fn(0);
      s.sample(p[0], p[1], p[2], a);
      for (let k = 1; k <= 400; k++) {
        p = fn(k / 400);
        expect(s.sample(p[0], p[1], p[2], b)).toBe(true);
        maxJump = Math.max(maxJump, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
        a.set(b);
      }
      return maxJump;
    };
    // Along the great circle x = 0 through both poles.
    const jumpPole = walk((t) => [0, Math.cos(t * 2 * Math.PI), Math.sin(t * 2 * Math.PI)]);
    // Along the equator through the antimeridian.
    const jumpEq = walk((t) => [Math.cos(Math.PI - 0.3 + 0.6 * t), Math.sin(Math.PI - 0.3 + 0.6 * t), 0]);
    expect(jumpPole).toBeLessThan(1.5);
    expect(jumpEq).toBeLessThan(0.5);
    // Advect a particle across the north pole: it stays on its circle |p·x̂| = const.
    const p = new Float64Array([0.3, 0, Math.sqrt(1 - 0.09)]);
    const vel = new Float64Array(3);
    for (let k = 0; k < 2000; k++) {
      expect(s.sample(p[0], p[1], p[2], vel)).toBe(true);
      advectOnSphere(p, 0, vel, 0.0005, 0.02);
      close(Math.hypot(p[0], p[1], p[2]), 1, 1e-12);
      expect(Number.isFinite(p[0] + p[1] + p[2])).toBe(true);
    }
    expect(Math.abs(p[0] - 0.3)).toBeLessThan(0.02);
  });

  it('reports NaN corners as invalid', () => {
    const f = uniform(1, 1);
    f.u[10 * w + 20] = NaN;
    const s = new VectorFieldSampler(f);
    const out = new Float64Array(3);
    const lat = Math.PI / 2 - ((10 + 0.5) * Math.PI) / h;
    const lon = -Math.PI + ((20 + 0.5) * 2 * Math.PI) / w;
    const p = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    expect(s.sample(p[0], p[1], p[2], out)).toBe(false);
    expect(s.sample(1, 0, 0, out)).toBe(true);
    expect(() => new VectorFieldSampler({ w, h, u: new Float32Array(3), v: new Float32Array(3) })).toThrow();
  });

  it('advection step: eastward motion at the equator and step clamping', () => {
    const p = new Float64Array([1, 0, 0]);
    const moved = advectOnSphere(p, 0, [0, 10, 0], 0.001, 1);
    close(moved, 0.01, 1e-12);
    close(Math.atan2(p[1], p[0]), Math.atan(0.01), 1e-12);
    const q = new Float64Array([1, 0, 0]);
    close(advectOnSphere(q, 0, [0, 1000, 0], 1, 0.02), 0.02, 1e-12);
    close(Math.hypot(q[0], q[1], q[2]), 1, 1e-12);
  });
});

describe('small circle (map brush)', () => {
  it('stays at the given distance and spans 2π when enclosing a pole', () => {
    const c = { lat: 40 * DEG, lon: 175 * DEG };
    const sc = smallCircle(c, 0.2, 64);
    for (let i = 0; i <= 64; i++) close(geoDistance(c, { lat: sc.lat[i], lon: sc.lon[i] }), 0.2, 1e-9);
    // Continuous lon (no ±2π jumps) even across the antimeridian.
    for (let i = 1; i <= 64; i++) expect(Math.abs(sc.lon[i] - sc.lon[i - 1])).toBeLessThan(0.1);
    const polar = smallCircle({ lat: 85 * DEG, lon: 0 }, 10 * DEG, 128);
    close(Math.abs(polar.lon[128] - polar.lon[0]), 2 * Math.PI, 1e-9);
  });

  it('centred exactly on a pole: a latitude circle sweeping all longitudes', () => {
    for (const plat of [Math.PI / 2, -Math.PI / 2]) {
      const sc = smallCircle({ lat: plat, lon: 1 }, 0.3, 64);
      close(Math.abs(sc.lon[64] - sc.lon[0]), 2 * Math.PI, 1e-6);
      for (let i = 0; i <= 64; i++) close(Math.abs(sc.lat[i]), Math.PI / 2 - 0.3, 1e-6);
    }
  });
});
