/**
 * Tunable constants of the tectonic simulation (SPEC §4). Units: km, Myr, m (elevation), km/Myr
 * (speeds), rad/Myr (angular velocities). Distances are physical (km) so behaviour is independent of
 * mesh resolution.
 */

/* ---------------- Kinematics (substeps A–D) ---------------- */

/** Maximum displacement of any plate point per substep, in cell spacings. */
export const SUBSTEP_MAX_DISPLACEMENT = 0.8;
/** Hard cap on substeps per step (a warning is emitted once when hit). */
export const MAX_SUBSTEPS = 8;
/** Loser crust is consumed (subducted / collided) only where plates converge faster than this. */
export const CONSUME_MIN_VCONV = 3;
/** Gaps open new ridge crust only where some plate pair diverges faster than this. */
export const RIDGE_MIN_DIVERGENCE = 5;
/**
 * Convergence/divergence is only trusted when the normal component exceeds this fraction of the
 * relative speed as well (obliquity gate): suppresses lattice-noise "subduction" along transforms.
 */
export const MIN_NORMAL_FRACTION = 0.3;
/**
 * Boundary normal is undefined (→ no consumption / no ridge) when |n| is below this fraction of the
 * value a straight boundary would give (e.g. a cell deep inside one plate).
 */
export const NORMAL_MIN_STRENGTH = 0.25;
/** Elevation removed from continental crust cloned into slow-stretching gaps (rift basins), m. */
export const RIFT_BASIN_DROP = 150;

/* ---------------- Interaction fields (E) ---------------- */

/**
 * Crust-thickness proxy added to max(0, elev + 500) when a continental cell is consumed, m: a 35 km
 * crustal column stacked onto the overriding plate is worth ≈ 35 km·(1 − ρc/ρm) ≈ 5 km of relief.
 */
export const COLLISION_THICKNESS_PROXY = 4500;
/**
 * Subduction uplift rate at the kernel peak, m/Myr per km/Myr of convergence. With the erosion below an
 * Andean margin converging at 50 km/Myr builds a ~3.6 km crest in 40 Myr and ~4.7 km in 60 Myr (100k cells).
 */
export const SUBDUCTION_UPLIFT_RATE = 2.1;
/**
 * Uplift factor of island arcs (oceanic overriding plate): arcs must build ~5 km of relief. The arc rate
 * SUBDUCTION_UPLIFT_RATE × ARC_OCEANIC_FACTOR stays 3.5 m/Myr per km/Myr (arc growth and the juvenile
 * crust budget are calibrated on it).
 */
export const ARC_OCEANIC_FACTOR = 3.5 / SUBDUCTION_UPLIFT_RATE;
/** Arc crust rising above this converts to continental crust, m. */
export const ARC_CONVERSION_ELEV = 0;
/**
 * Continental-margin (cordillera) kernel: peak distance / rise width / fall width, km. A distinct range
 * ~150–400 km inland rather than a broad swell (the back-arc beyond ~500 km stays low).
 */
export const CORDILLERA_PEAK_KM = 230;
export const CORDILLERA_RISE_KM = 120;
export const CORDILLERA_FALL_KM = 240;
/** Island-arc kernel on oceanic overriding plates, km. */
export const ARC_PEAK_KM = 160;
export const ARC_RISE_KM = 90;
export const ARC_FALL_KM = 150;
/** Subduction influence ends here, km. */
export const SUBDUCTION_MAX_KM = 1000;
/** Collision kernel: frontal peak width, plateau end, cutoff (km) and frontal peak share. */
export const COLLISION_PEAK_KM = 180;
export const COLLISION_PLATEAU_KM = 700;
export const COLLISION_MAX_KM = 1200;
export const COLLISION_PEAK_SHARE = 0.55;
/** Soft saturation height for tectonic uplift, m (rate × (1 − h/cap)). */
export const UPLIFT_SOFT_CAP = 9000;
/** Transient trench: depth at the front, e-folding half-width, cutoff, full-depth speed. */
export const TRENCH_DEPTH = -7500;
export const TRENCH_WIDTH_KM = 70;
export const TRENCH_MAX_KM = 200;
export const TRENCH_FULL_SPEED = 20;
/** Smoothing passes of front speeds / collision budgets along the front. */
export const FRONT_SMOOTH_PASSES = 2;
/**
 * Width (Gaussian σ, km) of the conservative smoothing of the tectonic uplift field inside each plate;
 * one pass adds σ ≈ spacing/2, so passes = round((2σ/spacing)²), at least one.
 */
export const UPLIFT_SMOOTH_KM = 60;
/** Oceanic crust converts to continental only in the arc core (subduction kernel ≥ this fraction). */
export const ARC_CORE_FRACTION = 0.3;
/**
 * Crustal growth budget (arc accretion vs. recycling). Emergent arc-core crust converts to continental
 * crust stochastically: per step with probability (raw arc uplift of the step, m) / ARC_JUVENILE_UPLIFT,
 * i.e. after ~ARC_JUVENILE_UPLIFT m of accumulated arc uplift on average — the magmatic addition
 * needed to build a continental column. Island arcs still rise above sea level (as volcanic islands on
 * oceanic crust) long before they become continental.
 */
