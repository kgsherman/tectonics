/**
 * Globe surface shader: base (sRGB), overlay (premultiplied) and height (R16F) textures in one pass.
 *
 * Textures are row-0-north equirect rasters sampled at st = (uv.x, 1 − uv.y) (the "flip v in the
 * shader" option of SPEC §2). Normals are object-space, computed from central differences of the
 * height texture with the 1/cosφ metric (no tangent attributes); the difference step grows with the
 * pixel footprint so distant relief is shaded from the matching mip level instead of aliasing.
 */
import { GLSL_BASIS, GLSL_CONSTANTS, GLSL_SRGB } from './shadersCommon';

export const SURFACE_VERTEX = /* glsl */ `
uniform sampler2D uHeight;
uniform float uHasHeight;
uniform float uSeaLevel;
uniform float uDispScale;
uniform float uHeightLod;
uniform vec2 uPoleHeight;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec3 dir = normalize(position);
  float r = 1.0;
  if (uHasHeight > 0.5 && uDispScale > 0.0) {
    // All pole vertices share one position: use the polar-row mean so the tip stays closed.
    float h = dir.y > 0.99999 ? uPoleHeight.x
      : dir.y < -0.99999 ? uPoleHeight.y
      : textureLod(uHeight, vec2(uv.x, 1.0 - uv.y), uHeightLod).r;
    r += uDispScale * max(h - uSeaLevel, 0.0);
  }
  vDir = dir;
  vec4 wp = modelMatrix * vec4(dir * r, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const SURFACE_FRAGMENT = /* glsl */ `
${GLSL_CONSTANTS}
${GLSL_SRGB}
${GLSL_BASIS}
uniform sampler2D uBase;
uniform float uHasBase;
uniform sampler2D uOverlay;
uniform float uHasOverlay;
uniform sampler2D uHeight;
uniform float uHasHeight;
uniform vec2 uHeightTexel;
uniform float uSeaLevel;
uniform float uShadeScale;
uniform int uLightMode;
uniform vec3 uSunDir;
uniform vec3 uCamUpLeft;
uniform float uBrushOn;
uniform vec3 uBrushCenter;
uniform float uBrushRadius;
uniform vec3 uBrushColor;
uniform float uGratOn;
uniform float uGratStep;
uniform vec3 uAtmoColor;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;

// Relief light elevation above the local horizon (35°).
const float SIN_ALT = 0.573576;
const float COS_ALT = 0.819152;

float seaClampedHeight(vec2 st) {
  return max(texture(uHeight, st).r, uSeaLevel);
}

// Anti-aliased mask of lines at multiples of stepSize; widthPx wide on screen (fw = fwidth(x)).
float lineMask(float x, float stepSize, float fw, float widthPx) {
  float d = abs(x - stepSize * floor(x / stepSize + 0.5));
  return 1.0 - smoothstep(0.5 * widthPx * fw, (0.5 * widthPx + 1.0) * fw, d);
}

