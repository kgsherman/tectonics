/**
 * Cloud shell above the globe surface (see shadersClouds.ts / cloudsField.ts for the model):
 * coverage-driven, domain-warped multi-octave noise (a smooth shape volume and a detail volume with
 * analytic gradients), advected by the wind, with storm-track cyclones, regime-dependent texture
 * (billowy convection, cellular stratocumulus, fibrous cirrus), sun/relief lighting and soft ground
 * shadows.
 *
 * Nothing expensive runs on the main thread: the regime grids (per climate / month / density) and
 * the noise volumes (once) come from the cloud worker (cloudsWorkerClient.ts); set() returns at
 * once and the new grids crossfade in over TRANSITION_MS when they land.
 */
import {
  ClampToEdgeWrapping, Data3DTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, Mesh, NoColorSpace,
  NormalBlending, RepeatWrapping, RGBAFormat, ShaderMaterial, SphereGeometry, UnsignedByteType, Vector3, Vector4,
} from 'three';
import type { Camera, Texture } from 'three';
import type { CloudQuality, CloudSpec } from '../core/types';
import type { CloudGridsResult } from './cloudsJobs';
import { CLOUD_DEBUG } from './cloudsDebug';
import { noiseDrift } from './cloudsField';
import { CLOUD_FLOW, createCycloneMemo, CYCLONE_COUNT, CYCLONE_STRIDE, cycloneStates, type CloudClimate } from './cloudsModel';
import type { CloudNoiseVolume } from './cloudsNoise';
import { cloudWorker } from './cloudsWorkerClient';
import { GridTextureSlot } from './globeTextures';
import type { SharedUniforms } from './globeSurface';
import { CLOUDS_FRAGMENT, CLOUDS_VERTEX } from './shadersClouds';

/**
 * Flow-map cycle length, seconds. The two phases are half a cycle apart, so they disagree by
 * CLOUD_FLOW·cycle/2 of drift (0.06 rad at 10 m/s): large structures morph smoothly while
 * mesoscale detail renews every cycle (small clouds evolve faster).
 */
const CLOUD_CYCLE = 24;
/** Effective cloud height for ground shadows (planet radii; the shell itself floats higher for parallax). */
const SHADOW_HEIGHT = 0.004;
/** Ground darkening under thick cloud (sun lighting; relief lighting uses 60 % of it). */
const SHADOW_STRENGTH = 0.42;
/** Crossfade from the previous grids after an update (month / density / climate change), ms. */
const TRANSITION_MS = 900;
/**
 * Standard-quality clouds (CloudQuality): regime grids at most this wide (2°; the worker job is ~6×
 * cheaper than at 1°) and only the two coarse detail octaves (the finer two are skipped per pixel).
 */
export const STANDARD_GRID_W = 180;
const OCTAVES_STANDARD: [number, number, number, number] = [1, 1, 0, 0];
const OCTAVES_HIGH: [number, number, number, number] = [1, 1, 1, 1];

/** RGBA8 equirect grid texture (regime grid), linear filtered, longitude repeats. */
class RgbaGridSlot {
  texture: DataTexture | null = null;
  private w = 0;
  private h = 0;

  set(data: Uint8Array, w: number, h: number): void {
    if (!this.texture || w !== this.w || h !== this.h) {
      this.dispose();
      const tex = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
      tex.colorSpace = NoColorSpace;
      tex.wrapS = RepeatWrapping;
      tex.wrapT = ClampToEdgeWrapping;
      tex.magFilter = LinearFilter;
      tex.minFilter = LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = false;
      tex.unpackAlignment = 4;
      tex.needsUpdate = true;
      this.texture = tex;
      this.w = w;
      this.h = h;
      return;
    }
    this.texture.image = { data, width: w, height: h };
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture?.dispose();
    this.texture = null;
    this.w = this.h = 0;
  }
}

/** Current + previous texture slot pair (crossfades). */
interface SlotSet {
  grid: RgbaGridSlot;
  aux: RgbaGridSlot;
  wind: GridTextureSlot;
}

function newSlots(): SlotSet {
  return { grid: new RgbaGridSlot(), aux: new RgbaGridSlot(), wind: new GridTextureSlot('rg16f') };
}

function disposeSlots(s: SlotSet): void {
  s.grid.dispose();
  s.aux.dispose();
  s.wind.dispose();
}

interface Volumes {
  noise: Data3DTexture;
  detail: Data3DTexture;
  cells: Data3DTexture;
}

let volumes: Volumes | null = null;
let volumesPromise: Promise<Volumes | null> | null = null;
let volumeUsers = 0;

