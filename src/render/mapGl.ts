/**
 * GPU layers for the 2D map (raw WebGL2, one fullscreen triangle per pass).
 *
 * The map used to draw the equirect base image with Canvas 2D bilinear magnification: blurry land
 * and stair-stepped coasts at 4–48× zoom, plus a CPU hillshade pass on every new image. The base
 * pass renders only the visible viewport at device resolution with the globe's sub-texel
 * reconstruction (smooth anti-aliased coastline from the height map, per-class colour reconstruction
 * with smooth lake/Köppen/snow/sea-ice edges, C1 relief normals, zoom-dependent procedural detail —
 * shared GLSL in shadersCommon.ts) and the same relief shade response and relief cue as the globe.
 * The overlay pass redraws the overlay's lines at a constant thin screen width once magnified, the
 * coastline on the base's displayed coast (GLSL_OVERLAY_LINES), instead of a zoom-wide bilinear blur. Longitude wraps in the shaders, so no world copies are
 * needed. Output is sRGB (premultiplied, alpha 0 beyond the poles); the caller composites each pass
 * into its 2D canvas.
 *
 * Textures: one per raster size (playback previews and paused frames alternate without
 * reallocating), immutable storage updated with texSubImage2D; the height mip chain is generated on
 * the GPU when R16F is color-renderable (EXT_color_buffer_float), else box-filtered on the CPU.
 * Context loss: rendering pauses (the caller falls back to Canvas 2D); on webglcontextrestored the
 * programs are rebuilt and `onRestored` asks the owner to re-send its images.
 */
import { buildFloatMips, type FloatMip } from './globeTextures';
import {
  GLSL_BASIS, GLSL_CONSTANTS, GLSL_OVERLAY_LINES, GLSL_RELIEF_RESPONSE, GLSL_SRGB_ENCODE, GLSL_TERRAIN_DETAIL,
  GLSL_TERRAIN_RECON,
} from './shadersCommon';
import { SizeCache } from './viewBuffers';
import type { MapTransform } from './viewMapTransform';
import { PLANET_RADIUS_M, SHADE_EXAGGERATION } from './viewUtil';

const VERTEX = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** Shared prologue: map pixel → lat/lon/st with analytic derivatives (the map is affine in lon/lat). */
const GLSL_MAP_COORDS = /* glsl */ `
uniform vec2 uView;
uniform vec3 uXform;
// Returns false beyond the poles.
bool mapCoords(out float lat, out float lon, out vec2 st, out vec2 dsx, out vec2 dsy) {
  float x = gl_FragCoord.x, y = uView.y - gl_FragCoord.y;
  float scale = uXform.z;
  lat = uXform.y - (y - 0.5 * uView.y) / scale;
  lon = uXform.x + (x - 0.5 * uView.x) / scale;
  st = vec2(fract(lon * (1.0 / TWO_PI) + 0.5), 0.5 - lat * (1.0 / PI));
  dsx = vec2(1.0 / (TWO_PI * scale), 0.0);
  dsy = vec2(0.0, 1.0 / (PI * scale));
  return abs(lat) <= 0.5 * PI;
}
`;

/** Map base fragment shader (exported for contract tests). */
export const MAP_BASE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${GLSL_CONSTANTS}
${GLSL_SRGB_ENCODE}
${GLSL_BASIS}
${GLSL_TERRAIN_RECON}
${GLSL_TERRAIN_DETAIL}
${GLSL_RELIEF_RESPONSE}
${GLSL_MAP_COORDS}
uniform sampler2D uBase;
uniform sampler2D uHeight;
uniform vec2 uBaseSize;
uniform vec2 uHeightSize;
uniform float uHasHeight;
uniform float uSameSize;
uniform float uSeaLevel;
uniform float uShade;
uniform float uShadeScale;
uniform float uDetail;
out vec4 outColor;

const float SIN_ALT = 0.573576;
const float COS_ALT = 0.819152;
const float MAX_TILT = 1.6;

