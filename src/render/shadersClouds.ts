/**
 * Cloud shell shader (see cloudsField.ts for the model, whose constants are interpolated here).
 *
 * Per fragment (all geometry in SPEC axes, z north; the Three direction is converted once):
 *  - extratropical cyclones (uniform array, updated per frame) bias the local coverage with a comma
 *    template evaluated in a swirled frame, and swirl the noise domain;
 *  - the noise is domain-warped fbm from a tileable 3D texture: one shared large-scale warp, a
 *    synoptic shape fetch and mesoscale detail fetches (a finer one when zoomed in), stretched
 *    east–west and sheared along the wind into streaks. It is advected with the wind by two-phase
 *    flow mapping: each phase is displaced upstream by wind·time within a cycle and re-seeded (on a
 *    slow drift path, so structures persist) while its weight is zero; the phases are crossfaded
 *    with variance restoration so the statistics stay stationary. Detail is skipped where the shape
 *    noise leaves no chance of cloud;
 *  - regimes from the RGBA regime grid (coverage, stratocumulus, deep convection, shallow cumulus)
 *    reshape the noise; the coverage fraction sets the threshold z_thr = Φ⁻¹(1 − f), the excess above
 *    it a continuous optical depth → opacity (crisp antialiased edges, thin veils, bright cores,
 *    billowy cloud-top texture);
 *  - lighting follows the surface's mode: sun (terminator, twilight tint, night), relief (camera
 *    light) or flat; cloud-top relief from the synoptic noise gradient, a blue limb tint and
 *    thicker-looking cloud at grazing angles;
 *  - cloud shadows on the ground: the output is premultiplied (blend ONE, ONE_MINUS_SRC_ALPHA) and
 *    its alpha also darkens the ground seen through the gaps by the cloud density found along the
 *    light ray from the ground point behind the fragment.
 */
import { CLOUD_NOISE_SIZE, CLOUD_NOISE_STD } from './cloudsNoise';
import {
  ALPHA_MAX, ANISO, DETAIL_AMP, DETAIL_CORR_LENGTH, EDGE_TAU, FETCH_GAIN, DETAIL_RATIO, DETAIL_WARP, FIELD_GLSL_CONSTANTS as K, NOISE_SWIRL,
  SHAPE_CORR_LENGTH, SHAPE_SCALE, TAU_PER_SIGMA, WARP_AMP, WARP_SCALE,
} from './cloudsField';
import { CYCLONE_COUNT } from './cloudsModel';
import { GLSL_CONSTANTS } from './shadersCommon';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const v3 = (a: number[]): string => `vec3(${a.map(f).join(', ')})`;

