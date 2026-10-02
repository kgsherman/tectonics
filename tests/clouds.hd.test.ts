/**
 * Cloud quality tiers: full-quality clouds (the default, following every climate / month / density
 * change) and standard clouds (cheaper: used while the seasons play on the map).
 */
import { Color } from 'three';
import type { Vector4 } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '../src/app/store';
import { initialState, reduce, type Action, type AppState } from '../src/app/state';
import type { RightPanel } from '../src/app/ui/rightPanel';
import type { Viewport } from '../src/app/ui/viewport';
import { ViewSync } from '../src/app/viewSync';
import type { ClimateResult, CloudSpec } from '../src/core/types';
import { STANDARD_GRID_W, GlobeClouds } from '../src/render/cloudsGlobe';
import { limitSpec } from '../src/render/cloudsJobs';
import { MapClouds } from '../src/render/cloudsMap';
import { setCloudWorkerFactory } from '../src/render/cloudsWorkerClient';
import { createSharedUniforms } from '../src/render/globeSurface';
import { CLOUDS_FRAGMENT } from '../src/render/shadersClouds';
import { mapMinScale, type MapTransform } from '../src/render/viewMapTransform';

function spec(w: number, h: number): CloudSpec {
  const n = w * h;
  const cover = new Float32Array(n), u = new Float32Array(n), v = new Float32Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      cover[i] = 0.3 + 0.4 * Math.abs(Math.sin((3 * c) / w + r / h));
      u[i] = 6 * Math.cos((Math.PI * r) / h);
      v[i] = Math.sin((6 * Math.PI * c) / w);
    }
  }
  return { w, h, cover, u, v };
}

const settle = async (busy: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && busy(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('standard-quality grids', () => {
  it('box-average the spec down to the standard grid width (wind gaps count as calm)', () => {
    const s = spec(360, 180);
    s.u![5] = NaN;
    const d = limitSpec(s, STANDARD_GRID_W);
    expect([d.w, d.h]).toEqual([180, 90]);
    expect(d.cover.length).toBe(180 * 90);
    expect(d.u!.every(Number.isFinite)).toBe(true);
    expect(d.cover[0]).toBeCloseTo((s.cover[0] + s.cover[1] + s.cover[360] + s.cover[361]) / 4, 5);
    expect(limitSpec(spec(120, 60), STANDARD_GRID_W).w).toBe(120);
  });
});

describe('GlobeClouds quality', () => {
  afterEach(() => setCloudWorkerFactory(null));

  it('renders standard clouds from a coarser grid with two detail octaves, HD clouds in full', async () => {
    setCloudWorkerFactory(null);
    const shared = createSharedUniforms(new Color(0.3, 0.5, 1));
    const clouds = new GlobeClouds(shared);
    const shown: CloudSpec[] = [];
    clouds.onShown = (c) => shown.push(c);
    const mask = (): number[] => (clouds.mesh.material.uniforms.uOctaveMask.value as Vector4).toArray();
    const gridW = (): number => (shared.uCloudGrid.value as { image: { width: number } }).image.width;

    const std = { ...spec(360, 180), quality: 'standard' as const };
    clouds.set(std);
    await settle(() => clouds.busy);
    expect(gridW()).toBe(STANDARD_GRID_W);
    expect(mask()).toEqual([1, 1, 0, 0]);
    expect(clouds.shownQuality).toBe('standard');
    expect(shown.at(-1)).toBe(std);

    const hd = { ...spec(360, 180), quality: 'high' as const };
    clouds.set(hd);
    await settle(() => clouds.busy);
    expect(gridW()).toBe(360);
    expect(mask()).toEqual([1, 1, 1, 1]);
    expect(clouds.shownQuality).toBe('high');
    expect(shown.at(-1)).toBe(hd);
    clouds.dispose();
  });

  it('masks the finest octaves in the shader', () => {
    expect(CLOUDS_FRAGMENT).toContain('uniform vec4 uOctaveMask;');
    expect(CLOUDS_FRAGMENT).toContain('* uOctaveMask;');
  });
});

describe('MapClouds quality', () => {
  class FakeCtx {
    setTransform(): void {}
    clearRect(): void {}
    putImageData(): void {}
    save(): void {}
    restore(): void {}
    beginPath(): void {}
    rect(): void {}
    clip(): void {}
    drawImage(): void {}
  }
  class FakeCanvas {
    width = 0;
    height = 0;
    getContext(): FakeCtx { return new FakeCtx(); }
  }
  const g = globalThis as unknown as { document?: unknown; ImageData?: unknown };
  const hadDoc = 'document' in g, hadImageData = 'ImageData' in g;
  afterEach(() => {
    setCloudWorkerFactory(null);
    if (!hadDoc) delete g.document;
    if (!hadImageData) delete g.ImageData;
  });

  it('rasterizes standard clouds at half size without tiles; HD at full size with tiles', async () => {
    const rasters: number[] = [];
    g.document = { createElement: () => new FakeCanvas() };
    g.ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) { rasters.push(width); } };
    setCloudWorkerFactory(null);
    const clouds = new MapClouds(() => {});
    const shown: CloudSpec[] = [];
    clouds.onShown = (c) => shown.push(c);
    const W = 400, H = 250;
    const fit = mapMinScale(W, H);
    const zoomed: MapTransform = { width: W, height: H, centerLon: 0.3, centerLat: 0.4, scale: 8 * fit };

    const std = { ...spec(72, 36), quality: 'standard' as const };
    clouds.set(std);
    await settle(() => clouds.busy);
    expect(rasters).toEqual([768]);
    expect(shown).toEqual([std]);
    clouds.setView(zoomed, 1);
    expect(clouds.pending).toBe(false);

    const hd = { ...spec(72, 36), quality: 'high' as const };
    clouds.set(hd);
    await settle(() => clouds.busy);
    expect(rasters.at(-1)).toBe(1536);
    expect(shown.at(-1)).toBe(hd);
    clouds.setView(zoomed, 1);
    expect(clouds.pending).toBe(true);
    await settle(() => clouds.pending);
    expect(clouds.lastDetailMs).toBeGreaterThan(0);
    clouds.dispose();
  });
});

