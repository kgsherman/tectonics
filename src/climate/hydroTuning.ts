/**
 * Every tunable constant of the hydrology stage (SPEC.md §6.2) lives here so calibration
 * (scripts/calibrate.ts) can sweep them. `HYDRO_TUNING` is the default set; computeHydrology
 * accepts a partial override. Units are given per field.
 */
export interface HydroTuning {
  /* ---- Column saturation ---- */
  /** Water-vapour scale height H_w (m): W_sat = H_w · ρ_v,sat(T_col). */
  waterScaleHeight: number;
  /**
   * κ in the column temperature T_col = T_ref + (1 − κ)(T_s,sl − T_ref) − Γh⁺ that sets W_sat
   * (T_ref = the latitude's ocean-weighted sea-level air temperature; Γh⁺ keeps plateaus dry).
   * The free troposphere is far more zonally uniform than the surface: winter inversions over cold
   * continents keep the air aloft warmer (Siberian columns hold 3–4 mm at −35 °C surface
   * temperature, 4× the surface-saturated value) and summer surface heating stays near the ground.
   * κ = 0 is the plain surface-temperature form.
   */
  columnAnomalyDamping: number;
  /** Weight of land cells relative to ocean cells in the zonal reference means (T_ref, SST_ref). */
  referenceLandWeight: number;

  /* ---- Humidity-gated precipitation (Bretherton et al. 2004) ---- */
  /** Gate steepness a in exp(a (r − r0)). */
  gateSteepness: number;
  /** Gate threshold r0 (column relative humidity at which the gate saturates at 1). */
  gateThreshold: number;
  /**
   * Weight of the ice-phase onset: below 0 °C (column temperature) r0 is scaled by
   * 1 − w·(1 − e_si/e_sw) (precipitation starts at ice saturation). 0 disables.
   */
  icePhaseGate: number;
  /**
   * Storm-track lowering of r0: r0 − stormGateShift · clamp(Baro / baroclinicForMaxGateShift, 0, 1).
   * The gate is a relation for instantaneous column RH; synoptic RH variance σ² in storm tracks
   * turns its monthly mean into exp(a (r̄ − r0 + a σ²/2)), so rain falls at lower mean RH
   * (σ ≈ 0.15–0.2 ⇒ shift ≈ 0.17–0.3).
   */
  stormGateShift: number;
  baroclinicForMaxGateShift: number;
  /**
   * Lowering of r0 on land (× land fraction): the Bretherton fit is for tropical oceans; over land
   * the diurnal cycle and convective/synoptic systems add column-RH variance, so monthly-mean
   * precipitation starts at a lower mean RH (same a·σ²/2 argument as the storm-track shift).
   */
  landGateShift: number;
  /**
   * Convective lowering of r0 over land warmer than the latitude's reference air temperature:
   * landConvectionGateShift · clamp(lf·(T_s,sl − T_ref) / landConvectionRefK, 0, 1).
   */
  landConvectionGateShift: number;
  landConvectionRefK: number;
  /**
   * The land-convection shift is scaled by max(0, 1 − subsidenceCapping·Asc⁻) (normalized
   * subsidence): a subsidence inversion suppresses surface-heated convection (drier Mediterranean
   * and subtropical summers).
   */
  subsidenceCapping: number;
  /** The same capping coefficient for the base land shift (diurnal variance). */
  subsidenceCappingLand: number;
  /** Cap on the total threshold shift. */
  gateShiftMax: number;
  /** Precipitation time scale τ_p (days) at M = 1 and gate = 1. */
  precipTimescaleDays: number;
  /** Large-scale condensation time scale (hours) removing super-saturation (r > 1). */
  condensationTimescaleHours: number;

  /* ---- Precipitation multiplier M ---- */
  /** c_c: weight of large-scale ascent (normalized `ascent`, positive part). */
  ascentWeight: number;
  /** c_s: weight of large-scale subsidence (normalized `ascent`, negative part). */
  subsidenceWeight: number;
  /** c_f: weight of the baroclinic / storm-track proxy (normalized). */
  baroclinicWeight: number;
  /** c_o: weight of orographic lift (u·∇h⁺ / orographicRefSpeed). */
  orographicWeight: number;
  /** c_st: weight of cold-SST stability (K⁻¹). */
  stabilityWeight: number;
  /** Lower bound on M before lee suppression. */
  multiplierMin: number;
  /** Upper bound on M (keeps extreme orographic cases finite and well conditioned). */
  multiplierMax: number;
  /** Normalized `ascent` / `baroclinic` are divided by (this × their global area-weighted RMS). */
  ascentRmsScale: number;
  baroclinicRmsScale: number;

  /* ---- Orography ---- */
  /** Gaussian σ (km) of the smoothing applied to h⁺ before taking its gradient (~150–200 km FWHM-ish). */
  orographySmoothKm: number;
  /** Vertical-velocity scale (m/s) normalizing u·∇h⁺. */
  orographicRefSpeed: number;
  /** Lee suppression exp(−k · max(0, −u·∇h⁺) / orographicRefSpeed). */
  leeSuppression: number;
  /** Floor on the lee factor. */
  leeFloor: number;

