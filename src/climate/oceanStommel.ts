/**
 * Stommel barotropic transport streamfunction Ψ (m³/s) on the core grid (SPEC §6.1.6):
 *
 *   r∇²Ψ + (2Ω_s/R²)∂λΨ = curl τ / ρ₀        (finite-volume, integrated over each cell)
 *
 * Unknowns are the ocean ("wet") cells between the channel walls at |φ| = wallLat. Dry cells hold
 * the value of their land component: the largest component (merged with the walls it touches) is
 * Ψ = 0; every other island ≥ minIslandCells is a super-node whose equation is the sum of the
 * discrete equations over its cells, i.e. the circulation condition r∮u·dl = (1/ρ₀)∮τ·dl.
 * Faces between a wet and a dry cell take the dry (wall) value, so β-terms vanish around islands.
 * Relaxation: zonal line relaxation (periodic or bounded tridiagonal per row segment, β implicit),
 * red-black rows with over-relaxation, island super-nodes updated after every sweep, plus a coarse
 * row/island additive correction (oceanBlock.ts). The sweep preconditions restarted GMRES, which
 * removes the slow basin-scale modes (oceanSolver.ts); coefficients are precomputed per land mask.
 */
import { OMEGA_EARTH } from '../core/constants';
import { EARTH_RADIUS_M, type LatLonGrid } from './dynGrid';
import { buildBlockCorrection, type BlockCorrection } from './oceanBlock';
import { oceanTuning } from './tuning';

const DEG = Math.PI / 180;

export interface StommelSetup {
  g: LatLonGrid;
  /** Rows [j0, j1] are inside the walls. */
  j0: number;
  j1: number;
  /** 1 = unknown of the solve. */
  wet: Uint8Array;
  /** Dry cells: component id (0 = main / Ψ = 0, k ≥ 1 islands); −1 for wet cells. */
  comp: Int32Array;
  nIslands: number;
  /** Island k (1-based, stored at k−1): its cells and its wet boundary faces (cell, coefficient). */
  islCellOff: Int32Array;
  islCells: Int32Array;
  islFaceOff: Int32Array;
  islFaceCell: Int32Array;
  islFaceCoef: Float64Array;
  /** Bottom friction r (s⁻¹) and signed rotation Ω_s. */
  r: number;
  omega: number;
  /** Dimensionless FV geometry per row: zonal, north-face and south-face couplings; β weight Ω_s·(sinφ_n − sinφ_s). */
  ax: Float64Array;
  an: Float64Array;
  as: Float64Array;
  bw: Float64Array;
  /** Per wet cell: tridiagonal row coefficients (0 where the neighbour is dry). */
  diag: Float64Array;
  lo: Float64Array;
  up: Float64Array;
  /** Row segments of consecutive wet cells: start column, length, periodic flag. */
  segOff: Int32Array;
  segStart: Int32Array;
  segLen: Int32Array;
  segPeriodic: Uint8Array;
  /** Coarse row/island additive correction (oceanBlock.ts). */
  block: BlockCorrection;
}

