/** One brush dab of each stroke tool, applied through a Mutator (undo + change tracking). */
import type { Vec3 } from '../core/types';
import { CRUST_CONTINENTAL, CRUST_OCEANIC } from '../core/types';
import { oceanDepthForAge } from '../tectonics/draft';
import { ELEV_MAX, ELEV_MIN, PAINTED_CONTINENT_AGE } from './editorConstants';
import type { Mutator } from './plateOps';
import { smoothLabels } from './plateOps';
import { raiseKernel } from './relief';
import type { DabRoughness } from './stroke';
import { dabCells } from './stroke';

export type StrokeTool = 'plate' | 'continent' | 'ocean' | 'raise' | 'lower' | 'smooth';

export interface DabSettings {
  tool: StrokeTool;
  /** Effective radius, radians (≥ one mesh spacing). */
  radius: number;
  /** Target plate index (plate brush). */
  plate: number;
  /** Peak elevation change per dab, m (raise / lower). */
  amount: number;
  /** Per-plate mean ocean age for crust the ocean brush converts (ocean brush only). */
  oceanAges: Float64Array | null;
  /** Noisy footprint (continent / ocean brushes). */
  rough: DabRoughness | null;
  /** Continent brush: cells this stroke turned continental are flagged here (coast hygiene). */
  paintMask?: Uint8Array | null;
}

/**
 * Apply one dab centred at c; returns how many cells it changed. `buf` is scratch storage.
 *  - plate: assign the target plate;  smooth: majority-filter plate labels;
 *  - continent: oceanic → continental (provisional shelf elevation; the caller recomputes coastal
 *    relief after the batch of dabs);  ocean: continental → oceanic at the plate's mean ocean age,
 *    and any ocean cell back to its age-based depth;
 *  - raise / lower: add ±amount × raised-cosine falloff (sculpted cells are kept on apply).
 */
export function applyDab(mut: Mutator, s: DabSettings, c: Vec3, buf: number[]): number {
  const st = mut.state;
  const d = st.draft;
  const cells = dabCells(mut.mesh, c, s.radius, buf, s.rough ?? undefined);
  let changed = 0;
  switch (s.tool) {
    case 'plate':
      for (const i of cells) {
        if (d.plate[i] === s.plate) continue;
        mut.setPlate(i, s.plate);
        changed++;
      }
      break;
    case 'smooth':
      smoothLabels(mut, cells);
      break;
    case 'continent':
      for (const i of cells) {
        if (d.crust[i] === CRUST_CONTINENTAL) continue;
        mut.touch(i);
        d.crust[i] = CRUST_CONTINENTAL;
        d.age[i] = PAINTED_CONTINENT_AGE;
        d.elev[i] = -150;
        if (d.orogeny) d.orogeny[i] = 0;
        st.brushRelief[i] = 1;
        st.userElev[i] = 0;
        st.sourceRelief[i] = 0;
        if (s.paintMask) s.paintMask[i] = 1;
        mut.markCell(i);
        changed++;
      }
      break;
    case 'ocean': {
      const ages = s.oceanAges;
      if (!ages) throw new Error('applyDab: the ocean brush needs per-plate ocean ages');
      for (const i of cells) {
        const wasCont = d.crust[i] === CRUST_CONTINENTAL;
        const age = wasCont ? ages[d.plate[i]] : d.age[i];
        // Compare in float32 (elev storage precision), or cells already at depth are rewritten on every dab.
        const e = Math.fround(oceanDepthForAge(age));
        if (!wasCont && d.elev[i] === e && !st.userElev[i] && !st.sourceRelief[i]) continue;
        mut.touch(i);
        d.crust[i] = CRUST_OCEANIC;
        d.age[i] = age;
        d.elev[i] = e;
        if (d.orogeny) d.orogeny[i] = 0;
        st.brushRelief[i] = 0;
        st.userElev[i] = 0;
        st.sourceRelief[i] = 0;
        mut.markCell(i);
        changed++;
      }
      break;
    }
    case 'raise':
    case 'lower': {
      const sign = s.tool === 'raise' ? 1 : -1;
      const { xyz } = mut.mesh;
      for (const i of cells) {
        const dot = xyz[3 * i] * c[0] + xyz[3 * i + 1] * c[1] + xyz[3 * i + 2] * c[2];
        const w = raiseKernel(Math.acos(Math.max(-1, Math.min(1, dot))), s.radius);
        if (w <= 0) continue;
        mut.touch(i);
        d.elev[i] = Math.max(ELEV_MIN, Math.min(ELEV_MAX, d.elev[i] + sign * s.amount * w));
        st.userElev[i] = 1;
        st.brushRelief[i] = 0;
        mut.markCell(i);
        changed++;
      }
      break;
    }
  }
  return changed;
}