vec3 saturateTilt(vec3 t) {
  return t * inversesqrt(1.0 + dot(t, t) * (1.0 / (MAX_TILT * MAX_TILT)));
}

void main() {
  float lat, lon;
  vec2 st, dsx, dsy;
  if (!mapCoords(lat, lon, st, dsx, dsy)) {
    outColor = vec4(0.0);
    return;
  }
  float scale = uXform.z;
  float cl = cos(lat);
  // Same frame as the globe (Three axes, Y north) so procedural detail matches between the views.
  vec3 n0 = vec3(cl * cos(lon), sin(lat), -cl * sin(lon));
  vec3 east, north;
  geoBasis(lat, lon, east, north);
  float cosLat = max(cl, 0.5 * PI / uHeightSize.y);
  bool hasH = uHasHeight > 0.5;
  bool lit = uShade > 0.5 && hasH;
  float pxRad = 1.0 / scale;
  float texRad = PI / uBaseSize.y;
  float texRadH = PI / uHeightSize.y;
  // Only for one shared base/height raster (a base on another grid has its own land/sea mask).
  float k = hasH && uSameSize > 0.5 ? smoothstep(1.0, 0.5, pxRad / texRad) : 0.0;
  // Pixel-footprint height and its coarse (~8 texel / ≥ 4 px) mean for the relief cue.
  vec2 fwSt = abs(dsx) + abs(dsy);
  float hLin = hasH ? textureGrad(uHeight, st, dsx, dsy).r : uSeaLevel;
  vec2 cg = max(8.0 / uHeightSize, 4.0 * fwSt);
  float hCoarse = hasH ? textureGrad(uHeight, st, vec2(cg.x, 0.0), vec2(0.0, cg.y)).r : uSeaLevel;
  float footBoost = clamp(1.6 * sqrt(pxRad / texRadH), 1.0, 2.2);

  vec3 col = vec3(0.0);
  vec3 tilt = vec3(0.0);
  float detailAlbedo = 0.0;
  float rough = 0.0;
  float landF = 0.0;
  float baseTilt = 0.0;
  if (k < 1.0) {
    col = textureGrad(uBase, st, dsx, dsy).rgb;
    if (lit) {
      vec2 d = max(1.0 / uHeightSize, fwSt);
      float hE = max(textureGrad(uHeight, st + vec2(d.x, 0.0), dsx, dsy).r, uSeaLevel);
      float hW = max(textureGrad(uHeight, st - vec2(d.x, 0.0), dsx, dsy).r, uSeaLevel);
      float hN = max(textureGrad(uHeight, st - vec2(0.0, d.y), dsx, dsy).r, uSeaLevel);
      float hS = max(textureGrad(uHeight, st + vec2(0.0, d.y), dsx, dsy).r, uSeaLevel);
      float land = step(uSeaLevel, hLin);
      float gE = (hE - hW) / (2.0 * d.x * TWO_PI * cosLat);
      float gN = (hN - hS) / (2.0 * d.y * PI);
      tilt = (uShadeScale * footBoost) * land * (gE * east + gN * north);
      landF = land;
      baseTilt = length(tilt);
    }
  }
  if (k > 0.0) {
    vec3 warp = vec3(0.0), cwarp = vec3(0.0);
    float ridgeW = smoothstep(400.0, 2500.0, hLin - uSeaLevel);
    vec4 det = uDetail > 0.0 ? terrainDetail(n0, texRad, pxRad, ridgeW, warp, cwarp) : vec4(0.0);
    warp = uDetail * (warp - dot(warp, n0) * n0);
    vec2 stw = st + vec2(dot(warp, east) / (TWO_PI * cosLat), -dot(warp, north) / PI);
    TerrainSample ts = reconstructTerrain(uHeight, uHeightSize, uBase, uBaseSize, uSameSize > 0.5, true, stw, uSeaLevel, pxRad / texRadH);
    float slopeReal = length(ts.g) / (texRadH * ${PLANET_RADIUS_M.toFixed(1)});
    float above = max(ts.h - uSeaLevel, 0.0);
    float r = clamp(max(smoothstep(0.004, 0.05, slopeReal), smoothstep(250.0, 3000.0, above)), 0.0, 1.0);
    float aa = max(length(ts.gm) * (pxRad / texRadH), 1e-4);
    float l = smoothstep(-0.5, 0.5, ts.m / aa);
    // Procedural colour warp of the land (lit only: flat mode keeps exact legend colours).
    cwarp = (lit ? uDetail : 0.0) * (cwarp - dot(cwarp, n0) * n0);
    vec2 coff = vec2(dot(cwarp, east) / (TWO_PI * cosLat), -dot(cwarp, north) / PI) * uHeightSize;
    vec3 c = mix(ts.seaCol, perturbLand(ts, coff), l);
    vec3 t = vec3(0.0);
    if (lit) {
      vec2 gt = terrainGradient(ts, texRadH / pxRad);
      float gE = gt.x * uHeightSize.x / (TWO_PI * cosLat);
      float gN = -gt.y * uHeightSize.y / PI;
      t = uShadeScale * l * (gE * east + gN * north);
      baseTilt = mix(baseTilt, length(t), k);
      vec3 dg = det.yzw - dot(det.yzw, n0) * n0;
      t += (uDetail * l * detailSlopeGain(r)) * dg;
    }
    col = mix(col, c, k);
    tilt = mix(tilt, t, k);
    landF = mix(landF, l, k);
    detailAlbedo = k * l * det.x;
    rough = r;
  }
  if (lit) {
    vec3 n = normalize(n0 - saturateTilt(tilt));
    // Light from the north-west, 35° above the horizon (as the CPU hillshade).
    vec3 L = n0 * SIN_ALT + normalize(north - east) * COS_ALT;
    col *= reliefShade(dot(n, L) / SIN_ALT);
    col *= 1.0 + uDetail * detailAlbedoGain(rough) * detailAlbedo;
    col *= reliefCue(baseTilt, landF * (max(hLin, uSeaLevel) - max(hCoarse, uSeaLevel)));
  }
  outColor = vec4(linearToSrgb(col), 1.0);
}
`;

/**
 * Map overlay fragment shader (exported for tests): premultiplied overlay; once magnified, lines at a
 * constant thin screen width with the coastline on the displayed coast (the base pass's coast field
 * and procedural warp, recomputed only near overlay lines).
 */
export const MAP_OVERLAY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${GLSL_CONSTANTS}
${GLSL_BASIS}
${GLSL_TERRAIN_RECON}
${GLSL_TERRAIN_DETAIL}
${GLSL_OVERLAY_LINES}
${GLSL_MAP_COORDS}
uniform sampler2D uOverlay;
uniform vec2 uOverlaySize;
uniform sampler2D uHeight;
uniform vec2 uHeightSize;
uniform vec2 uBaseSize;
uniform float uHasHeight;
uniform float uSameSize;
uniform float uSeaLevel;
uniform float uDetail;
uniform float uDpr;
out vec4 outColor;

void main() {
  float lat, lon;
  vec2 st, dsx, dsy;
  if (!mapCoords(lat, lon, st, dsx, dsy)) {
    outColor = vec4(0.0);
    return;
  }
  vec4 o = textureGrad(uOverlay, st, dsx, dsy);
  float pxRad = 1.0 / uXform.z;
  // Overlay texels per screen pixel; lines are redrawn once a texel spans ≥ 1–1.4 px.
  float ovTex = uOverlaySize.y * pxRad / PI;
  float ko = smoothstep(1.0, 0.7, ovTex);
  if (ko > 0.0) {
    OverlayRidge ridge = overlayRidge(uOverlay, uOverlaySize, st, dsx * uOverlaySize, dsy * uOverlaySize);
    float coastPx = 1e6, onCoast = 0.0, snap = 0.0;
    // The displayed coast, exactly as the base pass reconstructs it (same k, warp and coast field).
    float texRad = PI / uBaseSize.y;
    float k = uHasHeight > 0.5 && uSameSize > 0.5 ? smoothstep(1.0, 0.5, pxRad / texRad) : 0.0;
    if (k > 0.0 && ridge.peak > 0.0) {
      float cl = cos(lat);
      vec3 n0 = vec3(cl * cos(lon), sin(lat), -cl * sin(lon));
      vec3 east, north;
      geoBasis(lat, lon, east, north);
      float cosLat = max(cl, 0.5 * PI / uHeightSize.y);
      vec3 warp = uDetail > 0.0 ? terrainWarp(n0, texRad, pxRad) : vec3(0.0);
      warp = uDetail * (warp - dot(warp, n0) * n0);
      vec2 stw = st + vec2(dot(warp, east) / (TWO_PI * cosLat), -dot(warp, north) / PI);
      vec3 cf = coastField(uHeight, uHeightSize, stw, uSeaLevel);
      coastPx = coastDistPx(cf.x, cf.yz, dsx * uHeightSize, dsy * uHeightSize);
      snap = k;
      onCoast = ridgeOnCoast(ridge, uHeight, uHeightSize, uOverlaySize, st, uSeaLevel, cf.x, cf.yz);
    }
    o = mix(o, overlayCompose(ridge, coastPx, onCoast, snap, uDpr), ko);
  }
  outColor = o;
}
`;

