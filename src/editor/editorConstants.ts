import { DEG } from '../core/constants';

/** Disconnected plate fragments smaller than this merge into a neighbouring plate (SPEC §9). */
export const MIN_FRAGMENT_CELLS = 20;

/** Undo history: always keep at least this many steps, never more than HISTORY_MAX_STEPS. */
export const HISTORY_MIN_STEPS = 30;
export const HISTORY_MAX_STEPS = 100;
/** Beyond HISTORY_MIN_STEPS, the oldest steps are dropped while the history exceeds this size. */
export const HISTORY_BYTE_BUDGET = 160 * 1024 * 1024;

/**
 * Motion arrows: arc length (radians) drawn per km/Myr of surface speed, so 50 km/Myr (5 cm/yr)
 * is a 15° arrow. Dragging an arrow head inverts the same mapping.
 */
export const ARROW_RAD_PER_KM_MYR = 0.3 * DEG;
/**
 * Fastest plate the editor lets you draw, km/Myr: |ω|·R (the plate's fastest point), the same
 * quantity the simulation clamps, so drawn motions reach the simulation unscaled.
 */
export const MAX_PLATE_SPEED = 150;
/** Default motion for new plates / "Randomize motions", km/Myr. */
export const DEFAULT_SPEED_RANGE: readonly [number, number] = [30, 60];

/** Brush radius bounds and default, km. The effective minimum is one mesh spacing. */
export const BRUSH_MIN_KM = 50;
export const BRUSH_MAX_KM = 4000;
export const BRUSH_DEFAULT_KM = 600;

/** Raise/Lower: default peak elevation change per dab (m) and bounds. */
export const RAISE_DEFAULT_M = 150;
export const RAISE_MIN_M = 20;
export const RAISE_MAX_M = 1000;
/** Elevation limits for sculpting, m. */
export const ELEV_MIN = -11000;
export const ELEV_MAX = 9000;

/** Continent brush: edge roughness as a fraction of the radius (organic coastlines from round dabs). */
export const CONTINENT_EDGE_ROUGHNESS = 0.3;
/** Age given to crust painted continental, Myr. */
export const PAINTED_CONTINENT_AGE = 800;
/** Ocean age used when a plate has no oceanic crust to borrow an age from, Myr. */
export const DEFAULT_OCEAN_AGE = 60;
/** Coast distance beyond which the painted-continent profile is flat, km. */
export const COAST_INFLUENCE_KM = 800;

/** Brush strokes: a jump larger than this between two pointer samples breaks the stroke (ill-defined slerp). */
export const MAX_STROKE_JUMP = 170 * DEG;
