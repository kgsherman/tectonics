/**
 * Enclosed water: connected components of sea pixels (H ≤ sea level, 4-connected, longitude
 * wraps). Components smaller than a size threshold are lagoons / flooded coastal hollows rather than
 * open sea: the satellite paints them as still, dark lagoon water instead of the shallow-shelf ramp
 * (which would outline every small pit with a turquoise rim).
 */
import type { PaintCache } from './paintCache';
import type { HeightField } from './terrain';

/** Minimum open-sea component size, in pixels of a 2048-wide raster (scaled with area). */
const OPEN_SEA_MIN_PX_2048 = 400;

/** 1 = pixel belongs to a small enclosed water body. */
export function enclosedWater(hf: HeightField, sea: number, heightKey: string, cache: PaintCache): Uint8Array {
  return cache.getOrBuild(`enclosed|${heightKey}|${sea}`, () => build(hf, sea));
}

function build(hf: HeightField, sea: number): Uint8Array {
  const { w, h, height } = hf;
  const n = w * h;
  const minPx = Math.max(8, Math.round(OPEN_SEA_MIN_PX_2048 * ((w * h) / (2048 * 1024))));
  const out = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s] || height[s] > sea) continue;
    let top = 0, count = 0;
    stack[top++] = s;
    seen[s] = 1;
    while (top > 0) {
      const p = stack[--top];
      members[count++] = p;
      const r = (p / w) | 0, c = p - r * w;
      const left = c > 0 ? p - 1 : p + w - 1;
      const right = c < w - 1 ? p + 1 : p - w + 1;
      if (!seen[left] && height[left] <= sea) { seen[left] = 1; stack[top++] = left; }
      if (!seen[right] && height[right] <= sea) { seen[right] = 1; stack[top++] = right; }
      if (r > 0 && !seen[p - w] && height[p - w] <= sea) { seen[p - w] = 1; stack[top++] = p - w; }
      if (r < h - 1 && !seen[p + w] && height[p + w] <= sea) { seen[p + w] = 1; stack[top++] = p + w; }
    }
    if (count < minPx) for (let k = 0; k < count; k++) out[members[k]] = 1;
  }
  return out;
}
