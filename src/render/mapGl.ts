/**
 * GPU base layer for the 2D map (raw WebGL2, one fullscreen triangle).
 *
 * The map used to draw the equirect base image with Canvas 2D bilinear magnification: blurry land
 * and stair-stepped coasts at 4–48× zoom, plus a CPU hillshade pass on every new image. This layer
 * renders only the visible viewport at device resolution with the globe's sub-texel reconstruction
 * (smooth anti-aliased coastline from the height map, per-class color reconstruction, C1 relief
 * normals, zoom-dependent procedural detail — shared GLSL in shadersCommon.ts) and the same relief
 * shade response as the CPU fallback. Longitude wraps in the shader, so no world copies are needed.
 * Output is sRGB with alpha 0 beyond the poles; the caller composites it into its 2D canvas.
 */
import { buildFloatMips, type FloatMip } from './globeTextures';
import {
  GLSL_BASIS, GLSL_CONSTANTS, GLSL_RELIEF_RESPONSE, GLSL_SRGB_ENCODE, GLSL_TERRAIN_DETAIL, GLSL_TERRAIN_RECON,
} from './shadersCommon';
import type { MapTransform } from './viewMapTransform';
import { PLANET_RADIUS_M, SHADE_EXAGGERATION } from './viewUtil';

const VERTEX = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
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
uniform sampler2D uBase;
uniform sampler2D uHeight;
uniform vec2 uBaseSize;
uniform vec2 uHeightSize;
uniform float uHasHeight;
uniform float uSameSize;
uniform vec2 uView;
uniform vec3 uXform;
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
  float x = gl_FragCoord.x, y = uView.y - gl_FragCoord.y;
  float scale = uXform.z;
  float lat = uXform.y - (y - 0.5 * uView.y) / scale;
  if (abs(lat) > 0.5 * PI) {
    outColor = vec4(0.0);
    return;
  }
  float lon = uXform.x + (x - 0.5 * uView.x) / scale;
  vec2 st = vec2(fract(lon * (1.0 / TWO_PI) + 0.5), 0.5 - lat * (1.0 / PI));
  // Analytic screen derivatives (the equirect map is affine in lon/lat).
  vec2 dsx = vec2(1.0 / (TWO_PI * scale), 0.0), dsy = vec2(0.0, 1.0 / (PI * scale));
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
  // Only for one shared base/height raster (a base on another grid has its own land/sea mask).
  float k = hasH && uSameSize > 0.5 ? smoothstep(1.0, 0.5, pxRad / texRad) : 0.0;

  vec3 col = vec3(0.0);
  vec3 tilt = vec3(0.0);
  float detailAlbedo = 0.0;
  float rough = 0.0;
  if (k < 1.0) {
    col = textureGrad(uBase, st, dsx, dsy).rgb;
    if (lit) {
      vec2 d = max(1.0 / uHeightSize, abs(dsx) + abs(dsy));
      float hE = max(textureGrad(uHeight, st + vec2(d.x, 0.0), dsx, dsy).r, uSeaLevel);
      float hW = max(textureGrad(uHeight, st - vec2(d.x, 0.0), dsx, dsy).r, uSeaLevel);
      float hN = max(textureGrad(uHeight, st - vec2(0.0, d.y), dsx, dsy).r, uSeaLevel);
      float hS = max(textureGrad(uHeight, st + vec2(0.0, d.y), dsx, dsy).r, uSeaLevel);
      float land = step(uSeaLevel, textureGrad(uHeight, st, dsx, dsy).r);
      float gE = (hE - hW) / (2.0 * d.x * TWO_PI * cosLat);
      float gN = (hN - hS) / (2.0 * d.y * PI);
      tilt = uShadeScale * land * (gE * east + gN * north);
    }
  }
  if (k > 0.0) {
    vec3 warp = vec3(0.0);
    float ridgeW = smoothstep(400.0, 2500.0, textureGrad(uHeight, st, dsx, dsy).r - uSeaLevel);
    vec4 det = uDetail > 0.0 ? terrainDetail(n0, texRad, pxRad, ridgeW, warp) : vec4(0.0);
    warp = uDetail * (warp - dot(warp, n0) * n0);
    vec2 stw = st + vec2(dot(warp, east) / (TWO_PI * cosLat), -dot(warp, north) / PI);
    TerrainSample ts = reconstructTerrain(uHeight, uHeightSize, uBase, uBaseSize, uSameSize > 0.5, true, stw, uSeaLevel);
    float texRadH = PI / uHeightSize.y;
    float slopeReal = length(ts.g) / (texRadH * ${PLANET_RADIUS_M.toFixed(1)});
    float above = max(ts.h - uSeaLevel, 0.0);
    float r = clamp(max(smoothstep(0.004, 0.05, slopeReal), smoothstep(250.0, 3000.0, above)), 0.0, 1.0);
    float aa = max(length(ts.gm) * (pxRad / texRadH), 1e-4);
    float l = smoothstep(-0.5, 0.5, ts.m / aa);
    vec3 c = mix(ts.seaCol, ts.landCol, l);
    vec3 t = vec3(0.0);
    if (lit) {
      vec2 gt = terrainGradient(ts, texRadH / pxRad);
      float gE = gt.x * uHeightSize.x / (TWO_PI * cosLat);
      float gN = -gt.y * uHeightSize.y / PI;
      t = uShadeScale * l * (gE * east + gN * north);
      vec3 dg = det.yzw - dot(det.yzw, n0) * n0;
      t += (uDetail * l * (0.04 + 0.3 * r)) * dg;
    }
    col = mix(col, c, k);
    tilt = mix(tilt, t, k);
    detailAlbedo = k * l * det.x;
    rough = r;
  }
  if (lit) {
    vec3 n = normalize(n0 - saturateTilt(tilt));
    // Light from the north-west, 35° above the horizon (as the CPU hillshade).
    vec3 L = n0 * SIN_ALT + normalize(north - east) * COS_ALT;
    col *= reliefShade(dot(n, L) / SIN_ALT);
    col *= 1.0 + uDetail * (0.14 + 0.06 * rough) * detailAlbedo;
  }
  outColor = vec4(linearToSrgb(col), 1.0);
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

