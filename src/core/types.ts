/**
 * Shared cross-module types — THE CONTRACT.
 *
 * Every module codes against these. Do not change a type here without
 * updating every consumer (see SPEC.md §"Ownership").
 *
 * Coordinate conventions (see SPEC.md §2):
 *  - Unit sphere, right-handed, z = north pole.
 *    x = cos(lat)cos(lon), y = cos(lat)sin(lon), z = sin(lat).
 *  - lat ∈ [-π/2, π/2], lon ∈ (-π, π], radians unless a name says Deg.
 *  - Lat-lon rasters ("grids") are row-major, row 0 = northernmost row,
 *    col 0 = westernmost (lon ≈ -π). Cell centers:
 *      lat(r) = π/2 - (r + 0.5)·π/h,  lon(c) = -π + (c + 0.5)·2π/w
 *  - Time in Myr (tectonics) ; plate speeds reported in km/Myr (= mm/yr; 10 km/Myr = 1 cm/yr).
 *  - Elevation in meters relative to the sea-level datum (0 m). Display sea level may be offset.
 */

export type Vec3 = [number, number, number];
/** Quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number];
/** 0-255 per channel. */
export type RGB = [number, number, number];

/* ------------------------------------------------------------------ */
/* Sphere mesh (Fibonacci lattice + spherical Delaunay)                 */
/* ------------------------------------------------------------------ */

export interface SphereMesh {
  /** Number of cells (lattice points). */
  n: number;
  /** 3n unit vectors. Point i = spherical Fibonacci point i (see SPEC §3.1). */
  xyz: Float64Array;
  /** Per-cell latitude / longitude (radians). */
  lat: Float32Array;
  lon: Float32Array;
  /** CSR adjacency of the spherical Delaunay graph: neighbors of i are adj[adjOffset[i] .. adjOffset[i+1]). */
  adjOffset: Int32Array;
  adj: Int32Array;
  /** Delaunay triangles, 3 vertex indices each, CCW when viewed from outside the sphere. */
  triangles: Int32Array;
  /** Mean angular distance between neighboring cells (radians). */
  spacing: number;
  /** Mean cell area in steradians (= 4π / n). */
  cellArea: number;
  /** Acceleration structure for nearestCell (opaque to consumers). */
  lutW: number;
  lutH: number;
  lut: Int32Array;
}

/** Precomputed mapping from mesh cells onto a lat-lon raster of size w×h. */
export interface MeshGridMap {
  w: number;
  h: number;
  /** 3 mesh cell indices per pixel (containing Delaunay triangle). */
  tri: Int32Array;
  /** 3 barycentric weights per pixel (sum to 1, all ≥ 0 up to float error). */
  bary: Float32Array;
  /** Nearest mesh cell per pixel (for categorical fields). */
  nearest: Int32Array;
}

/* ------------------------------------------------------------------ */
/* Tectonics                                                           */
/* ------------------------------------------------------------------ */

export const CRUST_OCEANIC = 0;
export const CRUST_CONTINENTAL = 1;

export const BOUNDARY_NONE = 0;
export const BOUNDARY_CONVERGENT = 1;
export const BOUNDARY_DIVERGENT = 2;
export const BOUNDARY_TRANSFORM = 3;

export interface PlateSpec {
  /** Stable unique id (never reused within a session; used for color/selection continuity). */
  id: number;
  name: string;
  color: RGB;
  /** Angular velocity in the world frame, radians per Myr. Surface velocity at unit point p = omega × p (× EARTH_RADIUS_KM for km/Myr). */
  omega: Vec3;
}

export interface PlateInfo extends PlateSpec {
  /** Area-weighted centroid (world frame, normalized). */
  centroid: Vec3;
  /** Fraction of sphere area, [0, 1]. */
  area: number;
  /** Fraction of this plate's area that is continental crust. */
  continentalFraction: number;
  /** Surface speed at centroid, km/Myr (10 km/Myr = 1 cm/yr). */
  speed: number;
}

/** Mantle hotspot, fixed in the world (mantle) frame. */
export interface Hotspot {
  pos: Vec3;
  /** Relative strength, ~0.5..1.5. */
  strength: number;
  /** Influence radius, radians. */
  radius: number;
}

/**
 * Editable world-frame description of a tectonic world. Produced by the random
 * generator, by the plate editor, and by TectonicSim.toDraft(); consumed by
 * new TectonicSim(). All per-cell arrays have length n (= mesh.n).
 */
export interface WorldDraft {
  n: number;
  /** Per cell: index into plates[]. Every cell must belong to a plate. */
  plate: Int16Array;
  crust: Uint8Array;
  /** Meters. */
  elev: Float32Array;
  /** Crust age, Myr. */
  age: Float32Array;
  plates: PlateSpec[];
  hotspots: Hotspot[];
  /** Simulation time, Myr. */
  time: number;
  /** Seed for any stochastic processes that continue from this draft. */
  seed: number;
}

