/**
 * The planet surface mesh: a high-segment SphereGeometry with one ShaderMaterial that samples the
 * base, overlay and height textures, displaces vertices by relief and draws the brush ring and
 * graticule analytically.
 */
import { Color, Mesh, ShaderMaterial, SphereGeometry, Vector2, Vector3 } from 'three';
import type { IUniform, Texture } from 'three';
import { HeightTextureSlot, RgbaTextureSlot } from './globeTextures';
import { SURFACE_FRAGMENT, SURFACE_VERTEX } from './shadersSurface';
import { PLANET_RADIUS_M, SHADE_EXAGGERATION } from './viewUtil';

/** Lighting modes as shader integers. */
export const LIGHT_FLAT = 0;
export const LIGHT_RELIEF = 1;
export const LIGHT_SUN = 2;

/** Uniforms shared by several globe materials (same objects referenced by each material). */
export interface SharedUniforms {
  uLightMode: IUniform<number>;
  uSunDir: IUniform<Vector3>;
  uAtmoColor: IUniform<Color>;
}

/** Surface mesh resolution (segments around × pole to pole). */
const SEGMENTS_W = 512;
const SEGMENTS_H = 256;

export class GlobeSurface {
  readonly mesh: Mesh<SphereGeometry, ShaderMaterial>;
  readonly base: RgbaTextureSlot;
  readonly overlay: RgbaTextureSlot;
  readonly height: HeightTextureSlot;
  private readonly u: Record<string, IUniform>;

  /**
   * @param gpuHeightMips R16F is color-renderable (EXT_color_buffer_float): the height mip chain is
   *   generated on the GPU instead of box-filtered on the CPU and uploaded level by level.
   */
  constructor(shared: SharedUniforms, anisotropy: number, gpuHeightMips = false) {
    this.base = new RgbaTextureSlot(true, false, anisotropy);
    // Raw bytes (NoColorSpace): the shader un-premultiplies the sRGB values and decodes them itself;
    // an sRGB texture format would decode in hardware first (double decode → darker, shifted colors).
    this.overlay = new RgbaTextureSlot(false, true, anisotropy);
    this.height = new HeightTextureSlot(anisotropy, gpuHeightMips);
    this.u = {
      uBase: { value: null as Texture | null },
      uHasBase: { value: 0 },
      uOverlay: { value: null as Texture | null },
      uHasOverlay: { value: 0 },
      uOverlaySize: { value: new Vector2(1, 1) },
      uDpr: { value: 1 },
      uHeight: { value: null as Texture | null },
      uHasHeight: { value: 0 },
      uHeightTexel: { value: new Vector2(1, 1) },
      uHeightSize: { value: new Vector2(1, 1) },
      uBaseSize: { value: new Vector2(1, 1) },
      uSameSize: { value: 0 },
      uDetail: { value: 0 },
      uRecon: { value: 1 },
      uHeightLod: { value: 0 },
      uPoleHeight: { value: new Vector2(0, 0) },
      uSeaLevel: { value: 0 },
      uDispScale: { value: 0 },
      uShadeScale: { value: SHADE_EXAGGERATION / PLANET_RADIUS_M },
      uLightMode: shared.uLightMode,
      uSunDir: shared.uSunDir,
      uAtmoColor: shared.uAtmoColor,
      uCamUpLeft: { value: new Vector3(0, 1, 0) },
      uBrushOn: { value: 0 },
      uBrushCenter: { value: new Vector3(0, 1, 0) },
      uBrushRadius: { value: 0.05 },
      uBrushColor: { value: new Color(1, 1, 1) },
      uGratOn: { value: 0 },
      uGratStep: { value: Math.PI / 12 },
    };
    const material = new ShaderMaterial({
      uniforms: this.u,
      vertexShader: SURFACE_VERTEX,
      fragmentShader: SURFACE_FRAGMENT,
    });
    this.mesh = new Mesh(new SphereGeometry(1, SEGMENTS_W, SEGMENTS_H), material);
    this.mesh.renderOrder = 0;
  }

