/**
 * Globe surface shader: base (sRGB), overlay (premultiplied) and height (R16F) textures in one pass.
 *
 * Textures are row-0-north equirect rasters. The fragment derives its texture coordinate from the
 * interpolated sphere direction (exact at any zoom, no per-triangle UV warping near the poles);
 * texture derivatives are unwrapped across the antimeridian so mip selection has no seam.
 *
 * Two sampling regimes, blended by how many screen pixels a texel covers:
 *  - minified / ~1:1: hardware trilinear + anisotropic sampling; normals from central differences
 *    whose step grows with the pixel footprint (distant relief is shaded from the matching mip);
 *  - magnified (texel ≥ ~2 px): sub-texel reconstruction (GLSL_TERRAIN_RECON): smooth anti-aliased
 *    coastline from the Catmull-Rom height, land/sea colors reconstructed per class (no bleeding),
 *    C1 relief normals, plus procedural detail (slope-aware albedo and micro-relief, a colour warp
 *    that sharpens painted patch borders, fractal coast breakup) that fades in octave by octave with
 *    zoom (GLSL_TERRAIN_DETAIL).
 * Overlay lines (boundaries, coastlines) keep a constant thin screen width once magnified, the
 * coastline drawn on the displayed coast (GLSL_OVERLAY_LINES).
 * Relief normals are object-space from the height gradient with the 1/cosφ metric (no tangents).
 */
import {
  GLSL_BASIS, GLSL_CONSTANTS, GLSL_OVERLAY_LINES, GLSL_RELIEF_RESPONSE, GLSL_SRGB, GLSL_TERRAIN_DETAIL, GLSL_TERRAIN_RECON,
} from './shadersCommon';

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
${GLSL_TERRAIN_RECON}
${GLSL_TERRAIN_DETAIL}
${GLSL_RELIEF_RESPONSE}
${GLSL_OVERLAY_LINES}
uniform sampler2D uBase;
uniform float uHasBase;
uniform vec2 uBaseSize;
uniform sampler2D uOverlay;
uniform float uHasOverlay;
uniform vec2 uOverlaySize;
uniform float uDpr;
uniform sampler2D uHeight;
uniform float uHasHeight;
uniform vec2 uHeightTexel;
uniform vec2 uHeightSize;
uniform float uSameSize;
uniform float uSeaLevel;
uniform float uShadeScale;
uniform float uDetail;
uniform float uRecon;
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
// Largest shading tilt (tan of the normal's deviation): steep exaggerated slopes saturate instead of
// turning into black walls / blown-out faces.
const float MAX_TILT = 1.6;

float seaClampedHeight(vec2 st, vec2 dx, vec2 dy) {
  return max(textureGrad(uHeight, st, dx, dy).r, uSeaLevel);
}

vec3 saturateTilt(vec3 t) {
  return t * inversesqrt(1.0 + dot(t, t) * (1.0 / (MAX_TILT * MAX_TILT)));
}

// Anti-aliased mask of lines at multiples of stepSize; widthPx wide on screen (fw = fwidth(x)).
float lineMask(float x, float stepSize, float fw, float widthPx) {
  float d = abs(x - stepSize * floor(x / stepSize + 0.5));
  return 1.0 - smoothstep(0.5 * widthPx * fw, (0.5 * widthPx + 1.0) * fw, d);
}