void main() {
  vec3 n0 = normalize(vDir);
  vec2 st = vec2(vUv.x, 1.0 - vUv.y);
  float lat = (vUv.y - 0.5) * PI;
  float lon = vUv.x * TWO_PI - PI;
  vec3 east, north;
  geoBasis(lat, lon, east, north);

  vec3 col = uHasBase > 0.5 ? texture(uBase, st).rgb : vec3(0.015, 0.02, 0.03);

  vec3 n = n0;
  float ocean = 0.0;
  if (uHasHeight > 0.5) {
    ocean = step(texture(uHeight, st).r, uSeaLevel);
    if (uLightMode != 0) {
      vec2 d = max(uHeightTexel, fwidth(st));
      float hE = seaClampedHeight(st + vec2(d.x, 0.0));
      float hW = seaClampedHeight(st - vec2(d.x, 0.0));
      float hN = seaClampedHeight(st - vec2(0.0, d.y));
      float hS = seaClampedHeight(st + vec2(0.0, d.y));
      float cosLat = max(cos(lat), 0.5 * uHeightTexel.y * PI);
      // Surface gradient in metres per radian of arc: d/dx = (1/cosφ) d/dλ, d/dy = d/dφ.
      float gE = (hE - hW) / (2.0 * d.x * TWO_PI * cosLat);
      float gN = (hN - hS) / (2.0 * d.y * PI);
      n = normalize(n0 - uShadeScale * (gE * east + gN * north));
    }
  }

  vec3 V = normalize(cameraPosition - vWorld);
  float nv = max(dot(n0, V), 0.0);
  float overlayLight = 1.0;
  if (uLightMode == 1) {
    // Hillshade with the light 35° above the local horizon toward screen up-left, evaluated per
    // fragment so the whole visible hemisphere is evenly lit; 1.0 on flat ground.
    vec3 t = uCamUpLeft - dot(uCamUpLeft, n0) * n0;
    float tl = length(t);
    vec3 T = tl > 1e-4 ? t / tl : north;
    vec3 L = n0 * SIN_ALT + T * COS_ALT;
    // Shadowed slopes darken fully; lit slopes brighten less (bright surfaces would clip).
    float rel = dot(n, L) / SIN_ALT;
    float shade = rel < 1.0 ? max(0.28, mix(1.0, rel, 0.85)) : min(1.35, 1.0 + 0.45 * (rel - 1.0));
    col *= shade * (0.8 + 0.2 * nv);
    col = mix(col, uAtmoColor, 0.3 * pow(1.0 - nv, 3.0));
  } else if (uLightMode == 2) {
    float mu0 = dot(n0, uSunDir);
    float day = smoothstep(-0.10, 0.12, mu0);
    // Relief can catch light just past the terminator (peaks at dawn), never deep on the night side.
    float diff = max(dot(n, uSunDir), 0.0) * smoothstep(-0.05, 0.04, mu0);
    col = col * (1.05 * diff + 0.05 * day + 0.012) + vec3(0.0012, 0.0018, 0.0035) * (1.0 - day);
    vec3 H = normalize(uSunDir + V);
    float nh = max(dot(n0, H), 0.0);
    col += ocean * day * (0.7 * pow(nh, 260.0) + 0.04 * pow(nh, 24.0)) * vec3(1.0, 0.93, 0.8);
    col = mix(col, uAtmoColor * 1.15, 0.45 * pow(1.0 - nv, 3.0) * smoothstep(-0.25, 0.3, mu0));
    overlayLight = mix(0.22, 1.0, day);
  }

  if (uHasOverlay > 0.5) {
    vec4 o = texture(uOverlay, st);
    if (o.a > 0.003) col = mix(col, srgbToLinear(o.rgb / o.a) * overlayLight, o.a);
  }

  if (uGratOn > 0.5) {
    float fwLat = fwidth(lat), fwLon = fwidth(lon);
    float polarFade = 1.0 - smoothstep(radians(76.0), radians(87.0), abs(lat));
    float minor = max(lineMask(lat, uGratStep, fwLat, 1.0), lineMask(lon, uGratStep, fwLon, 1.0) * polarFade);
    float major = max(lineMask(lat, PI, fwLat, 1.6), lineMask(lon, TWO_PI, fwLon, 1.6) * polarFade);
    col = mix(col, vec3(overlayLight), max(0.28 * minor, 0.55 * major));
  }

  if (uBrushOn > 0.5) {
    // Geodesic distance via the chord (precise for small radii).
    float dist = 2.0 * asin(clamp(0.5 * length(n0 - uBrushCenter), 0.0, 1.0));
    float fw = max(fwidth(dist), 1e-7);
    float e = abs(dist - uBrushRadius);
    float ring = 1.0 - smoothstep(0.8 * fw, 1.8 * fw, e);
    float halo = 1.0 - smoothstep(1.8 * fw, 3.4 * fw, e);
    float inside = (1.0 - smoothstep(uBrushRadius - fw, uBrushRadius, dist)) * 0.12;
    col = mix(col, vec3(0.0), 0.5 * halo);
    col = mix(col, uBrushColor, max(ring, inside));
  }

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
