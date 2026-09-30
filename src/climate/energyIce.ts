/**
 * Ice-sheet surface elevation feedback of the land snow/ice mass balance (energyStep.ts).
 *
 * A glacier that survives grows into an ice sheet whose surface rises far above its bed: a
 * perfectly plastic ice sheet (Nye 1951) has thickness H(d) = sqrt(2·τ₀·d / (ρ_i·g)) at distance d
 * from its margin (τ₀ ≈ 50–100 kPa: ≈ 3 km at 1000 km, Antarctica; ≈ 3 km at 400 km, Greenland),
 * and isostasy lowers its bed by ≈ ρ_i/ρ_m ≈ 0.3·H. The surface of a glaciated land cell is
 *
 *   h = h_bed + G·(max(h_bed, min(iceSheetMaxHeight, iceProfileScale·sqrt(d_km))) − h_bed)
 *
 * with G its glacier weight: it only ever raises the surface, so hand-authored ice-sheet
 * elevations (the Earth input already includes Greenland's and Antarctica's ice) are kept. The raise
 * is what makes a large polar continent glaciate robustly (its interior climbs out of the melt zone)
 * while small or low-latitude ice caps, which cannot build a dome before the surrounding warm air
 * melts them, stay small. Recomputed once per model year from the glacier mask; the land lapse and
 * free-troposphere coupling of the energy balance follow the new surface.
 */
import { LAPSE_RATE } from '../core/constants';
import { glacierWeight, type EbmModel, type EbmState } from './energy';
import { nearestValidIndex } from './numerics';
import { ebmTuning } from './tuning';

/** Surface raise (m) of land cells above their bed from the current glacier mask (0 elsewhere). */
export function iceSurfaceRaise(M: EbmModel, S: EbmState, out: Float64Array): Float64Array {
  const t = ebmTuning;
  const { g, land, bedHeight } = M;
  const { nx, ny, n } = g;
  out.fill(0);
  if (!(t.iceProfileScale > 0)) return out;
  // Margin: every cell that is not (mostly) glacier.
  const open = new Uint8Array(n);
  let anyIce = false;
  let anyOpen = false;
  for (let i = 0; i < n; i++) {
    const ice = land[i] === 1 && glacierWeight(S.M[i]) >= 0.5;
    open[i] = ice ? 0 : 1;
    if (ice) anyIce = true;
    else anyOpen = true;
  }
  if (!anyIce) return out;
  const near = anyOpen ? nearestValidIndex(nx, ny, open) : null;
  const R = 6371;
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!land[i]) continue;
      const G = glacierWeight(S.M[i]);
      if (G <= 0) continue;
      let dKm: number;
      if (!near || near[i] < 0) dKm = Math.PI * R;
      else if (open[i]) dKm = 0;
      else {
        const k = near[i];
        const j2 = (k / nx) | 0;
        const c2 = k - j2 * nx;
        // Great-circle distance between cell centers; the margin lies half a cell beyond the center.
        const cosD = g.sinLat[j] * g.sinLat[j2] + g.cosLat[j] * g.cosLat[j2] * Math.cos(g.lon[c] - g.lon[c2]);
        dKm = Math.max(0, R * Math.acos(Math.max(-1, Math.min(1, cosD))) - 0.5 * R * g.dLat);
      }
      const profile = Math.min(t.iceSheetMaxHeight, t.iceProfileScale * Math.sqrt(dKm + t.iceProfileEdgeKm));
      const bed = bedHeight[i];
      out[i] = profile > bed ? G * (profile - bed) : 0;
    }
  }
  return out;
}

/** Update the land lapse and free-troposphere coupling of `M` for the current ice surface of `S`. */
export function applyIceSurface(M: EbmModel, S: EbmState): void {
  const raise = iceSurfaceRaise(M, S, M.work.dep);
  const { land, bedHeight, lapse, freeTrop } = M;
  const t = ebmTuning;
  for (let i = 0; i < M.g.n; i++) {
    if (!land[i]) continue;
    const h = bedHeight[i] + raise[i];
    M.iceRaise[i] = raise[i];
    lapse[i] = LAPSE_RATE * h;
    const x = h / t.freeTropHeight;
    freeTrop[i] = t.freeTropCoupling * Math.min(1, x * x);
  }
}

/**
 * Ice flow, in its simplest budget form: an ice sheet's ablation zone is fed by flow from its
 * accumulation zone. For every connected glacier region of last year's mask the ablating cells get
 * their annual deficit (melt − snowfall) back, scaled by f = min(1, surplus / deficit) with the
 * surplus the region's area-integrated net accumulation. A sheet whose accumulation outweighs its
 * margin melt keeps its extent (ablation-area ratio set by its own climate); one whose margin melt
 * dominates shrinks, faster the smaller its accumulation area. Cells whose ice melted out during
 * the year are no longer part of the sheet. Resets the yearly accumulators.
 */
export function applyIceFlow(M: EbmModel, S: EbmState): void {
  const { g, land, iceMask, accY, ablY, minY } = M;
  const { nx, ny, n } = g;
  const t = ebmTuning;
  if (M.iceYears > 0) {
    const region = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    for (let s0 = 0; s0 < n; s0++) {
      if (!iceMask[s0] || region[s0] >= 0) continue;
      // Flood the region (4-neighbourhood, longitude wraps).
      let head = 0;
      let tail = 0;
      queue[tail++] = s0;
      region[s0] = s0;
      let surplus = 0;
      let deficit = 0;
      while (head < tail) {
        const i = queue[head++];
        const j = (i / nx) | 0;
        const c = i - j * nx;
        const b = (accY[i] - ablY[i]) * g.area[j];
        if (b > 0) surplus += b;
        else deficit -= b;
        const nb0 = j * nx + (c === 0 ? nx - 1 : c - 1);
        const nb1 = j * nx + (c === nx - 1 ? 0 : c + 1);
        const nb2 = j > 0 ? i - nx : -1;
        const nb3 = j < ny - 1 ? i + nx : -1;
        for (const k of [nb0, nb1, nb2, nb3]) {
          if (k >= 0 && iceMask[k] && region[k] < 0) {
            region[k] = s0;
            queue[tail++] = k;
          }
        }
      }
      if (!(deficit > 0)) continue;
      const f = Math.min(1, surplus / deficit);
      for (let q = 0; q < tail; q++) {
        const i = queue[q];
        const d = ablY[i] - accY[i];
        // Cells whose ice melted out during the year left the sheet (no ice to flow into).
        if (d > 0 && minY[i] > 0) S.M[i] = Math.min(t.glacierMassMax, S.M[i] + f * d);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    iceMask[i] = land[i] === 1 && glacierWeight(S.M[i]) >= 0.5 ? 1 : 0;
    accY[i] = 0;
    ablY[i] = 0;
    minY[i] = S.M[i];
  }
  M.iceYears++;
}
