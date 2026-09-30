/**
 * Views demo: exercises GlobeView and MapView with synthetic data built from core noise only
 * (continents + ranges height map, satellite-like/elevation/test-pattern images, zonal winds,
 * ocean gyres with NaN on land, clouds, arrows, markers, brush, overlay, lighting, relief).
 * Debug handle: window.__demo.
 */
import { DEG } from '../src/core/constants';
import { omegaFromDirection } from '../src/core/math3';
import { createNoise3, fbm3, ridged3 } from '../src/core/noise';
import { sampleGrid } from '../src/core/grid';
import type {
  ArrowSpec, CloudSpec, LightingMode, MarkerSpec, RGB, VectorFieldSpec, WorldPointerEvent, WorldView,
} from '../src/core/types';
import { GlobeView } from '../src/render/globeView';
import { MapView } from '../src/render/mapView';

const params = new URLSearchParams(location.search);
const W = Number(params.get('w') ?? 1024);
const H = W / 2;
const SEED = Number(params.get('seed') ?? 7);

/* ------------------------------------------------------------------ */
/* Synthetic planet                                                     */
/* ------------------------------------------------------------------ */

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

function buildHeight(): Float32Array {
  const nC = createNoise3(SEED), nW = createNoise3(SEED + 1), nM = createNoise3(SEED + 2), nD = createNoise3(SEED + 3);
  const out = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / H;
    const cl = Math.cos(lat), sl = Math.sin(lat);
    for (let c = 0; c < W; c++) {
      const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / W;
      const x = cl * Math.cos(lon), y = cl * Math.sin(lon), z = sl;
      // Domain-warped continents.
      const wx = fbm3(nW, x * 1.7, y * 1.7, z * 1.7, 3), wy = fbm3(nW, y * 1.7 + 5, z * 1.7, x * 1.7, 3);
      const qx = x + 0.35 * wx, qy = y + 0.35 * wy, qz = z;
      const cont = fbm3(nC, qx * 1.25, qy * 1.25, qz * 1.25, 6) + 0.05;
      const detail = fbm3(nD, x * 9, y * 9, z * 9, 4);
      let e: number;
      if (cont > 0) {
        const belt = smooth(0.15, 0.55, fbm3(nM, qx * 1.1 + 3, qy * 1.1, qz * 1.1, 3) * 0.5 + 0.5);
        const ridge = ridged3(nM, qx * 3.4, qy * 3.4, qz * 3.4, 6);
        e = 120 + 700 * smooth(0, 0.25, cont) + 5200 * belt * Math.pow(ridge, 2.4) * smooth(0.02, 0.12, cont) + 260 * detail;
      } else {
        const abyss = smooth(0, 0.16, -cont);
        const midRidge = ridged3(nM, x * 2.2 + 7, y * 2.2, z * 2.2, 3);
        e = -120 - 4400 * abyss + 1400 * abyss * Math.pow(midRidge, 3) + 250 * detail;
      }
      out[r * W + c] = e;
    }
  }
  return out;
}

type Img = Uint8ClampedArray;

