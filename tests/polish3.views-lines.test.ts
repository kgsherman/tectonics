/**
 * Polish 3 (views): magnified overlay lines at a constant thin screen width with the coastline on
 * the displayed coast, coastal anti-aliasing texels kept out of the per-class colours, sharper
 * close-up detail. The GPU output is verified visually (scratch/views); here the CPU reference model
 * of the line reconstruction (src/render/viewLines.ts) is exercised on painter-like rasters, and the
 * shaders are pinned to it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Color, Vector3 } from 'three';
import { GlobeSurface, LIGHT_RELIEF } from '../src/render/globeSurface';
import { MAP_BASE_FRAGMENT, MAP_OVERLAY_FRAGMENT } from '../src/render/mapGl';
import { buildOverlay } from '../src/render/overlay';
import { GLSL_OVERLAY_LINES, GLSL_TERRAIN_DETAIL, GLSL_TERRAIN_RECON } from '../src/render/shadersCommon';
import { SURFACE_FRAGMENT } from '../src/render/shadersSurface';
import {
  coastField, COAST_HALF_PX, contourDist, HALO_ALPHA, HALO_PX, LINE_HALF_PX, overlayCompose, overlayRidge, ridgeOnCoast,
  ridgeWhite, type HeightRaster, type LineRaster,
} from '../src/render/viewLines';

type Pt = [number, number];

function distToPolyline(pts: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** Straight-alpha "over" into a 0..255 float buffer (as the painter's overlay). */
function blend(out: Float32Array, p: number, c: readonly number[], a: number): void {
  if (a <= 0) return;
  const o = 4 * p, da = out[o + 3] / 255, oa = a + da * (1 - a);
  for (let q = 0; q < 3; q++) out[o + q] = (c[q] * a + out[o + q] * da * (1 - a)) / oa;
  out[o + 3] = oa * 255;
}

/** Straight 0..255 values → premultiplied 0..1 raster quantized like the RGBA8 texture. */
function toRaster(straight: ArrayLike<number>, w: number, h: number): LineRaster {
  const data = new Float32Array(4 * w * h);
  for (let i = 0; i < w * h; i++) {
    const a = Math.round(straight[4 * i + 3]);
    for (let q = 0; q < 3; q++) data[4 * i + q] = Math.round((Math.round(straight[4 * i + q]) * a) / 255) / 255;
    data[4 * i + 3] = a / 255;
  }
  return { w, h, data };
}

/** A boundary drawn like overlay.ts drawBoundaries: dark halo, then the coloured core (k = raster scale). */
function paintBoundary(w: number, h: number, pts: Pt[], k: number): LineRaster {
  const out = new Float32Array(4 * w * h);
  const hw = 0.85 * k, haloHw = hw + 0.9 * k;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const d = distToPolyline(pts, c, r);
    if (d >= haloHw + 0.5) continue;
    blend(out, r * w + c, [12, 14, 20], 0.45 * Math.min(1, haloHw + 0.5 - d));
    if (hw + 0.5 - d > 0) blend(out, r * w + c, [250, 212, 60], 0.97 * Math.min(1, hw + 0.5 - d));
  }
  return toRaster(out, w, h);
}

const BW = 120, BH = 60;
const CURVE: Pt[] = [];
for (let x = 8; x <= BW - 8; x += 0.5) CURVE.push([x, BH / 2 + 9 * Math.sin(x / 8)]);

/** Line coverage (no halo) of the reconstruction at texel coordinates (u, v), M px per texel. */
function lineCover(r: LineRaster, u: number, v: number, M: number): number {
  const rd = overlayRidge(r, u / r.w, v / r.h, [1 / M, 0], [0, 1 / M]);
  return rd.alpha * Math.min(1, Math.max(0, LINE_HALF_PX + 0.5 - rd.dist));
}

