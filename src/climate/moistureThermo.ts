/**
 * Moist thermodynamics helpers for the hydrology stage: saturation vapour pressure, column
 * saturation water, surface specific humidity, Hamon PET and day length.
 */
import { DAYS_PER_MONTH } from '../core/constants';

/** Specific gas constant of water vapour, J kg⁻¹ K⁻¹. */
const R_VAPOR = 461.5;
/** Standard surface pressure, Pa. */
const P_SURFACE = 101325;
const T_MIN = -120;

/** Saturation vapour pressure over water (Pa), Bolton (1980); clamped far below the singularity. */
export function satVaporPressure(tC: number): number {
  const t = tC < T_MIN ? T_MIN : tC;
  return 611.2 * Math.exp((17.67 * t) / (t + 243.5));
}

/**
 * Saturation column water (kg/m² = mm) for a column whose surface air is at tC:
 * W_sat = H_w · ρ_v,sat = H_w · e_s / (R_v T). Uses the vapour density, which does not depend on
 * pressure, so elevated (lapse-cooled) surfaces automatically hold less water.
 */
export function saturationColumnWater(tC: number, scaleHeight: number): number {
  const t = tC < T_MIN ? T_MIN : tC;
  return (scaleHeight * satVaporPressure(t)) / (R_VAPOR * (t + 273.15));
}

/**
 * Saturation specific humidity (kg/kg) at standard surface pressure. e_s is capped at the surface
 * pressure (boiling, q = 1): beyond it the formula has a pole near 130 °C and turns negative, which
 * would flip the sign of the evaporation's humidity term and let E grow with column water.
 */
export function satSpecificHumidity(tC: number): number {
  const es = satVaporPressure(tC);
  const e = es < P_SURFACE ? es : P_SURFACE;
  return (0.622 * e) / (P_SURFACE - 0.378 * e);
}

/**
 * Hamon (1963) potential evapotranspiration in kg m⁻² s⁻¹ (= mm/s):
 * PET = 29.8 · D · e_s[kPa] / (T + 273.2) mm/day with D the day length in hours.
 * Zero at or below 0 °C, ramping linearly to full value at `rampTemp` so ET has no step.
 */
export function hamonPet(tC: number, dayLengthHours: number, rampTemp: number): number {
  if (!(tC > 0)) return 0;
  const ramp = rampTemp > 0 && tC < rampTemp ? tC / rampTemp : 1;
  const mmPerDay = (29.8 * dayLengthHours * (satVaporPressure(tC) / 1000)) / (tC + 273.2);
  return (ramp * mmPerDay) / 86400;
}

/**
 * Month-mean day length (hours) at latitude `lat` (radians) for month m (0 = Jan) and obliquity
 * `tiltRad`. Solar declination sin δ = sin ε · sin L with orbital longitude L measured from the March
 * equinox (≈ 20 March); averaged over 6 samples inside the month. Valid for any tilt 0..90°.
 */
export function monthDayLength(lat: number, month: number, tiltRad: number): number {
  const samples = 6;
  const sinTilt = Math.sin(tiltRad);
  const tanLat = Math.tan(Math.max(-1.5707, Math.min(1.5707, lat)));
  let sum = 0;
  for (let s = 0; s < samples; s++) {
    const day = (month + (s + 0.5) / samples) * DAYS_PER_MONTH;
    const L = (2 * Math.PI * (day - 79)) / 365.2422;
    const dec = Math.asin(sinTilt * Math.sin(L));
    const x = -tanLat * Math.tan(dec);
    const hourAngle = x <= -1 ? Math.PI : x >= 1 ? 0 : Math.acos(x);
    sum += (24 * hourAngle) / Math.PI;
  }
  return sum / samples;
}
