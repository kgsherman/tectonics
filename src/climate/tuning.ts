/**
 * Every tunable constant of the climate dynamics (SPEC §6.1) in one place.
 *
 * The objects are deliberately mutable so a calibration harness (scripts/calibrate.ts) can sweep
 * them; the model reads them at call time. Units are given per field. Values were calibrated
 * against the Earth input (src/climate/earthInput.ts) in stages (temperature, then winds and
 * pressure, then currents / SST / sea ice, then precipitation), and finally jointly with the
 * hydrology constants by coordinate descent on a combined score: zonal-mean temperature and its
 * band biases, Köppen group shares, reference-city classes, station temperatures, seasonal sea-ice
 * areas, coastal SST anomalies, western-boundary-current speeds and global precipitation.
 * Physical meaning takes precedence over the score: mechanisms and bounds follow the literature
 * values quoted with each constant, and no constant is tied to a place on Earth.
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
  olrA: 201,
  olrB: 2.09,
  /** Snow/ice-free planetary albedo 0.30 + 0.08·P2(sinφ). */
  albedoBase: 0.29,
  albedoP2: 0.19,
  /** Offset for open ocean relative to land (darker surface). */
  albedoOceanOffset: -0.015,
  /** Planetary albedo over snow and cold sea ice, and over permanent land ice sheets. */
  albedoIce: 0.61,
  albedoIceSheet: 0.68,
  /** Melting sea ice (surface near 0 °C: ponds, wet snow) and its ramp on ice-surface T (°C, ≥ 10 K wide). */
  albedoSeaIceMelt: 0.45,
  seaIceRampCold: -11,
  seaIceRampWarm: -1,
  /** Snow albedo ramp on surface temperature (°C): full snow at ≤ cold, none at ≥ warm (≥ 10 K wide). */
  snowRampCold: -13,
  snowRampWarm: -2,
  /** Seasonal snow on terrain this high (m) has half its albedo effect; an annual-mean surface T below snowPolarWarm − 10 °C counts as ice sheet. */
  snowPatchyHeight: 2000,
  snowPolarWarm: -5,
  /**
   * Land snow / ice mass balance (energyStep.ts; mass M in kg/m² water equivalent per land cell).
   * Snowfall: the dynamics carries no moisture, so precipitation over cold land follows the
   * Clausius–Clapeyron scaling of ice-sheet models, P = snowfallRef·exp(snowfallPerK·T_s) (mm/yr;
   * ≈ 1.2 m/yr at 0 °C, 0.4 m/yr at −15 °C, 30 mm/yr at −50 °C: Antarctic coast and plateau), falling
   * as snow below snowfallWarm..snowfallCold (linear ramp, °C).
   */
  snowfallRef: 1200,
  snowfallPerK: 0.074,
  snowfallWarm: 2,
  snowfallCold: -2,
  /**
   * Melt: a snow- or ice-covered surface cannot warm above 0 °C; the air over it is coupled to the
   * melting surface with meltCoupling (W/m²/K × snow cover) and the absorbed heat melts the pack
   * (latent heat of fusion, J/kg).
   */
  meltCoupling: 15,
  latentFusion: 3.34e5,
  /** Snow cover fraction 1 − exp(−M/snowCoverMass) (kg/m²). */
  snowCoverMass: 15,
  /**
   * Albedo weight of a melting seasonal snowpack relative to cold fresh snow (wet, patchy snow,
   * forest masking), and the planetary albedo of a melting glacier surface (ablation zone: wet
   * snow, bare ice, meltwater), reached on the sea-ice ramp seaIceRampCold..seaIceRampWarm of the
   * surface temperature.
   */
  snowWetWeight: 0,
  albedoIceSheetMelt: 0.5,
  /**
   * Planetary albedo of a melting glacier surface that still carries its seasonal snow (wet snow,
   * firn: the percolation zone). The glacier darkens to albedoIceSheetMelt only as that layer
   * (EbmState.Ms) melts away and bare ice is exposed (the ablation zone below the equilibrium line).
   */
  albedoIceSheetWet: 0.63,
  /**
   * Perennial mass (firn and ice) turns snow into glacier: glacier weight G = smoothstep(glacierMassLow,
   * glacierMassHigh, M), which takes the ice-sheet albedo, is never patchy on high terrain and
   * behaves as an ice sheet at the output (EF/ET, perennial snow). Mass is capped at glacierMassMax
   * (also the mass of a cell that joins a sheet; energyIce.ts decides which cells are glacier).
   */
  glacierMassLow: 150,
  glacierMassHigh: 600,
  glacierMassMax: 1500,
  /**
   * Cold start: land whose steady annual-mean surface temperature is below glacierInitT (°C) starts
   * glaciated (M = glacierMassMax) where it can carry an ice sheet (glacierInitCoastKm,
   * glacierInitReachKm); the mass balance then keeps, spreads or removes the ice (the ice-covered
   * branch of the hysteresis: an ice sheet keeps its own summers cold). Other land starts bare and
   * glaciates only where its seasonal snow survives the summer or a sheet's surplus can feed it.
   * (−14 °C: the interiors of large polar continents (−20 to −30 °C) and of Greenland and
   * Antarctica start glaciated; continental Siberia (≈ −12 °C), dry and ice-free even in glacial
   * times, does not.)
   */
  glacierInitT: -14,
  /**
   * The ice-covered branch needs room for an ice-sheet dome: only land at least this far (km) from
   * the ocean starts glaciated. Islands and coastal strips start bare (the interglacial branch) and
   * carry ice only where their own seasonal snow survives the summer or a neighbouring sheet's
   * accumulation surplus can feed them (energyIce.ts).
   */
  glacierInitCoastKm: 300,
  /** …and the initial sheet reaches this far (km) from its interior (the dome's half-width). */
  glacierInitReachKm: 450,
  /**
   * Glacier topology (which cells are ice) changes only at the first glacierTopologyYears year
   * boundaries of a run — all of them inside the always-identical cold pass 1 — each time to the
   * margin that balances every sheet's mass budget (energyIce.ts); afterwards it is held, so the
   * glacier margins do not depend on how many coupled years a run gets (fast, full, warm starts).
   */
  glacierTopologyYears: 3,
  /**
   * The interior of a cold-start ice sheet farther than this (km) from its initial margin is never
   * removed by the topology updates; only its outer band adjusts to the mass balance (energyIce.ts).
   * A sheet that size is kilometres thick and responds over millennia, and its own climate is cold
   * (bright, high, and decoupled from the warm air around it); the uncoupled pass 1 that settles the
   * margins lacks the air advection that cools it, so without this its budget melted the ice sheets
   * of large polar continents from the margin inwards. Only cells deeper than this inside the
   * initial sheet are protected: narrow ice caps can still vanish entirely.
   */
  glacierCoreKm: 400,
  /**
   * Except the core of a sheet that is not sustained even on the ice-covered branch: when more than
   * glacierCoreReleaseShare of its core area melted out in the first year of the run (the cold
   * start's own ice-albedo summer) with more than glacierCoreReleaseMelt (kg/m² w.e.) of melt to
   * spare on the bare ground, its core is not protected (energyIce.releaseMeltedCore; e.g. a polar
   * continent under high-obliquity summers). On the QA supercontinent ~15 % of the core melts out in
   * that year (its core stays protected); on a tilt-45° Antarctica all of it (no ice sheet is kept).
   */
  glacierCoreReleaseShare: 0.5,
  glacierCoreReleaseMelt: 0,
  /**
   * A sheet advances only onto bare land whose melt left over once its seasonal snow is gone stays
   * below this (kg/m²/yr w.e.): ice flow extends the margin into cool ground next to it, but cannot
   * carry the accumulation of a distant interior across warm lowlands.
   */
  glacierAdvanceMaxDeficit: 400,
  /**
   * Ice-sheet surface (energyIce.ts): height above sea level iceProfileScale·sqrt(d + iceProfileEdgeKm)
   * (m, d = km from the glacier margin; plastic ice with τ₀ ≈ 70 kPa after isostatic bed
   * depression), capped at iceSheetMaxHeight (m); 0 disables the elevation feedback.
   */
  iceProfileScale: 90,
  iceProfileEdgeKm: 0,
  iceSheetMaxHeight: 3500,
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
  mixedLayerMax: 180,
  /**
   * Seasonal stratified surface layer (m, 0 = off) above the winter mixed layer, and the e-folding
   * time (days) over which wind stirring mixes its heat down.
   */
  stratDepth: 25,
  stratMixDays: 80,
  /** Diffusivity on the unit sphere, W/m²/K: D(φ) = D0·(1 + d2·sin²φ + d4·sin⁴φ) (North 1975 shape). */
  diffusion: 0.56,
  diffusionD2: -0.5,
  diffusionD4: 0,
  /**
   * Hadley-cell enhancement of the meridional diffusivity: D·(1 + boost·exp(−(φ/lat)^power)), and
   * the fraction of the boost applied to zonal faces (Walker circulation).
   */
  hadleyBoost: 0.5,
  hadleyLat: 25,
  hadleyPower: 6,
  hadleyZonalFactor: 0,
  /** Obliquity (deg) up to which the boost applies fully, and at which it has faded out. */
  hadleyTiltFull: 35,
  hadleyTiltMax: 65,
  /** Ocean mixed-layer heat diffusion between ocean cells (eddies, overturning), W/m²/K on the unit sphere. */
  oceanDiffusion: 0.3,
  /**
   * Meridional ocean diffusion across zonally open channels: × (1 − (1 − factor)·open^power), open =
   * longest ocean run of the adjacent rows as a fraction of the latitude circle.
   */
  channelDiffusionFactor: 0.75,
  /** Zonal ocean diffusion relative to the meridional one. */
  oceanZonalDiffusionFactor: 1,
  /** Interhemispheric overturning heat transport (PW) for a single-hemisphere circumpolar channel (energyOverturning.ts). */
  overturningPW: 0.4,
  channelDiffusionPower: 4,
  /** Free-troposphere coupling of high terrain: k·min(1, (h/height)²), W/m²/K and m. */
  freeTropCoupling: 10,
  freeTropHeight: 3000,
  /**
   * Moist-adiabatic lapse of the free troposphere: the free-troposphere coupling pulls high terrain
   * toward T_row − (Γ − reduction·clamp(T_row/moistLapseWarmT, 0, 1))·h with reduction in K/km
   * (T_row = the row-mean sea-level air temperature, °C).
   */
  moistLapseReduction: 1.5,
  moistLapseWarmT: 25,
  /** Air diffusion factor over fully snow-covered (cold) land: stable surface layers (1 = off). */
  stableLandDiffusion: 1,
  /** Diffusivity factor over land (weaker low-level eddy mixing into continental interiors). */
  landDiffusionFactor: 1,
  /** Diffusivity factor over high polar plateaus (ice sheets: strong surface inversions), poleward of iceSheetLat above iceSheetHeight (m). */
  iceSheetDiffusionFactor: 0.17,
  iceSheetLat: 60,
  iceSheetHeight: 1500,
  /**
   * Snow-surface inversion of the reported land temperature (surfaceInversion.ts): up to
   * inversionMax K under full snow cover when the daily insolation is far below inversionInsolation
   * (W/m²), shaped by inversionPower.
   */
  inversionMax: 7,
  /**
   * Extra inversion (K) over glaciers and ice sheets: a permanent snow surface with no summer heat
   * store in the ground and very weak winter mixing (20–25 K inversions on the Antarctic plateau).
   */
  inversionIceSheetExtra: 7,
  /** Terrain slope (m/km) scale of the ice-sheet extra: × exp(−(slope/this)²) (flat interiors only). */
  inversionIceSheetSlope: 4,
  inversionInsolation: 250,
  inversionPower: 1.5,
  /** Terrain slope (m/km) over which katabatic mixing weakens the inversion by 1/e (0 = no slope effect). */
  inversionSlope: 13,
  /**
   * Cloud cover (0..1) below which the inversion is full and above which it vanishes: surface
   * inversions form under clear skies (longwave cooling of the snow); overcast, windy maritime
   * winters keep the surface layer mixed. clear ≥ overcast disables the cloud dependence.
   */
  inversionCloudClear: 0.6,
  inversionCloudOvercast: 0.9,
  /**
   * Reference air-mass temperature (K) of the inversion's radiative factor min(1, (T/ref)⁴); 0 = off.
   * The surface's net longwave loss that builds the inversion scales roughly with σT⁴.
   */
  inversionRadiativeRefK: 225,
  /** Sea-water freezing point °C. */
  freezeT: -1.8,
  /**
   * Sea ice: latent heat per unit volume J/m³, reference thickness (m: initial and warm-start ice,
   * minimum conductive thickness), max thickness (m).
   */
  iceLatent: 917 * 3.34e5,
  iceFullThickness: 1.0,
  iceMaxThickness: 6,
  /**
   * Sea-ice area (Hibler 1979): open water freezes into new ice of the lead-closing thickness (m);
   * melting removes the thin end of a uniform 0..2h thickness distribution, dA = (A/2h)·dV; the
   * ice part is never thinner than seaIceMinThickness (m) on average.
   */
  seaIceLeadThickness: 1.0,
  seaIceMinThickness: 0.3,
  /**
   * Ocean heat flux into the base of sea ice (W/m²): entrainment of the warmer water below the
   * polar mixed layer (Arctic ≈ 2–5, Southern Ocean ≈ 10–30 W/m²; McPhee et al.).
   */
  iceBasalHeatFlux: 4,
  /** Conductive coupling k/(h + h_snow), W/m/K and m of equivalent snow insulation. */
  iceConductivity: 2.0,
  iceSnowEquivalent: 1.5,
  /** Upwelling cooling ∝ ρc·w⁺·efficiency·(SST − T_sub), T_sub = zonal annual SST − upwellingDeltaT. */
  upwellingEfficiency: 4,
  upwellingDeltaT: 6,
  /**
   * Temperature of the deep water below polar surface layers (°C): T_sub ≥ min(zonal + ΔT, this), so
   * upwelling of warmer deep water limits sea ice (Antarctic divergence).
   */
  deepWaterT: 2.0,
  /** Thermocline tilt: T_sub is up to this much colder at the eastern coast (warmer at the western). */
  upwellingTiltDeltaT: 7,
  /** Air heat advection: effective velocity = factor × steering wind (boundary-layer heat content). */
  heatAdvectionFactor: 0.4,
  /** Coupling of warm advection over a colder surface (stable inversion) relative to cold advection. */
  stableAdvectionFactor: 0.5,
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
 * Cloud regimes in the pass-2 planetary albedo (dynCloud.ts): offsets per unit of normalized
 * subsidence (−ascent, capped at subsidenceMax), storm-track index (baroclinic, capped at stormMax,
 * this share from the annual mean) and cold-SST anomaly (relative to the row's ocean mean, / stratusRefK,
 * capped at 1; × (1 + stratusSubsidence·subsidence)).
 */