export const ARC_JUVENILE_UPLIFT = 150000;
/**
 * Tectonic (subduction) erosion + sediment subduction: the overriding plate's leading edge at every
 * subduction front retreats at this rate (km/Myr at TECTONIC_EROSION_REF_SPEED km/Myr of convergence,
 * proportional to convergence, capped at 2×). Earth: ~1–3 km/Myr at erosive margins; globally the
 * recycled volume ≈ the arc addition, so continental area stays roughly constant.
 */
export const TECTONIC_EROSION_RATE = 1.7;
export const TECTONIC_EROSION_REF_SPEED = 50;
/** Plates with fewer owned cells than this are never eroded (keeps housekeeping invariants simple). */
export const TECTONIC_EROSION_MIN_CELLS = 64;
/**
 * Continental volume closure: land eroded above the freeboard is redeposited on passive margins, and
 * once a margin cell has received a continental column's worth (MARGIN_COLUMN_M of elevation
 * equivalent — the same proxy as a consumed collision column, COLLISION_THICKNESS_PROXY + 500 m) it
 * becomes continental shelf. Collisions turn area into thickness; erosion of the resulting belts turns
 * it back into area over ~100 Myr, as on Earth. SEDIMENT_EFFICIENCY: fraction of the eroded volume
 * that stays on the margins (the rest is subducted with the sea floor).
 */
export const SEDIMENT_EFFICIENCY = 0.7;
/** Same for land being uplifted above a subducting slab (arcs, cordilleras): it is subducted. */
export const SEDIMENT_ACTIVE_EFFICIENCY = 0;
export const MARGIN_COLUMN_M = 5000;
/**
 * Terrane accretion: a continental fragment of TERRANE_MIN_FRACTION..TERRANE_MAX_FRACTION of the sphere
 * (~5·10⁴ – 3·10⁶ km²) docks onto the overriding plate once its collision has absorbed
 * TERRANE_DOCK_SHORTENING km of shortening.
 */
export const TERRANE_DOCK_SHORTENING = 150;
export const TERRANE_MAX_FRACTION = 0.006;
export const TERRANE_MIN_FRACTION = 0.0001;
/** Trapped ocean basins up to this fraction of the sphere, whose youngest crust is older than
 * TRAPPED_BASIN_MIN_AGE Myr (no ridge inside), fill from the edge by one ring per MARGIN_INTERVAL. */
export const TRAPPED_BASIN_MAX_FRACTION = 0.01;
export const TRAPPED_BASIN_MIN_AGE = 60;
/** Margin accretion runs every this many Myr. */
export const MARGIN_INTERVAL = 5;
/** Unspent sediment is capped at this fraction of all cells (no instant continents after long droughts). */
export const MARGIN_MAX_BACKLOG = 0.01;

/** Hotspot saturating growth rate at the plume centre, 1/Myr (× strength × activity). */
export const HOTSPOT_RATE = 0.35;
/** Oceanic hotspot target height = HOTSPOT_OCEAN_TARGET × strength², m. */
export const HOTSPOT_OCEAN_TARGET = 1500;
/** Continental hotspot swell target = HOTSPOT_CONT_TARGET × strength, m. */
export const HOTSPOT_CONT_TARGET = 1000;
/** Hotspot influence radius in units of Hotspot.radius. */
export const HOTSPOT_REACH = 2.5;
/**
 * Volcanic construction is confined to the plume core (Gaussian width HOTSPOT_EDIFICE_WIDTH × radius),
 * so plates carry away seamount chains of edifice width. (Growth over the full plume width used to
 * leave ~600 km wide shallow walls across the oceans behind every hotspot.)
 */
export const HOTSPOT_EDIFICE_WIDTH = 0.6;

/* ---------------- Surface processes (G) ---------------- */

/**
 * Isostatic freeboard of continental crust (m) by age: juvenile arc crust (age 0) floats low and rises
 * to FREEBOARD_YOUNG by JUVENILE_AGE (Myr), then to FREEBOARD_CRATON by CRATON_AGE. Inactive young
 * arcs therefore subside to submarine ridges instead of standing as permanent land bridges.
 */
export const FREEBOARD_JUVENILE = -300;
export const FREEBOARD_YOUNG = 300;
export const FREEBOARD_CRATON = 480;
export const JUVENILE_AGE = 200;
export const CRATON_AGE = 2000;
/** Relaxation time of juvenile continental crust toward its freeboard, Myr. */
export const TAU_JUVENILE = 50;
/**
 * Erosion e-folding times, Myr: whole continental excess, orogenic excess above +1 km (SPEC: τ ≈ 150–300
 * and ≈ 40–80 Myr). Together with the diffusion below (100k cells), an inactive ~4.7 km cordillera keeps
 * ground above 2 km for ~80 Myr, is down to ~1.6 km after 100 Myr and to ~1 km hills after ~180 Myr;
 * post-orogenic plains relax to the freeboard.
 */
