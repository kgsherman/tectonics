/** GLSL snippets shared by the globe shaders (Three.js ShaderMaterial, WebGL2 / GLSL ES 3.0). */

export const GLSL_CONSTANTS = /* glsl */ `
#define PI 3.141592653589793
#define TWO_PI 6.283185307179586
`;

/** Exact sRGB → linear transfer (for colors not coming from sRGB textures). */
export const GLSL_SRGB = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
`;

/**
 * Local east/north unit vectors in Three world axes (Y = north) at a geo lat/lon. Matches the
 * derivatives of the SphereGeometry parameterisation: P = (cosφ cosλ, sinφ, −cosφ sinλ).
 */
export const GLSL_BASIS = /* glsl */ `
void geoBasis(float lat, float lon, out vec3 east, out vec3 north) {
  float sl = sin(lon), cl = cos(lon), sp = sin(lat), cp = cos(lat);
  east = vec3(-sl, 0.0, -cl);
  north = vec3(-sp * cl, cp, sp * sl);
}
`;

/** Exact linear → sRGB transfer (for shaders writing sRGB bytes themselves, e.g. the 2D map base). */
export const GLSL_SRGB_ENCODE = /* glsl */ `
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

/**
 * Sub-texel terrain reconstruction shared by the globe surface and the 2D map base (GLSL ES 3.0).
 *
 * The painted base image and the height map are the same equirect raster (row 0 = north), with land
 * exactly where height > sea level. When a texel covers several screen pixels, plain bilinear
 * magnification shows stair-stepped coasts and colors bleeding across them. Instead:
 *  - height is Catmull-Rom interpolated (4×4 texelFetch); relief normals come from analytic
 *    gradients of the sea-clamped height: Catmull-Rom (crisp) and B-spline (C2; stair-steps of the
 *    thresholded raster are not shaded as rows of little cliffs) — see terrainGradient();
 *  - the coast is the zero contour of a *saturated* height field ((h − sea)/S squashed to ±1: raw
 *    heights are so asymmetric at coasts, +50 m land next to −2000 m sea, that their contour hugs
 *    the land texel centers). The field is B-spline smoothed (turns the thresholded raster's
 *    staircases into smooth diagonals) but kept within ±0.5 of its Catmull-Rom interpolation, so
 *    single-texel islands and lakes survive. Anti-aliased over one screen pixel by the caller;
 *  - land and sea colors are reconstructed separately from the texels of each class, so land color
 *    extends across the smooth coast without sea tint and vice versa: Catmull-Rom (sharp, clamped to
 *    the class's colour range in the central 2×2 texels so lakes/rivers/ice edges do not ring) where
 *    the 4×4 neighbourhood is (almost) all one class, blending to positive B-spline weights (always
 *    well conditioned) toward the coast;
 *  - on land, sharp two-colour edges of the painted raster (lake shores, Köppen class and snow
 *    edges: binary texel masks that magnify into staircases) are rebuilt like the coast:
 *    the two dominant colours A, B of the land's central 2×2 texels define a membership
 *    t = proj(c − A, B − A) per texel, B-spline smoothed (kept within ±0.5 of Catmull-Rom so
 *    single-texel features survive), thresholded at 0.5 and anti-aliased over one screen pixel,
 *    each side coloured by its own texels. Gated by contrast and by how well the whole stencil fits
 *    two colours, so gradients, texture and junctions keep the Catmull-Rom colour (classEdge()).
 * Only meaningful when base and height are one raster (same size): callers disable it otherwise.
 * Longitude wraps; rows clamp at the poles. Needs GLSL_CONSTANTS.
 */
