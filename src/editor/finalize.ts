/**
 * "Simulate this world" pre/post-processing around finalizeDraft (tectonics), which splits every
 * disconnected plate into separate plates (new ids, names and colours, same motion) — and, once the
 * MAX_PLATES cap is reached, floods the remaining pieces into whatever plate surrounds them. The
 * editor lets a plate be in several pieces on purpose (painting an island of plate X keeps it
 * plate X), so:
 *  - before: `simulationLabels` merges only the tiny detached pieces (< MIN_FRAGMENT_CELLS) into
 *    their neighbours, as the editor's own tidying does;
 *  - after: `rejoinPlatePieces` gives every cell back the plate it was drawn with (by plate id), so
 *    pieces that finalizeDraft split off — or flooded into a neighbour at the cap — rejoin their
 *    plate, and the split-off plates are dropped.
 */
import type { SphereMesh, WorldDraft } from '../core/types';
import { MIN_FRAGMENT_CELLS } from './editorConstants';
import { labelComponents, longestBorderNeighbor } from './topology';

export interface SimulationLabels {
  /** Plate index per cell (a new array). */
  plate: Int16Array;
  /** Tiny detached pieces merged into neighbours. */
  merged: number;
  /**
   * Cells of tiny pieces still detached after the merge passes (practically never): left to
   * finalizeDraft's own clean-up instead of being restored by rejoinPlatePieces. Null when none.
   */
  loose: Uint8Array | null;
}

/**
 * The labels to simulate: every piece of a plate stays with it, except detached pieces smaller than
 * MIN_FRAGMENT_CELLS (not the plate's largest piece), which merge into the neighbour with the
 * longest shared boundary, largest first. Repeated because a sliver can merge into the plate of a
 * neighbouring sliver that moves away afterwards (converges in 1–2 passes; bounded).
 */
export function simulationLabels(mesh: SphereMesh, plateIn: Int16Array, numPlates: number): SimulationLabels {
  const plate = plateIn.slice();
  const n = plate.length;
  let merged = 0;
  for (let pass = 0; pass < 6; pass++) {
    const comps = labelComponents(mesh, plate);
    const nc = comps.size.length;
    const main = new Int32Array(numPlates).fill(-1);
    for (let c = 0; c < nc; c++) {
      const k = comps.label[c];
      if (main[k] < 0 || comps.size[c] > comps.size[main[k]]) main[k] = c;
    }
    const tiny: number[] = [];
    for (let c = 0; c < nc; c++) if (main[comps.label[c]] !== c && comps.size[c] < MIN_FRAGMENT_CELLS) tiny.push(c);
    if (tiny.length === 0) return { plate, merged, loose: null };
    if (pass === 5) {
      const loose = new Uint8Array(n);
      const isTiny = new Uint8Array(nc);
      for (const c of tiny) isTiny[c] = 1;
      for (let i = 0; i < n; i++) if (isTiny[comps.comp[i]]) loose[i] = 1;
      return { plate, merged, loose };
    }
    tiny.sort((a, b) => comps.size[b] - comps.size[a] || a - b);
    const slot = new Int32Array(nc).fill(-1);
    tiny.forEach((c, s) => (slot[c] = s));
    const lists: number[][] = tiny.map(() => []);
    for (let i = 0; i < n; i++) {
      const s = slot[comps.comp[i]];
      if (s >= 0) lists[s].push(i);
    }
    for (const cells of lists) {
      const own = plate[cells[0]];
      const t = longestBorderNeighbor(mesh, plate, cells, own, numPlates);
      if (t < 0) continue;
      if (pass === 0) merged++;
      for (const i of cells) plate[i] = t;
    }
  }
  return { plate, merged, loose: null };
}

/**
 * `src` is the draft handed to finalizeDraft (plate ids unique), `fin` its result. Every cell gets
 * the finalized plate with the id it had in `src` (except `loose` cells, left as finalizeDraft
 * resolved them); plates finalizeDraft created for split-off pieces end up without cells and are
 * dropped. Returns `fin` (modified in place) with compacted plates.
 */
export function rejoinPlatePieces(src: WorldDraft, fin: WorldDraft, loose: Uint8Array | null = null): WorldDraft {
  const n = fin.n;
  const finIdx = new Map<number, number>();
  fin.plates.forEach((p, k) => finIdx.set(p.id, k));
  const np = fin.plates.length;
  const toFin = new Int32Array(src.plates.length);
  const drawn = new Uint8Array(np);
  src.plates.forEach((p, k) => {
    const t = finIdx.get(p.id) ?? -1;
    toFin[k] = t;
    if (t >= 0) drawn[t] = 1;
  });
  for (let i = 0; i < n; i++) {
    // A loose cell keeps finalizeDraft's label unless that is a plate split off for a piece.
    if (loose && loose[i] && drawn[fin.plate[i]]) continue;
    const t = toFin[src.plate[i]];
    if (t >= 0) fin.plate[i] = t;
  }
  // Compact: drop plates left without cells, remap indices.
  const used = new Uint8Array(np);
  for (let i = 0; i < n; i++) used[fin.plate[i]] = 1;
  const remap = new Int32Array(np).fill(-1);
  const plates: WorldDraft['plates'] = [];
  for (let k = 0; k < np; k++) {
    if (!used[k]) continue;
    remap[k] = plates.length;
    plates.push(fin.plates[k]);
  }
  if (plates.length === np) return fin;
  for (let i = 0; i < n; i++) fin.plate[i] = remap[fin.plate[i]];
  fin.plates = plates;
  return fin;
}
