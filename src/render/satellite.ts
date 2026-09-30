/**
 * Satellite layer (SPEC §7, the showcase): Köppen-driven surface attributes sampled through the
 * warped climate sampler, per-pixel lapse-corrected alpine belts (treeline, tundra, bare rock,
 * snow line, ice caps), depth/SST-tinted oceans with shelves, monthly sea ice and snow, optional
 * hillshade, rivers & lakes at full quality. Blending in linear light, sRGB encoding at the end.
 * Land vs sea is decided only by the height map.
 *
 * Crispness comes from MOSAICS rather than linear blends: each sub-grid cover fraction (vegetation,
 * trees, snow, sea ice) is turned into patches by thresholding a noise field against it with soft
 * but narrow edges, so a 40 % forest cell shows dark forest patches in lighter fields (area ≈ 40 %)
 * instead of a uniform 40 % tint. The noises are ordered by terrain — vegetation in dryland
 * valleys, forests on humid hills, snow first on high ground and pole-facing slopes — and anchored
 * to the plates (sea ice to the world; a faint per-pixel grain aside), so textures follow the
 * relief and never crawl.
 */
import * as _constants from '../core/constants';
import type { ClimateResult, PaintOptions, SphereMesh, WorldSnapshot } from '../core/types';
import * as _colormaps from './colormaps';
import type { PaintCache } from './paintCache';
import * as _rivers from './rivers';
import * as _paintGeometry from './paintGeometry';
import * as _satelliteBiome from './satelliteBiome';
import * as _satelliteCoast from './satelliteCoast';
import type { SatelliteGrid } from './satelliteBiome';
import * as _satelliteNeutral from './satelliteNeutral';
import * as _satellitePixels from './satellitePixels';
import * as _satellitePalette from './satellitePalette';
import * as _satelliteSampler from './satelliteSampler';
import * as _satelliteWater from './satelliteWater';
import * as _terrain from './terrain';
import * as _terrainShade from './terrainShade';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { LAPSE_RATE } = _constants;
const { encodeSrgb } = _colormaps;
const { drainageLines, drawRiversAndLakes } = _rivers;
const {
  A_COVER, A_DESERT, A_EVER, A_GRASS, A_HIDED, A_HOT, A_SNOWSUP, A_SOIL, A_TREE, A_TREES, A_TSNOW, A_TWARM, A_WET,
  A_PANN, A_SHEET, A_WINDE, A_WINDN, EVERGREEN_SNOW_HIDE, LAND_K, O_ICE, O_SST, OCEAN_K, buildSatelliteGrid, satelliteClimateOf,
} = _satelliteBiome;
const { neutralSatelliteGrid } = _satelliteNeutral;
const {
  COLD_DESERT, DEPTH_INDEX, DEPTH_LUT_STEP, FIRN, HOT_DESERT, ICE_BARE, ICE_CREVASSE, LAGOON_COLD, LAGOON_WARM, MOTTLE_C,
  OCEAN_COLD, OCEAN_SRGB, OCEAN_WARM, OCEAN_WARM_N, ROCK_DRY, ROCK_WET, SEA_ICE, SEA_ICE_THIN, SNOW, SNOW_SHADE,
  TUNDRA_DRY, TUNDRA_WET,
} = _satellitePalette;
const { getClimateSampler } = _satelliteSampler;
const {
  PX_COVER, PX_DESERT, PX_GRASS, PX_HOT, PX_ICE, PX_K, PX_OK_LAND, PX_OK_OCEAN, PX_SHEET, PX_SNOWSUP, PX_SOIL, PX_SST, PX_T,
  PX_T0, PX_TREE, PX_TREES, PX_TSNOW, PX_TWARM, PX_U, PX_WET, fillLand, fillOcean, pixelAttributes,
} = _satellitePixels;
const NO_PIXELS = new Uint8Array(0);
const { antialiasCoast } = _satelliteCoast;
const { rasterGeometry } = _paintGeometry;
/** Frozen, snow-covered lagoon / hollow. */
const LAKE_FROZEN = _colormaps.toLinear([214, 224, 234]);
const { enclosedWater } = _satelliteWater;
const { HF_NOISE_SCALE, detailTexture, getHeightField, heightFieldKey, qualityOf } = _terrain;
const { RELIEF_SHADE_SCALE, gradientScales, reliefShadeField } = _terrainShade;

/** Mosaic noise → pseudo-uniform (0,1): U(x) = ½ + ½·z/(1 + |z|), z = MOSAIC_K·x. */
const MOSAIC_K = 3.2;
/** Mosaic edge widths (in U units): vegetation / forest, snow, sea-ice floes. */
const W_VEG = 0.3;
const W_SNOW = 0.2;
const W_ICE = 0.16;
/** Relief position (hills and crests +, valleys −): ridge detail (m) worth one unit. */
const REL_RIDGE_M = 500;
/** Pole-facing slope gain (per m/m of north–south gradient). */
const ASPECT_K = 7;
/** Relief-coupled albedo: dryland valleys (alluvium) brighter, crests darker; humid valleys darker. */
const REL_DRY = 0.13;
const REL_WET = 0.07;
/** How far the vegetation / forest fractions become patches (0 = linear mix, 1 = full mosaic). */
const MOS_VEG = 0.3;
const MOS_TREE = 0.9;
/** Forest mosaic edge width (U units): crisp forest edges (they carry the winter look). */
const W_TREE = 0.12;
/** Weight of the fine grain in the forest mosaic: small crisp openings (bogs, lakes, clearings). */
const SPECK = 1;
/** Downslope gully / spur texture: derivative gain, weight in the forest mosaic, slope of full effect. */
const GULLY_K = 2;
const GULLY_W = 1.2;
const GULLY_SLOPE = 0.08;
/** Fine texture amplitudes: forest canopy, grass, bare ground. */
const CANOPY_TEX = 0.16;
const HERB_TEX = 0.07;
const GROUND_TEX = 0.05;
/**
 * Drainage-line field (HeightField.pdrain, 0..255) → valley lines: 0 below DRAIN_LO, 1 above
 * DRAIN_HI (smoothstep).
 */
