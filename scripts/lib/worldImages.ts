/**
 * Reference renderings of a world snapshot for the headless tool, used when the painter
 * (src/render/paint.ts) is unavailable: hypsometric elevation with hillshade, plates, crust type and
 * crust age, plus climate layers via climateImages. Plain and exact rather than pretty.
 */
import { buildMeshGridMap, meshToGrid, meshToGridNearest } from '../../src/core/grid';
import type { ClimateResult, LayerId, MeshGridMap, RGB, SphereMesh, WorldSnapshot } from '../../src/core/types';
import { BOUNDARY_CONVERGENT, BOUNDARY_DIVERGENT, BOUNDARY_TRANSFORM } from '../../src/core/types';
import { colorAt, createImage, ELEVATION_STOPS, type ColorStops, type Image } from '../png';
import { renderClimateLayer, type ClimateImageLayer } from './climateImages';

const AGE_STOPS: ColorStops = [
  [0, [230, 40, 40]], [20, [245, 150, 40]], [50, [240, 230, 80]], [90, [80, 200, 120]],
  [140, [50, 120, 200]], [200, [80, 50, 150]],
];
const CONTINENTAL_AGE: RGB = [170, 150, 120];
const BOUNDARY_COLORS: Record<number, RGB> = {
  [BOUNDARY_CONVERGENT]: [220, 30, 30],
  [BOUNDARY_DIVERGENT]: [250, 220, 40],
  [BOUNDARY_TRANSFORM]: [250, 250, 250],
};

const CLIMATE_LAYERS: ReadonlySet<string> = new Set(['temperature', 'precipitation', 'pressure', 'sst', 'wind', 'currents', 'koppen']);

export interface FallbackRender {
  image: Image;
  /** What was drawn (e.g. "hypsometric elevation" for a satellite request). */
  label: string;
}

/** Grid-map cache for repeated fallback renders of the same mesh/size. */
const mapCache = new Map<string, MeshGridMap>();
function gridMap(mesh: SphereMesh, W: number, H: number): MeshGridMap {
  const key = `${mesh.n}|${W}x${H}`;
  let m = mapCache.get(key);
  if (!m) {
    m = buildMeshGridMap(mesh, W, H);
    mapCache.clear();
    mapCache.set(key, m);
  }
  return m;
}

/** Render `layer` without the painter. Returns null when the layer needs data that is missing. */
export function renderFallbackLayer(
  layer: LayerId, mesh: SphereMesh, snap: WorldSnapshot | null, climate: ClimateResult | null,
  W: number, H: number, month: number, seaLevel: number,
): FallbackRender | null {
  if (CLIMATE_LAYERS.has(layer)) {
    if (!climate) return null;
    return { image: renderClimateLayer(layer as ClimateImageLayer, climate, month, W, H), label: `climate grid ${climate.w}x${climate.h} colormap` };
  }
  if (!snap) return null;
  const map = gridMap(mesh, W, H);
  switch (layer) {
    case 'satellite':
    case 'elevation':
      return { image: elevationImage(meshToGrid(map, snap.elev), W, H, seaLevel), label: 'hypsometric elevation + hillshade' };
    case 'plates': {
      const p = meshToGridNearest(map, snap.plate);
      const b = meshToGridNearest(map, snap.boundary);
      const img = createImage(W, H);
      for (let i = 0; i < W * H; i++) {
        const c = BOUNDARY_COLORS[b[i]] ?? snap.plates[p[i]]?.color ?? [128, 128, 128];
        setPx(img, i, c);
      }
      return { image: img, label: 'plate colors + boundary types' };
    }
    case 'crust': {
      const cr = meshToGridNearest(map, snap.crust);
      const img = createImage(W, H);
      for (let i = 0; i < W * H; i++) setPx(img, i, cr[i] ? [190, 160, 110] : [40, 80, 150]);
      return { image: img, label: 'crust type' };
    }
    case 'crustAge': {
      const age = meshToGrid(map, snap.age);
      const cr = meshToGridNearest(map, snap.crust);
      const img = createImage(W, H);
      const c = [0, 0, 0];
      for (let i = 0; i < W * H; i++) {
        if (cr[i]) setPx(img, i, CONTINENTAL_AGE);
        else {
          colorAt(AGE_STOPS, age[i], c);
          setPx(img, i, c);
        }
      }
      return { image: img, label: 'oceanic crust age' };
    }
    default:
      return null;
  }
}

function setPx(img: Image, i: number, c: ArrayLike<number>): void {
  img.rgba[4 * i] = c[0];
  img.rgba[4 * i + 1] = c[1];
  img.rgba[4 * i + 2] = c[2];
}

/** Hypsometric colors with a simple NW-lit hillshade on land (metric-correct slopes). */
export function elevationImage(elev: Float32Array, W: number, H: number, seaLevel: number): Image {
  const img = createImage(W, H);
  const c = [0, 0, 0];
  const dyM = (Math.PI * 6371e3) / H;
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) * Math.PI) / H;
    const dxM = Math.max(1e3, ((2 * Math.PI * 6371e3) / W) * Math.cos(lat));
    const yn = Math.max(0, y - 1), ys = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = elev[i] - seaLevel;
      colorAt(ELEVATION_STOPS, e, c);
      if (e > 0) {
        const xe = (x + 1) % W, xw = (x - 1 + W) % W;
        // Slopes (east, north), exaggerated 20× for visibility; light from the NW, 45° up:
        // L = (−½, ½, √½), normal ∝ (−gx, −gy, 1); flat ground → shade 1.
        const gx = (20 * (elev[y * W + xe] - elev[y * W + xw])) / (2 * dxM);
        const gy = (20 * (elev[yn * W + x] - elev[ys * W + x])) / ((ys - yn) * dyM);
        const lit = (0.5 * gx - 0.5 * gy + Math.SQRT1_2) / Math.sqrt(gx * gx + gy * gy + 1) / Math.SQRT1_2;
        const shade = Math.max(0.4, Math.min(1.3, lit));
        c[0] *= shade;
        c[1] *= shade;
        c[2] *= shade;
      }
      setPx(img, i, [Math.min(255, c[0]), Math.min(255, c[1]), Math.min(255, c[2])]);
    }
  }
  return img;
}
