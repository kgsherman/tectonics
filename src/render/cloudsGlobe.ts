/** Cloud shell above the globe surface: cover texture × drifting noise (see shadersClouds.ts). */
import { Mesh, ShaderMaterial, SphereGeometry } from 'three';
import type { Texture } from 'three';
import type { CloudSpec } from '../core/types';
import { GridTextureSlot } from './globeTextures';
import type { SharedUniforms } from './globeSurface';
import { CLOUDS_FRAGMENT } from './shadersClouds';
import { SHELL_VERTEX } from './shadersCommon';

/** Cloud drift: radians of arc per second per (m/s) of wind (10 m/s ≈ 0.29°/s: a gentle time-lapse). */
const CLOUD_FLOW = 0.0005;
/**
 * Flow-map cycle length, seconds. Each noise layer is re-seeded once per cycle (while invisible), so
 * the pattern slowly morphs (over ~half a cycle) while drifting; the ±CLOUD_FLOW·cycle/2 displacement
 * (0.12 rad at 10 m/s) stays below the noise feature size (≈ 1/5 rad), keeping shear distortion small.
 */
const CLOUD_CYCLE = 48;

export class GlobeClouds {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;
  private readonly cover = new GridTextureSlot('r8');
  private readonly wind = new GridTextureSlot('rg16f');

  constructor(shared: SharedUniforms) {
    const material = new ShaderMaterial({
      uniforms: {
        uShellRadius: { value: 1.008 },
        uCover: { value: null as Texture | null },
        uWind: { value: null as Texture | null },
        uHasWind: { value: 0 },
        uTime: { value: 0 },
        uCycle: { value: CLOUD_CYCLE },
        uFlow: { value: CLOUD_FLOW },
        uOpacity: { value: 1 },
        uLightMode: shared.uLightMode,
        uSunDir: shared.uSunDir,
      },
      vertexShader: SHELL_VERTEX,
      fragmentShader: CLOUDS_FRAGMENT,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 256, 128), material);
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  set(clouds: CloudSpec | null): void {
    const u = this.mesh.material.uniforms;
    if (!clouds) {
      this.mesh.visible = false;
      this.cover.dispose();
      this.wind.dispose();
      u.uCover.value = null;
      u.uWind.value = null;
      u.uHasWind.value = 0;
      return;
    }
    if (!(clouds.w > 0 && clouds.h > 0) || clouds.cover.length < clouds.w * clouds.h) {
      throw new Error(`GlobeClouds: cover does not match ${clouds.w}x${clouds.h}`);
    }
    this.cover.setScalar(clouds.cover, clouds.w, clouds.h);
    u.uCover.value = this.cover.texture;
    if (clouds.u && clouds.v) {
      this.wind.setVector(clouds.u, clouds.v, clouds.w, clouds.h);
      u.uWind.value = this.wind.texture;
      u.uHasWind.value = 1;
    } else {
      this.wind.dispose();
      u.uWind.value = null;
      u.uHasWind.value = 0;
    }
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
    this.mesh.material.uniforms.uTime.value = seconds;
  }

  dispose(): void {
    this.cover.dispose();
    this.wind.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
