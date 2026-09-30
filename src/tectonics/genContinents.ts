import { EARTH_RADIUS_KM } from '../core/constants';
import { cross3, normalize3, tangentBasis } from '../core/math3';
import { createNoise3, fbm3 } from '../core/noise';
import type { Rng } from '../core/rng';
import type { GenerateParams, SphereMesh, Vec3 } from '../core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import type { Components } from './genGraph';
import { labelComponents, multiSourceDijkstra } from './genGraph';

// Continental crust mask. A smooth "continentality" field (domain-warped elliptical blobs laid out per
// continentMode and grouped into masses, plus fbm coastline noise) is thresholded at the quantile that
// yields exactly the requested continental fraction; specks and small enclosed seas are then cleaned up
// and the threshold re-adjusted so the cleaned mask still matches the target.
//
// Blobs of one mass add up (lobed continents), but different masses combine as a union with a channel
// carved where two masses meet (strongest mass − CHANNEL × second strongest). A plain sum lets the
// tails of neighbouring masses add up into land bridges: 'scattered' then often collapsed into one or
// two continents and supercontinent fragments merged into the main mass.

type Mode = GenerateParams['continentMode'];

/** Flattened blob parameters (one entry per elliptical Gaussian blob). */
interface Blobs {
  count: number;
  /** Center (3), major axis (3), minor axis (3) per blob. */
  frame: Float64Array;
  /** 1/sin²(semi-axis) along major and minor axes. */
  invA2: Float64Array;
  invB2: Float64Array;
  /** Cosine of the cut-off angle (blob contributes nothing beyond it). */
  cosCut: Float64Array;
  /** Mass id per blob; the blobs of one mass are contiguous. */
  mass: Int32Array;
}

/** Channel strength between neighbouring masses (see header). */
const CHANNEL = 0.6;

interface ModeStyle {
  /** Domain-warp amplitude (unit-sphere units) and frequency. */
  warpAmp: number;
  warpFreq: number;
  /** Coastline fbm amplitude (relative to a blob peak of 1), frequency and octaves. */
  coastAmp: number;
  coastFreq: number;
  coastOctaves: number;
}

const STYLES: Record<Mode, ModeStyle> = {
  scattered: { warpAmp: 0.2, warpFreq: 1.6, coastAmp: 0.42, coastFreq: 2.6, coastOctaves: 5 },
  supercontinent: { warpAmp: 0.16, warpFreq: 1.4, coastAmp: 0.36, coastFreq: 2.4, coastOctaves: 5 },
  archipelago: { warpAmp: 0.24, warpFreq: 2.2, coastAmp: 0.62, coastFreq: 4.2, coastOctaves: 5 },
};

/** A continent-scale mass: center and target angular radius. */
interface Mass {
  center: Vec3;
  radius: number;
}

/** Angular radius (radians) of a spherical cap covering `areaFrac` of the sphere. */
function capRadius(areaFrac: number): number {
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * areaFrac)));
}

function angle(a: Vec3, b: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
}

/** Rotate unit vector p by `dist` radians along tangent heading `heading` (radians from local east). */
function moveAlong(p: Vec3, heading: number, dist: number): Vec3 {
  const { east, north } = tangentBasis(p);
  const dx = Math.cos(heading), dy = Math.sin(heading);
  const d: Vec3 = [east[0] * dx + north[0] * dy, east[1] * dx + north[1] * dy, east[2] * dx + north[2] * dy];
  const c = Math.cos(dist), s = Math.sin(dist);
  return normalize3([p[0] * c + d[0] * s, p[1] * c + d[1] * s, p[2] * c + d[2] * s]);
}

/** Best-candidate placement: maximize the gap angle(c, c_j) − (r + r_j) to already placed masses. */
function placeMasses(rng: Rng, radii: number[], candidates = 40): Mass[] {
  const out: Mass[] = [];
  for (const r of radii) {
    let best: Vec3 = rng.unitVector();
    let bestGap = -Infinity;
    for (let t = 0; t < candidates; t++) {
      const c = rng.unitVector();
      let gap = Infinity;
      for (const m of out) gap = Math.min(gap, angle(c, m.center) - (r + m.radius));
      if (gap > bestGap) { bestGap = gap; best = c; }
      if (out.length === 0) break;
    }
    out.push({ center: best, radius: r });
  }
  return out;
}

class BlobBuilder {
  private readonly list: number[][] = [];
  private massId = -1;

