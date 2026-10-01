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
 *    well conditioned) toward the coast. Texels next to the other class (flags from a 6×6 land/sea
 *    ring, so they do not depend on the stencil position) carry the painter's coastline
 *    anti-aliasing, a blend of both classes' colours: they barely count (tan blobs in the sea and
 *    blue-tinted beaches otherwise, once magnified);
 *  - on land, sharp two-colour edges of the painted raster (lake shores, Köppen class and snow
 *    edges: binary texel masks that magnify into staircases) are rebuilt like the coast:
 *    the two dominant colours A, B of the land's central 2×2 texels define a membership
 *    t = proj(c − A, B − A) per texel, B-spline smoothed (kept within ±0.5 of Catmull-Rom so
 *    single-texel features survive), thresholded at 0.5 and anti-aliased over one screen pixel,
 *    each side coloured by its own texels. Gated by contrast and by how well the whole stencil fits
 *    two colours, so gradients, texture and junctions keep the Catmull-Rom colour (classEdge()).
 *  - the land colour's B-spline gradient and a soft local range are returned for perturbLand() (a
 *    procedural first-order colour warp that gives soft painted patch borders detailed, organic
 *    edges when zoomed in), with how much of the colour is a rebuilt edge or water (kept smooth).
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
// strength: how much of the result is a rebuilt edge (0..1).
vec3 classEdge(vec3 cv[16], float lv[16], float want, vec2 f, vec4 bx, vec4 by, vec4 dbx, vec4 dby, vec4 cx, vec4 cy,
               float pxTex, vec3 base, out float strength) {
  strength = 0.0;
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
  strength = contrast * binary;
  return mix(base, mix(colA, colB, e), strength);
}

// Height scale (m) of the squashed coast field.
const float COAST_SCALE = 15.0;

// Gradient of the displayed coast field clamp(mb, m − 0.5, m + 0.5) (B-spline value mb, Catmull-Rom
// m): the B-spline gradient where the clamp is inactive, the Catmull-Rom one where it holds, blended
// just before it engages (continuous). The Catmull-Rom gradient alone is ~1.7× steeper than the
// B-spline value's along smooth coasts: distances |m|/|∇m| from it come out too short (coast lines
// drawn ~2 px wide, soft wedges at capes).
vec2 coastGrad(float m, float mb, vec2 gm, vec2 gmb) {
  return mix(gmb, gm, smoothstep(0.47, 0.5, abs(mb - m)));
}

