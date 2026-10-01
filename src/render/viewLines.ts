/**
 * CPU reference model of the magnified overlay-line reconstruction (GLSL_OVERLAY_LINES in
 * shadersCommon.ts): the same math in plain TypeScript, so the ridge detection, its gates and the
 * constant-screen-width compositing can be unit-tested and tuned on synthetic rasters (pure, DOM-free).
 * Keep the two in sync: the tests evaluate this model and pin the shader's constants.
 */

/** Line half width and halo (CSS px), halo opacity and colour (sRGB / 255): mirrors the GLSL constants. */
export const LINE_HALF_PX = 0.8;
export const COAST_HALF_PX = 0.62;
export const HALO_PX = 1.4;
export const HALO_ALPHA = 0.32;
export const HALO_RGB: readonly [number, number, number] = [0.035, 0.04, 0.055];

/** Premultiplied RGBA raster with channels in 0..1 (row 0 = north, longitude wraps). */
export interface LineRaster {
  w: number;
  h: number;
  /** 4·w·h premultiplied values in 0..1. */
  data: Float32Array;
}

export interface OverlayRidge {
  /** Screen px to the nearest line centre (1e6 when none). */
  dist: number;
  /** Opacity of that line (0 when none). */
  alpha: number;
  /** Painted opacity around the point (soft maximum of the stencil). */
  peak: number;
  /** Smoothed coverage at the point. */
  cover: number;
  /** Straight colour of the line core (0..1). */
  col: [number, number, number];
  /** Offset (overlay texels) from the point to the line centre. */
  off: [number, number];
  /** Diagnostics: coverage at the centre and principal curvatures, relative to the peak. */
  arRel: number;
  l1Rel: number;
  l2Rel: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Cubic B-spline weights, first and second derivatives at t ∈ [0, 1). */
export function bsplineWeights(t: number): { w: number[]; d: number[]; d2: number[] } {
  const t2 = t * t, t3 = t2 * t, s = 1 - t;
  return {
    w: [(s * s * s) / 6, (3 * t3 - 6 * t2 + 4) / 6, (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, t3 / 6],
    d: [-0.5 * s * s, 1.5 * t2 - 2 * t, -1.5 * t2 + t + 0.5, 0.5 * t2],
    d2: [1 - t, 3 * t - 2, 1 - 3 * t, t],
  };
}

/**
 * Ridge analysis at texture coordinate (s, t) ∈ [0,1)²; jx, jy: overlay texel offsets per screen pixel
 * along screen x and y (Jacobian columns). Mirrors overlayRidge().
 */
export function overlayRidge(r: LineRaster, s: number, t: number, jx: [number, number], jy: [number, number]): OverlayRidge {
  const out: OverlayRidge = { dist: 1e6, alpha: 0, peak: 0, cover: 0, col: [1, 1, 1], off: [0, 0], arRel: 0, l1Rel: 0, l2Rel: 0 };
  const px = s * r.w - 0.5, py = t * r.h - 0.5;
  const fx = Math.floor(px), fy = Math.floor(py);
  const bx = bsplineWeights(px - fx), by = bsplineWeights(py - fy);
  const i0 = fx - 1, j0 = fy - 1;
  let A = 0, gx = 0, gy = 0, hxx = 0, hyy = 0, hxy = 0, p3 = 0, p4 = 0;
  const c4 = [0, 0, 0];
  for (let j = 0; j < 4; j++) {
    const row = clamp(j0 + j, 0, r.h - 1);
    for (let i = 0; i < 4; i++) {
      const col = (((i0 + i) % r.w) + r.w) % r.w;
      const o = 4 * (row * r.w + col);
      const a = r.data[o + 3];
      const w = bx.w[i] * by.w[j];
      A += w * a;
      gx += bx.d[i] * by.w[j] * a;
      gy += bx.w[i] * by.d[j] * a;
      hxx += bx.d2[i] * by.w[j] * a;
      hyy += bx.w[i] * by.d2[j] * a;
      hxy += bx.d[i] * by.d[j] * a;
      const a3 = w * a * a * a;
      p3 += a3;
      p4 += a3 * a;
      c4[0] += a3 * r.data[o];
      c4[1] += a3 * r.data[o + 1];
      c4[2] += a3 * r.data[o + 2];
    }
  }
  out.cover = A;
  if (p4 < 1e-8) return out;
  const peak = p4 / p3;
  out.peak = peak;
  out.col = [c4[0] / p4, c4[1] / p4, c4[2] / p4];
  const hm = 0.5 * (hxx + hyy);
  const hd = Math.sqrt(0.25 * (hxx - hyy) * (hxx - hyy) + hxy * hxy);
  const l1 = hm - hd, l2 = hm + hd;
  out.l1Rel = l1 / peak;
  out.l2Rel = l2 / peak;
  if (l1 >= -0.02 * peak) return out;
  const va = [hxy, l1 - hxx], vb = [l1 - hyy, hxy];
  let e1 = va[0] * va[0] + va[1] * va[1] > vb[0] * vb[0] + vb[1] * vb[1] ? va : vb;
  const el = Math.hypot(e1[0], e1[1]);
  e1 = el > 1e-9 ? [e1[0] / el, e1[1] / el] : [1, 0];
  const e2 = [-e1[1], e1[0]];
  const g1 = gx * e1[0] + gy * e1[1];
  const x1 = clamp(-g1 / l1, -3, 3);
  const ar = A + 0.5 * g1 * x1;
  out.arRel = ar / peak;
  const dLine = Math.abs(x1) / Math.max(Math.hypot(jx[0] * e1[0] + jx[1] * e1[1], jy[0] * e1[0] + jy[1] * e1[1]), 1e-6);
  const sp = l2 < 0 ? smoothstep(0.35, 0.8, l2 / l1) : 0;
  let dist = dLine;
  out.off = [x1 * e1[0], x1 * e1[1]];
  if (sp > 0) {
    const x2 = clamp(-(gx * e2[0] + gy * e2[1]) / l2, -3, 3);
    const dx = x1 * e1[0] + x2 * e2[0], dy = x1 * e1[1] + x2 * e2[1];
    let det = jx[0] * jy[1] - jy[0] * jx[1];
    if (Math.abs(det) <= 1e-12) det = 1e-12;
    const vx = (jy[1] * dx - jy[0] * dy) / det, vy = (jx[0] * dy - jx[1] * dx) / det;
    dist = dLine + (Math.hypot(vx, vy) - dLine) * sp;
    out.off = [out.off[0] + (dx - out.off[0]) * sp, out.off[1] + (dy - out.off[1]) * sp];
  }
  out.dist = dist;
  out.alpha = peak * smoothstep(0.3, 0.45, -l1 / peak) * smoothstep(0.42, 0.55, ar / peak);
  return out;
}

/** Whiteness of the ridge colour (the painter's coastline is pure white; transform boundaries 0.94). */
export function ridgeWhite(r: OverlayRidge): number {
  return smoothstep(0.955, 0.985, Math.min(r.col[0], r.col[1], r.col[2]));
}

/** Height raster (m), row 0 = north, longitude wraps. */
export interface HeightRaster {
  w: number;
  h: number;
  data: Float32Array;
}

function bilinear(hr: HeightRaster, x: number, y: number): number {
  // x, y in texel-centre coordinates (texel i at i).
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (i: number, j: number): number => hr.data[clamp(j, 0, hr.h - 1) * hr.w + (((i % hr.w) + hr.w) % hr.w)];
  const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
  const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
  return a + (b - a) * fy;
}

/**
 * Distance (height texels) from (s, t) to the sea-level contour of the bilinear height, where the
 * painter traces its coastline: the painter's linear estimate |h|/|∇h| (±1 texel differences) or the nearest sign change toward ±1.5
 * texels east, west, north and south (robust in one-texel channels and on flat coasts). Mirrors
 * contourDist().
 */
export function contourDist(hr: HeightRaster, s: number, t: number, sea: number): number {
  const x = s * hr.w - 0.5, y = t * hr.h - 0.5;
  const h0 = bilinear(hr, x, y) - sea;
  const h1 = [bilinear(hr, x + 1, y), bilinear(hr, x - 1, y), bilinear(hr, x, y + 1), bilinear(hr, x, y - 1)];
  const hn = [bilinear(hr, x + 1.5, y), bilinear(hr, x - 1.5, y), bilinear(hr, x, y + 1.5), bilinear(hr, x, y - 1.5)];
  let d = Math.abs(h0) / Math.max(0.5 * Math.hypot(h1[0] - h1[1], h1[2] - h1[3]), 1e-3);
  for (const v of hn) {
    const h1 = v - sea;
    if (h1 > 0 !== h0 > 0) d = Math.min(d, (1.5 * Math.abs(h0)) / Math.max(Math.abs(h0) + Math.abs(h1), 1e-3));
  }
  return d;
}

/** Height scale (m) of the squashed coast field (COAST_SCALE in GLSL_TERRAIN_RECON). */
const COAST_SCALE = 15;

function catmullRom(t: number): { w: number[]; d: number[] } {
  const t2 = t * t, t3 = t2 * t;
  return {
    w: [-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1, -1.5 * t3 + 2 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2],
    d: [-1.5 * t2 + 2 * t - 0.5, 4.5 * t2 - 5 * t, -4.5 * t2 + 4 * t + 0.5, 1.5 * t2 - t],
  };
}

/**
 * The displayed coast field (GLSL coastField / reconstructTerrain's m, gmd): value > 0 on land and
 * the gradient per height texel of that value — the B-spline gradient where the ±0.5 clamp to the
 * Catmull-Rom field is inactive, the Catmull-Rom one where it holds, blended just before it engages
 * (mirrors coastGrad()).
 */
export function coastField(hr: HeightRaster, s: number, t: number, sea: number): { m: number; gx: number; gy: number } {
  const px = s * hr.w - 0.5, py = t * hr.h - 0.5;
  const fx = Math.floor(px), fy = Math.floor(py);
  const cx = catmullRom(px - fx), cy = catmullRom(py - fy);
  const bsx = bsplineWeights(px - fx), bsy = bsplineWeights(py - fy);
  const bx = bsx.w, by = bsy.w;
  let m = 0, mb = 0, gx = 0, gy = 0, gbx = 0, gby = 0;
  for (let j = 0; j < 4; j++) {
    const row = clamp(fy - 1 + j, 0, hr.h - 1);
    let rm = 0, rdm = 0, rmb = 0, rdmb = 0;
    for (let i = 0; i < 4; i++) {
      const v = hr.data[row * hr.w + ((((fx - 1 + i) % hr.w) + hr.w) % hr.w)];
      const x = (v - sea) / COAST_SCALE;
      const q = x / Math.sqrt(1 + x * x);
      const sv = v > sea ? Math.max(q, 0.02) : Math.min(q, -0.02);
      rm += cx.w[i] * sv;
      rdm += cx.d[i] * sv;
      rmb += bx[i] * sv;
      rdmb += bsx.d[i] * sv;
    }
    m += cy.w[j] * rm;
    gx += cy.w[j] * rdm;
    gy += cy.d[j] * rm;
    mb += by[j] * rmb;
    gbx += by[j] * rdmb;
    gby += bsy.d[j] * rmb;
  }
  const k = smoothstep(0.47, 0.5, Math.abs(mb - m));
  return { m: clamp(mb, m - 0.5, m + 0.5), gx: gbx + (gx - gbx) * k, gy: gby + (gy - gby) * k };
}

/**
 * 0..1: the (white) ridge at the point is the raster's coastline — its centre lies on the sea-level
 * contour of the raw height, or the point is next to the displayed coast (coast field m, gradient
 * gx, gy per height texel). Mirrors ridgeOnCoast(); (s, t) is the point's texture coordinate.
 */
export function ridgeOnCoast(
  r: OverlayRidge, hr: HeightRaster, ovW: number, ovH: number, s: number, t: number, sea: number,
  m: number, gx: number, gy: number,
): number {
  if (r.alpha <= 0 || ridgeWhite(r) <= 0) return 0;
  const nearCoast = 1 - smoothstep(0.9, 1.4, Math.abs(m) / Math.max(Math.hypot(gx, gy), 1e-4));
  if (nearCoast >= 1) return 1;
  const onContour = 1 - smoothstep(1.2, 1.8, contourDist(hr, s + r.off[0] / ovW, t + r.off[1] / ovH, sea));
  return Math.max(nearCoast, onContour);
}

/**
 * Premultiplied RGBA (0..1) of the magnified overlay at a point: mirrors overlayCompose(). coastPx:
 * screen distance to the displayed coast (1e6 when unknown); onCoast: 0..1, the ridge lies on the
 * sea-level contour (it is the raster's coastline); snap: weight of the analytic coast; dpr: device
 * pixels per CSS pixel.
 */
export function overlayCompose(
  r: OverlayRidge, coastPx: number, onCoast: number, snap: number, dpr: number,
): [number, number, number, number] {
  const coastW = snap * ridgeWhite(r);
  const lineA = r.alpha * (1 - coastW * onCoast);
  const coastA = coastW * r.peak * smoothstep(0.04, 0.16, r.cover);
  const hwL = LINE_HALF_PX * dpr, hwC = COAST_HALF_PX * dpr, halo = HALO_PX * dpr;
  const covL = lineA * clamp(hwL + 0.5 - r.dist, 0, 1);
  const covC = coastA * clamp(hwC + 0.5 - coastPx, 0, 1);
  const hal = HALO_ALPHA * Math.max(
    lineA * (1 - smoothstep(hwL - 0.5, hwL + halo, r.dist)),
    0.75 * coastA * (1 - smoothstep(hwC - 0.5, hwC + halo, coastPx)),
  );
  const o = [r.col[0] * covL, r.col[1] * covL, r.col[2] * covL, covL];
  for (let q = 0; q < 3; q++) o[q] = r.col[q] * covC + o[q] * (1 - covC);
  o[3] = covC + o[3] * (1 - covC);
  const k = 1 - o[3];
  return [o[0] + HALO_RGB[0] * hal * k, o[1] + HALO_RGB[1] * hal * k, o[2] + HALO_RGB[2] * hal * k, o[3] + hal * k];
}