  /** Starts a new mass: blobs added from now on belong to it. */
  beginMass(): void {
    this.massId++;
  }

  /** Elliptical Gaussian blob at `center` with angular semi-axes a ≥ b, major axis at `heading`. */
  add(center: Vec3, a: number, b: number, heading: number): void {
    const { east, north } = tangentBasis(center);
    const ch = Math.cos(heading), sh = Math.sin(heading);
    const major: Vec3 = [east[0] * ch + north[0] * sh, east[1] * ch + north[1] * sh, east[2] * ch + north[2] * sh];
    const minor = normalize3(cross3(center, major));
    const sa = Math.sin(Math.min(1.4, a)), sb = Math.sin(Math.min(1.4, b));
    // exp(-r²) < 0.01 beyond r ≈ 2.15 semi-axes.
    const cut = Math.min(Math.PI * 0.49, 2.15 * Math.max(a, b));
    this.list.push([...center, ...major, ...minor, 1 / (sa * sa), 1 / (sb * sb), Math.cos(cut), Math.max(0, this.massId)]);
  }

  build(): Blobs {
    const count = this.list.length;
    const b: Blobs = {
      count,
      frame: new Float64Array(9 * count),
      invA2: new Float64Array(count),
      invB2: new Float64Array(count),
      cosCut: new Float64Array(count),
      mass: new Int32Array(count),
    };
    this.list.forEach((e, k) => {
      for (let q = 0; q < 9; q++) b.frame[9 * k + q] = e[q];
      b.invA2[k] = e[9];
      b.invB2[k] = e[10];
      b.cosCut[k] = e[11];
      b.mass[k] = e[12];
    });
    return b;
  }
}

/** Shape of a lobe chain: spacing between lobes (× lobe radius) and turning per lobe (radians). */
interface ChainStyle {
  step: [number, number];
  /** Mean turn per lobe; its sign is randomized per mass (constant sign ⇒ C-shaped arcs). */
  turn: number;
  /** Random turn jitter per lobe. */
  jitter: number;
}

const CHAIN_COMPACT: ChainStyle = { step: [1.0, 1.4], turn: 0, jitter: 0.55 };
const CHAIN_ARC: ChainStyle = { step: [1.15, 1.35], turn: 0.42, jitter: 0.18 };

/**
 * A mass made of `lobes` overlapping elliptical sub-blobs strung along a curving axis: elongated,
 * lobed continents (compact chains) or a Pangaea-like "C" wrapped around an embayment (arc chains).
 */
function addLobedMass(bb: BlobBuilder, rng: Rng, m: Mass, lobes: number, chain: ChainStyle = CHAIN_COMPACT): void {
  bb.beginMass();
  let heading = rng.float(0, 2 * Math.PI);
  if (lobes <= 1) {
    const aspect = rng.float(1.2, 2.2);
    bb.add(m.center, m.radius * Math.sqrt(aspect), m.radius / Math.sqrt(aspect), heading);
    return;
  }
  // Sub-blob radius such that `lobes` partially overlapping blobs cover roughly the mass area.
  const rs = m.radius / Math.sqrt(lobes * 0.7);
  const turn = chain.turn * (rng.bool() ? 1 : -1);
  const meanStep = 0.5 * (chain.step[0] + chain.step[1]) * rs;
  // Start about half a chain behind the centre, with the heading turned back by half the total turn,
  // so the (curved) chain is roughly centred on the mass centre.
  const halfTurn = 0.5 * turn * (lobes - 1);
  let p = moveAlong(m.center, heading + Math.PI + 0.5 * halfTurn, meanStep * 0.5 * (lobes - 1));
  heading -= halfTurn;
  for (let k = 0; k < lobes; k++) {
    const aspect = rng.float(1.0, 1.8);
    const r = rs * rng.float(0.75, 1.2);
    bb.add(p, r * Math.sqrt(aspect), r / Math.sqrt(aspect), heading + rng.float(-0.6, 0.6));
    heading += turn + rng.float(-chain.jitter, chain.jitter);
    p = moveAlong(p, heading, rs * rng.float(chain.step[0], chain.step[1]));
  }
}

/** Random partition of 1 into `k` shares with a heavy-ish tail (log-normal weights). */
function shares(rng: Rng, k: number, sigma: number): number[] {
  const w = Array.from({ length: k }, () => Math.exp(rng.normal(0, sigma)));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s).sort((a, b) => b - a);
}

