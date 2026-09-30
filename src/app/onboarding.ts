/**
 * First-run hint state ("Drag to rotate · Space to play · Plates tab to draw your own"): which tips
 * the user already followed and whether the hint was dismissed, persisted in localStorage so it is
 * shown once. Pure (storage injected) so it is unit-tested.
 */
import type { KeyValueStorage } from './settings';

export const FIRST_RUN_KEY = 'worldgen.firstRun.v1';

export type HintStep = 'rotate' | 'play' | 'plates';
export const HINT_STEPS: readonly HintStep[] = ['rotate', 'play', 'plates'];

export interface HintState {
  dismissed: boolean;
  done: HintStep[];
}

const FRESH: HintState = { dismissed: false, done: [] };

export function loadHintState(storage: KeyValueStorage | null): HintState {
  if (!storage) return { ...FRESH, done: [] };
  try {
    const raw = storage.getItem(FIRST_RUN_KEY);
    if (!raw) return { ...FRESH, done: [] };
    const v = JSON.parse(raw) as Partial<HintState>;
    const done = Array.isArray(v.done) ? HINT_STEPS.filter((s) => (v.done as unknown[]).includes(s)) : [];
    return { dismissed: v.dismissed === true, done };
  } catch {
    return { ...FRESH, done: [] };
  }
}

export function saveHintState(storage: KeyValueStorage | null, st: HintState): boolean {
  if (!storage) return false;
  try {
    storage.setItem(FIRST_RUN_KEY, JSON.stringify(st));
    return true;
  } catch {
    return false;
  }
}

/** Mark a tip as followed (same object when already done). */
export function markHintDone(st: HintState, step: HintStep): HintState {
  return st.done.includes(step) ? st : { ...st, done: HINT_STEPS.filter((s) => s === step || st.done.includes(s)) };
}

export function hintComplete(st: HintState): boolean {
  return st.dismissed || HINT_STEPS.every((s) => st.done.includes(s));
}