export interface MapGlRenderOptions {
  t: MapTransform;
  dpr: number;
  seaLevel: number;
  /** Relief shading from the height map ('relief' / 'sun' lighting). */
  shade: boolean;
  /** Procedural close-up detail strength 0..1. */
  detail: number;
}

export interface MapGlOverlayOptions {
  t: MapTransform;
  dpr: number;
  /** Sea level and detail strength of the base draw (the coastline follows its displayed coast). */
  seaLevel: number;
  detail: number;
}

const BASE_UNIFORMS = [
  'uBase', 'uHeight', 'uBaseSize', 'uHeightSize', 'uHasHeight', 'uSameSize', 'uView', 'uXform', 'uSeaLevel', 'uShade',
  'uShadeScale', 'uDetail',
] as const;
const OVERLAY_UNIFORMS = [
  'uOverlay', 'uOverlaySize', 'uView', 'uXform', 'uHeight', 'uHeightSize', 'uBaseSize', 'uHasHeight', 'uSameSize', 'uSeaLevel',
  'uDetail', 'uDpr',
] as const;
type Locations<K extends string> = Record<K, WebGLUniformLocation | null>;

interface Programs {
  base: WebGLProgram;
  overlay: WebGLProgram;
  vao: WebGLVertexArrayObject | null;
  ub: Locations<(typeof BASE_UNIFORMS)[number]>;
  uo: Locations<(typeof OVERLAY_UNIFORMS)[number]>;
  anisotropy: number;
  /** R16F is color-renderable: GPU height mips. */
  gpuHeightMips: boolean;
}