function satelliteImage(h: Float32Array, sea: number): Img {
  const n = createNoise3(SEED + 9);
  const img = new Uint8ClampedArray(W * H * 4);
  for (let r = 0; r < H; r++) {
    const lat = Math.PI / 2 - ((r + 0.5) * Math.PI) / H;
    const alat = Math.abs(lat) / DEG;
    for (let c = 0; c < W; c++) {
      const lon = -Math.PI + ((c + 0.5) * 2 * Math.PI) / W;
      const i = r * W + c;
      const e = h[i] - sea;
      let R: number, G: number, B: number;
      if (e <= 0) {
        const d = smooth(0, 3500, -e);
        R = mix(38, 6, d); G = mix(118, 22, d); B = mix(138, 58, d);
        if (alat > 72) { const ice = smooth(72, 78, alat); R = mix(R, 225, ice); G = mix(G, 232, ice); B = mix(B, 240, ice); }
      } else {
        const x = Math.cos(lat) * Math.cos(lon), y = Math.cos(lat) * Math.sin(lon), z = Math.sin(lat);
        const moist = 0.5 + 0.5 * fbm3(n, x * 3, y * 3, z * 3, 4) - 0.55 * Math.exp(-(((alat - 24) / 9) ** 2)) + 0.35 * Math.exp(-((alat / 10) ** 2));
        const green: RGB = alat < 18 ? [34, 72, 28] : alat < 50 ? [72, 98, 48] : [48, 70, 44];
        const dry: RGB = [196, 168, 118];
        const m = smooth(0.25, 0.6, moist);
        R = mix(dry[0], green[0], m); G = mix(dry[1], green[1], m); B = mix(dry[2], green[2], m);
        const rock = smooth(1800, 3200, e);
        R = mix(R, 112, rock); G = mix(G, 102, rock); B = mix(B, 92, rock);
        const tundra = smooth(58, 66, alat);
        R = mix(R, 132, tundra); G = mix(G, 124, tundra); B = mix(B, 104, tundra);
        const snow = Math.max(smooth(3600, 4600, e + 60 * (alat - 30)), smooth(68, 74, alat));
        R = mix(R, 242, snow); G = mix(G, 245, snow); B = mix(B, 250, snow);
      }
      img[4 * i] = R; img[4 * i + 1] = G; img[4 * i + 2] = B; img[4 * i + 3] = 255;
    }
  }
  return img;
}

function elevationImage(h: Float32Array, sea: number): Img {
  const stops: Array<[number, RGB]> = [
    [-6000, [8, 20, 60]], [-3000, [25, 60, 130]], [-200, [70, 140, 200]], [0, [150, 205, 230]],
    [1, [60, 130, 70]], [500, [140, 170, 90]], [1500, [200, 180, 110]], [3000, [150, 110, 80]], [5000, [245, 245, 245]],
  ];
  const img = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const e = h[i] - sea;
    let k = 0;
    while (k < stops.length - 2 && e > stops[k + 1][0]) k++;
    const [e0, c0] = stops[k], [e1, c1] = stops[k + 1];
    const t = Math.min(1, Math.max(0, (e - e0) / (e1 - e0)));
    img[4 * i] = mix(c0[0], c1[0], t); img[4 * i + 1] = mix(c0[1], c1[1], t); img[4 * i + 2] = mix(c0[2], c1[2], t); img[4 * i + 3] = 255;
  }
  return img;
}

/** Quadrant colors (NE red, NW green, SE blue, SW yellow), 30° lines, cyan lon +90°, magenta lat +45°. */
function testPattern(): Img {
  const img = new Uint8ClampedArray(W * H * 4);
  for (let r = 0; r < H; r++) {
    const lat = 90 - ((r + 0.5) * 180) / H;
    for (let c = 0; c < W; c++) {
      const lon = -180 + ((c + 0.5) * 360) / W;
      const i = 4 * (r * W + c);
      let col: RGB = lat >= 0 ? (lon >= 0 ? [200, 60, 60] : [60, 170, 70]) : lon >= 0 ? [60, 90, 200] : [210, 190, 60];
      const check = (Math.floor((lon + 180) / 10) + Math.floor((lat + 90) / 10)) % 2 === 0;
      if (check) col = [col[0] * 0.8, col[1] * 0.8, col[2] * 0.8];
      const px = 360 / W;
      if (Math.abs(((lon + 180) % 30) - 15) > 15 - px || Math.abs(((lat + 90) % 30) - 15) > 15 - px) col = [20, 20, 20];
      if (Math.abs(lon - 90) < 1.2 * px) col = [0, 255, 255];
      if (Math.abs(lat - 45) < 1.2 * px) col = [255, 0, 255];
      img[i] = col[0]; img[i + 1] = col[1]; img[i + 2] = col[2]; img[i + 3] = 255;
    }
  }
  return img;
}

