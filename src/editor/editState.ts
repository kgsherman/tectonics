import type { PlateSpec, WorldDraft } from '../core/types';
import { CRUST_OCEANIC } from '../core/types';
import { cloneDraft, clonePlateSpec, oceanDepthForAge } from '../tectonics/draft';

/**
 * Everything the editor edits: the draft plus per-cell provenance flags that decide which
 * elevations "Simulate this world" keeps (see keepElevationMask).
 */
export interface EditState {
  draft: WorldDraft;
  /** 1 = elevation sculpted by the user (Raise/Lower): always kept. */
  userElev: Uint8Array;
  /** 1 = elevation came from a meaningful source (generator / simulation): kept while its plate is untouched. */
  sourceRelief: Uint8Array;
  /** 1 = continental cell painted by the continent brush: elevation follows its distance to the coast. */
  brushRelief: Uint8Array;
  /** Ids of plates whose outline or motion changed since the draft was loaded. */
  dirtyPlates: Set<number>;
}

/** Where a loaded draft came from (decides whether its ocean-floor relief is worth keeping). */
export type DraftSource = 'blank' | 'random' | 'current' | 'unknown';

export type CellArray = Int16Array | Uint8Array | Float32Array;

/**
 * The per-cell arrays of a state in a fixed order (history diffs refer to fields by position).
 * orogeny is included only when the draft has one.
 */
export function cellFields(s: EditState): CellArray[] {
  const d = s.draft;
  const f: CellArray[] = [d.plate, d.crust, d.elev, d.age, s.userElev, s.sourceRelief, s.brushRelief];
  if (d.orogeny) f.push(d.orogeny);
  return f;
}

/** Plate-list metadata that history snapshots wholesale (small: ≤ MAX_PLATES specs). */
export interface MetaState {
  plates: PlateSpec[];
  nextPlateId: number;
  dirtyPlates: number[];
}

export function captureMeta(s: EditState): MetaState {
  return {
    plates: s.draft.plates.map(clonePlateSpec),
    nextPlateId: s.draft.nextPlateId,
    dirtyPlates: [...s.dirtyPlates],
  };
}

export function restoreMeta(s: EditState, m: MetaState): void {
  s.draft.plates = m.plates.map(clonePlateSpec);
  s.draft.nextPlateId = m.nextPlateId;
  s.dirtyPlates = new Set(m.dirtyPlates);
}

export function metaEqual(a: MetaState, b: MetaState): boolean {
  if (a.nextPlateId !== b.nextPlateId || a.plates.length !== b.plates.length) return false;
  if (a.dirtyPlates.length !== b.dirtyPlates.length) return false;
  const da = [...a.dirtyPlates].sort((x, y) => x - y);
  const db = [...b.dirtyPlates].sort((x, y) => x - y);
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  for (let k = 0; k < a.plates.length; k++) {
    const p = a.plates[k], q = b.plates[k];
    if (p.id !== q.id || p.name !== q.name) return false;
    for (let c = 0; c < 3; c++) if (p.color[c] !== q.color[c] || p.omega[c] !== q.omega[c]) return false;
    const pf = p.frame, qf = q.frame;
    if (!pf !== !qf) return false;
    if (pf && qf) for (let c = 0; c < 4; c++) if (pf[c] !== qf[c]) return false;
  }
  return true;
}

export function cloneEditState(s: EditState): EditState {
  return {
    draft: cloneDraft(s.draft),
    userElev: s.userElev.slice(),
    sourceRelief: s.sourceRelief.slice(),
    brushRelief: s.brushRelief.slice(),
    dirtyPlates: new Set(s.dirtyPlates),
  };
}

/** True when every oceanic cell sits exactly at its age-based depth (nothing worth preserving). */
function oceanIsAgeDepth(d: WorldDraft): boolean {
  for (let i = 0; i < d.n; i++) {
    if (d.crust[i] !== CRUST_OCEANIC) continue;
    if (Math.abs(d.elev[i] - oceanDepthForAge(d.age[i])) > 1) return false;
  }
  return true;
}

/**
 * Wrap a (cloned) draft into a fresh edit state. Ocean-floor relief of generated or simulated worlds
 * is marked as source relief (kept on apply while its plate is untouched); blank drafts, and unknown
 * drafts whose ocean floor is purely age-based, have nothing to keep.
 */
export function stateFromDraft(draft: WorldDraft, source: DraftSource): EditState {
  const d = cloneDraft(draft);
  d.revision = d.revision ?? 0;
  d.stepIndex = d.stepIndex ?? 0;
  const n = d.n;
  const keepSource = source === 'random' || source === 'current' || (source === 'unknown' && !oceanIsAgeDepth(d));
  return {
    draft: d,
    userElev: new Uint8Array(n),
    sourceRelief: new Uint8Array(n).fill(keepSource ? 1 : 0),
    brushRelief: new Uint8Array(n),
    dirtyPlates: new Set(),
  };
}

/**
 * Per-cell mask for finalizeDraft(keepElevation): sculpted and brush-painted cells, plus source relief
 * on plates whose outline and motion are unchanged (their ocean floor is still consistent).
 */
export function keepElevationMask(s: EditState): Uint8Array {
  const d = s.draft;
  const keep = new Uint8Array(d.n);
  const plateDirty = d.plates.map((p) => s.dirtyPlates.has(p.id));
  for (let i = 0; i < d.n; i++) {
    if (s.userElev[i] || s.brushRelief[i]) keep[i] = 1;
    else if (s.sourceRelief[i] && !plateDirty[d.plate[i]]) keep[i] = 1;
  }
  return keep;
}