interface GlTex {
  tex: WebGLTexture;
  w: number;
  h: number;
  /** CPU mip chain buffers (height without GPU mips), recycled between uploads. */
  mips?: FloatMip[];
}

/** Raster sizes kept per texture kind (playback preview + paused full quality). */
const SIZES_PER_KIND = 2;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('mapGl: createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`mapGl: shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  const prog = gl.createProgram();
  if (!prog) throw new Error('mapGl: createProgram failed');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`mapGl: link failed: ${gl.getProgramInfoLog(prog)}`);
  }
  return prog;
}

function locations<K extends string>(gl: WebGL2RenderingContext, prog: WebGLProgram, names: readonly K[]): Locations<K> {
  return Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)])) as Locations<K>;
}

function mipLevels(w: number, h: number): number {
  return Math.floor(Math.log2(Math.max(w, h))) + 1;
}

export class MapGlBase {
  readonly canvas: HTMLCanvasElement;
  /** Called after the context was restored (programs rebuilt): re-send base, height and overlay. */
  onRestored: (() => void) | null = null;
  private readonly gl: WebGL2RenderingContext;
  private p: Programs | null = null;
  private readonly baseTexs: SizeCache<GlTex>;
  private readonly heightTexs: SizeCache<GlTex>;
  private readonly overlayTexs: SizeCache<GlTex>;
  private base: GlTex | null = null;
  private height: GlTex | null = null;
  private overlay: GlTex | null = null;
  private contextLost = false;
  /** performance.now() of the last context loss (0 = never). */
  lostAt = 0;
  private disposed = false;