export const GLSL_TERRAIN_RECON = /* glsl */ `
void crWeights(float t, out vec4 w, out vec4 dw) {
  float t2 = t * t, t3 = t2 * t;
  w = vec4(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
  dw = vec4(-1.5 * t2 + 2.0 * t - 0.5, 4.5 * t2 - 5.0 * t, -4.5 * t2 + 4.0 * t + 0.5, 1.5 * t2 - t);
}
vec4 bsWeights(float t) {
  float t2 = t * t, t3 = t2 * t, s = 1.0 - t;
  return vec4(s * s * s, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) * (1.0 / 6.0);
}
vec4 bsDerivs(float t) {
  float s = 1.0 - t;
  return vec4(-0.5 * s * s, 1.5 * t * t - 2.0 * t, -1.5 * t * t + t + 0.5, 0.5 * t * t);
}
int wrapCol(int c, int w) {
  return c < 0 ? c + w : (c >= w ? c - w : c);
}
void classRange(vec3 c, bool isLand, inout vec3 lmin, inout vec3 lmax, inout vec3 smin, inout vec3 smax) {
  if (isLand) {
    lmin = min(lmin, c);
    lmax = max(lmax, c);
  } else {
    smin = min(smin, c);
    smax = max(smax, c);
  }
}
// Clamps a Catmull-Rom colour into [lo, hi] (the class's central texels); [0, 1] when none.
vec3 antiRing(vec3 cr, vec3 lo, vec3 hi) {
  return hi.x >= lo.x ? clamp(cr, lo, hi) : clamp(cr, 0.0, 1.0);
}

// Two-colour edge reconstruction inside the class 'want' (1 land, 0 sea) of a 4×4 stencil: returns
// 'base' with sharp binary colour edges rebuilt as smooth anti-aliased contours (see the header).
// f: sample position in the central cell; pxTex: texels per screen pixel.
vec3 classEdge(vec3 cv[16], float lv[16], float want, vec2 f, vec4 bx, vec4 by, vec4 dbx, vec4 dby, vec4 cx, vec4 cy,
               float pxTex, vec3 base) {
  // Anchors: A = the class's central texel nearest the sample, B = its central texel most unlike A.
  vec3 A = base;
  float best = -1.0;
  for (int j = 1; j <= 2; j++) {
    for (int i = 1; i <= 2; i++) {
      int k = 4 * j + i;
      float w = (i == 1 ? 1.0 - f.x : f.x) * (j == 1 ? 1.0 - f.y : f.y);
      if (lv[k] == want && w > best) {
        best = w;
        A = cv[k];
      }
    }
  }
  if (best < 0.0) return base;
  vec3 sA = sqrt(max(A, 0.0));
  vec3 B = A;
  float far = 0.0;
  for (int j = 1; j <= 2; j++) {
    for (int i = 1; i <= 2; i++) {
      int k = 4 * j + i;
      vec3 d = sqrt(max(cv[k], 0.0)) - sA;
      float q = dot(d, d);
      if (lv[k] == want && q > far) {
        far = q;
        B = cv[k];
      }
    }
  }
  // Perceptual contrast gate (distance in √linear ≈ gamma-2 space).
  float contrast = smoothstep(0.004, 0.02, far);
  if (contrast <= 0.0) return base;
  vec3 D = B - A;
  float inv = 1.0 / max(dot(D, D), 1e-10);
  float sw = 0.0, stt = 0.0, scw = 0.0, sct = 0.0, wa = 0.0, wb = 0.0, dev = 0.0, nc = 0.0;
  vec2 gw = vec2(0.0), gt = vec2(0.0);
  vec3 ca = vec3(0.0), cb = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      int k = 4 * j + i;
      if (lv[k] != want) continue;
      float tu = dot(cv[k] - A, D) * inv;
      // Distance of the texel from the two-colour model (0 for exactly A or B; a gradient continuing
      // beyond A/B, texture or a third colour give large values).
      vec3 rsd = cv[k] - A - tu * D;
      dev += min(tu * tu, (tu - 1.0) * (tu - 1.0)) + dot(rsd, rsd) * inv;
      nc += 1.0;
      float t = clamp(tu, 0.0, 1.0);
      float w = bx[i] * by[j];
      vec2 dw = vec2(dbx[i] * by[j], bx[i] * dby[j]);
      sw += w;
      stt += w * t;
      gw += dw;
      gt += dw * t;
      float wc = cx[i] * cy[j];
      scw += wc;
      sct += wc * t;
      ca += (w - w * t) * cv[k];
      wa += w - w * t;
      cb += (w * t) * cv[k];
      wb += w * t;
    }
  }
  if (sw < 1e-4) return base;
  float T = stt / sw;
  vec2 gT = (gt - T * gw) / sw;
  if (scw > 0.3) {
    float tc = sct / scw;
    T = clamp(T, tc - 0.5, tc + 0.5);
  }
  float e = smoothstep(-0.5, 0.5, (T - 0.5) / max(length(gT) * pxTex, 1e-4));
  vec3 colA = wa > 1e-5 ? ca / wa : A;
  vec3 colB = wb > 1e-5 ? cb / wb : B;
  // Only a binary stencil (every texel of the class ≈ A or B) is a painted class edge; gradients,
  // texture, anti-aliased lines and junctions of three colours keep the Catmull-Rom colour.
  float binary = 1.0 - smoothstep(0.004, 0.03, dev / max(nc, 1.0));
  return mix(base, mix(colA, colB, e), contrast * binary);
}

// Height scale (m) of the squashed coast field.
const float COAST_SCALE = 15.0;

struct TerrainSample {
  float h;        // Catmull-Rom height (m)
  vec2 g;         // its gradient, m per texel (x east, y south)
  vec2 gc;        // Catmull-Rom gradient of the sea-clamped height (seas flat), m per texel
  vec2 gb;        // B-spline gradient of the sea-clamped height, m per texel
  float m;        // coast field: > 0 land, < 0 sea (≈ ±1 away from the coast)
  vec2 gm;        // its gradient per texel
  vec3 landCol;   // linear RGB of land texels around the point
  vec3 seaCol;    // linear RGB of sea texels around the point
};

// heightTex/baseTex: texel-exact rasters; sameSize: base and height rasters have equal dimensions;
// pxTex: height texels per screen pixel (anti-aliasing width of rebuilt colour edges).
TerrainSample reconstructTerrain(sampler2D heightTex, vec2 hSize, sampler2D baseTex, vec2 bSize, bool sameSize,
                                 bool hasBase, vec2 st, float sea, float pxTex) {
  TerrainSample r;
  ivec2 hs = ivec2(hSize);
  vec2 p = st * hSize - 0.5;
  vec2 fp = floor(p);
  vec2 f = p - fp;
  ivec2 i0 = ivec2(fp) - 1;
  vec4 cx, dcx, cy, dcy;
  crWeights(f.x, cx, dcx);
  crWeights(f.y, cy, dcy);
  vec4 bx = bsWeights(f.x), by = bsWeights(f.y);
  vec4 dbx = bsDerivs(f.x), dby = bsDerivs(f.y);
  float h = 0.0, m = 0.0, mb = 0.0;
  vec2 g = vec2(0.0), gc = vec2(0.0), gb = vec2(0.0), gm = vec2(0.0);
  vec3 lc = vec3(0.0), sc = vec3(0.0), lcr = vec3(0.0), scr = vec3(0.0);
  float wl = 0.0, ws = 0.0, wlr = 0.0, wsr = 0.0;
  // Per-class colour range of the central 2×2 texels (anti-ringing bounds; empty = min > max).
  vec3 lmin = vec3(2.0), lmax = vec3(-1.0), smin = vec3(2.0), smax = vec3(-1.0);
  bool fused = sameSize && hasBase;
  // Fused stencil kept for the class-edge pass.
  vec3 cv[16];
  float lv[16];
  for (int j = 0; j < 4; j++) {
    int row = clamp(i0.y + j, 0, hs.y - 1);
    float rh = 0.0, rdh = 0.0, rhc = 0.0, rdhc = 0.0, rhb = 0.0, rdhb = 0.0, rm = 0.0, rdm = 0.0, rmb = 0.0;
    for (int i = 0; i < 4; i++) {
      ivec2 tc = ivec2(wrapCol(i0.x + i, hs.x), row);
      float v = texelFetch(heightTex, tc, 0).r;
      float vc = max(v, sea);
      float x = (v - sea) * (1.0 / COAST_SCALE);
      // Strictly signed: a texel exactly at sea level is sea (land iff h > sea).
      float sv = v > sea ? max(x * inversesqrt(1.0 + x * x), 0.02) : min(x * inversesqrt(1.0 + x * x), -0.02);
      rh += cx[i] * v;
      rdh += dcx[i] * v;
      rhc += cx[i] * vc;
      rdhc += dcx[i] * vc;
      rhb += bx[i] * vc;
      rdhb += dbx[i] * vc;
      rm += cx[i] * sv;
      rdm += dcx[i] * sv;
      rmb += bx[i] * sv;
      if (fused) {
        vec3 c = texelFetch(baseTex, tc, 0).rgb;
        float wb = bx[i] * by[j];
        float wc = cx[i] * cy[j];
        float isLand = v > sea ? 1.0 : 0.0;
        cv[4 * j + i] = c;
        lv[4 * j + i] = isLand;
        lc += (wb * isLand) * c;
        wl += wb * isLand;
        sc += (wb - wb * isLand) * c;
        ws += wb - wb * isLand;
        lcr += (wc * isLand) * c;
        wlr += wc * isLand;
        scr += (wc - wc * isLand) * c;
        wsr += wc - wc * isLand;
        if ((i == 1 || i == 2) && (j == 1 || j == 2)) classRange(c, v > sea, lmin, lmax, smin, smax);
      }
    }
    h += cy[j] * rh;
    g += vec2(cy[j] * rdh, dcy[j] * rh);
    gc += vec2(cy[j] * rdhc, dcy[j] * rhc);
    gb += vec2(by[j] * rdhb, dby[j] * rhb);
    m += cy[j] * rm;
    gm += vec2(cy[j] * rdm, dcy[j] * rm);
    mb += by[j] * rmb;
  }
  if (hasBase && !fused) {
    // Base raster of another size: classify its texels by sampling the height at their centers.
    ivec2 bs = ivec2(bSize);
    vec2 q = st * bSize - 0.5;
    vec2 fq = floor(q);
    vec2 u = q - fq;
    ivec2 k0 = ivec2(fq) - 1;
    vec4 ux = bsWeights(u.x), uy = bsWeights(u.y);
    vec4 vx, dvx, vy, dvy;
    crWeights(u.x, vx, dvx);
    crWeights(u.y, vy, dvy);
    for (int j = 0; j < 4; j++) {
      int row = clamp(k0.y + j, 0, bs.y - 1);
      for (int i = 0; i < 4; i++) {
        ivec2 tc = ivec2(wrapCol(k0.x + i, bs.x), row);
        vec3 c = texelFetch(baseTex, tc, 0).rgb;
        float v = textureLod(heightTex, (vec2(tc) + 0.5) / bSize, 0.0).r;
        float wb = ux[i] * uy[j];
        float wc = vx[i] * vy[j];
        float isLand = v > sea ? 1.0 : 0.0;
        lc += (wb * isLand) * c;
        wl += wb * isLand;
        sc += (wb - wb * isLand) * c;
        ws += wb - wb * isLand;
        lcr += (wc * isLand) * c;
        wlr += wc * isLand;
        scr += (wc - wc * isLand) * c;
        wsr += wc - wc * isLand;
        if ((i == 1 || i == 2) && (j == 1 || j == 2)) classRange(c, v > sea, lmin, lmax, smin, smax);
      }
    }
  }
  vec3 lcol = wl > 1e-5 ? lc / wl : vec3(0.0);
  vec3 scol = ws > 1e-5 ? sc / ws : lcol;
  if (wl <= 1e-5) lcol = scol;
  // Sharpen with Catmull-Rom where the class covers (almost) the whole stencil; the CR weight sum of
  // a class varies continuously, so the blend has no seams. CR over/undershoots high-contrast
  // features by up to ~25 % of the step (2-texel lakes/rivers on land: dark rings, black cores in
  // linear light), so it is clamped to the class's range in the central 2×2 (anti-ringing).
  if (wlr > 0.7) lcol = mix(lcol, antiRing(lcr / wlr, lmin, lmax), smoothstep(0.7, 0.97, wlr));
  if (wsr > 0.7) scol = mix(scol, antiRing(scr / wsr, smin, smax), smoothstep(0.7, 0.97, wsr));
  // Land only: painted sea colours are depth ramps (a one-texel shelf halo would turn into a hard band).
  if (fused) lcol = classEdge(cv, lv, 1.0, f, bx, by, dbx, dby, cx, cy, pxTex, lcol);
  r.h = h;
  r.g = g;
  r.gc = gc;
  r.gb = gb;
  r.m = clamp(mb, m - 0.5, m + 0.5);
  r.gm = gm;
  r.landCol = lcol;
  r.seaCol = scol;
  return r;
}

// Relief gradient (m per texel): crisp Catmull-Rom while a texel spans only a few pixels, the smooth
// B-spline gradient at the coast and once texels are large on screen (procedural detail takes over).
vec2 terrainGradient(TerrainSample ts, float texPx) {
  float smoothW = max(1.0 - smoothstep(0.8, 0.97, ts.m), 0.55 * smoothstep(3.0, 9.0, texPx));
  return mix(ts.gc, ts.gb, smoothW);
}
`;

