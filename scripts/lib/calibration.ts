/**
 * Generic parameter-sweep machinery for scripts/calibrate.ts: range parsing, combination
 * enumeration/sampling, dotted-path get/set on (mutable) tuning objects, and ranking.
 * Independent of the climate model so it can be unit-tested with a fake evaluator.
 */
import { Rng } from '../../src/core/rng';

/** A parameter range: explicit values, or a linear/log sweep. */
export type RangeSpec = number[] | { values: number[] } | { from: number; to: number; steps: number; log?: boolean };

export type Combo = Record<string, number>;

/** Normalize a JSON range object to explicit value lists. */
export function parseRanges(spec: Record<string, RangeSpec>): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, r] of Object.entries(spec)) {
    let vals: number[];
    if (Array.isArray(r)) vals = r;
    else if ('values' in r) vals = r.values;
    else {
      const { from, to, steps, log } = r;
      if (!(steps >= 1) || !Number.isInteger(steps)) throw new Error(`range ${key}: steps must be a positive integer`);
      if (log && (from <= 0 || to <= 0)) throw new Error(`range ${key}: log sweep needs positive bounds`);
      vals = [];
      for (let i = 0; i < steps; i++) {
        const t = steps === 1 ? 0 : i / (steps - 1);
        vals.push(log ? from * Math.pow(to / from, t) : from + (to - from) * t);
      }
    }
    if (vals.length === 0) throw new Error(`range ${key}: no values`);
    for (const v of vals) if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`range ${key}: non-numeric value ${v}`);
    out[key] = vals;
  }
  return out;
}

/** Number of combinations of a full grid. */
export function gridSize(ranges: Record<string, number[]>): number {
  return Object.values(ranges).reduce((a, v) => a * v.length, 1);
}

/**
 * Full cartesian grid if it has ≤ max combinations; otherwise `max` distinct combinations drawn
 * uniformly at random (deterministic for `seed`).
 */
export function combinations(ranges: Record<string, number[]>, max: number, seed = 1): Combo[] {
  const keys = Object.keys(ranges);
  const total = gridSize(ranges);
  const decode = (idx: number): Combo => {
    const c: Combo = {};
    for (const k of keys) {
      const vals = ranges[k];
      c[k] = vals[idx % vals.length];
      idx = Math.floor(idx / vals.length);
    }
    return c;
  };
  if (total <= max) return Array.from({ length: total }, (_, i) => decode(i));
  const rng = new Rng(seed);
  const picked = new Set<number>();
  while (picked.size < max) picked.add(Math.floor(rng.next() * total));
  return [...picked].sort((a, b) => a - b).map(decode);
}

/** Read a numeric property by dotted path ("a.b.c"). Throws if missing or not a number. */
export function getPath(obj: unknown, path: string): number {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) throw new Error(`tuning path "${path}" not found (at "${part}")`);
    cur = (cur as Record<string, unknown>)[part];
  }
  if (typeof cur !== 'number') throw new Error(`tuning path "${path}" is not a number (${typeof cur})`);
  return cur;
}

/** Write a numeric property by dotted path (must already exist as a number). */
export function setPath(obj: unknown, path: string, value: number): void {
  getPath(obj, path);
  const parts = path.split('.');
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]] as Record<string, unknown>;
  cur[parts[parts.length - 1]] = value;
}

/** Apply a combination; returns a function that restores the previous values. */
export function applyCombo(target: unknown, combo: Combo): () => void {
  const saved: Combo = {};
  for (const k of Object.keys(combo)) saved[k] = getPath(target, k);
  for (const [k, v] of Object.entries(combo)) setPath(target, k, v);
  return () => {
    for (const [k, v] of Object.entries(saved)) setPath(target, k, v);
  };
}

export interface SweepRow<M> {
  combo: Combo;
  /** null when the evaluation failed. */
  metrics: M | null;
  error?: string;
  ms: number;
  baseline: boolean;
}

/**
 * Evaluate the baseline (current values) and every combination, restoring the target after each run
 * (also on errors). `evaluate` may throw; the row then carries the error.
 */
export async function runSweep<M>(
  target: unknown, combos: Combo[], evaluate: () => Promise<M>, onRow?: (row: SweepRow<M>, i: number, total: number) => void,
): Promise<SweepRow<M>[]> {
  const rows: SweepRow<M>[] = [];
  const keys = combos.length ? Object.keys(combos[0]) : [];
  const baselineCombo: Combo = {};
  for (const k of keys) baselineCombo[k] = getPath(target, k);
  const all: Array<[Combo, boolean]> = [[baselineCombo, true], ...combos.map((c): [Combo, boolean] => [c, false])];
  for (let i = 0; i < all.length; i++) {
    const [combo, baseline] = all[i];
    const restore = applyCombo(target, combo);
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    let row: SweepRow<M>;
    try {
      row = { combo, metrics: await evaluate(), ms: 0, baseline };
    } catch (e) {
      row = { combo, metrics: null, error: e instanceof Error ? e.message : String(e), ms: 0, baseline };
    } finally {
      restore();
    }
    row.ms = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    rows.push(row);
    onRow?.(row, i, all.length);
  }
  return rows;
}

/** Sort successful rows by `key` (ascending unless `descending`); failed rows go last. */
export function rankRows<M>(rows: SweepRow<M>[], key: (m: M) => number, descending = false): SweepRow<M>[] {
  const ok = rows.filter((r) => r.metrics !== null);
  const bad = rows.filter((r) => r.metrics === null);
  ok.sort((a, b) => (descending ? -1 : 1) * (key(a.metrics!) - key(b.metrics!)));
  return [...ok, ...bad];
}

/** Fixed-width text table. */
export function formatTable(header: string[], rows: string[][]): string {
  const widths = header.map((h, j) => Math.max(h.length, ...rows.map((r) => (r[j] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, j) => c.padStart(widths[j])).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