export interface GenerateParams {
  seed: number;
  /** Number of plates, 3..30. Default 12. */
  plateCount: number;
  /** Fraction of the sphere covered by continental crust, 0.05..0.7. Default 0.35. */
  continentalFraction: number;
  /** 'scattered': several noise-shaped continents; 'supercontinent': one Pangaea-like mass; 'archipelago': many small landmasses. */
  continentMode: 'scattered' | 'supercontinent' | 'archipelago';
  /** Number of mantle hotspots. Default 8. */
  hotspotCount: number;
  /** Mean plate speed, km/Myr (default 50 = 5 cm/yr). */
  plateSpeed: number;
  /** Plate boundary irregularity 0..1. Default 0.5. */
  boundaryRoughness: number;
}

export interface TectonicParams {
  /** Myr per step. Default 1. The sim may substep internally to keep per-substep displacement < 1 cell. */
  dt: number;
  /** Hard cap on plate count (rifting disabled at cap). Default 24. */
  maxPlates: number;
  /** Rifting events per 100 Myr (expected), 0 disables. Default 1.5. */
  riftRate: number;
  /** Allow plates in sustained continental collision to merge. Default true. */
  mergePlates: boolean;
  /** Multipliers, default 1. */
  subductionUplift: number;
  collisionUplift: number;
  erosion: number;
  hotspotActivity: number;
  /** Multiplies every plate's omega when stepping. Default 1. */
  speedScale: number;
  /** Seed for stochastic events. */
  seed: number;
}

export interface WorldSnapshot {
  time: number;
  n: number;
  /** Per cell: index into plates[] (the plate on top at that location). */
  plate: Int16Array;
  elev: Float32Array;
  crust: Uint8Array;
  age: Float32Array;
  /** BOUNDARY_* per cell (cells on a plate boundary; NONE elsewhere). */
  boundary: Uint8Array;
  /** Recent tectonic uplift activity per cell, meters, decaying (e-folding ~50 Myr). Drives mountain ruggedness in rendering. */
  orogeny: Float32Array;
  plates: PlateInfo[];
  hotspots: Hotspot[];
}

export interface TectonicStats {
  time: number;
  steps: number;
  lastStepMs: number;
  plateCount: number;
  /** Fraction of cells with elev > 0. */
  landFraction: number;
  /** Fraction of cells with continental crust. */
  continentalFraction: number;
  meanElevation: number;
  maxElevation: number;
  minElevation: number;
}

/* ------------------------------------------------------------------ */
/* Climate                                                             */
/* ------------------------------------------------------------------ */

export interface ClimateParams {
  /** Climate grid size. Default 360×180 (1°). 'fast' mode typically 180×90. */
  gridW: number;
  gridH: number;
  /** Degrees. Default 23.44. */
  axialTilt: number;
  /** Multiplier on the solar constant. Default 1. */
  solarMultiplier: number;
  /** °C added to all temperatures after the model. Default 0. */
  globalTempOffset: number;
  /** Sea level, meters: cells with elev > seaLevel are land. Default 0. */
  seaLevel: number;
  /** Multiplier on evaporation / precipitation. Default 1. */
  moisture: number;
  /** Multiplier on ocean heat transport by currents. Default 1. */
  oceanCurrents: number;
  /** Planet spins retrograde (reverses Coriolis). Default false. */
  retrograde: boolean;
  /** Fewer iterations for interactive/live use. Default false. */
  fast: boolean;
}

export interface ClimateInput {
  w: number;
  h: number;
  /** w*h elevation in meters (row 0 = north), NOT offset by sea level. */
  elev: Float32Array;
}

/**
 * All monthly fields are laid out as [month][row][col]:
 *   index = m*w*h + r*w + c, m = 0 (January) .. 11 (December).
 */
export interface ClimateResult {
  w: number;
  h: number;
  params: ClimateParams;
  /** w*h, 1 = land. */
  land: Uint8Array;
  /** w*h, input elevation echo (m). */
  elev: Float32Array;
  /** 12*w*h near-surface air temperature at the actual surface elevation, °C. */
  temp: Float32Array;
  /** 12*w*h precipitation, mm/month. */
  precip: Float32Array;
  /** 12*w*h sea-level pressure, hPa. */
  pressure: Float32Array;
  /** 12*w*h near-surface wind, m/s, eastward (u) and northward (v). */
  windU: Float32Array;
  windV: Float32Array;
  /** 12*w*h sea-surface temperature °C (NaN on land). */
  sst: Float32Array;
  /** 12*w*h sea-ice fraction 0..1 (0 on land). */
  seaIce: Float32Array;
  /** 12*w*h surface ocean current, m/s (0 on land). */
  currentU: Float32Array;
  currentV: Float32Array;
  /** w*h Köppen class id (index into KOPPEN_CLASSES; 0 = ocean). */
  koppen: Uint8Array;
  /** w*h annual mean temperature °C, annual total precipitation mm/yr. */
  tempAnnual: Float32Array;
  precipAnnual: Float32Array;
  /** Wall-clock per stage, ms. */
  timings: Record<string, number>;
}

