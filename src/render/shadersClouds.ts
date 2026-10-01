/**
 * Cloud shell shader (see cloudsField.ts for the model, whose constants are interpolated here).
 *
 * Per fragment (all geometry in SPEC axes, z north; the Three direction is converted once):
 *  - regimes from two RGBA grids (coverage, stratocumulus, deep convection, shallow cumulus; cirrus,
 *    open cells), crossfaded from the previous grids for ~1 s after an update (month / density
 *    changes morph instead of popping);
 *  - extratropical cyclones (uniform array, updated per frame) bias the local coverage with a comma
 *    template evaluated in a swirled frame (sharp trailing edge on the cold front), add cirrus over
 *    the head / warm conveyor and open cells in the cold sector, and swirl the synoptic noise domain
 *    (the mesoscale detail follows only DETAIL_SWIRL of it, the cirrus fibres none: no brush strokes
 *    or fanned-out fibres around the lows);
 *  - the noise: one large-scale warp and a synoptic shape fetch (zonally stretched) from the smooth
 *    tileable volume, then 2–4 isotropic mesoscale / convective-scale octaves (ratio 2.6) from the
 *    detail volume, which stores its analytic gradient: each octave is warped a little by the
 *    previous one's gradient, shaped per regime between plain fbm (fronts, stratus), soft billows
 *    (cumulus, convective cores, closed cells) and ridges (open cells), with a regime-dependent
 *    spectrum (convection, cumulus fields and stratocumulus decks textured at the finest resolved
 *    scale), and band-limited to the pixel footprint (an octave fades in between 0.75 and 1.4 px per
 *    lattice cell: pixel-scale speckle at the default zoom). Stratocumulus and open cells add a
 *    Worley honeycomb (cell volume) whose walls the detail wobbles; deep convection is sorted into
 *    ~360 km clusters (the cell volume again) with clearer gaps between them. Everything is advected with
 *    the synoptically smoothed wind by two-phase flow mapping: each phase is displaced upstream by
 *    wind·time within a cycle and re-seeded (on a slow drift path, so structures persist) while its
 *    weight is zero; the phases are crossfaded with variance restoration. Detail is skipped where the
 *    shape noise leaves no chance of cloud;
 *  - the coverage fraction sets the threshold z_thr = Φ⁻¹(1 − f), the excess above it a continuous,
 *    log-normally textured optical depth → opacity (texture from the finest resolved octaves) that
 *    grows from zero at the threshold (soft but detailed edges, thin translucent veils over most of
 *    the cloudy area) to bright opaque cores only well inside (fronts, storm centres, convection),
 *    scaled by the climate's cloud thickness (aux grid);
 *  - upper cloud over the low clouds: cirrus veils (patches striated by coarse streaks and, up close,
 *    fine fibres along the zonal flow) and the smooth, soft-edged anvils around deep-convective cores;
 *  - lighting follows the surface's mode: sun (terminator, twilight tint, night), relief (camera
 *    light, taken 60° high for the cloud tops) or flat. Cloud tops are bump-lit gently from the
 *    synoptic height (screen-space derivatives) plus the analytic gradient of the fine detail (per
 *    pixel, no 2×2 blocks), deep only for convective towers and cumulus; decks and fronts stay flat;
 *    thin cloud is a pale translucent veil, the limb whiter (longer slant path) with a blue haze;
 *  - cloud shadows on the ground: the output is premultiplied (blend ONE, ONE_MINUS_SRC_ALPHA) and
 *    its alpha also darkens the ground seen through the gaps by the synoptic cloud field at the point
 *    that shades it (first order from its screen-space gradient: no extra fetches).
 */
import {
  CLOUD_CELL_EDGE_RANGE, CLOUD_CELL_PERIOD, CLOUD_CELL_SIZE, CLOUD_DETAIL_GRAD_K, CLOUD_DETAIL_PERIOD, CLOUD_DETAIL_SIZE,
  CLOUD_NOISE_STD,
} from './cloudsNoise';
import {
  ALPHA_MAX, ANISO, ANVIL_SOFT, BIAS_REF, CYCLONE_BIAS_GAIN, ANVIL_SPREAD, ANVIL_TAU, BILLOW_EPS, BILLOW_INV_SD, BILLOW_MEAN, BRIGHT_K, CELL_DETAIL_WARP, CELL_FADE_PX,
  CELL_SCALE, CELL_WARP, CIRRUS_ANISO, CIRRUS_BASE, CIRRUS_COARSE, CIRRUS_COARSE_W, CLUSTER_GAIN, CLUSTER_MEAN, CLUSTER_ROUGH, CLUSTER_SCALE, CLUSTER_WARP, CIRRUS_SCALE, CIRRUS_STRAND_MEAN, CIRRUS_TAU, CIRRUS_WARP, DETAIL_AMP, DETAIL_ANISO, DETAIL_CORR_LENGTH,
  DETAIL_EDGE_BOOST, DETAIL_FLOOR, DETAIL_GRAD_WARP, DETAIL_SCALES, DETAIL_SWIRL, DETAIL_WARP, EXCESS_REF, EXCESS_REF_K,
  FIELD_GLSL_CONSTANTS as K, NOISE_SWIRL, OCTAVE_FADE_PX,
  OPEN_CELL_SCALE, ORGANIZED_CALM, ORGANIZED_COARSE, REGIME_OFFSET_CU, REGIME_OFFSET_CV, REGIME_OFFSET_SC, SHAPE_CORR_LENGTH, SHAPE_SCALE, TAU_CONVECTIVE, TAU_FRONT, TAU_POW, TAU_SCALE,
  TAU_DETAIL, TAU_DETAIL_CV, TAU_EDGE, TAU_TEXTURE, THIN_BRIGHT, VEIL_ALPHA, VEIL_SOFT, VEIL_SPREAD, WARP_AMP, WARP_SCALE,
} from './cloudsField';
import { CYCLONE_COUNT, THICK_MAX } from './cloudsModel';
import { GLYPH_CODES } from './cloudsDebug';
import { GLSL_CONSTANTS } from './shadersCommon';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const v3 = (a: number[]): string => `vec3(${a.map(f).join(', ')})`;
const v4 = (a: number[]): string => `vec4(${a.map(f).join(', ')})`;

/** Detail-volume texels per lattice cell. */
const TEXELS_PER_CELL = CLOUD_DETAIL_SIZE / CLOUD_DETAIL_PERIOD;