/** Transparent overlay: 30° graticule and the coastline at the current sea level. */
function overlayImage(h: Float32Array, sea: number): Img {
  const img = new Uint8ClampedArray(W * H * 4);
  const px = 360 / W;
  for (let r = 0; r < H; r++) {
    const lat = 90 - ((r + 0.5) * 180) / H;
    for (let c = 0; c < W; c++) {
      const lon = -180 + ((c + 0.5) * 360) / W;
      const i = r * W + c;
      const land = h[i] > sea;
      const right = h[r * W + ((c + 1) % W)] > sea;
      const down = r + 1 < H ? h[i + W] > sea : land;
      if (land !== right || land !== down) {
        img.set([255, 255, 255, 230], 4 * i);
      } else if (Math.abs(((lon + 180) % 30) - 15) > 15 - px || Math.abs(((lat + 90) % 30) - 15) > 15 - px) {
        img.set([255, 220, 120, 150], 4 * i);
      }
    }
  }
  return img;
}

const GW = 360, GH = 180;
const gLat = (r: number): number => Math.PI / 2 - ((r + 0.5) * Math.PI) / GH;
const gLon = (c: number): number => -Math.PI + ((c + 0.5) * 2 * Math.PI) / GW;

/** Zonal three-cell winds + meridional convergence + a divergence-free eddy field. */
function windField(): VectorFieldSpec {
  const prof: Array<[number, number, number]> = [
    [-90, 0, 0], [-75, -3, -1], [-60, 3, 0], [-45, 10, 1.5], [-30, 0, 0], [-15, -7, 2.5], [0, -4, 0],
    [15, -7, -2.5], [30, 0, 0], [45, 10, -1.5], [60, 3, 0], [75, -3, 1], [90, 0, 0],
  ];
  const n = createNoise3(SEED + 20);
  const psi = new Float32Array(GW * GH);
  for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
    const la = gLat(r), lo = gLon(c);
    psi[r * GW + c] = fbm3(n, Math.cos(la) * Math.cos(lo) * 2.5, Math.cos(la) * Math.sin(lo) * 2.5, Math.sin(la) * 2.5, 3);
  }
  const u = new Float32Array(GW * GH), v = new Float32Array(GW * GH);
  const dPhi = Math.PI / GH, dLam = (2 * Math.PI) / GW;
  for (let r = 0; r < GH; r++) {
    const latD = gLat(r) / DEG;
    let k = 0;
    while (k < prof.length - 2 && latD > prof[k + 1][0]) k++;
    const t = (latD - prof[k][0]) / (prof[k + 1][0] - prof[k][0]);
    const u0 = mix(prof[k][1], prof[k + 1][1], t), v0 = mix(prof[k][2], prof[k + 1][2], t);
    const cl = Math.max(0.05, Math.cos(gLat(r)));
    for (let c = 0; c < GW; c++) {
      const rn = Math.max(0, r - 1), rs = Math.min(GH - 1, r + 1);
      const dpsiDy = (psi[rn * GW + c] - psi[rs * GW + c]) / ((rs - rn) * dPhi);
      const dpsiDx = (psi[r * GW + ((c + 1) % GW)] - psi[r * GW + ((c + GW - 1) % GW)]) / (2 * dLam * cl);
      u[r * GW + c] = u0 - 0.9 * dpsiDy;
      v[r * GW + c] = v0 + 0.9 * dpsiDx;
    }
  }
  return { kind: 'wind', w: GW, h: GH, u, v };
}

/** Basin gyres from a noise streamfunction plus a circumpolar current; NaN over land. */
function currentField(h: Float32Array, sea: number): VectorFieldSpec {
  const n = createNoise3(SEED + 30);
  const psi = new Float32Array(GW * GH);
  for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) {
    const la = gLat(r), lo = gLon(c);
    psi[r * GW + c] = Math.sin(3 * la) * 0.6 + fbm3(n, Math.cos(la) * Math.cos(lo) * 2, Math.cos(la) * Math.sin(lo) * 2, Math.sin(la) * 2, 3);
  }
  const u = new Float32Array(GW * GH), v = new Float32Array(GW * GH);
  const dPhi = Math.PI / GH, dLam = (2 * Math.PI) / GW;
  for (let r = 0; r < GH; r++) {
    const la = gLat(r), cl = Math.max(0.05, Math.cos(la));
    for (let c = 0; c < GW; c++) {
      const i = r * GW + c;
      if (sampleGrid(h, W, H, la, gLon(c)) > sea) {
        u[i] = NaN;
        v[i] = NaN;
        continue;
      }
      const rn = Math.max(0, r - 1), rs = Math.min(GH - 1, r + 1);
      const dpsiDy = (psi[rn * GW + c] - psi[rs * GW + c]) / ((rs - rn) * dPhi);
      const dpsiDx = (psi[r * GW + ((c + 1) % GW)] - psi[r * GW + ((c + GW - 1) % GW)]) / (2 * dLam * cl);
      u[i] = -0.07 * dpsiDy + 0.3 * Math.exp(-(((la / DEG + 55) / 7) ** 2));
      v[i] = 0.07 * dpsiDx;
    }
  }
  return { kind: 'current', w: GW, h: GH, u, v };
}

