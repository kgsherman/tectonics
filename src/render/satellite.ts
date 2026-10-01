/**
 * Satellite layer (SPEC §7, the showcase): Köppen-driven surface attributes sampled through the
 * warped climate sampler, per-pixel lapse-corrected alpine belts (treeline, tundra, bare rock,
 * snow line, ice caps), depth/SST-tinted oceans with shelves, monthly sea ice and snow, optional
 * hillshade, rivers & lakes at full quality. Blending in linear light, sRGB encoding at the end.
 * Land vs sea is decided only by the height map.
 *
 * Structure comes from MOSAICS rather than linear blends: each sub-grid cover fraction (vegetation,
 * trees, snow, glacier ice; sea-ice floes separately) is turned into patches by thresholding a
 * patch score at the fraction's normal quantile, so a 40 % forest cell shows forest patches in
 * lighter fields (area ≈ 40 %) instead of a uniform 40 % tint. The scores are smooth at the pixel
 * scale (a band-limited, domain-warped plate-frame patch noise, a smooth relief proxy, valley
 * lines drawn from smoothed polylines) and their thresholds are anti-aliased: edges a pixel or two
 * wide, widened where the lapse rate sweeps a fraction through its range within a pixel — organic
 * patches at every scale, no pixel-scale fragments or blocks. The thresholded climate attributes
 * are C² cubic B-spline fields sampled through a C¹ warp, so no climate-cell outline survives.
 * Patches are ordered by terrain — vegetation in dryland valleys, forests on humid hills, snow
 * first on high ground and pole-facing slopes — and anchored to the plates (sea ice to the
 * world), so textures follow the relief and never crawl.
 *
 * Forests read as orbital imagery, not camouflage: the patch score is fractal (multi-scale patch
 * noise plus broad substrate tracts from the lithology noise: patches at every size, rough outlines)
 * and its soft threshold is mean-preserving (the wooded area follows the climate's tree fraction).
 * Contrast and edges depend on the tree fraction t: intermediate cover (savanna, forest-steppe) has
 * the strongest mosaic with the softest edges (tree-density gradients); toward a closed humid
 * canopy the openings fade into shrubby secondary growth (continuous dark canopy with gentle tone
 * variation and fine texture), while snow still reveals the stand structure crisply in winter.
 * Openings in humid forest sit in the hollows and along the valleys; in drylands and at the cold
 * margin (northern taiga, forest-tundra) the trees gather there instead (gallery forests), and drawn
 * rivers through dry land get riparian strips.
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
const { bspline16, bsplineWeights, getClimateSampler } = _satelliteSampler;
const {
  PX_COVER, PX_DESERT, PX_EVER, PX_GRASS, PX_HIDED, PX_HOT, PX_ICE, PX_K, PX_OK_LAND, PX_OK_OCEAN, PX_P, PX_PANN, PX_SHEET,
  PX_SNOWSUP, PX_SOIL, PX_SST, PX_T, PX_T0, PX_TREE, PX_TREES, PX_TSNOW, PX_TWARM, PX_U, PX_W, PX_WET, PX_WINDE, PX_WINDN,
  fillLand, fillOcean, pixelAttributes,
} = _satellitePixels;
const NO_PIXELS = new Uint8Array(0);
/** B-spline weights scratch (rows 0..3, columns 4..7). */
const BW = new Float64Array(8);
const { antialiasCoast } = _satelliteCoast;
const { rasterGeometry } = _paintGeometry;
/** Frozen, snow-covered lagoon / hollow. */
const LAKE_FROZEN = _colormaps.toLinear([214, 224, 234]);
const { enclosedWater } = _satelliteWater;
const { HF_NOISE_SCALE, PVEG_SCALE, detailTexture, getHeightField, heightFieldKey, qualityOf } = _terrain;
const { RELIEF_SHADE_SCALE, gradientScales, reliefShadeField } = _terrainShade;

/** Sea-ice floe mosaic: noise → pseudo-uniform (0,1): U(x) = ½ + ½·z/(1 + |z|), z = MOSAIC_K·x. */
const MOSAIC_K = 3.2;
/** Sea-ice floe mosaic edge width (U units). */
const W_ICE = 0.16;
/**
 * Land mosaics threshold a patch score s (≈ unit variance) at the normal quantile of the cover
 * fraction: mask = smoothstep((Φ⁻¹(fraction)·σ − s) / W + ½). Edge widths W (score units) at 2048 px
 * for the vegetation, forest (and evergreen stands), snow and glacier-margin scores — ≈ EDGE_PX
 * pixels of their typical gradient — scaled as the scores' per-pixel gradient at other widths
 * ((2048 / w)^EDGE_EXP): smooth, anti-aliased patch edges instead of pixel-scale fragments.
 */
const EDGE_VEG = 0.8;
const EDGE_TREE = 0.9;
const EDGE_SNOW = 0.5;
const EDGE_ICE = 0.35;
const EDGE_EXP = 0.58;
/** Normal quantiles Φ⁻¹(i / QN_N), clamped to ±3.2 (fraction → patch-score threshold). */
const QN_N = 1024;
const QN = (() => {
  const out = new Float64Array(QN_N + 1);
  for (let i = 0; i <= QN_N; i++) out[i] = normalQuantile(i / QN_N);
  return out;
})();
/**
 * Pixel-scale curvature albedo: height deviation from the 5-point mean (m) at which the soft-clamped
 * curvature reaches ½, and its albedo gains on vegetation (crests brighter) and in deserts (crests
 * darker: rock varnish; hollows brighter: sand, alluvium).
 */
const CURV_M = 60;
const CURV_VEG = 0.07;
const CURV_DRY = 0.1;
/** Relief position (hills and crests +, valleys −): ridge detail (m) worth one unit. */
const REL_RIDGE_M = 500;
/** Smooth relief position (mosaics): weights of the relief proxy (unit variance) and ridge detail. */
const REL_S_VR = 0.55;
const REL_S_RIDGE = 0.5;
/** Pole-facing slope gain (per m/m of north–south gradient). */
const ASPECT_K = 7;
/** Relief-coupled albedo: dryland valleys (alluvium) brighter, crests darker; humid valleys darker. */
const REL_DRY = 0.13;
const REL_WET = 0.07;
/**
 * How far the vegetation / forest fractions become patches (0 = linear mix, 1 = full mosaic); the
 * forest mosaic's strength is MOS_TREE (humid) … MOS_TREE_DRY × t4·(1.6 − 0.6·t4), t4 = 4·t·(1 − t) of
 * the tree fraction t: full at intermediate fractions, ≈ ¼ at t = 0.95, none in a closed canopy.
 */