function volumeTexture(vol: CloudNoiseVolume): Data3DTexture {
  const tex = new Data3DTexture(vol.data, vol.size, vol.size, vol.size);
  tex.format = RGBAFormat;
  tex.type = UnsignedByteType;
  tex.colorSpace = NoColorSpace;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Shared noise textures (built by the cloud worker once, refcounted across globes). */
function acquireVolumes(): Promise<Volumes | null> {
  volumeUsers++;
  if (volumes) return Promise.resolve(volumes);
  volumesPromise ??= cloudWorker().run({ kind: 'volumes' }, 'cloud-volumes').then((r) => {
    volumesPromise = null;
    if (!r || volumeUsers === 0) return null;
    volumes = { noise: volumeTexture(r.noise), detail: volumeTexture(r.detail), cells: volumeTexture(r.cells) };
    return volumes;
  });
  return volumesPromise;
}

function releaseVolumes(): void {
  volumeUsers = Math.max(0, volumeUsers - 1);
  if (volumeUsers === 0 && volumes) {
    volumes.noise.dispose();
    volumes.detail.dispose();
    volumes.cells.dispose();
    volumes = null;
  }
}

let instances = 0;

export class GlobeClouds {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;
  private cur: SlotSet = newSlots();
  private prev: SlotSet = newSlots();
  private readonly cyc = new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE);
  /** cos(2.7 R) per cyclone: its reach (shader early-out). */
  private readonly cycCut = new Float32Array(CYCLONE_COUNT).fill(2);
  private readonly drift = [new Vector3(), new Vector3(), new Vector3()];
  private readonly driftTmp = [0, 0, 0];
  /** Genesis parameters of the storms on screen (kept across cloud-spec changes: no teleporting). */
  private readonly memo = createCycloneMemo();
  private readonly upLeft = new Vector3();
  private readonly right = new Vector3();
  private readonly channel = `globe-clouds-${++instances}`;
  private volumesState: 'none' | 'loading' | 'ready' = 'none';
  /** Cover of the displayed grids (cyclone genesis prefers cloudy longitudes). */
  private spec: CloudSpec | null = null;
  private climate: CloudClimate | null = null;
  private time = 0;
  /** Grid jobs in flight. */
  private jobs = 0;
  /** Sequence of set() calls; results of calls older than the last clear are dropped. */
  private seq = 0;
  private clearedAt = 0;
  /** performance.now() when the current crossfade started (−1: none). */
  private transitionStart = -1;
  private disposed = false;
  /** Worker compute time of the last grid job (ms, diagnostics). */
  lastJobMs = 0;
  /** Quality of the clouds on screen (null: none yet). */
  shownQuality: CloudQuality | null = null;
  /** Called with the spec given to set() once its clouds are on screen. */
  onShown: ((clouds: CloudSpec) => void) | null = null;
  /** Spec whose grids landed while the noise volumes were still loading (announced when they are). */
  private shownPending: CloudSpec | null = null;
  private readonly shared: SharedUniforms;

  constructor(shared: SharedUniforms) {
    this.shared = shared;
    const material = new ShaderMaterial({
      defines: CLOUD_DEBUG ? { CLOUD_DEBUG: 1 } : {},
      uniforms: {
        uShellRadius: { value: 1.008 },
        uGrid: { value: null as Texture | null },
        uAux: { value: null as Texture | null },
        uGridPrev: { value: null as Texture | null },
        uAuxPrev: { value: null as Texture | null },
        uWind: { value: null as Texture | null },
        uWindPrev: { value: null as Texture | null },
        uMix: { value: 1 },
        uNoise: { value: null as Texture | null },
        uDetail: { value: null as Texture | null },
        uCells: { value: null as Texture | null },
        uHasWind: { value: 0 },
        uTime: { value: 0 },
        uCycle: { value: CLOUD_CYCLE },
        uOctaveMask: { value: new Vector4(...OCTAVES_HIGH) },
        uGridW: { value: 0 },
        uFlow: { value: CLOUD_FLOW },
        uOpacity: { value: 1 },
        uShadow: { value: SHADOW_STRENGTH },
        uShadowHeight: { value: SHADOW_HEIGHT },
        uCyc: { value: this.cyc },
        uCycCut: { value: this.cycCut },
        uDrift0: { value: this.drift[0] },
        uDrift1: { value: this.drift[1] },
        uDriftW: { value: this.drift[2] },
        uCamUpLeft: { value: this.upLeft },
        uLightMode: shared.uLightMode,
        uSunDir: shared.uSunDir,
        uAtmoColor: shared.uAtmoColor,
      },
      vertexShader: CLOUDS_VERTEX,
      fragmentShader: CLOUDS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // Premultiplied output: alpha also darkens the ground seen through gaps (cloud shadows).
      premultipliedAlpha: true,
      blending: NormalBlending,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 256, 128), material);
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (_r, _s, camera: Camera) => this.beforeRender(camera);
    this.updateDrift();
  }

  /**
   * New cloud cover (or null: hide). Returns immediately; the grids are computed by the cloud worker
   * and crossfade in when ready (the first ones appear directly). The spec's arrays are copied.
   */
  set(clouds: CloudSpec | null): void {
    const seq = ++this.seq;
    if (!clouds) {
      this.clearedAt = seq;
      cloudWorker().cancel(this.channel);
      this.mesh.visible = false;
      disposeSlots(this.cur);
      disposeSlots(this.prev);
      this.spec = null;
      this.climate = null;
      this.shownQuality = null;
      this.shownPending = null;
      this.transitionStart = -1;
      this.memo.fill(NaN);
      this.bindTextures();
      return;
    }
    if (!(clouds.w > 0 && clouds.h > 0) || clouds.cover.length < clouds.w * clouds.h) {
      throw new Error(`GlobeClouds: cover does not match ${clouds.w}x${clouds.h}`);
    }
    const n = clouds.w * clouds.h;
    const hasWind = !!(clouds.u && clouds.v && clouds.u.length >= n && clouds.v.length >= n);
    const spec: CloudSpec = { w: clouds.w, h: clouds.h, cover: clouds.cover.slice(0, n) };
    if (hasWind) {
      spec.u = clouds.u!.slice(0, n);
      spec.v = clouds.v!.slice(0, n);
    }
    const quality = clouds.quality ?? 'high';
    this.jobs++;
    const maxW = quality === 'standard' ? STANDARD_GRID_W : undefined;
    void cloudWorker().run({ kind: 'grids', spec, maxW }, this.channel).then((res) => {
      this.jobs--;
      if (!res || this.disposed || seq < this.clearedAt) return;
      this.lastJobMs = res.ms;
      this.apply(res, { w: spec.w, h: spec.h, cover: spec.cover }, hasWind, quality);
      if (this.volumesState === 'ready') this.onShown?.(clouds);
      else this.shownPending = clouds;
    });
    if (this.volumesState === 'none') {
      this.volumesState = 'loading';
      void acquireVolumes().then((v) => {
        if (!v) {
          volumeUsers = Math.max(0, volumeUsers - 1);
          if (!this.disposed) this.volumesState = 'none';
          return;
        }
        if (this.disposed) {
          releaseVolumes();
          return;
        }
        this.volumesState = 'ready';
        this.bindTextures();
        this.updateVisibility();
        const shown = this.shownPending;
        this.shownPending = null;
        if (shown) this.onShown?.(shown);
      });
    }
  }

  /** Cloud work (grids, volumes or a crossfade) still in progress. */
  get pending(): boolean {
    return this.busy || this.transitionStart >= 0;
  }

  /** Worker jobs (grids or volumes) in flight. */
  get busy(): boolean {
    return this.jobs > 0 || this.volumesState === 'loading';
  }

  get active(): boolean {
    return this.mesh.visible;
  }

  /** Shell radius above the (possibly displaced) terrain. */
  setRadius(r: number): void {
    this.mesh.material.uniforms.uShellRadius.value = r;
  }

  setTime(seconds: number): void {
    this.time = seconds;
    this.mesh.material.uniforms.uTime.value = seconds;
    this.updateDrift();
    if (this.mesh.visible) this.updateCyclones();
  }

  /** Global opacity multiplier (1 = the model's opacity). */
  setOpacity(opacity: number): void {
    this.mesh.material.uniforms.uOpacity.value = Math.max(0, Math.min(1, opacity));
  }

  /** Ground-shadow strength (0 disables the extra lookups). */
  setShadowStrength(strength: number): void {
    this.mesh.material.uniforms.uShadow.value = Math.max(0, Math.min(1, strength));
  }

  /** Ends a running crossfade now (screenshots / tests). */
  finishTransition(): void {
    if (this.transitionStart < 0) return;
    this.transitionStart = -1;
    this.mesh.material.uniforms.uMix.value = 1;
  }

  dispose(): void {
    this.disposed = true;
    this.onShown = null;
    cloudWorker().cancel(this.channel);
    disposeSlots(this.cur);
    disposeSlots(this.prev);
    this.bindTextures();
    if (this.volumesState === 'ready') releaseVolumes();
    this.volumesState = 'none';
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private apply(res: CloudGridsResult, cover: CloudSpec, hasWind: boolean, quality: CloudQuality): void {
    const first = !this.cur.grid.texture;
    const now = performance.now();
    if (!first) {
      // Crossfade from what is on screen. Updates can come faster than TRANSITION_MS (season playback
      // at the default 0.8 s/month, the density slider): while the screen still shows mostly the
      // previous grids (first half of the fade) only the target is replaced and the fade runs on;
      // past halfway the target on screen becomes the new start. Either way the jump is at most half
      // a step and the start never goes stale (restarting from a fixed start snapped playback back
      // to the month it began with, every month).
      if (this.transitionStart < 0 || now - this.transitionStart >= 0.5 * TRANSITION_MS) {
        [this.cur, this.prev] = [this.prev, this.cur];
        this.transitionStart = now;
      }
    }
    this.cur.grid.set(res.regime, res.w, res.h);
    this.cur.aux.set(res.aux, res.w, res.h);
    this.cur.wind.setVector(res.flowU, res.flowV, res.w, res.h);
    // Storms keep their genesis across month / density / climate updates, unless the planet's
    // rotation sense flipped (their spin and drift would be wrong).
    if (this.climate && this.climate.rotation !== res.climate.rotation) this.memo.fill(NaN);
    this.climate = res.climate;
    this.spec = cover;
    this.mesh.material.uniforms.uHasWind.value = hasWind ? 1 : 0;
    (this.mesh.material.uniforms.uOctaveMask.value as Vector4).set(...(quality === 'standard' ? OCTAVES_STANDARD : OCTAVES_HIGH));
    this.shownQuality = quality;
    this.mesh.material.uniforms.uGridW.value = res.w;
    this.mesh.material.uniforms.uMix.value = first ? 1 : this.mixAt(now);
    this.bindTextures();
    this.updateCyclones();
    this.updateVisibility();
  }

  private bindTextures(): void {
    const u = this.mesh.material.uniforms;
    // The surface's sun glint fades under the cloud cover and roughens with the wind.
    const s = this.shared;
    if (s.uCloudGrid) s.uCloudGrid.value = this.cur.grid.texture;
    if (s.uCloudWind) s.uCloudWind.value = this.cur.wind.texture;
    if (s.uCloudOn) s.uCloudOn.value = !this.cur.grid.texture ? 0 : this.cur.wind.texture && u.uHasWind.value > 0.5 ? 2 : 1;
    u.uGrid.value = this.cur.grid.texture;
    u.uAux.value = this.cur.aux.texture;
    u.uWind.value = this.cur.wind.texture;
    u.uGridPrev.value = this.prev.grid.texture ?? this.cur.grid.texture;
    u.uAuxPrev.value = this.prev.aux.texture ?? this.cur.aux.texture;
    u.uWindPrev.value = this.prev.wind.texture ?? this.cur.wind.texture;
    if (volumes && this.volumesState === 'ready') {
      u.uNoise.value = volumes.noise;
      u.uDetail.value = volumes.detail;
      u.uCells.value = volumes.cells;
    }
  }

  private updateVisibility(): void {
    this.mesh.visible = this.volumesState === 'ready' && this.cur.grid.texture !== null;
  }

  private updateCyclones(): void {
    if (this.climate) cycloneStates(this.time, this.spec, this.climate, this.cyc, this.memo);
    else this.cyc.fill(0);
    for (let k = 0; k < CYCLONE_COUNT; k++) this.cycCut[k] = Math.cos(2.7 * this.cyc[k * CYCLONE_STRIDE + 3]);
  }

  /**
   * Noise-space drift of the two flow phases and of the warp (constant over the frame: the shader
   * would evaluate 18 sines per pixel). Mirrors the phase timing in shadersClouds.ts.
   */
  private updateDrift(): void {
    const t = this.time / CLOUD_CYCLE;
    for (let i = 0; i < 3; i++) {
      noiseDrift(i === 0 ? Math.floor(t) : i === 1 ? Math.floor(t + 0.5) - 0.5 : t - 0.5, this.driftTmp);
      this.drift[i].set(this.driftTmp[0], this.driftTmp[1], this.driftTmp[2]);
    }
  }

  private beforeRender(camera: Camera): void {
    // Relief-mode light: toward the camera's screen up-left (as the surface hillshade).
    const e = camera.matrixWorld.elements;
    this.right.set(e[0], e[1], e[2]);
    this.upLeft.set(e[4], e[5], e[6]).sub(this.right).normalize();
    if (this.transitionStart >= 0) {
      const now = performance.now();
      if (now - this.transitionStart >= TRANSITION_MS) this.finishTransition();
      else this.mesh.material.uniforms.uMix.value = this.mixAt(now);
    }
  }

  /** Crossfade weight of the current grids at time `now` (1 when no crossfade runs). */
  private mixAt(now: number): number {
    if (this.transitionStart < 0) return 1;
    const m = Math.min(1, Math.max(0, (now - this.transitionStart) / TRANSITION_MS));
    return m * m * (3 - 2 * m);
  }
}