function clouds(wind: VectorFieldSpec): CloudSpec {
  const n = createNoise3(SEED + 40);
  const cover = new Float32Array(GW * GH);
  for (let r = 0; r < GH; r++) {
    const la = gLat(r), a = Math.abs(la) / DEG;
    for (let c = 0; c < GW; c++) {
      const lo = gLon(c);
      const f = fbm3(n, Math.cos(la) * Math.cos(lo) * 3, Math.cos(la) * Math.sin(lo) * 3, Math.sin(la) * 3, 4);
      const base = 0.3 + 0.35 * Math.exp(-((la / DEG / 7) ** 2)) + 0.35 * Math.exp(-(((a - 58) / 11) ** 2)) - 0.25 * Math.exp(-(((a - 24) / 8) ** 2));
      cover[r * GW + c] = Math.min(1, Math.max(0, base + 0.5 * f));
    }
  }
  return { w: GW, h: GH, cover, u: wind.u, v: wind.v };
}

const TEST_MARKERS: MarkerSpec[] = [
  { lat: 90 * DEG, lon: 0, color: [230, 60, 60], radiusPx: 6, label: 'N pole' },
  { lat: -90 * DEG, lon: 0, color: [170, 90, 230], radiusPx: 6, label: 'S pole' },
  { lat: 0, lon: 90 * DEG, color: [60, 140, 255], radiusPx: 6, label: '0°, 90°E' },
  { lat: 0, lon: 0, color: [250, 250, 250], radiusPx: 5, label: '0°, 0°' },
  { lat: 0, lon: -90 * DEG, color: [80, 220, 120], radiusPx: 5, label: '0°, 90°W' },
  { lat: 45 * DEG, lon: 180 * DEG, color: [250, 220, 60], radiusPx: 5, label: '45°N 180°', highlighted: true },
];

const TEST_ARROWS: ArrowSpec[] = [
  { lat: 0, lon: 170 * DEG, east: 1, north: 0, length: 25 * DEG, color: [235, 70, 60] },
  { lat: 72 * DEG, lon: -30 * DEG, east: 0, north: 1, length: 32 * DEG, color: [90, 220, 110] },
  { lat: -30 * DEG, lon: 60 * DEG, east: 0.6, north: 0.8, length: 14 * DEG, color: [255, 160, 40], highlighted: true },
  { lat: 20 * DEG, lon: -100 * DEG, east: -1, north: -0.3, length: 6 * DEG, color: [120, 180, 255], id: 4 },
];

