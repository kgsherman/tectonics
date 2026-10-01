/**
 * Land share at the display sea level. TectonicStats.landFraction counts elevation > 0 (the
 * datum); the UI shows land against the one app sea level (SPEC §2), like the painter's land rule.
 */

/** Fraction of cells with elevation above `seaLevel` (0 for an empty field). */
export function landFractionAt(elev: ArrayLike<number>, seaLevel: number): number {
  const n = elev.length;
  if (n === 0) return 0;
  let land = 0;
  for (let i = 0; i < n; i++) if (elev[i] > seaLevel) land++;
  return land / n;
}