export const TAU_CONTINENT = 160;
export const TAU_OROGEN = 80;
export const OROGEN_THRESHOLD = 1000;
/** Submerged continental crust drifts toward a shelf depth, m, with this e-folding time, Myr. */
export const SHELF_DEPTH = -200;
export const TAU_SHELF = 200;
/** Oceanic islands above sea level are planed off by waves (guyots), Myr. */
export const TAU_ISLAND = 15;
/** Subaerial hillslope/fluvial diffusivity, km²/Myr, and the factor for the submarine part. */
export const DIFFUSIVITY = 40;
export const SUBMARINE_DIFFUSIVITY_FACTOR = 0.15;
/** e-folding time of the orogeny field, Myr. */
export const OROGENY_DECAY = 50;
/** Deepest allowed sea floor, m. */
export const OCEAN_FLOOR_MIN = -11000;
/** Highest allowed elevation (hard safety clamp after the soft cap), m. */
export const ELEVATION_MAX = 10000;

/* ---------------- Polarity (F) ---------------- */

/** Width of the boundary band whose oceanic age sets a plate's buoyancy rank, km. */
export const POLARITY_BAND_KM = 500;
/** Score bonus of continent-dominated plates. */
export const CONTINENTAL_RANK_BONUS = 1000;
/** Mean-age difference (Myr) that must persist POLARITY_FLIP_TIME Myr before two plates swap rank. */
export const POLARITY_FLIP_DIFF = 15;
export const POLARITY_FLIP_TIME = 10;
/** Oceanic age assumed for a plate with no oceanic crust near its boundaries, Myr. */
export const POLARITY_DEFAULT_AGE = 120;
/** Rank scores are re-evaluated every this many Myr (the hysteresis clocks advance by the elapsed time). */
export const POLARITY_INTERVAL = 5;

/* ---------------- Plate dynamics (H) ---------------- */

/** Maximum surface speed |ω|·R, km/Myr. */
export const MAX_SURFACE_SPEED = 150;
/** Collision drag coefficient (km/Myr) and the shortening scale at which it bites, km. */
export const COLLISION_DRAG = 4000;
export const COLLISION_SHORTENING_REF = 1200;
/** Pairs without collision contacts for this long forget their shortening, Myr. */
export const COLLISION_MEMORY = 20;
/** Merge when the relative speed at the suture stays below this (km/Myr) for MERGE_TIME Myr. */
export const MERGE_SPEED = 5;
export const MERGE_TIME = 10;
/** Slab pull: refit interval, relaxation time (Myr), trench-ward target speed (km/Myr). */
export const SLAB_PULL_INTERVAL = 5;
export const SLAB_PULL_TAU = 20;
export const SLAB_PULL_SPEED = 90;
/** Fraction of a plate's perimeter that must subduct for the full slab-pull weight. */
export const SLAB_PULL_FULL_FRACTION = 0.15;

/* ---------------- Rifting (I) & housekeeping (J) ---------------- */

/**
 * Rift rate scaling with plate size: riftRate applies to a world of RIFT_REF_PLATES equal plates; the
 * rate is multiplied by RIFT_REF_PLATES·Σ A_k² (A = area fraction), clamped to [MIN, MAX].
 */
export const RIFT_REF_PLATES = 12;
export const RIFT_SIZE_FACTOR_MIN = 0.5;
export const RIFT_SIZE_FACTOR_MAX = 4;
/** Minimum visible area (fraction of the sphere) of a plate that may rift. */
export const RIFT_MIN_AREA = 0.04;
/** Relative separation speed of rift halves, km/Myr. */
export const RIFT_SPEED_MIN = 20;
export const RIFT_SPEED_MAX = 60;
/** Noise warp of the rift partition (unit-sphere amplitude) and its frequency. */
export const RIFT_WARP = 0.22;
export const RIFT_WARP_FREQ = 2.2;
/** Each rift half must receive at least this fraction of the parent's cells. */
export const RIFT_MIN_SHARE = 0.2;
/**
 * Subduction initiation at old passive margins (closing half of the Wilson cycle): oceanic crust
 * older than INITIATION_AGE next to continental crust of the same plate may detach and converge on
 * the continent. Expected events per 100 Myr = riftRate × min(2, oldOceanFraction / INITIATION_REF).
 */
export const INITIATION_AGE = 140;
export const INITIATION_REF = 0.15;
/** Minimum old passive-margin length of a candidate plate, as a fraction of all cells. */
export const INITIATION_MIN_MARGIN = 0.0003;
/** The detached oceanic region must cover at least this fraction of the sphere. */
export const INITIATION_MIN_AREA = 0.01;
/** Initial convergence speed of the detached ocean toward its continent, km/Myr. */
export const INITIATION_SPEED_MIN = 20;
export const INITIATION_SPEED_MAX = 50;
/** Plates with fewer visible cells than this are merged into a neighbour. */
export const TINY_PLATE_CELLS = 20;