/** Mean effective width (∫ coverage across the line, px) and centroid offset over cross sections. */
function crossSections(r: LineRaster, M: number): { width: number; bias: number; peak: number } {
  let wsum = 0, bsum = 0, psum = 0, n = 0;
  for (let i = 12; i + 12 < CURVE.length; i += 9) {
    const [ax, ay] = CURVE[i], [bx, by] = CURVE[i + 1];
    const l = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / l, ny = (bx - ax) / l;
    let integ = 0, cen = 0, mx = 0;
    for (let t = -5; t <= 5; t += 0.1) {
      const cov = lineCover(r, ax + (nx * t) / M + 0.5, ay + (ny * t) / M + 0.5, M);
      integ += cov * 0.1;
      cen += cov * t * 0.1;
      mx = Math.max(mx, cov);
    }
    wsum += integ;
    bsum += integ > 0 ? Math.abs(cen / integ) : 0;
    psum += mx;
    n++;
  }
  return { width: wsum / n, bias: bsum / n, peak: psum / n };
}

describe('overlay lines: constant thin screen width at any magnification', () => {
  for (const k of [1, 0.6]) {
    it(`boundaries painted at ${k === 1 ? 'full (2048)' : 'preview (1024)'} scale keep ~1.2–1.6 px from 2× to 32×`, () => {
      const r = paintBoundary(BW, BH, CURVE, k);
      const widths: number[] = [];
      for (const M of [2, 4, 8, 16, 32]) {
        const m = crossSections(r, M);
        widths.push(m.width);
        expect(m.width).toBeGreaterThan(1.0);
        expect(m.width).toBeLessThan(1.7);
        // Centred on the painted line (sub-texel accurate), and nearly opaque at its centre.
        expect(m.bias).toBeLessThan(0.5);
        expect(m.peak).toBeGreaterThan(0.8);
      }
      // Constant on screen: the old magnification grew ~3 px per texel of zoom (7 px at 2.2, 15 px at 1.5).
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(0.35);
    });
  }

  it('draws nothing on the dark halo shoulders or away from the line', () => {
    const r = paintBoundary(BW, BH, CURVE, 1);
    const M = 8;
    let stray = 0, n = 0;
    for (let v = 4; v < BH - 4; v += 0.25) for (let u = 12; u < BW - 12; u += 0.25) {
      const d = distToPolyline(CURVE, u - 0.5, v - 0.5) * M;
      if (d < LINE_HALF_PX + 1.5) continue;
      n++;
      if (lineCover(r, u, v, M) > 0.05) stray++;
    }
    expect(stray / n).toBeLessThan(1e-3);
  });

  it('is anisotropy-aware: screen width follows the texel→pixel Jacobian', () => {
    // A vertical line (constant u) under a 2:1 horizontal squeeze (high latitude / map aspect).
    const w = 40, h = 40, out = new Float32Array(4 * w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const d = Math.abs(c - 20.3);
      if (0.85 + 0.5 - d > 0) blend(out, r * w + c, [250, 212, 60], 0.97 * Math.min(1, 0.85 + 0.5 - d));
    }
    const r = toRaster(out, w, h);
    for (const [jxx, M] of [[1 / 8, 8], [1 / 4, 4]] as const) {
      let integ = 0;
      for (let x = -6; x <= 6; x += 0.05) {
        const rd = overlayRidge(r, (20.8 + x * jxx) / w, 20.5 / h, [jxx, 0], [0, 1 / 16]);
        integ += rd.alpha * Math.min(1, Math.max(0, LINE_HALF_PX + 0.5 - rd.dist)) * 0.05;
      }
      expect(integ, `M=${M}`).toBeGreaterThan(1.1);
      expect(integ, `M=${M}`).toBeLessThan(1.7);
    }
  });
});