type Uniforms = Record<
  'uBase' | 'uHeight' | 'uBaseSize' | 'uHeightSize' | 'uHasHeight' | 'uSameSize' | 'uView' | 'uXform' | 'uSeaLevel' |
  'uShade' | 'uShadeScale' | 'uDetail',
  WebGLUniformLocation | null
>;

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

export class MapGlBase {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject | null;
  private readonly u: Uniforms;
  private readonly anisoExt: EXT_texture_filter_anisotropic | null;
  private baseTex: WebGLTexture | null = null;
  private heightTex: WebGLTexture | null = null;
  private baseW = 0;
  private baseH = 0;
  private heightW = 0;
  private heightH = 0;
  private mips: FloatMip[] | undefined;
  private contextLost = false;

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
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fs = compile(gl, gl.FRAGMENT_SHADER, MAP_BASE_FRAGMENT);
    const prog = gl.createProgram();
    if (!prog) throw new Error('mapGl: createProgram failed');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`mapGl: link failed: ${gl.getProgramInfoLog(prog)}`);
    this.program = prog;
    this.vao = gl.createVertexArray();
    const names: Array<keyof Uniforms> = [
      'uBase', 'uHeight', 'uBaseSize', 'uHeightSize', 'uHasHeight', 'uSameSize', 'uView', 'uXform', 'uSeaLevel', 'uShade',
      'uShadeScale', 'uDetail',
    ];
    this.u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(prog, n)])) as Uniforms;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
  }

  /** False after a context loss (the caller falls back to its Canvas 2D path). */
  get usable(): boolean {
    return !this.contextLost && !this.gl.isContextLost();
  }

  get hasBase(): boolean {
    return this.baseTex !== null;
  }

  /** Uploads the base image (sRGB RGBA8, row 0 = north) with a mip chain. Copies synchronously. */
  setBase(rgba: Uint8ClampedArray, w: number, h: number): void {
    if (!this.usable) return;
    const gl = this.gl;
    const data = new Uint8Array(rgba.buffer, rgba.byteOffset, w * h * 4);
    const fresh = !this.baseTex || w !== this.baseW || h !== this.baseH;
    if (fresh) {
      if (this.baseTex) gl.deleteTexture(this.baseTex);
      this.baseTex = gl.createTexture();
      this.baseW = w;
      this.baseH = h;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (fresh) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      if (this.anisoExt) {
        const max = gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
        gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
      }
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Uploads the height map (m) as R16F with a CPU box-filtered mip chain; null clears it. */
  setHeight(height: Float32Array | null, w: number, h: number): void {
    if (!this.usable) return;
    const gl = this.gl;
    if (!height) {
      if (this.heightTex) gl.deleteTexture(this.heightTex);
      this.heightTex = null;
      this.heightW = this.heightH = 0;
      this.mips = undefined;
      return;
    }
    const fresh = !this.heightTex || w !== this.heightW || h !== this.heightH;
    // Level 0 is uploaded straight from the caller's array (texImage2D copies synchronously).
    const level0 = height.subarray(0, w * h);
    const reuse = fresh ? undefined : this.mips;
    const mips = buildFloatMips(level0, w, h, reuse);
    this.mips = mips;
    if (fresh) {
      if (this.heightTex) gl.deleteTexture(this.heightTex);
      this.heightTex = gl.createTexture();
      this.heightW = w;
      this.heightH = h;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    for (let l = 0; l < mips.length; l++) {
      const m = mips[l];
      if (fresh) gl.texImage2D(gl.TEXTURE_2D, l, gl.R16F, m.width, m.height, 0, gl.RED, gl.FLOAT, m.data);
      else gl.texSubImage2D(gl.TEXTURE_2D, l, 0, 0, m.width, m.height, gl.RED, gl.FLOAT, m.data);
    }
    if (fresh) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    // The level-0 buffer belongs to the caller: do not keep it for the next reuse.
    mips[0] = { data: new Float32Array(0), width: w, height: h };
  }

  /**
   * Renders the viewport of transform `t` at device resolution. Returns the canvas (read it with
   * drawImage in the same task), or null when unusable / no base image.
   */
  render(o: MapGlRenderOptions): HTMLCanvasElement | null {
    if (!this.usable || !this.baseTex) return null;
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
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.uniform1i(this.u.uBase, 0);
    const hasH = this.heightTex !== null;
    gl.activeTexture(gl.TEXTURE1);
    // Without a height map texture unit 1 still needs a valid sampler: reuse the base (never read).
    gl.bindTexture(gl.TEXTURE_2D, hasH ? this.heightTex : this.baseTex);
    gl.uniform1i(this.u.uHeight, 1);
    gl.uniform2f(this.u.uBaseSize, this.baseW, this.baseH);
    gl.uniform2f(this.u.uHeightSize, hasH ? this.heightW : this.baseW, hasH ? this.heightH : this.baseH);
    gl.uniform1f(this.u.uHasHeight, hasH ? 1 : 0);
    gl.uniform1f(this.u.uSameSize, hasH && this.heightW === this.baseW && this.heightH === this.baseH ? 1 : 0);
    gl.uniform2f(this.u.uView, W, H);
    // Keep the center longitude small: large values lose float precision in the shader.
    gl.uniform3f(this.u.uXform, o.t.centerLon, o.t.centerLat, o.t.scale * (W / Math.max(1e-6, o.t.width)));
    gl.uniform1f(this.u.uSeaLevel, o.seaLevel);
    gl.uniform1f(this.u.uShade, o.shade ? 1 : 0);
    gl.uniform1f(this.u.uShadeScale, SHADE_EXAGGERATION / PLANET_RADIUS_M);
    gl.uniform1f(this.u.uDetail, Math.max(0, Math.min(1, o.detail)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    return this.canvas;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.baseTex) gl.deleteTexture(this.baseTex);
    if (this.heightTex) gl.deleteTexture(this.heightTex);
    this.baseTex = this.heightTex = null;
    gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.width = this.canvas.height = 0;
  }
}