struct TerrainSample {
  float h;        // Catmull-Rom height (m)
  vec2 g;         // its gradient, m per texel (x east, y south)
  vec2 gc;        // Catmull-Rom gradient of the sea-clamped height (seas flat), m per texel
  vec2 gb;        // B-spline gradient of the sea-clamped height, m per texel
  float m;        // coast field: > 0 land, < 0 sea (≈ ±1 away from the coast)
  vec2 gm;        // its gradient per texel (Catmull-Rom: steeper than m itself where m is the B-spline)
  vec2 gmd;       // the gradient of m as displayed (coastGrad): screen distances to the coast
  vec3 landCol;   // linear RGB of land texels around the point
  vec3 seaCol;    // linear RGB of sea texels around the point
  vec3 landDx;    // gradient of the (B-spline) land colour per texel, x east
  vec3 landDy;    // ... y south
  vec3 landMin;   // soft colour range of the land texels around the point (min > max: none)
  vec3 landMax;
  float landEdge; // 0..1: the land colour is a rebuilt sharp two-colour edge (lake shore, class edge)
  float landWater;// B-spline share of water-coloured land texels (rivers, lakes) around the point
  float landFlat; // weighted share of exactly repeated neighbour colours: a categorical raster (Köppen, plates)
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
  vec2 g = vec2(0.0), gc = vec2(0.0), gb = vec2(0.0), gm = vec2(0.0), gmb = vec2(0.0);
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
    float rh = 0.0, rdh = 0.0, rhc = 0.0, rdhc = 0.0, rhb = 0.0, rdhb = 0.0, rm = 0.0, rdm = 0.0, rmb = 0.0, rdmb = 0.0;
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
      rdmb += dbx[i] * sv;
      if (fused) {
        cv[4 * j + i] = texelFetch(baseTex, tc, 0).rgb;
        lv[4 * j + i] = v > sea ? 1.0 : 0.0;
      }
    }
    h += cy[j] * rh;
    g += vec2(cy[j] * rdh, dcy[j] * rh);
    gc += vec2(cy[j] * rdhc, dcy[j] * rhc);
    gb += vec2(by[j] * rdhb, dby[j] * rhb);
    m += cy[j] * rm;
    gm += vec2(cy[j] * rdm, dcy[j] * rm);
    mb += by[j] * rmb;
    gmb += vec2(by[j] * rdmb, dby[j] * rmb);
  }
  // Colour-sharpening sums of the CR weights (gating uses the plain class weights wlr / wsr).
  float wlrc = 0.0, wsrc = 0.0;
  // Land colour gradient (B-spline) and range, for the procedural colour perturbation.
  vec3 dlcx = vec3(0.0), dlcy = vec3(0.0), lc2 = vec3(0.0), lp8 = vec3(0.0), lq8 = vec3(0.0);
  vec2 dwl = vec2(0.0);
  float lwater = 0.0, eqW = 0.0, eqN = 0.0;
  // Class-edge stencil: coastal texels excluded (neither class).
  float le[16];
  if (fused) {
    // Land/sea of the 6×6 texels around the stencil: each texel's coastal flag must not depend on
    // where the stencil sits (seams at texel borders otherwise).
    float l6[36];
    for (int j = 0; j < 6; j++) {
      int row = clamp(i0.y - 1 + j, 0, hs.y - 1);
      for (int i = 0; i < 6; i++) {
        bool inner = j >= 1 && j <= 4 && i >= 1 && i <= 4;
        l6[6 * j + i] = inner ? lv[4 * (j - 1) + i - 1]
          : (texelFetch(heightTex, ivec2(wrapCol(i0.x - 1 + i, hs.x), row), 0).r > sea ? 1.0 : 0.0);
      }
    }
    for (int j = 0; j < 4; j++) {
      for (int i = 0; i < 4; i++) {
        int k = 4 * j + i;
        int k6 = 6 * (j + 1) + i + 1;
        float isLand = lv[k];
        // Texels next to the other class carry the painter's coastline anti-aliasing (a blend of
        // both classes' colours: tan blobs in the sea, blue-tinted beaches once magnified). They
        // barely count toward the per-class colours (the reconstruction draws its own anti-aliased
        // coast); where a class has only such texels here, the normalisation keeps them. Sea texels
        // diagonal to land count too when land-tinted (not bluish: the anti-aliasing reaches
        // ~1.5 texels into the sea; turquoise shelves, deep water and sea ice stay).
        vec3 c = cv[k];
        bool edge = l6[k6 - 1] != isLand || l6[k6 + 1] != isLand || l6[k6 - 6] != isLand || l6[k6 + 6] != isLand;
        if (!edge && isLand < 0.5 && c.b < max(c.r, c.g) + 0.01) {
          edge = l6[k6 - 7] > 0.5 || l6[k6 - 5] > 0.5 || l6[k6 + 5] > 0.5 || l6[k6 + 7] > 0.5;
        }
        float q = edge ? 0.015 : 1.0;
        le[k] = edge ? 0.5 : isLand;
        float wb = bx[i] * by[j] * q;
        float wc = cx[i] * cy[j];
        lc += (wb * isLand) * c;
        wl += wb * isLand;
        sc += (wb - wb * isLand) * c;
        ws += wb - wb * isLand;
        vec2 dw = vec2(dbx[i] * by[j], bx[i] * dby[j]) * (q * isLand);
        dlcx += dw.x * c;
        dlcy += dw.y * c;
        dwl += dw;
        // Water on land (rivers, lakes, even as a faint anti-aliased tint of a sub-texel river): dark
        // and bluish (plants and soils have b ≪ g; snow and rock are brighter).
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        lwater += wb * isLand * smoothstep(0.5, 0.7, c.b / max(c.g, 1e-3)) * (1.0 - smoothstep(0.05, 0.1, lum));
        // Categorical rasters repeat exact colours between neighbours (painted imagery never does):
        // B-spline-weighted share of identical right / lower land neighbours (continuous as the
        // stencil moves: texels enter and leave it with zero weight).
        if (isLand > 0.5) {
          float wp = bx[i] * by[j];
          if (i < 3 && lv[k + 1] > 0.5) {
            vec3 dc = abs(cv[k + 1] - c);
            float w2 = wp + bx[i + 1] * by[j];
            eqN += w2;
            eqW += max(dc.r, max(dc.g, dc.b)) < 1e-5 ? w2 : 0.0;
          }
          if (j < 3 && lv[k + 4] > 0.5) {
            vec3 dc = abs(cv[k + 4] - c);
            float w2 = wp + bx[i] * by[j + 1];
            eqN += w2;
            eqW += max(dc.r, max(dc.g, dc.b)) < 1e-5 ? w2 : 0.0;
          }
        }
        lc2 += (wb * isLand) * c * c;
        // Power means (p = 8) of c and 1 − c: smooth stand-ins for the max / min (never beyond them).
        vec3 c2 = c * c, c4 = c2 * c2, u = 1.0 - clamp(c, 0.0, 1.0), u2 = u * u, u4 = u2 * u2;
        lp8 += (wb * isLand) * c4 * c4;
        lq8 += (wb * isLand) * u4 * u4;
        wlr += wc * isLand;
        wsr += wc - wc * isLand;
        wc *= q;
        lcr += (wc * isLand) * c;
        wlrc += wc * isLand;
        scr += (wc - wc * isLand) * c;
        wsrc += wc - wc * isLand;
        if (!edge && (i == 1 || i == 2) && (j == 1 || j == 2)) classRange(c, isLand > 0.5, lmin, lmax, smin, smax);
      }
    }
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
    wlrc = wlr;
    wsrc = wsr;
  }
  vec3 lcol = wl > 1e-5 ? lc / wl : vec3(0.0);
  vec3 scol = ws > 1e-5 ? sc / ws : lcol;
  if (wl <= 1e-5) lcol = scol;
  // Sharpen with Catmull-Rom where the class covers (almost) the whole stencil; the CR weight sum of
  // a class varies continuously, so the blend has no seams. CR over/undershoots high-contrast
  // features by up to ~25 % of the step (2-texel lakes/rivers on land: dark rings, black cores in
  // linear light), so it is clamped to the class's range in the central 2×2 (anti-ringing).
  if (wlr > 0.7 && wlrc > 0.3) lcol = mix(lcol, antiRing(lcr / wlrc, lmin, lmax), smoothstep(0.7, 0.97, wlr) * smoothstep(0.3, 0.6, wlrc));
  if (wsr > 0.7 && wsrc > 0.3) scol = mix(scol, antiRing(scr / wsrc, smin, smax), smoothstep(0.7, 0.97, wsr) * smoothstep(0.3, 0.6, wsrc));
  // Land only: painted sea colours are depth ramps (a one-texel shelf halo would turn into a hard band).
  float edgeW = 0.0;
  if (fused) lcol = classEdge(cv, le, 1.0, f, bx, by, dbx, dby, cx, cy, pxTex, lcol, edgeW);
  r.h = h;
  r.g = g;
  r.gc = gc;
  r.gb = gb;
  r.m = clamp(mb, m - 0.5, m + 0.5);
  r.gm = gm;
  r.gmd = coastGrad(m, mb, gm, gmb);
  r.landCol = lcol;
  r.seaCol = scol;
  vec3 lbs = wl > 1e-5 ? lc / wl : vec3(0.0);
  float iwl = wl > 1e-5 ? 1.0 / wl : 0.0;
  r.landDx = (dlcx - lbs * dwl.x) * iwl;
  r.landDy = (dlcy - lbs * dwl.y) * iwl;
  // Mean ± 1.6σ within the smooth max / min (continuous B-spline weights: no seams where the stencil
  // moves on; never beyond the texels' own range: no black or blown-out rims at snow edges).
  vec3 sd = sqrt(max(lc2 * iwl - lbs * lbs, 0.0));
  vec3 pmax = pow(max(lp8 * iwl, 0.0), vec3(0.125)), pmin = 1.0 - pow(max(lq8 * iwl, 0.0), vec3(0.125));
  r.landMin = fused && wl > 1e-5 ? max(lbs - 1.6 * sd, pmin) : vec3(2.0);
  r.landMax = fused && wl > 1e-5 ? min(lbs + 1.6 * sd, pmax) : vec3(-1.0);
  r.landEdge = edgeW;
  r.landWater = lwater * iwl;
  r.landFlat = eqN > 1e-5 ? eqW / eqN : 0.0;
  return r;
}

