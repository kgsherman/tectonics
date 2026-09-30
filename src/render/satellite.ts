/**
 * Satellite layer (SPEC §7, the showcase): Köppen-driven surface attributes sampled through the
 * warped climate sampler, per-pixel lapse-corrected alpine belts (treeline, tundra, bare rock,
 * snow line, ice caps), terrain-anchored patchiness, depth/SST-tinted oceans with shelves, monthly
 * sea ice and snow, optional hillshade, rivers & lakes at full quality. Blending in linear light,
 * sRGB encoding at the end. Land vs sea is decided only by the height map.
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
  COLD_DESERT, DEPTH_MAX, DEPTH_N, HOT_DESERT, LAGOON_COLD, LAGOON_WARM, MOTTLE_C, OCEAN_COLD, OCEAN_WARM,
  ROCK_DRY, ROCK_WET, SEA_ICE, SNOW, TUNDRA_DRY, TUNDRA_WET,
} = _satellitePalette;
const { getClimateSampler } = _satelliteSampler;
const { enclosedWater } = _satelliteWater;
const { detailTexture, getHeightField, heightFieldKey, qualityOf } = _terrain;
const { gradientScales, hillshade, shadeExaggeration } = _terrainShade;

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
  const { height, patch, lith, rough } = hf;
  const { idx, wr, wc, tex: wtex, fine: wfine } = smp;
  const LG = grid.land, OG = grid.ocean;
  const lStride = smp.stride * LAND_K, oStride = smp.stride * OCEAN_K;
  const sea = opts.seaLevel;
  const doShade = opts.hillshade;
  const slopeNorm = gs.slopeNorm;
  const a = new Float64Array(LAND_K);
  const full = qualityOf(opts) === 'full';
  const withRivers = full && opts.rivers !== false && snapshot !== null;
  const enclosed = full && snapshot !== null ? enclosedWater(hf, sea, heightFieldKey(mesh, snapshot, opts), cache) : null;
  // Per-pixel surface state for rivers/lakes (frozen lakes, riparian strips in drylands).
  const surf = withRivers ? { snow: new Uint8Array(w * h), desert: new Uint8Array(w * h) } : null;
  for (let r = 0; r < h; r++) {
    const invDx = gs.invDx[r], invDy = gs.invDy;
    const row = r * w;
    const rowN = (r > 0 ? r - 1 : 0) * w, rowS = (r < h - 1 ? r + 1 : h - 1) * w;
    for (let c = 0; c < w; c++) {
      const p = row + c;
      const H = height[p];
      const i00 = idx[p];
      const fr = wr[p] * (1 / 65535), fc = wc[p] * (1 / 65535);
      const w00 = (1 - fr) * (1 - fc), w01 = (1 - fr) * fc, w10 = fr * (1 - fc), w11 = fr * fc;
      let R: number, G: number, B: number;
      if (H > sea) {
        // ---- land --------------------------------------------------------------------------
        const q00 = i00 * LAND_K, q01 = q00 + LAND_K, q10 = q00 + lStride, q11 = q10 + LAND_K;
        for (let k = 0; k < LAND_K; k++) a[k] = w00 * LG[q00 + k] + w01 * LG[q01 + k] + w10 * LG[q10 + k] + w11 * LG[q11 + k];
        const hp = H - sea;
        const tw = a[A_TWARM] - LAPSE_RATE * hp;
        const ts = a[A_TSNOW] - LAPSE_RATE * hp;
        const gx = (height[row + (c + 1 < w ? c + 1 : 0)] - height[row + (c > 0 ? c - 1 : w - 1)]) * invDx;
        const gy = (height[rowN + c] - height[rowS + c]) * invDy;
        const slope = Math.sqrt(gx * gx + gy * gy) * slopeNorm;
        const pn = patch[p];
        // Sub-pixel terrain (valleys vs spurs) mottles the thermal belts: plate-anchored noise
        // shifts the effective temperature by up to ≈ ±2.5 °C (≈ ±400 m of relief).
        const twm = tw + MOTTLE_C * pn;
        // Temperature-limited vegetation: continuous re-classification by the pixel's own warmest
        // month (treeline ≈ 10 °C, vegetation limit ≈ 0 °C).
        const vegT = ss((twm + 1) * (1 / 7));
        const treeT = ss((twm - 9) * (1 / 2.5));
        let cover = a[A_COVER] * vegT;
        let trees = a[A_TREES] * treeT;
        // Terrain-anchored patchiness ∝ c(1−c): valleys (pn < 0) greener, hills/ridges drier.
        cover -= 2.2 * pn * cover * (1 - cover);
        trees -= 2.8 * pn * trees * (1 - trees);
        cover = cover < 0 ? 0 : cover > 1 ? 1 : cover;
        trees = trees < 0 ? 0 : trees > cover ? cover : trees;
        // Bare rock: steep slopes, crests of mountain ridges, and above the vegetation limit.
        const crest = ss((rough[p] - 120) * (1 / 780));
        let rock = ss((slope - 0.1) * (1 / 0.22)) + 0.75 * crest * (1 - treeT) + 0.6 * (1 - vegT);
        rock = rock > 1 ? 1 : rock;
        // Soil: humid soils ↔ desert sands/gravels chosen by plate-anchored lithology.
        // Lithology + fine noise, contrast-expanded around 0 so sand seas and rocky plateaus have
        // distinct, fairly crisp boundaries.
        let li = lith[p] + 0.45 * pn;
        li = li < -1 ? -1 : li > 1 ? 1 : li;
        li = li * (1.9 - 0.9 * (li < 0 ? -li : li));
        const li3 = 3 * (((li + 1) * 31.5 + 0.5) | 0);
        const hot = a[A_HOT], des = a[A_DESERT], wet = a[A_WET];
        const dune = 1 + 0.12 * pn * des;
        const sR = ((HOT_DESERT[li3] - COLD_DESERT[li3]) * hot + COLD_DESERT[li3]) * dune;
        const sG = ((HOT_DESERT[li3 + 1] - COLD_DESERT[li3 + 1]) * hot + COLD_DESERT[li3 + 1]) * dune;
        const sB = ((HOT_DESERT[li3 + 2] - COLD_DESERT[li3 + 2]) * hot + COLD_DESERT[li3 + 2]) * dune;
        let gR = a[A_SOIL] + (sR - a[A_SOIL]) * des;
        let gG = a[A_SOIL + 1] + (sG - a[A_SOIL + 1]) * des;
        let gB = a[A_SOIL + 2] + (sB - a[A_SOIL + 2]) * des;
        const rR = ROCK_DRY[0] + (ROCK_WET[0] - ROCK_DRY[0]) * wet;
        const rG = ROCK_DRY[1] + (ROCK_WET[1] - ROCK_DRY[1]) * wet;
        const rB = ROCK_DRY[2] + (ROCK_WET[2] - ROCK_DRY[2]) * wet;
        gR += (rR - gR) * rock;
        gG += (rG - gG) * rock;
        gB += (rB - gB) * rock;
        // Vegetation: herbaceous (→ tundra above the treeline) and canopy.
        const tun = 1 - ss((twm - 7) * (1 / 4));
        const tR = TUNDRA_DRY[0] + (TUNDRA_WET[0] - TUNDRA_DRY[0]) * wet;
        const tG = TUNDRA_DRY[1] + (TUNDRA_WET[1] - TUNDRA_DRY[1]) * wet;
        const tB = TUNDRA_DRY[2] + (TUNDRA_WET[2] - TUNDRA_DRY[2]) * wet;
        const hR = a[A_GRASS] + (tR - a[A_GRASS]) * tun;
        const hG = a[A_GRASS + 1] + (tG - a[A_GRASS + 1]) * tun;
        const hB = a[A_GRASS + 2] + (tB - a[A_GRASS + 2]) * tun;
        const tf = cover > 1e-4 ? trees / cover : 0;
        const vR = hR + (a[A_TREE] - hR) * tf;
        const vG = hG + (a[A_TREE + 1] - hG) * tf;
        const vB = hB + (a[A_TREE + 2] - hB) * tf;
        const vc = cover * (1 - 0.75 * rock);
        R = gR + (vR - gR) * vc;
        G = gG + (vG - gG) * vc;
        B = gB + (vB - gB) * vc;
        // Snow (seasonal, lapse-corrected) and permanent ice; steep rock sheds snow.
        // Glaciers need both a freezing summer and enough precipitation to nourish them.
        const ice = ss((1 - twm) * (1 / 2)) * ss((a[A_PANN] - 0.12) * (1 / 0.4));
        let snow = ss((1 - ts - MOTTLE_C * pn) * (1 / 5)) * a[A_SNOWSUP] * (1 - 0.55 * trees);
        if (ice > snow) snow = ice;
        // Steep rock walls shed snow; even ice fields show nunataks on the steepest faces.
        snow *= 1 - ss((slope - 0.2) * (1 / 0.3)) * (0.5 - 0.25 * ice);
        const snowBright = 1 - 0.07 * ice * (pn > 0 ? pn : -pn);
        const nR = SNOW[0] * snowBright, nG = SNOW[1] * snowBright, nB = SNOW[2] * snowBright;
        R += (nR - R) * snow;
        G += (nG - G) * snow;
        B += (nB - B) * snow;
        if (surf) {
          surf.snow[p] = (snow * 255 + 0.5) | 0;
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
        // Depth ramps are indexed on a sqrt scale (fine near the coast, no log per pixel).
        let di = (Math.sqrt((sea - H) * (1 / DEPTH_MAX)) * (DEPTH_N - 1) + 0.5) | 0;
        if (di >= DEPTH_N) di = DEPTH_N - 1;
        const warm = ss((sst - 8) * (1 / 16));
        const d3 = 3 * di;
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
        if (iceF > 0.02) {
          // Pack ice: world-frame-noise-perturbed concentration → gradual, granular marginal ice
          // zone; thin (low concentration) ice is greyer, leads darken the pack along the
          // fine-noise zero crossings.
          const tn = wtex[p] * (1 / 127), tf = wfine[p] * (1 / 127);
          const eff = iceF + 0.3 * tf + 0.08 * tn;
          const cov = ss((eff - 0.12) * (1 / 0.6));
          const lead = 1 - 0.14 * (1 - ss((tf < 0 ? -tf : tf) * (1 / 0.16))) * iceF;
          const br = (0.74 + 0.2 * (eff > 1 ? 1 : eff < 0 ? 0 : eff) + 0.05 * tn) * lead;
          R += (SEA_ICE[0] * br - R) * cov;
          G += (SEA_ICE[1] * br - G) * cov;
          B += (SEA_ICE[2] * br - B) * cov;
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