export const cloudAlbedoTuning = {
  subsidenceLand: 0.11,
  /** Convective cloud over land per unit of normalized ascent (capped at ascentMax). */
  ascentLand: 0.02,
  ascentMax: 2,
  subsidenceOcean: 0.06,
  subsidenceMax: 1.5,
  stormLand: 0,
  stormOcean: 0.04,
  stormMax: 1.5,
  stormAnnualWeight: 0.5,
  stratus: 0.08,
  stratusRefK: 4,
  stratusSubsidence: 0.5,
};

/**
 * Spin-up schedule (model years). Pass-1 years are spin-up years before the diagnosed (monthly
 * output) year; pass-2 years include the output year. Aitken extrapolates the ocean enthalpy
 * after every second spin-up year. Pass 2 starts ~3 K warmer than its own equilibrium (upwelling
 * and current transport cool the uncoupled pass-1 climate) and needs its Aitken step to converge.
 * The pass-1 climate also sets pass 2's circulation, upwelling source temperature and cloud
 * regimes, so fast mode spins pass 1 up as well (without it the fast climate ran ~1.5 K warmer
 * than the full one); a warm-started full solve needs 3 years for the deep winter mixed layer.
 */
export const spinupTuning = {
  full: { pass1Years: 2, pass1Aitken: true, pass2Years: 4, pass2Aitken: true },
  fast: { pass1Years: 2, pass1Aitken: true, pass2Years: 3, pass2Aitken: true },
  /** With a warm start pass 1 keeps the cold schedule above and pass 2 starts from the warm state. */
  warmFull: { pass2Years: 3, pass2Aitken: false },
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
  subtropicalAmp: 12,
  subtropicalWidth: 13,
  /** Subtropical-high amplitude over (smoothed) land relative to the ocean amplitude. */
  subtropicalLandFactor: 0.45,
  /** Subpolar lows: land / ocean amplitudes (ocean lows are deeper). */
  subpolarLat: 62,
  subpolarAmpLand: 2,
  subpolarAmpOcean: 10,
  subpolarWidth: 13,
  /**
   * Deepening of the subpolar trough over a zonally open ocean (circumpolar storm track): factor
   * 1 + channelBoost·clamp((f_ocean − channelStart)/(1 − channelStart)), f_ocean = ocean share of the
   * band subpolarLat − channelBandLow .. subpolarLat + channelBandHigh (deg).
   */
  channelBoost: 1.3,
  channelStart: 0.7,
  channelBandLow: 8,
  channelBandHigh: 3,
  /** Polar highs. */
  polarAmp: 7,
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
  thermalK: 1,
  /** Weight of the all-cell zonal mean in T_ref (0 = ocean-only reference). */
  refAllCellWeight: 0,
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
  /**
   * Latitude-dependent friction: r = max(rMin, |f|·tan α) with boundary-layer turning angles α
   * (deg) over ocean and land; α ≤ 0 selects the constant rOcean / rLand above.
   */
  frictionAngleOcean: 16,
  frictionAngleLand: 35,
  rMinOcean: 3e-5,
  rMinLand: 3e-5,
  coastSmoothKm: 300,
  /** Polar filter start latitude (deg). */
  polarFilterLat: 60,
  maxSpeed: 30,
  /** Steering wind: rotate half-way back toward geostrophic, times this factor. */
  steerFactor: 1.2,
  /** Thermal-wind shear added to the steering wind: depth (m, 0 = off), |f| floor latitude (deg), cap (m/s). */
  steerThermalHeight: 1500,
  steerThermalMinLat: 15,
  steerThermalMax: 12,
  /** Thermal-wind term fades in from this latitude over the given width (deg); 0 = from the equator. */
  steerThermalFadeLat: 45,
  steerThermalFadeWidth: 15,
  /** Share of the thermal-wind shear in the boundary-layer flow used for heat advection. */
  heatThermalShare: 0.75,
  /** Steering rotation tapers to 0 at the equator over this latitude (deg). */
  steerEquatorTaper: 8,
  /** Ascent (frictional convergence) smoothing (km) and normalization (s⁻¹ ↦ 1). */
  ascentSmoothKm: 400,
  ascentRef: 2.5e-6,
  /** Baroclinicity: smoothing (km) and normalization of |∂T/∂y|·westerly (K/1000 km · m/s ↦ 1). */
  baroSmoothKm: 500,
  baroRef: 40,
  /** Weight of the steering-wind speed (vs the westerly component) in the storm-track proxy. */
  baroSpeedWeight: 0.75,
};