describe('coastline on the displayed coast', () => {
  // A synthetic island map with steep asymmetric coasts (+20..1500 m land, −200..−4000 m sea) and
  // 1–3 texel islets; its coastline overlay is painted by the painter itself (overlay.ts).
  const CW = 120, CH = 80;
  const height = new Float32Array(CW * CH);
  const hash = (i: number, j: number): number => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise = (x: number, y: number): number => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  const ISLETS: Array<[number, number, number]> = [[96, 22, 1.1], [100, 44, 1.6], [92, 62, 0.6]];
  for (let r = 0; r < CH; r++) for (let c = 0; c < CW; c++) {
    const f = 1 - Math.hypot((c - 42) / 30, (r - 40) / 24) + 0.35 * (vnoise(c / 6, r / 6) - 0.5) + 0.2 * (vnoise(c / 2.5, r / 2.5) - 0.5);
    let v = f > 0 ? 20 + 1500 * f * vnoise(c / 9 + 7, r / 9) : -200 + 4000 * Math.min(0, f);
    for (const [ic, ir, rad] of ISLETS) if (Math.hypot(c - ic, r - ir) <= rad) v = 60;
    height[r * CW + c] = v;
  }
  const hr: HeightRaster = { w: CW, h: CH, data: height };
  const ov = toRaster(
    buildOverlay(
      { coastlines: true, boundaries: false, graticule: false }, {} as never, null, { w: CW, h: CH, height } as never,
      { width: CW, height: CH, month: 0, seaLevel: 0, hillshade: false, seed: 1 }, {} as never,
    ),
    CW, CH,
  );
  // Displayed coast = the coast field domain-warped by up to ~0.4 texel (procedural breakup).
  const warp = (u: number, v: number): Pt => [0.3 * Math.sin(u * 0.9 + v * 0.3), 0.3 * Math.cos(v * 0.8 - u * 0.4)];

  function shade(u: number, v: number, M: number): { rgba: number[]; raster: number; land: boolean } {
    const s = u / CW, t = v / CH, rd = overlayRidge(ov, s, t, [1 / M, 0], [0, 1 / M]);
    const [wu, wv] = warp(u, v);
    const cf = coastField(hr, (u + wu) / CW, (v + wv) / CH, 0);
    const coastPx = Math.abs(cf.m) / Math.max(Math.hypot(cf.gx / M, cf.gy / M), 1e-6);
    const onCoast = ridgeOnCoast(rd, hr, CW, CH, s, t, 0, cf.m, cf.gx, cf.gy);
    const raster = rd.alpha * (1 - ridgeWhite(rd) * onCoast) * Math.min(1, Math.max(0, LINE_HALF_PX + 0.5 - rd.dist));
    return { rgba: overlayCompose(rd, coastPx, onCoast, 1, 1), raster, land: cf.m > 0 };
  }

  it('replaces the raster coastline by one thin line on the displayed coast (no offset copies)', () => {
    for (const M of [3, 8, 20]) {
      let residual = 0, n = 0;
      for (let v = 3; v < CH - 3; v += 0.3) for (let u = 3; u < CW - 3; u += 0.3) {
        n++;
        if (shade(u, v, M).raster > 0.05) residual++;
      }
      expect(residual / n, `M=${M}`).toBeLessThan(2e-4);
    }
  });

  it('draws the coast line continuously along the displayed coast', () => {
    const M = 8;
    let onCoast = 0, drawn = 0;
    for (let v = 3; v < CH - 3; v += 0.125) for (let u = 3; u < 80; u += 0.125) {
      const [wu, wv] = warp(u, v);
      const cf = coastField(hr, (u + wu) / CW, (v + wv) / CH, 0);
      const px = Math.abs(cf.m) / Math.max(Math.hypot(cf.gx / M, cf.gy / M), 1e-6);
      if (px > 0.3) continue;
      onCoast++;
      if (shade(u, v, M).rgba[3] > 0.5) drawn++;
    }
    expect(onCoast).toBeGreaterThan(500);
    expect(drawn / onCoast).toBeGreaterThan(0.97);
  });

  it('never hides small islands: their interior stays visible once magnified', () => {
    for (const M of [8, 16]) {
      let land = 0, covered = 0;
      for (const [ic, ir] of ISLETS.slice(0, 2)) {
        for (let v = ir - 2.5; v <= ir + 2.5; v += 1 / M) for (let u = ic - 2.5; u <= ic + 2.5; u += 1 / M) {
          const s = shade(u + 0.5, v + 0.5, M);
          if (!s.land) continue;
          land++;
          if (s.rgba[3] > 0.5) covered++;
        }
      }
      expect(land).toBeGreaterThan(10);
      // Only a ~1.3 px outline (the old magnification covered them entirely with a white blob).
      expect(covered / land, `M=${M}`).toBeLessThan(M === 8 ? 0.45 : 0.25);
    }
  });

  it('measures screen distances with the gradient of the displayed coast field (review: lines were ~2 px)', () => {
    // m is the B-spline field (clamped to ±0.5 of Catmull-Rom); its Catmull-Rom gradient alone is ~1.7×
    // steeper along smooth coasts, so |m|/|∇m| came out too short: coast lines ~2 px wide instead of
    // 2·COAST_HALF_PX, soft wedges at capes. The returned gradient must be the value's own.
    const e = 1e-3;
    let n = 0, bad = 0;
    for (let v = 4; v < CH - 4; v += 0.37) for (let u = 4; u < CW - 4; u += 0.37) {
      const cf = coastField(hr, u / CW, v / CH, 0);
      if (Math.abs(cf.m) > 0.3) continue;
      const fx = (coastField(hr, (u + e) / CW, v / CH, 0).m - coastField(hr, (u - e) / CW, v / CH, 0).m) / (2 * e);
      const fy = (coastField(hr, u / CW, (v + e) / CH, 0).m - coastField(hr, u / CW, (v - e) / CH, 0).m) / (2 * e);
      n++;
      if (Math.hypot(cf.gx - fx, cf.gy - fy) > 0.15 * Math.max(Math.hypot(fx, fy), 0.05)) bad++;
    }
    expect(n).toBeGreaterThan(500);
    expect(bad / n).toBeLessThan(0.03);
    expect(GLSL_TERRAIN_RECON).toContain('return mix(gmb, gm, smoothstep(0.47, 0.5, abs(mb - m)));');
    expect(readFileSync(new URL('../src/render/viewLines.ts', import.meta.url), 'utf8')).toContain('smoothstep(0.47, 0.5, Math.abs(mb - m))');
    expect(GLSL_TERRAIN_RECON).toContain('r.gmd = coastGrad(m, mb, gm, gmb);');
    expect(GLSL_TERRAIN_RECON).toContain('return vec3(clamp(mb, m - 0.5, m + 0.5), coastGrad(m, mb, gm, gmb));');
    expect(SURFACE_FRAGMENT).toContain('coastPx = coastDistPx(ts.m, ts.gmd, dsx * uHeightSize, dsy * uHeightSize);');
  });

  it('recognises the raster coastline by its position on the sea-level contour', () => {
    // Painter's band centre on a steep shelf break ~1 texel out at sea still counts (|h|/|∇h| < 1.2).
    const ramp: HeightRaster = { w: 8, h: 4, data: Float32Array.from({ length: 32 }, (_, i) => [300, 100, -500, -2500, -3000, -3000, -3000, -3000][i % 8]) };
    expect(contourDist(ramp, 1.62 / 8, 0.5, 0)).toBeLessThan(0.25);
    expect(contourDist(ramp, 2.5 / 8, 0.5, 0)).toBeLessThan(1.2);
    expect(contourDist(ramp, 5.5 / 8, 0.5, 0)).toBeGreaterThan(5);
    // A one-texel channel (symmetric: central differences cancel) is still found.
    const channel: HeightRaster = { w: 8, h: 4, data: Float32Array.from({ length: 32 }, (_, i) => (i % 8 === 4 ? -12 : 30)) };
    expect(contourDist(channel, 4.5 / 8, 0.5, 0)).toBeLessThan(0.6);
  });
});

