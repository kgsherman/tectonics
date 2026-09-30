/**
 * Implicit (backward Euler) eddy diffusion of column water on the lat-lon grid, operator split
 * into a periodic tridiagonal solve per row (Thomas + Sherman–Morrison) and a tridiagonal solve
 * per column. Finite-volume flux form: face diffusivity = mean of the two cells, meridional face
 * flux ∝ cosφ_face, zero flux through the poles ⇒ Σ area·W is conserved exactly.
 * Factorizations are computed once per (K field, dt) by `setup` and reused every step.
 */
import { EARTH_RADIUS_M } from './moistureGrid';
import type { HydroGrid } from './moistureGrid';

export class ImplicitDiffusion {
  private readonly g: HydroGrid;
  // Row (zonal) system after the Sherman–Morrison split, prefactored Thomas coefficients.
  private readonly rowSub: Float64Array;
  private readonly rowInvPivot: Float64Array;
  private readonly rowSupPrime: Float64Array;
  private readonly rowZ: Float64Array;
  /** Per row: v_last = α/γ and 1/(1 + v·z). */
  private readonly rowVLast: Float64Array;
  private readonly rowDenom: Float64Array;
  // Column (meridional) system, stored [row][col] so sweeps run over contiguous rows.
  private readonly colSub: Float64Array;
  private readonly colInvPivot: Float64Array;
  private readonly colSupPrime: Float64Array;

  constructor(g: HydroGrid) {
    this.g = g;
    const n = g.n;
    this.rowSub = new Float64Array(n);
    this.rowInvPivot = new Float64Array(n);
    this.rowSupPrime = new Float64Array(n);
    this.rowZ = new Float64Array(n);
    this.rowVLast = new Float64Array(g.h);
    this.rowDenom = new Float64Array(g.h);
    this.colSub = new Float64Array(n);
    this.colInvPivot = new Float64Array(n);
    this.colSupPrime = new Float64Array(n);
  }

  /** Prefactor both systems for diffusivity K (m²/s, per cell) and time step dt (s). */
  setup(K: ArrayLike<number>, dt: number): void {
    const { w, h, dLon, dLat, cosLat, faceCos } = this.g;
    const sub = new Float64Array(w);
    const diag = new Float64Array(w);
    const sup = new Float64Array(w);
    const rhsU = new Float64Array(w);
    for (let r = 0; r < h; r++) {
      const dx = EARTH_RADIUS_M * Math.max(cosLat[r], 1e-6) * dLon;
      const f = dt / (dx * dx);
      const row = r * w;
      for (let c = 0; c < w; c++) {
        const ce = c + 1 < w ? c + 1 : 0;
        const cw = c > 0 ? c - 1 : w - 1;
        const aE = f * 0.5 * (K[row + c] + K[row + ce]);
        const aW = f * 0.5 * (K[row + c] + K[row + cw]);
        sub[c] = -aW;
        sup[c] = -aE;
        diag[c] = 1 + aE + aW;
      }
      // Cyclic corners A[0][w-1] = sub[0] (α), A[w-1][0] = sup[w-1] (β).
      const alpha = sub[0];
      const beta = sup[w - 1];
      const gamma = -diag[0];
      diag[0] -= gamma;
      diag[w - 1] -= (alpha * beta) / gamma;
      // Thomas factorization of the modified matrix B.
      let prevSup = 0;
      for (let c = 0; c < w; c++) {
        const s = c > 0 ? sub[c] : 0;
        const pivot = diag[c] - s * prevSup;
        const ip = 1 / pivot;
        this.rowSub[row + c] = s;
        this.rowInvPivot[row + c] = ip;
        prevSup = c < w - 1 ? sup[c] * ip : 0;
        this.rowSupPrime[row + c] = prevSup;
      }
      // z = B⁻¹ u with u = [γ, 0, …, 0, β].
      rhsU.fill(0);
      rhsU[0] = gamma;
      rhsU[w - 1] = beta;
      this.solveRow(row, rhsU, 0);
      for (let c = 0; c < w; c++) this.rowZ[row + c] = rhsU[c];
      const vLast = alpha / gamma;
      this.rowVLast[r] = vLast;
      this.rowDenom[r] = 1 / (1 + rhsU[0] + vLast * rhsU[w - 1]);
    }
    // Columns: row r couples to r−1 through face r and to r+1 through face r+1.
    const cf = dt / (EARTH_RADIUS_M * EARTH_RADIUS_M * dLat * dLat);
    for (let r = 0; r < h; r++) {
      const invCos = 1 / Math.max(cosLat[r], 1e-6);
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        const aN = r > 0 ? cf * faceCos[r] * invCos * 0.5 * (K[i] + K[i - w]) : 0;
        const aS = r < h - 1 ? cf * faceCos[r + 1] * invCos * 0.5 * (K[i] + K[i + w]) : 0;
        const pivot = 1 + aN + aS - (r > 0 ? -aN * this.colSupPrime[i - w] : 0);
        const ip = 1 / pivot;
        this.colSub[i] = -aN;
        this.colInvPivot[i] = ip;
        this.colSupPrime[i] = -aS * ip;
      }
    }
  }

  /** Solve B x = d in place for one row (d[o .. o+w)) with the prefactored Thomas coefficients. */
  private solveRow(row: number, d: Float64Array, o: number): void {
    const w = this.g.w;
    const sub = this.rowSub;
    const ip = this.rowInvPivot;
    const sp = this.rowSupPrime;
    d[o] *= ip[row];
    for (let c = 1; c < w; c++) d[o + c] = (d[o + c] - sub[row + c] * d[o + c - 1]) * ip[row + c];
    for (let c = w - 2; c >= 0; c--) d[o + c] -= sp[row + c] * d[o + c + 1];
  }

  /** One implicit diffusion step applied to W in place (zonal then meridional). */
  apply(W: Float64Array): void {
    const { w, h } = this.g;
    const z = this.rowZ;
    for (let r = 0; r < h; r++) {
      const row = r * w;
      this.solveRow(row, W, row);
      // Sherman–Morrison correction x = y − (v·y)/(1 + v·z) z, v = [1, 0, …, 0, α/γ].
      const f = (W[row] + this.rowVLast[r] * W[row + w - 1]) * this.rowDenom[r];
      if (f !== 0) for (let c = 0; c < w; c++) W[row + c] -= f * z[row + c];
    }
    // Columns, swept for all columns at once row by row (contiguous memory).
    const sub = this.colSub;
    const ip = this.colInvPivot;
    const sp = this.colSupPrime;
    for (let c = 0; c < w; c++) W[c] *= ip[c];
    for (let r = 1; r < h; r++) {
      const row = r * w;
      for (let c = 0; c < w; c++) {
        const i = row + c;
        W[i] = (W[i] - sub[i] * W[i - w]) * ip[i];
      }
    }
    for (let r = h - 2; r >= 0; r--) {
      const row = r * w;
      for (let c = 0; c < w; c++) {
        const i = row + c;
        W[i] -= sp[i] * W[i + w];
      }
    }
  }
}