/** Build the solver geometry for a core land mask (1 = land). */
export function buildStommelSetup(g: LatLonGrid, land: Uint8Array, retrograde: boolean): StommelSetup {
  const T = oceanTuning;
  const { nx, ny, n } = g;
  const wall = T.wallLat * DEG;
  let j0 = 0;
  while (j0 < ny && g.lat[j0] >= wall) j0++;
  let j1 = ny - 1;
  while (j1 >= 0 && g.lat[j1] <= -wall) j1--;
  // Dry = land or outside the walls.
  const dry = new Uint8Array(n);
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      dry[i] = j < j0 || j > j1 || land[i] ? 1 : 0;
    }
  }
  // Label dry components with 8-connectivity (lon wraps): the dual of the 4-connected ocean of the
  // 5-point stencil, so land touching only diagonally still blocks the flow between the basins.
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!dry[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let top = 0;
    stack[top++] = s;
    label[s] = id;
    let size = 0;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const j = (i / nx) | 0;
      const c = i - j * nx;
      const cw = c === 0 ? nx - 1 : c - 1;
      const ce = c === nx - 1 ? 0 : c + 1;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        const b = jj * nx;
        const n0 = b + cw, n1 = b + c, n2 = b + ce;
        if (dry[n0] && label[n0] < 0) { label[n0] = id; stack[top++] = n0; }
        if (dry[n1] && label[n1] < 0) { label[n1] = id; stack[top++] = n1; }
        if (dry[n2] && label[n2] < 0) { label[n2] = id; stack[top++] = n2; }
      }
    }
    sizes.push(size);
  }
  let main = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[main]) main = k;
  // Map labels → component ids: main → 0, islands ≥ min size → 1.., small islands → wet.
  const remap = new Int32Array(sizes.length).fill(-1);
  let nIslands = 0;
  for (let k = 0; k < sizes.length; k++) {
    if (k === main) remap[k] = 0;
    else if (sizes[k] >= T.minIslandCells) remap[k] = ++nIslands;
  }
  const wet = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (!dry[i]) wet[i] = 1;
    else if (remap[label[i]] < 0) wet[i] = 1;
    else comp[i] = remap[label[i]];
  }

  // Geometry.
  const ax = new Float64Array(ny), an = new Float64Array(ny), as = new Float64Array(ny), bw = new Float64Array(ny);
  const mf = meridionalFrictionPerFace(g, wet, j0, j1);
  const omega = OMEGA_EARTH * (retrograde ? -1 : 1);
  for (let j = 0; j < ny; j++) {
    ax[j] = g.dLat / (g.cosLat[j] * g.dLon);
    an[j] = (mf[j] * g.dLon * g.faceCos[j]) / g.dLat;
    as[j] = (mf[j + 1] * g.dLon * g.faceCos[j + 1]) / g.dLat;
    bw[j] = omega * (g.faceSin[j] - g.faceSin[j + 1]);
  }
  const betaEq = (2 * OMEGA_EARTH) / EARTH_RADIUS_M;
  const r = T.stommelWidthKm * 1000 * betaEq;

  // Row coefficients for wet cells.
  const diag = new Float64Array(n), lo = new Float64Array(n), up = new Float64Array(n);
  for (let j = j0; j <= j1; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      if (!wet[i]) continue;
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      let d = -r * (2 * ax[j] + an[j] + as[j]);
      if (wet[ie]) {
        d += bw[j];
        up[i] = r * ax[j] + bw[j];
      }
      if (wet[iw]) {
        d -= bw[j];
        lo[i] = r * ax[j] - bw[j];
      }
      diag[i] = d;
    }
  }

  // Row segments.
  const segOff = new Int32Array(ny + 1);
  const segStart: number[] = [];
  const segLen: number[] = [];
  const segPer: number[] = [];
  for (let j = 0; j < ny; j++) {
    if (j >= j0 && j <= j1) {
      let firstDry = -1;
      for (let c = 0; c < nx; c++) if (!wet[j * nx + c]) { firstDry = c; break; }
      if (firstDry < 0) {
        segStart.push(0);
        segLen.push(nx);
        segPer.push(1);
      } else {
        let k = 0;
        while (k < nx) {
          const c = (firstDry + k) % nx;
          if (!wet[j * nx + c]) { k++; continue; }
          let len = 0;
          while (k + len < nx && wet[j * nx + ((firstDry + k + len) % nx)]) len++;
          segStart.push(c);
          segLen.push(len);
          segPer.push(0);
          k += len;
        }
      }
    }
    segOff[j + 1] = segStart.length;
  }

  // Islands: cells and wet boundary faces with their symmetric coefficients.
  const cellsBy: number[][] = Array.from({ length: nIslands }, () => []);
  const facesBy: Array<Array<[number, number]>> = Array.from({ length: nIslands }, () => []);
  for (let j = 0; j < ny; j++) {
    for (let c = 0; c < nx; c++) {
      const i = j * nx + c;
      const k = comp[i];
      if (k <= 0) continue;
      cellsBy[k - 1].push(i);
      const iw = j * nx + (c === 0 ? nx - 1 : c - 1);
      const ie = j * nx + (c === nx - 1 ? 0 : c + 1);
      if (wet[iw]) facesBy[k - 1].push([iw, ax[j]]);
      if (wet[ie]) facesBy[k - 1].push([ie, ax[j]]);
      if (j > 0 && wet[i - nx]) facesBy[k - 1].push([i - nx, an[j]]);
      if (j < ny - 1 && wet[i + nx]) facesBy[k - 1].push([i + nx, as[j]]);
    }
  }
  const islCellOff = new Int32Array(nIslands + 1);
  const islFaceOff = new Int32Array(nIslands + 1);
  for (let k = 0; k < nIslands; k++) {
    islCellOff[k + 1] = islCellOff[k] + cellsBy[k].length;
    islFaceOff[k + 1] = islFaceOff[k] + facesBy[k].length;
  }
  const islCells = new Int32Array(islCellOff[nIslands]);
  const islFaceCell = new Int32Array(islFaceOff[nIslands]);
  const islFaceCoef = new Float64Array(islFaceOff[nIslands]);
  for (let k = 0; k < nIslands; k++) {
    islCells.set(cellsBy[k], islCellOff[k]);
    facesBy[k].forEach(([cell, coef], q) => {
      islFaceCell[islFaceOff[k] + q] = cell;
      islFaceCoef[islFaceOff[k] + q] = coef;
    });
  }
  const setup: StommelSetup = {
    g, j0, j1, wet, comp, nIslands, islCellOff, islCells, islFaceOff, islFaceCell, islFaceCoef,
    r, omega, ax, an, as, bw, diag, lo, up,
    segOff, segStart: Int32Array.from(segStart), segLen: Int32Array.from(segLen), segPeriodic: Uint8Array.from(segPer),
    block: null as unknown as BlockCorrection,
  };
  setup.block = buildBlockCorrection(setup);
  return setup;
}

/**
 * Anisotropic bottom friction: the factor on meridional faces (per face row k = north face of row k).
 * In zonally blocked basins friction on meridional shear is reduced (meridionalFriction) so
 * interiors reach Sverdrup balance on the coarse grid while the western boundary layer keeps
 * δ_S = r/β; in zonally open channels (e.g. the Southern Ocean) there is no western boundary to
 * close the flow and a higher friction (channelFriction × r, standing in for topographic form drag,
 * which limits the circumpolar current) applies. The blend uses the
 * longest wet run of the two adjacent rows as a fraction of the latitude circle.
 */
function meridionalFrictionPerFace(g: LatLonGrid, wet: Uint8Array, j0: number, j1: number): Float64Array {
  const { nx, ny } = g;
  const base = oceanTuning.meridionalFriction;
  const open = new Float64Array(ny);
  for (let j = j0; j <= j1; j++) {
    let best = 0;
    let run = 0;
    let all = true;
    for (let k = 0; k < 2 * nx; k++) {
      if (wet[j * nx + (k % nx)]) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
        all = false;
      }
    }
    open[j] = all ? 1 : Math.min(1, best / nx);
  }
  const out = new Float64Array(ny + 1);
  for (let k = 0; k <= ny; k++) {
    const o = Math.max(k > 0 ? open[k - 1] : 0, k < ny ? open[k] : 0);
    const w = Math.pow(o, oceanTuning.channelOpennessPower);
    out[k] = base + (oceanTuning.channelFriction - base) * w;
  }
  return out;
}
