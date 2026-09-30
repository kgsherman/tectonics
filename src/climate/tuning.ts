/**
 * Every tunable constant of the climate dynamics (SPEC §6.1) in one place.
 *
 * The objects are deliberately mutable so a calibration harness (scripts/calibrate.ts) can sweep
 * them; the model reads them at call time. Units are given per field. Values were calibrated
 * against the Earth input (src/climate/earthInput.ts) in stages: temperature, then winds, then
 * currents.
 */

/** Dynamic-core grid and time stepping. */
export const gridTuning = {
  /** Full-quality core grid (2°). */
  fullNx: 180,
  fullNy: 90,
  /** Fast (live) core grid (3°). */
  fastNx: 120,
  fastNy: 60,
  /** Energy-balance time steps per month (6 → ~5.07-day steps, 72 per year). */
  stepsPerMonth: 6,
};

/** Coupled seasonal energy balance (Budyko–Sellers, North et al. 1981). */
export const ebmTuning = {
  /**
   * OLR = A + B·T (T in °C at the actual surface height), W/m², W/m²/K. A starts from North et al.
   * (203.3) and is recalibrated for the converged (pass-2 Aitken) spin-up.
   */
  olrA: 202.3,
  olrB: 2.09,
  /** Snow/ice-free planetary albedo 0.30 + 0.08·P2(sinφ). */
  albedoBase: 0.29,
  albedoP2: 0.11,
  /** Offset for open ocean relative to land (darker surface). */
  albedoOceanOffset: -0.015,
  /** Planetary albedo over snow and cold sea ice, and over permanent land ice sheets. */
  albedoIce: 0.58,
  albedoIceSheet: 0.68,
  /** Melting sea ice (surface near 0 °C: ponds, wet snow) and its ramp on ice-surface T (°C, ≥ 10 K wide). */
  albedoSeaIceMelt: 0.45,
  seaIceRampCold: -11,
  seaIceRampWarm: -1,
  /** Land albedo reduction per unit of normalized subsidence (clear skies), capped at subsidenceMax units. */
  subsidenceAlbedo: 0.03,
  subsidenceMax: 1.5,
  /** Snow albedo ramp on surface temperature (°C): full snow at ≤ cold, none at ≥ warm (≥ 10 K wide). */
  snowRampCold: -13,
  snowRampWarm: -2,
  /** Seasonal snow on terrain this high (m) has half its albedo effect; an annual-mean surface T below snowPolarWarm − 10 °C counts as ice sheet. */
  snowPatchyHeight: 2000,
  snowPolarWarm: -5,
  /** Land/atmosphere column heat capacity, J/m²/K. */
  cLand: 0.8e7,
  /** Heat capacity of the air column over the ocean, J/m²/K. */
  cAir: 1.0e7,
  /** Heat capacity of the sea-ice surface layer (ice + snow), J/m²/K. */
  cIceSurface: 2e6,
  /** Air–sea (and air–ice) exchange coefficient γ, W/m²/K (sensible + latent). */
  airSeaExchange: 50,
  /** Convective thermostat on SST: extra damping (W/m²/K) above T_c (°C). */
  convectiveCapT: 30,
  convectiveDamping: 10,
  /** Ocean mixed layer: ρc (J/m³/K) and depth by latitude (m): depth = min + (max-min)·sin²φ. */
  rhoCpWater: 4.1e6,
  mixedLayerMin: 30,
  mixedLayerMax: 55,
  /** Diffusivity on the unit sphere, W/m²/K: D(φ) = D0·(1 + d2·sin²φ + d4·sin⁴φ) (North 1975 shape). */
  diffusion: 0.56,
  diffusionD2: -0.5,
  diffusionD4: 0,
  /** Ocean mixed-layer heat diffusion between ocean cells (eddies, overturning), W/m²/K on the unit sphere. */
  oceanDiffusion: 0.08,
  /** Free-troposphere coupling of high terrain: k·min(1, (h/height)²), W/m²/K and m. */
  freeTropCoupling: 8,
  freeTropHeight: 3000,
  /** Diffusivity factor over land (weaker low-level eddy mixing into continental interiors). */
  landDiffusionFactor: 1.0,
  /** Diffusivity factor over high polar plateaus (ice sheets: strong surface inversions), poleward of iceSheetLat above iceSheetHeight (m). */
  iceSheetDiffusionFactor: 0.2,
  iceSheetLat: 60,
  iceSheetHeight: 1500,
  /** Sea-water freezing point °C. */
  freezeT: -1.8,
  /** Sea ice: latent heat per unit volume J/m³, thickness at which a cell is fully covered (m), max thickness (m). */
  iceLatent: 917 * 3.34e5,
  iceFullThickness: 1.0,
  iceMaxThickness: 6,
  /** Conductive coupling k/(h + h_snow), W/m/K and m of equivalent snow insulation. */
  iceConductivity: 2.0,
  iceSnowEquivalent: 0.35,
  /** Upwelling cooling ∝ ρc·w⁺·efficiency·(SST − T_sub), T_sub = zonal annual SST − upwellingDeltaT. */
  upwellingEfficiency: 2.0,
  upwellingDeltaT: 6,
  /** Thermocline tilt: T_sub is up to this much colder at the eastern coast (warmer at the western). */
  upwellingTiltDeltaT: 7,
  /** Air heat advection: effective velocity = factor × steering wind (boundary-layer heat content). */
  heatAdvectionFactor: 0.4,
  /** Coupling of warm advection over a colder surface (stable inversion) relative to cold advection. */
  stableAdvectionFactor: 0.6,
  /** Air advected across a terrain step Δh (cold air uphill, warm air downhill) couples with exp(−|Δh|/leeHeight). */
  leeHeight: 700,
  /** Mixed-layer heat advection: effective velocity = factor × surface current × params.oceanCurrents. */
  sstAdvectionFactor: 1.0,
  /** Semi-Lagrangian sub-step length, in meridional cell sizes per sub-step. */
  cellsPerSubstep: 1.0,
  maxSubsteps: 24,
  /** Aitken extrapolation: max jump per cell (K-equivalent) and accepted contraction ratio. */
  aitkenMaxJump: 8,
  aitkenMaxRatio: 0.92,
};