const DRAIN_LO = 50;
const DRAIN_HI = 170;
/** Mean of the valley-ness field (centres the microclimate / mosaic terms). */
const VLY_MEAN = 0.12;
/** Thermal microclimate (× MOTTLE_C °C): plate-frame noise and valley shelter. */
const MOT_NOISE = 0.3;
const MOT_VALLEY = 0.8;
/** How much warmer (°C of warmest month) valley / outlet glaciers reach than the ice-sheet limit. */
const ICE_VALLEY_C = 4.5;
/** How much warmer (°C) ice-sheet margins reach where the neighbourhood is glaciated. */
const ICE_FLOW_C = 4;
/** Warmest-month temperature (°C) above which no ice can form whatever the valley / sheet terms. */
const ICE_TW_MAX = 2 + ICE_VALLEY_C + ICE_FLOW_C + 1.5;
/** Ice-margin mosaic edge width (U units). */
const W_ICE_L = 0.22;
/** Slope (normalised) above which rock faces pierce the ice (nunataks). */
const NUNATAK_SLOPE = 0.34;
/** Open snowfields: shrub lines along the drainage and wind-scoured crests (fraction of snow hidden). */
const SHRUB_SNOW = 0.3;
const SCOUR_SNOW = 0.14;
/** Ice-flow stripes: gain of the cross-flow derivative. */
const STRIPE_K = 1.4;
/** Deserts: erg threshold / edge width on the lithology, dune grain gain and amplitude, gravel speckle. */
const ERG_T = 0.05;
const ERG_W = 0.12;
const DUNE_K = 3;
const DUNE_AMP = 0.15;
/** Hamada (dark rocky plateau) threshold on relief + lithology. */
const HAMADA_T = 0.42;
const REG_SPECKLE = 0.07;
/** Fine multiplicative grain of the land surface (world-frame texture, and per-pixel hash). */
const GRAIN = 0.035;
const PIXEL_GRAIN = 0.03;
/** Depth (m) under which ice-covered shallows count as land-fast ice. */
const FAST_ICE_DEPTH = 60;

function smooth(a: number, b: number, x: number): number {
  return ss((x - a) / (b - a));
}