export type KoppenGroup = 'A' | 'B' | 'C' | 'D' | 'E' | 'ocean';

export interface KoppenClassInfo {
  id: number;
  code: string;
  name: string;
  group: KoppenGroup;
  /** Standard map color (Beck et al. 2018 legend). */
  color: RGB;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export type LayerId =
  | 'satellite'
  | 'elevation'
  | 'plates'
  | 'crust'
  | 'crustAge'
  | 'temperature'
  | 'precipitation'
  | 'pressure'
  | 'sst'
  | 'wind'
  | 'koppen';

export interface OverlayFlags {
  boundaries: boolean;
  graticule: boolean;
  coastlines: boolean;
}

export type LegendSpec =
  | {
      kind: 'gradient';
      title: string;
      unit?: string;
      /** Ascending values. */
      stops: Array<{ value: number; color: RGB; label?: string }>;
    }
  | {
      kind: 'categorical';
      title: string;
      items: Array<{ color: RGB; label: string; code?: string }>;
    };

export interface PaintSources {
  mesh: SphereMesh;
  snapshot: WorldSnapshot | null;
  climate: ClimateResult | null;
}

export interface PaintOptions {
  width: number;
  height: number;
  /** 0..11, or -1 for annual mean / annual-representative (satellite uses a typical mid-summer-greenness blend). */
  month: number;
  /** Display sea level (m). */
  seaLevel: number;
  /** Bake hillshading into the RGBA. */
  hillshade: boolean;
  /** Seed for procedural detail (terrain amplification, color noise). */
  seed: number;
  /** Terrain detail amplification amount 0..2 (default 1). */
  detail?: number;
  /** Draw rivers & lakes (satellite). Default true. */
  rivers?: boolean;
}

export interface PaintResult {
  width: number;
  height: number;
  /** width*height*4, row 0 = north. Opaque. */
  rgba: Uint8ClampedArray;
  /** Optional width*height amplified elevation in meters (for globe relief / normal mapping). */
  heightMap?: Float32Array;
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface WorldPointerEvent {
  type: 'down' | 'move' | 'up' | 'hover' | 'leave';
  /** Null when the pointer is not over the planet (e.g., globe background). */
  point: GeoPoint | null;
  clientX: number;
  clientY: number;
  /** MouseEvent.buttons bitmask. */
  buttons: number;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

export interface ArrowSpec {
  /** Tail position. */
  lat: number;
  lon: number;
  /** Direction as local east/north components (need not be normalized). */
  east: number;
  north: number;
  /** Arrow length along the surface, radians of arc. */
  length: number;
  color: RGB;
  /** Optional id (e.g., plate id) for hit testing. */
  id?: number;
  highlighted?: boolean;
}

export interface VectorFieldSpec {
  kind: 'wind' | 'current';
  w: number;
  h: number;
  /** w*h eastward / northward components (m/s); NaN or 0 where undefined. */
  u: Float32Array;
  v: Float32Array;
}

export interface BrushCursor {
  point: GeoPoint;
  /** Radius, radians of arc. */
  radius: number;
  color?: RGB;
}

/** Common interface implemented by GlobeView (3D) and MapView (2D equirectangular). */
export interface WorldView {
  readonly kind: 'globe' | 'map';
  readonly element: HTMLElement;
  /** Base layer image (equirectangular, row 0 = north). */
  setBaseImage(rgba: Uint8ClampedArray, width: number, height: number): void;
  /** Amplified elevation (m) for relief/normal-mapping; the map view may ignore. null clears. */
  setHeightMap(height: Float32Array | null, width: number, height_: number): void;
  /** Transparent overlay image (equirectangular) drawn over the base; null clears. */
  setOverlayImage(rgba: Uint8ClampedArray | null, width: number, height: number): void;
  /** Animated flow particles; null disables. */
  setVectorField(field: VectorFieldSpec | null): void;
  setArrows(arrows: ArrowSpec[]): void;
  setBrushCursor(cursor: BrushCursor | null): void;
  /** 'navigate': drag rotates/pans. 'paint': left-drag is delivered as pointer events only (no camera motion); right/middle-drag still navigates. */
  setInteractionMode(mode: 'navigate' | 'paint'): void;
  /** Month 0..11 for sun direction (globe lighting); -1 = neutral. */
  setMonth(month: number): void;
  /** Relief exaggeration for the globe (0 = flat). */
  setReliefScale(scale: number): void;
  /** Screen → geo. Null if not over the planet. */
  pick(clientX: number, clientY: number): GeoPoint | null;
  /** Geo → client coordinates; visible=false if on the far side / off-screen. */
  project(point: GeoPoint): { x: number; y: number; visible: boolean };
  /** Subscribe to pointer events; returns unsubscribe. */
  onPointer(handler: (e: WorldPointerEvent) => void): () => void;
  /** Call after the container size changes. */
  resize(): void;
  /** Current view as a PNG data URL (for export). */
  toDataURL(): string;
  dispose(): void;
}
