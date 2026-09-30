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
import * as _satelliteBiome from './satelliteBiome';
import type { SatelliteGrid } from './satelliteBiome';
import * as _satelliteNeutral from './satelliteNeutral';
import * as _satellitePalette from './satellitePalette';
import * as _satelliteSampler from './satelliteSampler';
import * as _satelliteWater from './satelliteWater';
import * as _terrain from './terrain';
import * as _terrainShade from './terrainShade';

// Imported values are copied into module constants: some module runners (vitest / vite-node SSR)
// compile named imports into namespace property reads, which would otherwise sit in per-pixel loops.
const { LAPSE_RATE } = _constants;
const { encodeSrgb } = _colormaps;
const { drawRiversAndLakes } = _rivers;
const {
  A_COVER, A_DESERT, A_GRASS, A_HOT, A_SNOWSUP, A_SOIL, A_TREE, A_TREES, A_TSNOW, A_TWARM, A_WET,
  A_PANN, LAND_K, O_ICE, O_SST, OCEAN_K, buildSatelliteGrid, satelliteClimateOf,
} = _satelliteBiome;
const { neutralSatelliteGrid } = _satelliteNeutral;
const {
  COLD_DESERT, DEPTH_INDEX, DEPTH_LUT_STEP, HOT_DESERT, LAGOON_COLD, LAGOON_WARM, MOTTLE_C, OCEAN_COLD, OCEAN_SRGB,
  OCEAN_WARM, OCEAN_WARM_N, ROCK_DRY, ROCK_WET, SEA_ICE, SEA_ICE_THIN, SNOW, SNOW_SHADE, TUNDRA_DRY, TUNDRA_WET,
} = _satellitePalette;
const { getClimateSampler } = _satelliteSampler;
const { enclosedWater } = _satelliteWater;
const { detailTexture, getHeightField, heightFieldKey, qualityOf } = _terrain;
const { gradientScales, hillshade, shadeExaggeration } = _terrainShade;

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
const MOS_TREE = 0.8;
/** Fine texture amplitudes: forest canopy, grass, bare ground. */
const CANOPY_TEX = 0.16;
const HERB_TEX = 0.07;
const GROUND_TEX = 0.05;
/** Fraction of the snow hidden by forest canopies (winter taiga stays dark). */
const CANOPY_SNOW_HIDE = 0.85;
/** Fine multiplicative grain of the land surface (world-frame texture, and per-pixel hash). */
const GRAIN = 0.035;
const PIXEL_GRAIN = 0.03;
/** Contrast gain of the desert lithology (crisp erg / reg / hamada boundaries). */
const LITH_GAIN = 3.2;
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
  const ex = shadeExaggeration(gs);
  const rgba = new Uint8ClampedArray(4 * w * h);
  const { height, patch, lith, rough, pfine } = hf;
  const { idx, wr, wc, tex: wtex, fine: wfine } = smp;
  const LG = grid.land, OG = grid.ocean;
  const lStride = smp.stride * LAND_K, oStride = smp.stride * OCEAN_K;
  const sea = opts.seaLevel;
  const doShade = opts.hillshade;
  const slopeNorm = gs.slopeNorm;
  const full = qualityOf(opts) === 'full';
  const withRivers = full && opts.rivers !== false && snapshot !== null;
  const enclosed = full && snapshot !== null ? enclosedWater(hf, sea, heightFieldKey(mesh, snapshot, opts), cache) : null;
  // Per-pixel surface state for rivers/lakes (frozen lakes, riparian strips in drylands).
  const surf = withRivers ? { snow: new Uint8Array(w * h), desert: new Uint8Array(w * h) } : null;
  const iW_VEG = 1 / W_VEG, iW_SNOW = 1 / W_SNOW, iW_ICE = 1 / W_ICE;
  const grainSeed = Math.imul(Math.floor(opts.seed) | 0, 0x9e3779b1) ^ w;
  for (let r = 0; r < h; r++) {
    const invDx = gs.invDx[r], invDy = gs.invDy;
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
        const soilR = w00 * LG[q00 + A_SOIL] + w01 * LG[q01 + A_SOIL] + w10 * LG[q10 + A_SOIL] + w11 * LG[q11 + A_SOIL];
        const soilG = w00 * LG[q00 + A_SOIL + 1] + w01 * LG[q01 + A_SOIL + 1] + w10 * LG[q10 + A_SOIL + 1] + w11 * LG[q11 + A_SOIL + 1];
        const soilB = w00 * LG[q00 + A_SOIL + 2] + w01 * LG[q01 + A_SOIL + 2] + w10 * LG[q10 + A_SOIL + 2] + w11 * LG[q11 + A_SOIL + 2];
        const grassR = w00 * LG[q00 + A_GRASS] + w01 * LG[q01 + A_GRASS] + w10 * LG[q10 + A_GRASS] + w11 * LG[q11 + A_GRASS];
        const grassG = w00 * LG[q00 + A_GRASS + 1] + w01 * LG[q01 + A_GRASS + 1] + w10 * LG[q10 + A_GRASS + 1] + w11 * LG[q11 + A_GRASS + 1];
        const grassB = w00 * LG[q00 + A_GRASS + 2] + w01 * LG[q01 + A_GRASS + 2] + w10 * LG[q10 + A_GRASS + 2] + w11 * LG[q11 + A_GRASS + 2];
        const treeR = w00 * LG[q00 + A_TREE] + w01 * LG[q01 + A_TREE] + w10 * LG[q10 + A_TREE] + w11 * LG[q11 + A_TREE];
        const treeG = w00 * LG[q00 + A_TREE + 1] + w01 * LG[q01 + A_TREE + 1] + w10 * LG[q10 + A_TREE + 1] + w11 * LG[q11 + A_TREE + 1];
        const treeB = w00 * LG[q00 + A_TREE + 2] + w01 * LG[q01 + A_TREE + 2] + w10 * LG[q10 + A_TREE + 2] + w11 * LG[q11 + A_TREE + 2];
        const aCover = w00 * LG[q00 + A_COVER] + w01 * LG[q01 + A_COVER] + w10 * LG[q10 + A_COVER] + w11 * LG[q11 + A_COVER];
        const aTrees = w00 * LG[q00 + A_TREES] + w01 * LG[q01 + A_TREES] + w10 * LG[q10 + A_TREES] + w11 * LG[q11 + A_TREES];
        const aTwarm = w00 * LG[q00 + A_TWARM] + w01 * LG[q01 + A_TWARM] + w10 * LG[q10 + A_TWARM] + w11 * LG[q11 + A_TWARM];
        const aTsnow = w00 * LG[q00 + A_TSNOW] + w01 * LG[q01 + A_TSNOW] + w10 * LG[q10 + A_TSNOW] + w11 * LG[q11 + A_TSNOW];
        const aSnowSup = w00 * LG[q00 + A_SNOWSUP] + w01 * LG[q01 + A_SNOWSUP] + w10 * LG[q10 + A_SNOWSUP] + w11 * LG[q11 + A_SNOWSUP];
        const des = w00 * LG[q00 + A_DESERT] + w01 * LG[q01 + A_DESERT] + w10 * LG[q10 + A_DESERT] + w11 * LG[q11 + A_DESERT];
        const hot = w00 * LG[q00 + A_HOT] + w01 * LG[q01 + A_HOT] + w10 * LG[q10 + A_HOT] + w11 * LG[q11 + A_HOT];
        const wet = w00 * LG[q00 + A_WET] + w01 * LG[q01 + A_WET] + w10 * LG[q10 + A_WET] + w11 * LG[q11 + A_WET];
        const hp = H - sea;
        const tw = aTwarm - LAPSE_RATE * hp;
        const ts = aTsnow - LAPSE_RATE * hp;
        const gx = (height[row + (c + 1 < w ? c + 1 : 0)] - height[row + (c > 0 ? c - 1 : w - 1)]) * invDx;
        const gy = (height[rowN + c] - height[rowS + c]) * invDy;
        const slope = Math.sqrt(gx * gx + gy * gy) * slopeNorm;
        const pn = patch[p];
        // Texture noise anchored to the plates (the sampler's world-frame ones would stay put while
        // the land moves under them: crawling mosaics during playback). The sampler's `tex` and
        // `fine` are 0.99-correlated (≈ 0.91 : 1), so one plate-frame channel stands in for both.
        const lf = pfine[p] * (1 / 127), lt = 0.91 * lf;
        // Relief position: + hills and crests, − valleys.
        let rel = 1.6 * pn + rough[p] * (1 / REL_RIDGE_M);
        rel = rel < -1.5 ? -1.5 : rel > 1.5 ? 1.5 : rel;
        // Sub-pixel terrain (valleys vs spurs) mottles the thermal belts: plate-anchored noise
        // shifts the effective temperature by up to ≈ ±2.5 °C (≈ ±400 m of relief).
        const twm = tw + MOTTLE_C * pn;
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
        // Cover fractions → mosaics. Vegetation favours valleys (U small where pn < 0); trees favour
        // hills in humid climates and drainage lines in dry ones.
        const cover = aCover * vegT * (1 - 0.75 * rock);
        let trees = aTrees * treeT;
        if (trees > cover) trees = cover;
        // Grass vs bare ground mixes at the sub-pixel scale (only mildly patchy); forests form
        // distinct patches.
        let z = MOSAIC_K * (pn + 0.5 * lt + 0.35 * lf);
        const uV = 0.5 + 0.5 * z / (1 + (z < 0 ? -z : z));
        let mC0 = (cover * (1 + W_VEG) - uV) * iW_VEG;
        mC0 = mC0 < 0 ? 0 : mC0 > 1 ? 1 : mC0 * mC0 * (3 - 2 * mC0);
        const mC = cover + (mC0 - cover) * MOS_VEG;
        let humid = (wet - 0.4) * (1 / 0.3);
        humid = humid < 0 ? 0 : humid > 1 ? 1 : humid * humid * (3 - 2 * humid);
        z = MOSAIC_K * ((0.8 - 1.6 * humid) * pn + 0.7 * lt - 0.45 * lf);
        const uT = 0.5 + 0.5 * z / (1 + (z < 0 ? -z : z));
        const tRel = cover > 1e-4 ? trees / cover : 0;
        let mT0 = (tRel * (1 + W_VEG) - uT) * iW_VEG;
        mT0 = mT0 < 0 ? 0 : mT0 > 1 ? 1 : mT0 * mT0 * (3 - 2 * mT0);
        const mT = (tRel + (mT0 - tRel) * MOS_TREE) * mC;
        // Ground: humid soils ↔ desert sands/gravels chosen by plate-anchored lithology (ergs with
        // crisp edges, darker regs and hamadas), then rock.
        let li = lith[p] + 0.5 * pn;
        li = li < -1 ? -1 : li > 1 ? 1 : li;
        li = li * (LITH_GAIN - (LITH_GAIN - 1) * (li < 0 ? -li : li));
        li = li < -1 ? -1 : li > 1 ? 1 : li;
        const li3 = 3 * (((li + 1) * 31.5 + 0.5) | 0);
        const dune = 1 + 0.06 * lf * des;
        const sR = ((HOT_DESERT[li3] - COLD_DESERT[li3]) * hot + COLD_DESERT[li3]) * dune;
        const sG = ((HOT_DESERT[li3 + 1] - COLD_DESERT[li3 + 1]) * hot + COLD_DESERT[li3 + 1]) * dune;
        const sB = ((HOT_DESERT[li3 + 2] - COLD_DESERT[li3 + 2]) * hot + COLD_DESERT[li3 + 2]) * dune;
        let gR = soilR + (sR - soilR) * des;
        let gG = soilG + (sG - soilG) * des;
        let gB = soilB + (sB - soilB) * des;
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
        const tx = 1.2 * pn + 0.6 * lf;
        const vf = 1 + REL_WET * rel;
        const cf = vf * (1 + CANOPY_TEX * tx), hf = vf * (1 + HERB_TEX * tx);
        const mH = (mC - mT) * hf, mTc = mT * cf, mG = (1 - mC) * gf * (1 + GROUND_TEX * tx);
        R = gR * mG + hR * mH + treeR * mTc;
        G = gG * mG + hG * mH + treeG * mTc;
        B = gB * mG + hB * mH + treeB * mTc;
        // Snow (seasonal, lapse-corrected) and permanent ice. The snow fraction becomes a mosaic
        // ordered by relief and aspect (high ground and pole-facing slopes first) with crisp edges;
        // ice sheets need a freezing summer (and some precipitation only near their margins).
        // Glaciers / ice sheets: summer means below ≈ +2 °C at the pixel (peaks of the relief
        // detail included); nourished by precipitation near that limit, by cold alone well below.
        let ice = (2 - twm + 2 * lt) * (1 / 3);
        ice = ice < 0 ? 0 : ice > 1 ? 1 : ice * ice * (3 - 2 * ice);
        if (ice > 0) {
          const pa = w00 * LG[q00 + A_PANN] + w01 * LG[q01 + A_PANN] + w10 * LG[q10 + A_PANN] + w11 * LG[q11 + A_PANN] + 0.08 * lt;
          let nour = (pa - 0.02) * (1 / 0.45);
          nour = nour < 0 ? 0 : nour > 1 ? 1 : nour * nour * (3 - 2 * nour);
          let cold = (-3 - twm) * (1 / 4);
          cold = cold < 0 ? 0 : cold > 1 ? 1 : cold * cold * (3 - 2 * cold);
          ice *= nour > cold ? nour : cold;
        }
        let sT = (1 - ts - 0.5 * MOTTLE_C * pn) * (1 / 5);
        sT = sT < 0 ? 0 : sT > 1 ? 1 : sT * sT * (3 - 2 * sT);
        sT *= aSnowSup;
        if (ice > sT) sT = ice;
        let snow = 0;
        if (sT > 0) {
          // Seasonal snow and ice caps alike become crisp patches on the high ground first.
          let asp = aspSign * gy;
          asp = asp < -1 ? -1 : asp > 1 ? 1 : asp;
          z = MOSAIC_K * (-0.8 * rel - 0.55 * asp + 0.3 * lt + 0.2 * lf);
          const uS = 0.5 + 0.5 * z / (1 + (z < 0 ? -z : z));
          snow = (sT * (1 + W_SNOW) - uS) * iW_SNOW;
          snow = snow < 0 ? 0 : snow > 1 ? 1 : snow * snow * (3 - 2 * snow);
        }
        if (snow > 0) {
          // Steep rock walls shed snow; ice sheets only show nunataks on the steepest faces.
          let shed = (slope - 0.28) * (1 / 0.3);
          shed = shed < 0 ? 0 : shed > 1 ? 1 : shed * shed * (3 - 2 * shed);
          snow *= 1 - shed * (0.6 - 0.45 * ice);
          // Forest canopies stay dark above the snow (winter taiga), less so on ice.
          // Canopy gaps (texture) let some snow through.
          let hide = CANOPY_SNOW_HIDE * (1 - 0.35 * tx);
          hide = hide > 0.95 ? 0.95 : hide < 0 ? 0 : hide;
          const vis = snow * (1 - hide * mT * (1 - ice));
          // Shaded snow (valleys, pole-facing) is slightly bluer; fine grain on seasonal snow.
          let sh = -0.6 * rel;
          sh = sh < 0 ? 0 : sh > 1 ? 1 : sh * sh * (3 - 2 * sh);
          sh *= 1 - ice;
          const sb = 1 + 0.03 * lf - 0.04 * ice * (pn < 0 ? -pn : pn);
          const nR = (SNOW[0] + (SNOW_SHADE[0] - SNOW[0]) * sh) * sb;
          const nG = (SNOW[1] + (SNOW_SHADE[1] - SNOW[1]) * sh) * sb;
          const nB = (SNOW[2] + (SNOW_SHADE[2] - SNOW[2]) * sh) * sb;
          R += (nR - R) * vis;
          G += (nG - G) * vis;
          B += (nB - B) * vis;
        }
        // Static pixel-scale grain (hash) on top of the band-limited textures.
        let hs = Math.imul(p ^ grainSeed, 0x27d4eb2d);
        hs ^= hs >>> 15;
        hs = Math.imul(hs, 0x2c1b3c6d);
        hs ^= hs >>> 12;
        const grain = 1 + GRAIN * lf + PIXEL_GRAIN * ((hs & 1023) * (1 / 511.5) - 1);
        R *= grain;
        G *= grain;
        B *= grain;
        if (surf) {
          // Lakes and rivers freeze in a cold month even where there is no snow to cover them.
          let frz = (-3 - ts) * (1 / 4);
          frz = frz < 0 ? 0 : frz > 1 ? 1 : frz;
          surf.snow[p] = ((snow > frz ? snow : frz) * 255 + 0.5) | 0;
          surf.desert[p] = (smooth(0.2, 0.8, des) * 255 + 0.5) | 0;
        }
        if (doShade) {
          const f = 1 + 0.7 * (hillshade(gx, gy, ex) - 1);
          R *= f;
          G *= f;
          B *= f;
        }
      } else {
        // ---- ocean -------------------------------------------------------------------------
        const q00 = i00 * OCEAN_K, q01 = q00 + OCEAN_K, q10 = q00 + oStride, q11 = q10 + OCEAN_K;
        const iceF = w00 * OG[q00 + O_ICE] + w01 * OG[q01 + O_ICE] + w10 * OG[q10 + O_ICE] + w11 * OG[q11 + O_ICE];
        const sst = w00 * OG[q00 + O_SST] + w01 * OG[q01 + O_SST] + w10 * OG[q10 + O_SST] + w11 * OG[q11 + O_SST];
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
          // Small enclosed water body (lagoon / flooded hollow): still, dark water.
          R = LAGOON_COLD[0] + (LAGOON_WARM[0] - LAGOON_COLD[0]) * warm;
          G = LAGOON_COLD[1] + (LAGOON_WARM[1] - LAGOON_COLD[1]) * warm;
          B = LAGOON_COLD[2] + (LAGOON_WARM[2] - LAGOON_COLD[2]) * warm;
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
  if (surf) drawRiversAndLakes(rgba, hf, heightFieldKey(mesh, snapshot, opts), climate, opts, cache, surf);
  return rgba;
}
