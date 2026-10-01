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
 * melts them, stay small. Recomputed once per model year from the glacier mask; the land lapse,
 * free-troposphere coupling and air-diffusion couplings of the energy balance follow the new surface
 * (a grown sheet is a high polar plateau, decoupled from the eddies by its surface inversion).
 */
import { LAPSE_RATE } from '../core/constants';
import { airDiffusionCouplings, glacierWeight, type EbmModel, type EbmState } from './energy';
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
    // The glacier mask of the year (applyIceFlow), not the mass: deep seasonal snow is not a sheet.
    const ice = land[i] === 1 && M.iceMask[i] === 1;
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
      const G = open[i] ? 0 : glacierWeight(S.M[i]);
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

/**
 * Update the land lapse, free-troposphere coupling and air-diffusion couplings of `M` for the current
 * ice surface of `S`. A grown ice sheet is a high polar plateau like any other: its strong surface
 * inversion decouples it from the transient eddies (ebmTuning.iceSheetDiffusionFactor), so warm air
 * from bare land around it does not mix into its interior.
 */
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
  const h = M.work.F;
  for (let i = 0; i < M.g.n; i++) h[i] = land[i] ? bedHeight[i] + M.iceRaise[i] : 0;
  airDiffusionCouplings(M.g, land, h, M.tilt, M.kE, M.kN, M.kS);
}

/**
 * Ice flow and glacier margins, in budget form, once per model year from last year's accumulators.
 *
 * Every connected glacier region of last year's mask has a surplus (area-integrated net
 * accumulation of its accumulation zone) and a deficit (net ablation of its ablation zone). Ice flow
 * carries the surplus to the margin, so the margin settles where the two balance (the
 * accumulation-area ratio of the sheet's own climate):
 *  - deficit > surplus: the margin retreats — the most strongly ablating cells melt out, until the
 *    remaining ablation zone is fed by the accumulation;
 *  - surplus > deficit: the sheet advances onto adjacent bare land, best-placed cells first (least
 *    melt left over once their seasonal snow is gone, `potY`), as far as the surplus can feed their
 *    ablation;
 *  - the ablation zone of a sheet in balance gets its annual loss back (flow from upstream).
 * Cells whose ice melted out during the year have left their sheet. The core of a cold-start sheet
 * (deeper than ebmTuning.glacierCoreKm inside its initial margin) is never removed, unless the sheet
 * did not sustain itself in the first year of the run (releaseMeltedCore). Bare land
 * nucleates new ice where its snow survived the year with a positive balance. Conversions are
 * immediate (a whole ice cap forms or disappears), so the margins converge within a few years;
 * topology changes only at the first ebmTuning.glacierTopologyYears year boundaries of a run
 * (M.iceUpdates; inside the cold pass 1, identical for every schedule) and is held afterwards (mask
 * kept, sheets nourished, bare land kept below glacier mass), which makes the glacier state
 * independent of the run length and of warm starts.
 * Resets the yearly accumulators.
 */
export function applyIceFlow(M: EbmModel, S: EbmState): void {
  const { g, land, iceMask, accY, ablY, potY, minY } = M;
  const { n } = g;
  const t = ebmTuning;
  // The mask is read from the mass only for the initial state; afterwards the topology update sets
  // it from the sheets' budgets (a bare cell's deep winter snow at the year boundary is not glacier)
  // and the held topology keeps it.
  if (M.iceYears === 0) {
    for (let i = 0; i < n; i++) iceMask[i] = land[i] === 1 && glacierWeight(S.M[i]) >= 0.5 ? 1 : 0;
    marginDistanceKm(M, iceMask, M.iceCoreKm);
  } else if (M.iceUpdates > 0) {
    if (M.iceYears === 1) releaseMeltedCore(M);
    updateIceTopology(M, S);
    M.iceUpdates--;
  } else holdIceTopology(M, S);
  for (let i = 0; i < n; i++) {
    accY[i] = 0;
    ablY[i] = 0;
    potY[i] = 0;
    minY[i] = S.M[i];
  }
  M.iceYears++;
}

/**
 * Held topology (the mask itself is kept): sheets are nourished by flow from upstream, bare land
 * keeps its snow below glacier mass (no perennial build-up that would depend on the run length).
 */