// Land colour displaced by off (texels) to first order, kept inside the stencil's land colour range:
// the procedural colour warp that turns soft painted patch borders (forest/grass, soil, snow) into
// detailed, organic ones without another texture fetch. Rebuilt sharp edges (lake shores, class
// edges), water on land (rivers would break up) and categorical rasters (Köppen, plates: exact legend
// classes) stay as painted.
vec3 perturbLand(TerrainSample ts, vec2 off) {
  if (ts.landMax.x < ts.landMin.x) return ts.landCol;
  off *= (1.0 - ts.landEdge) * (1.0 - smoothstep(0.02, 0.15, ts.landWater)) * (1.0 - smoothstep(0.1, 0.35, ts.landFlat));
  // Limits only the displacement (the reconstructed colour itself may lie outside the soft range).
  return clamp(ts.landCol + ts.landDx * off.x + ts.landDy * off.y, min(ts.landMin, ts.landCol), max(ts.landMax, ts.landCol));
}

// Coast field alone (same values as reconstructTerrain's m / gmd): x = m (> 0 land), yz = its gradient
// per texel as displayed (coastGrad). For passes that only need the displayed coastline (the map
// overlay).
vec3 coastField(sampler2D heightTex, vec2 hSize, vec2 st, float sea) {
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
  float m = 0.0, mb = 0.0;
  vec2 gm = vec2(0.0), gmb = vec2(0.0);
  for (int j = 0; j < 4; j++) {
    int row = clamp(i0.y + j, 0, hs.y - 1);
    float rm = 0.0, rdm = 0.0, rmb = 0.0, rdmb = 0.0;
    for (int i = 0; i < 4; i++) {
      float v = texelFetch(heightTex, ivec2(wrapCol(i0.x + i, hs.x), row), 0).r;
      float x = (v - sea) * (1.0 / COAST_SCALE);
      float sv = v > sea ? max(x * inversesqrt(1.0 + x * x), 0.02) : min(x * inversesqrt(1.0 + x * x), -0.02);
      rm += cx[i] * sv;
      rdm += dcx[i] * sv;
      rmb += bx[i] * sv;
      rdmb += dbx[i] * sv;
    }
    m += cy[j] * rm;
    gm += vec2(cy[j] * rdm, dcy[j] * rm);
    mb += by[j] * rmb;
    gmb += vec2(by[j] * rdmb, dby[j] * rmb);
  }
  return vec3(clamp(mb, m - 0.5, m + 0.5), coastGrad(m, mb, gm, gmb));
}

