/**
 * Local (per-column) sources and implicit sink of the moisture solver (SPEC §6.2):
 *
 *   W ← (W_adv + dτ·E) / (1 + dτ·P/W),   P/W = λ = min(1, exp(a (r − r0)))·M/τ_p (+ condensation)
 *
 * applied in k sub-steps dτ = dt/k per pseudo-time step. The humidity gate is evaluated at the
 * start of each sub-step; the local map W ↦ W_new then has slope [1 + dτλ(1 − a·r)]/(1 + dτλ)², which
 * lies in [0, 1) as long as dτ·λ·a·r ≤ 1 — monotone, no overshoot. With the full dt that product
 * reaches ~5 on strongly forced cells (period-2 oscillations), so k is chosen per cell and month
 * from the forcing alone (`substepsFor`), keeping the discretization fixed during the iteration.
 * Large-scale condensation of super-saturation, (W − W_sat)/τ_c, is linear in W and is treated fully
 * implicitly. Land ET = min(PET, β·P_recent) with P_recent = (1 − μ)·P + μ·(earlier months' P) is
 * affine in P, so its fixed point is solved in closed form. Each sub-step removes exactly dτ·P, so
 * the reported P and E close the column budget: W_new = W_adv + dt·(E − P).
 */

export interface ColumnContext {
  /** Per-cell forcing (see MonthForcing). */
  wsat: Float32Array;
  invWsat: Float32Array;
  mult: Float32Array;
  evapA: Float32Array;
  evapB: Float32Array;
  /** Land ET = min(pet, etCap·P + etMemory) (β·(1 − μ)·lf and β·μ·lf·P_earlier). */
  etCap: Float32Array;
  etMemory: Float32Array;
  pet: Float32Array;
  substeps: Uint8Array;
  /** Per-cell gate threshold r0 (lowered in storm tracks, see MonthForcing.gateR0). */
  gateR0: Float32Array;
  /** Gate steepness a; 1/τ_p and 1/τ_c (s⁻¹); pseudo-time step dt (s). */
  a: number;
  invTauP: number;
  invTauC: number;
  dt: number;
}

/**
 * Sub-steps needed for cell forcing M (multiplier) so that dτ·(M/τ_p)·a·r0 ≤ maxStiffness
 * (the gate's largest dτ·λ·a·r occurs at r = r0), capped at maxSubsteps.
 */
export function substepsFor(mult: number, invTauP: number, a: number, r0: number, dt: number, maxStiffness: number, maxSubsteps: number): number {
  // Stored in a Uint8Array (MonthForcing.substeps), where 256 would wrap to 0 sub-steps (dt / 0).
  const cap = maxSubsteps > 255 ? 255 : maxSubsteps >= 1 ? Math.floor(maxSubsteps) : 1;
  const k = Math.ceil((dt * mult * invTauP * a * r0) / maxStiffness);
  return k < 1 ? 1 : k > cap ? cap : k;
}

/**
 * Apply sources and the sink to every cell: reads the advected water `wa` scaled by the
 * mass-fixer factor `waScale`, writes the new water `out`, precipitation `P` and evaporation `E`
 * (kg m⁻² s⁻¹, averaged over the step). Returns Σ_rows rowArea·Σ out (the new global water mass).
 */
export function updateColumns(
  ctx: ColumnContext,
  wa: Float64Array,
  waScale: number,
  out: Float64Array,
  P: Float64Array,
  E: Float64Array,
  w: number,
  rowArea: Float64Array,
): number {
  const { wsat, invWsat, mult, evapA, evapB, etCap, etMemory, pet, substeps, gateR0, a, invTauP, invTauC, dt } = ctx;
  const h = rowArea.length;
  let mass = 0;
  for (let row = 0; row < h; row++) {
    let rowMass = 0;
    for (let c = 0; c < w; c++) {
      const i = row * w + c;
      const ws = wsat[i];
      const s = invWsat[i];
      const rate = mult[i] * invTauP;
      const eA = evapA[i];
      const eB = evapB[i];
      const cap = etCap[i];
      const em = etMemory[i];
      const pe = pet[i];
      const r0 = gateR0[i];
      const k = substeps[i];
      const dtau = dt / k;
      let x = wa[i] * waScale;
      let pSum = 0;
      let eSum = 0;
      for (let j = 0; j < k; j++) {
        const r = x * s;
        const lam = r < r0 ? Math.exp(a * (r - r0)) * rate : rate;
        let eo = eA - r * eB;
        if (eo < 0) eo = 0;
        const ld = lam * dtau;
        // Unsaturated land ET (ET = β(1 − μ)·P + memory): W_new (1 + dτ(1 − cap)λ) = base.
        const base = x + dtau * (eo + em);
        let xn = base / (1 + ld * (1 - cap));
        let cond = 0;
        if (xn > ws) {
          // Condensation (W − W_sat)/τ_c active, implicit and linear.
          const cd = dtau * invTauC * (1 - cap);
          xn = (base + cd * ws) / (1 + ld * (1 - cap) + cd);
          cond = (xn - ws) * invTauC;
        }
        let p = lam * xn + cond;
        let et = cap * p + em;
        if (et > pe) {
          // PET-limited land ET: W_new (1 + dτλ) = x + dτ·(E_o + PET) (+ condensation if active).
          et = pe;
          const baseSat = x + dtau * (eo + pe);
          xn = baseSat / (1 + ld);
          cond = 0;
          if (xn > ws) {
            const cd = dtau * invTauC;
            xn = (baseSat + cd * ws) / (1 + ld + cd);
            cond = (xn - ws) * invTauC;
          }
          p = lam * xn + cond;
        }
        pSum += p;
        eSum += eo + et;
        x = xn;
      }
      out[i] = x;
      P[i] = pSum / k;
      E[i] = eSum / k;
      rowMass += x;
    }
    mass += rowMass * rowArea[row];
  }
  return mass;
}