export const CLOUDS_FRAGMENT = /* glsl */ `
${GLSL_CONSTANTS}
uniform sampler2D uGrid;
uniform sampler2D uWind;
uniform sampler3D uNoise;
uniform float uHasWind;
uniform float uTime;
uniform float uCycle;
uniform float uFlow;
uniform float uOpacity;
uniform float uShadow;
uniform float uShadowHeight;
uniform vec4 uCyc[${2 * CYCLONE_COUNT}];
uniform int uLightMode;
uniform vec3 uSunDir;
uniform vec3 uAtmoColor;
uniform vec3 uCamUpLeft;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;

const float INV_STD = ${f(1 / CLOUD_NOISE_STD)};
const float WARP_SCALE = ${f(WARP_SCALE)};
const float WARP_AMP = ${f(WARP_AMP)};
const float SHAPE_SCALE = ${f(SHAPE_SCALE)};
const float D1_SCALE = ${f(SHAPE_SCALE * DETAIL_RATIO)};
const float D2_SCALE = ${f(SHAPE_SCALE * DETAIL_RATIO ** 2)};
const float FINE_SCALE = ${f(SHAPE_SCALE * DETAIL_RATIO ** 3)};
const float FETCH_GAIN = ${f(FETCH_GAIN)};
const float DETAIL_AMP = ${f(DETAIL_AMP)};
const float DETAIL_WARP = ${f(DETAIL_WARP)};
const float TAU_PER_SIGMA = ${f(TAU_PER_SIGMA)};
const float ALPHA_MAX = ${f(ALPHA_MAX)};
const float EDGE_TAU = ${f(EDGE_TAU)};
const float NOISE_SWIRL = ${f(NOISE_SWIRL)};
const float INV_SHAPE_CORR2 = ${f(1 / SHAPE_CORR_LENGTH ** 2)};
const float INV_DETAIL_CORR = ${f(1 / DETAIL_CORR_LENGTH)};
const vec3 ANISO3 = vec3(1.0, 1.0, ${f(ANISO)});
// Flow-aligned shear of the detail noise per (m/s) of wind and σ of the shear field.
const float STREAK = 0.004;
// Cloud-top relief height per σ of excess (world units) for bump lighting.
const float RELIEF_HEIGHT = 0.004;
const vec3 OFF_W = ${v3(K.OFF_W)};
const vec3 OFF_B = ${v3(K.OFF_B)};
const vec3 OFF_D = ${v3(K.OFF_D)};
const vec3 OFF_E = ${v3(K.OFF_E)};
const vec3 OFF_F = ${v3(K.OFF_F)};
const mat3 ROT = mat3(${K.ROT.map(f).join(', ')});
// Relief light elevation above the local horizon (35°), as the surface shader.
const float SIN_ALT = 0.573576;
const float COS_ALT = 0.819152;

float sstep(float a, float b, float x) { return smoothstep(a, b, x); }

// Cyclone template (x downstream, y poleward, units of the radius). Mirrors cycloneTemplate().
float cycloneTemplate(vec2 t) {
  float s = max(0.0, 0.1 - t.y);
  float xc = 0.3 - 0.32 * s - 0.1 * s * s;
  float bx = (t.x - xc) / (0.26 + 0.07 * s);
  float tail = exp(-bx * bx) * sstep(-0.2, 0.2, 0.25 - t.y) * (1.0 - sstep(1.5, 2.5, s));
  vec2 hd = (t - vec2(0.15, 0.42)) / vec2(0.95, 0.55);
  vec2 wm = (t - vec2(0.85, 0.05)) / vec2(0.55, 0.75);
  vec2 uv = vec2(t.x + t.y, t.x - t.y) * 0.7071;
  vec2 dr = (uv - vec2(-0.55, 0.05)) / vec2(0.55, 0.28);
  vec2 co = (t + vec2(1.4, 0.8)) / 1.1;
  return 1.9 * tail + 1.6 * exp(-dot(hd, hd)) + 0.9 * exp(-dot(wm, wm)) - 1.8 * exp(-dot(dr, dr)) - 0.8 * exp(-dot(co, co)) - 0.16;
}

// Sum of cyclone biases (σ units) at p; swirl displacement of the noise domain in disp.
float cyclones(vec3 p, out vec3 disp) {
  float bias = 0.0;
  disp = vec3(0.0);
  for (int k = 0; k < ${CYCLONE_COUNT}; k++) {
    vec4 a = uCyc[2 * k];
    vec4 b = uCyc[2 * k + 1];
    if (b.x <= 0.001) continue;
    float cd = dot(p, a.xyz);
    float R = a.w;
    if (cd < cos(2.7 * R)) continue;
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
    bias += b.x * env * cycloneTemplate(ts);
    vec2 dd = vec2(b.z, b.w) * (ts - t) * (R * NOISE_SWIRL);
    disp += dd.x * e + dd.y * n;
  }
  return bias;
}

// Mesoscale detail of one flow-map phase (mirrors cloudNoise()): nd ≈ N(0,1) from two (zoomed in:
// three) fetches, each rotated, 3.9× finer and warped by the previous one; bill = billowy cloud-top
// texture (rounded bright cells where |n| is large, thin dark creases along its zero crossings),
// LOD-faded per scale. b is the phase's shape fetch.
// streak: the local wind (noise-space units per σ): detail coordinates are sheared along the flow by
// a slowly varying amount, stretching mesoscale features into streaks aligned with the wind.
// Explicit LODs: this runs in non-uniform control flow (skipped where no cloud is possible).
void phaseDetail(vec3 qw, vec4 b, vec3 streak, float fine, float fade2, vec3 lod, out float nd, out float bill) {
  vec3 a1 = ROT * (qw + streak * ((b.g - 0.5) * INV_STD));
  vec4 d1 = textureLod(uNoise, a1 * D1_SCALE + (b.gba - 0.5) * (INV_STD * DETAIL_WARP) + OFF_D, lod.x);
  vec3 a2 = ROT * a1;
  vec3 g2 = (d1.gba - 0.5) * (INV_STD * DETAIL_WARP);
  vec4 d2 = textureLod(uNoise, a2 * D2_SCALE + g2 + OFF_E, lod.y);
  float n2 = (d2.r - 0.5) * INV_STD;
  float n1 = (d1.r - 0.5) * INV_STD;
  nd = (n1 + FETCH_GAIN * n2) * ${f(1 / Math.sqrt(1 + FETCH_GAIN ** 2))};
  bill = 0.6 * (abs(n1) - 0.8) + 0.45 * fade2 * (abs(n2) - 0.8);
  if (fine > 0.0) {
    // One tile of this fetch spans only ~20–60 px when zoomed in: a weak warp left the 64³ tile
    // repeating as a regular lattice of identical cloudlets. Warping by both coarser fetches' GBA
    // channels (≈ 0.3 + 0.12 tile per σ, varying within a few tiles) decorrelates neighbouring tiles.
    vec3 g3 = 6.0 * g2 + (d2.gba - 0.5) * (INV_STD * 0.12);
    float n3 = (textureLod(uNoise, ROT * a2 * FINE_SCALE + g3 + OFF_F, lod.z).r - 0.5) * INV_STD;
    float c = FETCH_GAIN * FETCH_GAIN * fine;
    nd = (nd * ${f(Math.sqrt(1 + FETCH_GAIN ** 2))} + c * n3) * inversesqrt(1.0 + ${f(FETCH_GAIN ** 2)} + c * c);
    bill += 0.35 * fine * (abs(n3) - 0.8);
  }
}

// Shape noise only, explicit LOD (used inside branches).
float shapeAt(vec3 qw, float lod) {
  return (textureLod(uNoise, qw * SHAPE_SCALE + OFF_B, lod).r - 0.5) * INV_STD;
}

vec3 toSpec(vec3 t) { return vec3(t.x, -t.z, t.y); }

// Noise-space offset for flow-map cycle k: a slow Lissajous path (≤ ~0.04 per cycle and axis, about
// a quarter of the synoptic wavelength), bounded so texture coordinates stay small forever.
vec3 noiseDrift(float k) {
  return 0.2 * vec3(
    sin(k * 0.071) + sin(k * 0.113 + 1.3),
    sin(k * 0.083 + 2.1) + sin(k * 0.127 + 0.4),
    sin(k * 0.067 + 4.2) + sin(k * 0.109 + 5.1));
}

void main() {
  vec3 n3 = normalize(vDir);            // Three axes
  vec3 p = toSpec(n3);                  // SPEC axes (z north)
  // Grid lookups from the exact direction (the interpolated uv is off by up to a texel between
  // sphere segments, which printed faint seams). No mipmaps on the grids: the lon wrap is harmless.
  vec2 st = vec2(atan(p.y, p.x) * ${f(1 / (2 * Math.PI))} + 0.5, 0.5 - asin(clamp(p.z, -1.0, 1.0)) * ${f(1 / Math.PI)});
  vec4 grid = texture(uGrid, st);
  float cov = grid.r;
  if (cov < 0.004) discard;
  float sc = grid.g, cv = grid.b, cu = grid.a;

  float cl = max(length(p.xy), 1e-5);
  vec3 east = vec3(-p.y, p.x, 0.0) / cl;
  vec3 north = cross(p, east);

  vec3 disp;
  float bias = cyclones(p, disp);

  vec3 flow = vec3(0.0);
  if (uHasWind > 0.5) {
    vec2 w = texture(uWind, st).rg;
    flow = w.x * east + w.y * north;
  }
  // Pixel footprint (radians): fine detail only when zoomed in.
  float px = length(fwidth(p));
  float fine = 1.0 - sstep(0.0007, 0.0014, px);
  float fade2 = 1.0 - sstep(0.0012, 0.0028, px);
  float lodShape = log2(max(px * SHAPE_SCALE * ${f(CLOUD_NOISE_SIZE)}, 1e-6));
  vec3 lodDetail = lodShape + log2(vec3(${f(DETAIL_RATIO)}, ${f(DETAIL_RATIO ** 2)}, ${f(DETAIL_RATIO ** 3)}));

  float t = uTime / uCycle;
  float ph0 = fract(t), ph1 = fract(t + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0), w1 = 1.0 - w0;
  float span = uFlow * uCycle;
  // Both phases sample the same noise; each re-seeds (while invisible) at its point on a slow,
  // bounded quasi-periodic path through noise space, so structures persist across cycles and the
  // weather evolves gradually instead of cross-dissolving into an unrelated pattern.
  vec3 q0 = (normalize(p - flow * (span * (ph0 - 0.5))) + disp) * ANISO3 + noiseDrift(floor(t));
  vec3 q1 = (normalize(p - flow * (span * (ph1 - 0.5))) + disp) * ANISO3 + noiseDrift(floor(t + 0.5) - 0.5);
  // One large-scale warp for both phases, drifting continuously along the same path (~4000 km
  // features: not advecting them is invisible, and it saves a fetch per phase).
  vec3 wv = texture(uNoise, ((p + disp) * ANISO3 + noiseDrift(t - 0.5)) * WARP_SCALE + OFF_W).gba - 0.5;
  vec3 qw0 = q0 + WARP_AMP * INV_STD * wv;
  vec3 qw1 = q1 + WARP_AMP * INV_STD * wv;
  vec4 b0 = texture(uNoise, qw0 * SHAPE_SCALE + OFF_B);
  vec4 b1 = texture(uNoise, qw1 * SHAPE_SCALE + OFF_B);
  // Variance-restoring crossfade. The phases are correlated (same noise a small offset apart: ρ ≈ 1
  // in calm air), so normalize with that correlation (fits of the noise autocorrelation, see
  // SHAPE_CORR_LENGTH), not as if independent, which pulsed contrast and coverage globally by up to
  // ~40 % twice per cycle.
  vec3 dq = q0 - q1;
  float dq2 = dot(dq, dq);
  float wsq = w0 * w0 + w1 * w1, wx = 2.0 * w0 * w1;
  float norm = inversesqrt(wsq + wx * exp(-dq2 * INV_SHAPE_CORR2));
  float normD = inversesqrt(wsq + wx * exp(-sqrt(dq2) * INV_DETAIL_CORR));
  float nb = (w0 * (b0.r - 0.5) + w1 * (b1.r - 0.5)) * (INV_STD * norm);

  // Threshold (mirror coverageThreshold).
  float fc = clamp(cov, 0.002, 0.998);
  float zthr = log((1.0 - fc) / fc) * ${f(1 / 1.702)} - bias;

  // Mesoscale detail only where cloud is possible at all (|detail mix| < ~2.6σ).
  float nd = 0.0, bill = 0.0;
  if (nb > zthr - 2.6) {
    vec3 streak = flow * ANISO3 * STREAK;
    float nd0, nd1, bl0, bl1;
    phaseDetail(qw0, b0, streak, fine, fade2, lodDetail, nd0, bl0);
    phaseDetail(qw1, b1, streak, fine, fade2, lodDetail, nd1, bl1);
    nd = (w0 * nd0 + w1 * nd1) * normD;
    bill = w0 * bl0 + w1 * bl1;
  }

  // Regime mix (mirror combineNoise).
  float exb = nb - zthr;
  float amp = DETAIL_AMP * (0.25 + 1.4 * exp(-2.0 * exb * exb)) * (1.0 + 0.8 * cv) * (1.0 - 0.4 * sc);
  float ex = (nb + amp * nd) * inversesqrt(1.0 + amp * amp) - 0.5 * cu + 0.15 * sc + 0.2 * cv - zthr;

  // Light direction for self-shadowing / ground shadows (relief: 35° above the horizon toward the
  // camera's up-left, as the surface hillshade).
  vec3 L3;
  if (uLightMode == 2) {
    L3 = uSunDir;
  } else {
    vec3 tl = uCamUpLeft - dot(uCamUpLeft, n3) * n3;
    float tlen = length(tl);
    L3 = n3 * SIN_ALT + (tlen > 1e-4 ? tl / tlen : vec3(0.0, 1.0, 0.0)) * COS_ALT;
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
      float gl = dot(G, L3);
      if (gl > 0.0) {
        float Rh = 1.0 + uShadowHeight;
        float ts = -gl + sqrt(gl * gl - (dot(G, G) - Rh * Rh));
        vec3 dS = (toSpec(normalize(G + L3 * ts)) - p) * ANISO3;
        float zs = (w0 * shapeAt(qw0 + dS, lodShape + 1.0) + w1 * shapeAt(qw1 + dS, lodShape + 1.0)) * norm;
        shadow = sstep(zthr - 0.2, zthr + 1.4, zs) * uShadow * sstep(0.0, 0.15, gl) * (uLightMode == 2 ? 1.0 : 0.6);
      }
    }
  }

  // Cloud-top height (σ units) and its surface gradient (per world unit) from screen-space
  // derivatives, computed in uniform control flow. Only the smooth synoptic noise: derivatives come
  // per 2×2 pixel quad, so fast-varying detail would shade in blocks (it textures τ instead).
  float hgt = nb + bias;
  vec3 dpx = dFdx(vWorld), dpy = dFdy(vWorld);
  vec3 r1 = cross(dpy, n3), r2 = cross(n3, dpx);
  float det = dot(dpx, r1);
  vec3 bumpGrad = abs(det) > 1e-14 ? (dFdx(hgt) * r1 + dFdy(hgt) * r2) / det : vec3(0.0);

  // Edge step width: about a pixel (crisp, antialiased outlines at any zoom).
  float edgeW = max(1.5 * fwidth(ex), 0.02);

  float alpha = 0.0;
  vec3 col = vec3(0.0);
  if (ex > 0.0) {
    float aLat = abs(asin(clamp(p.z, -1.0, 1.0)));
    // Mirror opticalDepth().
    float thick = (1.0 - 0.45 * sstep(1.05, 1.4, aLat)) * (1.0 - 0.4 * sc - 0.65 * cu + 0.35 * cv);
    float k = 0.6 + 0.3 * cv;
    float tex = clamp(1.0 + 0.12 * nd + bill * (0.25 + 0.2 * cv + 0.15 * cu + 0.3 * sc), 0.5, 1.6);
    float tau = (TAU_PER_SIGMA * ex * ((1.0 - k) + k * ex) * tex + EDGE_TAU * sstep(0.0, edgeW, ex)) * thick;

    vec3 V3 = normalize(cameraPosition - vWorld);
    float nv = max(dot(n3, V3), 0.0);
    // Longer slant path through the layer toward the limb.
    float slant = tau / max(nv, 0.3);
    alpha = ALPHA_MAX * (1.0 - exp(-slant));

    // Cloud-top relief: bump the normal by the synoptic height gradient, lit like the surface
    // (strong near the terminator, gentle under a high sun).
    float relief = 1.0;
    if (uLightMode != 0) {
      vec3 nb3 = normalize(n3 - RELIEF_HEIGHT * bumpGrad);
      float l0 = max(dot(n3, L3), 0.0);
      relief = clamp((max(dot(nb3, L3), 0.0) + 0.15) / (l0 + 0.15), 0.5, 1.4);
    }
    // Thin cloud reflects less than thick cloud.
    float bright = (0.7 + 0.3 * (1.0 - exp(-0.65 * tau))) * clamp(1.0 + (0.07 + 0.08 * sc) * bill + 0.03 * nd, 0.82, 1.14);
    col = vec3(0.94, 0.955, 0.98) * bright * relief;

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
  alpha *= uOpacity;
  shadow *= uOpacity;
  if (alpha < 0.002 && shadow < 0.002) discard;
  vec4 outCol = linearToOutputTexel(vec4(col, 1.0));
  gl_FragColor = vec4(outCol.rgb * alpha, alpha + shadow * (1.0 - alpha));
}
`;
