/**
 * Vector annotations for the 2D map drawn with Canvas 2D in CSS pixels: graticule, great-circle
 * arrows, markers with labels and the geodesic brush ellipse. Every primitive is laid out once
 * around the center copy of the world (longitudes unwrapped continuously) and stamped at each
 * horizontal repeat that intersects the viewport.
 */
import type { ArrowSpec, BrushCursor, MarkerSpec } from '../core/types';
import { arrowCenterline, arrowFrame } from './viewArrows';
import { mapLatToY, mapLonToX, mapProject, type MapTransform } from './viewMapTransform';
import { smallCircle, unwrapLonNear } from './viewUtil';

const TWO_PI = Math.PI * 2;

/** Calls fn(offsetX) for each world repeat where [minX, maxX] (center-copy coordinates) is visible. */
export function forEachCopy(t: MapTransform, minX: number, maxX: number, fn: (ox: number) => void): void {
  const worldW = TWO_PI * t.scale;
  const mMin = Math.ceil(-maxX / worldW);
  const mMax = Math.floor((t.width - minX) / worldW);
  for (let m = mMin; m <= mMax; m++) fn(m * worldW);
}

const rgb = (c: readonly number[], a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function drawGraticule(ctx: CanvasRenderingContext2D, t: MapTransform, stepDeg: number): void {
  const step = (stepDeg * Math.PI) / 180;
  const top = Math.max(0, mapLatToY(t, Math.PI / 2)), bottom = Math.min(t.height, mapLatToY(t, -Math.PI / 2));
  ctx.save();
  ctx.lineWidth = 1;
  const nLat = Math.round(Math.PI / 2 / step);
  for (let k = -nLat; k <= nLat; k++) {
    const y = Math.round(mapLatToY(t, k * step)) + 0.5;
    if (y < 0 || y > t.height) continue;
    ctx.strokeStyle = k === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(t.width, y);
    ctx.stroke();
  }
  // Meridians: lon = j·step in the center copy, repeated.
  const lonMin = t.centerLon - t.width / 2 / t.scale, lonMax = t.centerLon + t.width / 2 / t.scale;
  for (let j = Math.ceil(lonMin / step); j <= Math.floor(lonMax / step); j++) {
    const lon = j * step;
    const x = Math.round(mapLonToX(t, lon)) + 0.5;
    const isPrime = Math.abs(unwrapLonNear(lon, 0)) < 1e-9;
    ctx.strokeStyle = isPrime ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  ctx.restore();
}

/** Screen polyline of an arrow's centerline (center copy), or null if degenerate. */
function arrowScreenPath(t: MapTransform, a: ArrowSpec, n: number): Float64Array | null {
  const f = arrowFrame(a);
  if (!f) return null;
  const pts = arrowCenterline(f, n);
  const out = new Float64Array(2 * (n + 1));
  let prevLon = 0;
  for (let i = 0; i <= n; i++) {
    const x = pts[3 * i], y = pts[3 * i + 1], z = pts[3 * i + 2];
    const lat = Math.asin(Math.max(-1, Math.min(1, z)));
    const rawLon = Math.atan2(y, x);
    // First point: nearest copy to the view center; then continuous unwrapping along the arrow.
    const lon = i === 0 ? unwrapLonNear(rawLon, t.centerLon) : unwrapLonNear(rawLon, prevLon);
    prevLon = lon;
    out[2 * i] = mapLonToX(t, lon);
    out[2 * i + 1] = mapLatToY(t, lat);
  }
  return out;
}

export function drawArrows(ctx: CanvasRenderingContext2D, t: MapTransform, arrows: readonly ArrowSpec[]): void {
  const N = 24;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  for (const a of arrows) {
    const path = arrowScreenPath(t, a, N);
    if (!path) continue;
    // Arc length along the screen path; head size from the on-screen length.
    const cum = new Float64Array(N + 1);
    for (let i = 1; i <= N; i++) cum[i] = cum[i - 1] + Math.hypot(path[2 * i] - path[2 * i - 2], path[2 * i + 1] - path[2 * i - 1]);
    const total = cum[N];
    if (!(total > 0.5)) continue;
    const width = Math.min(5, Math.max(2, 1.6 + 0.02 * total));
    const headLen = Math.min(0.45 * total, Math.max(7, width * 3.2));
    const headW = Math.max(width * 2.6, headLen * 0.8) / 2;
    // Head direction: from the point where the head starts to the tip.
    const cut = total - headLen;
    let k = 1;
    while (k < N && cum[k] < cut) k++;
    const u = (cut - cum[k - 1]) / Math.max(1e-9, cum[k] - cum[k - 1]);
    const bx = path[2 * k - 2] + (path[2 * k] - path[2 * k - 2]) * u;
    const by = path[2 * k - 1] + (path[2 * k + 1] - path[2 * k - 1]) * u;
    const tx = path[2 * N], ty = path[2 * N + 1];
    const dl = Math.hypot(tx - bx, ty - by) || 1;
    const dx = (tx - bx) / dl, dy = (ty - by) / dl;
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i <= N; i++) {
      minX = Math.min(minX, path[2 * i]);
      maxX = Math.max(maxX, path[2 * i]);
    }
    const outline = a.highlighted ? 'rgba(255,255,255,1)' : 'rgba(0,0,0,0.75)';
    const olw = a.highlighted ? 3 : 2;
    forEachCopy(t, minX - headW, maxX + headW, (ox) => {
      const shaft = (): void => {
        ctx.beginPath();
        ctx.moveTo(path[0] + ox, path[1]);
        for (let i = 1; i < k; i++) ctx.lineTo(path[2 * i] + ox, path[2 * i + 1]);
        ctx.lineTo(bx + ox, by);
      };
      const head = (): void => {
        ctx.beginPath();
        ctx.moveTo(tx + ox, ty);
        ctx.lineTo(bx - dy * headW + ox, by + dx * headW);
        ctx.lineTo(bx + dy * headW + ox, by - dx * headW);
        ctx.closePath();
      };
      ctx.strokeStyle = outline;
      ctx.lineWidth = width + 2 * olw;
      shaft();
      ctx.stroke();
      ctx.lineWidth = 2 * olw;
      head();
      ctx.stroke();
      const fill = rgb(a.highlighted ? a.color.map((c) => Math.min(255, c + 50)) : a.color);
      ctx.strokeStyle = fill;
      ctx.fillStyle = fill;
      ctx.lineWidth = width;
      shaft();
      ctx.stroke();
      head();
      ctx.fill();
    });
  }
  ctx.restore();
}

export function drawMarkers(ctx: CanvasRenderingContext2D, t: MapTransform, markers: readonly MarkerSpec[]): void {
  ctx.save();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const m of markers) {
    const p = mapProject(t, m.lat, m.lon);
    const r = Math.max(1, m.radiusPx);
    const ring = m.highlighted ? 4 : 1.5;
    forEachCopy(t, p.x - r - ring, p.x + r + ring + (m.label ? 200 : 0), (ox) => {
      const x = p.x + ox, y = p.y;
      if (m.highlighted) {
        ctx.beginPath();
        ctx.arc(x, y, r + ring, 0, TWO_PI);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, r + 1.5, 0, TWO_PI);
      ctx.fillStyle = 'rgba(5,5,5,0.95)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TWO_PI);
      ctx.fillStyle = rgb(m.color);
      ctx.fill();
      if (m.label) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.strokeText(m.label, x + r + ring + 3, y);
        ctx.fillStyle = '#fff';
        ctx.fillText(m.label, x + r + ring + 3, y);
      }
    });
  }
  ctx.restore();
}