/** A sparse field of small ω×p plate-motion arrows (editor Motion tool preview). */
function arrowField(): ArrowSpec[] {
  const pole = omegaFromDirection([1, 0, 0], 0, 1, 50);
  const out: ArrowSpec[] = [];
  for (let la = -75; la <= 75; la += 15) {
    const step = 15 / Math.max(0.3, Math.cos(la * DEG));
    for (let lo = -180; lo < 180; lo += step) {
      const lat = la * DEG, lon = lo * DEG;
      const p = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      const vel = [pole[1] * p[2] - pole[2] * p[1], pole[2] * p[0] - pole[0] * p[2], pole[0] * p[1] - pole[1] * p[0]];
      const east = -Math.sin(lon) * vel[0] + Math.cos(lon) * vel[1];
      const north = -Math.sin(lat) * Math.cos(lon) * vel[0] - Math.sin(lat) * Math.sin(lon) * vel[1] + Math.cos(lat) * vel[2];
      const sp = Math.hypot(east, north);
      if (sp < 1e-6) continue;
      // sp = |ω×p| in rad/Myr on the unit sphere → km/Myr; draw 0.1° of arc per km/Myr (5° at 5 cm/yr).
      out.push({ lat, lon, east, north, length: sp * 6371 * 0.1 * DEG, color: [255, 255, 255] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                               */
/* ------------------------------------------------------------------ */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = $('status');

function start(): void {
  const t0 = performance.now();
  const height = buildHeight();
  const genMs = performance.now() - t0;
  const wind = windField();
  const cloudSpec = clouds(wind);
  $('busy').remove();

  const globe = new GlobeView($('globe'));
  let map: MapView | null = null;
  let active: WorldView = globe;
  const views = (): WorldView[] => (map ? [globe, map] : [globe]);

  const state = {
    layer: 'satellite', sea: 0, heightOn: true, overlay: false, graticule: true,
    lighting: 'relief' as LightingMode['mode'], decl: 15 * DEG, relief: 1,
    particles: 'wind' as 'none' | 'wind' | 'current', count: 8000, clouds: true,
    markers: true, arrows: true, arrowField: false, mode: 'navigate' as 'navigate' | 'paint', brushDeg: 5, brushOn: true,
  };
  const painted: MarkerSpec[] = [];
  let current: VectorFieldSpec | null = null;

  const applyImage = (v: WorldView): void => {
    const img = state.layer === 'test' ? testPattern() : state.layer === 'elevation' ? elevationImage(height, state.sea) : satelliteImage(height, state.sea);
    v.setBaseImage(img, W, H);
  };
  const applyAll = (v: WorldView): void => {
    applyImage(v);
    v.setSeaLevel(state.sea);
    v.setHeightMap(state.heightOn ? height : null, W, H);
    v.setOverlayImage(state.overlay ? overlayImage(height, state.sea) : null, W, H);
    (v as GlobeView | MapView).setGraticule(state.graticule, 15);
    v.setLighting(state.lighting === 'sun' ? { mode: 'sun', declination: state.decl } : { mode: state.lighting });
    v.setReliefScale(state.relief);
    (v as GlobeView | MapView).setParticleCount(state.count);
    v.setVectorField(current);
    v.setClouds(state.clouds ? cloudSpec : null);
    v.setMarkers([...(state.markers ? TEST_MARKERS : []), ...painted]);
    v.setArrows([...(state.arrows ? TEST_ARROWS : []), ...(state.arrowField ? arrowField() : [])]);
    v.setInteractionMode(state.mode);
  };
  const updateField = (): void => {
    current = state.particles === 'wind' ? wind : state.particles === 'current' ? currentField(height, state.sea) : null;
    for (const v of views()) v.setVectorField(current);
  };

  let hover = '—';
  const onPointer = (e: WorldPointerEvent): void => {
    hover = e.point ? `${(e.point.lat / DEG).toFixed(2)}°, ${(e.point.lon / DEG).toFixed(2)}°` : '—';
    for (const v of views()) v.setBrushCursor(state.brushOn && e.point && e.type !== 'leave' ? { point: e.point, radius: state.brushDeg * DEG, color: [255, 230, 120] } : null);
    if (state.mode === 'paint' && e.point && (e.type === 'down' || e.type === 'move') && (e.buttons & 1)) {
      painted.push({ lat: e.point.lat, lon: e.point.lon, color: [255, 120, 200], radiusPx: 2.5 });
      for (const v of views()) v.setMarkers([...(state.markers ? TEST_MARKERS : []), ...painted]);
    }
  };
  globe.onPointer(onPointer);
  updateField();
  applyAll(globe);

  const ensureMap = (): MapView => {
    if (!map) {
      map = new MapView($('map'));
      map.onPointer(onPointer);
      applyAll(map);
    }
    return map;
  };
  const showView = (kind: 'globe' | 'map'): void => {
    $('globe').style.display = kind === 'globe' ? '' : 'none';
    $('map').style.display = kind === 'map' ? '' : 'none';
    active = kind === 'globe' ? globe : ensureMap();
    active.resize();
    for (const b of $('viewSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === kind);
  };

  const seg = (id: string, fn: (v: string) => void): void => {
    $(id).addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      if (!b?.dataset.v) return;
      for (const x of $(id).querySelectorAll('button')) x.classList.toggle('on', x === b);
      fn(b.dataset.v);
    });
  };
  const input = (id: string, fn: (el: HTMLInputElement & HTMLSelectElement) => void): void => {
    $(id).addEventListener('input', (ev) => fn(ev.target as HTMLInputElement & HTMLSelectElement));
  };
  seg('viewSeg', (v) => showView(v as 'globe' | 'map'));
  seg('lightSeg', (v) => {
    state.lighting = v as LightingMode['mode'];
    for (const x of views()) x.setLighting(state.lighting === 'sun' ? { mode: 'sun', declination: state.decl } : { mode: state.lighting });
  });
  seg('modeSeg', (v) => {
    state.mode = v as 'navigate' | 'paint';
    for (const x of views()) x.setInteractionMode(state.mode);
  });
  input('layer', (el) => { state.layer = el.value; for (const v of views()) applyImage(v); });
  input('height', (el) => { state.heightOn = el.checked; for (const v of views()) v.setHeightMap(state.heightOn ? height : null, W, H); });
  input('overlay', (el) => { state.overlay = el.checked; for (const v of views()) v.setOverlayImage(state.overlay ? overlayImage(height, state.sea) : null, W, H); });
  input('graticule', (el) => { state.graticule = el.checked; for (const v of views()) (v as GlobeView | MapView).setGraticule(state.graticule, 15); });
  input('sea', (el) => {
    state.sea = Number(el.value);
    for (const v of views()) {
      v.setSeaLevel(state.sea);
      applyImage(v);
      if (state.overlay) v.setOverlayImage(overlayImage(height, state.sea), W, H);
    }
    if (state.particles === 'current') updateField();
  });
  input('decl', (el) => {
    state.decl = Number(el.value) * DEG;
    if (state.lighting === 'sun') for (const v of views()) v.setLighting({ mode: 'sun', declination: state.decl });
  });
  input('relief', (el) => { state.relief = Number(el.value); for (const v of views()) v.setReliefScale(state.relief); });
  input('particles', (el) => { state.particles = el.value as typeof state.particles; updateField(); });
  input('count', (el) => { state.count = Number(el.value); for (const v of views()) (v as GlobeView | MapView).setParticleCount(state.count); });
  input('clouds', (el) => { state.clouds = el.checked; for (const v of views()) v.setClouds(state.clouds ? cloudSpec : null); });
  input('markers', (el) => { state.markers = el.checked; for (const v of views()) v.setMarkers([...(state.markers ? TEST_MARKERS : []), ...painted]); });
  const arrowsNow = (): ArrowSpec[] => [...(state.arrows ? TEST_ARROWS : []), ...(state.arrowField ? arrowField() : [])];
  input('arrows', (el) => { state.arrows = el.checked; for (const v of views()) v.setArrows(arrowsNow()); });
  input('arrowField', (el) => { state.arrowField = el.checked; for (const v of views()) v.setArrows(arrowsNow()); });
  input('brush', (el) => { state.brushDeg = Number(el.value); });
  input('brushOn', (el) => { state.brushOn = el.checked; if (!el.checked) for (const v of views()) v.setBrushCursor(null); });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'g' || e.key === 'G') showView('globe');
    if (e.key === 'm' || e.key === 'M') showView('map');
  });

  // FPS meter (requestAnimationFrame cadence).
  let frames = 0, last = performance.now(), fps = 0;
  const tick = (): void => {
    frames++;
    const now = performance.now();
    if (now - last >= 500) {
      fps = (frames * 1000) / (now - last);
      frames = 0;
      last = now;
      status.textContent = `${active.kind}  ${fps.toFixed(0)} fps\nhover ${hover}\nplanet ${W}x${H} in ${genMs.toFixed(0)} ms`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  (window as unknown as { __demo: unknown }).__demo = {
    globe, get map() { return ensureMap(); }, get active() { return active; }, showView, state, height, W, H,
    fps: () => fps,
  };
}

// Let the "Generating…" message paint before the synchronous generation starts.
setTimeout(start, 30);
