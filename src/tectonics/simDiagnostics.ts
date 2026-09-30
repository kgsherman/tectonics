import type { SphereMesh, WorldSnapshot } from '../core/types';
import { CRUST_CONTINENTAL } from '../core/types';

/**
 * Consistency check of a tectonic snapshot (SPEC §4.4 invariants): every cell has a top plate, all
 * fields are finite, plate count within [1, cap] and plate ids unique. Returns null when valid,
 * otherwise a description of the first violation.
 */
export function snapshotInvariantError(mesh: SphereMesh, s: WorldSnapshot, cap: number): string | null {
  if (s.n !== mesh.n) return `snapshot.n ${s.n} != mesh.n ${mesh.n}`;
  if (s.plates.length < 1 || s.plates.length > cap) return `plate count ${s.plates.length} outside [1, ${cap}]`;
  const ids = new Set(s.plates.map((p) => p.id));
  if (ids.size !== s.plates.length) return 'duplicate plate ids';
  for (const p of s.plates) {
    if (![...p.omega, ...p.rotation, ...p.centroid, p.area, p.speed].every(Number.isFinite)) return `non-finite info for plate ${p.id}`;
  }
  for (let i = 0; i < s.n; i++) {
    const k = s.plate[i];
    if (!(k >= 0 && k < s.plates.length)) return `cell ${i} has no top plate (${k})`;
    if (!Number.isFinite(s.elev[i]) || !Number.isFinite(s.age[i]) || !Number.isFinite(s.orogeny[i])) {
      return `non-finite field at cell ${i}`;
    }
    if (s.crust[i] > CRUST_CONTINENTAL) return `invalid crust type at cell ${i}`;
  }
  return null;
}

/** Number of oceanic cells whose neighbours are all continental (holes / speckles in continents). */
export function countOceanicSpecks(mesh: SphereMesh, crust: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (crust[i] === CRUST_CONTINENTAL) continue;
    let enclosed = true;
    for (let q = mesh.adjOffset[i]; q < mesh.adjOffset[i + 1]; q++) {
      if (crust[mesh.adj[q]] !== CRUST_CONTINENTAL) {
        enclosed = false;
        break;
      }
    }
    if (enclosed) c++;
  }
  return c;
}

/** Number of cells whose plate differs from every neighbour's (single-cell plate speckles). */
export function countPlateSpecks(mesh: SphereMesh, plate: Int16Array): number {
  let c = 0;
  for (let i = 0; i < mesh.n; i++) {
    let alone = true;
    for (let q = mesh.adjOffset[i]; q < mesh.adjOffset[i + 1]; q++) {
      if (plate[mesh.adj[q]] === plate[i]) {
        alone = false;
        break;
      }
    }
    if (alone) c++;
  }
  return c;
}

/** Graph distance in rings from the nearest cell satisfying `isSource`, Infinity beyond maxRings. */
export function ringDistance(mesh: SphereMesh, isSource: (i: number) => boolean, maxRings: number): Float64Array {
  const d = new Float64Array(mesh.n).fill(Infinity);
  let frontier: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (isSource(i)) {
      d[i] = 0;
      frontier.push(i);
    }
  }
  for (let r = 1; r <= maxRings && frontier.length > 0; r++) {
    const next: number[] = [];
    for (const c of frontier) {
      for (let q = mesh.adjOffset[c]; q < mesh.adjOffset[c + 1]; q++) {
        const a = mesh.adj[q];
        if (d[a] === Infinity) {
          d[a] = r;
          next.push(a);
        }
      }
    }
    frontier = next;
  }
  return d;
}