/** Smoothstep of an already-normalized argument (hot loops pass (x − a)·(1/(b − a)) constants). */
function ss(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/**
 * Glacier nourishment 0..1 from annual precipitation (m/yr), the pixel's warmest-month temperature
 * (summers below freezing: no melt, so even a trickle of snowfall builds ice) and the ice-sheet
 * context (flow-fed margins are nourished by the ice upstream rather than by local snowfall).
 */
function iceNourishment(pAnn: number, tw: number, sheet: number): number {
  let nour = (pAnn - 0.02) * (1 / 0.45);
  nour = nour < 0 ? 0 : nour > 1 ? 1 : nour * nour * (3 - 2 * nour);
  let cold = (1 - tw) * (1 / 3.5);
  cold = cold < 0 ? 0 : cold > 1 ? 1 : cold * cold * (3 - 2 * cold);
  let fed = sheet * 3;
  fed = fed > 1 ? 1 : fed * fed * (3 - 2 * fed);
  if (fed > cold) cold = fed;
  return nour > cold ? nour : cold;
}

function satelliteGrid(climate: ClimateResult | null, month: number, cache: PaintCache): SatelliteGrid {
  if (!climate) return neutralSatelliteGrid(month, cache);
  return cache.getOrBuild(`satgrid|${climate.id}|${month}`, () => buildSatelliteGrid(satelliteClimateOf(climate), month));
}

export function normalizeMonth(month: number): number {
  if (!Number.isFinite(month)) throw new Error(`paint: month must be finite (got ${month})`);
  const m = Math.round(month);
  if (m < 0) return -1;
  return m % 12;
}

/** Paint the satellite layer. Returns a fresh opaque RGBA buffer. */
export function paintSatellite(
  mesh: SphereMesh, snapshot: WorldSnapshot | null, climate: ClimateResult | null, opts: PaintOptions, cache: PaintCache,
): Uint8ClampedArray {
  const w = opts.width, h = opts.height;
  const hf = getHeightField(mesh, snapshot, opts, cache);
  const month = normalizeMonth(opts.month);
  const grid = satelliteGrid(climate, month, cache);
  const tex = detailTexture(opts.seed, w, cache);
  const smp = getClimateSampler(w, h, grid.cw, grid.ch, opts.seed, tex, cache);
  const gs = gradientScales(w, h, cache);
  const rgba = new Uint8ClampedArray(4 * w * h);
  const { height, patch, lith, rough, pfine, pdrain, pgrain } = hf;
  const { idx, wr, wc, tex: wtex, fine: wfine } = smp;
  // Preview (playback: a new snapshot every frame, the same climate for many): the climate
  // attributes per pixel are cached (static per climate / month / raster), filled lazily the first
  // time each pixel is painted as land / sea.
  const pxA = qualityOf(opts) === 'full' ? null : pixelAttributes(smp, climate ? `${climate.id}|${month}` : `neutral|${month}`, opts.seed, cache);
  const px = pxA !== null ? pxA.rec : null;
  const pxOk = pxA !== null ? pxA.ok : NO_PIXELS;
  const LG = grid.land, OG = grid.ocean;
  const lStride = smp.stride * LAND_K, oStride = smp.stride * OCEAN_K;
  const sea = opts.seaLevel;
  // Baked relief shading only on request (the globe shades with GPU normals instead).
  const shadeF = opts.hillshade ? reliefShadeField(height, w, h, sea, heightFieldKey(mesh, snapshot, opts), cache) : null;
  const slopeNorm = gs.slopeNorm;
  const full = qualityOf(opts) === 'full';
  const withRivers = full && opts.rivers !== false && snapshot !== null;
  const enclosed = full && snapshot !== null ? enclosedWater(hf, sea, heightFieldKey(mesh, snapshot, opts), cache) : null;
  // Per-pixel surface state for rivers/lakes (frozen lakes, riparian strips in drylands).
  // Full quality: the dendritic valley network of the actual terrain (drainage routing) structures
  // vegetation and snow; the preview uses the plate-frame drainage-line texture alone.
  const lines = withRivers ? drainageLines(heightFieldKey(mesh, snapshot, opts), hf, climate, opts, cache) : null;
  const surf = withRivers ? { snow: new Uint8Array(w * h), desert: new Uint8Array(w * h), trees: new Uint8Array(w * h), ice: new Uint8Array(w * h) } : null;
  const iW_VEG = 1 / W_VEG, iW_SNOW = 1 / W_SNOW, iW_ICE = 1 / W_ICE;
  const grainSeed = Math.imul(Math.floor(opts.seed) | 0, 0x9e3779b1) ^ w;
  const cosLat = rasterGeometry(w, h, cache).cosLat;
  for (let r = 0; r < h; r++) {
    const invDx = gs.invDx[r], invDy = gs.invDy;
    // East-west pixel differences → metric (pixels shrink with cos(lat)).
    const invCos = 1 / (cosLat[r] > 0.2 ? cosLat[r] : 0.2);
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    // Pole-facing slopes: north-facing (height falling northward) in the north, south-facing south.
    const aspSign = r < h / 2 ? -ASPECT_K : ASPECT_K;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const H = height[p];
      const i00 = idx[p];
      const fr = wr[p] * (1 / 65535), fc = wc[p] * (1 / 65535);
      const w00 = (1 - fr) * (1 - fc), w01 = (1 - fr) * fc, w10 = fr * (1 - fc), w11 = fr * fc;
      let R: number, G: number, B: number;
      if (H > sea) {
        // ---- land --------------------------------------------------------------------------
        // Bilinear climate attributes, unrolled into locals (register-friendly hot loop).
        const q00 = i00 * LAND_K, q01 = q00 + LAND_K, q10 = q00 + lStride, q11 = q10 + LAND_K;
        let soilR = 0, soilG = 0, soilB = 0, grassR = 0, grassG = 0, grassB = 0, treeR = 0, treeG = 0, treeB = 0;
        let aCover = 0, aTrees = 0, aTwarm = 0, aTsnow = 0, aSnowSup = 0, des = 0, hot = 0, wet = 0, sheet = 0;
        if (px !== null) {
          const b = p * PX_K;
          if ((pxOk[p] & PX_OK_LAND) === 0) {
            fillLand(px, b, LG, q00, lStride, w00, w01, w10, w11);
            pxOk[p] |= PX_OK_LAND;
          }
          soilR = px[b + PX_SOIL] * PX_U; soilG = px[b + PX_SOIL + 1] * PX_U; soilB = px[b + PX_SOIL + 2] * PX_U;
          grassR = px[b + PX_GRASS] * PX_U; grassG = px[b + PX_GRASS + 1] * PX_U; grassB = px[b + PX_GRASS + 2] * PX_U;
          treeR = px[b + PX_TREE] * PX_U; treeG = px[b + PX_TREE + 1] * PX_U; treeB = px[b + PX_TREE + 2] * PX_U;
          aCover = px[b + PX_COVER] * PX_U; aTrees = px[b + PX_TREES] * PX_U;
          aTwarm = px[b + PX_TWARM] * PX_T + PX_T0; aTsnow = px[b + PX_TSNOW] * PX_T + PX_T0;
          aSnowSup = px[b + PX_SNOWSUP] * PX_U; des = px[b + PX_DESERT] * PX_U; hot = px[b + PX_HOT] * PX_U;
          wet = px[b + PX_WET] * PX_U; sheet = px[b + PX_SHEET] * PX_U;
        } else {
          soilR = w00 * LG[q00 + A_SOIL] + w01 * LG[q01 + A_SOIL] + w10 * LG[q10 + A_SOIL] + w11 * LG[q11 + A_SOIL];
          soilG = w00 * LG[q00 + A_SOIL + 1] + w01 * LG[q01 + A_SOIL + 1] + w10 * LG[q10 + A_SOIL + 1] + w11 * LG[q11 + A_SOIL + 1];
          soilB = w00 * LG[q00 + A_SOIL + 2] + w01 * LG[q01 + A_SOIL + 2] + w10 * LG[q10 + A_SOIL + 2] + w11 * LG[q11 + A_SOIL + 2];
          grassR = w00 * LG[q00 + A_GRASS] + w01 * LG[q01 + A_GRASS] + w10 * LG[q10 + A_GRASS] + w11 * LG[q11 + A_GRASS];
          grassG = w00 * LG[q00 + A_GRASS + 1] + w01 * LG[q01 + A_GRASS + 1] + w10 * LG[q10 + A_GRASS + 1] + w11 * LG[q11 + A_GRASS + 1];
          grassB = w00 * LG[q00 + A_GRASS + 2] + w01 * LG[q01 + A_GRASS + 2] + w10 * LG[q10 + A_GRASS + 2] + w11 * LG[q11 + A_GRASS + 2];
          treeR = w00 * LG[q00 + A_TREE] + w01 * LG[q01 + A_TREE] + w10 * LG[q10 + A_TREE] + w11 * LG[q11 + A_TREE];
          treeG = w00 * LG[q00 + A_TREE + 1] + w01 * LG[q01 + A_TREE + 1] + w10 * LG[q10 + A_TREE + 1] + w11 * LG[q11 + A_TREE + 1];
          treeB = w00 * LG[q00 + A_TREE + 2] + w01 * LG[q01 + A_TREE + 2] + w10 * LG[q10 + A_TREE + 2] + w11 * LG[q11 + A_TREE + 2];
          aCover = w00 * LG[q00 + A_COVER] + w01 * LG[q01 + A_COVER] + w10 * LG[q10 + A_COVER] + w11 * LG[q11 + A_COVER];
          aTrees = w00 * LG[q00 + A_TREES] + w01 * LG[q01 + A_TREES] + w10 * LG[q10 + A_TREES] + w11 * LG[q11 + A_TREES];
          aTwarm = w00 * LG[q00 + A_TWARM] + w01 * LG[q01 + A_TWARM] + w10 * LG[q10 + A_TWARM] + w11 * LG[q11 + A_TWARM];
          aTsnow = w00 * LG[q00 + A_TSNOW] + w01 * LG[q01 + A_TSNOW] + w10 * LG[q10 + A_TSNOW] + w11 * LG[q11 + A_TSNOW];
          aSnowSup = w00 * LG[q00 + A_SNOWSUP] + w01 * LG[q01 + A_SNOWSUP] + w10 * LG[q10 + A_SNOWSUP] + w11 * LG[q11 + A_SNOWSUP];
          des = w00 * LG[q00 + A_DESERT] + w01 * LG[q01 + A_DESERT] + w10 * LG[q10 + A_DESERT] + w11 * LG[q11 + A_DESERT];
          hot = w00 * LG[q00 + A_HOT] + w01 * LG[q01 + A_HOT] + w10 * LG[q10 + A_HOT] + w11 * LG[q11 + A_HOT];
          wet = w00 * LG[q00 + A_WET] + w01 * LG[q01 + A_WET] + w10 * LG[q10 + A_WET] + w11 * LG[q11 + A_WET];
          sheet = w00 * LG[q00 + A_SHEET] + w01 * LG[q01 + A_SHEET] + w10 * LG[q10 + A_SHEET] + w11 * LG[q11 + A_SHEET];
        }
        const hp = H - sea;
        const tw = aTwarm - LAPSE_RATE * hp;
        const ts = aTsnow - LAPSE_RATE * hp;
        const pE = row + (c + 1 < w ? c + 1 : 0), pW = row + (c > 0 ? c - 1 : w - 1), pN = rowN + c, pS = rowS + c;
        const gx = (height[pE] - height[pW]) * invDx;
        const gy = (height[pN] - height[pS]) * invDy;
        const slope = Math.sqrt(gx * gx + gy * gy) * slopeNorm;
        const pn = patch[p] * HF_NOISE_SCALE;
        // Texture noises anchored to the plates (world-frame ones would stay put while the land
        // moves under them: crawling mosaics during playback): fine texture, fine grain, and the
        // drainage-line network below the mesh scale.
        const lf = pfine[p] * (1 / 127), lt = 0.91 * lf;
        const gr = pgrain[p] * (1 / 127);
        let dl = (pdrain[p] - DRAIN_LO) * (1 / (DRAIN_HI - DRAIN_LO));
        dl = dl < 0 ? 0 : dl > 1 ? 1 : dl * dl * (3 - 2 * dl);
        if (lines !== null) {
          const ch = lines[p] * (1 / 255);
          dl = ch > 0.5 * dl ? ch : 0.5 * dl;
        }
        // Relief position: + hills and crests, − valleys.
        let rel = 1.6 * pn + rough[p] * (1 / REL_RIDGE_M);
        rel = rel < -1.5 ? -1.5 : rel > 1.5 ? 1.5 : rel;
        // Valley-ness: valley floors of the relief detail, and the drainage lines.
        let vb = -rel * (1 / 1.2);
        vb = vb < 0 ? 0 : vb > 1 ? 1 : vb * vb * (3 - 2 * vb);
        const vly = 1 - (1 - dl) * (1 - 0.6 * vb);
        const vc = vly - VLY_MEAN;
        const relC = rel < -1 ? -1 : rel > 1 ? 1 : rel;
        // Gradient of the fine plate-frame noises (px units), computed on demand: directional
        // derivatives of it give oriented textures — gullies and spurs running downhill, dune grain
        // across the wind, ice-flow stripes.
        let dfx = 0, dfy = 0, dfOk = false;
        // Microclimate: sheltered valleys and drainage lines are warmer in summer, exposed
        // interfluves cooler; a little plate-frame noise keeps the thermal belts organic. The
        // treeline therefore advances along the valleys (forest-tundra) instead of in blobs.
        const twm = tw + MOTTLE_C * (MOT_NOISE * pn + MOT_VALLEY * vc);
        // Temperature-limited vegetation: continuous re-classification by the pixel's own warmest
        // month (treeline ≈ 10 °C, vegetation limit ≈ 0 °C).
        let vegT = (twm + 1) * (1 / 7);
        vegT = vegT < 0 ? 0 : vegT > 1 ? 1 : vegT * vegT * (3 - 2 * vegT);
        let treeT = (twm - 9) * (1 / 2.5);
        treeT = treeT < 0 ? 0 : treeT > 1 ? 1 : treeT * treeT * (3 - 2 * treeT);
        // Bare rock: steep slopes, crests of mountain ridges, and above the vegetation limit.
        let crest = (rough[p] - 120) * (1 / 780);
        crest = crest < 0 ? 0 : crest > 1 ? 1 : crest * crest * (3 - 2 * crest);
        let rock = (slope - 0.12) * (1 / 0.2);
        rock = rock < 0 ? 0 : rock > 1 ? 1 : rock * rock * (3 - 2 * rock);
        rock += 0.75 * crest * (1 - treeT) + 0.6 * (1 - vegT);
        rock = rock > 1 ? 1 : rock;
        // Cover fractions → mosaics.
        const cover = aCover * vegT * (1 - 0.75 * rock);
        let trees = aTrees * treeT;
        if (trees > cover) trees = cover;
        let humid = (wet - 0.4) * (1 / 0.3);
        humid = humid < 0 ? 0 : humid > 1 ? 1 : humid * humid * (3 - 2 * humid);
        // Grass vs bare ground mixes at the sub-pixel scale (only mildly patchy); in drylands the
        // vegetation follows the drainage lines.
        let z: number;
        let mC = cover;
        if (cover > 1e-3 && cover < 0.999) {
          z = MOSAIC_K * (0.8 * pn + 0.5 * lt + 0.35 * lf - 0.9 * (1 - humid) * vc);
          const uV = 0.5 + 0.5 * z / (1 + (z < 0 ? -z : z));
          let mC0 = (cover * (1 + W_VEG) - uV) * iW_VEG;
          mC0 = mC0 < 0 ? 0 : mC0 > 1 ? 1 : mC0 * mC0 * (3 - 2 * mC0);
          mC = cover + (mC0 - cover) * MOS_VEG;
        } else if (cover >= 0.999) mC = 1;
        // Forests: along valleys and drainage lines first where trees are marginal (cold or dry:
        // gallery forests, forest-tundra), on the drained hills in humid lowlands; gullies and
        // spurs on slopes; fine grain makes crisp, irregular edges (bogs, lakes, clearings).
        let mT = 0, gully = 0;
        if (trees > 1e-4) {
          if (slope > 0.2 * GULLY_SLOPE) {
            // Downslope gully / spur pattern (derivative across the local slope: stripes run downhill).
            dfx = (pfine[pE] - pfine[pW]) + 0.8 * (pgrain[pE] - pgrain[pW]);
            dfy = (pfine[pN] - pfine[pS]) + 0.8 * (pgrain[pN] - pgrain[pS]);
            dfOk = true;
            gully = (-gy * dfx * invCos + gx * dfy) * (GULLY_K / 127) / Math.sqrt(gx * gx + gy * gy);
            gully = gully / (1 + (gully < 0 ? -gully : gully));
            const sw = slope * (1 / GULLY_SLOPE);
            if (sw < 1) gully *= sw;
          }
          // Rank score (unit variance) to a near-uniform U through tanh(0.8 s) ~ Phi(s): the
          // forested area then matches the tree fraction.
          // Crisp openings (bogs, lakes) mostly in cool humid forests; savannas cluster by terrain.
          z = ((0.6 - 1.1 * humid) * relC + 0.25 * lt + SPECK * (0.35 + 0.65 * humid * (1 - hot)) * gr - 2 * vc + GULLY_W * gully) * (0.8 / 0.42);
          z = z > 3 ? 3 : z < -3 ? -3 : z;
          const uT = 0.5 + 0.5 * (z * (27 + z * z)) / (27 + 9 * z * z);
          const tRel = trees / cover;
          let mT0 = (tRel * (1 + W_TREE) - uT) * (1 / W_TREE);
          mT0 = mT0 < 0 ? 0 : mT0 > 1 ? 1 : mT0 * mT0 * (3 - 2 * mT0);
          mT = (tRel + (mT0 - tRel) * MOS_TREE) * mC;
        }
        // Ground: humid soils ↔ desert surfaces, then rock.
        let gR = soilR, gG = soilG, gB = soilB;
        if (des > 0.003) {
          // Deserts: sand seas (ergs) collect in basins and lowlands with crisp edges; elsewhere
          // gravel plains (reg) and dark rocky plateaus / volcanic fields (hamada) on high ground.
          const lk = lith[p] * HF_NOISE_SCALE;
          let erg = (lk + 0.3 * pn - 0.35 * relC + 0.08 * lf - ERG_T) * (1 / ERG_W);
          erg = erg < 0 ? 0 : erg > 1 ? 1 : erg * erg * (3 - 2 * erg);
          let ls = 0.12 + 0.6 * lk + 0.2 * pn;
          ls = ls < -0.2 ? -0.2 : ls > 1 ? 1 : ls;
          // Rocky ground: tan gravel plains (reg) with crisp dark rocky plateaus / volcanic fields
          // (hamada) on the high, rugged ground.
          let ham = (0.8 * relC + 0.5 * lk + 0.12 * gr - HAMADA_T) * (1 / 0.1);
          ham = ham < 0 ? 0 : ham > 1 ? 1 : ham * ham * (3 - 2 * ham);
          let lr = -0.12 + 0.25 * lk + 0.08 * lf - (0.55 + 0.2 * lk) * ham;
          lr = lr < -0.95 ? -0.95 : lr > 0.12 ? 0.12 : lr;
          const is3 = 3 * (((ls + 1) * 31.5 + 0.5) | 0), ir3 = 3 * (((lr + 1) * 31.5 + 0.5) | 0);
          // Fine texture: dune grain across the prevailing wind in the ergs (directional derivative
          // of the plate-frame fine noises: crests transverse to the wind), gravel speckle elsewhere.
          let sf = 1;
          if (erg > 0.02) {
            if (!dfOk) {
              dfx = (pfine[pE] - pfine[pW]) + 0.8 * (pgrain[pE] - pgrain[pW]);
              dfy = (pfine[pN] - pfine[pS]) + 0.8 * (pgrain[pN] - pgrain[pS]);
              dfOk = true;
            }
            const wE = w00 * LG[q00 + A_WINDE] + w01 * LG[q01 + A_WINDE] + w10 * LG[q10 + A_WINDE] + w11 * LG[q11 + A_WINDE];
            const wN = w00 * LG[q00 + A_WINDN] + w01 * LG[q01 + A_WINDN] + w10 * LG[q10 + A_WINDN] + w11 * LG[q11 + A_WINDN];
            let dune = (wE * dfx * invCos + wN * dfy) * (DUNE_K / 127);
            dune = dune / (1 + (dune < 0 ? -dune : dune));
            sf = 1 + DUNE_AMP * dune;
          }
          const rf = 1 + REG_SPECKLE * gr + 0.5 * REG_SPECKLE * lf;
          const sR = ((HOT_DESERT[is3] - COLD_DESERT[is3]) * hot + COLD_DESERT[is3]) * sf;
          const sG = ((HOT_DESERT[is3 + 1] - COLD_DESERT[is3 + 1]) * hot + COLD_DESERT[is3 + 1]) * sf;
          const sB = ((HOT_DESERT[is3 + 2] - COLD_DESERT[is3 + 2]) * hot + COLD_DESERT[is3 + 2]) * sf;
          const kR = ((HOT_DESERT[ir3] - COLD_DESERT[ir3]) * hot + COLD_DESERT[ir3]) * rf;
          const kG = ((HOT_DESERT[ir3 + 1] - COLD_DESERT[ir3 + 1]) * hot + COLD_DESERT[ir3 + 1]) * rf;
          const kB = ((HOT_DESERT[ir3 + 2] - COLD_DESERT[ir3 + 2]) * hot + COLD_DESERT[ir3 + 2]) * rf;
          gR += (kR + (sR - kR) * erg - gR) * des;
          gG += (kG + (sG - kG) * erg - gG) * des;
          gB += (kB + (sB - kB) * erg - gB) * des;
        }
        const rR = ROCK_DRY[0] + (ROCK_WET[0] - ROCK_DRY[0]) * wet;
        const rG = ROCK_DRY[1] + (ROCK_WET[1] - ROCK_DRY[1]) * wet;
        const rB = ROCK_DRY[2] + (ROCK_WET[2] - ROCK_DRY[2]) * wet;
        gR += (rR - gR) * rock;
        gG += (rG - gG) * rock;
        gB += (rB - gB) * rock;
        // Relief-coupled bare-ground albedo: bright alluvial valleys, dark eroded crests in drylands.
        const gf = 1 - (REL_DRY * des - REL_WET * (1 - des)) * rel;
        // Vegetation: herbaceous (→ tundra above the treeline) and canopy.
        let tun = (twm - 7) * (1 / 4);
        tun = tun < 0 ? 0 : tun > 1 ? 1 : tun * tun * (3 - 2 * tun);
        tun = 1 - tun;
        const tR = TUNDRA_DRY[0] + (TUNDRA_WET[0] - TUNDRA_DRY[0]) * wet;
        const tG = TUNDRA_DRY[1] + (TUNDRA_WET[1] - TUNDRA_DRY[1]) * wet;
        const tB = TUNDRA_DRY[2] + (TUNDRA_WET[2] - TUNDRA_DRY[2]) * wet;
        const hR = grassR + (tR - grassR) * tun;
        const hG = grassG + (tG - grassG) * tun;
        const hB = grassB + (tB - grassB) * tun;
        // Fine texture: canopy (crowns, gaps, shaded valleys) varies most, grass less.
        const tx = 0.8 * pn + 0.45 * lf + 0.45 * gr;
        const vf = 1 + REL_WET * rel;
        const cf = vf * (1 + CANOPY_TEX * tx), hf = vf * (1 + HERB_TEX * tx);
        const mH = (mC - mT) * hf, mTc = mT * cf, mG = (1 - mC) * gf * (1 + GROUND_TEX * tx);
        R = gR * mG + hR * mH + treeR * mTc;
        G = gG * mG + hG * mH + treeG * mTc;
        B = gB * mG + hB * mH + treeB * mTc;
        // Pole-facing (shaded) slopes: + ; sun-facing: −.
        let asp = aspSign * gy;
        asp = asp < -1 ? -1 : asp > 1 ? 1 : asp;
        // Seasonal snow (lapse-corrected, climate supply), a mosaic ordered by relief and aspect
        // (high ground and pole-facing slopes first) with crisp edges.
        let sT = (1 - ts - 0.25 * MOTTLE_C * pn) * (1 / 5);
        let snow = 0;
        if (sT > 0) {
          sT = sT > 1 ? aSnowSup : sT * sT * (3 - 2 * sT) * aSnowSup;
          // (Valleys and drainage lines melt out first: the snowline follows the terrain.)
          z = MOSAIC_K * (-0.7 * rel - 0.55 * asp + 0.7 * vc + 0.22 * lt + 0.15 * gr);
          const uS = 0.5 + 0.5 * z / (1 + (z < 0 ? -z : z));
          snow = (sT * (1 + W_SNOW) - uS) * iW_SNOW;
          snow = snow < 0 ? 0 : snow > 1 ? 1 : snow * snow * (3 - 2 * snow);
          // Steep rock walls shed snow.
          let shed = (slope - 0.28) * (1 / 0.3);
          shed = shed < 0 ? 0 : shed > 1 ? 1 : shed * shed * (3 - 2 * shed);
          snow *= 1 - 0.6 * shed;
        }
        // Glaciers and ice sheets: summers below ≈ +2 °C at the pixel, nourished by precipitation
        // near that limit and by cold alone well below; outlet and valley glaciers descend the
        // valleys and drainage lines into ground several degrees warmer.
        let iceCov = 0;
        let ice = 0;
        if (tw < ICE_TW_MAX) {
          // Ice sheets also flow down into warmer margins (to the coast where the neighbourhood is
          // glaciated: Antarctica, inland Greenland).
          // Valley glaciers need steep mountain valleys to descend (not plateau drainage lines).
          let steep = slope * (1 / 0.2);
          steep = steep > 1 ? 1 : steep;
          ice = (2 + ICE_VALLEY_C * vly * steep + ICE_FLOW_C * sheet - tw + 1.5 * lt) * (1 / 3);
          ice = ice < 0 ? 0 : ice > 1 ? 1 : ice * ice * (3 - 2 * ice);
          if (ice > 0) ice *= iceNourishment(w00 * LG[q00 + A_PANN] + w01 * LG[q01 + A_PANN] + w10 * LG[q10 + A_PANN] + w11 * LG[q11 + A_PANN] + 0.08 * lt, tw, sheet);
        }
        if (ice > 0) {
          // Crisp margins: ice survives longest in valleys and on shaded slopes.
          z = MOSAIC_K * (0.45 * rel - 0.9 * vc - 0.35 * asp + 0.2 * lt + 0.12 * gr);
          const uI = 0.5 + 0.5 * z / (1 + (z < 0 ? -z : z));
          iceCov = (ice * (1 + W_ICE_L) - uI) * (1 / W_ICE_L);
          iceCov = iceCov < 0 ? 0 : iceCov > 1 ? 1 : iceCov * iceCov * (3 - 2 * iceCov);
          // Nunataks: only the steepest rock faces and crests poke through.
          let nun = (slope - NUNATAK_SLOPE) * (1 / 0.3) + 0.5 * crest - 0.25;
          nun = nun < 0 ? 0 : nun > 1 ? 1 : nun * nun * (3 - 2 * nun);
          iceCov *= 1 - 0.9 * nun;
        }
        let snowVis = 0;
        if (snow > 0) {
          // Forest canopies hide most of the ground snow (dark winter taiga) — bare deciduous
          // crowns much less (light-grey larch taiga); canopy gaps give it a fine grain.
          let vis = snow;
          if (mT > 0) {
            // Evergreen vs deciduous stands form a crisp mosaic too (dark spruce / fir in the
            // valleys, larch on the uplands), rather than a blur of the class blend.
            const ever = w00 * LG[q00 + A_EVER] + w01 * LG[q01 + A_EVER] + w10 * LG[q10 + A_EVER] + w11 * LG[q11 + A_EVER];
            const hideD = w00 * LG[q00 + A_HIDED] + w01 * LG[q01 + A_HIDED] + w10 * LG[q10 + A_HIDED] + w11 * LG[q11 + A_HIDED];
            z = (0.35 * pn + 0.3 * lf - 2.2 * vc) * (0.8 / 0.38);
            z = z > 3 ? 3 : z < -3 ? -3 : z;
            const uE = 0.5 + 0.5 * (z * (27 + z * z)) / (27 + 9 * z * z);
            let mE = (ever * (1 + W_TREE) - uE) * (1 / W_TREE);
            mE = mE < 0 ? 0 : mE > 1 ? 1 : mE * mE * (3 - 2 * mE);
            let hide = (hideD + (EVERGREEN_SNOW_HIDE - hideD) * mE) * (1 - 0.06 * gr - 0.04 * lf - 0.08 * relC + 0.1 * gully);
            hide = hide > 0.97 ? 0.97 : hide < 0 ? 0 : hide;
            vis *= 1 - hide * mT;
          }
          // Open snowfields: tall shrubs along the drainage lines and wind-scoured crests show
          // through a little (structure that follows the terrain, not noise).
          let shrub = (tw - 4) * (1 / 5);
          shrub = shrub < 0 ? 0 : shrub > 1 ? 1 : shrub * shrub * (3 - 2 * shrub);
          let scour = (rel - 0.35) * (1 / 0.9);
          scour = scour < 0 ? 0 : scour > 1 ? 1 : scour * scour * (3 - 2 * scour);
          vis *= 1 - (1 - mT) * (SHRUB_SNOW * shrub * dl + SCOUR_SNOW * scour);
          // Shaded snow (valleys, pole-facing) is slightly bluer.
          let sh = -0.6 * rel + 0.3 * asp;
          sh = sh < 0 ? 0 : sh > 1 ? 1 : sh * sh * (3 - 2 * sh);
          const sb = 1 + 0.02 * lf;
          const nR = (SNOW[0] + (SNOW_SHADE[0] - SNOW[0]) * sh) * sb;
          const nG = (SNOW[1] + (SNOW_SHADE[1] - SNOW[1]) * sh) * sb;
          const nB = (SNOW[2] + (SNOW_SHADE[2] - SNOW[2]) * sh) * sb;
          R += (nR - R) * vis;
          G += (nG - G) * vis;
          B += (nB - B) * vis;
          snowVis = vis;
        }
        if (iceCov > 0) {
          // Ice surface: bright firn in the accumulation zone (and wherever seasonal snow lies),
          // bare blue-grey glacier ice with darker crevassed margins in the ablation zone, and faint
          // flow stripes parallel to the large-scale surface slope.
          let acc = (-1 - tw) * (1 / 6);
          acc = acc < 0 ? 0 : acc > 1 ? 1 : acc * acc * (3 - 2 * acc);
          if (snow > acc) acc = snow;
          const c3e = c + 3 < w ? c + 3 : c + 3 - w, c3w = c >= 3 ? c - 3 : c - 3 + w;
          const r3n = (r >= 3 ? r - 3 : 0) * w, r3s = (r + 3 < h ? r + 3 : h - 1) * w;
          const fx = (height[row + c3e] - height[row + c3w]) * invCos, fy = height[r3n + c] - height[r3s + c];
          const fl = fx * fx + fy * fy;
          let stripe = 0;
          if (fl > 1) {
            const il = 1 / Math.sqrt(fl);
            if (!dfOk) {
              dfx = (pfine[pE] - pfine[pW]) + 0.8 * (pgrain[pE] - pgrain[pW]);
              dfy = (pfine[pN] - pfine[pS]) + 0.8 * (pgrain[pN] - pgrain[pS]);
              dfOk = true;
            }
            // Derivative across the flow: stripes along it.
            stripe = (-fy * dfx * invCos + fx * dfy) * il * (STRIPE_K / 127);
            stripe = stripe / (1 + (stripe < 0 ? -stripe : stripe));
          }
          let crev = (slope - 0.08) * (1 / 0.25);
          crev = crev < 0 ? 0 : crev > 1 ? 1 : crev * crev * (3 - 2 * crev);
          crev = (1 - acc) * (0.3 + 0.7 * crev) * (0.65 + 0.35 * (gr < 0 ? -gr : gr));
          const bR = ICE_BARE[0] + (ICE_CREVASSE[0] - ICE_BARE[0]) * crev;
          const bG = ICE_BARE[1] + (ICE_CREVASSE[1] - ICE_BARE[1]) * crev;
          const bB = ICE_BARE[2] + (ICE_CREVASSE[2] - ICE_BARE[2]) * crev;
          const ib = 1 + (0.045 + 0.07 * (1 - acc)) * stripe + 0.015 * lf;
          R += ((bR + (FIRN[0] - bR) * acc) * ib - R) * iceCov;
          G += ((bG + (FIRN[1] - bG) * acc) * ib - G) * iceCov;
          B += ((bB + (FIRN[2] - bB) * acc) * ib - B) * iceCov;
        }
        // Static pixel-scale grain (hash) on top of the band-limited textures; snowfields and ice
        // stay smooth.
        let hs = Math.imul(p ^ grainSeed, 0x27d4eb2d);
        hs ^= hs >>> 15;
        hs = Math.imul(hs, 0x2c1b3c6d);
        hs ^= hs >>> 12;
        const smoothWhite = snowVis > iceCov ? snowVis : iceCov;
        const grain = 1 + (GRAIN * lf + PIXEL_GRAIN * ((hs & 1023) * (1 / 511.5) - 1)) * (1 - 0.8 * smoothWhite);
        R *= grain;
        G *= grain;
        B *= grain;
        if (surf) {
          // Lakes and rivers freeze in a cold month even where there is no snow to cover them.
          let frz = (-3 - ts) * (1 / 4);
          frz = frz < 0 ? 0 : frz > 1 ? 1 : frz;
          let sv = snow > iceCov ? snow : iceCov;
          if (frz > sv) sv = frz;
          surf.snow[p] = (sv * 255 + 0.5) | 0;
          surf.desert[p] = (smooth(0.2, 0.8, des) * 255 + 0.5) | 0;
          surf.trees[p] = (mT * 255 + 0.5) | 0;
          surf.ice[p] = (iceCov * 255 + 0.5) | 0;
        }
        if (shadeF !== null) {
          // Ice sheets smooth the bedrock relief: their shading is softened.
          const f = 1 + (shadeF[p] * RELIEF_SHADE_SCALE - 1) * (1 - 0.45 * iceCov);
          R *= f;
          G *= f;
          B *= f;
        }
      } else {
        // ---- ocean -------------------------------------------------------------------------
        const q00 = i00 * OCEAN_K, q01 = q00 + OCEAN_K, q10 = q00 + oStride, q11 = q10 + OCEAN_K;
        let iceF: number, sst: number;
        if (px !== null) {
          const b = p * PX_K;
          if ((pxOk[p] & PX_OK_OCEAN) === 0) {
            fillOcean(px, b, OG, q00, oStride, w00, w01, w10, w11);
            pxOk[p] |= PX_OK_OCEAN;
          }
          iceF = px[b + PX_ICE] * PX_U;
          sst = px[b + PX_SST] * PX_T + PX_T0;
        } else {
          iceF = w00 * OG[q00 + O_ICE] + w01 * OG[q01 + O_ICE] + w10 * OG[q10 + O_ICE] + w11 * OG[q11 + O_ICE];
          sst = w00 * OG[q00 + O_SST] + w01 * OG[q01 + O_SST] + w10 * OG[q10 + O_SST] + w11 * OG[q11 + O_SST];
        }
        // Depth ramps are indexed on a sqrt scale (fine near the coast; table lookup per pixel).
        const depth = sea - H;
        let dq = (depth * (1 / DEPTH_LUT_STEP)) | 0;
        if (dq >= DEPTH_INDEX.length) dq = DEPTH_INDEX.length - 1;
        const di = DEPTH_INDEX[dq];
        let warm = (sst - 8) * (1 / 16);
        warm = warm < 0 ? 0 : warm > 1 ? 1 : warm * warm * (3 - 2 * warm);
        const d3 = 3 * di;
        if (iceF <= 0.004 && (enclosed === null || enclosed[p] === 0)) {
          // Open, ice-free water (most pixels): pre-encoded sRGB ramp.
          const q = 3 * (di * OCEAN_WARM_N + ((warm * (OCEAN_WARM_N - 1) + 0.5) | 0));
          const o = 4 * p;
          rgba[o] = OCEAN_SRGB[q];
          rgba[o + 1] = OCEAN_SRGB[q + 1];
          rgba[o + 2] = OCEAN_SRGB[q + 2];
          rgba[o + 3] = 255;
          continue;
        }
        if (enclosed !== null && enclosed[p] === 1) {
          // Small enclosed water body (lagoon / flooded hollow): still, dark water — frozen and
          // snow-covered in a cold month, and buried under the ice inside ice sheets (bedrock
          // hollows below sea level).
          R = LAGOON_COLD[0] + (LAGOON_WARM[0] - LAGOON_COLD[0]) * warm;
          G = LAGOON_COLD[1] + (LAGOON_WARM[1] - LAGOON_COLD[1]) * warm;
          B = LAGOON_COLD[2] + (LAGOON_WARM[2] - LAGOON_COLD[2]) * warm;
          const lq = i00 * LAND_K, lq01 = lq + LAND_K, lq10 = lq + lStride, lq11 = lq10 + LAND_K;
          const tsL = w00 * LG[lq + A_TSNOW] + w01 * LG[lq01 + A_TSNOW] + w10 * LG[lq10 + A_TSNOW] + w11 * LG[lq11 + A_TSNOW];
          const twL = w00 * LG[lq + A_TWARM] + w01 * LG[lq01 + A_TWARM] + w10 * LG[lq10 + A_TWARM] + w11 * LG[lq11 + A_TWARM];
          const shL = w00 * LG[lq + A_SHEET] + w01 * LG[lq01 + A_SHEET] + w10 * LG[lq10 + A_SHEET] + w11 * LG[lq11 + A_SHEET];
          let fz = (-2 - tsL) * (1 / 4);
          fz = fz < 0 ? 0 : fz > 1 ? 1 : fz * fz * (3 - 2 * fz);
          let buried = (2 + ICE_FLOW_C * shL - twL) * (1 / 3);
          buried = buried < 0 ? 0 : buried > 1 ? 1 : buried * buried * (3 - 2 * buried);
          buried *= shL > 0.3 ? 1 : shL * (1 / 0.3);
          if (buried > fz) fz = buried;
          if (fz > 0) {
            const iR = LAKE_FROZEN[0] + (FIRN[0] - LAKE_FROZEN[0]) * buried;
            const iG = LAKE_FROZEN[1] + (FIRN[1] - LAKE_FROZEN[1]) * buried;
            const iB = LAKE_FROZEN[2] + (FIRN[2] - LAKE_FROZEN[2]) * buried;
            R += (iR - R) * fz;
            G += (iG - G) * fz;
            B += (iB - B) * fz;
          }
        } else {
          R = OCEAN_COLD[d3] + (OCEAN_WARM[d3] - OCEAN_COLD[d3]) * warm;
          G = OCEAN_COLD[d3 + 1] + (OCEAN_WARM[d3 + 1] - OCEAN_COLD[d3 + 1]) * warm;
          B = OCEAN_COLD[d3 + 2] + (OCEAN_WARM[d3 + 2] - OCEAN_COLD[d3 + 2]) * warm;
        }
        if (iceF > 0.004) {
          // Sea ice: a floe mosaic of the climate concentration (area ≈ concentration, none where
          // the climate has none), world-frame so it does not ride on the plates. Land-fast ice
          // fills ice-covered shallows; leads crack the consolidated pack; thin, loose ice is
          // greyer than the snow-covered pack.
          const wt = wtex[p] * (1 / 127), wf = wfine[p] * (1 / 127);
          const z = MOSAIC_K * (0.75 * wt + 0.55 * wf);
          const uI = 0.5 + 0.5 * z / (1 + (z < 0 ? -z : z));
          let cov = ss((iceF * (1 + W_ICE) - uI) * iW_ICE);
          if (depth < FAST_ICE_DEPTH) {
            const fast = ss((iceF - 0.25) * (1 / 0.3));
            if (fast > cov) cov = fast;
          }
          if (cov > 0) {
            const lw = wf < 0 ? -wf : wf;
            const lead = 1 - 0.22 * ss((iceF - 0.8) * (1 / 0.15)) * (1 - ss(lw * (1 / 0.05)));
            const thick = ss((iceF - 0.3) * (1 / 0.5));
            const br = (0.93 + 0.07 * wt) * lead;
            R += ((SEA_ICE_THIN[0] + (SEA_ICE[0] - SEA_ICE_THIN[0]) * thick) * br - R) * cov;
            G += ((SEA_ICE_THIN[1] + (SEA_ICE[1] - SEA_ICE_THIN[1]) * thick) * br - G) * cov;
            B += ((SEA_ICE_THIN[2] + (SEA_ICE[2] - SEA_ICE_THIN[2]) * thick) * br - B) * cov;
          }
        }
      }
      const o = 4 * p;
      rgba[o] = encodeSrgb(R);
      rgba[o + 1] = encodeSrgb(G);
      rgba[o + 2] = encodeSrgb(B);
      rgba[o + 3] = 255;
    }
  }
  antialiasCoast(rgba, hf, sea);
  if (surf) drawRiversAndLakes(rgba, hf, heightFieldKey(mesh, snapshot, opts), climate, opts, cache, surf);
  return rgba;
}