export function drawBrush(ctx: CanvasRenderingContext2D, t: MapTransform, cursor: BrushCursor): void {
  const n = 96;
  const sc = smallCircle(cursor.point, cursor.radius, n);
  const c0 = unwrapLonNear(cursor.point.lon, t.centerLon);
  const shift = c0 - cursor.point.lon;
  const xs = new Float64Array(n + 1), ys = new Float64Array(n + 1);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i <= n; i++) {
    xs[i] = mapLonToX(t, sc.lon[i] + shift);
    ys[i] = mapLatToY(t, sc.lat[i]);
    minX = Math.min(minX, xs[i]);
    maxX = Math.max(maxX, xs[i]);
  }
  // A circle around a pole unwraps into a curve spanning the full width: close it along the pole.
  const polar = Math.abs(sc.lon[n] - sc.lon[0]) > Math.PI;
  const poleY = mapLatToY(t, cursor.point.lat > 0 ? Math.PI / 2 : -Math.PI / 2);
  const worldW = TWO_PI * t.scale;
  // Consecutive windings k = −m..m of the polar curve (each spans one world width) so the band
  // covers the whole viewport even when it is wider than one world copy (aspect > 2 at low zoom).
  const span = xs[n] - xs[0];
  const m = polar ? Math.ceil(t.width / Math.max(1e-9, Math.abs(span))) + 1 : 0;
  const color = cursor.color ?? [255, 255, 255];
  ctx.save();
  ctx.lineJoin = 'round';
  const trace = (ox: number): void => {
    ctx.beginPath();
    if (polar) {
      for (let w = -m; w <= m; w++) {
        const dx = ox + w * span;
        for (let i = 0; i <= n; i++) {
          if (w === -m && i === 0) ctx.moveTo(xs[i] + dx, ys[i]);
          else ctx.lineTo(xs[i] + dx, ys[i]);
        }
      }
    } else {
      ctx.moveTo(xs[0] + ox, ys[0]);
      for (let i = 1; i <= n; i++) ctx.lineTo(xs[i] + ox, ys[i]);
      ctx.closePath();
    }
  };
  const fillRegion = (ox: number): void => {
    trace(ox);
    if (polar) {
      const dir = Math.sign(span) || 1;
      const x1 = xs[n] + ox + m * span;
      const x0 = xs[0] + ox - m * span;
      ctx.lineTo(x1 + dir, poleY);
      ctx.lineTo(x0 - dir, poleY);
      ctx.closePath();
    }
  };
  const draw = (ox: number): void => {
    fillRegion(ox);
    ctx.fillStyle = rgb(color, 0.12);
    ctx.fill();
    trace(ox);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = rgb(color, 1);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  if (polar) draw(0 - worldW * Math.round((xs[0] - t.width / 2) / worldW));
  else forEachCopy(t, minX, maxX, draw);
  ctx.restore();
}