  /* ---- Cold-SST stability ---- */
  /** How far upwind (hours of steering-wind travel) the SST anomaly is sampled. */
  stabilityUpwindHours: number;
  /** Gaussian σ (km) spreading the ocean cold anomaly before the upwind sample. */
  stabilitySmoothKm: number;
  /** Cap on the stability anomaly (K). */
  stabilityMax: number;

  /* ---- Ocean evaporation (bulk formula) ---- */
  /** Air density ρ_a (kg/m³). */
  airDensity: number;
  /**
   * Bulk transfer coefficient C_E. Effective value: the bulk formula uses the column RH r, which is
   * lower than the near-surface RH (~0.8 over oceans), so a standard 1.3e-3 would overestimate E.
   */
  evapTransferCoeff: number;
  /** Gustiness σ (m/s) added in quadrature to the surface wind speed. */
  gustiness: number;

  /* ---- Land evapotranspiration ---- */
  /** β in ET = min(PET, β · P_recent). */
  etRecycling: number;
  /**
   * Soil-moisture memory: P_recent = (1 − μ)·P_month + μ·H, H = exponential moving average of the
   * earlier months' precipitation with e-folding `etMemoryMonths`. Lets seasonally dry land keep
   * evaporating stored water instead of collapsing into a no-rain/no-ET trap.
   */
  etMemoryWeight: number;
  etMemoryMonths: number;
  /** PET ramps from 0 at 0 °C to full Hamon PET at this temperature (°C). */
  petRampTemp: number;
  /** Multiplier on Hamon PET. */
  petScale: number;

  /* ---- Transport ---- */
  /** Pseudo-time step (hours) on a 1° grid; scales ∝ grid spacing. */
  dtHoursPerDegree: number;
  /** Bounds of the pseudo-time step (hours). */
  dtHoursMin: number;
  dtHoursMax: number;
  /**
   * Per-sub-step bound on dτ·λ·a·r (the gate's stiffness): cells whose forcing exceeds it with the
   * full step integrate their sink in ceil(stiffness / bound) sub-steps (≤ maxSinkSubsteps).
   * ≤ 1 keeps the local update monotone.
   */
  sinkStiffnessBound: number;
  maxSinkSubsteps: number;
  /** Midpoint iterations for the 3D departure points. */
  departureIterations: number;
  /**
   * Weight of the steering-wind divergence in the flux-form compression exp(−dt·w·∇·u). The
   * moisture-weighted flow converges less than the (partly ageostrophic, ×1.2) steering wind;
   * calibrated on Earth's zonal-mean precipitation (w = 1 doubles the equatorial peak and starves
   * the subtropics).
   */
  divergenceWeight: number;
  /** |∇·u| clamp (s⁻¹). */
  divergenceMax: number;
  /** Eddy diffusivity (m²/s): K = min + (max − min) · clamp(Baro / baroForMaxK, 0, 1). */
  eddyDiffusivityMin: number;
  /**
   * Terrain blocking of eddy moisture diffusion: each face's diffusivity × exp(−|Δh⁺|/this) (m) with
   * Δh⁺ the smoothed-height step between the two cells (the moist layer cannot mix across a ridge:
   * rain shadows). 0 disables.
   */
  diffusionBlockHeight: number;
  eddyDiffusivityMax: number;
  baroclinicForMaxDiffusivity: number;

  /* ---- Iteration / convergence ---- */
  /** Converged when max_i |ΔP_i| / (P_i + floor) over `checkEvery` steps < tolerance. */
  convergenceTolerance: number;
  /** Floor (mm/day) in the relative-change denominator (ignores changes in near-zero P). */
  convergenceFloorMmDay: number;
  checkEvery: number;
  minSteps: number;
  /**
   * Step caps per month: cold (first month without a warm start), warm (month-to-month), fast mode,
   * and the wrap-around re-solve of the first `wrapMonths` months of a cold start (so their soil
   * memory sees the previous December).
   */
  maxStepsCold: number;
  maxStepsWarm: number;
  maxStepsFast: number;
  wrapMonths: number;
  /**
   * Nested solve (hydroNest.ts): grids whose half is at least `nestMinWidth` wide are first solved
   * at half resolution (a warm start seeds that level), then relaxed for `nestFineSteps` steps per
   * month at full resolution.
   */
  nestMinWidth: number;
  nestFineSteps: number;
  /** The same for `fast` mode. */
  nestMinWidthFast: number;
  nestFineStepsFast: number;
  /** Initial column RH over ocean / land on a cold start. */
  initialRhOcean: number;
  initialRhLand: number;

  /* ---- Snowpack ---- */
  /** Precipitation is all snow below snowTempLow and all rain above snowTempHigh (monthly mean °C). */
  snowTempLow: number;
  snowTempHigh: number;
  /** Degree-day melt factor (mm w.e. per positive degree-day). */
  degreeDayFactor: number;
  /** Std-dev (°C) of daily temperature around the monthly mean (positive degree-day integral). */
  degreeDaySigma: number;
  /** SWE (mm) at which cover reaches 1 − 1/e. */
  snowCoverScale: number;
  /** SWE cap (mm) for permanent snow. */
  sweMax: number;
  /** Annual cycles of snowpack spin-up. */
  snowSpinupYears: number;