/**
 * Procedural terrain detail: fbm of 3D gradient noise (analytic derivatives) on the unit sphere,
 * band-limited to the pixel footprint so it fades in octave by octave as the camera zooms in. The
 * coarsest octave has a wavelength of two base texels (below the painted raster's own detail).
 * Returns (albedo, gradient.xyz): albedo ≈ [-1, 1]; the gradient is a dimensionless slope field in
 * the frame of `p` (project it onto the tangent plane before tilting a normal). `warp` receives a
 * fractal displacement (radians, ≲ 0.4 texel; amplitude ∝ wavelength^0.8) for coastline breakup
 * by domain warping (bounded shift of the contour regardless of how steep the terrain is).
 */
export const GLSL_TERRAIN_DETAIL = /* glsl */ `
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 gradHash(ivec3 c) {
  return vec3(pcg3d(uvec3(c))) * (2.0 / 4294967295.0) - 1.0;
}
// Gradient noise with analytic derivatives (value, d/dx, d/dy, d/dz); value ≈ [-1, 1].
vec4 gnoised(vec3 x) {
  vec3 fi = floor(x);
  vec3 f = x - fi;
  ivec3 i = ivec3(fi);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec3 ga = gradHash(i);
  vec3 gb = gradHash(i + ivec3(1, 0, 0));
  vec3 gc = gradHash(i + ivec3(0, 1, 0));
  vec3 gd = gradHash(i + ivec3(1, 1, 0));
  vec3 ge = gradHash(i + ivec3(0, 0, 1));
  vec3 gf = gradHash(i + ivec3(1, 0, 1));
  vec3 gg = gradHash(i + ivec3(0, 1, 1));
  vec3 gh = gradHash(i + ivec3(1, 1, 1));
  float va = dot(ga, f);
  float vb = dot(gb, f - vec3(1.0, 0.0, 0.0));
  float vc = dot(gc, f - vec3(0.0, 1.0, 0.0));
  float vd = dot(gd, f - vec3(1.0, 1.0, 0.0));
  float ve = dot(ge, f - vec3(0.0, 0.0, 1.0));
  float vf = dot(gf, f - vec3(1.0, 0.0, 1.0));
  float vg = dot(gg, f - vec3(0.0, 1.0, 1.0));
  float vh = dot(gh, f - vec3(1.0, 1.0, 1.0));
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va) + u.x * u.y * (va - vb - vc + vd)
    + u.y * u.z * (va - vc - ve + vg) + u.z * u.x * (va - vb - ve + vf) + u.x * u.y * u.z * (-va + vb + vc - vd + ve - vf - vg + vh);
  vec3 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd)
    + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf) + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh)
    + du * (vec3(vb - va, vc - va, ve - va) + u.yzx * vec3(va - vb - vc + vd, va - vc - ve + vg, va - vb - ve + vf)
    + u.zxy * vec3(va - vb - ve + vf, va - vb - vc + vd, va - vc - ve + vg)
    + u.yzx * u.zxy * (-va + vb + vc - vd + ve - vf - vg + vh));
  return vec4(v, d);
}
// p: unit position; texRad: angular size of a base texel; pxRad: angular size of a screen pixel;
// ridge 0..1 turns the slope field from rounded fbm bumps into ridged (creased) relief.
vec4 terrainDetail(vec3 p, float texRad, float pxRad, float ridge, out vec3 warp) {
  float freq = 0.5 / texRad;
  // The coarsest octave overlaps the painted raster's own relief: keep its slope low.
  float amp = 1.0, slope = 0.5, wamp = 0.16 * texRad;
  float a = 0.0;
  vec3 g = vec3(0.0);
  warp = vec3(0.0);
  for (int o = 0; o < 6; o++) {
    // Wavelength on screen (px): octaves appear between 2.5 and 6 px and are fully in above that.
    float fade = smoothstep(2.5, 6.0, 1.0 / (freq * pxRad));
    if (fade <= 0.0) break;
    vec4 n = gnoised(p * freq + vec3(float(o) * 19.19, float(o) * 7.31, float(o) * 3.77));
    a += amp * fade * n.x;
    // Ridged: gradient of (1 − |n|), sharp crests along n = 0.
    g += (slope * fade) * mix(n.yzw, -sign(n.x) * n.yzw, ridge);
    warp += (wamp * fade) * n.yzw;
    freq *= 2.07;
    amp *= 0.62;
    slope = 0.72;
    wamp *= 0.56;
  }
  return vec4(a * 0.62, g);
}
`;

