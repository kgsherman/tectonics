import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/constants';
import { Rng } from '../src/core/rng';
import { drawBrush } from '../src/render/mapLayers';
import {
  lonDelta, mapClamp, mapMinScale, mapPan, mapProject, mapUnproject, mapWorldCopies, mapWorldRect, mapZoomAt,
  MAP_MAX_ZOOM, type MapTransform,
} from '../src/render/viewUtil';

const rng = new Rng(4242);
const random = (): number => rng.next();

const fit = (width: number, height: number): MapTransform =>
  mapClamp({ width, height, centerLon: 0, centerLat: 0, scale: mapMinScale(width, height) });

describe('map transform', () => {
  it('fits the world and letterboxes', () => {
    const t = fit(1000, 400);
    expect(t.scale).toBeCloseTo(400 / Math.PI, 9);
    const w = fit(600, 800);
    expect(w.scale).toBeCloseTo(600 / (2 * Math.PI), 9);
    // Tall viewport: the world is shorter than the view, so latitude stays centered.
    expect(mapClamp({ ...w, centerLat: 0.5 }).centerLat).toBe(0);
  });

  it('north-up, east-right, lon +90° three quarters across at fit zoom', () => {
    const t = fit(1024, 512);
    const np = mapProject(t, Math.PI / 2, 0);
    expect(np.y).toBeCloseTo(0, 9);
    const e90 = mapProject(t, 0, Math.PI / 2);
    expect(e90.x).toBeCloseTo(768, 9);
    expect(e90.y).toBeCloseTo(256, 9);
  });

  it('pick/project round trip including across the antimeridian', () => {
    let t = fit(900, 500);
    t = mapZoomAt(t, 450, 250, 4);
    t = mapClamp({ ...t, centerLon: 179 * DEG });
    for (let i = 0; i < 300; i++) {
      const x = random() * t.width, y = random() * t.height;
      const g = mapUnproject(t, x, y)!;
      expect(g).not.toBeNull();
      expect(g.lon).toBeGreaterThan(-Math.PI);
      expect(g.lon).toBeLessThanOrEqual(Math.PI);
      const p = mapProject(t, g.lat, g.lon);
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    }
    // A point just east of the antimeridian is drawn to the right of the center.
    const east = mapProject(t, 0, -179 * DEG);
    expect(east.x).toBeGreaterThan(t.width / 2);
  });

  it('zoom keeps the point under the cursor fixed and respects limits', () => {
    let t = fit(800, 600);
    t = mapZoomAt(t, 400, 300, 3);
    const before = mapUnproject(t, 610, 170)!;
    const z = mapZoomAt(t, 610, 170, 1.7);
    const after = mapUnproject(z, 610, 170)!;
    expect(Math.abs(lonDelta(before.lon, after.lon))).toBeLessThan(1e-9);
    expect(after.lat).toBeCloseTo(before.lat, 9);
    const maxed = mapZoomAt(t, 400, 300, 1e6);
    expect(maxed.scale).toBeCloseTo(mapMinScale(800, 600) * MAP_MAX_ZOOM, 6);
    const minned = mapZoomAt(t, 400, 300, 1e-6);
    expect(minned.scale).toBeCloseTo(mapMinScale(800, 600), 9);
  });

  it('vertical clamp keeps the poles at the viewport edges', () => {
    let t = fit(800, 600);
    t = mapZoomAt(t, 400, 300, 2);
    t = mapPan(t, 0, 100000);
    expect(mapProject(t, Math.PI / 2, 0).y).toBeCloseTo(0, 6);
    t = mapPan(t, 0, -100000);
    expect(mapProject(t, -Math.PI / 2, 0).y).toBeCloseTo(600, 6);
  });

  it('panning wraps horizontally and world copies cover the viewport', () => {
    let t = fit(1600, 400); // wider than 2:1: several copies visible
    const copies = mapWorldCopies(t);
    expect(copies.length).toBeGreaterThanOrEqual(2);
    let covered = 0;
    for (const k of copies) {
      const r = mapWorldRect(t, k);
      covered += Math.max(0, Math.min(1600, r.x + r.w) - Math.max(0, r.x));
    }
    expect(covered).toBeCloseTo(1600, 6);
    t = mapPan(t, 12345, 0);
    expect(t.centerLon).toBeGreaterThan(-Math.PI);
    expect(t.centerLon).toBeLessThanOrEqual(Math.PI);
    for (const k of mapWorldCopies(t)) {
      const r = mapWorldRect(t, k);
      expect(r.x + r.w).toBeGreaterThan(0);
      expect(r.x).toBeLessThan(1600);
    }
  });
});