  /** Returns null when WebGL2 (or the shader) is unavailable: callers keep their Canvas 2D path. */
  static create(): MapGlBase | null {
    let gl: WebGL2RenderingContext | null = null;
    try {
      const canvas = document.createElement('canvas');
      // failIfMajorPerformanceCaveat: on software WebGL (SwiftShader, blocklisted GPUs) the per-pixel
      // reconstruction would cost hundreds of ms per pan/zoom redraw; the Canvas 2D path is cheaper.
      gl = canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
        failIfMajorPerformanceCaveat: true,
      });
      if (!gl) return null;
      return new MapGlBase(canvas, gl);
    } catch (e) {
      // Release the context now (a failed shader build would otherwise hold one until GC).
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      console.warn('MapGlBase unavailable; using the Canvas 2D map base.', e);
      return null;
    }
  }

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    const release = (t: GlTex): void => {
      if (!this.contextLost) gl.deleteTexture(t.tex);
    };
    this.baseTexs = new SizeCache<GlTex>(SIZES_PER_KIND, release);
    this.heightTexs = new SizeCache<GlTex>(SIZES_PER_KIND, release);
    this.overlayTexs = new SizeCache<GlTex>(SIZES_PER_KIND, release);
    this.p = this.init();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestore);
  }

  private init(): Programs {
    const gl = this.gl;
    const base = link(gl, MAP_BASE_FRAGMENT);
    const overlay = link(gl, MAP_OVERLAY_FRAGMENT);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    return {
      base,
      overlay,
      vao: gl.createVertexArray(),
      ub: locations(gl, base, BASE_UNIFORMS),
      uo: locations(gl, overlay, OVERLAY_UNIFORMS),
      anisotropy: aniso ? Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 0,
      gpuHeightMips: gl.getExtension('EXT_color_buffer_float') !== null,
    };
  }

  private readonly onLost = (e: Event): void => {
    // preventDefault: ask the browser to restore the context (webglcontextrestored).
    e.preventDefault();
    this.markLost();
  };

  /** Drops every GL object (they died with the context). */
  private markLost(): void {
    if (this.contextLost) return;
    this.contextLost = true;
    this.lostAt = performance.now();
    this.p = null;
    this.base = this.height = this.overlay = null;
    this.baseTexs.clear();
    this.heightTexs.clear();
    this.overlayTexs.clear();
  }

  private readonly onRestore = (): void => {
    if (this.disposed) return;
    try {
      this.p = this.init();
      this.contextLost = false;
    } catch (err) {
      console.warn('MapGlBase: could not rebuild after context restore; keeping the Canvas 2D map base.', err);
      return;
    }
    this.onRestored?.();
  };

  /** False while the context is lost (the caller falls back to its Canvas 2D path). */
  get usable(): boolean {
    // The loss event is not always delivered (e.g. an offscreen canvas evicted for exceeding the
    // context limit): also poll the context itself.
    if (!this.contextLost && !this.disposed && this.gl.isContextLost()) this.markLost();
    return !this.disposed && !this.contextLost && this.p !== null;
  }

  get hasBase(): boolean {
    return this.base !== null;
  }

  get hasHeight(): boolean {
    return this.height !== null;
  }

  get hasOverlay(): boolean {
    return this.overlay !== null;
  }

  /** Number of live textures (diagnostics). */
  get textureCount(): number {
    return this.baseTexs.size + this.heightTexs.size + this.overlayTexs.size;
  }

  /** Immutable RGBA8 / sRGB storage with a full mip chain for w×h (cached per size). */
  private rgbaTexture(cache: SizeCache<GlTex>, w: number, h: number, srgb: boolean): GlTex {
    const gl = this.gl, p = this.p!;
    return cache.get(w, h, () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, mipLevels(w, h), srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (p.anisotropy > 0) {
        const ext = gl.getExtension('EXT_texture_filter_anisotropic')!;
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, p.anisotropy);
      }
      return { tex, w, h };
    }).value;
  }

  private uploadRgba(t: GlTex, data: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Uploads the base image (sRGB RGBA8, row 0 = north) with a mip chain. Copies synchronously. */
  setBase(rgba: Uint8ClampedArray, w: number, h: number): void {
    if (!this.usable) return;
    const t = this.rgbaTexture(this.baseTexs, w, h, true);
    this.uploadRgba(t, new Uint8Array(rgba.buffer, rgba.byteOffset, w * h * 4));
    this.base = t;
  }

  /**
   * Uploads the overlay (raw sRGB bytes, premultiplied by the caller for fringe-free filtering; the
   * shader output stays premultiplied for canvas compositing); null hides it.
   */
  setOverlay(premultiplied: Uint8Array | null, w: number, h: number): void {
    if (!this.usable) return;
    if (!premultiplied) {
      this.overlay = null;
      return;
    }
    const t = this.rgbaTexture(this.overlayTexs, w, h, false);
    this.uploadRgba(t, premultiplied);
    this.overlay = t;
  }

  /** Uploads the height map (m) as R16F with a mip chain; null clears it. */
  setHeight(height: Float32Array | null, w: number, h: number): void {
    if (!this.usable) return;
    const gl = this.gl, p = this.p!;
    if (!height) {
      this.height = null;
      return;
    }
    // Same level count as buildFloatMips (halving with floor down to 1×1).
    const levels = mipLevels(w, h);
    const t = this.heightTexs.get(w, h, () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.R16F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      return { tex, w, h };
    }).value;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    // Level 0 is uploaded straight from the caller's array (texSubImage2D copies synchronously).
    const level0 = height.subarray(0, w * h);
    if (p.gpuHeightMips) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, level0);
      gl.generateMipmap(gl.TEXTURE_2D);
    } else {
      const mips = buildFloatMips(level0, w, h, t.mips);
      for (let l = 0; l < mips.length; l++) {
        const m = mips[l];
        gl.texSubImage2D(gl.TEXTURE_2D, l, 0, 0, m.width, m.height, gl.RED, gl.FLOAT, m.data);
      }
      // The level-0 buffer belongs to the caller: do not keep it for the next reuse.
      mips[0] = { data: new Float32Array(0), width: w, height: h };
      t.mips = mips;
    }
    this.height = t;
  }

  /** Sizes the drawing buffer and binds the shared state of a pass. */
  private begin(o: { t: MapTransform; dpr: number }, program: WebGLProgram): { W: number; H: number } {
    const gl = this.gl;
    const W = Math.max(1, Math.round(o.t.width * o.dpr)), H = Math.max(1, Math.round(o.t.height * o.dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(this.p!.vao);
    return { W, H };
  }

  private setXform(view: WebGLUniformLocation | null, xform: WebGLUniformLocation | null, t: MapTransform, W: number, H: number): void {
    const gl = this.gl;
    gl.uniform2f(view, W, H);
    // Keep the center longitude small: large values lose float precision in the shader.
    gl.uniform3f(xform, t.centerLon, t.centerLat, t.scale * (W / Math.max(1e-6, t.width)));
  }

  /**
   * Renders the base of the viewport of transform `t` at device resolution. Returns the canvas (read
   * it with drawImage in the same task), or null when unusable / no base image.
   */
  render(o: MapGlRenderOptions): HTMLCanvasElement | null {
    if (!this.usable || !this.base) return null;
    const gl = this.gl, p = this.p!, u = p.ub, base = this.base, height = this.height;
    const { W, H } = this.begin(o, p.base);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, base.tex);
    gl.uniform1i(u.uBase, 0);
    gl.activeTexture(gl.TEXTURE1);
    // Without a height map texture unit 1 still needs a valid sampler: reuse the base (never read).
    gl.bindTexture(gl.TEXTURE_2D, height ? height.tex : base.tex);
    gl.uniform1i(u.uHeight, 1);
    gl.uniform2f(u.uBaseSize, base.w, base.h);
    gl.uniform2f(u.uHeightSize, height ? height.w : base.w, height ? height.h : base.h);
    gl.uniform1f(u.uHasHeight, height ? 1 : 0);
    gl.uniform1f(u.uSameSize, height && height.w === base.w && height.h === base.h ? 1 : 0);
    this.setXform(u.uView, u.uXform, o.t, W, H);
    gl.uniform1f(u.uSeaLevel, o.seaLevel);
    gl.uniform1f(u.uShade, o.shade ? 1 : 0);
    gl.uniform1f(u.uShadeScale, SHADE_EXAGGERATION / PLANET_RADIUS_M);
    gl.uniform1f(u.uDetail, Math.max(0, Math.min(1, o.detail)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return this.canvas;
  }

  /**
   * Renders the overlay of the viewport (premultiplied sRGB, transparent elsewhere) into the same
   * canvas; returns it (drawImage it before the next pass), or null when unusable / no overlay. Pass
   * the sea level and detail of the base draw: the coastline is drawn on the base's displayed coast.
   */
  renderOverlay(o: MapGlOverlayOptions): HTMLCanvasElement | null {
    if (!this.usable || !this.overlay) return null;
    const gl = this.gl, p = this.p!, u = p.uo, ov = this.overlay, height = this.height, base = this.base;
    const { W, H } = this.begin(o, p.overlay);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ov.tex);
    gl.uniform1i(u.uOverlay, 0);
    gl.activeTexture(gl.TEXTURE1);
    // Without a height map texture unit 1 still needs a valid sampler: reuse the overlay (never read).
    gl.bindTexture(gl.TEXTURE_2D, height ? height.tex : ov.tex);
    gl.uniform1i(u.uHeight, 1);
    gl.uniform2f(u.uOverlaySize, ov.w, ov.h);
    gl.uniform2f(u.uHeightSize, height ? height.w : ov.w, height ? height.h : ov.h);
    gl.uniform2f(u.uBaseSize, base ? base.w : ov.w, base ? base.h : ov.h);
    gl.uniform1f(u.uHasHeight, height ? 1 : 0);
    gl.uniform1f(u.uSameSize, height && base && height.w === base.w && height.h === base.h ? 1 : 0);
    gl.uniform1f(u.uSeaLevel, o.seaLevel);
    gl.uniform1f(u.uDetail, Math.max(0, Math.min(1, o.detail)));
    gl.uniform1f(u.uDpr, o.dpr);
    this.setXform(u.uView, u.uXform, o.t, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return this.canvas;
  }

  dispose(): void {
    if (this.disposed) return;
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestore);
    this.baseTexs.clear();
    this.heightTexs.clear();
    this.overlayTexs.clear();
    this.base = this.height = this.overlay = null;
    if (this.p && !this.contextLost) {
      gl.deleteProgram(this.p.base);
      gl.deleteProgram(this.p.overlay);
      if (this.p.vao) gl.deleteVertexArray(this.p.vao);
    }
    this.p = null;
    this.disposed = true;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width = this.canvas.height = 0;
  }
}