describe('ViewSync: automatic full-quality clouds', () => {
  function setup() {
    const store = createStore<AppState, Action>(initialState(), reduce);
    store.dispatch({ type: 'patchView', patch: { layer: 'satellite', clouds: true } });
    const w = 36, h = 18, n = w * h;
    const field = (): Float32Array => new Float32Array(12 * n).fill(0.5);
    let climate = { id: 7, w, h, cloud: field(), windU: field(), windV: field() } as unknown as ClimateResult;
    const sent: (CloudSpec | null)[] = [];
    const viewport = {
      setClouds: (c: CloudSpec | null) => sent.push(c),
      setParticleCount: () => {},
      setVectorField: () => {},
    } as unknown as Viewport;
    const sync = new ViewSync(store, viewport, {} as RightPanel, { mesh: () => null, snapshot: () => null, climate: () => climate });
    return { store, sync, sent, setClimate: (id: number) => { climate = { ...climate, id } as ClimateResult; } };
  }

  it('sends full-quality clouds on every climate, month and density change', () => {
    const t = setup();
    t.store.dispatch({ type: 'setMonth', month: 3 });
    t.sync.weather();
    expect(t.sent.at(-1)?.quality).toBe('high');
    // Unrelated refreshes send nothing.
    const count = t.sent.length;
    t.sync.weather();
    expect(t.sent.length).toBe(count);
    t.store.dispatch({ type: 'setMonth', month: 4 });
    t.sync.weather();
    expect(t.sent.length).toBe(count + 1);
    expect(t.sent.at(-1)?.quality).toBe('high');
    t.setClimate(8);
    t.sync.weather();
    expect(t.sent.at(-1)?.quality).toBe('high');
    t.store.dispatch({ type: 'patchView', patch: { cloudDensity: 0.7 } });
    t.sync.weather();
    expect(t.sent.at(-1)?.quality).toBe('high');
    expect(t.sent.length).toBe(count + 3);
    t.store.dispatch({ type: 'patchView', patch: { layer: 'elevation' } });
    t.sync.weather();
    expect(t.sent.at(-1)).toBeNull();
  });

  it('uses standard clouds only while the seasons play on the map', () => {
    const t = setup();
    t.store.dispatch({ type: 'patchView', patch: { view: 'globe' } });
    t.store.dispatch({ type: 'setSeasonsPlaying', playing: true });
    t.sync.weather();
    expect(t.sent.at(-1)?.quality).toBe('high'); // the globe keeps full quality
    t.store.dispatch({ type: 'patchView', patch: { view: 'map' } });
    t.sync.weather();
    expect(t.sent.at(-1)?.quality).toBe('standard');
    t.store.dispatch({ type: 'setSeasonsPlaying', playing: false });
    t.sync.weather();
    expect(t.sent.at(-1)?.quality).toBe('high'); // back to full quality when the playback stops
  });
});

describe('cloud detail debug view (?cloudDebug)', () => {
  it('ships a digit font and a debug pass behind a define', async () => {
    const { GLYPH_CODES, CLOUD_DEBUG } = await import('../src/render/cloudsDebug');
    expect(CLOUD_DEBUG).toBe(false);
    expect(GLYPH_CODES).toHaveLength(11);
    expect(GLYPH_CODES[1]).toBe(2 + 8 + 16 + 128 + 1024 + 4096 + 8192 + 16384);
    expect(CLOUDS_FRAGMENT).toContain('#ifdef CLOUD_DEBUG');
    expect(CLOUDS_FRAGMENT).toContain('debugTile(st,');
  });

  it('reports fewer map raster octaves for coarser rasters', async () => {
    const { rasterOctaveLevel } = await import('../src/render/cloudsRaster');
    const world = rasterOctaveLevel(Math.PI / 768), hd = rasterOctaveLevel(Math.PI / 384 / 4);
    expect(world).toBeGreaterThan(0);
    expect(hd).toBeGreaterThanOrEqual(world);
    expect(hd).toBeLessThanOrEqual(4);
  });
});