/** Records the vertices of every filled path (enough to check where the brush fill lands). */
function recordingContext(): { ctx: CanvasRenderingContext2D; fills: Array<Array<[number, number]>> } {
  const fills: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  const noop = (): void => {};
  const ctx = {
    save: noop, restore: noop, closePath: noop, stroke: noop,
    beginPath: () => { cur = []; },
    moveTo: (x: number, y: number) => { cur.push([x, y]); },
    lineTo: (x: number, y: number) => { cur.push([x, y]); },
    fill: () => { fills.push(cur.slice()); },
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: 'miter',
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

describe('map brush', () => {
  const xRange = (fills: Array<Array<[number, number]>>): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const f of fills) for (const [x] of f) {
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return [lo, hi];
  };

  it('a brush around a pole fills the full viewport width, even wider than one world copy', () => {
    for (const [w, h] of [[1400, 600], [2000, 400], [800, 600]]) {
      for (const centerLon of [-3, -1.5, 0, 1.5, 3]) {
        for (const lon of [-3, -1, 0, 1, 3]) {
          const t = mapClamp({ width: w, height: h, centerLon, centerLat: 0, scale: mapMinScale(w, h) });
          const { ctx, fills } = recordingContext();
          drawBrush(ctx, t, { point: { lat: 80 * DEG, lon }, radius: 15 * DEG });
          expect(fills.length).toBe(1);
          const [lo, hi] = xRange(fills);
          expect(lo).toBeLessThanOrEqual(0);
          expect(hi).toBeGreaterThanOrEqual(w);
          // Closed along the north pole row.
          expect(fills[0].some(([, y]) => Math.abs(y - mapProject(t, Math.PI / 2, 0).y) < 1e-9)).toBe(true);
        }
      }
    }
  });

  it('a brush centred exactly on a pole still draws a full band', () => {
    const t = fit(1000, 500);
    for (const lat of [Math.PI / 2, -Math.PI / 2]) {
      const { ctx, fills } = recordingContext();
      drawBrush(ctx, t, { point: { lat, lon: 0.3 }, radius: 0.2 });
      const [lo, hi] = xRange(fills);
      expect(lo).toBeLessThanOrEqual(0);
      expect(hi).toBeGreaterThanOrEqual(1000);
      // The curve sweeps longitude smoothly at the circle's latitude (no atan2(0, 0) garbage).
      const yCircle = mapProject(t, Math.sign(lat) * (Math.PI / 2 - 0.2), 0).y;
      const curve = fills[0].filter(([, y]) => Math.abs(y - yCircle) < 1e-6);
      expect(curve.length).toBeGreaterThan(90);
      const step = (2 * Math.PI * t.scale) / 96;
      for (let i = 1; i < curve.length; i++) expect(Math.abs(curve[i][0] - curve[i - 1][0])).toBeLessThan(1.5 * step);
    }
  });

  it('an ordinary brush is a closed ellipse at the copy nearest the view', () => {
    const t = mapClamp({ ...fit(1000, 500), centerLon: 179 * DEG });
    const { ctx, fills } = recordingContext();
    drawBrush(ctx, t, { point: { lat: 10 * DEG, lon: -178 * DEG }, radius: 5 * DEG });
    expect(fills.length).toBeGreaterThanOrEqual(1);
    const c = mapProject(t, 10 * DEG, -178 * DEG);
    const main = fills.find((f) => f.every(([x]) => Math.abs(x - c.x) < 0.2 * t.scale));
    expect(main).toBeDefined();
    const [lo, hi] = xRange([main!]);
    // 5° radius at 10°N: ± 5.08° of longitude.
    expect(hi - lo).toBeCloseTo(2 * 5.08 * DEG * t.scale, 0);
  });
});