const MOS_VEG = 0.3;
const MOS_TREE = 0.85;
/** … in drylands (scattered trees and woodland islands mostly mix within a pixel). */
const MOS_TREE_DRY = 0.5;
/**
 * Forest patch-score weights: fractal patch noise, the lithology noise (substrate: broad, hundreds of
 * km, more- and less-wooded tracts — std ≈ 0.27, so ≈ 0.45 of score), fine noise (rough outlines).
 */
const TREE_VG = 0.85;
const TREE_LITH = 1.65;
const PATCH_IRREG = 0.3;
/** Relief (+ hills) and valley-ness weights in the forest score, dry → humid (− = more trees). */
const TREE_REL_DRY = 0.5;
const TREE_REL_HUMID = -0.35;
const TREE_VLY_DRY = -2.2;
const TREE_VLY_HUMID = 0.9;
/** Standard deviation of the forest score, dry → humid (quantile scale). */
const TREE_SIG_DRY = 1.33;
const TREE_SIG_HUMID = 1.11;
/** Warmest-month temperatures (°C, at the pixel) over which the cold margin's valley preference fades. */
const TREE_COLD_T0 = 11;
const TREE_COLD_T1 = 16;
/** Extra edge width of the forest mosaic at intermediate tree fractions (× t4²). */
const TREE_SOFT = 1.6;
/**
 * Per quantised tree fraction t (the QN index): 1 / edge-width factor (1 + TREE_SOFT·t4²), the
 * smoothstep spread 0.05·W² per unit base width², and the mosaic-contrast shape t4·(1.6 − 0.6·t4)
 * (t4 = 4·t·(1 − t)): no divisions in the hot loop.
 */
const { inv: TREE_INV, w2: TREE_W2, amp: TREE_AMP } = (() => {
  const inv = new Float64Array(QN_N + 1), w2 = new Float64Array(QN_N + 1), amp = new Float64Array(QN_N + 1);
  for (let i = 0; i <= QN_N; i++) {
    const t = i / QN_N, t4 = 4 * t * (1 - t), soft = 1 + TREE_SOFT * t4 * t4;
    inv[i] = 1 / soft;
    w2[i] = 0.05 * soft * soft;
    amp[i] = t4 * (1.6 - 0.6 * t4);
  }
  return { inv, w2, amp };
})();
/**
 * Openings in well-wooded humid land (shrubs, secondary growth): share of the herbaceous colour
 * replaced at full tree fraction and humidity, and their tone relative to the canopy.
 */
const GAP_SHRUB = 0.65;
const SHRUB_TONE = 1.45;
/** Canopy tone variation per unit of the lithology noise (std ≈ 0.27). */
const CANOPY_TONE = 0.3;
/** Riparian strips along drawn rivers: humidity share that suppresses them (humid land is wooded anyway). */
const RIP_HUMID = 0.75;
/** Downslope gully / spur texture: derivative gain, weight in the forest mosaic, slope of full effect. */
const GULLY_K = 2;
const GULLY_W = 0.6;
const GULLY_SLOPE = 0.08;
/** Fine texture amplitudes: forest canopy, grass, bare ground; weights of the hill / fine / grain noises. */
const CANOPY_TEX = 0.32;
const HERB_TEX = 0.15;
const GROUND_TEX = 0.1;
const TX_PN = 0.5;
const TX_LF = 0.55;
const TX_GR = 0.9;
/** Humid valleys and drainage lines: darker, wetter vegetation (albedo fraction at full valley-ness). */
const VALLEY_DARK = 0.09;
/**
 * Drainage-line field (HeightField.pdrain, 0..255) → valley lines: 0 below DRAIN_LO, 1 above
 * DRAIN_HI (smoothstep).
 */
const DRAIN_LO = 50;
const DRAIN_HI = 170;
/**
 * Mean of the valley-ness field over land (centres the microclimate / mosaic terms; measured on
 * Earth: 0.255 at full quality with the drainage lines, 0.237 in the preview). An off-centre value
 * biases every mosaic score (forest patches covered ≈ 2× their tree fraction at low fractions) and
 * warms the whole microclimate.
 */
const VLY_MEAN = 0.25;
/** Thermal microclimate (× MOTTLE_C °C): plate-frame noise and valley shelter. */
const MOT_NOISE = 0.3;
const MOT_VALLEY = 0.8;
/** How much warmer (°C of warmest month) valley / outlet glaciers reach than the ice-sheet limit. */
const ICE_VALLEY_C = 4.5;
/** How much warmer (°C) ice-sheet margins reach where the neighbourhood is glaciated. */
const ICE_FLOW_C = 4;
/** Warmest-month temperature (°C) above which no ice can form whatever the valley / sheet terms. */
const ICE_TW_MAX = 2 + ICE_VALLEY_C + ICE_FLOW_C + 1.5;
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
const REG_SPECKLE = 0.07;
/**
 * Dryland rock: slope threshold lowered by ROCK_DRY_SLOPE × desert weight; outcrops on the crests of
 * the fine relief (ridge detail DCREST_M0 → DCREST_M0 + DCREST_M1 m, minus the valleys), weight in
 * the rock fraction; wadis (drainage lines) brighten the gravel (lithology-ramp units).
 */
const ROCK_DRY_SLOPE = 0.05;
const DCREST_M0 = 20;
const DCREST_M1 = 90;
const DCREST_ROCK = 0.35;
const WADI = 0.3;
/** Fine multiplicative grain of the land surface (plate-frame fine and grain noises). */
const GRAIN = 0.035;
const FINE_GRAIN = 0.12;
/**
 * Tundra colour: annual precipitation (m/yr) where it starts turning from dry to wet, and the
 * further precipitation over which it turns (fully wet at TUNDRA_P0 + TUNDRA_P1 = 0.8 m/yr).
 */
const TUNDRA_P0 = 0.25;
const TUNDRA_P1 = 0.55;
/**
 * Altitude belts: share of the pixel's own deviation from its 5-point mean height kept in the lapse
 * correction, and weight of the mean absolute deviation (m) in the thermal ramp widths.
 */