describe('shaders follow the reference model', () => {
  const model = readFileSync(new URL('../src/render/viewLines.ts', import.meta.url), 'utf8');

  it('shares the widths, halo and gates with viewLines.ts', () => {
    expect(GLSL_OVERLAY_LINES).toContain(`const float LINE_HALF_PX = ${LINE_HALF_PX};`);
    expect(GLSL_OVERLAY_LINES).toContain(`const float COAST_HALF_PX = ${COAST_HALF_PX};`);
    expect(GLSL_OVERLAY_LINES).toContain(`const float HALO_PX = ${HALO_PX};`);
    expect(GLSL_OVERLAY_LINES).toContain(`const float HALO_ALPHA = ${HALO_ALPHA};`);
    for (const gate of [
      'smoothstep(0.3, 0.45, -l1 / peak)', 'smoothstep(0.42, 0.55, ar / peak)', 'smoothstep(0.35, 0.8, l2 / l1)',
      'smoothstep(0.955, 0.985,', 'smoothstep(0.9, 1.4,', 'smoothstep(1.2, 1.8, contourDist(', 'smoothstep(0.04, 0.16,',
    ]) {
      expect(GLSL_OVERLAY_LINES, gate).toContain(gate);
      expect(model, gate).toContain(gate);
    }
  });

  it('globe and map magnify overlays through the ridge reconstruction with the analytic coast', () => {
    for (const src of [SURFACE_FRAGMENT, MAP_OVERLAY_FRAGMENT]) {
      expect(src).toContain('overlayRidge(uOverlay, uOverlaySize, st, dsx * uOverlaySize, dsy * uOverlaySize)');
      expect(src).toContain('ridgeOnCoast(ridge, uHeight, uHeightSize, uOverlaySize, st, uSeaLevel,');
      expect(src).toContain('overlayCompose(ridge, coastPx, onCoast, snap, uDpr)');
      expect(src).toContain('smoothstep(1.0, 0.7, ovTex)');
      expect(src).not.toContain('overlaySharp');
    }
    // The map overlay pass rebuilds the base's displayed coast: same warp (terrainWarp = the warp of
    // terrainDetail) and the same coast field.
    expect(MAP_OVERLAY_FRAGMENT).toContain('terrainWarp(n0, texRad, pxRad)');
    expect(MAP_OVERLAY_FRAGMENT).toContain('coastField(uHeight, uHeightSize, stw, uSeaLevel)');
    const warpOctave = 'warp += (wamp * fade) * n.yzw;';
    expect(GLSL_TERRAIN_DETAIL.split(warpOctave).length - 1).toBe(2);
    expect(GLSL_TERRAIN_DETAIL.split('float fade = detailFade(freq, pxRad);').length - 1).toBe(2);
    expect(GLSL_TERRAIN_RECON).toContain('vec3 coastField(sampler2D heightTex, vec2 hSize, vec2 st, float sea)');
  });

  it('GlobeSurface carries the device pixel ratio for CSS-pixel line widths', () => {
    const shared = { uLightMode: { value: LIGHT_RELIEF }, uSunDir: { value: new Vector3(1, 0, 0) }, uAtmoColor: { value: new Color() } };
    const s = new GlobeSurface(shared, 1);
    const u = s.mesh.material.uniforms;
    expect(u.uDpr.value).toBe(1);
    s.setPixelRatio(2);
    expect(u.uDpr.value).toBe(2);
    s.setPixelRatio(Number.NaN);
    expect(u.uDpr.value).toBe(1);
    s.dispose();
  });
});

