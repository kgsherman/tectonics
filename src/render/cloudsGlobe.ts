/**
 * Cloud shell above the globe surface (see shadersClouds.ts / cloudsField.ts for the model):
 * coverage-driven, domain-warped fbm from a tileable 3D noise texture, advected by the wind, with
 * storm-track cyclones, regime-dependent texture, sun/relief lighting and soft ground shadows.
 */
import {
  ClampToEdgeWrapping, Data3DTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, Mesh, NoColorSpace,
  NormalBlending, RepeatWrapping, RGBAFormat, ShaderMaterial, SphereGeometry, UnsignedByteType, Vector3,
} from 'three';
import type { Camera, Texture } from 'three';
import type { CloudSpec } from '../core/types';
import {
  analyzeCloudClimate, buildCloudRegimeGrid, CLOUD_FLOW, createCycloneMemo, CYCLONE_COUNT, CYCLONE_STRIDE, cycloneStates,
  type CloudClimate,
} from './cloudsModel';
import { cloudNoiseVolume } from './cloudsNoise';
import { GridTextureSlot } from './globeTextures';
import type { SharedUniforms } from './globeSurface';
import { CLOUDS_FRAGMENT } from './shadersClouds';
import { SHELL_VERTEX } from './shadersCommon';

/**
 * Flow-map cycle length, seconds. The two phases are half a cycle apart, so they disagree by
 * CLOUD_FLOW·cycle/2 of drift (0.08 rad at 10 m/s): about half the synoptic wavelength (large
 * structures morph smoothly) while mesoscale detail renews every cycle (small clouds evolve faster).
 */
const CLOUD_CYCLE = 32;
/** Effective cloud height for ground shadows (planet radii; the shell itself floats higher for parallax). */
const SHADOW_HEIGHT = 0.004;
/** Ground darkening under thick cloud (sun lighting; relief lighting uses 60 % of it). */
const SHADOW_STRENGTH = 0.42;

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

let noiseTexture: Data3DTexture | null = null;
let noiseUsers = 0;

function acquireNoiseTexture(): Data3DTexture {
  noiseUsers++;
  if (noiseTexture) return noiseTexture;
  const vol = cloudNoiseVolume();
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
  noiseTexture = tex;
  return tex;
}

function releaseNoiseTexture(): void {
  noiseUsers = Math.max(0, noiseUsers - 1);
  if (noiseUsers === 0 && noiseTexture) {
    noiseTexture.dispose();
    noiseTexture = null;
  }
}

export class GlobeClouds {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly grid = new RgbaGridSlot();
  private readonly wind = new GridTextureSlot('rg16f');
  private readonly cyc = new Float32Array(CYCLONE_COUNT * CYCLONE_STRIDE);
  /** Genesis parameters of the storms on screen (kept across cloud-spec changes: no teleporting). */
  private readonly memo = createCycloneMemo();
  private readonly upLeft = new Vector3();
  private readonly right = new Vector3();
  private noiseHeld = false;
  /** Private copy of the cover (the caller may reuse its buffer) for cyclone genesis. */
  private spec: CloudSpec | null = null;
  private climate: CloudClimate | null = null;
  private time = 0;

  constructor(shared: SharedUniforms) {
    const material = new ShaderMaterial({
      uniforms: {
        uShellRadius: { value: 1.008 },
        uGrid: { value: null as Texture | null },
        uWind: { value: null as Texture | null },
        uNoise: { value: null as Texture | null },
        uHasWind: { value: 0 },
        uTime: { value: 0 },
        uCycle: { value: CLOUD_CYCLE },
        uFlow: { value: CLOUD_FLOW },
        uOpacity: { value: 1 },
        uShadow: { value: SHADOW_STRENGTH },
        uShadowHeight: { value: SHADOW_HEIGHT },
        uCyc: { value: this.cyc },
        uCamUpLeft: { value: this.upLeft },
        uLightMode: shared.uLightMode,
        uSunDir: shared.uSunDir,
        uAtmoColor: shared.uAtmoColor,
      },
      vertexShader: SHELL_VERTEX,
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
    this.mesh.onBeforeRender = (_r, _s, camera: Camera) => this.updateCamera(camera);
  }

  set(clouds: CloudSpec | null): void {
    const u = this.mesh.material.uniforms;
    if (!clouds) {
      this.mesh.visible = false;
      this.grid.dispose();
      this.wind.dispose();
      this.spec = null;
      this.climate = null;
      this.memo.fill(NaN);
      u.uGrid.value = null;
      u.uWind.value = null;
      u.uHasWind.value = 0;
      return;
    }
    if (!(clouds.w > 0 && clouds.h > 0) || clouds.cover.length < clouds.w * clouds.h) {
      throw new Error(`GlobeClouds: cover does not match ${clouds.w}x${clouds.h}`);
    }
    const n = clouds.w * clouds.h;
    const hasWind = !!(clouds.u && clouds.v && clouds.u.length >= n && clouds.v.length >= n);
    const spec: CloudSpec = { w: clouds.w, h: clouds.h, cover: clouds.cover.slice(0, n) };
    if (hasWind) {
      spec.u = clouds.u!.subarray(0, n);
      spec.v = clouds.v!.subarray(0, n);
    }
    this.grid.set(buildCloudRegimeGrid(spec), clouds.w, clouds.h);
    const climate = analyzeCloudClimate(spec);
    // Storms keep their genesis across month / density / climate updates, unless the planet's
    // rotation sense flipped (their spin and drift would be wrong).
    if (this.climate && this.climate.rotation !== climate.rotation) this.memo.fill(NaN);
    this.climate = climate;
    u.uGrid.value = this.grid.texture;
    if (hasWind) {
      this.wind.setVector(spec.u!, spec.v!, clouds.w, clouds.h);
      u.uWind.value = this.wind.texture;
      u.uHasWind.value = 1;
    } else {
      this.wind.dispose();
      u.uWind.value = null;
      u.uHasWind.value = 0;
    }
    // Keep only the (copied) cover: the wind arrays belong to the caller.
    this.spec = { w: spec.w, h: spec.h, cover: spec.cover };
    if (!this.noiseHeld) {
      u.uNoise.value = acquireNoiseTexture();
      this.noiseHeld = true;
    }
    this.updateCyclones();
    this.mesh.visible = true;
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

  dispose(): void {
    this.grid.dispose();
    this.wind.dispose();
    if (this.noiseHeld) releaseNoiseTexture();
    this.noiseHeld = false;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private updateCyclones(): void {
    if (this.climate) cycloneStates(this.time, this.spec, this.climate, this.cyc, this.memo);
    else this.cyc.fill(0);
  }

  /** Relief-mode light: toward the camera's screen up-left (as the surface hillshade). */
  private updateCamera(camera: Camera): void {
    const e = camera.matrixWorld.elements;
    this.right.set(e[0], e[1], e[2]);
    this.upLeft.set(e[4], e[5], e[6]).sub(this.right).normalize();
  }
}