const BELT_OWN = 0.35;
const BELT_SPREAD = 2;
/** Minimum width (px) of the thermal (altitude-belt) ramps on steep ground. */
const THERMAL_AA_PX = 1.4;
/** Minimum width (px) of a mosaic edge swept by a thermal ramp (treeline, snowline, glacier margin). */
const MOSAIC_AA_PX = 1.4;
/**
 * Ramp shift per pixel (ramp-argument units) below which the thermal sweep cannot widen a mosaic
 * edge beyond its base width (skips the check on gentle ground).
 */
const RAMP_AA_DU = 0.1;
/** Ice cover above which the ground below is not shaded (closed ice). */
const ICE_CLOSED = 0.9995;
/** Depth (m) under which ice-covered shallows count as land-fast ice. */
const FAST_ICE_DEPTH = 60;

/** Standard normal quantile (Acklam's rational approximation, |error| < 1.2e-9), clamped to ±3.2. */
function normalQuantile(p: number): number {
  if (p <= 0.0006871) return -3.2;
  if (p >= 1 - 0.0006871) return 3.2;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5, r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Per-pixel change of a mosaic threshold QN[f] when a thermal ramp moves by ±du around u (the
 * ramp argument; f = smoothstep(u)·k): half the QN difference. On steep ground the lapse rate
 * sweeps a fraction across its range within a pixel; the mosaic edge must then widen with it
 * (anti-aliased treelines, snowlines and glacier margins).
 */
function rampShift(u: number, du: number, k: number): number {
  let a = u - du, b = u + du;
  a = a < 0 ? 0 : a > 1 ? 1 : a * a * (3 - 2 * a);
  b = b < 0 ? 0 : b > 1 ? 1 : b * b * (3 - 2 * b);
  const d = QN[(b * k * QN_N + 0.5) | 0] - QN[(a * k * QN_N + 0.5) | 0];
  return 0.5 * (d < 0 ? -d : d);
}

/** Fine + 0.8 × grain noise of a packed HeightField.pnoise value (×127): oriented-texture derivatives. */
function fineMix(v: number): number {
  return ((v << 24) >> 24) + 0.8 * ((v << 16) >> 24);
}

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
  const { height, patch, lith, rough, pnoise, pdrain } = hf;
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
  const surf = withRivers
    ? { snow: new Uint8Array(w * h), desert: new Uint8Array(w * h), trees: new Uint8Array(w * h), ice: new Uint8Array(w * h), rip: new Uint8Array(w * h) }
    : null;
  const iW_ICE = 1 / W_ICE;
  // Temperature change across THERMAL_AA_PX pixels per unit of metric slope (°C).
  const lapsePx = LAPSE_RATE * gs.pixelKm * 1000 * THERMAL_AA_PX;
  const edgeK = Math.pow(2048 / w, EDGE_EXP);
  const iwVeg = 1 / (EDGE_VEG * edgeK), iwTree = 1 / (EDGE_TREE * edgeK), iwSnow = 1 / (EDGE_SNOW * edgeK), iwIce = 1 / (EDGE_ICE * edgeK);
  const wTree2 = (EDGE_TREE * edgeK) * (EDGE_TREE * edgeK);
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
      // Climate-grid corner and bilinear weights: always at full quality, only for the first
      // fill of a pixel's cached record in the preview.
      let i00 = 0, w00 = 0, w01 = 0, w10 = 0, w11 = 0;
      if (px === null || (pxOk[p] & (H > sea ? PX_OK_LAND : PX_OK_OCEAN)) === 0) {
        i00 = idx[p];
        const fr = wr[p] * (1 / 65535), fc = wc[p] * (1 / 65535);
        w00 = (1 - fr) * (1 - fc);
        w01 = (1 - fr) * fc;
        w10 = fr * (1 - fc);
        w11 = fr * fc;
      }
      let R: number, G: number, B: number;
      if (H > sea) {
        // ---- land --------------------------------------------------------------------------
        // Bilinear climate attributes, unrolled into locals (register-friendly hot loop).
        const q00 = i00 * LAND_K, q01 = q00 + LAND_K, q10 = q00 + lStride, q11 = q10 + LAND_K;
        let soilR = 0, soilG = 0, soilB = 0, grassR = 0, grassG = 0, grassB = 0, treeR = 0, treeG = 0, treeB = 0;
        let aCover = 0, aTrees = 0, aTwarm = 0, aTsnow = 0, aSnowSup = 0, des = 0, hot = 0, wet = 0, sheet = 0;
        // Cached record offset (preview), or −1: the rarely needed attributes below are then
        // interpolated from the grid on demand.
        const pb = px !== null ? p * PX_K : -1;
        if (px !== null) {
          const b = pb;
          if ((pxOk[p] & PX_OK_LAND) === 0) {
            fillLand(px, b, LG, i00, smp.stride, wr[p] * (1 / 65535), wc[p] * (1 / 65535));
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
          // The thresholded scalars (fractions, temperatures): C² cubic B-spline (as fillLand).
          bsplineWeights(wr[p] * (1 / 65535), BW, 0);
          bsplineWeights(wc[p] * (1 / 65535), BW, 4);
          const qb = (i00 - smp.stride - 1) * LAND_K;
          aCover = bspline16(LG, qb, lStride, LAND_K, A_COVER, BW);
          aTrees = bspline16(LG, qb, lStride, LAND_K, A_TREES, BW);
          aTwarm = bspline16(LG, qb, lStride, LAND_K, A_TWARM, BW);
          aTsnow = bspline16(LG, qb, lStride, LAND_K, A_TSNOW, BW);
          aSnowSup = bspline16(LG, qb, lStride, LAND_K, A_SNOWSUP, BW);
          des = bspline16(LG, qb, lStride, LAND_K, A_DESERT, BW);
          sheet = bspline16(LG, qb, lStride, LAND_K, A_SHEET, BW);
          hot = w00 * LG[q00 + A_HOT] + w01 * LG[q01 + A_HOT] + w10 * LG[q10 + A_HOT] + w11 * LG[q11 + A_HOT];
          wet = w00 * LG[q00 + A_WET] + w01 * LG[q01 + A_WET] + w10 * LG[q10 + A_WET] + w11 * LG[q11 + A_WET];
        }
        const pE = row + (c + 1 < w ? c + 1 : 0), pW = row + (c > 0 ? c - 1 : w - 1), pN = rowN + c, pS = rowS + c;
        const hE = height[pE], hW = height[pW], hN = height[pN], hS = height[pS];
        const gx = (hE - hW) * invDx;
        const gy = (hN - hS) * invDy;
        const gl = Math.sqrt(gx * gx + gy * gy);
        const slope = gl * slopeNorm;
        // Altitude belts use the pixel's mean ground (5-point, sea floors counted at sea level) with
        // a little of its own crest / hollow: rugged mountains have kilometre-scale relief within a
        // pixel, so belts come out fractional (a crest-speckled snowfield would alias into blocks);
        // the altitude spread widens the thermal ramps (see dTpx).
        const cE = hE > sea ? hE : sea, cW = hW > sea ? hW : sea, cN = hN > sea ? hN : sea, cS = hS > sea ? hS : sea;
        const hC = 0.2 * (H + cE + cW + cN + cS);
        const dH = H - hC;
        const spread = 0.2 * (Math.abs(dH) + Math.abs(cE - hC) + Math.abs(cW - hC)
          + Math.abs(cN - hC) + Math.abs(cS - hC));
        const hp = hC + BELT_OWN * dH - sea;
        const tw = aTwarm - LAPSE_RATE * hp;
        const ts = aTsnow - LAPSE_RATE * hp;
        const pn = patch[p] * HF_NOISE_SCALE, lk = lith[p] * HF_NOISE_SCALE;
        // Texture noises anchored to the plates (world-frame ones would stay put while the land
        // moves under them: crawling mosaics during playback): fine texture, fine grain, patch
        // noise, and the drainage-line network below the mesh scale.
        const pk = pnoise[p];
        const lf = ((pk << 24) >> 24) * (1 / 127), lt = 0.91 * lf;
        const gr = ((pk << 16) >> 24) * (1 / 127);
        const vg = ((pk << 8) >> 24) * (1 / PVEG_SCALE);
        let dl = (pdrain[p] - DRAIN_LO) * (1 / (DRAIN_HI - DRAIN_LO));
        dl = 0.5 * (Math.abs(dl) - Math.abs(dl - 1) + 1);
        dl = dl * dl * (3 - 2 * dl);
        if (lines !== null) {
          const ch = lines[p] * (1 / 255);
          dl = ch > 0.5 * dl ? ch : 0.5 * dl;
        }
        // Relief position: + hills and crests, − valleys — at the pixel scale (albedo textures), and
        // smooth (the relief proxy of the hill detail + damped ridges) for the mosaic thresholds.
        const rgh = rough[p];
        let rel = 1.6 * pn + rgh * (1 / REL_RIDGE_M);
        rel = 0.5 * (Math.abs(rel + 1.5) - Math.abs(rel - 1.5));
        let relC = REL_S_VR * (pk >> 24) * (1 / PVEG_SCALE) + REL_S_RIDGE * rgh * (1 / REL_RIDGE_M);
        relC = 0.5 * (Math.abs(relC + 1) - Math.abs(relC - 1));
        // Valley-ness: valley floors of the (smooth) relief, and the drainage lines.
        let vb = -relC * (1 / 0.8);
        vb = 0.5 * (Math.abs(vb) - Math.abs(vb - 1) + 1);
        vb = vb * vb * (3 - 2 * vb);
        const vly = 1 - (1 - dl) * (1 - 0.6 * vb);
        const vc = vly - VLY_MEAN;
        // Gradient of the fine plate-frame noises (px units), computed on demand: directional
        // derivatives of it give oriented textures — gullies and spurs running downhill, dune grain
        // across the wind, ice-flow stripes.
        let dfx = 0, dfy = 0, dfOk = false;
        // Microclimate: sheltered valleys and drainage lines are warmer in summer, exposed
        // interfluves cooler; a little plate-frame noise keeps the thermal belts organic. The
        // treeline therefore advances along the valleys (forest-tundra) instead of in blobs.
        const twm = tw + MOTTLE_C * (MOT_NOISE * pn + MOT_VALLEY * vc);
        // Anti-aliased altitude belts: on steep or rugged ground the lapse rate sweeps the pixel
        // temperature through a belt within a pixel, so each thermal ramp is at least THERMAL_AA_PX
        // pixels of the local temperature change wide (centre kept): smooth treelines and snowlines.
        // Reciprocals of the ramp widths max(W, dTpx) (one division at most).
        const dTpx = lapsePx * gl + LAPSE_RATE * BELT_SPREAD * spread;
        let iv25 = 0.4, iv3 = 1 / 3, iv4 = 0.25, iv5 = 0.2, iv7 = 1 / 7;
        if (dTpx > 2.5) {
          const iv = 1 / dTpx;
          iv25 = iv;
          if (dTpx > 3) {
            iv3 = iv;
            if (dTpx > 4) {
              iv4 = iv;
              if (dTpx > 5) {
                iv5 = iv;
                if (dTpx > 7) iv7 = iv;
              }
            }
          }
        }
        // Pole-facing (shaded) slopes: + ; sun-facing: −.
        let asp = aspSign * gy;
        asp = 0.5 * (Math.abs(asp + 1) - Math.abs(asp - 1));
        let crest = (rgh - 120) * (1 / 780);
        crest = 0.5 * (Math.abs(crest) - Math.abs(crest - 1) + 1);
        crest = crest * crest * (3 - 2 * crest);
        // Glaciers and ice sheets: summers below ≈ +0.5 °C at the pixel, nourished by precipitation
        // near that limit and by cold alone well below; outlet and valley glaciers descend the
        // valleys and drainage lines into ground several degrees warmer. (Decided first: under a
        // closed ice cover the ground is not shaded at all.)
        let iceCov = 0;
        let ice = 0, uI = 0, nourI = 1;
        if (tw < ICE_TW_MAX) {
          // Ice sheets also flow down into warmer margins (to the coast where the neighbourhood is
          // glaciated: Antarctica, inland Greenland).
          // Valley glaciers need steep mountain valleys to descend (not plateau drainage lines).
          let steep = slope * (1 / 0.2);
          steep = steep > 1 ? 1 : steep;
          uI = (0.5 + ICE_VALLEY_C * vly * steep + ICE_FLOW_C * sheet - tw + 1.5 * lt) * iv3 + 0.5;
          ice = 0.5 * (Math.abs(uI) - Math.abs(uI - 1) + 1);
          ice = ice * ice * (3 - 2 * ice);
          if (ice > 0) {
            const pann = px !== null ? px[pb + PX_PANN] * PX_P : w00 * LG[q00 + A_PANN] + w01 * LG[q01 + A_PANN] + w10 * LG[q10 + A_PANN] + w11 * LG[q11 + A_PANN];
            nourI = iceNourishment(pann + 0.08 * lt, tw, sheet);
            ice *= nourI;
          }
        }
        if (ice > 0) {
          // Crisp margins: ice survives longest in valleys and on shaded slopes.
          const sI = 0.5 * relC - 0.9 * vc - 0.35 * asp + 0.3 * lf;
          let iw = iwIce;
          const du = dTpx * iv3 * (1 / THERMAL_AA_PX);
          if (uI < 1 && du > RAMP_AA_DU) {
            const g = MOSAIC_AA_PX * 0.45 * rampShift(uI, du, nourI);
            if (g * iw > 1) iw = 1 / g;
          }
          iceCov = (QN[(ice * QN_N + 0.5) | 0] * 0.45 - sI) * iw + 0.5;
          iceCov = 0.5 * (Math.abs(iceCov) - Math.abs(iceCov - 1) + 1);
          iceCov = iceCov * iceCov * (3 - 2 * iceCov);
          // Nunataks: only the steepest rock faces and crests poke through.
          let nun = (slope - NUNATAK_SLOPE) * (1 / 0.3) + 0.5 * crest - 0.25;
          nun = 0.5 * (Math.abs(nun) - Math.abs(nun - 1) + 1);
          nun = nun * nun * (3 - 2 * nun);
          iceCov *= 1 - 0.9 * nun;
        }
        // Seasonal snow (lapse-corrected, climate supply), a mosaic ordered by relief and aspect
        // (high ground and pole-facing slopes first) with crisp edges.
        const uS = (-1.5 - ts - 0.25 * MOTTLE_C * pn) * iv5 + 0.5;
        let snow = 0;
        if (uS > 0) {
          const sT = uS > 1 ? aSnowSup : uS * uS * (3 - 2 * uS) * aSnowSup;
          // (Valleys and drainage lines melt out first: the snowline follows the terrain.)
          const sS = -0.9 * relC - 0.6 * asp + 0.9 * vc + 0.35 * lf;
          let iw = iwSnow;
          const du = dTpx * iv5 * (1 / THERMAL_AA_PX);
          if (uS < 1 && du > RAMP_AA_DU) {
            const g = MOSAIC_AA_PX * 0.62 * rampShift(uS, du, aSnowSup);
            if (g * iw > 1) iw = 1 / g;
          }
          snow = (QN[(sT * QN_N + 0.5) | 0] * 0.62 - sS) * iw + 0.5;
          snow = 0.5 * (Math.abs(snow) - Math.abs(snow - 1) + 1);
          snow = snow * snow * (3 - 2 * snow);
          // Steep rock walls shed snow.
          let shed = (slope - 0.28) * (1 / 0.3);
          shed = 0.5 * (Math.abs(shed) - Math.abs(shed - 1) + 1);
          shed = shed * shed * (3 - 2 * shed);
          snow *= 1 - 0.6 * shed;
        }
        let mT = 0, mTs = 0, des01 = 0, snowVis = 0, ripV = 0;
        if (iceCov < ICE_CLOSED) {
          // Temperature-limited vegetation: continuous re-classification by the pixel's own
          // warmest month (treeline ≈ 10 °C, vegetation limit ≈ 0 °C).
          let vegT = (twm - 2.5) * iv7 + 0.5;
          vegT = 0.5 * (Math.abs(vegT) - Math.abs(vegT - 1) + 1);
          vegT = vegT * vegT * (3 - 2 * vegT);
          const uTree = (twm - 10.25) * iv25 + 0.5;
          const treeTc = 0.5 * (Math.abs(uTree) - Math.abs(uTree - 1) + 1);
          const treeT = treeTc * treeTc * (3 - 2 * treeTc);
          // Bare rock: steep slopes, crests of mountain ridges, and above the vegetation limit.
          // Without soil and plant cover (drylands) rock is exposed on gentler slopes and along
          // the lower crests of the fine relief, cut by the valleys: outcrops trace ridges and
          // escarpments.
          let rock = (slope - 0.12 + ROCK_DRY_SLOPE * des) * (1 / 0.2);
          rock = 0.5 * (Math.abs(rock) - Math.abs(rock - 1) + 1);
          rock = rock * rock * (3 - 2 * rock);
          let dcrest = 0;
          if (des > 0.003) {
            dcrest = (rgh - DCREST_M0) * (1 / DCREST_M1) - 1.2 * vly;
            dcrest = 0.5 * (Math.abs(dcrest) - Math.abs(dcrest - 1) + 1);
            dcrest = dcrest * dcrest * (3 - 2 * dcrest);
            dcrest *= des;
          }
          rock += 0.75 * crest * (1 - treeT) + 0.6 * (1 - vegT) + DCREST_ROCK * dcrest;
          rock = rock > 1 ? 1 : rock;
          // Cover fractions → mosaics: each fraction thresholds a unit-variance patch score
          // (plate-frame patch noise plus terrain terms) at its normal quantile, so the patch area
          // follows the fraction, with smooth edges a pixel or two wide at any resolution (no
          // pixel-scale fragments).
          const cover = aCover * vegT * (1 - 0.75 * rock);
          let trees = aTrees * treeT;
          if (trees > cover) trees = cover;
          let humid = (wet - 0.4) * (1 / 0.3);
          humid = 0.5 * (Math.abs(humid) - Math.abs(humid - 1) + 1);
          humid = humid * humid * (3 - 2 * humid);
          // Grass vs bare ground: mostly a sub-pixel mix, mildly patchy; in drylands the
          // vegetation gathers along the valleys and drainage lines and thins on the crests.
          let mC = cover;
          if (cover > 1e-3 && cover < 0.999) {
            const sC = 0.8 * vg + (1 - humid) * (0.5 * relC - 1.6 * vc);
            let m = (QN[(cover * QN_N + 0.5) | 0] * 0.9 - sC) * iwVeg + 0.5;
            m = 0.5 * (Math.abs(m) - Math.abs(m - 1) + 1);
            m = m * m * (3 - 2 * m);
            mC = cover + (m - cover) * MOS_VEG;
          } else if (cover >= 0.999) mC = 1;
          // Forests: along valleys and drainage lines first where trees are marginal (cold or dry:
          // gallery forests, forest-tundra), on the drained hills in humid lowlands; gullies and
          // spurs on slopes.
          let gully = 0, gapK = 0;
          if (trees > 1e-4) {
            if (slope > 0.2 * GULLY_SLOPE) {
              // Downslope gully / spur pattern (derivative across the local slope: stripes run downhill).
              dfx = fineMix(pnoise[pE]) - fineMix(pnoise[pW]);
              dfy = fineMix(pnoise[pN]) - fineMix(pnoise[pS]);
              dfOk = true;
              gully = (-gy * dfx * invCos + gx * dfy) * (GULLY_K / 127) / gl;
              gully = gully / (1 + Math.abs(gully));
              const sw = slope * (1 / GULLY_SLOPE);
              if (sw < 1) gully *= sw;
            }
            const tRel = trees / cover;
            // Patch score: the fractal (multi-scale) patch noise, a little fine noise for rough
            // outlines, and the terrain — drylands: trees in the hollows and gallery forests along
            // the valleys and drainage lines; humid lands: forest on the drained hills, the openings
            // (floodplain meadows, wetlands, clearings) in the hollows and along the valleys.
            // The cold margin (northern taiga, forest-tundra) is marginal for trees like the drylands:
            // they gather in the sheltered, drained valleys there too (the aridity ratio calls every
            // cold climate humid).
            let cold = (TREE_COLD_T1 - twm) * (1 / (TREE_COLD_T1 - TREE_COLD_T0));
            cold = 0.5 * (Math.abs(cold) - Math.abs(cold - 1) + 1);
            const hT = humid * (1 - cold * cold * (3 - 2 * cold));
            const sig = TREE_SIG_DRY + (TREE_SIG_HUMID - TREE_SIG_DRY) * hT;
            const sT = TREE_VG * vg + TREE_LITH * lk + PATCH_IRREG * lf + (TREE_REL_DRY + (TREE_REL_HUMID - TREE_REL_DRY) * hT) * relC
              + (TREE_VLY_DRY + (TREE_VLY_HUMID - TREE_VLY_DRY) * hT) * vc + GULLY_W * gully;
            // Cover-dependent structure: t4 = 4·t·(1 − t) peaks at intermediate tree fractions.
            // Edges soften there (tree-density gradients of savannas and forest-steppe rather than
            // crisp stands), and the mosaic contrast fades toward closed canopy (rare, faint
            // openings) and toward open land (scattered trees: a sub-pixel mix).
            const ti = (tRel * QN_N + 0.5) | 0;
            const qn = QN[ti];
            // Edge widths (score units): soft (colour) and crisp (stand structure under snow).
            let iw = iwTree * TREE_INV[ti], w2 = wTree2 * TREE_W2[ti];
            let iwS = iwTree, w2S = 0.05 * wTree2;
            const du = dTpx * iv25 * (1 / THERMAL_AA_PX);
            if (treeT < 1 && du > RAMP_AA_DU) {
              // Treeline on steep ground: widen the edges with the thermal sweep.
              const g = MOSAIC_AA_PX * sig * rampShift(uTree, du, tRel / treeT > 1 ? 1 : tRel / treeT);
              if (g * iwS > 1) {
                iwS = 1 / g;
                w2S = 0.05 * g * g;
                if (iwS < iw) {
                  iw = iwS;
                  w2 = w2S;
                }
              }
            }
            // Mean-preserving soft threshold: a smoothstep edge W = 1/iw wide spreads the score by
            // ≈ 0.224·W (σ), so the quantile is taken of the widened distribution.
            let m = (qn * Math.sqrt(sig * sig + w2) - sT) * iw + 0.5;
            m = 0.5 * (Math.abs(m) - Math.abs(m - 1) + 1);
            m = m * m * (3 - 2 * m);
            // Summer colour: the mosaic contrast falls toward a closed canopy (shrubby openings).
            const mos = MOS_TREE_DRY + (MOS_TREE - MOS_TREE_DRY) * humid;
            mT = (tRel + (m - tRel) * mos * TREE_AMP[ti]) * mC;
            if (snow > 0) {
              // Under snow the stand structure itself shows: crisp edges, full contrast (open bogs
              // and clearings white in the dark winter taiga).
              let ms = (qn * Math.sqrt(sig * sig + w2S) - sT) * iwS + 0.5;
              ms = 0.5 * (Math.abs(ms) - Math.abs(ms - 1) + 1);
              ms = ms * ms * (3 - 2 * ms);
              mTs = (tRel + (ms - tRel) * mos) * mC;
            } else mTs = mT;
            // Openings within well-wooded humid land are shrubby secondary growth, close to the
            // canopy in tone (not the open grassland of the drier mosaics).
            gapK = GAP_SHRUB * tRel * tRel * humid;
          }
          // Ground: humid soils ↔ desert surfaces, then rock.
          let gR = soilR, gG = soilG, gB = soilB;
          if (des > 0.003) {
            // Deserts: sand seas (ergs) collect in basins and lowlands with crisp edges; elsewhere
            // gravel plains (reg) darkening onto the crests (desert varnish on the outcrops) and
            // brighter alluvium in the wadis.
            let erg = (lk + 0.3 * pn - 0.35 * relC + 0.08 * lf - ERG_T) * (1 / ERG_W);
            erg = 0.5 * (Math.abs(erg) - Math.abs(erg - 1) + 1);
            erg = erg * erg * (3 - 2 * erg);
            let ls = 0.12 + 0.6 * lk + 0.2 * pn;
            ls = 0.5 * (Math.abs(ls + 0.2) - Math.abs(ls - 1) + 0.8);
            let lr = -0.12 + 0.25 * lk + 0.08 * lf - (0.55 + 0.2 * lk) * dcrest + WADI * dl;
            lr = 0.5 * (Math.abs(lr + 0.95) - Math.abs(lr - 0.2) - 0.75);
            const is3 = 3 * (((ls + 1) * 31.5 + 0.5) | 0), ir3 = 3 * (((lr + 1) * 31.5 + 0.5) | 0);
            // Fine texture: dune grain across the prevailing wind in the ergs (directional
            // derivative of the plate-frame fine noises: crests transverse to the wind), gravel
            // speckle elsewhere.
            let sf = 1;
            if (erg > 0.02) {
              if (!dfOk) {
                dfx = fineMix(pnoise[pE]) - fineMix(pnoise[pW]);
                dfy = fineMix(pnoise[pN]) - fineMix(pnoise[pS]);
                dfOk = true;
              }
              const wE = px !== null ? px[pb + PX_WINDE] * PX_W - 1 : w00 * LG[q00 + A_WINDE] + w01 * LG[q01 + A_WINDE] + w10 * LG[q10 + A_WINDE] + w11 * LG[q11 + A_WINDE];
              const wN = px !== null ? px[pb + PX_WINDN] * PX_W - 1 : w00 * LG[q00 + A_WINDN] + w01 * LG[q01 + A_WINDN] + w10 * LG[q10 + A_WINDN] + w11 * LG[q11 + A_WINDN];
              let dune = (wE * dfx * invCos + wN * dfy) * (DUNE_K / 127);
              dune = dune / (1 + Math.abs(dune));
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
          if (rock > 0) {
            const rR = ROCK_DRY[0] + (ROCK_WET[0] - ROCK_DRY[0]) * wet;
            const rG = ROCK_DRY[1] + (ROCK_WET[1] - ROCK_DRY[1]) * wet;
            const rB = ROCK_DRY[2] + (ROCK_WET[2] - ROCK_DRY[2]) * wet;
            gR += (rR - gR) * rock;
            gG += (rG - gG) * rock;
            gB += (rB - gB) * rock;
          }
          // Pixel-scale curvature of the displayed relief (+ crests / convex, − hollows), soft-clamped:
          // albedo that follows the terrain at the finest scale, so it survives magnification on the
          // globe and agrees with its relief shading.
          const curv = dH / (Math.abs(dH) + CURV_M);
          // Relief-coupled bare-ground albedo: bright alluvial valleys, dark eroded crests in drylands.
          const gf = 1 - (REL_DRY * des - REL_WET * (1 - des)) * rel - CURV_DRY * des * curv;
          // Vegetation: herbaceous (→ tundra above the treeline) and canopy.
          let tun = (9 - twm) * iv4 + 0.5;
          tun = 0.5 * (Math.abs(tun) - Math.abs(tun - 1) + 1);
          tun = tun * tun * (3 - 2 * tun);
          let hR = grassR, hG = grassG, hB = grassB;
          if (tun > 0) {
            // Tundra / alpine meadow: mossy green-olive only where it is wet in absolute terms
            // (the aridity ratio calls every cold climate humid): dry high plateaus read as brown
            // alpine steppe.
            const pann = px !== null ? px[pb + PX_PANN] * PX_P : w00 * LG[q00 + A_PANN] + w01 * LG[q01 + A_PANN] + w10 * LG[q10 + A_PANN] + w11 * LG[q11 + A_PANN];
            let wetT = (pann - TUNDRA_P0) * (1 / TUNDRA_P1);
            wetT = 0.5 * (Math.abs(wetT) - Math.abs(wetT - 1) + 1);
            wetT = wetT * wetT * (3 - 2 * wetT);
            if (wet < wetT) wetT = wet;
            hR += (TUNDRA_DRY[0] + (TUNDRA_WET[0] - TUNDRA_DRY[0]) * wetT - hR) * tun;
            hG += (TUNDRA_DRY[1] + (TUNDRA_WET[1] - TUNDRA_DRY[1]) * wetT - hG) * tun;
            hB += (TUNDRA_DRY[2] + (TUNDRA_WET[2] - TUNDRA_DRY[2]) * wetT - hB) * tun;
          }
          // Fine texture (band-limited plate-frame noises, strongest at a few pixels: it survives
          // magnification on the globe): canopy (crowns, gaps, shaded valleys) varies most, grass less.
          const tx = TX_PN * pn + TX_LF * lf + TX_GR * gr;
          if (gapK > 0) {
            hR += (SHRUB_TONE * treeR - hR) * gapK;
            hG += (SHRUB_TONE * treeG - hG) * gapK;
            hB += (SHRUB_TONE * treeB - hB) * gapK;
          }
          // Vegetation: sunlit crests brighter, shaded wet hollows darker; the canopy also varies
          // gently in tone over tens of pixels (stand composition, soils: the lithology noise).
          const vf = 1 + REL_WET * rel + CURV_VEG * curv - VALLEY_DARK * humid * vly;
          const cf = vf * (1 + CANOPY_TEX * tx + CANOPY_TONE * lk), hf = vf * (1 + HERB_TEX * tx);
          const mH = (mC - mT) * hf, mTc = mT * cf, mG = (1 - mC) * gf * (1 + GROUND_TEX * tx);
          R = gR * mG + hR * mH + treeR * mTc;
          G = gG * mG + hG * mH + treeG * mTc;
          B = gB * mG + hB * mH + treeB * mTc;
          if (snow > 0) {
            // Forest canopies hide most of the ground snow (dark winter taiga) — bare deciduous
            // crowns much less (light-grey larch taiga); canopy gaps give it a fine grain.
            let vis = snow;
            if (mTs > 0) {
              // Evergreen vs deciduous stands form a mosaic too (dark spruce / fir in the valleys,
              // larch on the uplands), rather than a blur of the class blend.
              const ever = px !== null ? px[pb + PX_EVER] * PX_U : w00 * LG[q00 + A_EVER] + w01 * LG[q01 + A_EVER] + w10 * LG[q10 + A_EVER] + w11 * LG[q11 + A_EVER];
              const hideD = px !== null ? px[pb + PX_HIDED] * PX_U : w00 * LG[q00 + A_HIDED] + w01 * LG[q01 + A_HIDED] + w10 * LG[q10 + A_HIDED] + w11 * LG[q11 + A_HIDED];
              const sE = 0.7 * vg - 2.2 * vc;
              let mE = (QN[(ever * QN_N + 0.5) | 0] * 0.82 - sE) * iwTree + 0.5;
              mE = 0.5 * (Math.abs(mE) - Math.abs(mE - 1) + 1);
              mE = mE * mE * (3 - 2 * mE);
              let hide = (hideD + (EVERGREEN_SNOW_HIDE - hideD) * mE) * (1 - 0.06 * gr - 0.04 * lf - 0.08 * relC + 0.1 * gully);
              hide = hide > 0.97 ? 0.97 : hide < 0 ? 0 : hide;
              vis *= 1 - hide * mTs;
            }
            // Open snowfields: tall shrubs along the drainage lines and wind-scoured crests show
            // through a little (structure that follows the terrain, not noise).
            let shrub = (tw - 4) * (1 / 5);
            shrub = 0.5 * (Math.abs(shrub) - Math.abs(shrub - 1) + 1);
            shrub = shrub * shrub * (3 - 2 * shrub);
            let scour = (rel - 0.35) * (1 / 0.9);
            scour = 0.5 * (Math.abs(scour) - Math.abs(scour - 1) + 1);
            scour = scour * scour * (3 - 2 * scour);
            vis *= 1 - (1 - mTs) * (SHRUB_SNOW * shrub * dl + SCOUR_SNOW * scour);
            // Shaded snow (valleys, pole-facing) is slightly bluer.
            let sh = -0.6 * rel + 0.3 * asp;
            sh = 0.5 * (Math.abs(sh) - Math.abs(sh - 1) + 1);
            sh = sh * sh * (3 - 2 * sh);
            const sb = 1 + 0.02 * lf;
            const nR = (SNOW[0] + (SNOW_SHADE[0] - SNOW[0]) * sh) * sb;
            const nG = (SNOW[1] + (SNOW_SHADE[1] - SNOW[1]) * sh) * sb;
            const nB = (SNOW[2] + (SNOW_SHADE[2] - SNOW[2]) * sh) * sb;
            R += (nR - R) * vis;
            G += (nG - G) * vis;
            B += (nB - B) * vis;
            snowVis = vis;
          }
          des01 = des;
          // Riparian-forest potential: dry, sparsely wooded land.
          if (surf !== null) ripV = (1 - RIP_HUMID * humid) * (1 - mT);
        } else {
          // Closed ice cover: nothing of the ground shows.
          R = G = B = 0;
        }
        if (iceCov > 0) {
          // Ice surface: bright firn in the accumulation zone (and wherever seasonal snow lies),
          // bare blue-grey glacier ice with darker crevassed margins in the ablation zone, and faint
          // flow stripes parallel to the large-scale surface slope.
          let acc = (-1 - tw) * (1 / 6);
          acc = 0.5 * (Math.abs(acc) - Math.abs(acc - 1) + 1);
          acc = acc * acc * (3 - 2 * acc);
          if (snow > acc) acc = snow;
          const c3e = c + 3 < w ? c + 3 : c + 3 - w, c3w = c >= 3 ? c - 3 : c - 3 + w;
          const r3n = (r >= 3 ? r - 3 : 0) * w, r3s = (r + 3 < h ? r + 3 : h - 1) * w;
          const fx = (height[row + c3e] - height[row + c3w]) * invCos, fy = height[r3n + c] - height[r3s + c];
          const fl = fx * fx + fy * fy;
          let stripe = 0;
          if (fl > 1) {
            const il = 1 / Math.sqrt(fl);
            if (!dfOk) {
              dfx = fineMix(pnoise[pE]) - fineMix(pnoise[pW]);
              dfy = fineMix(pnoise[pN]) - fineMix(pnoise[pS]);
              dfOk = true;
            }
            // Derivative across the flow: stripes along it.
            stripe = (-fy * dfx * invCos + fx * dfy) * il * (STRIPE_K / 127);
            stripe = stripe / (1 + Math.abs(stripe));
          }
          let crev = (slope - 0.08) * (1 / 0.25);
          crev = 0.5 * (Math.abs(crev) - Math.abs(crev - 1) + 1);
          crev = crev * crev * (3 - 2 * crev);
          crev = (1 - acc) * (0.3 + 0.7 * crev) * (0.65 + 0.35 * Math.abs(gr));
          const bR = ICE_BARE[0] + (ICE_CREVASSE[0] - ICE_BARE[0]) * crev;
          const bG = ICE_BARE[1] + (ICE_CREVASSE[1] - ICE_BARE[1]) * crev;
          const bB = ICE_BARE[2] + (ICE_CREVASSE[2] - ICE_BARE[2]) * crev;
          const ib = 1 + (0.045 + 0.07 * (1 - acc)) * stripe + 0.015 * lf;
          R += ((bR + (FIRN[0] - bR) * acc) * ib - R) * iceCov;
          G += ((bG + (FIRN[1] - bG) * acc) * ib - G) * iceCov;
          B += ((bB + (FIRN[2] - bB) * acc) * ib - B) * iceCov;
        }
        // Fine band-limited grain on top (plate-frame: it travels with the land); snowfields and
        // ice stay smooth.
        const smoothWhite = snowVis > iceCov ? snowVis : iceCov;
        const grain = 1 + (GRAIN * lf + FINE_GRAIN * gr) * (1 - 0.8 * smoothWhite);
        R *= grain;
        G *= grain;
        B *= grain;
        if (surf) {
          // Lakes and rivers freeze in a cold month even where there is no snow to cover them.
          let frz = (-3 - ts) * (1 / 4);
          frz = 0.5 * (Math.abs(frz) - Math.abs(frz - 1) + 1);
          let sv = snow > iceCov ? snow : iceCov;
          if (frz > sv) sv = frz;
          surf.snow[p] = (sv * 255 + 0.5) | 0;
          surf.desert[p] = (smooth(0.2, 0.8, des01) * 255 + 0.5) | 0;
          surf.trees[p] = (mTs * 255 + 0.5) | 0;
          surf.ice[p] = (iceCov * 255 + 0.5) | 0;
          surf.rip[p] = (ripV * 255 + 0.5) | 0;
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
        warm = 0.5 * (Math.abs(warm) - Math.abs(warm - 1) + 1);
        warm = warm * warm * (3 - 2 * warm);
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
          fz = 0.5 * (Math.abs(fz) - Math.abs(fz - 1) + 1);
          fz = fz * fz * (3 - 2 * fz);
          let buried = (2 + ICE_FLOW_C * shL - twL) * (1 / 3);
          buried = 0.5 * (Math.abs(buried) - Math.abs(buried - 1) + 1);
          buried = buried * buried * (3 - 2 * buried);
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
          const uI = 0.5 + 0.5 * z / (1 + Math.abs(z));
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