function holdIceTopology(M: EbmModel, S: EbmState): void {
  const { land, iceMask } = M;
  const t = ebmTuning;
  for (let i = 0; i < M.g.n; i++) {
    if (!land[i]) continue;
    if (iceMask[i]) {
      if (S.M[i] < t.glacierMassMax) S.M[i] = t.glacierMassMax;
    } else if (S.M[i] > t.glacierMassLow) {
      S.M[i] = t.glacierMassLow;
      if (S.Ms[i] > S.M[i]) S.Ms[i] = S.M[i];
    }
  }
}

/** Neighbours (4-connected, longitude wraps) of cell i into out; returns the count. */
function neighbours4(nx: number, ny: number, i: number, out: Int32Array): number {
  const j = (i / nx) | 0;
  const c = i - j * nx;
  let k = 0;
  out[k++] = j * nx + (c === 0 ? nx - 1 : c - 1);
  out[k++] = j * nx + (c === nx - 1 ? 0 : c + 1);
  if (j > 0) out[k++] = i - nx;
  if (j < ny - 1) out[k++] = i + nx;
  return k;
}

/**
 * Great-circle distance (km) of every glacier cell of `mask` from the nearest non-glacier cell
 * (centre to centre); 0 elsewhere. With no non-glacier cell at all, half the circumference.
 */
function marginDistanceKm(M: EbmModel, mask: Uint8Array, out: Float64Array): void {
  const { g } = M;
  const { nx, ny, n } = g;
  out.fill(0);
  const open = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    open[i] = mask[i] ? 0 : 1;
    if (open[i]) any = true;
  }
  const near = any ? nearestValidIndex(nx, ny, open) : null;
  const R = 6371;
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!mask[i]) continue;
      if (!near || near[i] < 0) {
        out[i] = Math.PI * R;
        continue;
      }
      const k = near[i];
      const j2 = (k / nx) | 0;
      const c2 = k - j2 * nx;
      const cosD = g.sinLat[j] * g.sinLat[j2] + g.cosLat[j] * g.cosLat[j2] * Math.cos(g.lon[c] - g.lon[c2]);
      out[i] = R * Math.acos(Math.max(-1, Math.min(1, cosD)));
    }
  }
}

/**
 * First topology update of a run: the year just integrated is the cold start's own climate on the
 * ice-covered branch (ice albedo, surfaces starting at ≤ 0 °C). A sheet whose core mostly melted out
 * in that summer, with melt to spare on the bare ground (more than ebmTuning.glacierCoreReleaseShare
 * of its core area; e.g. a polar continent under high-obliquity summers), is not sustained by its
 * own climate: its core loses its protection and the mass balance decides, as for any other ice.
 * Otherwise the held mask would report an ice sheet under +15…+25 °C summers that melt it out every
 * year (Köppen C/D under white ice). Per sheet, not per cell: releasing the low outer ring of a
 * large sheet that does sustain itself would lower its dome and warm the next ring in turn.
 */