export const CLOUDS_FRAGMENT = /* glsl */ `
${GLSL_CONSTANTS}
uniform sampler2D uGrid;
uniform sampler2D uAux;
uniform sampler2D uGridPrev;
uniform sampler2D uAuxPrev;
uniform sampler2D uWind;
uniform sampler2D uWindPrev;
uniform float uMix;
uniform sampler3D uNoise;
uniform sampler3D uDetail;
uniform sampler3D uCells;
uniform float uHasWind;
uniform float uTime;
uniform float uCycle;
// Per-octave quality mask on the detail octaves' footprint fade (CloudQuality).
uniform vec4 uOctaveMask;
uniform float uFlow;
uniform float uOpacity;
uniform float uShadow;
uniform float uShadowHeight;
// The flow phases' noise-space drift (noiseDrift() of cycles floor(t), floor(t + ½) − ½ and of
// t − ½ for the warp): per frame on the CPU.
uniform vec3 uDrift0;
uniform vec3 uDrift1;
uniform vec3 uDriftW;
uniform int uLightMode;
uniform vec3 uSunDir;
uniform vec3 uAtmoColor;
uniform vec3 uCamUpLeft;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;
// Cyclone effects from the vertex shader (smooth at ≥ 0.05 rad; the shell's vertices are 0.02 apart):
// coverage bias, cirrus, open cells; and the swirl displacement of the noise domain.
varying vec3 vCyc;
varying vec3 vDisp;

const float INV_STD = ${f(1 / CLOUD_NOISE_STD)};
const float WARP_SCALE = ${f(WARP_SCALE)};
const float WARP_AMP = ${f(WARP_AMP)};
const float SHAPE_SCALE = ${f(SHAPE_SCALE)};
const vec4 DS = ${v4(DETAIL_SCALES)};
// Lattice cells per unit of noise domain for each detail octave (for the footprint fade).
const vec4 DCELLS = ${v4(DETAIL_SCALES.map((s) => s * CLOUD_DETAIL_PERIOD))};
const float LOG2_TEXELS_PER_CELL = ${f(Math.log2(TEXELS_PER_CELL))};
// Mip bias of the detail fetches (texels per pixel 2^-bias): sharper than standard mipmapping, but
// sharp LOD-0 fetches across a large 3D texture thrash the texture cache (2× the cost).
const float LOD_SHARPEN = 0.35;
// Gradient channel → σ per lattice cell.
const float GRAD_DEC = ${f(1 / CLOUD_DETAIL_GRAD_K)};
const float GRAD_WARP = ${f(DETAIL_GRAD_WARP / CLOUD_DETAIL_PERIOD / CLOUD_DETAIL_GRAD_K)};
const float DETAIL_AMP = ${f(DETAIL_AMP)};
const float DETAIL_FLOOR = ${f(DETAIL_FLOOR)};
const float DETAIL_EDGE_BOOST = ${f(DETAIL_EDGE_BOOST)};
const float DETAIL_WARP = ${f(DETAIL_WARP)};
// The part of the cyclone swirl the detail does not follow.
const float DETAIL_UNSWIRL = ${f(1 - DETAIL_SWIRL)};
const float BILLOW_EPS2 = ${f(BILLOW_EPS ** 2)};
const float BILLOW_MEAN = ${f(BILLOW_MEAN)};
const float BILLOW_INV_SD = ${f(BILLOW_INV_SD)};
const float TAU_SCALE = ${f(TAU_SCALE)};
const float TAU_POW = ${f(TAU_POW)};
const float BIAS_REF = ${f(BIAS_REF)};
const float TAU_FRONT = ${f(TAU_FRONT)};
const float ORGANIZED_CALM = ${f(ORGANIZED_CALM)};
const float ORGANIZED_COARSE = ${f(ORGANIZED_COARSE)};
const float TAU_CONVECTIVE = ${f(TAU_CONVECTIVE)};
const float THICK_MAX = ${f(THICK_MAX)};
const float ALPHA_MAX = ${f(ALPHA_MAX)};
const float THIN_BRIGHT = ${f(THIN_BRIGHT)};
const float BRIGHT_K = ${f(BRIGHT_K)};
const float TAU_TEXTURE = ${f(TAU_TEXTURE)};
const float INV_SHAPE_CORR2 = ${f(1 / SHAPE_CORR_LENGTH ** 2)};
const float INV_DETAIL_CORR = ${f(1 / DETAIL_CORR_LENGTH)};
const vec3 ANISO3 = vec3(1.0, 1.0, ${f(ANISO)});
// Detail domain: the shape's zonal stretch undone down to a mild one.
const vec3 DANISO3 = vec3(1.0, 1.0, ${f(DETAIL_ANISO / ANISO)});
const vec3 CIRRUS3 = vec3(1.0, 1.0, ${f(CIRRUS_ANISO / ANISO)});
const float CIRRUS_SCALE = ${f(CIRRUS_SCALE)};
const float CIRRUS_TAU = ${f(CIRRUS_TAU)};
const float CIRRUS_WARP = ${f(CIRRUS_WARP)};
const float CIRRUS_STRAND_MEAN = ${f(CIRRUS_STRAND_MEAN)};
const float CIRRUS_BASE = ${f(CIRRUS_BASE)};
const float CIRRUS_COARSE = ${f(CIRRUS_COARSE)};
const float CIRRUS_COARSE_W = ${f(CIRRUS_COARSE_W)};
const float ANVIL_SPREAD = ${f(ANVIL_SPREAD)};
const float ANVIL_TAU = ${f(ANVIL_TAU)};
const float ANVIL_SOFT = ${f(ANVIL_SOFT)};
const float RO_CU = ${f(REGIME_OFFSET_CU)};
const float RO_SC = ${f(REGIME_OFFSET_SC)};
const float RO_CV = ${f(REGIME_OFFSET_CV)};
const float CELL_SCALE = ${f(CELL_SCALE)};
const float CELL_WARP = ${f(CELL_WARP)};
// Second detail octave's gradient channel (byte/255 − 0.5) → cell-lattice warp (tile units).
const float CELL_DWARP = ${f(CELL_DETAIL_WARP / CLOUD_DETAIL_GRAD_K)};
const float CELL_EDGE_RANGE = ${f(CLOUD_CELL_EDGE_RANGE)};
const float CELLS_PER_UNIT = ${f(CELL_SCALE * CLOUD_CELL_PERIOD)};
const float OPEN_CELL_SCALE = ${f(OPEN_CELL_SCALE)};
const float CLUSTER_SCALE = ${f(CLUSTER_SCALE)};
const float CLUSTER_WARP = ${f(CLUSTER_WARP)};
const float CLUSTER_GAIN = ${f(CLUSTER_GAIN)};
const float CLUSTER_MEAN = ${f(CLUSTER_MEAN)};
const float CLUSTER_ROUGH = ${f(CLUSTER_ROUGH)};
// Cloud-top relief height per σ of synoptic noise (world units) for bump lighting: gentle (broad
// light and shade over whole cloud masses reads as impasto).
const float RELIEF_HEIGHT = 0.0015;
// Bump slope per σ/cell of detail gradient (sub-pixel cloud-top texture), per octave: the fine
// octaves (turrets, cauliflower), hardly the coarse one.
const vec4 DETAIL_SLOPE = vec4(0.006, 0.016, 0.016, 0.012);
const vec3 OFF_W = ${v3(K.OFF_W)};
const vec3 OFF_B = ${v3(K.OFF_B)};
const vec3 OFF_D = ${v3(K.OFF_D)};
const vec3 OFF_E = ${v3(K.OFF_E)};
const vec3 OFF_F = ${v3(K.OFF_F)};
const vec3 OFF_G = ${v3(K.OFF_G)};
const vec3 OFF_C = ${v3(K.OFF_C)};
const vec3 OFF_C2 = ${v3(K.OFF_C2)};
const vec3 OFF_H = ${v3(K.OFF_H)};
const mat3 ROT = mat3(${K.ROT.map(f).join(', ')});
// Relief light elevation above the local horizon (35°), as the surface shader.
const float SIN_ALT = 0.573576;
const float COS_ALT = 0.819152;

float sstep(float a, float b, float x) { return smoothstep(a, b, x); }

// Cell volume at both flow phases (scale: tiles per unit), blended; r = distance to the cell border
// (/ CELL_EDGE_RANGE), g = distance to the centre (/ 1.2), b = per-cell random value. wv: the phase's
// shape-fetch warp channels (− 0.5), g2: its second detail octave's gradient channels (− 0.5).
// Explicit LOD (non-uniform control flow).
vec4 cellFetch(vec3 qw0, vec3 wv0, vec3 g20, float w0, vec3 qw1, vec3 wv1, vec3 g21, float w1, float scale, float px) {
  float lodK = max(0.0, log2(px * scale * ${f(CLOUD_CELL_SIZE)}) - LOD_SHARPEN);
  vec3 k0 = ROT * (qw0 * DANISO3) * scale + wv0 * (INV_STD * CELL_WARP) + g20 * CELL_DWARP + OFF_H;
  vec3 k1 = ROT * (qw1 * DANISO3) * scale + wv1 * (INV_STD * CELL_WARP) + g21 * CELL_DWARP + OFF_H;
  return w0 * textureLod(uCells, k0, lodK) + w1 * textureLod(uCells, k1, lodK);
}

// Texture parameters per regime (mirror detailParams()): p.x, p.y = billow (+) / ridge (−) shaping of
// the coarse and fine octaves, p.z = gain between the finer octaves, p.w = detail amplitude factor;
// q.x = weight of the coarse octave, q.y = detail amplitude floor. vary: independent N(0,1).
void detailParams(float sc, float cv, float cu, float open, float vary, out vec4 p, out vec2 q) {
  float bc = 0.05 + 0.1 * cv + 0.45 * cu + 0.15 * sc - 0.5 * open;
  float bf = 0.15 + 0.35 * cv + 0.65 * cu + 0.15 * sc - 1.6 * open;
  float gain = clamp(0.62 + 0.25 * cv + 0.4 * cu + 0.3 * sc + 0.2 * open + 0.06 * vary, 0.4, 1.0);
  float am = (1.0 - 0.1 * cv + 0.8 * cu + 0.4 * open - 0.2 * sc) * clamp(1.0 + 0.3 * vary, 0.55, 1.5);
  p = vec4(clamp(vec2(bc, bf), -1.0, 1.0), gain, am);
  q = vec2(clamp(1.0 - 0.65 * cu - 0.3 * open - 0.55 * sc - 0.5 * cv, 0.3, 1.0), DETAIL_FLOOR + 0.55 * min(1.0, cu + open));
}

// Regime shaping of one octave (mirror shapeOctave()): sh = (linear, billow) weights from
// shaping(): beta 0 = plain noise, +1 = billows (soft |n|), −1 = ridges (−|n|); zero mean, ~unit
// variance. Returns the shaped value, dT/dn in dt.
float shapeOctave(float n, vec2 sh, out float dt) {
  float sa = sqrt(n * n + BILLOW_EPS2);
  dt = sh.x + sh.y * (n / sa);
  return sh.x * n + sh.y * (sa - BILLOW_MEAN);
}

vec2 shaping(float beta) {
  float ab = abs(beta);
  float inv = inversesqrt((1.0 - ab) * (1.0 - ab) + ab * ab);
  return vec2((1.0 - ab) * inv, beta * BILLOW_INV_SD * inv);
}

// Detail stack of one flow-map phase at warped noise-domain point qw (wv: that phase's shape-fetch
// warp channels − 0.5, which warp the first octave a little): 2–4 octaves of the detail volume, each
// rotated, 2.6× finer and warped slightly by the previous one's gradient, with amplitudes
// [coarse, g, g², g³]. Returns d (≈ N(0,1), shaped: the cloud mask's detail); dt: the optical-depth
// texture noise (mirror detailTexture(): mostly the finer octaves); n1: the coarse octave (faded);
// g2: the second octave's gradient channels (− 0.5, the cell walls' wobble); gl: the bump-lighting
// slope (σ per lattice cell, weighted per octave). sh: shaping() of the coarse (xy) and fine (zw)
// octaves. Explicit LODs: this runs in non-uniform control flow (skipped where no cloud is possible).
void phaseDetail(vec3 qw, vec3 wv, vec4 sh, float coarse, float gain, vec4 fade, vec4 lod,
    out float d, out float dt, out float n1o, out vec3 g2, out vec3 gl) {
  vec3 a1 = ROT * (qw * DANISO3);
  vec4 t1 = textureLod(uDetail, a1 * DS.x + wv * (INV_STD * DETAIL_WARP) + OFF_D, lod.x);
  vec3 a2 = ROT * a1;
  vec4 t2 = textureLod(uDetail, a2 * DS.y + (t1.gba - 0.5) * GRAD_WARP + OFF_E, lod.y);
  float dt1, dt2;
  float amp1 = coarse * fade.x, amp2 = gain * fade.y;
  float n1 = (t1.r - 0.5) * INV_STD, n2 = (t2.r - 0.5) * INV_STD;
  d = amp1 * shapeOctave(n1, sh.xy, dt1) + amp2 * shapeOctave(n2, sh.xy, dt2);
  float fine = fade.y * n2;
  float c1 = amp1 * dt1, c2 = amp2 * dt2;
  // Slope accumulated from the finest octave outward (Horner in ROTᵀ: one product per octave).
  vec3 accL = vec3(0.0);
  if (fade.z > 0.02) {
    vec3 a3 = ROT * a2;
    vec4 t3 = textureLod(uDetail, a3 * DS.z + (t2.gba - 0.5) * GRAD_WARP + OFF_F, lod.z);
    float dt3;
    float amp3 = gain * gain * fade.z;
    float n3 = (t3.r - 0.5) * INV_STD;
    d += amp3 * shapeOctave(n3, sh.zw, dt3);
    fine += gain * fade.z * n3;
    float c3 = amp3 * dt3;
    if (fade.w > 0.02) {
      vec4 t4 = textureLod(uDetail, (ROT * a3) * DS.w + (t3.gba - 0.5) * GRAD_WARP + OFF_G, lod.w);
      float dt4;
      float amp4 = gain * gain * gain * fade.w;
      float n4 = (t4.r - 0.5) * INV_STD;
      d += amp4 * shapeOctave(n4, sh.zw, dt4);
      fine += gain * gain * fade.w * n4;
      accL = ((t4.gba - 0.5) * (amp4 * dt4 * DETAIL_SLOPE.w)) * ROT;
    }
    accL = (accL + (t3.gba - 0.5) * (c3 * DETAIL_SLOPE.z)) * ROT;
  }
  g2 = t2.gba - 0.5;
  vec3 g1 = t1.gba - 0.5;
  accL = ((accL + g2 * (c2 * DETAIL_SLOPE.y)) * ROT + g1 * (c1 * DETAIL_SLOPE.x)) * ROT;
  float g2n = gain * gain;
  float dn = inversesqrt(coarse * coarse + g2n * (1.0 + g2n * (1.0 + g2n)));
  d *= dn;
  n1o = fade.x * n1;
  dt = 0.35 * n1o + 0.94 * fine * inversesqrt(1.0 + g2n * (1.0 + g2n));
  // Back from the detail domain to the unit sphere (z was scaled by the detail anisotropy); the
  // gradient channels decode to σ per lattice cell (GRAD_DEC).
  gl = accL * (dn * GRAD_DEC) * (ANISO3 * DANISO3);
}

vec3 toSpec(vec3 t) { return vec3(t.x, -t.z, t.y); }
vec3 toThree(vec3 s) { return vec3(s.x, s.z, -s.y); }

#ifdef CLOUD_DEBUG
// Debug view (?cloudDebug, cloudsDebug.ts): width of the cloud grid on screen.
uniform float uGridW;

float glyphCode(float g) {
${GLYPH_CODES.map((c, i) => `  if (g < ${i}.5) return ${c}.0;`).join('\n')}
  return 0.0;
}

// Bit (col, row) of glyph g (row 0 at the top).
float glyphBit(float g, vec2 c) {
  return mod(floor(glyphCode(g) / exp2(c.y * 3.0 + c.x)), 2.0);
}

// Three glyphs (3×5 cells, 1-cell gaps) at text coordinates q (cells, origin top-left).
float text3(vec2 q, float g0, float g1, float g2) {
  if (q.x < 0.0 || q.y < 0.0 || q.x >= 11.0 || q.y >= 5.0) return 0.0;
  float i = floor(q.x / 4.0);
  float cx = q.x - 4.0 * i;
  if (cx >= 3.0) return 0.0;
  return glyphBit(i < 0.5 ? g0 : i < 1.5 ? g1 : g2, vec2(floor(cx), floor(q.y)));
}

// Premultiplied debug colour of a 15° tile: tint by the effective octave count (level) (red: 2 or
// fewer, yellow: 3, green: 4), the level (one decimal) over the grid width as text, tile borders.
vec4 debugTile(vec2 st, float lat, float level) {
  vec2 tile = vec2(st.x * 24.0, st.y * 12.0);
  vec2 f = fract(tile);
  vec3 tint = level < 2.5 ? mix(vec3(0.9, 0.15, 0.1), vec3(0.95, 0.8, 0.1), clamp(level - 1.5, 0.0, 1.0))
    : mix(vec3(0.95, 0.8, 0.1), vec3(0.15, 0.85, 0.3), clamp(level - 2.5, 0.0, 1.0));
  float a = 0.35;
  vec3 col = tint;
  vec2 fw = fwidth(tile);
  vec2 edge = min(f, 1.0 - f) / max(fw, vec2(1e-6));
  if (min(edge.x, edge.y) < 1.0) { col = vec3(1.0); a = 0.5; }
  float cl = cos(lat);
  if (cl > 0.3) {
    // Square text cells on the sphere: 11 cells = 60 % of the tile height.
    float cv = 0.6 / 11.0, cu = cv / cl;
    vec2 q = vec2((f.x - 0.5) / cu + 5.5, (f.y - 0.5) / cv + 5.5);
    float L = clamp(level, 0.0, 4.0);
    float d0 = floor(L), d1 = min(9.0, floor((L - d0) * 10.0));
    float gw = floor(uGridW + 0.5);
    float on = text3(q, d0, 10.0, d1) + text3(q - vec2(0.0, 6.0), floor(gw / 100.0), mod(floor(gw / 10.0), 10.0), mod(gw, 10.0));
    if (on > 0.5) { col = vec3(1.0); a = 0.95; }
  }
  return vec4(col * a, a);
}
#endif

void main() {
  vec3 n3 = normalize(vDir);            // Three axes
  vec3 p = toSpec(n3);                  // SPEC axes (z north)
  // Pixel footprint (radians) and surface derivatives, in uniform control flow.
  vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
  float px = max(max(length(dpx), length(dpy)) / length(vWorld), 1e-6);
  // Grid lookups from the exact direction (the interpolated uv is off by up to a texel between
  // sphere segments, which printed faint seams). No mipmaps on the grids: the lon wrap is harmless.
  vec2 st = vec2(atan(p.y, p.x) * ${f(1 / (2 * Math.PI))} + 0.5, 0.5 - asin(clamp(p.z, -1.0, 1.0)) * ${f(1 / Math.PI)});
#ifdef CLOUD_DEBUG
  {
    // The detail octaves' footprint fades (as below) × the quality mask, summed: 0–4 octaves.
    vec4 fd = smoothstep(${f(OCTAVE_FADE_PX[0])}, ${f(OCTAVE_FADE_PX[1])}, 1.0 / (px * DCELLS)) * uOctaveMask;
    gl_FragColor = debugTile(st, asin(clamp(p.z, -1.0, 1.0)), fd.x + fd.y + fd.z + fd.w);
    return;
  }
#endif
  vec4 grid = texture(uGrid, st);
  vec4 aux = texture(uAux, st);
  if (uMix < 1.0) {
    grid = mix(texture(uGridPrev, st), grid, uMix);
    aux = mix(texture(uAuxPrev, st), aux, uMix);
  }
  float cov = grid.r;
  if (cov < 0.004) discard;
  float sc = grid.g, cv = grid.b, cu = grid.a;

  float cl = max(length(p.xy), 1e-5);
  vec3 east = vec3(-p.y, p.x, 0.0) / cl;
  vec3 north = cross(p, east);

  vec3 disp = vDisp;
  vec3 cyc = vCyc;
  float bias = cyc.x;
  float cirrus = clamp(aux.r + 0.5 * cyc.y, 0.0, 1.0);
  float open = clamp(aux.g + cyc.z, 0.0, 1.0);
  // Cloud thickness of the climate (mirror cloudThickness()).
  float thickness = aux.b * THICK_MAX;

  vec3 flow = vec3(0.0);
  if (uHasWind > 0.5) {
    vec2 w = texture(uWind, st).rg;
    if (uMix < 1.0) w = mix(texture(uWindPrev, st).rg, w, uMix);
    flow = w.x * east + w.y * north;
  }
  // Detail octaves: pixels per lattice cell → fade (1.4 → 0.75 px) and a LOD that stays sharp until then.
  vec4 ppc = 1.0 / (px * DCELLS);
  // (Below ~0.75 px per cell an octave is invisible yet costs a full-rate fetch per phase.)
  // × the quality mask: standard-quality clouds skip the two finest octaves (their fetches too).
  vec4 fade = smoothstep(${f(OCTAVE_FADE_PX[0])}, ${f(OCTAVE_FADE_PX[1])}, ppc) * uOctaveMask;
  vec4 lod = max(vec4(0.0), LOG2_TEXELS_PER_CELL - log2(ppc) - LOD_SHARPEN);

  float t = uTime / uCycle;
  float ph0 = fract(t), ph1 = fract(t + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0), w1 = 1.0 - w0;
  float span = uFlow * uCycle;
  // Both phases sample the same noise; each re-seeds (while invisible) at its point on a slow,
  // bounded quasi-periodic path through noise space, so structures persist across cycles and the
  // weather evolves gradually instead of cross-dissolving into an unrelated pattern.
  vec3 q0 = (normalize(p - flow * (span * (ph0 - 0.5))) + disp) * ANISO3 + uDrift0;
  vec3 q1 = (normalize(p - flow * (span * (ph1 - 0.5))) + disp) * ANISO3 + uDrift1;
  // One large-scale warp for both phases, drifting continuously along the same path (~4000 km
  // features: not advecting them is invisible, and it saves a fetch per phase).
  vec3 wv = texture(uNoise, ((p + disp) * ANISO3 + uDriftW) * WARP_SCALE + OFF_W).gba - 0.5;
  vec3 qw0 = q0 + WARP_AMP * INV_STD * wv;
  vec3 qw1 = q1 + WARP_AMP * INV_STD * wv;
  vec4 b0 = texture(uNoise, qw0 * SHAPE_SCALE + OFF_B);
  vec4 b1 = texture(uNoise, qw1 * SHAPE_SCALE + OFF_B);
  vec3 wb0 = b0.gba - 0.5, wb1 = b1.gba - 0.5;
  // Detail domain: only DETAIL_SWIRL of the storms' swirl (the rest drew the cumulus and cells out
  // into brush strokes around the lows); cirrus fibres: none (swirled fibres fanned out into beams).
  vec3 dispA = disp * ANISO3;
  vec3 qd0 = qw0 - DETAIL_UNSWIRL * dispA, qd1 = qw1 - DETAIL_UNSWIRL * dispA;
  // Variance-restoring crossfade. The phases are correlated (same noise a small offset apart: ρ ≈ 1
  // in calm air), so normalize with that correlation (fits of the noise autocorrelation, see
  // SHAPE_CORR_LENGTH), not as if independent, which pulsed contrast and coverage globally.
  vec3 dq = q0 - q1;
  float dq2 = dot(dq, dq);
  float wsq = w0 * w0 + w1 * w1, wx = 2.0 * w0 * w1;
  float norm = inversesqrt(wsq + wx * exp(-dq2 * INV_SHAPE_CORR2));
  float normD = inversesqrt(wsq + wx * exp(-sqrt(dq2) * INV_DETAIL_CORR));
  float nb = (w0 * (b0.r - 0.5) + w1 * (b1.r - 0.5)) * (INV_STD * norm);

  // Surface gradients (per world unit) from screen-space derivatives, in uniform control flow: of
  // the synoptic noise (cloud-top relief; derivatives come per 2×2 pixel quad, so fast-varying detail
  // would shade in blocks: its gradient is analytic instead) and of the cyclone bias (edge width and
  // shadow shift only: it is interpolated per vertex, so its gradient is piecewise constant).
  vec3 r1 = cross(dpy, n3), r2 = cross(n3, dpx);
  float det = dot(dpx, r1);
  float idet = abs(det) > 1e-14 ? 1.0 / det : 0.0;
  vec3 bumpGrad = (dFdx(nb) * r1 + dFdy(nb) * r2) * idet;
  vec3 fieldGrad = bumpGrad + (dFdx(bias) * r1 + dFdy(bias) * r2) * idet;

  // Threshold (mirror coverageThreshold).
  float fc = clamp(cov, 0.002, 0.998);
  float zthr0 = log((1.0 - fc) / fc) * ${f(1 / 1.702)};
  float zthr = zthr0 - bias;
  // Texture variation: an independent ~650 km noise (sheets next to broken fields; cluster sizes).
  float vary = (w0 * (b0.a - 0.5) + w1 * (b1.a - 0.5)) * (INV_STD * norm);
  // Deep-convective clusters (mirror clusterCore() / clusterBias()): ~360 km cells sort convection
  // into bright clusters of varied size with clearer gaps (part of the cells' warp, no detail warp).
  float clCore = 0.0;
  if (cv > 0.02) {
    vec4 kq = cellFetch(qd0, wb0 * CLUSTER_WARP, vec3(0.0), w0, qd1, wb1 * CLUSTER_WARP, vec3(0.0), w1, CLUSTER_SCALE, px);
    clCore = 1.0 - sstep(0.15, clamp(0.6 + 0.25 * vary, 0.3, 0.95), kq.g * 1.2);
    zthr -= cv * CLUSTER_GAIN * (clCore - CLUSTER_MEAN);
  }
  // Excess for the reference optical depth (mirror excessRef()).
  float exRef = ${f(EXCESS_REF)} - ${f(EXCESS_REF_K)} * min(zthr0, 0.0);

  // Texture regime (mirror detailParams): billow / ridge shaping of the coarse and fine octaves,
  // spectrum (coarse weight, gain) and amplitude (clumpy convection, speckled cumulus fields, finely
  // cellular stratocumulus decks), varied in space by an independent ~650 km noise (sheets next to
  // broken fields).
  vec4 dpar;
  vec2 dq2p;
  detailParams(sc, cv, cu, open, vary, dpar, dq2p);
  // Organized frontal / comma cloud: continuous sheets, without the coarse octave's holes.
  float organized = sstep(0.3, 1.5, bias);
  dq2p.x *= 1.0 - ORGANIZED_COARSE * organized;
  vec4 sh = vec4(shaping(dpar.x), shaping(dpar.y));
  float gain = dpar.z;

  // Detail only where cloud (or an anvil) is possible at all.
  float nd = 0.0, ndt = 0.0, n1 = 0.0;
  vec3 gl = vec3(0.0), g20 = vec3(0.0), g21 = vec3(0.0);
  if (nb > zthr - 2.8) {
    float nd0, nd1, dt0, dt1, n10, n11;
    vec3 gl0, gl1;
    phaseDetail(qd0, wb0, sh, dq2p.x, gain, fade, lod, nd0, dt0, n10, g20, gl0);
    phaseDetail(qd1, wb1, sh, dq2p.x, gain, fade, lod, nd1, dt1, n11, g21, gl1);
    nd = (w0 * nd0 + w1 * nd1) * normD;
    ndt = (w0 * dt0 + w1 * dt1) * normD;
    n1 = (w0 * n10 + w1 * n11) * normD;
    gl = (w0 * gl0 + w1 * gl1) * normD;
  }

  // Regime mix (mirror combineNoise): detail strongest at the edges (fractal outlines), weaker but
  // present inside (textured tops); cumulus fields broken throughout (higher floor).
  float exb = nb - zthr;
  float edge = exp(-2.0 * exb * exb);
  // Organized frontal / comma cloud (strong positive cyclone bias): smoother, sharper-edged sheets.
  float amp = DETAIL_AMP * (dq2p.y + DETAIL_EDGE_BOOST * edge) * dpar.w * (1.0 - ORGANIZED_CALM * organized);
  float ia = inversesqrt(1.0 + amp * amp);
  // + the clusters' ragged outlines (mirror clusterRough()).
  float ex = (nb + amp * nd) * ia + RO_CU * cu + RO_SC * sc + RO_CV * cv - zthr + cv * CLUSTER_GAIN * CLUSTER_ROUGH * clCore * nd;
  // Mesoscale cellular convection (mirror cellStage / closedCells / openCells): a Worley honeycomb
  // in stratocumulus (darker walls, domed brighter centres, per-cell brightness; ~46 km cells) and
  // open cells (cloudy rings around clear centres; ~2x larger), each fetched only in its regime and
  // when resolved; the walls wobble with the detail.
  float cellTau = 1.0;
  float fadeClosed = sc * smoothstep(${f(CELL_FADE_PX[0])}, ${f(CELL_FADE_PX[1])}, 1.0 / (px * CELLS_PER_UNIT));
  float fadeOpen = open * smoothstep(${f(CELL_FADE_PX[0])}, ${f(CELL_FADE_PX[1])}, 1.0 / (px * CELLS_PER_UNIT * OPEN_CELL_SCALE));
  if (fadeClosed > 0.02 && ex > -1.5) {
    vec4 kc = cellFetch(qd0, wb0, g20, w0, qd1, wb1, g21, w1, CELL_SCALE, px);
    float f1 = min(1.0, kc.g * kc.g * 1.44);
    cellTau = 1.0 + fadeClosed * ((0.72 + 0.28 * sstep(0.0, 0.25, kc.r * CELL_EDGE_RANGE)) * (0.85 + 0.3 * kc.b) * (1.1 - 0.4 * f1) - 1.0);
  }
  if (fadeOpen > 0.02 && ex > -1.5) {
    vec4 ko = cellFetch(qd0, wb0, g20, w0, qd1, wb1, g21, w1, CELL_SCALE * OPEN_CELL_SCALE, px);
    // Ring edge softened to ~a pixel (cell units per pixel = px * cells per unit).
    float ring = 1.0 - sstep(0.05, 0.3 + px * CELLS_PER_UNIT * OPEN_CELL_SCALE, ko.r * CELL_EDGE_RANGE);
    // Lumpy, broken rings (cumulus along the cell walls), not a continuous net.
    ex += fadeOpen * (1.3 * ring * (0.75 + 0.35 * clamp(nd, -1.5, 1.5)) - 0.85);
  }
  // Anvils (mirror anvilAlpha): a smooth sheet around the convective cores, under their tops.
  float alphaA = 0.0;
  if (cv > 0.02) {
    float xa = exb + ANVIL_SPREAD + 0.5 * n1 + 0.3 * ndt;
    alphaA = ANVIL_TAU * cv * sstep(0.0, ANVIL_SOFT, xa) * (0.45 + 0.55 * sstep(ANVIL_SOFT, 5.0 * ANVIL_SOFT, xa));
  }
  // Thin veil around and under the cloud masses (mirror veilAlpha): cloud systems fade out through a
  // translucent margin; composited with the anvils as one sheet under the low cloud.
  float xv = exb + ${f(VEIL_SPREAD)} + 0.35 * n1;
  if (xv > 0.0) {
    float wisps = 0.1 + 0.9 * sstep(-0.6, 1.0, 0.3 * n1 + ndt);
    alphaA += ${f(VEIL_ALPHA)} * (1.0 - cu) * sstep(0.3, 0.9, thickness) * sstep(0.0, ${f(VEIL_SOFT)}, xv) * wisps * (1.0 - alphaA);
  }
  // Cirrus veils, not over optically thick low cloud (a thin white veil on a white deck is
  // invisible): patches (the shape fetches' independent B channel) striated into fibres by the
  // detail volume strongly stretched along the zonal flow.
  float alphaC = 0.0;
  if (ex < 1.6) {
    float fcC = clamp(cirrus, 0.002, 0.998);
    float cpatch = (w0 * (b0.b - 0.5) + w1 * (b1.b - 0.5)) * (INV_STD * norm);
    float exP = 0.93 * cpatch - log((1.0 - fcC) / fcC) * ${f(1 / 1.702)};
    float aCir = 0.0;
    // Fibres reach at most ~0.6σ beyond the patches: fetch only there.
    if (cirrus > 0.02 && exP > -0.6) {
      vec3 a0 = ROT * ((qw0 - dispA) * CIRRUS3), a1 = ROT * ((qw1 - dispA) * CIRRUS3);
      vec3 cw0 = wb0 * (INV_STD * CIRRUS_WARP), cw1 = wb1 * (INV_STD * CIRRUS_WARP);
      // Streak octaves (mirror cirrusFibre() / cirrusFades()): coarse bundles, and fine fibres where
      // resolved; footprints of the across-streak direction.
      float cellsAcross = CIRRUS_SCALE * ${f(CLOUD_DETAIL_PERIOD * CIRRUS_ANISO)};
      float fadeC = smoothstep(1.0, 2.0, 1.0 / (px * cellsAcross * CIRRUS_COARSE));
      float fadeF = smoothstep(1.0, 2.0, 1.0 / (px * cellsAcross));
      float lodC = max(0.0, log2(px * cellsAcross * CIRRUS_COARSE) + LOG2_TEXELS_PER_CELL - LOD_SHARPEN);
      float sc0 = CIRRUS_SCALE * CIRRUS_COARSE;
      float nc = (w0 * (textureLod(uDetail, a0 * sc0 + cw0 + OFF_C2, lodC).r - 0.5) + w1 * (textureLod(uDetail, a1 * sc0 + cw1 + OFF_C2, lodC).r - 0.5)) * (INV_STD * normD);
      float wf = ${f(Math.sqrt(1 - CIRRUS_COARSE_W ** 2))} * fadeF;
      nc *= CIRRUS_COARSE_W;
      if (wf > 0.02) {
        float lodF = max(0.0, log2(px * cellsAcross) + LOG2_TEXELS_PER_CELL - LOD_SHARPEN);
        nc += wf * (w0 * (textureLod(uDetail, a0 * CIRRUS_SCALE + cw0 + OFF_C, lodF).r - 0.5) + w1 * (textureLod(uDetail, a1 * CIRRUS_SCALE + cw1 + OFF_C, lodF).r - 0.5)) * (INV_STD * normD);
      }
      nc *= inversesqrt(${f(CIRRUS_COARSE_W ** 2)} + wf * wf);
      // Mirror cirrusAlphaThr(): a veil striated by soft, elongated strands.
      float strand = sstep(-0.8, 1.6, nc);
      aCir = CIRRUS_TAU * sstep(0.0, 0.9, exP + 0.3 * nc * fadeC) * (CIRRUS_BASE + ${f(1 - CIRRUS_BASE)} * (CIRRUS_STRAND_MEAN + fadeC * (strand - CIRRUS_STRAND_MEAN)));
    }
    alphaC = aCir * (1.0 - sstep(1.1, 1.6, ex));
  }

  // Light direction for self-shadowing / ground shadows (relief: 35° above the horizon toward the
  // camera's up-left, as the surface hillshade).
  vec3 L3, Lb;
  if (uLightMode == 2) {
    L3 = Lb = uSunDir;
  } else {
    vec3 tl = uCamUpLeft - dot(uCamUpLeft, n3) * n3;
    float tlen = length(tl);
    tl = tlen > 1e-4 ? tl / tlen : vec3(0.0, 1.0, 0.0);
    L3 = n3 * SIN_ALT + tl * COS_ALT;
    // Cloud tops are lit from higher up (60°): relief light reads as a mid-morning sun, not a
    // grazing one (which would emboss every billow on the planet).
    Lb = n3 * 0.866 + tl * 0.5;
  }

  // Ground shadow: density along the light ray from the ground point behind this fragment.
  float shadow = 0.0;
  if (uShadow > 0.0 && uLightMode != 0) {
    vec3 C = cameraPosition;
    vec3 dir = normalize(vWorld - C);
    float bq = dot(C, dir);
    float disc = bq * bq - (dot(C, C) - 1.0);
    if (disc > 0.0) {
      vec3 G = C + dir * (-bq - sqrt(disc));
      float gl3 = dot(G, L3);
      if (gl3 > 0.0) {
        float Rh = 1.0 + uShadowHeight;
        float ts = -gl3 + sqrt(gl3 * gl3 - (dot(G, G) - Rh * Rh));
        // The synoptic cloud field at the shadow-casting point, to first order from its screen-space
        // gradient (the shift is a few pixels to ~1/4 of a synoptic wavelength near the terminator,
        // where shadows fade out anyway): no extra noise fetches.
        vec3 dS = normalize(G + L3 * ts) - n3;
        float zs = nb - zthr + clamp(dot(fieldGrad, dS), -1.5, 1.5);
        // Only optically thick cloud casts a visible shadow (thin veils hardly dim the ground).
        shadow = sstep(0.3, 1.5, zs / exRef) * min(1.0, thickness) * uShadow * sstep(0.0, 0.15, gl3) * (uLightMode == 2 ? 1.0 : 0.6);
      }
    }
  }

  vec3 V3 = normalize(cameraPosition - vWorld);
  float nv = max(dot(n3, V3), 0.0);
  float slantK = 1.0 / max(nv, 0.3);
  float aLat = abs(asin(clamp(p.z, -1.0, 1.0)));

  float alpha = 0.0;
  vec3 col = vec3(0.0);
  float tau = 0.0;
  if (ex > 0.0) {
    // Mirror opticalDepth(): zero at the threshold, ∝ ex^TAU_POW (soft, translucent edges and thin
    // veils; bright, opaque cloud only well inside: fronts, storm centres, convective cores), × the
    // climate's thickness (aux grid) and the regime.
    float regime = (1.0 - 0.45 * sstep(1.05, 1.4, aLat)) * (1.0 - 0.25 * sc - 0.6 * cu + TAU_CONVECTIVE * cv) * (1.0 + TAU_FRONT * organized);
    // Optical-depth variability (≈ log-normal, as observed) from the finer detail octaves (mirror
    // opticalDepth(), cellularTexture()): mottled cumulus, gentle in stratiform and frontal cloud.
    // Cellular regimes take the shaped detail (bright closed cells / open-cell rings).
    float ndx = mix(ndt, nd, clamp(0.8 * sc + 0.6 * open, 0.0, 1.0));
    float tex = exp(TAU_TEXTURE * (0.35 + 0.6 * cu + 0.4 * sc + 0.2 * cv) * (1.0 - 0.3 * organized) * ndx);
    // Excess for the optical depth (mirror tauExcess()): only tauDetail(cv) of the detail noise.
    float exT = max(ex - (${f(1 - TAU_DETAIL)} - ${f(TAU_DETAIL_CV)} * cv) * amp * ia * nd, ${f(TAU_EDGE)} * ex);
    tau = TAU_SCALE * pow(exT / (exRef + BIAS_REF * max(bias, 0.0)), TAU_POW) * thickness * regime * tex * cellTau;
    // Longer slant path through the layer toward the limb.
    // Opacity (mirror cloudOpacity()): saturates slowly, thick cores keep their texture.
    float q = 1.0 + 0.5 * tau * slantK;
    alpha = ALPHA_MAX * (1.0 - 1.0 / (q * q));
  }
  // Anvils under the cores' tops, cirrus over everything (thin: brightens and veils).
  float aA = alphaA * (1.0 - alpha);
  float aLow = alpha + aA;
  float aC = alphaC * (1.0 - exp(-2.0 * slantK)) * 1.15;
  float aTot = aC + aLow * (1.0 - aC);

  if (aTot > 0.002) {
    // Cloud-top relief: bump the normal by the synoptic height gradient plus the fine detail's
    // analytic slope (deep for convective towers and cumulus, flat for decks and fronts), lit like the
    // surface (strong near the terminator, gentle under a high sun).
    float relief = 1.0;
    if (uLightMode != 0) {
      float depth = sstep(0.0, 1.5, tau) * (0.35 + 0.7 * cv + 0.4 * cu) * (1.0 - 0.4 * sc);
      vec3 gT = toThree(gl - dot(gl, p) * p) * depth;
      vec3 nb3 = normalize(n3 - RELIEF_HEIGHT * bumpGrad - gT);
      float l0 = max(dot(n3, Lb), 0.0);
      relief = clamp((max(dot(nb3, Lb), 0.0) + 0.25) / (l0 + 0.25), 0.7, 1.25);
    }
    // Reflectance rises with optical depth: thin cloud a pale translucent veil, thick cores white; it
    // saturates slowly (as real reflectance does), so the optical-depth texture still mottles thick
    // decks instead of leaving them a uniform, featureless white.
    float bright = mix(THIN_BRIGHT, 1.0, 1.0 - exp(-BRIGHT_K * tau * slantK));
    // A core's thin edge inside an anvil is no darker than the anvil around it (no grey outlines).
    float anvBright = mix(0.84, 0.97, min(1.0, alphaA / ANVIL_TAU)) * (1.0 + 0.05 * clamp(ndt, -2.0, 2.0));
    bright = max(bright, anvBright * sstep(0.0, 0.3, alphaA));
    vec3 low = vec3(0.93, 0.95, 0.98) * bright * relief;
    vec3 cir = vec3(0.92, 0.94, 0.98);
    vec3 anv = vec3(0.93, 0.95, 0.98) * anvBright;
    col = (cir * aC + (low * alpha + anv * aA) * (1.0 - aC)) / aTot;

    if (uLightMode == 1) {
      col *= 0.86 + 0.14 * nv;
      col = mix(col, uAtmoColor, 0.25 * pow(1.0 - nv, 3.0));
    } else if (uLightMode == 2) {
      float mu = dot(n3, uSunDir);
      float day = sstep(-0.12, 0.12, mu);
      // Clouds stand above the ground: lit a little past the ground terminator, warm at twilight.
      float lit = max(mu + 0.06, 0.0) / 1.06;
      vec3 tint = mix(vec3(1.0, 0.84, 0.72), vec3(1.0), sstep(-0.03, 0.1, mu));
      col = col * tint * (0.03 * day + 1.02 * pow(lit, 0.85) * sstep(-0.08, 0.06, mu)) + vec3(0.002, 0.003, 0.006);
      col = mix(col, uAtmoColor * 1.1, 0.4 * pow(1.0 - nv, 3.0) * sstep(-0.2, 0.3, mu));
    }
  }
  aTot *= uOpacity;
  shadow *= uOpacity;
  if (aTot < 0.002 && shadow < 0.002) discard;
  vec4 outCol = linearToOutputTexel(vec4(col, 1.0));
  gl_FragColor = vec4(outCol.rgb * aTot, aTot + shadow * (1.0 - aTot));
}
`;