function layoutBlobs(mode: Mode, fraction: number, rng: Rng): Blobs {
  const bb = new BlobBuilder();
  if (mode === 'scattered') {
    const k = rng.int(3, 8);
    const sh = shares(rng, k, 0.55);
    const masses = placeMasses(rng, sh.map((s) => capRadius(fraction * s)));
    masses.forEach((m, i) => addLobedMass(bb, rng, m, Math.max(1, Math.min(4, Math.round(1 + sh[i] * k * rng.float(0.8, 2.2))))));
  } else if (mode === 'supercontinent') {
    const mainShare = rng.float(0.78, 0.88);
    const frags = rng.int(2, 5);
    const fsh = shares(rng, frags, 0.5).map((s) => s * (1 - mainShare));
    const main: Mass = { center: rng.unitVector(), radius: capRadius(fraction * mainShare) };
    addLobedMass(bb, rng, main, rng.int(6, 9), CHAIN_ARC);
    // Fragments hug the main mass (microcontinents / terranes rifted off its margins).
    for (const s of fsh) {
      const r = capRadius(fraction * s);
      const c = moveAlong(main.center, rng.float(0, 2 * Math.PI), main.radius * rng.float(1.05, 1.6) + r);
      addLobedMass(bb, rng, { center: c, radius: r }, rng.int(1, 3));
    }
  } else {
    const k = rng.int(16, 34);
    const sh = shares(rng, k, 0.8);
    const masses = placeMasses(rng, sh.map((s) => capRadius(fraction * s)), 12);
    for (const m of masses) addLobedMass(bb, rng, m, rng.int(1, 3));
  }
  return bb.build();
}

/** Evaluate the continentality field per cell. */
function continentField(mesh: SphereMesh, blobs: Blobs, style: ModeStyle, noiseSeed: number): Float32Array {
  const { n, xyz } = mesh;
  const wx = createNoise3(noiseSeed + 11), wy = createNoise3(noiseSeed + 12), wz = createNoise3(noiseSeed + 13);
  const coast = createNoise3(noiseSeed + 14);
  const field = new Float32Array(n);
  const { frame, invA2, invB2, cosCut, mass, count } = blobs;
  const wf = style.warpFreq, cf = style.coastFreq;
  for (let i = 0; i < n; i++) {
    const x = xyz[3 * i], y = xyz[3 * i + 1], z = xyz[3 * i + 2];
    // Domain warp gives blobs organic outlines (bays, peninsulas) instead of ellipses.
    let qx = x + style.warpAmp * fbm3(wx, x * wf, y * wf, z * wf, 2);
    let qy = y + style.warpAmp * fbm3(wy, x * wf, y * wf, z * wf, 2);
    let qz = z + style.warpAmp * fbm3(wz, x * wf, y * wf, z * wf, 2);
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
    qx /= ql; qy /= ql; qz /= ql;
    // Strongest (m1) and second strongest (m2) mass: each mass sums its own blobs.
    let m1 = 0, m2 = 0, cur = 0, curMass = -1;
    for (let b = 0; b < count; b++) {
      if (mass[b] !== curMass) {
        if (cur > m1) { m2 = m1; m1 = cur; } else if (cur > m2) m2 = cur;
        cur = 0;
        curMass = mass[b];
      }
      const o = 9 * b;
      const c = frame[o] * qx + frame[o + 1] * qy + frame[o + 2] * qz;
      if (c < cosCut[b]) continue;
      const u = frame[o + 3] * qx + frame[o + 4] * qy + frame[o + 5] * qz;
      const v = frame[o + 6] * qx + frame[o + 7] * qy + frame[o + 8] * qz;
      cur += Math.exp(-(u * u * invA2[b] + v * v * invB2[b]));
    }
    if (cur > m1) { m2 = m1; m1 = cur; } else if (cur > m2) m2 = cur;
    let f = m1 - CHANNEL * m2;
    f += style.coastAmp * fbm3(coast, x * cf, y * cf, z * cf, style.coastOctaves);
    field[i] = f;
  }
  return field;
}

/** Threshold such that `count` cells have field ≥ threshold. */
function thresholdForCount(sorted: Float32Array, count: number): number {
  const n = sorted.length;
  if (count <= 0) return Infinity;
  if (count >= n) return -Infinity;
  return sorted[n - count];
}

