/**
 * Drainage routing on a (half-resolution) copy of the display height map: priority-flood
 * depression filling with an ε gradient (Barnes et al. 2014), metric-correct D8 steepest descent
 * with longitude wrap, runoff accumulation, and a water balance per filled depression that decides
 * open lakes (outflow continues), endorheic lakes (partial fill, outflow lost) and salt pans.
 */

/** Routing grid result. Discharge in km³/yr. */
export interface Drainage {
  w: number;
  h: number;
  /** Routing-cell elevation (m). */
  elev: Float32Array;
  /** 1 = ocean (≤ sea level). */
  ocean: Uint8Array;
  /** Receiver cell (−1 for ocean cells). */
  recv: Int32Array;
  /** Discharge leaving the cell, km³/yr (after lake evaporation losses). */
  q: Float32Array;
  /** Upstream drainage area in routing cells (the cell itself included; lon-row area weighted, 1 = an equatorial cell). */
  area: Float32Array;
  /** Lake id per cell (−1 none), dilated by LAKE_ZONE_RINGS cells so shores follow the finer output terrain. */
  lakeOf: Int32Array;
  lakes: Lake[];
}

export interface Lake {
  /** Water surface elevation (m). Cells of the depression below it are water. */
  level: number;
  /** Salt-pan level (m): depression cells below it (and above `level`) are salt flats; −∞ if none. */
  saltLevel: number;
  /** Lowest terrain elevation in the depression (m). */
  floor: number;
  /** Depression area in routing cells, and the filled (water) area. */
  cells: number;
  waterCells: number;
  endorheic: boolean;
  /** Water balance (km³/yr): inflow reaching the basin and open-water evaporation over the whole basin; mean aridity 0..1. */
  inflow: number;
  evap: number;
  arid: number;
}