/**
 * Cloud shell vertex shader: the shell transform (as SHELL_VERTEX) plus the extratropical cyclones,
 * evaluated per vertex (their comma templates and swirl are smooth at ≥ 0.05 rad and the shell's
 * vertices are ~0.02 rad apart; per fragment they cost as much as all the noise at high DPI).
 */
export const CLOUDS_VERTEX = /* glsl */ `
${GLSL_CONSTANTS}
uniform float uShellRadius;
uniform vec4 uCyc[${2 * CYCLONE_COUNT}];
// cos(2.7 R) per cyclone: its reach (per frame on the CPU).
uniform float uCycCut[${CYCLONE_COUNT}];
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;
varying vec3 vCyc;
varying vec3 vDisp;

const float NOISE_SWIRL = ${f(NOISE_SWIRL)};
const float CYCLONE_BIAS_GAIN = ${f(CYCLONE_BIAS_GAIN)};

float sstep(float a, float b, float x) { return smoothstep(a, b, x); }

// Cyclone template (x downstream, y poleward, units of the radius). Mirrors cycloneTemplate():
// x = coverage bias; y = cirrus (head and warm conveyor shield); z = open cells (cold sector).
vec3 cycloneTemplate(vec2 t) {
  float s = max(0.0, 0.1 - t.y);
  float xc = 0.3 - 0.32 * s - 0.1 * s * s;
  float bx = (t.x - xc) / (0.26 + 0.07 * s);
  // Sharp trailing (cold-side) edge, gentler warm side.
  bx *= bx < 0.0 ? 1.6 : 0.8;
  float tail = exp(-bx * bx) * sstep(-0.2, 0.2, 0.25 - t.y) * (1.0 - sstep(1.5, 2.5, s));
  vec2 hd = (t - vec2(0.15, 0.42)) / vec2(0.95, 0.55);
  vec2 wm = (t - vec2(0.85, 0.05)) / vec2(0.55, 0.75);
  vec2 uv = vec2(t.x + t.y, t.x - t.y) * 0.7071;
  vec2 dr = (uv - vec2(-0.55, 0.05)) / vec2(0.55, 0.28);
  vec2 co = (t + vec2(1.4, 0.8)) / 1.1;
  float head = exp(-dot(hd, hd)), warm = exp(-dot(wm, wm)), dry = exp(-dot(dr, dr)), cold = exp(-dot(co, co));
  vec2 oc = (t + vec2(1.25, 0.95)) / 0.95;
  return vec3(1.9 * tail + 1.6 * head + 0.9 * warm - 1.8 * dry - 0.8 * cold - 0.16, 0.6 * head + 0.8 * warm, exp(-dot(oc, oc)));
}

// Sum of cyclone effects at p (see cycloneTemplate); swirl displacement of the noise domain in disp.
vec3 cyclones(vec3 p, out vec3 disp) {
  vec3 acc = vec3(0.0);
  disp = vec3(0.0);
  for (int k = 0; k < ${CYCLONE_COUNT}; k++) {
    vec4 a = uCyc[2 * k];
    vec4 b = uCyc[2 * k + 1];
    if (b.x <= 0.001) continue;
    float cd = dot(p, a.xyz);
    float R = a.w;
    if (cd < uCycCut[k]) continue;
    vec3 c = a.xyz;
    float ch = max(length(c.xy), 1e-4);
    vec3 e = vec3(-c.y, c.x, 0.0) / ch;
    vec3 n = vec3(-c.z * c.x / ch, -c.z * c.y / ch, ch);
    vec3 d = p - c * cd;
    vec2 t = vec2(b.z * dot(d, e), b.w * dot(d, n)) / R;
    float r2 = dot(t, t);
    float th = b.y * exp(-1.6 * r2) * b.x;
    float cs = cos(th), sn = sin(th);
    vec2 ts = vec2(cs * t.x + sn * t.y, -sn * t.x + cs * t.y);
    float env = 1.0 - sstep(1.9, 2.6, sqrt(r2));
    acc += b.x * env * cycloneTemplate(ts) * vec3(CYCLONE_BIAS_GAIN, 1.0, 1.0);
    vec2 dd = vec2(b.z, b.w) * (ts - t) * (R * NOISE_SWIRL);
    disp += dd.x * e + dd.y * n;
  }
  return acc;
}

void main() {
  vUv = uv;
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(vDir * uShellRadius, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  // SPEC axes (z north), as the fragment shader's toSpec().
  vCyc = cyclones(vec3(vDir.x, -vDir.z, vDir.y), vDisp);
}
`;