/** Remove continental specks and fill small enclosed seas in place. */
function cleanMask(mesh: SphereMesh, crust: Uint8Array, minLand: number, minSea: number): void {
  const comps = labelComponents(mesh, crust);
  for (let i = 0; i < mesh.n; i++) {
    const c = comps.comp[i];
    const size = comps.size[c];
    if (crust[i] === CRUST_CONTINENTAL && size < minLand) crust[i] = CRUST_OCEANIC;
    else if (crust[i] === CRUST_OCEANIC && size < minSea) crust[i] = CRUST_CONTINENTAL;
  }
}

/**
 * Continental crust mask (CRUST_* per cell) covering `fraction` of the sphere (within ~0.2% after
 * cleanup), shaped per `mode`. Deterministic in (mesh.n, mode, fraction, rng state, noiseSeed).
 */
export function generateContinents(mesh: SphereMesh, mode: Mode, fraction: number, rng: Rng, noiseSeed: number): Uint8Array {
  const n = mesh.n;
  const crust = new Uint8Array(n).fill(CRUST_OCEANIC);
  const style = STYLES[mode];
  if (fraction <= 0) return crust;
  const blobs = layoutBlobs(mode, fraction, rng);
  const field = continentField(mesh, blobs, style, noiseSeed);
  const sorted = field.slice().sort();
  // Specks below ~10–15 cells at 100k (≈ 50–75 000 km²) are dropped; enclosed seas below ~50 cells
  // (≈ 250 000 km²) are filled.
  const minLand = Math.max(4, Math.round(n * (mode === 'archipelago' ? 1e-4 : 1.5e-4)));
  const minSea = Math.max(8, Math.round(n * 5e-4));
  const target = Math.round(fraction * n);
  let want = target;
  for (let iter = 0; iter < 4; iter++) {
    const thr = thresholdForCount(sorted, want);
    let count = 0;
    for (let i = 0; i < n; i++) {
      crust[i] = field[i] >= thr ? CRUST_CONTINENTAL : CRUST_OCEANIC;
    }
    cleanMask(mesh, crust, minLand, minSea);
    for (let i = 0; i < n; i++) count += crust[i];
    const err = target - count;
    if (Math.abs(err) <= Math.max(2, n * 0.002)) break;
    want += err;
  }
  return crust;
}

/**
 * Distance (km) from each cell with inside[i] = 1 to the nearest cell outside (0 outside; 20 000 if
 * there is no outside cell). Boundary cells sit half a spacing from the dividing line.
 */
function distanceToOutsideKm(mesh: SphereMesh, inside: Uint8Array): Float32Array {
  const n = mesh.n;
  const sources: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!inside[i]) continue;
    for (let e = mesh.adjOffset[i]; e < mesh.adjOffset[i + 1]; e++) {
      if (!inside[mesh.adj[e]]) {
        sources.push(i);
        break;
      }
    }
  }
  const out = new Float32Array(n);
  if (sources.length === 0) {
    for (let i = 0; i < n; i++) out[i] = inside[i] ? 20000 : 0;
    return out;
  }
  // Coast cells sit half a spacing from the shoreline.
  const half = 0.5 * mesh.spacing;
  const { dist } = multiSourceDijkstra(mesh, sources, sources.map(() => 0), { mask: inside, sourceDist: new Float32Array(sources.length).fill(half) });
  for (let i = 0; i < n; i++) out[i] = inside[i] ? (dist[i] < Infinity ? dist[i] * EARTH_RADIUS_KM : 20000) : 0;
  return out;
}

export interface ContinentInfo {
  /** 1 = continental crust. */
  mask: Uint8Array;
  /** Connected continents (comp = -1 on oceanic cells). */
  comps: Components;
  /** Distance (km) from each continental cell to the edge of continental crust (0 on oceanic cells). */
  coastKm: Float32Array;
  /** Distance (km) from each oceanic cell to the nearest continental crust (0 on continental cells). */
  oceanKm: Float32Array;
}

/** Continental components and coast distances, shared by the plate, motion and relief stages. */
export function analyzeContinents(mesh: SphereMesh, crust: Uint8Array): ContinentInfo {
  const mask = new Uint8Array(mesh.n);
  const ocean = new Uint8Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    mask[i] = crust[i] === CRUST_CONTINENTAL ? 1 : 0;
    ocean[i] = 1 - mask[i];
  }
  return {
    mask,
    comps: labelComponents(mesh, mask, mask),
    coastKm: distanceToOutsideKm(mesh, mask),
    oceanKm: distanceToOutsideKm(mesh, ocean),
  };
}