describe('coast colours and close-up detail', () => {
  it('keeps the painter\'s coastal anti-aliasing texels out of the per-class colours, stencil-independently', () => {
    // 6×6 land/sea ring (flags must not depend on where the 4×4 stencil sits) and a small weight.
    expect(GLSL_TERRAIN_RECON).toContain('float l6[36];');
    expect(GLSL_TERRAIN_RECON).toContain('float q = edge ? 0.015 : 1.0;');
    // Sea texels diagonal to land count when land-tinted (not bluish).
    expect(GLSL_TERRAIN_RECON).toContain('c.b < max(c.r, c.g) + 0.01');
  });

  it('warps land colours procedurally (lit modes only), keeping rebuilt edges, water and categorical rasters as painted', () => {
    expect(GLSL_TERRAIN_RECON).toContain('vec3 perturbLand(TerrainSample ts, vec2 off)');
    expect(GLSL_TERRAIN_RECON).toContain(
      'off *= (1.0 - ts.landEdge) * (1.0 - smoothstep(0.02, 0.15, ts.landWater)) * (1.0 - smoothstep(0.1, 0.35, ts.landFlat));',
    );
    // Never beyond the texels' own colour range (smooth power-mean max / min).
    expect(GLSL_TERRAIN_RECON).toContain('r.landMin = fused && wl > 1e-5 ? max(lbs - 1.6 * sd, pmin) : vec3(2.0);');
    for (const src of [SURFACE_FRAGMENT, MAP_BASE_FRAGMENT]) {
      expect(src).toContain('cwarp = (lit ? uDetail : 0.0) * (cwarp - dot(cwarp, n0) * n0);');
      expect(src).toContain('perturbLand(ts, coff)');
      // Shared detail strengths (slope-aware micro-relief and albedo).
      expect(src).toContain('detailSlopeGain(r)');
      expect(src).toContain('detailAlbedoGain(rough)');
    }
  });
});
