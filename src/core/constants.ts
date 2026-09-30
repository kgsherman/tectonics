export const EARTH_RADIUS_KM = 6371;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
/** Sidereal rotation rate of an Earth-like planet, rad/s. */
export const OMEGA_EARTH = 7.2921e-5;
export const SECONDS_PER_DAY = 86400;
export const DAYS_PER_MONTH = 365.2422 / 12;
export const SECONDS_PER_MONTH = SECONDS_PER_DAY * DAYS_PER_MONTH;
/** W/m^2 */
export const SOLAR_CONSTANT = 1361;
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
/** Default mesh resolution (cells). Presets offered in UI: 40k / 100k / 160k. */
export const DEFAULT_MESH_N = 100_000;