// Screen distance (px) to the displayed coast from the coast field (value m, gradient gm per height
// texel) and the height-texel-per-pixel Jacobian columns jx, jy.
float coastDistPx(float m, vec2 gm, vec2 jx, vec2 jy) {
  return abs(m) / max(length(vec2(dot(gm, jx), dot(gm, jy))), 1e-6);
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
 * band-limited to the pixel footprint so it fades in octave by octave as the camera zooms in (down
 * to ~2–5 px wavelengths). The coarsest octave has a wavelength of two base texels (below the
 * painted raster's own detail). Returns (albedo, gradient.xyz): albedo ≈ [-1, 1], following the
 * micro-relief (bumps / ridged crests lighter) with a flatter spectrum than the relief; the gradient
 * is a dimensionless slope field in the frame of `p` (project it onto the tangent plane before tilting
 * a normal). `warp` receives a fractal displacement (radians, ≲ 0.4 texel; amplitude ∝
 * wavelength^0.8) for coastline breakup by domain warping (bounded shift of the contour regardless of
 * how steep the terrain is); `cwarp` a larger, flatter one for the land colours (perturbLand).
 * detailSlopeGain / detailAlbedoGain give the slope-aware strengths shared by the globe and the map.
 * The detail is anchored to the planet frame: the views fade it out while the height map streams
 * (DetailFader), so it never swims over moving plates.
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
// Octave fade-in by on-screen wavelength (px): an octave appears between 2 and 5 px (below that it
// would alias and shimmer while the globe turns) and is fully in above.
float detailFade(float freq, float pxRad) {
  return smoothstep(2.0, 5.0, 1.0 / (freq * pxRad));
}
// p: unit position; texRad: angular size of a base texel; pxRad: angular size of a screen pixel;
// ridge 0..1 turns the slope field from rounded fbm bumps into ridged (creased) relief.
// cwarp: a flatter-spectrum fractal displacement (radians) for the land colours (perturbLand).
vec4 terrainDetail(vec3 p, float texRad, float pxRad, float ridge, out vec3 warp, out vec3 cwarp) {
  float freq = 0.5 / texRad;
  // The coarsest octave overlaps the painted raster's own relief: keep its slope low.
  float amp = 1.0, slope = 0.5, wamp = 0.16 * texRad, camp = 1.0 * texRad;
  float a = 0.0;
  vec3 g = vec3(0.0);
  warp = vec3(0.0);
  cwarp = vec3(0.0);
  for (int o = 0; o < 6; o++) {
    float fade = detailFade(freq, pxRad);
    if (fade <= 0.0) break;
    vec4 n = gnoised(p * freq + vec3(float(o) * 19.19, float(o) * 7.31, float(o) * 3.77));
    // Albedo follows the micro-relief it shades: rounded terrain is lighter on its bumps, ridged
    // terrain on its crests (rock, scree) and darker in the creases. A flatter spectrum than the
    // relief (amp × 0.74 per octave): fine texture is what reads as sharpness up close.
    a += amp * fade * mix(n.x, 1.6 * (0.22 - abs(n.x)), ridge);
    // Ridged: gradient of (1 − |n|), sharp crests along n = 0.
    g += (slope * fade) * mix(n.yzw, -sign(n.x) * n.yzw, ridge);
    warp += (wamp * fade) * n.yzw;
    cwarp += (camp * fade) * n.yzw;
    freq *= 2.07;
    amp *= 0.74;
    slope = 0.72;
    wamp *= 0.56;
    camp *= 0.7;
  }
  return vec4(a * 0.62, g);
}
// The coast-breakup warp of terrainDetail alone (same octaves, same values).
vec3 terrainWarp(vec3 p, float texRad, float pxRad) {
  float freq = 0.5 / texRad;
  float wamp = 0.16 * texRad;
  vec3 warp = vec3(0.0);
  for (int o = 0; o < 6; o++) {
    float fade = detailFade(freq, pxRad);
    if (fade <= 0.0) break;
    vec4 n = gnoised(p * freq + vec3(float(o) * 19.19, float(o) * 7.31, float(o) * 3.77));
    warp += (wamp * fade) * n.yzw;
    freq *= 2.07;
    wamp *= 0.56;
  }
  return warp;
}
// Detail strengths shared by the globe and the map. rough 0..1: slope/elevation ruggedness.
// Micro-relief slope (tan) added to the shading normal: some texture on plains, much more on slopes.
float detailSlopeGain(float rough) {
  return 0.08 + 0.3 * rough;
}
// Relative albedo modulation per unit of terrainDetail's albedo.
float detailAlbedoGain(float rough) {
  return 0.26 + 0.12 * rough;
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
 * Magnified overlay lines (plate boundaries, coastlines) at a constant, thin screen width.
 *
 * The overlay is a raster of 1–2 texel anti-aliased lines. Magnifying it (bilinear, or thresholding a
 * smoothed coverage) draws each line as wide as its texels: 7 px bands at a globe distance of 2.2,
 * 15 px at 1.5, opaque blobs over small islands. Instead the line *centres* are recovered and redrawn
 * at a fixed width in screen pixels:
 *  - overlayRidge(): the coverage is B-spline smoothed over the 4×4 texel stencil (C2: a line traced
 *    texel by texel becomes a smooth curve; the fractional coverage of anti-aliased fringe texels puts
 *    the ridge at sub-texel precision) with analytic gradient g and Hessian H. A line is a ridge: H
 *    has a clearly negative principal curvature λ1 (direction e1 across the line) and the centre lies
 *    at the Newton offset x = −(g·e1)/λ1. Its screen distance is |x| / |Jᵀe1| with J the texel-per-
 *    pixel Jacobian (exact under the anisotropic equirect → screen mapping). Where both curvatures
 *    are negative and alike (dots, line ends, junctions) the distance blends to the 2D Newton offset.
 *    Opacity is the painted one (soft maximum Σw·a⁴/Σw·a³ of the stencil), colour the α⁴-weighted
 *    texel colour (the line core, not its dark halo texels);
 *  - overlayCompose(): the line at LINE_HALF_PX, a subtle separate dark halo beyond it, and the
 *    coastline redrawn on the *displayed* coast when the caller knows it (snap > 0): the raster's
 *    coastline is traced on the unwarped height contour, the reconstructed coast is domain-warped by
 *    the procedural breakup (≲ 0.4 texel), so a white raster ridge within ~1 texel of the displayed
 *    coast is replaced by an analytic line on the coast itself (distance |m|/|∇m| of the coast field).
 * Everything is in the texture's encoding (sRGB bytes / 255), premultiplied. Needs GLSL_TERRAIN_RECON
 * (weights, wrapCol).
 */
export const GLSL_OVERLAY_LINES = /* glsl */ `
// Line half width and the halo beyond it (CSS px; times the device pixel ratio).
const float LINE_HALF_PX = 0.8;
const float COAST_HALF_PX = 0.62;
const float HALO_PX = 1.4;
const float HALO_ALPHA = 0.32;
const vec3 HALO_RGB = vec3(0.035, 0.04, 0.055);

vec4 bsDerivs2(float t) {
  return vec4(1.0 - t, 3.0 * t - 2.0, 1.0 - 3.0 * t, t);
}

struct OverlayRidge {
  float dist;   // screen px to the nearest line centre (1e6 when none)
  float alpha;  // opacity of that line (0 when none)
  float peak;   // painted opacity around the point (soft maximum of the stencil)
  float cover;  // smoothed coverage at the point
  vec3 col;     // straight colour of the line core
  vec2 off;     // offset (overlay texels) from the point to the line centre
};

// jx, jy: overlay texel offsets per screen pixel along screen x and y.
OverlayRidge overlayRidge(sampler2D tex, vec2 size, vec2 st, vec2 jx, vec2 jy) {
  OverlayRidge r;
  r.dist = 1e6;
  r.alpha = 0.0;
  r.peak = 0.0;
  r.cover = 0.0;
  r.col = vec3(1.0);
  r.off = vec2(0.0);
  ivec2 is = ivec2(size);
  vec2 p = st * size - 0.5;
  vec2 fp = floor(p);
  vec2 f = p - fp;
  ivec2 i0 = ivec2(fp) - 1;
  vec4 bx = bsWeights(f.x), by = bsWeights(f.y);
  vec4 dbx = bsDerivs(f.x), dby = bsDerivs(f.y);
  vec4 ddx = bsDerivs2(f.x), ddy = bsDerivs2(f.y);
  float A = 0.0, hxx = 0.0, hyy = 0.0, hxy = 0.0, p3 = 0.0, p4 = 0.0;
  vec2 g = vec2(0.0);
  vec3 c4 = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    int row = clamp(i0.y + j, 0, is.y - 1);
    for (int i = 0; i < 4; i++) {
      vec4 o = texelFetch(tex, ivec2(wrapCol(i0.x + i, is.x), row), 0);
      float a = o.a;
      float w = bx[i] * by[j];
      A += w * a;
      g += vec2(dbx[i] * by[j], bx[i] * dby[j]) * a;
      hxx += ddx[i] * by[j] * a;
      hyy += bx[i] * ddy[j] * a;
      hxy += dbx[i] * dby[j] * a;
      // Σw·a³·(a·rgb) / Σw·a⁴ = α⁴-weighted straight colour.
      float a3 = w * a * a * a;
      p3 += a3;
      p4 += a3 * a;
      c4 += a3 * o.rgb;
    }
  }
  r.cover = A;
  if (p4 < 1e-8) return r;
  float peak = p4 / p3;
  r.peak = peak;
  r.col = c4 / p4;
  // Principal curvatures l1 ≤ l2 and the direction e1 of l1 (across the line).
  float hm = 0.5 * (hxx + hyy);
  float hd = sqrt(0.25 * (hxx - hyy) * (hxx - hyy) + hxy * hxy);
  float l1 = hm - hd, l2 = hm + hd;
  if (l1 >= -0.02 * peak) return r;
  vec2 va = vec2(hxy, l1 - hxx), vb = vec2(l1 - hyy, hxy);
  vec2 e1 = dot(va, va) > dot(vb, vb) ? va : vb;
  float el = length(e1);
  e1 = el > 1e-9 ? e1 / el : vec2(1.0, 0.0);
  vec2 e2 = vec2(-e1.y, e1.x);
  float g1 = dot(g, e1);
  float x1 = clamp(-g1 / l1, -3.0, 3.0);
  // Coverage at the line centre (the quadratic model's maximum).
  float ar = A + 0.5 * g1 * x1;
  // Distance to the centre line through p + x1·e1 (normal e1 in texel space).
  float dLine = abs(x1) / max(length(vec2(dot(jx, e1), dot(jy, e1))), 1e-6);
  // Peak-like points (dots, line ends, junctions): distance to the 2D maximum instead.
  float s = l2 < 0.0 ? smoothstep(0.35, 0.8, l2 / l1) : 0.0;
  float dist = dLine;
  r.off = x1 * e1;
  if (s > 0.0) {
    vec2 d = x1 * e1 + clamp(-dot(g, e2) / l2, -3.0, 3.0) * e2;
    float det = jx.x * jy.y - jy.x * jx.y;
    vec2 v = vec2(jy.y * d.x - jy.x * d.y, jx.x * d.y - jx.y * d.x) / (abs(det) > 1e-12 ? det : 1e-12);
    dist = mix(dLine, length(v), s);
    r.off = mix(r.off, d, s);
  }
  r.dist = dist;
  // A real line: clearly curved across (not the flank of a wider feature) and well covered at its
  // centre relative to the painted opacity (faint fringes alone draw nothing).
  r.alpha = peak * smoothstep(0.3, 0.45, -l1 / peak) * smoothstep(0.42, 0.55, ar / peak);
  return r;
}

// Whiteness of the line colour: the painter's coastline is pure white (transform boundaries 0.94).
float ridgeWhite(OverlayRidge r) {
  return smoothstep(0.955, 0.985, min(r.col.r, min(r.col.g, r.col.b)));
}

// Distance (height texels) from st to the sea-level contour of the bilinear height, where the painter
// traces its coastline.
float contourDist(sampler2D heightTex, vec2 hSize, vec2 st, float sea) {
  vec2 dx = vec2(1.0 / hSize.x, 0.0), dy = vec2(0.0, 1.0 / hSize.y);
  float h0 = textureLod(heightTex, st, 0.0).r - sea;
  vec4 h1 = vec4(textureLod(heightTex, st + dx, 0.0).r, textureLod(heightTex, st - dx, 0.0).r,
                 textureLod(heightTex, st + dy, 0.0).r, textureLod(heightTex, st - dy, 0.0).r) - sea;
  vec4 hn = vec4(textureLod(heightTex, st + 1.5 * dx, 0.0).r, textureLod(heightTex, st - 1.5 * dx, 0.0).r,
                 textureLod(heightTex, st + 1.5 * dy, 0.0).r, textureLod(heightTex, st - 1.5 * dy, 0.0).r) - sea;
  // The painter's own estimate |h| / |∇h| (central differences over ±1 texel: on a steep shelf break
  // its band spreads ~1.5 texels seaward)...
  float d = abs(h0) / max(0.5 * length(vec2(h1.x - h1.y, h1.z - h1.w)), 1e-3);
  // ...or the nearest sign change along the axes (robust in one-texel channels and on flat coasts,
  // where central differences cancel out or vanish).
  for (int i = 0; i < 4; i++) {
    if ((hn[i] > 0.0) != (h0 > 0.0)) d = min(d, 1.5 * abs(h0) / max(abs(h0) + abs(hn[i]), 1e-3));
  }
  return d;
}

// 0..1: the (white) ridge at this point is the raster's coastline — its centre lies on the sea-level
// contour of the raw height, or the point is next to the displayed coast (coast field value m and
// gradient gm per height texel). The painter's coastline sits within ~1 texel of both.
float ridgeOnCoast(OverlayRidge r, sampler2D heightTex, vec2 hSize, vec2 ovSize, vec2 st, float sea, float m, vec2 gm) {
  if (r.alpha <= 0.0 || ridgeWhite(r) <= 0.0) return 0.0;
  float nearCoast = 1.0 - smoothstep(0.9, 1.4, abs(m) / max(length(gm), 1e-4));
  if (nearCoast >= 1.0) return 1.0;
  float onContour = 1.0 - smoothstep(1.2, 1.8, contourDist(heightTex, hSize, st + r.off / ovSize, sea));
  return max(nearCoast, onContour);
}

// Premultiplied RGBA of the magnified overlay. coastPx: screen distance of the point to the displayed
// coast (1e6 when unknown); onCoast: 0..1, the ridge lies on the sea-level contour (it is the raster's
// coastline, redrawn on the displayed coast instead); snap: weight of the analytic coast (0 = raster
// lines only); dpr: device pixels per CSS pixel.
vec4 overlayCompose(OverlayRidge r, float coastPx, float onCoast, float snap, float dpr) {
  float coastW = snap * ridgeWhite(r);
  float lineA = r.alpha * (1.0 - coastW * onCoast);
  float coastA = coastW * r.peak * smoothstep(0.04, 0.16, r.cover);
  float hwL = LINE_HALF_PX * dpr, hwC = COAST_HALF_PX * dpr, halo = HALO_PX * dpr;
  float covL = lineA * clamp(hwL + 0.5 - r.dist, 0.0, 1.0);
  float covC = coastA * clamp(hwC + 0.5 - coastPx, 0.0, 1.0);
  float hal = HALO_ALPHA * max(lineA * (1.0 - smoothstep(hwL - 0.5, hwL + halo, r.dist)),
                               0.75 * coastA * (1.0 - smoothstep(hwC - 0.5, hwC + halo, coastPx)));
  vec4 o = vec4(r.col * covL, covL);
  o = vec4(r.col * covC, covC) + o * (1.0 - covC);
  return o + vec4(HALO_RGB * hal, hal) * (1.0 - o.a);
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