/**
 * Spin-up schedule (model years). Pass-1 years are spin-up years before the diagnosed (monthly
 * output) year; pass-2 years include the output year. Aitken extrapolates the ocean enthalpy
 * after every second spin-up year. Pass 2 starts ~3 K warmer than its own equilibrium (upwelling
 * and current transport cool the uncoupled pass-1 climate) and needs its Aitken step to converge.
 */
export const spinupTuning = {
  full: { pass1Years: 2, pass1Aitken: true, pass2Years: 4, pass2Aitken: true },
  fast: { pass1Years: 0, pass1Aitken: false, pass2Years: 3, pass2Aitken: true },
  /** With a warm start pass 1 keeps the cold schedule above and pass 2 starts from the warm state. */
  warmFull: { pass2Years: 2, pass2Aitken: false },
  warmFast: { pass2Years: 1, pass2Aitken: false },
  /** Steady (annual-mean) solve: albedo outer iterations and CG tolerance (K). */
  steadyAlbedoIters: 3,
  steadyCgMaxIter: 400,
  steadyCgTol: 3e-3,
  /** Extra local damping used by the analytic periodic init (stands in for diffusion), W/m²/K. */
  periodicExtraDamping: 1.2,
};

/** Sea-level pressure (SPEC §6.1.4), hPa. */
export const pressureTuning = {
  base: 1012,
  /** Equatorial trough. */
  itczDepth: 4,
  itczWidth: 9,
  /** Subtropical highs. */
  subtropicalLat: 31,
  subtropicalAmp: 9,
  subtropicalWidth: 13,
  /** Subpolar lows: land / ocean amplitudes (ocean lows are deeper). */
  subpolarLat: 62,
  subpolarAmpLand: 6,
  subpolarAmpOcean: 16,
  subpolarWidth: 13,
  /** Polar highs. */
  polarAmp: 6,
  polarWidth: 12,
  /** Belt shift with the thermal equator decays with distance from it (deg). */
  shiftDecay: 35,
  /** Thermal equator: search band (deg), longitudinal smoothing (deg), clamp (deg, also ≤ tilt). */
  thermalEqSearch: 35,
  thermalEqSmoothLon: 30,
  thermalEqClamp: 25,
  thermalEqSoftness: 2.5,
  /** Belt amplitudes scale with the hemispheric T gradient (K between the 0–30° and 50–80° bands). */
  gradientRef: 36,
  gradientScaleMin: 0,
  gradientScaleMax: 1.5,
  /** Scale = (G/G_ref)^exponent (sub-linear: summer belts weaken but persist). */
  gradientExponent: 0.5,
  /** Thermal term ΔP = −k·(T_slr − T_ref(lat)), hPa/K, smoothing length km. */
  thermalK: 0.8,
  /** Weight of the all-cell zonal mean in T_ref (0 = ocean-only reference). */
  refAllCellWeight: 0.5,
  thermalSmoothKm: 500,
  thermalMax: 28,
  /** Final smoothing length for the belt field and the land fraction used for ocean/land amplitudes, km. */
  beltLandSmoothKm: 900,
  finalSmoothKm: 350,
};

