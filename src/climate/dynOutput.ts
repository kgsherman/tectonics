/**
 * Core grid → output grid for the dynamics fields. Temperatures are interpolated separately from
 * land and ocean core cells (each extended across the coast by nearest fill) and chosen by the
 * output land mask, so 1° coastlines stay sharp; land temperatures are lapse-corrected to the
 * output cell's own height (1° lapse downscaling). Small islands unresolved on the core grid take
 * the maritime (ocean) temperature; lakes/inland seas unresolved as ocean take the land air.
 */
import { LAPSE_RATE, SECONDS_PER_DAY } from '../core/constants';
import type { LatLonGrid } from './dynGrid';
import { makeBilinearStencil } from './dynGrid';
import type { OutputSurface } from './dynInput';
import { fillFromNearest, nearestValidIndex } from './numerics';
import { ebmTuning } from './tuning';

/** Monthly core fields needed for the output (12·n each). */
export interface CoreMonthly {
  /** Sea-level-reduced air temperature (land) / sea-level air temperature (ocean), °C. */
  tAir: Float64Array;
  sst: Float64Array;
  ice: Float64Array;
  pressure: Float64Array;
  windU: Float64Array;
  windV: Float64Array;
  steerU: Float64Array;
  steerV: Float64Array;
  ascent: Float64Array;
  baroclinic: Float64Array;
  currentU: Float64Array;
  currentV: Float64Array;
  /** m/s. */
  upwelling: Float64Array;
}