/** Wind-driven ocean (SPEC §6.1.6). */
export const oceanTuning = {
  rhoWater: 1025,
  /** Stommel boundary-layer width δ_S = r/β_eq (km). */
  stommelWidthKm: 200,
  /**
   * Friction on meridional faces relative to zonal ones in zonally blocked basins (anisotropic
   * bottom friction) and the power of the row openness that restores full friction in open channels.
   */
  meridionalFriction: 0.05,
  channelOpennessPower: 4,
  /** Friction factor (× r) on meridional faces of zonally open channels (form drag on the circumpolar current). */
  channelFriction: 10,
  /** Stommel-solver land threshold on the core land fraction (closes narrow isthmuses such as Panama). */
  solverLandThreshold: 0.3,
  /** Latitude of the channel walls (deg). */
  wallLat: 75,
  /** Islands smaller than this (core cells) are treated as ocean in the solve. */
  minIslandCells: 6,
  /** Wind stress: ρ_a C_d sqrt(|u|² + σ²) u. */
  dragCoeff: 1.3e-3,
  gustiness: 3,
  /** Storm-track gustiness (m/s) per unit of the normalized baroclinic index (capped at stormGustinessMax). */
  stormGustiness: 0,
  stormGustinessMax: 2,
  /** Easterly row-mean stress (N/m²) giving the full thermocline tilt. */
  thermoclineTiltStressRef: 0.04,
  curlSmoothPasses: 2,
  /** Surface velocity = transport / effectiveDepth (m), calibrated once on Earth. */
  effectiveDepth: 40,
  /** Latitude scale (deg) of the equatorial taper of the zonal geostrophic surface current (0 = off). */
  equatorTaperLat: 5,
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