/** Surface winds (SPEC §6.1.5). */
export const windTuning = {
  rhoAir: 1.2,
  /** Rayleigh friction, s⁻¹. */
  rOcean: 3.7e-5,
  rLand: 7e-5,
  coastSmoothKm: 300,
  /** Polar filter start latitude (deg). */
  polarFilterLat: 60,
  maxSpeed: 30,
  /** Steering wind: rotate half-way back toward geostrophic, times this factor. */
  steerFactor: 1.2,
  /** Steering rotation tapers to 0 at the equator over this latitude (deg). */
  steerEquatorTaper: 8,
  /** Ascent (frictional convergence) smoothing (km) and normalization (s⁻¹ ↦ 1). */
  ascentSmoothKm: 400,
  ascentRef: 2.5e-6,
  /** Baroclinicity: smoothing (km) and normalization of |∂T/∂y|·westerly (K/1000 km · m/s ↦ 1). */
  baroSmoothKm: 500,
  baroRef: 40,
};

/** Wind-driven ocean (SPEC §6.1.6). */
export const oceanTuning = {
  rhoWater: 1025,
  /** Stommel boundary-layer width δ_S = r/β_eq (km). */
  stommelWidthKm: 275,
  /**
   * Friction on meridional faces relative to zonal ones in zonally blocked basins (anisotropic
   * bottom friction) and the power of the row openness that restores full friction in open channels.
   */
  meridionalFriction: 0.05,
  channelOpennessPower: 4,
  /** Stommel-solver land threshold on the core land fraction (closes narrow isthmuses such as Panama). */
  solverLandThreshold: 0.3,
  /** Latitude of the channel walls (deg). */
  wallLat: 75,
  /** Islands smaller than this (core cells) are treated as ocean in the solve. */
  minIslandCells: 6,
  /** Wind stress: ρ_a C_d sqrt(|u|² + σ²) u. */
  dragCoeff: 1.3e-3,
  gustiness: 3,
  /** Easterly row-mean stress (N/m²) giving the full thermocline tilt. */
  thermoclineTiltStressRef: 0.04,
  curlSmoothPasses: 2,
  /** Surface velocity = transport / effectiveDepth (m), calibrated once on Earth. */
  effectiveDepth: 50,
  maxCurrent: 2.5,
  /** Ekman: regularization latitude (deg) and surface drift depth (m). */
  ekmanRegLat: 3,
  ekmanDepth: 40,
  /** Line-relaxation over-relaxation factor (the sweep preconditions GMRES). */
  sorOmega: 1.3,
  /**
   * Sweep budgets per Fourier component of the monthly forcing (mean, annual harmonic, others),
   * for a cold solve and for a warm-started one.
   */
  sweepsCold: [72, 36, 20],
  sweepsWarm: [24, 12, 8],
  sweepsColdFast: [40, 20, 10],
  sweepsWarmFast: [16, 8, 4],
  /** Highest seasonal harmonic of the forcing kept in Ψ (the ocean filters faster changes). */
  maxHarmonic: 3,
  /** Convergence: max |Δu| (m/s). */
  tolerance: 1e-3,
  /** Upwelling smoothing passes (1-2-1) before use. */
  upwellingSmoothPasses: 1,
};