function releaseMeltedCore(M: EbmModel): void {
  const { g, iceMask, iceCoreKm, minY, potY } = M;
  const { nx, ny, n } = g;
  const t = ebmTuning;
  const region = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const nb = new Int32Array(4);
  for (let s0 = 0; s0 < n; s0++) {
    if (!iceMask[s0] || region[s0] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s0;
    region[s0] = s0;
    let coreArea = 0;
    let meltedArea = 0;
    while (head < tail) {
      const i = queue[head++];
      if (iceCoreKm[i] > t.glacierCoreKm) {
        const a = g.area[(i / nx) | 0];
        coreArea += a;
        if (minY[i] <= 0 && potY[i] > t.glacierCoreReleaseMelt) meltedArea += a;
      }
      const k = neighbours4(nx, ny, i, nb);
      for (let q = 0; q < k; q++) {
        const m = nb[q];
        if (iceMask[m] && region[m] < 0) {
          region[m] = s0;
          queue[tail++] = m;
        }
      }
    }
    if (coreArea > 0 && meltedArea > t.glacierCoreReleaseShare * coreArea) for (let q = 0; q < tail; q++) iceCoreKm[queue[q]] = 0;
  }
}

function updateIceTopology(M: EbmModel, S: EbmState): void {
  const { g, land, iceMask, accY, ablY, potY, minY } = M;
  const { nx, ny, n } = g;
  const t = ebmTuning;
  const mMax = t.glacierMassMax;
  const mLow = t.glacierMassLow;
  const area = (i: number): number => g.area[(i / nx) | 0];
  // Annual balance including the melt left over on bare ground (kg/m²/yr).
  const bal = new Float64Array(n);
  for (let i = 0; i < n; i++) if (land[i]) bal[i] = accY[i] - ablY[i] - potY[i];
  // 1 = ice, 0 = bare, −1 = melted out / removed this year (not re-added).
  const state = new Int8Array(n);
  // The interior of an initial ice sheet (farther than glacierCoreKm from its initial margin) is
  // never removed: a sheet that size is kilometres thick, its cold, high surface sustains it, and
  // its response time far exceeds the climate's; only its margins adjust to the mass balance.
  const core = M.iceCoreKm;
  const coreKm = t.glacierCoreKm;
  for (let i = 0; i < n; i++) {
    if (!iceMask[i]) continue;
    if (minY[i] > 0 || core[i] > coreKm) state[i] = 1;
    else {
      state[i] = -1;
      if (S.M[i] > mLow) S.M[i] = mLow;
      if (S.Ms[i] > S.M[i]) S.Ms[i] = S.M[i];
    }
  }
  const region = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const nb = new Int32Array(4);
  // Max-heap of advance candidates (cell ids keyed by bal). Every push crosses a distinct ice–bare
  // face (≤ 2n faces on the grid), so 2n entries can never overflow, duplicates included.
  const heap = new Int32Array(2 * n);
  let hn = 0;
  const push = (i: number): void => {
    let k = hn++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (bal[heap[p]] >= bal[i]) break;
      heap[k] = heap[p];
      k = p;
    }
    heap[k] = i;
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap[--hn];
    let k = 0;
    for (;;) {
      let ch = 2 * k + 1;
      if (ch >= hn) break;
      if (ch + 1 < hn && bal[heap[ch + 1]] > bal[heap[ch]]) ch++;
      if (bal[heap[ch]] <= bal[last]) break;
      heap[k] = heap[ch];
      k = ch;
    }
    heap[k] = last;
    return top;
  };
  for (let s0 = 0; s0 < n; s0++) {
    if (state[s0] !== 1 || region[s0] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s0;
    region[s0] = s0;
    let surplus = 0;
    let deficit = 0;
    while (head < tail) {
      const i = queue[head++];
      const b = bal[i] * area(i);
      if (b > 0) surplus += b;
      else deficit -= b;
      const k = neighbours4(nx, ny, i, nb);
      for (let q = 0; q < k; q++) {
        const m = nb[q];
        if (state[m] === 1 && region[m] < 0) {
          region[m] = s0;
          queue[tail++] = m;
        }
      }
    }
    const cells = Array.from(queue.subarray(0, tail));
    if (deficit > surplus) {
      // Retreat: the most strongly ablating cells melt out until the rest is fed.
      cells.sort((a, b) => bal[a] - bal[b] || a - b);
      for (const i of cells) {
        if (!(deficit > surplus) || bal[i] >= 0) break;
        if (core[i] > coreKm) continue;
        deficit -= -bal[i] * area(i);
        state[i] = -1;
        if (S.M[i] > mLow) S.M[i] = mLow;
        if (S.Ms[i] > S.M[i]) S.Ms[i] = S.M[i];
      }
    } else {
      // Advance onto adjacent bare land while the surplus can feed the new ablation.
      let budget = surplus - deficit;
      hn = 0;
      for (const i of cells) {
        const k = neighbours4(nx, ny, i, nb);
        for (let q = 0; q < k; q++) if (land[nb[q]] && state[nb[q]] === 0) push(nb[q]);
      }
      while (hn > 0) {
        const c = pop();
        if (state[c] !== 0) continue;
        if (-bal[c] > t.glacierAdvanceMaxDeficit) break;
        const cost = Math.max(0, -bal[c]) * area(c);
        if (cost > budget) break;
        budget += bal[c] * area(c);
        state[c] = 1;
        region[c] = s0;
        S.M[c] = mMax;
        const k = neighbours4(nx, ny, c, nb);
        for (let q = 0; q < k; q++) if (land[nb[q]] && state[nb[q]] === 0) push(nb[q]);
      }
    }
    // Flow from upstream returns the annual loss of the remaining ablation zone.
    for (const i of cells) {
      if (state[i] !== 1) continue;
      const d = ablY[i] - accY[i];
      if (d > 0) S.M[i] = Math.min(mMax, S.M[i] + d);
    }
  }
  // Nucleation: bare land whose snow survived the year and still gained mass.
  for (let i = 0; i < n; i++) {
    if (land[i] && state[i] === 0 && minY[i] > 0 && bal[i] > 0) {
      S.M[i] = mMax;
      state[i] = 1;
    }
  }
  for (let i = 0; i < n; i++) iceMask[i] = state[i] === 1 ? 1 : 0;
}