export interface OutputFields {
  temp: Float32Array;
  sst: Float32Array;
  seaIce: Float32Array;
  pressure: Float32Array;
  windU: Float32Array;
  windV: Float32Array;
  steerU: Float32Array;
  steerV: Float32Array;
  ascent: Float32Array;
  baroclinic: Float32Array;
  currentU: Float32Array;
  currentV: Float32Array;
  /** m/day. */
  upwelling: Float32Array;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Month-independent interpolation weights per output cell: plain bilinear weights, weights
 * restricted to land / ocean core cells (renormalized; plain weights where none), and the blend
 * factors telling how well the land / ocean side is represented nearby.
 */
interface OutputWeights {
  idx: Int32Array;
  wt: Float32Array;
  wLand: Float32Array;
  wSea: Float32Array;
  bLand: Float32Array;
  bSea: Float32Array;
}

function outputWeights(g: LatLonGrid, coreLand: Uint8Array, out: OutputSurface, hasLand: boolean, hasSea: boolean): OutputWeights {
  const N = out.w * out.h;
  const S = makeBilinearStencil(g.nx, g.ny, out.w, out.h);
  const wLand = new Float32Array(4 * N);
  const wSea = new Float32Array(4 * N);
  const bLand = new Float32Array(N);
  const bSea = new Float32Array(N);
  for (let p = 0, k = 0; p < N; p++, k += 4) {
    let sL = 0;
    let sO = 0;
    for (let q = 0; q < 4; q++) {
      if (coreLand[S.idx[k + q]]) sL += S.wt[k + q];
      else sO += S.wt[k + q];
    }
    for (let q = 0; q < 4; q++) {
      const land = coreLand[S.idx[k + q]] === 1;
      wLand[k + q] = sL > 0 ? (land ? S.wt[k + q] / sL : 0) : S.wt[k + q];
      wSea[k + q] = sO > 0 ? (land ? 0 : S.wt[k + q] / sO) : S.wt[k + q];
    }
    bLand[p] = hasLand ? smoothstep(0, 0.3, sL) : 0;
    bSea[p] = hasSea ? smoothstep(0, 0.3, sO) : 0;
  }
  return { idx: S.idx, wt: S.wt, wLand, wSea, bLand, bSea };
}

function dot4(f: Float64Array, o: number, i0: number, i1: number, i2: number, i3: number, w0: number, w1: number, w2: number, w3: number): number {
  return w0 * f[o + i0] + w1 * f[o + i1] + w2 * f[o + i2] + w3 * f[o + i3];
}

/** Interpolate all monthly core fields onto the output surface. */
export function assembleOutput(g: LatLonGrid, coreLand: Uint8Array, core: CoreMonthly, out: OutputSurface, tempOffset: number): OutputFields {
  const Tf = ebmTuning.freezeT;
  const { w, h } = out;
  const N = w * h;
  const n = g.n;
  const f32 = (): Float32Array => new Float32Array(12 * N);
  const o: OutputFields = {
    temp: f32(), sst: f32(), seaIce: f32(), pressure: f32(), windU: f32(), windV: f32(), steerU: f32(), steerV: f32(),
    ascent: f32(), baroclinic: f32(), currentU: f32(), currentV: f32(), upwelling: f32(),
  };
  const isOcean = new Uint8Array(n);
  for (let i = 0; i < n; i++) isOcean[i] = coreLand[i] ? 0 : 1;
  const nearLand = nearestValidIndex(g.nx, g.ny, coreLand);
  const nearSea = nearestValidIndex(g.nx, g.ny, isOcean);
  const hasLand = nearLand[0] >= 0;
  const hasSea = nearSea[0] >= 0;
  const W = outputWeights(g, coreLand, out, hasLand, hasSea);
  const { idx, wt, wLand, wSea, bLand, bSea } = W;
  // Extended (across the coast) land and ocean fields of one month.
  const tL = new Float64Array(n);
  const tO = new Float64Array(n);
  const sstE = new Float64Array(n);
  const iceE = new Float64Array(n);
  const oceanOnly = (src: Float64Array, off: number, dst: Float64Array): void => {
    for (let i = 0; i < n; i++) dst[i] = isOcean[i] ? src[off + i] : 0;
  };
  const cu = new Float64Array(n), cv = new Float64Array(n), up = new Float64Array(n);
  for (let m = 0; m < 12; m++) {
    const cOff = m * n;
    for (let i = 0; i < n; i++) {
      tL[i] = core.tAir[cOff + i];
      tO[i] = core.tAir[cOff + i];
      sstE[i] = core.sst[cOff + i];
      iceE[i] = core.ice[cOff + i];
    }
    if (hasLand) fillFromNearest(tL, 0, nearLand);
    if (hasSea) {
      fillFromNearest(tO, 0, nearSea);
      fillFromNearest(sstE, 0, nearSea);
      fillFromNearest(iceE, 0, nearSea);
    }
    oceanOnly(core.currentU, cOff, cu);
    oceanOnly(core.currentV, cOff, cv);
    oceanOnly(core.upwelling, cOff, up);
    const oOff = m * N;
    for (let p = 0, k = 0; p < N; p++, k += 4) {
      const i0 = idx[k], i1 = idx[k + 1], i2 = idx[k + 2], i3 = idx[k + 3];
      const w0 = wt[k], w1 = wt[k + 1], w2 = wt[k + 2], w3 = wt[k + 3];
      const l0 = wLand[k], l1 = wLand[k + 1], l2 = wLand[k + 2], l3 = wLand[k + 3];
      const s0 = wSea[k], s1 = wSea[k + 1], s2 = wSea[k + 2], s3 = wSea[k + 3];
      const q = oOff + p;
      o.pressure[q] = dot4(core.pressure, cOff, i0, i1, i2, i3, w0, w1, w2, w3);
      o.windU[q] = dot4(core.windU, cOff, i0, i1, i2, i3, w0, w1, w2, w3);
      o.windV[q] = dot4(core.windV, cOff, i0, i1, i2, i3, w0, w1, w2, w3);
      o.steerU[q] = dot4(core.steerU, cOff, i0, i1, i2, i3, w0, w1, w2, w3);
      o.steerV[q] = dot4(core.steerV, cOff, i0, i1, i2, i3, w0, w1, w2, w3);
      o.ascent[q] = dot4(core.ascent, cOff, i0, i1, i2, i3, w0, w1, w2, w3);
      o.baroclinic[q] = dot4(core.baroclinic, cOff, i0, i1, i2, i3, w0, w1, w2, w3);
      const landT = l0 * tL[i0] + l1 * tL[i1] + l2 * tL[i2] + l3 * tL[i3];
      const oceanT = s0 * tO[i0] + s1 * tO[i1] + s2 * tO[i2] + s3 * tO[i3];
      const sstO = s0 * sstE[i0] + s1 * sstE[i1] + s2 * sstE[i2] + s3 * sstE[i3];
      const iceO = s0 * iceE[i0] + s1 * iceE[i1] + s2 * iceE[i2] + s3 * iceE[i3];
      let temp: number;
      let sst: number;
      let ice: number;
      if (out.land[p]) {
        const b = bLand[p];
        temp = b * landT + (1 - b) * (hasSea ? oceanT : landT) - LAPSE_RATE * out.surfaceHeight[p];
        o.currentU[q] = 0;
        o.currentV[q] = 0;
        o.upwelling[q] = 0;
        sst = hasSea ? sstO : Math.max(Tf, temp);
        ice = hasSea ? iceO : 0;
      } else {
        const b = bSea[p];
        temp = b * oceanT + (1 - b) * (hasLand ? landT : oceanT);
        o.currentU[q] = b * (s0 * cu[i0] + s1 * cu[i1] + s2 * cu[i2] + s3 * cu[i3]);
        o.currentV[q] = b * (s0 * cv[i0] + s1 * cv[i1] + s2 * cv[i2] + s3 * cv[i3]);
        o.upwelling[q] = b * (s0 * up[i0] + s1 * up[i1] + s2 * up[i2] + s3 * up[i3]) * SECONDS_PER_DAY;
        // Inland seas / lakes unresolved on the core grid follow the local air.
        const localIce = temp < Tf - 2 ? Math.min(1, (Tf - 2 - temp) / 8) : 0;
        sst = b * sstO + (1 - b) * Math.max(Tf, temp);
        ice = b * iceO + (1 - b) * localIce;
      }
      o.temp[q] = temp + tempOffset;
      o.sst[q] = Math.max(Tf, sst + tempOffset);
      o.seaIce[q] = Math.min(1, Math.max(0, ice));
    }
  }
  return o;
}
