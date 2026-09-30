/** Number formatting for readouts (tabular, compact, with proper minus signs). */
import { MONTH_NAMES } from '../core/constants';

const MINUS = '−';
const THIN = ' ';

/** Fixed decimals with a typographic minus; non-finite → em dash. */
export function fmtNum(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // −0.0 and values that round to zero show without a sign.
  return v < 0 && Number(s.replace(/,/g, '')) !== 0 ? MINUS + s : s;
}

export function fmtTemp(c: number, digits = 1): string {
  return `${fmtNum(c, digits)}${THIN}°C`;
}

export function fmtPrecip(mm: number): string {
  return `${fmtNum(mm, mm < 10 && mm !== 0 ? 1 : 0)}${THIN}mm`;
}

export function fmtElev(m: number): string {
  return `${fmtNum(m, 0)}${THIN}m`;
}

export function fmtMyr(t: number): string {
  return `${fmtNum(t, Math.abs(t) < 1000 ? 1 : 0)}${THIN}Myr`;
}

export function fmtPercent(fraction: number, digits = 0): string {
  return `${fmtNum(fraction * 100, digits)}%`;
}

/** km/Myr → cm/yr (10 km/Myr = 1 cm/yr). */
export function fmtPlateSpeed(kmPerMyr: number): string {
  return `${fmtNum(kmPerMyr / 10, 1)}${THIN}cm/yr`;
}

export function fmtLat(lat: number): string {
  const d = (lat * 180) / Math.PI;
  return `${fmtNum(Math.abs(d), 1)}°${d >= 0 ? 'N' : 'S'}`;
}

export function fmtLon(lon: number): string {
  let d = (lon * 180) / Math.PI;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  return `${fmtNum(Math.abs(d), 1)}°${d >= 0 ? 'E' : 'W'}`;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${fmtNum(b / 1024, 0)} KB`;
  return `${fmtNum(b / (1024 * 1024), 0)} MB`;
}

export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  return ms >= 1000 ? `${fmtNum(ms / 1000, 2)}${THIN}s` : `${fmtNum(ms, 0)}${THIN}ms`;
}

/** 'Annual' for −1, else the short month name. */
export function monthLabel(month: number): string {
  return month < 0 ? 'Annual' : MONTH_NAMES[Math.max(0, Math.min(11, Math.round(month)))];
}

/** Compass direction for a bearing in degrees clockwise from north. */
export function compass(bearingDeg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const i = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return dirs[i];
}