/** Binary min-heap of (key, index) with Float64 keys. */
class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(cap: number) {
    this.keys = new Float64Array(Math.max(16, cap));
    this.vals = new Int32Array(Math.max(16, cap));
  }
  push(k: number, v: number): void {
    if (this.size >= this.keys.length) {
      const nk = new Float64Array(this.keys.length * 2);
      nk.set(this.keys);
      const nv = new Int32Array(this.vals.length * 2);
      nv.set(this.vals);
      this.keys = nk;
      this.vals = nv;
    }
    let i = this.size++;
    const keys = this.keys, vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  /** Pops the minimum; returns its index value (key via lastKey). */
  lastKey = 0;
  pop(): number {
    const keys = this.keys, vals = this.vals;
    const top = vals[0];
    this.lastKey = keys[0];
    const n = --this.size;
    if (n > 0) {
      const k = keys[n], v = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}

const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
const DC = [-1, 0, 1, -1, 1, -1, 0, 1];
/** ε added per flooded step so every filled cell has a strictly lower neighbour. */
const FILL_EPS = 1e-3;

export interface RouteInput {
  w: number;
  h: number;
  elev: Float32Array;
  sea: number;
  /** Per cell runoff, mm/yr (≥ 0). */
  runoff: Float32Array;
  /** Per cell open-water evaporation, mm/yr (> 0). */
  lakeEvap: Float32Array;
  /** Per cell aridity 0..1 (1 = hyper-arid) for salt pans. */
  arid: Float32Array;
  /** Minimum depression size (cells) to become a lake / salt pan. */
  minLakeCells: number;
}

/**
 * Minimum depression depth (m) for a lake. Shallower closed basins in the procedural terrain would
 * have been breached by fluvial erosion on a real planet: rivers simply run through them.
 */
const LAKE_MIN_DEPTH = 120;
/** Outlet incision of open lakes as a fraction of the basin depth (lowers their level). */
const BREACH = 0.45;
/** Incision of deep basins: BREACH_DEEP reached from BREACH between M0 and M0 + M1 m of depth. */
const BREACH_DEEP = 0.85;
const BREACH_DEEP_M0 = 250;
const BREACH_DEEP_M1 = 900;
/**
 * Dryland transmission loss per 40 km of channel: fraction TL_K·aridity/(q + TL_Q0)^0.88 (q in
 * km³/yr) above aridity TL_ARID0 — about 0.5 km³/yr lost per 40 km whatever the size: wadis of
 * ≲ 1 km³/yr die within a cell or two, a Nile-sized exotic river (~100 km³/yr) loses ~30 % over
 * 2000 km of desert.
 */
const TL_K = 0.4;
const TL_Q0 = 0.1;
const TL_ARID0 = 0.35;
/**
 * Hyper-arid closed basins hold at most this fraction of their floor as standing water (a terminal
 * or ephemeral lake), whatever the inflow; the rest of the floor is playa / salt crust.
 */
const ARID_LAKE_FRAC = 0.05;
/** Dilation (cells) of the drawable lake zone around a depression. */
const LAKE_ZONE_RINGS = 2;

/** Route water over the grid. Deterministic. */
export function routeDrainage(inp: RouteInput): Drainage {
  const { w, h, elev, sea } = inp;
  const n = w * h;
  const ocean = new Uint8Array(n);
  for (let i = 0; i < n; i++) ocean[i] = elev[i] <= sea ? 1 : 0;
  // Cell sizes (m): east–west spacing shrinks with cos(lat).
  const dy = (Math.PI / h) * 6.371e6;
  const dxRow = new Float64Array(h);
  const areaRow = new Float64Array(h);
  for (let r = 0; r < h; r++) {
    const cl = Math.max(1e-3, Math.cos(Math.PI / 2 - ((r + 0.5) * Math.PI) / h));
    dxRow[r] = ((2 * Math.PI) / w) * 6.371e6 * cl;
    areaRow[r] = (dxRow[r] * dy) / 1e6; // km²
  }

  // --- Priority flood from the ocean ------------------------------------------------------------
  const filled = new Float64Array(n);
  const done = new Uint8Array(n);
  const order = new Int32Array(n);
  let nOrder = 0;
  const heap = new MinHeap(n >> 2);
  let anyOcean = false;
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    anyOcean = true;
    done[i] = 1;
    filled[i] = elev[i];
  }
  const pushNeighbors = (i: number): void => {
    const r = (i / w) | 0, c = i - r * w;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      if (rr < 0 || rr >= h) continue;
      let cc = c + DC[k];
      if (cc < 0) cc += w;
      else if (cc >= w) cc -= w;
      const j = rr * w + cc;
      if (done[j]) continue;
      done[j] = 1;
      // Jittered ε: across filled flats the flood front (and hence the drainage paths, which
      // follow it back to the outlet) wanders instead of fanning out in straight lines.
      let hsh = Math.imul(j ^ 0x5bd1e995, 0x27d4eb2d);
      hsh ^= hsh >>> 15;
      hsh = Math.imul(hsh, 0x2c1b3c6d);
      hsh ^= hsh >>> 13;
      filled[j] = Math.max(elev[j], filled[i] + FILL_EPS * (0.05 + ((hsh >>> 0) % 1000) * 0.004));
      heap.push(filled[j], j);
    }
  };
  if (anyOcean) {
    for (let i = 0; i < n; i++) if (ocean[i]) pushNeighbors(i);
  } else {
    // No ocean at all: drain to the global minimum.
    let m = 0;
    for (let i = 1; i < n; i++) if (elev[i] < elev[m]) m = i;
    done[m] = 1;
    filled[m] = elev[m];
    order[nOrder++] = m;
    pushNeighbors(m);
  }
  while (heap.size > 0) {
    const i = heap.pop();
    order[nOrder++] = i;
    pushNeighbors(i);
  }

  // --- Metric D8 steepest descent on the filled surface -----------------------------------------
  const recv = new Int32Array(n).fill(-1);
  for (let t = 0; t < nOrder; t++) {
    const i = order[t];
    if (ocean[i]) continue;
    const r = (i / w) | 0, c = i - r * w;
    let best = -1, bs = 0;
    for (let k = 0; k < 8; k++) {
      const rr = r + DR[k];
      if (rr < 0 || rr >= h) continue;
      let cc = c + DC[k];
      if (cc < 0) cc += w;
      else if (cc >= w) cc -= w;
      const j = rr * w + cc;
      const drop = filled[i] - filled[j];
      if (drop <= 0) continue;
      const ddx = DC[k] * 0.5 * (dxRow[r] + dxRow[rr]), ddy = DR[k] * dy;
      const s = drop / Math.sqrt(ddx * ddx + ddy * ddy);
      if (s > bs) { bs = s; best = j; }
    }
    recv[i] = best;
  }

  // --- Accumulation (descending filled order = reverse flood order) ------------------------------
  const q = new Float32Array(n);
  const area = new Float32Array(n);
  const cell0 = areaRow[h >> 1];
  for (let t = nOrder - 1; t >= 0; t--) {
    const i = order[t];
    if (ocean[i]) continue;
    const r = (i / w) | 0;
    q[i] += inp.runoff[i] * 1e-6 * areaRow[r]; // mm → km, × km² = km³
    area[i] += areaRow[r] / cell0;
    // Transmission losses in drylands (evaporation from channels and floodplains, seepage into
    // alluvial fans): small streams die out within a few cells, exotic rivers lose a little.
    const ar = inp.arid[i];
    if (ar > TL_ARID0 && q[i] > 0) {
      let t = (ar - TL_ARID0) * (1 / (1 - TL_ARID0));
      t = t > 1 ? 1 : t * t * (3 - 2 * t);
      const f = (TL_K * t * (dy / 4e4)) / Math.pow(q[i] + TL_Q0, 0.88);
      q[i] *= f < 0.95 ? 1 - f : 0.05;
    }
    const j = recv[i];
    if (j >= 0 && !ocean[j]) {
      q[j] += q[i];
      area[j] += area[i];
    }
  }

  // --- Depressions → lakes ---------------------------------------------------------------------
  const lakeOf = new Int32Array(n).fill(-1);
  const lakes: Lake[] = [];
  const comp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const compCells: number[][] = [];
  const DEPTH_MIN = 0.5; // m: filled this much above the terrain counts as a depression
  for (let s = 0; s < n; s++) {
    if (ocean[s] || comp[s] >= 0 || filled[s] - elev[s] < DEPTH_MIN) continue;
    const id = compCells.length;
    const cells: number[] = [];
    let top = 0;
    stack[top++] = s;
    comp[s] = id;
    while (top > 0) {
      const i = stack[--top];
      cells.push(i);
      const r = (i / w) | 0, c = i - r * w;
      for (let k = 0; k < 8; k++) {
        const rr = r + DR[k];
        if (rr < 0 || rr >= h) continue;
        let cc = c + DC[k];
        if (cc < 0) cc += w;
        else if (cc >= w) cc -= w;
        const j = rr * w + cc;
        if (comp[j] >= 0 || ocean[j] || filled[j] - elev[j] < DEPTH_MIN) continue;
        comp[j] = id;
        stack[top++] = j;
      }
    }
    compCells.push(cells);
  }
  // Process upstream depressions first (higher spill level).
  const spill = compCells.map((cells) => {
    let m = Infinity;
    for (const i of cells) if (filled[i] < m) m = filled[i];
    return m;
  });
  const ids = compCells.map((_, i) => i).sort((a, b) => spill[b] - spill[a]);
  for (const id of ids) {
    const cells = compCells[id];
    if (cells.length < inp.minLakeCells) continue;
    let floor = Infinity;
    for (const i of cells) if (elev[i] < floor) floor = elev[i];
    const depth = spill[id] - floor;
    if (depth < LAKE_MIN_DEPTH) continue;
    // Inflow = discharge leaving the depression; open-water evaporation over the full basin.
    let inflow = 0, evapFull = 0, aridSum = 0, exitCell = -1, exitQ = -1;
    for (const i of cells) {
      const j = recv[i];
      if (j < 0 || comp[j] !== id) {
        inflow += q[i];
        if (q[i] > exitQ) { exitQ = q[i]; exitCell = i; }
      }
      const r = (i / w) | 0;
      evapFull += inp.lakeEvap[i] * 1e-6 * areaRow[r];
      aridSum += inp.arid[i];
    }
    const arid = aridSum / cells.length;
    const sorted = cells.slice().sort((a, b) => elev[a] - elev[b]);
    const endorheic = inflow < evapFull * 0.65;
    // Open lakes: level at the (partly incised) outlet; area = cells below it. Deep pits between
    // mountain ridges (rugged plateaus) are incised far more by their outlets: only their floors
    // hold water, instead of a lake in every hollow of the procedural relief.
    let deep = (depth - BREACH_DEEP_M0) * (1 / BREACH_DEEP_M1);
    deep = deep < 0 ? 0 : deep > 1 ? 1 : deep * deep * (3 - 2 * deep);
    let level = spill[id] - (BREACH + (BREACH_DEEP - BREACH) * deep) * depth;
    let waterCells = 0;
    for (const i of cells) if (elev[i] < level) waterCells++;
    // Drylands: standing water shrinks to a terminal lake on a playa floor as the basin gets more
    // arid (evaporation and seepage along the way, ephemeral floods), even with exotic inflow.
    let dry = (arid - 0.45) * (1 / 0.45);
    dry = dry < 0 ? 0 : dry > 1 ? 1 : dry * dry * (3 - 2 * dry);
    const aridCap = Math.floor(cells.length * (1 - (1 - ARID_LAKE_FRAC) * dry));
    if (waterCells > aridCap) {
      waterCells = aridCap;
      level = waterCells > 0 ? elev[sorted[waterCells - 1]] + 0.01 : -Infinity;
    }
    let loss = evapFull * (waterCells / cells.length);
    if (endorheic) {
      // Partial fill: the lake grows until evaporation balances the inflow.
      const frac = evapFull > 0 ? inflow / evapFull : 0;
      waterCells = Math.min(waterCells, Math.floor(frac * cells.length));
      level = waterCells > 0 ? elev[sorted[waterCells - 1]] + 0.01 : -Infinity;
      loss = inflow;
    }
    // Salt flats / playas around a shrunken lake in dry closed basins.
    let saltLevel = -Infinity;
    if ((endorheic || dry > 0.3) && arid > 0.6) {
      const saltCells = Math.max(1, waterCells, Math.floor(cells.length * (0.1 + 0.2 * arid)));
      saltLevel = elev[sorted[Math.min(cells.length - 1, saltCells - 1)]] + 0.01;
    }
    if (waterCells < inp.minLakeCells && saltLevel === -Infinity) continue;
    const lakeId = lakes.length;
    lakes.push({ level, saltLevel, floor, cells: cells.length, waterCells, endorheic, inflow, evap: evapFull, arid });
    // Lake zone = depression dilated by LAKE_ZONE_RINGS cells, so shores and salt rims are cut by
    // the fine output terrain rather than by the routing-cell outline. Only the rim (undrained
    // ground at or above the spill level) is added: cells past the outlet, which drain away below
    // the lake level, and other depressions must not be painted as this lake's water / salt.
    const spillLevel = spill[id];
    for (const i of cells) {
      const r = (i / w) | 0, c = i - r * w;
      for (let dr = -LAKE_ZONE_RINGS; dr <= LAKE_ZONE_RINGS; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= h) continue;
        for (let dc = -LAKE_ZONE_RINGS; dc <= LAKE_ZONE_RINGS; dc++) {
          let cc = c + dc;
          if (cc < 0) cc += w;
          else if (cc >= w) cc -= w;
          const j = rr * w + cc;
          if (lakeOf[j] >= 0 || ocean[j]) continue;
          if (comp[j] === id || (comp[j] < 0 && filled[j] >= spillLevel)) lakeOf[j] = lakeId;
        }
      }
    }
    if (loss <= 0) continue;
    // Remove the evaporated water from everything downstream of the outlet.
    let j = exitCell >= 0 ? recv[exitCell] : -1;
    for (const i of cells) if (recv[i] < 0 || comp[recv[i]] !== id) q[i] = Math.max(0, q[i] - loss * (q[i] / Math.max(1e-12, inflow)));
    let guard = 0;
    while (j >= 0 && !ocean[j] && guard++ < n) {
      q[j] = Math.max(0, q[j] - loss);
      j = recv[j];
    }
  }
  return { w, h, elev, ocean, recv, q, area, lakeOf, lakes };
}