/**
 * Relief shade response (1 on flat ground) for rel = n·L / sin(light altitude): shadows darken
 * linearly and roll off smoothly into a 0.3 floor (sky fill, never black walls); highlights brighten
 * at 0.45× and saturate smoothly toward 1.35 (no clipped plastic sheen). Same curve as
 * mapShading.reliefShade (CPU map fallback).
 */
export const GLSL_RELIEF_RESPONSE = /* glsl */ `
float reliefShade(float rel) {
  if (rel >= 1.0) return 1.0 + 0.35 * (1.0 - exp(-1.2857 * (rel - 1.0)));
  float s = 1.0 - 0.85 * (1.0 - rel);
  return s >= 0.5 ? s : 0.3 + 0.2 * exp((s - 0.5) * 5.0);
}
// Light-independent relief cue (albedo factor, 1 on flat ground): steep slopes darken slightly and
// ground above (below) its surroundings ~150 km around brightens (darkens), so ranges read as ranges
// in any light direction, including the overhead sun, without extra highlight (no plastic sheen).
// tilt: exaggerated slope (tan); localRelief: height minus the coarse (~8 texel) mean, metres.
float reliefCue(float tilt, float localRelief) {
  float slope = 1.0 - 0.24 * smoothstep(0.1, 1.2, tilt);
  return slope * (1.0 + 0.18 * clamp(localRelief * (1.0 / 1000.0), -1.0, 1.0));
}
`;

