/**
 * Cloud shell shader. Opacity = cloud-cover field × thresholded 3D fbm noise: the noise is converted
 * to an approximately uniform variable and thresholded at (1 − cover), so the covered area fraction
 * tracks the cover value. The noise drifts with the wind using two-phase flow mapping: each layer
 * is displaced upstream by wind·time within a cycle and reset (with a fresh noise offset) while its
 * weight is zero; the two layers are half a cycle apart and crossfaded with variance restoration.
 */
import { GLSL_BASIS, GLSL_CONSTANTS } from './shadersCommon';

export const CLOUDS_FRAGMENT = /* glsl */ `
${GLSL_CONSTANTS}
${GLSL_BASIS}
uniform sampler2D uCover;
uniform sampler2D uWind;
uniform float uHasWind;
uniform float uTime;
uniform float uCycle;
uniform float uFlow;
uniform float uOpacity;
uniform int uLightMode;
uniform vec3 uSunDir;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;

const float NOISE_FREQ = 5.0;
// Approximate std-dev of fbm() around its 0.5 mean (value noise, 7 octaves).
const float FBM_SIGMA = 0.105;

float hash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash13(i);
  float b = hash13(i + vec3(1.0, 0.0, 0.0));
  float c = hash13(i + vec3(0.0, 1.0, 0.0));
  float d = hash13(i + vec3(1.0, 1.0, 0.0));
  float e = hash13(i + vec3(0.0, 0.0, 1.0));
  float g = hash13(i + vec3(1.0, 0.0, 1.0));
  float h = hash13(i + vec3(0.0, 1.0, 1.0));
  float k = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}

// Octaves are rotated to hide the value-noise lattice.
const mat3 OCTAVE_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

float fbm(vec3 p) {
  float s = 0.0;
  float a = 0.5;
  for (int o = 0; o < 7; o++) {
    s += a * valueNoise(p);
    p = OCTAVE_ROT * p * 2.02;
    a *= 0.5;
  }
  return s / 0.9921875;
}

float layer(vec3 p, vec3 flow, float phase, float cycleIndex) {
  vec3 q = normalize(p - flow * (uFlow * uCycle * (phase - 0.5)));
  vec3 jump = vec3(0.131, 0.379, 0.253) * cycleIndex;
  return fbm(q * NOISE_FREQ + vec3(3.1, 1.7, 5.3) + jump * 7.0);
}

void main() {
  vec2 st = vec2(vUv.x, 1.0 - vUv.y);
  float cover = texture(uCover, st).r;
  if (cover < 0.004) discard;
  vec3 p = normalize(vDir);
  float lat = (vUv.y - 0.5) * PI;
  float lon = vUv.x * TWO_PI - PI;
  vec3 east, north;
  geoBasis(lat, lon, east, north);
  vec3 flow = vec3(0.0);
  if (uHasWind > 0.5) {
    vec2 w = texture(uWind, st).rg;
    flow = w.x * east + w.y * north;
  }
  float t = uTime / uCycle;
  float ph0 = fract(t);
  float ph1 = fract(t + 0.5);
  float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
  float n0 = layer(p, flow, ph0, floor(t));
  float n1 = layer(p, flow, ph1, floor(t + 0.5) + 17.0);
  // Crossfade two (nearly independent) layers, restoring the variance lost by averaging.
  float z = (w0 * (n0 - 0.5) + (1.0 - w0) * (n1 - 0.5)) / (FBM_SIGMA * sqrt(w0 * w0 + (1.0 - w0) * (1.0 - w0)));
  float uni = 1.0 / (1.0 + exp(-1.702 * z)); // ~ normal CDF: roughly uniform on [0, 1]
  float thr = 1.0 - cover;
  // Crisp-ish edges at the coverage threshold; optical thickness varies with the noise itself so
  // even full overcast keeps texture (thick bright cells, thinner grey lanes).
  float edge = smoothstep(thr - 0.035, thr + 0.05, uni);
  float thick = smoothstep(0.12, 0.95, uni);
  float alpha = edge * (0.42 + 0.58 * thick) * uOpacity;

  vec3 col = vec3(0.74 + 0.26 * thick);
  if (uLightMode == 1) {
    vec3 V = normalize(cameraPosition - vWorld);
    col *= 0.86 + 0.14 * max(dot(p, V), 0.0);
  } else if (uLightMode == 2) {
    float mu = dot(p, uSunDir);
    float day = smoothstep(-0.12, 0.15, mu);
    col *= 0.03 + 1.02 * max(mu, 0.0) * smoothstep(-0.05, 0.1, mu) + 0.06 * day;
    alpha *= 0.2 + 0.8 * day;
  } else {
    alpha *= 0.9;
  }
  gl_FragColor = vec4(col, alpha);
  #include <colorspace_fragment>
}
`;