  setBase(rgba: Uint8ClampedArray, w: number, h: number): void {
    this.base.set(rgba, w, h);
    this.u.uBase.value = this.base.texture;
    this.u.uHasBase.value = 1;
    (this.u.uBaseSize.value as Vector2).set(w, h);
    this.updateSameSize();
  }

  setOverlay(rgba: Uint8ClampedArray | null, w: number, h: number): void {
    if (!rgba) {
      // Keep the textures: overlays are toggled often and come back at the same size.
      this.u.uHasOverlay.value = 0;
      return;
    }
    this.overlay.set(rgba, w, h);
    this.u.uOverlay.value = this.overlay.texture;
    this.u.uHasOverlay.value = 1;
    (this.u.uOverlaySize.value as Vector2).set(w, h);
  }

  setHeight(height: Float32Array | null, w: number, h: number): void {
    if (!height) {
      this.height.dispose();
      this.u.uHeight.value = null;
      this.u.uHasHeight.value = 0;
      return;
    }
    this.height.set(height, w, h);
    this.u.uHeight.value = this.height.texture;
    this.u.uHasHeight.value = 1;
    (this.u.uHeightTexel.value as Vector2).set(1 / w, 1 / h);
    (this.u.uHeightSize.value as Vector2).set(w, h);
    this.updateSameSize();
    (this.u.uPoleHeight.value as Vector2).set(this.height.poleNorth, this.height.poleSouth);
    // Vertex sampling LOD matched to the mesh density (texels per segment).
    this.u.uHeightLod.value = Math.max(0, Math.log2(w / SEGMENTS_W));
  }

  get hasHeight(): boolean {
    return this.u.uHasHeight.value === 1;
  }

  setSeaLevel(seaLevel: number): void {
    this.u.uSeaLevel.value = seaLevel;
  }

  /** Procedural detail / coast breakup strength 0..1 (fades in with zoom inside the shader). */
  setDetail(amount: number): void {
    this.u.uDetail.value = Math.max(0, Math.min(1, amount));
  }

  get detail(): number {
    return this.u.uDetail.value as number;
  }

  /** Sub-texel coastline/color reconstruction when zoomed in (on by default). */
  setReconstruction(on: boolean): void {
    this.u.uRecon.value = on ? 1 : 0;
  }

  private updateSameSize(): void {
    const b = this.u.uBaseSize.value as Vector2, h = this.u.uHeightSize.value as Vector2;
    this.u.uSameSize.value = b.x === h.x && b.y === h.y ? 1 : 0;
  }

  /** exaggeration: vertical exaggeration factor (0 = no displacement). */
  setExaggeration(exaggeration: number): void {
    this.u.uDispScale.value = Math.max(0, exaggeration) / PLANET_RADIUS_M;
    this.u.uShadeScale.value = Math.max(SHADE_EXAGGERATION, exaggeration) / PLANET_RADIUS_M;
  }

  /** Device pixels per CSS pixel (overlay lines keep a constant CSS width). */
  setPixelRatio(dpr: number): void {
    this.u.uDpr.value = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  }

  /** Screen up-left direction in world space (relief light azimuth). */
  setCameraFrame(upLeft: Vector3): void {
    (this.u.uCamUpLeft.value as Vector3).copy(upLeft);
  }

  /** center: Three-space unit vector; color: linear RGB. */
  setBrush(center: Vector3 | null, radius: number, color: Color): void {
    this.u.uBrushOn.value = center ? 1 : 0;
    if (center) (this.u.uBrushCenter.value as Vector3).copy(center);
    this.u.uBrushRadius.value = radius;
    (this.u.uBrushColor.value as Color).copy(color);
  }

  setGraticule(on: boolean, stepRad: number): void {
    this.u.uGratOn.value = on ? 1 : 0;
    this.u.uGratStep.value = stepRad;
  }

  dispose(): void {
    this.base.dispose();
    this.overlay.dispose();
    this.height.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