/**
 * Crisp magnification of a premultiplied RGBA overlay of anti-aliased lines and areas (boundaries,
 * coastlines, isobars, graticule): bilinear magnification of a 1–2 texel line gives a band as wide as
 * the zoom and just as soft, following every texel step of the traced line. Here the coverage is
 * B-spline smoothed (C2: a line traced texel by texel becomes a smooth curve) and thresholded at
 * 0.4 of its local peak — about the painted width (a 1-texel line keeps ~1.25 texels, B-spline
 * peak 2/3) at the painted peak opacity — with a one-screen-pixel anti-aliased edge; the colour is
 * the B-spline average of the premultiplied texels, un-premultiplied. The local peak is a smooth
 * soft maximum (Σw·a⁴ / Σw·a³ with the B-spline weights: exact for one opacity, no texel-shaped
 * plateaus where opacities differ); isolated faint fringe texels fade out. pxTex: overlay texels per
 * screen pixel. Returns premultiplied RGBA in the texture's encoding. Needs GLSL_TERRAIN_RECON
 * (weights, wrapCol).
 */
export const GLSL_OVERLAY_SHARP = /* glsl */ `
vec4 overlaySharp(sampler2D tex, vec2 size, vec2 st, float pxTex) {
  ivec2 is = ivec2(size);
  vec2 p = st * size - 0.5;
  vec2 fp = floor(p);
  vec2 f = p - fp;
  ivec2 i0 = ivec2(fp) - 1;
  vec4 bx = bsWeights(f.x), by = bsWeights(f.y);
  vec4 dbx = bsDerivs(f.x), dby = bsDerivs(f.y);
  float p3 = 0.0, p4 = 0.0;
  vec2 ga = vec2(0.0);
  vec4 cb = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    int row = clamp(i0.y + j, 0, is.y - 1);
    for (int i = 0; i < 4; i++) {
      vec4 o = texelFetch(tex, ivec2(wrapCol(i0.x + i, is.x), row), 0);
      float w = bx[i] * by[j];
      ga += vec2(dbx[i] * by[j], bx[i] * dby[j]) * o.a;
      cb += w * o;
      float a3 = w * o.a * o.a * o.a;
      p3 += a3;
      p4 += a3 * o.a;
    }
  }
  if (p3 < 1e-7) return vec4(0.0);
  float peak = p4 / p3;
  float thr = 0.4 * peak;
  float e = max(0.5 * length(ga) * pxTex, 1e-4);
  float cov = peak * smoothstep(thr - e, thr + e, cb.a) * smoothstep(0.02, 0.08, peak);
  return vec4(cb.rgb / max(cb.a, 1e-4) * cov, cov);
}
`;

/** Minimal vertex shader for a unit SphereGeometry scaled to `uShellRadius`. */
export const SHELL_VERTEX = /* glsl */ `
uniform float uShellRadius;
varying vec2 vUv;
varying vec3 vDir;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(vDir * uShellRadius, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