  /* ---- Clouds ---- */
  /** Column-RH ramp for cloud cover (the model's oceans equilibrate at r ≈ 0.5–0.75). */
  cloudRhLow: number;
  cloudRhHigh: number;
  cloudRhWeight: number;
  /** Precipitation contribution: cloudPrecipWeight · (1 − exp(−P / cloudPrecipRefMmDay)). */
  cloudPrecipWeight: number;
  cloudPrecipRefMmDay: number;
  /** Marine stratocumulus over cold, stable water: cloudStratusWeight · clamp(stab / cloudStratusRefK). */
  cloudStratusWeight: number;
  cloudStratusRefK: number;
  /** Stratocumulus thickening per unit of normalized subsidence (the trapping inversion). */
  cloudStratusSubsidence: number;
  /** RH-driven layer cloud × max(0, 1 − this · subsidence) (dry descending air of the subtropical highs). */
  cloudSubsidenceThinning: number;
  /** Frontal cloud of the storm tracks per unit of the normalized storm-track (baroclinic) index. */
  cloudStormWeight: number;
  /** Polar low cloud (summer stratus over open water / melting ice). */
  cloudPolarWeight: number;
  /** Shallow-cumulus base cover over open water. */
  cloudMarineBase: number;
}

export const HYDRO_TUNING: HydroTuning = {
  waterScaleHeight: 2200,
  columnAnomalyDamping: 0.5,
  referenceLandWeight: 0.1,

  gateSteepness: 15,
  gateThreshold: 0.83,
  icePhaseGate: 1,
  stormGateShift: 0.4,
  baroclinicForMaxGateShift: 1.5,
  landGateShift: 0.25,
  landConvectionGateShift: 0.15,
  landConvectionRefK: 8,
  subsidenceCapping: 3,
  subsidenceCappingLand: 1.8,
  gateShiftMax: 0.5,
  precipTimescaleDays: 4,
  condensationTimescaleHours: 2,

  ascentWeight: 1.0,
  subsidenceWeight: 0.4,
  baroclinicWeight: 0.6,
  orographicWeight: 0.8,
  stabilityWeight: 0.15,
  multiplierMin: 0.05,
  multiplierMax: 12,
  ascentRmsScale: 1,
  baroclinicRmsScale: 1,

  orographySmoothKm: 80,
  orographicRefSpeed: 0.01,
  leeSuppression: 1.5,
  leeFloor: 0.02,

  stabilityUpwindHours: 12,
  stabilitySmoothKm: 150,
  stabilityMax: 12,

  airDensity: 1.2,
  evapTransferCoeff: 7e-4,
  gustiness: 4.5,

  etRecycling: 0.5,
  etMemoryWeight: 0.5,
  etMemoryMonths: 1.5,
  petRampTemp: 2,
  petScale: 1,

  dtHoursPerDegree: 4,
  dtHoursMin: 2,
  dtHoursMax: 12,
  sinkStiffnessBound: 1,
  maxSinkSubsteps: 24,
  departureIterations: 2,
  divergenceWeight: 0.5,
  divergenceMax: 4e-5,
  eddyDiffusivityMin: 5e5,
  diffusionBlockHeight: 1500,
  eddyDiffusivityMax: 8e6,
  baroclinicForMaxDiffusivity: 1,

  convergenceTolerance: 0.01,
  convergenceFloorMmDay: 0.5,
  checkEvery: 4,
  minSteps: 8,
  maxStepsCold: 240,
  maxStepsWarm: 80,
  maxStepsFast: 40,
  wrapMonths: 2,
  nestMinWidth: 180,
  nestFineSteps: 16,
  nestMinWidthFast: 90,
  nestFineStepsFast: 12,
  initialRhOcean: 0.72,
  initialRhLand: 0.5,

  snowTempLow: -2,
  snowTempHigh: 2,
  degreeDayFactor: 3.5,
  degreeDaySigma: 4.5,
  snowCoverScale: 15,
  sweMax: 5000,
  snowSpinupYears: 3,

  cloudRhLow: 0.25,
  cloudRhHigh: 0.75,
  cloudRhWeight: 0.6,
  cloudPrecipWeight: 0.6,
  cloudPrecipRefMmDay: 4,
  cloudStratusWeight: 0.45,
  cloudStratusRefK: 3,
  cloudStratusSubsidence: 0.5,
  cloudSubsidenceThinning: 0.9,
  cloudStormWeight: 0.5,
  cloudPolarWeight: 0.6,
  cloudMarineBase: 0.15,
};

/** Defaults merged with an optional partial override. */
export function resolveHydroTuning(override?: Partial<HydroTuning>): HydroTuning {
  return override ? { ...HYDRO_TUNING, ...override } : HYDRO_TUNING;
}