void main() {
  vec3 n0 = normalize(vDir);
  float lat = asin(clamp(n0.y, -1.0, 1.0));
  float lon = atan(-n0.z, n0.x);
  vec2 st = vec2(lon * (1.0 / TWO_PI) + 0.5, 0.5 - lat * (1.0 / PI));
  // Screen derivatives of st with the antimeridian jump removed (|Δs| < 0.5 everywhere else).
  vec2 dsx = dFdx(st), dsy = dFdy(st);
  dsx.x -= floor(dsx.x + 0.5);
  dsy.x -= floor(dsy.x + 0.5);
  vec2 fwSt = abs(dsx) + abs(dsy);
  // Angular size of a screen pixel on the sphere.
  float pxRad = max(max(length(dFdx(n0)), length(dFdy(n0))), 1e-7);
  float lonW = lon < 0.0 ? lon + TWO_PI : lon;
  float fwLat = fwidth(lat), fwLon = min(fwidth(lon), fwidth(lonW));
  vec3 east, north;
  geoBasis(lat, lon, east, north);
  float cosLat = max(cos(lat), 0.5 * uHeightTexel.y * PI);
  bool lit = uLightMode != 0;
  bool hasH = uHasHeight > 0.5;

  // Magnification: 0 while a texel covers ≤ 1 px, 1 once it covers ≥ 2 px.
  vec2 texSize = uHasBase > 0.5 ? uBaseSize : uHeightSize;
  float texRad = PI / max(texSize.y, 1.0);
  // Only for one shared raster: a base painted on another grid has its own land/sea mask, so per-class
  // colours around the height contour would show a second, blocky coastline (hardware path instead).
  bool oneRaster = uSameSize > 0.5 || uHasBase < 0.5;
  float k = hasH && oneRaster ? uRecon * smoothstep(1.0, 0.5, pxRad / texRad) : 0.0;

  // Hardware-filtered height (uniform control flow: its derivative gives the coast AA width).
  float hLin = hasH ? textureGrad(uHeight, st, dsx, dsy).r : uSeaLevel - 1.0;
  float fwH = fwidth(hLin);
  // Coarse (~8 texel / ≥ 4 px) mean height for the light-independent relief cue.
  vec2 cg = max(8.0 * uHeightTexel, 4.0 * fwSt);
  float hCoarse = hasH ? textureGrad(uHeight, st, vec2(cg.x, 0.0), vec2(0.0, cg.y)).r : uSeaLevel;
  // Height texel angle; relief exaggeration grows as a pixel spans more of the map (at the default
  // zoom a texel is ~1 px and footprint-filtered slopes flatten further out): ×1.6 at 1 texel/px
  // (≈ ×1.5 at the default camera distance), up to ×2.2, fading to ×1 as texels magnify (the
  // reconstruction path takes over).
  float texRadH = PI / uHeightSize.y;
  float footBoost = clamp(1.6 * sqrt(pxRad / texRadH), 1.0, 2.2);

  vec3 col = vec3(0.015, 0.02, 0.03);
  vec3 tilt = vec3(0.0);
  float land = 0.0;
  float detailAlbedo = 0.0;
  float rough = 0.0;
  // Relief tilt without the procedural detail (drives the light-independent relief cue).
  float baseTilt = 0.0;
  // Screen distance to the displayed coast for the overlay's coastline (1e6 = unknown) and the weight
  // of that analytic coast (the reconstruction's share).
  float coastPx = 1e6, snap = 0.0, coastM = 1.0;
  vec2 coastG = vec2(0.0);

  if (k < 1.0) {
    vec3 c = uHasBase > 0.5 ? textureGrad(uBase, st, dsx, dsy).rgb : col;
    float l = hasH ? smoothstep(-0.5, 0.5, (hLin - uSeaLevel) / max(fwH, 1e-3)) : 0.0;
    vec3 t = vec3(0.0);
    if (hasH && lit) {
      vec2 d = max(uHeightTexel, fwSt);
      float hE = seaClampedHeight(st + vec2(d.x, 0.0), dsx, dsy);
      float hW = seaClampedHeight(st - vec2(d.x, 0.0), dsx, dsy);
      float hN = seaClampedHeight(st - vec2(0.0, d.y), dsx, dsy);
      float hS = seaClampedHeight(st + vec2(0.0, d.y), dsx, dsy);
      // Surface gradient in metres per radian of arc: d/dx = (1/cosφ) d/dλ, d/dy = d/dφ.
      float gE = (hE - hW) / (2.0 * d.x * TWO_PI * cosLat);
      float gN = (hN - hS) / (2.0 * d.y * PI);
      // Seas render flat: the clamped gradient still rises toward the coast on the sea side.
      t = (uShadeScale * footBoost) * l * (gE * east + gN * north);
    }
    col = c;
    land = l;
    tilt = t;
    baseTilt = length(t);
  }

  if (k > 0.0) {
    vec3 warp = vec3(0.0), cwarp = vec3(0.0);
    float ridgeW = smoothstep(400.0, 2500.0, hLin - uSeaLevel);
    vec4 det = uDetail > 0.0 ? terrainDetail(n0, texRad, pxRad, ridgeW, warp, cwarp) : vec4(0.0);
    // Fractal coast breakup by domain warping the lookup (≤ ~0.4 texel, tangent to the sphere).
    warp = uDetail * (warp - dot(warp, n0) * n0);
    vec2 stw = st + vec2(dot(warp, east) / (TWO_PI * cosLat), -dot(warp, north) / PI);
    TerrainSample ts = reconstructTerrain(
      uHeight, uHeightSize, uBase, uBaseSize, uSameSize > 0.5, uHasBase > 0.5, stw, uSeaLevel, pxRad / texRadH);
    // Real (unexaggerated) slope and elevation drive how rugged the procedural detail is.
    float slopeReal = length(ts.g) / (texRadH * 6371000.0);
    float above = max(ts.h - uSeaLevel, 0.0);
    float r = clamp(max(smoothstep(0.004, 0.05, slopeReal), smoothstep(250.0, 3000.0, above)), 0.0, 1.0);
    // Coast = zero contour of the squashed height, anti-aliased over one pixel (analytic gradient).
    float aa = max(length(ts.gm) * (pxRad / texRadH), 1e-4);
    float l = smoothstep(-0.5, 0.5, ts.m / aa);
    coastPx = coastDistPx(ts.m, ts.gmd, dsx * uHeightSize, dsy * uHeightSize);
    coastM = ts.m;
    coastG = ts.gmd;
    snap = k;
    // Procedural colour warp of the land (tangent displacement → base texels); lit modes only (flat
    // mode keeps exact legend colours).
    cwarp = (lit ? uDetail : 0.0) * (cwarp - dot(cwarp, n0) * n0);
    vec2 coff = vec2(dot(cwarp, east) / (TWO_PI * cosLat), -dot(cwarp, north) / PI) * uHeightSize;
    vec3 c = uHasBase > 0.5 ? mix(ts.seaCol, perturbLand(ts, coff), l) : col;
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
    land = mix(land, l, k);
    tilt = mix(tilt, t, k);
    detailAlbedo = k * l * det.x;
    rough = r;
  }

  vec3 n = normalize(n0 - saturateTilt(tilt));
  float ocean = hasH ? 1.0 - land : 0.0;

  vec3 V = normalize(cameraPosition - vWorld);
  float nv = max(dot(n0, V), 0.0);
  float overlayLight = 1.0;
  if (lit) {
    // Albedo detail and the light-independent relief cue (lit modes only: flat mode keeps exact
    // legend colors).
    col *= 1.0 + uDetail * detailAlbedoGain(rough) * detailAlbedo;
    col *= reliefCue(baseTilt, land * (max(hLin, uSeaLevel) - max(hCoarse, uSeaLevel)));
  }
  if (uLightMode == 1) {
    // Hillshade with the light 35° above the local horizon toward screen up-left, evaluated per
    // fragment so the whole visible hemisphere is evenly lit; 1.0 on flat ground.
    vec3 t = uCamUpLeft - dot(uCamUpLeft, n0) * n0;
    float tl = length(t);
    vec3 T = tl > 1e-4 ? t / tl : north;
    vec3 L = n0 * SIN_ALT + T * COS_ALT;
    float shade = reliefShade(dot(n, L) / SIN_ALT);
    col *= shade * (0.8 + 0.2 * nv);
    col = mix(col, uAtmoColor * 0.9, 0.28 * pow(1.0 - nv, 3.0));
  } else if (uLightMode == 2) {
    float mu0 = dot(n0, uSunDir);
    float day = smoothstep(-0.10, 0.12, mu0);
    // Relief can catch light just past the terminator (peaks at dawn), never deep on the night side.
    float nl = dot(n, uSunDir);
    float diff = max(nl, 0.0) * smoothstep(-0.05, 0.04, mu0);
    // Sky fill on slopes facing away from the sun (keeps shadowed mountainsides readable).
    float fill = 0.06 * day * (0.5 + 0.5 * dot(n, n0));
    col = col * (1.02 * diff + fill + 0.012) + vec3(0.0012, 0.0018, 0.0035) * (1.0 - day);
    // Sun glint on water only: microfacet (Beckmann, rms wave slope ~0.19) × Schlick Fresnel. A
    // soft, moderately bright patch, never a saturated white disk.
    if (ocean > 0.0) {
      vec3 H = normalize(uSunDir + V);
      float nh = max(dot(n0, H), 1e-3);
      float nh2 = nh * nh;
      const float M2 = 0.036;
      float D = exp((nh2 - 1.0) / (nh2 * M2)) / (PI * M2 * nh2 * nh2);
      float F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
      float spec = D * F / (4.0 * max(nv, 0.08));
      col += ocean * smoothstep(0.0, 0.08, mu0) * min(spec, 0.6) * 2.2 * vec3(1.0, 0.97, 0.92);
    }
    col = mix(col, uAtmoColor * 1.1, 0.4 * pow(1.0 - nv, 3.0) * smoothstep(-0.25, 0.3, mu0));
    overlayLight = mix(0.22, 1.0, day);
  }

  if (uHasOverlay > 0.5) {
    vec4 o = textureGrad(uOverlay, st, dsx, dsy);
    // Magnified (an overlay texel ≥ 1–1.4 px): the lines are redrawn at a constant thin screen width
    // (the coastline on the displayed coast) instead of growing with the zoom.
    float ovTex = pxRad * uOverlaySize.y / PI;
    float ko = smoothstep(1.0, 0.7, ovTex);
    if (ko > 0.0) {
      OverlayRidge ridge = overlayRidge(uOverlay, uOverlaySize, st, dsx * uOverlaySize, dsy * uOverlaySize);
      float onCoast = snap > 0.0 ? ridgeOnCoast(ridge, uHeight, uHeightSize, uOverlaySize, st, uSeaLevel, coastM, coastG) : 0.0;
      o = mix(o, overlayCompose(ridge, coastPx, onCoast, snap, uDpr), ko);
    }
    if (o.a > 0.003) col = mix(col, srgbToLinear(o.rgb / o.a) * overlayLight, o.a);
  }

  if (uGratOn > 0.5) {
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
